// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function getFullName(uint256) external view returns (string memory);
    function transferFrom(address, address, uint256) external;
}
interface ISteth { function balanceOf(address) external view returns (uint256); }

/// @notice Who may collect round 0's live prize, against the deployed contract at head.
///         Two questions: was the draw independent of the winner, and is the claim actually
///         gated to whoever holds the winning name?
///         `RUN_FORK_CLAIM=true forge test --match-contract ForkRollClaimAuth -vv`
contract ForkRollClaimAuth is Test {
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;
    address constant DRAW_CALLER = 0xAE39Ed982aF86B50BAd2C6954F84E06cE4BC8feC;

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_CLAIM", false)) { skipped = true; return; }
        vm.createSelectFork(vm.rpcUrl("main3"));
    }
    modifier onlyFork() { if (skipped) { vm.skip(true); return; } _; }

    /// @notice The caller of {draw} had no stake in the outcome: not the winner, and not even
    ///         an entrant. (They could not have steered it either way — the field was frozen at
    ///         roundEnd and the seed is Chainlink's — but independence is worth showing.)
    function testTheDrawCallerIsNotTheWinnerAndHeldNoTicket() public onlyFork {
        uint256 winner = ROLL.winnerOf(0);
        address champ = IWNS(NFT).ownerOf(winner);
        assertTrue(DRAW_CALLER != champ, "the draw caller is not the winner");

        uint256 n = ROLL.ticketCount(0);
        uint256 owned;
        for (uint256 i; i < n; ++i) {
            if (IWNS(NFT).ownerOf(ROLL.ticketAt(0, i).tokenId) == DRAW_CALLER) owned++;
        }
        emit log_named_uint("tickets in the field", n);
        emit log_named_uint("tickets held by the draw caller", owned);
        assertEq(owned, 0, "the draw caller held no entry at all");
        emit log_named_string("winner", IWNS(NFT).getFullName(winner));
        emit log_named_address("winner held by", champ);
    }

    /// @notice The winner can collect, and nobody else can.
    function testOnlyTheHolderOfTheWinningNameCanClaim() public onlyFork {
        uint256 winner = ROLL.winnerOf(0);
        address champ = IWNS(NFT).ownerOf(winner);
        uint256 prize = ROLL.prizeOf(0);

        // Everyone who is not the holder is refused — including the parties with the strongest
        // claim to be "involved": whoever paid for the draw, the biggest entrant, and the DAO
        // that funded the pot.
        address[5] memory strangers = [
            DRAW_CALLER,
            0xE04885c3f1419C6E8495C33bDCf5F8387cd88846, // the 31.9% top holder
            DAO,
            address(ROLL),
            makeAddr("randomPasserby")
        ];
        for (uint256 i; i < strangers.length; ++i) {
            assertFalse(ROLL.canClaim(0, strangers[i]), "canClaim must be false for a stranger");
            vm.prank(strangers[i]);
            vm.expectRevert(WeiRoll.NotWinner.selector);
            ROLL.claim(0);
        }

        // And the holder is not refused.
        assertTrue(ROLL.canClaim(0, champ), "the holder can claim");
        uint256 before = ISteth(STETH).balanceOf(champ);
        vm.prank(champ);
        ROLL.claim(0);
        assertApproxEqAbs(ISteth(STETH).balanceOf(champ) - before, prize, 2, "paid in full");
        assertEq(ROLL.reservedShares(), 0, "escrow released");
        emit log_named_string("badge", IWNS(NFT).getFullName(ROLL.trophyOf(0)));

        // Not twice, and not by anyone afterwards.
        assertFalse(ROLL.canClaim(0, champ));
        vm.prank(champ);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        ROLL.claim(0);
    }

    /// @notice Holding the name is the whole test, so selling it hands the prize to the buyer —
    ///         the rule the contract documents, checked against the live registry.
    function testSellingTheNameMovesTheClaimToTheBuyer() public onlyFork {
        uint256 winner = ROLL.winnerOf(0);
        address champ = IWNS(NFT).ownerOf(winner);
        address buyer = makeAddr("buyer");

        vm.prank(champ);
        IWNS(NFT).transferFrom(champ, buyer, winner);

        assertFalse(ROLL.canClaim(0, champ), "the seller loses it");
        assertTrue(ROLL.canClaim(0, buyer), "the buyer gains it");
        vm.prank(champ);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        ROLL.claim(0);

        uint256 prize = ROLL.prizeOf(0);
        uint256 before = ISteth(STETH).balanceOf(buyer);
        vm.prank(buyer);
        ROLL.claim(0);
        assertApproxEqAbs(ISteth(STETH).balanceOf(buyer) - before, prize, 2, "buyer paid");
    }

    /// @notice The deadline is real in both directions: no claim after it, no rollover before it.
    function testTheClaimWindowIsEnforcedAtBothEnds() public onlyFork {
        uint256 winner = ROLL.winnerOf(0);
        address champ = IWNS(NFT).ownerOf(winner);
        uint256 deadline = ROLL.claimBy(0);

        vm.prank(makeAddr("anyone"));
        vm.expectRevert(WeiRoll.ClaimWindowOpen.selector);
        ROLL.rollOver(0);

        // Still fine on the last second.
        uint256 snap = vm.snapshotState();
        vm.warp(deadline);
        assertTrue(ROLL.canClaim(0, champ), "claimable up to and including the deadline");
        vm.revertToState(snap);

        // One second later it is gone, and only a rollover is left.
        vm.warp(deadline + 1);
        assertFalse(ROLL.canClaim(0, champ));
        vm.prank(champ);
        vm.expectRevert(WeiRoll.ClaimWindowOver.selector);
        ROLL.claim(0);

        vm.prank(makeAddr("anyone"));
        ROLL.rollOver(0);
        assertEq(ROLL.reservedShares(), 0, "prize returned to the pot");
    }
}
