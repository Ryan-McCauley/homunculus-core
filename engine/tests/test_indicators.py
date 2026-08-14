"""Indicator math must agree with shared/indicators.ts to the last decimal.

Two layers of defence here: hand-computable vectors (below), which pin the shape
and the warm-up behaviour, and the cross-language parity fixture in
test_parity.py, which pins the exact numbers against the TypeScript
implementation on real candle data.
"""

import unittest

from engine.indicators import (
    sma, ema, rsi, macd, bollinger, bb_width_pct, rel_volume,
    pct_change, last_value, last_pair, crossed_above, crossed_below,
)


class TestSma(unittest.TestCase):
    def test_warms_up_with_none_then_averages(self):
        self.assertEqual(sma([1, 2, 3, 4, 5], 3), [None, None, 2.0, 3.0, 4.0])

    def test_series_shorter_than_period_is_all_none(self):
        self.assertEqual(sma([1, 2], 5), [None, None])

    def test_period_of_one_is_the_values_themselves(self):
        self.assertEqual(sma([4.5, 2.5], 1), [4.5, 2.5])


class TestEma(unittest.TestCase):
    def test_seeds_from_the_sma_of_the_first_period(self):
        # k = 2/(3+1) = 0.5; seed = mean(1,2,3) = 2, then each step averages in.
        self.assertEqual(ema([1, 2, 3, 4, 5, 6], 3), [None, None, 2.0, 3.0, 4.0, 5.0])

    def test_returns_all_none_when_too_short_to_seed(self):
        self.assertEqual(ema([1, 2], 5), [None, None])

    def test_flat_input_stays_flat(self):
        out = ema([7.0] * 10, 4)
        self.assertTrue(all(v is None or abs(v - 7.0) < 1e-12 for v in out))

    def test_is_aligned_to_the_input_length(self):
        self.assertEqual(len(ema(list(range(30)), 10)), 30)


class TestRsi(unittest.TestCase):
    def test_monotonic_rise_pins_at_100(self):
        out = rsi([float(i) for i in range(1, 40)], 14)
        self.assertAlmostEqual(out[-1], 100.0, places=9)

    def test_monotonic_fall_pins_at_0(self):
        out = rsi([float(i) for i in range(40, 1, -1)], 14)
        self.assertAlmostEqual(out[-1], 0.0, places=9)

    def test_first_defined_value_lands_at_index_period(self):
        out = rsi([float(i) for i in range(1, 40)], 14)
        self.assertIsNone(out[13])
        self.assertIsNotNone(out[14])

    def test_too_short_is_all_none(self):
        self.assertEqual(rsi([1.0, 2.0, 3.0], 14), [None, None, None])

    def test_stays_within_bounds_on_noisy_input(self):
        closes = [100 + (i * 7 % 13) - 6 for i in range(120)]
        for v in rsi([float(c) for c in closes], 14):
            if v is not None:
                self.assertGreaterEqual(v, 0.0)
                self.assertLessEqual(v, 100.0)

    def test_flat_series_has_no_gain_or_loss(self):
        # Zero average loss means the guarded branch returns 100, not a divide by zero.
        out = rsi([50.0] * 40, 14)
        self.assertAlmostEqual(out[-1], 100.0, places=9)


class TestMacd(unittest.TestCase):
    def test_returns_three_aligned_series(self):
        closes = [float(100 + (i % 9)) for i in range(120)]
        m = macd(closes)
        self.assertEqual(len(m["macd"]), len(closes))
        self.assertEqual(len(m["signal"]), len(closes))
        self.assertEqual(len(m["histogram"]), len(closes))

    def test_histogram_is_macd_minus_signal_wherever_both_exist(self):
        closes = [float(100 + (i * 3 % 17)) for i in range(150)]
        m = macd(closes)
        checked = 0
        for i in range(len(closes)):
            if m["macd"][i] is not None and m["signal"][i] is not None:
                self.assertAlmostEqual(m["histogram"][i], m["macd"][i] - m["signal"][i], places=9)
                checked += 1
        self.assertGreater(checked, 0)

    def test_signal_never_warms_up_before_the_macd_line(self):
        closes = [float(100 + (i % 5)) for i in range(120)]
        m = macd(closes)
        first_macd = next(i for i, v in enumerate(m["macd"]) if v is not None)
        first_sig = next(i for i, v in enumerate(m["signal"]) if v is not None)
        self.assertGreaterEqual(first_sig, first_macd)

    def test_too_short_yields_no_values(self):
        m = macd([1.0, 2.0, 3.0])
        self.assertTrue(all(v is None for v in m["macd"]))


class TestBollinger(unittest.TestCase):
    def test_flat_series_collapses_the_bands_onto_the_mean(self):
        b = bollinger([10.0] * 30, 20, 2)
        self.assertAlmostEqual(b["upper"][-1], 10.0, places=9)
        self.assertAlmostEqual(b["lower"][-1], 10.0, places=9)
        self.assertAlmostEqual(b["middle"][-1], 10.0, places=9)

    def test_uses_population_variance_matching_the_ts_side(self):
        # closes 1..4 with period 4: mean 2.5, population sd = sqrt(1.25).
        b = bollinger([1.0, 2.0, 3.0, 4.0], 4, 2)
        self.assertAlmostEqual(b["middle"][-1], 2.5, places=9)
        self.assertAlmostEqual(b["upper"][-1], 2.5 + 2 * (1.25 ** 0.5), places=9)

    def test_bandwidth_is_a_percent_of_the_middle_band(self):
        width = bb_width_pct([1.0, 2.0, 3.0, 4.0], 4, 2)
        expected = ((2 * 2 * (1.25 ** 0.5)) / 2.5) * 100
        self.assertAlmostEqual(width, expected, places=9)

    def test_bandwidth_is_none_when_not_warmed_up(self):
        self.assertIsNone(bb_width_pct([1.0, 2.0], 20, 2))


class TestRelVolume(unittest.TestCase):
    def test_equals_one_when_the_last_bar_matches_the_average(self):
        self.assertAlmostEqual(rel_volume([5.0] * 25, 20), 1.0, places=9)

    def test_doubles_when_the_last_bar_doubles(self):
        vols = [5.0] * 24 + [10.0]
        self.assertAlmostEqual(rel_volume(vols, 20), 2.0, places=9)

    def test_excludes_the_current_bar_from_its_own_baseline(self):
        # A 100x spike must not dilute itself by entering the average.
        vols = [1.0] * 24 + [100.0]
        self.assertAlmostEqual(rel_volume(vols, 20), 100.0, places=9)

    def test_is_none_without_enough_history(self):
        self.assertIsNone(rel_volume([1.0, 2.0], 20))

    def test_is_none_when_the_baseline_is_zero(self):
        self.assertIsNone(rel_volume([0.0] * 24 + [3.0], 20))


class TestPctChange(unittest.TestCase):
    def test_measures_across_the_requested_lookback(self):
        self.assertAlmostEqual(pct_change([100.0, 110.0], 1), 10.0, places=9)
        self.assertAlmostEqual(pct_change([100.0, 50.0], 1), -50.0, places=9)

    def test_is_none_without_the_full_lookback(self):
        self.assertIsNone(pct_change([100.0], 1))

    def test_is_none_when_the_reference_price_is_zero(self):
        self.assertIsNone(pct_change([0.0, 5.0], 1))


class TestSeriesHelpers(unittest.TestCase):
    def test_last_value_skips_trailing_nones(self):
        self.assertEqual(last_value([1.0, 2.0, None]), 2.0)
        self.assertIsNone(last_value([None, None]))

    def test_last_pair_returns_oldest_first(self):
        self.assertEqual(last_pair([1.0, 2.0, 3.0]), (2.0, 3.0))

    def test_last_pair_needs_two_defined_values(self):
        self.assertIsNone(last_pair([None, 4.0]))

    def test_cross_detection(self):
        self.assertTrue(crossed_above((1.0, 3.0), (2.0, 2.0)))
        self.assertFalse(crossed_above((3.0, 4.0), (2.0, 2.0)))
        self.assertTrue(crossed_below((3.0, 1.0), (2.0, 2.0)))
        self.assertFalse(crossed_below((1.0, 1.5), (2.0, 2.0)))

    def test_touching_without_passing_is_not_a_cross(self):
        # Equal on both bars never counts — otherwise a flat pair fires every bar.
        self.assertFalse(crossed_above((2.0, 2.0), (2.0, 2.0)))
        self.assertFalse(crossed_below((2.0, 2.0), (2.0, 2.0)))


if __name__ == "__main__":
    unittest.main()
