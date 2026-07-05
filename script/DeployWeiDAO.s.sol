// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "@forge/Script.sol";
import {console2} from "@forge/console2.sol";
import {WeiDAO} from "../src/WeiDAO.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
}

interface INameNFTApprove {
    function approve(address to, uint256 id) external;
    function ownerOf(uint256 id) external view returns (address);
}

/// @notice Deploy WeiDAO to a deterministic (CREATE3) address via canonical CreateX and, if the
///         deployer holds `dao.wei`, pre-approve the target address so the constructor pulls the name
///         in and reverse-resolves to it — atomically. See ops/DEPLOY.md for the full runbook,
///         including how to mine `SALT`/`DAO_ADDR` for a `0x00000000…` vanity address.
///
/// Env: WNS_NFT, ALPHA, THRESHOLD, PROPOSAL_FEE, EXECUTION_DELAY, SALT, DAO_ADDR (the CREATE3 address
///      the mined SALT yields — pass it so we can pre-approve it before deploying).
contract DeployWeiDAO is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    // namehash("dao.wei") — equals WeiDAO.PROPOSAL_PARENT.
    uint256 constant DAO_WEI = 0x2a39629d0ee4dc68cfd48b5eefdd0362b034be5a595fec5dc802144293a8287c;

    function run() external {
        address nft = vm.envAddress("WNS_NFT");
        bytes32 salt = vm.envBytes32("SALT");
        address expected = vm.envAddress("DAO_ADDR");

        // Refuse to deploy unless SALT is sender-bound to this deployer (CreateX permissioned salt:
        // first 20 bytes == caller). Without it, an attacker could front-run deployCreate3 with the
        // same salt, occupy the CREATE3 address with their own contract, and spend the dao.wei
        // pre-approval below. Enforcing it here makes that front-run structurally impossible.
        require(
            address(bytes20(salt)) == msg.sender,
            "SALT must be sender-bound (first 20 bytes == deployer)"
        );

        bytes memory initCode = abi.encodePacked(
            type(WeiDAO).creationCode,
            abi.encode(
                nft,
                vm.envUint("ALPHA"),
                vm.envUint("THRESHOLD"),
                vm.envUint("PROPOSAL_FEE"),
                vm.envUint("EXECUTION_DELAY"),
                vm.envAddress("ROLE_HOLDER") // veto + exec minted to this on the dao.wei pull
            )
        );

        vm.startBroadcast();
        // Pre-approve the counterfactual DAO for dao.wei so the constructor can pull it in.
        if (INameNFTApprove(nft).ownerOf(DAO_WEI) == msg.sender) {
            INameNFTApprove(nft).approve(expected, DAO_WEI);
        }
        address dao = CREATEX.deployCreate3(salt, initCode);
        vm.stopBroadcast();

        require(dao == expected, "DAO_ADDR does not match the CREATE3 address for SALT");
        console2.log("WeiDAO deployed at", dao);
    }
}
