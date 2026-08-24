// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract NullForwarder {
    fallback() external payable {
        assembly ("memory-safe") {
            pop(call(0x00, 0x00, callvalue(), codesize(), 0x00, codesize(), 0x00))
            calldatacopy(0x00, 0x00, 0x04)
            return(0x00, 0x20)
        }
    }
}
