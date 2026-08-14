#!/usr/bin/env python3
"""Screener engine CLI — the only surface server/screenerRunner.ts talks to.

    echo '<job json>' | python3 engine/screener_engine.py     → result json, exit 0
    python3 engine/screener_engine.py --contract              → wire contract, exit 0

STDOUT IS A SINGLE JSON DOCUMENT. Nothing else may ever be written there: a stray
print, a warning, or a traceback would corrupt the parse on the Node side, which
would surface to the user as "the screener engine failed" when the truth was a
debug statement. Diagnostics go to stderr. Failures come back as a structured
{"error": ...} document with exit 1, so the caller always has JSON to read.

There is no network access, no model call, and no clock read in this process. The
job carries its own timestamp. Given the same job it returns the same bytes, which
is what makes the whole thing testable and what makes a screener reproducible.
"""

from __future__ import annotations

import json
import os
import sys

# Allow running as a plain script (python3 engine/screener_engine.py) as well as a
# module — the server spawns it by path, without the repo root on PYTHONPATH.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from engine.patterns import ALL_PATTERNS               # noqa: E402
from engine.rollup import TIMEFRAME_SOURCE             # noqa: E402
from engine.screen import GATE_ORDER, SCHEMA_VERSION, run_screen  # noqa: E402


def fail(message: str, detail: str = "") -> int:
    """Emit a structured error on stdout so the caller always parses JSON."""
    body = {"schemaVersion": SCHEMA_VERSION, "error": message}
    if detail:
        body["detail"] = detail
    json.dump(body, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 1


def contract() -> int:
    """The wire agreement, for the TypeScript side to assert against at runtime.

    Cheaper and more honest than duplicating these lists in a test fixture: the
    check reads them from the engine that will actually run.
    """
    json.dump(
        {
            "schemaVersion": SCHEMA_VERSION,
            "gates": list(GATE_ORDER),
            "patterns": list(ALL_PATTERNS),
            "timeframes": list(TIMEFRAME_SOURCE.keys()),
        },
        sys.stdout, separators=(",", ":"),
    )
    sys.stdout.write("\n")
    return 0


def main(argv) -> int:
    if "--contract" in argv:
        return contract()

    raw = sys.stdin.read()
    if not raw.strip():
        return fail("no job on stdin")

    try:
        job = json.loads(raw)
    except ValueError as exc:
        return fail("job is not valid JSON", str(exc))

    if not isinstance(job, dict):
        return fail("job must be a JSON object, got %s" % type(job).__name__)

    try:
        result = run_screen(job)
    except ValueError as exc:
        return fail(str(exc))
    except Exception as exc:  # never leak a traceback onto stdout
        print("screener engine crashed: %r" % (exc,), file=sys.stderr)
        return fail("screener engine failed", str(exc))

    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
