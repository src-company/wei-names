# WeiDAO deployment — vanity address via CreateX, atomic dao.wei handover

Goal: deploy `WeiDAO` to a **vanity address with a leading 4 zero bytes** (`0x00000000…`) and have it
**own `dao.wei` and reverse-resolve to it** the moment it's deployed — no separate handover tx.

Two on-chain features make this clean:
- The **constructor** pulls `dao.wei` in if the deployer pre-approved this address, then calls
  `setPrimaryName(dao.wei)` so `reverseResolve(dao) == "dao.wei"`. Best-effort: no approval ⇒ deploy
  still succeeds and you hand the name over later.
- A **deterministic deploy** (via canonical **CreateX**) makes the DAO address knowable *before*
  deployment, so you can pre-approve it.

## CREATE2 vs CREATE3 — use CREATE3

| | CREATE2 | **CREATE3 (recommended)** |
|---|---|---|
| Address depends on | deployer + salt + **init code (incl. constructor args)** | deployer + **salt only** |
| Change an arg (alpha/threshold/…) | address moves → **re-mine the vanity** | address unchanged |
| Pre-approve `dao.wei` to it | must re-approve if args change | approve once, tweak args freely |

Because the DAO's constructor args (alpha, threshold, fee, delay) are things you may still be tuning,
**CREATE3** is the right pick: mine the vanity salt once, pre-approve once, and the address is stable
no matter how the args land.

Canonical CreateX (same address on every chain, incl. mainnet):
`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`.

## 1. Mine the vanity salt (off-chain)

A leading 4 zero bytes is ~2³² work — infeasible in a Solidity loop, trivial for a native miner. Use
**createXcrunch** (CreateX-aware, by the CreateX author) or any CREATE3 vanity miner:

```
# builds (salt, address) pairs whose CreateX-CREATE3 address starts with 0x00000000
createxcrunch create3 --factory 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed \
  --caller <YOUR_DEPLOYER_EOA> --matching 00000000XXXX...
```

It prints a `salt` and the resulting `address`. Keep both — the salt goes to the deploy, the address
is what you pre-approve.

> **⚠️ Use a sender-protected salt — REQUIRED, not optional.** You are pre-approving `dao.wei` to an
> address *before* code exists there. If anyone else could deploy to that address first, their
> contract could spend the approval (`transferFrom(owner, attacker, dao.wei)`) and steal the name.
> CreateX prevents this only when the salt's **first 20 bytes equal the deployer address**
> (`--caller <YOUR_DEPLOYER_EOA>` above binds it); CreateX then reverts any deploy from a different
> sender. Do **not** use a zero/opensalt here. Equivalently safe: skip pre-approval entirely and use
> the deploy-then-transfer flow (deploy first, verify the address, *then* `transferFrom` `dao.wei` to
> the DAO) — the constructor pull is best-effort, so a later transfer works just as well.

## 2. Pre-register dao.wei

Before deploying, from the deployer: `commit` → wait `MIN_COMMITMENT_AGE` → `reveal` **`dao`** (pays the
length fee) — you now own `dao.wei`. **You do not mint the roles by hand** — the constructor mints
`veto.dao.wei` and `exec.dao.wei` to `ROLE_HOLDER` itself, on the dao.wei pull (see §3). (They can't
be minted after deploy: once the DAO owns dao.wei, only the DAO could, and there'd be no exec yet.)

## 3. Pre-approve the mined address, then deploy

The script does the approve + `deployCreate3` in one broadcast:

```
WNS_NFT=<NameNFT addr> ALPHA=999998853923940000 THRESHOLD=<...> PROPOSAL_FEE=<wei> \
EXECUTION_DELAY=172800 ROLE_HOLDER=<veto+exec multisig> SALT=<mined salt> DAO_ADDR=<mined address> \
forge script script/DeployWeiDAO.s.sol --rpc-url $RPC --broadcast
```

On success: the DAO is live at `0x00000000…`, **owns `dao.wei`**, `reverseResolve(dao)` is `"dao.wei"`,
and `veto.dao.wei`/`exec.dao.wei` are minted to `ROLE_HOLDER` — all in the one deploy tx. The role
mints are *mandatory after a successful pull* (a fresh dao.wei has no subdomains, so they can't fail
silently — a failure reverts the whole deploy rather than launching with no backstop). If the deployer
doesn't hold `dao.wei` at deploy time, the pull is skipped (no roles either) and you transfer it in
later. **Note:** `ROLE_HOLDER` is a constructor arg but does **not** change the CREATE3 address (that
depends only on factory + salt), so you can tune it without re-mining the vanity.

## 4. Finish the handover — verify BEFORE funding

The DAO recognises `veto`/`exec` roles **only while it owns `dao.wei`** (a role held under a parent the
DAO doesn't own is void, so an outsider can't mint one to seize god-mode). So if the constructor pull
was skipped, `executor()` is `address(0)` and there is *no* exec escape hatch until you transfer
`dao.wei` in. Verify the whole chain before moving any real ETH into the treasury:

0. **Knobs landed correctly** (guards against an `.env` typo baked into the immutable-ish args):
   `dao.nft() == WNS_NFT`, `dao.alpha() == ALPHA`, `dao.threshold() == THRESHOLD`,
   `dao.proposalFee() == PROPOSAL_FEE`, `dao.executionDelay() == EXECUTION_DELAY`. (`nft` is
   immutable — a wrong value here means redeploy, so check it first.)
1. `nft.ownerOf(dao.wei) == dao` — if not, `transferFrom` `dao.wei` to the DAO now (the pull was skipped).
2. `dao.vetoer()` and `dao.executor()` resolve to the intended multisig (non-zero).
3. `nft.reverseResolve(dao) == "dao.wei"` (only if the constructor primary-name set succeeded; else set it).
4. `NameNFT.transferOwnership(dao)`, then `nft.owner() == dao` — DAO governs the fee schedule / `withdraw`.
5. Only once 0–4 pass: fund the treasury.

- See [`LAUNCH.md`](./LAUNCH.md) for calibration and the keep-`dao.wei`-renewed operational note
  (renewal is load-bearing: if `dao.wei` ever lapses, all roles go void until it is re-owned).

## Pilot parameters (recommended starting set)

Context at pilot time: ~1,776 `.wei` names across ~516 wallets (canonical NameNFT
`0x0000000000696760e15f265e828db644a0c242eb`). Roles both held by the launch multisig
`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` (a timelocked multisig — initial **exec** and **veto**).
Every knob below is exec/governance-adjustable later; start conservative and tune from observed use.

```
# deploy .env (see script/DeployWeiDAO.s.sol)
WNS_NFT=0x0000000000696760e15f265e828db644a0c242eb
ALPHA=999998853923940000             # 7-day conviction half-life
THRESHOLD=159446457364257519435776   # convictionMax(0.365 ETH)/2 = W_req 10% of measured live weight (scan below)
PROPOSAL_FEE=2000000000000000        # 0.002 ETH anti-spam
EXECUTION_DELAY=259200               # 3 days  (must exceed the multisig's own timelock)
ROLE_HOLDER=0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2   # veto + exec, minted by the constructor
```

Reasoning:
- **`EXECUTION_DELAY` = 3 days** — the most safety-critical knob. The veto holder is a *timelocked
  multisig*, so a veto is queue-then-execute on the multisig's own delay. The DAO's `executionDelay`
  must exceed **(multisig timelock + human reaction margin)** or a passed proposal could execute
  before the veto lands. If the multisig timelock is 24–48h, 3 days is a safe floor. Never set it
  below the multisig's timelock. (Reclaiming a rogue role via governance is *slow* — conviction has
  to build — so the veto+timelock is the real-time defense; see role mechanics below.)
- **`ALPHA` = 7-day half-life** for a production feel. For faster pilot iteration you can start at a
  3–4 day half-life (`alpha = round(2^(-1/(H·86400))·1e18)`); it's adjustable.
- **`PROPOSAL_FEE` = 0.002 ETH** — deters spam, low enough that pilot users will actually try it.
- **`THRESHOLD`** — `convictionMax(W_req)/2`; with the 7-day alpha, `threshold ≈ W_req × 436,270`.
  `W_req` is the sustained weight that passes a proposal in one half-life. This is now **set from a
  live measurement of the real WNS book** (`ops/weight_scan.py`, run 2026-07-05), not a guess:

  | metric | value |
  |---|---|
  | total live voting weight (active top-level names) | **3.6548 ETH** |
  | active top-level names / subdomains (0-weight) / expired | 1608 / 169 / 0 |
  | weight in 1–4-char names (the short tiers) | ~3.18 ETH (**87%**) |
  | `W_req` = 5% / 10% / 15% of live weight | 0.183 / 0.365 / 0.548 ETH |
  | `THRESHOLD` = 5% / 10% / 15% | 79723228682128759717888 / **159446457364257519435776** / 239169686046386279153664 |

  Weight is heavily concentrated in short names, so a low `W_req` lets a single 1–4-char whale pass
  proposals alone. **10% (`W_req ≈ 0.365 ETH`, the listed `THRESHOLD`)** is the recommended start: it
  clears any plausible single name and forces a real coalition. Drop to 5% if nothing passes in the
  pilot; raise toward 15% if a lone holder dominates. Re-run the scan to recalibrate as the book
  grows — the knob is exec/governance-adjustable.
- **Treasury** — seed small; don't move meaningful ETH in until you've watched proposals go through
  end-to-end. `exec.rescue` is the escape hatch.

### Roles are transferable subdomain NFTs; the DAO can reclaim them
`veto.dao.wei` / `exec.dao.wei` are ordinary ERC-721 subdomains — hand a role off by transferring the
NFT. Because the DAO owns the parent `dao.wei`, it can **reclaim/reassign** any role by re-registering
it: `NameNFT.registerSubdomainFor("exec", dao.wei, newHolder)` overwrites the current holder (via a
passed proposal, or `exec.rescue` while exec is trusted). And if `dao.wei` ever lapses, both roles
lapse to `address(0)` (dead-man's switch) — so keeping `dao.wei` renewed is load-bearing (see
[LAUNCH.md](./LAUNCH.md)).

### Decentralisation path
Hold both roles in the multisig now → transfer `veto.dao.wei` to a broader council once flows are
validated → keep `exec` as the launch multisig → eventually relinquish `exec` (transfer to a
burn/longer-timelock address) once conviction governance is trusted. `dao.wei` ownership means a
botched handoff is always recoverable.

## Notes
- The constructor pull uses `transferFrom` (not safe) + `setPrimaryName`; both are wrapped so a
  missing approval or an inactive name never bricks deployment.
- If you *don't* want a vanity address, skip step 1 and pass any `salt` (still CREATE3, still gets the
  atomic handover). The 4-zero-byte prefix is purely cosmetic/gas-cheaper-calldata.
