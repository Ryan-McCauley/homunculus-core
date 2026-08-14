"""Indicator math for the screening engine — a line-for-line port of
shared/indicators.ts.

The port is deliberate rather than approximate. The MARKET chart draws from the
TypeScript version and this engine screens from the Python one; if they disagree
by even a rounding convention, the app shows an RSI the screener never saw. The
conventions that matter, and that engine/tests/test_parity.py holds to:

  * EMA is seeded with the SMA of the first `period` values, not with values[0].
  * RSI is Wilder-smoothed, and its first defined value lands at index `period`.
  * Bollinger uses POPULATION variance (/n), not the sample variance (/n-1).
  * Every series function returns a list ALIGNED TO THE INPUT, with None where
    the indicator has not warmed up. Alignment is what makes cross detection a
    two-element comparison instead of an index hunt.

Stdlib only, matching the rest of the Python in this repo.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

Series = List[Optional[float]]

# Gemini candle tuple indices: [timestampMs, open, high, low, close, volume]
T, O, HI, LO, C, V = 0, 1, 2, 3, 4, 5


def closes_of(candles: Sequence[Sequence[float]]) -> List[float]:
    return [float(c[C]) for c in candles]


def highs_of(candles: Sequence[Sequence[float]]) -> List[float]:
    return [float(c[HI]) for c in candles]


def lows_of(candles: Sequence[Sequence[float]]) -> List[float]:
    return [float(c[LO]) for c in candles]


def volumes_of(candles: Sequence[Sequence[float]]) -> List[float]:
    return [float(c[V]) for c in candles]


# ── Series helpers ────────────────────────────────────────────────────────────

def last_value(series: Sequence[Optional[float]]) -> Optional[float]:
    """Last non-None value, or None when the series never warmed up."""
    for v in reversed(series):
        if v is not None:
            return v
    return None


def last_pair(series: Sequence[Optional[float]]) -> Optional[Tuple[float, float]]:
    """The final two defined values, oldest first — the input for cross detection.
    None unless BOTH exist, because a cross needs a before and an after."""
    vals: List[float] = []
    for v in reversed(series):
        if v is not None:
            vals.append(v)
            if len(vals) == 2:
                return (vals[1], vals[0])
    return None


def crossed_above(a: Tuple[float, float], b: Tuple[float, float]) -> bool:
    """True when `a` crossed above `b` between the previous bar and this one."""
    return a[0] <= b[0] and a[1] > b[1]


def crossed_below(a: Tuple[float, float], b: Tuple[float, float]) -> bool:
    return a[0] >= b[0] and a[1] < b[1]


# ── Moving averages ───────────────────────────────────────────────────────────

def sma(values: Sequence[float], period: int) -> Series:
    out: Series = []
    for i in range(len(values)):
        if i < period - 1:
            out.append(None)
            continue
        out.append(sum(values[i - period + 1:i + 1]) / period)
    return out


def ema(values: Sequence[float], period: int) -> Series:
    """EMA seeded with the SMA of the first `period` values (matches ts ema())."""
    out: Series = [None] * len(values)
    if len(values) < period:
        return out
    k = 2.0 / (period + 1)
    val = sum(values[:period]) / period
    out[period - 1] = val
    for i in range(period, len(values)):
        val = values[i] * k + val * (1 - k)
        out[i] = val
    return out


# ── Oscillators ───────────────────────────────────────────────────────────────

def rsi(closes: Sequence[float], period: int = 14) -> Series:
    """Wilder RSI, null-aligned to the input."""
    out: Series = [None] * len(closes)
    if len(closes) < period + 1:
        return out
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(period):
        d = deltas[i]
        if d >= 0:
            avg_gain += d
        else:
            avg_loss += -d
    avg_gain /= period
    avg_loss /= period

    def rsi_from(g: float, l: float) -> float:
        return 100.0 if l == 0 else 100.0 - 100.0 / (1 + g / l)

    out[period] = rsi_from(avg_gain, avg_loss)
    for i in range(period, len(deltas)):
        d = deltas[i]
        avg_gain = (avg_gain * (period - 1) + (d if d >= 0 else 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + (-d if d < 0 else 0.0)) / period
        out[i + 1] = rsi_from(avg_gain, avg_loss)
    return out


def macd(closes: Sequence[float], fast: int = 12, slow: int = 26, sig: int = 9) -> Dict[str, Series]:
    fast_e = ema(closes, fast)
    slow_e = ema(closes, slow)
    macd_line: Series = [
        (fast_e[i] - slow_e[i]) if (fast_e[i] is not None and slow_e[i] is not None) else None
        for i in range(len(closes))
    ]

    # The signal EMA runs over the macd line's defined tail only, then maps back onto
    # the original indices — an EMA over Nones would poison the seed.
    defined: List[float] = []
    idx: List[int] = []
    for i, v in enumerate(macd_line):
        if v is not None:
            defined.append(v)
            idx.append(i)
    sig_dense = ema(defined, sig)
    signal: Series = [None] * len(closes)
    for k, orig in enumerate(idx):
        signal[orig] = sig_dense[k]

    histogram: Series = [
        (macd_line[i] - signal[i]) if (macd_line[i] is not None and signal[i] is not None) else None
        for i in range(len(closes))
    ]
    return {"macd": macd_line, "signal": signal, "histogram": histogram}


# ── Volatility ────────────────────────────────────────────────────────────────

def bollinger(closes: Sequence[float], period: int = 20, mult: float = 2) -> Dict[str, Series]:
    """Population variance (/n), matching the TypeScript and server implementations."""
    middle = sma(closes, period)
    upper: Series = []
    lower: Series = []
    for i in range(len(closes)):
        if i < period - 1:
            upper.append(None)
            lower.append(None)
            continue
        win = closes[i - period + 1:i + 1]
        mean = middle[i]
        variance = sum((p - mean) ** 2 for p in win) / period
        sd = variance ** 0.5
        upper.append(mean + mult * sd)
        lower.append(mean - mult * sd)
    return {"upper": upper, "middle": middle, "lower": lower}


def bb_width_pct(closes: Sequence[float], period: int = 20, mult: float = 2) -> Optional[float]:
    """Latest Bollinger bandwidth as a PERCENT of the middle band — the squeeze /
    expansion reading the BB WIDTH gate screens on."""
    b = bollinger(closes, period, mult)
    up, lo, mid = last_value(b["upper"]), last_value(b["lower"]), last_value(b["middle"])
    if up is None or lo is None or mid is None or mid == 0:
        return None
    return ((up - lo) / mid) * 100.0


# ── Volume & change ───────────────────────────────────────────────────────────

def rel_volume(volumes: Sequence[float], period: int = 20) -> Optional[float]:
    """Last bar's volume as a multiple of the average of the `period` bars BEFORE it.

    The current bar is excluded from its own baseline on purpose: including it lets a
    spike dilute the very average it is being measured against, which flattens exactly
    the reading the gate exists to catch."""
    if len(volumes) < period + 1:
        return None
    baseline = sum(volumes[-period - 1:-1]) / period
    if baseline <= 0:
        return None
    return volumes[-1] / baseline


def pct_change(closes: Sequence[float], lookback: int) -> Optional[float]:
    """Percent change from `lookback` bars ago to the last close."""
    if len(closes) < lookback + 1:
        return None
    ref = closes[-lookback - 1]
    if ref == 0:
        return None
    return ((closes[-1] - ref) / ref) * 100.0
