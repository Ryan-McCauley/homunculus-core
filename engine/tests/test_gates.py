"""Per-symbol gate evaluation.

The contract every test here defends: a screener must be able to say WHY. Passing
is the easy half — the half that earns the tab is naming the single gate that
blocked a symbol, in the order the user reads the rail, with the observed value
attached.
"""

from __future__ import annotations

import unittest

from engine.screen import evaluate_symbol, blank_gates, GATE_ORDER

H = 60 * 60 * 1000


def rising(n=120, start=100.0, step=0.5):
    """Monotonic climb — RSI pins at 100, price sits above every moving average."""
    out = []
    for i in range(n):
        o = start + i * step
        cl = o + step
        out.append([i * H, o, cl + 0.1, o - 0.1, cl, 100.0])
    return out


def falling(n=120, start=200.0, step=0.5):
    """Monotonic slide — RSI pins at 0, price sits below every moving average."""
    out = []
    for i in range(n):
        o = start - i * step
        cl = o - step
        out.append([i * H, o, o + 0.1, cl - 0.1, cl, 100.0])
    return out


def sym(**kw):
    base = {
        "symbol": "TESTUSD",
        "last": 100.0,
        "change24h": -5.0,
        "volume24h": 5_000_000.0,
        "marketCap": 500_000_000.0,
        "held": False,
        "candles": {"1hr": rising()},
    }
    base.update(kw)
    return base


def screener(**gates):
    g = blank_gates()
    for key, value in gates.items():
        g[key].update(value)
    return {"id": "test", "name": "TEST", "timeframe": "1hr", "universe": "ALL", "gates": g}


def verdict(candidate, gate_id):
    return next(v for v in candidate["gates"] if v["gate"] == gate_id)


class TestNoGates(unittest.TestCase):
    def test_a_screener_with_nothing_enabled_passes_everything(self):
        c = evaluate_symbol(screener(), sym())
        self.assertTrue(c["passes"])
        self.assertIsNone(c["blockedBy"])

    def test_fit_is_full_when_there_is_nothing_to_fail(self):
        self.assertEqual(evaluate_symbol(screener(), sym())["fit"], 100)

    def test_reports_a_verdict_for_every_gate_even_when_disabled(self):
        c = evaluate_symbol(screener(), sym())
        self.assertEqual([v["gate"] for v in c["gates"]], list(GATE_ORDER))


class TestRangeGates(unittest.TestCase):
    def test_a_value_inside_the_range_passes(self):
        c = evaluate_symbol(screener(volume24h={"enabled": True, "min": 1_000_000}), sym())
        self.assertTrue(c["passes"])
        self.assertEqual(verdict(c, "volume24h")["value"], 5_000_000.0)

    def test_a_value_below_the_minimum_fails_and_says_so(self):
        c = evaluate_symbol(screener(volume24h={"enabled": True, "min": 10_000_000}), sym())
        self.assertFalse(c["passes"])
        self.assertEqual(c["blockedBy"], "volume24h")
        self.assertIn("below", c["blockedReason"].lower())

    def test_a_value_above_the_maximum_fails(self):
        c = evaluate_symbol(screener(marketCap={"enabled": True, "max": 50_000_000}), sym())
        self.assertEqual(c["blockedBy"], "marketCap")

    def test_a_two_sided_range_admits_only_the_interior(self):
        s = screener(change24h={"enabled": True, "min": -12, "max": -1})
        self.assertTrue(evaluate_symbol(s, sym(change24h=-5.0))["passes"])
        self.assertFalse(evaluate_symbol(s, sym(change24h=+3.0))["passes"])
        self.assertFalse(evaluate_symbol(s, sym(change24h=-30.0))["passes"])

    def test_bounds_are_inclusive(self):
        s = screener(change24h={"enabled": True, "min": -12, "max": -1})
        self.assertTrue(evaluate_symbol(s, sym(change24h=-12.0))["passes"])
        self.assertTrue(evaluate_symbol(s, sym(change24h=-1.0))["passes"])

    def test_a_disabled_gate_never_blocks(self):
        c = evaluate_symbol(screener(volume24h={"enabled": False, "min": 10_000_000}), sym())
        self.assertTrue(c["passes"])


class TestMissingData(unittest.TestCase):
    def test_market_cap_degrades_to_pass_when_no_feed_supplied_it(self):
        # CMC may not be configured at all. Failing every symbol would make the
        # screener look broken rather than under-informed, so the gate steps aside
        # and flags itself instead.
        c = evaluate_symbol(
            screener(marketCap={"enabled": True, "min": 100_000_000}),
            sym(marketCap=None),
        )
        self.assertTrue(c["passes"])
        self.assertTrue(verdict(c, "marketCap")["degraded"])

    def test_a_required_input_that_is_missing_fails_rather_than_degrading(self):
        # No candles means RSI cannot be computed. Passing here would silently admit
        # unscreenable symbols into the results.
        c = evaluate_symbol(
            screener(rsi={"enabled": True, "max": 35}),
            sym(candles={"1hr": []}),
        )
        self.assertFalse(c["passes"])
        self.assertEqual(c["blockedBy"], "rsi")
        self.assertFalse(verdict(c, "rsi")["degraded"])
        self.assertIn("data", c["blockedReason"].lower())

    def test_too_little_history_for_a_long_moving_average_fails_cleanly(self):
        c = evaluate_symbol(
            screener(ema200={"enabled": True, "trend": "ABOVE"}),
            sym(candles={"1hr": rising(n=30)}),
        )
        self.assertFalse(c["passes"])
        self.assertEqual(c["blockedBy"], "ema200")


class TestTechnicalGates(unittest.TestCase):
    def test_rsi_reads_from_the_screener_timeframe(self):
        c = evaluate_symbol(screener(rsi={"enabled": True, "max": 35}), sym(candles={"1hr": falling()}))
        self.assertTrue(c["passes"])
        self.assertAlmostEqual(c["rsi"], 0.0, places=6)

    def test_an_overbought_symbol_fails_an_oversold_screen(self):
        c = evaluate_symbol(screener(rsi={"enabled": True, "max": 35}), sym(candles={"1hr": rising()}))
        self.assertEqual(c["blockedBy"], "rsi")

    def test_ema_above_passes_when_price_leads_the_average(self):
        c = evaluate_symbol(screener(ema50={"enabled": True, "trend": "ABOVE"}), sym(candles={"1hr": rising()}))
        self.assertTrue(c["passes"])

    def test_ema_above_fails_in_a_downtrend(self):
        c = evaluate_symbol(screener(ema50={"enabled": True, "trend": "ABOVE"}), sym(candles={"1hr": falling()}))
        self.assertEqual(c["blockedBy"], "ema50")

    def test_ema_below_is_the_mirror(self):
        s = screener(ema50={"enabled": True, "trend": "BELOW"})
        self.assertTrue(evaluate_symbol(s, sym(candles={"1hr": falling()}))["passes"])
        self.assertFalse(evaluate_symbol(s, sym(candles={"1hr": rising()}))["passes"])

    def test_trend_any_passes_either_way(self):
        s = screener(ema50={"enabled": True, "trend": "ANY"})
        self.assertTrue(evaluate_symbol(s, sym(candles={"1hr": rising()}))["passes"])
        self.assertTrue(evaluate_symbol(s, sym(candles={"1hr": falling()}))["passes"])

    def test_bb_width_screens_for_expansion(self):
        # A monotonic ramp has a wide band; a flat tape has almost none.
        wide = evaluate_symbol(screener(bbWidth={"enabled": True, "min": 0.5}), sym(candles={"1hr": rising()}))
        self.assertTrue(wide["passes"])
        flat = [[i * H, 100, 100.01, 99.99, 100, 100.0] for i in range(60)]
        narrow = evaluate_symbol(screener(bbWidth={"enabled": True, "min": 0.5}), sym(candles={"1hr": flat}))
        self.assertEqual(narrow["blockedBy"], "bbWidth")

    def test_macd_cross_any_passes_without_a_cross(self):
        c = evaluate_symbol(screener(macd={"enabled": True, "cross": "ANY"}), sym(candles={"1hr": rising()}))
        self.assertTrue(c["passes"])

    def test_macd_bullish_requires_an_actual_cross_this_bar(self):
        # A steady ramp crossed long ago; the gate asks about the latest bar.
        c = evaluate_symbol(screener(macd={"enabled": True, "cross": "BULLISH"}), sym(candles={"1hr": rising()}))
        self.assertEqual(c["blockedBy"], "macd")

    def test_macd_bullish_fires_on_the_turn(self):
        # Flat tape holds the MACD and its signal at exactly zero, so the first
        # rising bar is an unambiguous cross. A V-shaped reversal would put the
        # crossing bar on a float tie between two values 1e-15 apart — real
        # behaviour, but not what this test is about.
        flat = [[i * H, 100, 100.1, 99.9, 100, 100.0] for i in range(60)]
        turn = flat + rising(n=1, start=100.0, step=2.0)
        c = evaluate_symbol(screener(macd={"enabled": True, "cross": "BULLISH"}), sym(candles={"1hr": turn}))
        self.assertTrue(c["passes"], c["blockedReason"])

    def test_macd_bullish_does_not_re_fire_on_later_bars(self):
        flat = [[i * H, 100, 100.1, 99.9, 100, 100.0] for i in range(60)]
        turn = flat + rising(n=4, start=100.0, step=2.0)
        c = evaluate_symbol(screener(macd={"enabled": True, "cross": "BULLISH"}), sym(candles={"1hr": turn}))
        self.assertEqual(c["blockedBy"], "macd")


class TestPatternGates(unittest.TestCase):
    def _with_hammer(self):
        bars = falling(n=90)
        last_close = bars[-1][4]
        bars.append([90 * H, last_close, last_close + 3, last_close - 10, last_close + 2.5, 100.0])
        return bars

    def test_finds_a_whitelisted_pattern_and_reports_it(self):
        c = evaluate_symbol(
            screener(pattern={"enabled": True, "names": ["hammer"]}),
            sym(candles={"1hr": self._with_hammer()}),
        )
        self.assertTrue(c["passes"], c["blockedReason"])
        self.assertEqual(c["pattern"], "hammer")
        self.assertEqual(c["patternAgeBars"], 0)

    def test_a_symbol_without_the_pattern_is_blocked_by_it(self):
        c = evaluate_symbol(
            screener(pattern={"enabled": True, "names": ["morning_star"]}),
            sym(candles={"1hr": self._with_hammer()}),
        )
        self.assertEqual(c["blockedBy"], "pattern")
        self.assertIsNone(c["pattern"])

    def test_freshness_blocks_a_stale_signal(self):
        bars = self._with_hammer()
        for i in range(5):  # five quiet bars print after the hammer
            prev = bars[-1][4]
            bars.append([(91 + i) * H, prev, prev + 0.2, prev - 0.2, prev + 0.05, 100.0])
        c = evaluate_symbol(
            screener(
                pattern={"enabled": True, "names": ["hammer"]},
                freshness={"enabled": True, "max": 2},
            ),
            sym(candles={"1hr": bars}),
        )
        self.assertEqual(c["blockedBy"], "freshness")
        self.assertEqual(c["patternAgeBars"], 5)

    def test_freshness_without_a_pattern_gate_has_nothing_to_measure(self):
        c = evaluate_symbol(
            screener(freshness={"enabled": True, "max": 2}),
            sym(candles={"1hr": rising()}),
        )
        self.assertEqual(c["blockedBy"], "freshness")
        self.assertIn("no pattern", c["blockedReason"].lower())

    def test_relative_volume_screens_out_a_spike(self):
        bars = rising(n=60)
        bars[-1][5] = 5000.0  # 50x the surrounding bars
        c = evaluate_symbol(screener(relVolume={"enabled": True, "max": 2.0}), sym(candles={"1hr": bars}))
        self.assertEqual(c["blockedBy"], "relVolume")
        self.assertAlmostEqual(verdict(c, "relVolume")["value"], 50.0, places=6)


class TestBlockingOrder(unittest.TestCase):
    def test_the_first_failing_gate_in_rail_order_is_the_one_reported(self):
        c = evaluate_symbol(
            screener(
                volume24h={"enabled": True, "min": 10_000_000},   # fails, earlier
                rsi={"enabled": True, "max": 35},                 # also fails
            ),
            sym(candles={"1hr": rising()}),
        )
        self.assertEqual(c["blockedBy"], "volume24h")
        self.assertFalse(verdict(c, "rsi")["pass"])

    def test_every_failing_gate_is_still_recorded_for_the_gate_strip(self):
        c = evaluate_symbol(
            screener(
                volume24h={"enabled": True, "min": 10_000_000},
                rsi={"enabled": True, "max": 35},
            ),
            sym(candles={"1hr": rising()}),
        )
        failed = [v["gate"] for v in c["gates"] if not v["pass"]]
        self.assertEqual(failed, ["volume24h", "rsi"])


class TestFit(unittest.TestCase):
    def test_a_symbol_failing_half_the_gates_scores_below_one_passing_all(self):
        good = evaluate_symbol(
            screener(volume24h={"enabled": True, "min": 1_000_000}, rsi={"enabled": True, "min": 50}),
            sym(candles={"1hr": rising()}),
        )
        bad = evaluate_symbol(
            screener(volume24h={"enabled": True, "min": 10_000_000}, rsi={"enabled": True, "min": 50}),
            sym(candles={"1hr": rising()}),
        )
        self.assertGreater(good["fit"], bad["fit"])

    def test_fit_stays_within_bounds(self):
        for candles in (rising(), falling()):
            c = evaluate_symbol(
                screener(rsi={"enabled": True, "max": 35}, volume24h={"enabled": True, "min": 1}),
                sym(candles={"1hr": candles}),
            )
            self.assertGreaterEqual(c["fit"], 0)
            self.assertLessEqual(c["fit"], 100)

    def test_a_fresher_pattern_outranks_a_staler_one(self):
        base = falling(n=90)
        last_close = base[-1][4]
        hammer = [90 * H, last_close, last_close + 3, last_close - 10, last_close + 2.5, 100.0]

        fresh = base + [hammer]
        stale = base + [hammer] + [[91 * H, 158.0, 158.2, 157.8, 158.05, 100.0],
                                   [92 * H, 158.05, 158.3, 157.9, 158.1, 100.0]]
        s = screener(pattern={"enabled": True, "names": ["hammer"]}, freshness={"enabled": True, "max": 5})
        a = evaluate_symbol(s, sym(candles={"1hr": fresh}))
        b = evaluate_symbol(s, sym(candles={"1hr": stale}))
        self.assertTrue(a["passes"] and b["passes"])
        self.assertGreater(a["fit"], b["fit"])

    def test_a_value_deep_inside_a_range_outranks_one_at_the_edge(self):
        s = screener(volume24h={"enabled": True, "min": 1_000_000, "max": 10_000_000})
        deep = evaluate_symbol(s, sym(volume24h=5_500_000.0))
        edge = evaluate_symbol(s, sym(volume24h=1_050_000.0))
        self.assertGreater(deep["fit"], edge["fit"])


class TestRobustness(unittest.TestCase):
    def test_a_gate_absent_from_the_definition_is_treated_as_disabled(self):
        s = screener()
        del s["gates"]["rsi"]
        c = evaluate_symbol(s, sym())
        self.assertTrue(c["passes"])

    def test_carries_the_display_fields_through(self):
        c = evaluate_symbol(screener(), sym(symbol="JTOUSD", last=1.842, held=True))
        self.assertEqual(c["symbol"], "JTOUSD")
        self.assertEqual(c["last"], 1.842)
        self.assertTrue(c["held"])

    def test_never_raises_on_a_symbol_with_no_candles_at_all(self):
        c = evaluate_symbol(screener(rsi={"enabled": True, "max": 35}), sym(candles={}))
        self.assertFalse(c["passes"])


if __name__ == "__main__":
    unittest.main()
