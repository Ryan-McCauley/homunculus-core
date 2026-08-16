// Sectors — the HOME tab's room model.
//
// A sector is one Home Assistant area plus a summary of what is happening in it:
// how many lights are lit, the temperature, the power draw, and anything that
// wants attention. The sector strip on the overview and the whole SECTORS view
// both render from this, and an agent reads the same summaries to answer "what is
// going on in the living room" without walking raw entities.
//
// Entities whose area is unknown collect into a single UNASSIGNED sector rather
// than being dropped. That bucket is the guarantee behind the design: nothing in
// the house becomes unreachable just because it was never filed into a room.

import { slugify } from './homeRoute'
import type { HaAreaRegistry, HaEntity } from './homeassistant'

/** Slug of the catch-all sector for entities with no area. */
export const UNASSIGNED_SECTOR = 'unassigned'

export interface SectorSummary {
  /** Slug of the area name — how routes and agents address this sector. */
  id: string
  label: string
  /** HA's own area id, or null for the unassigned bucket. */
  areaId: string | null
  entityIds: string[]
  lightsOn: number
  lightsTotal: number
  temp: number | null
  humidity: number | null
  /** Summed watts across the sector's power sensors, or null if it has none. */
  power: number | null
  /** Human-readable conditions worth surfacing: open doors, unlocked locks, leaks. */
  alerts: string[]
}

/** Numeric state, or null when the entity is unavailable/non-numeric. */
function numericState(entity: HaEntity): number | null {
  const n = Number(entity.state)
  return Number.isFinite(n) ? n : null
}

/**
 * A short display label for an entity.
 *
 * friendly_name is used when HA has one, but it falls back to the entity id, so
 * strip the domain prefix and de-snake whatever remains: 'cover.garage_bay'
 * reads as 'GARAGE BAY' rather than leaking the id into an alert.
 */
function displayLabel(entity: HaEntity): string {
  const base = entity.name.includes('.') ? entity.name.split('.').slice(1).join('.') : entity.name
  return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase()
}

/** Device classes whose "on" means something is physically open. */
const OPENING_CLASSES = new Set(['door', 'window', 'garage_door', 'opening'])

function alertFor(entity: HaEntity): string | null {
  const label = displayLabel(entity)
  if (entity.domain === 'cover' && entity.state === 'open') return `${label} OPEN`
  if (entity.domain === 'lock' && entity.state === 'unlocked') return `${label} UNLOCKED`
  if (entity.domain === 'binary_sensor' && entity.state === 'on') {
    if (entity.deviceClass && OPENING_CLASSES.has(entity.deviceClass)) return `${label} OPEN`
    if (entity.deviceClass === 'moisture') return `${label} WET`
    if (entity.deviceClass === 'smoke') return `${label} SMOKE`
  }
  return null
}

function summarize(id: string, label: string, areaId: string | null, entities: HaEntity[]): SectorSummary {
  const lights = entities.filter((e) => e.domain === 'light')
  const powerReadings = entities
    .filter((e) => e.deviceClass === 'power')
    .map(numericState)
    .filter((n): n is number => n !== null)

  const temp = entities.find((e) => e.deviceClass === 'temperature' && numericState(e) !== null)
  const humidity = entities.find((e) => e.deviceClass === 'humidity' && numericState(e) !== null)

  return {
    id,
    label,
    areaId,
    entityIds: entities.map((e) => e.entityId),
    lightsOn: lights.filter((e) => e.state === 'on').length,
    lightsTotal: lights.length,
    temp: temp ? numericState(temp) : null,
    humidity: humidity ? numericState(humidity) : null,
    // Summed rather than averaged, and rounded: floating-point addition of
    // sensor readings otherwise yields 480.50000000000006 in the UI.
    power: powerReadings.length ? round2(powerReadings.reduce((a, b) => a + b, 0)) : null,
    alerts: entities.map(alertFor).filter((a): a is string => a !== null),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Groups entities into sectors, summarizing each.
 *
 * Areas holding no entities are omitted (an empty room is not worth a rail slot),
 * named sectors sort alphabetically, and the unassigned bucket always sorts last
 * so the rail reads as rooms-then-leftovers.
 */
export function buildSectors(entities: HaEntity[], registry: HaAreaRegistry | null): SectorSummary[] {
  const areasById = new Map((registry?.areas ?? []).map((a) => [a.id, a]))
  const assignment = registry?.entityAreas ?? {}

  const buckets = new Map<string, HaEntity[]>()
  const unassigned: HaEntity[] = []

  for (const entity of entities) {
    const areaId = assignment[entity.entityId]
    // An assignment pointing at an area the registry doesn't list is stale, not
    // authoritative — treat it as unfiled rather than inventing a nameless room.
    if (areaId && areasById.has(areaId)) {
      const existing = buckets.get(areaId)
      if (existing) existing.push(entity)
      else buckets.set(areaId, [entity])
    } else {
      unassigned.push(entity)
    }
  }

  const sectors: SectorSummary[] = []
  for (const [areaId, members] of buckets) {
    const area = areasById.get(areaId)!
    sectors.push(summarize(slugify(area.name) || areaId, area.name, areaId, members))
  }
  sectors.sort((a, b) => a.label.localeCompare(b.label))

  if (unassigned.length) {
    sectors.push(summarize(UNASSIGNED_SECTOR, 'Unassigned', null, unassigned))
  }
  return sectors
}

/** The sector a route selects, falling back to the first one. Null if there are none. */
export function findSector(sectors: SectorSummary[], slug: string | undefined): SectorSummary | null {
  if (!sectors.length) return null
  return sectors.find((s) => s.id === slug) ?? sectors[0] ?? null
}
