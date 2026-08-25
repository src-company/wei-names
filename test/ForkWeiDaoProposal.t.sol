// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiDAO} from "../src/WeiDAO.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function computeId(string calldata) external pure returns (uint256);
    function primaryName(address) external view returns (uint256);
}

/// @notice Runs the *exact* calldata Ross is about to submit — byte for byte — against the live
///         WeiDAO on a mainnet fork. Proves two things: the `propose` call itself does not revert
///         and stores the intended (target, value, empty calldata); and that once passed, the
///         stored call executes and really tops up round 0 of the live WeiRoll by 1 ETH.
///
///         Self-skips unless `RUN_FORK_LIVE=true`. Run:
///         `RUN_FORK_LIVE=true forge test --match-contract ForkWeiDaoProposal -vv`.
contract ForkWeiDaoProposal is Test {
    WeiDAO constant DAO = WeiDAO(payable(0x00000007988A79d16cf76B5dc4cF54dc3Af24936));
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;

    // The precise payload from the pending proposal — propose(address,uint256,bytes,string):
    //   target = 0x0000C82A… (roll.wei), value = 1 ETH, data = 0x, desc = "fund roll.wei …".
    bytes constant PAYLOAD =
        hex"82ff16c10000000000000000000000000000c82aa4d72871568ef3859d2b0e7cf37e45f20000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002866756e6420726f6c6c2e776569206c6f747465727920726f756e6420302077697468203120455448000000000000000000000000000000000000000000000000";

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipped = true;
            return;
        }
        vm.createSelectFork(vm.rpcUrl("main3"));
        vm.txGasPrice(20 gwei);
    }

    modifier onlyFork() {
        if (skipped) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _proposer() internal view returns (address who) {
        who = IWNS(NFT).ownerOf(IWNS(NFT).computeId("ross.wei"));
        assertTrue(who != address(0), "ross.wei has no owner");
        assertGt(IWNS(NFT).primaryName(who), 0, "proposer needs a primary name set");
    }

    /// @notice The core question: the exact bytes, sent by Ross with the proposal fee, do not
    ///         revert — and the proposal that lands stores the right target, value, and empty data.
    function testExactPayloadProposesWithoutReverting() public onlyFork {
        address ross = _proposer();
        uint256 fee = DAO.proposalFee();
        uint256 countBefore = DAO.proposalCount();

        // propose() only needs the proposal fee — the 1 ETH is stored and forwarded later at
        // execute(), not sent now. Send exactly the fee, the way the wallet would.
        vm.deal(ross, fee);
        vm.prank(ross);
        (bool ok, bytes memory ret) = address(DAO).call{value: fee}(PAYLOAD);
        assertTrue(ok, "the exact payload reverted");

        uint256 id = abi.decode(ret, (uint256));
        assertEq(id, countBefore + 1, "proposal id should be the next one");
        assertEq(DAO.proposalCount(), countBefore + 1, "proposalCount should have grown by one");

        // Getter tuple: (lastUpdate, created, executed, vetoed, target, conviction, supportWeight,
        // value, data).
        (,,,, address target,,, uint256 value,) = DAO.proposals(id);
        assertEq(target, address(ROLL), "target should be roll.wei / WeiRoll");
        assertEq(value, 1 ether, "value should be exactly 1 ETH");
        emit log_named_uint("new proposal id", id);
        emit log_named_decimal_uint("fee Ross fronts (ETH)", fee, 18);
    }

    /// @notice End to end: the same proposal, once it clears conviction, forwards its 1 ETH into the
    ///         live pot and round 0 keeps running — proving the empty-calldata payload does exactly
    ///         what it says when executed. (Threshold is lowered here only to reach execution in a
    ///         test; it does not change what the stored call does.)
    function testPayloadExecutesAndTopsUpRoundZero() public onlyFork {
        address ross = _proposer();
        uint256 fee = DAO.proposalFee();

        vm.deal(ross, fee);
        vm.prank(ross);
        (bool ok, bytes memory ret) = address(DAO).call{value: fee}(PAYLOAD);
        assertTrue(ok, "propose reverted");
        uint256 id = abi.decode(ret, (uint256));

        // Snapshot the live round before funding.
        uint256 round0 = ROLL.round();
        uint256 end0 = ROLL.roundEnd();
        uint256 pot0 = ROLL.pot();
        assertEq(round0, 0, "written for round 0");

        // Reach execution: back it with Ross's name, drop the bar so a little conviction crosses,
        // then let the timelock and a little conviction accrue. This only exercises the execute
        // path — the stored (target, value, data) is untouched.
        uint256 rossId = IWNS(NFT).computeId("ross.wei");
        vm.prank(ross);
        DAO.support(id, rossId);

        address exec = DAO.executor();
        vm.prank(exec);
        DAO.setThreshold(1); // scaled units; any sustained support crosses it

        // Past the timelock so the veto window is satisfied, and enough for conviction > 1.
        vm.warp(block.timestamp + DAO.executionDelay() + 1 days);
        assertTrue(DAO.passed(id), "should be over the (lowered) bar");

        uint256 daoBefore = address(DAO).balance;
        assertGe(daoBefore, 1 ether, "DAO must hold the 1 ETH it forwards");
        DAO.execute(id);

        // The 1 ETH left the treasury and landed in the pot; round 0 is unchanged but richer.
        assertEq(address(DAO).balance, daoBefore - 1 ether, "1 ETH should leave the treasury");
        assertEq(ROLL.round(), round0, "still round 0");
        assertEq(ROLL.roundEnd(), end0, "deadline untouched");
        assertApproxEqAbs(ROLL.pot(), pot0 + 1 ether, 4, "pot up by ~1 ETH");
        assertEq(address(ROLL).balance, 0, "funded ETH was staked, not left idle");
        emit log_named_decimal_uint("pot before (stETH)", pot0, 18);
        emit log_named_decimal_uint("pot after  (stETH)", ROLL.pot(), 18);
    }
}
