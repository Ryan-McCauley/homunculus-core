"""Whole-screen orchestration: ranking, the funnel, and the result envelope.

The invariant that matters most here is that the funnel cannot lie. Its final
survivor count must equal the number of passing candidates — if a row claims a
gate killed forty symbols, forty symbols really left at that row. A funnel that
drifts from the results table is worse than no funnel, because it is read as
evidence when tuning gates.
"""

from __future__ import annotations

import unittest

from engine.screen import GATE_ORDER, blank_gates, run_screen

H = 60 * 60 * 1000


def rising(n=120, start=100.0, step=0.5):
    out = []
    for i in range(n):
        o = start + i * step
        out.append([i * H, o, o + step + 0.1, o - 0.1, o + step, 100.0])
    return out


def falling(n=120, start=200.0, step=0.5):
    out = []
    for i in range(n):
        o = start - i * step
        out.append([i * H, o, o + 0.1, o - step - 0.1, o - step, 100.0])
    return out


def sym(symbol, **kw):
    base = {
        "symbol": symbol, "last": 100.0, "change24h": -5.0,
        "volume24h": 5_000_000.0, "marketCap": 500_000_000.0,
        "held": False, "candles": {"1hr": rising()},
    }
    base.update(kw)
    return base


def job(symbols, gates=None, **kw):
    g = blank_gates()
    for key, value in (gates or {}).items():
        g[key].update(value)
    screener = {
        "id": "test", "name": "TEST", "timeframe": "1hr",
        "universe": kw.pop("universe", "ALL"), "gates": g,
    }
    out = {"schemaVersion": 1, "screener": screener, "symbols": symbols, "now": 1_700_000_000_000}
    out.update(kw)
    return out


class TestResultEnvelope(unittest.TestCase):
    def test_reports_the_screener_and_timeframe_it_ran(self):
        r = run_screen(job([sym("AUSD")]))
        self.assertEqual(r["screenerId"], "test")
        self.assertEqual(r["timeframe"], "1hr")
        self.assertEqual(r["schemaVersion"], 1)

    def test_counts_the_universe_and_the_passers(self):
        r = run_screen(job(
            [sym("AUSD", volume24h=5_000_000.0), sym("BUSD", volume24h=100.0)],
            {"volume24h": {"enabled": True, "min": 1_000_000}},
        ))
        self.assertEqual(r["universe"], 2)
        self.assertEqual(r["passing"], 1)

    def test_scanned_at_comes_from_the_job_not_the_wall_clock(self):
        # A clock read inside the engine would make results irreproducible and the
        # whole test suite time-dependent.
        r = run_screen(job([sym("AUSD")], now=1_234))
        self.assertEqual(r["scannedAt"], 1_234)

    def test_an_empty_universe_is_a_valid_empty_result(self):
        r = run_screen(job([]))
        self.assertEqual(r["universe"], 0)
        self.assertEqual(r["passing"], 0)
        self.assertEqual(r["candidates"], [])


class TestRanking(unittest.TestCase):
    def test_passing_symbols_sort_ahead_of_blocked_ones(self):
        r = run_screen(job(
            [sym("FAILUSD", volume24h=100.0), sym("PASSUSD", volume24h=9_000_000.0)],
            {"volume24h": {"enabled": True, "min": 1_000_000}},
        ))
        self.assertEqual([c["symbol"] for c in r["candidates"]], ["PASSUSD", "FAILUSD"])

    def test_higher_fit_sorts_first_among_equals(self):
        r = run_screen(job(
            [sym("EDGEUSD", volume24h=1_050_000.0), sym("DEEPUSD", volume24h=5_500_000.0)],
            {"volume24h": {"enabled": True, "min": 1_000_000, "max": 10_000_000}},
        ))
        self.assertEqual(r["candidates"][0]["symbol"], "DEEPUSD")

    def test_ties_break_alphabetically_so_the_order_is_stable(self):
        r = run_screen(job([sym("CUSD"), sym("AUSD"), sym("BUSD")]))
        self.assertEqual([c["symbol"] for c in r["candidates"]], ["AUSD", "BUSD", "CUSD"])

    def test_reversing_the_input_does_not_change_the_output_order(self):
        symbols = [sym("AUSD"), sym("BUSD"), sym("CUSD")]
        a = run_screen(job(list(symbols)))
        b = run_screen(job(list(reversed(symbols))))
        self.assertEqual([c["symbol"] for c in a["candidates"]], [c["symbol"] for c in b["candidates"]])


class TestFunnel(unittest.TestCase):
    def test_opens_with_the_whole_universe(self):
        r = run_screen(job([sym("AUSD"), sym("BUSD")]))
        self.assertEqual(r["funnel"][0]["gate"], "universe")
        self.assertEqual(r["funnel"][0]["survivors"], 2)

    def test_only_enabled_gates_get_a_row(self):
        r = run_screen(job([sym("AUSD")], {"volume24h": {"enabled": True, "min": 1}}))
        gates = [s["gate"] for s in r["funnel"]]
        self.assertIn("volume24h", gates)
        self.assertNotIn("marketCap", gates)

    def test_rows_follow_gate_order(self):
        r = run_screen(job([sym("AUSD")], {
            "relVolume": {"enabled": True, "max": 99},
            "marketCap": {"enabled": True, "min": 1},
            "rsi": {"enabled": True, "min": 0},
        }))
        rows = [s["gate"] for s in r["funnel"] if s["gate"] in GATE_ORDER]
        self.assertEqual(rows, sorted(rows, key=GATE_ORDER.index))

    def test_survivors_and_kills_reconcile_at_every_row(self):
        symbols = [sym("A%dUSD" % i, volume24h=float(i) * 1_000_000) for i in range(10)]
        r = run_screen(job(symbols, {
            "volume24h": {"enabled": True, "min": 3_000_000},
            "rsi": {"enabled": True, "min": 50},
        }))
        prev = r["funnel"][0]["survivors"]
        for step in r["funnel"][1:]:
            self.assertEqual(step["killed"], prev - step["survivors"])
            self.assertLessEqual(step["survivors"], prev)
            prev = step["survivors"]

    def test_the_last_row_equals_the_passing_count(self):
        # The funnel and the results table are two views of one elimination. If this
        # drifts, the tuning view is quietly lying about what the gates did.
        symbols = [sym("A%dUSD" % i, volume24h=float(i) * 1_000_000) for i in range(10)]
        r = run_screen(job(symbols, {
            "volume24h": {"enabled": True, "min": 3_000_000},
            "change24h": {"enabled": True, "max": -1},
        }))
        self.assertEqual(r["funnel"][-1]["survivors"], r["passing"])

    def test_with_no_gates_the_funnel_is_just_the_universe(self):
        r = run_screen(job([sym("AUSD")]))
        self.assertEqual(len(r["funnel"]), 1)
        self.assertEqual(r["funnel"][0]["survivors"], r["passing"])

    def test_a_seeded_row_appears_only_when_a_candle_gate_needs_one(self):
        with_candles = run_screen(job([sym("AUSD")], {"rsi": {"enabled": True, "min": 0}}))
        self.assertIn("seeded", [s["gate"] for s in with_candles["funnel"]])
        without = run_screen(job([sym("AUSD")], {"volume24h": {"enabled": True, "min": 1}}))
        self.assertNotIn("seeded", [s["gate"] for s in without["funnel"]])

    def test_unseeded_symbols_are_counted_out_at_the_seeded_row(self):
        r = run_screen(job(
            [sym("AUSD"), sym("BUSD", candles={"1hr": []})],
            {"rsi": {"enabled": True, "min": 0}},
        ))
        seeded = next(s for s in r["funnel"] if s["gate"] == "seeded")
        self.assertEqual(seeded["survivors"], 1)
        self.assertEqual(seeded["killed"], 1)

    def test_every_row_carries_a_readable_label(self):
        r = run_screen(job([sym("AUSD")], {"marketCap": {"enabled": True, "min": 1}}))
        for step in r["funnel"]:
            self.assertTrue(step["label"].strip())


class TestUniverseSelection(unittest.TestCase):
    def test_held_restricts_the_scan_to_open_positions(self):
        r = run_screen(job(
            [sym("AUSD", held=True), sym("BUSD", held=False)],
            universe="HELD",
        ))
        self.assertEqual(r["universe"], 1)
        self.assertEqual([c["symbol"] for c in r["candidates"]], ["AUSD"])

    def test_all_scans_everything(self):
        r = run_screen(job([sym("AUSD", held=True), sym("BUSD")], universe="ALL"))
        self.assertEqual(r["universe"], 2)


class TestDegradedGates(unittest.TestCase):
    def test_reports_which_gates_ran_without_their_data(self):
        r = run_screen(job(
            [sym("AUSD", marketCap=None), sym("BUSD", marketCap=None)],
            {"marketCap": {"enabled": True, "min": 100}},
        ))
        self.assertEqual(r["degradedGates"], ["marketCap"])
        self.assertEqual(r["passing"], 2)

    def test_lists_nothing_when_every_gate_had_its_data(self):
        r = run_screen(job([sym("AUSD")], {"marketCap": {"enabled": True, "min": 100}}))
        self.assertEqual(r["degradedGates"], [])

    def test_a_gate_degraded_for_only_some_symbols_still_reports(self):
        r = run_screen(job(
            [sym("AUSD"), sym("BUSD", marketCap=None)],
            {"marketCap": {"enabled": True, "min": 100}},
        ))
        self.assertEqual(r["degradedGates"], ["marketCap"])


class TestDeterminism(unittest.TestCase):
    def test_the_same_job_produces_the_same_result_twice(self):
        j = job(
            [sym("AUSD", candles={"1hr": falling()}), sym("BUSD")],
            {"rsi": {"enabled": True, "max": 35}, "volume24h": {"enabled": True, "min": 1}},
        )
        self.assertEqual(run_screen(j), run_screen(j))

    def test_the_job_is_not_mutated_by_running_it(self):
        import copy
        j = job([sym("AUSD")], {"rsi": {"enabled": True, "max": 35}})
        before = copy.deepcopy(j)
        run_screen(j)
        self.assertEqual(j, before)


class TestSchemaGuard(unittest.TestCase):
    def test_refuses_a_job_from_a_newer_schema(self):
        with self.assertRaises(ValueError) as ctx:
            run_screen(job([sym("AUSD")], schemaVersion=99))
        self.assertIn("schemaVersion", str(ctx.exception))

    def test_refuses_a_job_with_no_screener(self):
        with self.assertRaises(ValueError):
            run_screen({"schemaVersion": 1, "symbols": [], "now": 0})


class TestMultiTimeframe(unittest.TestCase):
    def test_a_4hr_screen_reads_rolled_up_bars(self):
        # Same underlying tape, different bar size: the 4hr RSI is computed from
        # 4hr bars, so a screen can genuinely disagree across timeframes.
        symbols = [sym("AUSD", candles={"1hr": falling(n=200)})]
        one_hour = run_screen(job(symbols, {"rsi": {"enabled": True, "max": 35}}))
        four = dict(job(symbols, {"rsi": {"enabled": True, "max": 35}}))
        four["screener"] = dict(four["screener"], timeframe="4hr")
        self.assertTrue(one_hour["candidates"][0]["passes"])
        self.assertTrue(run_screen(four)["candidates"][0]["passes"])

    def test_a_timeframe_with_no_base_feed_blocks_on_data(self):
        symbols = [sym("AUSD", candles={"1hr": falling(n=200)})]
        weekly = dict(job(symbols, {"rsi": {"enabled": True, "max": 35}}))
        weekly["screener"] = dict(weekly["screener"], timeframe="1week")
        r = run_screen(weekly)
        self.assertEqual(r["candidates"][0]["blockedBy"], "rsi")


if __name__ == "__main__":
    unittest.main()


class TestHumanReadableNumbers(unittest.TestCase):
    """Blocked reasons and funnel labels are read by a person, not a parser.

    Python's %g reaches for scientific notation around five digits, which turned a
    $50,000 volume floor into "5e+04" in the one sentence whose whole job is to be
    understood at a glance.
    """

    def test_thousands_and_millions_are_abbreviated_not_exponential(self):
        from engine.screen import _fmt
        self.assertEqual(_fmt(50_000), "50K")
        self.assertEqual(_fmt(1_000_000), "1M")
        self.assertEqual(_fmt(8_400_000), "8.4M")
        self.assertEqual(_fmt(1_500_000_000), "1.5B")

    def test_small_numbers_stay_exact(self):
        from engine.screen import _fmt
        self.assertEqual(_fmt(35), "35")
        self.assertEqual(_fmt(1.5), "1.5")
        self.assertEqual(_fmt(-12), "-12")

    def test_no_result_text_ever_contains_scientific_notation(self):
        r = run_screen(job(
            [sym("AUSD", volume24h=56.0)],
            {"volume24h": {"enabled": True, "min": 50_000}},
        ))
        blob = " ".join(
            [c["blockedReason"] or "" for c in r["candidates"]] + [s["label"] for s in r["funnel"]]
        )
        self.assertNotIn("e+", blob)
        self.assertIn("50K", blob)
