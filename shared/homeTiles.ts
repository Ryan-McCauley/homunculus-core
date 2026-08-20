// ── Home tile bindings ─────────────────────────────────────────────────
// The HOME tab's device tiles used to name entity ids as literals:
// `climate.thermostat`, `vacuum.r2peepoo_litter_box`, a `CATS` array of five
// names. That works exactly once, on one house. This module is what replaces
// them — the tiles now render against SLOTS, and a slot is bound to whatever
// entity a given install actually has.
//
// Three pieces, in dependency order:
//
//   TileSpec   — what a tile type needs, as data. A thermostat tile has a
//                required `climate` slot and four optional ones; the tile
//                component asks for `climate` and gets back an entity id.
//   discovery  — given a house's entity list, produce a starting configuration.
//                Anchors first (every `climate.*` is a thermostat), then the
//                remaining slots are filled from the anchor's own device.
//   config     — the persisted result, sanitized. What discovery guessed is
//                only a default: every binding is overwritable from the UI, and
//                a hand-bound slot is never re-guessed.
//
// DISCOVERY IS A GUESS AND IS TREATED AS ONE. The scoring below recognises the
// naming conventions common integrations use, which covers most houses and no
// house completely. That is why nothing here runs at render time — discovery
// produces a config once, the user corrects it, and the correction is what
// persists. A wrong guess is a wrong dropdown value, not a broken tile.

import type { HaEntity } from './homeassistant'

// ── Spec model ──────────────────────────────────────────────────────────

/** One entity a tile needs. Domains hard-filter; classes and keywords rank. */
export interface TileSlot {
  key: string
  label: string
  /** Candidate entities must be in one of these domains. Never empty. */
  domains: string[]
  /** Ranked higher when the entity's device_class is one of these. */
  deviceClasses?: string[]
  /** Ranked higher when the entity id or friendly name contains one of these. */
  keywords?: string[]
  /** The tile renders nothing at all without this one. */
  required?: boolean
  /**
   * Discovery may only fill this slot from the anchor's own device.
   *
   * Set on anything that is PART OF the device — a washer's door, a litter box's
   * waste drawer. Without it, a house whose washer has no child lock happily
   * borrows the dryer's, because "child lock" matched and nothing said it had to
   * be the same appliance. Left off for slots that legitimately live elsewhere
   * (the sun entity on a weather tile).
   */
  sameDevice?: boolean
  hint?: string
}

export type TileOptionValue = number | string | boolean

export interface TileOption {
  key: string
  label: string
  kind: 'number' | 'text' | 'boolean' | 'select'
  default: TileOptionValue
  min?: number
  max?: number
  /** For kind 'select'. */
  choices?: string[]
  hint?: string
}

/** A repeatable group of slots — one row per pet, per plant, per whatever. */
export interface TileRowSpec {
  /** Noun for one row, used in the editor's "add" button. */
  noun: string
  slots: TileSlot[]
}

export interface TileSpec {
  type: string
  label: string
  icon: string
  /** Key of the slot that identifies the device. Discovery starts here. */
  anchor: string
  /** The tile renders only when at least one of these slots is bound. Empty
   *  means the tile decides for itself (the repeatable ones gate on rows). */
  renderRequires: string[]
  slots: TileSlot[]
  options: TileOption[]
  rows?: TileRowSpec
  /** Fallback header text before the user names the tile. */
  defaultTitle: string
}

// ── Config model ────────────────────────────────────────────────────────

export interface HomeTileRow {
  label: string
  bindings: Record<string, string>
}

export interface HomeTileConfig {
  /** Stable instance id — tiles are addressable, so a widget can name one. */
  id: string
  type: string
  /** Header text. Discovery seeds it from the device's friendly name. */
  title: string
  enabled: boolean
  bindings: Record<string, string>
  options: Record<string, TileOptionValue>
  rows?: HomeTileRow[]
}

export interface HomeTilesConfig {
  version: number
  /** Array order is render order on the OVERVIEW. */
  tiles: HomeTileConfig[]
  /** False until discovery has run against a connected house, so a config
   *  written while HA was offline isn't mistaken for "this house has nothing". */
  discovered: boolean
}

export const HOME_TILES_VERSION = 1

export const emptyHomeTiles = (): HomeTilesConfig =>
  ({ version: HOME_TILES_VERSION, tiles: [], discovered: false })

// ── Entity id helpers ───────────────────────────────────────────────────

/** `sensor.washer_current_status` → `washer_current_status`. */
export function objectId(entityId: string): string {
  const dot = entityId.indexOf('.')
  return dot === -1 ? entityId : entityId.slice(dot + 1)
}

/** Underscore tokens of an object id, lowercased. */
export const tokensOf = (entityId: string): string[] =>
  objectId(entityId).toLowerCase().split('_').filter(Boolean)

/**
 * The device stem an entity belongs to — its object id minus any trailing
 * role words.
 *
 * Integrations name entities `<device>_<role>`: `washer_current_status`,
 * `r2peepoo_waste_drawer`, `thermostat_humidity`. Stripping known role words off
 * the end recovers the device: all three of those collapse to `washer`,
 * `r2peepoo`, `thermostat`, which is what lets discovery gather one tile's slots
 * from one physical device.
 *
 * A device whose own name happens to end in a role word (a sensor literally
 * called `temperature`) collapses to its first token rather than to nothing —
 * an over-broad stem groups too much, an empty one groups nothing.
 */
export function stemOf(entityId: string): string {
  const tokens = tokensOf(entityId)
  let end = tokens.length
  while (end > 1 && ROLE_WORDS.has(tokens[end - 1])) end--
  return tokens.slice(0, end).join('_')
}

/** Trailing words that describe an entity's ROLE on a device, not the device. */
const ROLE_WORDS = new Set([
  'state', 'status', 'code', 'mode', 'level', 'temp', 'temperature', 'humidity',
  'power', 'energy', 'current', 'voltage', 'battery', 'signal',
  'time', 'remaining', 'total', 'elapsed', 'duration', 'today', 'weekly', 'monthly',
  'door', 'lock', 'light', 'switch', 'button', 'sensor', 'reset', 'start', 'stop',
  'drawer', 'waste', 'litter', 'hopper', 'weight', 'visits', 'cycles', 'count',
  'speed', 'spin', 'soil', 'dry', 'wash', 'operation', 'notification', 'prevent',
  'wrinkle', 'child', 'globe', 'pet', 'job', 'program', 'progress', 'percent',
  'next', 'last', 'rising', 'setting', 'manager', 'heat', 'emergency',
  'box', 'bin', 'tray',
])

// ── Candidate scoring ───────────────────────────────────────────────────

const haystack = (e: HaEntity): string => `${e.entityId} ${e.name}`.toLowerCase()

/** Spread of the detail score, and the gap between device tiers. Tiering rather
 *  than adding keeps the rule absolute: no amount of good naming promotes an
 *  entity over one that is on the right device. */
const TIER = 100

/**
 * How well an entity fits a slot, or null when it cannot fit at all.
 *
 * Domain is the only hard gate. Beyond it the score has two parts, and the
 * ordering between them is the whole design: WHICH DEVICE the entity belongs to
 * dominates, and device_class/keywords only break ties within a device. The
 * right sensor on the right appliance beats a better-named sensor on the wrong
 * one — otherwise a house with two washers, or a neighbouring `greenhouse
 * humidity`, quietly wires the tile to someone else's hardware.
 */
export interface CandidateMatch {
  /** 2 = the anchor's own device, 1 = a related one, 0 = unrelated. */
  tier: number
  /** Ranking within a tier: device_class and keyword hits, minus penalties. */
  detail: number
  /** True when device_class or a keyword actually matched — the difference
   *  between "this IS the door sensor" and "this is merely on the right device". */
  discriminated: boolean
  score: number
}

export function evaluateCandidate(
  slot: TileSlot, entity: HaEntity, stem?: string,
): CandidateMatch | null {
  if (!slot.domains.includes(entity.domain)) return null

  let tier = 0
  if (stem) {
    const entityStem = stemOf(entity.entityId)
    if (entityStem === stem) tier = 2
    else if (entityStem.startsWith(stem + '_') || stem.startsWith(entityStem + '_')) tier = 1
  }

  let detail = 0
  let discriminated = false
  if (slot.deviceClasses?.length) {
    if (entity.deviceClass && slot.deviceClasses.includes(entity.deviceClass)) {
      detail += 5
      discriminated = true
    } else {
      detail -= 1 // a class was expected and this isn't it — usable, not preferred
    }
  }
  const hay = haystack(entity)
  for (const kw of slot.keywords ?? []) {
    if (objectId(entity.entityId).toLowerCase().includes(kw)) { detail += 3; discriminated = true }
    else if (hay.includes(kw)) { detail += 2; discriminated = true }
  }
  // Unavailable entities are real but useless; rank them last within their tier
  // rather than hiding them — an integration that is merely reloading still owns
  // the slot, and dropping it would silently rebind the tile to something else.
  if (entity.state === 'unavailable' || entity.state === 'unknown') detail -= 2

  // Clamped so a slot with many keywords can never accumulate its way into the
  // tier above, which is the one invariant this function has.
  const clamped = Math.max(-(TIER / 2 - 1), Math.min(TIER / 2 - 1, detail))
  return { tier, detail, discriminated, score: tier * TIER + clamped }
}

export function scoreCandidate(slot: TileSlot, entity: HaEntity, stem?: string): number | null {
  return evaluateCandidate(slot, entity, stem)?.score ?? null
}

/** Every entity that could fill a slot, best first. Powers the editor dropdown. */
export function candidatesFor(slot: TileSlot, entities: HaEntity[], stem?: string): HaEntity[] {
  const scored: Array<{ e: HaEntity; s: number }> = []
  for (const e of entities) {
    const s = scoreCandidate(slot, e, stem)
    if (s !== null) scored.push({ e, s })
  }
  scored.sort((a, b) => b.s - a.s || a.e.entityId.localeCompare(b.e.entityId))
  return scored.map((x) => x.e)
}

/**
 * Fill every non-anchor slot of a tile from the entities around its anchor.
 *
 * A slot is left unbound rather than filled with a poor match. A tile that omits
 * a humidity readout the house doesn't have is honest; one showing the garage
 * door's battery under "RH" is worse than the blank it replaced. So being on the
 * right device is NOT on its own enough to win a slot — an entity must also look
 * like the thing the slot is asking for:
 *
 *   discriminated   device_class or a keyword matched. Required whenever the
 *                   slot describes what it wants, which is nearly always.
 *   sameDevice      slots that are part of the device reject anything from
 *                   another one outright, at any score.
 *
 * Both conditions exist because of the same class of bug: a two-appliance house
 * where the washer has no child lock will otherwise bind the dryer's, and a
 * thermostat with only a humidity sensor will otherwise show humidity as its
 * temperature. An empty slot is the correct answer to "you don't have one".
 */
export function autoBindTile(
  spec: TileSpec,
  entities: HaEntity[],
  anchorId: string,
): Record<string, string> {
  const stem = stemOf(anchorId)
  const bindings: Record<string, string> = { [spec.anchor]: anchorId }
  const taken = new Set([anchorId])

  for (const slot of spec.slots) {
    if (slot.key === spec.anchor) continue
    const describes = Boolean(slot.deviceClasses?.length || slot.keywords?.length)

    let best: { id: string; score: number } | null = null
    for (const e of entities) {
      if (taken.has(e.entityId)) continue
      const m = evaluateCandidate(slot, e, stem)
      if (!m) continue
      if (slot.sameDevice && m.tier === 0) continue
      if (describes ? !m.discriminated : m.tier < 2) continue
      if (!best || m.score > best.score) best = { id: e.entityId, score: m.score }
    }
    if (best) {
      bindings[slot.key] = best.id
      taken.add(best.id)
    }
  }
  return bindings
}

// ── Reading a bound tile ────────────────────────────────────────────────

/** Entity id bound to a slot, or null. Tiles call this instead of naming ids. */
export const boundId = (tile: HomeTileConfig, slot: string): string | null =>
  tile.bindings[slot] || null

/** An option's value, falling back to the spec default. */
export function optionOf(tile: HomeTileConfig, spec: TileSpec, key: string): TileOptionValue {
  const def = spec.options.find((o) => o.key === key)
  const raw = tile.options[key]
  if (def && typeof raw === typeof def.default) return raw
  return def ? def.default : (raw ?? '')
}

/** Numeric option, coerced. Tiles use this for thresholds. */
export function numberOption(tile: HomeTileConfig, spec: TileSpec, key: string): number {
  const v = optionOf(tile, spec, key)
  return typeof v === 'number' ? v : Number(v) || 0
}
