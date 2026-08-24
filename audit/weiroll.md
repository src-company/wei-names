# WeiRoll AI Security Review — with responses

**Date**: 2026-08-24
**Scope**: `src/WeiRoll.sol` (single file). Dependencies `NameNFT`, `WeiDAO`, Lido stETH, and the
Chainlink VRF V2.5 native wrapper were treated as trusted and examined only where `WeiRoll` relies
on their behavior.
**Method**: manual line-by-line + design/economic review; `PARENT` namehash and share/pot
invariants verified by hand; no deployment, fuzzing, or formal verification.
**Result**: no theft/redirect path found. 1 High, 3 Medium, 5 Low, 8 informational/verified-safe.

Responses and the commit that resolves each are inline below. Findings the review rated
*verified-safe* are recorded but not repeated in full.

| # | Title | Severity | Disposition |
|---|-------|----------|-------------|
| H-1 | No escape if Lido/VRF wrapper permanently unavailable → funds locked | High | **Fixed (wrapper half)** + documented |
| M-1 | Claim-time boost re-check can forfeit a legitimately-won prize | Medium | **Fixed** |
| M-2 | A winning name lapsing into grace forfeits the prize | Medium | **Fixed** |
| M-3 | VRF callback makes an avoidable Lido call under the gas cap | Medium | **Fixed** |
| L-1 | No reentrancy guard on state-changing entrypoints | Low | **Fixed** |
| L-2 | Empty-round abandon is griefable / silently orphans tickets | Low | Acknowledged (UI) |
| L-3 | `draw()` not fully Lido-independent in a wrapper-refund edge | Low | Verified benign |
| L-4 | Excess-value refund in `draw()` reverts if caller rejects ETH | Low | Acknowledged (self-inflicted) |
| L-5 | Trophy naming cannot be retried/backfilled | Low | Won't fix (cosmetic) |
| I-1..I-8 | Verified-safe confirmations | Info | Noted; I-1 hardened |

---

## H-1 — No recovery if Lido or the VRF wrapper becomes permanently unavailable *(High)*

**Finding.** The contract is ownerless with no withdrawal, and every payout routes through both the
Chainlink wrapper and Lido at hardcoded addresses. If the wrapper is permanently deprecated,
`draw()` takes the `!priced` branch forever and the staked pot can never become a prize; if Lido
permanently blocks `transferShares`, prizes can never be paid. The README disclosed the Lido lock
but not the symmetric wrapper lock.

**Response — fixed for the wrapper half; documented for the Lido half.** Added a permissionless
`rescue()`: if no draw has been *requested* for `RESCUE_TIMEOUT` (365 days), the **unreserved** pot
is swept back to WeiDAO — the funder, owned by the same `.wei` holders. A successful draw stamps
`lastRequest`, so a functioning lottery never approaches the timeout; only a genuinely stuck one
(dead wrapper, or a dead community for a year) unlocks it, and it returns funds *home* rather than
to any privileged party. It is not terminal — fresh funding reopens a round, a recovered wrapper
resumes, and a rescue restarts the clock so new funds get a full window. Reserved prizes are never
swept (they stay claimable while Lido works). The Lido half is genuinely unrescuable — if
`transferShares` permanently fails nothing can move, `rescue` included — and is now documented in
the caveats with the same prominence as the wrapper case.

Regression: `testRescueReturnsAStuckPotToTheDao`, `testASuccessfulDrawResetsTheRescueClock`,
`testRescueLeavesReservedPrizesAlone`, `testRescueRestartsTheClock`,
`testRescueIsANoOpWhenNothingIsUnreserved`.

---

## M-1 — Claim-time boost re-check can forfeit a legitimately-won prize *(Medium)*

**Finding.** `claim()` re-checked `dao.supportOf(pid, tokenId)`. The boost weights the *draw*, which
is already over by claim time, so the re-check cannot change who won — it can only make a real
winner lose a real prize when support lapses through ordinary behavior: voluntarily unsupporting
(normal governance), or a permissionless prune after the name is renewed.

**Verified against source.** WeiDAO's `execute`/`veto` do **not** iterate or clear `_support` (only
`unsupport` does), so the auditor's uncertain "path 3" (execution clearing support) does not exist.
Paths 1 (unsupport) and 2 (prune-after-renewal) are real.

**Response — fixed.** Removed the claim-time boost re-check and the `winnerBoostOf` storage (and its
callback write, saving a slot). The boost is now evaluated exactly once, at entry, and baked into
the ticket's cumulative weight; nothing about payout depends on support persisting. This deletes an
accidental-forfeiture trap and a griefing vector, and makes the boost cleanly additive, matching the
"taxes the unengaged rather than gates rewards" framing. Regression:
`testDroppingSupportAfterEntryDoesNotForfeit`, `testCanClaimIgnoresBoostAfterEntry`.

---

## M-2 — A winning name lapsing into grace forfeits the prize *(Medium)*

**Finding.** `claim()` required `weightOf(tokenId) > 0`, which is 0 the instant a name passes
`expiresAt` — i.e. throughout its 90-day grace, during which the holder still *owns* the NFT. A
winner whose name slipped into grace inside the 30-day claim window could not claim without first
renewing, an easy deadline to miss.

**Response — fixed.** Dropped the `weightOf` check from `claim()` (and `canClaim`). The only
surviving test is `ownerOf(tokenId) == msg.sender` — *holding* the name. This is safe because
NameNFT freezes an inactive name's transfers (so a grace name can't move to a stranger) and grace
(90d) exceeds the claim window (so no one can re-register it inside the window — see I-1). So a
winner in grace still holds the name and still claims; selling still forfeits to the buyer, by
design. Regression: `testAWinnerInGraceCanStillClaim`, `testSellingForfeitsToTheBuyerNotTheSeller`.

---

## M-3 — VRF callback makes an avoidable Lido call under the gas cap *(Medium)*

**Finding.** `rawFulfillRandomWords` runs under `CALLBACK_GAS = 200_000`, where a revert burns the
randomness. It made two Lido calls: `sharesOf` (essential) and `getPooledEthByShares` inside the
`Won` emit (only to express the prize in ETH). A future Lido upgrade raising view gas costs eats the
callback's headroom.

**Response — fixed.** `Won` now carries the prize in **shares** (`emit Won(r, tokenId, shares)`),
removing the avoidable Lido call from the gas-critical path. Indexers convert via
`getPooledEthByShares` off-chain; `prizeOf(r)` exposes the stETH figure on demand. Kept
`CALLBACK_GAS` at 200k — measured ~112k at 2^32 tickets, now with one fewer external call.
Regression: `testWonEmitsSharesNotStEth`.

---

## L-1 — No reentrancy guard on state-changing entrypoints *(Low)*

**Finding.** Safety rested entirely on CEI plus dependency trust; no concrete exploit found, but the
window in `draw()` between the wrapper call returning and `requestId` being set is a theoretical
soft spot if the (trusted) wrapper misbehaved.

**Response — fixed.** Added soledge's transient `ReentrancyGuard` and `nonReentrant` to `enter`,
`draw`, `claim`, `rollOver`, and `stake` — cheap defense-in-depth for an unrescuable vault, closing
the class outright. `nameWinner` is deliberately left unguarded so `claim`'s `this.nameWinner(...)`
self-call still works; it is `msg.sender == address(this)`-gated instead.

---

## L-2 / L-3 / L-4 / L-5 — Low findings

- **L-2 (abandon griefing / orphaned tickets).** No contract change. The dapp surfaces abandoned
  rounds (distinguishing "settled" from "reopened") and prompts affected entrants to re-enter. The
  griefing impact is nil — it only keeps a near-empty lottery empty; the pot is preserved.
- **L-3 (`draw` Lido-independence in a refund edge).** Verified benign: `draw` sends exactly
  `price`, computed from the same `tx.gasprice` the wrapper prices against, so there is nothing to
  refund and `receive()`'s `submit` is never reached during a draw. The independence claim holds for
  the mainnet wrapper (fork-tested). Documented as an assumption.
- **L-4 (refund reverts if caller rejects ETH).** Self-inflicted only — anyone can call `draw`
  sending exactly `drawPrice()`, so it cannot block other callers. Integrator note: send the exact
  quote or be able to receive the refund.
- **L-5 (no trophy backfill).** Won't fix. Naming is cosmetic and already best-effort; a backfill
  path adds code for no funds-at-risk benefit. Funds always take priority over commemoration.

---

## Verified-safe confirmations (I-1 … I-8)

All confirmed by the review and re-checked here. Notable:

- **I-1 (theft-by-re-registration window closed).** Entry-to-claim-end ≤ 60 days; re-registration
  needs `expiresAt + 90d > entry + 90d`, so a winning name can never be re-registered inside its
  claim window. **Hardened:** `CLAIM_WINDOW`'s doc now states the `CLAIM_WINDOW < GRACE_PERIOD`
  invariant explicitly (NameNFT does not expose the constant, so it is enforced by note + fork
  test), so a future tweak can't silently break it.
- **I-2 (share accounting exact, cannot underflow).** `reservedShares == Σ prizeSharesOf` and
  `reservedShares ≤ sharesOf(this)`; every decrement is paired. Confirmed.
- **I-3 (settled ⇒ non-empty prize).** The pot only grows or holds between open and settle.
- **I-4 (sybil resistance).** Subdomains and expired names weigh 0; weight needs paid top-level
  names; cumulative weight capped at `uint128`.
- **I-5 (reorg handling).** `CONFIRMATIONS = 64` (two epochs); stale fulfilments rejected by the id
  check.
- **I-6 (`PARENT` correct).** `namehash("roll.wei") == 0xf218…9d80`, verified.
- **I-7 (`resetRequest` grinding bounded and disclosed).** One reset per `REQUEST_TIMEOUT`, surfaced
  via `resetsOf`.
- **I-8 (direct stETH donation benign).** Becomes part of the next prize; `stake()` rescues
  force-sent native ETH.

---

## Design-level items (unchanged, restated)

stETH depeg (prize can lose ETH value between draw and claim); governance-coupled odds (weight
snapshotted at entry, so a mid-round fee change cannot re-weight existing tickets or steer a draw);
weight drift bounded by one `ROUND_LENGTH`; external renewal of the `roll.wei` namespace. All
disclosed in the contract caveats and README.

---

## Post-fix status

360 unit tests + 7 mainnet-fork tests pass; 100% branch and function coverage. Contract 11,868 bytes
runtime. A formal/machine-checked pass on the callback gas bound against current mainnet Lido, and an
independent review of the `rescue` sweep, remain recommended before large value accrues.
