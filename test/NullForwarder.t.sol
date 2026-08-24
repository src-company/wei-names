// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {ERC1155} from "solady/tokens/ERC1155.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {NullForwarder} from "../src/NullForwarder.sol";

contract MockNFT is ERC721 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MOCK";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract Mock1155 is ERC1155 {
    function uri(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id, uint256 amt) external {
        _mint(to, id, amt, "");
    }
}

contract NullForwarderTest is Test {
    NullForwarder public forwarder;
    NameNFT public nft;

    address public alice = address(0xA11CE);
    uint256 public constant DEFAULT_FEE = 0.001 ether;

    uint256 public aliceId;

    function setUp() public {
        forwarder = new NullForwarder();
        nft = new NameNFT();
        vm.deal(alice, 1000 ether);
        aliceId = _register("alice");
    }

    function _register(string memory label) internal returns (uint256) {
        bytes32 secret = keccak256(bytes(label));
        vm.prank(alice);
        nft.commit(nft.makeCommitment(label, alice, secret));
        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        return nft.reveal{value: DEFAULT_FEE}(label, secret);
    }

    /*//////////////////////////////////////////////////////////////
                              FORWARDING
    //////////////////////////////////////////////////////////////*/

    function test_ForwardsPlainSendToZeroAddress() public {
        uint256 before = address(0).balance;

        vm.prank(alice);
        (bool ok,) = address(forwarder).call{value: 1 ether}("");

        assertTrue(ok);
        assertEq(address(0).balance, before + 1 ether);
        assertEq(address(forwarder).balance, 0);
    }

    function test_ForwardsCallWithCalldata() public {
        uint256 before = address(0).balance;

        vm.prank(alice);
        (bool ok,) = address(forwarder).call{value: 3 ether}(hex"deadbeef");

        assertTrue(ok);
        assertEq(address(0).balance, before + 3 ether);
        assertEq(address(forwarder).balance, 0);
    }

    function test_ForwardsZeroValue() public {
        vm.prank(alice);
        (bool ok,) = address(forwarder).call("");
        assertTrue(ok);
    }

    function testFuzz_NeverRetainsBalance(uint96 amount) public {
        vm.deal(alice, amount);
        uint256 before = address(0).balance;

        vm.prank(alice);
        (bool ok,) = address(forwarder).call{value: amount}("");

        assertTrue(ok);
        assertEq(address(0).balance, before + amount);
        assertEq(address(forwarder).balance, 0);
    }

    /// @dev `transfer`/`send` give 2300 gas; the CALL to `0x00` needs ~9.3k.
    ///      Senders must use a full `call`. Documenting it so it stays known.
    function test_RevertsUnderTransferStipend() public {
        vm.prank(alice);
        (bool ok,) = address(forwarder).call{value: 1 ether, gas: 2300}("");
        assertFalse(ok);
    }

    /// @dev Mainnet-realistic: `0x00` already holds ETH, so no empty-account
    ///      surcharge, and a warm-up call makes both accounts warm as they would
    ///      be mid-transaction. Reported figure includes the test's outer CALL.
    function test_ForwardGasCost() public {
        vm.deal(address(0), 1 wei);
        vm.deal(alice, 100 ether);

        vm.startPrank(alice);
        (bool warm,) = address(forwarder).call{value: 1 ether}("");
        assertTrue(warm);

        uint256 g = gasleft();
        (bool ok,) = address(forwarder).call{value: 1 ether}("");
        uint256 used = g - gasleft();
        vm.stopPrank();

        assertTrue(ok);
        emit log_named_uint("forward gas (incl. outer CALL)", used);
        assertLt(used, 25_000);
    }

    /*//////////////////////////////////////////////////////////////
                    WHY THE FORWARDER HAS TO EXIST
    //////////////////////////////////////////////////////////////*/

    /// @dev `setAddr(id, address(0))` stores zero, but `resolve()` treats zero as
    ///      "unset" and falls back to `ownerOf`. A name can never resolve to null.
    function test_NameNFT_CannotResolveToZero() public {
        vm.prank(alice);
        nft.setAddr(aliceId, address(0));

        assertEq(nft.resolve(aliceId), alice);
        assertEq(abi.decode(abi.encodePacked(bytes12(0), nft.addr(aliceId, 60)), (address)), alice);
    }

    /// @dev The NFT itself cannot be sent to `0x00` either.
    function test_NameNFT_CannotTransferToZero() public {
        vm.prank(alice);
        vm.expectRevert(ERC721.TransferToZeroAddress.selector);
        nft.transferFrom(alice, address(0), aliceId);
    }

    /// @dev Nor can a name be minted straight to `0x00`.
    function test_NameNFT_CannotRegisterSubdomainToZero() public {
        vm.prank(alice);
        vm.expectRevert(ERC721.TransferToZeroAddress.selector);
        nft.registerSubdomainFor("null", aliceId, address(0));
    }

    /// @dev The workaround: alias the name to the forwarder. Paying the name burns.
    function test_AliasNameToForwarder() public {
        vm.prank(alice);
        nft.setAddr(aliceId, address(forwarder));

        assertEq(nft.resolve(aliceId), address(forwarder));

        uint256 before = address(0).balance;
        vm.prank(alice);
        (bool ok,) = nft.resolve(aliceId).call{value: 2 ether}("");

        assertTrue(ok);
        assertEq(address(0).balance, before + 2 ether);
    }

    /*//////////////////////////////////////////////////////////////
                          SAFE-TRANSFER RECEIVER
    //////////////////////////////////////////////////////////////*/

    /// @dev The fallback echoes calldata[0:4] as a left-aligned word. All three
    ///      receiver magic values ARE their own selectors, so one echo satisfies
    ///      721, 1155 and 1155-batch with no selector dispatch.
    function test_AcceptsERC721SafeTransfer() public {
        MockNFT nft721 = new MockNFT();
        nft721.mint(alice, 1);

        vm.prank(alice);
        nft721.safeTransferFrom(alice, address(forwarder), 1);

        assertEq(nft721.ownerOf(1), address(forwarder));
    }

    function test_AcceptsERC721SafeTransferWithData() public {
        MockNFT nft721 = new MockNFT();
        nft721.mint(alice, 1);

        vm.prank(alice);
        nft721.safeTransferFrom(alice, address(forwarder), 1, hex"c0ffee");

        assertEq(nft721.ownerOf(1), address(forwarder));
    }

    function test_AcceptsERC1155SafeTransfer() public {
        Mock1155 m = new Mock1155();
        m.mint(alice, 7, 100);

        vm.prank(alice);
        m.safeTransferFrom(alice, address(forwarder), 7, 100, "");

        assertEq(m.balanceOf(address(forwarder), 7), 100);
    }

    function test_AcceptsERC1155BatchTransfer() public {
        Mock1155 m = new Mock1155();
        m.mint(alice, 7, 100);
        m.mint(alice, 8, 5);

        uint256[] memory ids = new uint256[](2);
        uint256[] memory amts = new uint256[](2);
        ids[0] = 7;
        ids[1] = 8;
        amts[0] = 100;
        amts[1] = 5;

        vm.prank(alice);
        m.safeBatchTransferFrom(alice, address(forwarder), ids, amts, "");

        assertEq(m.balanceOf(address(forwarder), 7), 100);
        assertEq(m.balanceOf(address(forwarder), 8), 5);
    }

    /// @dev The echoed word must be the selector left-aligned in 32 bytes.
    function test_EchoesSelectorLeftAligned() public {
        (bool ok, bytes memory ret) = address(forwarder).call(abi.encodeWithSelector(0x150b7a02));
        assertTrue(ok);
        assertEq(ret.length, 32);
        assertEq(bytes32(ret), bytes32(bytes4(0x150b7a02)));
    }

    /// @dev Empty calldata returns a zero word, which is harmless.
    function test_PlainSendReturnsZeroWord() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(forwarder).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(bytes32(ret), bytes32(0));
    }
}
