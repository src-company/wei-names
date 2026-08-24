// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "@forge/Script.sol";
import {console2} from "@forge/console2.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
}

interface INameNFTApprove {
    function approve(address to, uint256 id) external;
    function ownerOf(uint256 id) external view returns (address);
}

/// @notice Deploy WeiRoll to a deterministic (CREATE3) address via canonical CreateX, fund the pot
///         in the same tx (the constructor stakes it into Lido), and — if the deployer holds
///         `roll.wei` — pre-approve the target so the constructor pulls the name in and
///         reverse-resolves to it, atomically. See ops/ROLL.md for the runbook and how to mine
///         SALT / ROLL_ADDR for a vanity address.
///
/// Env: SALT (sender-bound), ROLL_ADDR (the CREATE3 address the mined SALT yields), VALUE (wei to
///      fund the first pot, 0 to launch dormant). All four dependencies are hardcoded mainnet.
contract DeployWeiRoll is Script {
    ICreateX constant CREATEX = ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    // namehash("roll.wei") — equals WeiRoll.PARENT.
    uint256 constant ROLL_WEI = 0xf218d633879b71231b282e26380ab665b6d0defe8dafef3bfeac70dd46799d80;

    function run() external {
        bytes32 salt = vm.envBytes32("SALT");
        address expected = vm.envAddress("ROLL_ADDR");
        uint256 value = vm.envOr("VALUE", uint256(0));

        // Refuse unless SALT is sender-bound (CreateX permissioned salt: first 20 bytes == caller).
        // Without it, someone could front-run deployCreate3 with the same salt, occupy the address,
        // and spend the roll.wei pre-approval below. Enforcing it makes that front-run impossible.
        require(
            address(bytes20(salt)) == msg.sender,
            "SALT must be sender-bound (first 20 bytes == deployer)"
        );

        bytes memory initCode =
            abi.encodePacked(type(WeiRoll).creationCode, abi.encode(NFT, DAO, WRAPPER, STETH));

        vm.startBroadcast();
        if (INameNFTApprove(NFT).ownerOf(ROLL_WEI) == msg.sender) {
            INameNFTApprove(NFT).approve(expected, ROLL_WEI); // constructor pulls it in
        }
        address roll = CREATEX.deployCreate3{value: value}(salt, initCode);
        vm.stopBroadcast();

        require(roll == expected, "ROLL_ADDR does not match the CREATE3 address for SALT");
        console2.log("WeiRoll deployed at", roll);
        console2.log("pot (stETH wei)", WeiRoll(payable(roll)).pot());
    }
}
