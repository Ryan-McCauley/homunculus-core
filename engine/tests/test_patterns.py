"""Candle pattern detection.

Two rules run through all of this and are worth stating once:

TREND CONTEXT IS REQUIRED. A hammer and a hanging man are the same shape; only the
preceding trend tells them apart. A screener is a precision instrument — the user
asked for hammers, not for hammer-shaped bars — so a reversal pattern is emitted
only when the trend it reverses is actually there. Ambiguous (flat) context emits
neither.

AGE IS MEASURED IN BARS BACK FROM THE NEWEST. Age 0 is the current forming bar.
That is what the FRESHNESS gate counts.
"""

from __future__ import annotations

import unittest

from engine.patterns import (
    ALL_PATTERNS, detect_at, latest_pattern, trend_before,
)


def c(o, h, l, cl, v=100.0, ts=0):
    return [ts, o, h, l, cl, v]


# The trend helpers are anchored on where they FINISH, not where they start. A
# context that marches away from the pattern bar's price is not context at all —
# it reads as a crash or a spike between the two, which is what trend_before()
# would (correctly) report.

def downtrend(end=100.0, n=6, step=3.0):
    """n bars marching steadily down, finishing just above `end`."""
    bars = []
    for i in range(n):
        cl = end + (n - i) * step
        op = cl + step
        bars.append(c(op, op + 0.4, cl - 0.4, cl, 100.0, i))
    return bars


def uptrend(end=100.0, n=6, step=3.0):
    """n bars marching steadily up, finishing just below `end`."""
    bars = []
    for i in range(n):
        cl = end - (n - i) * step
        op = cl - step
        bars.append(c(op, cl + 0.4, op - 0.4, cl, 100.0, i))
    return bars


def flat(n=6, price=100.0):
    return [c(price, price + 0.2, price - 0.2, price, 100.0, i) for i in range(n)]


class TestRegistry(unittest.TestCase):
    def test_matches_the_shared_contract_exactly(self):
        # KNOWN_PATTERNS in shared/screener.ts is the source of truth; a pattern that
        # exists on only one side of the wire is a whitelist the engine silently drops.
        expected = {
            "doji", "dragonfly_doji", "gravestone_doji", "long_legged_doji",
            "hammer", "hanging_man", "inverted_hammer", "shooting_star",
            "bullish_engulfing", "bearish_engulfing",
            "bullish_harami", "bullish_harami_cross", "bearish_harami", "bearish_harami_cross",
            "piercing_line", "dark_cloud_cover",
            "morning_star", "evening_star",
            "three_white_soldiers", "three_black_crows",
        }
        self.assertEqual(set(ALL_PATTERNS), expected)


class TestTrendBefore(unittest.TestCase):
    def test_reads_a_falling_run_as_down(self):
        bars = downtrend(n=8)
        self.assertEqual(trend_before(bars, len(bars) - 1), "down")

    def test_reads_a_rising_run_as_up(self):
        bars = uptrend(n=8)
        self.assertEqual(trend_before(bars, len(bars) - 1), "up")

    def test_reads_a_sideways_run_as_flat(self):
        bars = flat(8)
        self.assertEqual(trend_before(bars, len(bars) - 1), "flat")

    def test_is_flat_when_there_is_no_history_to_judge(self):
        self.assertEqual(trend_before([c(1, 2, 0, 1)], 0), "flat")


class TestDojiFamily(unittest.TestCase):
    def test_dragonfly_needs_a_long_lower_wick_and_no_upper(self):
        bars = downtrend() + [c(100, 100.2, 90, 100.1)]
        self.assertIn("dragonfly_doji", detect_at(bars, len(bars) - 1))

    def test_gravestone_needs_a_long_upper_wick_and_no_lower(self):
        bars = uptrend() + [c(100, 110, 99.8, 99.9)]
        self.assertIn("gravestone_doji", detect_at(bars, len(bars) - 1))

    def test_long_legged_doji_has_both_wicks(self):
        bars = flat(6) + [c(100, 105, 95, 100.1)]
        self.assertIn("long_legged_doji", detect_at(bars, len(bars) - 1))

    def test_a_dead_flat_bar_with_no_volume_is_not_a_doji(self):
        # Zero volume on an illiquid book is dead air, not indecision.
        bars = downtrend() + [c(100, 100.2, 90, 100.1, 0.0)]
        self.assertEqual(detect_at(bars, len(bars) - 1), [])

    def test_a_doji_far_narrower_than_recent_range_is_ignored(self):
        wide = [c(100, 130, 70, 100, 100.0, i) for i in range(15)]
        tiny = c(100, 100.05, 99.95, 100.0)
        self.assertEqual(detect_at(wide + [tiny], len(wide)), [])

    def test_dragonfly_requires_a_downtrend(self):
        bars = uptrend() + [c(100, 100.2, 90, 100.1)]
        self.assertNotIn("dragonfly_doji", detect_at(bars, len(bars) - 1))


class TestHammerFamily(unittest.TestCase):
    def test_hammer_after_a_downtrend(self):
        bars = downtrend() + [c(100, 103, 90, 102.5)]
        found = detect_at(bars, len(bars) - 1)
        self.assertIn("hammer", found)
        self.assertNotIn("hanging_man", found)

    def test_the_same_shape_after_an_uptrend_is_a_hanging_man(self):
        bars = uptrend() + [c(100, 103, 90, 102.5)]
        found = detect_at(bars, len(bars) - 1)
        self.assertIn("hanging_man", found)
        self.assertNotIn("hammer", found)

    def test_inverted_hammer_after_a_downtrend(self):
        bars = downtrend() + [c(100, 110, 99, 102.5)]
        self.assertIn("inverted_hammer", detect_at(bars, len(bars) - 1))

    def test_shooting_star_after_an_uptrend(self):
        bars = uptrend() + [c(100, 110, 99, 102.5)]
        self.assertIn("shooting_star", detect_at(bars, len(bars) - 1))

    def test_ambiguous_flat_context_emits_neither_side(self):
        bars = flat(6) + [c(100, 103, 90, 102.5)]
        found = detect_at(bars, len(bars) - 1)
        self.assertNotIn("hammer", found)
        self.assertNotIn("hanging_man", found)


class TestEngulfing(unittest.TestCase):
    def test_bullish_engulfing_swallows_the_prior_red_body(self):
        bars = downtrend() + [c(100, 101, 94, 95), c(94, 103, 93.5, 102)]
        self.assertIn("bullish_engulfing", detect_at(bars, len(bars) - 1))

    def test_bearish_engulfing_swallows_the_prior_green_body(self):
        bars = uptrend(end=100) + [c(95, 101, 94, 100), c(101, 102, 93, 94)]
        self.assertIn("bearish_engulfing", detect_at(bars, len(bars) - 1))

    def test_a_body_that_does_not_fully_cover_is_not_engulfing(self):
        bars = downtrend() + [c(100, 101, 94, 95), c(96, 100, 95.5, 99)]
        self.assertNotIn("bullish_engulfing", detect_at(bars, len(bars) - 1))


class TestHarami(unittest.TestCase):
    def test_bullish_harami_sits_inside_a_long_red_body(self):
        bars = downtrend() + [c(110, 111, 89, 90), c(98, 100, 96, 99)]
        self.assertIn("bullish_harami", detect_at(bars, len(bars) - 1))

    def test_a_doji_inside_the_body_is_a_harami_cross(self):
        bars = downtrend() + [c(110, 111, 89, 90), c(99, 100, 98, 99.02)]
        found = detect_at(bars, len(bars) - 1)
        self.assertIn("bullish_harami_cross", found)
        self.assertNotIn("bullish_harami", found)

    def test_bearish_harami_sits_inside_a_long_green_body(self):
        bars = uptrend(end=110) + [c(90, 111, 89, 110), c(99, 101, 97, 98)]
        self.assertIn("bearish_harami", detect_at(bars, len(bars) - 1))

    def test_a_body_poking_outside_the_prior_body_is_not_a_harami(self):
        bars = downtrend() + [c(110, 111, 89, 90), c(98, 115, 96, 112)]
        self.assertNotIn("bullish_harami", detect_at(bars, len(bars) - 1))


class TestPiercingAndCloud(unittest.TestCase):
    def test_piercing_line_recovers_past_the_midpoint(self):
        bars = downtrend() + [c(110, 111, 89, 90), c(88, 102, 87, 101)]
        self.assertIn("piercing_line", detect_at(bars, len(bars) - 1))

    def test_a_close_short_of_the_midpoint_is_not_piercing(self):
        bars = downtrend() + [c(110, 111, 89, 90), c(88, 95, 87, 93)]
        self.assertNotIn("piercing_line", detect_at(bars, len(bars) - 1))

    def test_a_close_past_the_prior_open_is_engulfing_not_piercing(self):
        bars = downtrend() + [c(110, 111, 89, 90), c(88, 115, 87, 112)]
        found = detect_at(bars, len(bars) - 1)
        self.assertNotIn("piercing_line", found)
        self.assertIn("bullish_engulfing", found)

    def test_dark_cloud_cover_mirrors_it(self):
        bars = uptrend(end=110) + [c(90, 111, 89, 110), c(112, 113, 98, 99)]
        self.assertIn("dark_cloud_cover", detect_at(bars, len(bars) - 1))


class TestStars(unittest.TestCase):
    def test_morning_star_is_long_red_small_body_long_green(self):
        bars = downtrend() + [c(110, 111, 99, 100), c(99, 99.6, 98.4, 99.2), c(100, 111, 99.5, 110)]
        self.assertIn("morning_star", detect_at(bars, len(bars) - 1))

    def test_evening_star_mirrors_it(self):
        bars = uptrend(end=100) + [c(100, 111, 99, 110), c(110.5, 111.5, 110, 110.8), c(110, 110.5, 99, 100)]
        self.assertIn("evening_star", detect_at(bars, len(bars) - 1))

    def test_a_large_middle_body_is_not_a_star(self):
        bars = downtrend() + [c(110, 111, 99, 100), c(99, 108, 98, 107), c(107, 112, 106, 111)]
        self.assertNotIn("morning_star", detect_at(bars, len(bars) - 1))


class TestSoldiersAndCrows(unittest.TestCase):
    def test_three_white_soldiers_climb(self):
        bars = downtrend() + [c(100, 105, 99.5, 104), c(103, 109, 102.5, 108), c(107, 113, 106.5, 112)]
        self.assertIn("three_white_soldiers", detect_at(bars, len(bars) - 1))

    def test_three_black_crows_fall(self):
        bars = uptrend(end=110) + [c(112, 112.5, 106, 107), c(108, 108.5, 102, 103), c(104, 104.5, 98, 99)]
        self.assertIn("three_black_crows", detect_at(bars, len(bars) - 1))

    def test_a_broken_run_is_neither(self):
        bars = downtrend() + [c(100, 105, 99.5, 104), c(103, 109, 102.5, 108), c(107, 108, 100, 101)]
        self.assertNotIn("three_white_soldiers", detect_at(bars, len(bars) - 1))


class TestLatestPattern(unittest.TestCase):
    def test_finds_the_newest_whitelisted_pattern_and_its_age(self):
        bars = downtrend() + [c(100, 103, 90, 102.5)] + [c(102.5, 103, 102, 102.6), c(102.6, 103, 102.2, 102.7)]
        name, age = latest_pattern(bars, ["hammer"], max_scan=10)
        self.assertEqual(name, "hammer")
        self.assertEqual(age, 2)  # two bars have printed since it formed

    def test_age_zero_is_the_current_forming_bar(self):
        bars = downtrend() + [c(100, 103, 90, 102.5)]
        name, age = latest_pattern(bars, ["hammer"], max_scan=10)
        self.assertEqual((name, age), ("hammer", 0))

    def test_ignores_patterns_outside_the_whitelist(self):
        bars = downtrend() + [c(100, 103, 90, 102.5)]
        self.assertEqual(latest_pattern(bars, ["morning_star"], max_scan=10), (None, None))

    def test_an_empty_whitelist_finds_nothing(self):
        bars = downtrend() + [c(100, 103, 90, 102.5)]
        self.assertEqual(latest_pattern(bars, [], max_scan=10), (None, None))

    def test_stops_looking_past_the_scan_window(self):
        bars = downtrend() + [c(100, 103, 90, 102.5)] + flat(5, 102.5)
        self.assertEqual(latest_pattern(bars, ["hammer"], max_scan=3), (None, None))

    def test_handles_a_series_too_short_to_have_context(self):
        self.assertEqual(latest_pattern([c(1, 2, 0, 1)], ["hammer"], max_scan=5), (None, None))

    def test_never_raises_on_degenerate_bars(self):
        # A zero-range bar divides by zero if the guards are missing.
        bars = [c(5, 5, 5, 5, 0.0, i) for i in range(10)]
        self.assertEqual(latest_pattern(bars, list(ALL_PATTERNS), max_scan=5), (None, None))


if __name__ == "__main__":
    unittest.main()
