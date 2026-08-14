import { describe, it, expect } from 'vitest'
import {
  gateStrip, blockedText, fitBarWidth, isDirty, railGroups,
  boundLabel, formatGateValue, patternLabel, timeframeLabel, degradedNote,
} from './screenerUi'
import { normalizeScreenerDef, type ScreenerCandidate, type GateVerdict } from '../../shared/screener'

const def = (over: Record<string, unknown> = {}) =>
  normalizeScreenerDef({ id: 's', name: 'S', ...over })

function verdict(over: Partial<GateVerdict> = {}): GateVerdict {
  return { gate: 'rsi', pass: true, degraded: false, value: null, text: null, reason: '', ...over }
}

function candidate(over: Partial<ScreenerCandidate> = {}): ScreenerCandidate {
  return {
    symbol: 'JTOUSD', last: 1.842, change24h: -6.2, volume24h: 8_400_000,
    marketCap: 500_000_000, held: false, fit: 96, passes: true,
    gates: [], blockedBy: null, blockedReason: null,
    rsi: 28.4, pattern: 'dragonfly_doji', patternAgeBars: 1,
    ...over,
  }
}

describe('gateStrip', () => {
  it('shows only the gates the screener actually enabled', () => {
    const d = def({ gates: { rsi: { enabled: true, max: 35 }, volume24h: { enabled: true, min: 1 } } })
    const strip = gateStrip(candidate({
      gates: [verdict({ gate: 'volume24h' }), verdict({ gate: 'rsi' })],
    }), d)
    expect(strip.map((s) => s.gate)).toEqual(['volume24h', 'rsi'])
  })

  it('is empty when nothing is enabled — no strip of meaningless ticks', () => {
    expect(gateStrip(candidate(), def())).toEqual([])
  })

  it('carries the display letter for each gate', () => {
    const d = def({ gates: { rsi: { enabled: true, max: 35 } } })
    expect(gateStrip(candidate({ gates: [verdict({ gate: 'rsi' })] }), d)[0]!.letter).toBe('R')
  })

  it('marks state as pass, fail or degraded', () => {
    const d = def({
      gates: {
        marketCap: { enabled: true, min: 1 },
        rsi: { enabled: true, max: 35 },
        volume24h: { enabled: true, min: 1 },
      },
    })
    const strip = gateStrip(candidate({
      gates: [
        verdict({ gate: 'marketCap', pass: true, degraded: true }),
        verdict({ gate: 'volume24h', pass: false }),
        verdict({ gate: 'rsi', pass: true }),
      ],
    }), d)
    expect(strip.map((s) => s.state)).toEqual(['degraded', 'fail', 'pass'])
  })

  it('follows rail order regardless of the order verdicts arrived in', () => {
    const d = def({ gates: { relVolume: { enabled: true, max: 2 }, marketCap: { enabled: true, min: 1 } } })
    const strip = gateStrip(candidate({
      gates: [verdict({ gate: 'relVolume' }), verdict({ gate: 'marketCap' })],
    }), d)
    expect(strip.map((s) => s.gate)).toEqual(['marketCap', 'relVolume'])
  })

  it('gives every cell a tooltip naming the gate', () => {
    const d = def({ gates: { rsi: { enabled: true, max: 35 } } })
    const cell = gateStrip(candidate({ gates: [verdict({ gate: 'rsi', value: 28.4 })] }), d)[0]!
    expect(cell.title).toMatch(/RSI/)
  })

  it('puts the failure reason in the tooltip of a failing cell', () => {
    const d = def({ gates: { rsi: { enabled: true, max: 35 } } })
    const cell = gateStrip(candidate({
      gates: [verdict({ gate: 'rsi', pass: false, reason: 'RSI 41.9 is above the 35 ceiling' })],
    }), d)[0]!
    expect(cell.title).toMatch(/41.9/)
  })
})

describe('blockedText', () => {
  it('is empty for a passing candidate', () => {
    expect(blockedText(candidate())).toBe('')
  })

  it('reads as a plain sentence a trader can act on', () => {
    expect(blockedText(candidate({
      passes: false, blockedBy: 'rsi', blockedReason: 'RSI 41.9 is above the 35 ceiling',
    }))).toBe('BLOCKED · RSI 41.9 is above the 35 ceiling')
  })

  it('falls back to naming the gate when no reason came back', () => {
    expect(blockedText(candidate({ passes: false, blockedBy: 'ema200', blockedReason: null })))
      .toMatch(/EMA 200/)
  })
})

describe('fitBarWidth', () => {
  it('maps fit straight onto a percentage', () => {
    expect(fitBarWidth(96)).toBe('96%')
  })
  it('clamps out-of-range values rather than overflowing the bar', () => {
    expect(fitBarWidth(140)).toBe('100%')
    expect(fitBarWidth(-5)).toBe('0%')
  })
  it('treats a missing fit as empty', () => {
    expect(fitBarWidth(NaN)).toBe('0%')
  })
})

describe('isDirty', () => {
  it('is false for an untouched screener', () => {
    const saved = def({ gates: { rsi: { enabled: true, max: 35 } } })
    expect(isDirty(saved, saved)).toBe(false)
  })

  it('is false for a structurally identical copy', () => {
    const saved = def({ gates: { rsi: { enabled: true, max: 35 } } })
    expect(isDirty(saved, JSON.parse(JSON.stringify(saved)))).toBe(false)
  })

  it('sees an edited gate', () => {
    const saved = def({ gates: { rsi: { enabled: true, max: 35 } } })
    const draft = def({ gates: { rsi: { enabled: true, max: 40 } } })
    expect(isDirty(saved, draft)).toBe(true)
  })

  it('sees a changed timeframe', () => {
    expect(isDirty(def({ timeframe: '1hr' }), def({ timeframe: '4hr' }))).toBe(true)
  })

  it('sees a changed universe', () => {
    expect(isDirty(def({ universe: 'ALL' }), def({ universe: 'HELD' }))).toBe(true)
  })

  it('sees a rename', () => {
    expect(isDirty(def({ name: 'A' }), def({ name: 'B' }))).toBe(true)
  })

  it('ignores updatedAt, which changes on every save', () => {
    expect(isDirty(def({ updatedAt: 1 }), def({ updatedAt: 999 }))).toBe(false)
  })

  it('is false when there is nothing saved to compare against', () => {
    expect(isDirty(undefined, def())).toBe(false)
  })
})

describe('railGroups', () => {
  it('splits the rail into MARKET, TECHNICAL and PATTERN', () => {
    expect(railGroups().map((g) => g.group)).toEqual(['MARKET', 'TECHNICAL', 'PATTERN'])
  })

  it('lists every gate exactly once across the groups', () => {
    const all = railGroups().flatMap((g) => g.gates)
    expect(all.length).toBe(new Set(all).size)
    expect(all).toContain('marketCap')
    expect(all).toContain('relVolume')
  })

  it('keeps gate order inside each group', () => {
    const technical = railGroups().find((g) => g.group === 'TECHNICAL')!
    expect(technical.gates).toEqual(['rsi', 'ema50', 'ema200', 'macd', 'bbWidth'])
  })
})

describe('boundLabel', () => {
  it('renders a one-sided floor', () => {
    expect(boundLabel('volume24h', { enabled: true, min: 1_000_000, max: null })).toBe('> $1M')
  })
  it('renders a one-sided ceiling', () => {
    expect(boundLabel('rsi', { enabled: true, min: null, max: 35 })).toBe('≤ 35')
  })
  it('renders a two-sided range', () => {
    expect(boundLabel('change24h', { enabled: true, min: -12, max: -1 })).toBe('-12% … -1%')
  })
  it('says ANY when the gate is off', () => {
    expect(boundLabel('rsi', { enabled: false, min: null, max: 35 })).toBe('ANY')
  })
  it('says ANY when enabled with no bound', () => {
    expect(boundLabel('rsi', { enabled: true, min: null, max: null })).toBe('ANY')
  })
  it('renders a trend gate by its side', () => {
    expect(boundLabel('ema200', { enabled: true, trend: 'ABOVE' })).toBe('ABOVE')
    expect(boundLabel('ema200', { enabled: false, trend: 'ABOVE' })).toBe('ANY')
  })
  it('renders a cross gate by its direction', () => {
    expect(boundLabel('macd', { enabled: true, cross: 'BULLISH' })).toBe('BULLISH')
    expect(boundLabel('macd', { enabled: false, cross: 'ANY' })).toBe('OFF')
  })
  it('summarizes a pattern whitelist by count', () => {
    expect(boundLabel('pattern', { enabled: true, names: ['hammer', 'doji'] })).toBe('2 SELECTED')
    expect(boundLabel('pattern', { enabled: false, names: [] })).toBe('ANY')
  })
})

describe('formatGateValue', () => {
  it('abbreviates large dollar figures', () => {
    expect(formatGateValue('marketCap', 1_500_000_000)).toBe('$1.5B')
    expect(formatGateValue('volume24h', 8_400_000)).toBe('$8.4M')
  })
  it('renders percentages with a sign', () => {
    expect(formatGateValue('change24h', -6.2)).toBe('-6.2%')
    expect(formatGateValue('change24h', 3)).toBe('+3.0%')
  })
  it('renders RSI to one decimal', () => {
    expect(formatGateValue('rsi', 28.42)).toBe('28.4')
  })
  it('renders freshness in bars', () => {
    expect(formatGateValue('freshness', 0)).toBe('now')
    expect(formatGateValue('freshness', 1)).toBe('1 bar')
    expect(formatGateValue('freshness', 3)).toBe('3 bars')
  })
  it('renders relative volume as a multiple', () => {
    expect(formatGateValue('relVolume', 1.85)).toBe('1.9×')
  })
  it('renders a missing value as an em dash', () => {
    expect(formatGateValue('rsi', null)).toBe('—')
  })
})

describe('patternLabel', () => {
  it('turns a snake_case detector name into something readable', () => {
    expect(patternLabel('dragonfly_doji')).toBe('dragonfly doji')
    expect(patternLabel('bullish_harami_cross')).toBe('bullish harami cross')
  })
  it('renders nothing for no pattern', () => {
    expect(patternLabel(null)).toBe('—')
  })
})

describe('timeframeLabel', () => {
  it('uses the labels a trader reads on a chart', () => {
    expect(timeframeLabel('15m')).toBe('15M')
    expect(timeframeLabel('1hr')).toBe('1H')
    expect(timeframeLabel('1week')).toBe('1W')
  })
})

describe('degradedNote', () => {
  it('is empty when every gate had its data', () => {
    expect(degradedNote([])).toBe('')
  })
  it('names the gate and why it stood aside', () => {
    const note = degradedNote(['marketCap'])
    expect(note).toMatch(/MKT CAP/)
    expect(note).toMatch(/no data/i)
  })
  it('lists several gates', () => {
    expect(degradedNote(['marketCap', 'volume24h'])).toMatch(/MKT CAP.*VOL 24H/)
  })
})
