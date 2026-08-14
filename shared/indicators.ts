// Indicator math shared by the MARKET chart (drawing) and the server alert
// evaluator (firing). Both import from here so a plotted line and the alert that
// watches it can never disagree — the failure mode this file exists to prevent is
// a chart showing an RSI cross that the alert engine never saw.
//
// Every series function returns an array ALIGNED TO THE INPUT CANDLES: index i of
// the result corresponds to candle i, with `null` where the indicator has not
// warmed up yet. That alignment is what makes cross detection trivial (compare
// [n-2] and [n-1]) and lets the chart map values straight onto its x-scale.
//
// Conventions deliberately match server/crypto.ts so the strategy engine and these
// agree: Wilder smoothing for RSI/ATR/ADX, population variance (/n) for Bollinger.

/** Gemini candle tuple: [timestampMs, open, high, low, close, volume] */
export type Candle = [number, number, number, number, number, number]

export type Series = (number | null)[]

const HI = 2, LO = 3, C = 4, V = 5

export const closesOf = (candles: Candle[]): number[] => candles.map((c) => c[C])
export const highsOf = (candles: Candle[]): number[] => candles.map((c) => c[HI])
export const lowsOf = (candles: Candle[]): number[] => candles.map((c) => c[LO])

/** Last non-null value of a series, or null when the series never warmed up. */
export function last(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i]!
  return null
}

/** The final two non-null values, oldest first — the input for cross detection.
 *  Returns null unless BOTH exist, because a cross needs a before and an after. */
export function lastPair(series: Series): [number, number] | null {
  const vals: number[] = []
  for (let i = series.length - 1; i >= 0 && vals.length < 2; i--) {
    if (series[i] != null) vals.push(series[i]!)
  }
  return vals.length === 2 ? [vals[1]!, vals[0]!] : null
}

/** True when `a` crossed above `b` between the previous bar and the current one. */
export function crossedAbove(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[0] && a[1] > b[1]
}
export function crossedBelow(a: [number, number], b: [number, number]): boolean {
  return a[0] >= b[0] && a[1] < b[1]
}

// ── Moving averages ───────────────────────────────────────────────────────────

export function sma(values: number[], period: number): Series {
  return values.map((_, i) => {
    if (i < period - 1) return null
    let sum = 0
    for (let k = i - period + 1; k <= i; k++) sum += values[k]!
    return sum / period
  })
}

/** EMA seeded with the SMA of the first `period` values (matches server ema()). */
export function ema(values: number[], period: number): Series {
  const out: Series = values.map(() => null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let val = 0
  for (let i = 0; i < period; i++) val += values[i]!
  val /= period
  out[period - 1] = val
  for (let i = period; i < values.length; i++) {
    val = values[i]! * k + val * (1 - k)
    out[i] = val
  }
  return out
}

// ── Oscillators ───────────────────────────────────────────────────────────────

/** Wilder RSI. Mirrors server wilderRsiSeries() but null-aligned to the input. */
export function rsi(closes: number[], period = 14): Series {
  const out: Series = closes.map(() => null)
  if (closes.length < period + 1) return out
  const deltas: number[] = []
  for (let i = 1; i < closes.length; i++) deltas.push(closes[i]! - closes[i - 1]!)
  let avgGain = 0, avgLoss = 0
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!
    if (d >= 0) avgGain += d; else avgLoss += -d
  }
  avgGain /= period; avgLoss /= period
  const rsiFrom = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l))
  out[period] = rsiFrom(avgGain, avgLoss)
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!
    avgGain = (avgGain * (period - 1) + (d >= 0 ? d : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period
    out[i + 1] = rsiFrom(avgGain, avgLoss)
  }
  return out
}

export interface MacdSeries { macd: Series; signal: Series; histogram: Series }

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MacdSeries {
  const fastE = ema(closes, fast)
  const slowE = ema(closes, slow)
  const macdLine: Series = closes.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? fastE[i]! - slowE[i]! : null)

  // The signal EMA runs over the macd line's defined tail only, then is mapped
  // back onto the original indices — an EMA over nulls would poison the seed.
  const defined: number[] = []
  const idx: number[] = []
  macdLine.forEach((v, i) => { if (v != null) { defined.push(v); idx.push(i) } })
  const sigDense = ema(defined, sig)
  const signal: Series = closes.map(() => null)
  idx.forEach((origIndex, k) => { signal[origIndex] = sigDense[k] ?? null })

  const histogram: Series = closes.map((_, i) =>
    macdLine[i] != null && signal[i] != null ? macdLine[i]! - signal[i]! : null)
  return { macd: macdLine, signal, histogram }
}

export interface StochSeries { k: Series; d: Series }

/** Stochastic %K (raw, `period` lookback) smoothed into %D over `dPeriod`. */
export function stochastic(candles: Candle[], period = 14, dPeriod = 3): StochSeries {
  const k: Series = candles.map((_, i) => {
    if (i < period - 1) return null
    let hh = -Infinity, ll = Infinity
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j]![HI])
      ll = Math.min(ll, candles[j]![LO])
    }
    const range = hh - ll
    return range === 0 ? 50 : ((candles[i]![C] - ll) / range) * 100
  })
  const dense: number[] = []
  const idx: number[] = []
  k.forEach((v, i) => { if (v != null) { dense.push(v); idx.push(i) } })
  const dDense = sma(dense, dPeriod)
  const d: Series = candles.map(() => null)
  idx.forEach((origIndex, n) => { d[origIndex] = dDense[n] ?? null })
  return { k, d }
}

/** Commodity Channel Index over the typical price. */
export function cci(candles: Candle[], period = 20): Series {
  const tp = candles.map((c) => (c[HI] + c[LO] + c[C]) / 3)
  return tp.map((_, i) => {
    if (i < period - 1) return null
    const win = tp.slice(i - period + 1, i + 1)
    const mean = win.reduce((a, b) => a + b, 0) / period
    const meanDev = win.reduce((s, v) => s + Math.abs(v - mean), 0) / period
    return meanDev === 0 ? 0 : (tp[i]! - mean) / (0.015 * meanDev)
  })
}

/** Money Flow Index — RSI weighted by volume. */
export function mfi(candles: Candle[], period = 14): Series {
  const out: Series = candles.map(() => null)
  const tp = candles.map((c) => (c[HI] + c[LO] + c[C]) / 3)
  for (let i = period; i < candles.length; i++) {
    let pos = 0, neg = 0
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j]! * candles[j]![V]
      if (tp[j]! > tp[j - 1]!) pos += flow
      else if (tp[j]! < tp[j - 1]!) neg += flow
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg)
  }
  return out
}

// ── Volatility ────────────────────────────────────────────────────────────────

export interface BandSeries { upper: Series; middle: Series; lower: Series }

/** Bollinger Bands. Population variance (/n), matching server bollingerBands(). */
export function bollinger(closes: number[], period = 20, mult = 2): BandSeries {
  const middle = sma(closes, period)
  const upper: Series = [], lower: Series = []
  closes.forEach((_, i) => {
    if (i < period - 1) { upper.push(null); lower.push(null); return }
    const win = closes.slice(i - period + 1, i + 1)
    const mean = middle[i]!
    const variance = win.reduce((s, p) => s + (p - mean) ** 2, 0) / period
    const sd = Math.sqrt(variance)
    upper.push(mean + mult * sd)
    lower.push(mean - mult * sd)
  })
  return { upper, middle, lower }
}

/** True Range per candle. Index 0 is null — TR needs a previous close. */
export function trueRange(candles: Candle[]): Series {
  return candles.map((c, i) => {
    if (i === 0) return null
    const pc = candles[i - 1]![C]
    return Math.max(c[HI] - c[LO], Math.abs(c[HI] - pc), Math.abs(c[LO] - pc))
  })
}

/** Wilder-smoothed ATR. */
export function atr(candles: Candle[], period = 14): Series {
  const tr = trueRange(candles)
  const out: Series = candles.map(() => null)
  if (candles.length < period + 1) return out
  let sum = 0
  for (let i = 1; i <= period; i++) sum += tr[i] ?? 0
  let val = sum / period
  out[period] = val
  for (let i = period + 1; i < candles.length; i++) {
    val = (val * (period - 1) + (tr[i] ?? 0)) / period
    out[i] = val
  }
  return out
}

/** Keltner Channels: EMA basis ± mult × ATR. Pairs with Bollinger for squeeze. */
export function keltner(candles: Candle[], period = 20, mult = 1.5): BandSeries {
  const middle = ema(closesOf(candles), period)
  const a = atr(candles, period)
  const upper: Series = candles.map((_, i) =>
    middle[i] != null && a[i] != null ? middle[i]! + mult * a[i]! : null)
  const lower: Series = candles.map((_, i) =>
    middle[i] != null && a[i] != null ? middle[i]! - mult * a[i]! : null)
  return { upper, middle, lower }
}

/** Squeeze = Bollinger band width inside Keltner width: volatility coiling. */
export function squeezeOn(candles: Candle[]): Series {
  const bb = bollinger(closesOf(candles), 20, 2)
  const kc = keltner(candles, 20, 1.5)
  return candles.map((_, i) => {
    if (bb.upper[i] == null || kc.upper[i] == null) return null
    return bb.upper[i]! < kc.upper[i]! && bb.lower[i]! > kc.lower[i]! ? 1 : 0
  })
}

// ── Trend ─────────────────────────────────────────────────────────────────────

export interface AdxSeries { adx: Series; plusDi: Series; minusDi: Series }

/** Wilder ADX with +DI/−DI. ADX > 25 trending, < 20 chopping. */
export function adx(candles: Candle[], period = 14): AdxSeries {
  const n = candles.length
  const plusDi: Series = candles.map(() => null)
  const minusDi: Series = candles.map(() => null)
  const adxOut: Series = candles.map(() => null)
  if (n < period * 2) return { adx: adxOut, plusDi, minusDi }

  const tr = trueRange(candles)
  const plusDm: number[] = [0], minusDm: number[] = [0]
  for (let i = 1; i < n; i++) {
    const up = candles[i]![HI] - candles[i - 1]![HI]
    const down = candles[i - 1]![LO] - candles[i]![LO]
    plusDm.push(up > down && up > 0 ? up : 0)
    minusDm.push(down > up && down > 0 ? down : 0)
  }

  let trS = 0, pS = 0, mS = 0
  for (let i = 1; i <= period; i++) { trS += tr[i] ?? 0; pS += plusDm[i]!; mS += minusDm[i]! }
  const dxs: { i: number; dx: number }[] = []
  const pushDi = (i: number) => {
    const p = trS === 0 ? 0 : (pS / trS) * 100
    const m = trS === 0 ? 0 : (mS / trS) * 100
    plusDi[i] = p; minusDi[i] = m
    const sum = p + m
    dxs.push({ i, dx: sum === 0 ? 0 : (Math.abs(p - m) / sum) * 100 })
  }
  pushDi(period)
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + (tr[i] ?? 0)
    pS = pS - pS / period + plusDm[i]!
    mS = mS - mS / period + minusDm[i]!
    pushDi(i)
  }
  if (dxs.length < period) return { adx: adxOut, plusDi, minusDi }
  let avg = dxs.slice(0, period).reduce((a, b) => a + b.dx, 0) / period
  adxOut[dxs[period - 1]!.i] = avg
  for (let k = period; k < dxs.length; k++) {
    avg = (avg * (period - 1) + dxs[k]!.dx) / period
    adxOut[dxs[k]!.i] = avg
  }
  return { adx: adxOut, plusDi, minusDi }
}

/** Parabolic SAR — trailing stop dots that flip with trend. */
export function psar(candles: Candle[], step = 0.02, maxStep = 0.2): Series {
  const n = candles.length
  const out: Series = candles.map(() => null)
  if (n < 2) return out
  let bull = candles[1]![C] >= candles[0]![C]
  let sar = bull ? candles[0]![LO] : candles[0]![HI]
  let ep = bull ? candles[0]![HI] : candles[0]![LO]
  let af = step
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar)
    // SAR may not penetrate the prior two bars' range.
    const p1 = candles[i - 1]!, p2 = candles[i - 2] ?? p1
    if (bull) sar = Math.min(sar, p1[LO], p2[LO])
    else sar = Math.max(sar, p1[HI], p2[HI])

    const c = candles[i]!
    if (bull && c[LO] < sar) {           // flip to bear
      bull = false; sar = ep; ep = c[LO]; af = step
    } else if (!bull && c[HI] > sar) {   // flip to bull
      bull = true; sar = ep; ep = c[HI]; af = step
    } else if (bull && c[HI] > ep) {
      ep = c[HI]; af = Math.min(af + step, maxStep)
    } else if (!bull && c[LO] < ep) {
      ep = c[LO]; af = Math.min(af + step, maxStep)
    }
    out[i] = sar
  }
  return out
}

export interface SupertrendSeries { line: Series; /** 1 = long, -1 = short */ dir: Series }

/** Supertrend — ATR bands that ratchet, producing one flip-line stop/entry. */
export function supertrend(candles: Candle[], period = 10, mult = 3): SupertrendSeries {
  const a = atr(candles, period)
  const line: Series = candles.map(() => null)
  const dir: Series = candles.map(() => null)
  let upper = 0, lower = 0, trend = 1
  let started = false
  candles.forEach((c, i) => {
    if (a[i] == null) return
    const mid = (c[HI] + c[LO]) / 2
    const bUp = mid + mult * a[i]!
    const bLo = mid - mult * a[i]!
    if (!started) { upper = bUp; lower = bLo; trend = 1; started = true }
    else {
      upper = bUp < upper || candles[i - 1]![C] > upper ? bUp : upper
      lower = bLo > lower || candles[i - 1]![C] < lower ? bLo : lower
      if (trend === 1 && c[C] < lower) trend = -1
      else if (trend === -1 && c[C] > upper) trend = 1
    }
    line[i] = trend === 1 ? lower : upper
    dir[i] = trend
  })
  return { line, dir }
}

// ── Volume ────────────────────────────────────────────────────────────────────

/** On-Balance Volume — cumulative, so it is defined from index 0. */
export function obv(candles: Candle[]): Series {
  let acc = 0
  return candles.map((c, i) => {
    if (i === 0) return 0
    const prev = candles[i - 1]![C]
    if (c[C] > prev) acc += c[V]
    else if (c[C] < prev) acc -= c[V]
    return acc
  })
}

/** Rolling VWAP over the loaded window (these candle sets have no session
 *  boundary, so this is a window VWAP, not an exchange session VWAP). */
export function vwap(candles: Candle[]): Series {
  let pv = 0, vol = 0
  return candles.map((c) => {
    const tp = (c[HI] + c[LO] + c[C]) / 3
    pv += tp * c[V]; vol += c[V]
    return vol === 0 ? null : pv / vol
  })
}

/** Volume relative to its own N-bar average — the basis for spike alerts. */
export function volumeRatio(candles: Candle[], period = 20): Series {
  const vols = candles.map((c) => c[V])
  const avg = sma(vols, period)
  return candles.map((_, i) => (avg[i] && avg[i]! > 0 ? vols[i]! / avg[i]! : null))
}

// ── Levels ────────────────────────────────────────────────────────────────────

export interface PivotLevels { pivot: number; r1: number; r2: number; s1: number; s2: number }

/** Classic floor-trader pivots from the last completed bar (use a 1day candle
 *  set for daily pivots). Returns null when there is no prior bar to derive from. */
export function pivotLevels(candles: Candle[]): PivotLevels | null {
  if (candles.length < 2) return null
  const b = candles[candles.length - 2]!
  const p = (b[HI] + b[LO] + b[C]) / 3
  return {
    pivot: p,
    r1: 2 * p - b[LO],
    s1: 2 * p - b[HI],
    r2: p + (b[HI] - b[LO]),
    s2: p - (b[HI] - b[LO]),
  }
}
