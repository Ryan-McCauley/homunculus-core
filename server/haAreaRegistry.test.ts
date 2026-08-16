import { describe, it, expect } from 'vitest'
import { buildAreaRegistry } from './haAreaRegistry'

describe('buildAreaRegistry', () => {
  it('maps HA areas to id and name', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'living_room', name: 'Living Room' }],
      devices: [],
      entities: [],
    })
    expect(reg.areas).toEqual([{ id: 'living_room', name: 'Living Room' }])
  })

  it('assigns an entity to the area named on the entity itself', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'living_room', name: 'Living Room' }],
      devices: [],
      entities: [{ entity_id: 'light.ceiling', area_id: 'living_room', device_id: null }],
    })
    expect(reg.entityAreas).toEqual({ 'light.ceiling': 'living_room' })
  })

  it('inherits the area from the entity device when the entity has none', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'kitchen', name: 'Kitchen' }],
      devices: [{ id: 'dev1', area_id: 'kitchen' }],
      entities: [{ entity_id: 'sensor.fridge', area_id: null, device_id: 'dev1' }],
    })
    expect(reg.entityAreas['sensor.fridge']).toBe('kitchen')
  })

  it('prefers the entity area over its device area', () => {
    const reg = buildAreaRegistry({
      areas: [
        { area_id: 'kitchen', name: 'Kitchen' },
        { area_id: 'pantry', name: 'Pantry' },
      ],
      devices: [{ id: 'dev1', area_id: 'kitchen' }],
      entities: [{ entity_id: 'sensor.fridge', area_id: 'pantry', device_id: 'dev1' }],
    })
    expect(reg.entityAreas['sensor.fridge']).toBe('pantry')
  })

  it('leaves an entity unassigned when neither it nor its device has an area', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'kitchen', name: 'Kitchen' }],
      devices: [{ id: 'dev1', area_id: null }],
      entities: [{ entity_id: 'sensor.orphan', area_id: null, device_id: 'dev1' }],
    })
    expect(reg.entityAreas).toEqual({})
  })

  it('leaves an entity unassigned when its device is unknown', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'kitchen', name: 'Kitchen' }],
      devices: [],
      entities: [{ entity_id: 'sensor.orphan', area_id: null, device_id: 'ghost' }],
    })
    expect(reg.entityAreas).toEqual({})
  })

  it('drops an assignment pointing at an area the registry does not list', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'kitchen', name: 'Kitchen' }],
      devices: [],
      entities: [{ entity_id: 'light.x', area_id: 'demolished', device_id: null }],
    })
    expect(reg.entityAreas).toEqual({})
  })

  it('skips malformed rows rather than throwing', () => {
    const reg = buildAreaRegistry({
      areas: [{ area_id: 'kitchen', name: 'Kitchen' }, { area_id: '', name: 'Nameless' }],
      devices: [{ id: '', area_id: 'kitchen' }],
      entities: [{ entity_id: '', area_id: 'kitchen', device_id: null }],
    })
    expect(reg.areas).toEqual([{ id: 'kitchen', name: 'Kitchen' }])
    expect(reg.entityAreas).toEqual({})
  })

  it('handles entirely empty registries', () => {
    expect(buildAreaRegistry({ areas: [], devices: [], entities: [] }))
      .toEqual({ areas: [], entityAreas: {} })
  })
})
