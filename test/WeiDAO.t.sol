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
    uint256 constant TOTAL = W_ALICE + W_BOB + W_CAROL + W_DAVE; // 0.14 ether

    bytes32 root;
    bytes32[] proofAlice;
    bytes32[] proofBob;
    bytes32[] proofCarol;
    bytes32[] proofDave;

    function setUp() public {
        nft = new NameNFT();
        dao = new WeiDAO(address(nft), guardian);

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

        // Weight = expected contribution, ranked by length via the live config.
        assertEq(dao.weightOf(tAlice), W_ALICE);
        assertEq(dao.weightOf(tBob), W_BOB);
        assertEq(dao.weightOf(tCarol), W_CAROL);
        assertEq(dao.weightOf(tDave), W_DAVE);

        _buildTree();
    }

    /*//////////////////////////////////////////////////////////////
                               HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function testWithdrawFeesToTreasury() public {
        vm.deal(address(nft), 5 ether); // Simulate accumulated registration fees.

        uint256 id = _proposeWithdraw();

        vm.prank(alice);
        dao.vote(id, tAlice, true, proofAlice);
        vm.prank(carol);
        dao.vote(id, tCarol, true, proofCarol);
        vm.prank(dave);
        dao.vote(id, tDave, true, proofDave);
        vm.prank(bob);
        dao.vote(id, tBob, false, proofBob);

        assertTrue(dao.passed(id));

        vm.warp(block.timestamp + dao.VOTING_PERIOD() + dao.EXECUTION_DELAY() + 1);
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
            root,
            TOTAL,
            block.number,
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
                     ONE-VOTE-PER-NAME / TRANSFER SAFETY
    //////////////////////////////////////////////////////////////*/

    /// The core property: a name transferred mid-vote cannot be recounted for that proposal.
    function testTransferredNameCannotDoubleVote() public {
        uint256 id = _proposeWithdraw();

        vm.prank(alice);
        dao.vote(id, tAlice, true, proofAlice);

        address buyer = address(0xB0FFEE);
        vm.prank(alice);
        nft.transferFrom(alice, buyer, tAlice);
        assertEq(nft.ownerOf(tAlice), buyer);

        vm.prank(buyer);
        vm.expectRevert(WeiDAO.AlreadyVoted.selector);
        dao.vote(id, tAlice, false, proofAlice);
    }

    function testNonOwnerCannotVoteName() public {
        uint256 id = _proposeWithdraw();
        vm.prank(bob); // bob does not own tAlice
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.vote(id, tAlice, true, proofAlice);
    }

    function testBatchVoteMultipleNames() public {
        uint256 tAlice2 = _register("zephyrus", alice); // len 8 -> default fee 0.001 ether
        uint256 wAlice2 = nft.getFee(8);

        bytes32 la = _leaf(tAlice);
        bytes32 lb = _leaf(tAlice2);
        bytes32 batchRoot = _pair(la, lb);

        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSelector(NameNFT.setDefaultFee.selector, uint256(0.01 ether)),
            batchRoot,
            W_ALICE + wAlice2,
            block.number,
            "batch",
            tAlice
        );

        uint256[] memory ids = new uint256[](2);
        ids[0] = tAlice;
        ids[1] = tAlice2;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = new bytes32[](1);
        proofs[0][0] = lb;
        proofs[1] = new bytes32[](1);
        proofs[1][0] = la;

        vm.prank(alice);
        dao.voteBatch(id, ids, true, proofs);

        (,, uint256 forVotes,,,,,,,) = dao.proposals(id);
        assertEq(forVotes, W_ALICE + wAlice2);
    }

    /*//////////////////////////////////////////////////////////////
                               NEGATIVE
    //////////////////////////////////////////////////////////////*/

    function testProposeRequiresHolder() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.propose(address(nft), 0, "", root, TOTAL, block.number, "x", tAlice);
    }

    function testBadProofRejected() public {
        uint256 id = _proposeWithdraw();
        vm.prank(carol);
        vm.expectRevert(WeiDAO.BadProof.selector);
        dao.vote(id, tCarol, true, proofAlice); // carol's token, alice's proof
    }

    function testCannotExecuteWhileOpen() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, true, proofAlice);
        vm.expectRevert(WeiDAO.VotingOpen.selector);
        dao.execute(id);
    }

    function testCannotExecuteDuringTimelock() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, true, proofAlice);
        vm.prank(carol);
        dao.vote(id, tCarol, true, proofCarol);
        // Voting closed but timelock not yet elapsed.
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
        vm.expectRevert(WeiDAO.ExecutionLocked.selector);
        dao.execute(id);
    }

    function testGuardianCanCancelPassingProposal() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, true, proofAlice);
        vm.prank(carol);
        dao.vote(id, tCarol, true, proofCarol);
        vm.prank(dave);
        dao.vote(id, tDave, true, proofDave);
        assertTrue(dao.passed(id));

        // Guardian vetoes during the timelock window.
        vm.prank(guardian);
        dao.cancel(id);

        vm.warp(block.timestamp + dao.VOTING_PERIOD() + dao.EXECUTION_DELAY() + 1);
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

    function testRejectedWhenMajorityAgainst() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.vote(id, tAlice, false, proofAlice);
        vm.prank(carol);
        dao.vote(id, tCarol, false, proofCarol);
        vm.prank(bob);
        dao.vote(id, tBob, true, proofBob);
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + dao.EXECUTION_DELAY() + 1);
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testRejectedWithNoVotes() public {
        uint256 id = _proposeWithdraw();
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + dao.EXECUTION_DELAY() + 1);
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
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
            root,
            TOTAL,
            block.number,
            "withdraw fees to treasury",
            tAlice
        );
    }

    function _passAndWarp(uint256 id) internal {
        vm.prank(alice);
        dao.vote(id, tAlice, true, proofAlice);
        vm.prank(carol);
        dao.vote(id, tCarol, true, proofCarol);
        vm.prank(dave);
        dao.vote(id, tDave, true, proofDave);
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + dao.EXECUTION_DELAY() + 1);
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

    function _leaf(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(tokenId))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    // 4-leaf sorted Merkle tree matching Solady's MerkleProofLib folding.
    function _buildTree() internal {
        bytes32 l0 = _leaf(tAlice);
        bytes32 l1 = _leaf(tBob);
        bytes32 l2 = _leaf(tCarol);
        bytes32 l3 = _leaf(tDave);

        bytes32 n01 = _pair(l0, l1);
        bytes32 n23 = _pair(l2, l3);
        root = _pair(n01, n23);

        proofAlice = [l1, n23];
        proofBob = [l0, n23];
        proofCarol = [l3, n01];
        proofDave = [l2, n01];
    }
}
