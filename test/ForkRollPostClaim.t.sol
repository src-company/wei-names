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
    function sharesOf(address) external view returns (uint256);
}

/// @notice Round 0 has been claimed live by `lom.wei` (tx 0x74178a32…). Forked at head: the
///         post-claim books, then round 1 run to completion against the real wrapper, a repeat
///         win, a forfeit, and rounds after it — no mocks.
///         `RUN_FORK_POST=true forge test --match-contract ForkRollPostClaim -vv`
contract ForkRollPostClaim is Test {
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address constant LOM_HOLDER = 0x43dB7ED667b5019CC5C9117d727eafF485d35Eca;
    uint256 constant LOM = 0xdf001aa1613d8bc0118be86e756ab1587a2fb81065b5dc85894bb7f9314eabf0;

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_POST", false)) { skipped = true; return; }
        vm.createSelectFork(vm.rpcUrl("main3"));
    }

    modifier onlyFork() { if (skipped) { vm.skip(true); return; } _; }

    function _seedFor(uint256 r, uint256 i) internal view returns (uint256) {
        return i == 0 ? 0 : ROLL.ticketAt(r, i - 1).cum; // target = seed % total lands on ticket i
    }

    /// @dev Warp to roundEnd, draw at the live quote, deliver `seed` through coordinator -> wrapper.
    function _settle(uint256 seed) internal returns (uint256 r, uint256 winner) {
        r = ROLL.round();
        vm.warp(ROLL.roundEnd());
        vm.txGasPrice(2 gwei);
        assertTrue(ROLL.drawSettles(), "round must settle");
        uint256 price = ROLL.drawPrice();
        address caller = makeAddr("drawer");
        vm.deal(caller, price);
        uint256 potAtDraw = ROLL.pot();
        vm.prank(caller, caller);
        ROLL.draw{value: price}();
        uint256 id = ROLL.requestId();
        assertGt(id, 0);
        uint256[] memory words = new uint256[](1);
        words[0] = seed;
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(id, words);
        winner = ROLL.winnerOf(r);
        assertGt(winner, 0, "callback did not settle");
        assertTrue(ROLL.ticketOf(r, winner) != 0, "winner is not an entrant");
        assertApproxEqAbs(ROLL.prizeOf(r), potAtDraw, 1e9, "prize is the whole pot");
        assertEq(ROLL.pot(), 0);
        assertEq(ROLL.round(), r + 1);
        assertTrue(ROLL.phase() == WeiRoll.Phase.Idle);
    }

    function _claimAndCheckBadge(uint256 r, uint256 winner) internal {
        address holder = IWNS(NFT).ownerOf(winner);
        uint256 prize = ROLL.prizeOf(r);
        uint256 before = ISteth(STETH).balanceOf(holder);
        vm.prank(holder);
        ROLL.claim(r);
        assertApproxEqAbs(ISteth(STETH).balanceOf(holder) - before, prize, 2);
        assertEq(ROLL.prizeSharesOf(r), 0);
        (string memory label,,,,) = IWNS(NFT).records(winner);
        uint256 badge = ROLL.trophyOf(r);
        assertGt(badge, 0, "no badge");
        string memory rs = vm.toString(r);
        assertEq(IWNS(NFT).getFullName(badge), string.concat(label, ".", rs, ".roll.wei"));
        assertEq(IWNS(NFT).ownerOf(badge), holder);
        assertEq(IWNS(NFT).resolve(badge), holder);
        assertEq(IWNS(NFT).getFullName(ROLL.roundName(r)), string.concat(rs, ".roll.wei"));
        assertEq(IWNS(NFT).text(ROLL.roundName(r), "winner"), label);
        emit log_named_string("badge", IWNS(NFT).getFullName(badge));
    }

    /// @notice The live books after the claim: nothing owed, round 1 owns every share.
    function testPostClaimBooksBalance() public onlyFork {
        assertEq(ROLL.reservedShares(), 0, "round 0's reserve released exactly");
        assertEq(ROLL.prizeSharesOf(0), 0);
        assertEq(ROLL.winnerOf(0), LOM);
        assertEq(address(ROLL).balance, 0, "no stranded native ETH");
        assertEq(ROLL.pot(), ISteth(STETH).balanceOf(address(ROLL)), "pot is the whole balance");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 1 open");
        assertEq(ROLL.round(), 1);

        // Round 0 is spent: no second claim, no rollover, no rescue.
        vm.prank(LOM_HOLDER);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        ROLL.claim(0);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        ROLL.rollOver(0);
        vm.expectRevert(WeiRoll.NotStuck.selector);
        ROLL.rescue();

        // Namespace: roll.wei and 0.roll.wei stay here, the badge went to the winner.
        assertEq(IWNS(NFT).ownerOf(ROLL.PARENT()), address(ROLL));
        assertEq(IWNS(NFT).ownerOf(ROLL.roundName(0)), address(ROLL));
        assertEq(IWNS(NFT).getFullName(ROLL.trophyOf(0)), "lom.0.roll.wei");
        assertEq(IWNS(NFT).ownerOf(ROLL.trophyOf(0)), LOM_HOLDER);
        assertEq(IWNS(NFT).resolve(ROLL.roundName(0)), LOM_HOLDER);
        assertEq(IWNS(NFT).text(ROLL.roundName(0), "winner"), "lom");
        assertEq(IWNS(NFT).text(ROLL.roundName(0), "prize"), "1063209025185975128");
    }

    /// @notice Top-ups during round 1 grow its pot without moving its deadline.
    function testRound1TopUpAndEntry() public onlyFork {
        uint256 end = ROLL.roundEnd();
        uint256 pot = ROLL.pot();
        address funder = makeAddr("funder");
        vm.deal(funder, 0.5 ether);
        vm.prank(funder);
        (bool ok,) = address(ROLL).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(ROLL.roundEnd(), end, "deadline unchanged");
        assertApproxEqAbs(ROLL.pot(), pot + 0.5 ether, 3);
        assertEq(ROLL.reservedShares(), 0);

        // A round-0 entrant not yet in round 1 can still join.
        uint256 n = ROLL.ticketCount(0);
        for (uint256 i; i < n; ++i) {
            uint256 tok = ROLL.ticketAt(0, i).tokenId;
            if (ROLL.ticketOf(1, tok) != 0 || ROLL.weightOf(tok) == 0) continue;
            uint256 before = ROLL.ticketCount(1);
            vm.prank(IWNS(NFT).ownerOf(tok));
            ROLL.enter(tok, 0);
            assertEq(ROLL.ticketCount(1), before + 1);
            return;
        }
    }

    /// @notice Round 1 settles and pays, then round 2 opens on new funding and does the same.
    function testRound1ThenRound2() public onlyFork {
        (uint256 r, uint256 w) = _settle(uint256(keccak256("round one")));
        assertEq(r, 1);
        _claimAndCheckBadge(r, w);
        assertEq(ROLL.reservedShares(), 0);

        // Round 2: funding reopens, entries, settle, claim.
        address funder = makeAddr("funder2");
        vm.deal(funder, 0.1 ether);
        vm.prank(funder);
        (bool ok,) = address(ROLL).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open);
        assertEq(ROLL.round(), 2);
        uint256 entered;
        for (uint256 i; i < ROLL.ticketCount(1) && entered < 3; ++i) {
            uint256 tok = ROLL.ticketAt(1, i).tokenId;
            if (ROLL.weightOf(tok) == 0) continue;
            vm.prank(IWNS(NFT).ownerOf(tok));
            ROLL.enter(tok, 0);
            ++entered;
        }
        assertEq(ROLL.ticketCount(2), 3);
        (r, w) = _settle(uint256(keccak256("round two")));
        assertEq(r, 2);
        _claimAndCheckBadge(r, w);
    }

    /// @notice lom.wei winning again gets `lom.1.roll.wei` — no collision with its round-0 badge.
    function testRepeatWinnerGetsASeparateBadge() public onlyFork {
        if (ROLL.ticketOf(1, LOM) == 0) {
            vm.prank(LOM_HOLDER);
            ROLL.enter(LOM, 0);
        }
        uint256 i = ROLL.ticketOf(1, LOM) - 1;
        (uint256 r, uint256 w) = _settle(_seedFor(1, i));
        assertEq(w, LOM, "seed targets lom");
        _claimAndCheckBadge(r, w);
        assertEq(IWNS(NFT).getFullName(ROLL.trophyOf(1)), "lom.1.roll.wei");
        assertEq(IWNS(NFT).ownerOf(ROLL.trophyOf(0)), LOM_HOLDER, "round-0 badge untouched");
    }

    /// @notice An unclaimed round-1 prize rolls over after 30 days and reopens round 2 by itself.
    function testRound1ForfeitReopens() public onlyFork {
        (uint256 r,) = _settle(uint256(keccak256("forfeit")));
        uint256 shares = ROLL.prizeSharesOf(r);
        vm.warp(ROLL.claimBy(r) + 1);
        ROLL.rollOver(r);
        assertEq(ROLL.reservedShares(), 0);
        assertEq(ISteth(STETH).sharesOf(address(ROLL)), shares);
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "forfeit is funding");
        assertEq(ROLL.round(), 2);
    }
}
