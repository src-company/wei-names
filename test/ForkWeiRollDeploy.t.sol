// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiRoll} from "../src/WeiRoll.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes calldata initCode) external payable returns (address);
    function computeCreate3Address(bytes32 guardedSalt) external view returns (address);
}

interface IWNS {
    function ownerOf(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
    function reverseResolve(address) external view returns (string memory);
}

/// @notice Rehearsal of the exact mainnet deploy the wallet will sign: CreateX CREATE3 at a mined
///         vanity salt, funded in the same tx, then `roll.wei` transferred in (the boring §5 path,
///         no pre-approval). Self-skips unless RUN_FORK_DEPLOY=true.
///         Run: `RUN_FORK_DEPLOY=true forge test --match-contract ForkWeiRollDeploy -vv`.
contract ForkWeiRollDeploy is Test {
    address constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    address constant NFT = 0x0000000000696760E15f265e828DB644A0c242EB;
    address constant DAO = 0x00000007988A79d16cf76B5dc4cF54dc3Af24936;
    address constant WRAPPER = 0x02aae1A04f9828517b3007f83f6181900CaD910c;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address constant DEPLOYER = 0x1C0Aa8cCD568d90d61659F060D1bFb1e6f855A20; // owns roll.wei
    uint256 constant ROLL_WEI = 0xf218d633879b71231b282e26380ab665b6d0defe8dafef3bfeac70dd46799d80;

    // sample sender-protected salt (2 leading zero bytes) — the miner supplies the final one.
    bytes32 constant SALT = 0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20000000000000000000006b83;

    function testDeployViaCreateX() public {
        if (!vm.envOr("RUN_FORK_DEPLOY", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.rpcUrl("main3"));

        bytes memory initCode =
            abi.encodePacked(type(WeiRoll).creationCode, abi.encode(NFT, DAO, WRAPPER, STETH));

        bytes32 guarded = keccak256(abi.encode(DEPLOYER, SALT));
        address predicted = ICreateX(CREATEX).computeCreate3Address(guarded);
        emit log_named_address("predicted vanity address", predicted);

        // 1) deploy + fund, signed by the deployer (sender-protected salt requires it)
        vm.deal(DEPLOYER, 1 ether);
        vm.prank(DEPLOYER);
        address deployed = ICreateX(CREATEX).deployCreate3{value: 0.05 ether}(SALT, initCode);
        assertEq(deployed, predicted, "landed off the predicted address");

        WeiRoll roll = WeiRoll(payable(deployed));
        assertApproxEqAbs(roll.pot(), 0.05 ether, 4, "funding did not stake into the pot");
        assertEq(roll.roundEnd(), block.timestamp + roll.ROUND_LENGTH(), "first round not open");
        assertFalse(roll.state().naming, "naming should be off until roll.wei arrives");

        // 2) hand roll.wei over (deploy-then-transfer, no pre-approval)
        vm.prank(DEPLOYER);
        IWNS(NFT).transferFrom(DEPLOYER, deployed, ROLL_WEI);
        assertEq(IWNS(NFT).ownerOf(ROLL_WEI), deployed, "roll.wei not held");
        assertTrue(roll.state().naming, "naming should be live once roll.wei is in");

        emit log_named_decimal_uint("pot after 0.05 ETH deploy (stETH)", roll.pot(), 18);
    }
}
