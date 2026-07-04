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
    address vetoAddr = address(0x5E70); // holds veto.dao.wei
    address execAddr = address(0xE7EC); // holds exec.dao.wei

    uint256 tAlice;
    uint256 tCarol;
    uint256 tDao;

    uint256 constant W_ALICE = 0.05 ether;
    uint256 constant W_CAROL = 0.02 ether;

    // 7-day half-life. alpha = round(2^(-1/604800) * 1e18).
    uint256 constant ALPHA = 999_998_853_923_940_000;
    uint256 constant HALF_LIFE = 7 days;

    // threshold = convictionMax(W_ALICE)/2 ⇒ alice's fresh name passes in ~one half-life.
    uint256 threshold;

    function setUp() public {
        threshold = W_ALICE * 1e18 / (1e18 - ALPHA) / 2;
        nft = new NameNFT();
        dao = new WeiDAO(address(nft), ALPHA, threshold, 0);

        address owner_ = nft.owner();
        uint256[] memory lens = new uint256[](2);
        uint256[] memory fees = new uint256[](2);
        lens[0] = 2;
        fees[0] = W_ALICE;
        lens[1] = 5;
        fees[1] = W_CAROL;
        vm.startPrank(owner_);
        nft.setLengthFees(lens, fees);
        nft.transferOwnership(address(dao));
        vm.stopPrank();

        tAlice = _register("ab", alice);
        tCarol = _register("delta", carol);
        vm.prank(alice);
        nft.setPrimaryName(tAlice); // proposers must have a primary name
        vm.prank(carol);
        nft.setPrimaryName(tCarol);

        // dao.wei + roles: z registers dao.wei, mints the role subdomains, gifts dao.wei to the DAO.
        address z = makeAddr("z0r0z");
        tDao = _register("dao", z);
        assertEq(tDao, dao.PROPOSAL_PARENT()); // hardcoded namehash sanity
        vm.startPrank(z);
        nft.registerSubdomainFor("veto", tDao, vetoAddr);
        nft.registerSubdomainFor("exec", tDao, execAddr);
        nft.transferFrom(z, address(dao), tDao);
        vm.stopPrank();

        assertEq(dao.vetoer(), vetoAddr);
        assertEq(dao.executor(), execAddr);
    }

    /*//////////////////////////////////////////////////////////////
                           CONVICTION VOTING
    //////////////////////////////////////////////////////////////*/

    function testSevenDayHalfLifeCalibration() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        assertEq(dao.convictionOf(id), 0);
        vm.warp(block.timestamp + HALF_LIFE);
        assertApproxEqRel(dao.convictionOf(id), threshold, 0.005e18); // α^7d ≈ 0.5
    }

    function testConvictionAccruesAndExecutes() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        assertTrue(dao.passed(id));
        dao.execute(id);
        assertEq(address(dao).balance, 5 ether);
    }

    function testNotPassedBeforeHalfLife() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 6 days);
        assertFalse(dao.passed(id));
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testCannotExecuteFreshSupport() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.expectRevert(WeiDAO.Rejected.selector);
        dao.execute(id);
    }

    function testUnsupportDecaysConviction() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        dao.unsupport(id, tAlice);
        vm.warp(block.timestamp + 30 days);
        assertFalse(dao.passed(id));
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

    function testAnyoneCanPruneExpiredSupport() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + 365 days + 90 days + 1); // "ab" expires
        assertEq(dao.weightOf(tAlice), 0);
        vm.prank(address(0x5151));
        dao.unsupport(id, tAlice);
        assertEq(dao.supportOf(id, tAlice), 0);
    }

    /*//////////////////////////////////////////////////////////////
                        WEIGHT = ETH CONTRIBUTED
    //////////////////////////////////////////////////////////////*/

    function testRenewalBoostsWeight() public {
        uint256 wBefore = dao.weightOf(tAlice);
        uint256 fee = nft.getFee(2);
        vm.deal(alice, fee);
        vm.prank(alice);
        nft.renew{value: fee}(tAlice);
        assertEq(dao.weightOf(tAlice) - wBefore, W_ALICE); // one extra year == one extra getFee
    }

    function testSubdomainHasNoWeight() public view {
        // veto.dao.wei is a subdomain — cost no ETH, earns no weight.
        assertGt(dao.weightOf(tDao), 0);
        assertEq(dao.weightOf(dao.VETO_ROLE()), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          ROLES: VETO & EXEC
    //////////////////////////////////////////////////////////////*/

    function testVetoerCanVeto() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        vm.prank(vetoAddr);
        dao.veto(id);
        vm.expectRevert(WeiDAO.Vetoed.selector);
        dao.execute(id);
        assertEq(address(nft).balance, 5 ether); // treasury untouched
    }

    function testExecCanVeto() public {
        uint256 id = _proposeWithdraw();
        vm.prank(execAddr);
        dao.veto(id);
        (,, bool vetoed,,,,,) = dao.proposals(id);
        assertTrue(vetoed);
    }

    function testNonRoleCannotVeto() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.veto(id);
    }

    function testExecForceExecutesBelowThreshold() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw(); // zero support, zero conviction
        vm.prank(execAddr);
        dao.execute(id); // god-mode: bypasses the threshold
        assertEq(address(dao).balance, 5 ether);
    }

    function testExecCanRescueWnsOwnership() public {
        // The whole point: exec can force-execute a NameNFT.transferOwnership to a safe address.
        address safe = makeAddr("safe");
        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSignature("transferOwnership(address)", safe),
            "rescue WNS",
            tAlice
        );
        vm.prank(execAddr);
        dao.execute(id);
        assertEq(nft.owner(), safe);
    }

    function testRolesLapseWhenParentExpires() public {
        vm.warp(block.timestamp + 365 days + 90 days + 1); // dao.wei expires past grace
        assertEq(dao.vetoer(), address(0));
        assertEq(dao.executor(), address(0)); // dead-man's-switch
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN (GOVERNANCE OR EXEC)
    //////////////////////////////////////////////////////////////*/

    function testExecCanSetKnobs() public {
        vm.startPrank(execAddr);
        dao.setThreshold(threshold * 3);
        dao.setProposalFee(0.01 ether);
        dao.setAlpha(0.9 ether);
        vm.stopPrank();
        assertEq(dao.threshold(), threshold * 3);
        assertEq(dao.proposalFee(), 0.01 ether);
        assertEq(dao.alpha(), 0.9 ether);
    }

    function testGovernanceCanSetThreshold() public {
        vm.prank(alice);
        uint256 id = dao.propose(
            address(dao),
            0,
            abi.encodeWithSelector(WeiDAO.setThreshold.selector, threshold * 2),
            "raise threshold",
            tAlice
        );
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        dao.execute(id);
        assertEq(dao.threshold(), threshold * 2);
    }

    function testSetThresholdUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.setThreshold(1);
    }

    function testProposalFeeEnforced() public {
        vm.prank(execAddr);
        dao.setProposalFee(0.01 ether);

        vm.prank(alice);
        vm.expectRevert(WeiDAO.InsufficientFee.selector);
        dao.propose(address(nft), 0, "", "x", tAlice);

        vm.deal(alice, 0.01 ether);
        vm.prank(alice);
        dao.propose{value: 0.01 ether}(address(nft), 0, "", "x", tAlice);
    }

    /*//////////////////////////////////////////////////////////////
                       WNS-NATIVE: NAMING & IDENTITY
    //////////////////////////////////////////////////////////////*/

    function testProposalsAutoNamedUnderParent() public {
        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft),
            0,
            abi.encodeWithSelector(NameNFT.withdraw.selector),
            "Fund grants",
            tAlice
        );
        string memory name = string.concat(vm.toString(id), ".dao.wei");
        uint256 subId = nft.computeId(name);
        assertEq(nft.ownerOf(subId), address(dao));
        assertEq(nft.getFullName(subId), name);
        assertEq(nft.text(subId, "description"), "Fund grants");
    }

    function testProposeRequiresPrimaryName() public {
        address dave = address(0xDA5E);
        uint256 tDave = _register("echo", dave); // holds a name, but no primary name set
        vm.prank(dave);
        vm.expectRevert(WeiDAO.NoPrimaryName.selector);
        dao.propose(address(nft), 0, "", "x", tDave);
    }

    function testProposeRequiresHolder() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.propose(address(nft), 0, "", "x", tAlice);
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
