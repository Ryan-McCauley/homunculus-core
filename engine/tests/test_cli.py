"""The process contract: stdin job in, stdout result out.

This is the only surface the Node server touches, so the rules are strict and
mechanical. stdout carries exactly one JSON document and nothing else — a stray
print or a traceback leaking onto stdout would corrupt the parse on the other
side, and the server would report "screener engine failed" for what was really a
debug statement. Diagnostics go to stderr; failures come back as structured JSON
with a non-zero exit.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ENGINE = os.path.join(REPO, "engine", "screener_engine.py")

H = 60 * 60 * 1000


def run(stdin_text, args=(), timeout=60):
    proc = subprocess.run(
        [sys.executable, ENGINE, *args],
        input=stdin_text, capture_output=True, text=True, timeout=timeout, cwd=REPO,
    )
    return proc


def candles(n=120, start=100.0, step=0.5):
    out = []
    for i in range(n):
        o = start + i * step
        out.append([i * H, o, o + step + 0.1, o - 0.1, o + step, 100.0])
    return out


def gates(**over):
    base = {
        "marketCap": {"enabled": False, "min": None, "max": None},
        "volume24h": {"enabled": False, "min": None, "max": None},
        "change24h": {"enabled": False, "min": None, "max": None},
        "rsi": {"enabled": False, "min": None, "max": None},
        "ema50": {"enabled": False, "trend": "ANY"},
        "ema200": {"enabled": False, "trend": "ANY"},
        "macd": {"enabled": False, "cross": "ANY"},
        "bbWidth": {"enabled": False, "min": None, "max": None},
        "pattern": {"enabled": False, "names": []},
        "freshness": {"enabled": False, "min": None, "max": None},
        "relVolume": {"enabled": False, "min": None, "max": None},
    }
    for k, v in over.items():
        base[k].update(v)
    return base


def job(n_symbols=2, **gate_over):
    return {
        "schemaVersion": 1,
        "screener": {
            "id": "cli-test", "name": "CLI TEST", "timeframe": "1hr",
            "universe": "ALL", "gates": gates(**gate_over),
        },
        "symbols": [
            {
                "symbol": "T%dUSD" % i, "last": 100.0, "change24h": -3.0,
                "volume24h": 2_000_000.0, "marketCap": 400_000_000.0,
                "held": False, "candles": {"1hr": candles()},
            }
            for i in range(n_symbols)
        ],
        "now": 1_700_000_000_000,
    }


class TestHappyPath(unittest.TestCase):
    def test_returns_a_result_document_and_exits_zero(self):
        proc = run(json.dumps(job()))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["screenerId"], "cli-test")
        self.assertEqual(result["universe"], 2)

    def test_stdout_is_exactly_one_json_document(self):
        proc = run(json.dumps(job()))
        decoder = json.JSONDecoder()
        _, end = decoder.raw_decode(proc.stdout.lstrip())
        self.assertEqual(proc.stdout.lstrip()[end:].strip(), "")

    def test_applies_the_gates_it_was_given(self):
        proc = run(json.dumps(job(volume24h={"enabled": True, "min": 10_000_000})))
        result = json.loads(proc.stdout)
        self.assertEqual(result["passing"], 0)
        self.assertEqual(result["candidates"][0]["blockedBy"], "volume24h")

    def test_the_same_input_produces_byte_identical_output(self):
        payload = json.dumps(job(rsi={"enabled": True, "max": 90}))
        self.assertEqual(run(payload).stdout, run(payload).stdout)


class TestFailureModes(unittest.TestCase):
    def test_malformed_json_is_a_structured_error_not_a_traceback(self):
        proc = run("{not json")
        self.assertEqual(proc.returncode, 1)
        body = json.loads(proc.stdout)
        self.assertIn("error", body)
        self.assertNotIn("Traceback", proc.stdout)

    def test_empty_stdin_is_a_structured_error(self):
        proc = run("")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("error", json.loads(proc.stdout))

    def test_a_schema_mismatch_is_refused_by_name(self):
        bad = job()
        bad["schemaVersion"] = 99
        proc = run(json.dumps(bad))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("schemaVersion", json.loads(proc.stdout)["error"])

    def test_a_job_without_a_screener_is_refused(self):
        proc = run(json.dumps({"schemaVersion": 1, "symbols": [], "now": 0}))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("error", json.loads(proc.stdout))

    def test_a_top_level_array_is_refused_rather_than_crashing(self):
        proc = run("[1,2,3]")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("error", json.loads(proc.stdout))

    def test_one_unusable_symbol_does_not_void_the_scan(self):
        j = job(1, rsi={"enabled": True, "min": 0})
        j["symbols"].append({"symbol": "BADUSD", "candles": "not-a-dict"})
        proc = run(json.dumps(j))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("BADUSD", result["errors"][0])
        self.assertEqual(result["passing"], 1)


class TestContractFlag(unittest.TestCase):
    """--contract lets the TypeScript side assert the wire agreement at runtime."""

    def test_reports_the_schema_gates_patterns_and_timeframes(self):
        proc = run("", args=["--contract"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        body = json.loads(proc.stdout)
        self.assertEqual(body["schemaVersion"], 1)
        self.assertEqual(body["gates"][0], "marketCap")
        self.assertIn("dragonfly_doji", body["patterns"])
        self.assertIn("1week", body["timeframes"])

    def test_needs_no_stdin_at_all(self):
        proc = subprocess.run(
            [sys.executable, ENGINE, "--contract"],
            capture_output=True, text=True, timeout=30, cwd=REPO, stdin=subprocess.DEVNULL,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)


class TestPerformance(unittest.TestCase):
    def test_a_full_universe_scan_finishes_promptly(self):
        # 142 USD pairs is the live universe; 500 hourly bars is what the cache holds.
        # This runs on every refresh, so a slow engine is a slow tab.
        big = job(0, rsi={"enabled": True, "max": 35}, pattern={"enabled": True, "names": ["hammer", "dragonfly_doji"]})
        bars = candles(n=500)
        big["symbols"] = [
            {
                "symbol": "P%dUSD" % i, "last": 100.0, "change24h": -3.0,
                "volume24h": 2_000_000.0, "marketCap": 400_000_000.0,
                "held": False, "candles": {"1hr": bars},
            }
            for i in range(142)
        ]
        payload = json.dumps(big)
        started = time.time()
        proc = run(payload, timeout=60)
        elapsed = time.time() - started
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertLess(elapsed, 10.0, "full-universe scan took %.1fs" % elapsed)


class TestJsonSafety(unittest.TestCase):
    """stdout must always be parseable by JSON.parse on the Node side."""

    def test_non_finite_values_never_reach_stdout(self):
        # json.loads ACCEPTS these literals, so a job can carry them straight in —
        # and an overflowed EMA can manufacture them internally. Either way, bare
        # NaN/Infinity on stdout is invalid JSON and fails the whole scan rather
        # than one symbol.
        j = job(0, rsi={"enabled": True, "max": 90})
        j["symbols"] = [{
            "symbol": "NANUSD", "last": float("nan"), "change24h": float("inf"),
            "volume24h": float("-inf"), "marketCap": 1e308,
            "held": False, "candles": {"1hr": candles(n=60)},
        }]
        proc = run(json.dumps(j))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("NaN", proc.stdout)
        self.assertNotIn("Infinity", proc.stdout)
        json.loads(proc.stdout)  # strict parse: raises if the document is malformed

    def test_json_safe_helper_maps_non_finite_to_none(self):
        from engine.screener_engine import _json_safe
        self.assertEqual(
            _json_safe({"a": float("nan"), "b": [float("inf"), 1.5], "c": "ok"}),
            {"a": None, "b": [None, 1.5], "c": "ok"},
        )


if __name__ == "__main__":
    unittest.main()
