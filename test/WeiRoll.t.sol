// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAO} from "../src/WeiDAO.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

/// @dev Stand-in for the Chainlink VRF v2.5 direct-funding wrapper. Records what the consumer
///      sent (so the tests can assert the exact request encoding) and lets a test drive the
///      callback with a chosen word. The real wrapper is exercised in {ForkWeiRollVRF}.
contract MockWrapper {
    uint256 public price = 0.0001 ether;
    uint256 public nextId = 1;

    uint32 public lastGas;
    uint16 public lastConfs;
    uint32 public lastWords;
    bytes public lastExtraArgs;
    uint256 public lastValue;

    function setPrice(uint256 p) external {
        price = p;
    }

    function calculateRequestPriceNative(uint32, uint32) external view returns (uint256) {
        return price;
    }

    function requestRandomWordsInNative(
        uint32 gas,
        uint16 confs,
        uint32 words,
        bytes calldata extraArgs
    ) external payable returns (uint256) {
        lastGas = gas;
        lastConfs = confs;
        lastWords = words;
        lastExtraArgs = extraArgs;
        lastValue = msg.value;
        return nextId++;
    }

    function fulfill(address consumer, uint256 id, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        WeiRoll(payable(consumer)).rawFulfillRandomWords(id, words);
    }
}

/// @dev Refuses ETH — used to prove {claim} cannot be bricked by a hostile winner contract.
contract RejectsETH {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    receive() external payable {
        revert("no");
    }
}

contract WeiRollTest is Test {
    NameNFT nft;
    WeiDAO dao;
    WeiRoll roll;
    MockWrapper wrapper;

    address alice = address(0xA11CE); // "ab"     len 2 -> 0.05 ether/yr
    address bob = address(0xB0B); //    "bobby"   len 5 -> 0.02 ether/yr
    address carol = address(0xCA201); // "carols" len 6 -> 0.001 ether/yr (default)
    address vetoAddr = address(0x5E70);
    address execAddr = address(0xE7EC);

    uint256 tAlice;
    uint256 tBob;
    uint256 tCarol;
    uint256 tDao;
    uint256 tRoll;

    uint256 constant ALPHA = 999_998_853_923_940_000; // 7-day half-life
    uint256 constant HALF_LIFE = 7 days;

    function setUp() public {
        nft = new NameNFT();
        // threshold = convictionMax(alice's weight)/2, so one supported name passes in a half-life
        dao = new WeiDAO(
            address(nft), ALPHA, 0.05 ether * 1e18 / (1e18 - ALPHA) / 2, 0, 0, address(0)
        );
        wrapper = new MockWrapper();
        roll = new WeiRoll(address(nft), address(dao), address(wrapper));

        uint256[] memory lens = new uint256[](2);
        uint256[] memory fees = new uint256[](2);
        lens[0] = 2;
        fees[0] = 0.05 ether;
        lens[1] = 5;
        fees[1] = 0.02 ether;
        vm.prank(nft.owner());
        nft.setLengthFees(lens, fees);

        tAlice = _register("ab", alice);
        tBob = _register("bobby", bob);
        tCarol = _register("carols", carol);

        // dao.wei + roles, so the DAO is functional for the boost tests.
        address z = makeAddr("z0r0z");
        tDao = _register("dao", z);
        vm.startPrank(z);
        nft.registerSubdomainFor("veto", tDao, vetoAddr);
        nft.registerSubdomainFor("exec", tDao, execAddr);
        nft.transferFrom(z, address(dao), tDao);
        vm.stopPrank();

        // roll.wei: the trophy parent. Namehash is deployment-independent, so a fresh NameNFT
        // yields exactly the constant the contract hardcodes.
        tRoll = _register("roll", z);
        assertEq(tRoll, roll.PARENT(), "roll.wei namehash mismatch");
        vm.prank(z);
        nft.transferFrom(z, address(roll), tRoll);

        _fund(10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                              ELIGIBILITY
    //////////////////////////////////////////////////////////////*/

    function testWeightMatchesDAO() public view {
        assertEq(roll.weightOf(tAlice), dao.weightOf(tAlice));
        assertEq(roll.weightOf(tBob), dao.weightOf(tBob));
        assertGt(roll.weightOf(tAlice), roll.weightOf(tBob)); // shorter name = pricier = better odds
    }

    function testOnlyOwnerCanEnterTheirName() public {
        vm.prank(bob);
        vm.expectRevert(WeiRoll.NotOwner.selector);
        roll.enter(tAlice, 0);
    }

    function testSubdomainsCannotEnter() public {
        vm.prank(alice);
        uint256 sub = nft.registerSubdomain("free", tAlice);
        assertEq(roll.weightOf(sub), 0);
        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotLive.selector);
        roll.enter(sub, 0);
    }

    function testExpiredNameCannotEnter() public {
        _rollRoundsUntil(nft.expiresAt(tAlice) + 1);
        assertEq(roll.weightOf(tAlice), 0);
        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotLive.selector);
        roll.enter(tAlice, 0);
    }

    /// @dev Cumulative weight is stored as a uint128. Governance sets the fee schedule, so a fee
    ///      absurd enough to overflow it is refused rather than silently truncating the odds.
    function testAbsurdFeeScheduleIsRefusedNotTruncated() public {
        uint256[] memory lens = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        lens[0] = 7;
        fees[0] = uint256(type(uint128).max) + 1e18;
        vm.prank(nft.owner());
        nft.setLengthFees(lens, fees);

        uint256 big = _register("bigname", carol);
        assertGt(roll.weightOf(big), type(uint128).max);
        vm.prank(carol);
        vm.expectRevert(WeiRoll.WeightTooLarge.selector);
        roll.enter(big, 0);
    }

    function testOneTicketPerNamePerRound() public {
        vm.startPrank(alice);
        roll.enter(tAlice, 0);
        vm.expectRevert(WeiRoll.AlreadyEntered.selector);
        roll.enter(tAlice, 0);
        vm.stopPrank();
    }

    /// @dev {WeiRoll.enter} carries no in-flight guard of its own: entries close at `roundEnd` and
    ///      {WeiRoll.draw} cannot run before it, so the ticket set is always frozen before a seed is
    ///      requested. This test is what holds that invariant — nobody may add a ticket once
    ///      randomness is in flight.
    function testEntriesCloseBeforeAnyDrawCanStart() public {
        vm.prank(alice);
        roll.enter(tAlice, 0);
        vm.prank(bob);
        roll.enter(tBob, 0);
        vm.warp(roll.roundEnd());

        vm.prank(carol);
        vm.expectRevert(WeiRoll.TooSoon.selector);
        roll.enter(tCarol, 0); // closed at roundEnd, before draw() is even callable

        roll.draw();
        vm.prank(carol);
        vm.expectRevert(WeiRoll.TooSoon.selector);
        roll.enter(tCarol, 0); // and still closed with the request in flight
    }

    /*//////////////////////////////////////////////////////////////
                            WEIGHTED SELECTION
    //////////////////////////////////////////////////////////////*/

    function testCumulativeWeightsAreRunningTotals() public {
        _enterAll();
        uint256 wA = roll.weightOf(tAlice);
        assertEq(roll.ticketAt(0, 0).cum, wA);
        assertEq(roll.ticketAt(0, 1).cum, wA + roll.weightOf(tBob));
        assertEq(roll.totalWeight(0), roll.ticketAt(0, 2).cum);
    }

    /// @dev The whole selection rule: sweep every seed in the weight range and assert each ticket
    ///      wins exactly on its own half-open slice `(cum[i-1], cum[i]]`.
    function testSelectionCoversEveryTicketExactlyOnce() public {
        _enterAll();
        uint256 total = roll.totalWeight(0);
        uint256[3] memory ids = [tAlice, tBob, tCarol];

        for (uint256 i; i < 3; ++i) {
            uint256 lo = i == 0 ? 0 : roll.ticketAt(0, i - 1).cum;
            uint256 hi = roll.ticketAt(0, i).cum;
            // boundaries plus the interior midpoint
            uint256[3] memory probes = [lo, hi - 1, (lo + hi) / 2];
            for (uint256 p; p < 3; ++p) {
                assertEq(_winnerForSeed(probes[p], total), ids[i], "wrong slice owner");
            }
        }
    }

    function testOddsAreProportionalToWeight() public {
        _enterAll();
        uint256 total = roll.totalWeight(0);
        uint256 aliceWins;
        uint256 N = 3000;
        for (uint256 i; i < N; ++i) {
            if (_winnerForSeed(uint256(keccak256(abi.encode(i))) % total, total) == tAlice) {
                aliceWins++;
            }
        }
        uint256 expected = N * roll.weightOf(tAlice) / total;
        assertApproxEqRel(aliceWins, expected, 0.08e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 DRAW
    //////////////////////////////////////////////////////////////*/

    function testDrawSendsExactlyTheQuotedPriceInNative() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        assertEq(wrapper.lastValue(), wrapper.price());
        assertEq(wrapper.lastWords(), 1);
        assertEq(wrapper.lastConfs(), 64, "should wait for finality, not the 3-block floor");
        // nativePayment: true, ExtraArgsV1 tag
        assertEq(
            wrapper.lastExtraArgs(),
            hex"92fd13380000000000000000000000000000000000000000000000000000000000000001"
        );
    }

    function testDrawBeforeRoundEndReverts() public {
        _enterAll();
        vm.expectRevert(WeiRoll.TooSoon.selector);
        roll.draw();
    }

    function testThinRoundRollsForwardInsteadOfBricking() public {
        vm.prank(alice);
        roll.enter(tAlice, 0);
        uint256 end = roll.roundEnd();
        vm.warp(end);
        vm.expectEmit(true, false, false, true, address(roll));
        emit WeiRoll.RoundOpened(0, end + roll.ROUND_LENGTH());
        roll.draw(); // only one ticket: no VRF request, entries reopen
        assertEq(roll.requestId(), 0);
        assertEq(roll.round(), 0);
        assertEq(roll.roundEnd(), end + roll.ROUND_LENGTH());
        vm.prank(bob);
        roll.enter(tBob, 0); // still open
    }

    /// @dev The wrapper prices a request off a LINK/ETH feed behind a staleness guard. If it ever
    ///      declines to quote, draw must reopen the round, not revert — entries are already shut by
    ///      then and there is no owner to unstick an ownerless contract.
    function testAWrapperThatWillNotQuoteReopensRatherThanBricking() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        vm.mockCallRevert(
            address(wrapper),
            abi.encodeWithSignature("calculateRequestPriceNative(uint32,uint32)", 200_000, 1),
            ""
        );

        assertEq(roll.drawPrice(), 0, "an unavailable quote reads as 0");
        assertFalse(roll.drawSettles());
        assertFalse(roll.state().drawSettles, "state must not revert either");

        roll.draw();
        assertEq(roll.requestId(), 0, "must not have requested a seed");
        assertGt(roll.roundEnd(), block.timestamp, "entries reopened");

        // and it picks straight back up once the wrapper answers again
        vm.clearMockedCalls();
        vm.warp(roll.roundEnd());
        roll.draw();
        assertGt(roll.requestId(), 0);
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.winnerOf(0), tAlice);
    }

    function testCannotDrawTwiceWithARequestInFlight() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        vm.expectRevert(WeiRoll.DrawPending.selector);
        roll.draw();
    }

    function testResetWithNothingInFlightReverts() public {
        vm.expectRevert(WeiRoll.NoRequest.selector);
        roll.resetRequest();
    }

    /// @dev Reverting here would wedge the contract: entries are already shut at `roundEnd`, so
    ///      nobody could enter and nobody could draw until someone funded it.
    function testAPotTooThinForTheFeeReopensInsteadOfWedging() public {
        _enterAll();
        vm.deal(address(roll), 0);
        wrapper.setPrice(1 ether);
        vm.warp(roll.roundEnd());

        roll.draw();
        assertEq(roll.requestId(), 0, "should not have requested a seed");
        assertEq(roll.round(), 0);
        assertGt(roll.roundEnd(), block.timestamp, "entries should be open again");

        // tickets ride through the reopen rather than being discarded
        assertEq(roll.ticketCount(0), 3, "entries should survive a reopen");

        // funding it makes the same round drawable
        wrapper.setPrice(0.0001 ether);
        _fund(1 ether);
        vm.warp(roll.roundEnd());
        roll.draw();
        assertGt(roll.requestId(), 0);
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.winnerOf(0), tAlice, "the carried tickets are the ones drawn");
    }

    function testOnlyWrapperCanFulfill() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        uint256[] memory words = new uint256[](1);
        words[0] = 1;
        vm.expectRevert(WeiRoll.Unauthorized.selector);
        roll.rawFulfillRandomWords(1, words);
    }

    function testStaleFulfillmentIsRejectedAfterReset() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        uint256 stale = roll.requestId();

        vm.warp(block.timestamp + roll.REQUEST_TIMEOUT());
        roll.resetRequest();
        roll.draw(); // fresh request, new id

        vm.expectRevert(WeiRoll.NoRequest.selector);
        wrapper.fulfill(address(roll), stale, 12345);
    }

    function testResetBeforeTimeoutReverts() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        vm.expectRevert(WeiRoll.TooSoon.selector);
        roll.resetRequest();
    }

    function testFulfillGasFitsCallbackLimit() public {
        // 64 tickets -> 6 binary-search steps, the deepest realistic case for cold SLOADs.
        for (uint256 i; i < 64; ++i) {
            address who = address(uint160(0x1000 + i));
            uint256 id = _register(string(abi.encodePacked("n", vm.toString(i), "xx")), who);
            vm.prank(who);
            roll.enter(id, 0);
        }
        vm.warp(roll.roundEnd());
        roll.draw();
        uint256 id_ = roll.requestId();
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("seed"));
        uint256 before = gasleft();
        vm.prank(address(wrapper));
        roll.rawFulfillRandomWords(id_, words);
        uint256 used = before - gasleft();
        emit log_named_uint("fulfill gas, 64 tickets", used);
        // Each doubling of the field adds one cold SLOAD (~2100) to the search, so the headroom
        // here covers field sizes far beyond any plausible round.
        assertLt(used, 200_000, "callback exceeds CALLBACK_GAS");
    }

    /*//////////////////////////////////////////////////////////////
                                 PRIZE
    //////////////////////////////////////////////////////////////*/

    function testSettlingPaysTheWholePotAndStopsUntilRefunded() public {
        _enterAll();
        vm.warp(roll.roundEnd());
        uint256 potBefore = roll.pot();
        roll.draw();
        uint256 fee = wrapper.price();
        wrapper.fulfill(address(roll), roll.requestId(), 0);

        assertEq(roll.prizeOf(0), potBefore - fee);
        assertEq(roll.reserved(), potBefore - fee);
        assertEq(roll.pot(), 0);
        assertEq(roll.round(), 1);
        assertEq(roll.requestId(), 0);
        assertEq(roll.roundEnd(), 0, "nothing left to run on");
    }

    function testWinnerClaims() public {
        uint256 prize = _drawWith(0); // seed 0 -> first ticket -> alice
        assertEq(roll.winnerOf(0), tAlice);
        uint256 before = alice.balance;
        vm.prank(alice);
        roll.claim(0);
        assertEq(alice.balance - before, prize);
        assertEq(roll.reserved(), 0);
    }

    function testNonWinnerCannotClaim() public {
        _drawWith(0);
        vm.prank(bob);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        roll.claim(0);
    }

    function testCannotClaimTwice() public {
        _drawWith(0);
        vm.startPrank(alice);
        roll.claim(0);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        roll.claim(0);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        YOU MUST STILL HOLD THE NAME
    //////////////////////////////////////////////////////////////*/

    function testSellingTheNameHandsThePrizeToTheBuyer() public {
        uint256 prize = _drawWith(0);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tAlice);

        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotWinner.selector);
        roll.claim(0);

        uint256 before = bob.balance;
        vm.prank(bob);
        roll.claim(0);
        assertEq(bob.balance - before, prize);
    }

    function testLettingTheNameLapseForfeitsThePrize() public {
        // Advance whole rounds until the next one is the last that ends before alice's name
        // expires, so the expiry falls strictly inside that round's claim window.
        uint256 exp = nft.expiresAt(tAlice);
        while (roll.roundEnd() + roll.ROUND_LENGTH() < exp) {
            vm.warp(roll.roundEnd());
            roll.draw();
        }
        uint256 r = roll.round();
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.winnerOf(r), tAlice);
        assertLt(exp, roll.claimBy(r));

        vm.warp(exp + 1);
        assertFalse(roll.canClaim(r, alice), "a lapsed winner cannot claim");
        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotLive.selector);
        roll.claim(r);

        // Load-bearing: NameNFT's 90-day grace exceeds CLAIM_WINDOW, so nobody can re-register the
        // lapsed name inside the window and claim the prize out from under the previous holder.
        vm.warp(roll.claimBy(r));
        assertFalse(nft.isAvailable("ab", 0), "lapsed winner could be sniped inside the window");

        // and the forfeited prize goes back to the pot for everyone else
        vm.warp(roll.claimBy(r) + 1);
        roll.rollOver(r);
        assertGt(roll.pot(), 0);
    }

    function testUnclaimedPrizeRollsIntoTheNextPot() public {
        uint256 prize = _drawWith(0);
        vm.warp(roll.claimBy(0) + 1);

        vm.prank(alice);
        vm.expectRevert(WeiRoll.ClaimWindowOver.selector);
        roll.claim(0);

        assertEq(roll.pot(), 0);
        roll.rollOver(0);
        assertEq(roll.pot(), prize);
        assertEq(roll.reserved(), 0);
    }

    function testCannotRollOverAnUnsettledRound() public {
        vm.expectRevert(WeiRoll.NotWinner.selector);
        roll.rollOver(0);
    }

    function testCannotRollOverWhileWindowOpen() public {
        _drawWith(0);
        vm.expectRevert(WeiRoll.ClaimWindowOpen.selector);
        roll.rollOver(0);
    }

    function testHostileWinnerCannotBrickTheContract() public {
        RejectsETH hostile = new RejectsETH();
        uint256 tHostile = _register("hostile", address(hostile));
        vm.prank(address(hostile));
        roll.enter(tHostile, 0);
        _enterAll();

        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0); // seed 0 -> hostile, ticket 0
        assertEq(roll.winnerOf(0), tHostile);

        vm.prank(address(hostile));
        vm.expectRevert(); // the push fails, but only for them
        roll.claim(0);

        // everyone else's next round is unaffected once it rolls over
        vm.warp(roll.claimBy(0) + 1);
        roll.rollOver(0);
        assertGt(roll.pot(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                              THE DAO BOOST
    //////////////////////////////////////////////////////////////*/

    function testBoostDoublesWeight() public {
        uint256 pid = _proposal();
        vm.startPrank(alice);
        dao.support(pid, tAlice);
        roll.enter(tAlice, pid);
        vm.stopPrank();

        assertEq(roll.ticketAt(0, 0).cum, roll.weightOf(tAlice) * 2);
        assertEq(roll.ticketAt(0, 0).boostPid, pid);
    }

    function testCannotClaimBoostWithoutBacking() public {
        uint256 pid = _proposal();
        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotBacking.selector);
        roll.enter(tAlice, pid);
    }

    /// @dev The bond. Boosted odds, support dropped before claiming -> prize is unclaimable.
    function testDroppingSupportForfeitsTheBoostedPrize() public {
        uint256 pid = _proposal();
        vm.startPrank(alice);
        dao.support(pid, tAlice);
        roll.enter(tAlice, pid);
        vm.stopPrank();
        vm.prank(bob);
        roll.enter(tBob, 0);

        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.winnerOf(0), tAlice);

        vm.prank(alice);
        dao.unsupport(pid, tAlice);

        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotBacking.selector);
        roll.claim(0);

        // re-backing restores the claim
        vm.startPrank(alice);
        dao.support(pid, tAlice);
        roll.claim(0);
        vm.stopPrank();
    }

    function testBoostRejectsAVetoedProposal() public {
        uint256 pid = _proposal();
        vm.prank(alice);
        dao.support(pid, tAlice);
        vm.prank(vetoAddr);
        dao.veto(pid);

        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotLive.selector);
        roll.enter(tAlice, pid);
    }

    /// @dev Support is not cleared when a proposal settles, so without this check a single ancient
    ///      `support` would buy doubled odds forever.
    function testBoostRejectsAnExecutedProposal() public {
        uint256 pid = _proposal();
        vm.prank(alice);
        dao.support(pid, tAlice);
        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        dao.execute(pid);

        assertGt(dao.supportOf(pid, tAlice), 0, "support survived execution, as expected");
        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotLive.selector);
        roll.enter(tAlice, pid);
    }

    /// @dev The bond re-checks backing only, never the proposal's state, so a boosted entrant is
    ///      not punished for the thing they backed succeeding.
    function testBoostSurvivesTheProposalPassing() public {
        uint256 pid = _proposal();
        vm.startPrank(alice);
        dao.support(pid, tAlice);
        roll.enter(tAlice, pid);
        vm.stopPrank();
        vm.prank(bob);
        roll.enter(tBob, 0);

        vm.warp(block.timestamp + HALF_LIFE + 1 hours);
        dao.execute(pid);

        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.winnerOf(0), tAlice);

        uint256 prize = roll.prizeOf(0);
        uint256 before = alice.balance;
        vm.prank(alice);
        roll.claim(0);
        assertEq(alice.balance - before, prize, "winner punished for their proposal passing");
    }

    function testUnboostedWinnerNeedsNoDAOPosition() public {
        _drawWith(0);
        assertEq(roll.winnerBoostOf(0), 0);
        vm.prank(alice);
        roll.claim(0); // no DAO interaction required
    }

    /*//////////////////////////////////////////////////////////////
                                 TROPHY
    //////////////////////////////////////////////////////////////*/

    function testAClaimWritesTheRoundIntoTheNamespace() public {
        uint256 prize = _drawWith(0); // alice ("ab") wins
        vm.prank(alice);
        roll.claim(0);

        // roll.wei -> 0.roll.wei -> ab.0.roll.wei
        uint256 roundName = nft.computeId("0.roll.wei");
        uint256 badge = nft.computeId("ab.0.roll.wei");
        assertEq(roll.roundName(0), roundName, "roundName must match the minted name");
        assertEq(roll.trophyOf(0), badge);

        assertEq(
            nft.ownerOf(roundName), address(roll), "round record should stay with the contract"
        );
        assertEq(nft.resolve(roundName), alice, "round should resolve to its winner");
        assertEq(nft.text(roundName, "winner"), "ab");
        assertEq(nft.text(roundName, "prize"), vm.toString(prize));

        assertEq(nft.ownerOf(badge), alice, "badge not handed to the winner");
        assertEq(nft.resolve(badge), alice);
        assertEq(nft.getFullName(badge), "ab.0.roll.wei");
    }

    function testBadgeFollowsTheClaimerNotTheOriginalHolder() public {
        _drawWith(0);
        vm.prank(alice);
        nft.transferFrom(alice, bob, tAlice); // bob buys the winning name and claims
        vm.prank(bob);
        roll.claim(0);
        assertEq(nft.ownerOf(nft.computeId("ab.0.roll.wei")), bob);
        assertEq(nft.resolve(nft.computeId("0.roll.wei")), bob);
    }

    function testPrizePaysEvenWithoutRollWei() public {
        // hand roll.wei away: naming is impossible, the lottery is unaffected
        vm.prank(address(roll));
        nft.transferFrom(address(roll), bob, tRoll);

        uint256 prize = _drawWith(0);
        uint256 before = alice.balance;
        vm.prank(alice);
        roll.claim(0);
        assertEq(alice.balance - before, prize, "naming failure blocked the prize");
        assertEq(roll.trophyOf(0), 0);
    }

    /// @dev The point of giving each round its own parent: the lottery recurs forever, so a repeat
    ///      winner collects a distinct badge per round instead of colliding on one label.
    function testRepeatWinnerIsBadgedOncePerRound() public {
        _drawWith(0);
        vm.prank(alice);
        roll.claim(0);
        uint256 first = roll.trophyOf(0);
        assertEq(nft.getFullName(first), "ab.0.roll.wei");

        vm.prank(alice);
        nft.setText(first, "note", "mine"); // anything she writes must survive the next win

        _fund(5 ether); // refill: round 0 paid the whole pot out
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.winnerOf(1), tAlice);

        uint256 prize1 = roll.prizeOf(1);
        uint256 before = alice.balance;
        vm.prank(alice);
        roll.claim(1);

        assertEq(alice.balance - before, prize1, "repeat winner was not paid");
        uint256 second = roll.trophyOf(1);
        assertEq(nft.getFullName(second), "ab.1.roll.wei", "second badge missing");
        assertTrue(first != second);
        assertEq(nft.ownerOf(first), alice, "first badge was burned");
        assertEq(nft.text(first, "note"), "mine", "first badge was wiped");
    }

    /// @dev Distinct from {testPrizePaysEvenWithoutRollWei}: here the contract still *holds*
    ///      roll.wei, so the ownership guard passes and it is `registerSubdomain` itself that
    ///      reverts on the expired parent — the swallowed-self-call path.
    function testExpiredRollWeiJustStopsBadging() public {
        // Keep the players alive past roll.wei by renewing them a year further out.
        _renew(tAlice);
        _renew(tBob);
        _rollRoundsUntil(nft.expiresAt(tRoll) + 1);

        assertEq(nft.ownerOf(tRoll), address(roll), "parent should still be held");
        assertGt(roll.weightOf(tAlice), 0, "players should still be active");
        _fund(10 ether);

        vm.prank(alice);
        roll.enter(tAlice, 0);
        vm.prank(bob);
        roll.enter(tBob, 0);
        uint256 r = roll.round();
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);

        uint256 prize = roll.prizeOf(r);
        uint256 before = alice.balance;
        vm.prank(alice);
        roll.claim(r);
        assertEq(alice.balance - before, prize);
        assertEq(roll.trophyOf(r), 0);
    }

    /// @dev A badge sold on must never be reachable by a later win. Each round parents its own
    ///      badge, so there is no label for a later round to collide with.
    function testABadgeSoldOnIsUntouchedByALaterWin() public {
        _drawWith(0);
        vm.prank(alice);
        roll.claim(0);
        uint256 badge = roll.trophyOf(0);

        address collector = makeAddr("collector");
        vm.prank(alice);
        nft.transferFrom(alice, collector, badge);

        _fund(5 ether);
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        vm.prank(alice);
        roll.claim(1);

        assertEq(nft.ownerOf(badge), collector, "collector's badge was taken");
        assertEq(nft.getFullName(badge), "ab.0.roll.wei");
    }

    /// @dev A lapsed and re-registered `roll.wei` orphans the old round names. Rounds keep counting
    ///      up regardless, so naming simply resumes under the new parent.
    function testNamingResumesUnderAFreshRollWei() public {
        _renew(tAlice);
        _renew(tBob);
        _renew(tCarol);
        // past grace *and* the 21-day premium decay, so re-registration is at the plain fee
        _rollRoundsUntil(nft.expiresAt(tRoll) + 90 days + 21 days + 1);
        assertEq(nft.getPremium(roll.PARENT()), 0);

        address z2 = makeAddr("z2");
        uint256 tRoll2 = _register("roll", z2);
        assertEq(tRoll2, roll.PARENT());
        vm.prank(z2);
        nft.transferFrom(z2, address(roll), tRoll2);

        _fund(5 ether);
        uint256 r = roll.round();
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        vm.prank(alice);
        roll.claim(r);

        assertGt(roll.trophyOf(r), 0, "naming should resume");
        assertEq(
            nft.getFullName(roll.trophyOf(r)), string.concat("ab.", vm.toString(r), ".roll.wei")
        );
    }

    /// @dev `ownerOf` reverts on a name that was never registered, so a bare check here would make
    ///      every claim revert on a chain without `roll.wei` — prizes stranded, no owner to rescue.
    function testClaimSurvivesRollWeiNotExistingAtAll() public {
        uint256 prize = _drawWith(0);
        vm.mockCallRevert(
            address(nft), abi.encodeWithSignature("ownerOf(uint256)", roll.PARENT()), ""
        );

        assertFalse(roll.state().naming, "naming should report unavailable");
        uint256 before = alice.balance;
        vm.prank(alice);
        roll.claim(0);
        assertEq(alice.balance - before, prize, "an absent parent must not block the prize");
        assertEq(roll.trophyOf(0), 0);
    }

    function testNameWinnerIsSelfCallOnly() public {
        _drawWith(0);
        vm.prank(alice);
        vm.expectRevert(WeiRoll.Unauthorized.selector);
        roll.nameWinner(0, tAlice, alice, 1 ether);
    }

    /// @dev `NameNFT.renew` takes no ownership check, so keeping `roll.wei` alive needs no code
    ///      here: anyone can pay its fee, and badge holders have reason to.
    function testAnyoneCanRenewRollWeiDirectly() public {
        uint256 exp = nft.expiresAt(tRoll);
        uint256 fee = nft.getFee(4); // "roll"
        address stranger = makeAddr("stranger");
        vm.deal(stranger, fee);

        vm.prank(stranger);
        nft.renew{value: fee}(tRoll);

        assertEq(nft.expiresAt(tRoll), exp + 365 days);
        assertEq(nft.ownerOf(tRoll), address(roll), "renewing must not move the name");
        assertEq(roll.pot(), 10 ether, "the pot should not have paid for it");
    }

    /*//////////////////////////////////////////////////////////////
                            FUNDING RUNS IT
    //////////////////////////////////////////////////////////////*/

    /// @dev The WeiDAO handover trick: pre-approve the address the deploy will land at, and the
    ///      constructor pulls `roll.wei` in itself, so deploy and namespace handover are one
    ///      transaction. Funding it in the same breath opens the first round on the spot.
    function testConstructorPullsInRollWeiWhenPreApproved() public {
        address z3 = makeAddr("z3");
        vm.prank(address(roll));
        nft.transferFrom(address(roll), z3, tRoll); // park it on an EOA to hand over

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(z3);
        nft.approve(predicted, tRoll);

        vm.deal(address(this), 1 ether);
        WeiRoll fresh = new WeiRoll{value: 1 ether}(address(nft), address(dao), address(wrapper));

        assertEq(address(fresh), predicted, "address prediction drifted");
        assertEq(nft.ownerOf(tRoll), address(fresh), "roll.wei was not pulled in");
        assertEq(
            nft.reverseResolve(address(fresh)), "roll.wei", "should reverse-resolve to roll.wei"
        );
        assertEq(nft.resolve(tRoll), address(fresh), "roll.wei should resolve to the contract");
        assertEq(
            fresh.roundEnd(), block.timestamp + fresh.ROUND_LENGTH(), "first round should be open"
        );
        assertEq(fresh.pot(), 1 ether);
    }

    /// @dev No approval is not a failure: the deploy still works and the name arrives later.
    function testDeployWithoutTheNameStillWorks() public {
        vm.prank(address(roll));
        nft.transferFrom(address(roll), bob, tRoll);

        WeiRoll fresh = new WeiRoll(address(nft), address(dao), address(wrapper));
        assertEq(nft.ownerOf(tRoll), bob, "nothing should have been pulled");

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(fresh).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(alice);
        fresh.enter(tAlice, 0); // runs fine, it just cannot name anything yet
        assertEq(fresh.ticketCount(0), 1);
    }

    function testNothingRunsUntilItIsFunded() public {
        WeiRoll fresh = new WeiRoll(address(nft), address(dao), address(wrapper));
        assertEq(fresh.roundEnd(), 0);
        assertEq(fresh.pot(), 0);

        vm.prank(alice);
        vm.expectRevert(WeiRoll.NotRunning.selector);
        fresh.enter(tAlice, 0);

        vm.expectRevert(WeiRoll.NotRunning.selector);
        fresh.draw();
    }

    function testFundingOpensARound() public {
        WeiRoll fresh = new WeiRoll(address(nft), address(dao), address(wrapper));
        vm.deal(address(this), 1 ether);

        vm.expectEmit(true, false, false, true, address(fresh));
        emit WeiRoll.RoundOpened(0, block.timestamp + fresh.ROUND_LENGTH());
        (bool ok,) = address(fresh).call{value: 1 ether}("");
        assertTrue(ok);

        assertEq(fresh.roundEnd(), block.timestamp + fresh.ROUND_LENGTH());
        vm.prank(alice);
        fresh.enter(tAlice, 0); // open for business, no admin touched it
    }

    /// @dev Deploying with value is funding too.
    function testDeployingWithValueOpensTheFirstRound() public {
        vm.deal(address(this), 1 ether);
        WeiRoll fresh = new WeiRoll{value: 1 ether}(address(nft), address(dao), address(wrapper));
        assertEq(fresh.roundEnd(), block.timestamp + fresh.ROUND_LENGTH());
        assertEq(fresh.pot(), 1 ether);
    }

    function testTopUpsDoNotRestartTheWindow() public {
        uint256 end = roll.roundEnd();
        vm.warp(block.timestamp + 5 days);
        _fund(1 ether);
        assertEq(roll.roundEnd(), end, "a top-up must not extend the round");
        assertEq(roll.pot(), 11 ether);
    }

    /// @dev The whole cycle with no keeper and no schedule: fund, run, pay out, stop, fund again.
    function testItStopsWhenDrainedAndRestartsWhenRefunded() public {
        _drawWith(0);
        vm.prank(alice);
        roll.claim(0);

        assertEq(roll.pot(), 0);
        assertEq(roll.roundEnd(), 0, "should be idle with an empty pot");
        vm.prank(bob);
        vm.expectRevert(WeiRoll.NotRunning.selector);
        roll.enter(tBob, 0);

        _fund(2 ether);
        assertEq(roll.roundEnd(), block.timestamp + roll.ROUND_LENGTH());
        assertEq(roll.round(), 1, "should pick up where it left off");
        vm.prank(bob);
        roll.enter(tBob, 0);
    }

    /// @dev A forfeited prize is funding like any other: it restarts an idle contract and becomes
    ///      the next round's prize rather than being stranded.
    function testAForfeitedPrizeRestartsItAndBecomesTheNextPot() public {
        uint256 prize0 = _drawWith(0);
        assertEq(roll.roundEnd(), 0);

        vm.warp(roll.claimBy(0) + 1);
        roll.rollOver(0);
        assertEq(roll.pot(), prize0);
        assertEq(
            roll.roundEnd(), block.timestamp + roll.ROUND_LENGTH(), "forfeit should restart it"
        );

        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        uint256 fee = wrapper.price();
        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertEq(roll.prizeOf(1), prize0 - fee, "forfeited pot did not carry forward");
    }

    /*//////////////////////////////////////////////////////////////
                               RECURRENCE
    //////////////////////////////////////////////////////////////*/

    /// @dev Nothing about a round is one-shot: the counter, the ticket set, the entry flags, the
    ///      window and the namespace all advance, and it keeps drawing as long as it is funded.
    ///      Three rounds back to back, each with a different winner.
    function testItKeepsRollingRoundAfterRound() public {
        uint256[3] memory expected = [tAlice, tBob, tCarol];
        address[3] memory holders = [alice, bob, carol];
        string[3] memory labels = ["ab", "bobby", "carols"];

        for (uint256 r; r < 3; ++r) {
            if (r != 0) _fund(3 ether); // each settle empties the pot
            assertEq(roll.round(), r, "round counter did not advance");
            _enterAll(); // the same three names re-enter every round
            assertEq(roll.ticketCount(r), 3);

            uint256 seed = _seedFor(expected[r]);
            vm.warp(roll.roundEnd());
            roll.draw();
            wrapper.fulfill(address(roll), roll.requestId(), seed);
            assertEq(roll.winnerOf(r), expected[r]);

            uint256 prize = roll.prizeOf(r);
            uint256 before = holders[r].balance;
            vm.prank(holders[r]);
            roll.claim(r);
            assertEq(holders[r].balance - before, prize);

            assertEq(nft.getFullName(roll.roundName(r)), string.concat(vm.toString(r), ".roll.wei"));
            assertEq(
                nft.getFullName(roll.trophyOf(r)),
                string.concat(labels[r], ".", vm.toString(r), ".roll.wei")
            );
            assertEq(nft.ownerOf(roll.trophyOf(r)), holders[r]);
        }

        assertEq(roll.round(), 3);
        assertEq(roll.reserved(), 0, "nothing should be left owed");
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function testPhaseTracksTheLifecycle() public {
        WeiRoll fresh = new WeiRoll(address(nft), address(dao), address(wrapper));
        assertTrue(fresh.phase() == WeiRoll.Phase.Idle);

        assertTrue(roll.phase() == WeiRoll.Phase.Open);
        _enterAll();
        vm.warp(roll.roundEnd());
        assertTrue(roll.phase() == WeiRoll.Phase.Ready);

        roll.draw();
        assertTrue(roll.phase() == WeiRoll.Phase.Drawing);

        wrapper.fulfill(address(roll), roll.requestId(), 0);
        assertTrue(roll.phase() == WeiRoll.Phase.Idle, "pot paid out, back to idle");
    }

    function testStateIsEnoughToDriveAFrontend() public {
        _enterAll();
        WeiRoll.State memory st = roll.state();

        assertTrue(st.phase == WeiRoll.Phase.Open);
        assertEq(st.round, 0);
        assertEq(st.roundEnd, roll.roundEnd());
        assertEq(st.pot, 10 ether);
        assertEq(st.reserved, 0);
        assertEq(st.tickets, 3);
        assertEq(st.totalWeight, roll.totalWeight(0));
        assertEq(st.requestId, 0);
        assertEq(st.resetAt, 0);
        assertEq(st.drawPrice, wrapper.price());
        assertFalse(st.drawSettles, "not drawable until the window closes");
        assertTrue(st.naming);

        vm.warp(roll.roundEnd());
        assertTrue(roll.state().drawSettles);

        roll.draw();
        st = roll.state();
        assertTrue(st.phase == WeiRoll.Phase.Drawing);
        assertEq(st.resetAt, block.timestamp + roll.REQUEST_TIMEOUT());
        assertFalse(st.drawSettles);
    }

    function testDrawSettlesIsFalseWhenTheRoundCannotSettle() public {
        vm.prank(alice);
        roll.enter(tAlice, 0); // one ticket
        vm.warp(roll.roundEnd());
        assertFalse(roll.drawSettles(), "one ticket cannot settle");

        vm.prank(bob);
        vm.expectRevert(WeiRoll.TooSoon.selector);
        roll.enter(tBob, 0);

        roll.draw(); // reopens
        vm.prank(bob);
        roll.enter(tBob, 0);
        vm.warp(roll.roundEnd());
        assertTrue(roll.drawSettles());

        vm.deal(address(roll), 0);
        assertFalse(roll.drawSettles(), "an empty pot cannot settle");
    }

    function testRoundInfoCoversTheWholeLifecycle() public {
        WeiRoll.Round memory info = roll.roundInfo(0);
        assertFalse(info.settled);
        assertEq(info.roundName, nft.computeId("0.roll.wei"), "name is known before it is minted");

        uint256 prize = _drawWith(0);
        info = roll.roundInfo(0);
        assertTrue(info.settled);
        assertFalse(info.resolved);
        assertEq(info.tickets, 3);
        assertEq(info.winner, tAlice);
        assertEq(info.prize, prize);
        assertEq(info.claimBy, roll.claimBy(0));
        assertEq(info.trophy, 0, "not named until claimed");

        vm.prank(alice);
        roll.claim(0);
        info = roll.roundInfo(0);
        assertTrue(info.resolved);
        assertEq(info.prize, 0);
        assertEq(info.trophy, nft.computeId("ab.0.roll.wei"));
    }

    function testWeightInGivesAHoldersOdds() public {
        _enterAll();
        assertEq(roll.weightIn(0, tAlice), roll.weightOf(tAlice));
        assertEq(roll.weightIn(0, tBob), roll.weightOf(tBob));
        assertEq(roll.weightIn(0, tCarol), roll.weightOf(tCarol));
        assertEq(roll.weightIn(0, tRoll), 0, "not entered");

        assertEq(
            roll.weightIn(0, tAlice) + roll.weightIn(0, tBob) + roll.weightIn(0, tCarol),
            roll.totalWeight(0),
            "the parts must sum to the whole"
        );
    }

    function testWeightInReflectsTheBoost() public {
        uint256 pid = _proposal();
        vm.startPrank(alice);
        dao.support(pid, tAlice);
        roll.enter(tAlice, pid);
        vm.stopPrank();
        assertEq(roll.weightIn(0, tAlice), roll.weightOf(tAlice) * 2);
    }

    function testCanClaimMirrorsClaim() public {
        _drawWith(0);
        assertTrue(roll.canClaim(0, alice));
        assertFalse(roll.canClaim(0, bob), "not the holder");
        assertFalse(roll.canClaim(1, alice), "unsettled round");

        vm.prank(alice);
        roll.claim(0);
        assertFalse(roll.canClaim(0, alice), "already claimed");
    }

    /// @dev `ownerOf` reverts on a name that no longer exists; a view that reverts breaks the
    ///      frontend that calls it, so this one answers false instead.
    function testCanClaimIsFalseNotRevertingWhenTheNameIsGone() public {
        _drawWith(0);
        assertTrue(roll.canClaim(0, alice));
        vm.mockCallRevert(address(nft), abi.encodeWithSignature("ownerOf(uint256)", tAlice), "");
        assertFalse(roll.canClaim(0, alice));
    }

    function testCanClaimGoesFalseWhenTheWindowShuts() public {
        _drawWith(0);
        vm.warp(roll.claimBy(0) + 1);
        assertFalse(roll.canClaim(0, alice));
    }

    function testCanClaimTracksTheBoostBond() public {
        uint256 pid = _proposal();
        vm.startPrank(alice);
        dao.support(pid, tAlice);
        roll.enter(tAlice, pid);
        vm.stopPrank();
        vm.prank(bob);
        roll.enter(tBob, 0);
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), 0);

        assertTrue(roll.canClaim(0, alice));
        vm.prank(alice);
        dao.unsupport(pid, tAlice);
        assertFalse(roll.canClaim(0, alice), "bond dropped");
    }

    function testTicketsInPages() public {
        _enterAll();
        WeiRoll.Ticket[] memory page = roll.ticketsIn(0, 0, 2);
        assertEq(page.length, 2);
        assertEq(page[0].tokenId, tAlice);
        assertEq(page[1].tokenId, tBob);

        page = roll.ticketsIn(0, 2, 10); // clamps to what is left
        assertEq(page.length, 1);
        assertEq(page[0].tokenId, tCarol);

        page = roll.ticketsIn(0, 1, type(uint256).max); // "give me the rest" must not overflow
        assertEq(page.length, 2);
        assertEq(page[0].tokenId, tBob);

        assertEq(roll.ticketsIn(0, 3, 10).length, 0, "past the end is empty, not a revert");
        assertEq(roll.ticketsIn(99, 0, 10).length, 0, "an unused round is empty");
    }

    function testTicketOfIndexesEntries() public {
        assertEq(roll.ticketOf(0, tAlice), 0);
        _enterAll();
        assertEq(roll.ticketOf(0, tAlice), 1);
        assertEq(roll.ticketOf(0, tCarol), 3);
        assertEq(roll.ticketAt(0, roll.ticketOf(0, tCarol) - 1).tokenId, tCarol);
    }

    /*//////////////////////////////////////////////////////////////
                              OWNERLESSNESS
    //////////////////////////////////////////////////////////////*/

    function testNoOneCanWithdraw() public view {
        // The only value-moving paths are claim/rollOver/draw. No owner, no setter, no sweep.
        assertEq(_selectorCount("owner()"), 0);
        assertEq(_selectorCount("withdraw()"), 0);
    }

    function testAnyoneCanFund() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(roll).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(roll.pot(), 11 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _selectorCount(string memory sig) internal view returns (uint256 n) {
        bytes4 sel = bytes4(keccak256(bytes(sig)));
        (bool ok,) = address(roll).staticcall(abi.encodeWithSelector(sel));
        if (ok) n = 1;
    }

    /// @dev A seed that lands inside `tokenId`'s slice of the current round's weight range.
    function _seedFor(uint256 tokenId) internal view returns (uint256) {
        uint256 r = roll.round();
        uint256 n = roll.ticketCount(r);
        for (uint256 i; i < n; ++i) {
            if (roll.ticketAt(r, i).tokenId == tokenId) {
                uint256 lo = i == 0 ? 0 : roll.ticketAt(r, i - 1).cum;
                return lo;
            }
        }
        revert("not entered");
    }

    function _renew(uint256 tokenId) internal {
        (string memory label,,,,) = nft.records(tokenId);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.deal(address(this), fee);
        nft.renew{value: fee}(tokenId);
    }

    /// @dev Walk the clock forward a whole round at a time. Empty rounds roll themselves forward,
    ///      which is exactly how an unused lottery behaves on-chain.
    function _rollRoundsUntil(uint256 ts) internal {
        while (roll.roundEnd() < ts) {
            vm.warp(roll.roundEnd());
            roll.draw();
        }
        vm.warp(ts);
    }

    /// @dev Real transfer, not `vm.deal`: funding is what opens a round.
    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(roll).call{value: amount}("");
        assertTrue(ok, "funding failed");
    }

    function _enterAll() internal {
        vm.prank(alice);
        roll.enter(tAlice, 0);
        vm.prank(bob);
        roll.enter(tBob, 0);
        vm.prank(carol);
        roll.enter(tCarol, 0);
    }

    function _drawWith(uint256 seed) internal returns (uint256 prize) {
        _enterAll();
        vm.warp(roll.roundEnd());
        roll.draw();
        wrapper.fulfill(address(roll), roll.requestId(), seed);
        prize = roll.prizeOf(0);
    }

    /// @dev Re-runs the contract's selection rule off-chain for a given seed by replaying it
    ///      through a fresh request. Cheaper: read the cum array and binary-search here.
    function _winnerForSeed(uint256 target, uint256 total) internal view returns (uint256) {
        require(target < total);
        uint256 n = roll.ticketCount(0);
        for (uint256 i; i < n; ++i) {
            if (uint256(roll.ticketAt(0, i).cum) > target) return roll.ticketAt(0, i).tokenId;
        }
        revert("no winner");
    }

    /// @dev Targets a codeless address with empty calldata so {WeiDAO.execute} actually succeeds.
    function _proposal() internal returns (uint256 id) {
        vm.prank(alice);
        nft.setPrimaryName(tAlice);
        vm.prank(alice);
        id = dao.propose(address(0xdead), 0, "", "fund the roll");
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
