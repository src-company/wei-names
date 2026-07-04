// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAO} from "../src/WeiDAO.sol";

contract WeiDAOTest is Test {
    NameNFT nft;
    WeiDAO dao;

    address alice = address(0xA11CE); // "ab"    len 2 -> 0.05 ether
    address carol = address(0xCA201); // "delta" len 5 -> 0.02 ether
    address guardian = address(0x6DA12D);

    uint256 tAlice;
    uint256 tCarol;

    uint256 constant W_ALICE = 0.05 ether;
    uint256 constant W_CAROL = 0.02 ether;

    // Real calibration: 7-day half-life. alpha = round(2^(-1/604800) * 1e18).
    uint256 constant ALPHA = 999_998_853_923_940_000;
    uint256 constant HALF_LIFE = 7 days;

    // threshold = convictionMax(W_ALICE) / 2  ⇒  a proposal holding alice's weight passes
    // after exactly one half-life (7 days).
    uint256 threshold;

    function setUp() public {
        threshold = W_ALICE * 1e18 / (1e18 - ALPHA) / 2;
        nft = new NameNFT();
        // Default fixture: no fee, no primary-name requirement, no proposal-naming.
        dao = new WeiDAO(address(nft), guardian, ALPHA, threshold, 0, false, 0);

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
    }

    /// The half-life is real: alice's weight held for exactly 7 days accrues conviction equal
    /// to convictionMax/2 == threshold (α^7d ≈ 0.5).
    function testSevenDayHalfLifeCalibration() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);

        assertEq(dao.convictionMax(W_ALICE), 2 * threshold); // threshold == C_max/2

        vm.warp(block.timestamp + HALF_LIFE);
        // conviction(7d) = C_max·(1 − α^7d) ≈ C_max·0.5 == threshold, within fixed-point error.
        assertApproxEqRel(dao.convictionOf(id), threshold, 0.005e18); // 0.5%
    }

    function testConvictionAccruesAndExecutes() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);

        assertEq(dao.convictionOf(id), 0); // starts at zero
        vm.warp(block.timestamp + HALF_LIFE + 1 hours); // just past threshold
        assertTrue(dao.passed(id));

        dao.execute(id);
        assertEq(address(dao).balance, 5 ether);
        assertEq(address(nft).balance, 0);
    }

    function testNotPassedBeforeHalfLife() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 6 days); // one day short of the half-life
        assertFalse(dao.passed(id));
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testInsufficientWeightNeverPasses() public {
        // carol's C_max (0.02) < threshold (0.5·C_max of 0.05), so she can't pass alone, ever.
        uint256 id = _proposeWithdraw();
        vm.prank(carol);
        dao.support(id, tCarol);
        assertLt(dao.convictionMax(W_CAROL), threshold);
        vm.warp(block.timestamp + 365 days); // effectively steady state
        assertFalse(dao.passed(id));
    }

    function testCannotExecuteFreshSupport() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice); // dt = 0 -> conviction 0
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testUnsupportDecaysConviction() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 3 days); // partway, still below threshold
        assertFalse(dao.passed(id));

        vm.prank(alice);
        dao.unsupport(id, tAlice); // weight removed; conviction now decays
        vm.warp(block.timestamp + 30 days);
        assertFalse(dao.passed(id));
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testGuardianCanCancel() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        assertTrue(dao.passed(id));

        vm.prank(guardian);
        dao.cancel(id);
        vm.expectRevert(WeiDAO.Canceled.selector);
        dao.execute(id);
        assertEq(address(nft).balance, 5 ether);
    }

    function testProposalFeeFixture() public {
        WeiDAO d = new WeiDAO(address(nft), guardian, ALPHA, threshold, 0.01 ether, false, 0);
        assertEq(d.proposalFee(), 0.01 ether);

        vm.prank(alice);
        vm.expectRevert(WeiDAO.InsufficientFee.selector);
        d.propose(address(nft), 0, "", "no fee", tAlice);

        vm.deal(alice, 0.01 ether);
        vm.prank(alice);
        d.propose{value: 0.01 ether}(address(nft), 0, "", "with fee", tAlice);
        assertEq(address(d).balance, 0.01 ether); // fee lands in the treasury
    }

    function testRequirePrimaryNameFixture() public {
        WeiDAO d = new WeiDAO(address(nft), guardian, ALPHA, threshold, 0, true, 0);

        vm.prank(carol); // no primary name set
        vm.expectRevert(WeiDAO.NoPrimaryName.selector);
        d.propose(address(nft), 0, "", "x", tCarol);

        vm.prank(carol);
        nft.setPrimaryName(tCarol);
        vm.prank(carol);
        d.propose(address(nft), 0, "", "x", tCarol);
    }

    /// Proposals as a browsable WNS namespace: each mints `<id>.dao.wei` with its description.
    function testProposalsAutoNamedUnderParent() public {
        uint256 tDao = nft.computeId("dao.wei"); // namehash is known before registration
        WeiDAO d = new WeiDAO(address(nft), guardian, ALPHA, threshold, 0, false, tDao);

        address z = makeAddr("z0r0z");
        assertEq(_register("dao", z), tDao);
        vm.prank(z);
        nft.transferFrom(z, address(d), tDao); // gift dao.wei so the DAO can mint under it

        vm.prank(alice);
        uint256 id = d.propose(
            address(nft),
            0,
            abi.encodeWithSelector(NameNFT.withdraw.selector),
            "Fund grants",
            tAlice
        );

        string memory name = string.concat(vm.toString(id), ".dao.wei");
        uint256 subId = nft.computeId(name);
        assertEq(nft.ownerOf(subId), address(d));
        assertEq(nft.getFullName(subId), name);
        assertEq(nft.text(subId, "description"), "Fund grants");
    }

    /// Anyone may prune support from a name that has since expired (bounds lazy capture).
    function testAnyoneCanPruneExpiredSupport() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);

        vm.warp(block.timestamp + 365 days + 90 days + 1); // "ab" expires past grace
        assertEq(dao.weightOf(tAlice), 0);

        address stranger = address(0x5151);
        vm.prank(stranger);
        dao.unsupport(id, tAlice); // permissionless prune of ineligible support
        assertEq(dao.supportOf(id, tAlice), 0);
    }

    function testDoubleSupportReverts() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.prank(alice);
        vm.expectRevert(WeiDAO.AlreadySupported.selector);
        dao.support(id, tAlice);
    }

    function testSupportUnknownProposalReverts() public {
        vm.prank(alice);
        vm.expectRevert(WeiDAO.NoProposal.selector);
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
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.unsupport(id, tAlice);

        vm.prank(buyer); // new owner controls it
        dao.unsupport(id, tAlice);
        assertEq(dao.supportOf(id, tAlice), 0);
    }

    /// Gift `dao.wei` to the treasury, then let governance mint role subdomains under it.
    /// On mainnet, dao.wei is owned by z0r0z.wei; here we mirror that and gift it locally.
    function testDaoMintsRoleSubdomainViaProposal() public {
        address z0r0z = makeAddr("z0r0z");
        uint256 tDao = _register("dao", z0r0z);
        vm.prank(z0r0z);
        nft.transferFrom(z0r0z, address(dao), tDao); // gift to the treasury
        assertEq(nft.ownerOf(tDao), address(dao));

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
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        uint256 subId = abi.decode(dao.execute(id), (uint256));

        assertEq(nft.ownerOf(subId), member);
        assertEq(nft.getFullName(subId), "contributor.dao.wei");
        assertEq(subId, nft.computeId("contributor.dao.wei"));
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
