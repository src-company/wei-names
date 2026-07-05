// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {NameNFT} from "../src/NameNFT.sol";
import {WeiDAO} from "../src/WeiDAO.sol";

/// @notice Not a unit test — a generator. Seeds a dummy WeiDAO with 30 proposals in every state and
///         writes the live `html()` output to `ops/demo_many.html` for visual review of the on-chain
///         dapp. Run: `forge test --match-test testGenerateDapp -vv`.
contract WeiDAODemoTest is Test {
    NameNFT nft;
    WeiDAO dao;

    address alice = makeAddr("alice");
    address carol = makeAddr("carol");
    address vetoAddr = makeAddr("vetoer");
    address execAddr = makeAddr("exec");
    address z = makeAddr("deployer");

    uint256 tAlice; // "aa"    len 2 -> 0.05 ETH tier
    uint256 tCarol; // "carol" len 5 -> 0.02 ETH tier
    uint256 tDao;

    uint256 constant ALPHA_7D = 999_998_853_923_940_000;
    uint256 threshold;

    function setUp() public {
        threshold = 0.05 ether * 1e18 / (1e18 - ALPHA_7D) / 2; // W_req = one "aa" name-year
        nft = new NameNFT();
        dao = new WeiDAO(address(nft), ALPHA_7D, threshold, 0.001 ether, 2 days, address(0));

        uint256[] memory lens = new uint256[](2);
        uint256[] memory fees = new uint256[](2);
        (lens[0], fees[0]) = (2, 0.05 ether);
        (lens[1], fees[1]) = (5, 0.02 ether);
        vm.startPrank(nft.owner());
        nft.setLengthFees(lens, fees);
        nft.transferOwnership(address(dao));
        vm.stopPrank();

        tAlice = _register("aa", alice);
        tCarol = _register("carol", carol);
        vm.prank(alice);
        nft.setPrimaryName(tAlice);
        vm.prank(carol);
        nft.setPrimaryName(tCarol);

        tDao = _register("dao", z);
        vm.startPrank(z);
        nft.registerSubdomainFor("veto", tDao, vetoAddr);
        nft.registerSubdomainFor("exec", tDao, execAddr);
        nft.transferFrom(z, address(dao), tDao);
        vm.stopPrank();

        // Alice renews "aa" far ahead → whale weight that can carry proposals past threshold.
        uint256 fee = nft.getFee(2);
        vm.deal(alice, fee * 40);
        for (uint256 i; i < 40; ++i) {
            vm.prank(alice);
            nft.renew{value: fee}(tAlice);
        }

        vm.deal(address(dao), 12.4 ether); // seed the treasury
    }

    /// @notice Generator: 30 proposals so the newest-25 page, the pager, and scroll are visible.
    function testGenerateDapp() public {
        vm.prank(execAddr);
        dao.setExecutionDelay(12 hours);

        for (uint256 k = 1; k <= 30; ++k) {
            _propose(string.concat("Proposal #", vm.toString(k), ": ", _blurb(k)));
        }

        // Newest three backed by the whale; one older vetoed; warp past the delay; execute one.
        vm.startPrank(alice);
        dao.support(30, tAlice);
        dao.support(29, tAlice);
        dao.support(28, tAlice);
        vm.stopPrank();
        vm.prank(vetoAddr);
        dao.veto(27);
        vm.warp(block.timestamp + 1 days);
        dao.execute(28);

        vm.deal(address(nft), 2 ether);
        string memory page = dao.html();
        vm.writeFile("ops/demo_many.html", page);
        emit log_named_uint("html bytes", bytes(page).length);
        emit log_named_uint("proposals", dao.proposalCount());
    }

    function _blurb(uint256 k) internal pure returns (string memory) {
        if (k % 3 == 0) {
            return "Fund a public-goods grant round and publish the report to the dao.wei resolver "
                "so the whole membership can audit where treasury ETH went this quarter";
        }
        if (k % 3 == 1) return "Shorten the conviction half-life for faster governance";
        return "Withdraw accrued WNS registration fees into the DAO treasury";
    }

    function _propose(string memory description) internal returns (uint256 id) {
        vm.deal(alice, 0.001 ether); // proposal fee
        vm.prank(alice);
        id = dao.propose{value: 0.001 ether}(
            address(nft), 0, abi.encodeWithSelector(NameNFT.withdraw.selector), description
        );
    }

    function _register(string memory label, address to) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(bytes(label));
        vm.startPrank(to);
        nft.commit(nft.makeCommitment(label, to, secret));
        vm.warp(block.timestamp + 61);
        uint256 fee = nft.getFee(bytes(label).length);
        vm.deal(to, fee);
        tokenId = nft.reveal{value: fee}(label, secret);
        vm.stopPrank();
    }
}
