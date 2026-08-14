"""Deriving the timeframes Gemini does not serve.

Gemini's /v2/candles offers 1m/5m/15m/30m/1hr/6hr/1day. A screener may run on 4hr
or 1week, so those are built here from the 1hr and 1day feeds respectively — the
same derivation server/crypto.ts already does for the 4hr chart (aggregateTo4h),
ported so the screener and the chart bucket identically.

BUCKETING. A bar's timestamp is its bucket BOUNDARY, not the timestamp of the first
input bar that landed in it. That is what makes the rollup stable: the same candle
always falls in the same bucket regardless of where the fetched window happens to
start, so two scans an hour apart agree about what "the last 4hr bar" was.

The newest bucket is deliberately kept even when partial — it is the forming bar,
which is precisely the one a live screen is reading.

WEEKS START MONDAY. The epoch is a Thursday, so a naive floor(t / 7d) would put
week boundaries on Thursdays. The anchor shifts buckets onto Monday 1969-12-29,
which is the Monday-open week every exchange chart shows.
"""

from __future__ import annotations

from typing import Dict, List, Sequence

Candle = List[float]

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS
WEEK_MS = 7 * DAY_MS

#: Monday 1969-12-29T00:00:00Z — see WEEKS START MONDAY above.
MONDAY_ANCHOR_MS = -259200000

T, O, HI, LO, C, V = 0, 1, 2, 3, 4, 5

#: Which native feed each timeframe is built from, and its bucket size.
#: Mirrors TIMEFRAME_SOURCE in shared/screener.ts.
TIMEFRAME_SOURCE = {
    "15m": ("15m", 15 * 60 * 1000, 0),
    "1hr": ("1hr", HOUR_MS, 0),
    "4hr": ("1hr", 4 * HOUR_MS, 0),
    "1day": ("1day", DAY_MS, 0),
    "1week": ("1day", WEEK_MS, MONDAY_ANCHOR_MS),
}


def rollup(candles: Sequence[Sequence[float]], bucket_ms: int, anchor: int = 0) -> List[Candle]:
    """Aggregate oldest-first candles into `bucket_ms` buckets aligned to `anchor`.

    open = first bar's open, high/low = extremes, close = last bar's close,
    volume = sum. Returns new lists; the input is never mutated.
    """
    out: List[Candle] = []
    for c in candles:
        bucket = ((int(c[T]) - anchor) // bucket_ms) * bucket_ms + anchor
        if out and out[-1][T] == bucket:
            prev = out[-1]
            prev[HI] = max(prev[HI], c[HI])
            prev[LO] = min(prev[LO], c[LO])
            prev[C] = c[C]
            prev[V] += c[V]
        else:
            out.append([bucket, c[O], c[HI], c[LO], c[C], c[V]])
    return out


def candles_for_timeframe(base: Dict[str, Sequence[Sequence[float]]], timeframe: str) -> List[Candle]:
    """Candles for `timeframe`, rolled up from the base feeds when not native.

    A missing base feed returns [] rather than raising: a symbol that has not been
    seeded yet is a symbol with no data, not a broken job.
    """
    source = TIMEFRAME_SOURCE.get(timeframe)
    if source is None:
        return []
    feed, bucket_ms, anchor = source
    candles = base.get(feed) or []
    if not candles:
        return []
    return rollup(candles, bucket_ms, anchor)
