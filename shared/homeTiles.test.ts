import { describe, it, expect } from 'vitest'
import {
  autoBindTile, boundId, candidatesFor, numberOption, objectId, optionOf,
  scoreCandidate, stemOf, type HomeTileConfig, type TileSlot, type TileSpec,
} from './homeTiles'
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

const slot = (s: Partial<TileSlot> & { key: string; domains: string[] }): TileSlot =>
  ({ label: s.key, ...s })

describe('objectId / stemOf', () => {
  it('splits the domain off an entity id', () => {
    expect(objectId('sensor.washer_current_status')).toBe('washer_current_status')
    expect(objectId('nodots')).toBe('nodots')
  })

  it('strips trailing role words to recover the device', () => {
    expect(stemOf('sensor.washer_current_status')).toBe('washer')
    expect(stemOf('sensor.r2peepoo_waste_drawer')).toBe('r2peepoo')
    expect(stemOf('switch.thermostat_emergency_heat')).toBe('thermostat')
    expect(stemOf('sensor.willow_visits_today')).toBe('willow')
  })

  it('keeps multi-word device names intact', () => {
    expect(stemOf('sensor.back_porch_motion_temperature')).toBe('back_porch_motion')
  })

  it('never collapses an entity to an empty stem', () => {
    // A device whose own name IS a role word still has to group as something.
    expect(stemOf('sensor.temperature')).toBe('temperature')
    expect(stemOf('sensor.status_code')).toBe('status')
  })
})

describe('scoreCandidate', () => {
  const humidity = slot({
    key: 'humidity', domains: ['sensor'], deviceClasses: ['humidity'], keywords: ['humidity'],
  })

  it('excludes entities outside the slot domains', () => {
    expect(scoreCandidate(humidity, entity('switch.thermostat_humidity'))).toBeNull()
  })

  it('ranks a same-device match above a better-named foreign one', () => {
    const own = entity('sensor.thermostat_rh')
    const foreign = entity('sensor.greenhouse_humidity', { deviceClass: 'humidity' })
    const ownScore = scoreCandidate(humidity, own, 'thermostat')
    const foreignScore = scoreCandidate(humidity, foreign, 'thermostat')
    expect(ownScore).not.toBeNull()
    expect(foreignScore).not.toBeNull()
    expect(ownScore as number).toBeGreaterThan(foreignScore as number)
  })

  it('ranks unavailable entities below live ones', () => {
    const live = scoreCandidate(humidity, entity('sensor.a_humidity'))
    const dead = scoreCandidate(humidity, entity('sensor.b_humidity', { state: 'unavailable' }))
    expect(live as number).toBeGreaterThan(dead as number)
  })
})

describe('candidatesFor', () => {
  it('returns every domain match, best first', () => {
    const entities = [
      entity('sensor.garage_battery'),
      entity('sensor.thermostat_humidity', { deviceClass: 'humidity' }),
      entity('switch.ignored'),
    ]
    const out = candidatesFor(
      slot({ key: 'humidity', domains: ['sensor'], deviceClasses: ['humidity'], keywords: ['humidity'] }),
      entities,
    )
    expect(out.map((e) => e.entityId)).toEqual(['sensor.thermostat_humidity', 'sensor.garage_battery'])
  })
})

const testSpec: TileSpec = {
  type: 'test',
  label: 'Test',
  icon: 'ti-test',
  defaultTitle: 'Test',
  anchor: 'vacuum',
  renderRequires: ['vacuum'],
  slots: [
    slot({ key: 'vacuum', domains: ['vacuum'], required: true }),
    slot({ key: 'waste', domains: ['sensor'], keywords: ['waste', 'drawer'] }),
    slot({ key: 'litter', domains: ['sensor'], keywords: ['litter_level', 'litter'] }),
    slot({ key: 'reset', domains: ['button'], keywords: ['reset'] }),
    slot({ key: 'nothingHere', domains: ['humidifier'] }),
  ],
  options: [
    { key: 'wasteFull', label: 'Waste full', kind: 'number', default: 80, min: 1, max: 100 },
    { key: 'unit', label: 'Unit', kind: 'select', default: 'lb', choices: ['lb', 'kg'] },
  ],
}

describe('autoBindTile', () => {
  const house = [
    entity('vacuum.tidycat_box'),
    entity('sensor.tidycat_waste_drawer'),
    entity('sensor.tidycat_litter_level'),
    entity('button.tidycat_reset'),
    entity('sensor.other_device_waste_drawer'),
  ]

  it('fills slots from the anchor’s own device', () => {
    const b = autoBindTile(testSpec, house, 'vacuum.tidycat_box')
    expect(b['vacuum']).toBe('vacuum.tidycat_box')
    expect(b['waste']).toBe('sensor.tidycat_waste_drawer')
    expect(b['litter']).toBe('sensor.tidycat_litter_level')
    expect(b['reset']).toBe('button.tidycat_reset')
  })

  it('leaves a slot unbound rather than guessing wildly', () => {
    const b = autoBindTile(testSpec, house, 'vacuum.tidycat_box')
    expect(b['nothingHere']).toBeUndefined()
  })

  it('never binds one entity to two slots', () => {
    const b = autoBindTile(testSpec, house, 'vacuum.tidycat_box')
    const ids = Object.values(b)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('prefers the anchor’s device when two houses share a naming scheme', () => {
    const b = autoBindTile(testSpec, house, 'vacuum.tidycat_box')
    expect(b['waste']).not.toBe('sensor.other_device_waste_drawer')
  })
})

describe('reading a bound tile', () => {
  const tile: HomeTileConfig = {
    id: 't1', type: 'test', title: 'Test', enabled: true,
    bindings: { vacuum: 'vacuum.tidycat_box' },
    options: { wasteFull: 60 },
  }

  it('returns the bound id, or null for an empty slot', () => {
    expect(boundId(tile, 'vacuum')).toBe('vacuum.tidycat_box')
    expect(boundId(tile, 'waste')).toBeNull()
  })

  it('falls back to the spec default for an unset option', () => {
    expect(optionOf(tile, testSpec, 'unit')).toBe('lb')
    expect(numberOption(tile, testSpec, 'wasteFull')).toBe(60)
  })

  it('ignores a stored option of the wrong type', () => {
    const bad: HomeTileConfig = { ...tile, options: { wasteFull: 'lots' as never } }
    expect(numberOption(bad, testSpec, 'wasteFull')).toBe(80)
  })
})
