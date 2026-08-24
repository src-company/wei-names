// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";

/// @dev NameNFT surface used here. `records` is the public getter for its NameRecord struct.
interface INameNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function records(uint256 tokenId)
        external
        view
        returns (
            string memory label,
            uint256 parent,
            uint64 expiresAt,
            uint64 epoch,
            uint64 parentEpoch
        );
    function isAvailable(string memory label, uint256 parentId) external view returns (bool);
    function registerSubdomain(string memory label, uint256 parentId) external returns (uint256);
    function setAddr(uint256 tokenId, address addr) external;
    function setPrimaryName(uint256 tokenId) external;
    function setText(uint256 tokenId, string memory key, string memory value) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @dev WeiDAO surface used here. `proposals` is the public getter for its Proposal struct.
interface IWeiDAO {
    function supportOf(uint256 id, uint256 tokenId) external view returns (uint256);
    function proposals(uint256 id)
        external
        view
        returns (
            uint64 lastUpdate,
            uint64 created,
            bool executed,
            bool vetoed,
            address target,
            uint256 conviction,
            uint256 supportWeight,
            uint256 value,
            bytes memory data
        );
}

/// @dev Chainlink VRF v2.5 direct-funding wrapper, paid in native ETH. It quotes its own
///      gas-price-dependent price and is the only address permitted to call back.
interface IVRFV2PlusWrapper {
    function calculateRequestPriceNative(uint32 callbackGasLimit, uint32 numWords)
        external
        view
        returns (uint256);
    function requestRandomWordsInNative(
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        uint32 numWords,
        bytes calldata extraArgs
    ) external payable returns (uint256 requestId);
}

/// @title WeiRoll
/// @notice Ownerless ETH lottery for WNS name holders, drawn with Chainlink VRF.
/// @dev Funded by WeiDAO sending ETH here. There is no owner and no withdrawal: value leaves only
///      as a prize to a drawn winner or as the VRF fee.
///
/// ── Rounds run on funding, not a calendar ──────────────────────────────────────────────
/// Nothing runs while the pot is empty. ETH arriving opens a {ROUND_LENGTH} entry window; at the
/// end of it {draw} settles, paying out the entire pot, which leaves nothing to run on until the
/// next funding opens the next window. A round that cannot settle — under two tickets, or a pot
/// too thin to cover the VRF fee — reopens rather than reverting, so the contract is never wedged
/// with entries shut and no way forward. No keeper, no schedule, no admin: fund it and it runs.
///
/// ── Entries ────────────────────────────────────────────────────────────────────────────
/// WNS token IDs are namehashes and NameNFT is not enumerable, so the set of holders does not
/// exist on-chain to index into. Holders opt in per round with {enter}, which checks ownership and
/// eligibility live. That registry is the candidate set — no snapshot, no root, no indexer.
///
/// ── Odds ───────────────────────────────────────────────────────────────────────────────
/// Ticket weight is WeiDAO's `weightOf`: `getFee(byteLength) · (expiresAt − now) / 365d`, the ETH
/// it would currently cost to hold the name for its remaining runway. Odds are proportional to it,
/// making this EV-equivalent to a pro-rata airdrop paid in one transfer instead of N. Flat
/// one-name-one-ticket is not viable: at the 0.001 ETH default fee, odds would cost 0.001 ETH
/// each. Subdomains are free to mint, weigh 0, and are excluded, as in governance.
///
/// ── Boost ──────────────────────────────────────────────────────────────────────────────
/// {enter} takes an optional `boostPid`. If the name backs that proposal and the proposal is still
/// open, the ticket weighs {BOOST_BPS} more. {claim} re-checks the backing, so the boost is a bond
/// rather than a snapshot: support, enter, unsupport wins better odds on an unclaimable prize.
/// Only the backing is re-checked, not the proposal's state — a boosted entrant is never punished
/// for their proposal passing.
///
/// ── Winners hold names, not addresses ──────────────────────────────────────────────────
/// A draw records a tokenId. {claim} pays whoever holds that name, while it is still active, so
/// selling or lapsing forfeits the prize to the next round. NameNFT's 90-day grace period exceeds
/// {CLAIM_WINDOW}, so a name that lapses mid-window cannot be re-registered by someone else in
/// time to claim off the previous holder.
///
/// ── Rounds are names ───────────────────────────────────────────────────────────────────
/// The lottery runs forever, and while this contract holds `roll.wei` it writes its whole history
/// into that namespace. Claiming round 7 mints `7.roll.wei` to this contract — resolving to the
/// winner, with the winning label and prize in its text records — and then mints the winner's own
/// label beneath it: `alice.wei` wins round 7, `alice.7.roll.wei` goes to the claimer. So the
/// history browses as `roll.wei` → `7.roll.wei` → `alice.7.roll.wei`, the way WeiDAO's proposals
/// browse under `dao.wei`, and a repeat winner collects a badge per round because each round is
/// its own parent. Naming is a swallowed self-call and can never block a payout; a round whose
/// prize is left unclaimed is simply never named.
///
/// ── Caveats ────────────────────────────────────────────────────────────────────────────
/// • Weight is snapshotted at {enter} and drifts down over the round as runway burns, bounded by
///   {ROUND_LENGTH}. Same treatment WeiDAO gives support weight.
/// • Chainlink is a liveness dependency, not a safety one. An unfulfilled request is cleared by
///   the permissionless {resetRequest} after {REQUEST_TIMEOUT} and the draw retried.
/// • A name whose supported runway elapses makes its DAO position prunable by anyone; a boosted
///   winner in that state must re-`support` before claiming.
/// • Naming needs an active `roll.wei` held here. Without one, draws and payouts are unchanged and
///   only the namespace stops growing. Keeping it renewed is left outside this contract because
///   `NameNFT.renew` is permissionless — anyone may pay the fee for a name they do not own — and
///   badge holders are motivated to: NameNFT blocks transfers of inactive names, so a lapsed
///   `roll.wei` freezes every badge under it.
/// • {draw} is permissionless and pays the VRF fee from the pot. There is no keeper reward, but
///   every entrant has one waiting for them.
contract WeiRoll {
    error TooSoon();
    error NotRunning();
    error NotLive();
    error NotOwner();
    error NoRequest();
    error NotWinner();
    error NotBacking();
    error DrawPending();
    error Unauthorized();
    error AlreadyEntered();
    error AlreadyNamed();
    error WeightTooLarge();
    error ClaimWindowOver();
    error ClaimWindowOpen();

    event Entered(
        uint256 indexed round,
        uint256 indexed tokenId,
        address owner,
        uint256 weight,
        uint256 boostPid
    );
    event Drawn(uint256 indexed round, uint256 requestId);
    event RoundOpened(uint256 indexed round, uint256 roundEnd);
    event Won(uint256 indexed round, uint256 indexed tokenId, uint256 prize);
    event Claimed(
        uint256 indexed round, uint256 indexed tokenId, address indexed to, uint256 prize
    );
    event RolledOver(uint256 indexed round, uint256 prize);
    event Funded(address indexed from, uint256 amount);
    event Named(
        uint256 indexed round, uint256 indexed tokenId, uint256 indexed trophyId, address to
    );

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant REGISTRATION_PERIOD = 365 days;

    /// @notice How long entries stay open before a round may be drawn.
    uint256 public constant ROUND_LENGTH = 30 days;

    /// @notice How long a winner has to claim before the prize rolls into the next round.
    /// @dev Must stay under NameNFT's 90-day grace period. See "Winners hold names, not addresses".
    uint256 public constant CLAIM_WINDOW = 30 days;

    /// @notice Extra weight for a ticket backing an open proposal, in basis points.
    uint256 public constant BOOST_BPS = 10_000;

    /// @notice After this long with no VRF callback, anyone may clear the request and redraw.
    uint256 public constant REQUEST_TIMEOUT = 1 days;

    /// @notice `namehash("roll.wei")` — the parent every trophy is minted under.
    uint256 public constant PARENT =
        0xf218d633879b71231b282e26380ab665b6d0defe8dafef3bfeac70dd46799d80;

    uint32 internal constant CALLBACK_GAS = 200_000;
    uint16 internal constant CONFIRMATIONS = 3;

    /// @dev `VRFV2PlusClient._argsToBytes(ExtraArgsV1({nativePayment: true}))`: the tag
    ///      `bytes4(keccak256("VRF ExtraArgsV1"))` followed by the bool. Inlined so this contract
    ///      needs no Chainlink dependency; checked against the mainnet wrapper in the fork test.
    bytes internal constant EXTRA_ARGS =
        hex"92fd13380000000000000000000000000000000000000000000000000000000000000001";

    INameNFT public immutable nft;
    IWeiDAO public immutable dao;
    IVRFV2PlusWrapper public immutable wrapper;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev One entry. `cum` is the running weight total through this ticket, so the winner is the
    ///      first ticket whose `cum` exceeds a uniform draw over the round's total — a binary
    ///      search in the callback rather than a loop that could run out of gas.
    struct Ticket {
        uint256 tokenId; //   The namehash, full width.
        uint128 cum; //     ┐ Cumulative weight through this ticket,
        uint128 boostPid; // ┘ proposal bonded to for the boost (0 = none).
    }

    /// @notice The round now accepting entries.
    uint256 public round;

    /// @notice Entries close, and {draw} becomes callable, at this timestamp.
    uint256 public roundEnd;

    /// @notice In-flight VRF request id (0 = none).
    uint256 public requestId;

    /// @notice When that request was made, for {resetRequest}.
    uint256 public requestedAt;

    /// @notice Prize money spoken for by drawn-but-unclaimed rounds. Never part of a new pot.
    uint256 public reserved;

    mapping(uint256 => Ticket[]) internal _tickets;

    /// @notice Whether a name already holds a ticket in a round.
    mapping(uint256 => mapping(uint256 => bool)) public entered;

    /// @notice Winning tokenId of a settled round (0 = not settled).
    mapping(uint256 => uint256) public winnerOf;

    /// @notice Proposal the winning ticket bonded to, re-checked at claim (0 = unboosted).
    mapping(uint256 => uint256) public winnerBoostOf;

    /// @notice Unclaimed prize of a settled round.
    mapping(uint256 => uint256) public prizeOf;

    /// @notice Claim deadline of a settled round.
    mapping(uint256 => uint256) public claimBy;

    /// @notice `<label>.<r>.roll.wei`, the winner's badge for a round (0 = never named).
    mapping(uint256 => uint256) public trophyOf;

    /// @dev Send ETH with the deploy to open the first round immediately, and pre-approve this
    ///      (deterministic, e.g. CREATE3) address for `roll.wei` to hand the namespace over in the
    ///      same transaction. Both are optional and everything here is best-effort: with no
    ///      approval the deploy still succeeds and the name can be transferred in later, and unlike
    ///      WeiDAO — which refuses to launch a treasury without its veto backstop — nothing this
    ///      constructor does is load-bearing. Naming is decoration; the lottery runs without it.
    constructor(address _nft, address _dao, address _wrapper) payable {
        nft = INameNFT(_nft);
        dao = IWeiDAO(_dao);
        wrapper = IVRFV2PlusWrapper(_wrapper);

        if (_nft.code.length != 0) {
            try nft.ownerOf(PARENT) returns (address holder) {
                try nft.transferFrom(holder, address(this), PARENT) {
                    // Owning the parent, reverse-resolve to it: `roll.wei` now names this contract.
                    try nft.setPrimaryName(PARENT) {} catch {}
                } catch {}
            } catch {}
        }

        _open();
    }

    /// @notice Fund the pot, starting a round if none is running. WeiDAO does this with a proposal
    ///         targeting this address; anyone else may top it up the same way.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
        _open();
    }

    /// @dev Open an entry window if the contract holds unspoken-for ETH and is idle. Every path
    ///      that can leave money in the pot calls this, so funding is the only trigger needed.
    function _open() internal {
        if (roundEnd == 0 && address(this).balance > reserved) {
            roundEnd = block.timestamp + ROUND_LENGTH;
            emit RoundOpened(round, roundEnd);
        }
    }

    /// @dev So `roll.wei` can be handed over with `safeTransferFrom`.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    /*//////////////////////////////////////////////////////////////
                                  ENTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Enter `tokenId` in the current round. One ticket per name per round.
    /// @param boostPid An open proposal `tokenId` currently backs, for {BOOST_BPS} extra weight, or
    ///        0 for none. Passing one the name does not back reverts rather than silently entering
    ///        unboosted. Re-checked in {claim}, so dropping support before claiming forfeits.
    function enter(uint256 tokenId, uint256 boostPid) external {
        // Entries close at `roundEnd` and {draw} cannot run before it, so the ticket set is always
        // frozen before a seed is requested. No separate in-flight guard is needed here.
        if (roundEnd == 0) revert NotRunning();
        if (block.timestamp >= roundEnd) revert TooSoon();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotOwner();

        uint256 r = round;
        if (entered[r][tokenId]) revert AlreadyEntered();

        uint256 weight = weightOf(tokenId);
        if (weight == 0) revert NotLive();

        if (boostPid != 0) {
            // Requiring the proposal to still be open is what keeps the boost about current
            // governance: support left on a long-settled proposal cannot buy odds forever.
            (,, bool executed, bool vetoed,,,,,) = dao.proposals(boostPid);
            if (executed || vetoed) revert NotLive();
            if (dao.supportOf(boostPid, tokenId) == 0) revert NotBacking();
            weight += weight * BOOST_BPS / 10_000;
        }

        Ticket[] storage t = _tickets[r];
        uint256 cum = (t.length == 0 ? 0 : t[t.length - 1].cum) + weight;
        if (cum > type(uint128).max) revert WeightTooLarge();

        entered[r][tokenId] = true;
        t.push(Ticket({tokenId: tokenId, cum: uint128(cum), boostPid: uint128(boostPid)}));

        emit Entered(r, tokenId, msg.sender, weight, boostPid);
    }

    /*//////////////////////////////////////////////////////////////
                                  DRAW
    //////////////////////////////////////////////////////////////*/

    /// @notice Close the round and ask Chainlink for a seed. Permissionless.
    /// @dev A round that cannot be drawn — under two tickets, or a pot too thin to cover the VRF
    ///      fee — reopens for another {ROUND_LENGTH} instead of reverting. Reverting here would
    ///      wedge the contract: entries are already shut, so nobody could act until it was funded.
    function draw() external {
        if (roundEnd == 0) revert NotRunning();
        if (block.timestamp < roundEnd) revert TooSoon();
        if (requestId != 0) revert DrawPending();

        uint256 r = round;
        uint256 price = wrapper.calculateRequestPriceNative(CALLBACK_GAS, 1);

        // The +1 leaves at least a wei of prize behind, so a settled round is always claimable.
        if (_tickets[r].length < 2 || address(this).balance < reserved + price + 1) {
            roundEnd = block.timestamp + ROUND_LENGTH;
            emit RoundOpened(r, roundEnd);
            return;
        }

        requestId = wrapper.requestRandomWordsInNative{value: price}(
            CALLBACK_GAS, CONFIRMATIONS, 1, EXTRA_ARGS
        );
        requestedAt = block.timestamp;
        emit Drawn(r, requestId);
    }

    /// @notice Chainlink's callback. Picks the winner and opens the next round.
    /// @dev Held to a binary search and a handful of writes so it fits {CALLBACK_GAS}; a reverting
    ///      callback would burn the randomness.
    function rawFulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) external {
        if (msg.sender != address(wrapper)) revert Unauthorized();
        if (_requestId == 0 || _requestId != requestId) revert NoRequest();

        uint256 r = round;
        Ticket[] storage t = _tickets[r];

        // Uniform over total weight, then the first ticket whose cumulative weight exceeds it.
        uint256 target = _randomWords[0] % uint256(t[t.length - 1].cum);
        uint256 lo;
        uint256 hi = t.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (uint256(t[mid].cum) > target) hi = mid;
            else lo = mid + 1;
        }

        uint256 prize = address(this).balance - reserved;
        winnerOf[r] = t[lo].tokenId;
        winnerBoostOf[r] = uint256(t[lo].boostPid);
        prizeOf[r] = prize;
        claimBy[r] = block.timestamp + CLAIM_WINDOW;
        reserved += prize;

        requestId = 0;
        requestedAt = 0;
        round = r + 1;
        // The prize was the entire pot, so nothing is left to run on: the next funding reopens.
        roundEnd = 0;

        emit Won(r, t[lo].tokenId, prize);
    }

    /// @notice Clear a request that was never fulfilled, so {draw} can retry. Permissionless.
    /// @dev A late callback for the cleared id is rejected by the id check in
    ///      {rawFulfillRandomWords}, so there is no race with the retry.
    function resetRequest() external {
        if (requestId == 0) revert NoRequest();
        if (block.timestamp < requestedAt + REQUEST_TIMEOUT) revert TooSoon();
        requestId = 0;
        requestedAt = 0;
    }

    /*//////////////////////////////////////////////////////////////
                                 CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @notice Collect the prize for a settled round. The caller must still own the winning name,
    ///         it must still be active, and any boost bonded at entry must still be in place.
    function claim(uint256 r) external {
        uint256 prize = prizeOf[r];
        if (prize == 0) revert NotWinner();
        if (block.timestamp > claimBy[r]) revert ClaimWindowOver();

        uint256 tokenId = winnerOf[r];
        if (nft.ownerOf(tokenId) != msg.sender) revert NotWinner();
        if (weightOf(tokenId) == 0) revert NotLive();

        uint256 pid = winnerBoostOf[r];
        if (pid != 0 && dao.supportOf(pid, tokenId) == 0) revert NotBacking();

        prizeOf[r] = 0;
        reserved -= prize;
        emit Claimed(r, tokenId, msg.sender, prize);

        // Best-effort naming, wrapped the way WeiDAO wraps its proposal naming: a self-call so the
        // mints and the resolver writes fail together and are swallowed together.
        if (nft.ownerOf(PARENT) == address(this)) {
            try this.nameWinner(r, tokenId, msg.sender, prize) {} catch {}
        }

        safeTransferETH(msg.sender, prize);
    }

    /// @notice Return an unclaimed prize to the pot once its window closes. Permissionless.
    function rollOver(uint256 r) external {
        uint256 prize = prizeOf[r];
        if (prize == 0) revert NotWinner();
        if (block.timestamp <= claimBy[r]) revert ClaimWindowOpen();
        prizeOf[r] = 0;
        reserved -= prize;
        emit RolledOver(r, prize);
        _open(); // a forfeited prize is funding like any other
    }

    /*//////////////////////////////////////////////////////////////
                                 TROPHY
    //////////////////////////////////////////////////////////////*/

    /// @notice Record a claimed round in the namespace: mint `<r>.roll.wei` here, point it at the
    ///         winner, and mint `<label>.<r>.roll.wei` to them.
    /// @dev External only so {claim} can wrap it in try/catch; callable by this contract alone.
    ///      The round name is minted to this contract because NameNFT's resolver writes require
    ///      ownership and because it must stay owned to parent the badge. Labels come out of
    ///      NameNFT already normalised, so there is nothing here to validate.
    ///
    ///      Giving every round its own parent is what makes repeat wins work: `alice.7.roll.wei`
    ///      and `alice.12.roll.wei` never collide, so nothing is ever overwritten. That matters —
    ///      NameNFT lets a parent owner re-register its own subdomains, burning an NFT the holder
    ///      already has. This contract keeps every round name forever and has no code path that
    ///      re-enters a settled round, so it never uses that power on a badge it handed out.
    function nameWinner(uint256 r, uint256 tokenId, address to, uint256 prize) external {
        if (msg.sender != address(this)) revert Unauthorized();

        string memory roundLabel = LibString.toString(r);
        if (!nft.isAvailable(roundLabel, PARENT)) revert AlreadyNamed();
        uint256 roundId = nft.registerSubdomain(roundLabel, PARENT);

        (string memory label,,,,) = nft.records(tokenId);
        uint256 badge = nft.registerSubdomain(label, roundId);
        nft.setAddr(badge, to);
        nft.transferFrom(address(this), to, badge);

        nft.setAddr(roundId, to);
        nft.setText(roundId, "winner", label);
        nft.setText(roundId, "prize", LibString.toString(prize));

        trophyOf[r] = badge;
        emit Named(r, tokenId, badge, to);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's ticket weight: WeiDAO's `weightOf`, the current cost to hold it for its
    ///         remaining runway. Active top-level names only; subdomains and expired names are 0.
    function weightOf(uint256 tokenId) public view returns (uint256) {
        (string memory label, uint256 parent, uint64 exp,,) = nft.records(tokenId);
        if (parent != 0 || bytes(label).length == 0 || block.timestamp >= exp) return 0;
        return nft.getFee(bytes(label).length) * (exp - block.timestamp) / REGISTRATION_PERIOD;
    }

    /// @notice The id `<r>.roll.wei` has, whether or not the round was ever named. Naming is
    ///         best-effort, so read {trophyOf} to tell whether it actually happened.
    function roundName(uint256 r) public pure returns (uint256) {
        return uint256(
            keccak256(abi.encodePacked(bytes32(PARENT), keccak256(bytes(LibString.toString(r)))))
        );
    }

    /// @notice Number of tickets in round `r`.
    function ticketCount(uint256 r) external view returns (uint256) {
        return _tickets[r].length;
    }

    /// @notice Ticket `i` of round `r`.
    function ticketAt(uint256 r, uint256 i) external view returns (Ticket memory) {
        return _tickets[r][i];
    }

    /// @notice Total weight entered in round `r` — the denominator of every ticket's odds.
    function totalWeight(uint256 r) public view returns (uint256) {
        Ticket[] storage t = _tickets[r];
        return t.length == 0 ? 0 : uint256(t[t.length - 1].cum);
    }

    /// @notice What a draw settled now would pay out, net of prizes already spoken for.
    function pot() external view returns (uint256) {
        return address(this).balance - reserved;
    }
}

/// @dev Reverts with `ETHTransferFailed()` if the recipient rejects it, which only ever strands
///      that winner's own prize — {WeiRoll.rollOver} returns it to the pot.
function safeTransferETH(address to, uint256 amount) {
    assembly ("memory-safe") {
        if iszero(call(gas(), to, amount, codesize(), 0x00, codesize(), 0x00)) {
            mstore(0x00, 0xb12d13eb)
            revert(0x1c, 0x04)
        }
    }
}
