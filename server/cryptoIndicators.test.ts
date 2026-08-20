import { describe, it, expect, vi } from 'vitest'
import * as shared from '../shared/indicators'

// Characterization tests for the pure indicator maths inside server/crypto.ts.
//
// This is the file's FIRST coverage: crypto.ts reported 0% of 7,315 lines while
// holding every indicator the strategy engine scores entries with. The functions
// were always pure — they just had no seam, because nothing in the module was
// exported except cryptoHub/autoPlanner/getFlashDipSelected. They are exported
// now (an `export` keyword and nothing else; no behaviour changed).
//
// These are CHARACTERIZATION tests, deliberately: they pin what the code does
// today, so the eventual convergence onto shared/indicators.ts is a refactor
// with a net under it rather than a rewrite by eye. A test here failing after a
// change means the numbers moved — decide whether that was intended before
// making it green.
//
// The RSI block at the bottom is the exception: it started as a record of a real
// divergence (crypto.ts rounded every RSI to 2dp inside the recurrence, shared
// did not, and the two disagreed at the oversold threshold) and is now the
// regression guard for its fix. See wilderRsiSeries and fmtRsi in crypto.ts.
//
// Importing crypto.ts constructs autoPlanner and cryptoHub at module scope, and
// their field initialisers read from disk. Every collaborator that touches the
// outside world is mocked so the import is inert: no disk, no network, no timers
// (the timer fields initialise to null and are only armed by start(), which these
// tests never call). Order execution is untouched and never reached.

vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((_file: string, fallback: unknown) => fallback),
    writeJson: vi.fn(),
    deleteJson: vi.fn(),
  },
}))
vi.mock('./auditLog', () => ({ auditLog: { note: vi.fn(), record: vi.fn() } }))
vi.mock('./chat', () => ({ broadcastProactive: vi.fn() }))
vi.mock('./cryptoAlerts', () => ({ alertStore: { list: vi.fn(() => []), evaluate: vi.fn(() => []) } }))
vi.mock('./cmc', () => ({ fetchCmcVolumes: vi.fn(async () => new Map()), cmcConfigured: vi.fn(() => false) }))
vi.mock('./strategyRunner', () => ({
  strategyRunner: { isRunning: vi.fn(() => false), run: vi.fn(), subscribe: vi.fn(() => () => {}) },
  getEnabledStrategy: vi.fn(() => null),
  isStrategyId: vi.fn(() => false),
}))

const {
  aggregateTo4h, closes, highs, lows, volumes, sma, ema, wmaSeries, hma,
  calcOBVSeries, calcOBV, wilderRsiSeries, rsi14, calcMacd, bollingerBands,
  calcVWAP, calcADX, calcStochRSI, findPivots, detectCapitulation,
  calcFibLevels, recentSlice, linregSlope, fmtRsi,
} = await import('./crypto')

type C = [number, number, number, number, number, number]

/** Candle at `t` hours past epoch. [ts, open, high, low, close, volume] */
const candle = (hour: number, o: number, h: number, l: number, c: number, v = 100): C =>
  [hour * 3_600_000, o, h, l, c, v]

/** `n` candles walking `close` by `step`, with a 1-wide high/low band. */
const walk = (n: number, start: number, step: number, vol = 100): C[] =>
  Array.from({ length: n }, (_, i) => {
    const c = start + step * i
    return candle(i, c - step, c + 1, c - 1, c, vol)
  })

// ── Accessors ──────────────────────────────────────────────────────────────

describe('candle accessors', () => {
  const cs: C[] = [candle(0, 1, 9, 0.5, 5, 42), candle(1, 5, 11, 4, 7, 43)]

  it('pull the right tuple slots', () => {
    expect(closes(cs)).toEqual([5, 7])
    expect(highs(cs)).toEqual([9, 11])
    expect(lows(cs)).toEqual([0.5, 4])
    expect(volumes(cs)).toEqual([42, 43])
  })

  it('return empty for no candles', () => {
    expect(closes([])).toEqual([])
  })
})

// ── 4h aggregation ─────────────────────────────────────────────────────────

describe('aggregateTo4h', () => {
  it('folds four hourly candles into one 4h bar with OHLCV semantics', () => {
    const hourly: C[] = [
      candle(0, 10, 12, 9, 11, 100),
      candle(1, 11, 15, 10, 14, 200),
      candle(2, 14, 14, 6, 8, 300),
      candle(3, 8, 13, 7, 12, 400),
    ]
    const [bar, ...rest] = aggregateTo4h(hourly)
    expect(rest).toHaveLength(0)
    expect(bar![0]).toBe(0)        // bucket start
    expect(bar![1]).toBe(10)       // open  = first candle's open
    expect(bar![2]).toBe(15)       // high  = max high
    expect(bar![3]).toBe(6)        // low   = min low
    expect(bar![4]).toBe(12)       // close = last candle's close
    expect(bar![5]).toBe(1000)     // volume = sum
  })

  it('starts a new bar on the next 4h boundary', () => {
    const hourly: C[] = [candle(3, 1, 1, 1, 1), candle(4, 2, 2, 2, 2)]
    const out = aggregateTo4h(hourly)
    expect(out).toHaveLength(2)
    expect(out[1]![0]).toBe(4 * 3_600_000)
  })

  it('does not mutate the input candles', () => {
    const hourly: C[] = [candle(0, 10, 12, 9, 11, 100), candle(1, 11, 15, 10, 14, 200)]
    const snapshot = JSON.stringify(hourly)
    aggregateTo4h(hourly)
    expect(JSON.stringify(hourly)).toBe(snapshot)
  })

  it('returns empty for no input', () => {
    expect(aggregateTo4h([])).toEqual([])
  })
})

// ── Moving averages ────────────────────────────────────────────────────────

describe('sma', () => {
  it('averages the last n values only', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5)
    expect(sma([1, 2, 3, 4], 4)).toBe(2.5)
  })

  it('returns null when there is less data than the window', () => {
    expect(sma([1, 2], 3)).toBeNull()
    expect(sma([], 1)).toBeNull()
  })
})

describe('ema', () => {
  it('seeds with the simple average then applies k = 2/(n+1)', () => {
    // n=2 → k=2/3. seed=(1+2)/2=1.5; 3·⅔+1.5·⅓=2.5; 4·⅔+2.5·⅓=3.5
    expect(ema([1, 2, 3, 4], 2)).toEqual([1.5, 2.5, 3.5])
  })

  it('returns one value per index from n-1 onward', () => {
    expect(ema(Array.from({ length: 10 }, (_, i) => i), 4)).toHaveLength(7)
  })

  it('returns empty when there is less data than the period', () => {
    expect(ema([1, 2], 5)).toEqual([])
  })

  it('is flat on a flat series', () => {
    expect(ema([5, 5, 5, 5, 5], 2)).toEqual([5, 5, 5, 5])
  })
})

describe('wmaSeries', () => {
  it('weights by position, most recent heaviest', () => {
    // n=2, denom=3 → (1·1+2·2)/3, (2·1+3·2)/3
    const out = wmaSeries([1, 2, 3], 2)
    expect(out[0]).toBeCloseTo(5 / 3, 10)
    expect(out[1]).toBeCloseTo(8 / 3, 10)
  })

  it('guards a nonsensical window', () => {
    expect(wmaSeries([1, 2, 3], 0)).toEqual([])
    expect(wmaSeries([1], 5)).toEqual([])
  })
})

describe('hma', () => {
  it('tracks a clean linear trend with only the residual HMA lag', () => {
    // Textbook HMA behaviour, worth stating because it looks off by eye: on a
    // slope-1 ramp ending at 139, 2·WMA(n/2) − WMA(n) cancels the lag exactly,
    // so `raw` ends at 139 — but the final WMA(√n) smoothing re-introduces
    // (√n − 1)/3 = 2/3 of a bar. 139 − 0.667 = 138.333. Not a bug; the formula.
    const prices = Array.from({ length: 40 }, (_, i) => 100 + i)
    const out = hma(prices, 9)
    expect(out).not.toBeNull()
    expect(out!).toBeCloseTo(138.3333, 3)
  })

  it('returns null without enough history', () => {
    expect(hma([1, 2, 3], 16)).toBeNull()
  })
})

// ── Volume ─────────────────────────────────────────────────────────────────

describe('OBV', () => {
  it('adds volume on an up close and subtracts on a down close', () => {
    const cs: C[] = [
      candle(0, 10, 10, 10, 10, 50),
      candle(1, 10, 10, 10, 12, 100),  // up   → +100
      candle(2, 12, 12, 12, 11, 30),   // down → −30
      candle(3, 11, 11, 11, 11, 999),  // flat → unchanged
    ]
    expect(calcOBVSeries(cs)).toEqual([0, 100, 70, 70])
    expect(calcOBV(cs)).toBe(70)
  })

  it('needs at least two candles', () => {
    expect(calcOBVSeries([candle(0, 1, 1, 1, 1)])).toEqual([])
    expect(calcOBV([candle(0, 1, 1, 1, 1)])).toBeNull()
  })
})

describe('calcVWAP', () => {
  it('weights the typical price by volume', () => {
    const cs: C[] = [
      candle(0, 0, 12, 6, 9, 100),   // tp = (12+6+9)/3 = 9
      candle(1, 0, 30, 15, 15, 300), // tp = (30+15+15)/3 = 20
    ]
    // (9·100 + 20·300) / 400 = 6900/400
    expect(calcVWAP(cs)).toBeCloseTo(17.25, 10)
  })

  it('returns null when the session has no volume', () => {
    expect(calcVWAP([candle(0, 1, 1, 1, 1, 0), candle(1, 1, 1, 1, 1, 0)])).toBeNull()
  })

  it('needs at least two candles', () => {
    expect(calcVWAP([candle(0, 1, 1, 1, 1)])).toBeNull()
  })
})

// ── Oscillators ────────────────────────────────────────────────────────────

describe('wilderRsiSeries', () => {
  it('is 100 when every bar gains (no losses to divide by)', () => {
    // 20 prices → 19 deltas → 1 seed + (19 − 14) recursive = 6 values.
    expect(wilderRsiSeries(Array.from({ length: 20 }, (_, i) => 100 + i))).toEqual(
      Array.from({ length: 6 }, () => 100))
  })

  it('is 0 when every bar loses', () => {
    const out = wilderRsiSeries(Array.from({ length: 20 }, (_, i) => 100 - i))
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('hovers near 50 on alternating equal moves, biased by the last bar', () => {
    // The seed over 14 alternating deltas is a clean 50 (7 gains, 7 losses of
    // equal size), but Wilder's recurrence then leans toward whichever
    // direction the final bar moved — so the tail sits just off 50, not on it.
    const prices = Array.from({ length: 40 }, (_, i) => 100 + (i % 2))
    const out = wilderRsiSeries(prices)
    expect(out[out.length - 1]).toBeCloseTo(52.14, 2)
    expect(out[out.length - 1]).toBeGreaterThan(45)
    expect(out[out.length - 1]).toBeLessThan(55)
  })

  it('returns empty below period+1 samples', () => {
    expect(wilderRsiSeries([1, 2, 3])).toEqual([])
  })

  it('emits one value per bar from index `period` onward', () => {
    // 30 prices → 29 deltas → 1 seed + (29−14) recursive = 16 values
    expect(wilderRsiSeries(Array.from({ length: 30 }, (_, i) => 100 + (i % 3)))).toHaveLength(16)
  })
})

describe('rsi14', () => {
  it('is the last value of the series', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + (i % 5))
    const series = wilderRsiSeries(prices, 14)
    expect(rsi14(prices)).toBe(series[series.length - 1])
  })

  it('is null without enough history', () => {
    expect(rsi14([1, 2, 3])).toBeNull()
  })
})

describe('calcStochRSI', () => {
  it('stays within 0..100 on both axes', () => {
    const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 10)
    const out = calcStochRSI(prices)
    expect(out).not.toBeNull()
    expect(out!.k).toBeGreaterThanOrEqual(0)
    expect(out!.k).toBeLessThanOrEqual(100)
    expect(out!.d).toBeGreaterThanOrEqual(0)
    expect(out!.d).toBeLessThanOrEqual(100)
  })

  it('is null without enough history', () => {
    expect(calcStochRSI([1, 2, 3])).toBeNull()
  })
})

describe('calcMacd', () => {
  it('is positive with a rising fast EMA and null when starved', () => {
    const rising = Array.from({ length: 80 }, (_, i) => 100 + i * 2)
    const out = calcMacd(rising)
    expect(out).not.toBeNull()
    expect(out!.macd).toBeGreaterThan(0)
    expect(calcMacd([1, 2, 3])).toBeNull()
  })

  it('reports histogram = macd − signal', () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5)
    const out = calcMacd(prices)!
    expect(out.histogram).toBeCloseTo(out.macd - out.signal, 6)
  })
})

describe('bollingerBands', () => {
  it('centres on the SMA with symmetric bands', () => {
    const prices = Array.from({ length: 40 }, (_, i) => 100 + (i % 4))
    const out = bollingerBands(prices)!
    expect(out.middle).toBeCloseTo(sma(prices, 20)!, 10)
    expect(out.upper - out.middle).toBeCloseTo(out.middle - out.lower, 10)
  })

  it('collapses to a single line with zero variance', () => {
    const out = bollingerBands(Array.from({ length: 40 }, () => 100))!
    expect(out.upper).toBeCloseTo(100, 10)
    expect(out.lower).toBeCloseTo(100, 10)
  })

  it('is null without a full window', () => {
    expect(bollingerBands([1, 2, 3])).toBeNull()
  })
})

describe('calcADX', () => {
  it('reports a strong trend with +DI over −DI on a clean uptrend', () => {
    const out = calcADX(walk(80, 100, 2))
    expect(out).not.toBeNull()
    expect(out!.plusDI).toBeGreaterThan(out!.minusDI)
    expect(out!.adx).toBeGreaterThanOrEqual(0)
    expect(out!.adx).toBeLessThanOrEqual(100)
  })

  it('flips the DI ordering on a downtrend', () => {
    const out = calcADX(walk(80, 300, -2))!
    expect(out.minusDI).toBeGreaterThan(out.plusDI)
  })

  it('is null without enough candles', () => {
    expect(calcADX(walk(5, 100, 1))).toBeNull()
  })
})

// ── Structure ──────────────────────────────────────────────────────────────

describe('findPivots', () => {
  it('finds a low that is the minimum of its radius window', () => {
    //            0  1  2  3  4  5  6
    const vals = [5, 4, 3, 1, 3, 4, 5]
    expect(findPivots(vals, 2, 'low')).toContain(3)
  })

  it('finds a high symmetrically', () => {
    const vals = [1, 2, 3, 9, 3, 2, 1]
    expect(findPivots(vals, 2, 'high')).toContain(3)
  })

  it('finds nothing on a monotonic series', () => {
    expect(findPivots([1, 2, 3, 4, 5, 6, 7], 2, 'low')).toEqual([])
  })
})

describe('calcFibLevels', () => {
  it('derives the standard retracements from the swing range', () => {
    const cs = walk(30, 100, 1)          // closes 100..129, highs close+1, lows close−1
    const out = calcFibLevels(cs)!
    expect(out.swingHigh).toBe(130)      // max high = 129 + 1
    expect(out.swingLow).toBe(99)        // min low  = 100 − 1
    const range = out.swingHigh - out.swingLow
    expect(out.levels['23.6%']).toBeCloseTo(130 - range * 0.236, 10)
    expect(out.levels['61.8%']).toBeCloseTo(130 - range * 0.618, 10)
  })

  it('orders levels monotonically down from the high', () => {
    const out = calcFibLevels(walk(30, 100, 1))!
    const vals = ['23.6%', '38.2%', '50.0%', '61.8%', '78.6%'].map((k) => out.levels[k]!)
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThan(vals[i - 1]!)
  })

  it('is null below 20 candles', () => {
    expect(calcFibLevels(walk(19, 100, 1))).toBeNull()
  })
})

describe('detectCapitulation', () => {
  it('fires on a high-volume, large-bodied bearish bar at the lows', () => {
    const cs = walk(25, 200, -1, 100)
    // Final bar: 3× volume, big red body, new low.
    cs[cs.length - 1] = candle(24, 180, 181, 160, 162, 300)
    const out = detectCapitulation(cs)
    expect(out.detected).toBe(true)
    expect(out.volumeMultiple).toBeGreaterThanOrEqual(1.8)
  })

  it('does not fire on ordinary volume', () => {
    expect(detectCapitulation(walk(25, 200, -1, 100)).detected).toBe(false)
  })

  it('reports a zero multiple below 20 candles', () => {
    expect(detectCapitulation(walk(10, 100, 1))).toEqual({ detected: false, volumeMultiple: 0 })
  })
})

// ── Small helpers ──────────────────────────────────────────────────────────

describe('recentSlice', () => {
  it('takes the tail only when longer than n', () => {
    expect(recentSlice([1, 2, 3, 4, 5], 2)).toEqual([4, 5])
    expect(recentSlice([1, 2], 5)).toEqual([1, 2])
  })
})

describe('linregSlope', () => {
  it('is exact on a straight line', () => {
    expect(linregSlope([0, 1, 2, 3])).toBeCloseTo(1, 10)
    expect(linregSlope([10, 8, 6, 4])).toBeCloseTo(-2, 10)
  })

  it('is zero on a flat series and on too little data', () => {
    expect(linregSlope([7, 7, 7, 7])).toBeCloseTo(0, 10)
    expect(linregSlope([5])).toBe(0)
  })
})

// ── Divergence from shared/indicators ──────────────────────────────────────

describe('RSI parity with shared/indicators', () => {
  const prices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 8)

  it('matches bar for bar, offset by the sparse/compact convention', () => {
    // shared.rsi is null-padded and aligned to the input index (first value at
    // [period]); crypto's series is compacted and starts at that same bar. This
    // index offset is the one real difference left between the two, and it is
    // the trap for whoever eventually merges them.
    const mine = wilderRsiSeries(prices, 14)
    const theirs = shared.rsi(prices, 14)
    expect(mine).toHaveLength(prices.length - 14)
    for (let k = 0; k < mine.length; k++) {
      expect(mine[k]).toBeCloseTo(theirs[k + 14]!, 12)
    }
  })

  it('carries full precision — no rounding inside the recurrence', () => {
    // Regression guard for the defect this suite originally pinned: crypto.ts
    // used to .toFixed(2) every RSI as it was computed, so its values were
    // quantised to 0.01 while shared/indicators' were not.
    const mine = wilderRsiSeries(prices, 14)
    expect(mine.some((v) => Number(v.toFixed(2)) !== v)).toBe(true)
  })

  it('agrees with shared at the oversold threshold on a boundary bar', () => {
    // The series that exposed the bug: true Wilder RSI-14 = 29.9982, which the
    // old .toFixed(2) reported as exactly 30.00 — so `rsiVal < 30` (the +20
    // oversold gate) read FALSE here while shared/indicators, scoring the same
    // candles for alerts, read TRUE. Both must now call it oversold.
    const series = [
      100, 97.97, 98.89, 96.85, 94.99, 94.25, 95.55, 93.87, 94.86, 93.67, 92.29,
      91.26, 91.73, 90.35, 90.52, 89.63, 90.74, 90.82, 90.19, 88.91, 90.22,
    ]
    const theirs = shared.rsi(series, 14).at(-1)!
    const mine = rsi14(series)!

    expect(mine).toBeCloseTo(theirs, 12)
    expect(mine).toBeGreaterThan(29.99)
    expect(mine).toBeLessThan(30)

    expect(mine < 30).toBe(true)      // strategy engine: oversold
    expect(theirs < 30).toBe(true)    // alerts engine:   oversold
  })
})

describe('fmtRsi', () => {
  it('is the only place precision is reduced, and only for display', () => {
    expect(fmtRsi(29.998191293684158)).toBe('30.00')
    expect(fmtRsi(35)).toBe('35.00')
  })

  it('renders a missing reading rather than throwing', () => {
    expect(fmtRsi(null)).toBe('?')
    expect(fmtRsi(undefined)).toBe('?')
  })
})
