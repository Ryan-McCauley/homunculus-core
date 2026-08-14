// Display logic for the SCREENERS tab.
//
// Everything here is a pure function of engine output plus a screener definition,
// kept out of the component so it can be tested directly — the same split
// cryptoUi.ts uses. The component below it only arranges what these return.
//
// The formatting rules are not cosmetic. A screener's whole job is to answer "why
// is this coin here, or why isn't it", so a blocked row states its cause as a
// sentence rather than a code, and the gate strip shows only the gates the user
// actually switched on. A row of ticks for gates nobody enabled reads as evidence
// and is really just decoration.

import {
  GATE_META, GATE_ORDER,
  type CrossGate, type GateGroup, type PatternGate, type RangeGate,
  type ScreenerCandidate, type ScreenerDef, type ScreenerGateId,
  type ScreenerTimeframe, type TrendGate,
} from '../../shared/screener'

export type GateState = 'pass' | 'fail' | 'degraded'

export interface GateCell {
  gate: ScreenerGateId
  letter: string
  state: GateState
  title: string
}

const gateOf = (def: ScreenerDef, id: ScreenerGateId) => def.gates?.[id]

/** The compact per-gate pass/fail strip, limited to gates this screener enabled. */
export function gateStrip(candidate: ScreenerCandidate, def: ScreenerDef): GateCell[] {
  const byGate = new Map(candidate.gates.map((v) => [v.gate, v]))
  return GATE_ORDER.filter((id) => gateOf(def, id)?.enabled).flatMap((id) => {
    const verdict = byGate.get(id)
    if (!verdict) return []
    const meta = GATE_META[id]
    const state: GateState = verdict.degraded ? 'degraded' : verdict.pass ? 'pass' : 'fail'
    const observed = formatGateValue(id, verdict.value)
    const title = state === 'fail' && verdict.reason
      ? `${meta.label} — ${verdict.reason}`
      : state === 'degraded'
        ? `${meta.label} — no data, gate skipped`
        : `${meta.label} — ${observed}`
    return [{ gate: id, letter: meta.letter, state, title }]
  })
}

/** The blocked cell's text: the cause, in words, or nothing when the symbol passed. */
export function blockedText(candidate: ScreenerCandidate): string {
  if (candidate.passes || !candidate.blockedBy) return ''
  const reason = candidate.blockedReason?.trim()
  return `BLOCKED · ${reason || `${GATE_META[candidate.blockedBy].label} gate`}`
}

export function fitBarWidth(fit: number): string {
  if (!Number.isFinite(fit)) return '0%'
  return `${Math.max(0, Math.min(100, Math.round(fit)))}%`
}

/** Whether the rail has unsaved edits — drives the amber dot on the active chip.
 *
 *  `updatedAt` is excluded deliberately: it moves on every save, so including it
 *  would make a freshly saved screener look dirty the moment it came back. */
export function isDirty(saved: ScreenerDef | undefined, draft: ScreenerDef): boolean {
  if (!saved) return false
  const strip = (d: ScreenerDef) => canonical({
    name: d.name, timeframe: d.timeframe, universe: d.universe, gates: d.gates,
  })
  return strip(saved) !== strip(draft)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

export interface RailGroup { group: GateGroup; gates: ScreenerGateId[] }

/** The rail's three sections, in gate order. GATE_ORDER keeps groups contiguous,
 *  so this is a partition rather than a re-sort. */
export function railGroups(): RailGroup[] {
  const out: RailGroup[] = []
  for (const id of GATE_ORDER) {
    const group = GATE_META[id].group
    const current = out[out.length - 1]
    if (current && current.group === group) current.gates.push(id)
    else out.push({ group, gates: [id] })
  }
  return out
}

type AnyGate = Partial<RangeGate & TrendGate & CrossGate & PatternGate>

/** What the rail shows next to a gate name: its bound, or ANY when it is off. */
export function boundLabel(id: ScreenerGateId, gate: AnyGate): string {
  const kind = GATE_META[id].kind
  if (kind === 'cross') return gate.enabled ? (gate.cross ?? 'ANY') : 'OFF'
  if (!gate.enabled) return 'ANY'
  if (kind === 'trend') return gate.trend ?? 'ANY'
  if (kind === 'pattern') {
    const n = gate.names?.length ?? 0
    return n ? `${n} SELECTED` : 'ANY'
  }
  const { min = null, max = null } = gate
  if (min == null && max == null) return 'ANY'
  if (min != null && max != null) return `${bound(id, min)} … ${bound(id, max)}`
  if (min != null) return `> ${bound(id, min)}`
  return `≤ ${bound(id, max as number)}`
}

/** A bound rendered in the gate's own units — money abbreviated, percents signed. */
function bound(id: ScreenerGateId, v: number): string {
  const unit = GATE_META[id].unit
  if (unit === '$') return money(v)
  if (unit === '%') return `${v}%`
  if (unit === '×') return `${v}×`
  return String(v)
}

function money(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `$${trim(v / 1e9)}B`
  if (abs >= 1e6) return `$${trim(v / 1e6)}M`
  if (abs >= 1e3) return `$${trim(v / 1e3)}K`
  return `$${trim(v)}`
}

/** Drop a trailing ".0" so "$1.0M" reads as "$1M". */
const trim = (v: number): string => String(Number(v.toFixed(1)))

/** An observed value, formatted for the gate it belongs to. */
export function formatGateValue(id: ScreenerGateId, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  switch (id) {
    case 'marketCap':
    case 'volume24h':
      return money(value)
    case 'change24h':
      return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
    case 'bbWidth':
      return `${value.toFixed(1)}%`
    case 'rsi':
      return value.toFixed(1)
    case 'relVolume':
      return `${value.toFixed(1)}×`
    case 'freshness': {
      const bars = Math.round(value)
      if (bars === 0) return 'now'
      return `${bars} bar${bars === 1 ? '' : 's'}`
    }
    default:
      return String(Number(value.toFixed(2)))
  }
}

export function patternLabel(name: string | null): string {
  return name ? name.replace(/_/g, ' ') : '—'
}

const TIMEFRAME_LABELS: Record<ScreenerTimeframe, string> = {
  '15m': '15M', '1hr': '1H', '4hr': '4H', '1day': '1D', '1week': '1W',
}

export function timeframeLabel(tf: ScreenerTimeframe): string {
  return TIMEFRAME_LABELS[tf] ?? String(tf).toUpperCase()
}

/** Warning line for gates that ran without their data. Silence here would let a
 *  screener claim it filtered on market cap when no cap was ever available. */
export function degradedNote(gates: ScreenerGateId[]): string {
  if (!gates.length) return ''
  const names = gates.map((g) => GATE_META[g].label).join(' · ')
  return `${names} ran with no data and was skipped for some symbols`
}
