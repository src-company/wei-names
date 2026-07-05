# WeiDAO — pre-pilot security audit

**Scope:** `src/WeiDAO.sol` (full, incl. embedded dapp), `src/NameNFT.sol` (interaction only),
`test/WeiDAO*.t.sol` (intent). **Commit:** branch `dao` (working tree). **Method:** manual review +
Foundry (`forge test`: 68/68 pass), selector/namehash/encoding verification with `cast`, review of
Solady `Multicallable`/`LibString.escapeHTML`, and the `DeployWeiDAO`/`DEPLOY.md` handover path.

## Overall assessment

The core is **sound and, for a pre-pilot contract, unusually well-defended.** Conviction math is
differential-tested to ~1 ppm and cannot be compressed below the `executionDelay` floor by any amount
of weight; sybil resistance (weight = sunk ETH, subdomains = 0 weight) holds at every depth; access
control is clean (`Multicallable` cannot forge `msg.sender == address(this)` and rejects `msg.value`);
`execute`/`rescue` are effects-before-interaction; and the on-chain dapp's hand-rolled ABI encoding
and selectors are correct byte-for-byte, with user text HTML-escaped. **No Critical or High issues.**

The residual risk is **operational, and concentrated on one asset: `dao.wei`.** The whole authority
and naming model assumes the DAO owns `dao.wei`; the two findings that can actually move funds
(M1, M2) both live in that seam. Neither is a code defect so much as a monitoring obligation — but
both are worth hardening before real ETH goes in.

| # | Severity | Title |
|---|---|---|
| M1 | Medium | Expired supporters keep **inflating** conviction until someone prunes them |
| M2 | Medium | A lapsed / re-registered `dao.wei` makes **`exec` (god-mode) claimable** → treasury drain |
| L1 | Low | Deploy script doesn't **assert the CreateX salt is sender-bound** (front-run window) |
| L2 | Low | Constructor `setPrimaryName` runs in the try **success-block**, not independently guarded |
| L3 | Low | **No cross-proposal weight budget** — one name backs unlimited proposals at full weight |
| I1–I3 | Info | Fee-tier overflow coupling; cosmetic threshold units; positive confirmations |

---

## Medium

### M1 — Expired supporters keep *inflating* conviction until permissionlessly pruned

`support()` snapshots weight `w` and adds it to `p.supportWeight` (WeiDAO.sol:333-338). `_sync` accrues
conviction from `p.supportWeight` every time (WeiDAO.sol:1041-1054). Nothing decrements `supportWeight`
when a supporting name later expires — only an explicit `unsupport()` does (WeiDAO.sol:347-358). Because
`unsupport` is permissionless once `weightOf == 0` but **not automatic**, an expired name's stale
snapshot keeps driving conviction **upward** (toward `convictionMax(w)`), not merely holding it.

The docs frame the snapshot/prune as bounding "lazy-capture staleness." The sharper consequence worth
stating: conviction keeps *growing* on weight the supporter no longer pays for.

**Failure scenario.** Alice supports proposal P with a name that has ~5 days of runway left (real,
paid-for weight `w`, with `convictionMax(w) > threshold`). She never renews. The name expires ~day 5,
but nobody calls `unsupport`. From day 5 onward P's conviction *continues climbing* on the stale `w`;
it crosses `threshold`, the `executionDelay` elapses, and P executes — moving treasury ETH — funded by
a name that is now worthless. Effectively Alice bought ~10 days of governance pressure with ~5 days of
runway.

**Mitigations already present:** expiry is fully predictable on-chain, the prune is permissionless
(anyone — an opponent, keeper, or the vetoer — can collapse `supportWeight` the instant the name
expires), and `veto` + `executionDelay` backstop any bad proposal. So it is *defensible*, but the
defense is an action someone has to take.

**Recommendation.** For the pilot, run a keeper that (a) prunes expired supporters on live proposals
and (b) alerts on any proposal within one half-life of `threshold`. Longer term, consider having
`execute` accept a caller-supplied list of `tokenId`s to prune-and-resync before the threshold check
(keeps it O(k) and lets a defender neutralize stale weight in the same block as a veto). Fully
re-reading live weight for every supporter at execute time is not feasible (unbounded), so
snapshot + prune + keeper is the right shape — just make the keeper a launch requirement, not optional.

### M2 — A lapsed or re-registered `dao.wei` lets an attacker claim `exec` (god-mode)

Roles resolve live from `exec.dao.wei` / `veto.dao.wei` (WeiDAO.sol:244-266), and the design correctly
trusts whoever holds `exec`. The audit asked me to flag *unintended ways to gain that power* — here is
one, and it is the single most important operational invariant.

`exec.dao.wei` can only be minted by the owner of `dao.wei` (`registerSubdomainFor` requires parent
ownership). While the DAO owns `dao.wei`, only governance/exec can assign it — safe. **But if `dao.wei`
ever expires past its 90-day grace and is re-registered by a third party**, then:

1. the old `exec.dao.wei` goes stale (parent-epoch mismatch → `_holder` returns `address(0)`), and
2. the new `dao.wei` owner can `registerSubdomainFor("exec", dao.wei, attacker)`, and
3. `executor()` now returns the attacker, who can `rescue(treasury → attacker)` (WeiDAO.sol:394-403)
   and call every admin setter.

The DAO contract itself isn't bricked (self-call governance via passed proposals still works), but an
attacker gains god-mode over its treasury. This is a genuine, if remote, escalation path to the
"fully trusted" role — exactly the class the prompt asked to hunt.

**Likelihood is low:** it requires `dao.wei` to be neglected for 365 + 90 days, and `NameNFT.renew()`
is **permissionless** (anyone can renew it for the length fee), so any single well-wisher prevents the
lapse. **Impact is catastrophic** (treasury drain + naming/role takeover).

**Recommendation.** (1) At launch, pre-renew `dao.wei` several years ahead so lapse is implausible.
(2) Add a keeper that renews `dao.wei` well inside grace and alarms if `nft.ownerOf(dao.wei) != dao`.
(3) Treat "the DAO owns `dao.wei`" as a monitored invariant, not an assumption. `LAUNCH.md` already
calls the renewal "load-bearing"; this finding is the concrete why (drain), so weight the operational
control accordingly.

---

## Low

### L1 — Deploy script doesn't assert the CreateX salt is sender-bound

`DeployWeiDAO.run()` pre-approves the counterfactual DAO for `dao.wei` and then
`CREATEX.deployCreate3(salt, initCode)` (script/DeployWeiDAO.s.sol:45-53). A CREATE3 address depends on
`(factory, salt)` only — **not** on init code. If `SALT` is not sender-permissioned (first 20 bytes ≠
deployer, per CreateX `_guard`), an attacker can front-run `deployCreate3` with the *same* salt,
occupy the vanity address with their own contract, and — because `approve(expected, dao.wei)` may have
already landed — have *their* contract pull `dao.wei`. The deployer's own tx then reverts on the
address collision.

`DEPLOY.md` step 1 says to bind the salt to the deployer EOA (`createxcrunch --caller <EOA>`), which
closes this — but nothing in the script enforces it, and `require(dao == expected)` only fires *after*
the damage. **Recommendation:** assert it in code before approving, e.g.
`require(address(bytes20(salt)) == msg.sender, "salt not sender-bound")`. One line makes the
front-run structurally impossible instead of a runbook footnote.

### L2 — Constructor `setPrimaryName` is in the try success-block, not independently guarded

The best-effort `dao.wei` pull wraps `transferFrom` in `try/catch`, but calls `setPrimaryName` *inside
the success block* (WeiDAO.sol:232-234). Solidity's `catch` does **not** catch reverts thrown by the
success block — only by the guarded external call. With the current `NameNFT`, `setPrimaryName` cannot
revert here (the DAO owns the just-pulled name, so the `ownerOf == msg.sender` branch passes), so this
is safe today. But it means a future/again-deployed registry whose `setPrimaryName` can revert would
**brick deployment**, contradicting the "naming failure never blocks deploy" intent.
**Recommendation:** wrap `setPrimaryName` in its own `try/catch` (or `Multicallable`-style
low-level call) so the pull is genuinely best-effort end to end.

### L3 — No cross-proposal weight budget

A name can `support` unlimited proposals simultaneously, each accruing full `convictionMax(w)` — unlike
classic conviction voting where staked tokens are a shared budget split across proposals. This is a
deliberate simplification (weight = sunk ETH gives the sybil resistance; `proposalFee`, `executionDelay`
and `veto` gate execution), and it is fine — but be aware when setting `threshold`: the "cost" to keep
N proposals climbing is identical to keeping 1, so a single short-name whale can push many parallel
proposals. `DEPLOY.md`'s "10% of live weight" `W_req` target already accounts for lone whales; just
keep that in mind if pilot spam appears (raise `threshold` or `proposalFee`, both adjustable).

---

## Informational

- **I1 — Fee-tier overflow coupling.** `weightOf = getFee(len)·(exp−now)/365d` (WeiDAO.sol:462-466) and
  `convictionMax` (477-479) only overflow if the (trusted) `NameNFT` owner sets absurd `getFee` tiers
  (~1e60+). Post-handover the DAO *is* that owner, so it can't foot-gun itself without a passed
  proposal; noted only as a coupling.
- **I2 — Cosmetic units.** The dapp renders `threshold` via `_weiToEth` (WeiDAO.sol:663) though
  `threshold` is in scaled-conviction units, not wei. Display-only; the "Pass bar" (`_passWeight`, in
  real ETH) is the meaningful figure. Consider labelling `threshold` as "conviction units" to avoid a
  reader mistaking it for an ETH amount.
- **I3 — Positive confirmations** (the "confirm or refute" asks): see next two sections.

---

## Invariant confirmations (the audit's core checklist)

1. **Conviction math** — `_accrue = c·α^Δ/S + w·(S−α^Δ)/(S−α)` (WeiDAO.sol:1050-1054) matches the spec.
   `_pow` is exp-by-squaring, differential-tested against Solady `powWad` (independent exp/ln) to
   ~1 ppm and pinned at the half-life anchors (`WeiDAOPrecision.t.sol`). Division is always by
   `SCALE−alpha > 0` (α<SCALE enforced) and `dt==0` is short-circuited; no div-by-zero, no realistic
   overflow (conviction is bounded by `convictionMax(supportWeight)`, fuzz-checked to `w ≤ 1e30`).
   **A flash-mint or freshly-bought name cannot execute faster than the ramp + timelock** — conviction
   starts at 0 and `execute` independently enforces `created + executionDelay` (see #6). ✔
2. **Weight = ETH sunk in WNS** — `weightOf` returns 0 for **any** name with `parent != 0`
   (WeiDAO.sol:464), i.e. every subdomain at every depth (`a.b.wei`, nested), and for expired names.
   Only active top-level names — which cost `getFee+premium` via commit-reveal — earn weight, and it
   tracks paid-ahead runway. No cheap way to manufacture voting weight. ✔
   (Verified `testSubdomainHasNoWeight`, `testSubdomainCannotVote`, `testRenewalBoostsWeight`.)
3. **Access control / Multicallable** — `_authed` is `self-call || executor` (WeiDAO.sol:269-271).
   Solady `multicall` **`delegatecall`s to self, so `msg.sender` stays the original caller** (cannot
   forge `address(this)`), **and reverts on non-zero `msg.value`** (no fee/value double-spend). The
   only way to be `address(this)` is a proposal that targets the DAO and passes conviction. ✔
   (Verified `testMulticallRejectsValue`; Solady `Multicallable.sol` `if (msg.value != 0) revert()`.)
4. **Reentrancy / fund safety** — `execute` sets `p.executed = true` before the external call
   (WeiDAO.sol:382-385); re-entering the same id reverts `AlreadyExecuted`, and every other proposal
   forwards only its own governance-authorized `p.value`, so no reentrant path drains beyond what was
   authorized. A failed call reverts the whole tx (retriable), never bricks. `rescue` is exec-only. ✔
5. **Roles as WNS subdomains** — `_holder` (WeiDAO.sol:256-266) lapses a role to `address(0)` on
   parent-epoch mismatch or parent expiry (dead-man's switch), matching `NameNFT._isActive` for
   depth-1 names. The DAO (owner of `dao.wei`) can always reclaim/reassign a role by re-registering the
   subdomain; a role holder cannot mint or escalate to the other role. The three role/parent namehash
   constants were verified to equal `dao.wei` / `veto.dao.wei` / `exec.dao.wei` exactly. ✔
   (The one escalation *into* a role is M2, gated on a `dao.wei` lapse.)
6. **Timelock** — `execute` reverts `TooSoon` while `block.timestamp < p.created + executionDelay`,
   read live and capped at `MAX_EXECUTION_DELAY = 30 days` (WeiDAO.sol:377, 437-442). No amount of
   weight compresses it. ✔ (Verified `testExecutionDelayFloorsWhaleWindow`: a ~100× whale crosses
   `threshold` in ~90 min but still cannot execute before the delay.)
7. **Knob bounds** — `alpha ∈ (0, SCALE)`, `threshold != 0`, `delay ≤ cap` enforced in the constructor
   and on every setter (WeiDAO.sol:208-209, 410-442). ✔

## Embedded dapp — correctness & performance

- **Selectors** — all 11 hand-encoded selectors verified against the real ABIs with `cast sig`:
  `propose 82ff16c1`, `support 9be56c67`, `unsupport 84a1faba`, `execute fe0d94c1`,
  `multicall ac9650d8`; reads `computeId fb021939`, `primaryName eba951aa`, `getFullName 465411c1`,
  `weightOf 0767d178`, `resolve 4f896d4f`, `reverseResolve 9af8b7aa`. All match. ✔
- **ABI hand-encoding** — the `propose(address,uint256,bytes,string)` dynamic-offset layout
  (`…+p(128)+p(160+dp)+p(dl)+w(d)+p(sl)+w(x)`, WeiDAO.sol:937-940) and the `Multicallable` `bytes[]`
  encoder `mc` (WeiDAO.sol:917-919) are proven **byte-for-byte equal to `abi.encode`** in-contract,
  including non-aligned bytes, empty bytes+string, and odd-length elements
  (`testProposeCalldataMatchesAbi`, `testMulticallCalldataMatchesAbi`, `testStaticCalldataMatchesAbi`). ✔
- **Value handling** — `wei()` decimal→wei parsing is correct (integer + up-to-18 fractional digits,
  floor); `propose` sends only `W.fee` as `msg.value`, and the proposal's own `value` is forwarded
  from the treasury at execution, never at propose time. Multicall txs carry no value. ✔
- **Rendering safety (XSS)** — the only user-controlled free-text on the page is the proposal
  description, read from the name record and passed through `LibString.escapeHTML` before being placed
  in both a `title="…"` attribute and element text (WeiDAO.sol:804-807). `escapeHTML` escapes
  `" & ' < >` (mask verified in Solady source), so the double-quoted attribute cannot be broken out of
  and no tag can be injected. Every other interpolated value is a number, hex address, or hex calldata.
  The description name is DAO-owned, so only the DAO writes it. ✔ (Verified `testHtmlEscapesDescription`.)
- **View robustness / gas** — `html()`/`request()` cannot revert on normal input: `_holder`/`weightOf`
  guard `ownerOf` behind a minted-label check and never touch an unminted role; `nft.text` returns ""
  for missing names; all subtractions are guarded; `?from=` is length-capped and clamped to
  `[1, count]`. Output is bounded to `_HTML_ROWS = 25` per page with `?from=` paging, and the spotlight
  banner is capped at 8 buttons. ✔ (Verified `testHtmlRendersLiveState`, `testRequestPagesOlderProposals`,
  `testHtmlSpotlightsExecutable` across mixed proposal states.)
- **Self-containment / UX** — no external network/CDN dependency (SVG favicon is an inline data URI,
  CSS/JS inlined via SSTORE2 blobs); theme-aware (`prefers-color-scheme`) and mobile-responsive
  (card layout < 680px); connect / support / unsupport / execute / propose are wired to the verified
  calls, with name-string voting (`computeId`) so users type `alice.wei` rather than a token id. ✔

---

## Opinion — is the conviction design logically sound for its purpose?

**Yes.** For steering a WNS treasury with sybil-resistant, deadline-free governance, the model is
coherent and the pieces reinforce each other:

- **Sybil resistance is real and cheap to reason about:** weight = ETH actually sunk into a top-level
  name (fee tier × runway), subdomains are free and therefore worth 0, so vote-buying costs exactly
  the ETH it represents. This is a cleaner, more Boolean sybil boundary than token-balance schemes.
- **The flash-mint objection is answered twice over:** conviction must be *accumulated* (starts at 0),
  and even an arbitrarily large whale is floored by `executionDelay`. The explicit separation of "ramp
  = warning window for supporters near `W_req`" from "timelock = hard floor for whales" is the correct
  framing, and the code enforces the floor unconditionally.
- **Support-only + veto + timelock** is a sensible opposition model given the goal (no deadlines): you
  oppose by withholding/withdrawing support, and the veto is the real-time circuit-breaker during the
  timelock. This *does* put weight on the veto holder and on `executionDelay` being set above the veto
  multisig's own timelock — which `DEPLOY.md` gets right (3 days > multisig delay).

Two honest caveats to hold alongside it: (1) there is **no cross-proposal budget** (L3) — weight is
replicated across concurrent proposals rather than divided — so `threshold` must be set for the
lone-whale case (the pilot's 10%-of-live-weight `W_req` does this); and (2) the whole thing is a
**superstructure on `dao.wei`** (M2) — governance survives its loss, but the trusted-role and naming
layers do not, so `dao.wei` custody/renewal is the load-bearing operational control, not a detail.

## Launch-readiness of the embedded dapp

**Confirmed: the embedded dapp will drive correct on-chain transactions for all supported functions,
with no encoding, selector, value-handling, or injection bug found.** Connect, support/unsupport
(single and multicall-batched), execute, and propose (with fee + treasury-forwarded value) are all
wired to verified calldata, and the page renders safely and boundedly from live state. The only
launch blockers are **operational, not code**: stand up the keeper (M1 prune + M2 `dao.wei` renewal),
pre-renew `dao.wei` long, add the one-line salt assertion to the deploy script (L1), verify
`nft.ownerOf(dao.wei) == dao` and both roles resolve post-deploy, and — as the contract's own caveats
say — commission a formal review of the fixed-point `_pow`/`_accrue` before large ETH is committed.
