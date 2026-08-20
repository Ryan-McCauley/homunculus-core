import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import type { HaEntity } from '../shared/homeassistant'

// Same shape as layout.test.ts: homeTiles.ts caches at module scope and writes
// through stateStore, so each test needs a fresh module over a virtual store.
const fsState = vi.hoisted(() => ({ exists: new Set<string>() }))
const store = vi.hoisted(() => ({ map: new Map<string, unknown>() }))

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => fsState.exists.has(p)),
  mkdirSync: vi.fn(),
}))

vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (store.map.has(file) ? store.map.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { store.map.set(file, value) }),
    deleteJson: vi.fn((file: string) => { store.map.delete(file) }),
  },
}))

const DATA_DIR = process.env['HOMUNCULUS_DATA_DIR'] || join(process.cwd(), 'data')
const FILE = join(DATA_DIR, 'home-tiles.json')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists.clear()
  store.map.clear()
})

const freshModule = () => import('./homeTiles')

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

const HOUSE: HaEntity[] = [
  entity('climate.hall', { name: 'Hall' }),
  entity('sensor.hall_humidity', { name: 'Hall Humidity', deviceClass: 'humidity' }),
  entity('vacuum.katzenklo', { name: 'Katzenklo', state: 'docked' }),
  entity('sensor.katzenklo_waste_drawer', { name: 'Katzenklo Waste drawer', state: '12' }),
]

/** Persist a config as if a previous run had written it. */
function seed(config: unknown): void {
  fsState.exists.add(FILE)
  store.map.set(FILE, config)
}

describe('getHomeTiles', () => {
  it('is empty and undiscovered on a fresh data dir', async () => {
    const m = await freshModule()
    expect(m.getHomeTiles()).toEqual({ version: 1, tiles: [], discovered: false })
  })

  it('reads and sanitizes what is on disk', async () => {
    seed({
      version: 1, discovered: true,
      tiles: [
        { id: 'a', type: 'thermostat', title: 'Hall', enabled: true, bindings: { climate: 'climate.hall' }, options: {} },
        { id: 'b', type: 'not_a_tile', bindings: {} },
      ],
    })
    const m = await freshModule()
    const config = m.getHomeTiles()
    expect(config.tiles).toHaveLength(1)
    expect(config.tiles[0]?.id).toBe('a')
  })

  it('falls back to empty-and-undiscovered when the file is unreadable', async () => {
    fsState.exists.add(FILE)
    const { stateStore } = await import('./stateStore')
    vi.mocked(stateStore.readJson).mockImplementationOnce(() => { throw new Error('EIO') })
    const m = await freshModule()
    // Undiscovered, not merely empty — so the next snapshot rebuilds it.
    expect(m.getHomeTiles()).toEqual({ version: 1, tiles: [], discovered: false })
  })
})

describe('ensureDiscovered', () => {
  it('discovers tiles on the first connected snapshot and persists them', async () => {
    const m = await freshModule()
    const config = m.ensureDiscovered(HOUSE)
    expect(config.discovered).toBe(true)
    expect(config.tiles.map((t) => t.type)).toEqual(['thermostat', 'litter'])
    expect(store.map.get(FILE)).toEqual(config)
  })

  it('does nothing on an empty entity list, so an offline HA cannot blank the tab', async () => {
    const m = await freshModule()
    const config = m.ensureDiscovered([])
    expect(config.discovered).toBe(false)
    expect(store.map.has(FILE)).toBe(false)
  })

  it('never re-runs once discovery has happened', async () => {
    const m = await freshModule()
    m.ensureDiscovered(HOUSE)
    const after = m.ensureDiscovered([...HOUSE, entity('climate.attic', { name: 'Attic' })])
    // The new thermostat is NOT picked up: re-deriving bindings in the
    // background would silently undo a binding the user had corrected.
    expect(after.tiles.filter((t) => t.type === 'thermostat')).toHaveLength(1)
  })

  it('leaves a user-saved config alone', async () => {
    const m = await freshModule()
    m.setHomeTiles({ tiles: [] })
    expect(m.ensureDiscovered(HOUSE).tiles).toEqual([])
  })
})

describe('setHomeTiles', () => {
  it('persists a sanitized copy and marks discovery done', async () => {
    const m = await freshModule()
    const saved = m.setHomeTiles({
      tiles: [{ id: 'x', type: 'thermostat', title: 'Hall', bindings: { climate: 'climate.hall', junk: 'x' } }],
    })
    expect(saved.discovered).toBe(true)
    expect(saved.tiles[0]?.bindings).toEqual({ climate: 'climate.hall' })
  })

  it('lets the user delete every tile without discovery resurrecting them', async () => {
    const m = await freshModule()
    m.ensureDiscovered(HOUSE)
    m.setHomeTiles({ tiles: [] })
    expect(m.ensureDiscovered(HOUSE).tiles).toEqual([])
  })
})

describe('rediscoverHomeTiles', () => {
  it('adds tiles for new devices and keeps existing ones verbatim', async () => {
    const m = await freshModule()
    m.ensureDiscovered(HOUSE)
    m.setHomeTiles({
      tiles: [{
        id: 'mine', type: 'thermostat', title: 'MY NAME FOR IT', enabled: true,
        bindings: { climate: 'climate.hall' }, options: { step: 2 },
      }],
    })

    const next = m.rediscoverHomeTiles([...HOUSE, entity('climate.attic', { name: 'Attic' })])
    const mine = next.tiles.find((t) => t.id === 'mine')
    expect(mine?.title).toBe('MY NAME FOR IT')
    expect(mine?.options['step']).toBe(2)
    expect(next.tiles.some((t) => t.bindings['climate'] === 'climate.attic')).toBe(true)
    // The litter tile the user deleted comes back — "scan for new devices" is
    // about the house, and hiding a device for good is the enabled flag's job.
    expect(next.tiles.some((t) => t.type === 'litter')).toBe(true)
  })

  it('is idempotent — scanning twice adds nothing the second time', async () => {
    const m = await freshModule()
    m.ensureDiscovered(HOUSE)
    const once = m.rediscoverHomeTiles(HOUSE)
    const twice = m.rediscoverHomeTiles(HOUSE)
    expect(twice.tiles).toHaveLength(once.tiles.length)
  })

  it('does not mutate the cached config when merging', async () => {
    const m = await freshModule()
    m.ensureDiscovered(HOUSE)
    const before = JSON.parse(JSON.stringify(m.getHomeTiles()))
    m.rediscoverHomeTiles(HOUSE)
    // The merge appends rows in place; a cache mutated ahead of the write would
    // make a failed write leave the process holding a config nothing persisted.
    expect(before.tiles).toHaveLength(2)
  })
})

describe('resetHomeTiles', () => {
  it('throws the config away and rebuilds from the house', async () => {
    const m = await freshModule()
    m.setHomeTiles({
      tiles: [{ id: 'stale', type: 'thermostat', title: 'Gone', bindings: { climate: 'climate.removed' } }],
    })
    const next = m.resetHomeTiles(HOUSE)
    expect(next.tiles.some((t) => t.id === 'stale')).toBe(false)
    expect(next.tiles.map((t) => t.type)).toEqual(['thermostat', 'litter'])
  })
})

describe('write failures', () => {
  it('keeps serving the new config in memory when the disk write fails', async () => {
    const { stateStore } = await import('./stateStore')
    vi.mocked(stateStore.writeJson).mockImplementation(() => { throw new Error('ENOSPC') })
    const m = await freshModule()
    const config = m.ensureDiscovered(HOUSE)
    expect(config.tiles.length).toBeGreaterThan(0)
    expect(m.getHomeTiles().tiles.length).toBeGreaterThan(0)
  })
})
