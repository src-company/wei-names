# WeiTerms — security review of the live multi-term mechanism

**Date**: 2026-09-08
**Scope**: `src/WeiTerms.sol` **and the deployed instance** at
[`0x0000002ba1dd65dBe75388F6672826FaC6Ec69fe`](https://etherscan.io/address/0x0000002ba1dd65dBe75388F6672826FaC6Ec69fe),
plus the dapp integration that drives it — the commit/reveal path in `dapp/index.html`
(`doCommit` / `doReveal` / `displayPending`) and the renewal path (`initRenewTerms` / `doRenew`).
Reviewed at block 25934031.
**Method**: line-by-line re-read of the helper and of every `NameNFT` function it touches
(`reveal`, `renew`, `getFee`, `records`, `_validateAndNormalize`, `_beforeTokenTransfer`),
bytecode verification against source, live state pull, eleven new executable PoCs
(`test/WeiTermsAdversarial.t.sol`), and the fourteen live-fork cases in `test/ForkMultiYear.t.sol`
run for real against mainnet.
**Result**: **green light for continued production use.** No theft path, no accounting bug, no way
to strand a name or a payment, and no reentrancy. Every finding below is either on the dapp side —
where all four are now fixed — or an accepted, documented property of an ownerless helper.

| # | Title | Severity | Disposition |
|---|-------|----------|-------------|
| T-1 | The dapp re-quotes at send time, so the helper's price protection never engages | **Low** | **Fixed** — the agreed price is carried and compared |
| T-2 | A commitment's price was not shown across the window it sits in | **Low** (UX/safety) | **Fixed** — the pending panel prices itself |
| T-3 | `pending.terms` went from storage into `msg.value` untrusted | Info | **Fixed** — refused, not clamped |
| T-4 | The reveal delivered to the connected address, not the bound one | Info | **Fixed** — delivers to the address the secret derives from |
| T-5 | `quote`/`quoteMany` answer for a token that does not exist | Info | **Integrator note** — live-confirmed, safe-fails on spend |
| T-6 | `sweep` is permissionless; stray ETH is anyone's | Info | **Accepted by design** — pinned that a caller's change is never in that pool |
| T-7 | `renewMany` has no basket cap; repeated entries compound | Info | **Accepted** — bounded by `msg.value`, arithmetic pinned to 625 years |
| T-8 | Delivery is a plain `transferFrom`; `to` must be able to hold an ERC-721 | Info | **Accepted by design** — deliberate, and pinned |

## Live state at review time

```
WeiTerms  0x0000002ba1dd65dBe75388F6672826FaC6Ec69fe   MAX_TERMS 25, balance 0
NameNFT   0x0000000000696760E15f265e828DB644A0c242EB   owner 0x00000007988A79d16cf76B5dc4cF54dc3Af24936
fee schedule: 1 char 0.5 ETH/yr · 3 char 0.05 ETH/yr · 5+ char 0.0005 ETH/yr
dapp offers 10 terms; the contract allows 25
```

**Bytecode verified.** The deployed `WeiTerms` runtime is **byte-identical** to `src/WeiTerms.sol`
compiled at the repo's settings — including the CBOR metadata trailer, so the source is the live
contract down to the compiler input. The deployed `NameNFT` is byte-identical apart from that
trailer (solc 0.8.33 against the repo's 0.8.34), which is why the unit PoCs, which deploy the
registry from source to its mainnet address, exercise real registry semantics.

**Because the helper is deployed and non-upgradeable, `src/WeiTerms.sol` was deliberately left
untouched** — any edit, comments included, changes the metadata hash and breaks that verification.
All hardening from this pass is in the dapp.

---

## The boundary, and why it is narrow

`NameNFT.renew()` ignores `msg.sender`. Anyone may extend anyone's registration, and renewal
cannot move, approve, expire or reclaim a name. So the helper needs — and holds — no authority
over anything: no owner, no storage, no custody beyond one instruction inside `register`. The
entire attack surface is **the ETH attached to a call**, and three properties bound it:

- prices are read from the registry inside the call, never taken from the caller;
- spending is capped by `msg.value`, checked before each name's renewals are paid for;
- change is `msg.value - spent`, never the balance.

That last one matters more than it looks: refunding the balance instead would let anyone brick an
exact-paying caller by sending it 1 wei. The existing suite pins it; this pass attacked it.

## What was attacked and did not break

Eleven PoCs in `test/WeiTermsAdversarial.t.sol`. The existing 40-case suite had **no reentrancy
coverage at all**, which was the largest gap in the evidence, so that is where this pass started.

**Reentrancy through the refund.** `_refund` hands control to `msg.sender` with all remaining gas.
It is the only place attacker code runs inside a call — `onERC721Received` is `view` and so cannot
write state or move value, `NameNFT._beforeTokenTransfer` makes no external call, and the renew
loop pays exact value so the registry never refunds into the helper mid-loop. Four probes re-enter
from that callback:

- a zero-value re-entry into `renew` buys nothing (`InsufficientFee`) — spending is capped by the
  *nested* call's `msg.value`, which is zero;
- likewise into `renewMany`;
- `sweep` from inside the callback finds nothing to take: by the time caller code runs, the change
  has already left the contract, so the caller's own money is never in the sweepable pool;
- a *funded* re-entry is simply a second purchase, and the PoC asserts exactly two fees left the
  attacker's wallet for the two terms it bought.

**Balance-delta accounting in `register`.** `spent = before - address(this).balance` is measured,
not predicted, which is what makes a decayed premium price itself correctly. It can only be
skewed by ETH arriving or leaving during `reveal()`, and nothing can do either: the only inbound
path is `receive()`, which runs no attacker code, and the only outbound path is `sweep`, which
needs a call that nothing in that window can make. A stray balance is neither spent nor handed to
an overpayer (pinned both ways).

**Fee-tier divergence in `register`.** The helper budgets renewals at `getFee(bytes(label).length)`
— the *raw* calldata label — while `NameNFT.renew` charges `getFee(bytes(record.label).length)` —
the *normalized* one. A divergence would have silently stranded the difference in the contract on
every multi-year registration, because `renew` refunds overpayment to the helper and `_refund`
would not have counted it. It does not diverge: `_validateAndNormalize` allocates
`new bytes(b.length)` and only case-folds ASCII, so it is length-preserving by construction, and
rejects rather than rewrites everything else.

**Expiry arithmetic.** 25 terms per entry with no cap on the basket means a single `renewMany` can
push a name 625 years out. `NameNFT.renew` does `record.expiresAt + uint64(REGISTRATION_PERIOD)`
under checked arithmetic; the PoC drives the full 25×25 and asserts the expiry lands exactly.

**Atomicity.** A basket containing one unrenewable name (a subdomain) takes none of the caller's
money — `renewMany` is all-or-nothing, so it cannot leave a partial extension behind.

**Delivery.** A recipient whose `onERC721Received` reverts still receives the name, and the helper
ends the call holding no token, no approval and no operator rights (T-8, below).

**The commitment's owner field.** `makeCommitment(label, owner, secret)` looks like a delegation
field and is not one. `commit()` stores a hash against a timestamp and never records who called
it; `reveal()` recomputes the commitment from **`msg.sender`**. So naming `WeiTerms` there does
not hand it authority — it *restricts* settlement to it, and that restriction is what makes the
reveal safe to broadcast. Two PoCs: an onlooker holding the entire leaked reveal — label, inner
secret, recipient, term count — cannot settle it directly at the registry, because
`keccak(label, attacker, secret)` is a different hash, and cannot redirect it through the helper
either; and the commitment survives both attempts intact. Separately, because `commit()` is
permissionless and records nothing about its caller, a third party may pay to submit someone
else's commitment and it changes neither who can settle it nor where the name lands. There is no
trust step in the forwarding itself: the only reveal that succeeds is one whose `to` matches the
bound secret, and the line after the mint transfers to that same `to`.

**Metadata across a renewal.** Every resolver record — `addr`, `contenthash`, `text`, per-coin
addresses — is stored keyed by `recordVersion[tokenId]`, and that counter moves in exactly one
place: `_register`, when a name that lapsed past grace is taken by someone new. `NameNFT.renew()`
writes a single field, `expiresAt`. So a renewal cannot invalidate a record by construction, and
three PoCs drive it rather than assert it: the full record surface plus a subdomain and a display
name survives a ten-year top-up *paid by a stranger*; the same survives a five-year `renewMany`
on a name sitting in grace, which is the branch where the dapp offers renewal as the only
remaining action; and the boundary is pinned from the other side too — a name allowed to lapse
past grace and re-registered by someone else does **not** carry the previous holder's records
over, which is the one place the version bump is meant to happen. (`resolve` falls back to the
holder when no addr record is set, so a re-registered name reads as the new owner rather than
zero.)

**Live behaviour.** `test/ForkMultiYear.t.sol` was run against mainnet with `RUN_FORK_TERMS=true`
— it self-skips otherwise, and a bare `forge test` reports it as passing while executing nothing,
which is worth knowing. All fourteen cases pass with real gas, including custody across a live
multi-year renewal of a name held by a third party.

---

## T-1 — The dapp re-quotes at send time, so the helper's price protection never engages *(Low — fixed)*

**Finding.** `WeiTerms` is documented to protect a caller against a price moved under a pending
transaction: *"send exactly the quote and a price raised under the pending transaction reverts
it."* That is true, and it is the caller's whole defence — but it only engages if the caller sends
**the price it was quoted**. The dapp did not. Both paths re-read `getFee` immediately before
signing and sent whatever came back:

```js
const total = termsTotal(results[0][0], results[1][0], terms);   // doReveal, fresh read
const fee   = await rc.getFee(byteLength(currentTokenName));     // doRenew, fresh read
... { value: fee * BigInt(terms) }
```

Nothing reverts, because the value sent always matches the price. The user simply pays the new
one. Two things sharpen this for the multi-term feature specifically:

- **the term count multiplies it.** A fee change is amplified by up to ten in the dapp, twenty-five
  on-chain. The commit/reveal window is up to 24 hours (`MAX_COMMITMENT_AGE`), and the term count
  is frozen at commit time while the price is not;
- **the tiers are steep.** 0.5 ETH/yr at one character against 0.0005 at five — three orders of
  magnitude — so the amounts in play at the short end are real.

This needs the registry owner to move `defaultFee` or `setLengthFees`, so it is an operator-trust
and stale-quote issue rather than an external attack. It is still the difference between the
helper's price protection being armed and being decorative.

**Fix.** The price the user was looking at is now recorded on the pending commitment
(`quotedWei`) and compared before the reveal; `doRenew` compares the fresh fee against the one the
open panel was priced from. Either way the transaction stops once, the new price is shown, and a
second press accepts it — fail closed with disclosure, rather than silently overpay. Commitments
made before this shipped carry no recorded price and are never blocked.

## T-2 — A commitment's price was not shown across the window it sits in *(Low, UX/safety — fixed)*

**Finding.** Commit and reveal are at least 60 seconds and up to 24 hours apart. The pending panel
a user comes back to said `Registering for 10 years — paid in ETH` and gave no amount. For a
one-character name that is 5 ETH, and the first time the number appears is in the wallet
confirmation.

**Fix.** The panel now carries the price alongside the term count. It uses the figure recorded at
commit time, so it costs no RPC, and T-1's comparison is what keeps that figure honest.

## T-3 — `pending.terms` went from storage into `msg.value` untrusted *(Info — fixed)*

**Finding.** `doReveal` read `const terms = pending.terms || 1` straight out of `localStorage` and
multiplied it into the value sent. The term count is folded into the commitment secret on-chain,
so a wrong one cannot *buy* anything — the reveal reverts. But it is also what prices the
transaction, so a corrupted entry could put an arbitrary figure in front of the user's wallet
before failing. `validTerms()` guarded the commit path; nothing guarded the read back.

**Fix.** `readPendingTerms()` refuses anything that is not an integer in `1..MAX_TERMS` and the
reveal stops with a clear message. Refused rather than clamped deliberately: the commitment binds
one count, so quietly substituting another would spend gas on a reveal that cannot match.

## T-4 — The reveal delivered to the connected address, not the bound one *(Info — fixed)*

**Finding.** The commitment secret derives from `(innerSecret, pending.owner, terms)`, but the
call passed `_connectedAddress` as the recipient. A guard rejects a mismatch when both are set, so
the normal path was correct; the edge where `_connectedAddress` is unset skipped the guard and
sent `undefined`. Safe-failing either way — a mismatched recipient derives a different secret and
matches no commitment — but there is no reason for the two values to be able to disagree.

**Fix.** The reveal delivers to `pending.owner`, the address the secret is actually derived from.

## T-5 — `quote`/`quoteMany` answer for a token that does not exist *(Info — integrator note)*

**Finding.** `quote` reads `NFT.records(tokenId)` without checking the record exists. An
unregistered id has an empty label, so it prices at the zero-length tier and returns a confident,
wrong number. Live:

```
quote(0, 10) = 0.005 ETH        # a token that has never existed
```

Nothing can be lost through it — paying that quote reverts inside `NameNFT.renew` with
`TokenDoesNotExist`, and `renewMany` is all-or-nothing — so this is a *safe-fail*, not a
mispricing. It matters only to an integrator who treats a non-zero quote as evidence a name is
renewable. The dapp is unaffected: it only quotes names it has just read a record for, and the
renew control is gated on `isTopLevel`.

**Disposition.** Not fixable on-chain — the helper is deployed and non-upgradeable. Recorded here
and pinned by `test_QuoteAnswersForATokenThatDoesNotExist`, which asserts both halves: the quote
answers, and the spend reverts. Integrators should check `expiresAt(tokenId) != 0` before
trusting a quote.

## T-6 — `sweep` is permissionless *(Info — accepted by design)*

Anyone may send the helper's whole balance anywhere. This is deliberate and correct for an
ownerless contract: a successful call leaves nothing behind, so a balance is always stray, and
`sweep` is how it gets out of a contract with no owner to rescue it. The property that has to hold
is that a *caller's* money is never sitting in that pool while someone else can call `sweep`, and
that is now pinned directly — `test_SweepFromTheRefundCallbackCannotTakeTheChange` sweeps to a
third party from inside the refund callback and asserts the change arrived in full and the sweep
found nothing.

## T-7 — `renewMany` has no basket cap *(Info — accepted)*

`MAX_TERMS` bounds each entry at 25, but nothing bounds the array, and repeating a name across
entries compounds it. The source comment says so. It is bounded by `msg.value` in every case —
the running total is checked before each name's renewals are paid for — and by gas beyond that.
`test_DeepCompoundingDoesNotOverflowTheExpiry` drives 25 entries × 25 terms on one name and
asserts the expiry lands exactly 625 years out, well inside `uint64`.

## T-8 — Delivery is a plain `transferFrom` *(Info — accepted by design)*

`register` delivers with `transferFrom`, not `safeTransferFrom`. That is the right call: the safe
variant would hand `to` a callback able to revert or re-enter the settlement, and `to` is chosen by
whoever made the commitment. The cost is that `to` is delivered to unconditionally and must be able
to hold an ERC-721. `test_ARecipientThatRefusesERC721StillGetsTheName` pins it, and
`test_RegisterNeverLeavesTheNameHere` pins the other half — the helper ends the call holding no
token, no approval and no operator rights over what it just paid for.

---

## Verdict

**Continue in production.** The contract is sound and the deployed bytecode is provably the
reviewed source. Its design choice — an ownerless, storage-less envelope around a permissionless
`renew()` — keeps the blast radius of any bug at "the ETH attached to one call", and every path by
which that ETH could be diverted was attacked and held.

The findings that had teeth were on the dapp side, and they shared a shape: the contract offers a
price guarantee the client was not taking up. That is fixed. The remaining items are properties to
know about rather than defects to fix, and each is now pinned by a test that fails loudly if it
ever stops being true.

**Coverage after this pass**: 56 unit cases (40 existing + 16 adversarial), 14 live-fork cases,
56 dapp cases (35 existing + 21 for the new guards).
