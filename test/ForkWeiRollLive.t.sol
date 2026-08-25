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
}

interface ISteth {
    function sharesOf(address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Simulates the pending WeiDAO proposal — "fund roll.wei lottery round 0 with 1 ETH" —
///         against the *already-deployed, live* WeiRoll, not a fresh copy. It forks mainnet, binds
///         to the real contract at its address, sends 1 ETH the exact way the DAO's `execute` would
///         (a value call with empty calldata, msg.sender = the DAO, paid from the DAO's real
///         balance), and asserts round 0 simply keeps running with a bigger pot: same round number,
///         same deadline, same entrants, same odds. Then it carries that same round to a genuine
///         VRF draw to prove the DAO's ETH becomes prize money a real round-0 entrant wins.
///
///         Self-skips unless `RUN_FORK_LIVE=true`. Run:
///         `RUN_FORK_LIVE=true forge test --match-contract ForkWeiRollLive -vv`.
contract ForkWeiRollLive is Test {
    // The live deployment and its dependencies, all real mainnet addresses.
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    uint256 constant GAS_PRICE = 20 gwei;

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipped = true;
            return;
        }
        vm.createSelectFork(vm.rpcUrl("main3"));
        // The wrapper prices the VRF request off tx.gasprice; Foundry leaves it at 0 otherwise.
        vm.txGasPrice(GAS_PRICE);
    }

    modifier onlyFork() {
        if (skipped) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @notice The heart of the question: 1 ETH into the live pot leaves round 0 running, only
    ///         richer. Nothing about the round is disturbed — not its number, deadline, field, or
    ///         odds — and no idle ETH is left behind (it is staked into Lido on arrival).
    function testDaoFundingAddsToRoundZeroWithoutDisturbingIt() public onlyFork {
        // The live round exactly as it stands now.
        uint256 round0 = ROLL.round();
        uint256 end0 = ROLL.roundEnd();
        uint256 pot0 = ROLL.pot();
        uint256 tickets0 = ROLL.ticketCount(round0);
        uint256 weight0 = ROLL.totalWeight(round0);
        uint256 shares0 = ISteth(STETH).sharesOf(address(ROLL));

        assertEq(round0, 0, "these assertions are written for round 0");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 0 should be open right now");
        assertGt(end0, block.timestamp, "round 0 should still be counting down");
        assertGt(tickets0, 0, "expected live entrants in round 0");
        emit log_named_uint("round", round0);
        emit log_named_uint("entrants", tickets0);
        emit log_named_decimal_uint("pot before (stETH)", pot0, 18);
        emit log_named_uint("days left", (end0 - block.timestamp) / 1 days);

        // Fund it exactly as WeiDAO.execute would: p.target.call{value: p.value}(p.data) with
        // p.data empty and msg.sender = the DAO. The 1 ETH is drawn from the DAO's real balance,
        // so this also proves the treasury can actually afford the proposal.
        uint256 daoBefore = DAO.balance;
        assertGe(daoBefore, 1 ether, "the DAO cannot afford 1 ETH at this block");
        vm.prank(DAO);
        (bool ok,) = address(ROLL).call{value: 1 ether}("");
        assertTrue(ok, "the funding call reverted");
        assertEq(DAO.balance, daoBefore - 1 ether, "the ETH must come from the DAO treasury");

        // Round 0 is untouched but for the pot.
        assertEq(ROLL.round(), round0, "funding must not advance the round");
        assertEq(ROLL.roundEnd(), end0, "funding must not extend or reset the deadline");
        assertEq(ROLL.ticketCount(round0), tickets0, "the field must be preserved");
        assertEq(ROLL.totalWeight(round0), weight0, "everyone's odds must be unchanged");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "round 0 should still be open");

        // The pot grew by ~1 ETH (Lido credits a hair under 1:1 on the way in), and it is stETH,
        // not idle ETH sitting in the contract.
        assertApproxEqAbs(ROLL.pot(), pot0 + 1 ether, 4, "the pot should be up by 1 ETH");
        assertEq(address(ROLL).balance, 0, "nothing should be left unstaked");
        assertGt(ISteth(STETH).sharesOf(address(ROLL)), shares0, "1 ETH of shares should be minted");
        emit log_named_decimal_uint("pot after (stETH)", ROLL.pot(), 18);
    }

    /// @notice Everything else: the same live round, now carrying the DAO's ETH, is drawn for real
    ///         through Chainlink VRF and settles to one of its existing entrants — who is paid the
    ///         whole pot, the extra 1 ETH included. This is the proof the funding is not just parked
    ///         but actually becomes the prize the round pays out.
    function testFundedRoundZeroDrawsAndPaysAnEntrant() public onlyFork {
        uint256 round0 = ROLL.round();
        uint256 end0 = ROLL.roundEnd();
        uint256 pot0 = ROLL.pot();

        // The DAO tops it up mid-round.
        vm.prank(DAO);
        (bool ok,) = address(ROLL).call{value: 1 ether}("");
        assertTrue(ok, "funding failed");
        uint256 fundedPot = ROLL.pot();

        // Halfway through, nothing has changed but the balance.
        vm.warp((block.timestamp + end0) / 2);
        assertEq(ROLL.round(), round0, "still the same round midway");
        assertTrue(ROLL.phase() == WeiRoll.Phase.Open, "still open midway");

        // The deadline passes — the round becomes drawable.
        vm.warp(end0);
        assertTrue(ROLL.phase() == WeiRoll.Phase.Ready, "should be ready to draw at the deadline");
        uint256 fee = ROLL.drawPrice();
        assertGt(fee, 0, "the VRF fee should quote a real price");

        // Anyone can pull the draw, fronting the VRF fee from their own pocket.
        address caller = makeAddr("caller");
        vm.deal(caller, 1 ether);
        vm.prank(caller);
        ROLL.draw{value: fee}();

        uint256 requestId = ROLL.requestId();
        assertGt(requestId, 0, "no VRF request was made");

        // Deliver randomness the real way: coordinator -> wrapper -> our gas-limited callback.
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("live round 0 with the DAO's eth"));
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(requestId, words);

        // The winner is one of the round's actual entrants, and the prize is the whole pot the DAO
        // helped fill — pot0 plus the 1 ETH (no rebase happens on a static fork, so no yield drift).
        uint256 winner = ROLL.winnerOf(round0);
        assertGt(winner, 0, "the round did not settle");
        assertGt(ROLL.weightIn(round0, winner), 0, "the winner was not an entrant in this round");
        assertApproxEqAbs(ROLL.prizeOf(round0), fundedPot, 4, "the prize is the whole funded pot");
        assertApproxEqAbs(ROLL.prizeOf(round0), pot0 + 1 ether, 8, "the DAO's ETH is in the prize");
        assertEq(ROLL.round(), round0 + 1, "the round advanced after settling");
        assertEq(ROLL.pot(), 0, "the pot is fully reserved for the winner");
        emit log_named_string("winner", IWNS(NFT).getFullName(winner));
        emit log_named_decimal_uint("prize (stETH)", ROLL.prizeOf(round0), 18);

        // And the winner can actually take the money: the whole prize lands in their wallet as
        // stETH. (roll.wei is already held by the live contract, so the claim also badges.)
        address holder = IWNS(NFT).ownerOf(winner);
        uint256 prize = ROLL.prizeOf(round0);
        uint256 before = ISteth(STETH).balanceOf(holder);
        vm.prank(holder);
        ROLL.claim(round0);
        assertApproxEqAbs(
            ISteth(STETH).balanceOf(holder) - before, prize, 2, "the winner was not paid in full"
        );
        assertEq(ROLL.pot(), 0, "nothing should remain after the payout");
    }
}
