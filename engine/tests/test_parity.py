"""Cross-language parity: engine/indicators.py must equal shared/indicators.ts.

The fixture holds real candles plus the numbers the TypeScript implementation
produced from them (regenerate with `npx tsx engine/tools/gen-parity-fixture.ts`).
Recomputing them here catches the failure this whole split exists to prevent: the
chart drawing one RSI while the screener filters on another.

Tolerance is 1e-9 relative. Both sides are IEEE doubles doing the same operations
in the same order, so the only expected difference is last-bit accumulation.
"""

from __future__ import annotations

import json
import os
import unittest

from engine.indicators import (
    sma, ema, rsi, macd, bollinger, bb_width_pct, rel_volume, pct_change,
    closes_of, volumes_of, last_value, last_pair,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures", "parity.json")
TOLERANCE = 1e-9


def close_enough(a, b, tol=TOLERANCE):
    if a is None or b is None:
        return a is None and b is None
    scale = max(1.0, abs(a), abs(b))
    return abs(a - b) <= tol * scale


class TestIndicatorParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE) as fh:
            cls.fixture = json.load(fh)

    def test_fixture_covers_several_real_symbols(self):
        self.assertGreaterEqual(len(self.fixture["cases"]), 2)
        for case in self.fixture["cases"]:
            self.assertGreaterEqual(len(case["candles"]), 200)

    def test_every_indicator_matches_the_typescript_output(self):
        for case in self.fixture["cases"]:
            symbol = case["symbol"]
            candles = case["candles"]
            exp = case["expected"]
            c = closes_of(candles)
            v = volumes_of(candles)
            m = macd(c)
            b = bollinger(c, 20, 2)

            got = {
                "sma20": last_value(sma(c, 20)),
                "ema12": last_value(ema(c, 12)),
                "ema50": last_value(ema(c, 50)),
                "ema200": last_value(ema(c, 200)),
                "rsi14": last_value(rsi(c, 14)),
                "macd": last_value(m["macd"]),
                "macdSignal": last_value(m["signal"]),
                "macdHistogram": last_value(m["histogram"]),
                "bbUpper": last_value(b["upper"]),
                "bbMiddle": last_value(b["middle"]),
                "bbLower": last_value(b["lower"]),
                "bbWidthPct": bb_width_pct(c, 20, 2),
                "relVolume20": rel_volume(v, 20),
                "pctChange24": pct_change(c, 24),
            }

            for key, value in got.items():
                with self.subTest(symbol=symbol, indicator=key):
                    self.assertTrue(
                        close_enough(value, exp[key]),
                        "%s %s: python=%r ts=%r" % (symbol, key, value, exp[key]),
                    )

    def test_previous_bar_values_match_too(self):
        # Cross detection reads the PREVIOUS bar as well as the current one, so a
        # drift that only shows up one bar back would still break the MACD gate.
        for case in self.fixture["cases"]:
            c = closes_of(case["candles"])
            exp = case["expected"]
            with self.subTest(symbol=case["symbol"]):
                prev = last_pair(rsi(c, 14))
                self.assertIsNotNone(prev)
                self.assertTrue(close_enough(prev[0], exp["rsi14_prev"]))

                m = macd(c)
                for name, series in (("macdPair", m["macd"]), ("signalPair", m["signal"])):
                    pair = last_pair(series)
                    expected_pair = exp[name]
                    self.assertIsNotNone(pair, name)
                    self.assertTrue(close_enough(pair[0], expected_pair[0]), name)
                    self.assertTrue(close_enough(pair[1], expected_pair[1]), name)


class TestRollupParity(unittest.TestCase):
    """The 4hr bars the screener reads must be the same bars the chart draws."""

    @classmethod
    def setUpClass(cls):
        with open(FIXTURE) as fh:
            cls.fixture = json.load(fh)

    def test_4hr_rollup_matches_the_server_aggregation(self):
        from engine.rollup import rollup, HOUR_MS

        for case in self.fixture["cases"]:
            got = rollup(case["candles"], 4 * HOUR_MS)
            expected = case["expected4h"]
            with self.subTest(symbol=case["symbol"]):
                self.assertEqual(len(got), len(expected))
                for i, (g, e) in enumerate(zip(got, expected)):
                    self.assertEqual(g[0], e[0], "bucket %d timestamp" % i)
                    for field in range(1, 6):
                        self.assertTrue(
                            close_enough(g[field], e[field]),
                            "%s bucket %d field %d: python=%r ts=%r"
                            % (case["symbol"], i, field, g[field], e[field]),
                        )


if __name__ == "__main__":
    unittest.main()
