import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import postgres from 'postgres'

// `stateStore` is a module-level singleton constructed once at import time.
// Every test needs a fresh instance (vi.resetModules + dynamic import) over a
// controllable virtual filesystem, exactly like cryptoStrategySettings.test.ts's
// freshModule() pattern — but this module also talks to Postgres, so a second
// hoisted fake models the `postgres` package itself.

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => fsState.files.has(p)),
  readFileSync: vi.fn((p: string) => {
    const v = fsState.files.get(p)
    if (v === undefined) throw new Error(`ENOENT: no such file, open '${p}'`)
    return v
  }),
  writeFileSync: vi.fn((p: string, data: string) => { fsState.files.set(p, data) }),
  mkdirSync: vi.fn(),
  rmSync: vi.fn((p: string) => { fsState.files.delete(p) }),
  // Directory walking (registerAllJson / importPlanReports) is exercised only
  // in the Postgres-connected tests, and only ever against a data/ directory
  // this fake never populates — the real code already tolerates that (it's
  // wrapped in try/catch for "no data dir yet"), so throwing is the honest
  // behaviour of an absent directory rather than a special case we invented.
  readdirSync: vi.fn((p: string) => { throw new Error(`ENOENT: no such directory, scandir '${p}'`) }),
  statSync: vi.fn((_p: string) => ({ isDirectory: () => false })),
}))

// A minimal stand-in for the `postgres` tagged-template client. Responses are
// keyed by a substring of the flattened query text so callers don't have to
// track the exact call order of start()'s many migration statements — they
// just register what a particular statement should resolve to.
const pg = vi.hoisted(() => ({
  responses: new Map<string, unknown[]>(),
  calls: [] as string[],
  throwOn: null as string | null,
}))

vi.mock('postgres', () => {
  const factory = vi.fn((_url: string, _opts?: unknown) => {
    const sqlFn: any = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join(' ').replace(/\s+/g, ' ').trim()
      pg.calls.push(text)
      if (pg.throwOn && text.includes(pg.throwOn)) {
        return Promise.reject(new Error('simulated pg failure'))
      }
      let result: unknown[] = []
      for (const [match, resp] of pg.responses) {
        if (text.includes(match)) { result = resp; break }
      }
      const arr: any = [...result]
      arr.count = result.length
      return Promise.resolve(arr)
    })
    sqlFn.json = vi.fn((v: unknown) => v)
    sqlFn.end = vi.fn(() => Promise.resolve())
    return sqlFn
  })
  return { default: factory }
})

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  fsState.files.clear()
  pg.responses.clear()
  pg.calls.length = 0
  pg.throwOn = null
})

async function freshModule() {
  return import('./stateStore')
}

const DATA_ROOT = join(process.cwd(), 'data')

describe('stateKey', () => {
  it('derives a POSIX-separated key relative to data/', async () => {
    const { stateKey } = await freshModule()
    expect(stateKey(join(DATA_ROOT, 'crypto', 'trades.json'))).toBe('crypto/trades.json')
  })

  it('handles a file directly under data/', async () => {
    const { stateKey } = await freshModule()
    expect(stateKey(join(DATA_ROOT, 'foo.json'))).toBe('foo.json')
  })

  it('handles deeper nesting', async () => {
    const { stateKey } = await freshModule()
    expect(stateKey(join(DATA_ROOT, 'crypto', 'office', 'blockers.json'))).toBe('crypto/office/blockers.json')
  })
})

describe('readJson (file-only, no start() called)', () => {
  it('returns the fallback when the file does not exist', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'nope.json')
    expect(stateStore.readJson(file, { a: 1 })).toEqual({ a: 1 })
  })

  it('returns the parsed value when the file exists', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'exists.json')
    fsState.files.set(file, JSON.stringify({ hello: 'world' }))
    expect(stateStore.readJson(file, {})).toEqual({ hello: 'world' })
  })

  it('falls back gracefully on corrupt JSON instead of throwing', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'corrupt.json')
    fsState.files.set(file, '{not valid json')
    expect(() => stateStore.readJson(file, { fallback: true })).not.toThrow()
    expect(stateStore.readJson(file, { fallback: true })).toEqual({ fallback: true })
  })

  it('registers the key as known', async () => {
    const { stateStore, stateKey } = await freshModule()
    const file = join(DATA_ROOT, 'tracked.json')
    stateStore.readJson(file, {})
    expect(stateStore.status().keys).toBeGreaterThanOrEqual(1)
    expect(stateKey(file)).toBe('tracked.json')
  })
})

describe('writeJson', () => {
  it('writes the file as pretty JSON', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'write-test.json')
    stateStore.writeJson(file, { z: 1 })
    expect(fsState.files.get(file)).toBe(JSON.stringify({ z: 1 }, null, 2))
  })

  it('is idempotent about directory creation — repeated writes never throw', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'write-test2.json')
    expect(() => {
      stateStore.writeJson(file, { z: 1 })
      stateStore.writeJson(file, { z: 2 })
      stateStore.writeJson(file, { z: 3 })
    }).not.toThrow()
    expect(JSON.parse(fsState.files.get(file)!)).toEqual({ z: 3 })
  })

  it('a fresh readJson call after writeJson sees the new value (round trip)', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'roundtrip.json')
    stateStore.writeJson(file, { n: 42 })
    expect(stateStore.readJson(file, {})).toEqual({ n: 42 })
  })
})

describe('deleteJson', () => {
  it('removes the file', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'delete-me.json')
    stateStore.writeJson(file, { a: 1 })
    expect(fsState.files.has(file)).toBe(true)
    stateStore.deleteJson(file)
    expect(fsState.files.has(file)).toBe(false)
  })

  it('is a no-op (does not throw) when the file never existed', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'never-existed.json')
    expect(() => stateStore.deleteJson(file)).not.toThrow()
  })

  it('a deleted key falls back on the next readJson', async () => {
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'delete-fallback.json')
    stateStore.writeJson(file, { a: 1 })
    stateStore.deleteJson(file)
    expect(stateStore.readJson(file, { fallback: true })).toEqual({ fallback: true })
  })
})

describe('status()', () => {
  it('reports disconnected before start() is ever called', async () => {
    const { stateStore } = await freshModule()
    expect(stateStore.status()).toEqual({ connected: false, queued: 0, keys: 0, divergent: [] })
  })

  it('counts known keys as readJson/writeJson touch them', async () => {
    const { stateStore } = await freshModule()
    stateStore.readJson(join(DATA_ROOT, 'a.json'), {})
    stateStore.writeJson(join(DATA_ROOT, 'b.json'), {})
    expect(stateStore.status().keys).toBe(2)
  })
})

describe('start() with DATABASE_URL unset', () => {
  it('resolves without connecting, and status stays disconnected', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const { stateStore } = await freshModule()
    await expect(stateStore.start()).resolves.toBeUndefined()
    expect(stateStore.status().connected).toBe(false)
    expect(postgres).not.toHaveBeenCalled()
  })

  it('leaves readJson/writeJson fully functional in file-only mode', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const { stateStore } = await freshModule()
    await stateStore.start()
    const file = join(DATA_ROOT, 'file-only.json')
    stateStore.writeJson(file, { ok: true })
    expect(stateStore.readJson(file, {})).toEqual({ ok: true })
  })
})

describe('start() with DATABASE_URL set and a mocked postgres client', () => {
  it('runs migration statements and reports connected on success', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    expect(stateStore.status().connected).toBe(true)
    expect(postgres).toHaveBeenCalledWith('postgres://fake/db', expect.any(Object))
    expect(pg.calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS app_state'))).toBe(true)
    expect(pg.calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS closed_trades'))).toBe(true)
    expect(pg.calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS plan_reports'))).toBe(true)
    expect(pg.calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS portfolio_history'))).toBe(true)
    expect(pg.calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS agent_runs'))).toBe(true)
  })

  it('falls back to file-only mode and records the error when a migration query throws', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.throwOn = 'CREATE TABLE IF NOT EXISTS app_state'
    const { stateStore } = await freshModule()
    await stateStore.start()

    const status = stateStore.status()
    expect(status.connected).toBe(false)
    expect(status.error).toMatch(/simulated pg failure/)
  })

  it('imports a file-only key into Postgres during reconcile', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    const file = join(DATA_ROOT, 'preexisting.json')
    fsState.files.set(file, JSON.stringify({ v: 1 }))
    stateStore.readJson(file, {}) // registers the key as "known" before start()

    await stateStore.start()

    expect(pg.calls.some((c) => c.includes('INSERT INTO app_state'))).toBe(true)
    expect(stateStore.status().connected).toBe(true)
  })
})
