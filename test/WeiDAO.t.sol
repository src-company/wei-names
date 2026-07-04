// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAO} from "../src/WeiDAO.sol";

contract WeiDAOTest is Test {
    NameNFT nft;
    WeiDAO dao;

    // Four holders, each with one top-level name of a different length.
    // Weight = NameNFT.getFee(byteLength), i.e. expected contribution under the live config,
    // which we configure below so shorter (pricier) names rank higher.
    address alice = address(0xA11CE); // "ab"    len 2 -> 0.05 ether
    address bob = address(0xB0B); //     "cat"   len 3 -> 0.04 ether
    address carol = address(0xCA201); // "delta" len 5 -> 0.02 ether
    address dave = address(0xDA5E); //   "echo"  len 4 -> 0.03 ether
    address guardian = address(0x6DA12D);

    uint256 tAlice;
    uint256 tBob;
    uint256 tCarol;
    uint256 tDave;

    uint256 constant W_ALICE = 0.05 ether;
    uint256 constant W_BOB = 0.04 ether;
    uint256 constant W_CAROL = 0.02 ether;
    uint256 constant W_DAVE = 0.03 ether;
    uint256 constant QUORUM = 0.05 ether;

    function setUp() public {
        nft = new NameNFT();
        dao = new WeiDAO(address(nft), guardian, QUORUM);

        // Configure a length-graded fee schedule (shorter = pricier), then hand WNS to the DAO.
        address deployerOwner = nft.owner();
        uint256[] memory lens = new uint256[](4);
        uint256[] memory fees = new uint256[](4);
        lens[0] = 2;
        fees[0] = W_ALICE;
        lens[1] = 3;
        fees[1] = W_BOB;
        lens[2] = 4;
        fees[2] = W_DAVE;
        lens[3] = 5;
        fees[3] = W_CAROL;
        vm.startPrank(deployerOwner);
        nft.setLengthFees(lens, fees);
        nft.transferOwnership(address(dao)); // Treasury now owns WNS admin + fees.
        vm.stopPrank();
        assertEq(nft.owner(), address(dao));

        tAlice = _register("ab", alice);
        tBob = _register("cat", bob);
        tCarol = _register("delta", carol);
        tDave = _register("echo", dave);

        assertEq(dao.weightOf(tAlice), W_ALICE);

        // Enroll all four and let them season.
        _enroll(tAlice, alice);
        _enroll(tBob, bob);
        _enroll(tCarol, carol);
        _enroll(tDave, dave);
        vm.warp(block.timestamp + dao.MATURITY() + 1);
    }

    /*//////////////////////////////////////////////////////////////
                               HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function testWithdrawFeesToTreasury() public {
        vm.deal(address(nft), 5 ether); // Simulate accumulated registration fees.

        uint256 id = _proposeWithdraw();

        vm.prank(alice);
        dao.vote(id, tAlice, true);
        vm.prank(carol);
        dao.vote(id, tCarol, true);
        vm.prank(dave);
        dao.vote(id, tDave, true);
        vm.prank(bob);
        dao.vote(id, tBob, false);

        assertTrue(dao.passed(id));

        _warpToExecutable();
        dao.execute(id);

        assertEq(address(dao).balance, 5 ether);
        assertEq(address(nft).balance, 0);
    }

    function testExecuteOnlyOwnerSetting() public {
        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSelector(NameNFT.setDefaultFee.selector, uint256(0.5 ether)),
            "raise default fee",
            tAlice
        );
        _passAndWarp(id);
        dao.execute(id);
        assertEq(nft.defaultFee(), 0.5 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        TREASURY HOLDS ASSETS
    //////////////////////////////////////////////////////////////*/

    function testTreasuryCanCustodyName() public {
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(dao), tAlice); // exercises Receiver callback
        assertEq(nft.ownerOf(tAlice), address(dao));
    }

    /*//////////////////////////////////////////////////////////////
                      SEASONING / ANTI FLASH-MINT
    //////////////////////////////////////////////////////////////*/

    function testUnseasonedNameCannotVote() public {
        // A name enrolled after the proposal exists cannot vote it.
        uint256 tNew = _register("newbie", address(0xF00D));
        _enroll(tNew, address(0xF00D));

        uint256 id = _proposeWithdraw(); // createdAt == now; tNew just enrolled

        vm.prank(address(0xF00D));
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.vote(id, tNew, true);
        assertEq(dao.voteWeight(id, tNew), 0);
    }

    function testAnyoneCanEnrollAndSeason() public {
        uint256 tGift = _register("gift", bob); // len 4 -> 0.03 ether, unenrolled
        vm.prank(address(0x5555)); // a stranger seasons bob's name for him
        dao.enroll(tGift);
        vm.warp(block.timestamp + dao.MATURITY() + 1);

        uint256 id = _proposeWithdraw();
        vm.prank(bob);
        dao.vote(id, tGift, true);
        (,,,, uint256 forVotes,,,) = dao.proposals(id);
        assertEq(forVotes, W_DAVE); // getFee(4)
    }

    function testCannotResetEnrollment() public {
        // tAlice is already enrolled in setUp; a reset (same epoch) must revert (anti-grief).
        vm.expectRevert(WeiDAO.AlreadyEnrolled.selector);
        dao.enroll(tAlice);
    }

    function testCannotEnrollNonexistentName() public {
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.enroll(uint256(0xdeadbeef));
    }

    function testUnenrolledNameCannotVote() public {
        // "zulu" is registered and seasoned by time, but never enrolled.
        uint256 tZulu = _register("zulu", alice);
        vm.warp(block.timestamp + dao.MATURITY() + 1);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.vote(id, tZulu, true);
    }

    function testReRegistrationVoidsEnrollment() public {
        // Let "ab" fully expire, then re-register it to a new owner; stale seasoning must not
        // carry over (epoch binding).
        vm.warp(block.timestamp + 365 days + 90 days + 1); // past expiry + grace
        address attacker = address(0xBAD);
        uint256 tAb = _register("ab", attacker); // epoch bumps 1 -> 2; same tokenId
        assertEq(tAb, tAlice);
        assertEq(nft.ownerOf(tAlice), attacker);

        // A fresh, properly seasoned proposer (the originals all expired above).
        uint256 tProp = _register("proposer", carol);
        _enroll(tProp, carol);
        vm.warp(block.timestamp + dao.MATURITY() + 1);
        vm.prank(carol);
        uint256 id = dao.propose(
            address(nft), 0, abi.encodeWithSelector(NameNFT.withdraw.selector), "x", tProp
        );

        // Attacker holds tAlice; its stale enrollment (epoch 1) no longer matches epoch 2.
        assertEq(dao.voteWeight(id, tAlice), 0);
        vm.prank(attacker);
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.vote(id, tAlice, true);
    }

    /*//////////////////////////////////////////////////////////////
                    NAMES AS IDENTITY: DAO-OWNED PARENT
    //////////////////////////////////////////////////////////////*/

    /// Gift `dao.wei` to the treasury, then let governance mint role subdomains under it.
    /// On mainnet, dao.wei is owned by z0r0z.wei; here we mirror that and gift it locally.
    function testDaoMintsRoleSubdomainViaProposal() public {
        address z0r0z = makeAddr("z0r0z");
        uint256 tDao = _register("dao", z0r0z); // dao.wei
        vm.prank(z0r0z);
        nft.transferFrom(z0r0z, address(dao), tDao); // gift to the treasury
        assertEq(nft.ownerOf(tDao), address(dao));

        // A passed proposal mints contributor.dao.wei to a member (DAO owns the parent).
        address member = address(0xC0FFEE);
        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSelector(
                NameNFT.registerSubdomainFor.selector, "contributor", tDao, member
            ),
            "grant contributor role",
            tAlice
        );
        _passAndWarp(id);
        uint256 subId = abi.decode(dao.execute(id), (uint256));

        assertEq(nft.ownerOf(subId), member);
        assertEq(nft.getFullName(subId), "contributor.dao.wei");
        assertEq(subId, nft.computeId("contributor.dao.wei"));
    }

    /*//////////////////////////////////////////////////////////////
                     ONE-VOTE-PER-NAME / TRANSFER SAFETY
    //////////////////////////////////////////////////////////////*/

    function testTransferredNameCannotDoubleVote() public {
        uint256 id = _proposeWithdraw();

        vm.prank(alice);
        dao.vote(id, tAlice, true);

        address buyer = address(0xB0FFEE);
        vm.prank(alice);
        nft.transferFrom(alice, buyer, tAlice);
        assertEq(nft.ownerOf(tAlice), buyer);

        vm.prank(buyer);
        vm.expectRevert(WeiDAO.AlreadyVoted.selector);
        dao.vote(id, tAlice, false);
    }

    function testNonOwnerCannotVoteName() public {
        uint256 id = _proposeWithdraw();
        vm.prank(bob); // bob does not own tAlice
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.vote(id, tAlice, true);
    }

    function testBatchVoteMultipleNames() public {
        uint256 tAlice2 = _register("zephyrus", alice); // default fee 0.001 ether
        _enroll(tAlice2, alice);
        vm.warp(block.timestamp + dao.MATURITY() + 1);

        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSelector(NameNFT.setDefaultFee.selector, uint256(0.01 ether)),
            "batch",
            tAlice
        );

        uint256[] memory ids = new uint256[](2);
        ids[0] = tAlice;
        ids[1] = tAlice2;
        vm.prank(alice);
        dao.voteBatch(id, ids, true);

        (,,,, uint256 forVotes,,,) = dao.proposals(id);
        assertEq(forVotes, W_ALICE + nft.getFee(8));
    }

    /*//////////////////////////////////////////////////////////////
                               NEGATIVE
    //////////////////////////////////////////////////////////////*/

    function testProposeRequiresHolder() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.propose(address(nft), 0, "", "x", tAlice);
    }

    function testCannotExecuteWhileOpen() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, true);
        vm.expectRevert(WeiDAO.VotingOpen.selector);
        dao.execute(id);
    }

    function testCannotExecuteDuringTimelock() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, true);
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1); // voting closed, timelock not elapsed
        vm.expectRevert(WeiDAO.ExecutionLocked.selector);
        dao.execute(id);
    }

    function testRejectedBelowQuorum() public {
        uint256 id = _proposeWithdraw();
        vm.prank(carol); // 0.02 < QUORUM 0.05, majority but under quorum
        dao.vote(id, tCarol, true);
        assertFalse(dao.passed(id));
        _warpToExecutable();
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testRejectedWhenMajorityAgainst() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, false);
        vm.prank(bob);
        dao.vote(id, tBob, true);
        _warpToExecutable();
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    /*//////////////////////////////////////////////////////////////
                             GUARDIAN VETO
    //////////////////////////////////////////////////////////////*/

    function testGuardianCanCancelPassingProposal() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, true);
        vm.prank(dave);
        dao.vote(id, tDave, true);
        assertTrue(dao.passed(id));

        vm.prank(guardian);
        dao.cancel(id);

        _warpToExecutable();
        vm.expectRevert(WeiDAO.Canceled.selector);
        dao.execute(id);
        assertEq(address(nft).balance, 5 ether); // treasury untouched
    }

    function testNonGuardianCannotCancel() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        vm.expectRevert(WeiDAO.NotGuardian.selector);
        dao.cancel(id);
    }

    function testGuardianCannotCancelExecuted() public {
        uint256 id = _proposeWithdraw();
        _passAndWarp(id);
        dao.execute(id);
        vm.prank(guardian);
        vm.expectRevert(WeiDAO.AlreadyExecuted.selector);
        dao.cancel(id);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _proposeWithdraw() internal returns (uint256 id) {
        vm.prank(alice);
        id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSelector(NameNFT.withdraw.selector),
            "withdraw fees to treasury",
            tAlice
        );
    }

    function _passAndWarp(uint256 id) internal {
        vm.prank(alice);
        dao.vote(id, tAlice, true);
        vm.prank(dave);
        dao.vote(id, tDave, true);
        _warpToExecutable();
    }

    function _warpToExecutable() internal {
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + dao.EXECUTION_DELAY() + 1);
    }

    function _enroll(uint256 tokenId, address owner) internal {
        vm.prank(owner);
        dao.enroll(tokenId);
    }

    function _register(string memory label, address to) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(bytes(label));
        vm.startPrank(to);
        bytes32 commitment = nft.makeCommitment(label, to, secret);
        nft.commit(commitment);
        vm.warp(block.timestamp + 61);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.deal(to, fee);
        tokenId = nft.reveal{value: fee}(label, secret);
        vm.stopPrank();
    }
}
