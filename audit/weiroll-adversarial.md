# WeiRoll — adversarial review (live deployment)

**Date**: 2026-08-30
**Scope**: `src/WeiRoll.sol` **and the deployed instance** at
[`0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2`](https://etherscan.io/address/0x0000C82AA4D72871568eF3859D2b0E7CF37e45f2),
in its live state at block 25869120. Unlike `audit/weiroll.md`, `NameNFT` and `WeiDAO` were **not**
treated as trusted — the point of this pass was to attack across that boundary.
**Method**: line-by-line re-read, bytecode verification against source, live state pull, and four
executable PoCs (`test/WeiRollAdversarial.t.sol`, `test/ForkWeiRollExecCapture.t.sol`).
**Result**: one genuine code defect (A-4). Everything else is either an accepted trust assumption
or economics. No theft path, no accounting bug, no way to strand or double-spend the pot.

| # | Title | Severity | Disposition |
|---|-------|----------|-------------|
| A-1 | The fee schedule is a live weight lever: exec, or a passed proposal, re-prices later entrants | Info (exec) / Low (governance) | **Accepted — exec is trusted.** Governance half scales with pot size |
| A-2 | Pot exceeds total field weight | Info | **Not an issue — entry is permissionless, so it self-corrects** |
| A-3 | The boost is a flat opt-in 2x, not a governance gate | Info | **Code is sound.** Unenforceable as a signal, unsafe in no way |
| A-4 | `draw()`'s abandon branch silently confiscates `msg.value` | **Low** | The one real defect; integrator note |
| A-5 | `rescue()` can empty the pot under an open round | Low | Invariant note; not reachable before 2027-08-24 |

## Live state at review time

```
round 0, phase Open, roundEnd 2026-09-23T10:42:47Z (deployed 2026-08-24)
115 tickets, distinct names, total weight 0.957922629185692481 ETH
pot 1.050081754296132365 stETH (844880183456313736 shares), reservedShares 0
requestId 0, resets 0, lastRequest = deploy -> rescue unlocks 2027-08-24
roll.wei held by the contract, active to 2027-08-24; top-5 tickets hold 62.6% of odds
11 of 115 tickets (4.0% of weight) took the boost; boost pids in use: 2, 3
```

**Bytecode verified.** The deployed runtime is byte-identical to `src/WeiRoll.sol` compiled at the
repo's settings; the only differing bytes are the four immutable slots, which hold exactly the
documented mainnet `NameNFT` / `WeiDAO` / VRF wrapper / stETH addresses. The deployed `NameNFT` is
likewise byte-identical to `src/NameNFT.sol` apart from the CBOR metadata trailer (compiled with
solc 0.8.33 vs the repo's 0.8.34), so the source-level `GRACE_PERIOD = 90 days > CLAIM_WINDOW`
invariant holds against the live registrar.

---

## A-1 — The fee schedule is a live weight lever *(exec: accepted; governance: Low)*

**Finding.** WeiRoll prices odds off a **mutable oracle controlled by a third party**:

```solidity
return nft.getFee(bytes(label).length) * (exp - block.timestamp) / REGISTRATION_PERIOD;
```

`getFee` reads NameNFT's *live* fee schedule and applies it to an **already-paid** registration
term. `setLengthFees` / `setDefaultFee` are `onlyOwner`, NameNFT's owner is WeiDAO, and WeiDAO's
`rescue()` lets the `exec.dao.wei` holder make any owner call **with no proposal, no conviction
threshold and no timelock**. Neither setter has any cap on the fee value.

Because `enter` snapshots weight into `Ticket.cum`, the fee can be put back in the **same
transaction**: the attacker's ticket keeps the inflated weight, every honest ticket keeps the old
one, and the fee schedule ends the transaction exactly as it started.

```
exec: dao.rescue(nft, setLengthFees([5], [1_000_000 ether]))
      roll.enter(myName, 0)                    // weight frozen at 1e24
      dao.rescue(nft, setLengthFees([5], [0.0005 ether]))   // restored
```

**Proven against live state.** `test/ForkWeiRollExecCapture.t.sol` forks mainnet, binds to the real
contracts, impersonates the real `exec.dao.wei` holder
(`0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`), registers one ordinary 5-character name at the
ordinary 0.0005 ETH price, and settles the actual round-0 field:

```
fair weight of that name : 0.000500000000000000
attacker ticket weight   : 1000000.000000000000000000
odds                     : 9999 / 10000 bps   (99.99%)
fee schedule after       : restored, unchanged
attacker stETH shares    : 0.844880183456313736   <- the entire live pot
cost of the attack       : 0.000500000000000000 ETH + gas
```

`RUN_FORK_EXEC=true forge test --match-contract ForkWeiRollExecCapture -vv`

**Why the earlier review missed it.** `audit/weiroll.md` scoped `NameNFT`/`WeiDAO` as trusted, and
its design-level note states: *"governance-coupled odds (weight snapshotted at entry, so a mid-round
fee change cannot re-weight existing tickets or steer a draw)."* The first half is right and the
conclusion does not follow — **freezing existing tickets is precisely what makes the attack work.**
A fee change cannot re-weight the tickets already in; it re-weights every ticket entered *after*,
which is all an attacker needs.

**Also reachable without the exec role**, more slowly and visibly: a passed proposal calling
`setLengthFees` does the same thing, subject to the conviction threshold and the 3-day
`executionDelay`. `test/WeiRollAdversarial.t.sol::testAFeeRiseRepricesOnlyLaterEntrants` isolates
the pure mechanism — a 100x fee rise leaves the earlier ticket untouched and gives the later one
100x weight.

**Corollary DoS.** The same lever freezes a round: one ticket whose weight brings the running `cum`
to just under `type(uint128).max` makes every subsequent `enter` revert `WeightTooLarge`, locking
out the rest of the field. A fee near `type(uint256).max` instead makes `weightOf` overflow-revert,
which also reverts `state()` for any frontend.

**Disposition — exec half accepted.** `exec.dao.wei` is trusted by design; the PoC above is a
demonstration of that trust's reach, not a vulnerability. Recorded so the reach is written down:
trusting exec over WeiDAO governance also means trusting it over WeiRoll's odds.

**Governance half — costed.** The same setter is reachable without exec, by a passed proposal. At
live parameters (`alpha` 999998853923940000 ⇒ a 7-day half-life, `threshold` 1.594e23,
`executionDelay` 3 days, `proposalFee` 0.002 ETH), passing one needs sustained supporting weight of:

| time held | weight needed |
|---|---|
| 7 days | 0.366 ETH |
| 14 days | 0.244 ETH |
| 30 days | 0.193 ETH |

Weight is bought ~1:1 in registration fees, so a fee-raising proposal costs roughly **0.2–0.37 ETH
of names held for 1–4 weeks** — against a live pot of 1.05 stETH. It is public for that whole period
and cancellable through `ConvictionVeto` (`0x0000005260725EEe99704957218d4045A50C2051`, live vetoer;
note the README still lists the multisig here), which uses WeiDAO's *same* threshold — so stopping
one costs the same mobilization as passing one.

The practical rule this yields: **the fee lever is safe while the pot stays below the cost of passing
a proposal.** It is currently above it. That coupling is permanent (both contracts are immutable), so
it is a pot-sizing constraint, not something a code change can retire. Watching
`NameNFT.LengthFeeChanged` / `DefaultFeeChanged` for the duration of an open round makes it visible;
an inflated ticket is also visible directly in `ticketsIn`.

---

## A-2 — Pot above total field weight *(informational, self-correcting)*

Weight is bought at ~1 ETH of weight per 1 ETH of fees (`weightOf` is the pro-rated registration
fee, and `renew()` is uncapped), so whenever the pot exceeds the field's total weight, buying in is
positive-EV. Live at review time: pot 1.0501 stETH vs total weight 0.9579 ETH.

**Not an issue.** `enter` is permissionless and stays open for the full `ROUND_LENGTH`, so a
positive-EV pot is an invitation, not an exploit — the response is to join, and each entry raises
the denominator until the edge is gone. That is the mechanism working. Recorded only because it
does not converge on its own if nobody is watching, and because of one structural detail:

- **Last-block entry.** Whoever enters in the final block before `roundEnd` sees the completed field
  and can size their stake against it with no risk of being diluted. Everyone else commits under
  uncertainty. The edge is small, mempool-visible, and bounded by the same 1:1 weight cost — but it
  is real and it always accrues to the latest entrant.

## A-3 — Is the boost sound? *(informational — yes, as code)*

**As code: sound.** Every path was checked and none of them is unsafe.

- The 2x is applied exactly once, at entry, and baked into `Ticket.cum`. `AlreadyEntered` makes it
  one ticket per name per round, so it cannot be stacked.
- It cannot be obtained without actually supporting: `supportOf` reads `_support[id][tokenId]`,
  which only `WeiDAO.support` writes, and that requires `ownerOf(tokenId) == msg.sender` — the same
  owner check `enter` makes. No third party can boost someone else's ticket, and no one can boost
  without owning the name.
- An out-of-range `boostPid` cannot bypass it: `dao.proposals(pid)` returns zeros for an unknown id,
  which passes the executed/vetoed test, but `supportOf` is then 0 and `enter` reverts `NotBacking`.
- `weight += weight * BOOST_BPS / 10_000` is exactly 2x, and the `cum > type(uint128).max` guard
  catches the doubled value before it is truncated into the ticket.
- Nothing after entry reads the boost. A proposal executed, vetoed, or unsupported later has no
  effect on the ticket or the payout — which is what M-1 fixed, and it holds.
- `boostPid` is stored and emitted but never used in logic, so its `uint128` truncation guard is
  belt-and-braces rather than load-bearing.

**What it is not: a governance gate.** `support` costs only gas and `unsupport` is unrestricted for
the owner, so `support → enter → unsupport` works in a single transaction
(`testBoostCanBeSupportedAndDroppedInOneTx`: ends with `supportOf == 0` and the ticket still
carrying the 2x). `propose` costs 0.002 ETH, so an attacker can even mint their own proposal to back.
The boost therefore cannot enforce sustained support — it is a flat 2x available to every entrant
who asks for it.

That costs nothing and risks nothing: a multiplier everyone can take cancels in the odds ratio. It
only bites as a differential, and live that differential is wide — **11 of 115 tickets, 4.0% of
weight, took it**, so 96% of the field is entering at half the weight it could have. The dapp's
auto-detect (22cb659) closes this for its own users; direct callers are on their own.

## A-4 — `draw()`'s abandon branch silently confiscates `msg.value` *(Low)*

**Finding.** The abandon branch returns before the `msg.value < price` check and before any refund:

```solidity
if (!priced || _tickets[r].length < 2) {
    round = r + 1; roundEnd = block.timestamp + ROUND_LENGTH;
    emit RoundOpened(r + 1, roundEnd);
    return;                                  // msg.value is neither refunded nor staked
}
```

The caller's ETH stays as raw native balance: outside the share-denominated pot, invisible to
`pot()`, with **no `Funded` event**. Only a later `stake()` sweeps it in, crediting it to whoever
calls that. This breaks the invariant `receive()`'s own natspec asserts — *"an indexer summing these
should reconcile with {pot}"*.

Realistic trigger: the VRF wrapper's LINK/ETH feed goes stale between the caller's `drawPrice()`
`eth_call` and their transaction landing, so a draw quoted as settling takes the abandon branch
instead. Proven in `testAbandonBranchSilentlyConfiscatesTheDrawFee`.

**Disposition.** Immutable. Integrator note for `Integrators.md` / the dapp: check `drawSettles()`
and send `value: 0` when it is false; a `draw()` that abandons should never carry value.

---

## A-5 — `rescue()` can empty the pot under an open round with entries *(Low)*

**Finding.** `draw()` reasons that *"a round only opens on a non-empty pot, and nothing between
opening and settling can shrink it, so a settled round is always claimable."* `rescue()` shrinks it:
it sweeps `sharesOf - reservedShares` regardless of `roundEnd`, and `lastRequest` only advances on a
successful VRF request. A round left undrawn for `RESCUE_TIMEOUT` (365 days) — `draw()` is
permissionless, so nobody is obliged to call it — can therefore be rescued out from under its own
entrants. The next `draw()` then pays a real VRF fee to settle a round whose prize is 0, after which
`claim` reverts `NotWinner` and `rollOver` reverts too, and the round shows `settled: true,
resolved: true` with a winner and nothing to collect.

**Not reachable on the current round**: rescue unlocks 2027-08-24 and round 0 ends 2026-09-23. It is
reachable on any future round that goes undrawn for a year.

**Disposition.** Immutable, and a strictly better outcome than the pot being permanently stuck (the
funds go home to WeiDAO). Worth recording that the "settled ⇒ non-empty prize" invariant (I-3 in the
earlier review) has this one exception, and that the operational answer is the same as A-1's: draw
rounds promptly.

---

## Re-verified clean

- Deployed runtime bytecode matches `src/WeiRoll.sol` exactly (immutables aside); deployed `NameNFT`
  matches `src/NameNFT.sol` exactly (metadata trailer aside).
- `reservedShares ≤ sharesOf(this)` is maintained on every path; `rescue` only ever touches the
  unreserved remainder, and each `prizeSharesOf` decrement is paired with a `reservedShares` one.
- The VRF callback cannot be reached with fewer than 2 tickets — `round` only advances while
  `requestId == 0` — so `t[t.length - 1]` is safe and the modulo has a non-zero divisor.
- Stale fulfilments are rejected by the `_requestId != requestId` check; the
  `resetRequest` → `draw` → late-callback race is safe (it burns the old randomness, never applies it).
- The live registrar blocks transfers of inactive names (`_beforeTokenTransfer`), so a winner in
  grace still holds the name and `claim`'s single ownership test holds.
- `ticketsIn`'s `offset + limit` cannot overflow.
- `receive()` and `resetRequest()` are unguarded but reachable during a guarded call only in states
  where they are no-ops or revert.
- 368 unit tests pass, including the 4 new PoCs.
