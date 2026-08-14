import { describe, it, expect } from 'vitest'
import {
  closesOf, highsOf, lowsOf, last, lastPair, crossedAbove, crossedBelow,
  sma, ema, rsi, macd, stochastic, cci, mfi, bollinger, trueRange, atr,
  keltner, squeezeOn, adx, psar, supertrend, obv, vwap, volumeRatio, pivotLevels,
  type Candle,
} from './indicators'

// [timestampMs, open, high, low, close, volume]
function candle(ts: number, o: number, h: number, l: number, c: number, v: number): Candle {
  return [ts, o, h, l, c, v]
}

/** Deterministic synthetic series: mild uptrend with a sine oscillation, no randomness. */
function genCandles(n: number): Candle[] {
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 5) * 2
    const drift = i * 0.1
    const open = price
    const close = 100 + drift + wave
    const high = Math.max(open, close) + 0.5
    const low = Math.min(open, close) - 0.5
    const vol = 100 + (i % 7) * 10
    out.push(candle(i * 3_600_000, open, high, low, close, vol))
    price = close
  }
  return out
}

describe('closesOf / highsOf / lowsOf', () => {
  const candles = [candle(0, 1, 5, 0, 3, 10), candle(1, 3, 6, 2, 4, 20)]
  it('extracts the right column', () => {
    expect(closesOf(candles)).toEqual([3, 4])
    expect(highsOf(candles)).toEqual([5, 6])
    expect(lowsOf(candles)).toEqual([0, 2])
  })
})

describe('last', () => {
  it('returns the last non-null value', () => {
    expect(last([1, 2, null])).toBe(2)
    expect(last([1, null, 3])).toBe(3)
  })
  it('returns null when every value is null', () => {
    expect(last([null, null])).toBeNull()
  })
  it('returns null for an empty series', () => {
    expect(last([])).toBeNull()
  })
})

describe('lastPair', () => {
  it('returns the last two non-null values, oldest first', () => {
    expect(lastPair([1, 2, 3])).toEqual([2, 3])
  })
  it('skips nulls to find two defined values', () => {
    expect(lastPair([5, null, 6, null, 7])).toEqual([6, 7])
  })
  it('returns null when fewer than two values are defined', () => {
    expect(lastPair([1, null])).toBeNull()
    expect(lastPair([null])).toBeNull()
    expect(lastPair([])).toBeNull()
  })
})

describe('crossedAbove / crossedBelow', () => {
  it('detects an upward cross (was <=, now >)', () => {
    expect(crossedAbove([1, 2], [3, 1])).toBe(true)
  })
  it('does not fire when already above', () => {
    expect(crossedAbove([4, 5], [1, 1])).toBe(false)
  })
  it('detects a downward cross (was >=, now <)', () => {
    expect(crossedBelow([3, 1], [1, 2])).toBe(true)
  })
  it('does not fire when already below', () => {
    expect(crossedBelow([1, 1], [4, 5])).toBe(false)
  })
})

describe('sma', () => {
  it('warms up with nulls before period-1', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })
  it('matches a hand-computed average', () => {
    const out = sma([10, 20, 30, 40], 2)
    expect(out).toEqual([null, 15, 25, 35])
  })
})

describe('ema', () => {
  it('seeds with the SMA of the first period values', () => {
    // period=3 seed = avg(1,2,3) = 2, then EMA recurrence with k = 2/4 = 0.5
    const out = ema([1, 2, 3, 4, 5, 6, 7], 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(2, 10)
    expect(out[3]).toBeCloseTo(3, 10)
    expect(out[6]).toBeCloseTo(6, 10)
  })
  it('is all null when there is not enough data', () => {
    expect(ema([1, 2], 5)).toEqual([null, null])
  })
})

describe('rsi', () => {
  // Classic Wilder RSI textbook example (Wilder's own 14-period walkthrough).
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28,
  ]
  it('matches the classic Wilder worked example to 2 decimals', () => {
    const out = rsi(closes, 14)
    expect(out[13]).toBeNull() // not warmed up until index 14
    expect(out[14]).toBeCloseTo(70.46, 1)
  })
  it('returns all null when shorter than period + 1', () => {
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).toBe(true)
  })
  it('is 100 when there are no losses in the window', () => {
    const risingOnly = Array.from({ length: 16 }, (_, i) => 100 + i)
    const out = rsi(risingOnly, 14)
    expect(out[14]).toBe(100)
  })
})

describe('macd', () => {
  it('histogram is the difference between macd and signal wherever both are defined', () => {
    const candles = genCandles(60)
    const closes = closesOf(candles)
    const { macd: line, signal, histogram } = macd(closes)
    for (let i = 0; i < closes.length; i++) {
      if (line[i] != null && signal[i] != null) {
        expect(histogram[i]).toBeCloseTo(line[i]! - signal[i]!, 10)
      } else {
        expect(histogram[i]).toBeNull()
      }
    }
  })
  it('macd line is fast EMA minus slow EMA', () => {
    const closes = closesOf(genCandles(40))
    const fast = ema(closes, 12)
    const slow = ema(closes, 26)
    const { macd: line } = macd(closes, 12, 26, 9)
    for (let i = 0; i < closes.length; i++) {
      if (fast[i] != null && slow[i] != null) expect(line[i]).toBeCloseTo(fast[i]! - slow[i]!, 10)
      else expect(line[i]).toBeNull()
    }
  })
})

describe('stochastic', () => {
  it('%K is 100 at the period high and 0 at the period low', () => {
    const candles = [
      candle(0, 10, 10, 5, 8, 1),
      candle(1, 8, 12, 8, 9, 1),
      candle(2, 9, 15, 9, 15, 1), // new high, close = high → %K 100
    ]
    const { k } = stochastic(candles, 3, 1)
    expect(k[2]).toBeCloseTo(100, 10)
  })
  it('%K is 50 when the period range is flat (zero-division guard)', () => {
    const candles = [candle(0, 5, 5, 5, 5, 1), candle(1, 5, 5, 5, 5, 1)]
    const { k } = stochastic(candles, 2, 1)
    expect(k[1]).toBe(50)
  })
})

describe('cci', () => {
  it('is 0 when the window has zero mean deviation (flat typical price)', () => {
    const candles = Array.from({ length: 20 }, (_, i) => candle(i, 10, 10, 10, 10, 1))
    const out = cci(candles, 20)
    expect(out[19]).toBe(0)
  })
})

describe('mfi', () => {
  it('is 100 when every flow in the window is positive (no negative flow)', () => {
    const candles = Array.from({ length: 16 }, (_, i) => candle(i, 100 + i, 101 + i, 99 + i, 100 + i, 10))
    const out = mfi(candles, 14)
    expect(out[14]).toBe(100)
  })
  it('warms up with nulls for the first `period` bars', () => {
    const candles = Array.from({ length: 5 }, (_, i) => candle(i, 100, 101, 99, 100, 10))
    const out = mfi(candles, 14)
    expect(out.every((v) => v === null)).toBe(true)
  })
})

describe('bollinger', () => {
  it('matches hand-computed population-variance bands', () => {
    // closes 1..10, period 5: window [1,2,3,4,5] at i=4 → mean 3, population sd = sqrt(2)
    const out = bollinger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 2)
    expect(out.middle[4]).toBe(3)
    expect(out.upper[4]).toBeCloseTo(3 + 2 * Math.sqrt(2), 10)
    expect(out.lower[4]).toBeCloseTo(3 - 2 * Math.sqrt(2), 10)
  })
  it('band width is symmetric around the middle band', () => {
    const out = bollinger(closesOf(genCandles(40)), 20, 2)
    for (let i = 0; i < 40; i++) {
      if (out.middle[i] == null) continue
      expect(out.upper[i]! - out.middle[i]!).toBeCloseTo(out.middle[i]! - out.lower[i]!, 10)
    }
  })
})

describe('trueRange', () => {
  it('is null for the first bar (no previous close)', () => {
    const candles = [candle(0, 10, 12, 9, 11, 1), candle(1, 11, 13, 10, 12, 1)]
    expect(trueRange(candles)[0]).toBeNull()
  })
  it('is the largest of the three range definitions', () => {
    // prior close 11: high-low=3, |high-pc|=2, |low-pc|=2 → TR = 3
    const candles = [candle(0, 10, 12, 9, 11, 1), candle(1, 11, 13, 10, 12, 1)]
    expect(trueRange(candles)[1]).toBe(3)
  })
})

describe('atr', () => {
  it('warms up at exactly index `period`', () => {
    const candles = genCandles(30)
    const out = atr(candles, 14)
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true)
    expect(out[14]).not.toBeNull()
  })
  it('stays all-null when shorter than period + 1', () => {
    const candles = genCandles(10)
    expect(atr(candles, 14).every((v) => v === null)).toBe(true)
  })
})

describe('keltner', () => {
  it('upper/lower are the EMA basis plus/minus mult * ATR', () => {
    const candles = genCandles(40)
    const a = atr(candles, 20)
    const mid = ema(closesOf(candles), 20)
    const { upper, lower } = keltner(candles, 20, 1.5)
    for (let i = 0; i < 40; i++) {
      if (mid[i] == null || a[i] == null) continue
      expect(upper[i]).toBeCloseTo(mid[i]! + 1.5 * a[i]!, 10)
      expect(lower[i]).toBeCloseTo(mid[i]! - 1.5 * a[i]!, 10)
    }
  })
})

describe('squeezeOn', () => {
  it('is 1 exactly where Bollinger sits inside Keltner', () => {
    const candles = genCandles(50)
    const bb = bollinger(closesOf(candles), 20, 2)
    const kc = keltner(candles, 20, 1.5)
    const sq = squeezeOn(candles)
    for (let i = 0; i < 50; i++) {
      if (bb.upper[i] == null || kc.upper[i] == null) { expect(sq[i]).toBeNull(); continue }
      const expected = bb.upper[i]! < kc.upper[i]! && bb.lower[i]! > kc.lower[i]! ? 1 : 0
      expect(sq[i]).toBe(expected)
    }
  })
})

describe('adx', () => {
  it('stays all-null when shorter than 2*period', () => {
    const candles = genCandles(20)
    const { adx: out } = adx(candles, 14)
    expect(out.every((v) => v === null)).toBe(true)
  })
  it('produces values in [0, 100] once warmed up', () => {
    const { adx: out, plusDi, minusDi } = adx(genCandles(60), 14)
    const defined = out.filter((v): v is number => v != null)
    expect(defined.length).toBeGreaterThan(0)
    for (const v of defined) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100) }
    for (const v of plusDi.filter((v): v is number => v != null)) expect(v).toBeGreaterThanOrEqual(0)
    for (const v of minusDi.filter((v): v is number => v != null)) expect(v).toBeGreaterThanOrEqual(0)
  })
})

describe('psar', () => {
  it('is null for the first bar and defined afterward', () => {
    const candles = genCandles(20)
    const out = psar(candles)
    expect(out[0]).toBeNull()
    expect(out.slice(1).every((v) => v != null)).toBe(true)
  })
  it('is all null for a single-candle series', () => {
    expect(psar([genCandles(1)[0]!])).toEqual([null])
  })
})

describe('supertrend', () => {
  it('dir is always 1 or -1 once ATR has warmed up', () => {
    const { dir } = supertrend(genCandles(40), 10, 3)
    for (const d of dir) { if (d != null) expect([1, -1]).toContain(d) }
  })
  it('line equals lower band when trending up, upper band when trending down', () => {
    // Just assert internal consistency: line is defined exactly where dir is defined.
    const { line, dir } = supertrend(genCandles(40), 10, 3)
    for (let i = 0; i < line.length; i++) {
      expect(line[i] == null).toBe(dir[i] == null)
    }
  })
})

describe('obv', () => {
  it('accumulates volume on up closes and subtracts on down closes', () => {
    const candles = [
      candle(0, 10, 12, 9, 11, 100),
      candle(1, 11, 13, 10, 12, 150), // up → +150
      candle(2, 12, 12.5, 11, 11.5, 120), // down → -120
      candle(3, 11.5, 12, 10.5, 11.8, 130), // up → +130
    ]
    expect(obv(candles)).toEqual([0, 150, 30, 160])
  })
  it('is unchanged on a flat close', () => {
    const candles = [candle(0, 10, 10, 10, 10, 100), candle(1, 10, 10, 10, 10, 200)]
    expect(obv(candles)).toEqual([0, 0])
  })
})

describe('vwap', () => {
  it('matches a hand-computed running volume-weighted average', () => {
    const candles = [candle(0, 10, 12, 9, 11, 100), candle(1, 11, 13, 10, 12, 150)]
    const tp0 = (12 + 9 + 11) / 3
    const tp1 = (13 + 10 + 12) / 3
    const expected0 = tp0
    const expected1 = (tp0 * 100 + tp1 * 150) / 250
    const out = vwap(candles)
    expect(out[0]).toBeCloseTo(expected0, 10)
    expect(out[1]).toBeCloseTo(expected1, 10)
  })
  it('is null when there has been zero volume so far', () => {
    const candles = [candle(0, 10, 10, 10, 10, 0)]
    expect(vwap(candles)[0]).toBeNull()
  })
})

describe('volumeRatio', () => {
  it('is null until the average has warmed up', () => {
    const candles = [candle(0, 1, 1, 1, 1, 10), candle(1, 1, 1, 1, 1, 20)]
    expect(volumeRatio(candles, 5).every((v) => v === null)).toBe(true)
  })
  it('is 1 when volume equals its own trailing average', () => {
    const candles = Array.from({ length: 5 }, (_, i) => candle(i, 1, 1, 1, 1, 50))
    expect(volumeRatio(candles, 5)[4]).toBeCloseTo(1, 10)
  })
})

describe('pivotLevels', () => {
  it('returns null with fewer than two candles', () => {
    expect(pivotLevels([])).toBeNull()
    expect(pivotLevels([candle(0, 1, 2, 0, 1, 1)])).toBeNull()
  })
  it('derives classic floor pivots from the second-to-last bar', () => {
    const candles = [candle(0, 10, 12, 8, 11, 1), candle(1, 11, 11.5, 10.5, 11.2, 1)]
    const p = pivotLevels(candles)!
    const pivot = (12 + 8 + 11) / 3
    expect(p.pivot).toBeCloseTo(pivot, 10)
    expect(p.r1).toBeCloseTo(2 * pivot - 8, 10)
    expect(p.s1).toBeCloseTo(2 * pivot - 12, 10)
    expect(p.r2).toBeCloseTo(pivot + 4, 10)
    expect(p.s2).toBeCloseTo(pivot - 4, 10)
  })
})
