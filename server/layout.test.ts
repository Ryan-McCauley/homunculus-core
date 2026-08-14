import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { defaultLayout, sanitizeLayout, resolveDefaultTab, type LayoutConfig } from '../shared/layout'

// layout.ts caches its in-memory copy at module scope (`cache`), reads it once via
// stateStore + node:fs's existsSync, and writes through on every mutation. Each test
// needs a fresh module instance over a controllable virtual store/fs, same pattern as
// cryptoStrategySettings.test.ts.
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
const LAYOUT_FILE = join(DATA_DIR, 'layout.json')
const SETUP_FILE = join(DATA_DIR, 'setup.json')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists.clear()
  store.map.clear()
})

async function freshModule() {
  return import('./layout')
}

describe('getLayout', () => {
  it('returns the stock default layout when no file exists on disk', async () => {
    const m = await freshModule()
    const layout = m.getLayout()
    expect(layout).toEqual(defaultLayout())
  })

  it('caches the loaded layout across repeated calls (single read)', async () => {
    const m = await freshModule()
    const first = m.getLayout()
    const second = m.getLayout()
    expect(first).toBe(second)
  })

  it('loads and sanitizes a layout already on disk', async () => {
    const custom: LayoutConfig = {
      version: 1,
      defaultTab: 'CRYPTO',
      tabs: [{ id: 'CRYPTO', label: 'CRYPTO', enabled: true, builtin: true, widgets: [] }],
    }
    fsState.exists.add(LAYOUT_FILE)
    store.map.set(LAYOUT_FILE, custom)
    const m = await freshModule()
    expect(m.getLayout()).toEqual(sanitizeLayout(custom))
  })

  it('falls back to defaults when the on-disk read throws', async () => {
    fsState.exists.add(LAYOUT_FILE)
    // No entry in the store map, but readJson is fine with that (returns fallback {}).
    // Force a genuine throw instead by making sanitizeLayout unreachable: simulate a
    // stateStore.readJson failure directly.
    const mod = await import('./stateStore')
    vi.mocked(mod.stateStore.readJson).mockImplementationOnce(() => { throw new Error('disk error') })
    const m = await freshModule()
    expect(m.getLayout()).toEqual(defaultLayout())
  })
})

describe('setLayout', () => {
  it('sanitizes and persists the given raw layout', async () => {
    const m = await freshModule()
    const raw = { defaultTab: 'crypto', tabs: [{ id: 'crypto', widgets: [] }] }
    const result = m.setLayout(raw)
    expect(result.tabs[0]!.id).toBe('CRYPTO')
    expect(store.map.get(LAYOUT_FILE)).toEqual(result)
  })

  it('degrades malformed input to the stock layout rather than persisting garbage', async () => {
    const m = await freshModule()
    const result = m.setLayout({ tabs: [] })
    expect(result).toEqual(defaultLayout())
  })

  it('updates the in-memory cache so a subsequent getLayout sees the change', async () => {
    const m = await freshModule()
    const raw = { defaultTab: 'CRYPTO', tabs: [{ id: 'CRYPTO', widgets: [] }] }
    m.setLayout(raw)
    expect(m.getLayout().tabs).toHaveLength(1)
    expect(m.getLayout().tabs[0]!.id).toBe('CRYPTO')
  })

  it('creates the data directory before writing', async () => {
    const m = await freshModule()
    m.setLayout(defaultLayout())
    const fs = await import('node:fs')
    expect(fs.mkdirSync).toHaveBeenCalled()
  })
})

describe('resetLayout', () => {
  it('restores the stock layout and persists it', async () => {
    const m = await freshModule()
    m.setLayout({ defaultTab: 'CRYPTO', tabs: [{ id: 'CRYPTO', widgets: [] }] })
    const reset = m.resetLayout()
    expect(reset).toEqual(defaultLayout())
    expect(store.map.get(LAYOUT_FILE)).toEqual(defaultLayout())
  })
})

describe('isSetupComplete / markSetupComplete', () => {
  it('is false when no setup file exists', async () => {
    const m = await freshModule()
    expect(m.isSetupComplete()).toBe(false)
  })

  it('is false when the setup file exists but complete is not true', async () => {
    fsState.exists.add(SETUP_FILE)
    store.map.set(SETUP_FILE, { complete: false })
    const m = await freshModule()
    expect(m.isSetupComplete()).toBe(false)
  })

  it('is true once markSetupComplete(true) has been called', async () => {
    const m = await freshModule()
    m.markSetupComplete(true)
    // markSetupComplete persists via stateStore; writeJson doesn't touch our fs-exists
    // mock, so isSetupComplete's existsSync(SETUP_FILE) gate needs the fixture updated
    // too — mirroring a real writeFileSync having created the file on disk.
    expect(store.map.get(SETUP_FILE)).toEqual(expect.objectContaining({ complete: true }))
    fsState.exists.add(SETUP_FILE)
    expect(m.isSetupComplete()).toBe(true)
  })

  it('returns false if reading the setup file throws', async () => {
    fsState.exists.add(SETUP_FILE)
    const mod = await import('./stateStore')
    vi.mocked(mod.stateStore.readJson).mockImplementationOnce(() => { throw new Error('boom') })
    const m = await freshModule()
    expect(m.isSetupComplete()).toBe(false)
  })
})

describe('resolveDefaultTab re-export sanity (imported from shared/layout, used internally)', () => {
  it('sanitizeLayout falls back to the first enabled tab when defaultTab is disabled', async () => {
    const raw = {
      defaultTab: 'B',
      tabs: [
        { id: 'A', enabled: true, widgets: [] },
        { id: 'B', enabled: false, widgets: [] },
      ],
    }
    const sanitized = sanitizeLayout(raw)
    expect(resolveDefaultTab(sanitized)).toBe('A')
  })
})
