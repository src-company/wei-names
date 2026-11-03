// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "@forge/Script.sol";
import {console2} from "@forge/console2.sol";
import {WeiPosts, IWeiPostsNameNFT} from "../src/WeiPosts.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
}

/// @notice Deploy WeiPosts to a deterministic (CREATE3) address via canonical CreateX.
///
///         The address is user-facing (the dapp and gateway hardcode it, and authors pay into
///         it), so mine a leading-zeros salt as for the rest of the system:
///         `python3 ops/mine_create3.py <DEPLOYER_EOA> 4`, then `verify` its output.
///
///         WeiPosts has no owner and its only constructor argument is the NameNFT it checks
///         ownership against, so nothing rides on the predicted address beyond the address.
///
///         Build and deploy under the default profile (solc 0.8.34, via-IR, 20 runs), then:
///         `forge verify-contract $POSTS_ADDR src/WeiPosts.sol:WeiPosts --chain 1 \
///            --constructor-args $(cast abi-encode "f(address)" 0x0000000000696760E15f265e828DB644A0c242EB)`
///
///         Record the deployment block: the gateway (POSTS_FROM_BLOCK) and the publisher
///         (POSTER_FROM_BLOCK) read events from it.
///
/// Env: SALT (sender-bound), POSTS_ADDR (the CREATE3 address that SALT yields).
/// Run: forge script script/DeployWeiPosts.s.sol --rpc-url $RPC --broadcast
contract DeployWeiPosts is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    address constant NAME_NFT = 0x0000000000696760E15f265e828DB644A0c242EB;

    function run() external {
        bytes32 salt = vm.envBytes32("SALT");
        address expected = vm.envAddress("POSTS_ADDR");

        require(
            address(bytes20(salt)) == msg.sender,
            "SALT must be sender-bound (first 20 bytes == deployer)"
        );
        require(uint8(salt[20]) == 0, "SALT byte 20 must be 0x00 (no redeploy protection)");
        require(block.chainid == 1, "mainnet only");
        require(NAME_NFT.code.length != 0, "NameNFT not deployed here");

        bytes memory initCode = abi.encodePacked(type(WeiPosts).creationCode, abi.encode(NAME_NFT));
        vm.startBroadcast();
        address deployed = CREATEX.deployCreate3(salt, initCode);
        vm.stopBroadcast();

        // The runtime code embeds the NameNFT immutable, so it can't be compared against
        // type(WeiPosts).runtimeCode; check what the immutable and constant read back instead.
        require(deployed == expected, "POSTS_ADDR does not match the CREATE3 address for SALT");
        require(address(WeiPosts(deployed).nameNFT()) == NAME_NFT, "bound to the wrong NameNFT");
        require(WeiPosts(deployed).REFUND_DELAY() == 1 days, "not WeiPosts as built here");
        console2.log("WeiPosts deployed at", deployed);
        console2.log("deployment block", block.number);
    }
}
