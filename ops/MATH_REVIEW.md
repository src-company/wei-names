# WeiDAO — formal review of the conviction fixed-point math

Scope: `_pow`, `_accrue`, `_sync`, `convictionMax`, `_passWeight` in `src/WeiDAO.sol`. This is the
"review the fixed-point math before large ETH" item the contract's own caveats flag. Method: closed-
form derivation + error/overflow analysis, cross-checked by a property/differential suite
(`test/WeiDAOPrecision.t.sol`, run at 5,000 fuzz iterations per differential property, stable across
seeds). No SMT/theorem-prover was available in-tree, so the tight bounds below are *derived
analytically and confirmed empirically*, not machine-proved — a Halmos/Certora pass is still the
gold standard if you want one.

## 1. Model

Support with constant weight `w` accrues conviction by the recurrence

```
c' = c·α^Δ + w·(1 − α^Δ)/(1 − α)          (α ∈ (0,1), Δ = seconds since last sync)
```

Closed form from `c₀ = 0` under constant `w`: `c(t) = w·(1 − α^t)/(1 − α)`, monotone increasing with
asymptote (steady state) `c(∞) = w/(1 − α) = convictionMax(w)`. Calibration: `threshold =
convictionMax(W_req)/2` ⇒ sustained weight `W_req` reaches `threshold` in exactly one half-life.

Scaled representation (`SCALE = 1e18`): `alpha = α·SCALE`, and `_pow(alpha, Δ)` returns `a ≈ α^Δ·SCALE`.
Then `_accrue` computes `c·a/SCALE + w·(SCALE − a)/(SCALE − alpha)`, which is the recurrence term-for-
term (verified: `(1−α^Δ)/(1−α) = (SCALE−a)/(SCALE−alpha)`).

## 2. `_pow` — correctness, range, error

Algorithm: exponentiation-by-squaring with truncating fixed-point multiply `m(x,y)=⌊x·y/SCALE⌋`.

- **Range.** For `base ≤ SCALE`, every partial product `≤ SCALE`, so `_pow ≤ SCALE` always — decay can
  never amplify (**P1**, fuzzed). `x^0 = SCALE`, `x^1 = x`, `1^n = SCALE` (exact, anchored).
- **Direction.** Each `m` floors, so `a = _pow(alpha, Δ) ≤ α^Δ·SCALE` — `α^Δ` is *under*-estimated.
- **Error bound.** `Δ ≤ 2³²` ⇒ ≤ 64 truncations along the squaring/accumulation chain, each losing
  < 1 wei, propagating multiplicatively. The resulting relative error is ≤ ~1 ppm over `α ∈ [0.9, 1)`
  and `Δ ≤ 3650 d`, confirmed against solady `powWad` (an independent `exp(Δ·ln α)`): agreement to
  1 ppm relative where the value is non-negligible, and to 1e6 wei absolute deep in the decay tail
  where both collapse toward 0 (`testFuzz_PowMatchesReference`). Monotone non-increasing in `Δ`.

## 3. `_accrue` — rounding direction (the security-relevant part)

Because `a` under-estimates `α^Δ`:

- **Decay term** `⌊c·a/SCALE⌋`: `a` low ⇒ term low ⇒ existing conviction decays *slightly faster*
  (conservative — never over-retains).
- **Accrual term** `⌊w·(SCALE−a)/(SCALE−alpha)⌋`: `a` low ⇒ `(SCALE−a)` high ⇒ term *slightly high*.

So for a fresh proposal (`c = 0`) conviction is over-stated by at most
`w·Δa/(SCALE−alpha) = convictionMax(w)·(Δa/SCALE) ≤ convictionMax(w)·10⁻⁶` — i.e. **a proposal can
cross `threshold` at most ~1 ppm early in conviction terms** (a few ppm early in *time*), never late,
never unbounded. This is backstopped absolutely two ways: conviction is hard-bounded by
`convictionMax` (§4), and execution is floored by `executionDelay` regardless of conviction. For
`c > 0` the two directional biases oppose and cancel at the asymptote: `convictionMax` is a fixed
point of `_accrue` to ±2 wei (`testConvictionMaxIsFixedPoint`).

`testFuzz_AccrueMatchesReferenceAcrossAlpha` bounds the *total* deviation from an independent high-
precision reference (powWad α^Δ + full-width `mulDiv`) to `≤ (c + convictionMax)·10⁻⁶ + 2 wei`,
two-sided, across the whole adjustable alpha range — so both over- and under-crediting are pinned.

## 4. Invariants (each mapped to a test)

| Property | Statement | Test |
|---|---|---|
| Boundedness | `_accrue(0,w,Δ) ≤ convictionMax(w)` and starting at the asymptote stays there (±1) | `testFuzz_AccrueBoundedByMax`, `testFuzz_NoOverflowAtExtremes` |
| Flash-mint resistance | `_accrue(c,w,0) = c` — fresh weight adds **zero** conviction instantly; the ramp is `w·(1−α^Δ)/(1−α)`, never a jump | `testAccrueZeroTimeAddsNothing` |
| Monotone in time | `Δ₁ ≤ Δ₂ ⇒ _accrue(0,w,Δ₁) ≤ _accrue(0,w,Δ₂)` | `testFuzz_AccrueMonotoneInTime` |
| Monotone in weight | `w₁ ≤ w₂ ⇒ _accrue(0,w₁,Δ) ≤ _accrue(0,w₂,Δ)` | `testFuzz_AccrueMonotoneInWeight` |
| Path independence | syncing once over `Δ₁+Δ₂` ≈ syncing at `Δ₁` then `Δ₂` (to ~ppm) — so conviction does not depend on how often `support`/`unsupport` call `_sync` | `testFuzz_AccrueSemigroup` |
| Half-life calibration | one half-life of sustained `w` reaches ½·convictionMax | `testAccrueHalfLifeReachesHalfMax` |

Path independence is what makes the snapshot-at-`lastUpdate` design sound: an attacker cannot change a
proposal's conviction by choosing when (or how often) syncs happen.

## 5. Overflow analysis (no reverts in the supported domain)

`α < SCALE` is enforced at construction and in `setAlpha`, so `SCALE − alpha ≥ 1` — no div-by-zero.
Products (checked arithmetic; a revert would be a DoS, not a wrong value):

- `_pow`: operands `≤ SCALE`, product `≤ 1e36 ≪ 2²⁵⁶` (≈1.16e77). Safe for all inputs.
- `convictionMax = ⌊w·SCALE/(SCALE−alpha)⌋`: `w·SCALE` overflows only at `w > 2²⁵⁶/1e18 ≈ 1.16e59`.
- `_accrue` decay term `c·a`: worst case `alpha → SCALE−1` ⇒ `convictionMax = w·SCALE`, so `c ≤ w·1e18`
  and `c·a ≤ w·1e36`; overflows only at `w > 1.16e77/1e36 ≈ 1.16e41`.

The binding limit is `w ≈ 1.16e41`. The measured **total live WNS weight is ~3.65 ETH ≈ 3.65e18**, and
even a single pathological name is ~1e24 — **~17 orders of magnitude** below the limit.
`testFuzz_NoOverflowAtExtremes` fuzzes `w ≤ 1e30` with `alpha` up to `SCALE−1` and asserts no revert
plus the asymptote bound. (Reaching the overflow region needs a WNS fee schedule ~1e17× today's — only
the DAO, as NameNFT owner post-handover, could set that, and it would be self-inflicted; noted, not a
vector.)

## 6. Conclusion

The implementation matches the intended recurrence and steady state; `_pow` is accurate to ~1 ppm
against an independent exp/ln; rounding bias is ≤ ~1 ppm and, in the only security-relevant direction,
can make a proposal pass a hair *early* but never past the `executionDelay` floor and never unbounded;
all monotonicity/boundedness/path-independence invariants hold; and there is no overflow within ~17
orders of magnitude of any realistic weight. No defect found. For a treasury holding significant ETH,
a machine-checked pass (Halmos on `_pow`/`_accrue`, or Certora rules mirroring §4) remains a worthwhile
belt-and-suspenders, but is not a blocker for a pilot with a bounded treasury.
