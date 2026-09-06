// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "@forge/Script.sol";
import {console2} from "@forge/console2.sol";
import {WeiTerms} from "../src/WeiTerms.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
}

/// @notice Deploy WeiTerms to a deterministic (CREATE3) address via canonical CreateX.
///
///         The address is user-facing — the dapp hardcodes it and wallets show it on every
///         multi-year renewal — so it is worth mining a leading-zeros salt the way the rest of the
///         system did: `python3 ops/mine_create3.py <DEPLOYER_EOA> 4`, then `verify` its output.
///
///         There are no constructor arguments and nothing to fund. WeiTerms has no owner, no
///         storage and no privileges over any name, so unlike the WeiRoll deployment there is
///         nothing riding on the predicted address beyond the address itself.
///
///         Build and deploy under the default profile (solc 0.8.34, via-IR, 20 runs). The
///         CREATE3 address does not depend on the initcode, so `profile.null` would put
///         different bytecode at the same address with every check below still passing.
///
///         Etherscan does not attribute a CREATE3 deployment to the broadcast transaction, so
///         verify afterwards rather than with `--verify`:
///         `forge verify-contract $TERMS_ADDR src/WeiTerms.sol:WeiTerms --chain 1`
///
/// Env: SALT (sender-bound), TERMS_ADDR (the CREATE3 address that SALT yields).
/// Run: forge script script/DeployWeiTerms.s.sol --rpc-url $RPC --broadcast
contract DeployWeiTerms is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external {
        bytes32 salt = vm.envBytes32("SALT");
        address expected = vm.envAddress("TERMS_ADDR");

        // CreateX permissioned salt: first 20 bytes == caller, byte 20 the cross-chain redeploy
        // flag. Only that combination sends CreateX down the branch these addresses were mined
        // against; any other caller reusing this salt lands somewhere unrelated, so the predicted
        // address cannot be occupied ahead of the deployer.
        require(
            address(bytes20(salt)) == msg.sender,
            "SALT must be sender-bound (first 20 bytes == deployer)"
        );
        require(uint8(salt[20]) == 0, "SALT byte 20 must be 0x00 (no redeploy protection)");
        require(block.chainid == 1, "mainnet only");

        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(salt, type(WeiTerms).creationCode);
        vm.stopBroadcast();

        // The address is derived from the salt alone, so matching it says nothing about what was
        // deployed. Compare the code as well — this is the only check that ties the two together,
        // and the salt is one-shot: a wrong first deploy burns the address for good.
        require(deployed == expected, "TERMS_ADDR does not match the CREATE3 address for SALT");
        require(
            deployed.codehash == keccak256(type(WeiTerms).runtimeCode),
            "deployed code is not WeiTerms as built here"
        );
        console2.log("WeiTerms deployed at", deployed);
        console2.log("MAX_TERMS", WeiTerms(payable(deployed)).MAX_TERMS());
    }
}
