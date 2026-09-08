// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiTerms} from "../src/WeiTerms.sol";

/// @dev Re-enters the helper from the refund callback. `_refund` hands control to `msg.sender`
///      with all remaining gas, so this is the only place an attacker's code runs inside a call.
contract RefundReenterer {
    WeiTerms immutable terms;
    uint256 public mode; // 0 none, 1 renew free, 2 renewMany free, 3 sweep, 4 renew funded
    uint256 public target;
    address public sink;
    uint256 public received;
    bool public reentryReverted;
    bool public entered;

    constructor(WeiTerms t) {
        terms = t;
    }

    function arm(uint256 m, uint256 id, address s) external {
        mode = m;
        target = id;
        sink = s;
    }

    function renew(uint256 id, uint256 n, uint256 value) external {
        terms.renew{value: value}(id, n);
    }

    function renewMany(uint256[] calldata ids, uint256[] calldata n, uint256 value) external {
        terms.renewMany{value: value}(ids, n);
    }

    function register(string calldata label, bytes32 inner, address to, uint256 n, uint256 value)
        external
    {
        terms.register{value: value}(label, inner, to, n);
    }

    receive() external payable {
        received += msg.value;
        if (entered || mode == 0) return;
        entered = true;
        uint256[] memory ids = new uint256[](1);
        uint256[] memory n = new uint256[](1);
        ids[0] = target;
        n[0] = 1;
        if (mode == 1) {
            try terms.renew{value: 0}(target, 1) {} catch { reentryReverted = true; }
        } else if (mode == 2) {
            try terms.renewMany{value: 0}(ids, n) {} catch { reentryReverted = true; }
        } else if (mode == 3) {
            terms.sweep(sink);
        } else if (mode == 4) {
            // Re-enter with the whole balance this contract holds, funded or not.
            uint256 bal = address(this).balance;
            try terms.renew{value: bal}(target, 1) {} catch { reentryReverted = true; }
        }
        entered = false;
    }
}

/// @dev Refuses every ERC-721. `register` delivers with a plain `transferFrom`, so this must
///      still receive the name — the point of not using the safe variant.
contract RejectsERC721 {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("no thanks");
    }
}

/// @notice Adversarial probes for the multi-term helper: the paths where an attacker's code runs
///         inside a call, and the accounting edges the unit suite does not reach.
contract WeiTermsAdversarialTest is Test {
    address constant NFT_ADDR = 0x0000000000696760E15f265e828DB644A0c242EB;

    uint256 constant TERM = 365 days;
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

    function _commitFor(string memory label, bytes32 inner, address to, uint256 n)
        internal
        returns (uint256 fee)
    {
        bytes32 secret = keccak256(abi.encode(inner, to, n));
        nft.commit(keccak256(abi.encode(bytes(label), address(terms), secret)));
        vm.warp(block.timestamp + MIN_COMMIT_AGE + 1);
        fee = nft.getFee(bytes(label).length);
    }

    /*//////////////////////////////////////////////////////////////
                      REENTRANCY THROUGH THE REFUND
    //////////////////////////////////////////////////////////////*/

    /// The refund is the only hand-off to caller code. A re-entrant call carries its own
    /// `msg.value`, and spending is capped by that, so a zero-value re-entry buys nothing.
    function test_ReentrantRefundCannotBuyTermsForFree() public {
        uint256 id = _register("reentry", alice);
        uint256 fee = nft.getFee(7);
        uint64 before = uint64(nft.expiresAt(id));

        RefundReenterer atk = new RefundReenterer(terms);
        vm.deal(address(atk), 10 ether);
        atk.arm(1, id, address(0));

        atk.renew(id, 2, fee * 2 + 1 ether); // overpay, so a refund fires

        assertTrue(atk.reentryReverted(), "the free re-entry must revert");
        assertEq(nft.expiresAt(id), before + 2 * TERM, "only the paid-for terms landed");
        assertEq(address(terms).balance, 0, "nothing left behind");
    }

    function test_ReentrantRefundCannotBatchForFree() public {
        uint256 id = _register("reenttwo", alice);
        uint256 fee = nft.getFee(8);
        uint64 before = uint64(nft.expiresAt(id));

        RefundReenterer atk = new RefundReenterer(terms);
        vm.deal(address(atk), 10 ether);
        atk.arm(2, id, address(0));

        atk.renew(id, 3, fee * 3 + 1 ether);

        assertTrue(atk.reentryReverted(), "the free batch re-entry must revert");
        assertEq(nft.expiresAt(id), before + 3 * TERM, "only the paid-for terms landed");
        assertEq(address(terms).balance, 0, "nothing left behind");
    }

    /// A stray balance is documented as anyone's. What must not happen is the *caller's* change
    /// being sweepable: by the time caller code runs, the change has already left the contract.
    function test_SweepFromTheRefundCallbackCannotTakeTheChange() public {
        uint256 id = _register("sweeper", alice);
        uint256 fee = nft.getFee(7);

        RefundReenterer atk = new RefundReenterer(terms);
        vm.deal(address(atk), 10 ether);
        atk.arm(3, id, stranger); // sweep to a third party from inside the refund

        uint256 strangerBefore = stranger.balance;
        atk.renew(id, 1, fee + 3 ether);

        assertEq(atk.received(), 3 ether, "the change arrived in full");
        assertEq(stranger.balance, strangerBefore, "and there was nothing left to sweep");
        assertEq(address(terms).balance, 0, "nothing left behind");
    }

    /// Re-entering with real value is just a second purchase, paid for twice over. It must not
    /// be able to reach the outer call's money.
    function test_ReentrantFundedRenewBuysOnlyWhatItPaysFor() public {
        uint256 id = _register("funded", alice);
        uint256 fee = nft.getFee(6);
        uint64 before = uint64(nft.expiresAt(id));

        RefundReenterer atk = new RefundReenterer(terms);
        vm.deal(address(atk), 100 ether);
        atk.arm(4, id, address(0));

        uint256 atkBefore = address(atk).balance;
        atk.renew(id, 1, fee + 1 ether);

        // Outer bought one term; the re-entry paid for one more out of the same wallet.
        assertEq(nft.expiresAt(id), before + 2 * TERM, "two terms, both paid for");
        assertEq(atkBefore - address(atk).balance, fee * 2, "and exactly two fees left the wallet");
        assertEq(address(terms).balance, 0, "nothing left behind");
    }

    /*//////////////////////////////////////////////////////////////
                            ACCOUNTING EDGES
    //////////////////////////////////////////////////////////////*/

    /// A stray balance must not quietly top up an overpaying caller's refund either.
    function test_StrayIsNotHandedToAnOverpayer() public {
        uint256 id = _register("overpay", alice);
        uint256 fee = nft.getFee(7);
        vm.deal(address(terms), 5 ether);

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        terms.renew{value: fee * 2 + 1 ether}(id, 2);

        assertEq(aliceBefore - alice.balance, fee * 2, "alice paid the quote and no more");
        assertEq(address(terms).balance, 5 ether, "the stray balance is untouched");
    }

    /// Repeating a name across entries compounds it. The comment says so; pin the arithmetic and
    /// that the caller is charged for every one of them.
    function test_DuplicateEntriesCompoundAndAreEachPaidFor() public {
        uint256 id = _register("dupe", alice);
        uint256 fee = nft.getFee(4);
        uint64 before = uint64(nft.expiresAt(id));

        uint256[] memory ids = new uint256[](3);
        uint256[] memory n = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            ids[i] = id;
            n[i] = 25;
        }

        assertEq(terms.quoteMany(ids, n), fee * 75, "the quote counts every entry");

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        terms.renewMany{value: fee * 75}(ids, n);

        assertEq(nft.expiresAt(id), before + 75 * TERM, "75 years, in one transaction");
        assertEq(aliceBefore - alice.balance, fee * 75, "paid for every one");
        assertEq(address(terms).balance, 0, "nothing left behind");
    }

    /// The per-entry cap is 25, but nothing caps the basket, so the reachable expiry is far past
    /// anything a UI offers. It must still be arithmetic the registry can hold.
    function test_DeepCompoundingDoesNotOverflowTheExpiry() public {
        uint256 id = _register("deepdeep", alice);
        uint256 fee = nft.getFee(8);
        uint64 before = uint64(nft.expiresAt(id));

        uint256[] memory ids = new uint256[](25);
        uint256[] memory n = new uint256[](25);
        for (uint256 i; i < 25; ++i) {
            ids[i] = id;
            n[i] = 25;
        }

        vm.prank(alice);
        terms.renewMany{value: fee * 625}(ids, n);

        assertEq(nft.expiresAt(id), before + 625 * TERM, "625 years, still a uint64");
    }

    /// A basket that contains one unrenewable name must take none of the caller's money.
    function test_ABasketWithASubdomainTakesNothing() public {
        uint256 parent = _register("parenting", alice);
        vm.prank(alice);
        uint256 sub = nft.registerSubdomain("blog", parent);
        uint256 good = _register("goodname", alice);

        uint256[] memory ids = new uint256[](2);
        uint256[] memory n = new uint256[](2);
        (ids[0], n[0]) = (good, 3);
        (ids[1], n[1]) = (sub, 1);

        uint64 before = uint64(nft.expiresAt(good));
        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        vm.expectRevert();
        terms.renewMany{value: 10 ether}(ids, n);

        assertEq(nft.expiresAt(good), before, "the good name was not extended");
        assertEq(alice.balance, aliceBefore, "and nothing was taken");
    }

    /// `quote` reads `records()` for a token that may not exist. An unregistered id has no label,
    /// so this prices at the zero-length tier and returns a number that no renewal can spend.
    function test_QuoteAnswersForATokenThatDoesNotExist() public {
        uint256 ghost = uint256(keccak256("never registered"));
        uint256 quoted = terms.quote(ghost, 5);

        assertEq(quoted, nft.getFee(0) * 5, "it prices the empty label rather than reverting");
        assertTrue(quoted != 0, "and the answer is not obviously wrong");

        // Paying that quote does not buy anything: the registry rejects the token.
        vm.prank(alice);
        vm.expectRevert();
        terms.renew{value: quoted}(ghost, 5);
    }

    /*//////////////////////////////////////////////////////////////
                               DELIVERY
    //////////////////////////////////////////////////////////////*/

    /// Delivery is a plain `transferFrom` on purpose: a recipient must not be able to revert or
    /// re-enter the settlement by refusing the token.
    function test_ARecipientThatRefusesERC721StillGetsTheName() public {
        RejectsERC721 rec = new RejectsERC721();
        bytes32 inner = keccak256("inner");

        vm.startPrank(alice);
        uint256 fee = _commitFor("refuser", inner, address(rec), 4);
        uint256 id = terms.register{value: fee * 4}("refuser", inner, address(rec), 4);
        vm.stopPrank();

        assertEq(nft.ownerOf(id), address(rec), "delivered anyway");
        assertEq(nft.expiresAt(id), block.timestamp + 4 * TERM, "for all four years");
        assertEq(address(terms).balance, 0, "nothing left behind");
    }

    /// The helper must never end a call holding a name, whatever the recipient does.
    function test_RegisterNeverLeavesTheNameHere() public {
        RejectsERC721 rec = new RejectsERC721();
        bytes32 inner = keccak256("inner2");

        vm.startPrank(alice);
        uint256 fee = _commitFor("holdnone", inner, address(rec), 2);
        uint256 id = terms.register{value: fee * 2}("holdnone", inner, address(rec), 2);
        vm.stopPrank();

        assertTrue(nft.ownerOf(id) != address(terms), "the helper holds nothing");
        assertEq(nft.getApproved(id), address(0), "and took no approval");
        assertFalse(nft.isApprovedForAll(address(rec), address(terms)), "nor operator rights");
    }
}
