# Audit request — WeiDAO

You are auditing a Solidity smart contract before a pilot mainnet deployment. Review it for
**safety** and **logical soundness**, and separately review its **embedded on-chain dapp** for
correctness and performance. Be adversarial and concrete: assume real ETH and real WNS names are at
stake.

## What it is

`WeiDAO` is a **conviction-voting DAO and treasury** for the Wei Name Service (WNS). WNS name
holders steer the treasury (ETH + NFTs) by supporting proposals; there are no voting deadlines and no
"against" vote. It also serves its own frontend on-chain: `html()` returns a self-contained HTML page
rendered live from chain state (ERC-8244 / ERC-4804-5219), and because the DAO owns `dao.wei` the name
resolves to the contract.

## Scope

- **Primary:** `src/WeiDAO.sol` — the full contract, including the embedded dapp string constants
  (`_DEFAULT_SHELL` CSS/HTML and `_JS` wallet bridge) and the `request()`/`html()` renderers.
- **Dependency (read for interaction only, not a full audit):** `src/NameNFT.sol` — the WNS
  registry the DAO calls (`records`, `ownerOf`, `getFee`, `primaryName`, `getFullName`,
  `registerSubdomainFor`, `setText`, `setAddr`, `setPrimaryName`, `transferFrom`, `resolve`,
  `reverseResolve`, `computeId`). Verify WeiDAO uses this ABI correctly and makes no unsafe
  assumptions about it.
- **Tests** (for intent, not correctness): `test/WeiDAO*.t.sol`.

## Design intent — please do NOT report these as bugs (they are deliberate)

- **Support-only.** Opposition is expressed by withholding/withdrawing support and, ultimately, the
  veto. There is intentionally no "against".
- **Exec is fully trusted until relinquished.** The `exec.dao.wei` holder is a god-mode launch
  operator (can `rescue` = arbitrary call, `veto`, and call admin setters directly). This is the
  intended launch-multisig design; flag *unintended* ways to gain this power, not the power itself.
- **Weight is snapshotted at `support` time.** It does not track later weight decay; an expired
  supporting name can be pruned by anyone (`unsupport` is permissionless when `weightOf == 0`).
- **Best-effort proposal naming.** `propose` tries to mint `<id>.dao.wei` and write resolver records;
  failure is swallowed and must never block proposal creation.
- **Constructor pull is best-effort.** If the deployer pre-approved the (deterministic) DAO address
  for `dao.wei`, the constructor pulls it in and sets the primary name; otherwise deployment still
  succeeds.

## Core invariants to check

1. **Conviction math** (`_accrue`, `_pow`, `_sync`, `convictionMax`, `_passWeight`): does it correctly
   implement `conviction' = conviction·α^Δ + w·(1−α^Δ)/(1−α)`? Check for overflow, precision loss,
   div-by-zero, and whether a flash-minted / freshly-acquired name can execute a proposal faster than
   the intended ramp + `executionDelay` timelock allows.
2. **Weight = ETH sunk in WNS** (`weightOf`): `getFee(byteLength)·(expiresAt−now)/365d`, zero for
   subdomains and expired names. Confirm there is **no way to manufacture voting weight cheaply** —
   in particular that subdomains (e.g. `a.b.wei`, nested) always yield zero, so a short-name holder
   cannot mint fake weight.
3. **Access control**: `execute` (permissionless, gated on conviction ≥ threshold + timelock),
   `veto`/`rescue` (role-gated), admin setters (`_authed` = self-call or exec). Confirm `Multicallable`
   (delegatecall-to-self) cannot forge `msg.sender == address(this)` or double-spend `msg.value`.
4. **Reentrancy / fund safety**: `execute` and `rescue` make arbitrary external calls with treasury
   ETH. Confirm effects-before-interaction and that no reentrant path drains beyond what governance
   authorized.
5. **Roles as WNS subdomains** (`_holder`, `vetoer`, `executor`): roles resolve live from
   `veto.dao.wei` / `exec.dao.wei`; they must lapse to `address(0)` if `dao.wei` expires or is
   re-registered (dead-man's switch via `parentEpoch`). Confirm the DAO (owner of `dao.wei`) can always
   reclaim/reassign a role, and that a role holder cannot escalate beyond their intended power.
6. **Timelock** (`executionDelay`, capped at `MAX_EXECUTION_DELAY`): a passed proposal cannot execute
   before `created + executionDelay`, read live. Confirm no whale weight can compress this window.
7. **Knob bounds**: `alpha ∈ (0, 1e18)`, `threshold != 0`, delay ≤ cap — enforced on every write.

## Embedded dapp — correctness & performance

The returned page IS the DAO's UI; users transact directly from it. Review the `_JS` wallet bridge and
the renderers:

- **ABI hand-encoding correctness**: `propose(address,uint256,bytes,string)` (dynamic offsets),
  `support`/`unsupport`/`execute`, and the `Multicallable` `bytes[]` batch encoder (`mc`). A wrong
  offset or selector would craft a malformed or wrong transaction.
- **Function selectors**: all tx and read selectors (computeId, primaryName, getFullName, resolve,
  reverseResolve, weightOf) must match the deployed ABIs.
- **Value handling**: decimal-ETH → wei parsing (`wei()`), and that `propose` sends only `proposalFee`
  as `msg.value` (the proposal's `value` is forwarded from the treasury at execution).
- **Rendering safety**: user-controlled strings (proposal descriptions read from name records) must be
  HTML-escaped — check for XSS/injection into `html()` output.
- **View robustness / gas**: `html()` and `request()` are `view` but loop over proposals and make
  external calls; confirm they cannot revert on normal input (e.g. un-named proposals, unminted roles,
  a lapsed `dao.wei`) and stay bounded (pagination via `?from=`, capped page size).
- **Self-containment & UX**: no external network/CDN dependencies, theme-aware, mobile-responsive, and
  the connect / support / unsupport / execute / propose flows are wired to working calls.

## Deployment context

Deployed via canonical **CreateX CREATE3** to a vanity address with a leading 4 zero bytes; the
constructor optionally pulls in `dao.wei`. Consider anything specific to deterministic deployment and
the constructor handover (e.g. front-running the pre-approval, griefing the pull).

## Deliverable

- A list of findings ranked by severity (Critical / High / Medium / Low / Informational), each with a
  concrete failure scenario (inputs → wrong outcome) and a suggested fix.
- A short overall opinion on whether the conviction-voting design is logically sound for its stated
  purpose (steering a WNS treasury with sybil-resistant, deadline-free governance).
- Confirmation (or refutation) that the embedded dapp will drive correct on-chain transactions with no
  bugs or blockers for its supported functions at launch.
