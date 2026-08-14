// Regenerates engine/fixtures/parity.json — the cross-language contract between
// shared/indicators.ts and engine/indicators.py.
//
//   npx tsx engine/tools/gen-parity-fixture.ts
//
// The fixture carries real candles plus the numbers the TypeScript implementation
// produces from them. engine/tests/test_parity.py recomputes those numbers in Python
// and fails on any disagreement, so a change to one implementation cannot silently
// leave the other behind: whoever edits the math has to regenerate this file, and
// regenerating it makes the behaviour change visible in the diff.
//
// Selection is deterministic (symbols sorted, fixed tail length) so re-running on the
// same cache is a no-op in git.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  sma, ema, rsi, macd, bollinger,
  closesOf, last, lastPair,
  type Candle,
} from '../../shared/indicators'

const volumesOf = (candles: Candle[]): number[] => candles.map((c) => c[5])

const CACHE = join(process.cwd(), 'data', 'crypto', 'candle-cache.json')
const OUT = join(process.cwd(), 'engine', 'fixtures', 'parity.json')

const SYMBOL_COUNT = 4
const BARS = 260 // enough to warm up EMA-200

interface CacheFile { symbols: Record<string, Record<string, Candle[]>> }

function bbWidthPct(closes: number[], period = 20, mult = 2): number | null {
  const b = bollinger(closes, period, mult)
  const up = last(b.upper), lo = last(b.lower), mid = last(b.middle)
  if (up == null || lo == null || mid == null || mid === 0) return null
  return ((up - lo) / mid) * 100
}

function relVolume(volumes: number[], period = 20): number | null {
  if (volumes.length < period + 1) return null
  const window = volumes.slice(-period - 1, -1)
  const baseline = window.reduce((a, b) => a + b, 0) / period
  if (baseline <= 0) return null
  return volumes[volumes.length - 1]! / baseline
}

function pctChange(closes: number[], lookback: number): number | null {
  if (closes.length < lookback + 1) return null
  const ref = closes[closes.length - 1 - lookback]!
  if (ref === 0) return null
  return ((closes[closes.length - 1]! - ref) / ref) * 100
}

/** Verbatim copy of aggregateTo4h in server/crypto.ts — the behaviour the Python
 *  rollup must reproduce. Duplicated rather than imported because that module opens
 *  network connections and reads Gemini keys at import time. */
const FOUR_H_MS = 4 * 60 * 60 * 1000
function aggregateTo4h(hourly: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const c of hourly) {
    const bucket = Math.floor(c[0] / FOUR_H_MS) * FOUR_H_MS
    const prev = out[out.length - 1]
    if (prev && prev[0] === bucket) {
      prev[2] = Math.max(prev[2], c[2])
      prev[3] = Math.min(prev[3], c[3])
      prev[4] = c[4]
      prev[5] += c[5]
    } else {
      out.push([bucket, c[1], c[2], c[3], c[4], c[5]])
    }
  }
  return out
}

const cache = JSON.parse(readFileSync(CACHE, 'utf8')) as CacheFile
const symbols = Object.keys(cache.symbols)
  .filter((s) => (cache.symbols[s]?.['1hr']?.length ?? 0) >= BARS)
  .sort()
  .slice(0, SYMBOL_COUNT)

if (symbols.length === 0) throw new Error('no symbols in the candle cache have enough 1hr history')

const cases = symbols.map((symbol) => {
  const candles = cache.symbols[symbol]!['1hr']!.slice(-BARS)
  const c = closesOf(candles)
  const v = volumesOf(candles)
  const m = macd(c)
  const b = bollinger(c, 20, 2)
  const macdPair = lastPair(m.macd)
  const signalPair = lastPair(m.signal)
  return {
    symbol,
    candles,
    expected4h: aggregateTo4h(candles),
    expected: {
      sma20: last(sma(c, 20)),
      ema12: last(ema(c, 12)),
      ema50: last(ema(c, 50)),
      ema200: last(ema(c, 200)),
      rsi14: last(rsi(c, 14)),
      rsi14_prev: lastPair(rsi(c, 14))?.[0] ?? null,
      macd: last(m.macd),
      macdSignal: last(m.signal),
      macdHistogram: last(m.histogram),
      macdPair,
      signalPair,
      bbUpper: last(b.upper),
      bbMiddle: last(b.middle),
      bbLower: last(b.lower),
      bbWidthPct: bbWidthPct(c, 20, 2),
      relVolume20: relVolume(v, 20),
      pctChange24: pctChange(c, 24),
    },
  }
})

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ generatedFrom: 'shared/indicators.ts', bars: BARS, cases }, null, 1))
console.log(`wrote ${OUT}: ${cases.length} symbols × ${BARS} bars — ${symbols.join(', ')}`)
