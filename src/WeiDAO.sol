// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Receiver} from "solady/accounts/Receiver.sol";

/// @title WeiDAO
/// @notice Minimal seasoning-based DAO + treasury for the Wei Name Service.
/// @dev In homage to Wei Dai, the cypherpunk whose b-money prefigured on-chain governance.
///
/// The treasury *is* this contract. Point WNS at it once with
/// `NameNFT.transferOwnership(weiDAO)`; thereafter it:
///   • receives `withdraw()` fees and any ETH (via {Receiver}),
///   • can custody ERC721/ERC1155 assets, including WNS names (via {Receiver} callbacks),
///   • is the only account able to call NameNFT's `onlyOwner` admin setters — reachable
///     solely through a passed proposal's arbitrary `execute` call.
///
/// ── One name, one vote ─────────────────────────────────────────────────────────────────
/// WNS names are unique ERC721 IDs, so each name votes once per proposal (`tokenVoted`) and a
/// transfer mid-vote can't double-count it. There is no Merkle snapshot and no proofs:
/// eligibility, ownership, and weight are all read live on-chain at vote time.
///
/// ── Seasoning (anti flash-mint) ────────────────────────────────────────────────────────
/// Voting power is freely mintable (register a name, pay a fee) and, worse, that fee flows
/// into the very treasury a drain would return — so power must not be acquirable on demand.
/// A name may only vote a proposal if it was `enroll`ed and has matured for `MATURITY` *before
/// that proposal was created*. A fresh registration cannot satisfy the delay, so you can't
/// react to a proposal by minting weight; an attacker must register AND enroll a fake
/// electorate `MATURITY` in advance — locking capital and leaving a public on-chain footprint
/// the entire time. Enrollment is permissionless (a keeper can season the whole namespace, so
/// holders needn't act), set-once per registration, and bound to the name's `epoch` — so a
/// name that lapses and is re-registered loses its seasoning (a new owner cannot inherit it).
///
/// ── Weight = expected contribution, ranked by length via the live config ───────────────
/// A name's weight is `NameNFT.getFee(byteLength(label))`: exactly what a name of that length
/// pays to register/renew per the *current* on-chain fee schedule (the same byte-length key
/// NameNFT charges on). Shorter, pricier names rank higher precisely to the degree the live
/// config prices them so; under the flat default config, one name = one vote. Only active
/// top-level names (`parent == 0`, not expired) are eligible.
///
/// ── Absolute quorum + guardian + timelock ──────────────────────────────────────────────
/// A proposal passes on a simple majority of cast weight AND `forVotes >= quorum`, an absolute
/// floor. Because weight is denominated in fees, clearing quorum by minting costs at least
/// `quorum` in fees paid into the treasury — so an attack must front roughly the treasury's
/// scale in fresh, at-risk capital. Execution is timelocked after voting closes, and an
/// immutable `guardian` may *only cancel* a not-yet-executed proposal (never propose, vote,
/// execute, or steal — worst case it censors). Set `guardian = address(0)` to disable.
contract WeiDAO is Receiver {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotSelf();
    error Canceled();
    error Rejected();
    error NotHolder();
    error VotingOpen();
    error NotEligible();
    error NotGuardian();
    error AlreadyVoted();
    error VotingClosed();
    error NoPrimaryName();
    error AlreadyEnrolled();
    error AlreadyExecuted();
    error ExecutionFailed();
    error ExecutionLocked();
    error InsufficientFee();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Enrolled(uint256 indexed tokenId, address indexed by, uint64 since, uint64 epoch);
    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        address target,
        uint256 value,
        bytes data,
        uint256 createdAt,
        string description,
        string proposerName
    );
    event ProposalFeeSet(uint256 fee);
    event RequirePrimaryNameSet(bool required);
    event VoteCast(
        uint256 indexed id,
        uint256 indexed tokenId,
        address indexed voter,
        bool support,
        uint256 weight
    );
    event ProposalExecuted(uint256 indexed id, bytes result);
    event ProposalCanceled(uint256 indexed id);

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice How long a name must be enrolled before a proposal to vote it (anti flash-mint).
    uint256 public constant MATURITY = 30 days;

    /// @notice How long voting stays open after a proposal is created.
    uint256 public constant VOTING_PERIOD = 3 days;

    /// @notice Delay after voting closes before a passed proposal may be executed (guardian window).
    uint256 public constant EXECUTION_DELAY = 2 days;

    /// @notice WNS NameNFT.
    INameNFT public immutable nft;

    /// @notice May cancel (only) any not-yet-executed proposal. `address(0)` disables the veto.
    address public immutable guardian;

    /// @notice Absolute "for" weight a proposal must reach to pass (in `getFee` weight-units).
    uint256 public immutable quorum;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Enrollment {
        uint64 since; // When the name was enrolled (0 = never).
        uint64 epoch; // NameNFT epoch at enrollment; invalidated if the name is re-registered.
    }

    struct Proposal {
        uint64 createdAt; // ┐ packed: proposal time (drives voting close + timelock + seasoning),
        bool executed; //    │ execution flag,
        bool canceled; //    │ guardian veto flag,
        address target; // ┘ call target (e.g. NameNFT).
        uint256 forVotes;
        uint256 againstVotes;
        uint256 value; // ETH to forward from the treasury.
        bytes data; // Calldata (e.g. abi.encodeWithSelector(NameNFT.withdraw.selector)).
    }

    uint256 public proposalCount;
    /// @notice ETH required to open a proposal (anti-spam, paid to the treasury). Starts 0;
    ///         tunable only by the DAO itself (`setProposalFee` via a passed proposal).
    uint256 public proposalFee;
    /// @notice If true, a proposer must have a WNS primary name. Starts false; DAO-tunable.
    bool public requirePrimaryName;

    mapping(uint256 => Enrollment) public enrollments; // tokenId => seasoning
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(uint256 => bool)) public tokenVoted; // id => tokenId => voted

    constructor(address nameNFT, address guardian_, uint256 quorum_) payable {
        nft = INameNFT(nameNFT);
        guardian = guardian_;
        quorum = quorum_;
    }

    /*//////////////////////////////////////////////////////////////
                               ENROLLMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Start a name's seasoning clock; it matures in `MATURITY`.
    /// @dev Permissionless — anyone may enroll any registered name (so a keeper can season the
    ///      whole namespace; holders needn't act). The delay, not the caller, is what secures
    ///      it: the clock can't start before the name exists, and enrolling only ever helps the
    ///      name's owner. Set-once per registration — an enrollment can't be reset (anti-grief)
    ///      until the name is re-registered, which bumps `epoch` and voids the old seasoning.
    function enroll(uint256 tokenId) external {
        (,,, uint64 epoch,) = nft.records(tokenId);
        if (epoch == 0) revert NotEligible(); // name was never registered
        Enrollment storage e = enrollments[tokenId];
        if (e.since != 0 && e.epoch == epoch) revert AlreadyEnrolled();
        e.since = uint64(block.timestamp);
        e.epoch = epoch;
        emit Enrolled(tokenId, msg.sender, uint64(block.timestamp), epoch);
    }

    /*//////////////////////////////////////////////////////////////
                              GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a proposal to run `target.call{value}(data)` if the vote passes.
    /// @dev Payable: `msg.value` must cover `proposalFee` and stays in the treasury.
    /// @param proposerTokenId Any active WNS name owned by the caller — sybil gate for proposing.
    function propose(
        address target,
        uint256 value,
        bytes calldata data,
        string calldata description,
        uint256 proposerTokenId
    ) external payable returns (uint256 id) {
        if (nft.ownerOf(proposerTokenId) != msg.sender) revert NotHolder();
        if (weightOf(proposerTokenId) == 0) revert NotEligible();
        if (msg.value < proposalFee) revert InsufficientFee();

        string memory proposerName = nft.reverseResolve(msg.sender);
        if (requirePrimaryName && bytes(proposerName).length == 0) revert NoPrimaryName();

        unchecked {
            id = ++proposalCount;
        }
        Proposal storage p = proposals[id];
        p.createdAt = uint64(block.timestamp);
        p.target = target;
        p.value = value;
        p.data = data;

        emit ProposalCreated(
            id, msg.sender, target, value, data, block.timestamp, description, proposerName
        );
    }

    /// @notice Set the proposal fee. Callable only by the DAO itself (via a passed proposal).
    function setProposalFee(uint256 fee) external {
        if (msg.sender != address(this)) revert NotSelf();
        proposalFee = fee;
        emit ProposalFeeSet(fee);
    }

    /// @notice Toggle the primary-name requirement. Callable only by the DAO itself.
    function setRequirePrimaryName(bool required) external {
        if (msg.sender != address(this)) revert NotSelf();
        requirePrimaryName = required;
        emit RequirePrimaryNameSet(required);
    }

    /// @notice Vote a single name. Eligibility, ownership, and weight are all verified on-chain.
    function vote(uint256 id, uint256 tokenId, bool support) external {
        _vote(id, tokenId, support);
    }

    /// @notice Vote every name you hold in one call.
    function voteBatch(uint256 id, uint256[] calldata tokenIds, bool support) external {
        uint256 n = tokenIds.length;
        for (uint256 i; i < n; ++i) {
            _vote(id, tokenIds[i], support);
        }
    }

    function _vote(uint256 id, uint256 tokenId, bool support) internal {
        Proposal storage p = proposals[id];
        if (block.timestamp > p.createdAt + VOTING_PERIOD) revert VotingClosed();
        if (tokenVoted[id][tokenId]) revert AlreadyVoted();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        // Weight is 0 unless the name is seasoned as of proposal creation and active now.
        uint256 w = _weightFor(tokenId, p.createdAt);
        if (w == 0) revert NotEligible();

        tokenVoted[id][tokenId] = true;
        if (support) {
            p.forVotes += w;
        } else {
            p.againstVotes += w;
        }

        emit VoteCast(id, tokenId, msg.sender, support, w);
    }

    /// @notice Guardian-only: cancel a not-yet-executed proposal (the sole guardian power).
    function cancel(uint256 id) external {
        if (msg.sender != guardian) revert NotGuardian();
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        p.canceled = true;
        emit ProposalCanceled(id);
    }

    /// @notice Execute a passed proposal once voting has closed and the timelock has elapsed.
    /// @dev Passes on simple majority of cast weight plus the absolute `quorum` "for" floor.
    function execute(uint256 id) external returns (bytes memory result) {
        Proposal storage p = proposals[id];
        if (p.canceled) revert Canceled();
        if (p.executed) revert AlreadyExecuted();
        if (block.timestamp <= p.createdAt + VOTING_PERIOD) revert VotingOpen();
        if (block.timestamp <= p.createdAt + VOTING_PERIOD + EXECUTION_DELAY) {
            revert ExecutionLocked();
        }
        if (p.forVotes <= p.againstVotes || p.forVotes < quorum) revert Rejected();

        p.executed = true; // Effects before interaction (reentrancy-safe).

        bool ok;
        (ok, result) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecutionFailed();

        emit ProposalExecuted(id, result);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's base weight: its expected contribution under the live fee config.
    /// @dev Active top-level names only (`parent == 0`, `block.timestamp <= expiresAt`); 0 else.
    ///      Weight is `NameNFT.getFee(byteLength(label))` — the same byte-length key NameNFT
    ///      charges on — read live, so it reflects the config at call time. Voting additionally
    ///      requires seasoning (see `voteWeight`).
    function weightOf(uint256 tokenId) public view returns (uint256) {
        (string memory label, uint256 parent, uint64 exp,,) = nft.records(tokenId);
        if (parent != 0 || bytes(label).length == 0 || block.timestamp > exp) return 0;
        return nft.getFee(bytes(label).length);
    }

    /// @notice The weight `tokenId` would contribute to proposal `id` (0 if ineligible now).
    function voteWeight(uint256 id, uint256 tokenId) external view returns (uint256) {
        return _weightFor(tokenId, proposals[id].createdAt);
    }

    /// @notice Whether a proposal currently meets the pass conditions (majority + quorum).
    function passed(uint256 id) external view returns (bool) {
        Proposal storage p = proposals[id];
        return p.forVotes > p.againstVotes && p.forVotes >= quorum;
    }

    /// @dev Eligible voting weight: base weight, but 0 unless the name was seasoned by `asOf`
    ///      and its enrollment epoch still matches (i.e. it has not been re-registered since).
    function _weightFor(uint256 tokenId, uint256 asOf) internal view returns (uint256) {
        Enrollment storage e = enrollments[tokenId];
        if (e.since == 0 || uint256(e.since) + MATURITY > asOf) return 0;
        (string memory label, uint256 parent, uint64 exp, uint64 epoch,) = nft.records(tokenId);
        if (parent != 0 || bytes(label).length == 0 || block.timestamp > exp) return 0;
        if (e.epoch != epoch) return 0;
        return nft.getFee(bytes(label).length);
    }
}

interface INameNFT {
    function ownerOf(uint256 id) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function reverseResolve(address addr) external view returns (string memory);
    function records(uint256 id)
        external
        view
        returns (
            string memory label,
            uint256 parent,
            uint64 expiresAt,
            uint64 epoch,
            uint64 parentEpoch
        );
}
