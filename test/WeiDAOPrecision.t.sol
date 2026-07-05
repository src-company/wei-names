// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "@forge/Test.sol";
import {WeiDAO} from "../src/WeiDAO.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @dev Exposes WeiDAO's internal fixed-point math (`_pow`, `_accrue`) for precision auditing.
///      Constructor args are placeholders — none of the exposed math touches the NameNFT.
contract PowHarness is WeiDAO {
    constructor() WeiDAO(address(0xdead), 5e17, 1, 0, 0, address(0)) {}

    function pow(uint256 base, uint256 exp) external pure returns (uint256) {
        return _pow(base, exp);
    }

    function accrue(uint256 c, uint256 w, uint256 dt) external view returns (uint256) {
        return _accrue(c, w, dt);
    }

    function setAlphaRaw(uint256 a) external {
        alpha = a;
    }
}

/// @notice Precision audit for the conviction math. `_pow` uses exponentiation-by-squaring with
///         truncating division; this suite pins its accuracy against solady's `powWad` (an
///         independent exp/ln implementation) and checks the algebraic invariants `_accrue` relies
///         on. This is the "review before mainnet" item the contract's own caveats flag.
contract WeiDAOPrecisionTest is Test {
    PowHarness h;

    uint256 constant SCALE = 1e18;
    // 7-day half-life: alpha = round(2^(-1/604800)·1e18).
    uint256 constant ALPHA_7D = 999_998_853_923_940_000;

    function setUp() public {
        h = new PowHarness();
        h.setAlphaRaw(ALPHA_7D);
    }

    /*//////////////////////////////////////////////////////////////
                          _pow: FIXED ANCHORS
    //////////////////////////////////////////////////////////////*/

    function testPowIdentities() public view {
        assertEq(h.pow(ALPHA_7D, 0), SCALE); // x^0 = 1
        assertEq(h.pow(ALPHA_7D, 1), ALPHA_7D); // x^1 = x
        assertEq(h.pow(SCALE, 12345), SCALE); // 1^n = 1
    }

    /// @dev The doc claims α^7d is within 0.5% of ½. Verify that, and the successive half-lives.
    function testHalfLifeAnchors() public view {
        assertApproxEqRel(h.pow(ALPHA_7D, 7 days), 0.5e18, 0.005e18);
        assertApproxEqRel(h.pow(ALPHA_7D, 14 days), 0.25e18, 0.01e18);
        assertApproxEqRel(h.pow(ALPHA_7D, 21 days), 0.125e18, 0.02e18);
    }

    function testPowMonotoneNonIncreasing() public view {
        uint256 prev = SCALE;
        for (uint256 dt; dt <= 90 days; dt += 3 days) {
            uint256 v = h.pow(ALPHA_7D, dt);
            assertLe(v, prev);
            prev = v;
        }
    }

    /*//////////////////////////////////////////////////////////////
                     _pow: DIFFERENTIAL vs exp/ln
    //////////////////////////////////////////////////////////////*/

    /// @dev Reference α^dt via solady `powWad` = exp(dt·ln α) — a fully independent algorithm.
    function _ref(uint256 base, uint256 dt) internal pure returns (uint256) {
        if (dt == 0) return SCALE;
        int256 r = FixedPointMathLib.powWad(int256(base), int256(dt * SCALE));
        return r <= 0 ? 0 : uint256(r);
    }

    function testFuzz_PowMatchesReference(uint256 base, uint256 dt) public view {
        // Governance-realistic per-second decay: extremely close to 1, down to a fast 1%/s.
        base = bound(base, 0.99e18, SCALE - 1);
        dt = bound(dt, 0, 3650 days);

        uint256 got = h.pow(base, dt);
        uint256 ref = _ref(base, dt);

        if (ref < 1e6) {
            // Deep decay: both collapse to ~0. Compare absolutely.
            assertApproxEqAbs(got, ref, 1e6);
        } else {
            // Elsewhere the two independent algorithms agree to ~1 part per million.
            assertApproxEqRel(got, ref, 1e12);
        }
    }

    /*//////////////////////////////////////////////////////////////
                       _accrue: ALGEBRAIC INVARIANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev From 0, sustained weight approaches exactly `convictionMax` once α^dt underflows to 0.
    function testAccrueReachesConvictionMax() public view {
        uint256 w = 1e18;
        assertEq(h.pow(ALPHA_7D, 3650 days), 0); // α^dt has underflowed
        assertEq(h.accrue(0, w, 3650 days), h.convictionMax(w)); // exact
    }

    /// @dev One half-life of sustained weight reaches ½·convictionMax — the calibration identity.
    function testAccrueHalfLifeReachesHalfMax() public view {
        uint256 w = 1e18;
        assertApproxEqRel(h.accrue(0, w, 7 days), h.convictionMax(w) / 2, 0.005e18);
    }

    /// @dev `convictionMax` is a fixed point of `_accrue`: sitting at the asymptote, you stay there.
    function testConvictionMaxIsFixedPoint() public view {
        uint256 w = 3e18;
        uint256 cmax = h.convictionMax(w);
        for (uint256 dt = 1 days; dt <= 100 days; dt += 7 days) {
            assertApproxEqAbs(h.accrue(cmax, w, dt), cmax, 2);
        }
    }

    /// @dev Conviction from 0 never overshoots the asymptote, and starting at it never exceeds it —
    ///      the bound `threshold` calibration depends on.
    function testFuzz_AccrueBoundedByMax(uint256 w, uint256 dt) public view {
        w = bound(w, 0, 1e30);
        dt = bound(dt, 0, 3650 days);
        uint256 cmax = h.convictionMax(w);
        assertLe(h.accrue(0, w, dt), cmax + 1); // +1: rounding slack
        assertLe(h.accrue(cmax, w, dt), cmax + 1);
    }

    /// @dev Accrual from 0 is monotone non-decreasing in elapsed time.
    function testFuzz_AccrueMonotoneInTime(uint256 w, uint256 dt) public view {
        w = bound(w, 1, 1e24);
        dt = bound(dt, 0, 3649 days);
        assertGe(h.accrue(0, w, dt + 1 days), h.accrue(0, w, dt));
    }

    /*//////////////////////////////////////////////////////////////
                     FORMAL PROPERTIES (see ops/MATH_REVIEW.md)
    //////////////////////////////////////////////////////////////*/

    /// @dev P1 — decay can never amplify: α^dt ≤ 1 for every α ≤ 1 and every dt.
    function testFuzz_PowNeverExceedsScale(uint256 base, uint256 dt) public view {
        base = bound(base, 0, SCALE);
        dt = bound(dt, 0, type(uint32).max);
        assertLe(h.pow(base, dt), SCALE);
    }

    /// @dev High-precision reference for `_accrue`, independent of `_pow`: α^dt from solady's exp/ln,
    ///      and full-width mulDiv for both terms — isolates `_accrue`'s own error end to end.
    function _refAccrue(uint256 c, uint256 w, uint256 dt, uint256 a)
        internal
        pure
        returns (uint256)
    {
        uint256 A = _ref(a, dt); // α^dt·SCALE, high precision (≤ SCALE)
        return FixedPointMathLib.fullMulDiv(c, A, SCALE)
            + FixedPointMathLib.fullMulDiv(w, SCALE - A, SCALE - a);
    }

    /// @dev P2 — `_accrue` matches the independent reference to ~2 ppm across the *whole* adjustable
    ///      alpha range (not just the 7-day default), two-sided so it bounds both over- and
    ///      under-crediting. The over-credit direction is the security-relevant one (a proposal can
    ///      only cross `threshold` earlier), and it is bounded here to a few ppm of `convictionMax`.
    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_AccrueMatchesReferenceAcrossAlpha(uint256 a, uint256 c, uint256 w, uint256 dt)
        public
    {
        a = bound(a, 0.9e18, SCALE - 1);
        c = bound(c, 0, 1e27);
        w = bound(w, 0, 1e27);
        dt = bound(dt, 0, 3650 days);
        h.setAlphaRaw(a);
        uint256 got = h.accrue(c, w, dt);
        uint256 ref = _refAccrue(c, w, dt, a);
        // Derived bound: the two terms differ from the reference only by the ~1e-6 relative `_pow`
        // error amplified by their scale — the decay term by c, the accrual term by cmax — plus two
        // floor wei: |got − ref| ≤ (c + cmax)·1e-6 + 2. Use /500_000 (2× margin) + 32. Absolute, so it
        // stays meaningful at tiny magnitudes where a relative tolerance would be spuriously tight.
        assertApproxEqAbs(got, ref, (c + h.convictionMax(w)) / 500_000 + 32);
    }

    /// @dev P3 — flash-mint resistance, exactly: weight introduced *now* adds zero conviction now
    ///      (dt = 0), and existing conviction is returned untouched. No instant jump from fresh weight.
    function testAccrueZeroTimeAddsNothing() public view {
        uint256 w = 5e18;
        assertEq(h.accrue(0, w, 0), 0); // fresh weight, no elapsed time → 0
        assertEq(h.accrue(123_456, w, 0), 123_456); // prior conviction unchanged
    }

    /// @dev P4 — path independence: one sync over `dt1 + dt2` equals two syncs (over dt1 then dt2) to
    ///      within accumulated rounding, so conviction does not depend on how often support/unsupport
    ///      happen to call `_sync`. This is what makes the snapshot-at-`lastUpdate` design sound.
    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_AccrueSemigroup(uint256 w, uint256 dt1, uint256 dt2) public view {
        w = bound(w, 0, 1e27);
        dt1 = bound(dt1, 0, 1825 days);
        dt2 = bound(dt2, 0, 1825 days);
        uint256 split = h.accrue(h.accrue(0, w, dt1), w, dt2);
        uint256 whole = h.accrue(0, w, dt1 + dt2);
        // Each path's error vs the exact value is ≤ cmax·1e-6 + floor slack, so their difference is
        // ≤ 2·cmax·1e-6 + a few wei. Same principled absolute bound as the reference test.
        assertApproxEqAbs(split, whole, h.convictionMax(w) / 250_000 + 32);
    }

    /// @dev P5 — accrual from 0 is monotone non-decreasing in weight (more backing ⇒ ≥ conviction).
    function testFuzz_AccrueMonotoneInWeight(uint256 w1, uint256 w2, uint256 dt) public view {
        w1 = bound(w1, 0, 1e27);
        w2 = bound(w2, w1, 1e27);
        dt = bound(dt, 0, 3650 days);
        assertLe(h.accrue(0, w1, dt), h.accrue(0, w2, dt));
    }

    /// @dev P6 — no overflow anywhere in the supported domain, even at the alpha extreme (SCALE−1, so
    ///      convictionMax = w·SCALE) with weight far above any realistic WNS book (~1e24). Also
    ///      re-confirms the asymptote bound holds under those extremes.
    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_NoOverflowAtExtremes(uint256 a, uint256 w, uint256 dt) public {
        a = bound(a, 1, SCALE - 1);
        w = bound(w, 0, 1e30);
        dt = bound(dt, 0, 3650 days);
        h.setAlphaRaw(a);
        uint256 cmax = h.convictionMax(w);
        assertLe(h.accrue(0, w, dt), cmax + 1);
        assertLe(h.accrue(cmax, w, dt), cmax + 1);
    }
}
