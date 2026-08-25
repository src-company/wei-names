# ConvictionVeto AI Security Review — with responses

**Date**: 2026-08-25
**Scope**: `src/ConvictionVeto.sol` — holds the `veto.dao.wei` role; lets WNS holders build
*veto-conviction* against a WeiDAO proposal and cancel it once opposition reaches `threshold`.
**Method**: two independent adversarial passes (automated agent + manual), reconciled. WeiDAO,
NameNFT, Solady trusted.
**Result**: a **faithful mirror** of WeiDAO's support/conviction machinery. **Negative power only —
it can only cancel proposals, never touch the treasury or NameNFT.** No theft, role-theft,
flash-veto, multicall escalation, or reentrancy. One real *asymmetry* (F1) and one inherited
calibration risk (F2), both governance-griefing, both recoverable by exec reassigning the role.

---

## Confirmed-safe (attacked and clean)

- **Flash / instant veto — impossible.** Same-block support+veto yields 0: first `support` hits the
  `lastUpdate == 0` init branch (sets `lastUpdate`, conviction stays 0); same-block `veto` sees
  `dt = 0` → `_accrue` returns 0; `0 >= threshold` is false (`threshold != 0`).
- **Math — no divergence from WeiDAO.** `_sync`/`_accrue`/`_pow` are line-for-line WeiDAO's, reading
  `dao.alpha()` live. `SCALE − alpha > 0` guaranteed. `vetoable` compares against the same
  `dao.threshold()` WeiDAO's `passed()` uses, so veto triggers at exactly WeiDAO's own pass-point.
- **support / sybil / double-count — safe.** Requires `ownerOf == msg.sender` (can't veto-support a
  name you don't own); subdomains weigh 0; `AlreadySupported` keyed by tokenId; `supportWeight`
  can't underflow; **prune can't be blocked** (stale path never calls `ownerOf`, so a burned token
  can't wedge it).
- **Role NFT — can't be stolen or bricked.** No function ever calls `transferFrom`/`approve`, and
  `multicall` delegatecalls only this contract's own functions — genuinely **no transfer-out path**.
  `onERC721Received` accepts only `VETO_ROLE`. Only WeiDAO governance can reassign the role.
- **Multicallable — no escalation.** No ERC-2771 context, so the calldata-spoof doesn't apply;
  `msg.sender` is real and preserved through delegatecall; reverts on `msg.value != 0`; there is no
  self-only privileged entrypoint to reach.
- **Reentrancy — none.** `veto` → `dao.veto` only flips a bool and emits; no callback.

---

## Findings

### F1 — No veto-side timelock; the "symmetric cost" claim is inaccurate (Medium, griefing)
The natspec claims *"symmetric cost (vetoing costs as much sustained weight as passing)."* It isn't.
`WeiDAO.execute` gates on conviction **and** `created + executionDelay` (the 3-day floor that exists
so a whale who crosses threshold in minutes still can't act before opponents react). `veto` gates on
**only** `convictionOf(id) >= threshold` — no time-floor, and it never reads `executionDelay`. So:

- Passing owes `max(time-to-threshold, executionDelay)` — at least 3 days.
- Vetoing owes only `time-to-threshold` — hours for a well-resourced holder, with **no warning
  window and no contest** (support and veto are separate accumulators; a good proposal's backers
  can't out-vote a veto). Once veto-conviction hits threshold, the proposal is cancelled permanently.

**Important bound:** vetoing still needs the *full* pass bar of conviction, so a *small* actor cannot
cheaply veto — the minority-griefing attack does **not** exist. The asymmetry only benefits a holder
with pass-bar weight (≈0.365 ETH; no current single holder has it — largest is 0.26 ETH). **Response
— accepted with the exec backstop:** the contract is negative-power and immutable; a weaponized veto
is recovered by exec reassigning `veto.dao.wei` to a trusted key (`dao.rescue(nft, 0,
registerSubdomainFor("veto", dao.wei, newHolder))`). The "symmetric" wording overstates the
guarantee — the accurate statement is *"vetoing costs the same sustained **weight** as passing, but
without the execution timelock."* A future redeploy could add a `created`-anchored veto delay to make
it truly symmetric.

### F2 — No cross-proposal weight budget → blanket veto (Medium, calibration)
Inherited from WeiDAO: a name backs each proposal at full weight with no global budget. Via
`multicall`, one holder sustaining pass-bar weight can veto-support **every** live proposal in one tx
and freeze the whole governance queue, for the cost of passing one. **Response:** the negative-power
mirror of WeiDAO's own lone-whale property; depends on `threshold` calibration and is recovered by
exec reassigning the role. State it in governance docs.

---

## Bottom line
The least-dangerous of the three contracts — it can only say "no," and its role can't be stolen from
it. The math is a proven copy of WeiDAO's. The one real code-level issue is the missing veto delay
(F1), which makes the "symmetric" claim wrong and lets a pass-bar-weight whale jam governance with no
contest — griefing, never theft, and recoverable by the exec multisig. Run-and-observe is defensible
given negative power + exec recovery; a redeploy with a veto-side delay floor would close it fully.
