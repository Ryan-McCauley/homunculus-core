// Saved screeners — the user's own market questions, persisted.
//
//   data/crypto/screeners.json    the library, authoritative
//
// A screener is pure data (see shared/screener.ts); this module owns its lifecycle:
// seed on first boot, create, edit, rename, delete. Nothing here evaluates anything
// — that is engine/screener_engine.py, reached through screenerRunner.ts.
//
// SCREENERS ARE NOT STRATEGIES. A strategy executes: it sizes a bid, places legs,
// manages an exit. A screener only asks a question about the market. They are kept
// apart deliberately, because conflating them is how a "just looking" filter turns
// into something that trades. The one bridge is STRATEGY_PRESETS below, and it runs
// one way only: a strategy's gates can be COPIED into a new screener as a starting
// point, and from that moment the copy is independent. Editing a screener can never
// reach back and retune a live strategy.
//
// Persistence follows the house pattern (stateStore, whole-file rewrite on change);
// mutations are attributed in the audit log the same way strategy tuning is.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeScreenerDef, screenerFromInput, validateScreenerDef,
  type PartialGates, type ScreenerDef, type ScreenerTimeframe,
} from '../shared/screener'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'

const SCREENERS_DIR = join(process.cwd(), 'data', 'crypto')
const SCREENERS_FILE = join(SCREENERS_DIR, 'screeners.json')

export interface StrategyPreset {
  label: string
  timeframe: ScreenerTimeframe
  gates: PartialGates
}

/** Gate snapshots of the live trading strategies, offered as starting points in the
 *  "+ NEW SCREENER" flow. These are DEPARTURE POINTS, not mirrors: a strategy also
 *  carries sizing, exits and circuit breakers that a screener has no concept of, and
 *  the skills retune themselves as they run. A screener created from one is a copy
 *  taken at creation time and never resynced — which is exactly what makes it safe
 *  to edit. */
export const STRATEGY_PRESETS: Record<string, StrategyPreset> = {
  sniper: {
    label: 'SNIPER',
    timeframe: '1hr',
    gates: {
      pattern: { enabled: true, names: ['dragonfly_doji', 'bullish_harami_cross', 'hammer'] },
      rsi: { enabled: true, min: null, max: 35 },
      freshness: { enabled: true, min: null, max: 2 },
      relVolume: { enabled: true, min: null, max: 2 },
    },
  },
  trapline: {
    label: 'TRAPLINE',
    timeframe: '1hr',
    gates: {
      pattern: { enabled: true, names: ['dragonfly_doji', 'bullish_harami_cross', 'hammer'] },
      rsi: { enabled: true, min: 15, max: 35 },
      freshness: { enabled: true, min: null, max: 2 },
    },
  },
  oversold: {
    label: 'OVERSOLD RSI',
    timeframe: '1hr',
    gates: {
      rsi: { enabled: true, min: null, max: 30 },
    },
  },
  'fast-cash': {
    label: 'FAST CASH',
    timeframe: '15m',
    gates: {
      pattern: {
        enabled: true,
        names: ['hammer', 'dragonfly_doji', 'bullish_engulfing', 'bullish_harami', 'piercing_line'],
      },
      freshness: { enabled: true, min: null, max: 2 },
    },
  },
  firecracker: {
    label: 'FIRECRACKER',
    timeframe: '1hr',
    gates: {
      rsi: { enabled: true, min: null, max: 40 },
      pattern: {
        enabled: true,
        names: ['hammer', 'dragonfly_doji', 'bullish_harami_cross', 'bullish_engulfing'],
      },
    },
  },
}

/** Starter library, written on first boot so the tab is never an empty room. */
function seedScreeners(now: number): ScreenerDef[] {
  const seeds: Array<{ name: string; timeframe: ScreenerTimeframe; gates: PartialGates }> = [
    {
      name: 'DIP HUNTER',
      timeframe: '1hr',
      gates: {
        marketCap: { enabled: true, min: 100_000_000, max: null },
        volume24h: { enabled: true, min: 1_000_000, max: null },
        change24h: { enabled: true, min: -12, max: -1 },
        rsi: { enabled: true, min: null, max: 35 },
      },
    },
    {
      name: 'OVERSOLD BLUE-CHIPS',
      timeframe: '4hr',
      gates: {
        marketCap: { enabled: true, min: 1_000_000_000, max: null },
        volume24h: { enabled: true, min: 5_000_000, max: null },
        rsi: { enabled: true, min: null, max: 30 },
        ema200: { enabled: true, trend: 'ABOVE' },
      },
    },
    {
      name: 'BREAKOUT WATCH',
      timeframe: '4hr',
      gates: {
        volume24h: { enabled: true, min: 2_000_000, max: null },
        change24h: { enabled: true, min: 5, max: 20 },
        rsi: { enabled: true, min: 50, max: 70 },
        ema50: { enabled: true, trend: 'ABOVE' },
        macd: { enabled: true, cross: 'BULLISH' },
      },
    },
  ]
  return seeds.map((s) => screenerFromInput({ name: s.name, timeframe: s.timeframe, gates: s.gates }, now))
}

export interface CreateScreenerInput {
  name: string
  timeframe?: ScreenerTimeframe
  universe?: 'ALL' | 'HELD'
  gates?: PartialGates
  /** Start from another saved screener — a deep copy, never a live link. */
  copyFromId?: string
  /** Start from a STRATEGY_PRESETS snapshot; recorded in `origin` for provenance. */
  importStrategy?: string
}

export interface StoreResult {
  ok: boolean
  screener?: ScreenerDef
  errors?: string[]
}

class ScreenerStore {
  private items: ScreenerDef[] = []

  constructor() {
    this.load()
  }

  private load(): void {
    const raw = stateStore.readJson<unknown>(SCREENERS_FILE, undefined)
    if (Array.isArray(raw)) {
      // One corrupt entry must not cost the user their whole library, so unreadable
      // rows are dropped with a warning rather than aborting the boot.
      this.items = raw.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const def = normalizeScreenerDef(entry as Record<string, unknown>)
        if (!def.id) return []
        return [def]
      })
      if (this.items.length) return
    }
    this.items = seedScreeners(Date.now())
    this.persist()
    console.log(`[screeners] seeded ${this.items.length} starter screener(s)`)
  }

  private persist(): void {
    if (!existsSync(SCREENERS_DIR)) mkdirSync(SCREENERS_DIR, { recursive: true })
    stateStore.writeJson(SCREENERS_FILE, this.items)
  }

  list(): ScreenerDef[] {
    return this.items.map((s) => JSON.parse(JSON.stringify(s)) as ScreenerDef)
  }

  get(id: string): ScreenerDef | undefined {
    const found = this.items.find((s) => s.id === id)
    return found ? (JSON.parse(JSON.stringify(found)) as ScreenerDef) : undefined
  }

  /** A free id derived from the name; a collision gets a numeric suffix rather than
   *  silently overwriting the screener already living there. */
  private freeId(base: string): string {
    if (!this.items.some((s) => s.id === base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`
      if (!this.items.some((s) => s.id === candidate)) return candidate
    }
    return `${base}-${Date.now().toString(36)}`
  }

  create(input: CreateScreenerInput, now = Date.now()): StoreResult {
    if (!input?.name || !String(input.name).trim()) {
      return { ok: false, errors: ['name is required'] }
    }

    let gates = input.gates
    let timeframe = input.timeframe
    let copyFrom: ScreenerDef | undefined

    // A PRESENT-BUT-EMPTY reference is a bug upstream, not a request for a blank
    // screener. The create overlay can post importStrategy:"" if its strategy list
    // has not loaded yet; treating that as falsy silently handed back an empty
    // screener when the user had asked for a strategy's gates. Omitting the field
    // entirely still means blank — that is the honest way to ask for one.
    if (input.copyFromId !== undefined) {
      if (!input.copyFromId) return { ok: false, errors: ['copyFromId was empty — pick a screener to copy'] }
      copyFrom = this.items.find((s) => s.id === input.copyFromId)
      if (!copyFrom) return { ok: false, errors: [`no screener named ${input.copyFromId} to copy`] }
    }
    if (input.importStrategy !== undefined) {
      if (!input.importStrategy) return { ok: false, errors: ['importStrategy was empty — pick a strategy to import'] }
      const preset = STRATEGY_PRESETS[input.importStrategy]
      if (!preset) return { ok: false, errors: [`unknown strategy ${input.importStrategy}`] }
      gates = { ...preset.gates, ...(input.gates ?? {}) }
      timeframe = timeframe ?? preset.timeframe
    }

    const def = screenerFromInput({
      name: input.name,
      timeframe,
      universe: input.universe,
      gates,
      copyFrom,
      importStrategy: input.importStrategy,
    }, now)
    def.id = this.freeId(def.id)

    const check = validateScreenerDef(def)
    if (!check.ok) return { ok: false, errors: check.errors }

    this.items = [...this.items, def]
    this.persist()
    auditLog.note({
      action: 'screener.create',
      resource: `screener:${def.id}`,
      summary: `created screener "${def.name}" (${def.origin.kind})`,
      after: def,
    })
    return { ok: true, screener: this.get(def.id) }
  }

  /** Patch a screener. `id`, `createdAt` and `origin` are fixed at creation — a
   *  rename must not orphan links, and provenance is a record, not a field. */
  update(id: string, patch: Partial<ScreenerDef>, now = Date.now()): StoreResult {
    const before = this.items.find((s) => s.id === id)
    if (!before) return { ok: false, errors: [`no screener named ${id}`] }

    const next = normalizeScreenerDef({
      ...before,
      ...patch,
      id: before.id,
      createdAt: before.createdAt,
      origin: before.origin,
      updatedAt: Math.max(now, before.updatedAt + 1),
    })

    const check = validateScreenerDef(next)
    if (!check.ok) return { ok: false, errors: check.errors }

    this.items = this.items.map((s) => (s.id === id ? next : s))
    this.persist()
    auditLog.note({
      action: 'screener.update',
      resource: `screener:${id}`,
      summary: `edited screener "${next.name}"`,
      before, after: next,
    })
    return { ok: true, screener: this.get(id) }
  }

  remove(id: string): StoreResult {
    const before = this.items.find((s) => s.id === id)
    if (!before) return { ok: false, errors: [`no screener named ${id}`] }
    this.items = this.items.filter((s) => s.id !== id)
    this.persist()
    auditLog.note({
      action: 'screener.delete',
      resource: `screener:${id}`,
      summary: `deleted screener "${before.name}"`,
      before,
    })
    return { ok: true }
  }
}

export const screenerStore = new ScreenerStore()
