// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "@forge/Test.sol";
import {WeiTerms} from "../src/WeiTerms.sol";

interface INameNFT {
    function commit(bytes32 commitment) external;
    function reveal(string calldata label, bytes32 secret) external payable returns (uint256);
    function renew(uint256 tokenId) external payable;
    function getFee(uint256 length) external view returns (uint256);
    function getPremium(uint256 tokenId) external view returns (uint256);
    function expiresAt(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function isAvailable(string calldata label, uint256 parentId) external view returns (bool);
    function records(uint256 tokenId)
        external
        view
        returns (string memory label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch);
}

interface IZRouter {
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
    function revealName(string calldata label, bytes32 innerSecret, address to)
        external
        payable
        returns (uint256);
    function sweep(address token, uint256 id, uint256 amount, address to) external payable;
    function execute(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory);
    function trust(address target, bool ok) external payable;
}

/// @notice Mainnet-fork exploration of multi-year .wei registration and renewal.
///
///         The deployed NameNFT sells exactly one 365-day term per call: `reveal()` mints one
///         year, `renew()` adds one year to the CURRENT expiry. Both are non-upgradeable, so
///         "5 years" can only ever mean five calls. The open questions are who may make them,
///         whether they compound, what they cost, and which batching venue can carry them
///         without ever leaving user funds or a user's name sitting in a contract.
///
///         `WeiTerms` (unit-tested against a local registry in WeiTerms.t.sol) is exercised here
///         against the live one, so its assumptions about the deployed fee schedule, the grace
///         window and the premium are checked rather than mirrored.
///
///         Self-skips unless `RUN_FORK_TERMS=true`.
///         Run: `RUN_FORK_TERMS=true forge test --match-contract ForkMultiYear -vv`
contract ForkMultiYear is Test {
    address constant NFT_ADDR = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant ZROUTER_OWNER = 0x5E58BA0e06ED0F5558f83bE732a4b899a674053E;

    uint256 constant TERM = 365 days;
    uint256 constant MIN_COMMIT_AGE = 60;

    INameNFT nft = INameNFT(NFT_ADDR);
    IZRouter router = IZRouter(ZROUTER);
    WeiTerms terms;

    address alice = address(0xA11CE);
    address stranger = address(0xB0B);

    bool skipped;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TERMS", false)) {
            skipped = true;
            return;
        }
        vm.createSelectFork(vm.rpcUrl("main3"));
        terms = new WeiTerms();
        // The CREATE address can collide with a funded mainnet account. WeiTerms hands any stray
        // balance to its next caller by design, which would show up here as unexplained change —
        // zero it so these assertions are about the helper, not about who lives at that address.
        vm.deal(address(terms), 0);
        vm.deal(alice, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Registers `label` to `alice` by the plain (non-router) path: one 365-day term.
    function _registerDirect(string memory label) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encodePacked("secret", label));
        vm.startPrank(alice);
        nft.commit(keccak256(abi.encode(bytes(label), alice, secret)));
        vm.warp(_now() + MIN_COMMIT_AGE + 1);
        uint256 fee = nft.getFee(bytes(label).length);
        tokenId = nft.reveal{value: fee}(label, secret);
        vm.stopPrank();
    }

    function _fresh(string memory stem) internal view returns (string memory) {
        return string.concat(stem, vm.toString(vm.getBlockTimestamp()));
    }

    /// @dev `block.timestamp` is constant within a real transaction, so the optimizer may cache
    ///      it across calls; after a `vm.warp` that cached value is stale. Read it back through
    ///      the cheatcode, which cannot be folded away.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /*//////////////////////////////////////////////////////////////
                             WHAT A TERM COSTS
    //////////////////////////////////////////////////////////////*/

    /// The dapp has to price "N years" before the user signs, so pin the live schedule that
    /// price comes from. A flat schedule means N years is exactly N x the 1-year price.
    function test_liveFeeSchedule() public view {
        if (skipped) return;
        console2.log("--- live getFee(length) ---");
        for (uint256 len = 1; len <= 12; ++len) {
            console2.log(len, nft.getFee(len));
        }
    }

    /*//////////////////////////////////////////////////////////////
                          RENEWAL IS PERMISSIONLESS
    //////////////////////////////////////////////////////////////*/

    /// `renew()` checks only that the record exists, is top-level, and is not past grace — it
    /// never looks at `msg.sender`. That is what makes a helper contract safe here: it can
    /// extend a name it does not own and can never take one. It also means a batch does not
    /// have to be signed by the holder, so a helper needs no approval and no custody.
    function test_renewIsPermissionlessAndCompounds() public {
        if (skipped) return;
        string memory label = _fresh("wnsterms");
        uint256 tokenId = _registerDirect(label);

        uint256 start = nft.expiresAt(tokenId);
        assertEq(nft.ownerOf(tokenId), alice, "alice holds the name");

        uint256 fee = nft.getFee(bytes(label).length);
        vm.startPrank(stranger);
        for (uint256 i; i != 3; ++i) {
            nft.renew{value: fee}(tokenId);
        }
        vm.stopPrank();

        assertEq(nft.expiresAt(tokenId), start + 3 * TERM, "three terms compound onto expiry");
        assertEq(nft.ownerOf(tokenId), alice, "a stranger's renewal cannot move the name");
    }

    /// The premium and the renewal window never overlap. `getPremium` stays 0 for the whole
    /// grace period and only starts decaying once grace ends — by which point `renew()` itself
    /// reverts. So a renewal is always fee-only, and "expired" is never a renewal the UI can
    /// offer at a premium: past grace it is a fresh commit/reveal, and the name is open to all.
    function test_premiumAndRenewalWindowsDoNotOverlap() public {
        if (skipped) return;
        string memory label = _fresh("wnsgrace");
        uint256 tokenId = _registerDirect(label);
        uint256 expiry = nft.expiresAt(tokenId);
        uint256 fee = nft.getFee(bytes(label).length);

        // Deep in grace: renewable, and still no premium.
        vm.warp(expiry + 89 days);
        assertEq(nft.getPremium(tokenId), 0, "no premium anywhere inside grace");
        vm.prank(stranger);
        nft.renew{value: fee}(tokenId);
        assertEq(nft.expiresAt(tokenId), expiry + TERM, "grace renewal extends from expiry, fee-only");

        // One second past grace: the premium appears and renewal is gone.
        vm.warp(nft.expiresAt(tokenId) + 90 days + 1);
        assertGt(nft.getPremium(tokenId), 0, "premium only exists past grace");
        vm.prank(stranger);
        vm.expectRevert(bytes4(keccak256("Expired()")));
        nft.renew{value: fee}(tokenId);
    }

    /// Overpayment is refunded to `msg.sender`, not to the holder. That is the whole reason a
    /// contract in the middle of a batch has to hand the remainder back explicitly: left
    /// alone, the change from a user's renewal settles in the batching contract.
    function test_overpaymentRefundsToTheCallerNotTheHolder() public {
        if (skipped) return;
        string memory label = _fresh("wnsrefund");
        uint256 tokenId = _registerDirect(label);

        uint256 fee = nft.getFee(bytes(label).length);
        uint256 aliceBefore = alice.balance;
        uint256 strangerBefore = stranger.balance;

        vm.prank(stranger);
        nft.renew{value: fee + 1 ether}(tokenId);

        assertEq(alice.balance, aliceBefore, "the holder is not the refund address");
        assertEq(stranger.balance, strangerBefore - fee, "the caller gets the change back");
    }

    /*//////////////////////////////////////////////////////////////
                       THE HELPER: N TERMS, ONE SIGNATURE
    //////////////////////////////////////////////////////////////*/

    function test_helperBuysNTermsAndKeepsNothing() public {
        if (skipped) return;
        string memory label = _fresh("wnshelper");
        uint256 tokenId = _registerDirect(label);

        uint256 start = nft.expiresAt(tokenId);
        uint256 fee = nft.getFee(bytes(label).length);
        uint256 before = alice.balance;

        // Overpay deliberately: the dapp's quote can be stale by a block.
        vm.prank(alice);
        terms.renew{value: fee * 5 + 0.5 ether}(tokenId, 5);

        assertEq(nft.expiresAt(tokenId), start + 5 * TERM, "five terms in one call");
        assertEq(nft.ownerOf(tokenId), alice, "name never leaves the holder");
        assertEq(alice.balance, before - fee * 5, "change comes back to the payer");
        assertEq(address(terms).balance, 0, "helper is left holding nothing");
    }

    /// A helper that trusted a caller-supplied price could be made to overspend the ETH sent
    /// with it. This one reads `getFee` on-chain, so a fee raised between the dapp's quote and
    /// the transaction landing reverts the batch instead of quietly spending more.
    function test_helperRevertsWhenFeeRisesUnderIt() public {
        if (skipped) return;
        string memory label = _fresh("wnsfeerise");
        uint256 tokenId = _registerDirect(label);
        uint256 fee = nft.getFee(bytes(label).length);

        address nftOwner = _nameNftOwner(); // hoisted: an inline call would eat the prank
        vm.prank(nftOwner);
        (bool ok,) = NFT_ADDR.call(abi.encodeWithSignature("setDefaultFee(uint256)", fee * 2));
        assertTrue(ok, "live owner raises the fee under the pending batch");

        vm.prank(alice);
        vm.expectRevert(WeiTerms.InsufficientFee.selector);
        terms.renew{value: fee * 5}(tokenId, 5);
    }

    function _nameNftOwner() internal view returns (address o) {
        (bool ok, bytes memory ret) = NFT_ADDR.staticcall(abi.encodeWithSignature("owner()"));
        require(ok, "owner()");
        o = abi.decode(ret, (address));
    }

    function test_helperGasPerTerm() public {
        if (skipped) return;
        string memory label = _fresh("wnsgas");
        uint256 tokenId = _registerDirect(label);
        uint256 fee = nft.getFee(bytes(label).length);

        uint256[4] memory counts = [uint256(1), 2, 5, 10];
        console2.log("--- helper gas by term count ---");
        for (uint256 i; i != counts.length; ++i) {
            uint256 g = gasleft();
            vm.prank(alice);
            terms.renew{value: fee * counts[i]}(tokenId, counts[i]);
            console2.log(counts[i], g - gasleft());
        }
    }

    /*//////////////////////////////////////////////////////////////
                      BATCHING VENUE: THE LIVE zROUTER
    //////////////////////////////////////////////////////////////*/

    /// zRouter is already the registration path (`revealName` + `sweep`), so it is the obvious
    /// place to bolt renewals onto. Its generic `execute` is gated on an owner-curated
    /// allowlist, and NameNFT is NOT on it today — so the router cannot be made to call
    /// `renew` at all. Batching through zRouter is blocked on its owner, not on us.
    function test_zRouterCannotCallRenewToday() public {
        if (skipped) return;
        string memory label = _fresh("wnsrouter");
        uint256 tokenId = _registerDirect(label);
        uint256 fee = nft.getFee(bytes(label).length);

        vm.deal(ZROUTER, 1 ether);
        vm.prank(alice);
        vm.expectRevert(bytes4(0x82b42900)); // Unauthorized()
        router.execute(NFT_ADDR, fee, abi.encodeWithSignature("renew(uint256)", tokenId));
    }

    /// What it would look like if zRouter's owner trusted NameNFT: register and pay for the
    /// remaining terms in ONE router multicall, change swept back to the user. This is the
    /// shape the USDC/DAI paths would inherit for free — priced in the same swap.
    function test_zRouterAtomicMultiYearIfNameNftWereTrusted() public {
        if (skipped) return;
        string memory label = _fresh("wnsatomic");
        bytes32 inner = keccak256("inner");
        bytes32 secret = keccak256(abi.encode(inner, alice));
        uint256 nTerms = 5;

        vm.prank(ZROUTER_OWNER);
        router.trust(NFT_ADDR, true);

        vm.prank(alice);
        nft.commit(keccak256(abi.encode(bytes(label), ZROUTER, secret)));
        vm.warp(_now() + MIN_COMMIT_AGE + 1);

        uint256 fee = nft.getFee(bytes(label).length);
        uint256 tokenId = uint256(keccak256(abi.encodePacked(
            bytes32(0xa82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f),
            keccak256(bytes(label))
        )));

        bytes[] memory calls = new bytes[](nTerms + 1);
        calls[0] = abi.encodeCall(IZRouter.revealName, (label, inner, alice));
        for (uint256 i = 1; i != nTerms; ++i) {
            calls[i] = abi.encodeCall(
                IZRouter.execute,
                (NFT_ADDR, fee, abi.encodeWithSignature("renew(uint256)", tokenId))
            );
        }
        calls[nTerms] = abi.encodeCall(IZRouter.sweep, (address(0), 0, 0, alice));

        uint256 before = alice.balance;
        uint256 startTime = _now();
        vm.prank(alice);
        router.multicall{value: fee * nTerms + 0.3 ether}(calls);

        assertEq(nft.ownerOf(tokenId), alice, "name lands with the user, not the router");
        assertEq(nft.expiresAt(tokenId), startTime + nTerms * TERM, "five terms from one signature");
        assertEq(alice.balance, before - fee * nTerms, "overpayment swept back");
        assertEq(ZROUTER.balance, 0, "no user funds stranded in the shared router");
    }

    /*//////////////////////////////////////////////////////////////
                REGISTRATION: N YEARS AGAINST THE LIVE REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// The unit tests price `register` against a locally deployed registry with constructor
    /// defaults. This is the same path against the live fee schedule and the live premium
    /// settings, which is what the dapp will actually be quoting.
    function test_registerMultiYearThroughTheHelper() public {
        if (skipped) return;
        string memory label = _fresh("wnshelperreg");
        bytes32 inner = keccak256("helperinner");
        uint256 nTerms = 5;
        bytes32 secret = keccak256(abi.encode(inner, alice, nTerms));

        vm.prank(alice);
        nft.commit(keccak256(abi.encode(bytes(label), address(terms), secret)));
        vm.warp(_now() + MIN_COMMIT_AGE + 1);

        uint256 fee = nft.getFee(bytes(label).length);
        uint256 startTime = _now();
        uint256 before = alice.balance;

        vm.prank(alice);
        uint256 tokenId = terms.register{value: fee * nTerms}(label, inner, alice, nTerms);

        assertEq(nft.ownerOf(tokenId), alice, "the name is delivered, not held");
        assertEq(nft.expiresAt(tokenId), startTime + nTerms * TERM, "five years, one signature");
        assertEq(alice.balance, before - fee * nTerms, "charged exactly five live fees");
        assertEq(address(terms).balance, 0, "helper holds nothing afterwards");
    }

    /// Two transactions for any term count — the commit, then the reveal that buys every year.
    /// That is the floor: `MIN_COMMITMENT_AGE` puts the two in different blocks by construction.
    function test_registerCostsTwoTransactionsAtAnyTermCount() public {
        if (skipped) return;
        console2.log("--- helper register gas by term count ---");
        uint256[3] memory counts = [uint256(1), 5, 10];
        for (uint256 i; i != counts.length; ++i) {
            string memory label = string.concat(_fresh("wnsreggas"), vm.toString(i));
            bytes32 inner = keccak256(abi.encode("gas", i));
            bytes32 secret = keccak256(abi.encode(inner, alice, counts[i]));

            vm.prank(alice);
            nft.commit(keccak256(abi.encode(bytes(label), address(terms), secret)));
            vm.warp(_now() + MIN_COMMIT_AGE + 1);

            uint256 fee = nft.getFee(bytes(label).length);
            uint256 startTime = _now();
            uint256 g = gasleft();
            vm.prank(alice);
            uint256 tokenId = terms.register{value: fee * counts[i]}(label, inner, alice, counts[i]);
            console2.log(counts[i], g - gasleft());

            assertEq(nft.ownerOf(tokenId), alice);
            assertEq(nft.expiresAt(tokenId), startTime + counts[i] * TERM);
        }
    }

    /*//////////////////////////////////////////////////////////////
                  WHAT THE DAPP CAN SHIP WITHOUT ANY GRANT
    //////////////////////////////////////////////////////////////*/

    /// Registration today: commit bound to zRouter, reveal through it, name delivered to the
    /// user. The extra terms can ride behind it in the SAME transaction only if the wallet
    /// batches (ERC-5792) — otherwise it is a second signature against the helper. This
    /// rehearses the two-call sequence and checks nothing is stranded in between.
    function test_registerThenTopUpTerms() public {
        if (skipped) return;
        string memory label = _fresh("wnsregthen");
        bytes32 inner = keccak256("inner2");
        bytes32 secret = keccak256(abi.encode(inner, alice));
        uint256 nTerms = 4;

        vm.prank(alice);
        nft.commit(keccak256(abi.encode(bytes(label), ZROUTER, secret)));
        vm.warp(_now() + MIN_COMMIT_AGE + 1);

        uint256 fee = nft.getFee(bytes(label).length);
        uint256 startTime = _now();

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IZRouter.revealName, (label, inner, alice));
        calls[1] = abi.encodeCall(IZRouter.sweep, (address(0), 0, 0, alice));

        vm.prank(alice);
        router.multicall{value: fee}(calls);

        uint256 tokenId = uint256(keccak256(abi.encodePacked(
            bytes32(0xa82820059d5df798546bcc2985157a77c3eef25eba9ba01899927333efacbd6f),
            keccak256(bytes(label))
        )));
        assertEq(nft.ownerOf(tokenId), alice, "registered for one term");
        assertEq(nft.expiresAt(tokenId), startTime + TERM, "one term so far");

        vm.prank(alice);
        terms.renew{value: fee * (nTerms - 1)}(tokenId, nTerms - 1);

        assertEq(nft.expiresAt(tokenId), startTime + nTerms * TERM, "topped up to four terms");
        assertEq(ZROUTER.balance, 0, "router holds nothing after the reveal");
        assertEq(address(terms).balance, 0, "helper holds nothing after the top-up");
    }
}
