// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiDAO} from "../src/WeiDAO.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
}

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function approve(address, uint256) external;
    function reverseResolve(address) external view returns (string memory);
    function getFullName(uint256) external view returns (string memory);
    function records(uint256) external view returns (string memory, uint256, uint64, uint64, uint64);
}

/// @notice Mainnet-fork rehearsal of the exact deploy the wallet will sign: mint roles -> approve
///         the predicted CREATE3 address for dao.wei -> `CreateX.deployCreate3(salt, initCode)` as the
///         real deployer EOA, then assert the whole DEPLOY.md §4 end state. Self-skips unless
///         `RUN_FORK_SIM=true` so it never touches the network in the normal suite.
///         Run: `RUN_FORK_SIM=true forge test --match-contract ForkDeploySim -vv`.
contract ForkDeploySim is Test {
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    address constant DEPLOYER = 0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20; // owns dao.wei, signs both
    address constant MULTISIG = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2; // exec + veto holder
    uint256 constant DAO_WEI = 0x2a39629d0ee4dc68cfd48b5eefdd0362b034be5a595fec5dc802144293a8287c;
    uint256 constant VETO_ROLE = 0xa3cbec6f0a52ab020919800d82007684e63632feadb0f555ac3cf796ec121dc1;
    uint256 constant EXEC_ROLE = 0x990f75bf23721b810a24035c3d53688b7d5078ff2aa31c18219ee65ab75e5144;

    // Pilot params (must match ops/DEPLOY.md and ops/deploy_initcode.hex).
    uint256 constant ALPHA = 999998853923940000;
    uint256 constant THRESHOLD = 159446457364257519435776;
    uint256 constant FEE = 2000000000000000;
    uint256 constant DELAY = 259200;

    // Sender-bound VANITY salt for DEPLOYER + its predicted CREATE3 address (ops/mine_best.py).
    bytes32 constant SALT = 0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a2000ea5544edcbf32ad6e8bb88;
    address constant PREDICTED = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;

    function testForkDeploy() public {
        if (!vm.envOr("RUN_FORK_SIM", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("https://ethereum-rpc.publicnode.com");

        // The exact bytes the wallet submits as initCode; assert they equal the saved deploy artifact.
        bytes memory initCode = abi.encodePacked(
            type(WeiDAO).creationCode, abi.encode(NFT, ALPHA, THRESHOLD, FEE, DELAY, MULTISIG)
        );
        assertEq(
            keccak256(initCode),
            0xa2046eeec52c09112e6f2be86c0102df4d984833fd435bae5da8e1521574d70b,
            "initCode != ops/deploy_initcode.hex"
        );
        assertEq(IWNS(NFT).ownerOf(DAO_WEI), DEPLOYER, "you must own dao.wei");

        // Just two wallet txs: approve, then deploy. The constructor pulls dao.wei and mints the
        // veto/exec roles to MULTISIG itself — no separate role-mint txs.
        vm.startPrank(DEPLOYER);
        IWNS(NFT).approve(PREDICTED, DAO_WEI);
        address dao = ICreateX(CREATEX).deployCreate3(SALT, initCode);
        vm.stopPrank();

        // ── DEPLOY.md §4 end state ────────────────────────────────────────────────
        assertEq(dao, PREDICTED, "deployed address != predicted");
        assertEq(IWNS(NFT).ownerOf(DAO_WEI), dao, "constructor did not pull dao.wei");
        assertEq(IWNS(NFT).reverseResolve(dao), "dao.wei", "reverse-resolve failed");
        assertEq(address(WeiDAO(payable(dao)).nft()), NFT, "nft");
        assertEq(WeiDAO(payable(dao)).alpha(), ALPHA, "alpha");
        assertEq(WeiDAO(payable(dao)).threshold(), THRESHOLD, "threshold");
        assertEq(WeiDAO(payable(dao)).proposalFee(), FEE, "proposalFee");
        assertEq(WeiDAO(payable(dao)).executionDelay(), DELAY, "executionDelay");
        assertEq(WeiDAO(payable(dao)).executor(), MULTISIG, "executor role");
        assertEq(WeiDAO(payable(dao)).vetoer(), MULTISIG, "vetoer role");

        // Granular: the constructor actually minted the two subdomain NFTs to roleHolder, with the
        // right names and parented to dao.wei — so their namehashes equal VETO_ROLE / EXEC_ROLE.
        assertEq(IWNS(NFT).ownerOf(VETO_ROLE), MULTISIG, "veto.dao.wei not owned by roleHolder");
        assertEq(IWNS(NFT).ownerOf(EXEC_ROLE), MULTISIG, "exec.dao.wei not owned by roleHolder");
        assertEq(IWNS(NFT).getFullName(VETO_ROLE), "veto.dao.wei", "veto full name");
        assertEq(IWNS(NFT).getFullName(EXEC_ROLE), "exec.dao.wei", "exec full name");
        (, uint256 vetoParent,,,) = IWNS(NFT).records(VETO_ROLE);
        (, uint256 execParent,,,) = IWNS(NFT).records(EXEC_ROLE);
        assertEq(vetoParent, DAO_WEI, "veto parent != dao.wei");
        assertEq(execParent, DAO_WEI, "exec parent != dao.wei");
        emit log_named_address("DAO deployed + handover complete at", dao);
    }
}
