// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAO} from "../src/WeiDAO.sol";
import {LibString} from "solady/utils/LibString.sol";

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
        dao = new WeiDAO(address(nft), ALPHA, threshold, 0, 0, address(0)); // roles minted below

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

    /// @dev A passed proposal forwards its `value` in ETH from the treasury to its target.
    function testExecuteForwardsValue() public {
        vm.deal(address(dao), 3 ether);
        address payable sink = payable(makeAddr("sink"));
        vm.prank(alice);
        uint256 id = dao.propose(sink, 1 ether, "", "pay 1 ETH");
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        dao.execute(id);
        assertEq(sink.balance, 1 ether);
        assertEq(address(dao).balance, 2 ether);
    }

    /// @dev A failed execution reverts wholesale (executed flag doesn't latch), so it's retriable.
    function testExecuteFailureIsRetriable() public {
        address payable sink = payable(makeAddr("sink"));
        vm.prank(alice);
        uint256 id = dao.propose(sink, 5 ether, "", "overspend"); // more than treasury holds
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        vm.expectRevert(WeiDAO.ExecutionFailed.selector);
        dao.execute(id); // empty treasury -> transfer fails
        vm.deal(address(dao), 5 ether);
        dao.execute(id); // retry succeeds -> proves `executed` never latched
        assertEq(sink.balance, 5 ether);
    }

    /// @dev Weights sum across supporters, and a name below the minimum can never pass alone but
    ///      contributes once combined (carol's 0.02 < the 0.025 floor; alice's 0.05 tips it over).
    function testCombinedWeightPassesWhereOneCannot() public {
        uint256 id = _proposeWithdraw();
        vm.prank(carol);
        dao.support(id, tCarol); // 0.02 ETH: asymptote below threshold
        vm.warp(block.timestamp + 60 days);
        assertFalse(dao.passed(id)); // never crosses on its own
        vm.prank(alice);
        dao.support(id, tAlice); // +0.05 ETH -> 0.07 combined
        vm.warp(block.timestamp + HALF_LIFE);
        assertTrue(dao.passed(id)); // now clears
    }

    /// @dev A transferred name stays valid support (same snapshot, new controller); the new owner
    ///      can withdraw it, the old owner can't.
    function testTransferredNameKeepsSupport() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);
        uint256 w = dao.supportOf(id, tAlice);

        address bob = address(0xB0B);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tAlice);
        assertEq(dao.supportOf(id, tAlice), w); // still backing, unchanged

        vm.prank(alice);
        vm.expectRevert(WeiDAO.NotHolder.selector);
        dao.unsupport(id, tAlice); // old owner can't
        vm.prank(bob);
        dao.unsupport(id, tAlice); // new controller can
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

    /// @dev The sybil check: you cannot mint free subdomains (e.g. i.delta.wei) to print votes —
    ///      any name with a parent gets 0 weight and is rejected at `support`.
    function testSubdomainCannotVote() public {
        address bob = address(0xB0B);
        vm.prank(carol);
        uint256 sub = nft.registerSubdomainFor("i", tCarol, bob); // i.delta.wei, minted free
        uint256 nested;
        vm.prank(bob);
        nested = nft.registerSubdomainFor("x", sub, bob); // x.i.delta.wei, deeper still

        assertEq(dao.weightOf(sub), 0);
        assertEq(dao.weightOf(nested), 0);

        uint256 id = _proposeWithdraw();
        vm.prank(bob);
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.support(id, sub);
        vm.prank(bob);
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.support(id, nested);
    }

    /// @dev The dapp lets users vote by typing a name ("ross" or "ross.wei"); it resolves to a
    ///      tokenId via NameNFT.computeId. Prove both forms map to the real name and vote correctly.
    function testNameStringResolvesForVoting() public {
        // computeId strips the .wei suffix, so bare and suffixed forms give the SAME top-level id
        // (and the dapp also appends .wei when missing — either path lands here).
        assertEq(nft.computeId("ab"), tAlice);
        assertEq(nft.computeId("ab.wei"), tAlice);

        // Voting with the name-derived id is identical to voting with the raw tokenId.
        uint256 id = _proposeWithdraw();
        uint256 nameId = nft.computeId("ab.wei"); // resolve before the prank so it applies to support
        vm.prank(alice);
        dao.support(id, nameId);
        assertEq(dao.supportOf(id, tAlice), dao.weightOf(tAlice));
        assertGt(dao.supportOf(id, tAlice), 0);
    }

    /// @dev The CREATE2/3 deploy strategy: the deployer pre-approves the (deterministic) DAO address
    ///      for dao.wei, and the constructor pulls it in and sets the DAO's primary name so it
    ///      reverse-resolves to dao.wei — all atomically on deployment.
    function testConstructorPullsDaoWeiWhenApproved() public {
        NameNFT n = new NameNFT();
        address nameOwner = makeAddr("nameOwner");
        uint256 dw = _registerOn(n, "dao", nameOwner); // an EOA holds dao.wei
        assertEq(dw, dao.PROPOSAL_PARENT());

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(nameOwner);
        n.approve(predicted, dw); // pre-approve the counterfactual DAO
        address roleHolder = makeAddr("roleHolder");
        WeiDAO d = new WeiDAO(address(n), ALPHA, threshold, 0, 0, roleHolder);

        assertEq(address(d), predicted);
        assertEq(n.ownerOf(dw), address(d)); // pulled into the DAO on construction
        assertEq(n.reverseResolve(address(d)), "dao.wei"); // and reverse-resolves
        assertEq(d.vetoer(), roleHolder); // veto/exec minted to roleHolder in the constructor
        assertEq(d.executor(), roleHolder);
    }

    /// @dev Without the pre-approval, deployment still succeeds (best-effort) — dao.wei stays put.
    function testConstructorSkipsPullWithoutApproval() public {
        NameNFT n = new NameNFT();
        address nameOwner = makeAddr("nameOwner");
        _registerOn(n, "dao", nameOwner);
        WeiDAO d = new WeiDAO(address(n), ALPHA, threshold, 0, 0, makeAddr("roleHolder")); // no approval
        assertEq(n.ownerOf(dao.PROPOSAL_PARENT()), nameOwner); // not pulled
        assertTrue(address(d) != address(0));
        assertEq(d.executor(), address(0)); // pull skipped ⇒ no roles minted, none resolve
        assertEq(d.vetoer(), address(0));
    }

    /// @dev The dapp lets a proposal target be a .wei name, resolved to its address via
    ///      NameNFT.resolve (addr record, or owner fallback) — the path `toAddr()` uses.
    function testNameResolvesAsProposalTarget() public {
        assertEq(nft.resolve(nft.computeId("ab.wei")), alice); // no addr record set -> owner fallback

        vm.prank(alice);
        nft.setAddr(tAlice, address(0xCAFE)); // set an explicit addr record
        assertEq(nft.resolve(nft.computeId("ab.wei")), address(0xCAFE));
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
        (,,, bool vetoed,,,,,) = dao.proposals(id);
        assertTrue(vetoed);
    }

    function testNonRoleCannotVeto() public {
        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.veto(id);
    }

    /// @dev The vetoer cannot pre-veto a not-yet-created id (the bounded-id fix) — no bulk
    ///      pre-emptive freeze of the future proposal space.
    function testVetoCannotPreVeto() public {
        vm.prank(vetoAddr);
        vm.expectRevert(WeiDAO.NoProposal.selector);
        dao.veto(1); // nothing created yet

        uint256 id = _proposeWithdraw();
        vm.prank(vetoAddr);
        vm.expectRevert(WeiDAO.NoProposal.selector);
        dao.veto(id + 1); // still can't reach ahead of proposalCount
    }

    function testExecRescueSpendsTreasuryDirectly() public {
        // God-mode is a one-shot: no proposal, no vote.
        vm.deal(address(dao), 1 ether);
        address safe = makeAddr("safe");
        vm.prank(execAddr);
        dao.rescue(safe, 1 ether, "");
        assertEq(safe.balance, 1 ether);
    }

    function testExecCanRescueWnsOwnership() public {
        // The whole point: exec directly rescues WNS by calling NameNFT.transferOwnership.
        address safe = makeAddr("safe");
        vm.prank(execAddr);
        dao.rescue(address(nft), 0, abi.encodeWithSignature("transferOwnership(address)", safe));
        assertEq(nft.owner(), safe);
    }

    function testNonExecCannotRescue() public {
        vm.prank(alice);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.rescue(address(nft), 0, "");
    }

    function testRolesLapseWhenParentExpires() public {
        vm.warp(block.timestamp + 365 days + 90 days + 1); // dao.wei expires past grace
        assertEq(dao.vetoer(), address(0));
        assertEq(dao.executor(), address(0)); // dead-man's-switch
    }

    /// @dev Roles are void unless the DAO owns the active parent dao.wei — otherwise whoever holds
    ///      dao.wei (a failed handover, or a lapse + re-registration) could mint a role and seize
    ///      god-mode. Guards the dead-man's-switch against re-minting by a new parent owner.
    function testRolesVoidWhenDaoLosesParent() public {
        // Simulate a withdrawn/failed handover: dao.wei leaves the DAO to an external owner.
        address newParent = makeAddr("newParent");
        vm.prank(execAddr);
        dao.rescue(
            address(nft),
            0,
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)", address(dao), newParent, tDao
            )
        );
        // Role subdomains still exist and dao.wei is active, yet roles are void: the DAO no longer
        // owns the parent, so it no longer controls who may mint them.
        assertEq(dao.executor(), address(0));
        assertEq(dao.vetoer(), address(0));

        // The new dao.wei owner cannot re-mint a role to grab executor power.
        address attacker = makeAddr("attacker");
        vm.prank(newParent);
        nft.registerSubdomainFor("exec", tDao, attacker); // overwrites exec.dao.wei
        assertEq(dao.executor(), address(0)); // still void — DAO does not own the parent
        vm.prank(attacker);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.rescue(address(this), 0, "");
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN (GOVERNANCE OR EXEC)
    //////////////////////////////////////////////////////////////*/

    function testExecCanSetKnobs() public {
        vm.startPrank(execAddr);
        dao.setThreshold(threshold * 3);
        dao.setProposalFee(0.01 ether);
        dao.setAlpha(0.9 ether);
        dao.setExecutionDelay(2 days);
        vm.stopPrank();
        assertEq(dao.threshold(), threshold * 3);
        assertEq(dao.proposalFee(), 0.01 ether);
        assertEq(dao.alpha(), 0.9 ether);
        assertEq(dao.executionDelay(), 2 days);
    }

    /*//////////////////////////////////////////////////////////////
                         EXECUTION DELAY (TIMELOCK)
    //////////////////////////////////////////////////////////////*/

    /// @dev The floor holds even when conviction crosses `threshold` long before the delay elapses.
    function testExecutionDelayBlocksEarlyExecute() public {
        vm.deal(address(nft), 5 ether);
        vm.prank(execAddr);
        dao.setExecutionDelay(30 days);

        uint256 id = _proposeWithdraw();
        uint256 created = block.timestamp;
        vm.prank(alice);
        dao.support(id, tAlice);

        // Conviction passes, but the timelock has not — execution is blocked.
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        assertTrue(dao.passed(id));
        vm.expectRevert(WeiDAO.TooSoon.selector);
        dao.execute(id);

        // Once the delay elapses, it goes through.
        vm.warp(created + 30 days);
        dao.execute(id);
        assertEq(address(dao).balance, 5 ether);
    }

    /// @dev A whale whose weight dwarfs `W_req` crosses `threshold` in minutes; the floor is what
    ///      preserves the veto window it would otherwise erase.
    function testExecutionDelayFloorsWhaleWindow() public {
        vm.prank(execAddr);
        dao.setExecutionDelay(2 days);

        // Renew "ab" far ahead so its weight is ~100× the calibration weight W_ALICE.
        uint256 fee = nft.getFee(2);
        vm.deal(alice, fee * 100);
        for (uint256 i; i < 100; ++i) {
            vm.prank(alice);
            nft.renew{value: fee}(tAlice);
        }
        assertGt(dao.weightOf(tAlice), W_ALICE * 100);

        uint256 id = _proposeWithdraw();
        vm.prank(alice);
        dao.support(id, tAlice);

        // Conviction blows past threshold in ~90 minutes (vs a 7-day half-life at W_req)...
        vm.warp(block.timestamp + 90 minutes);
        assertTrue(dao.passed(id));
        // ...but the delay still gates execution.
        vm.expectRevert(WeiDAO.TooSoon.selector);
        dao.execute(id);
    }

    function testGovernanceCanSetExecutionDelay() public {
        vm.prank(alice);
        uint256 id = dao.propose(
            address(dao),
            0,
            abi.encodeWithSelector(WeiDAO.setExecutionDelay.selector, uint256(3 days)),
            "add timelock"
        );
        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        dao.execute(id);
        assertEq(dao.executionDelay(), 3 days);
    }

    function testSetExecutionDelayUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.setExecutionDelay(1 days);
    }

    function testSetExecutionDelayCapEnforced() public {
        vm.prank(execAddr);
        vm.expectRevert(WeiDAO.DelayTooLong.selector);
        dao.setExecutionDelay(31 days);
    }

    function testGovernanceCanSetThreshold() public {
        vm.prank(alice);
        uint256 id = dao.propose(
            address(dao),
            0,
            abi.encodeWithSelector(WeiDAO.setThreshold.selector, threshold * 2),
            "raise threshold"
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
        dao.propose(address(nft), 0, "", "x");

        vm.deal(alice, 0.01 ether);
        vm.prank(alice);
        dao.propose{value: 0.01 ether}(address(nft), 0, "", "x");
    }

    /*//////////////////////////////////////////////////////////////
                       WNS-NATIVE: NAMING & IDENTITY
    //////////////////////////////////////////////////////////////*/

    function testProposalsAutoNamedUnderParent() public {
        vm.prank(alice);
        uint256 id = dao.propose(
            address(nft), 0, abi.encodeWithSelector(NameNFT.withdraw.selector), "Fund grants"
        );
        string memory name = string.concat(vm.toString(id), ".dao.wei");
        uint256 subId = nft.computeId(name);
        assertEq(nft.ownerOf(subId), address(dao));
        assertEq(nft.getFullName(subId), name);
        assertEq(nft.text(subId, "description"), "Fund grants");
    }

    /// @dev Naming is best-effort: if the DAO no longer holds dao.wei, `propose` still succeeds
    ///      (no subdomain minted) instead of reverting — governance liveness never depends on it.
    function testProposeSucceedsWithoutNamespace() public {
        // exec moves dao.wei out of the DAO; roles now lapse to zero because the DAO no longer owns
        // the parent (see testRolesVoidWhenDaoLosesParent) — but propose must still succeed unnamed.
        vm.prank(execAddr);
        dao.rescue(
            address(nft),
            0,
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)", address(dao), execAddr, tDao
            )
        );
        assertEq(dao.executor(), address(0)); // roles void once the DAO no longer owns dao.wei

        vm.prank(alice);
        uint256 id = dao.propose(address(nft), 0, "", "no namespace");
        assertEq(id, 1); // created despite the missing namespace
        (,,,, address target,,,,) = dao.proposals(id);
        assertEq(target, address(nft));
        assertEq(nft.text(nft.computeId("1.dao.wei"), "description"), ""); // nothing minted/written
    }

    /// @dev A name that lapses and is re-registered (new epoch, possibly new owner) must not carry its
    ///      old support forward as a sticky, owner-only position — anyone can prune it (epoch changed).
    function testReregisteredNameSupportIsPrunable() public {
        vm.prank(alice);
        uint256 id = dao.propose(address(nft), 0, "", "p");
        vm.prank(alice);
        dao.support(id, tAlice);
        uint256 w = dao.supportOf(id, tAlice);
        assertGt(w, 0);
        (,,,,,, uint256 swBefore,,) = dao.proposals(id); // supportWeight is the 7th field

        // "ab" fully lapses (past grace) and a different party re-registers it: same token id, new epoch.
        vm.warp(block.timestamp + 365 days + 90 days + 1);
        address squatter = address(0x5804A7);
        bytes32 secret = keccak256("re-ab");
        vm.startPrank(squatter);
        nft.commit(nft.makeCommitment("ab", squatter, secret));
        vm.warp(block.timestamp + 61);
        vm.deal(squatter, 200 ether);
        uint256 reId = nft.reveal{value: 200 ether}("ab", secret); // covers fee + Dutch-auction premium
        vm.stopPrank();
        assertEq(reId, tAlice); // same namehash token id
        assertGt(dao.weightOf(tAlice), 0); // active again → the weightOf==0 prune path does NOT apply

        // A third party (not the new owner) can still prune the stale position via the epoch mismatch.
        address stranger = address(0x5171A9E7);
        vm.prank(stranger);
        dao.unsupport(id, tAlice);
        assertEq(dao.supportOf(id, tAlice), 0);
        (,,,,,, uint256 swAfter,,) = dao.proposals(id);
        assertEq(swAfter, swBefore - w); // stale weight removed from the proposal
    }

    /// @dev A name renewed (same epoch, still active) past its *support-time* term is prunable by
    ///      anyone — renewal can't silently keep a stale position alive; the owner must re-support.
    function testRenewedSupportIsPrunableAfterOriginalTerm() public {
        vm.prank(alice);
        uint256 id = dao.propose(address(nft), 0, "", "p");
        vm.prank(alice);
        dao.support(id, tAlice);
        assertGt(dao.supportOf(id, tAlice), 0);

        // Anyone renews "ab" before it expires — extends the term, epoch unchanged (public good).
        uint256 fee = nft.getFee(2);
        vm.deal(address(this), fee);
        nft.renew{value: fee}(tAlice);

        // Past the ORIGINAL support-time expiry but within the renewed term: active, same epoch, yet
        // the supported runway has elapsed — so a third party may prune it.
        vm.warp(block.timestamp + 366 days);
        assertGt(dao.weightOf(tAlice), 0); // renewed → still active (not the weightOf==0 path)
        assertEq(nft.ownerOf(tAlice), alice); // still Alice's name, same epoch

        vm.prank(makeAddr("stranger"));
        dao.unsupport(id, tAlice);
        assertEq(dao.supportOf(id, tAlice), 0);
    }

    function testProposeDescriptionLengthBoundary() public {
        uint256 max = dao.MAX_DESCRIPTION_BYTES();
        vm.prank(alice);
        dao.propose(address(nft), 0, "", string(new bytes(max))); // exactly the cap is accepted
        vm.prank(alice);
        vm.expectRevert(WeiDAO.DescriptionTooLong.selector);
        dao.propose(address(nft), 0, "", string(new bytes(max + 1))); // one over reverts
    }

    function testProposeRequiresPrimaryName() public {
        address dave = address(0xDA5E);
        _register("echo", dave); // holds a name, but no primary name set
        vm.prank(dave);
        vm.expectRevert(WeiDAO.NoPrimaryName.selector);
        dao.propose(address(nft), 0, "", "x");
    }

    function testSubdomainPrimaryCannotPropose() public {
        // A proposer's primary name must be a weighted top-level name; a subdomain earns 0.
        address bob = address(0xB0B);
        vm.prank(carol);
        uint256 subId = nft.registerSubdomainFor("bob", tCarol, bob);
        vm.prank(bob);
        nft.setPrimaryName(subId);
        vm.prank(bob);
        vm.expectRevert(WeiDAO.NotEligible.selector);
        dao.propose(address(nft), 0, "", "x");
    }

    /*//////////////////////////////////////////////////////////////
                        ERC-8244: ON-CHAIN DAPP
    //////////////////////////////////////////////////////////////*/

    function testHtmlRendersLiveState() public {
        vm.deal(address(dao), 2.5 ether);
        vm.prank(alice);
        dao.propose(
            address(nft), 0, abi.encodeWithSelector(NameNFT.withdraw.selector), "Fund grants"
        );

        string memory page = dao.html();
        assertTrue(LibString.startsWith(page, "<!doctype html>")); // default shell
        assertTrue(LibString.contains(page, "WeiDAO"));
        assertTrue(LibString.contains(page, "Under governance")); // treasury + WNS balance
        assertTrue(LibString.contains(page, "treasury 2.5000")); // DAO balance in the breakdown
        assertTrue(LibString.contains(page, "1.dao.wei")); // proposal row
        assertTrue(LibString.contains(page, "building")); // status
        assertTrue(LibString.contains(page, "Fund grants")); // description read from the WNS name
        assertTrue(LibString.contains(page, "calldata")); // expandable raw calldata drill-down
    }

    /// @dev The list is capped per page and pages back through older proposals via `?from=`.
    function testRequestPagesOlderProposals() public {
        for (uint256 i; i < 5; ++i) {
            _proposeWithdraw();
        }
        string[] memory res = new string[](0);
        WeiDAO.KeyValue[] memory params = new WeiDAO.KeyValue[](1);
        params[0] = WeiDAO.KeyValue("from", "3");
        (, string memory body,) = dao.request(res, params);
        assertTrue(LibString.contains(body, "Showing 1&ndash;3 of 5"));
        assertTrue(LibString.contains(body, ">3.dao.wei<")); // in the window
        assertFalse(LibString.contains(body, ">5.dao.wei<")); // above the window
        assertTrue(LibString.contains(body, "newer")); // newer page exists
    }

    function testHtmlEscapesDescription() public {
        vm.prank(alice);
        dao.propose(address(nft), 0, "", "<script>x</script>");
        string memory page = dao.html();
        assertTrue(LibString.contains(page, "&lt;script&gt;")); // escaped
        assertFalse(LibString.contains(page, "<script>x")); // raw injection absent
    }

    function testExecCanSetHtmlShell() public {
        vm.prank(execAddr);
        dao.setHtml("<main>brand {{state}}</main>");
        string memory page = dao.html();
        assertTrue(LibString.startsWith(page, "<main>brand <header>"));
    }

    function testSetHtmlUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(WeiDAO.Unauthorized.selector);
        dao.setHtml("<p>nope</p>");
    }

    /// @dev Execute-ready proposals are pinned in a spotlight above the list; building ones aren't.
    function testHtmlSpotlightsExecutable() public {
        vm.deal(address(nft), 5 ether);
        uint256 id = _proposeWithdraw();
        assertFalse(LibString.contains(dao.html(), "Ready to execute")); // nothing ready yet

        vm.prank(alice);
        dao.support(id, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours); // executionDelay is 0 in this suite
        string memory page = dao.html();
        assertTrue(LibString.contains(page, "Ready to execute"));
        assertTrue(LibString.contains(page, string.concat("wd.execute('", vm.toString(id), "')")));
    }

    /// @dev The kicker: dao.wei resolves to the WeiDAO contract with no wiring (owner fallback), so
    ///      an ERC-8244 gateway calls html() live.
    function testDaoWeiResolvesToContract() public view {
        assertEq(nft.resolve(tDao), address(dao));
    }

    /// @dev A minted proposal name is self-describing — description/target/value resolver records —
    ///      and the name resolves to the proposal's target (each id is its own subdomain, so targets
    ///      reused across proposals never collide).
    function testProposalNameIsSelfDescribing() public {
        address target = address(0xBEEF);
        vm.prank(alice);
        uint256 id = dao.propose(target, 1 ether, "", "grant round");
        uint256 sub = nft.computeId(string.concat(vm.toString(id), ".dao.wei"));
        assertEq(nft.text(sub, "description"), "grant round");
        assertEq(nft.text(sub, "target"), LibString.toHexStringChecksummed(target));
        assertEq(nft.text(sub, "value"), "1000000000000000000");
        assertEq(nft.resolve(sub), target); // <id>.dao.wei resolves to what it calls
    }

    /// @dev The four selectors the dapp's wallet bridge hardcodes must equal the real ABI selectors,
    ///      or every button would send a call to the wrong function.
    function testDappSelectorsMatchAbi() public view {
        string memory page = dao.html();
        assertTrue(LibString.contains(page, _sel(WeiDAO.propose.selector)));
        assertTrue(LibString.contains(page, _sel(WeiDAO.support.selector)));
        assertTrue(LibString.contains(page, _sel(WeiDAO.unsupport.selector)));
        assertTrue(LibString.contains(page, _sel(WeiDAO.execute.selector)));
    }

    /// @dev The dapp's hand-rolled `propose` calldata (selector + address + value + two dynamic
    ///      offsets + padded bytes/string) must be byte-identical to canonical ABI encoding. This
    ///      mirrors the exact JS formula in `_JS`; if it matches abi.encodeWithSelector, the bridge
    ///      produces a valid transaction on-chain.
    function testProposeCalldataMatchesAbi() public pure {
        _checkPropose(address(0xBEEF), 1.5 ether, hex"deadbeef", "hello world"); // non-aligned bytes
        _checkPropose(address(0xC0FFEE), 0, "", ""); // empty bytes + empty string
        _checkPropose(
            address(type(uint160).max), 42, hex"00112233445566778899aabbccddeeff", "aligned"
        );
    }

    function _checkPropose(address t, uint256 v, bytes memory d, string memory desc) internal pure {
        uint256 dp = ((d.length + 31) / 32) * 32; // padded byte length, as the JS computes
        bytes memory js = abi.encodePacked(
            WeiDAO.propose.selector,
            bytes32(uint256(uint160(t))),
            bytes32(v),
            bytes32(uint256(128)), // offset of bytes
            bytes32(uint256(160 + dp)), // offset of string
            bytes32(d.length),
            _pad32(d),
            bytes32(bytes(desc).length),
            _pad32(bytes(desc))
        );
        bytes memory abiEnc = abi.encodeWithSelector(WeiDAO.propose.selector, t, v, d, desc);
        assertEq(keccak256(js), keccak256(abiEnc));
    }

    /// @dev The three one-click actions build `selector + padded-uint args`. Prove each equals
    ///      canonical ABI encoding, so a click submits a call the contract decodes correctly.
    function testStaticCalldataMatchesAbi() public pure {
        assertEq(
            keccak256(abi.encodePacked(WeiDAO.execute.selector, bytes32(uint256(7)))),
            keccak256(abi.encodeWithSelector(WeiDAO.execute.selector, uint256(7)))
        );
        assertEq(
            keccak256(
                abi.encodePacked(
                    WeiDAO.support.selector, bytes32(uint256(3)), bytes32(uint256(999))
                )
            ),
            keccak256(abi.encodeWithSelector(WeiDAO.support.selector, uint256(3), uint256(999)))
        );
        assertEq(
            keccak256(
                abi.encodePacked(
                    WeiDAO.unsupport.selector, bytes32(uint256(3)), bytes32(uint256(999))
                )
            ),
            keccak256(abi.encodeWithSelector(WeiDAO.unsupport.selector, uint256(3), uint256(999)))
        );
    }

    function _pad32(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(((b.length + 31) / 32) * 32);
        for (uint256 i; i < b.length; ++i) {
            out[i] = b[i];
        }
    }

    function _sel(bytes4 s) internal pure returns (string memory) {
        return LibString.toHexString(uint256(uint32(s)), 4); // "0x" + 8 lowercase hex
    }

    /// @dev Multicall lets one wallet stack several of its names onto a proposal in a single tx;
    ///      `delegatecall` preserves msg.sender so each name's ownership check passes.
    function testMulticallBatchesSupport() public {
        uint256 tAlice2 = _register("cd", alice); // second len-2 name alice owns
        uint256 id = _proposeWithdraw();
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(WeiDAO.support, (id, tAlice));
        calls[1] = abi.encodeCall(WeiDAO.support, (id, tAlice2));
        vm.prank(alice);
        dao.multicall(calls);
        // Both names credited in the single tx (each captured at its live weight ~0.05 ETH).
        assertEq(dao.supportOf(id, tAlice), dao.weightOf(tAlice));
        assertEq(dao.supportOf(id, tAlice2), dao.weightOf(tAlice2));
        assertGt(dao.supportOf(id, tAlice), 0);
        assertGt(dao.supportOf(id, tAlice2), 0);
    }

    /// @dev The dapp hand-rolls `multicall(bytes[])` calldata in JS; prove that encoding is
    ///      byte-identical to canonical ABI, so a batched vote is a valid transaction on-chain.
    function testMulticallCalldataMatchesAbi() public pure {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(WeiDAO.support.selector, uint256(5), uint256(100));
        calls[1] = abi.encodeWithSelector(WeiDAO.support.selector, uint256(5), uint256(200));
        assertEq(
            keccak256(_jsMulticall(calls)),
            keccak256(abi.encodeWithSelector(bytes4(0xac9650d8), calls))
        );

        bytes[] memory one = new bytes[](1); // also cover unaligned element (odd byte length)
        one[0] = hex"deadbeef00112233445566";
        assertEq(
            keccak256(_jsMulticall(one)), keccak256(abi.encodeWithSelector(bytes4(0xac9650d8), one))
        );
    }

    /// @dev Mirrors the dapp's `mc()`: selector + offset(0x20) + n + per-element offsets + [len,paddedData].
    function _jsMulticall(bytes[] memory cds) internal pure returns (bytes memory js) {
        uint256 n = cds.length;
        bytes memory heads;
        bytes memory tails;
        uint256 off = n * 32;
        for (uint256 i; i < n; ++i) {
            heads = abi.encodePacked(heads, bytes32(off));
            bytes memory e = abi.encodePacked(bytes32(cds[i].length), _pad32(cds[i]));
            tails = abi.encodePacked(tails, e);
            off += e.length;
        }
        js = abi.encodePacked(bytes4(0xac9650d8), bytes32(uint256(32)), bytes32(n), heads, tails);
    }

    /// @dev The double-spend guard: multicall reverts on non-zero msg.value, so the payable
    ///      `propose` can't be batched to mint proposals for a single fee.
    function testMulticallRejectsValue() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(WeiDAO.execute, (1));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        dao.multicall{value: 1 ether}(calls);
    }

    /// @dev The readable params render alpha as its half-life; the on-chain binary search must
    ///      recover ~7d for the calibrated alpha.
    function testHtmlShowsHalfLife() public view {
        assertTrue(LibString.contains(dao.html(), "Half-life</span><span class=v>7d"));
    }

    /// @dev ERC-4804 resolve mode routes web3:// gateways to request().
    function testResolveModeIs5219() public view {
        assertEq(dao.resolveMode(), bytes32("5219"));
    }

    /// @dev ERC-5219 request() serves the same live page as html(), with an HTML content-type.
    function testRequestServesLiveHtml() public {
        vm.prank(alice);
        dao.propose(address(nft), 0, "", "hi");
        string[] memory res = new string[](0);
        WeiDAO.KeyValue[] memory params = new WeiDAO.KeyValue[](0);
        (uint16 code, string memory body, WeiDAO.KeyValue[] memory headers) =
            dao.request(res, params);
        assertEq(code, 200);
        assertTrue(LibString.eq(body, dao.html()));
        assertEq(headers.length, 2);
        assertTrue(LibString.eq(headers[0].key, "Content-Type"));
        assertTrue(LibString.eq(headers[0].value, "text/html; charset=utf-8"));
        assertTrue(LibString.eq(headers[1].key, "Cache-Control"));
    }

    /// @dev "Under governance" sums the DAO treasury and the WNS fees it can withdraw (the DAO owns
    ///      NameNFT here); the breakdown appears only when WNS holds a balance.
    function testHtmlSumsGovernedEth() public {
        vm.deal(address(dao), 3 ether);
        vm.deal(address(nft), 1 ether);
        string memory page = dao.html();
        assertTrue(
            LibString.contains(page, "Under governance</span><span class=v>4.0000 <small>ETH")
        );
        assertTrue(LibString.contains(page, "treasury 3.0000 + WNS fees 1.0000")); // breakdown tooltip
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _proposeWithdraw() internal returns (uint256 id) {
        vm.prank(alice);
        id = dao.propose(
            address(nft), 0, abi.encodeWithSelector(NameNFT.withdraw.selector), "withdraw"
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

    function _registerOn(NameNFT n, string memory label, address to) internal returns (uint256 id) {
        bytes32 secret = keccak256(bytes(label));
        vm.startPrank(to);
        n.commit(n.makeCommitment(label, to, secret));
        vm.warp(block.timestamp + 61);
        uint256 fee = n.getFee(bytes(label).length);
        vm.deal(to, fee);
        id = n.reveal{value: fee}(label, secret);
        vm.stopPrank();
    }
}
