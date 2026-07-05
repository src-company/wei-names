# WeiDAO launch runbook

Operational guide for deploying and running `WeiDAO` as the treasury + governor of the Wei Name
Service (`NameNFT`). Read this end-to-end before mainnet. It complements — does not replace — the
contract NatSpec in [`src/WeiDAO.sol`](../src/WeiDAO.sol).

Three things in this system are **load-bearing and silent if you get them wrong**: the bootstrap
ordering, the parameter calibration, and keeping `dao.wei` renewed. Each has its own section.

---

## 0. Roles at a glance

| Name | Namehash constant | Power |
|---|---|---|
| `dao.wei` | `PROPOSAL_PARENT` | parent of proposal names + the two roles; the DAO holds it |
| `veto.dao.wei` | `VETO_ROLE` | may `veto` any not-yet-executed proposal (negative power only) |
| `exec.dao.wei` | `EXEC_ROLE` | god-mode: `veto`, `rescue` (arbitrary call), and all admin setters |

Roles are **live-resolved from name ownership** — holding the name *is* holding the role, and
handoff is a transfer. Both roles are subdomains of `dao.wei`; if `dao.wei` lapses or is
re-registered, both roles lapse too (the dead-man's switch — see §4).

The hardcoded namehashes in the contract assume the labels `dao`, `veto`, `exec` and the `.wei`
root. If you deploy under a different parent, **recompute the three constants** (`nft.computeId("dao.wei")`,
etc.) and update `PROPOSAL_PARENT` / `VETO_ROLE` / `EXEC_ROLE` before deploying.

---

## 1. Bootstrap sequence (order matters)

Let `D` = deployer EOA/multisig, `V` = intended veto holder, `X` = intended exec holder.

1. **Deploy `NameNFT`** (or use the existing one). `NameNFT`'s owner is `tx.origin` at deploy.
2. **Set the length-fee tiers** on `NameNFT` (`setLengthFees`) — these define both registration
   price *and* voting weight, so pick them before anyone registers. (Optional: `setPremiumSettings`.)
3. **Deploy `WeiDAO`** with `(nameNFT, alpha, threshold, proposalFee, executionDelay, roleHolder)` —
   see §2 for values. You can send ETH at deploy to seed the treasury (`payable`).
4. **Register `dao.wei`** from any address (commit → wait `MIN_COMMITMENT_AGE` (60s) → reveal, paying
   the length fee). Registering address becomes its owner temporarily.
5. **Mint the roles** — as the `dao.wei` owner, `registerSubdomainFor("veto", daoId, V)` and
   `registerSubdomainFor("exec", daoId, X)`. Must happen *while you still own `dao.wei`*.
   **Skip this in the CREATE3 path** ([DEPLOY.md](./DEPLOY.md)): there `dao.wei` is owned *before*
   deploy and pre-approved, so the constructor pulls it and mints both roles to `roleHolder` itself
   (steps 5 & 7 fold into the deploy tx). This manual mint is only for the deploy-then-register order.
6. **Transfer `NameNFT` ownership to the DAO**: `nft.transferOwnership(address(dao))`. Now
   `NameNFT` admin calls (`withdraw`, `setLengthFees`, `transferOwnership`, …) are governable.
7. **Gift `dao.wei` to the DAO**: `nft.transferFrom(owner, address(dao), daoId)`. Now the DAO can
   auto-name proposals under it, and the roles resolve under a DAO-held parent.

**Verify before going live:** `dao.PROPOSAL_PARENT() == daoId`, `dao.vetoer() == V`,
`dao.executor() == X`, `nft.owner() == address(dao)`, `nft.ownerOf(daoId) == address(dao)`.

> The Foundry `setUp()` in [`test/WeiDAO.t.sol`](../test/WeiDAO.t.sol) performs exactly this
> sequence and is the reference implementation for a deploy script.

---

## 2. Parameter calibration

All four DAO knobs are governance/exec-adjustable post-launch (`setAlpha`, `setThreshold`,
`setProposalFee`, `setExecutionDelay`), but pick sane launch values — a mis-set `threshold` can make
governance either impossible or trivially capturable.

### `alpha` — conviction decay (half-life)

`alpha = round(2^(-1/H) · 1e18)` for a target half-life `H` in **seconds**. Longer half-life = more
inertia (harder to pass, harder to unwind). Reference: `H = 7 days → 999998853923940000`.

### `threshold` — the passing bar (conviction units)

Set relative to the sustained weight `W_req` you want to require:

```
threshold = convictionMax(W_req) / 2 = W_req · 1e18 / (1e18 − alpha) / 2
```

⇒ a proposal holding sustained weight `W_req` passes after **one half-life**. Choose `W_req` in
weight units, where **1 name-year at fee tier `f` = `f` weight** (a name paid one year ahead at a
tier costing `f` ETH). Example: to require "sustained backing equal to 50 name-years at the 0.001
ETH tier," set `W_req = 50 · 0.001e18`.

**Re-tune as the DAO grows.** Unlike a supply-relative quorum, an absolute threshold does *not*
auto-scale. If the active-name base 10×s, an old threshold becomes ~10× easier to clear — raise it
via `setThreshold`. Budget for periodic recalibration.

### `proposalFee` — anti-spam

ETH required to open a proposal (kept in treasury). Start modest; raise if spammed.

### `executionDelay` — veto-window floor (seconds, ≤ `MAX_EXECUTION_DELAY` = 30 days)

The timelock floor. Conviction's ramp is *not* a sufficient warning window on its own: a supporter
whose weight far exceeds `W_req` crosses `threshold` in minutes (≈73 min at 100×, ≈7 min at 1000×),
which no human veto multisig can react to. `executionDelay` guarantees a minimum time from proposal
creation to execution that **no amount of weight can compress**. Effective earliest execution is
`max(created + executionDelay, time-to-threshold)`.

Recommended launch value: **1–2 days** while the veto is a human multisig; can be lowered later as
the DAO decentralises. `0` disables it (not recommended pre-decentralisation).

---

## 3. Funding the treasury

- **Registration/renewal fees** accumulate in `NameNFT`. Because the DAO owns `NameNFT`, pull them
  in via a proposal (or exec `rescue`) calling `NameNFT.withdraw()` → sends the full balance to the
  DAO. This is the primary revenue path.
- **Direct transfers** of ETH or NFTs to the DAO are accepted (`Receiver`).
- **Spending** is via `execute` (a passed proposal) or exec `rescue` — either does
  `target.call{value}(data)`, so the DAO can forward ETH, `transfer`/`safeTransferFrom` NFTs it
  holds, or call any contract.

---

## 4. `dao.wei` renewal is load-bearing — do not let it lapse

If `dao.wei` expires (past its grace period it can even be re-registered by someone else, bumping
its epoch), then **silently and simultaneously**:

- `vetoer()` and `executor()` return `address(0)` → the veto safety net and exec god-mode vanish;
- proposal auto-naming stops (harmless — best-effort);
- conviction governance (`propose`/`support`/`execute`) keeps running **unprotected**.

This is the intended dead-man's switch, but you almost never want to trigger it by accident.

**Mitigation:** `NameNFT.renew(daoId)` is **permissionless** (anyone may pay the fee to extend a
top-level name). Run a keeper that renews `dao.wei` well before expiry, or have governance/exec
renew it periodically. Monitor `records(daoId).expiresAt`.

The same applies to `veto.dao.wei` / `exec.dao.wei` relative to `dao.wei`'s epoch: they only stay
valid while `dao.wei`'s epoch is unchanged. Renewing `dao.wei` does **not** bump its epoch (renewal
only extends `expiresAt`), so the roles survive renewals — only a lapse-and-re-register breaks them.

Roles are recognised **only while the DAO owns the active `dao.wei`** (a subdomain under a parent the
DAO doesn't own is void), so a lapse-and-re-register can **never** hand `exec`/`veto` to the new
registrant — the roles simply stay `address(0)` until the DAO owns `dao.wei` again. A lapse costs the
DAO its safety nets, not its treasury.

Renewal is cheap public-good insurance: `NameNFT.renew(daoId)` takes only the 3-char length fee, is
**permissionless** (anyone may pay), and **stacks** — each call adds another full period from the
current expiry (ENS-style), with no owner action and no epoch bump. So the whole community, not just
the DAO, can pre-fund many years of `dao.wei` runway and keep the safety nets alive indefinitely.

---

## 5. Monitoring

- **`dao.wei` expiry** — alert if `expiresAt − now < 30 days` (see §4).
- **Role holders** — watch `Transfer` of `VETO_ROLE`/`EXEC_ROLE` token ids and NameNFT ownership;
  these are the crown jewels.
- **In-flight proposals** — index `ProposalCreated` / `Supported` / `Unsupported`; surface each
  proposal's `convictionOf(id)` vs `threshold` and its `created + executionDelay` unlock time so the
  vetoer sees the warning window. (Proposals are also browsable on-chain as `<id>.dao.wei` with the
  description in the `"description"` text record.)
- **Passing proposals** — alert the vetoer the moment `passed(id)` flips true; they have at least
  `executionDelay` to act.
- **Expired supporters** — a name that expires while backing a live proposal keeps inflating its
  conviction on a stale snapshot until pruned. `unsupport(id, tokenId)` is permissionless once
  `weightOf(tokenId) == 0`, so run a keeper that prunes expired supporters on active proposals (and
  the vetoer can prune-then-watch a proposal back below `threshold` instead of vetoing outright).
  Prune **promptly**: a renewal or re-registration re-activates the name (`weightOf` nonzero again)
  and closes the permissionless-prune window, leaving the stale position removable only by the
  current owner. The window is at least the name's grace period, so a keeper polling daily is ample.
- **Knob changes** — `ThresholdSet` / `AlphaSet` / `ProposalFeeSet` / `ExecutionDelaySet`.
- **God-mode use** — `Rescued` (exec direct calls) and `ProposalVetoed`.

---

## 6. Decentralisation path

`exec.dao.wei` is fully trusted: until relinquished it can drain the treasury or seize WNS. That is
the intended launch-multisig design. To progressively decentralise:

1. Operate with exec as a launch multisig; use `rescue` only for genuine emergencies.
2. As governance proves out, **raise `executionDelay`** (5–7 days is reasonable once you lean on the
   veto rather than `rescue`) and lean on `veto` instead of `rescue`.
3. Relinquish exec. NameNFT is a solady ERC-721 with **no public burn**, and `transferFrom` to
   `address(0)` **reverts** — so you cannot "burn" the role to `address(0)`. Two working paths, both
   using the fact that the DAO owns the parent `dao.wei`:
   - **Collapse into governance (reversible):** a passed proposal calls
     `NameNFT.registerSubdomainFor("exec", dao.wei, address(dao))`, overwriting the holder to the DAO
     itself. Now `executor() == dao`, so `_authed` is satisfied only by a self-call — `rescue` and the
     admin setters become governance-only (a passed proposal), with no standalone key. Governance can
     later reassign exec if needed.
   - **Retire permanently (irreversible):** the exec holder transfers `exec.dao.wei` to a deliberately
     inert, non-zero dead address no one controls. `executor()` then resolves to that address; since
     nobody holds its key, `rescue`/exec-admin are permanently unreachable. (Note `executor()` returns
     the dead address, not `address(0)` — the role still *exists*, it's just uncontrollable.)
   Subdomains don't expire independently (they're bound to `dao.wei`'s epoch), so you can't let exec
   "lapse" — you must overwrite or transfer it. Consider the same for `veto` when ready.

Retiring exec permanently is irreversible — after it, the *only* positive path is conviction
governance. Make sure `threshold`/`alpha`/`executionDelay` are where you want them **first**.

---

## 7. Pre-mainnet checklist

- [ ] Namehash constants match the deployed parent (`dao.wei`) and labels.
- [ ] `alpha` / `threshold` / `proposalFee` / `executionDelay` calibrated (§2) and double-checked
      against `convictionMax`.
- [ ] Bootstrap sequence run and the §1 verifications pass.
- [ ] `dao.wei` renewal keeper live and alerting (§4); consider pre-renewing several years ahead.
- [ ] Prune keeper for expired supporters on live proposals (§5).
- [ ] Monitoring for role/ownership transfers and passing proposals (§5).
- [ ] `_pow`/`_accrue` precision reviewed — see [`test/WeiDAOPrecision.t.sol`](../test/WeiDAOPrecision.t.sol)
      (differential vs solady `powWad`; ~1 ppm agreement).
- [ ] Emergency runbook for exec `rescue` (who signs, under what conditions).
