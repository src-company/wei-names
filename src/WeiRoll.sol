// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibString} from "solady/utils/LibString.sol";

/// @dev NameNFT surface used here. `records` is the public getter for its NameRecord struct.
interface INameNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function records(uint256 tokenId)
        external
        view
        returns (
            string memory label,
            uint256 parent,
            uint64 expiresAt,
            uint64 epoch,
            uint64 parentEpoch
        );
    function isAvailable(string memory label, uint256 parentId) external view returns (bool);
    function registerSubdomain(string memory label, uint256 parentId) external returns (uint256);
    function setAddr(uint256 tokenId, address addr) external;
    function setPrimaryName(uint256 tokenId) external;
    function setText(uint256 tokenId, string memory key, string memory value) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @dev WeiDAO surface used here. `proposals` is the public getter for its Proposal struct.
interface IWeiDAO {
    function supportOf(uint256 id, uint256 tokenId) external view returns (uint256);
    function proposals(uint256 id)
        external
        view
        returns (
            uint64 lastUpdate,
            uint64 created,
            bool executed,
            bool vetoed,
            address target,
            uint256 conviction,
            uint256 supportWeight,
            uint256 value,
            bytes memory data
        );
}

/// @dev Lido stETH. Rebasing is a balance that grows while your *shares* stay put, so everything
///      owed here is denominated in shares: exact across rebases, and immune to the 1-2 wei
///      rounding that stETH's share-to-balance division puts on `transfer`.
interface ISTETH {
    function submit(address referral) external payable returns (uint256);
    function sharesOf(address account) external view returns (uint256);
    function transferShares(address to, uint256 shares) external returns (uint256);
    function getPooledEthByShares(uint256 shares) external view returns (uint256);
}

/// @dev Chainlink VRF v2.5 direct-funding wrapper, paid in native ETH. It quotes its own
///      gas-price-dependent price and is the only address permitted to call back.
interface IVRFV2PlusWrapper {
    function calculateRequestPriceNative(uint32 callbackGasLimit, uint32 numWords)
        external
        view
        returns (uint256);
    function requestRandomWordsInNative(
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        uint32 numWords,
        bytes calldata extraArgs
    ) external payable returns (uint256 requestId);
}

/// @title WeiRoll
/// @notice Ownerless ETH lottery for WNS name holders, drawn with Chainlink VRF.
/// @dev No owner, no admin, no withdrawal: value leaves only as a prize or the VRF fee. The long
///      form — rationale, VRF footgun review, integration notes — is in the README under "Lottery
///      (WeiRoll)". Here is only what reading the code requires.
///
/// ── A round ────────────────────────────────────────────────────────────────────────────
/// Funding opens a {ROUND_LENGTH} entry window; {draw} settles it and pays the whole pot, leaving
/// nothing to run on until the next funding. Whoever calls {draw} pays the VRF fee out of their own
/// pocket, so the pot is entirely prize money and the draw's timing is theirs to choose. A round
/// that cannot settle — under two tickets, or a wrapper that will not quote — is abandoned for a
/// fresh one rather than reverting: entries are shut by then and no owner exists to unstick it.
/// Abandoning rather than extending is also what stops a ticket outliving the name that bought it.
///
/// ── The pot is staked ──────────────────────────────────────────────────────────────────
/// ETH sent here is submitted to Lido on arrival, so a pot waiting out a round earns and everyone
/// can watch it grow. Everything owed is denominated in *shares* rather than stETH: shares are
/// what rebasing holds constant, so a prize keeps earning while it waits to be claimed, and
/// {ISTETH.transferShares} sidesteps the 1-2 wei rounding stETH puts on `transfer`. The winner is
/// paid in stETH. {draw} never touches Lido — its fee comes from the caller and goes straight to
/// Chainlink — so a paused or rate-limited staking queue can stall funding but never a settlement.
///
/// ── Odds ───────────────────────────────────────────────────────────────────────────────
/// Ticket weight is WeiDAO's `weightOf`: the ETH it would cost today to hold the name for its
/// remaining runway. Subdomains are free to mint, weigh 0, and are excluded. One-name-one-ticket
/// would instead put odds on sale at the 0.001 ETH default fee.
///
/// ── Winners hold names, not addresses ──────────────────────────────────────────────────
/// A draw records a tokenId, so {claim} pays whoever holds that name while it is still active, and
/// selling or lapsing forfeits. NameNFT's 90-day grace exceeds {CLAIM_WINDOW}, so a name lapsing
/// mid-window cannot be re-registered in time to claim off its old holder.
///
/// ── Rounds are names ───────────────────────────────────────────────────────────────────
/// While this contract holds `roll.wei`, claiming round 7 mints `7.roll.wei` here and the winner's
/// label beneath it, so history browses as `roll.wei` → `7.roll.wei` → `alice.7.roll.wei`. Naming
/// is a swallowed self-call and can never block a payout. See {nameWinner}.
///
/// ── Caveats ────────────────────────────────────────────────────────────────────────────
/// • {resetRequest} departs from Chainlink's rule against re-requesting randomness. Nothing can be
///   discarded — it fires only when nothing was delivered — and the alternative is stranding the
///   pot forever on one undelivered request. Residual: whoever controls fulfilment can force one
///   fresh draw per {REQUEST_TIMEOUT}, each burning a fee. Counted in {resetsOf} to make it visible.
/// • Odds track the *current* fee schedule, which WeiDAO governs: raising a length tier lifts the
///   odds of everyone already holding that length. WeiDAO carries the same caveat for votes.
/// • The boost costs only gas, so it confers no edge — it taxes the unengaged rather than
///   differentiating. A scarce boost would be the dangerous direction.
/// • Lido is a dependency this contract cannot be rescued from, and the prize is stETH rather than
///   ETH: it traded near 0.94 in June 2022, so a prize can lose ETH value between draw and claim.
/// • Naming needs an active `roll.wei` held here; without one only the namespace stops. Renewal is
///   left outside: `NameNFT.renew` is permissionless, and a lapsed parent freezes every badge
///   under it, so holders are motivated.
/// • Weight is snapshotted at {enter}, drifting down over at most one {ROUND_LENGTH}.
contract WeiRoll {
    error NotLive();
    error TooSoon();
    error NoConfig();
    error NotOwner();
    error NoRequest();
    error NotWinner();
    error Underpaid();
    error NotBacking();
    error NotRunning();
    error DrawPending();
    error AlreadyNamed();
    error Unauthorized();
    error AlreadyEntered();
    error WeightTooLarge();
    error ClaimWindowOpen();
    error ClaimWindowOver();

    event Entered(
        uint256 indexed round,
        uint256 indexed tokenId,
        address owner,
        uint256 weight,
        uint256 boostPid
    );
    event Drawn(uint256 indexed round, uint256 requestId);
    event RequestReset(uint256 indexed round, uint256 requestId, uint256 resets);
    event RoundOpened(uint256 indexed round, uint256 roundEnd);
    event Won(uint256 indexed round, uint256 indexed tokenId, uint256 prize);
    event Claimed(
        uint256 indexed round, uint256 indexed tokenId, address indexed to, uint256 prize
    );
    event RolledOver(uint256 indexed round, uint256 prize);
    event Funded(address indexed from, uint256 amount);
    event Named(
        uint256 indexed round, uint256 indexed tokenId, uint256 indexed trophyId, address to
    );

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant REGISTRATION_PERIOD = 365 days;

    /// @notice How long entries stay open before a round may be drawn.
    uint256 public constant ROUND_LENGTH = 30 days;

    /// @notice How long a winner has to claim before the prize rolls into the next round.
    /// @dev Must stay under NameNFT's 90-day grace period. See "Winners hold names, not addresses".
    uint256 public constant CLAIM_WINDOW = 30 days;

    /// @notice Extra weight for a ticket backing an open proposal, in basis points.
    uint256 public constant BOOST_BPS = 10_000;

    /// @notice After this long with no VRF callback, anyone may clear the request and redraw.
    /// @dev Also the grinding period (see caveats). Honest fulfilment takes about a minute, so
    ///      this is generous for liveness while keeping forced re-rolls slow and costly.
    uint256 public constant REQUEST_TIMEOUT = 3 days;

    /// @notice `namehash("roll.wei")` — the parent every trophy is minted under.
    uint256 public constant PARENT =
        0xf218d633879b71231b282e26380ab665b6d0defe8dafef3bfeac70dd46799d80;

    uint32 internal constant CALLBACK_GAS = 200_000;

    /// @dev Blocks the node waits before deriving the seed from the request block. Chainlink's
    ///      floor is 3, raised with the value at stake, because a reorg moving the request to
    ///      another block re-rolls the result. Two epochs is finality, past which none can. Costs
    ///      ~13 minutes and nothing in fees — confirmations are not priced.
    uint16 internal constant CONFIRMATIONS = 64;

    /// @dev `VRFV2PlusClient._argsToBytes(ExtraArgsV1({nativePayment: true}))`: the tag
    ///      `bytes4(keccak256("VRF ExtraArgsV1"))` followed by the bool. Inlined so this contract
    ///      needs no Chainlink dependency; checked against the mainnet wrapper in the fork test.
    bytes internal constant EXTRA_ARGS =
        hex"92fd13380000000000000000000000000000000000000000000000000000000000000001";

    INameNFT public immutable nft;
    IWeiDAO public immutable dao;
    IVRFV2PlusWrapper public immutable wrapper;
    ISTETH public immutable steth;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Where the contract is right now. `Idle` waits on funding, `Open` accepts entries,
    ///         `Ready` means {draw} is callable, `Drawing` means a seed is in flight.
    enum Phase {
        Idle,
        Open,
        Ready,
        Drawing
    }

    /// @dev Everything a frontend needs for its main screen, in one call.
    struct State {
        Phase phase;
        uint256 round;
        uint256 roundEnd;
        uint256 pot;
        uint256 reserved;
        uint256 tickets;
        uint256 totalWeight;
        uint256 requestId;
        uint256 resetAt;
        uint256 drawPrice;
        uint256 resets;
        bool drawSettles;
        bool naming;
    }

    /// @dev Everything a frontend needs about one round. `resolved` covers both a claim and a
    ///      forfeit — the `Claimed` and `RolledOver` events tell those apart.
    struct Round {
        uint256 tickets;
        uint256 totalWeight;
        uint256 winner;
        uint256 boostPid;
        uint256 prize;
        uint256 claimBy;
        uint256 roundName;
        uint256 trophy;
        uint256 resets;
        bool settled;
        bool resolved;
    }

    /// @dev `cum` is the running weight total through this ticket, so the winner is the first
    ///      whose `cum` exceeds a uniform draw over the round's total — a binary search in the
    ///      callback rather than a loop that could run out of gas.
    struct Ticket {
        uint256 tokenId; //   The namehash, full width.
        uint128 cum; //     ┐ Cumulative weight through this ticket,
        uint128 boostPid; // ┘ proposal bonded to for the boost (0 = none).
    }

    /// @notice The round now accepting entries.
    uint256 public round;

    /// @notice Entries close, and {draw} becomes callable, at this timestamp.
    uint256 public roundEnd;

    /// @notice In-flight VRF request id (0 = none).
    uint256 public requestId;

    /// @notice When that request was made, for {resetRequest}.
    uint256 public requestedAt;

    /// @notice Shares spoken for by drawn-but-unclaimed rounds. Never part of a new pot.
    uint256 public reservedShares;

    mapping(uint256 => Ticket[]) internal _tickets;

    /// @notice A name's ticket index in a round, plus one (0 = not entered). Doubles as the
    ///         one-entry-per-round guard and as an O(1) handle for {weightIn}.
    mapping(uint256 => mapping(uint256 => uint256)) public ticketOf;

    /// @notice Winning tokenId of a settled round (0 = not settled).
    mapping(uint256 => uint256) public winnerOf;

    /// @notice Proposal the winning ticket bonded to, re-checked at claim (0 = unboosted).
    mapping(uint256 => uint256) public winnerBoostOf;

    /// @notice How many times a round's VRF request was cleared and redrawn. Non-zero means
    ///         fulfilment failed or was withheld — the grinding surface, made visible.
    mapping(uint256 => uint256) public resetsOf;

    /// @notice Unclaimed prize of a settled round, in shares (0 = claimed, rolled over, or unrun).
    ///         Read {prizeOf} for what that is worth in stETH today.
    mapping(uint256 => uint256) public prizeSharesOf;

    /// @notice Claim deadline of a settled round.
    mapping(uint256 => uint256) public claimBy;

    /// @notice `<label>.<r>.roll.wei`, the winner's badge for a round (0 = never named).
    mapping(uint256 => uint256) public trophyOf;

    /// @dev Send ETH to open the first round on the spot, and pre-approve this (deterministic)
    ///      address for `roll.wei` to hand the namespace over in the same transaction. Both are
    ///      optional and everything here is swallowed — nothing in this constructor is
    ///      load-bearing, unlike WeiDAO's role mints. See ops/ROLL.md.
    constructor(address _nft, address _dao, address _wrapper, address _steth) payable {
        // An ownerless immutable contract has no way back from a mistyped dependency: a zero
        // wrapper would refuse to quote forever, so no round could ever settle and the pot would
        // sit unreachable. Cheap to refuse the deploy instead.
        if (_nft == address(0) || _dao == address(0) || _wrapper == address(0)) revert NoConfig();
        if (_steth == address(0)) revert NoConfig();

        nft = INameNFT(_nft);
        dao = IWeiDAO(_dao);
        wrapper = IVRFV2PlusWrapper(_wrapper);
        steth = ISTETH(_steth);

        // The whole balance, not just msg.value: a deploy address can already hold stray wei, and
        // once the pot is counted in shares any native ETH left behind is invisible to it.
        if (address(this).balance != 0) {
            ISTETH(_steth).submit{value: address(this).balance}(address(0));
        }

        if (_nft.code.length != 0) {
            try nft.ownerOf(PARENT) returns (address holder) {
                try nft.transferFrom(holder, address(this), PARENT) {
                    // Owning the parent, reverse-resolve to it: `roll.wei` now names this contract.
                    try nft.setPrimaryName(PARENT) {} catch {}
                } catch {}
            } catch {}
        }

        _open();
    }

    /// @notice Fund the pot, starting a round if none is running. WeiDAO does this with a proposal
    ///         targeting this address; anyone else may top it up the same way. ETH is staked on
    ///         arrival, so a waiting pot earns and every holder can watch it grow.
    receive() external payable {
        // Reports what was staked, not `msg.value`: the balance can carry stray wei that arrived
        // without running code, and an indexer summing these should reconcile with {pot}.
        uint256 amount = address(this).balance;
        steth.submit{value: amount}(address(0));
        emit Funded(msg.sender, amount);
        _open();
    }

    /// @notice Stake native ETH sitting here into the pot. Permissionless, and a no-op if there is
    ///         none.
    /// @dev {receive} stakes on arrival, but ETH can still arrive without it — a forced
    ///      `selfdestruct` transfer runs no code. Since the pot is counted in shares, that ETH
    ///      would otherwise be stranded; this turns it into prize money.
    function stake() external {
        uint256 amount = address(this).balance;
        if (amount == 0) return;
        steth.submit{value: amount}(address(0));
        emit Funded(msg.sender, amount);
        _open();
    }

    /// @dev Every path that can leave money in the pot calls this, so funding is the only trigger.
    function _open() internal {
        if (roundEnd == 0 && steth.sharesOf(address(this)) > reservedShares) {
            roundEnd = block.timestamp + ROUND_LENGTH;
            emit RoundOpened(round, roundEnd);
        }
    }

    /// @dev So `roll.wei` can be handed over with `safeTransferFrom`.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    /*//////////////////////////////////////////////////////////////
                                  ENTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Enter `tokenId` in the current round. One ticket per name per round.
    /// @param boostPid An open proposal `tokenId` currently backs, for {BOOST_BPS} extra weight, or
    ///        0 for none. Passing one the name does not back reverts rather than silently entering
    ///        unboosted. Re-checked in {claim}, so dropping support before claiming forfeits.
    function enter(uint256 tokenId, uint256 boostPid) external {
        // Entries shut at `roundEnd` and {draw} cannot run before it, so the ticket set is frozen
        // before any seed exists; no in-flight guard is needed here.
        if (roundEnd == 0) revert NotRunning();
        if (block.timestamp >= roundEnd) revert TooSoon();
        if (nft.ownerOf(tokenId) != msg.sender) revert NotOwner();

        uint256 r = round;
        if (ticketOf[r][tokenId] != 0) revert AlreadyEntered();

        uint256 weight = weightOf(tokenId);
        if (weight == 0) revert NotLive();

        if (boostPid != 0) {
            // Bounded so the id checked here is the id re-checked at claim, with no truncation
            // between. Requiring the proposal open keeps the boost about current governance:
            // support left on a long-settled one must not buy odds forever.
            if (boostPid > type(uint128).max) revert NotBacking();
            (,, bool executed, bool vetoed,,,,,) = dao.proposals(boostPid);
            if (executed || vetoed) revert NotLive();
            if (dao.supportOf(boostPid, tokenId) == 0) revert NotBacking();
            weight += weight * BOOST_BPS / 10_000;
        }

        Ticket[] storage t = _tickets[r];
        uint256 cum = (t.length == 0 ? 0 : t[t.length - 1].cum) + weight;
        if (cum > type(uint128).max) revert WeightTooLarge();

        t.push(Ticket({tokenId: tokenId, cum: uint128(cum), boostPid: uint128(boostPid)}));
        ticketOf[r][tokenId] = t.length; // index + 1

        emit Entered(r, tokenId, msg.sender, weight, boostPid);
    }

    /*//////////////////////////////////////////////////////////////
                                  DRAW
    //////////////////////////////////////////////////////////////*/

    /// @notice Close the round and ask Chainlink for a seed. Permissionless, and the caller pays
    ///         the VRF fee: send at least {drawPrice}. Anything over stays in the pot.
    /// @dev The fee used to come out of the pot, which on a small one could burn most of the prize
    ///      — and made the draw's timing a decision about gas rather than about the round. The
    ///      caller chooses when to call and therefore what the fee costs, so they are the right
    ///      payer; every entrant has a prize waiting on it. The pot is now entirely prize money.
    ///
    ///      An undrawable round is abandoned for a fresh one rather than reverting; see the header.
    function draw() external payable {
        if (roundEnd == 0) revert NotRunning();
        if (block.timestamp < roundEnd) revert TooSoon();
        if (requestId != 0) revert DrawPending();

        uint256 r = round;
        (bool priced, uint256 price) = _quote();

        // No affordability test any more: a round only opens on a non-empty pot, and nothing
        // between opening and settling can shrink it, so a settled round is always claimable.
        if (!priced || _tickets[r].length < 2) {
            // Fresh round, not a carried one: a carried ticket can outlive the name that bought
            // it, and once that name lapses past its grace anyone may re-register it — same
            // tokenId, IDs being namehashes — and inherit the prize. Nothing to re-enter here
            // anyway; this branch means under two tickets or no money to pay out.
            round = r + 1;
            roundEnd = block.timestamp + ROUND_LENGTH;
            emit RoundOpened(r + 1, roundEnd);
            return;
        }

        if (msg.value < price) revert Underpaid();

        requestId = wrapper.requestRandomWordsInNative{value: price}(
            CALLBACK_GAS, CONFIRMATIONS, 1, EXTRA_ARGS
        );
        requestedAt = block.timestamp;
        emit Drawn(r, requestId);

        // Refunded rather than staked: keeping {draw} independent of Lido means a paused or
        // rate-limited staking queue can never stop a round settling.
        if (msg.value > price) safeTransferETH(msg.sender, msg.value - price);
    }

    /// @notice Chainlink's callback. Picks the winner and opens the next round.
    /// @dev Held to a binary search and a handful of writes so it fits {CALLBACK_GAS} — a
    ///      reverting callback burns the randomness. Measured: ~112k even at 2**32 tickets.
    function rawFulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) external {
        if (msg.sender != address(wrapper)) revert Unauthorized();
        if (_requestId == 0 || _requestId != requestId) revert NoRequest();

        uint256 r = round;
        Ticket[] storage t = _tickets[r];

        // Uniform over total weight, then the first ticket whose cumulative weight exceeds it.
        uint256 target = _randomWords[0] % t[t.length - 1].cum;
        uint256 lo;
        uint256 hi = t.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (t[mid].cum > target) hi = mid;
            else lo = mid + 1;
        }

        // The pot is every share not already owed to an earlier winner. Denominating in shares is
        // what makes a prize survive a rebase: it keeps earning while it waits to be claimed.
        uint256 shares = steth.sharesOf(address(this)) - reservedShares;
        winnerOf[r] = t[lo].tokenId;
        winnerBoostOf[r] = t[lo].boostPid;
        prizeSharesOf[r] = shares;
        claimBy[r] = block.timestamp + CLAIM_WINDOW;
        reservedShares += shares;

        requestId = 0;
        requestedAt = 0;
        round = r + 1;
        // The prize was the entire pot, so nothing is left to run on: the next funding reopens.
        roundEnd = 0;

        emit Won(r, t[lo].tokenId, steth.getPooledEthByShares(shares));
    }

    /// @notice Clear a request that was never fulfilled, so {draw} can retry. Permissionless.
    /// @dev A late callback for the cleared id is rejected by the id check in
    ///      {rawFulfillRandomWords}, so there is no race with the retry.
    function resetRequest() external {
        uint256 id = requestId;
        if (id == 0) revert NoRequest();
        if (block.timestamp < requestedAt + REQUEST_TIMEOUT) revert TooSoon();

        requestId = 0;
        requestedAt = 0;

        // A round showing resets is one whose fulfilment failed or was withheld.
        uint256 n = ++resetsOf[round];
        emit RequestReset(round, id, n);
    }

    /*//////////////////////////////////////////////////////////////
                                 CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @notice Collect the prize for a settled round. The caller must still own the winning name,
    ///         it must still be active, and any boost bonded at entry must still be in place.
    function claim(uint256 r) external {
        uint256 shares = prizeSharesOf[r];
        if (shares == 0) revert NotWinner();
        if (block.timestamp > claimBy[r]) revert ClaimWindowOver();

        uint256 tokenId = winnerOf[r];
        if (nft.ownerOf(tokenId) != msg.sender) revert NotWinner();

        if (weightOf(tokenId) == 0) revert NotLive();

        uint256 pid = winnerBoostOf[r];
        if (pid != 0 && dao.supportOf(pid, tokenId) == 0) revert NotBacking();

        prizeSharesOf[r] = 0;
        reservedShares -= shares;

        uint256 prize = steth.transferShares(msg.sender, shares);
        emit Claimed(r, tokenId, msg.sender, prize);

        // Self-call so the mints and the resolver writes fail together, and are swallowed
        // together — as WeiDAO wraps its proposal naming.
        if (_holdsParent()) {
            try this.nameWinner(r, tokenId, msg.sender, prize) {} catch {}
        }
    }

    /// @notice Return an unclaimed prize to the pot once its window closes. Permissionless.
    function rollOver(uint256 r) external {
        uint256 shares = prizeSharesOf[r];
        if (shares == 0) revert NotWinner();
        if (block.timestamp <= claimBy[r]) revert ClaimWindowOpen();
        prizeSharesOf[r] = 0;
        reservedShares -= shares;
        emit RolledOver(r, steth.getPooledEthByShares(shares));
        _open(); // a forfeited prize is funding like any other
    }

    /*//////////////////////////////////////////////////////////////
                                 TROPHY
    //////////////////////////////////////////////////////////////*/

    /// @notice Record a claimed round in the namespace: mint `<r>.roll.wei` here, point it at the
    ///         winner, and mint `<label>.<r>.roll.wei` to them.
    /// @dev External only so {claim} can wrap it in try/catch; callable by this contract alone.
    ///      The round name stays here: resolver writes need ownership, and it must keep owning the
    ///      badge's parent. Labels leave NameNFT normalised, so none is validated.
    ///
    ///      Per-round parents are what make repeat wins work — `alice.7` and `alice.12` cannot
    ///      collide — and they matter for safety too: NameNFT lets a parent owner re-register its
    ///      own subdomains, burning an NFT its holder already has. No path here re-enters a
    ///      settled round, so that power is never used.
    function nameWinner(uint256 r, uint256 tokenId, address to, uint256 prize) external {
        if (msg.sender != address(this)) revert Unauthorized();

        string memory roundLabel = LibString.toString(r);
        if (!nft.isAvailable(roundLabel, PARENT)) revert AlreadyNamed();
        uint256 roundId = nft.registerSubdomain(roundLabel, PARENT);

        (string memory label,,,,) = nft.records(tokenId);
        uint256 badge = nft.registerSubdomain(label, roundId);
        nft.setAddr(badge, to);
        nft.transferFrom(address(this), to, badge);

        nft.setAddr(roundId, to);
        nft.setText(roundId, "winner", label);
        nft.setText(roundId, "prize", LibString.toString(prize));

        trophyOf[r] = badge;
        emit Named(r, tokenId, badge, to);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice A name's ticket weight: WeiDAO's `weightOf`, the current cost to hold it for its
    ///         remaining runway. Active top-level names only; subdomains and expired names are 0.
    function weightOf(uint256 tokenId) public view returns (uint256) {
        (string memory label, uint256 parent, uint64 exp,,) = nft.records(tokenId);
        if (parent != 0 || bytes(label).length == 0 || block.timestamp >= exp) return 0;
        return nft.getFee(bytes(label).length) * (exp - block.timestamp) / REGISTRATION_PERIOD;
    }

    /// @notice The id `<r>.roll.wei` has, whether or not the round was ever named. Naming is
    ///         best-effort, so read {trophyOf} to tell whether it actually happened.
    function roundName(uint256 r) public pure returns (uint256) {
        return uint256(
            keccak256(abi.encodePacked(bytes32(PARENT), keccak256(bytes(LibString.toString(r)))))
        );
    }

    /// @notice Where the contract is right now.
    function phase() public view returns (Phase) {
        if (requestId != 0) return Phase.Drawing;
        if (roundEnd == 0) return Phase.Idle;
        return block.timestamp < roundEnd ? Phase.Open : Phase.Ready;
    }

    /// @notice What the wrapper charges for a seed right now — send at least this with {draw}.
    ///         0 if it will not quote one; read {drawSettles} for whether a draw would go ahead.
    /// @dev Priced off `tx.gasprice`, which is 0 in an `eth_call` — a frontend quoting this over
    ///      RPC should send a realistic gas price or treat the result as a floor.
    function drawPrice() public view returns (uint256 price) {
        (, price) = _quote();
    }

    /// @notice Whether {draw} would settle this round rather than abandon it. Says nothing about
    ///         the caller: they must still send {drawPrice} with the call.
    function drawSettles() public view returns (bool) {
        if (phase() != Phase.Ready) return false;
        (bool priced,) = _quote();
        return priced && _tickets[round].length > 1;
    }

    /// @notice The whole contract state in one call.
    function state() external view returns (State memory) {
        uint256 r = round;
        return State({
            phase: phase(),
            round: r,
            roundEnd: roundEnd,
            pot: pot(),
            reserved: steth.getPooledEthByShares(reservedShares),
            tickets: _tickets[r].length,
            totalWeight: totalWeight(r),
            requestId: requestId,
            resetAt: requestId == 0 ? 0 : requestedAt + REQUEST_TIMEOUT,
            drawPrice: drawPrice(),
            resets: resetsOf[r],
            drawSettles: drawSettles(),
            naming: _holdsParent()
        });
    }

    /// @notice Everything about round `r` in one call. Safe to call for a round that has not run.
    function roundInfo(uint256 r) external view returns (Round memory) {
        uint256 winner = winnerOf[r];
        return Round({
            tickets: _tickets[r].length,
            totalWeight: totalWeight(r),
            winner: winner,
            boostPid: winnerBoostOf[r],
            prize: prizeOf(r),
            claimBy: claimBy[r],
            roundName: roundName(r),
            trophy: trophyOf[r],
            resets: resetsOf[r],
            settled: winner != 0,
            resolved: winner != 0 && prizeSharesOf[r] == 0
        });
    }

    /// @notice A name's own ticket weight in round `r` (0 = not entered). Divide by {totalWeight}
    ///         for its odds.
    function weightIn(uint256 r, uint256 tokenId) public view returns (uint256) {
        uint256 i = ticketOf[r][tokenId];
        if (i == 0) return 0;
        Ticket[] storage t = _tickets[r];
        return i == 1 ? t[0].cum : t[i - 1].cum - t[i - 2].cum;
    }

    /// @notice Whether {claim} would succeed for `who` on round `r` right now.
    function canClaim(uint256 r, address who) external view returns (bool) {
        if (prizeSharesOf[r] == 0 || block.timestamp > claimBy[r]) return false;

        uint256 tokenId = winnerOf[r];
        if (weightOf(tokenId) == 0) return false;
        try nft.ownerOf(tokenId) returns (address holder) {
            if (holder != who) return false;
        } catch {
            return false;
        }

        uint256 pid = winnerBoostOf[r];
        return pid == 0 || dao.supportOf(pid, tokenId) != 0;
    }

    /// @notice A page of round `r`'s tickets, so a frontend can render the field without one call
    ///         per entry. Returns fewer than `limit` at the end.
    function ticketsIn(uint256 r, uint256 offset, uint256 limit)
        external
        view
        returns (Ticket[] memory page)
    {
        Ticket[] storage t = _tickets[r];
        uint256 n = t.length;
        if (offset >= n) return page;
        // `offset + limit` would overflow on a `limit` of type(uint256).max, a natural way to ask
        // for "the rest", and a view that reverts breaks the page asking the question.
        uint256 end = n - offset < limit ? n : offset + limit;
        page = new Ticket[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = t[offset + i];
        }
    }

    /// @notice Number of tickets in round `r`.
    function ticketCount(uint256 r) external view returns (uint256) {
        return _tickets[r].length;
    }

    /// @notice Ticket `i` of round `r`.
    function ticketAt(uint256 r, uint256 i) external view returns (Ticket memory) {
        return _tickets[r][i];
    }

    /// @notice Total weight entered in round `r` — the denominator of every ticket's odds.
    function totalWeight(uint256 r) public view returns (uint256) {
        Ticket[] storage t = _tickets[r];
        return t.length == 0 ? 0 : t[t.length - 1].cum;
    }

    /// @dev Its native pricing reads a LINK/ETH feed behind a staleness guard, so an ownerless
    ///      contract must not assume a quote always answers: a refusal degrades to "cannot draw
    ///      yet", never a revert that strands the pot with entries shut.
    function _quote() internal view returns (bool ok, uint256 price) {
        try wrapper.calculateRequestPriceNative(CALLBACK_GAS, 1) returns (uint256 p) {
            return (true, p);
        } catch {
            return (false, 0);
        }
    }

    /// @dev Whether `roll.wei` is held here, i.e. whether naming can happen at all. `ownerOf`
    ///      reverts on an unregistered name, so this cannot be a bare comparison.
    function _holdsParent() internal view returns (bool) {
        try nft.ownerOf(PARENT) returns (address holder) {
            return holder == address(this);
        } catch {
            return false;
        }
    }

    /// @notice What a draw settled now would pay out, in stETH, net of prizes already owed.
    function pot() public view returns (uint256) {
        return steth.getPooledEthByShares(steth.sharesOf(address(this)) - reservedShares);
    }

    /// @notice A settled round's unclaimed prize in stETH. Grows with the pot's yield until it is
    ///         claimed, because the claim is recorded in shares.
    function prizeOf(uint256 r) public view returns (uint256) {
        return steth.getPooledEthByShares(prizeSharesOf[r]);
    }
}

/// @dev Reverts with `ETHTransferFailed()` if the recipient rejects it, which only ever strands
///      that winner's own prize — {WeiRoll.rollOver} returns it to the pot.
function safeTransferETH(address to, uint256 amount) {
    assembly ("memory-safe") {
        if iszero(call(gas(), to, amount, codesize(), 0x00, codesize(), 0x00)) {
            mstore(0x00, 0xb12d13eb)
            revert(0x1c, 0x04)
        }
    }
}
