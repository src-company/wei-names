// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiTerms} from "../src/WeiTerms.sol";

/// @dev A caller that cannot receive ETH, for the refund path.
contract RejectsETH {
    WeiTerms immutable terms;

    constructor(WeiTerms t) {
        terms = t;
    }

    function go(uint256 tokenId, uint256 n, uint256 value) external {
        terms.renew{value: value}(tokenId, n);
    }

    function register(string calldata label, bytes32 inner, address to, uint256 n, uint256 value)
        external
    {
        terms.register{value: value}(label, inner, to, n);
    }

    // deliberately no receive() / fallback()
}

/// @notice Unit tests for the multi-term helper.
///
///         The security story is short: `renew()` on the registry is permissionless and cannot
///         move a name, so this contract needs no authority and the only thing at stake is the
///         ETH attached to a call. What follows pins that boundary — spending never exceeds
///         `msg.value`, a fee change under a pending call reverts rather than overspends, a batch
///         is all-or-nothing, and nothing is left here afterwards.
contract WeiTermsTest is Test {
    // WeiTerms hardcodes the live registry, so the registry has to live at that address here too.
    address constant NFT_ADDR = 0x0000000000696760E15f265e828DB644A0c242EB;

    uint256 constant TERM = 365 days;
    uint256 constant GRACE = 90 days;
    uint256 constant MIN_COMMIT_AGE = 60;

    NameNFT nft;
    WeiTerms terms;

    address owner;
    address alice = address(0xA11CE);
    address stranger = address(0xB0B);

    function setUp() public {
        deployCodeTo("NameNFT.sol:NameNFT", NFT_ADDR);
        nft = NameNFT(payable(NFT_ADDR));
        owner = nft.owner();
        terms = new WeiTerms();
        vm.deal(alice, 1000 ether);
        vm.deal(stranger, 1000 ether);
    }

    function _register(string memory label, address to) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encodePacked(label));
        vm.startPrank(to);
        nft.commit(keccak256(abi.encode(bytes(label), to, secret)));
        vm.warp(block.timestamp + MIN_COMMIT_AGE + 1);
        tokenId = nft.reveal{value: nft.getFee(bytes(label).length)}(label, secret);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                QUOTING
    //////////////////////////////////////////////////////////////*/

    function test_QuoteIsFeeTimesTerms() public {
        uint256 id = _register("quoted", alice);
        uint256 fee = nft.getFee(6);
        assertEq(terms.quote(id, 1), fee);
        assertEq(terms.quote(id, 7), fee * 7);
    }

    /// A quote follows the length tier of the name it names, not the caller's guess.
    function test_QuoteTracksTheLengthTier() public {
        uint256[] memory lengths = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        (lengths[0], fees[0]) = (3, 0.05 ether);
        vm.prank(owner);
        nft.setLengthFees(lengths, fees);

        uint256 shortId = _register("abc", alice);
        uint256 longId = _register("abcdefgh", alice);
        assertEq(terms.quote(shortId, 4), 0.05 ether * 4);
        assertEq(terms.quote(longId, 4), nft.defaultFee() * 4);
    }

    function test_QuoteManySumsTheBasket() public {
        uint256 a = _register("basketone", alice);
        uint256 b = _register("baskettwo", alice);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        (n[0], n[1]) = (2, 5);
        assertEq(terms.quoteMany(ids, n), terms.quote(a, 2) + terms.quote(b, 5));
    }

    function test_RevertsQuoteManyOnLengthMismatch() public {
        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](1);
        vm.expectRevert(WeiTerms.LengthMismatch.selector);
        terms.quoteMany(ids, n);
    }

    /*//////////////////////////////////////////////////////////////
                             BUYING TERMS
    //////////////////////////////////////////////////////////////*/

    function test_RenewBuysEveryTermAndKeepsNothing() public {
        uint256 id = _register("manyterms", alice);
        uint256 start = nft.expiresAt(id);
        uint256 cost = terms.quote(id, 5);
        uint256 before = alice.balance;

        vm.prank(alice);
        terms.renew{value: cost}(id, 5);

        assertEq(nft.expiresAt(id), start + 5 * TERM, "five terms compound onto expiry");
        assertEq(nft.ownerOf(id), alice, "the name never moves");
        assertEq(alice.balance, before - cost, "charged exactly the quote");
        assertEq(address(terms).balance, 0, "helper holds nothing afterwards");
    }

    /// The helper has no authority over the name and does not need any: renewal is open to all,
    /// so anyone may pay to extend anyone's registration and cannot do anything else with it.
    function test_AnyoneMayPayForAnothersName() public {
        uint256 id = _register("gifted", alice);
        uint256 start = nft.expiresAt(id);

        uint256 cost = terms.quote(id, 3);
        vm.prank(stranger);
        terms.renew{value: cost}(id, 3);

        assertEq(nft.expiresAt(id), start + 3 * TERM);
        assertEq(nft.ownerOf(id), alice, "paying for it does not claim it");
    }

    function test_ChangeGoesBackToTheCaller() public {
        uint256 id = _register("overpaid", alice);
        uint256 cost = terms.quote(id, 2);
        uint256 before = alice.balance;

        vm.prank(alice);
        terms.renew{value: cost + 3 ether}(id, 2);

        assertEq(alice.balance, before - cost, "only the quote is kept");
        assertEq(address(terms).balance, 0);
    }

    function test_RenewWorksThroughoutGrace() public {
        uint256 id = _register("gracerenew", alice);
        uint256 expiry = nft.expiresAt(id);
        vm.warp(expiry + GRACE - 1);

        uint256 cost = terms.quote(id, 2);
        vm.prank(alice);
        terms.renew{value: cost}(id, 2);

        // Extension is from the record's expiry, not from now — the grace months are not lost.
        assertEq(nft.expiresAt(id), expiry + 2 * TERM);
    }

    function testFuzz_TermsCompoundExactly(uint8 raw) public {
        uint256 n = bound(uint256(raw), 1, terms.MAX_TERMS());
        uint256 id = _register("fuzzterms", alice);
        uint256 start = nft.expiresAt(id);

        uint256 cost = terms.quote(id, n);
        vm.prank(alice);
        terms.renew{value: cost}(id, n);

        assertEq(nft.expiresAt(id), start + n * TERM);
        assertEq(address(terms).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                          WHERE IT REFUSES
    //////////////////////////////////////////////////////////////*/

    function test_RevertsOnZeroTerms() public {
        uint256 id = _register("zeroterms", alice);
        vm.prank(alice);
        vm.expectRevert(WeiTerms.BadTerms.selector);
        terms.renew{value: 1 ether}(id, 0);
    }

    function test_RevertsAboveMaxTerms() public {
        uint256 id = _register("maxterms", alice);
        uint256 over = terms.MAX_TERMS() + 1;
        vm.prank(alice);
        vm.expectRevert(WeiTerms.BadTerms.selector);
        terms.renew{value: 100 ether}(id, over);
    }

    function test_RevertsWhenUnderfunded() public {
        uint256 id = _register("underpaid", alice);
        uint256 short = terms.quote(id, 5) - 1; // hoisted: expectRevert would land on quote()
        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.renew{value: short}(id, 5);
    }

    /// The fee is read from the registry inside the call, so a raise landing between the dapp's
    /// quote and this transaction reverts the batch instead of spending more of the attached ETH.
    function test_RevertsWhenTheFeeRisesUnderAPendingCall() public {
        uint256 id = _register("feerise", alice);
        uint256 quoted = terms.quote(id, 5);

        uint256 raised = nft.defaultFee() * 2; // hoisted: the prank belongs to setDefaultFee
        vm.prank(owner);
        nft.setDefaultFee(raised);

        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.renew{value: quoted}(id, 5);
    }

    /// The mirror case: a fee cut is passed on rather than pocketed.
    function test_FeeCutIsRefundedNotKept() public {
        uint256 id = _register("feecut", alice);
        uint256 quoted = terms.quote(id, 4);

        uint256 cut = nft.defaultFee() / 4; // hoisted: the prank belongs to setDefaultFee
        vm.prank(owner);
        nft.setDefaultFee(cut);
        uint256 cheaper = terms.quote(id, 4);

        uint256 before = alice.balance;
        vm.prank(alice);
        terms.renew{value: quoted}(id, 4);

        assertEq(alice.balance, before - cheaper, "charged the new, lower price");
        assertEq(address(terms).balance, 0);
    }

    /// Subdomains have no independent expiry and `renew()` rejects them. The helper adds nothing
    /// here — it just surfaces the registry's own refusal.
    function test_RevertsOnSubdomain() public {
        uint256 parent = _register("parentname", alice);
        vm.prank(alice);
        uint256 sub = nft.registerSubdomain("kid", parent);

        vm.prank(alice);
        vm.expectRevert();
        terms.renew{value: 1 ether}(sub, 2);
    }

    /// Past grace the name is gone and renewal cannot bring it back — that is a re-registration,
    /// at premium, open to anyone. The helper must not paper over the difference.
    function test_RevertsPastGrace() public {
        uint256 id = _register("lapsed", alice);
        vm.warp(nft.expiresAt(id) + GRACE + 1);

        vm.prank(alice);
        vm.expectRevert();
        terms.renew{value: 1 ether}(id, 1);
    }

    function test_RevertsWhenTheCallerCannotTakeChange() public {
        uint256 id = _register("rejector", alice);
        RejectsETH r = new RejectsETH(terms);
        vm.deal(address(r), 10 ether);

        uint256 cost = terms.quote(id, 2);
        vm.expectRevert(WeiTerms.RefundFailed.selector);
        r.go(id, 2, cost + 1);

        // Exact payment makes no refund call at all, so a caller that cannot receive ETH is fine.
        r.go(id, 2, cost);
        assertGt(nft.expiresAt(id), 0);
    }

    /// Change is the caller's own `msg.value - spent`, never the contract's balance. Were it the
    /// balance, anyone could send 1 wei and turn every exact-payment call from a caller like this
    /// one into a `RefundFailed` revert.
    function test_StrayWeiCannotBrickAnExactPayer() public {
        uint256 id = _register("bricked", alice);
        RejectsETH r = new RejectsETH(terms);
        vm.deal(address(r), 10 ether);

        vm.deal(address(terms), 1); // a stranger's 1 wei
        uint256 cost = terms.quote(id, 2);
        uint256 start = nft.expiresAt(id);

        r.go(id, 2, cost);

        assertEq(nft.expiresAt(id), start + 2 * TERM, "the exact payer is unaffected");
        assertEq(address(terms).balance, 1, "and the stray wei is left where it was");
    }

    /*//////////////////////////////////////////////////////////////
                      SPENDING IS CAPPED BY msg.value
    //////////////////////////////////////////////////////////////*/

    /// ETH that arrives here outside a call is untouchable: the `msg.value` cap stops it funding
    /// renewals nobody paid for, and change is computed from `msg.value` rather than the balance,
    /// so it is not handed to a passer-by either.
    function test_StrayBalanceIsNeitherSpentNorPaidOut() public {
        uint256 id = _register("strayeth", alice);
        vm.deal(address(terms), 5 ether);

        // Asking for more terms than msg.value covers must fail even though the balance could pay.
        uint256 oneTerm = terms.quote(id, 1); // hoisted: expectRevert would land on quote()
        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.renew{value: oneTerm}(id, 4);

        // A properly funded call charges the quote and leaves the stray balance alone.
        uint256 cost = terms.quote(id, 2);
        uint256 before = alice.balance;
        vm.prank(alice);
        terms.renew{value: cost}(id, 2);

        assertEq(alice.balance, before - cost, "charged the quote, no more and no less");
        assertEq(address(terms).balance, 5 ether, "the stray balance is not the caller's to take");
    }

    /*//////////////////////////////////////////////////////////////
                   REGISTRATION: N YEARS IN ONE REVEAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Commit the way the dapp does for the helper path: bound to WeiTerms, with the
    ///      recipient folded into the secret.
    function _commitFor(string memory label, bytes32 innerSecret, address to, uint256 nTerms)
        internal
        returns (uint256 fee, uint256 premium)
    {
        bytes32 secret = keccak256(abi.encode(innerSecret, to, nTerms));
        vm.prank(to);
        nft.commit(keccak256(abi.encode(bytes(label), address(terms), secret)));
        vm.warp(block.timestamp + MIN_COMMIT_AGE + 1);
        fee = nft.getFee(bytes(label).length);
        premium = 0;
    }

    function test_RegisterBuysEveryTermInOneCall() public {
        bytes32 inner = keccak256("inner");
        (uint256 fee,) = _commitFor("freshname", inner, alice, 6);

        uint256 cost = fee * 6;
        uint256 startTime = block.timestamp;
        uint256 before = alice.balance;

        vm.prank(alice);
        uint256 id = terms.register{value: cost}("freshname", inner, alice, 6);

        assertEq(nft.ownerOf(id), alice, "the name is delivered, not held");
        assertEq(nft.expiresAt(id), startTime + 6 * TERM, "six years from one transaction");
        assertEq(alice.balance, before - cost, "charged exactly six fees");
        assertEq(address(terms).balance, 0);
    }

    function test_RegisterOneTermMatchesAPlainReveal() public {
        bytes32 inner = keccak256("inner1");
        (uint256 fee,) = _commitFor("singleyear", inner, alice, 1);
        uint256 startTime = block.timestamp;

        vm.prank(alice);
        uint256 id = terms.register{value: fee}("singleyear", inner, alice, 1);

        assertEq(nft.ownerOf(id), alice);
        assertEq(nft.expiresAt(id), startTime + TERM);
    }

    /// Anyone may broadcast the reveal — the commitment is not bound to the sender — so the
    /// recipient has to be bound instead. A copied transaction that redirects the name derives a
    /// different secret and matches nothing.
    function test_RegisterCannotBeFrontRunToAnotherRecipient() public {
        bytes32 inner = keccak256("inner2");
        (uint256 fee,) = _commitFor("targeted", inner, alice, 1);

        vm.prank(stranger);
        vm.expectRevert(); // CommitmentNotFound
        terms.register{value: fee}("targeted", inner, stranger, 1);
    }

    /// The term count is bound too, so a copy cannot settle the commitment for one year and
    /// leave the buyer with a name that expires nine years early.
    function test_RegisterCannotBeFrontRunToFewerTerms() public {
        bytes32 inner = keccak256("innerTerms");
        (uint256 fee,) = _commitFor("tenyears", inner, alice, 10);

        vm.prank(stranger);
        vm.expectRevert(); // CommitmentNotFound: a different term count is a different secret
        terms.register{value: fee}("tenyears", inner, alice, 1);

        // The buyer's own transaction is untouched by the attempt.
        uint256 startTime = block.timestamp;
        vm.prank(alice);
        uint256 id = terms.register{value: fee * 10}("tenyears", inner, alice, 10);
        assertEq(nft.expiresAt(id), startTime + 10 * TERM);
    }

    /// Copied verbatim, a front-run is pure loss for the copier: the name still lands with the
    /// intended recipient and the copier paid for it.
    function test_RegisterCopiedVerbatimStillDeliversToTheIntendedOwner() public {
        bytes32 inner = keccak256("inner3");
        (uint256 fee,) = _commitFor("copied", inner, alice, 1);

        uint256 strangerBefore = stranger.balance;
        vm.prank(stranger);
        uint256 id = terms.register{value: fee}("copied", inner, alice, 1);

        assertEq(nft.ownerOf(id), alice, "the intended recipient gets the name");
        assertEq(stranger.balance, strangerBefore - fee, "the copier paid for it");
    }

    function test_RegisterChargesThePremiumOnceNotPerTerm() public {
        // Register, let it lapse past grace, then re-register while a premium is decaying.
        uint256 old = _register("premiumname", stranger);
        vm.warp(nft.expiresAt(old) + GRACE + 1 days);

        uint256 premium = nft.getPremium(old);
        assertGt(premium, 0, "a premium is in force");

        bytes32 inner = keccak256("inner4");
        bytes32 secret = keccak256(abi.encode(inner, alice, uint256(5)));
        vm.prank(alice);
        nft.commit(keccak256(abi.encode(bytes("premiumname"), address(terms), secret)));
        vm.warp(block.timestamp + MIN_COMMIT_AGE + 1);

        uint256 fee = nft.getFee(11);
        uint256 live = nft.getPremium(old); // decays with time; re-read after the warp
        uint256 cost = live + fee * 5;
        uint256 before = alice.balance;

        vm.prank(alice);
        uint256 id = terms.register{value: cost}("premiumname", inner, alice, 5);

        assertEq(nft.ownerOf(id), alice);
        assertEq(alice.balance, before - cost, "premium once, fee five times");
        assertEq(address(terms).balance, 0);
    }

    function test_RevertsRegisterWhenUnderfundedForTheExtraTerms() public {
        bytes32 inner = keccak256("inner5");
        (uint256 fee,) = _commitFor("shortpay", inner, alice, 4);

        uint256 short = fee * 4 - 1;
        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.register{value: short}("shortpay", inner, alice, 4);
    }

    function test_RevertsRegisterOnBadTerms() public {
        bytes32 inner = keccak256("inner6");
        (uint256 fee,) = _commitFor("badterms", inner, alice, 1);
        uint256 over = terms.MAX_TERMS() + 1;

        vm.prank(alice);
        vm.expectRevert(WeiTerms.BadTerms.selector);
        terms.register{value: fee * 30}("badterms", inner, alice, over);

        vm.prank(alice);
        vm.expectRevert(WeiTerms.BadTerms.selector);
        terms.register{value: fee}("badterms", inner, alice, 0);
    }

    function test_RegisterRefundsOverpayment() public {
        bytes32 inner = keccak256("inner7");
        (uint256 fee,) = _commitFor("refundreg", inner, alice, 3);

        uint256 cost = fee * 3;
        uint256 before = alice.balance;
        vm.prank(alice);
        terms.register{value: cost + 2 ether}("refundreg", inner, alice, 3);

        assertEq(alice.balance, before - cost);
        assertEq(address(terms).balance, 0);
    }

    /// Nothing in this contract can move a name, so a name delivered here would be unrecoverable.
    function test_RevertsRegisterToTheHelperItself() public {
        bytes32 inner = keccak256("innerSelf");
        (uint256 fee,) = _commitFor("selfsend", inner, address(terms), 1);

        vm.prank(alice);
        vm.expectRevert(WeiTerms.BadRecipient.selector);
        terms.register{value: fee}("selfsend", inner, address(terms), 1);
    }

    /// The helper must never end a call still holding a name.
    function test_RegisterLeavesNoNameBehind() public {
        bytes32 inner = keccak256("inner8");
        (uint256 fee,) = _commitFor("nocustody", inner, alice, 2);

        vm.prank(alice);
        uint256 id = terms.register{value: fee * 2}("nocustody", inner, alice, 2);

        assertEq(nft.balanceOf(address(terms)), 0, "helper holds no names");
        assertEq(nft.ownerOf(id), alice);
    }

    /// Delivery is a plain `transferFrom`, so `to` is trusted to be able to hold the name. This
    /// contract cannot — it has no way to send one on again — so it refuses to be the recipient.

    /// A caller that cannot take change must still be able to buy, by paying exactly.
    function test_RegisterExactPaymentNeedsNoRefund() public {
        RejectsETH r = new RejectsETH(terms);
        vm.deal(address(r), 10 ether);

        bytes32 inner = keccak256("innerExact");
        bytes32 secret = keccak256(abi.encode(inner, address(alice), uint256(3)));
        vm.prank(alice);
        nft.commit(keccak256(abi.encode(bytes("exactpay"), address(terms), secret)));
        vm.warp(block.timestamp + MIN_COMMIT_AGE + 1);

        uint256 fee = nft.getFee(8);
        uint256 startTime = block.timestamp;
        r.register("exactpay", inner, alice, 3, fee * 3);

        uint256 id = nft.computeId("exactpay.wei");
        assertEq(nft.ownerOf(id), alice);
        assertEq(nft.expiresAt(id), startTime + 3 * TERM);
    }

    /// A stray balance cannot quietly buy terms the caller did not pay for.
    function test_RegisterStrayBalanceIsNotSpent() public {
        bytes32 inner = keccak256("inner9");
        (uint256 fee,) = _commitFor("straystray", inner, alice, 3);
        vm.deal(address(terms), 5 ether);

        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.register{value: fee}("straystray", inner, alice, 3);
    }

    /*//////////////////////////////////////////////////////////////
                          NOTHING GETS STUCK HERE
    //////////////////////////////////////////////////////////////*/

    /// A successful call leaves no ETH behind, so a balance is always an accident. `sweep` is the
    /// way out; it is open to anyone because there is no protocol balance for anyone to take.
    function test_SweepReturnsStrayEth() public {
        vm.deal(address(terms), 3 ether);
        uint256 before = stranger.balance;

        vm.prank(alice);
        terms.sweep(stranger);

        assertEq(stranger.balance, before + 3 ether);
        assertEq(address(terms).balance, 0);
    }

    function test_SweepOnAnEmptyBalanceIsANoOp() public {
        vm.prank(alice);
        terms.sweep(stranger);
        assertEq(address(terms).balance, 0);
    }

    /// The mint during `register` is the only token this should ever hold. Anything else would be
    /// unrecoverable, so the safe-transfer path is refused rather than accepted and stranded.
    function test_RejectsNamesSentHere() public {
        uint256 id = _register("misdirected", alice);

        vm.prank(alice);
        vm.expectRevert();
        nft.safeTransferFrom(alice, address(terms), id);

        assertEq(nft.ownerOf(id), alice, "the name stays with its owner");
    }

    /*//////////////////////////////////////////////////////////////
                            WHOLE PORTFOLIOS
    //////////////////////////////////////////////////////////////*/

    function test_RenewManyExtendsEachByItsOwnTermCount() public {
        uint256 a = _register("portfolioa", alice);
        uint256 b = _register("portfoliob", alice);
        uint256 c = _register("portfolioc", alice);
        uint256[] memory startAt = new uint256[](3);
        (startAt[0], startAt[1], startAt[2]) = (nft.expiresAt(a), nft.expiresAt(b), nft.expiresAt(c));

        uint256[] memory ids = new uint256[](3);
        uint256[] memory n = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
        (n[0], n[1], n[2]) = (1, 3, 10);

        uint256 cost = terms.quoteMany(ids, n);
        uint256 before = alice.balance;

        vm.prank(alice);
        terms.renewMany{value: cost + 1 ether}(ids, n);

        assertEq(nft.expiresAt(a), startAt[0] + TERM);
        assertEq(nft.expiresAt(b), startAt[1] + 3 * TERM);
        assertEq(nft.expiresAt(c), startAt[2] + 10 * TERM);
        assertEq(alice.balance, before - cost, "one payment, priced per name");
        assertEq(address(terms).balance, 0);
    }

    /// Names on different fee tiers are priced individually in the same batch.
    function test_RenewManyPricesEachTierSeparately() public {
        uint256[] memory lengths = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        (lengths[0], fees[0]) = (3, 0.05 ether);
        vm.prank(owner);
        nft.setLengthFees(lengths, fees);

        uint256 shortId = _register("xyz", alice);
        uint256 longId = _register("ordinaryname", alice);

        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](2);
        (ids[0], ids[1]) = (shortId, longId);
        (n[0], n[1]) = (2, 2);

        uint256 expected = 0.05 ether * 2 + nft.defaultFee() * 2;
        assertEq(terms.quoteMany(ids, n), expected);

        uint256 before = alice.balance;
        vm.prank(alice);
        terms.renewMany{value: expected}(ids, n);
        assertEq(alice.balance, before - expected);
    }

    /// All-or-nothing: one unrenewable name takes the whole batch down, so a holder never has to
    /// work out which half of a portfolio renewal actually landed.
    function test_RenewManyIsAllOrNothing() public {
        uint256 good = _register("goodname", alice);
        uint256 lapsed = _register("lapsedname", alice);
        uint256 goodStart = nft.expiresAt(good);
        vm.warp(nft.expiresAt(lapsed) + GRACE + 1);

        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](2);
        (ids[0], ids[1]) = (good, lapsed);
        (n[0], n[1]) = (2, 2);

        vm.prank(alice);
        vm.expectRevert();
        terms.renewMany{value: 10 ether}(ids, n);

        assertEq(nft.expiresAt(good), goodStart, "the renewable name was not extended either");
    }

    function test_RevertsRenewManyOnEmptyOrMismatched() public {
        uint256[] memory none = new uint256[](0);
        vm.expectRevert(WeiTerms.LengthMismatch.selector);
        terms.renewMany{value: 0}(none, none);

        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](1);
        vm.expectRevert(WeiTerms.LengthMismatch.selector);
        terms.renewMany{value: 1 ether}(ids, n);
    }

    function test_RenewManyCapsTotalAtMsgValue() public {
        uint256 a = _register("cappedone", alice);
        uint256 b = _register("cappedtwo", alice);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        (n[0], n[1]) = (3, 3);

        uint256 short = terms.quoteMany(ids, n) - 1; // hoisted: expectRevert would land on quoteMany()
        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.renewMany{value: short}(ids, n);
    }
}
