// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface IVRFWrapper {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

interface IWeiDAO {
    function execute(uint256 id) external returns (bytes memory);
    function passed(uint256 id) external view returns (bool);
}

interface IWNS {
    function ownerOf(uint256) external view returns (address);
}

/// @notice Mainnet-fork rehearsal of the FIRST top-up of the live `roll.wei` lottery: WeiDAO
///         proposal 2 sends it 1 ETH mid-round, while round 0 already holds real tickets.
///
///         Funding is the one thing that touches a running round from outside, and `receive()`
///         both stakes and calls `_open()`. The worry is that a top-up disturbs the round it
///         lands in — extends the window, resets the field, or leaves the prize accounting
///         short. So this asserts the round is untouched around the top-up, then drives the
///         round all the way to a paid claim against the live Lido and the live Chainlink
///         wrapper, and checks the winner is paid the WHOLE pot including the new ETH.
///
///         Self-skips unless `RUN_FORK_TOPUP=true`.
///         Run: `RUN_FORK_TOPUP=true forge test --match-contract ForkRollTopUp -vv`
contract ForkRollTopUp is Test {
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;
    address constant ROLL = 0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    uint256 constant PROPOSAL = 2;
    uint256 constant TOP_UP = 1 ether;
    uint256 constant GAS_PRICE = 20 gwei;

    WeiRoll roll;
    bool skipped;

    modifier onlyFork() {
        if (skipped) return;
        _;
    }

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TOPUP", false)) {
            skipped = true;
            return;
        }
        vm.createSelectFork(vm.rpcUrl("main"));
        vm.txGasPrice(GAS_PRICE); // the wrapper prices off tx.gasprice; Foundry leaves it 0
        roll = WeiRoll(payable(ROLL));
    }

    /// @notice The top-up must not disturb the round it lands in.
    function testTopUpLeavesTheRunningRoundUntouched() public onlyFork {
        WeiRoll.State memory before = roll.state();
        assertEq(uint8(before.phase), uint8(WeiRoll.Phase.Open), "round must be open to test a mid-round top-up");
        assertGt(before.tickets, 0, "round should already have real entrants");
        assertTrue(IWeiDAO(DAO).passed(PROPOSAL), "proposal 2 has not reached threshold");

        uint256 daoBefore = DAO.balance;

        vm.prank(address(0xBEEF)); // execution is permissionless
        IWeiDAO(DAO).execute(PROPOSAL);

        WeiRoll.State memory afterState = roll.state();

        // The money moved, and all of it landed in the pot.
        assertEq(daoBefore - DAO.balance, TOP_UP, "DAO should send exactly the proposal value");
        assertApproxEqAbs(afterState.pot, before.pot + TOP_UP, 2 wei, "pot must grow by the whole top-up");
        assertEq(ROLL.balance, 0, "funding is staked on arrival, not left as raw ETH");

        // ...and nothing else about the round moved.
        assertEq(afterState.round, before.round, "top-up must not advance the round");
        assertEq(afterState.roundEnd, before.roundEnd, "top-up must not extend the entry window");
        assertEq(afterState.tickets, before.tickets, "top-up must not disturb the field");
        assertEq(afterState.totalWeight, before.totalWeight, "top-up must not change the odds");
        assertEq(afterState.requestId, before.requestId, "top-up must not touch a pending draw");
        assertEq(afterState.reserved, before.reserved, "top-up must not touch an owed prize");

        console2.log("tickets in round      ", before.tickets);
        console2.log("pot before (wei)      ", before.pot);
        console2.log("pot after  (wei)      ", afterState.pot);
        console2.log("roundEnd unchanged at ", afterState.roundEnd);
    }

    /// @notice The whole point: after the first top-up, a round still draws and pays out — and the
    ///         winner receives the topped-up pot, not the pot as it stood before the funding.
    function testRoundStillDrawsAndPaysTheToppedUpPot() public onlyFork {
        vm.prank(address(0xBEEF));
        IWeiDAO(DAO).execute(PROPOSAL);

        WeiRoll.State memory st = roll.state();
        uint256 potAfterTopUp = st.pot;
        assertGt(st.tickets, 1, "need at least two tickets for a settling draw");

        // Entries close, then anyone pays the VRF fee to draw.
        vm.warp(st.roundEnd + 1);
        assertTrue(roll.drawSettles(), "a funded round with a real field must settle on draw");

        uint256 price = roll.drawPrice();
        assertGt(price, 0, "live wrapper should quote a real price");
        address caller = address(0xCA11);
        vm.deal(caller, price * 2);
        vm.prank(caller, caller);
        roll.draw{value: price * 2}(); // over-send: the settling path refunds the excess

        uint256 requestId = roll.requestId();
        assertGt(requestId, 0, "draw should have requested randomness");

        // Deliver the callback the way it really arrives: coordinator -> wrapper -> consumer.
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("wns top-up rehearsal"));
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(requestId, words);

        uint256 r = st.round;
        uint256 winnerId = roll.winnerOf(r);
        assertGt(winnerId, 0, "a winner must have been picked");

        // The prize is the entire pot as it stood at settle — including the 1 ETH top-up.
        uint256 prize = roll.prizeOf(r);
        assertApproxEqRel(prize, potAfterTopUp, 0.001e18, "prize must be the topped-up pot");
        assertGt(prize, TOP_UP, "prize must exceed the top-up alone");

        // And the holder can actually take it.
        address winner = IWNS(NFT).ownerOf(winnerId);
        uint256 balBefore = _steth().balanceOf(winner);
        vm.prank(winner);
        roll.claim(r);
        assertApproxEqRel(
            _steth().balanceOf(winner) - balBefore, prize, 0.001e18, "winner must receive the prize in stETH"
        );

        // The round closed out cleanly: prize released, nothing left reserved for it.
        assertEq(roll.prizeSharesOf(r), 0, "claim must clear the reservation");
        assertEq(roll.round(), r + 1, "settle must advance the round");

        console2.log("winning tokenId       ", winnerId);
        console2.log("prize paid (wei)      ", prize);
        console2.log("pot at settle (wei)   ", potAfterTopUp);
        console2.log("VRF fee quoted (wei)  ", price);
    }

    /// @notice A top-up mid-round must not lock new entrants out of the round it lands in.
    function testEntryStillWorksAfterTheTopUp() public onlyFork {
        WeiRoll.State memory before = roll.state();

        vm.prank(address(0xBEEF));
        IWeiDAO(DAO).execute(PROPOSAL);

        // Any live top-level name whose holder we can impersonate. `wns.wei` is one of the
        // names already backing a proposal, so it is active and top-level by construction.
        uint256 id = uint256(0x68b4a9e9fae04030c8f659572b00f21bc0fa59020f307eb2cf37d98e7638e1da); // wns.wei
        address holder = IWNS(NFT).ownerOf(id);
        // Not a silent skip: if this name is already in, the test must say so loudly rather
        // than pass by doing nothing.
        assertEq(roll.ticketOf(before.round, id), 0, "fixture name is already entered - pick another");

        vm.prank(holder);
        roll.enter(id, 0);

        WeiRoll.State memory afterState = roll.state();
        assertEq(afterState.tickets, before.tickets + 1, "a new entry must still be accepted");
        assertGt(afterState.totalWeight, before.totalWeight, "the new ticket must carry weight");
    }

    function _steth() internal view returns (ISteth) {
        return ISteth(0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84);
    }
}

interface ISteth {
    function balanceOf(address) external view returns (uint256);
}
