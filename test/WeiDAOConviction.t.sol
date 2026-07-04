// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAOConviction} from "../src/WeiDAOConviction.sol";

contract WeiDAOConvictionTest is Test {
    NameNFT nft;
    WeiDAOConviction dao;

    address alice = address(0xA11CE); // "ab"    len 2 -> 0.05 ether
    address carol = address(0xCA201); // "delta" len 5 -> 0.02 ether
    address guardian = address(0x6DA12D);

    uint256 tAlice;
    uint256 tCarol;

    uint256 constant W_ALICE = 0.05 ether;
    uint256 constant W_CAROL = 0.02 ether;

    // Test-friendly, fast decay: alpha = 0.9, so C_max = w / 0.1 = 10·w.
    //   alice: C_max = 0.5 ether   carol: C_max = 0.2 ether
    uint256 constant ALPHA = 0.9 ether; // 0.9 * 1e18 per second
    uint256 constant THRESHOLD = 0.25 ether; // reachable by alice, never by carol alone

    function setUp() public {
        nft = new NameNFT();
        dao = new WeiDAOConviction(address(nft), guardian, ALPHA, THRESHOLD);

        address deployerOwner = nft.owner();
        uint256[] memory lens = new uint256[](2);
        uint256[] memory fees = new uint256[](2);
        lens[0] = 2;
        fees[0] = W_ALICE;
        lens[1] = 5;
        fees[1] = W_CAROL;
        vm.startPrank(deployerOwner);
        nft.setLengthFees(lens, fees);
        nft.transferOwnership(address(dao));
        vm.stopPrank();

        tAlice = _register("ab", alice);
        tCarol = _register("delta", carol);
        assertEq(dao.weightOf(tAlice), W_ALICE);
    }

    function testConvictionAccruesAndExecutes() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();

        vm.prank(alice);
        dao.support(id, tAlice);

        assertEq(dao.convictionOf(id), 0); // starts at zero
        vm.warp(block.timestamp + 10); // ~0.326 ether conviction > 0.25 threshold
        assertTrue(dao.passed(id));

        dao.execute(id);
        assertEq(address(dao).balance, 5 ether);
        assertEq(address(nft).balance, 0);
    }

    function testCannotExecuteFreshSupport() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice); // dt = 0 -> conviction 0
        vm.expectRevert(WeiDAOConviction.Rejected.selector);
        dao.execute(id);
    }

    function testInsufficientSupportNeverPasses() public {
        uint256 id = _proposeWithdraw();
        vm.prank(carol); // C_max = 0.2 ether < 0.25 threshold
        dao.support(id, tCarol);
        vm.warp(block.timestamp + 1_000_000); // effectively steady state
        assertFalse(dao.passed(id));
        vm.expectRevert(WeiDAOConviction.Rejected.selector);
        dao.execute(id);
    }

    function testUnsupportDecaysConviction() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 3); // some conviction, still < threshold
        assertFalse(dao.passed(id));

        vm.prank(alice);
        dao.unsupport(id, tAlice); // weight removed; conviction now decays
        vm.warp(block.timestamp + 100);
        assertFalse(dao.passed(id));
        vm.expectRevert(WeiDAOConviction.Rejected.selector);
        dao.execute(id);
    }

    function testGuardianCanCancel() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 10);
        assertTrue(dao.passed(id));

        vm.prank(guardian);
        dao.cancel(id);
        vm.expectRevert(WeiDAOConviction.Canceled.selector);
        dao.execute(id);
        assertEq(address(nft).balance, 5 ether);
    }

    function testDoubleSupportReverts() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.prank(alice);
        vm.expectRevert(WeiDAOConviction.AlreadySupported.selector);
        dao.support(id, tAlice);
    }

    function testSupportUnknownProposalReverts() public {
        vm.prank(alice);
        vm.expectRevert(WeiDAOConviction.NoProposal.selector);
        dao.support(999, tAlice);
    }

    function testTransferredNameSupportControlledByNewOwner() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);

        address buyer = address(0xB0FFEE);
        vm.prank(alice);
        nft.transferFrom(alice, buyer, tAlice);

        vm.prank(alice); // old owner can no longer touch it
        vm.expectRevert(WeiDAOConviction.NotHolder.selector);
        dao.unsupport(id, tAlice);

        vm.prank(buyer); // new owner controls it
        dao.unsupport(id, tAlice);
        assertEq(dao.supportOf(id, tAlice), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _proposeWithdraw() internal returns (uint256 id) {
        vm.prank(alice);
        id = dao.propose(
            address(nft), 0, abi.encodeWithSelector(NameNFT.withdraw.selector), "withdraw", tAlice
        );
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
