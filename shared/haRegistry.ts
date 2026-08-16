// The REGISTRY view's model: filtering and sorting over every entity.
//
// This is the tab's escape hatch, and the reason it can honestly claim to expose
// all of Home Assistant. A device that never earns a bespoke tile is still one
// query away here, and an agent that is asked about something no tile covers can
// find it the same way rather than reporting that the house has no such thing.

import type { HaEntity } from './homeassistant'

export interface RegistryFilter {
  domain?: string
  /** Free text, matched against entity id and friendly name. */
  q?: string
  /** Exact state match, e.g. 'on'. */
  state?: string
  /** Sector slug — membership is supplied by the caller, which knows the areas. */
  sector?: string
}

export type RegistrySort = 'changed' | 'name' | 'id' | 'state'

export interface DomainCount {
  domain: string
  count: number
}

/** Entity counts per domain: most populous first, ties broken alphabetically. */
export function domainCounts(entities: HaEntity[]): DomainCount[] {
  const counts = new Map<string, number>()
  for (const e of entities) counts.set(e.domain, (counts.get(e.domain) ?? 0) + 1)
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
}

/**
 * Applies a filter, preserving input order (the caller sorts).
 *
 * `sectorMembers` is the set of entity ids in the selected sector. Sector
 * membership lives in the area registry rather than on the entity, so it is
 * passed in instead of being re-derived here.
 */
export function filterEntities(
  entities: HaEntity[],
  filter: RegistryFilter,
  sectorMembers?: Set<string>,
): HaEntity[] {
  const q = filter.q?.trim().toLowerCase() ?? ''
  return entities.filter((e) => {
    if (filter.domain && e.domain !== filter.domain) return false
    if (filter.state && e.state !== filter.state) return false
    if (filter.sector && sectorMembers && !sectorMembers.has(e.entityId)) return false
    if (q && !e.entityId.toLowerCase().includes(q) && !e.name.toLowerCase().includes(q)) return false
    return true
  })
}

/** Sorted copy — never sorts the caller's array in place. */
export function sortEntities(entities: HaEntity[], sort: RegistrySort): HaEntity[] {
  const out = [...entities]
  switch (sort) {
    case 'changed':
      // Most recently changed first. Entities HA gave no timestamp sort last
      // rather than to the top, where they'd crowd out the actual recent activity.
      return out.sort((a, b) => timestamp(b.lastChanged) - timestamp(a.lastChanged))
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name))
    case 'state':
      return out.sort((a, b) => a.state.localeCompare(b.state) || a.entityId.localeCompare(b.entityId))
    case 'id':
    default:
      return out.sort((a, b) => a.entityId.localeCompare(b.entityId))
  }
}

function timestamp(iso: string | null): number {
  if (!iso) return -Infinity
  const t = Date.parse(iso)
  return Number.isNaN(t) ? -Infinity : t
}
