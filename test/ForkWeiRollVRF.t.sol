// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

/// @dev The wrapper is itself a VRF consumer: the coordinator calls this, and the wrapper then
///      calls the consumer with exactly `callbackGasLimit` forwarded.
interface IVRFWrapper {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

interface ISteth {
    function sharesOf(address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function getPooledEthByShares(uint256) external view returns (uint256);
}

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function computeId(string calldata) external pure returns (uint256);
    function transferFrom(address, address, uint256) external;
    function approve(address, uint256) external;
    function reverseResolve(address) external view returns (string memory);
    function isAvailable(string calldata, uint256) external view returns (bool);
    function expiresAt(uint256) external view returns (uint256);
    function getFullName(uint256) external view returns (string memory);
    function resolve(uint256) external view returns (address);
    function text(uint256, string calldata) external view returns (string memory);
    function records(uint256) external view returns (string memory, uint256, uint64, uint64, uint64);
}

/// @notice Mainnet-fork check that {WeiRoll}'s hand-written VRF v2.5 interface really matches the
///         deployed Chainlink direct-funding wrapper — the reason the interface is inlined rather
///         than pulled in as a dependency. Runs a full round against the live NameNFT, WeiDAO and
///         wrapper: two real `.wei` holders enter, the round is drawn (a genuine paid
///         `requestRandomWordsInNative` against the real contract, which is where a wrong
///         `EXTRA_ARGS` encoding or selector would blow up), then the callback is delivered from
///         the wrapper's address to settle the winner.
///
///         Self-skips unless `RUN_FORK_VRF=true` so the normal suite never touches the network.
///         Run: `RUN_FORK_VRF=true forge test --match-contract ForkWeiRollVRF -vv`.
contract ForkWeiRollVRF is Test {
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    uint256 constant GAS_PRICE = 20 gwei;

    WeiRoll roll;
    uint256 preDust;
    uint256 idA;
    uint256 idB;
    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_VRF", false)) {
            skipped = true;
            return;
        }
        vm.createSelectFork(vm.rpcUrl("main3"));
        // The wrapper prices a request off `tx.gasprice` (it is pre-paying the callback), which
        // Foundry leaves at 0. Without this the quote is 0 and the test proves nothing about cost.
        vm.txGasPrice(GAS_PRICE);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        preDust = predicted.balance;
        roll = new WeiRoll(NFT, DAO, WRAPPER, STETH);
        vm.deal(address(this), 5 ether);
        (bool funded,) = address(roll).call{value: 5 ether}(""); // staked on arrival
        require(funded, "funding failed");

        // Two live top-level names. Owners are read from chain, so a transfer can't stale the test.
        idA = IWNS(NFT).computeId("ross.wei");
        idB = IWNS(NFT).computeId("dao.wei");
    }

    modifier onlyFork() {
        if (skipped) {
            vm.skip(true);
            return;
        }
        _;
    }

    function testLiveWrapperQuotesAPrice() public onlyFork {
        uint256 price = roll.wrapper().calculateRequestPriceNative(200_000, 1);
        assertGt(price, 0, "wrapper quoted nothing");
        assertLt(price, 1 ether, "quote implausible");
        emit log_named_decimal_uint("VRF request price (ETH)", price, 18);
    }

    function testFullRoundAgainstLiveContracts() public onlyFork {
        _enter(idA);
        _enter(idB);
        assertEq(roll.ticketCount(0), 2);
        assertGt(roll.totalWeight(0), 0, "live names weighed nothing");

        uint256 balBefore = address(roll).balance;
        vm.warp(roll.roundEnd());
        emit log_named_decimal_uint("VRF fee the caller fronts (ETH)", roll.drawPrice(), 18);

        // The real call. A wrong selector, a wrong ExtraArgsV1 tag, or a nativePayment mismatch
        // all revert here rather than silently costing a round.
        vm.deal(address(this), 1 ether);
        roll.draw{value: roll.drawPrice()}();

        uint256 requestId = roll.requestId();
        assertGt(requestId, 0, "wrapper returned no request id");
        assertEq(address(roll).balance, balBefore, "the fee must come from the caller, not the pot");
        emit log_named_uint("live VRF requestId", requestId);
        emit log_named_uint("live VRF requestId", requestId);
        emit log_named_decimal_uint(
            "fee actually paid (ETH)", balBefore - address(roll).balance, 18
        );

        // Deliver the callback the way it actually arrives: the coordinator fulfils the wrapper,
        // and the wrapper forwards to us with exactly CALLBACK_GAS. The wrapper swallows a failed
        // callback rather than reverting, so the winner assertion below is what proves our
        // settlement fits the gas limit on the real path.
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("wei roll"));
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(requestId, words);

        uint256 winner = roll.winnerOf(0);
        assertGt(winner, 0, "wrapper's gas-limited callback did not settle the round");
        address holder0 = IWNS(NFT).ownerOf(winner);
        assertTrue(winner == idA || winner == idB, "winner is not an entrant");
        emit log_named_decimal_uint("stray ETH found at the address and swept in", preDust, 18);
        assertApproxEqAbs(
            roll.prizeOf(0), 5 ether + preDust, 4, "the prize is the whole staked pot"
        );
        assertEq(roll.pot(), 0, "nothing left unreserved");
        assertEq(roll.round(), 1);

        // A winning name sold on carries its prize: the old holder can no longer claim, the new
        // one can. Checked here against the live registry, not a local mock.
        address buyer = makeAddr("buyer");
        vm.prank(holder0);
        IWNS(NFT).transferFrom(holder0, buyer, winner);
        assertFalse(roll.canClaim(0, holder0), "the seller must lose the claim");
        assertTrue(roll.canClaim(0, buyer), "the buyer must gain it");

        // Hand the live roll.wei over, exactly as it would be at launch, so the claim also badges.
        uint256 parent = roll.PARENT(); // hoisted: an inline call here would eat the prank
        address rollOwner = IWNS(NFT).ownerOf(parent);
        vm.prank(rollOwner);
        IWNS(NFT).transferFrom(rollOwner, address(roll), parent);

        uint256 prize = roll.prizeOf(0);
        address holder = IWNS(NFT).ownerOf(winner);
        assertEq(holder, buyer);
        uint256 before = ISteth(STETH).balanceOf(holder);
        vm.prank(holder);
        roll.claim(0);
        assertEq(ISteth(STETH).balanceOf(holder) - before, prize, "winner was not paid in stETH");
        assertEq(roll.reservedShares(), 0);
        assertEq(roll.pot(), 0, "the pot was paid out in full");

        // roll.wei -> 0.roll.wei -> <winning label>.0.roll.wei, against the real registry.
        uint256 roundName = roll.roundName(0);
        uint256 badge = roll.trophyOf(0);
        assertGt(badge, 0, "no badge minted");
        (string memory label,,,,) = IWNS(NFT).records(winner);

        assertEq(IWNS(NFT).getFullName(roundName), "0.roll.wei");
        assertEq(IWNS(NFT).ownerOf(roundName), address(roll));
        assertEq(IWNS(NFT).resolve(roundName), holder);
        assertEq(IWNS(NFT).text(roundName, "winner"), label);
        assertEq(IWNS(NFT).text(roundName, "prize"), vm.toString(prize));

        assertEq(IWNS(NFT).getFullName(badge), string.concat(label, ".0.roll.wei"));
        assertEq(IWNS(NFT).ownerOf(badge), holder, "badge not handed to the claimer");
        assertEq(IWNS(NFT).resolve(badge), holder);
        emit log_named_string("badge minted", IWNS(NFT).getFullName(badge));
    }

    /// @notice The invariant {WeiRoll.CLAIM_WINDOW} rests on, checked against the deployed
    ///         NameNFT rather than a local copy: a name that lapses cannot be re-registered by
    ///         anyone else before the claim window shuts, so a winner cannot be sniped mid-window.
    /// @notice Funding really does become stETH on the live Lido, and the winner is really paid in
    ///         it — `transferShares` and all — rather than in ETH.
    function testFundingIsStakedOnLiveLido() public onlyFork {
        WeiRoll fresh = new WeiRoll(NFT, DAO, WRAPPER, STETH);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(fresh).call{value: 0.5 ether}("");
        assertTrue(ok, "funding failed");

        assertEq(address(fresh).balance, 0, "no idle ETH left behind");
        assertGt(ISteth(STETH).sharesOf(address(fresh)), 0, "no shares minted");
        // Lido's share division credits a hair under 1:1 on the way in — measured at 2 wei.
        assertApproxEqAbs(fresh.pot(), 0.5 ether, 4, "pot should be what was staked");
        assertEq(fresh.roundEnd(), block.timestamp + fresh.ROUND_LENGTH(), "round opened");

        emit log_named_decimal_uint("pot after staking 0.5 ETH (stETH)", fresh.pot(), 18);
        emit log_named_uint("shares held", ISteth(STETH).sharesOf(address(fresh)));
    }

    function testLiveGracePeriodOutlastsTheClaimWindow() public onlyFork {
        uint256 id = IWNS(NFT).computeId("ross.wei");
        uint256 exp = IWNS(NFT).expiresAt(id);
        assertGt(exp, block.timestamp, "pick a name that has not already lapsed");

        vm.warp(exp + 1);
        assertFalse(IWNS(NFT).isAvailable("ross", 0), "should still be in grace");

        vm.warp(exp + roll.CLAIM_WINDOW());
        assertFalse(
            IWNS(NFT).isAvailable("ross", 0), "grace must outlast the claim window on live WNS"
        );
    }

    /// @notice The unhappy path end to end: nobody claims, the window shuts, the prize returns to
    ///         the pot and reopens the contract rather than being stranded.
    function testUnclaimedPrizeRollsOverAgainstLiveContracts() public onlyFork {
        _enter(idA);
        _enter(idB);
        vm.warp(roll.roundEnd());
        vm.deal(address(this), 1 ether);
        roll.draw{value: roll.drawPrice()}();

        uint256 requestId = roll.requestId(); // hoisted: an inline call would eat the prank
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("nobody claims"));
        vm.prank(COORDINATOR);
        IVRFWrapper(WRAPPER).rawFulfillRandomWords(requestId, words);

        uint256 prize = roll.prizeOf(0);
        assertGt(prize, 0);
        assertEq(roll.roundEnd(), 0, "settling leaves nothing to run on");

        vm.warp(roll.claimBy(0) + 1);
        assertFalse(roll.canClaim(0, IWNS(NFT).ownerOf(roll.winnerOf(0))));
        roll.rollOver(0);

        assertEq(roll.pot(), prize, "the prize came back");
        assertEq(roll.reservedShares(), 0);
        assertEq(roll.roundEnd(), block.timestamp + roll.ROUND_LENGTH(), "and it reopened");
        assertEq(roll.trophyOf(0), 0, "an unclaimed round is never named");
    }

    /// @notice Rehearses the launch transaction itself against the live registry: pre-approve the
    ///         address the deploy will land at, deploy with value, and assert the end state
    ///         ops/ROLL.md says to check. This is the one step that has to be got right in the
    ///         correct order — approve *before* the deploy, or the pull silently no-ops.
    function testDeployRehearsalPullsInRollWeiAndOpensTheFirstRound() public onlyFork {
        uint256 parent = roll.PARENT(); // hoisted: an inline call would eat the prank
        address holder = IWNS(NFT).ownerOf(parent);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.prank(holder);
        IWNS(NFT).approve(predicted, parent);

        // A deploy address can already hold ETH — this one holds a wei of mainnet dust — and it
        // counts toward the pot, which is right: it is unspoken-for money like any other.
        uint256 dust = predicted.balance;

        vm.deal(address(this), 1 ether);
        WeiRoll fresh = new WeiRoll{value: 0.25 ether}(NFT, DAO, WRAPPER, STETH);

        assertEq(address(fresh), predicted, "address prediction drifted");
        assertEq(IWNS(NFT).ownerOf(parent), address(fresh), "roll.wei was not pulled in");
        assertEq(IWNS(NFT).reverseResolve(address(fresh)), "roll.wei");
        assertEq(IWNS(NFT).resolve(parent), address(fresh), "roll.wei should resolve to it");
        assertApproxEqAbs(fresh.pot(), 0.25 ether + dust, 4, "staked, less Lido rounding");
        assertEq(fresh.roundEnd(), block.timestamp + fresh.ROUND_LENGTH());
        assertTrue(fresh.phase() == WeiRoll.Phase.Open, "first round should be open");
        assertTrue(fresh.state().naming, "namespace should be live from round zero");
    }

    /// @dev The boring path in ops/ROLL.md §5: no approval, deploy, then hand the name over. Costs
    ///      only the reverse record, and avoids pre-approving an address that has no code yet.
    function testDeployRehearsalWithoutPreApproval() public onlyFork {
        uint256 parent = roll.PARENT();
        address holder = IWNS(NFT).ownerOf(parent);

        vm.deal(address(this), 1 ether);
        WeiRoll fresh = new WeiRoll{value: 0.25 ether}(NFT, DAO, WRAPPER, STETH);
        assertApproxEqAbs(fresh.pot(), 0.25 ether, 4);
        assertEq(IWNS(NFT).ownerOf(parent), holder, "nothing should have been pulled");
        assertFalse(fresh.state().naming);

        vm.prank(holder);
        IWNS(NFT).transferFrom(holder, address(fresh), parent);

        assertTrue(fresh.state().naming, "naming live once the name arrives");
        assertEq(fresh.roundEnd(), block.timestamp + fresh.ROUND_LENGTH());
    }

    function _enter(uint256 tokenId) internal {
        address holder = IWNS(NFT).ownerOf(tokenId);
        assertGt(roll.weightOf(tokenId), 0, "name is not an active top-level name");
        vm.prank(holder);
        roll.enter(tokenId, 0);
    }
}
