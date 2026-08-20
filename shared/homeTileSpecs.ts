// ── Home tile catalogue + discovery ────────────────────────────────────
// The tile types the HOME tab can render, each described as slots and options
// rather than as entity ids, plus the pass that turns a house's entity list into
// a starting configuration.
//
// This file is where "which devices does this person have?" is answered. It is
// deliberately the ONLY place that reasons about naming conventions — the tile
// components downstream see nothing but bound slots, so a house whose litter box
// is called something other than R2PEEPOO renders the same tile with the same
// code path, which is the entire point of the exercise.
//
// WHAT DISCOVERY PROMISES. That every device it is confident about gets a tile,
// and that a device it is unsure about gets no tile rather than a wrong one. It
// does not promise completeness: the SECTORS and REGISTRY views already show
// every entity unconditionally, so a device discovery misses is still reachable,
// still commandable, and one dropdown away from a tile of its own.

import type { HaEntity } from './homeassistant'
import {
  autoBindTile, objectId, stemOf, tokensOf,
  type HomeTileConfig, type HomeTilesConfig, type TileOptionValue, type TileSpec,
  HOME_TILES_VERSION,
} from './homeTiles'

// ── Specs ───────────────────────────────────────────────────────────────

const spec = (s: TileSpec): TileSpec => s

export const TILE_SPECS: TileSpec[] = [
  spec({
    type: 'thermostat',
    label: 'Thermostat',
    icon: 'ti-temperature',
    defaultTitle: 'Thermostat',
    anchor: 'climate',
    renderRequires: ['climate'],
    slots: [
      { key: 'climate', label: 'Thermostat', domains: ['climate'], required: true,
        hint: 'The climate entity this tile controls.' },
      { key: 'temperature', label: 'Temperature sensor', domains: ['sensor'], sameDevice: true,
        deviceClasses: ['temperature'], keywords: ['temperature', 'temp'],
        hint: 'Optional. Falls back to the climate entity’s own current_temperature.' },
      { key: 'humidity', label: 'Humidity sensor', domains: ['sensor'], sameDevice: true,
        deviceClasses: ['humidity'], keywords: ['humidity'] },
      { key: 'emergencyHeat', label: 'Emergency / aux heat', domains: ['switch'], sameDevice: true,
        keywords: ['emergency', 'aux', 'eheat', 'emergency_heat'] },
    ],
    options: [
      { key: 'step', label: 'Adjust step', kind: 'number', default: 1, min: 0.5, max: 5,
        hint: 'Degrees the +/- buttons move the target by.' },
    ],
  }),

  spec({
    type: 'ambient',
    label: 'Ambient',
    icon: 'ti-sun',
    defaultTitle: 'Ambient',
    anchor: 'weather',
    renderRequires: ['weather', 'sun'],
    slots: [
      { key: 'weather', label: 'Weather', domains: ['weather'], required: true },
      { key: 'sun', label: 'Sun', domains: ['sun'], keywords: ['sun'] },
      { key: 'nextRising', label: 'Next sunrise', domains: ['sensor'],
        deviceClasses: ['timestamp'], keywords: ['rising', 'sunrise'] },
      { key: 'nextSetting', label: 'Next sunset', domains: ['sensor'],
        deviceClasses: ['timestamp'], keywords: ['setting', 'sunset'] },
      { key: 'backup', label: 'Backup state', domains: ['sensor'], keywords: ['backup'],
        hint: 'Optional footer line — any status sensor you want visible here.' },
    ],
    options: [],
  }),

  spec({
    type: 'appliance',
    label: 'Appliance (washer / dryer)',
    icon: 'ti-wash-machine',
    defaultTitle: 'Appliance',
    anchor: 'status',
    renderRequires: ['status'],
    slots: [
      { key: 'status', label: 'Status sensor', domains: ['sensor'], required: true,
        keywords: ['current_status', 'status', 'job_state', 'program', 'state'],
        hint: 'The sensor carrying the run state (washing, drying, end, …).' },
      { key: 'power', label: 'Power switch', domains: ['switch'], sameDevice: true, keywords: ['power'] },
      { key: 'operation', label: 'Start/stop control', domains: ['select'], sameDevice: true, keywords: ['operation'] },
      { key: 'remainingTime', label: 'Finish time', domains: ['sensor'], sameDevice: true,
        deviceClasses: ['timestamp', 'duration'], keywords: ['remaining', 'finish', 'end_time'] },
      { key: 'totalTime', label: 'Total cycle time', domains: ['sensor'], sameDevice: true,
        deviceClasses: ['duration'], keywords: ['total_time', 'total'] },
      { key: 'door', label: 'Door sensor', domains: ['binary_sensor'], sameDevice: true,
        deviceClasses: ['door', 'opening'], keywords: ['door'] },
      { key: 'childLock', label: 'Child lock', domains: ['switch'], sameDevice: true, keywords: ['child', 'lock'] },
      { key: 'wrinklePrevent', label: 'Wrinkle prevent', domains: ['switch'], sameDevice: true, keywords: ['wrinkle'] },
      { key: 'notification', label: 'Done notification', domains: ['event', 'sensor'], sameDevice: true,
        keywords: ['notification'] },
      { key: 'cycles', label: 'Cycle counter', domains: ['sensor'], sameDevice: true, keywords: ['cycles', 'count'] },
      { key: 'temperature', label: 'Wash / dry temperature', domains: ['sensor', 'select'], sameDevice: true,
        keywords: ['temperature', 'temp'] },
      { key: 'spinSpeed', label: 'Spin speed', domains: ['sensor', 'select'], sameDevice: true, keywords: ['spin'] },
      { key: 'soilLevel', label: 'Soil level', domains: ['select'], sameDevice: true, keywords: ['soil'] },
      { key: 'dryLevel', label: 'Dry level', domains: ['select'], sameDevice: true, keywords: ['dry_level', 'dry'] },
    ],
    options: [
      { key: 'visual', label: 'Drum animation', kind: 'select', default: 'washer',
        choices: ['washer', 'dryer'],
        hint: 'Washer bubbles during the wash phase; dryer shows heat shimmer.' },
      { key: 'phases', label: 'Cycle phases', kind: 'text', default: 'detecting,washing,rinsing,spinning',
        hint: 'Comma-separated, in order. Matched as substrings of the status sensor.' },
      { key: 'idleStates', label: 'Idle states', kind: 'text',
        default: 'power_off,off,on,power_on,unknown,end,initial,detecting,pause',
        hint: 'States that do NOT count as running.' },
      { key: 'completeState', label: 'Finished state', kind: 'text', default: 'end' },
    ],
  }),

  spec({
    type: 'litter',
    label: 'Litter robot',
    icon: 'ti-robot',
    defaultTitle: 'Litter Robot',
    anchor: 'vacuum',
    renderRequires: ['vacuum'],
    slots: [
      { key: 'vacuum', label: 'Litter robot', domains: ['vacuum'], required: true,
        keywords: ['litter', 'box'] },
      { key: 'litterLevel', label: 'Litter level %', domains: ['sensor'], sameDevice: true,
        keywords: ['litter_level', 'litter', 'sand'] },
      { key: 'wasteDrawer', label: 'Waste drawer %', domains: ['sensor'], sameDevice: true,
        keywords: ['waste', 'drawer'] },
      { key: 'statusCode', label: 'Status code', domains: ['sensor'], sameDevice: true, keywords: ['status', 'code'] },
      { key: 'petWeight', label: 'Pet weight', domains: ['sensor'], sameDevice: true,
        deviceClasses: ['weight'], keywords: ['pet_weight', 'weight'] },
      { key: 'hopper', label: 'Hopper status', domains: ['sensor'], sameDevice: true, keywords: ['hopper'] },
      { key: 'globeLight', label: 'Night light', domains: ['select'], sameDevice: true,
        keywords: ['globe', 'light', 'night'] },
      { key: 'reset', label: 'Reset button', domains: ['button'], sameDevice: true, keywords: ['reset'] },
    ],
    options: [
      { key: 'wasteFull', label: 'Waste drawer critical %', kind: 'number', default: 80, min: 1, max: 100 },
      { key: 'wasteWarn', label: 'Waste drawer warning %', kind: 'number', default: 50, min: 1, max: 100 },
      { key: 'litterCritical', label: 'Litter critical %', kind: 'number', default: 20, min: 1, max: 100 },
      { key: 'litterLow', label: 'Litter low %', kind: 'number', default: 40, min: 1, max: 100 },
      { key: 'weightUnit', label: 'Weight unit', kind: 'select', default: 'lb', choices: ['lb', 'kg'] },
      { key: 'occupiedCodes', label: 'Occupied status codes', kind: 'text', default: 'cst,csi,cd,pd',
        hint: 'Status-sensor values meaning a pet is inside. Litter-Robot defaults shown.' },
      { key: 'cleaningCodes', label: 'Cleaning status codes', kind: 'text', default: 'ccp,ec' },
    ],
  }),

  spec({
    type: 'pets',
    label: 'Pets',
    icon: 'ti-cat',
    defaultTitle: 'Colony',
    anchor: 'visits',
    renderRequires: [],
    slots: [],
    rows: {
      noun: 'pet',
      slots: [
        { key: 'visits', label: 'Visits today', domains: ['sensor'], required: true,
          keywords: ['visits'] },
        { key: 'weight', label: 'Weight', domains: ['sensor'], sameDevice: true,
          deviceClasses: ['weight'], keywords: ['weight'] },
      ],
    },
    options: [
      { key: 'weightUnit', label: 'Weight unit', kind: 'select', default: 'lb', choices: ['lb', 'kg'] },
    ],
  }),
]

export const getTileSpec = (type: string): TileSpec | undefined =>
  TILE_SPECS.find((s) => s.type === type)

// ── Titles ──────────────────────────────────────────────────────────────

/**
 * A tile title from the anchor entity's friendly name.
 *
 * 'R2PEEPOO Litter Box' → 'R2PEEPOO', 'Washer Current status' → 'Washer'. The
 * user's own capitalization is preserved, which is why this strips words off the
 * friendly name rather than title-casing the entity id: HA already knows the
 * device is called R2PEEPOO and not R2peepoo.
 */
export function titleFor(anchor: HaEntity | undefined, spec: TileSpec): string {
  if (!anchor) return spec.defaultTitle
  const roleWords = new Set(tokensOf(anchor.entityId).slice(stemOf(anchor.entityId).split('_').length))
  const words = anchor.name.split(/\s+/).filter(Boolean)
  let end = words.length
  while (end > 1 && roleWords.has(words[end - 1].toLowerCase())) end--
  const trimmed = words.slice(0, end).join(' ').trim()
  return trimmed || anchor.name || spec.defaultTitle
}

// ── Discovery ───────────────────────────────────────────────────────────

const byId = (entities: HaEntity[]): Map<string, HaEntity> =>
  new Map(entities.map((e) => [e.entityId, e]))

/** Entities sharing a device stem with the given one, itself included. */
const siblingsOf = (entities: HaEntity[], anchorId: string): HaEntity[] => {
  const stem = stemOf(anchorId)
  return entities.filter((e) => stemOf(e.entityId) === stem)
}

const APPLIANCE_STATUS = /(current_status|job_state|machine_state|program|operation_state)/
const VISITS = /(^|_)visits(_|$)/
const LITTERY = /(litter|waste|drawer|hopper)/

function makeTile(
  spec: TileSpec,
  id: string,
  entities: HaEntity[],
  anchorId: string,
  extra?: Partial<HomeTileConfig>,
): HomeTileConfig {
  return {
    id,
    type: spec.type,
    title: titleFor(byId(entities).get(anchorId), spec),
    enabled: true,
    bindings: autoBindTile(spec, entities, anchorId),
    options: {},
    ...extra,
  }
}

/**
 * Build a starting tile set for a house.
 *
 * Order here is render order on the OVERVIEW, and it mirrors the arrangement the
 * hardcoded tab had: climate and ambient up top, appliances next, then the
 * device-specific tiles.
 */
export function discoverHomeTiles(entities: HaEntity[]): HomeTileConfig[] {
  const tiles: HomeTileConfig[] = []
  const seq = new Map<string, number>()
  const nextId = (type: string): string => {
    const n = (seq.get(type) ?? 0) + 1
    seq.set(type, n)
    return `${type}-${n}`
  }

  // Thermostats — exact, no heuristics needed. Every climate entity is one.
  const climateSpec = getTileSpec('thermostat')
  if (climateSpec) {
    for (const e of entities.filter((x) => x.domain === 'climate')) {
      tiles.push(makeTile(climateSpec, nextId('thermostat'), entities, e.entityId))
    }
  }

  // Ambient — one per house. Anchored on weather when there is one, otherwise
  // built around the sun entity so a house with no weather integration still
  // gets sunrise/sunset rather than nothing.
  const ambientSpec = getTileSpec('ambient')
  if (ambientSpec) {
    const weather = entities.find((e) => e.domain === 'weather')
    const sun = entities.find((e) => e.domain === 'sun')
    if (weather) {
      tiles.push(makeTile(ambientSpec, nextId('ambient'), entities, weather.entityId))
    } else if (sun) {
      const tile = makeTile(ambientSpec, nextId('ambient'), entities, sun.entityId)
      // The anchor slot only accepts `weather`; drop the bogus binding the
      // generic path just made and keep what actually fits.
      delete tile.bindings['weather']
      tile.bindings['sun'] = sun.entityId
      tile.title = ambientSpec.defaultTitle
      tiles.push(tile)
    }
  }

  // Appliances — a device is one when it exposes a run-state sensor AND some
  // way to observe or drive a cycle. The second condition is what keeps a
  // "Printer Status" sensor from becoming a washing machine.
  const applianceSpec = getTileSpec('appliance')
  if (applianceSpec) {
    const seen = new Set<string>()
    for (const e of entities) {
      if (e.domain !== 'sensor' || !APPLIANCE_STATUS.test(objectId(e.entityId))) continue
      const stem = stemOf(e.entityId)
      if (seen.has(stem)) continue
      const siblings = siblingsOf(entities, e.entityId)
      const drivable = siblings.some(
        (s) => s.domain === 'select' || s.domain === 'switch'
          || (s.domain === 'sensor' && /remaining|total_time/.test(objectId(s.entityId))),
      )
      if (!drivable) continue
      seen.add(stem)
      const tile = makeTile(applianceSpec, nextId('appliance'), entities, e.entityId)
      const dryerish = /dry/.test(stem)
      tile.options = {
        visual: dryerish ? 'dryer' : 'washer',
        ...(dryerish ? { phases: 'drying,cooling' } : {}),
      }
      tiles.push(tile)
    }
  }

  // Litter robots — a vacuum with litter-ish siblings. A plain floor vacuum has
  // none and is left to the SECTORS view, where it belongs.
  const litterSpec = getTileSpec('litter')
  if (litterSpec) {
    for (const e of entities.filter((x) => x.domain === 'vacuum')) {
      const siblings = siblingsOf(entities, e.entityId)
      const littery = siblings.some((s) => LITTERY.test(objectId(s.entityId)))
        || LITTERY.test(objectId(e.entityId))
      if (!littery) continue
      tiles.push(makeTile(litterSpec, nextId('litter'), entities, e.entityId))
    }
  }

  // Pets — one row per visits counter, named from the counter's own device.
  const petSpec = getTileSpec('pets')
  const rowSlots = petSpec?.rows?.slots ?? []
  if (petSpec && rowSlots.length) {
    const visitSensors = entities.filter(
      (e) => e.domain === 'sensor' && VISITS.test(objectId(e.entityId)),
    )
    if (visitSensors.length) {
      const rows = visitSensors.map((v) => {
        const bindings: Record<string, string> = { visits: v.entityId }
        const stem = stemOf(v.entityId)
        const weight = entities.find(
          (e) => e.domain === 'sensor' && stemOf(e.entityId) === stem
            && /weight/.test(objectId(e.entityId)),
        )
        if (weight) bindings['weight'] = weight.entityId
        return { label: prettyStem(stem), bindings }
      })
      tiles.push({
        id: nextId('pets'),
        type: 'pets',
        title: petSpec.defaultTitle,
        enabled: true,
        bindings: {},
        options: {},
        rows,
      })
    }
  }

  return tiles
}

/** `pazoozoo` → `Pazoozoo`, `back_porch` → `Back Porch`. */
export function prettyStem(stem: string): string {
  return stem.split('_').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** A complete discovered config, ready to persist. */
export function discoverHomeTilesConfig(entities: HaEntity[]): HomeTilesConfig {
  return { version: HOME_TILES_VERSION, tiles: discoverHomeTiles(entities), discovered: true }
}

// ── Sanitizing ──────────────────────────────────────────────────────────

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/

function cleanBindings(raw: unknown, allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) continue
    if (typeof v !== 'string' || !ENTITY_ID.test(v)) continue
    out[k] = v
  }
  return out
}

function cleanOptions(raw: unknown, spec: TileSpec): Record<string, TileOptionValue> {
  const out: Record<string, TileOptionValue> = {}
  if (!raw || typeof raw !== 'object') return out
  const rec = raw as Record<string, unknown>
  for (const opt of spec.options) {
    const v = rec[opt.key]
    if (v === undefined) continue
    if (opt.kind === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) continue
      out[opt.key] = Math.min(opt.max ?? n, Math.max(opt.min ?? n, n))
    } else if (opt.kind === 'boolean') {
      if (typeof v === 'boolean') out[opt.key] = v
    } else if (opt.kind === 'select') {
      if (typeof v === 'string' && (!opt.choices || opt.choices.includes(v))) out[opt.key] = v
    } else if (typeof v === 'string') {
      out[opt.key] = v.slice(0, 300)
    }
  }
  return out
}

/**
 * Normalise anything read off disk or POSTed by a client.
 *
 * Total, like sanitizeLayout: unknown tile types are dropped, bindings that
 * aren't entity ids are dropped, out-of-range thresholds are clamped. A config
 * that survives this is one every tile component can render without defending
 * itself, which is why the components below it do no validation of their own.
 */
export function sanitizeHomeTiles(raw: unknown): HomeTilesConfig {
  if (!raw || typeof raw !== 'object') return { version: HOME_TILES_VERSION, tiles: [], discovered: false }
  const r = raw as Partial<HomeTilesConfig>
  const tiles: HomeTileConfig[] = []
  const seen = new Set<string>()

  for (const t of Array.isArray(r.tiles) ? r.tiles : []) {
    if (!t || typeof t !== 'object') continue
    const spec = typeof t.type === 'string' ? getTileSpec(t.type) : undefined
    if (!spec) continue
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `${spec.type}-${tiles.length + 1}`
    if (seen.has(id)) continue
    seen.add(id)

    const slotKeys = new Set(spec.slots.map((s) => s.key))
    const rowKeys = new Set((spec.rows?.slots ?? []).map((s) => s.key))

    const tile: HomeTileConfig = {
      id,
      type: spec.type,
      title: typeof t.title === 'string' && t.title.trim() ? t.title.trim().slice(0, 60) : spec.defaultTitle,
      enabled: t.enabled !== false,
      bindings: cleanBindings(t.bindings, slotKeys),
      options: cleanOptions(t.options, spec),
    }

    if (spec.rows) {
      const rows = Array.isArray(t.rows) ? t.rows : []
      tile.rows = rows.slice(0, 50).map((row, i) => ({
        label: row && typeof row.label === 'string' && row.label.trim()
          ? row.label.trim().slice(0, 40)
          : `${spec.rows?.noun ?? 'row'} ${i + 1}`,
        bindings: cleanBindings(row?.bindings, rowKeys),
      })).filter((row) => Object.keys(row.bindings).length > 0)
    }

    tiles.push(tile)
  }

  return { version: HOME_TILES_VERSION, tiles, discovered: r.discovered === true }
}

/** True when the tile has everything it needs to draw. */
export function tileRenderable(tile: HomeTileConfig, spec: TileSpec): boolean {
  if (!tile.enabled) return false
  if (spec.renderRequires.length === 0) return (tile.rows?.length ?? 0) > 0
  return spec.renderRequires.some((k) => Boolean(tile.bindings[k]))
}

/**
 * Fold a fresh discovery pass into a configuration the user has already touched.
 *
 * Re-scanning must be safe to press. Every existing tile survives verbatim —
 * renamed, re-bound, disabled, reordered, all of it — and only devices that no
 * tile of that type already claims are appended. Buying a second washer adds a
 * tile; pressing re-scan twice does not.
 *
 * A tile the user DELETED for a device that still exists will come back. That is
 * the intended reading of "scan for new devices"; hiding it for good is what the
 * per-tile enabled flag is for, and a disabled tile still claims its anchor.
 */
export function mergeDiscovered(
  existing: HomeTileConfig[],
  discovered: HomeTileConfig[],
): HomeTileConfig[] {
  const claimed = new Set<string>()
  for (const tile of existing) {
    const spec = getTileSpec(tile.type)
    if (!spec) continue
    const anchor = tile.bindings[spec.anchor]
    if (anchor) claimed.add(`${tile.type}:${anchor}`)
    for (const row of tile.rows ?? []) {
      for (const id of Object.values(row.bindings)) claimed.add(`${tile.type}:${id}`)
    }
  }

  const used = new Set(existing.map((t) => t.id))
  const uniqueId = (base: string): string => {
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    return id
  }

  const added: HomeTileConfig[] = []
  for (const tile of discovered) {
    const spec = getTileSpec(tile.type)
    if (!spec) continue

    if (spec.rows) {
      // Repeatable tiles merge by ROW: a new pet joins the colony that already
      // exists rather than arriving as a second colony tile.
      const host = existing.find((t) => t.type === tile.type)
      const fresh = (tile.rows ?? []).filter(
        (r) => !Object.values(r.bindings).some((id) => claimed.has(`${tile.type}:${id}`)),
      )
      if (!fresh.length) continue
      if (host) host.rows = [...(host.rows ?? []), ...fresh]
      else added.push({ ...tile, id: uniqueId(tile.id), rows: fresh })
      continue
    }

    const anchor = tile.bindings[spec.anchor]
    if (anchor && claimed.has(`${tile.type}:${anchor}`)) continue
    added.push({ ...tile, id: uniqueId(tile.id) })
  }

  return [...existing, ...added]
}
