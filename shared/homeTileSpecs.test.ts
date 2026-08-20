import { describe, it, expect } from 'vitest'
import {
  discoverHomeTiles, discoverHomeTilesConfig, getTileSpec, prettyStem,
  sanitizeHomeTiles, tileRenderable, titleFor, TILE_SPECS,
} from './homeTileSpecs'
import type { HaEntity } from './homeassistant'
import type { HomeTileConfig } from './homeTiles'

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

const tilesOfType = (tiles: HomeTileConfig[], type: string): HomeTileConfig[] =>
  tiles.filter((t) => t.type === type)

// The house the HOME tab used to be hardcoded for. Discovery has to rebuild
// exactly these tiles from nothing but the entity list — that equivalence is
// what makes the generalization safe to ship to the install that already exists.
const LEGACY_HOUSE: HaEntity[] = [
  entity('climate.thermostat', { name: 'Thermostat', state: 'heat' }),
  entity('sensor.thermostat_temperature', { name: 'Thermostat Temperature', deviceClass: 'temperature', state: '68' }),
  entity('sensor.thermostat_humidity', { name: 'Thermostat Humidity', deviceClass: 'humidity', state: '41' }),
  entity('switch.thermostat_emergency_heat', { name: 'Thermostat Emergency heat' }),

  entity('weather.forecast_home', { name: 'Forecast Home', state: 'cloudy' }),
  entity('sun.sun', { name: 'Sun', state: 'above_horizon' }),
  entity('sensor.sun_next_rising', { name: 'Sun Next rising', deviceClass: 'timestamp' }),
  entity('sensor.sun_next_setting', { name: 'Sun Next setting', deviceClass: 'timestamp' }),
  entity('sensor.backup_backup_manager_state', { name: 'Backup Backup Manager state' }),

  entity('sensor.washer_current_status', { name: 'Washer Current status', state: 'washing' }),
  entity('switch.washer_power', { name: 'Washer Power' }),
  entity('select.washer_operation', { name: 'Washer Operation' }),
  entity('sensor.washer_remaining_time', { name: 'Washer Remaining time', deviceClass: 'timestamp' }),
  entity('sensor.washer_total_time', { name: 'Washer Total time', deviceClass: 'duration' }),
  entity('switch.washer_child_lock', { name: 'Washer Child lock' }),
  entity('sensor.washer_cycles', { name: 'Washer Cycles', state: '412' }),

  entity('sensor.dryer_current_status', { name: 'Dryer Current status', state: 'drying' }),
  entity('switch.dryer_power', { name: 'Dryer Power' }),
  entity('select.dryer_operation', { name: 'Dryer Operation' }),
  entity('sensor.dryer_remaining_time', { name: 'Dryer Remaining time', deviceClass: 'timestamp' }),
  entity('switch.dryer_wrinkle_prevent', { name: 'Dryer Wrinkle prevent' }),

  entity('vacuum.r2peepoo_litter_box', { name: 'R2PEEPOO Litter Box', state: 'docked' }),
  entity('sensor.r2peepoo_litter_level', { name: 'R2PEEPOO Litter level', state: '72' }),
  entity('sensor.r2peepoo_waste_drawer', { name: 'R2PEEPOO Waste drawer', state: '31' }),
  entity('sensor.r2peepoo_status_code', { name: 'R2PEEPOO Status code', state: 'rdy' }),
  entity('sensor.r2peepoo_pet_weight', { name: 'R2PEEPOO Pet weight', deviceClass: 'weight', state: '9.4' }),
  entity('sensor.r2peepoo_hopper_status', { name: 'R2PEEPOO Hopper status' }),
  entity('select.r2peepoo_globe_light', { name: 'R2PEEPOO Globe light' }),
  entity('button.r2peepoo_reset', { name: 'R2PEEPOO Reset' }),

  ...['smithers', 'willow', 'zelda', 'pazoozoo', 'piggy'].flatMap((cat) => [
    entity(`sensor.${cat}_visits_today`, { name: `${cat} Visits today`, state: '3' }),
    entity(`sensor.${cat}_weight`, { name: `${cat} Weight`, deviceClass: 'weight', state: '11.2' }),
  ]),

  // Noise that must NOT become a tile.
  entity('light.ceiling', { name: 'Ceiling' }),
  entity('sensor.printer_status', { name: 'Printer Status' }),
  entity('vacuum.roomba', { name: 'Roomba', state: 'docked' }),
]

describe('discoverHomeTiles on the legacy house', () => {
  const tiles = discoverHomeTiles(LEGACY_HOUSE)

  it('rebuilds the thermostat tile with all four bindings', () => {
    const [t] = tilesOfType(tiles, 'thermostat')
    expect(t?.bindings).toEqual({
      climate: 'climate.thermostat',
      temperature: 'sensor.thermostat_temperature',
      humidity: 'sensor.thermostat_humidity',
      emergencyHeat: 'switch.thermostat_emergency_heat',
    })
  })

  it('rebuilds the ambient tile', () => {
    const [t] = tilesOfType(tiles, 'ambient')
    expect(t?.bindings['weather']).toBe('weather.forecast_home')
    expect(t?.bindings['sun']).toBe('sun.sun')
    expect(t?.bindings['nextRising']).toBe('sensor.sun_next_rising')
    expect(t?.bindings['nextSetting']).toBe('sensor.sun_next_setting')
    expect(t?.bindings['backup']).toBe('sensor.backup_backup_manager_state')
  })

  it('finds the washer and the dryer as separate appliances', () => {
    const appliances = tilesOfType(tiles, 'appliance')
    expect(appliances.map((t) => t.bindings['status'])).toEqual([
      'sensor.washer_current_status', 'sensor.dryer_current_status',
    ])
    expect(appliances[0]?.title).toBe('Washer')
    expect(appliances[1]?.title).toBe('Dryer')
  })

  it('gives the dryer the dryer animation and phases', () => {
    const dryer = tilesOfType(tiles, 'appliance')[1]
    expect(dryer?.options['visual']).toBe('dryer')
    expect(dryer?.options['phases']).toBe('drying,cooling')
  })

  it('keeps each appliance’s slots on its own device', () => {
    const [washer, dryer] = tilesOfType(tiles, 'appliance')
    expect(washer?.bindings['power']).toBe('switch.washer_power')
    expect(dryer?.bindings['power']).toBe('switch.dryer_power')
    expect(washer?.bindings['wrinklePrevent']).toBeUndefined()
    expect(dryer?.bindings['childLock']).toBeUndefined()
  })

  it('rebuilds the litter tile and titles it from the device', () => {
    const [t] = tilesOfType(tiles, 'litter')
    expect(t?.title).toBe('R2PEEPOO')
    expect(t?.bindings).toMatchObject({
      vacuum: 'vacuum.r2peepoo_litter_box',
      litterLevel: 'sensor.r2peepoo_litter_level',
      wasteDrawer: 'sensor.r2peepoo_waste_drawer',
      statusCode: 'sensor.r2peepoo_status_code',
      petWeight: 'sensor.r2peepoo_pet_weight',
      hopper: 'sensor.r2peepoo_hopper_status',
      globeLight: 'select.r2peepoo_globe_light',
      reset: 'button.r2peepoo_reset',
    })
  })

  it('builds one pets tile with a row per animal', () => {
    const [t] = tilesOfType(tiles, 'pets')
    expect(t?.rows?.map((r) => r.label)).toEqual(['Smithers', 'Willow', 'Zelda', 'Pazoozoo', 'Piggy'])
    expect(t?.rows?.[1]?.bindings).toEqual({
      visits: 'sensor.willow_visits_today',
      weight: 'sensor.willow_weight',
    })
  })

  it('ignores a plain floor vacuum', () => {
    expect(tilesOfType(tiles, 'litter')).toHaveLength(1)
  })

  it('ignores a status sensor with nothing to drive', () => {
    expect(tilesOfType(tiles, 'appliance')).toHaveLength(2)
  })
})

describe('discoverHomeTiles on other houses', () => {
  it('finds nothing in an empty house rather than inventing tiles', () => {
    expect(discoverHomeTiles([])).toEqual([])
  })

  it('gives every climate entity its own thermostat tile', () => {
    const tiles = discoverHomeTiles([
      entity('climate.upstairs', { name: 'Upstairs' }),
      entity('climate.downstairs', { name: 'Downstairs' }),
      entity('sensor.upstairs_humidity', { name: 'Upstairs Humidity', deviceClass: 'humidity' }),
    ])
    const thermostats = tilesOfType(tiles, 'thermostat')
    expect(thermostats.map((t) => t.title)).toEqual(['Upstairs', 'Downstairs'])
    // The one humidity sensor belongs to upstairs, and must not leak downstairs.
    expect(thermostats[0]?.bindings['humidity']).toBe('sensor.upstairs_humidity')
    expect(thermostats[1]?.bindings['humidity']).toBeUndefined()
  })

  it('builds an ambient tile from sun alone when there is no weather integration', () => {
    const tiles = discoverHomeTiles([
      entity('sun.sun', { name: 'Sun' }),
      entity('sensor.sun_next_rising', { name: 'Sun Next rising', deviceClass: 'timestamp' }),
    ])
    const [t] = tilesOfType(tiles, 'ambient')
    expect(t?.bindings['weather']).toBeUndefined()
    expect(t?.bindings['sun']).toBe('sun.sun')
    const spec = getTileSpec('ambient')
    expect(spec && tileRenderable(t as HomeTileConfig, spec)).toBe(true)
  })

  it('recognises a differently-named litter robot', () => {
    const tiles = discoverHomeTiles([
      entity('vacuum.katzenklo', { name: 'Katzenklo', state: 'docked' }),
      entity('sensor.katzenklo_waste_drawer', { name: 'Katzenklo Waste drawer', state: '10' }),
    ])
    const [t] = tilesOfType(tiles, 'litter')
    expect(t?.title).toBe('Katzenklo')
    expect(t?.bindings['wasteDrawer']).toBe('sensor.katzenklo_waste_drawer')
  })

  it('assigns ids unique per type', () => {
    const tiles = discoverHomeTiles(LEGACY_HOUSE)
    expect(new Set(tiles.map((t) => t.id)).size).toBe(tiles.length)
  })
})

describe('titleFor / prettyStem', () => {
  it('strips role words off the friendly name', () => {
    const spec = getTileSpec('litter')
    expect(spec && titleFor(entity('vacuum.r2peepoo_litter_box', { name: 'R2PEEPOO Litter Box' }), spec))
      .toBe('R2PEEPOO')
  })

  it('falls back to the spec default with no anchor', () => {
    const spec = getTileSpec('litter')
    expect(spec && titleFor(undefined, spec)).toBe('Litter Robot')
  })

  it('title-cases a stem', () => {
    expect(prettyStem('back_porch')).toBe('Back Porch')
  })
})

describe('sanitizeHomeTiles', () => {
  it('returns an empty config for junk', () => {
    expect(sanitizeHomeTiles(null)).toEqual({ version: 1, tiles: [], discovered: false })
    expect(sanitizeHomeTiles('nope').tiles).toEqual([])
  })

  it('drops unknown tile types', () => {
    const out = sanitizeHomeTiles({ tiles: [{ id: 'a', type: 'nuclear_reactor', bindings: {} }] })
    expect(out.tiles).toEqual([])
  })

  it('drops bindings that are not entity ids or not slots of the type', () => {
    const out = sanitizeHomeTiles({
      tiles: [{
        id: 'x', type: 'thermostat',
        bindings: { climate: 'climate.hall', humidity: 'not an id', bogusSlot: 'sensor.a' },
      }],
    })
    expect(out.tiles[0]?.bindings).toEqual({ climate: 'climate.hall' })
  })

  it('clamps numeric options into range and drops mistyped ones', () => {
    const out = sanitizeHomeTiles({
      tiles: [{
        id: 'l', type: 'litter', bindings: { vacuum: 'vacuum.box' },
        options: { wasteFull: 900, weightUnit: 'stones', occupiedCodes: 'a,b' },
      }],
    })
    expect(out.tiles[0]?.options).toEqual({ wasteFull: 100, occupiedCodes: 'a,b' })
  })

  it('de-duplicates tile ids', () => {
    const out = sanitizeHomeTiles({
      tiles: [
        { id: 'same', type: 'thermostat', bindings: { climate: 'climate.a' } },
        { id: 'same', type: 'thermostat', bindings: { climate: 'climate.b' } },
      ],
    })
    expect(out.tiles).toHaveLength(1)
  })

  it('drops pet rows with nothing bound', () => {
    const out = sanitizeHomeTiles({
      tiles: [{
        id: 'p', type: 'pets', bindings: {},
        rows: [
          { label: 'Willow', bindings: { visits: 'sensor.willow_visits_today' } },
          { label: 'Ghost', bindings: {} },
        ],
      }],
    })
    expect(out.tiles[0]?.rows).toHaveLength(1)
  })

  it('round-trips a discovered config unchanged', () => {
    const discovered = discoverHomeTilesConfig(LEGACY_HOUSE)
    expect(sanitizeHomeTiles(discovered)).toEqual(discovered)
  })
})

describe('tileRenderable', () => {
  it('is false for a disabled tile', () => {
    const spec = getTileSpec('thermostat')
    const tile: HomeTileConfig = {
      id: 't', type: 'thermostat', title: 'T', enabled: false,
      bindings: { climate: 'climate.a' }, options: {},
    }
    expect(spec && tileRenderable(tile, spec)).toBe(false)
  })

  it('is false when no required slot is bound', () => {
    const spec = getTileSpec('thermostat')
    const tile: HomeTileConfig = {
      id: 't', type: 'thermostat', title: 'T', enabled: true, bindings: {}, options: {},
    }
    expect(spec && tileRenderable(tile, spec)).toBe(false)
  })

  it('gates a repeatable tile on having rows', () => {
    const spec = getTileSpec('pets')
    const empty: HomeTileConfig = {
      id: 'p', type: 'pets', title: 'Colony', enabled: true, bindings: {}, options: {}, rows: [],
    }
    expect(spec && tileRenderable(empty, spec)).toBe(false)
    expect(spec && tileRenderable(
      { ...empty, rows: [{ label: 'Willow', bindings: { visits: 'sensor.w' } }] }, spec,
    )).toBe(true)
  })
})

describe('the catalogue itself', () => {
  it('gives every spec a slot matching its anchor, or a row model', () => {
    for (const spec of TILE_SPECS) {
      const hasAnchorSlot = spec.slots.some((s) => s.key === spec.anchor)
      const hasRows = Boolean(spec.rows)
      expect(hasAnchorSlot || hasRows).toBe(true)
    }
  })

  it('names every renderRequires against a real slot', () => {
    for (const spec of TILE_SPECS) {
      const keys = new Set(spec.slots.map((s) => s.key))
      for (const k of spec.renderRequires) expect(keys.has(k)).toBe(true)
    }
  })

  it('has unique slot and option keys per spec', () => {
    for (const spec of TILE_SPECS) {
      expect(new Set(spec.slots.map((s) => s.key)).size).toBe(spec.slots.length)
      expect(new Set(spec.options.map((o) => o.key)).size).toBe(spec.options.length)
    }
  })
})
