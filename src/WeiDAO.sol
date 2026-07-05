// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Multicallable} from "solady/utils/Multicallable.sol";
import {Receiver} from "solady/accounts/Receiver.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// @title WeiDAO
/// @notice Conviction-voting DAO + treasury for the Wei Name Service.
/// @dev In homage to Wei Dai. A treasury (holds ETH + NFTs via {Receiver}) that WNS holders
///      steer by *conviction voting*: no voting deadline; the accrual ramp is intrinsically
///      flash-mint-resistant, backstopped by a short `executionDelay` timelock. See caveats below.
///
/// ── Conviction voting ──────────────────────────────────────────────────────────────────
/// You `support` a proposal with a name. While a name backs a proposal, the proposal's
/// *conviction* accrues over time toward an asymptote and decays when support is withdrawn:
///
///     conviction' = conviction · α^Δ  +  supportWeight · (1 − α^Δ) / (1 − α)
///
/// where Δ is seconds elapsed and α ∈ (0,1) is the per-second decay. A proposal executes once
/// conviction ≥ `threshold`. Because conviction starts at 0 and needs *sustained* support to
/// build, freshly-minted weight has ~no immediate effect, so a flash-mint cannot execute.
/// Steady-state conviction from constant weight w is `w · SCALE / (SCALE − α)` (see
/// `convictionMax`); `threshold` is set relative to it — e.g. `convictionMax(W_req)/2` makes a
/// proposal holding sustained weight `W_req` pass after one half-life.
///
/// ── Weight = current cost-to-hold in WNS ───────────────────────────────────────────────
/// A name's weight is `getFee(byteLength) · (expiresAt − now) / 365d`: the length fee tier ×
/// how far it is paid ahead — the ETH it would currently cost to hold that name for its
/// remaining runway. So both scarcity (short = pricier) and renewal runway earn power, renewing
/// boosts weight, and subdomains (which cost no ETH) get 0, so they can't be spam-minted for
/// votes. Active top-level names only. Note weight tracks the *current* fee schedule — which
/// NameNFT's owner (the DAO itself, post-handover) can change — not the historical ETH paid.
///
/// ── Roles are WNS subdomains of dao.wei ────────────────────────────────────────────────
/// Two roles are resolved live from names under the DAO's parent (`dao.wei`) — minted to a launch
/// `roleHolder` in the constructor (on the dao.wei pull) — so holding the name *is* holding the role,
/// and handing it off is just a transfer:
/// • `veto.dao.wei` — its holder may `veto` any not-yet-executed proposal (negative power
///   only; conviction's ramp plus the `executionDelay` floor is the warning window). Nothing
///   minted = no veto.
/// • `exec.dao.wei` — a god-mode operator: may `veto`, `rescue` (run any call directly, no
///   proposal and no vote), and call the DAO's admin setters directly. Intended as a launch
///   multisig that can rescue WNS (e.g. `rescue(nft, 0, transferOwnership(safe))`) if a bug
///   appears, then be relinquished by transferring/burning the name to progressively decentralise.
///
/// ── Knobs ──────────────────────────────────────────────────────────────────────────────
/// `nft` and the role/parent namehashes are fixed. `alpha`, `threshold`, `proposalFee`, and
/// `executionDelay` are adjustable by governance (a passed proposal calling in) or the executor.
/// Two WNS behaviours are always on: a proposer is identified by their WNS primary name (which
/// must be an active top-level name they own); and while the DAO holds dao.wei, every proposal
/// best-effort mints `<id>.dao.wei` to the DAO and writes its description into that name's
/// resolver, making governance a browsable WNS namespace (naming failure never blocks propose).
///
/// ── On-chain dapp (ERC-8244) ───────────────────────────────────────────────────────────
/// `html()` returns the DAO's frontend as a self-contained HTML page rendered live from chain
/// state (treasury, knobs, roles, recent proposals + their conviction/descriptions) — no server.
/// The page is a governable shell (`setHtml`) with a `{{state}}` slot. And because the DAO owns
/// dao.wei, the name already resolves to this contract, so an ERC-8244 gateway visiting `dao.wei`
/// renders `html()` directly. No server, no snapshot to maintain — the page is always live.
///
/// ── Caveats ────────────────────────────────────────────────────────────────────────────
/// • Conviction voting is support-only; opposition is expressed by withholding/withdrawing
///   support (and, ultimately, the veto). There is no "against".
/// • Weight is captured at `support` time along with the name's epoch and expiry. Support survives a
///   transfer (the new owner can `unsupport`), but a stale position — one whose supported runway has
///   elapsed (even if the name was later renewed) or whose name was re-registered — is
///   *permissionlessly* prunable, so a renewed name must re-support to keep backing. An un-pruned
///   expired supporter keeps driving conviction upward on its stale snapshot until pruned, so pruning
///   is a keeper duty, backstopped by `veto` + the `executionDelay` floor.
/// • No cross-proposal weight budget: a name backs every proposal it supports at full weight
///   (weight = sunk ETH already provides sybil resistance), so `threshold` must be set for the
///   lone-whale case — one holder can push many parallel proposals at once.
/// • `α^Δ` uses fixed-point exponentiation; differential-tested against an independent exp/ln
///   implementation to ~1 ppm (see test/WeiDAOPrecision.t.sol), but still worth a formal review.
/// • The `exec.dao.wei` holder is fully trusted until the role is relinquished: it can drain
///   the treasury or seize WNS at will. That is the intended launch-multisig design.
contract WeiDAO is Receiver, Multicallable {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Vetoed();
    error TooSoon();
    error Rejected();
    error NotHolder();
    error NoProposal();
    error NotEligible();
    error DelayTooLong();
    error Unauthorized();
    error NoPrimaryName();
    error NotSupporting();
    error WeightTooLarge();
    error AlreadyExecuted();
    error ExecutionFailed();
    error InsufficientFee();
    error AlreadySupported();
    error DescriptionTooLong();

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
    event Rescued(address indexed target, uint256 value, bytes data);
    event ProposalNamed(uint256 indexed id, uint256 indexed subTokenId);
    event ThresholdSet(uint256 threshold);
    event ProposalFeeSet(uint256 fee);
    event AlphaSet(uint256 alpha);
    event ExecutionDelaySet(uint256 delay);
    event HtmlSet();

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Fixed-point scale for `alpha`, conviction, and weights.
    uint256 internal constant SCALE = 1e18;

    /// @dev One registration/renewal period in NameNFT (weight is measured in these units).
    uint256 internal constant REGISTRATION_PERIOD = 365 days;

    /// @dev Upper bound on `executionDelay` — a guardrail so the (trusted) setter can't brick
    ///      execution by setting an unreachable delay.
    uint256 internal constant MAX_EXECUTION_DELAY = 30 days;

    /// @notice Max bytes of a proposal description. A summary field written into the `<id>.dao.wei`
    ///         resolver and rendered on the on-chain page — capped so it stays lean to store and load
    ///         (full rationale belongs off-chain). Calldata is uncapped but truncated at render time.
    uint256 public constant MAX_DESCRIPTION_BYTES = 2048;

    /// @notice dao.wei — the DAO's parent name; proposals are named under it and roles are its
    ///         subdomains. `= namehash("dao.wei")`.
    uint256 public constant PROPOSAL_PARENT =
        0x2a39629d0ee4dc68cfd48b5eefdd0362b034be5a595fec5dc802144293a8287c;

    /// @notice veto.dao.wei — its holder may veto (cancel) any not-yet-executed proposal.
    uint256 public constant VETO_ROLE =
        0xa3cbec6f0a52ab020919800d82007684e63632feadb0f555ac3cf796ec121dc1;

    /// @notice exec.dao.wei — god-mode operator: veto, `rescue` (direct call), and admin setters.
    uint256 public constant EXEC_ROLE =
        0x990f75bf23721b810a24035c3d53688b7d5078ff2aa31c18219ee65ab75e5144;

    /// @notice WNS NameNFT.
    INameNFT public immutable nft;

    /// @dev SSTORE2 pointers to the built-in dapp shell and wallet-bridge JS. These large static
    ///      blobs live in their own data contracts (written at deploy) so they stay out of WeiDAO's
    ///      runtime bytecode and keep it under the EIP-170 limit; `html()` reads them back on demand.
    address private immutable _shellData;
    address private immutable _jsData;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct Proposal {
        uint64 lastUpdate; // ┐ packed: last conviction sync,
        uint64 created; //    │ creation time (timelock anchor),
        bool executed; //     │ execution flag,
        bool vetoed; //       ┘ veto flag.
        address target; //    Call target, e.g. NameNFT (own slot).
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

    /// @notice Minimum seconds from a proposal's creation before it may execute, regardless of how
    ///         fast conviction crosses `threshold`. Gov/exec-adjustable (`setExecutionDelay`).
    /// @dev A floor on the veto window that no amount of support weight can compress. Conviction's
    ///      ramp is only a *warning window* for supporters near `W_req`; a whale whose weight far
    ///      exceeds `W_req` crosses `threshold` in minutes, so without this floor the veto could not
    ///      react. Effective earliest execution is `max(created + executionDelay, time-to-threshold)`.
    uint256 public executionDelay;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    /// @dev A name's support position for a proposal, packed into one slot (128+64+64). Snapshotting
    ///      the name's epoch *and* expiry at support time lets {unsupport} tell the supported
    ///      instance-and-term from a later re-registration (epoch bump) or renewal (expiry moved) — so
    ///      once the supported runway elapses or the name is re-registered, anyone may prune the stale
    ///      position. `weight == 0` ⇒ not supporting. Read weight via {supportOf}.
    struct Support {
        uint128 weight; // weight backing at support time (guarded ≤ uint128 in {support})
        uint64 epoch; // name epoch at support time — re-registration detector
        uint64 expiresAt; // name expiry at support time — runway-term bound
    }

    mapping(uint256 => mapping(uint256 => Support)) private _support;

    /// @notice Governable HTML shell for the on-chain dapp (ERC-8244). `html()` replaces the token
    ///         `{{state}}` in it with live DAO state; an empty shell falls back to a built-in one.
    /// @dev Set by governance or exec (`setHtml`) — the DAO can rebrand/restyle its own frontend, or
    ///      drop the placeholder entirely to serve a fully static page.
    string public htmlShell;

    constructor(
        address nameNFT,
        uint256 alpha_,
        uint256 threshold_,
        uint256 proposalFee_,
        uint256 executionDelay_,
        address roleHolder
    ) payable {
        require(alpha_ != 0 && alpha_ < SCALE && threshold_ != 0);
        require(executionDelay_ <= MAX_EXECUTION_DELAY);
        nft = INameNFT(nameNFT);
        alpha = alpha_;
        threshold = threshold_;
        proposalFee = proposalFee_;
        executionDelay = executionDelay_;
        // Park the static dapp blobs in their own data contracts (keeps runtime under EIP-170).
        _shellData = SSTORE2.write(bytes(_DEFAULT_SHELL));
        _jsData = SSTORE2.write(bytes(_JS));
        // Emit genesis config so indexers see the starting knobs (all are gov/exec-adjustable later).
        emit AlphaSet(alpha_);
        emit ThresholdSet(threshold_);
        emit ProposalFeeSet(proposalFee_);
        emit ExecutionDelaySet(executionDelay_);

        // If the deployer pre-approved this (deterministic, e.g. CREATE2/3) address for dao.wei, pull
        // it in on construction — then, owning the parent, set the DAO's primary name (so it
        // reverse-resolves to dao.wei) and mint the veto/exec roles to `roleHolder`, all atomically.
        // The pull is best-effort (no approval / no active name ⇒ deployment still succeeds and the
        // name is handed over later); setPrimaryName is cosmetic and stays swallowed. But the role
        // mints are deliberately NOT swallowed: a fresh dao.wei has no subdomains, so once the pull
        // succeeds they must succeed — a failure reverts the whole deploy rather than launching a
        // treasury with no veto/exec backstop. (The code check keeps this inert when `nameNFT` isn't a
        // live contract, e.g. a unit harness; `roleHolder == 0` skips minting for the same case.)
        if (nameNFT.code.length != 0) {
            address owner_ = _holder(PROPOSAL_PARENT);
            if (owner_ != address(0)) {
                try nft.transferFrom(owner_, address(this), PROPOSAL_PARENT) {
                    try nft.setPrimaryName(PROPOSAL_PARENT) {} catch {}
                    if (roleHolder != address(0)) {
                        nft.registerSubdomainFor("veto", PROPOSAL_PARENT, roleHolder);
                        nft.registerSubdomainFor("exec", PROPOSAL_PARENT, roleHolder);
                    }
                } catch {}
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Current holder of `veto.dao.wei` (may veto proposals), or `address(0)` if unminted or
    ///         while the DAO does not own `dao.wei` (see {_roleHolder}).
    function vetoer() public view returns (address) {
        return _roleHolder(VETO_ROLE);
    }

    /// @notice Current holder of `exec.dao.wei` (god-mode operator), or `address(0)` if unminted or
    ///         while the DAO does not own `dao.wei` (see {_roleHolder}).
    function executor() public view returns (address) {
        return _roleHolder(EXEC_ROLE);
    }

    /// @dev Resolve a role subdomain, but only while the DAO itself owns the active parent `dao.wei`.
    ///      A role is trustworthy only when the DAO controls who may mint/overwrite it: whoever owns
    ///      `dao.wei` can `registerSubdomainFor` its subdomains, so if the DAO does *not* own dao.wei
    ///      — a failed constructor handover, or a later lapse + re-registration — an outsider could
    ///      mint `exec.dao.wei`/`veto.dao.wei` and seize god-mode. Gating on DAO ownership voids roles
    ///      in exactly those states, closing the dead-man's-switch against re-minting by a new parent
    ///      owner. When the DAO owns dao.wei, only the DAO (governance/exec) can (re)assign a role.
    function _roleHolder(uint256 roleId) internal view returns (address) {
        if (_holder(PROPOSAL_PARENT) != address(this)) return address(0);
        return _holder(roleId);
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
    /// @dev Payable: `msg.value` must cover `proposalFee` and stays in the treasury. The proposer
    ///      is identified by their WNS primary name (looked up from `msg.sender`), which must be
    ///      an active top-level name they own — one lookup for identity, stake, and event label.
    function propose(
        address target,
        uint256 value,
        bytes calldata data,
        string calldata description
    ) external payable returns (uint256 id) {
        uint256 proposerTokenId = nft.primaryName(msg.sender);
        if (proposerTokenId == 0) revert NoPrimaryName();
        if (nft.ownerOf(proposerTokenId) != msg.sender) revert NotHolder();
        if (weightOf(proposerTokenId) == 0) revert NotEligible();
        if (msg.value < proposalFee) revert InsufficientFee();
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();

        string memory proposerName = nft.getFullName(proposerTokenId);

        unchecked {
            id = ++proposalCount;
        }
        Proposal storage p = proposals[id];
        p.lastUpdate = uint64(block.timestamp);
        p.created = uint64(block.timestamp);
        p.target = target;
        p.value = value;
        p.data = data;

        emit ProposalCreated(id, msg.sender, target, value, data, description, proposerName);

        // While the DAO holds dao.wei, best-effort name the proposal `<id>.dao.wei` — a self-
        // describing WNS namespace for governance. The whole routine (mint *and* the resolver writes)
        // runs in a wrapped self-call whose failure is swallowed, so nothing in naming — not even a
        // record write reverting after a successful mint — can ever brick proposal creation.
        if (_holder(PROPOSAL_PARENT) == address(this)) {
            try this.nameProposal(id, target, value, description) {} catch {}
        }
    }

    /// @notice Best-effort naming routine for {propose}: mints `<id>.dao.wei` to the DAO and writes the
    ///         proposal's description/target/value into the name's resolver, pointing the name at the
    ///         proposal's target.
    /// @dev External only so {propose} can wrap it in try/catch — any failure (mint or write) reverts
    ///      the whole routine atomically and is swallowed, never blocking proposal creation. Callable
    ///      only by the DAO itself; a governance/self call is the sole entry.
    function nameProposal(uint256 id, address target, uint256 value, string calldata description)
        external
    {
        if (msg.sender != address(this)) revert Unauthorized();
        if (id == 0 || id > proposalCount) revert NoProposal();
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();
        uint256 sub =
            nft.registerSubdomainFor(LibString.toString(id), PROPOSAL_PARENT, address(this));
        nft.setText(sub, "description", description);
        nft.setText(sub, "target", LibString.toHexStringChecksummed(target));
        nft.setText(sub, "value", LibString.toString(value));
        nft.setAddr(sub, target); // `<id>.dao.wei` resolves to what the proposal calls
        emit ProposalNamed(id, sub);
    }

    /// @notice Back a proposal with a name you own; its weight begins accruing conviction.
    function support(uint256 id, uint256 tokenId) external {
        if (id == 0 || id > proposalCount) revert NoProposal();
        Proposal storage p = proposals[id];
        if (p.executed || p.vetoed) revert Rejected();
        if (_support[id][tokenId].weight != 0) revert AlreadySupported();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        uint256 w = weightOf(tokenId);
        if (w == 0) revert NotEligible();
        if (w > type(uint128).max) revert WeightTooLarge(); // packing guard; unreachable at sane fees

        _sync(p);
        p.supportWeight += w;
        // Snapshot weight + the name's epoch and expiry, so {unsupport} can tell the supported
        // instance-and-term from a later re-registration (epoch bump) or renewal (expiry moved).
        (,, uint64 exp, uint64 epoch,) = nft.records(tokenId);
        _support[id][tokenId] = Support(uint128(w), epoch, exp);

        emit Supported(id, tokenId, msg.sender, w);
    }

    /// @notice Withdraw a name's support; conviction stops growing from it and decays.
    /// @dev The current owner may withdraw anytime. Anyone may *prune* a stale position — one whose
    ///      supported runway has elapsed (`block.timestamp ≥` the support-time expiry, even if the
    ///      name was since renewed) or whose name was re-registered (epoch changed). So stale support
    ///      is bounded across renewal *and* re-registration, not just plain expiry; a renewed name
    ///      must re-support to refresh its runway.
    function unsupport(uint256 id, uint256 tokenId) external {
        Support memory s = _support[id][tokenId];
        uint256 w = s.weight;
        if (w == 0) revert NotSupporting();
        (,,, uint64 epoch,) = nft.records(tokenId);
        bool stale = block.timestamp >= s.expiresAt || epoch != s.epoch;
        if (!stale && nft.ownerOf(tokenId) != msg.sender) revert NotHolder();

        Proposal storage p = proposals[id];
        _sync(p);
        p.supportWeight -= w;
        delete _support[id][tokenId];

        emit Unsupported(id, tokenId, msg.sender, w);
    }

    /// @notice Veto a not-yet-executed proposal. Callable by the `veto.dao.wei` holder or exec.
    function veto(uint256 id) external {
        if (msg.sender != vetoer() && msg.sender != executor()) revert Unauthorized();
        if (id == 0 || id > proposalCount) revert NoProposal();
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        p.vetoed = true;
        emit ProposalVetoed(id);
    }

    /// @notice Execute a proposal once its conviction reaches `threshold` and the execution delay
    ///         has elapsed (anyone; democratic).
    function execute(uint256 id) external returns (bytes memory result) {
        if (id == 0 || id > proposalCount) revert NoProposal();
        Proposal storage p = proposals[id];
        if (p.vetoed) revert Vetoed();
        if (p.executed) revert AlreadyExecuted();
        // Timelock floor: guarantees a minimum veto window that support weight cannot compress.
        if (block.timestamp < p.created + executionDelay) revert TooSoon();

        _sync(p);
        if (p.conviction < threshold) revert Rejected();

        p.executed = true; // Effects before interaction (reentrancy-safe).

        bool ok;
        (ok, result) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecutionFailed();

        emit ProposalExecuted(id, result);
    }

    /// @notice Executor god-mode: run an arbitrary call directly, no proposal and no vote — for
    ///         the `exec.dao.wei` holder only (e.g. rescue WNS via `transferOwnership(safe)`).
    /// @dev The single positive override. Fully trusted until the exec role is relinquished.
    function rescue(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory result)
    {
        if (msg.sender != executor()) revert Unauthorized();
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert ExecutionFailed();
        emit Rescued(target, value, data);
    }

    /*//////////////////////////////////////////////////////////////
                           ADMIN (GOV OR EXEC)
    //////////////////////////////////////////////////////////////*/

    /// @notice Set the passing threshold. Callable by governance (a passed proposal) or the executor.
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
    /// @dev Applied live and retroactively over each proposal's un-synced interval — the next accrual
    ///      uses the new alpha for the whole gap since that proposal was last touched — so prefer
    ///      changing it when few proposals are mid-flight. Only governance/exec can call it.
    function setAlpha(uint256 alpha_) external {
        if (!_authed()) revert Unauthorized();
        require(alpha_ != 0 && alpha_ < SCALE);
        alpha = alpha_;
        emit AlphaSet(alpha_);
    }

    /// @notice Set the minimum execution delay (veto-window floor). Callable by governance or exec.
    /// @dev Capped at `MAX_EXECUTION_DELAY` so it can't be set unreachably high. Read live at
    ///      execution (like `threshold`/`alpha`), so it applies to every not-yet-executed proposal —
    ///      raising it extends in-flight windows, lowering it shortens them. Exec gains no new power
    ///      by lowering it to 0 (exec can already `rescue` arbitrarily).
    function setExecutionDelay(uint256 delay) external {
        if (!_authed()) revert Unauthorized();
        if (delay > MAX_EXECUTION_DELAY) revert DelayTooLong();
        executionDelay = delay;
        emit ExecutionDelaySet(delay);
    }

    /// @notice Set the on-chain dapp's HTML shell (`{{state}}` is replaced with live state by
    ///         `html()`). Callable by governance or the executor. Pass "" to restore the default.
    function setHtml(string calldata shell) external {
        if (!_authed()) revert Unauthorized();
        htmlShell = shell;
        emit HtmlSet();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's weight: its current cost-to-hold in WNS — fee-per-length × remaining
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

    /// @notice Weight from name `tokenId` currently backing proposal `id` (0 = not supporting).
    /// @dev Storage also snapshots the name's epoch/expiry alongside; this returns just the weight.
    function supportOf(uint256 id, uint256 tokenId) public view returns (uint256) {
        return _support[id][tokenId].weight;
    }

    /*//////////////////////////////////////////////////////////////
                        ERC-8244: ON-CHAIN DAPP
    //////////////////////////////////////////////////////////////*/

    /// @notice The WeiDAO dapp as a self-contained HTML page, rendered live from on-chain state:
    ///         treasury, knobs, roles, and the most recent proposals with their conviction, status,
    ///         and descriptions (read from each `<id>.dao.wei` name). No off-chain data or hosting.
    /// @dev The page is the governable `htmlShell` with the `{{state}}` token replaced by rendered
    ///      state; an unset shell falls back to `_DEFAULT_SHELL`. See {setHtml}.
    ///
    ///      Resolves via `dao.wei` with no wiring: the DAO owns `dao.wei`, so `NameNFT.resolve`
    ///      returns this contract by owner-fallback and an ERC-8244 gateway calls `html()` live.
    function html() public view returns (string memory) {
        return _page(proposalCount);
    }

    /// @dev Render the full page for a window of proposals topped at `startId` (newest-first). The
    ///      list is capped at `_HTML_ROWS` per page and paged via `?from=` (see {request}), so the
    ///      returned string stays bounded no matter how many proposals exist.
    function _page(uint256 startId) internal view returns (string memory) {
        string memory shell = htmlShell;
        if (bytes(shell).length == 0) shell = string(SSTORE2.read(_shellData));
        // A custom shell may drop the {{state}} slot to serve a fully static page — skip the (costly)
        // live-state render entirely in that case rather than computing it only to discard it.
        if (!LibString.contains(shell, "{{state}}")) return shell;
        return LibString.replace(shell, "{{state}}", _renderState(startId));
    }

    /// @dev ERC-5219 header/param key-value pair.
    struct KeyValue {
        string key;
        string value;
    }

    /// @notice ERC-4804 resolve mode: tells web3:// gateways to dispatch to the ERC-5219 `request`
    ///         handler, so entering the DAO (or `dao.wei`) address in a web3:// browser renders the
    ///         dapp. Complements {html} (ERC-8244); together they cover the common on-chain-HTML readers.
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @notice ERC-5219 request handler: serves the same live page as {html}, honouring a `?from=<id>`
    ///         query param to page back through older proposals (25 per page).
    /// @dev The page is rendered from live DAO state *and* a governable shell (`setHtml`), so it can
    ///      change at any block. It is therefore `no-store` (never `immutable`) — a gateway must
    ///      always refetch so it shows the latest dapp and latest state.
    function request(string[] calldata, KeyValue[] calldata params)
        external
        view
        returns (uint16 statusCode, string memory body, KeyValue[] memory headers)
    {
        uint256 startId = proposalCount;
        for (uint256 i; i < params.length; ++i) {
            if (keccak256(bytes(params[i].key)) == keccak256("from")) {
                uint256 f = _toUint(params[i].value);
                if (f != 0) startId = f;
            }
        }
        statusCode = 200;
        body = _page(startId);
        headers = new KeyValue[](2);
        headers[0] = KeyValue("Content-Type", "text/html; charset=utf-8");
        headers[1] = KeyValue("Cache-Control", "no-store");
    }

    /// @dev Built-in page shell used when `htmlShell` is unset. Theme-aware and mobile-first.
    string internal constant _DEFAULT_SHELL = "<!doctype html><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'><title>WeiDAO</title>"
        "<link rel=icon type=image/svg+xml href='data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20fill%3D%22%230A0A0A%22%2F%3E%3Cdefs%3E%3Cpath%20id%3D%22pt%22%20d%3D%22M4%2C4%20H60%22%20fill%3D%22none%22%2F%3E%3Cpath%20id%3D%22pr%22%20d%3D%22M60%2C4%20V60%22%20fill%3D%22none%22%2F%3E%3Cpath%20id%3D%22pb%22%20d%3D%22M60%2C60%20H4%22%20fill%3D%22none%22%2F%3E%3Cpath%20id%3D%22pl%22%20d%3D%22M4%2C60%20V4%22%20fill%3D%22none%22%2F%3E%3C%2Fdefs%3E%3Ctext%20font-family%3D%22%27Courier%20New%27%2Cmonospace%22%20font-size%3D%224.2%22%20fill%3D%22%232D5FE8%22%20fill-opacity%3D%220.6%22%20letter-spacing%3D%22-0.3%22%3E%3CtextPath%20href%3D%22%23pt%22%3E%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%3C%2FtextPath%3E%3C%2Ftext%3E%3Ctext%20font-family%3D%22%27Courier%20New%27%2Cmonospace%22%20font-size%3D%224.2%22%20fill%3D%22%232D5FE8%22%20fill-opacity%3D%220.6%22%20letter-spacing%3D%22-0.3%22%3E%3CtextPath%20href%3D%22%23pr%22%3E%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%3C%2FtextPath%3E%3C%2Ftext%3E%3Ctext%20font-family%3D%22%27Courier%20New%27%2Cmonospace%22%20font-size%3D%224.2%22%20fill%3D%22%232D5FE8%22%20fill-opacity%3D%220.6%22%20letter-spacing%3D%22-0.3%22%3E%3CtextPath%20href%3D%22%23pb%22%3E%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%3C%2FtextPath%3E%3C%2Ftext%3E%3Ctext%20font-family%3D%22%27Courier%20New%27%2Cmonospace%22%20font-size%3D%224.2%22%20fill%3D%22%232D5FE8%22%20fill-opacity%3D%220.6%22%20letter-spacing%3D%22-0.3%22%3E%3CtextPath%20href%3D%22%23pl%22%3E%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%3C%2FtextPath%3E%3C%2Ftext%3E%3Cpath%20d%3D%22M16%2C16%20V48%20H22%20L32%2C32%20L42%2C48%20H48%20V16%20H42%20V38%20L32%2C22%20L22%2C38%20V16%20Z%22%20fill%3D%22%232D5FE8%22%2F%3E%3C%2Fsvg%3E'>"
        "<style>"
        ":root{--bg:#fbfbfd;--surface:#f4f4f7;--fg:#18181d;--muted:#6b6c78;--line:#e7e7ee;--accent:#4f46e5;--weak:#edecfc;--good:#15803d;--warn:#b45309;--bad:#be123c;--r:10px}"
        "@media(prefers-color-scheme:dark){:root{--bg:#0b0c10;--surface:#15171d;--fg:#e9e9ef;--muted:#8a8b98;--line:#23252d;--accent:#818cf8;--weak:#1a1b2b;--good:#4ade80;--warn:#fbbf24;--bad:#fb7185}}"
        "*{box-sizing:border-box}"
        "body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;max-width:62rem;margin:0 auto;padding:1.6rem 1.2rem 4rem;-webkit-font-smoothing:antialiased}"
        "a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}"
        "header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}"
        ".brand{display:flex;align-items:center;gap:.7rem}"
        ".mark{width:2.2rem;height:2.2rem;border-radius:8px;background:var(--accent);color:#fff;display:grid;place-items:center;flex:none}"
        ".mark svg{width:1.45rem;height:1.45rem;display:block}"
        "h1{font-size:1.35rem;font-weight:700;letter-spacing:-.01em;margin:0;line-height:1.15}"
        ".tag{font-size:.8rem;color:var(--muted);margin-top:.15rem}"
        "button{font:inherit;font-size:.85rem;font-weight:500;padding:.4rem .8rem;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:8px;cursor:pointer;transition:border-color .15s}"
        "button:hover{border-color:var(--accent)}button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}"
        ".cta{background:var(--accent);color:#fff;border-color:var(--accent)}.cta:hover{filter:brightness(1.08);border-color:var(--accent)}"
        "details.info{margin:1rem 0;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:0 .9rem}"
        "details.info>summary{cursor:pointer;padding:.7rem 0;font-size:.82rem;font-weight:600;list-style:none}"
        "details.info>summary::-webkit-details-marker{display:none}"
        "details.info p{font-size:.85rem;color:var(--muted);margin:0 0 .9rem;max-width:44rem;line-height:1.65}details.info b{color:var(--fg)}"
        ".strip{display:flex;flex-wrap:wrap;gap:1rem 2rem;padding:1rem 0;margin:1rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}"
        ".stat{display:flex;flex-direction:column;gap:.15rem}"
        ".stat .l{font-size:.62rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}"
        ".stat .v{font-size:1.05rem;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.stat .v small{font-size:.7rem;font-weight:400;color:var(--muted)}"
        "#me{font-size:.85rem;color:var(--muted);margin:.2rem 0}#me b{color:var(--fg)}"
        ".meta{display:flex;flex-wrap:wrap;gap:.3rem 1.2rem;align-items:center;color:var(--muted);font-size:.82rem;margin:.3rem 0 0}.meta b{color:var(--fg);font-weight:600}"
        "h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;margin:1.8rem 0 .7rem}"
        "form{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:1rem;display:flex;flex-wrap:wrap;gap:.8rem;align-items:start}"
        "form label{display:flex;flex-direction:column;gap:.35rem;font-size:.65rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;line-height:1.2}"
        "#wd-new>button{align-self:flex-end}"
        "input,select,textarea{font:inherit;font-size:.85rem;font-weight:400;text-transform:none;letter-spacing:0;padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);max-width:100%}"
        "input:focus,textarea:focus{outline:none;border-color:var(--accent)}"
        "textarea{resize:vertical;font:12px ui-monospace,monospace;min-height:2.4rem}"
        "pre{white-space:pre-wrap;word-break:break-word;margin:.4rem 0;font-size:12px}"
        "details.fns summary{cursor:pointer;font-size:.8rem;color:var(--muted);margin-top:.7rem}"
        ".ready{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;background:var(--weak);border:1px solid var(--accent);border-radius:var(--r);padding:.7rem .9rem;margin:1.1rem 0}"
        ".ready b{color:var(--fg);font-size:.9rem}.ready button{background:var(--bg)}"
        ".wrap{overflow-x:auto;overflow-y:hidden}"
        "table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:38rem}"
        "thead th{color:var(--muted);font-weight:600;font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);white-space:nowrap}"
        "tbody td{padding:.85rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:hover td{background:var(--surface)}"
        ".name{font-weight:600;white-space:nowrap}"
        ".pill{display:inline-flex;align-items:center;padding:.15rem .55rem;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid;line-height:1.5}"
        ".pill.build{color:var(--muted);border-color:var(--line)}.pill.exec{color:var(--accent);border-color:var(--accent);background:var(--weak)}"
        ".pill.done{color:var(--good);border-color:var(--good)}.pill.veto{color:var(--bad);border-color:var(--bad)}.pill.lock{color:var(--warn);border-color:var(--warn)}"
        ".conv{display:flex;align-items:center;gap:.5rem;min-width:7rem}"
        ".bar{flex:1;background:var(--line);height:6px;border-radius:99px;overflow:hidden;min-width:44px}.bar>i{display:block;height:100%;background:var(--accent);border-radius:99px}"
        ".conv small{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11px;min-width:2.4rem;text-align:right}"
        ".num{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted)}"
        "code{background:var(--surface);padding:.1rem .35rem;border-radius:4px;font:12px ui-monospace,monospace}"
        "a.addr{font:12px ui-monospace,monospace;color:var(--accent);text-decoration:none;white-space:nowrap;background:var(--surface);padding:.15rem .4rem;border-radius:6px}a.addr:hover{text-decoration:none}"
        ".desc{color:var(--fg);max-width:26rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}"
        ".cd{margin-top:.4rem}.cd summary{cursor:pointer;font-size:11px;color:var(--muted)}.cd code{display:inline-block;margin-top:.3rem;max-width:20rem;word-break:break-all;font-size:11px;color:var(--muted)}"
        ".act{display:flex;gap:.35rem;flex-wrap:wrap}"
        ".pager{display:flex;gap:1.2rem;align-items:center;color:var(--muted);font-size:.8rem;margin:1.1rem 0}"
        "footer{margin-top:2.5rem;padding-top:1.2rem;border-top:1px solid var(--line);color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:.4rem 1rem;align-items:center}"
        "@media(max-width:680px){body{padding:1.2rem 1rem 3rem}.strip{gap:.9rem 1.5rem}.wrap{overflow:visible}thead{display:none}table,tbody,tr,td{display:block;width:100%;min-width:0}tbody tr{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:.7rem .9rem;margin:.8rem 0}tbody tr:hover td{background:none}tbody td{border:none;padding:.3rem 0;display:flex;gap:1rem;justify-content:space-between;align-items:center}td::before{content:attr(data-l);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em;flex:0 0 auto}td.name{font-size:1.05rem;font-weight:600}td.name::before,td.act-cell::before{content:none}td.desc-cell,td.act-cell{display:block}.conv{min-width:0}.desc{display:block;max-width:none;overflow:visible;margin-top:.2rem}.act{margin-top:.6rem}.act button{flex:1}}"
        "</style>" "{{state}}";

    /// @dev Max proposals rendered by `html()` (bounds the returned string; newest first).
    uint256 internal constant _HTML_ROWS = 25;

    /// @dev Max bytes of a proposal's calldata / description rendered per row. The full value still
    ///      executes (calldata) and is stored on the name (description); the dapp shows a bounded
    ///      preview so one oversized proposal can't bloat a page past client/gateway limits.
    uint256 internal constant _RENDER_CAP = 512;

    /// @dev Render the live-state fragment for the proposal window topped at `startId`.
    function _renderState(uint256 startId) internal view returns (string memory s) {
        // ETH under governance = the DAO's own treasury + WNS fees it can withdraw (only counted
        // while the DAO owns NameNFT, i.e. those fees are actually governable).
        uint256 daoBal = address(this).balance;
        uint256 wnsBal = nft.owner() == address(this) ? address(nft).balance : 0;
        // Treasury breakdown shows as a tooltip on the "Under governance" stat (kept only when WNS holds a balance).
        string memory govTitle = wnsBal == 0
            ? ""
            : string.concat(
                " title=\"treasury ", _weiToEth(daoBal), " + WNS fees ", _weiToEth(wnsBal), "\""
            );
        s = string.concat(
            "<header><div class=brand><div class=mark><svg viewBox='12 12 40 40'>"
            "<path d='M16,16 V48 H22 L32,32 L42,48 H48 V16 H42 V38 L32,22 L22,38 V16 Z' fill=currentColor/>"
            "</svg></div><div>"
            "<h1>WeiDAO</h1><div class=tag>Conviction voting for the Wei Name Service</div></div></div>"
            "<div class=top><button onclick=\"wd.connect()\" id=cx class=cta>Connect wallet</button></div></header>"
            "<details class=info><summary>&#9432; How it works</summary><p>"
            "Back a proposal with a WNS name &mdash; its weight is the ETH you've committed to that name "
            "(length-fee tier &times; time paid ahead), so voting power tracks real contribution, not "
            "headcount. <b>Conviction</b> builds while weight is held and decays when withdrawn; a proposal "
            "passes once it crosses the <b>threshold</b> (about the <b>Pass bar</b> of weight sustained for "
            "one <b>half-life</b>), then executes after a short <b>timelock</b>. No deadlines and no "
            "&ldquo;against&rdquo; &mdash; withhold support or veto to oppose. Rendered entirely on-chain."
            "</p></details>"
            "<div id=me>Connect your wallet to vote with your WNS name and see your voting weight.</div>"
            "<div class=strip><div class=stat",
            govTitle,
            "><span class=l>Under governance</span><span class=v>",
            _weiToEth(daoBal + wnsBal),
            " <small>ETH</small></span></div>"
            "<div class=stat><span class=l>Proposals</span><span class=v>",
            LibString.toString(proposalCount),
            "</span></div>" "<div class=stat title=\"sustained backing to pass in one half-life\">"
            "<span class=l>Pass bar</span><span class=v>~",
            _weiToEth(_passWeight()),
            " <small>ETH</small></span></div>"
            "<div class=stat title=\"conviction half-life (the alpha decay)\">"
            "<span class=l>Half-life</span><span class=v>",
            _halfLifeStr(),
            "</span></div>"
            "<div class=stat title=\"minimum delay before a passed proposal can execute\">"
            "<span class=l>Timelock</span><span class=v>",
            _dur(executionDelay),
            "</span></div></div>" "<div class=meta><span><b>vetoer</b> ",
            _roleTag(vetoer()),
            "</span><span><b>exec</b> ",
            _roleTag(executor()),
            "</span><span title=\"conviction required to pass (scaled units)\"><b>threshold</b> ",
            _weiToEth(threshold),
            "</span></div>"
        );

        s = string.concat(s, _actions()); // new-proposal form + wallet bridge (self-contained dapp)

        uint256 count = proposalCount;
        if (count == 0) return string.concat(s, "<p class=meta>No proposals yet.</p>", _footer());

        // Newest-first window [stop+1 .. top], capped at _HTML_ROWS; older pages via `?from=`.
        uint256 top = (startId == 0 || startId > count) ? count : startId;
        uint256 stop = top > _HTML_ROWS ? top - _HTML_ROWS : 0;

        s = string.concat(
            s,
            _spotlight(top, stop), // pin any execute-ready proposals in this window above the list
            "<h2>Proposals</h2><div class=wrap><table><thead><tr><th>name</th><th>status</th>"
            "<th>conviction</th><th>value</th><th>target</th><th>description</th><th></th></tr>"
            "</thead><tbody>"
        );
        for (uint256 id = top; id > stop; --id) {
            s = string.concat(s, _row(id));
        }
        s = string.concat(s, "</tbody></table></div>", _pager(top, stop, count), _footer());
    }

    /// @dev A pinned banner of proposals in the rendered window that can be executed right now, each
    ///      a one-click execute button. Bounded to the page window (no unbounded scan); renders
    ///      nothing when none are ready. Latest-first browsing stays the primary order.
    function _spotlight(uint256 top, uint256 stop) internal view returns (string memory s) {
        uint256 shown; // cap the buttons so a large batch can't balloon the banner
        uint256 more;
        for (uint256 id = top; id > stop; --id) {
            Proposal storage p = proposals[id];
            if (p.vetoed || p.executed) continue;
            if (convictionOf(id) < threshold || block.timestamp < p.created + executionDelay) {
                continue;
            }
            if (shown >= 8) {
                ++more;
                continue;
            }
            string memory idStr = LibString.toString(id);
            s = string.concat(
                s,
                "<button onclick=\"wd.execute('",
                idStr,
                "')\">execute ",
                idStr,
                ".dao.wei</button>"
            );
            ++shown;
        }
        if (shown != 0) {
            string memory tail = more == 0
                ? ""
                : string.concat("<span class=num>+", LibString.toString(more), " more below</span>");
            s = string.concat(
                "<div class=ready><b>&#9889; Ready to execute</b> ", s, tail, "</div>"
            );
        }
    }

    /// @dev Page indicator + newer/older links (relative `?from=` URLs a web3:// gateway routes to
    ///      {request}). Keeps the page bounded while every proposal stays reachable.
    function _pager(uint256 top, uint256 stop, uint256 count)
        internal
        pure
        returns (string memory)
    {
        string memory nav = string.concat(
            "<div class=pager><span>Showing ",
            LibString.toString(stop + 1),
            "&ndash;",
            LibString.toString(top),
            " of ",
            LibString.toString(count),
            "</span>"
        );
        if (top < count) {
            uint256 newer = top + _HTML_ROWS > count ? count : top + _HTML_ROWS;
            nav = string.concat(
                nav, "<span><a href=?from=", LibString.toString(newer), ">&laquo; newer</a></span>"
            );
        }
        if (stop != 0) {
            nav = string.concat(
                nav, "<span><a href=?from=", LibString.toString(stop), ">older &raquo;</a></span>"
            );
        }
        return string.concat(nav, "</div>");
    }

    /// @dev Footer: the DAO contract, the WNS NameNFT (Etherscan-linked), and the WNS apps.
    function _footer() internal view returns (string memory) {
        string memory wns = LibString.toHexStringChecksummed(address(nft));
        return string.concat(
            "<footer><b>DAO</b> ",
            _addrLink(address(this)),
            " &middot; served on-chain from WeiDAO + " "<a href=https://etherscan.io/address/",
            wns,
            " target=_blank rel=noopener title=",
            wns,
            ">WNS NameNFT</a> &middot; <a href=https://wei.domains target=_blank rel=noopener>wei.domains</a>"
            " &middot; <a href=https://wns.wei.limo target=_blank rel=noopener>wns.wei.limo</a>"
            " &middot; <a href=https://opensea.io/collection/wei-name-service target=_blank rel=noopener>OpenSea</a>"
            " &middot; <a href=https://github.com/solardev-xyz/freedom-browser target=_blank rel=noopener>"
            "Supported on Freedom Browser</a></footer>"
        );
    }

    /// @dev One table row for proposal `id`: status pill, conviction bar, target (+ expandable
    ///      calldata), a clamped description, and the lifecycle buttons available in its state.
    function _row(uint256 id) internal view returns (string memory) {
        Proposal storage p = proposals[id];
        uint256 conv = convictionOf(id);
        string memory idStr = LibString.toString(id);
        uint256 pct = _pct(conv, threshold);
        return string.concat(
            "<tr><td class=name>",
            idStr,
            ".dao.wei</td><td data-l=status>",
            _statusOf(p, conv),
            "</td><td data-l=conviction><div class=conv><div class=bar><i style=width:",
            LibString.toString(pct),
            "%></i></div><small>",
            LibString.toString(pct),
            "%</small></div></td><td class=num data-l=value>",
            p.value == 0 ? "&mdash;" : string.concat(_weiToEth(p.value), " ETH"),
            "</td><td data-l=target>",
            _addrLink(p.target),
            _calldata(p.data),
            "</td><td class=desc-cell data-l=description>",
            _desc(idStr),
            "</td><td class=act-cell>",
            _rowActions(p, idStr, conv),
            "</td></tr>"
        );
    }

    /// @dev Description cell: escaped, clamped to two lines, full text in a hover `title`.
    function _desc(string memory idStr) internal view returns (string memory) {
        string memory raw = nft.text(_proposalNameId(idStr), "description");
        if (bytes(raw).length > _RENDER_CAP) {
            raw = string.concat(LibString.slice(raw, 0, _RENDER_CAP), unicode"…");
        }
        string memory d = LibString.escapeHTML(raw); // escape after truncation so entities stay intact
        return string.concat("<span class=desc title=\"", d, "\">", d, "</span>");
    }

    /// @dev Expandable raw calldata for a proposal (nothing rendered when there is none).
    function _calldata(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        string memory ellipsis = "";
        // Truncate the in-memory copy to _RENDER_CAP bytes *before* hex-encoding, so a huge proposal's
        // calldata can't force a big hex string to be built and thrown away (full data still executes).
        if (data.length > _RENDER_CAP) {
            uint256 cap = _RENDER_CAP;
            // memory-safe: only shrinks `data`'s length word in place — no OOB write, and the free
            // memory pointer is untouched (the tail bytes stay allocated, just unreferenced).
            assembly ("memory-safe") {
                mstore(data, cap)
            }
            ellipsis = unicode"…";
        }
        return string.concat(
            "<details class=cd><summary>calldata</summary><code>",
            LibString.toHexString(data),
            ellipsis,
            "</code></details>"
        );
    }

    /// @dev Lifecycle buttons for a proposal row (public actions only; veto is a role action).
    function _rowActions(Proposal storage p, string memory idStr, uint256 conv)
        internal
        view
        returns (string memory)
    {
        if (p.vetoed || p.executed) return "";
        string memory acts = string.concat(
            "<div class=act><button onclick=\"wd.sup('",
            idStr,
            "')\">support</button><button onclick=\"wd.unsup('",
            idStr,
            "')\">unsupport</button>"
        );
        if (conv >= threshold && block.timestamp >= p.created + executionDelay) {
            acts = string.concat(
                acts, "<button onclick=\"wd.execute('", idStr, "')\">execute</button>"
            );
        }
        return string.concat(acts, "</div>");
    }

    /// @dev Status pill for proposal `p` at conviction `conv`, with a timelock countdown.
    function _statusOf(Proposal storage p, uint256 conv) internal view returns (string memory) {
        if (p.vetoed) return _pill("veto", "vetoed");
        if (p.executed) return _pill("done", "executed");
        if (conv < threshold) return _pill("build", "building");
        uint256 unlock = p.created + executionDelay;
        if (block.timestamp >= unlock) return _pill("exec", "executable");
        return _pill("lock", string.concat("timelock ", _dur(unlock - block.timestamp)));
    }

    /// @dev A status pill; `cls` selects a theme-aware colour (`.pill.build/exec/done/veto/lock`).
    function _pill(string memory cls, string memory label) internal pure returns (string memory) {
        return string.concat("<span class=\"pill ", cls, "\">", label, "</span>");
    }

    /// @dev Role holder as an Etherscan-linked address, or a muted "none" when the role is unminted.
    function _roleTag(address a) internal pure returns (string memory) {
        if (a == address(0)) return "none"; // inherits the muted `.meta` colour
        return _addrLink(a);
    }

    /// @dev The interactive layer: a new-proposal form, a function reference, and a self-contained
    ///      vanilla-JS wallet bridge that drives the real calls — so the returned page *is* the
    ///      essential code to operate the DAO, no dapp host needed.
    function _actions() internal view returns (string memory) {
        return string.concat(
            "<h2>New proposal</h2><form id=wd-new>"
            "<label>target (0x or .wei)<input name=t placeholder=0x0000 size=16 required></label>"
            "<label>value (ETH)<input name=v type=number step=any min=0 placeholder=0 style=width:7rem></label>"
            "<label>calldata (hex)<textarea name=d placeholder=0x rows=2 cols=16></textarea></label>"
            "<label>description<textarea name=desc rows=2 cols=24 maxlength=2048 required></textarea></label>"
            "<button class=cta>propose &middot; pays fee</button></form>"
            "<details class=fns><summary>All functions (for wallets/tools)</summary><pre>"
            "propose(address,uint256,bytes,string) payable\nsupport(uint256 id,uint256 tokenId)\n"
            "unsupport(uint256 id,uint256 tokenId)\nexecute(uint256 id)\nveto(uint256 id)</pre></details>"
            "<script>window.WEIDAO={dao:'",
            _addr(address(this)),
            "',wns:'",
            _addr(address(nft)),
            "',fee:'",
            LibString.toString(proposalFee),
            "'};</script>",
            string(SSTORE2.read(_jsData))
        );
    }

    /// @dev Minimal, dependency-free wallet bridge. Tx selectors (all verified in tests):
    ///      propose 0x82ff16c1, support 0x9be56c67, unsupport 0x84a1faba, execute 0xfe0d94c1.
    ///      Read selectors: NameNFT.computeId(string) 0xfb021939 (name → tokenId, so users vote by
    ///      typing `alice.wei` — no client-side keccak), NameNFT.primaryName(address) 0xeba951aa,
    ///      NameNFT.getFullName(uint256) 0x465411c1, WeiDAO.weightOf(uint256) 0x0767d178.
    string internal constant _JS = "<script>(function(){var W=window.WEIDAO||{},E=window.ethereum;"
        "function p(n){n=BigInt(n).toString(16);return '0'.repeat(64-n.length)+n;}"
        "function u8(s){return Array.from(new TextEncoder().encode(s)).map(function(b)"
        "{return b.toString(16).padStart(2,'0');}).join('');}"
        "function w(h){return h+'0'.repeat((64-h.length%64)%64);}"
        "function estr(s){var h=u8(s);return p(32)+p(h.length/2)+w(h);}"
        "function wei(s){s=(s||'0').trim();var a=s.split('.'),f=(a[1]||'').slice(0,18);"
        "return BigInt(a[0]||'0')*(10n**18n)+BigInt(f+'0'.repeat(18-f.length)||'0');}"
        "function eth(v){v=BigInt(v);return v/(10n**18n)+'.'+('0000'+((v%(10n**18n))/(10n**14n))).slice(-4);}"
        "function s2(h){h=h.slice(2);var n=parseInt(h.slice(64,128),16),b=new Uint8Array(n);"
        "for(var i=0;i<n;i++)b[i]=parseInt(h.substr(128+i*2,2),16);return new TextDecoder().decode(b);}"
        "async function acct(){if(!E){alert('No Ethereum wallet found');return null;}"
        "return (await E.request({method:'eth_requestAccounts'}))[0];}"
        "async function call(to,d){return E.request({method:'eth_call',params:[{to:to,data:d},'latest']});}"
        "async function nameId(nm){if(nm.indexOf('.')<0)nm+='.wei';"
        "return BigInt(await call(W.wns,'0xfb021939'+estr(nm)));}"
        "async function toAddr(x){x=x.trim();if(/^0x[0-9a-fA-F]{40}$/.test(x))return x;"
        "var a='0x'+(await call(W.wns,'0x4f896d4f'+p(await nameId(x)))).slice(-40);"
        "if(/^0x0+$/.test(a)){alert(x+' does not resolve to an address');throw 0;}return a;}"
        "async function primaryOf(){if(W.pid!==undefined)return W.pid;var a=await acct();"
        "W.pid=a?BigInt(await call(W.wns,'0xeba951aa'+p(BigInt(a)))):0n;return W.pid;}"
        "async function tx(d,v){var a=await acct();if(!a)return;"
        "return E.request({method:'eth_sendTransaction',params:[{from:a,to:W.dao,data:d,value:v||'0x0'}]});}"
        "async function rev(a){if(!a)return '';"
        "if(W.name===undefined)W.name=s2(await call(W.wns,'0x9af8b7aa'+p(BigInt(a))));return W.name;}"
        "function mc(cds){var n=cds.length,off=n*32,h='',t='';"
        "for(var c of cds){c=c.replace(/^0x/,'');h+=p(off);var e=p(c.length/2)+w(c);t+=e;off+=e.length/2;}"
        "return '0xac9650d8'+p(32)+p(n)+h+t;}"
        "async function vote(i,sel,verb){var def=await rev(await acct());"
        "var s=prompt('WNS name(s) to '+verb+' proposal #'+i"
        "+' \\u2014 e.g. ross.wei; comma-separate to stack several:',def||'');"
        "if(s===null)return;var ids;if(s.trim()){ids=[];for(var nm of s.split(','))if(nm.trim())ids.push(await nameId(nm.trim()));}"
        "else{var pid=await primaryOf();if(!pid){alert('No WNS name set \\u2014 type a name or register at wei.domains.');return;}ids=[pid];}"
        "if(!ids.length)return;var cds=ids.map(function(t){return sel+p(i)+p(t);});"
        "return tx(cds.length>1?mc(cds):cds[0]);}"
        "var wd={connect:async function(){var a=await acct();if(!a)return;var nm=await rev(a);"
        "var b=document.getElementById('cx');if(b)b.textContent=nm||(a.slice(0,6)+'\\u2026'+a.slice(-4));"
        "var me=document.getElementById('me');if(!me)return;var pid=await primaryOf();"
        "if(pid){me.textContent='Voting as '+(nm||s2(await call(W.wns,'0x465411c1'+p(pid))))"
        "+' \\u00b7 weight '+eth(await call(W.dao,'0x0767d178'+p(pid)))+' ETH';}"
        "else{me.innerHTML='No WNS primary name set \\u2014 "
        "<a href=https://wei.domains target=_blank rel=noopener>get one at wei.domains</a> to vote in one click';}},"
        "execute:function(i){return tx('0xfe0d94c1'+p(i));},"
        "sup:function(i){return vote(i,'0x9be56c67','back');},"
        "unsup:function(i){return vote(i,'0x84a1faba','withdraw from');},"
        "propose:async function(t,e,d,desc){d=(d||'').replace(/^0x/,'');"
        "if(!/^([0-9a-fA-F]{2})*$/.test(d)){alert('Calldata must be hex with an even number of digits');return;}"
        "if((e||'').trim()&&!/^[0-9]*[.]?[0-9]*$/.test(e.trim())){alert('Value must be a decimal amount of ETH');return;}"
        "t=await toAddr(t);var val=wei(e);if(val>=(1n<<256n)){alert('Value exceeds uint256');return;}"
        "var x=u8(desc),dl=d.length/2,sl=x.length/2,dp=Math.ceil(dl/32)*32;"
        "if(sl>2048){alert('Description too long (max 2048 bytes)');return;}" // mirrors MAX_DESCRIPTION_BYTES
        "return tx('0x82ff16c1'+p(BigInt(t))+p(val)+p(128)+p(160+dp)+p(dl)+w(d)+p(sl)+w(x),"
        "'0x'+BigInt(W.fee).toString(16));}};"
        "window.wd=wd;var f=document.getElementById('wd-new');"
        "if(f)f.onsubmit=function(ev){ev.preventDefault();wd.propose(f.t.value,f.v.value,f.d.value,f.desc.value);};"

        // Wallet account/chain switches invalidate the cached identity so the UI never acts on a stale name.
        "if(E&&E.on){E.on('accountsChanged',function(){W.pid=undefined;W.name=undefined;wd.connect();});"
        "E.on('chainChanged',function(){location.reload();});}" "})();</script>";

    /// @dev Namehash of `<id>.dao.wei`; mirrors NameNFT's subdomain id derivation (numeric labels
    ///      pass normalization unchanged), so `html()` can read the description off the name.
    function _proposalNameId(string memory idStr) internal pure returns (uint256) {
        return
            uint256(keccak256(abi.encodePacked(bytes32(PROPOSAL_PARENT), keccak256(bytes(idStr)))));
    }

    /// @dev `num/den` as an integer percent, clamped to 100 (a full conviction bar = passed).
    function _pct(uint256 num, uint256 den) internal pure returns (uint256 p) {
        if (den == 0) return 0;
        p = num * 100 / den;
        if (p > 100) p = 100;
    }

    /// @dev The sustained weight that clears `threshold` in one half-life (`2·threshold·(1−α)`),
    ///      i.e. the ETH-denominated "pass bar" shown in the UI. Inverse of `convictionMax(W)/2`.
    function _passWeight() internal view returns (uint256) {
        return 2 * threshold * (SCALE - alpha) / SCALE;
    }

    /// @dev Conviction half-life in seconds — the human-readable form of `alpha` (`α^h = ½`). Found
    ///      by binary search over `_pow`; returns 0 as a "> 10y" sentinel for near-1 alphas.
    function _halfLife() internal view returns (uint256) {
        uint256 hi = 3650 days;
        if (_pow(alpha, hi) > SCALE / 2) return 0; // half-life beyond the search range
        uint256 lo = 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_pow(alpha, mid) <= SCALE / 2) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    /// @dev Half-life as a compact duration string (or "&gt;10y" when beyond the search range).
    function _halfLifeStr() internal view returns (string memory) {
        uint256 hl = _halfLife();
        return hl == 0 ? "&gt;10y" : _dur(hl);
    }

    /// @dev Checksummed 0x address string (zero address renders as all-zeroes).
    function _addr(address a) internal pure returns (string memory) {
        return LibString.toHexStringChecksummed(a);
    }

    /// @dev An Etherscan-linked, abbreviated address chip; full value in `href`/`title`.
    function _addrLink(address a) internal pure returns (string memory) {
        string memory h = LibString.toHexStringChecksummed(a);
        return string.concat(
            "<a class=addr href=https://etherscan.io/address/",
            h,
            " target=_blank rel=noopener title=",
            h,
            ">",
            string.concat(LibString.slice(h, 0, 6), unicode"…", LibString.slice(h, 38, 42)),
            "</a>"
        );
    }

    /// @dev Parse a decimal string to uint (non-digits or absurd length ⇒ 0, treated as "default
    ///      page" by callers). The length cap keeps a malformed `?from=` from overflowing rather than
    ///      falling back gracefully — no real proposal id is anywhere near 20 digits.
    function _toUint(string memory str) internal pure returns (uint256 r) {
        bytes memory b = bytes(str);
        if (b.length > 20) return 0;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 48 || c > 57) return 0;
            r = r * 10 + (c - 48);
        }
    }

    /// @dev Seconds as a compact human duration (largest whole unit).
    function _dur(uint256 s) internal pure returns (string memory) {
        if (s == 0) return "none";
        if (s >= 1 days) return string.concat(LibString.toString(s / 1 days), "d");
        if (s >= 1 hours) return string.concat(LibString.toString(s / 1 hours), "h");
        if (s >= 1 minutes) return string.concat(LibString.toString(s / 1 minutes), "m");
        return string.concat(LibString.toString(s), "s");
    }

    /// @dev Wei as a fixed 4-decimal string (display only).
    function _weiToEth(uint256 weiAmount) internal pure returns (string memory) {
        string memory frac = LibString.toString((weiAmount % 1e18) / 1e14); // 4 dp, 0..9999
        bytes memory pad = new bytes(4 - bytes(frac).length);
        for (uint256 i; i < pad.length; ++i) {
            pad[i] = "0";
        }
        return string.concat(LibString.toString(weiAmount / 1e18), ".", string(pad), frac);
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
    function owner() external view returns (address);
    function ownerOf(uint256 id) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function primaryName(address addr) external view returns (uint256);
    function getFullName(uint256 tokenId) external view returns (string memory);
    function registerSubdomainFor(string calldata label, uint256 parentId, address to)
        external
        returns (uint256);
    function setText(uint256 tokenId, string calldata key, string calldata value) external;
    function text(uint256 tokenId, string calldata key) external view returns (string memory);
    function setAddr(uint256 tokenId, address addr) external;
    function setPrimaryName(uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 id) external;
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
