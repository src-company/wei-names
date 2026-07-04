// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Receiver} from "solady/accounts/Receiver.sol";

/// @title WeiDAOConviction
/// @notice PROTOTYPE conviction-voting variant of WeiDAO for the Wei Name Service.
/// @dev In homage to Wei Dai. A treasury (holds ETH + NFTs via {Receiver}) that WNS holders
///      steer by *conviction voting* instead of discrete seasoned ballots. This is a prototype
///      to compare against the shipped `WeiDAO`; see caveats at the bottom.
///
/// ── How conviction replaces seasoning ──────────────────────────────────────────────────
/// You `support` a proposal with a name. While a name backs a proposal, the proposal's
/// *conviction* accrues over time toward an asymptote and decays when support is withdrawn:
///
///     conviction' = conviction · α^Δ  +  supportWeight · (1 − α^Δ) / (1 − α)
///
/// where Δ is seconds elapsed and α ∈ (0,1) is the per-second decay. A proposal executes once
/// conviction ≥ `threshold`. Because conviction starts at 0 and needs *sustained* support to
/// build, freshly-minted weight has ~no immediate effect — flash-mint-and-execute is
/// impossible with no enrollment, no maturity clock, and no voting deadline. Steady-state
/// conviction from constant weight w is `w · SCALE / (SCALE − α)`, so `threshold` is expressed
/// in weight-units: it is the sustained weight a proposal must hold to pass.
///
/// ── Weight = expected contribution, ranked by length via the live config ───────────────
/// A name's weight is `NameNFT.getFee(byteLength(label))` — what it pays to register/renew
/// under the live config; active top-level names only (`parent == 0`, not expired).
///
/// ── Guardian ───────────────────────────────────────────────────────────────────────────
/// Conviction's ramp *is* the timelock: a proposal is visible accruing for a long time before
/// it can pass, so watchers have warning. An immutable `guardian` may still only `cancel` a
/// not-yet-executed proposal (never propose, support, execute, or steal). `address(0)` disables.
///
/// ── Prototype caveats ──────────────────────────────────────────────────────────────────
/// • Conviction voting is support-only; opposition is expressed by withholding/withdrawing
///   support (and, ultimately, the guardian veto). There is no "against".
/// • Weight is captured at `support` time; if a supporting name is transferred or expires, its
///   weight keeps accruing until someone (its current owner) calls `unsupport`. Lazy accrual.
/// • `α^Δ` uses fixed-point exponentiation; fine for a prototype, not precision-audited.
contract WeiDAOConviction is Receiver {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Canceled();
    error Rejected();
    error NotHolder();
    error NoProposal();
    error NotEligible();
    error NotGuardian();
    error NotSupporting();
    error AlreadyExecuted();
    error ExecutionFailed();
    error AlreadySupported();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        address target,
        uint256 value,
        bytes data,
        string description
    );
    event Supported(
        uint256 indexed id, uint256 indexed tokenId, address indexed supporter, uint256 weight
    );
    event Unsupported(
        uint256 indexed id, uint256 indexed tokenId, address indexed supporter, uint256 weight
    );
    event ProposalExecuted(uint256 indexed id, bytes result);
    event ProposalCanceled(uint256 indexed id);

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Fixed-point scale for `alpha`, conviction, and weights.
    uint256 internal constant SCALE = 1e18;

    /// @notice WNS NameNFT.
    INameNFT public immutable nft;

    /// @notice May cancel (only) any not-yet-executed proposal. `address(0)` disables the veto.
    address public immutable guardian;

    /// @notice Per-second conviction decay α, scaled by 1e18 (0 < alpha < 1e18). Near 1e18 =
    ///         slow decay / long memory. The half-life is `ln(2) / -ln(alpha/1e18)` seconds.
    /// @dev Calibrated example — a **7-day half-life** is `alpha = 999998853923940000`
    ///      (= round(2^(-1/604800) · 1e18)). Then `SCALE - alpha = 1146076060000`.
    uint256 public immutable alpha;

    /// @notice Conviction a proposal must reach to pass (weight-units).
    /// @dev Calibrate against the half-life: set `threshold = convictionMax(W_req) / 2` so a
    ///      proposal holding sustained weight `W_req` passes after exactly one half-life (with
    ///      the 7-day alpha above, 7 days); more weight passes sooner, less never reaches.
    uint256 public immutable threshold;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Proposal {
        uint64 lastUpdate; // ┐ packed: last conviction sync,
        bool executed; //     │ execution flag,
        bool canceled; //     │ guardian veto flag,
        address target; //  ┘ call target (e.g. NameNFT).
        uint256 conviction; // Accrued conviction as of `lastUpdate` (scaled).
        uint256 supportWeight; // Total weight currently backing the proposal.
        uint256 value; // ETH to forward from the treasury.
        bytes data; // Calldata (e.g. abi.encodeWithSelector(NameNFT.withdraw.selector)).
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(uint256 => uint256)) public supportOf; // id => tokenId => weight backing (0 = none)

    constructor(address nameNFT, address guardian_, uint256 alpha_, uint256 threshold_) payable {
        require(alpha_ != 0 && alpha_ < SCALE && threshold_ != 0);
        nft = INameNFT(nameNFT);
        guardian = guardian_;
        alpha = alpha_;
        threshold = threshold_;
    }

    /*//////////////////////////////////////////////////////////////
                              GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a proposal to run `target.call{value}(data)` once conviction passes.
    /// @param proposerTokenId Any active WNS name owned by the caller — sybil gate for proposing.
    function propose(
        address target,
        uint256 value,
        bytes calldata data,
        string calldata description,
        uint256 proposerTokenId
    ) external returns (uint256 id) {
        if (nft.ownerOf(proposerTokenId) != msg.sender) revert NotHolder();
        if (weightOf(proposerTokenId) == 0) revert NotEligible();

        unchecked {
            id = ++proposalCount;
        }
        Proposal storage p = proposals[id];
        p.lastUpdate = uint64(block.timestamp);
        p.target = target;
        p.value = value;
        p.data = data;

        emit ProposalCreated(id, msg.sender, target, value, data, description);
    }

    /// @notice Back a proposal with a name you own; its weight begins accruing conviction.
    function support(uint256 id, uint256 tokenId) external {
        if (id == 0 || id > proposalCount) revert NoProposal();
        Proposal storage p = proposals[id];
        if (p.executed || p.canceled) revert Rejected();
        if (supportOf[id][tokenId] != 0) revert AlreadySupported();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        uint256 w = weightOf(tokenId);
        if (w == 0) revert NotEligible();

        _sync(p);
        p.supportWeight += w;
        supportOf[id][tokenId] = w;

        emit Supported(id, tokenId, msg.sender, w);
    }

    /// @notice Withdraw a name's support; conviction stops growing from it and decays.
    function unsupport(uint256 id, uint256 tokenId) external {
        uint256 w = supportOf[id][tokenId];
        if (w == 0) revert NotSupporting();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        Proposal storage p = proposals[id];
        _sync(p);
        p.supportWeight -= w;
        supportOf[id][tokenId] = 0;

        emit Unsupported(id, tokenId, msg.sender, w);
    }

    /// @notice Guardian-only: cancel a not-yet-executed proposal (the sole guardian power).
    function cancel(uint256 id) external {
        if (msg.sender != guardian) revert NotGuardian();
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        p.canceled = true;
        emit ProposalCanceled(id);
    }

    /// @notice Execute a proposal once its accrued conviction reaches `threshold`.
    function execute(uint256 id) external returns (bytes memory result) {
        Proposal storage p = proposals[id];
        if (p.canceled) revert Canceled();
        if (p.executed) revert AlreadyExecuted();

        _sync(p);
        if (p.conviction < threshold) revert Rejected();

        p.executed = true; // Effects before interaction (reentrancy-safe).

        bool ok;
        (ok, result) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecutionFailed();

        emit ProposalExecuted(id, result);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's weight: its expected contribution under the live fee config (0 if
    ///         not an active top-level name).
    function weightOf(uint256 tokenId) public view returns (uint256) {
        (string memory label, uint256 parent, uint64 exp,,) = nft.records(tokenId);
        if (parent != 0 || bytes(label).length == 0 || block.timestamp > exp) return 0;
        return nft.getFee(bytes(label).length);
    }

    /// @notice A proposal's conviction right now (accruing from its current support weight).
    function convictionOf(uint256 id) public view returns (uint256) {
        Proposal storage p = proposals[id];
        return _accrue(p.conviction, p.supportWeight, block.timestamp - p.lastUpdate);
    }

    /// @notice Steady-state conviction of a constant `weight`: `weight · SCALE / (SCALE − α)`.
    /// @dev The asymptote support of `weight` accrues toward. `threshold` is set relative to
    ///      this (e.g. `convictionMax(W_req) / 2` ⇒ `W_req` passes in one half-life).
    function convictionMax(uint256 weight) public view returns (uint256) {
        return weight * SCALE / (SCALE - alpha);
    }

    /// @notice Whether a proposal currently meets its conviction threshold.
    function passed(uint256 id) external view returns (bool) {
        return convictionOf(id) >= threshold;
    }

    /*//////////////////////////////////////////////////////////////
                               CONVICTION
    //////////////////////////////////////////////////////////////*/

    /// @dev Advance a proposal's stored conviction to the current time.
    function _sync(Proposal storage p) internal {
        uint256 dt = block.timestamp - p.lastUpdate;
        if (dt != 0) {
            p.conviction = _accrue(p.conviction, p.supportWeight, dt);
            p.lastUpdate = uint64(block.timestamp);
        }
    }

    /// @dev conviction' = c·α^dt + w·(1 − α^dt)/(1 − α).
    function _accrue(uint256 c, uint256 w, uint256 dt) internal view returns (uint256) {
        if (dt == 0) return c;
        uint256 a = _pow(alpha, dt); // α^dt, scaled
        return (c * a / SCALE) + (w * (SCALE - a) / (SCALE - alpha));
    }

    /// @dev Fixed-point exponentiation: (base/1e18)^exp · 1e18, by binary squaring.
    function _pow(uint256 base, uint256 exp) internal pure returns (uint256 result) {
        result = SCALE;
        while (exp != 0) {
            if (exp & 1 == 1) result = result * base / SCALE;
            base = base * base / SCALE;
            exp >>= 1;
        }
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
