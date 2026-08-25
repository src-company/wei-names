# WeiDAO AI Security Review — with responses

**Date**: 2026-08-25
**Scope**: `src/WeiDAO.sol` (1206 lines) — conviction-voting DAO + treasury that owns `NameNFT`.
**Method**: two independent adversarial passes (one automated agent + one manual), reconciled;
NameNFT/Solady treated as trusted and checked only where WeiDAO relies on them.
**Result**: **no unprivileged exploit** — no treasury drain, NameNFT seizure, or role hijack by an
outsider. Every finding is governance-parameter / operational, not a code defect. This is the first
adversarial pass on WeiDAO (prior audits covered only NameNFT/SubdomainRegistrar/dapp).

Live state at review: ~1.38 ETH under governance, `threshold` ≈ 0.365 ETH sustained, 7-day
conviction half-life, 3-day timelock. Measured electorate: ~3.73 ETH total live weight across 600
owners; largest single holder 0.26 ETH — **below** the pass bar, so no lone whale can pass today.

---

## Confirmed-safe (defenses attacked and not broken)

- **Role seizure via re-registered `dao.wei` — fix is complete.** `_roleHolder` (L299-302) returns
  `address(0)` for *both* roles unless the DAO owns the active parent, and `_holder` enforces
  `parentEpoch == dao.wei.epoch`. An attacker who re-registers a lapsed `dao.wei` and mints
  `exec.dao.wei` to themselves gets `executor() == address(0)` — the ownership gate voids the role,
  it never reassigns it. Roles also go dark during `dao.wei`'s grace (fail-closed). No bypass found.
- **Flash-mint / flash-loan — impossible.** Support added in the same block as `execute` contributes
  `dt = 0` → zero conviction (support calls `_sync`, setting `lastUpdate = now`). Conviction requires
  wall-clock time, floored by `executionDelay`. Cannot pump-and-execute atomically.
- **`execute` reentrancy — no drain.** `p.executed = true` before the call (CEI). A reentrant target
  can't re-run the same proposal (`AlreadyExecuted`), can't reach the setters (they require
  `msg.sender == address(this) || executor()`, not the target), and **cannot invoke `rescue`** (a
  proposal executes with `msg.sender == address(this) ≠ executor()`). `Multicallable` is
  delegatecall-to-self, preserving the real EOA — it cannot forge `msg.sender == address(this)`.
- **Double-count / sybil — none.** `support` reverts `AlreadySupported` keyed by tokenId (survives
  transfer without re-count); subdomains weigh 0; `supportWeight` is symmetric checked math.
- **Admin setters — guarded.** `threshold` can't be 0, `alpha ∈ (0, SCALE)`, delay capped, all
  behind `_authed()` (governance-self-call or exec). No external path.

---

## Findings (all governance/operational, not code bugs)

### F1 — `weightOf` is revalued live by the fee schedule the DAO itself controls (Medium, gov-gated)
`weightOf` reads `nft.getFee(byteLength)` live (L539-543). Post-handover the DAO owns NameNFT, so
governance/exec can raise a length tier's fee and **retroactively multiply the voting weight of
every already-registered name in that tier**, with no new ETH sunk. This decouples weight from the
advertised "sunk cost-to-hold." Trusted-only, but it's a governance-capture *amplifier*: whoever
first controls the fee schedule can cheaply revalue the electorate. **Response:** by-design (the DAO
governs its own economics), but treat fee-schedule changes as electorate-altering events; documented
here so it isn't a surprise.

### F2 — Single-proposal parameter cascade / lone-whale (Medium, calibration)
`execute` with `target = address(this)` reaches every setter (the intended governance path), so one
passed proposal can `setThreshold(1)` / `transferOwnership(attacker)` / drain. The *only* safeguard
is that the first such proposal must clear the real `threshold`, survive the timelock, and dodge the
veto. There's no per-proposal weight budget, so **threshold calibration is the single most important
operational control.** **Response:** keep `threshold` above the largest realistic coalition
(currently fine: bar 0.365 > largest holder 0.26), scale it up with the namespace
(`ops/weight_scan.py`), and keep the veto key live. Backstopped by the exec multisig.

### F3 — `setProposalFee(0)` enables propose-spam that mints subdomains (Low)
No minimum fee (L492-496). At fee 0, one weighted name can spam `propose`, each best-effort minting
an `<id>.dao.wei` and growing `proposalCount`. Bounded by gas + `html()` pagination — namespace
bloat, not a core-function DoS. **Response:** keep `proposalFee` non-trivial.

### F4 — `dao.wei` renewal is an unincentivized keeper duty (Low, availability)
`renew()` is permissionless but unpaid. If `dao.wei` lapses past grace, roles correctly go dark
(safe) but the veto/exec backstop and proposal-naming/`html()`-over-dao.wei break. **Response:**
keep `dao.wei` renewed (calendar/keeper). This is what keeps the exec off-switch armed.

### F5 — `_accrue` rounding bias is *upward* (Informational)
`_pow` truncates each squaring, so `α^dt` is under-estimated and the increment term
`w·(SCALE−a)/(SCALE−alpha)` is slightly over-estimated — conviction accrues marginally *faster* than
ideal, favoring the **proposer**, not the treasury. Bounded (can't exceed `convictionMax`), ~1 ppm
per the differential tests. **Response:** not exploitable, but note the direction; a machine-checked
pass on `_pow`/`_accrue` is still recommended before the treasury grows large.

### F6 — Support survives transfer (Informational)
A supporter can build conviction then sell the name, exiting future liability while their backing
lingers until pruned. Weight = cost they *did* pay, so no free vote. **Response:** documented, acceptable.

---

## Bottom line
WeiDAO's critical invariants — role safety, reentrancy, conviction timing, weight accounting — are
sound; two independent passes found no unprivileged exploit. The residual risk is **governance
discipline** (threshold calibration, fee-schedule power) and the **exec god-mode trust** (the
`exec.dao.wei` holder can drain/seize instantly — the intended launch-multisig design). Keep the
threshold calibrated, the names renewed, and the exec keys secure; a formal pass on the fixed-point
math is worthwhile before large value accrues.
