// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

/// @dev The wrapper is itself a VRF consumer: the coordinator calls this, and the wrapper then
///      calls the consumer with exactly `callbackGasLimit` forwarded.
interface IVRFWrapper {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function computeId(string calldata) external pure returns (uint256);
    function transferFrom(address, address, uint256) external;
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

    uint256 constant GAS_PRICE = 20 gwei;

    WeiRoll roll;
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
        roll = new WeiRoll(NFT, DAO, WRAPPER);
        vm.deal(address(roll), 5 ether);

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

        // The real call. A wrong selector, a wrong ExtraArgsV1 tag, or a nativePayment mismatch
        // all revert here rather than silently costing a round.
        roll.draw();

        uint256 requestId = roll.requestId();
        assertGt(requestId, 0, "wrapper returned no request id");
        assertLt(address(roll).balance, balBefore, "wrapper was not paid");
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
        assertTrue(winner == idA || winner == idB, "winner is not an entrant");
        assertEq(roll.prizeOf(0), address(roll).balance, "prize is not the whole pot");
        assertEq(roll.round(), 1);

        // Hand the live roll.wei over, exactly as it would be at launch, so the claim also badges.
        uint256 parent = roll.PARENT(); // hoisted: an inline call here would eat the prank
        address rollOwner = IWNS(NFT).ownerOf(parent);
        vm.prank(rollOwner);
        IWNS(NFT).transferFrom(rollOwner, address(roll), parent);

        uint256 prize = roll.prizeOf(0);
        address holder = IWNS(NFT).ownerOf(winner);
        uint256 before = holder.balance;
        vm.prank(holder);
        roll.claim(0);
        assertEq(holder.balance - before, prize, "winner was not paid the pot");
        assertEq(roll.reserved(), 0);
        assertEq(address(roll).balance, 0);

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

    function _enter(uint256 tokenId) internal {
        address holder = IWNS(NFT).ownerOf(tokenId);
        assertGt(roll.weightOf(tokenId), 0, "name is not an active top-level name");
        vm.prank(holder);
        roll.enter(tokenId, 0);
    }
}
