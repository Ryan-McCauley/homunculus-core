"""Candle pattern detection for the screening engine.

Shape rules follow .claude/scripts/crypto-candles.py, which is the house definition
the trading skills already screen on — same body/wick proportions, same guards
against dead bars. What differs is the trend handling, and deliberately:

TREND CONTEXT IS ENFORCED HERE, NOT DEFERRED. crypto-candles.py emits both readings
of an ambiguous shape (hammer AND hanging_man) and tags each with the trend it
requires, leaving the caller to filter. A screener cannot do that — the user
whitelisted "hammer" and expects hammers, so a bar is only reported as one when the
downtrend it reverses is actually present. Flat, unreadable context emits neither
side rather than guessing.

Every detector is defensive about degenerate bars: zero range, zero volume, and
zero body all occur in real Gemini data on thin books, and each one divides by zero
somewhere if it is not guarded.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

T, O, HI, LO, C, V = 0, 1, 2, 3, 4, 5

#: Every pattern this engine can report. Held equal to KNOWN_PATTERNS in
#: shared/screener.ts by test_patterns.py — the two lists are one contract.
ALL_PATTERNS: Tuple[str, ...] = (
    "doji", "dragonfly_doji", "gravestone_doji", "long_legged_doji",
    "hammer", "hanging_man", "inverted_hammer", "shooting_star",
    "bullish_engulfing", "bearish_engulfing",
    "bullish_harami", "bullish_harami_cross", "bearish_harami", "bearish_harami_cross",
    "piercing_line", "dark_cloud_cover",
    "morning_star", "evening_star",
    "three_white_soldiers", "three_black_crows",
)

#: How far back trend context is read, and the move needed to call it a trend.
TREND_LOOKBACK = 5
TREND_THRESHOLD_PCT = 0.5

EPS = 1e-12


def _parse(candle: Sequence[float]) -> Dict[str, float]:
    o, h, l, c, v = float(candle[O]), float(candle[HI]), float(candle[LO]), float(candle[C]), float(candle[V])
    return {
        "o": o, "h": h, "l": l, "c": c, "v": v,
        "body": abs(c - o),
        "rng": h - l,
        "upper": h - max(o, c),
        "lower": min(o, c) - l,
        "green": c >= o,
        "top": max(o, c),
        "bottom": min(o, c),
    }


def _avg_body(ps: Sequence[Dict[str, float]], end: int, n: int = 14) -> float:
    lo = max(0, end - n)
    window = ps[lo:end]
    if not window:
        return EPS
    return (sum(p["body"] for p in window) / len(window)) or EPS


def _avg_range(ps: Sequence[Dict[str, float]], end: int, n: int = 14) -> float:
    lo = max(0, end - n)
    window = ps[lo:end]
    if not window:
        return EPS
    return (sum(p["rng"] for p in window) / len(window)) or EPS


def _is_doji(p: Dict[str, float]) -> bool:
    return p["rng"] > 0 and p["body"] <= 0.1 * p["rng"]


def trend_before(candles: Sequence[Sequence[float]], i: int) -> str:
    """Direction of the run leading INTO bar `i` — 'up', 'down' or 'flat'.

    Reads closes only, and excludes bar `i` itself: the pattern bar is the
    reversal, so letting it colour its own context would mask the very move the
    pattern is supposed to be turning.
    """
    if i <= 0:
        return "flat"
    start = max(0, i - TREND_LOOKBACK)
    if start >= i:
        return "flat"
    first = float(candles[start][C])
    prev = float(candles[i - 1][C])
    if first == 0:
        return "flat"
    move = ((prev - first) / first) * 100.0
    if move >= TREND_THRESHOLD_PCT:
        return "up"
    if move <= -TREND_THRESHOLD_PCT:
        return "down"
    return "flat"


def detect_at(candles: Sequence[Sequence[float]], i: int) -> List[str]:
    """Every pattern whose FINAL candle is bar `i`, trend context already applied."""
    if i < 0 or i >= len(candles):
        return []
    ps = [_parse(c) for c in candles[:i + 1]]
    p = ps[i]
    out: List[str] = []

    if p["rng"] <= 0:
        return out  # a zero-range bar has no shape to read

    trend = trend_before(candles, i)
    ab = _avg_body(ps, i)
    avg_rng = _avg_range(ps, i)

    # ── Doji family (checked first — it excludes the hammer family below) ──
    if _is_doji(p):
        # A harami cross is a doji BY DEFINITION — its inside bar is supposed to be
        # tiny — so it is read before the dead-bar guard below. Applying that guard
        # first would reject every harami cross whose inside bar is narrower than
        # half the recent average range, which is most of them.
        out.extend(_harami(ps, i, ab, trend))
        # A STANDALONE doji, though, must be a real contested bar: no volume, or a
        # range far tighter than recent bars, is dead air rather than indecision.
        if p["v"] <= 0 or p["rng"] < 0.5 * avg_rng:
            return out
        if p["lower"] >= 0.6 * p["rng"] and p["upper"] <= 0.1 * p["rng"]:
            if trend == "down":
                out.append("dragonfly_doji")
        elif p["upper"] >= 0.6 * p["rng"] and p["lower"] <= 0.1 * p["rng"]:
            if trend == "up":
                out.append("gravestone_doji")
        elif p["upper"] >= 0.35 * p["rng"] and p["lower"] >= 0.35 * p["rng"]:
            out.append("long_legged_doji")
        else:
            out.append("doji")
        return out

    # ── Hammer family: small body, one dominant wick ──
    if p["body"] > 0 and p["lower"] >= 2.0 * p["body"] and p["upper"] <= max(p["body"], 0.15 * p["rng"]):
        if trend == "down":
            out.append("hammer")
        elif trend == "up":
            out.append("hanging_man")
    if p["body"] > 0 and p["upper"] >= 2.0 * p["body"] and p["lower"] <= max(p["body"], 0.15 * p["rng"]):
        if trend == "down":
            out.append("inverted_hammer")
        elif trend == "up":
            out.append("shooting_star")

    out.extend(_two_bar(ps, i, ab, trend))
    out.extend(_harami(ps, i, ab, trend))
    out.extend(_three_bar(ps, i, ab, trend))
    return out


def _two_bar(ps: Sequence[Dict[str, float]], i: int, ab: float, trend: str) -> List[str]:
    """Engulfing, piercing line and dark cloud cover."""
    if i < 1:
        return []
    a, b = ps[i - 1], ps[i]
    out: List[str] = []
    if a["body"] <= 0 or b["body"] <= 0:
        return out

    # Engulfing: this body fully covers the prior body, opposite colour.
    if not a["green"] and b["green"] and b["bottom"] <= a["bottom"] and b["top"] >= a["top"]:
        if trend == "down":
            out.append("bullish_engulfing")
    if a["green"] and not b["green"] and b["bottom"] <= a["bottom"] and b["top"] >= a["top"]:
        if trend == "up":
            out.append("bearish_engulfing")

    midpoint = (a["o"] + a["c"]) / 2.0

    # Piercing line: opens below the prior low, closes back INSIDE the prior body
    # past its midpoint. Closing beyond the prior open is an engulfing, not this.
    if not a["green"] and b["green"] and a["body"] >= 0.6 * ab:
        if b["o"] < a["l"] and midpoint < b["c"] < a["o"] and trend == "down":
            out.append("piercing_line")
    if a["green"] and not b["green"] and a["body"] >= 0.6 * ab:
        if b["o"] > a["h"] and a["o"] < b["c"] < midpoint and trend == "up":
            out.append("dark_cloud_cover")
    return out


def _harami(ps: Sequence[Dict[str, float]], i: int, ab: float, trend: str) -> List[str]:
    """Small body contained inside the prior long body; a doji inside is a cross."""
    if i < 1:
        return []
    a, b = ps[i - 1], ps[i]
    out: List[str] = []
    if a["body"] < 1.3 * ab:
        return out  # the prior bar has to be a genuinely long body
    inside = b["top"] <= a["top"] and b["bottom"] >= a["bottom"]
    if not inside or b["body"] >= a["body"]:
        return out
    if not a["green"] and trend == "down":
        out.append("bullish_harami_cross" if _is_doji(b) else "bullish_harami")
    elif a["green"] and trend == "up":
        out.append("bearish_harami_cross" if _is_doji(b) else "bearish_harami")
    return out


def _three_bar(ps: Sequence[Dict[str, float]], i: int, ab: float, trend: str) -> List[str]:
    """Morning/evening star and three soldiers/crows."""
    if i < 2:
        return []
    a, b, c = ps[i - 2], ps[i - 1], ps[i]
    out: List[str] = []

    # Star: long body, small indecisive body, long body back the other way that
    # recovers past the midpoint of the first.
    first_mid = (a["o"] + a["c"]) / 2.0
    small_middle = b["body"] <= 0.5 * a["body"] and b["body"] <= 0.6 * ab
    if (not a["green"] and a["body"] >= 1.0 * ab and small_middle
            and c["green"] and c["body"] >= 1.0 * ab and c["c"] > first_mid and trend == "down"):
        out.append("morning_star")
    if (a["green"] and a["body"] >= 1.0 * ab and small_middle
            and not c["green"] and c["body"] >= 1.0 * ab and c["c"] < first_mid and trend == "up"):
        out.append("evening_star")

    # Three soldiers / crows: three real bodies marching the same way, each opening
    # inside the previous body and closing beyond its close.
    all_green = a["green"] and b["green"] and c["green"]
    all_red = not a["green"] and not b["green"] and not c["green"]
    real = min(a["body"], b["body"], c["body"]) >= 0.6 * ab
    if all_green and real and b["c"] > a["c"] and c["c"] > b["c"]:
        if a["bottom"] <= b["o"] <= a["top"] and b["bottom"] <= c["o"] <= b["top"]:
            out.append("three_white_soldiers")
    if all_red and real and b["c"] < a["c"] and c["c"] < b["c"]:
        if a["bottom"] <= b["o"] <= a["top"] and b["bottom"] <= c["o"] <= b["top"]:
            out.append("three_black_crows")
    return out


def latest_pattern(
    candles: Sequence[Sequence[float]],
    whitelist: Sequence[str],
    max_scan: int = 10,
) -> Tuple[Optional[str], Optional[int]]:
    """Newest whitelisted pattern within `max_scan` bars, and its age in bars.

    Age 0 is the current forming bar. Returns (None, None) when nothing matches —
    including when the whitelist is empty, which is not an error but a screen that
    asked for no patterns.
    """
    wanted = set(whitelist)
    if not wanted or not candles:
        return (None, None)
    newest = len(candles) - 1
    for age in range(min(max_scan, len(candles))):
        i = newest - age
        if i < 0:
            break
        for name in detect_at(candles, i):
            if name in wanted:
                return (name, age)
    return (None, None)
