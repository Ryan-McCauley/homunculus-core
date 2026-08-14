// The screener contract — the ONLY coupling between the TypeScript app and the
// Python screening engine (engine/screener_engine.py).
//
// A screener is a saved question about the market: "which coins are above $100M cap,
// oversold on the 1hr, and printing a reversal candle?" It is pure data. Evaluating
// it is a pure function of (definition + candles + market stats), which is why the
// engine can be a deterministic Python process with no network and no model in it.
//
// SCHEMA DISCIPLINE. `schemaVersion` is stamped on both the job sent to the engine
// and the result it returns. The engine refuses a job whose version it does not
// implement rather than guessing, because a silently mismatched gate is a screener
// that lies about what it filtered. Bump the constant and both sides in one commit.
//
// GATE_ORDER is load-bearing in three places at once: the order the rail renders,
// the order the funnel eliminates in, and the order that decides WHICH failing gate
// is reported as the blocking reason (the first one). Reordering it changes user-
// visible output, so it lives here as one list rather than being repeated per site.

export const SCREENER_SCHEMA_VERSION = 1

// ── Timeframes ────────────────────────────────────────────────────────────────
// The engine receives only the timeframes Gemini actually serves and derives the
// rest by UTC-aligned rollup (see engine/rollup.py), mirroring server/crypto.ts.

export const SCREENER_TIMEFRAMES = ['15m', '1hr', '4hr', '1day', '1week'] as const
export type ScreenerTimeframe = (typeof SCREENER_TIMEFRAMES)[number]

/** Base feed each timeframe is built from, and how many base bars make one bar. */
export const TIMEFRAME_SOURCE: Record<ScreenerTimeframe, { base: string; factor: number }> = {
  '15m': { base: '15m', factor: 1 },
  '1hr': { base: '1hr', factor: 1 },
  '4hr': { base: '1hr', factor: 4 },
  '1day': { base: '1day', factor: 1 },
  '1week': { base: '1day', factor: 7 },
}

/** The base feeds a job must carry to satisfy every timeframe above. */
export const BASE_TIMEFRAMES = ['15m', '1hr', '1day'] as const

// ── Patterns ──────────────────────────────────────────────────────────────────
// Single source of truth for the candle names a screener may whitelist. The Python
// detector registry is asserted equal to this list by the parity test, so a pattern
// cannot exist on one side of the wire only.

export const KNOWN_PATTERNS = [
  'doji', 'dragonfly_doji', 'gravestone_doji', 'long_legged_doji',
  'hammer', 'hanging_man', 'inverted_hammer', 'shooting_star',
  'bullish_engulfing', 'bearish_engulfing',
  'bullish_harami', 'bullish_harami_cross', 'bearish_harami', 'bearish_harami_cross',
  'piercing_line', 'dark_cloud_cover',
  'morning_star', 'evening_star',
  'three_white_soldiers', 'three_black_crows',
] as const
export type PatternName = (typeof KNOWN_PATTERNS)[number]

// ── Gates ─────────────────────────────────────────────────────────────────────

// Groups are contiguous (MARKET → TECHNICAL → PATTERN) so the rail renders as three
// clean sections, and the funnel eliminates cheapest-first: a market-cap compare costs
// nothing, pattern detection walks every candle. Symbols killed early are never scanned.
export const GATE_ORDER = [
  'marketCap', 'volume24h', 'change24h',
  'rsi', 'ema50', 'ema200', 'macd', 'bbWidth',
  'pattern', 'freshness', 'relVolume',
] as const
export type ScreenerGateId = (typeof GATE_ORDER)[number]

export type GateGroup = 'MARKET' | 'TECHNICAL' | 'PATTERN'
export type GateKind = 'range' | 'trend' | 'cross' | 'pattern'
export type TrendValue = 'ANY' | 'ABOVE' | 'BELOW'
export type CrossValue = 'ANY' | 'BULLISH' | 'BEARISH'

export interface GateMeta {
  /** Compact display glyph for the results table's gate strip. Unique per gate. */
  letter: string
  label: string
  group: GateGroup
  kind: GateKind
  unit: string
  /** Hard bounds for a range gate's inputs — validation rejects outside these. */
  floor?: number
  ceiling?: number
  /** True when the gate needs data the app may not have (market cap needs CMC).
   *  A missing value degrades the gate to ANY instead of failing every symbol. */
  optionalData?: boolean
}

export const GATE_META: Record<ScreenerGateId, GateMeta> = {
  marketCap: { letter: 'C', label: 'MKT CAP', group: 'MARKET', kind: 'range', unit: '$', floor: 0, optionalData: true },
  // Volume is CMC's cross-exchange aggregate, not Gemini's own book — Gemini is one
  // (thin) venue, and a coin can be liquid market-wide while barely printing here.
  // Like market cap, it needs CMC and degrades to ANY when the read is missing.
  volume24h: { letter: 'V', label: 'VOL 24H', group: 'MARKET', kind: 'range', unit: '$', floor: 0, optionalData: true },
  change24h: { letter: 'D', label: 'Δ 24H', group: 'MARKET', kind: 'range', unit: '%', floor: -100, ceiling: 100_000 },
  pattern: { letter: 'P', label: 'CANDLE', group: 'PATTERN', kind: 'pattern', unit: '' },
  rsi: { letter: 'R', label: 'RSI', group: 'TECHNICAL', kind: 'range', unit: '', floor: 0, ceiling: 100 },
  ema50: { letter: 'M', label: 'EMA 50', group: 'TECHNICAL', kind: 'trend', unit: '' },
  ema200: { letter: 'N', label: 'EMA 200', group: 'TECHNICAL', kind: 'trend', unit: '' },
  macd: { letter: 'X', label: 'MACD ✕', group: 'TECHNICAL', kind: 'cross', unit: '' },
  bbWidth: { letter: 'B', label: 'BB WIDTH', group: 'TECHNICAL', kind: 'range', unit: '%', floor: 0 },
  freshness: { letter: 'F', label: 'FRESHNESS', group: 'PATTERN', kind: 'range', unit: 'bars', floor: 0 },
  relVolume: { letter: 'U', label: 'REL VOLUME', group: 'PATTERN', kind: 'range', unit: '×', floor: 0 },
}

export interface RangeGate { enabled: boolean; min: number | null; max: number | null }
export interface TrendGate { enabled: boolean; trend: TrendValue }
export interface CrossGate { enabled: boolean; cross: CrossValue }
export interface PatternGate { enabled: boolean; names: string[] }

export interface ScreenerGates {
  marketCap: RangeGate
  volume24h: RangeGate
  change24h: RangeGate
  pattern: PatternGate
  rsi: RangeGate
  ema50: TrendGate
  ema200: TrendGate
  macd: CrossGate
  bbWidth: RangeGate
  freshness: RangeGate
  relVolume: RangeGate
}

/** Where a screener's gates came from. Purely informational — an imported strategy
 *  gate-set is a SNAPSHOT, so editing the screener never reaches back to the skill. */
export type ScreenerOrigin =
  | { kind: 'blank' }
  | { kind: 'copy'; from: string }
  | { kind: 'strategy'; from: string }

export interface ScreenerDef {
  schemaVersion: number
  id: string
  name: string
  timeframe: ScreenerTimeframe
  /** 'ALL' scans every USD pair; 'HELD' restricts to symbols currently held. */
  universe: 'ALL' | 'HELD'
  gates: ScreenerGates
  origin: ScreenerOrigin
  createdAt: number
  updatedAt: number
}

export function blankGates(): ScreenerGates {
  return {
    marketCap: { enabled: false, min: null, max: null },
    volume24h: { enabled: false, min: null, max: null },
    change24h: { enabled: false, min: null, max: null },
    pattern: { enabled: false, names: [] },
    rsi: { enabled: false, min: null, max: null },
    ema50: { enabled: false, trend: 'ANY' },
    ema200: { enabled: false, trend: 'ANY' },
    macd: { enabled: false, cross: 'ANY' },
    bbWidth: { enabled: false, min: null, max: null },
    freshness: { enabled: false, min: null, max: null },
    relVolume: { enabled: false, min: null, max: null },
  }
}

// ── Normalization ─────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function normalizeGates(input: unknown): ScreenerGates {
  const src = (input ?? {}) as Record<string, Record<string, unknown> | undefined>
  const out = blankGates()
  for (const id of GATE_ORDER) {
    const given = src[id]
    if (!given) continue
    const enabled = given['enabled'] === true
    const meta = GATE_META[id]
    if (meta.kind === 'range') {
      (out[id] as RangeGate) = { enabled, min: num(given['min']), max: num(given['max']) }
    } else if (meta.kind === 'trend') {
      (out[id] as TrendGate) = { enabled, trend: (given['trend'] as TrendValue) ?? 'ANY' }
    } else if (meta.kind === 'cross') {
      (out[id] as CrossGate) = { enabled, cross: (given['cross'] as CrossValue) ?? 'ANY' }
    } else {
      const names = Array.isArray(given['names']) ? (given['names'] as unknown[]).map(String) : []
      ;(out[id] as PatternGate) = { enabled, names }
    }
  }
  return out
}

/** Gate input as callers actually write it: any subset of gates, each with any
 *  subset of its own fields. `{ rsi: { enabled: true, max: 35 } }` is the common
 *  shape, and requiring an explicit `min: null` beside it would be noise. */
export type PartialGates = { [K in keyof ScreenerGates]?: Partial<ScreenerGates[K]> }

/** Anything that might be a screener: a stored record, an HTTP body, a partial
 *  literal. Normalizing is how untrusted shapes become a ScreenerDef. */
export type ScreenerDefInput = Record<string, unknown> | Partial<Omit<ScreenerDef, 'gates'>> & { gates?: PartialGates }

/** Fill in every field the caller omitted. Idempotent: normalize(normalize(x)) === normalize(x). */
export function normalizeScreenerDef(raw: ScreenerDefInput): ScreenerDef {
  const input = raw as Record<string, unknown>
  const now = num(input['createdAt']) ?? 0
  return {
    schemaVersion: num(input['schemaVersion']) ?? SCREENER_SCHEMA_VERSION,
    id: String(input['id'] ?? ''),
    name: String(input['name'] ?? ''),
    timeframe: (input['timeframe'] as ScreenerTimeframe) ?? '1hr',
    universe: input['universe'] === 'HELD' ? 'HELD' : 'ALL',
    gates: normalizeGates(input['gates']),
    origin: (input['origin'] as ScreenerOrigin) ?? { kind: 'blank' },
    createdAt: now,
    updatedAt: num(input['updatedAt']) ?? now,
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult { ok: boolean; errors: string[] }

function validateRange(id: ScreenerGateId, gate: RangeGate, errors: string[]): void {
  if (!gate.enabled) return
  const meta = GATE_META[id]
  if (gate.min == null && gate.max == null) {
    errors.push(`${id} is enabled but has no bound — set a min, a max, or turn it off`)
    return
  }
  if (gate.min != null && gate.max != null && gate.min > gate.max) {
    errors.push(`${id} min (${gate.min}) is above its max (${gate.max})`)
  }
  for (const [edge, v] of [['min', gate.min], ['max', gate.max]] as const) {
    if (v == null) continue
    if (meta.floor != null && v < meta.floor) errors.push(`${id} ${edge} (${v}) is below ${meta.floor}${meta.unit}`)
    if (meta.ceiling != null && v > meta.ceiling) errors.push(`${id} ${edge} (${v}) is above ${meta.ceiling}${meta.unit}`)
  }
}

export function validateScreenerDef(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['definition must be an object'] }
  const def = input as ScreenerDef

  if (typeof def.schemaVersion === 'number' && def.schemaVersion > SCREENER_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${def.schemaVersion} is newer than this build understands (${SCREENER_SCHEMA_VERSION})`)
  }
  if (!def.name || !String(def.name).trim()) errors.push('name is required')
  if (!SCREENER_TIMEFRAMES.includes(def.timeframe)) {
    errors.push(`timeframe must be one of ${SCREENER_TIMEFRAMES.join(', ')}`)
  }
  if (!def.gates || typeof def.gates !== 'object') {
    errors.push('gates are required')
    return { ok: errors.length === 0, errors }
  }

  for (const id of GATE_ORDER) {
    const gate = def.gates[id] as RangeGate & TrendGate & CrossGate & PatternGate | undefined
    if (!gate) { errors.push(`gate ${id} is missing`); continue }
    switch (GATE_META[id].kind) {
      case 'range':
        validateRange(id, gate, errors)
        break
      case 'trend':
        if (!['ANY', 'ABOVE', 'BELOW'].includes(gate.trend)) errors.push(`${id} trend must be ANY, ABOVE or BELOW`)
        break
      case 'cross':
        if (!['ANY', 'BULLISH', 'BEARISH'].includes(gate.cross)) errors.push(`${id} cross must be ANY, BULLISH or BEARISH`)
        break
      case 'pattern':
        if (gate.enabled && (!Array.isArray(gate.names) || gate.names.length === 0)) {
          errors.push('pattern is enabled but its whitelist is empty')
        } else if (Array.isArray(gate.names)) {
          for (const n of gate.names) {
            if (!(KNOWN_PATTERNS as readonly string[]).includes(n)) errors.push(`pattern "${n}" is not a known candle pattern`)
          }
        }
        break
    }
  }
  return { ok: errors.length === 0, errors }
}

// ── Creation ──────────────────────────────────────────────────────────────────

export function slugifyScreenerName(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

export interface NewScreenerInput {
  name: string
  timeframe?: ScreenerTimeframe
  universe?: 'ALL' | 'HELD'
  /** Start from another screener — its gates are deep-copied, never shared. */
  copyFrom?: ScreenerDef
  /** Start from a strategy's gate snapshot; recorded in `origin` for provenance. */
  importStrategy?: string
  gates?: PartialGates
}

export function screenerFromInput(input: NewScreenerInput, now: number): ScreenerDef {
  const slug = slugifyScreenerName(input.name)
  const gates = input.copyFrom
    ? normalizeGates(JSON.parse(JSON.stringify(input.copyFrom.gates)))
    : normalizeGates(input.gates)

  const origin: ScreenerOrigin = input.importStrategy
    ? { kind: 'strategy', from: input.importStrategy }
    : input.copyFrom
      ? { kind: 'copy', from: input.copyFrom.id }
      : { kind: 'blank' }

  return normalizeScreenerDef({
    id: slug || `screener-${now.toString(36)}`,
    name: String(input.name).trim(),
    timeframe: input.timeframe ?? input.copyFrom?.timeframe ?? '1hr',
    universe: input.universe ?? input.copyFrom?.universe ?? 'ALL',
    gates,
    origin,
    createdAt: now,
    updatedAt: now,
  })
}

/** Order-insensitive deep equality — drives the "unsaved edits" dot on the chip. */
export function gatesEqual(a: ScreenerGates, b: ScreenerGates): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

// ── Engine wire format ────────────────────────────────────────────────────────

/** Gemini candle tuple: [timestampMs, open, high, low, close, volume]. */
export type ScreenerCandle = [number, number, number, number, number, number]

export interface ScreenerJobSymbol {
  symbol: string
  last: number
  change24h: number | null
  volume24h: number | null
  marketCap: number | null
  held: boolean
  /** Keyed by BASE_TIMEFRAMES; the engine rolls these up as needed. Oldest-first. */
  candles: Record<string, ScreenerCandle[]>
}

export interface ScreenerJob {
  schemaVersion: number
  screener: ScreenerDef
  symbols: ScreenerJobSymbol[]
  now: number
}

export interface GateVerdict {
  gate: ScreenerGateId
  pass: boolean
  /** The gate was enabled but its input was unavailable, so it was skipped as ANY. */
  degraded: boolean
  /** Observed value, for display. Null when unavailable. */
  value: number | null
  /** Observed label where a number is meaningless (pattern name, trend side). */
  text: string | null
  /** Plain-language cause, populated only when `pass` is false. */
  reason: string
}

export interface ScreenerCandidate {
  symbol: string
  last: number
  change24h: number | null
  volume24h: number | null
  marketCap: number | null
  held: boolean
  /** 0–100. Share of enabled gates passed, tie-broken by depth inside each range. */
  fit: number
  passes: boolean
  gates: GateVerdict[]
  /** First failing gate in GATE_ORDER, or null when the symbol passes. */
  blockedBy: ScreenerGateId | null
  blockedReason: string | null
  rsi: number | null
  pattern: string | null
  patternAgeBars: number | null
}

export interface FunnelStep {
  gate: ScreenerGateId | 'universe' | 'seeded'
  label: string
  survivors: number
  killed: number
}

export interface ScreenerResult {
  schemaVersion: number
  screenerId: string
  timeframe: ScreenerTimeframe
  scannedAt: number
  universe: number
  passing: number
  candidates: ScreenerCandidate[]
  funnel: FunnelStep[]
  /** Gates that ran degraded for at least one symbol (e.g. market cap with no CMC key). */
  degradedGates: ScreenerGateId[]
  errors: string[]
}

export interface ScreenerEngineError {
  schemaVersion: number
  error: string
  detail?: string
}

export function isScreenerEngineError(v: unknown): v is ScreenerEngineError {
  return !!v && typeof v === 'object' && typeof (v as ScreenerEngineError).error === 'string'
}
