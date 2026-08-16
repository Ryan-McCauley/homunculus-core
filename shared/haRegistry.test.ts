import { describe, it, expect } from 'vitest'
import { domainCounts, filterEntities, sortEntities, type RegistryFilter } from './haRegistry'
import type { HaEntity } from './homeassistant'

function entity(id: string, overrides: Partial<HaEntity> = {}): HaEntity {
  return {
    entityId: id,
    domain: id.split('.')[0] as string,
    name: id,
    state: 'off',
    unit: null,
    deviceClass: null,
    attributes: {},
    lastChanged: null,
    ...overrides,
  }
}

const sample = [
  entity('sensor.living_temp', { name: 'Living Temp', state: '71.4' }),
  entity('sensor.garage_temp', { name: 'Garage Temp', state: '88.7' }),
  entity('light.ceiling', { name: 'Ceiling Main', state: 'on' }),
  entity('lock.front_door', { name: 'Front Door', state: 'locked' }),
]

describe('domainCounts', () => {
  it('counts entities per domain, most populous first', () => {
    expect(domainCounts(sample)).toEqual([
      { domain: 'sensor', count: 2 },
      { domain: 'light', count: 1 },
      { domain: 'lock', count: 1 },
    ])
  })

  it('breaks count ties alphabetically', () => {
    const counts = domainCounts([entity('switch.a'), entity('lock.b')])
    expect(counts.map((c) => c.domain)).toEqual(['lock', 'switch'])
  })

  it('returns an empty list for no entities', () => {
    expect(domainCounts([])).toEqual([])
  })
})

describe('filterEntities', () => {
  it('returns everything when the filter is empty', () => {
    expect(filterEntities(sample, {})).toHaveLength(4)
  })

  it('filters by domain', () => {
    expect(filterEntities(sample, { domain: 'sensor' }).map((e) => e.entityId))
      .toEqual(['sensor.living_temp', 'sensor.garage_temp'])
  })

  it('matches a query against the entity id', () => {
    expect(filterEntities(sample, { q: 'garage' }).map((e) => e.entityId)).toEqual(['sensor.garage_temp'])
  })

  it('matches a query against the friendly name', () => {
    expect(filterEntities(sample, { q: 'ceiling main' }).map((e) => e.entityId)).toEqual(['light.ceiling'])
  })

  it('matches queries case-insensitively', () => {
    expect(filterEntities(sample, { q: 'FRONT' }).map((e) => e.entityId)).toEqual(['lock.front_door'])
  })

  it('ignores surrounding whitespace in a query', () => {
    expect(filterEntities(sample, { q: '  ceiling  ' }).map((e) => e.entityId)).toEqual(['light.ceiling'])
  })

  it('filters by exact state', () => {
    expect(filterEntities(sample, { state: 'on' }).map((e) => e.entityId)).toEqual(['light.ceiling'])
  })

  it('restricts to a sector when one is given', () => {
    const filter: RegistryFilter = { sector: 'living-room' }
    const inSector = new Set(['sensor.living_temp', 'light.ceiling'])
    expect(filterEntities(sample, filter, inSector).map((e) => e.entityId))
      .toEqual(['sensor.living_temp', 'light.ceiling'])
  })

  it('combines domain and query', () => {
    expect(filterEntities(sample, { domain: 'sensor', q: 'temp' })).toHaveLength(2)
    expect(filterEntities(sample, { domain: 'light', q: 'temp' })).toHaveLength(0)
  })

  it('returns nothing when a query matches nothing', () => {
    expect(filterEntities(sample, { q: 'zzz' })).toEqual([])
  })
})

describe('sortEntities', () => {
  const withTimes = [
    entity('sensor.a', { name: 'Bravo', lastChanged: '2026-01-01T00:00:00Z' }),
    entity('sensor.b', { name: 'Alpha', lastChanged: '2026-01-01T00:05:00Z' }),
    entity('sensor.c', { name: 'Charlie', lastChanged: null }),
  ]

  it('sorts by most recently changed first', () => {
    expect(sortEntities(withTimes, 'changed').map((e) => e.entityId)).toEqual(['sensor.b', 'sensor.a', 'sensor.c'])
  })

  it('sorts by friendly name', () => {
    expect(sortEntities(withTimes, 'name').map((e) => e.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('sorts by entity id', () => {
    expect(sortEntities(withTimes, 'id').map((e) => e.entityId)).toEqual(['sensor.a', 'sensor.b', 'sensor.c'])
  })

  it('does not mutate the input array', () => {
    const input = [...withTimes]
    sortEntities(input, 'name')
    expect(input.map((e) => e.entityId)).toEqual(['sensor.a', 'sensor.b', 'sensor.c'])
  })
})
