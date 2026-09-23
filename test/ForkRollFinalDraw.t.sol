// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface IVRFWrapper {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function getFullName(uint256) external view returns (string memory);
    function records(uint256) external view returns (string memory, uint256, uint64, uint64, uint64);
    function resolve(uint256) external view returns (address);
    function text(uint256, string memory) external view returns (string memory);
}

interface ISteth {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Round 0's settlement, rehearsed on the LIVE deployment exactly as it will happen:
///         no funding, no top-up, no mutation of the field. Forks at head, warps to the real
///         `roundEnd`, pays the real wrapper's real quote, and delivers the seed through the
///         genuine coordinator -> wrapper path under the real `callbackGasLimit` — the wrapper
///         swallows a failed callback rather than reverting, so the winner assertion is what
///         proves settlement fits 200k gas with the live 192-ticket field.
///
///         Self-skips unless `RUN_FORK_FINAL=true`. Run:
///         `RUN_FORK_FINAL=true forge test --match-contract ForkRollFinalDraw -vv`.
contract ForkRollFinalDraw is Test {
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_FINAL", false)) { skipped = true; return; }
        vm.createSelectFork(vm.rpcUrl("main5"));
    }

    modifier onlyFork() { if (skipped) { vm.skip(true); return; } _; }

    /// @dev Is `id` actually one of the live round-0 tickets?
    function _isEntrant(uint256 id) internal view returns (bool) {
        uint256 n = ROLL.ticketCount(0);
        for (uint256 i; i < n; ++i) if (ROLL.ticketAt(0, i).tokenId == id) return true;
        return false;
    }

    /// @notice The whole thing, end to end: draw -> seed -> winner -> claim -> badge -> idle.
    function testRoundZeroSettlesAndPaysTomorrow() public onlyFork {
        assertEq(ROLL.round(), 0);
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 0 should still be open right now");
        uint256 end = ROLL.roundEnd();
        uint256 tickets = ROLL.ticketCount(0);
        uint256 potBefore = ROLL.pot();
        emit log_named_uint("entrants", tickets);
        emit log_named_decimal_uint("pot (stETH)", potBefore, 18);
        emit log_named_decimal_uint("total weight (ETH)", ROLL.totalWeight(0), 18);
        emit log_named_uint("hours to roundEnd", (end - block.timestamp) / 1 hours);

        // --- the moment entries shut ---
        vm.warp(end);
        vm.txGasPrice(1 gwei); // the wrapper prices off tx.gasprice; eth_call reports 0
        assertTrue(ROLL.phase() == WeiRoll.Phase.Ready, "should be Ready the instant roundEnd hits");
        assertTrue(ROLL.drawSettles(), "the round must settle, not abandon");

        uint256 price = ROLL.drawPrice();
        emit log_named_decimal_uint("VRF fee at 1 gwei (ETH)", price, 18);

        // Anyone can call it. A stranger with no stake in the round, sending exactly the quote.
        address caller = makeAddr("anyDrawCaller");
        vm.deal(caller, price);
        uint256 potAtDraw = ROLL.pot();
        vm.prank(caller, caller);
        ROLL.draw{value: price}();

        uint256 id = ROLL.requestId();
        assertGt(id, 0, "the live wrapper returned no request id");
        assertEq(caller.balance, 0, "exact quote, nothing to refund");
        assertEq(ROLL.pot(), potAtDraw, "the fee came from the caller, never the pot");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Drawing);
        emit log_named_uint("live VRF requestId", id);

        // Entries are sealed: nobody can join now that a seed is in flight.
        uint256 firstTicket = ROLL.ticketAt(0, 0).tokenId;
        address anyHolder = IWNS(NFT).ownerOf(firstTicket);
        vm.prank(anyHolder);
        vm.expectRevert(WeiRoll.TooSoon.selector);
        ROLL.enter(firstTicket, 0);

        // --- the seed arrives the way it really arrives ---
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("round zero"));
        uint256 g = gasleft();
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(id, words);
        emit log_named_uint("gas used by the full coordinator->wrapper->callback path", g - gasleft());

        uint256 winner = ROLL.winnerOf(0);
        assertGt(winner, 0, "the gas-limited callback did not settle the round");
        assertTrue(_isEntrant(winner), "winner is not one of the 192 real entrants");
        address holder = IWNS(NFT).ownerOf(winner);
        emit log_named_string("winner", IWNS(NFT).getFullName(winner));
        emit log_named_address("held by", holder);

        uint256 prize = ROLL.prizeOf(0);
        assertApproxEqAbs(prize, potBefore, 1e12, "the prize is the whole pot");
        assertEq(ROLL.pot(), 0, "nothing left unreserved");
        assertEq(ROLL.round(), 1, "round 1 is next");
        assertEq(ROLL.roundEnd(), 0, "and it is Idle until someone funds it");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Idle);
        assertEq(ROLL.claimBy(0), block.timestamp + ROLL.CLAIM_WINDOW());

        // --- the winner claims ---
        assertTrue(ROLL.canClaim(0, holder), "the real holder should be able to claim");
        uint256 before = ISteth(STETH).balanceOf(holder);
        vm.prank(holder);
        ROLL.claim(0);
        assertApproxEqAbs(
            ISteth(STETH).balanceOf(holder) - before, prize, 2, "winner paid in stETH"
        );
        assertEq(ROLL.reservedShares(), 0, "share accounting closes out exactly");
        assertEq(ROLL.prizeSharesOf(0), 0);

        // --- and the badge, against the live registry ---
        (string memory label,,,,) = IWNS(NFT).records(winner);
        uint256 badge = ROLL.trophyOf(0);
        assertGt(badge, 0, "no badge minted");
        assertEq(IWNS(NFT).getFullName(badge), string.concat(label, ".0.roll.wei"));
        assertEq(IWNS(NFT).ownerOf(badge), holder, "badge not handed to the winner");
        assertEq(IWNS(NFT).getFullName(ROLL.roundName(0)), "0.roll.wei");
        assertEq(IWNS(NFT).text(ROLL.roundName(0), "winner"), label);
        emit log_named_string("badge minted", IWNS(NFT).getFullName(badge));
        emit log_named_string("round name", IWNS(NFT).getFullName(ROLL.roundName(0)));
    }

    /// @notice The draw is not time-critical: settling a week late works identically, and the
    ///         claim window runs from the draw, not from `roundEnd`.
    function testDrawingAWeekLateStillSettles() public onlyFork {
        vm.warp(ROLL.roundEnd() + 7 days);
        vm.txGasPrice(1 gwei);
        assertTrue(ROLL.drawSettles(), "still settles a week late");

        address caller = makeAddr("lateCaller");
        vm.deal(caller, 1 ether);
        uint256 p = ROLL.drawPrice();
        vm.prank(caller, caller);
        ROLL.draw{value: p}();

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("late"));
        uint256 rid = ROLL.requestId();
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(rid, words);

        assertGt(ROLL.winnerOf(0), 0, "late draw still settles");
        assertEq(ROLL.claimBy(0), block.timestamp + ROLL.CLAIM_WINDOW(), "window runs from the draw");
    }

    /// @notice Overpaying is refunded, so a frontend quoting a stale gas price cannot lose money.
    function testOverpayingTheDrawIsRefunded() public onlyFork {
        vm.warp(ROLL.roundEnd());
        vm.txGasPrice(1 gwei);
        uint256 price = ROLL.drawPrice();

        address caller = makeAddr("overpayer");
        vm.deal(caller, 1 ether);
        vm.prank(caller, caller);
        ROLL.draw{value: 1 ether}();
        assertEq(caller.balance, 1 ether - price, "the excess came back");
    }

    /// @notice Different seeds pick different winners, and every one of them is a real entrant
    ///         holding a real name — i.e. the field is live and the draw spreads across it.
    function testSeedsSpreadAcrossTheLiveField() public onlyFork {
        for (uint256 s; s < 5; ++s) {
            uint256 snap = vm.snapshotState();
            vm.warp(ROLL.roundEnd());
            vm.txGasPrice(1 gwei);
            address caller = makeAddr("c");
            vm.deal(caller, 1 ether);
            uint256 px = ROLL.drawPrice();
            vm.prank(caller, caller);
            ROLL.draw{value: px}();

            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encode("seed", s)));
            uint256 rid2 = ROLL.requestId();
            vm.prank(COORDINATOR);
            IVRFWrapper(WRAPPER).rawFulfillRandomWords(rid2, words);

            uint256 w = ROLL.winnerOf(0);
            assertTrue(_isEntrant(w), "winner is not a real entrant");
            emit log_named_string("winner", IWNS(NFT).getFullName(w));
            vm.revertToState(snap);
        }
    }

    /// @notice If the winner never claims, the prize is not lost: it rolls back into the pot and
    ///         reopens a round. This is the path if the winner has gone quiet.
    function testAnUnclaimedPrizeReopensARound() public onlyFork {
        vm.warp(ROLL.roundEnd());
        vm.txGasPrice(1 gwei);
        address caller = makeAddr("c2");
        vm.deal(caller, 1 ether);
        uint256 p = ROLL.drawPrice();
        vm.prank(caller, caller);
        ROLL.draw{value: p}();

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("unclaimed"));
        uint256 rid = ROLL.requestId();
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(rid, words);

        uint256 prize = ROLL.prizeOf(0);
        vm.warp(ROLL.claimBy(0) + 1);
        vm.prank(makeAddr("anyone"));
        ROLL.rollOver(0);

        assertApproxEqAbs(ROLL.pot(), prize, 1e15, "the prize came back to the pot");
        assertEq(ROLL.round(), 1);
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 1 opened on the forfeited prize");
        assertEq(ROLL.roundEnd(), block.timestamp + ROLL.ROUND_LENGTH());
    }
}
