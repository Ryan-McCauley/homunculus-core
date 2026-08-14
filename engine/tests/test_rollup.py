"""Timeframe rollup — deriving 4hr from 1hr and 1week from 1day.

Gemini serves 1m/5m/15m/30m/1hr/6hr/1day and nothing else, so every other
timeframe a screener offers has to be built locally. server/crypto.ts already
builds 4hr the same way for the chart; test_parity.py holds this port to that
one, and the tests here pin the bucketing rules themselves.
"""

from __future__ import annotations

import datetime
import unittest

from engine.rollup import HOUR_MS, DAY_MS, WEEK_MS, rollup, candles_for_timeframe

H = HOUR_MS


def bar(ts, o, h, l, c, v):
    return [ts, o, h, l, c, v]


class TestRollup(unittest.TestCase):
    def test_aggregates_ohlcv_the_standard_way(self):
        # Four 1hr bars inside one UTC 4hr bucket starting at 00:00.
        bars = [
            bar(0 * H, 10, 12, 9, 11, 100),
            bar(1 * H, 11, 15, 10, 14, 200),
            bar(2 * H, 14, 14, 8, 9, 50),
            bar(3 * H, 9, 11, 7, 10, 25),
        ]
        out = rollup(bars, 4 * H)
        self.assertEqual(len(out), 1)
        ts, o, h, l, c, v = out[0]
        self.assertEqual(ts, 0)
        self.assertEqual(o, 10)   # first bar's open
        self.assertEqual(h, 15)   # highest high
        self.assertEqual(l, 7)    # lowest low
        self.assertEqual(c, 10)   # last bar's close
        self.assertEqual(v, 375)  # summed volume

    def test_splits_on_utc_bucket_boundaries(self):
        bars = [bar(i * H, 1, 1, 1, 1, 1) for i in range(8)]
        out = rollup(bars, 4 * H)
        self.assertEqual([c[0] for c in out], [0, 4 * H])

    def test_a_partial_trailing_bucket_is_kept(self):
        # The newest bucket is the FORMING bar. Dropping it would hide the live
        # candle the screener is meant to be reading.
        bars = [bar(i * H, 1, 2, 0, 1, 1) for i in range(6)]
        out = rollup(bars, 4 * H)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[-1][0], 4 * H)
        self.assertEqual(out[-1][5], 2)  # only two hours have printed

    def test_a_bucket_starting_mid_stream_still_aligns_to_utc(self):
        # Input begins at 02:00, which belongs to the 00:00 bucket — the bucket
        # timestamp is the boundary, never the first bar's timestamp.
        bars = [bar(2 * H, 5, 6, 4, 5, 10), bar(3 * H, 5, 7, 5, 6, 10)]
        out = rollup(bars, 4 * H)
        self.assertEqual(out[0][0], 0)
        self.assertEqual(out[0][1], 5)

    def test_empty_input_yields_empty_output(self):
        self.assertEqual(rollup([], 4 * H), [])

    def test_factor_of_one_is_a_copy_not_an_alias(self):
        bars = [bar(0, 1, 2, 0, 1, 5)]
        out = rollup(bars, H)
        self.assertEqual(out, bars)
        out[0][1] = 999
        self.assertEqual(bars[0][1], 1)

    def test_weekly_buckets_start_on_monday_utc(self):
        # Derived, not hardcoded: a wrong epoch constant would otherwise let this
        # test agree with a wrong implementation.
        monday_date = datetime.datetime(2026, 8, 3, tzinfo=datetime.timezone.utc)
        self.assertEqual(monday_date.strftime("%A"), "Monday")
        monday = int(monday_date.timestamp() * 1000)
        sunday = monday + 6 * DAY_MS
        next_monday = monday + 7 * DAY_MS
        bars = [
            bar(monday, 1, 1, 1, 1, 1),
            bar(sunday, 2, 2, 2, 2, 1),
            bar(next_monday, 3, 3, 3, 3, 1),
        ]
        out = rollup(bars, WEEK_MS, anchor=-259200000)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0][0], monday)
        self.assertEqual(out[1][0], next_monday)

    def test_weekly_anchor_places_the_epoch_in_a_monday_bucket(self):
        # Epoch itself is a Thursday, so it belongs to the Monday of 1969-12-29.
        out = rollup([bar(0, 1, 1, 1, 1, 1)], WEEK_MS, anchor=-259200000)
        self.assertEqual(out[0][0], -259200000)


class TestCandlesForTimeframe(unittest.TestCase):
    def setUp(self):
        self.base = {
            "15m": [bar(i * 900_000, 1, 1, 1, 1, 1) for i in range(8)],
            "1hr": [bar(i * H, 1, 2, 0, 1, 1) for i in range(24)],
            "1day": [bar(i * DAY_MS, 1, 2, 0, 1, 1) for i in range(21)],
        }

    def test_native_timeframes_pass_through_untouched(self):
        self.assertEqual(candles_for_timeframe(self.base, "15m"), self.base["15m"])
        self.assertEqual(candles_for_timeframe(self.base, "1hr"), self.base["1hr"])
        self.assertEqual(candles_for_timeframe(self.base, "1day"), self.base["1day"])

    def test_4hr_is_derived_from_the_hourly_feed(self):
        out = candles_for_timeframe(self.base, "4hr")
        self.assertEqual(len(out), 6)  # 24 hourly bars → six 4hr buckets

    def test_1week_is_derived_from_the_daily_feed(self):
        out = candles_for_timeframe(self.base, "1week")
        self.assertEqual(len(out), 4)  # 21 daily bars spanning four Monday buckets

    def test_a_missing_base_feed_yields_no_candles_rather_than_an_error(self):
        self.assertEqual(candles_for_timeframe({}, "4hr"), [])

    def test_an_unknown_timeframe_yields_no_candles(self):
        self.assertEqual(candles_for_timeframe(self.base, "3hr"), [])


if __name__ == "__main__":
    unittest.main()
