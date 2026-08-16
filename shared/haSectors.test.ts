import { describe, it, expect } from 'vitest'
import { buildSectors, UNASSIGNED_SECTOR, findSector } from './haSectors'
import type { HaEntity, HaAreaRegistry } from './homeassistant'

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

const registry: HaAreaRegistry = {
  areas: [
    { id: 'living_room', name: 'Living Room' },
    { id: 'garage', name: 'Garage' },
    { id: 'attic', name: 'Attic' },
  ],
  entityAreas: {
    'light.ceiling': 'living_room',
    'light.shelf_strip': 'living_room',
    'sensor.living_temp': 'living_room',
    'cover.garage_bay': 'garage',
  },
}

describe('buildSectors', () => {
  it('groups entities under the area they belong to', () => {
    const sectors = buildSectors(
      [entity('light.ceiling'), entity('cover.garage_bay')],
      registry,
    )
    expect(sectors.map((s) => s.id)).toEqual(['garage', 'living-room'])
    expect(sectors.find((s) => s.id === 'living-room')?.entityIds).toEqual(['light.ceiling'])
  })

  it('labels a sector with the area name', () => {
    const sectors = buildSectors([entity('light.ceiling')], registry)
    expect(sectors[0]?.label).toBe('Living Room')
  })

  it('omits areas that hold no entities', () => {
    const sectors = buildSectors([entity('light.ceiling')], registry)
    expect(sectors.map((s) => s.id)).not.toContain('attic')
  })

  it('counts lights on and total', () => {
    const sectors = buildSectors([
      entity('light.ceiling', { state: 'on' }),
      entity('light.shelf_strip', { state: 'off' }),
    ], registry)
    expect(sectors[0]).toMatchObject({ lightsOn: 1, lightsTotal: 2 })
  })

  it('reads temperature and humidity from device-classed sensors', () => {
    const sectors = buildSectors([
      entity('sensor.living_temp', { state: '71.4', deviceClass: 'temperature' }),
    ], registry)
    expect(sectors[0]?.temp).toBe(71.4)
    expect(sectors[0]?.humidity).toBeNull()
  })

  it('sums power across the sector', () => {
    const reg: HaAreaRegistry = {
      areas: [{ id: 'living_room', name: 'Living Room' }],
      entityAreas: { 'sensor.a': 'living_room', 'sensor.b': 'living_room' },
    }
    const sectors = buildSectors([
      entity('sensor.a', { state: '300', deviceClass: 'power' }),
      entity('sensor.b', { state: '180.5', deviceClass: 'power' }),
    ], reg)
    expect(sectors[0]?.power).toBe(480.5)
  })

  it('ignores non-numeric sensor states rather than producing NaN', () => {
    const sectors = buildSectors([
      entity('sensor.living_temp', { state: 'unavailable', deviceClass: 'temperature' }),
    ], registry)
    expect(sectors[0]?.temp).toBeNull()
  })

  it('raises an alert for an open door', () => {
    const sectors = buildSectors([
      entity('cover.garage_bay', { state: 'open', deviceClass: 'garage' }),
    ], registry)
    expect(sectors[0]?.alerts).toEqual(['GARAGE BAY OPEN'])
  })

  it('raises an alert for an unlocked lock', () => {
    const reg: HaAreaRegistry = {
      areas: [{ id: 'garage', name: 'Garage' }],
      entityAreas: { 'lock.side_door': 'garage' },
    }
    const sectors = buildSectors([
      entity('lock.side_door', { name: 'Side Door', state: 'unlocked' }),
    ], reg)
    expect(sectors[0]?.alerts).toEqual(['SIDE DOOR UNLOCKED'])
  })

  it('raises an alert for detected moisture', () => {
    const reg: HaAreaRegistry = {
      areas: [{ id: 'garage', name: 'Garage' }],
      entityAreas: { 'binary_sensor.leak': 'garage' },
    }
    const sectors = buildSectors([
      entity('binary_sensor.leak', { name: 'Floor Leak', state: 'on', deviceClass: 'moisture' }),
    ], reg)
    expect(sectors[0]?.alerts).toEqual(['FLOOR LEAK WET'])
  })

  it('reports no alerts when everything is closed and locked', () => {
    const sectors = buildSectors([
      entity('cover.garage_bay', { state: 'closed', deviceClass: 'garage' }),
    ], registry)
    expect(sectors[0]?.alerts).toEqual([])
  })

  it('collects entities with no area into an unassigned sector listed last', () => {
    const sectors = buildSectors([
      entity('sensor.orphan'),
      entity('light.ceiling'),
    ], registry)
    expect(sectors.map((s) => s.id)).toEqual(['living-room', UNASSIGNED_SECTOR])
    expect(sectors[1]?.entityIds).toEqual(['sensor.orphan'])
  })

  it('omits the unassigned sector when every entity has an area', () => {
    const sectors = buildSectors([entity('light.ceiling')], registry)
    expect(sectors.map((s) => s.id)).not.toContain(UNASSIGNED_SECTOR)
  })

  it('puts everything in unassigned when no registry is available', () => {
    const sectors = buildSectors([entity('light.ceiling')], null)
    expect(sectors).toHaveLength(1)
    expect(sectors[0]?.id).toBe(UNASSIGNED_SECTOR)
  })

  it('returns nothing for an empty entity list', () => {
    expect(buildSectors([], registry)).toEqual([])
  })

  it('sorts named sectors alphabetically by label', () => {
    const sectors = buildSectors([
      entity('cover.garage_bay'), entity('light.ceiling'),
    ], registry)
    expect(sectors.map((s) => s.label)).toEqual(['Garage', 'Living Room'])
  })
})

describe('findSector', () => {
  const sectors = buildSectors([entity('light.ceiling'), entity('cover.garage_bay')], registry)

  it('finds a sector by its slug', () => {
    expect(findSector(sectors, 'living-room')?.label).toBe('Living Room')
  })

  it('falls back to the first sector for an unknown or missing slug', () => {
    expect(findSector(sectors, 'nowhere')?.id).toBe('garage')
    expect(findSector(sectors, undefined)?.id).toBe('garage')
  })

  it('returns null when there are no sectors at all', () => {
    expect(findSector([], 'living-room')).toBeNull()
  })
})
