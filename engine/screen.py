"""Screen evaluation — the deterministic core of the screener engine.

Given a screener definition, a symbol's market stats and its candles, decide:
does it pass, and if not, WHICH gate stopped it. No network, no model, no clock
reads: the same job always produces the same result, which is what lets the whole
thing be tested as a pure function.

THREE RULES SHAPE EVERYTHING HERE.

1. The blocking gate is the FIRST failure in GATE_ORDER, not the worst one. The
   rail is read top to bottom, so "blocked by market cap" has to mean the user's
   first filter, not whichever gate happened to fail hardest.

2. Missing data is not the same as failing. A gate marked OPTIONAL_DATA (market
   cap, which needs CoinMarketCap) steps aside and flags itself as degraded when
   its feed is absent — failing every symbol would make an unconfigured API key
   look like an empty market. Every other gate FAILS when its input cannot be
   computed, because a symbol with nine candles genuinely cannot be screened on
   RSI and quietly admitting it would be a lie about what was filtered.

3. Fit is mostly "how many gates did you clear", with a minority weight on "how
   comfortably". Two symbols that both pass everything should not tie, and the
   tiebreak that matters to a trader is margin: deeper into the range, fresher
   pattern, more room before the bound.

Gate order matters twice more: the funnel eliminates in it (cheap market compares
before expensive candle walks), and results sort by it. It comes from
shared/screener.ts and the two lists are asserted equal in the CLI tests.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from engine.indicators import (
    bb_width_pct, closes_of, crossed_above, crossed_below, ema, last_pair,
    last_value, macd, rel_volume, rsi, volumes_of,
)
from engine.patterns import latest_pattern
from engine.rollup import candles_for_timeframe

#: Mirrors GATE_ORDER in shared/screener.ts. Order is user-visible — see module docstring.
GATE_ORDER: Tuple[str, ...] = (
    "marketCap", "volume24h", "change24h",
    "rsi", "ema50", "ema200", "macd", "bbWidth",
    "pattern", "freshness", "relVolume",
)

#: Gates whose input comes from a feed the app may simply not have configured.
# Both come from CoinMarketCap: cap has always needed it, and volume is deliberately
# CMC's cross-exchange aggregate rather than Gemini's own book (one thin venue does not
# represent the market). A missing read degrades the gate to ANY instead of failing the
# symbol — the TS side mirrors this via GATE_META.optionalData.
OPTIONAL_DATA = frozenset({"marketCap", "volume24h"})

RANGE_GATES = frozenset({"marketCap", "volume24h", "change24h", "rsi", "bbWidth", "freshness", "relVolume"})
TREND_GATES = frozenset({"ema50", "ema200"})

GATE_LABELS = {
    "marketCap": "market cap", "volume24h": "24h volume", "change24h": "24h change",
    "rsi": "RSI", "ema50": "EMA 50", "ema200": "EMA 200", "macd": "MACD",
    "bbWidth": "BB width", "pattern": "candle pattern", "freshness": "freshness",
    "relVolume": "relative volume",
}

EMA_PERIOD = {"ema50": 50, "ema200": 200}

#: How far back the pattern scan looks when no freshness bound narrows it.
DEFAULT_PATTERN_SCAN = 10


def blank_gates() -> Dict[str, Dict[str, Any]]:
    """Every gate disabled — mirrors blankGates() in shared/screener.ts."""
    return {
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


def _gate(screener: Dict[str, Any], gate_id: str) -> Dict[str, Any]:
    """A gate from the definition, or a disabled stand-in.

    A definition missing a gate is treated as having it switched off rather than as
    a fatal job: an older saved screener should keep working after a new gate ships.
    """
    gates = screener.get("gates") or {}
    got = gates.get(gate_id)
    if not isinstance(got, dict):
        return blank_gates()[gate_id]
    return got


def _fmt(v: float) -> str:
    """A number as a person would write it, for blocked reasons and funnel labels.

    Never scientific notation: %g switches to it around five digits, which turned a
    $50,000 volume floor into "5e+04" in the one sentence whose entire job is to be
    understood at a glance.
    """
    def trim(x: float) -> str:
        return ("%.1f" % x).rstrip("0").rstrip(".")

    a = abs(v)
    if a >= 1_000_000_000:
        return trim(v / 1_000_000_000.0) + "B"
    if a >= 1_000_000:
        return trim(v / 1_000_000.0) + "M"
    if a >= 1_000:
        return trim(v / 1_000.0) + "K"
    if a >= 1 or v == 0:
        return trim(v)
    return "%.4g" % v


# ── Range helpers ─────────────────────────────────────────────────────────────

def _range_pass(value: float, lo: Optional[float], hi: Optional[float]) -> bool:
    """Bounds are INCLUSIVE — a user typing 35 means "35 counts"."""
    if lo is not None and value < lo:
        return False
    if hi is not None and value > hi:
        return False
    return True


def _range_reason(gate_id: str, value: float, lo: Optional[float], hi: Optional[float]) -> str:
    label = GATE_LABELS[gate_id]
    if lo is not None and value < lo:
        return "%s %s is below the %s floor" % (label, _fmt(value), _fmt(lo))
    if hi is not None and value > hi:
        return "%s %s is above the %s ceiling" % (label, _fmt(value), _fmt(hi))
    return ""


def _range_margin(value: float, lo: Optional[float], hi: Optional[float]) -> float:
    """0–1 measure of how comfortably a value clears its bounds.

    One-sided: how far past the bound, normalised by the bound's own scale and
    saturating at 1. Two-sided: distance from the nearer edge as a share of the
    half-width, so dead centre is 1 and sitting on an edge is 0.
    """
    if lo is not None and hi is not None:
        if hi == lo:
            return 1.0
        mid = (lo + hi) / 2.0
        half = (hi - lo) / 2.0
        return max(0.0, 1.0 - abs(value - mid) / half)
    bound = lo if lo is not None else hi
    if bound is None:
        return 1.0
    scale = abs(bound) if bound != 0 else 1.0
    slack = (value - bound) if lo is not None else (bound - value)
    return max(0.0, min(1.0, slack / scale))


def _verdict(gate_id, passed, degraded=False, value=None, text=None, reason="") -> Dict[str, Any]:
    return {
        "gate": gate_id, "pass": passed, "degraded": degraded,
        "value": value, "text": text, "reason": reason if not passed else "",
    }


def _missing(gate_id: str, what: str) -> Dict[str, Any]:
    """A gate that could not be evaluated. Degrades only for OPTIONAL_DATA gates."""
    if gate_id in OPTIONAL_DATA:
        return _verdict(gate_id, True, degraded=True, reason="")
    return _verdict(gate_id, False, reason="not enough data — %s" % what)


# ── Per-gate evaluation ───────────────────────────────────────────────────────

def _eval_stat(gate_id: str, gate: Dict[str, Any], value: Optional[float]) -> Dict[str, Any]:
    if value is None:
        return _missing(gate_id, "no %s available" % GATE_LABELS[gate_id])
    lo, hi = gate.get("min"), gate.get("max")
    ok = _range_pass(value, lo, hi)
    return _verdict(gate_id, ok, value=value, reason=_range_reason(gate_id, value, lo, hi))


def _eval_trend(gate_id: str, gate: Dict[str, Any], closes: Sequence[float]) -> Dict[str, Any]:
    want = gate.get("trend", "ANY")
    period = EMA_PERIOD[gate_id]
    line = last_value(ema(closes, period))
    if line is None or not closes:
        return _missing(gate_id, "fewer than %d bars of history" % period)
    price = closes[-1]
    side = "ABOVE" if price >= line else "BELOW"
    ok = want == "ANY" or side == want
    reason = "price is %s the %s, not %s" % (side.lower(), GATE_LABELS[gate_id], want.lower())
    return _verdict(gate_id, ok, value=line, text=side, reason=reason)


def _eval_macd(gate: Dict[str, Any], closes: Sequence[float]) -> Dict[str, Any]:
    want = gate.get("cross", "ANY")
    m = macd(closes)
    hist = last_value(m["histogram"])
    if hist is None:
        return _missing("macd", "fewer bars than the MACD needs to warm up")
    if want == "ANY":
        return _verdict("macd", True, value=hist)
    macd_pair, signal_pair = last_pair(m["macd"]), last_pair(m["signal"])
    if macd_pair is None or signal_pair is None:
        return _missing("macd", "only one MACD bar — a cross needs two")
    if want == "BULLISH":
        ok = crossed_above(macd_pair, signal_pair)
        reason = "no bullish MACD cross on the last bar"
    else:
        ok = crossed_below(macd_pair, signal_pair)
        reason = "no bearish MACD cross on the last bar"
    return _verdict("macd", ok, value=hist, text=want, reason=reason)


def _eval_pattern(gate: Dict[str, Any], candles, scan: int) -> Tuple[Dict[str, Any], Optional[str], Optional[int]]:
    names = gate.get("names") or []
    if not candles:
        return (_missing("pattern", "no candles"), None, None)
    name, age = latest_pattern(candles, names, max_scan=scan)
    if name is None:
        return (
            _verdict("pattern", False, reason="no %s in the last %d bars" % (
                " / ".join(names) if len(names) <= 3 else "whitelisted pattern", scan)),
            None, None,
        )
    return (_verdict("pattern", True, text=name, value=age), name, age)


def _eval_freshness(gate: Dict[str, Any], age: Optional[int]) -> Dict[str, Any]:
    if age is None:
        # Freshness measures a pattern's age. With no pattern found there is nothing
        # to be fresh, so this fails rather than passing vacuously.
        return _verdict("freshness", False, reason="no pattern found to measure freshness against")
    lo, hi = gate.get("min"), gate.get("max")
    ok = _range_pass(float(age), lo, hi)
    reason = "pattern is %d bars old, past the %s-bar limit" % (age, _fmt(hi)) if hi is not None and age > hi \
        else _range_reason("freshness", float(age), lo, hi)
    return _verdict("freshness", ok, value=age, reason=reason)


# ── Symbol evaluation ─────────────────────────────────────────────────────────

def evaluate_symbol(screener: Dict[str, Any], symbol: Dict[str, Any]) -> Dict[str, Any]:
    """Evaluate one symbol against one screener. Never raises on bad data."""
    timeframe = screener.get("timeframe", "1hr")
    candles = candles_for_timeframe(symbol.get("candles") or {}, timeframe)
    closes = closes_of(candles) if candles else []
    volumes = volumes_of(candles) if candles else []

    pattern_gate = _gate(screener, "pattern")
    freshness_gate = _gate(screener, "freshness")
    # Scan far enough back to answer the freshness bound; a stale pattern must be
    # FOUND before it can be reported as stale, otherwise the user sees "no pattern"
    # when the truth is "pattern, but old".
    scan = DEFAULT_PATTERN_SCAN
    if freshness_gate.get("enabled") and isinstance(freshness_gate.get("max"), (int, float)):
        scan = max(scan, int(freshness_gate["max"]) + 1)

    pattern_name: Optional[str] = None
    pattern_age: Optional[int] = None
    if pattern_gate.get("enabled") and candles:
        pattern_name, pattern_age = latest_pattern(candles, pattern_gate.get("names") or [], max_scan=scan)

    rsi_value = last_value(rsi(closes, 14)) if closes else None

    verdicts: List[Dict[str, Any]] = []
    for gate_id in GATE_ORDER:
        gate = _gate(screener, gate_id)
        if not gate.get("enabled"):
            verdicts.append(_verdict(gate_id, True))
            continue

        if gate_id == "marketCap":
            verdicts.append(_eval_stat(gate_id, gate, symbol.get("marketCap")))
        elif gate_id == "volume24h":
            verdicts.append(_eval_stat(gate_id, gate, symbol.get("volume24h")))
        elif gate_id == "change24h":
            verdicts.append(_eval_stat(gate_id, gate, symbol.get("change24h")))
        elif gate_id == "rsi":
            verdicts.append(_eval_stat(gate_id, gate, rsi_value))
        elif gate_id in TREND_GATES:
            verdicts.append(_eval_trend(gate_id, gate, closes))
        elif gate_id == "macd":
            verdicts.append(_eval_macd(gate, closes))
        elif gate_id == "bbWidth":
            verdicts.append(_eval_stat(gate_id, gate, bb_width_pct(closes) if closes else None))
        elif gate_id == "pattern":
            v, pattern_name, pattern_age = _eval_pattern(gate, candles, scan)
            verdicts.append(v)
        elif gate_id == "freshness":
            verdicts.append(_eval_freshness(gate, pattern_age))
        elif gate_id == "relVolume":
            verdicts.append(_eval_stat(gate_id, gate, rel_volume(volumes) if volumes else None))

    blocked = next((v for v in verdicts if not v["pass"]), None)

    return {
        "symbol": symbol.get("symbol", ""),
        "last": symbol.get("last", 0.0),
        "change24h": symbol.get("change24h"),
        "volume24h": symbol.get("volume24h"),
        "marketCap": symbol.get("marketCap"),
        "held": bool(symbol.get("held")),
        "fit": _fit(screener, verdicts),
        "passes": blocked is None,
        "gates": verdicts,
        "blockedBy": blocked["gate"] if blocked else None,
        "blockedReason": blocked["reason"] if blocked else None,
        "rsi": rsi_value,
        "pattern": pattern_name,
        "patternAgeBars": pattern_age,
    }


def _fit(screener: Dict[str, Any], verdicts: Sequence[Dict[str, Any]]) -> int:
    """0–100: 75% how many enabled gates cleared, 25% how comfortably.

    The margin quarter is what separates two symbols that both pass everything —
    without it the results table is a pile of ties and the ranking says nothing.
    """
    enabled = [v for v in verdicts if _gate(screener, v["gate"]).get("enabled")]
    if not enabled:
        return 100

    passed = sum(1 for v in enabled if v["pass"])
    base = passed / float(len(enabled))

    margins: List[float] = []
    for v in enabled:
        gate_id = v["gate"]
        gate = _gate(screener, gate_id)
        if not v["pass"]:
            margins.append(0.0)
        elif v["degraded"] or v["value"] is None or gate_id not in RANGE_GATES:
            margins.append(1.0)
        elif gate_id == "freshness":
            hi = gate.get("max")
            span = float(hi) + 1.0 if hi is not None else float(DEFAULT_PATTERN_SCAN)
            margins.append(max(0.0, 1.0 - (float(v["value"]) / span)))
        else:
            margins.append(_range_margin(float(v["value"]), gate.get("min"), gate.get("max")))

    quality = sum(margins) / float(len(margins))
    return int(round(100.0 * (0.75 * base + 0.25 * quality)))


# ── Whole-screen orchestration ────────────────────────────────────────────────

#: The schema this engine implements. Must equal SCREENER_SCHEMA_VERSION in
#: shared/screener.ts; a mismatch is refused rather than guessed at, because a
#: silently misread gate is a screener that lies about what it filtered.
SCHEMA_VERSION = 1

#: Gates that cannot be answered without candle history. Their presence is what
#: earns the funnel its SEEDED row.
CANDLE_GATES = frozenset({"rsi", "ema50", "ema200", "macd", "bbWidth", "pattern", "freshness", "relVolume"})

FUNNEL_LABELS = {
    "marketCap": "MKT CAP", "volume24h": "VOL 24H", "change24h": "Δ 24H",
    "rsi": "RSI", "ema50": "EMA 50", "ema200": "EMA 200", "macd": "MACD CROSS",
    "bbWidth": "BB WIDTH", "pattern": "CANDLE PATTERN", "freshness": "FRESHNESS",
    "relVolume": "REL VOLUME",
}


def _bound_text(gate: Dict[str, Any]) -> str:
    lo, hi = gate.get("min"), gate.get("max")
    if lo is not None and hi is not None:
        return "%s … %s" % (_fmt(lo), _fmt(hi))
    if lo is not None:
        return "≥ %s" % _fmt(lo)
    if hi is not None:
        return "≤ %s" % _fmt(hi)
    return ""


def _funnel_label(gate_id: str, gate: Dict[str, Any]) -> str:
    name = FUNNEL_LABELS.get(gate_id, gate_id.upper())
    if gate_id in RANGE_GATES:
        bound = _bound_text(gate)
        return "%s %s" % (name, bound) if bound else name
    if gate_id in TREND_GATES:
        return "%s · %s" % (name, gate.get("trend", "ANY"))
    if gate_id == "macd":
        return "%s · %s" % (name, gate.get("cross", "ANY"))
    if gate_id == "pattern":
        names = gate.get("names") or []
        return "%s · %d whitelisted" % (name, len(names))
    return name


def run_screen(job: Dict[str, Any]) -> Dict[str, Any]:
    """Run one screener over a universe of symbols. Pure: no clock, no network.

    Raises ValueError only for a malformed job — a bad SYMBOL is recorded in
    `errors` and skipped, because one unparseable coin should not void a scan of
    a hundred and forty.
    """
    version = job.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise ValueError(
            "job schemaVersion %r does not match this engine (%d)" % (version, SCHEMA_VERSION))
    screener = job.get("screener")
    if not isinstance(screener, dict):
        raise ValueError("job is missing its screener definition")

    symbols = list(job.get("symbols") or [])
    if screener.get("universe") == "HELD":
        symbols = [s for s in symbols if s.get("held")]

    timeframe = screener.get("timeframe", "1hr")
    errors: List[str] = []
    candidates: List[Dict[str, Any]] = []
    seeded: Dict[str, bool] = {}

    for entry in symbols:
        try:
            candidates.append(evaluate_symbol(screener, entry))
            seeded[entry.get("symbol", "")] = bool(candles_for_timeframe(entry.get("candles") or {}, timeframe))
        except Exception as exc:  # one bad symbol must not void the scan
            errors.append("%s: %s" % (entry.get("symbol", "?"), exc))

    # Passing first, then best fit, then alphabetical — the last key makes the
    # order reproducible when fit ties, which it often does on small gate sets.
    candidates.sort(key=lambda c: (not c["passes"], -c["fit"], c["symbol"]))

    enabled = [g for g in GATE_ORDER if _gate(screener, g).get("enabled")]
    verdict_of = {c["symbol"]: {v["gate"]: v for v in c["gates"]} for c in candidates}

    funnel: List[Dict[str, Any]] = [{
        "gate": "universe", "label": "UNIVERSE · %s" % ("HELD" if screener.get("universe") == "HELD" else "ALL USD PAIRS"),
        "survivors": len(candidates), "killed": 0,
    }]
    alive = [c["symbol"] for c in candidates]

    if any(g in CANDLE_GATES for g in enabled):
        before = len(alive)
        alive = [s for s in alive if seeded.get(s)]
        funnel.append({
            "gate": "seeded", "label": "SEEDED · %s history" % timeframe,
            "survivors": len(alive), "killed": before - len(alive),
        })

    for gate_id in enabled:
        before = len(alive)
        alive = [s for s in alive if verdict_of[s][gate_id]["pass"]]
        funnel.append({
            "gate": gate_id, "label": _funnel_label(gate_id, _gate(screener, gate_id)),
            "survivors": len(alive), "killed": before - len(alive),
        })

    degraded = [g for g in GATE_ORDER
                if any(v["gate"] == g and v["degraded"] for c in candidates for v in c["gates"])]

    return {
        "schemaVersion": SCHEMA_VERSION,
        "screenerId": screener.get("id", ""),
        "timeframe": timeframe,
        "scannedAt": job.get("now", 0),
        "universe": len(candidates),
        "passing": sum(1 for c in candidates if c["passes"]),
        "candidates": candidates,
        "funnel": funnel,
        "degradedGates": degraded,
        "errors": errors,
    }
