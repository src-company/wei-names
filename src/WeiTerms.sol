// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title WeiTerms
/// @notice Buy several 365-day terms of a `.wei` name in one transaction.
/// @dev `NameNFT` sells exactly one term per call and is non-upgradeable, so N years is always N
///      calls. This contract is just the envelope for them: no owner, no storage, no custody.
///
///      It never needs authority over a name. `NameNFT.renew()` does not read `msg.sender` —
///      anyone may extend anyone's registration, and renewal cannot move, approve, or expire a
///      name — so the worst a bug here could do is waste the ETH attached to the call.
///
///      Three properties bound it, each pinned by a test:
///        - Prices are read from the registry inside the call, never taken from the caller.
///        - Spending is capped by `msg.value`, so that is the caller's exposure. Send exactly the
///          quote and a price raised under the pending transaction reverts it; send slack and the
///          slack is spendable.
///        - Change is `msg.value - spent`, never the balance. Paying exactly makes no refund call,
///          so a caller that cannot receive ETH still works. Refunding the balance instead would
///          let anyone brick such a caller by sending 1 wei.
contract WeiTerms {
    INameNFT constant NFT = INameNFT(0x0000000000696760E15f265e828DB644A0c242EB);

    /// @dev Per call, and per entry in `renewMany`: repeating a name across entries extends it
    ///      further, bounded only by `msg.value`. The dapp offers ten.
    uint256 public constant MAX_TERMS = 25;

    error BadTerms();
    error BadRecipient();
    error LengthMismatch();
    error InsufficientFee();
    error RefundFailed();

    /// @notice What `terms` further years on `tokenId` cost at the current fee.
    /// @dev Quote and spend read the same `getFee`, so a quote holds until the fee schedule
    ///      changes. The spend is checked against `msg.value`, not against this.
    function quote(uint256 tokenId, uint256 terms) public view returns (uint256) {
        (string memory label,,,,) = NFT.records(tokenId);
        return NFT.getFee(bytes(label).length) * terms;
    }

    /// @notice What a whole basket costs, for `renewMany`.
    function quoteMany(uint256[] calldata tokenIds, uint256[] calldata terms)
        public
        view
        returns (uint256 total)
    {
        if (tokenIds.length != terms.length) revert LengthMismatch();
        for (uint256 i; i != tokenIds.length; ++i) {
            total += quote(tokenIds[i], terms[i]);
        }
    }

    /// @notice Register `label` for `terms` years and send it to `to`, in one transaction.
    /// @dev Commit first with `makeCommitment(label, <this contract>, keccak256(abi.encode(
    ///      innerSecret, to, terms)))`. Deriving the secret from the arguments is what makes the
    ///      reveal safe to broadcast: a copy that changes the recipient or the term count derives
    ///      a different secret and matches no commitment, and a verbatim copy delivers the name to
    ///      the intended recipient, for the intended number of years, at the copier's expense.
    ///      zRouter's `revealName` binds `to` this way; `terms` is bound for the same reason.
    ///
    ///      A commitment therefore settles at one `terms` value and no other. Changing the term
    ///      count means committing again.
    ///
    ///      The name is held here for one instruction: minted by `reveal()`, forwarded on the next
    ///      line. `reveal()` is `nonReentrant` and `onERC721Received` cannot write state, so
    ///      nothing runs in between. Delivery is a plain `transferFrom` deliberately — the safe
    ///      variant would give `to` a callback able to revert or re-enter the settlement. `to` is
    ///      therefore delivered to unconditionally and must be able to hold an ERC-721.
    function register(string calldata label, bytes32 innerSecret, address to, uint256 terms)
        public
        payable
        returns (uint256 tokenId)
    {
        if (terms == 0 || terms > MAX_TERMS) revert BadTerms();
        // Nothing here can move a name, so one delivered to this address would be unrecoverable.
        if (to == address(this)) revert BadRecipient();

        // `reveal()` keeps fee + premium and returns the rest, so forwarding `msg.value` cannot
        // overpay, and it reverts if that did not cover the price. `spent` is measured rather than
        // predicted, so whatever the premium actually was is what gets budgeted.
        uint256 before = address(this).balance;
        tokenId = NFT.reveal{value: msg.value}(label, keccak256(abi.encode(innerSecret, to, terms)));
        NFT.transferFrom(address(this), to, tokenId);

        uint256 spent = before - address(this).balance;
        uint256 fee = NFT.getFee(bytes(label).length);
        spent += fee * (terms - 1);
        if (spent > msg.value) revert InsufficientFee();
        // Year one came from `reveal()`. Renewals are fee-only; the premium never repeats.
        for (uint256 i = 1; i != terms; ++i) {
            NFT.renew{value: fee}(tokenId);
        }
        _refund(spent);
    }

    /// @notice Extend `tokenId` by `terms` further years. Send `quote(tokenId, terms)`; change
    ///         goes back to the caller. Reverts unless every term is paid for, so this cannot
    ///         leave a partial extension behind.
    function renew(uint256 tokenId, uint256 terms) public payable {
        _refund(_renew(tokenId, terms, 0));
    }

    /// @notice Extend several names in one transaction. Terms are per name, so names with
    ///         different expiries can be levelled up together.
    function renewMany(uint256[] calldata tokenIds, uint256[] calldata terms) public payable {
        if (tokenIds.length == 0 || tokenIds.length != terms.length) revert LengthMismatch();
        uint256 spent;
        for (uint256 i; i != tokenIds.length; ++i) {
            spent = _renew(tokenIds[i], terms[i], spent);
        }
        _refund(spent);
    }

    /// @dev `spent` is the batch's running total, checked against `msg.value` before this name's
    ///      renewals are paid for. That caps the batch at what the caller sent, so a stray balance
    ///      can never fund it, and prices a `renewMany` over mixed fee tiers in one pass.
    function _renew(uint256 tokenId, uint256 terms, uint256 spent) internal returns (uint256) {
        if (terms == 0 || terms > MAX_TERMS) revert BadTerms();
        (string memory label,,,,) = NFT.records(tokenId);
        uint256 fee = NFT.getFee(bytes(label).length);
        spent += fee * terms;
        if (spent > msg.value) revert InsufficientFee();
        // `renew()` extends from the record's expiry, not from now, so calls compound and an
        // early renewal loses nothing. Exact value per call means nothing is refunded to here.
        for (uint256 i; i != terms; ++i) {
            NFT.renew{value: fee}(tokenId);
        }
        return spent;
    }

    /// @dev `spent <= msg.value` by the checks above, so this is the caller's own change. Exact
    ///      payment sends nothing and touches no external code.
    function _refund(uint256 spent) internal {
        uint256 change = msg.value - spent;
        if (change != 0) {
            (bool ok,) = msg.sender.call{value: change}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Send any ETH sitting here to `to`. A successful call leaves none behind, so a
    ///         balance is always stray; this is how it gets out of an ownerless contract. Open to
    ///         anyone, since there is no protocol balance to take.
    function sweep(address to) public {
        uint256 bal = address(this).balance;
        if (bal != 0) {
            (bool ok,) = to.call{value: bal}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev The mint inside `register` is the only token this should ever hold. Refusing the rest
    ///      keeps a mis-sent name from landing where nothing can move it out. `view` rather than
    ///      `pure` only to read `msg.sender`; it still cannot write state or move value, so the
    ///      mint has no hook to re-enter through.
    function onERC721Received(address, address from, uint256, bytes calldata)
        public
        view
        returns (bytes4)
    {
        if (msg.sender != address(NFT) || from != address(0)) revert BadRecipient();
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}

interface INameNFT {
    function reveal(string calldata label, bytes32 secret) external payable returns (uint256);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function renew(uint256 tokenId) external payable;
    function getFee(uint256 length) external view returns (uint256);
    function records(uint256 tokenId)
        external
        view
        returns (string memory label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch);
}
