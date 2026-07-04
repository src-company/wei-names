// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Receiver} from "solady/accounts/Receiver.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title WeiDAO
/// @notice Conviction-voting DAO + treasury for the Wei Name Service.
/// @dev In homage to Wei Dai. A treasury (holds ETH + NFTs via {Receiver}) that WNS holders
///      steer by *conviction voting*: no enrollment, no maturity clock, no voting deadline or
///      timelock — the accrual ramp is intrinsically flash-mint-resistant. See caveats below.
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
/// ── Weight = ETH contributed to WNS ────────────────────────────────────────────────────
/// A name's weight is `getFee(byteLength) · (expiresAt − now) / 365d`: the length fee tier ×
/// how far it is paid ahead. So both scarcity (short = pricier) and renewal runway — the two
/// things that cost ETH — earn power, renewing boosts weight, and subdomains (which cost no
/// ETH) get 0, so they can't be spam-minted for votes. Active top-level names only.
///
/// ── Roles are WNS subdomains of dao.wei ────────────────────────────────────────────────
/// Two roles are resolved live from names under the DAO's parent (`dao.wei`), so holding the
/// name *is* holding the role, and handing it off is just a transfer:
/// • `veto.dao.wei` — its holder may `cancel` any not-yet-executed proposal (negative power
///   only; conviction's ramp is the warning window). Nothing minted = no veto.
/// • `exec.dao.wei` — a god-mode operator: may `cancel`, force-`execute` a proposal *bypassing
///   conviction*, and call the DAO's admin setters directly. Intended as a launch multisig
///   that can rescue WNS (e.g. force-execute `transferOwnership`) if a bug appears, then be
///   relinquished by transferring/burning the name to progressively decentralise.
///
/// ── Knobs ──────────────────────────────────────────────────────────────────────────────
/// `nft` is immutable; the role/parent names and `requirePrimaryName` are hardcoded. `alpha`,
/// `threshold`, and `proposalFee` are adjustable by governance (self-call) *or* the executor.
/// Default WNS behaviours (not toggles): a proposer must hold a WNS primary name; and every
/// proposal (while the DAO owns dao.wei) atomically mints `<id>.dao.wei` to the DAO and writes
/// its description into that name's resolver, so governance is a browsable WNS namespace.
///
/// ── Caveats ────────────────────────────────────────────────────────────────────────────
/// • Conviction voting is support-only; opposition is expressed by withholding/withdrawing
///   support (and, ultimately, the veto). There is no "against".
/// • Weight is captured at `support` time. A transferred name is still valid support (same
///   weight, new controller); an *expired* one becomes ineligible and anyone may `unsupport`
///   it (permissionless prune), so lazy staleness is bounded.
/// • `α^Δ` uses fixed-point exponentiation; conservative and tested (α^7d within 0.5%), but
///   not formally precision-audited — the one thing to review before mainnet.
contract WeiDAO is Receiver {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Vetoed();
    error Rejected();
    error NotHolder();
    error NoProposal();
    error NotEligible();
    error Unauthorized();
    error NoPrimaryName();
    error NotSupporting();
    error AlreadyExecuted();
    error ExecutionFailed();
    error InsufficientFee();
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
        string description,
        string proposerName
    );
    event Supported(
        uint256 indexed id, uint256 indexed tokenId, address indexed supporter, uint256 weight
    );
    event Unsupported(
        uint256 indexed id, uint256 indexed tokenId, address indexed supporter, uint256 weight
    );
    event ProposalExecuted(uint256 indexed id, bytes result);
    event ProposalVetoed(uint256 indexed id);
    event ProposalNamed(uint256 indexed id, uint256 indexed subTokenId);
    event ThresholdSet(uint256 threshold);
    event ProposalFeeSet(uint256 fee);
    event AlphaSet(uint256 alpha);

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Fixed-point scale for `alpha`, conviction, and weights.
    uint256 internal constant SCALE = 1e18;

    /// @dev One registration/renewal period in NameNFT (weight is measured in these units).
    uint256 internal constant REGISTRATION_PERIOD = 365 days;

    /// @notice dao.wei — the DAO's parent name; proposals are named under it and roles are its
    ///         subdomains. `= namehash("dao.wei")`.
    uint256 public constant PROPOSAL_PARENT =
        0x2a39629d0ee4dc68cfd48b5eefdd0362b034be5a595fec5dc802144293a8287c;

    /// @notice veto.dao.wei — its holder may veto (cancel) any not-yet-executed proposal.
    uint256 public constant VETO_ROLE =
        0xa3cbec6f0a52ab020919800d82007684e63632feadb0f555ac3cf796ec121dc1;

    /// @notice exec.dao.wei — god-mode operator: veto, force-execute (bypass conviction), admin.
    uint256 public constant EXEC_ROLE =
        0x990f75bf23721b810a24035c3d53688b7d5078ff2aa31c18219ee65ab75e5144;

    /// @notice WNS NameNFT.
    INameNFT public immutable nft;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Proposal {
        uint64 lastUpdate; // ┐ packed: last conviction sync,
        bool executed; //     │ execution flag,
        bool vetoed; //       │ veto flag,
        address target; //  ┘ call target (e.g. NameNFT).
        uint256 conviction; // Accrued conviction as of `lastUpdate` (scaled).
        uint256 supportWeight; // Total weight currently backing the proposal.
        uint256 value; // ETH to forward from the treasury.
        bytes data; // Calldata (e.g. abi.encodeWithSelector(NameNFT.withdraw.selector)).
    }

    /// @notice Per-second conviction decay α (0 < alpha < 1e18). Gov/exec-adjustable (`setAlpha`).
    /// @dev 7-day half-life = 999998853923940000 (= round(2^(-1/604800)·1e18)).
    uint256 public alpha;

    /// @notice Conviction a proposal must reach to pass. Gov/exec-adjustable (`setThreshold`) to
    ///         track participation as the DAO grows. `threshold = convictionMax(W_req)/2` ⇒ a
    ///         proposal holding sustained weight `W_req` passes after one half-life.
    uint256 public threshold;

    /// @notice ETH required to open a proposal (anti-spam, paid to treasury). Gov/exec-adjustable.
    uint256 public proposalFee;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(uint256 => uint256)) public supportOf; // id => tokenId => weight backing (0 = none)

    constructor(address nameNFT, uint256 alpha_, uint256 threshold_, uint256 proposalFee_) payable {
        require(alpha_ != 0 && alpha_ < SCALE && threshold_ != 0);
        nft = INameNFT(nameNFT);
        alpha = alpha_;
        threshold = threshold_;
        proposalFee = proposalFee_;
    }

    /*//////////////////////////////////////////////////////////////
                                  ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Current holder of `veto.dao.wei` (may veto proposals), or `address(0)` if unminted.
    function vetoer() public view returns (address) {
        return _holder(VETO_ROLE);
    }

    /// @notice Current holder of `exec.dao.wei` (god-mode operator), or `address(0)` if unminted.
    function executor() public view returns (address) {
        return _holder(EXEC_ROLE);
    }

    /// @dev Owner of an *active* name, or `address(0)` if unminted, expired, or (for a subdomain)
    ///      stale. Roles are direct subdomains of dao.wei, so they lapse when dao.wei expires or
    ///      is re-registered — a natural dead-man's-switch. Handles top-level and depth-1 names.
    function _holder(uint256 id) internal view returns (address) {
        (string memory label, uint256 parent, uint64 exp,, uint64 parentEpoch) = nft.records(id);
        if (bytes(label).length == 0) return address(0); // never minted
        if (parent == 0) {
            if (block.timestamp > exp) return address(0); // top-level expired
        } else {
            (,, uint64 pExp, uint64 pEpoch,) = nft.records(parent);
            if (parentEpoch != pEpoch || block.timestamp > pExp) return address(0); // stale/parent gone
        }
        return nft.ownerOf(id);
    }

    /// @dev Governance (a passed proposal calling in) or the executor.
    function _authed() internal view returns (bool) {
        return msg.sender == address(this) || msg.sender == executor();
    }

    /*//////////////////////////////////////////////////////////////
                              GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a proposal to run `target.call{value}(data)` once conviction passes.
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
        if (bytes(proposerName).length == 0) revert NoPrimaryName();

        unchecked {
            id = ++proposalCount;
        }
        Proposal storage p = proposals[id];
        p.lastUpdate = uint64(block.timestamp);
        p.target = target;
        p.value = value;
        p.data = data;

        emit ProposalCreated(id, msg.sender, target, value, data, description, proposerName);

        // While the DAO holds dao.wei, mint `<id>.dao.wei` to itself and record the proposal on it.
        if (_holder(PROPOSAL_PARENT) == address(this)) {
            uint256 subId =
                nft.registerSubdomainFor(LibString.toString(id), PROPOSAL_PARENT, address(this));
            nft.setText(subId, "description", description);
            emit ProposalNamed(id, subId);
        }
    }

    /*//////////////////////////////////////////////////////////////
                           ADMIN (GOV OR EXEC)
    //////////////////////////////////////////////////////////////*/

    /// @notice Set the passing threshold. Callable by governance (passed proposal) or the executor.
    function setThreshold(uint256 threshold_) external {
        if (!_authed()) revert Unauthorized();
        require(threshold_ != 0);
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    /// @notice Set the proposal fee. Callable by governance or the executor.
    function setProposalFee(uint256 fee) external {
        if (!_authed()) revert Unauthorized();
        proposalFee = fee;
        emit ProposalFeeSet(fee);
    }

    /// @notice Set the conviction decay. Callable by governance or the executor.
    function setAlpha(uint256 alpha_) external {
        if (!_authed()) revert Unauthorized();
        require(alpha_ != 0 && alpha_ < SCALE);
        alpha = alpha_;
        emit AlphaSet(alpha_);
    }

    /// @notice Back a proposal with a name you own; its weight begins accruing conviction.
    function support(uint256 id, uint256 tokenId) external {
        if (id == 0 || id > proposalCount) revert NoProposal();
        Proposal storage p = proposals[id];
        if (p.executed || p.vetoed) revert Rejected();
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
    /// @dev The owner may withdraw anytime. Anyone may *prune* support from a name that is no
    ///      longer eligible (`weightOf == 0`, e.g. expired) — bounding lazy-capture staleness.
    ///      Short-circuit ordering means an ineligible name never triggers the `ownerOf` call.
    function unsupport(uint256 id, uint256 tokenId) external {
        uint256 w = supportOf[id][tokenId];
        if (w == 0) revert NotSupporting();
        if (weightOf(tokenId) != 0 && nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        Proposal storage p = proposals[id];
        _sync(p);
        p.supportWeight -= w;
        supportOf[id][tokenId] = 0;

        emit Unsupported(id, tokenId, msg.sender, w);
    }

    /// @notice Veto a not-yet-executed proposal. Callable by the `veto.dao.wei` holder or exec.
    function veto(uint256 id) external {
        if (msg.sender != vetoer() && msg.sender != executor()) revert Unauthorized();
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        p.vetoed = true;
        emit ProposalVetoed(id);
    }

    /// @notice Execute a proposal once its conviction reaches `threshold`. The executor may
    ///         force-execute at any conviction (god-mode override).
    function execute(uint256 id) external returns (bytes memory result) {
        Proposal storage p = proposals[id];
        if (p.vetoed) revert Vetoed();
        if (p.executed) revert AlreadyExecuted();

        _sync(p);
        if (p.conviction < threshold && msg.sender != executor()) revert Rejected();

        p.executed = true; // Effects before interaction (reentrancy-safe).

        bool ok;
        (ok, result) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecutionFailed();

        emit ProposalExecuted(id, result);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's weight: its ETH contribution to WNS — fee-per-length × registration
    ///         runway. `getFee(byteLength) · (expiresAt − now) / REGISTRATION_PERIOD`.
    /// @dev Only active top-level names count (subdomains cost no ETH → 0 weight, so they can't
    ///      be spam-minted for power). Weight scales with how far a name is paid ahead, so
    ///      renewing *boosts* voting power and a near-expiry name is nudged to renew. Both the
    ///      fee tier (short = pricier) and the paid duration are things that cost ETH in WNS.
    function weightOf(uint256 tokenId) public view returns (uint256) {
        (string memory label, uint256 parent, uint64 exp,,) = nft.records(tokenId);
        if (parent != 0 || bytes(label).length == 0 || block.timestamp >= exp) return 0;
        return nft.getFee(bytes(label).length) * (exp - block.timestamp) / REGISTRATION_PERIOD;
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
    function reverseResolve(address addr) external view returns (string memory);
    function registerSubdomainFor(string calldata label, uint256 parentId, address to)
        external
        returns (uint256);
    function setText(uint256 tokenId, string calldata key, string calldata value) external;
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
