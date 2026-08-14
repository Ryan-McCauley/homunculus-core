import { describe, it, expect } from 'vitest'
import {
  SCREENER_SCHEMA_VERSION,
  GATE_ORDER,
  GATE_META,
  blankGates,
  normalizeScreenerDef,
  validateScreenerDef,
  screenerFromInput,
  gatesEqual,
  type ScreenerDef,
} from './screener'

/** A minimal valid definition — every test that needs a good one starts here. */
function baseDef(): ScreenerDef {
  return normalizeScreenerDef({ id: 'dip-hunter', name: 'DIP HUNTER' })
}

describe('gate registry', () => {
  it('orders gates the way the rail and funnel read them', () => {
    expect(GATE_ORDER).toEqual([
      'marketCap', 'volume24h', 'change24h',
      'rsi', 'ema50', 'ema200', 'macd', 'bbWidth',
      'pattern', 'freshness', 'relVolume',
    ])
  })

  it('gives every gate metadata, with unique display letters', () => {
    const letters = GATE_ORDER.map((g) => GATE_META[g].letter)
    expect(new Set(letters).size).toBe(GATE_ORDER.length)
    for (const g of GATE_ORDER) {
      expect(GATE_META[g].label.length).toBeGreaterThan(0)
      expect(GATE_META[g].group).toMatch(/^(MARKET|TECHNICAL|PATTERN)$/)
    }
  })

  it('groups gates contiguously so the rail never interleaves sections', () => {
    const groups = GATE_ORDER.map((g) => GATE_META[g].group)
    const firstIndex = new Map<string, number>()
    const lastIndex = new Map<string, number>()
    groups.forEach((grp, i) => {
      if (!firstIndex.has(grp)) firstIndex.set(grp, i)
      lastIndex.set(grp, i)
    })
    for (const [grp, first] of firstIndex) {
      const span = lastIndex.get(grp)! - first + 1
      expect(groups.slice(first, first + span).every((g) => g === grp)).toBe(true)
    }
  })
})

describe('blankGates', () => {
  it('starts every gate disabled — a blank screener passes the whole universe', () => {
    const gates = blankGates()
    for (const g of GATE_ORDER) expect(gates[g].enabled).toBe(false)
  })

  it('defaults the trend and cross gates to ANY', () => {
    const gates = blankGates()
    expect(gates.ema50.trend).toBe('ANY')
    expect(gates.ema200.trend).toBe('ANY')
    expect(gates.macd.cross).toBe('ANY')
  })
})

describe('normalizeScreenerDef', () => {
  it('fills defaults for everything the caller omitted', () => {
    const def = normalizeScreenerDef({ id: 'x', name: 'X' })
    expect(def.schemaVersion).toBe(SCREENER_SCHEMA_VERSION)
    expect(def.timeframe).toBe('1hr')
    expect(def.origin).toEqual({ kind: 'blank' })
    expect(def.universe).toBe('ALL')
    expect(Object.keys(def.gates).sort()).toEqual([...GATE_ORDER].sort())
  })

  it('keeps values the caller supplied', () => {
    const def = normalizeScreenerDef({
      id: 'x', name: 'X', timeframe: '4hr',
      gates: { rsi: { enabled: true, min: null, max: 35 } },
    })
    expect(def.timeframe).toBe('4hr')
    expect(def.gates.rsi).toEqual({ enabled: true, min: null, max: 35 })
    expect(def.gates.volume24h.enabled).toBe(false)
  })

  it('is idempotent — normalizing twice changes nothing', () => {
    const once = normalizeScreenerDef({ id: 'x', name: 'X', gates: { rsi: { enabled: true, max: 35 } } })
    expect(normalizeScreenerDef(once)).toEqual(once)
  })

  it('round-trips losslessly through JSON — this is the TS↔Python wire format', () => {
    const def = normalizeScreenerDef({
      id: 'x', name: 'X', timeframe: '1day',
      gates: {
        marketCap: { enabled: true, min: 100_000_000, max: null },
        pattern: { enabled: true, names: ['hammer', 'dragonfly_doji'] },
        ema200: { enabled: true, trend: 'ABOVE' },
        macd: { enabled: true, cross: 'BULLISH' },
      },
    })
    expect(JSON.parse(JSON.stringify(def))).toEqual(def)
  })
})

describe('validateScreenerDef', () => {
  it('accepts a well-formed definition', () => {
    const r = validateScreenerDef(baseDef())
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects a missing or blank name', () => {
    expect(validateScreenerDef({ ...baseDef(), name: '   ' }).errors)
      .toContain('name is required')
  })

  it('rejects an unknown timeframe', () => {
    const r = validateScreenerDef({ ...baseDef(), timeframe: '3h' })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/timeframe/)
  })

  it('rejects an inverted range (min above max)', () => {
    const def = baseDef()
    def.gates.rsi = { enabled: true, min: 70, max: 30 }
    const r = validateScreenerDef(def)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/rsi.*min/i)
  })

  it('allows an inverted-looking range when the gate is disabled', () => {
    const def = baseDef()
    def.gates.rsi = { enabled: false, min: 70, max: 30 }
    expect(validateScreenerDef(def).ok).toBe(true)
  })

  it('rejects an enabled range gate with no bound at all', () => {
    const def = baseDef()
    def.gates.volume24h = { enabled: true, min: null, max: null }
    const r = validateScreenerDef(def)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/volume24h/)
  })

  it('rejects an RSI bound outside 0–100', () => {
    const def = baseDef()
    def.gates.rsi = { enabled: true, min: null, max: 140 }
    expect(validateScreenerDef(def).ok).toBe(false)
  })

  it('rejects a negative market cap or volume bound', () => {
    const def = baseDef()
    def.gates.marketCap = { enabled: true, min: -5, max: null }
    expect(validateScreenerDef(def).ok).toBe(false)
  })

  it('rejects an enabled pattern gate with an empty whitelist', () => {
    const def = baseDef()
    def.gates.pattern = { enabled: true, names: [] }
    const r = validateScreenerDef(def)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/pattern/)
  })

  it('rejects an unknown pattern name', () => {
    const def = baseDef()
    def.gates.pattern = { enabled: true, names: ['moon_candle'] }
    expect(validateScreenerDef(def).ok).toBe(false)
  })

  it('rejects an unknown trend or cross value', () => {
    const a = baseDef(); a.gates.ema50 = { enabled: true, trend: 'SIDEWAYS' as never }
    const b = baseDef(); b.gates.macd = { enabled: true, cross: 'MAYBE' as never }
    expect(validateScreenerDef(a).ok).toBe(false)
    expect(validateScreenerDef(b).ok).toBe(false)
  })

  it('rejects a schemaVersion from the future', () => {
    const r = validateScreenerDef({ ...baseDef(), schemaVersion: SCREENER_SCHEMA_VERSION + 1 })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/schemaVersion/)
  })

  it('reports every problem at once rather than only the first', () => {
    const def = baseDef()
    def.name = ''
    def.gates.rsi = { enabled: true, min: 70, max: 30 }
    expect(validateScreenerDef(def).errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('screenerFromInput', () => {
  it('creates a blank screener with a slug id derived from the name', () => {
    const def = screenerFromInput({ name: 'Momentum Breakouts' }, 1_700_000_000_000)
    expect(def.id).toBe('momentum-breakouts')
    expect(def.origin).toEqual({ kind: 'blank' })
    expect(def.createdAt).toBe(1_700_000_000_000)
    expect(GATE_ORDER.every((g) => !def.gates[g].enabled)).toBe(true)
  })

  it('copies gates from a source screener without sharing structure', () => {
    const source = baseDef()
    source.gates.rsi = { enabled: true, min: null, max: 35 }
    const copy = screenerFromInput({ name: 'Copy', copyFrom: source }, 1)
    expect(copy.gates.rsi).toEqual(source.gates.rsi)
    copy.gates.rsi.max = 50
    expect(source.gates.rsi.max).toBe(35)
    expect(copy.origin).toEqual({ kind: 'copy', from: 'dip-hunter' })
  })

  it('tags an imported strategy gate-set with its origin', () => {
    const def = screenerFromInput(
      { name: 'Sniper Gates', importStrategy: 'sniper', gates: { rsi: { enabled: true, max: 35 } } },
      1,
    )
    expect(def.origin).toEqual({ kind: 'strategy', from: 'sniper' })
    expect(def.gates.rsi.max).toBe(35)
  })

  it('falls back to a stable id when the name has no slug characters', () => {
    const def = screenerFromInput({ name: '★★★' }, 42)
    expect(def.id.length).toBeGreaterThan(0)
    expect(def.id).toMatch(/^screener-/)
  })
})

describe('gatesEqual', () => {
  it('detects an unsaved edit — this drives the amber dirty dot', () => {
    const a = baseDef()
    const b = normalizeScreenerDef(JSON.parse(JSON.stringify(a)))
    expect(gatesEqual(a.gates, b.gates)).toBe(true)
    b.gates.rsi.enabled = true
    expect(gatesEqual(a.gates, b.gates)).toBe(false)
  })

  it('ignores key order', () => {
    const a = baseDef()
    const reordered = normalizeScreenerDef({
      id: a.id, name: a.name,
      gates: Object.fromEntries([...GATE_ORDER].reverse().map((g) => [g, a.gates[g]])),
    })
    expect(gatesEqual(a.gates, reordered.gates)).toBe(true)
  })
})
