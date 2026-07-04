// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MerkleProofLib} from "solady/utils/MerkleProofLib.sol";
import {Receiver} from "solady/accounts/Receiver.sol";

/// @title WeiDAO
/// @notice Minimal Merkle-snapshot DAO + treasury for the Wei Name Service.
/// @dev In homage to Wei Dai, the cypherpunk whose b-money prefigured on-chain governance.
///
/// The treasury *is* this contract. Point WNS at it once with
/// `NameNFT.transferOwnership(weiDAO)`; thereafter it:
///   • receives `withdraw()` fees and any ETH (via {Receiver}),
///   • can custody ERC721/ERC1155 assets, including WNS names (via {Receiver} callbacks),
///   • is the only account able to call NameNFT's `onlyOwner` admin setters — reachable
///     solely through a passed proposal's arbitrary `execute` call.
///
/// ── One name, one vote (per proposal) ──────────────────────────────────────────────────
/// WNS names are unique ERC721 IDs, so the tokenId is its own snapshot key: there is no need
/// for ERC20-style balance checkpoints. You vote a *name*; the name is marked as having voted
/// on that proposal, so transferring it mid-vote cannot double-count it.
///
/// ── Verifiable weight ──────────────────────────────────────────────────────────────────
/// The Merkle leaf is only the tokenId — no proposer-chosen data:
///
///     leaf = keccak256(bytes.concat(keccak256(abi.encode(tokenId))))
///
/// so the correct root is a deterministic fingerprint of the eligible-name set at the snapshot
/// block, reproducible by anyone from public NameNFT logs. Everything that gives a vote power
/// is re-checked on-chain at vote time: membership (root), live ownership (`ownerOf`), single
/// use (`tokenVoted`), and weight (recomputed here — the proposer cannot forge it).
///
/// ── Weight = expected contribution, ranked by length via the live config ───────────────
/// A name's weight is `NameNFT.getFee(byteLength(label))`: exactly what a name of that length
/// is expected to contribute to the treasury per the *current* on-chain fee schedule (what it
/// paid to register and pays to renew). Shorter, pricier names rank higher precisely to the
/// degree the live config prices them so; under the flat default config, one name = one vote.
///
/// ── Why a guardian + timelock ──────────────────────────────────────────────────────────
/// The `root` is author-supplied and proposing is permissionless, and a WNS tokenId
/// (`keccak(WEI_NODE, keccak(label))`) is computable before a name exists — so a malicious
/// proposer could commit a root over names they then register, out-voting honest holders with
/// freshly minted, fee-recoverable weight. On this immutable, non-enumerable NFT there is no
/// on-chain way to prove a root reflects the true pre-proposal electorate, so the treasury is
/// protected by a break-glass instead: execution is timelocked after voting closes, and a
/// `guardian` may *only cancel* a not-yet-executed proposal (it can never propose, vote, or
/// execute — worst case it censors, never steals). Set `guardian = address(0)` to disable.
contract WeiDAO is Receiver {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error BadProof();
    error Canceled();
    error Rejected();
    error NotHolder();
    error VotingOpen();
    error NotEligible();
    error NotGuardian();
    error AlreadyVoted();
    error VotingClosed();
    error EmptySnapshot();
    error LengthMismatch();
    error WeightOverflow();
    error AlreadyExecuted();
    error ExecutionFailed();
    error ExecutionLocked();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        address target,
        uint256 value,
        bytes data,
        bytes32 root,
        uint256 totalWeight,
        uint256 snapshotBlock,
        uint256 deadline,
        string description
    );
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

    /// @notice How long voting stays open after a proposal is created.
    uint256 public constant VOTING_PERIOD = 3 days;

    /// @notice Fraction of the snapshot's total weight that must vote "for" to pass (bps).
    uint256 public constant QUORUM_BPS = 2000; // 20%

    /// @notice Delay after voting closes before a passed proposal may be executed (guardian window).
    uint256 public constant EXECUTION_DELAY = 2 days;

    /// @notice WNS NameNFT.
    INameNFT public immutable nft;

    /// @notice May cancel (only) any not-yet-executed proposal. `address(0)` disables the veto.
    address public immutable guardian;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Proposal {
        bytes32 root; // Merkle root over eligible tokenIds at `snapshotBlock`.
        uint256 totalWeight; // Sum of every eligible name's expected-contribution weight.
        uint256 forVotes;
        uint256 againstVotes;
        uint64 deadline; // ┐ packed: voting close time,
        bool executed; //   │ execution flag,
        bool canceled; //   │ guardian veto flag,
        address target; // ┘ call target (e.g. NameNFT).
        uint256 value; // ETH to forward from the treasury.
        bytes data; // Calldata (e.g. abi.encodeWithSelector(NameNFT.withdraw.selector)).
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(uint256 => bool)) public tokenVoted; // id => tokenId => voted

    constructor(address nameNFT, address guardian_) payable {
        nft = INameNFT(nameNFT);
        guardian = guardian_;
    }

    /*//////////////////////////////////////////////////////////////
                              GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a proposal to run `target.call{value}(data)` if the vote passes.
    /// @param root Merkle root over the eligible tokenId set at `snapshotBlock`; leaves are
    ///        `keccak256(bytes.concat(keccak256(abi.encode(tokenId))))`.
    /// @param totalWeight Sum of every eligible name's weight (quorum base) at `snapshotBlock`.
    ///        Deterministic from chain logs + live config, and bounded on-chain (see `execute`).
    /// @param snapshotBlock Block the electorate was enumerated at (for indexers/auditors).
    /// @param proposerTokenId Any WNS name owned by the caller — sybil gate for proposing.
    function propose(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 root,
        uint256 totalWeight,
        uint256 snapshotBlock,
        string calldata description,
        uint256 proposerTokenId
    ) external returns (uint256 id) {
        if (nft.ownerOf(proposerTokenId) != msg.sender) {
            revert NotHolder();
        }
        if (root == bytes32(0) || totalWeight == 0) revert EmptySnapshot();

        unchecked {
            id = ++proposalCount;
        }
        Proposal storage p = proposals[id];
        p.root = root;
        p.totalWeight = totalWeight;
        p.deadline = uint64(block.timestamp + VOTING_PERIOD);
        p.target = target;
        p.value = value;
        p.data = data;

        emit ProposalCreated(
            id,
            msg.sender,
            target,
            value,
            data,
            root,
            totalWeight,
            snapshotBlock,
            p.deadline,
            description
        );
    }

    /// @notice Vote a single name. Weight is derived and verified on-chain; you must own it.
    function vote(uint256 id, uint256 tokenId, bool support, bytes32[] calldata proof) external {
        _vote(id, tokenId, support, proof);
    }

    /// @notice Vote every name you hold in one call (each with its own proof).
    function voteBatch(
        uint256 id,
        uint256[] calldata tokenIds,
        bool support,
        bytes32[][] calldata proofs
    ) external {
        uint256 n = tokenIds.length;
        if (n != proofs.length) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            _vote(id, tokenIds[i], support, proofs[i]);
        }
    }

    function _vote(uint256 id, uint256 tokenId, bool support, bytes32[] calldata proof) internal {
        Proposal storage p = proposals[id];
        if (block.timestamp > p.deadline) revert VotingClosed();
        if (tokenVoted[id][tokenId]) revert AlreadyVoted();

        // Membership: the tokenId must be in the frozen electorate.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(tokenId))));
        if (!MerkleProofLib.verifyCalldata(proof, p.root, leaf)) revert BadProof();

        // Authenticity: only the live holder may vote the name.
        if (nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        // Weight: recomputed on-chain from the live config — proposer cannot forge it.
        uint256 w = weightOf(tokenId);
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
    /// @dev Passes on simple majority of cast weight plus a `QUORUM_BPS` "for" quorum. The
    ///      `WeightOverflow` guard rejects any proposal whose cast weight exceeds the committed
    ///      `totalWeight` — an understated quorum base, or live weights inflated past the
    ///      snapshot by a mid-vote fee change (see `weightOf`); it fails closed either way.
    function execute(uint256 id) external returns (bytes memory result) {
        Proposal storage p = proposals[id];
        if (p.canceled) revert Canceled();
        if (p.executed) revert AlreadyExecuted();
        if (block.timestamp <= p.deadline) revert VotingOpen();
        if (block.timestamp <= p.deadline + EXECUTION_DELAY) revert ExecutionLocked();
        if (p.forVotes + p.againstVotes > p.totalWeight) revert WeightOverflow();
        if (p.forVotes <= p.againstVotes) revert Rejected();
        if (p.forVotes * 10000 < p.totalWeight * QUORUM_BPS) revert Rejected();

        p.executed = true; // Effects before interaction (reentrancy-safe).

        bool ok;
        (ok, result) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecutionFailed();

        emit ProposalExecuted(id, result);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's voting weight: its expected contribution under the live fee config.
    /// @dev Eligible = active top-level name (`parent == 0`, `block.timestamp <= expiresAt`);
    ///      subdomains and expired/grace-period names return 0. Weight is
    ///      `NameNFT.getFee(byteLength(label))` — the fee a name of this length pays to
    ///      register/renew (the same byte-length key NameNFT charges on), so power ranks by
    ///      length exactly as the current config prices it. Read live, so it reflects the
    ///      config at vote time, not at `snapshotBlock`. Returns 0 if ineligible.
    function weightOf(uint256 tokenId) public view returns (uint256) {
        (string memory label, uint256 parent, uint64 exp,,) = nft.records(tokenId);
        if (parent != 0) return 0; // Only top-level names vote.
        if (bytes(label).length == 0) return 0; // No such name.
        if (block.timestamp > exp) return 0; // Expired.
        return nft.getFee(bytes(label).length);
    }

    /// @notice Whether a proposal currently meets the pass conditions (majority + quorum).
    function passed(uint256 id) external view returns (bool) {
        Proposal storage p = proposals[id];
        return p.forVotes > p.againstVotes && p.forVotes * 10000 >= p.totalWeight * QUORUM_BPS;
    }
}

interface INameNFT {
    function ownerOf(uint256 id) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
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
