// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function getFullName(uint256) external view returns (string memory);
}
interface ISteth { function balanceOf(address) external view returns (uint256); }

/// @notice Round 0 has settled live (winner `lom.wei`, prize reserved, claim open to 2026-10-23).
///         This pins the question that follows: can round 1 run while that prize sits unclaimed?
///         Forked at head against the real contract — no mocks.
///         `RUN_FORK_R1=true forge test --match-contract ForkRollRound1 -vv`
contract ForkRollRound1 is Test {
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_R1", false)) { skipped = true; return; }
        vm.createSelectFork(vm.rpcUrl("main5"));
    }
    modifier onlyFork() { if (skipped) { vm.skip(true); return; } _; }

    function testRound1RunsWhileRound0PrizeIsStillUnclaimed() public onlyFork {
        // --- the live post-settlement state ---
        assertEq(ROLL.round(), 1, "round 1 is next");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Idle, "idle until funded");
        assertEq(ROLL.pot(), 0, "pot is empty: it all went to the winner");
        uint256 reserved = ROLL.reservedShares();
        uint256 prize = ROLL.prizeOf(0);
        uint256 winner = ROLL.winnerOf(0);
        address champ = IWNS(NFT).ownerOf(winner);
        emit log_named_string("round 0 winner", IWNS(NFT).getFullName(winner));
        emit log_named_decimal_uint("prize held in reserve (stETH)", prize, 18);

        // --- fund round 1, exactly as a DAO proposal or anyone else would ---
        vm.deal(DAO, 1 ether);
        vm.prank(DAO);
        (bool ok,) = address(ROLL).call{value: 1 ether}("");
        assertTrue(ok, "funding reverted");

        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 1 opened on the spot");
        assertEq(ROLL.round(), 1, "still round 1");
        assertEq(ROLL.roundEnd(), block.timestamp + ROLL.ROUND_LENGTH(), "a full 30-day window");
        assertApproxEqAbs(ROLL.pot(), 1 ether, 2, "round 1's pot is the new money only");
        assertEq(ROLL.reservedShares(), reserved, "the winner's shares were not touched");
        assertApproxEqAbs(ROLL.prizeOf(0), prize, 1e12, "round 0's prize is intact");
        assertTrue(ROLL.canClaim(0, champ), "and still claimable");

        // --- entries work immediately, including from the pending winner ---
        uint256 tok = ROLL.ticketAt(0, 0).tokenId; // a real round-0 entrant re-enters
        address holder = IWNS(NFT).ownerOf(tok);
        vm.prank(holder);
        ROLL.enter(tok, 0);
        assertEq(ROLL.ticketCount(1), 1, "round 1 has its first ticket");
        assertGt(ROLL.weightIn(1, tok), 0, "weight re-snapshotted for the new round");

        vm.prank(champ);
        ROLL.enter(winner, 0); // the unclaimed winner may play again with the same name
        assertEq(ROLL.ticketCount(1), 2);

        // --- and the round 0 claim still works, mid-round-1, untouched ---
        uint256 before = ISteth(STETH).balanceOf(champ);
        vm.prank(champ);
        ROLL.claim(0);
        assertApproxEqAbs(ISteth(STETH).balanceOf(champ) - before, prize, 2, "winner paid in full");
        assertEq(ROLL.reservedShares(), 0, "reserve released");
        assertApproxEqAbs(ROLL.pot(), 1 ether, 2, "round 1's pot is unchanged by the claim");
        assertEq(ROLL.ticketCount(1), 2, "round 1's field is undisturbed");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 1 still running");

        // the badge minted on the way out
        uint256 badge = ROLL.trophyOf(0);
        assertGt(badge, 0, "no badge");
        emit log_named_string("badge", IWNS(NFT).getFullName(badge));
        assertEq(IWNS(NFT).ownerOf(badge), champ);
    }

    /// @notice The other branch: nobody claims. The prize rolls into whatever is running.
    function testUnclaimedPrizeFoldsIntoTheOpenRound1() public onlyFork {
        uint256 prize = ROLL.prizeOf(0);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(ROLL).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 end1 = ROLL.roundEnd();

        vm.warp(ROLL.claimBy(0) + 1);
        vm.prank(makeAddr("anyone"));
        ROLL.rollOver(0);

        assertEq(ROLL.reservedShares(), 0);
        assertApproxEqAbs(ROLL.pot(), 1 ether + prize, 1e15, "forfeited prize joined round 1's pot");
        assertEq(ROLL.roundEnd(), end1, "round 1's deadline did not move");
        assertEq(ROLL.round(), 1);
    }
}
