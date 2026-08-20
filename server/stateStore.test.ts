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
  // writeFile persists atomically (temp file + rename), so the fake filesystem has
  // to model rename for the virtual store to end up with the real path.
  renameSync: vi.fn((from: string, to: string) => {
    const v = fsState.files.get(from)
    if (v === undefined) throw new Error(`ENOENT: no such file, rename '${from}'`)
    fsState.files.delete(from)
    fsState.files.set(to, v)
  }),
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

// ── Reconcile: the disaster-recovery path ──────────────────────────────────
//
// This is the half of the module that only runs when something has already gone
// wrong — a wiped data/ directory, a torn write from a crash, a file and row that
// disagree. It was entirely uncovered, which is the worst place to have no tests:
// the code only executes on the day you most need it to be right.

describe('reconcile — restoring from the database', () => {
  it('writes a file back when Postgres has a row and the disk does not', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [
      { key: 'crypto/trades.json', value: [{ id: 't1' }] },
    ])
    const { stateStore } = await freshModule()
    await stateStore.start()

    // This is the "delete data/ and the app rebuilds it" guarantee.
    const file = join(DATA_ROOT, 'crypto', 'trades.json')
    expect(fsState.files.has(file)).toBe(true)
    expect(JSON.parse(fsState.files.get(file)!)).toEqual([{ id: 't1' }])
  })

  it('leaves a readable file alone when it agrees with the row', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    const file = join(DATA_ROOT, 'agree.json')
    fsState.files.set(file, JSON.stringify({ a: 1 }, null, 2))
    pg.responses.set('SELECT key, value FROM app_state', [{ key: 'agree.json', value: { a: 1 } }])

    const { stateStore } = await freshModule()
    stateStore.readJson(file, {})
    await stateStore.start()

    expect(stateStore.status().divergent).toEqual([])
  })
})

describe('reconcile — corrupt file quarantine', () => {
  it('quarantines unparseable bytes and restores the row over them', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    const file = join(DATA_ROOT, 'torn.json')
    fsState.files.set(file, '{"half":')        // a torn write from a crash
    pg.responses.set('SELECT key, value FROM app_state', [
      { key: 'torn.json', value: { half: 'written', andThen: 'the rest' } },
    ])

    const { stateStore } = await freshModule()
    await stateStore.start()

    // The good row won...
    expect(JSON.parse(fsState.files.get(file)!)).toEqual({ half: 'written', andThen: 'the rest' })
    // ...and the corrupt bytes were kept aside for forensics, not destroyed.
    const quarantined = [...fsState.files.keys()].filter((k) => k.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(fsState.files.get(quarantined[0]!)).toBe('{"half":')
  })

  it('still restores when the file cannot be renamed out of the way', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    const fs = await import('node:fs')
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('EPERM') })

    const file = join(DATA_ROOT, 'locked.json')
    fsState.files.set(file, 'not json at all')
    pg.responses.set('SELECT key, value FROM app_state', [{ key: 'locked.json', value: { ok: true } }])

    const { stateStore } = await freshModule()
    await stateStore.start()

    // The comment says "fall through and overwrite" — verify it actually does.
    expect(JSON.parse(fsState.files.get(file)!)).toEqual({ ok: true })
  })
})

describe('reconcile — divergence', () => {
  it('reports a disagreement and lets the FILE win', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    const file = join(DATA_ROOT, 'split.json')
    fsState.files.set(file, JSON.stringify({ live: 'from disk' }))
    pg.responses.set('SELECT key, value FROM app_state', [
      { key: 'split.json', value: { live: 'stale from db' } },
    ])

    const { stateStore } = await freshModule()
    stateStore.readJson(file, {})   // make the key known
    await stateStore.start()

    expect(stateStore.status().divergent).toContain('split.json')
    // The file is what the hubs already read into memory — it must not be reverted.
    expect(JSON.parse(fsState.files.get(file)!)).toEqual({ live: 'from disk' })
    expect(pg.calls.some((c) => c.includes('INSERT INTO app_state'))).toBe(true)
  })

  it('does NOT call a key divergent merely because JSONB reordered its keys', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    const file = join(DATA_ROOT, 'ordered.json')
    fsState.files.set(file, JSON.stringify({ b: 2, a: 1 }))       // disk order
    pg.responses.set('SELECT key, value FROM app_state', [
      { key: 'ordered.json', value: { a: 1, b: 2 } },              // JSONB order
    ])

    const { stateStore } = await freshModule()
    stateStore.readJson(file, {})
    await stateStore.start()

    // Without canonical comparison this would flag every key on every boot.
    expect(stateStore.status().divergent).toEqual([])
  })
})

// ── Tombstones: deletes that must not resurrect ────────────────────────────

describe('deleteJson tombstones', () => {
  it('issues a DELETE against Postgres when connected', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    const file = join(DATA_ROOT, 'gone.json')
    fsState.files.set(file, JSON.stringify({ x: 1 }))
    stateStore.deleteJson(file)
    await new Promise((r) => setImmediate(r))   // let the fire-and-forget settle

    expect(fsState.files.has(file)).toBe(false)
    expect(pg.calls.some((c) => c.includes('DELETE FROM app_state WHERE key ='))).toBe(true)
  })

  it('retries a failed delete on the next flush rather than dropping it', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    // The database rejects the delete — an outage mid-delete.
    pg.throwOn = 'DELETE FROM app_state'
    const file = join(DATA_ROOT, 'stubborn.json')
    fsState.files.set(file, JSON.stringify({ x: 1 }))
    stateStore.deleteJson(file)
    await new Promise((r) => setImmediate(r))

    const attemptsWhileDown = pg.calls.filter((c) => c.includes('DELETE FROM app_state')).length
    expect(attemptsWhileDown).toBeGreaterThan(0)

    // Database comes back; any subsequent write drags the pending delete along.
    pg.throwOn = null
    stateStore.writeJson(join(DATA_ROOT, 'other.json'), { y: 2 })
    await new Promise((r) => setImmediate(r))

    // If the tombstone had been dropped, the row would survive and the next boot's
    // reconcile would write the file back — the resurrection this exists to prevent.
    expect(pg.calls.filter((c) => c.includes('DELETE FROM app_state')).length)
      .toBeGreaterThan(attemptsWhileDown)
  })
})

// ── Flush failure ──────────────────────────────────────────────────────────

describe('flush failure handling', () => {
  it('records the error and keeps the value queued instead of losing it', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    pg.throwOn = 'INSERT INTO app_state'
    stateStore.writeJson(join(DATA_ROOT, 'queued.json'), { v: 1 })
    await new Promise((r) => setImmediate(r))

    const status = stateStore.status()
    expect(status.error).toMatch(/simulated pg failure/)
    expect(status.queued).toBeGreaterThan(0)
    // The file half of the write still succeeded — Postgres is the backup, not the truth.
    expect(fsState.files.has(join(DATA_ROOT, 'queued.json'))).toBe(true)
  })
})

// ── Shutdown ───────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('closes the connection and reports disconnected', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()
    expect(stateStore.status().connected).toBe(true)

    await stateStore.stop()
    expect(stateStore.status().connected).toBe(false)
  })

  it('does not throw when a final flush fails on the way down', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    stateStore.writeJson(join(DATA_ROOT, 'last.json'), { v: 1 })
    pg.throwOn = 'INSERT INTO app_state'
    await expect(stateStore.stop()).resolves.toBeUndefined()
  })

  it('is safe to call without ever having connected', async () => {
    const { stateStore } = await freshModule()
    await expect(stateStore.stop()).resolves.toBeUndefined()
  })
})

// ── Relational writes ──────────────────────────────────────────────────────

describe('run persistence', () => {
  const run = {
    id: 'r1', component: 'crypto', label: 'swing scan', trigger: 'interval',
    startedAt: 1_000, endedAt: null, state: 'running', summary: '',
  }

  it('upserts a run so the finishing edge updates the same row', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    await stateStore.saveRun(run)
    await stateStore.saveRun({ ...run, endedAt: 2_000, state: 'ok', summary: 'done' })

    const inserts = pg.calls.filter((c) => c.includes('INSERT INTO agent_runs'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0]).toContain('ON CONFLICT (id) DO UPDATE SET')
  })

  it('swallows a write failure rather than taking the run down with it', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    pg.throwOn = 'INSERT INTO agent_runs'
    await expect(stateStore.saveRun(run)).resolves.toBeUndefined()
  })

  it('is a no-op in file-only mode', async () => {
    const { stateStore } = await freshModule()
    await expect(stateStore.saveRun(run)).resolves.toBeUndefined()
    expect(pg.calls).toHaveLength(0)
  })

  it('readRuns returns rows when connected and [] when the query fails', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    pg.responses.set('FROM agent_runs', [{ id: 'r1' }])
    const { stateStore } = await freshModule()
    await stateStore.start()

    expect([...await stateStore.readRuns(0, 9_999)]).toEqual([{ id: 'r1' }])

    pg.throwOn = 'FROM agent_runs'
    expect(await stateStore.readRuns(0, 9_999)).toEqual([])
  })

  it('readRuns returns [] in file-only mode', async () => {
    const { stateStore } = await freshModule()
    expect(await stateStore.readRuns(0, 1)).toEqual([])
  })

  it('readAuditWindow returns rows when connected and [] when the query fails', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    pg.responses.set('FROM audit_log', [{ actor: 'operator' }])
    const { stateStore } = await freshModule()
    await stateStore.start()

    expect([...await stateStore.readAuditWindow(0, 9_999)]).toEqual([{ actor: 'operator' }])

    pg.throwOn = 'FROM audit_log'
    expect(await stateStore.readAuditWindow(0, 9_999)).toEqual([])
  })
})

describe('saveClosedTrades', () => {
  const trade = { id: 'c1', symbol: 'BTCUSD', realizedUsd: 12.5, closedAt: 5_000 }

  it('writes each row and counts them', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    expect(await stateStore.saveClosedTrades([trade, { ...trade, id: 'c2' }])).toBe(2)
    expect(pg.calls.filter((c) => c.includes('INSERT INTO closed_trades'))).toHaveLength(2)
  })

  it('stops at the first failure and reports how many landed', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    pg.throwOn = 'INSERT INTO closed_trades'
    expect(await stateStore.saveClosedTrades([trade])).toBe(0)
  })

  it('short-circuits on an empty list and in file-only mode', async () => {
    const { stateStore } = await freshModule()
    expect(await stateStore.saveClosedTrades([])).toBe(0)
    expect(await stateStore.saveClosedTrades([trade])).toBe(0)
    expect(pg.calls).toHaveLength(0)
  })
})

describe('savePortfolioHistory', () => {
  const point = { at: 1_000, btc: 0.5, usd: 100, totalUsd: 30_100, btcPrice: 60_000 }

  it('inserts one row per point', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    await stateStore.savePortfolioHistory([point, { ...point, at: 2_000 }])
    expect(pg.calls.filter((c) => c.includes('INSERT INTO portfolio_history'))).toHaveLength(2)
  })

  it('swallows a write failure', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake/db')
    pg.responses.set('SELECT key, value FROM app_state', [])
    const { stateStore } = await freshModule()
    await stateStore.start()

    pg.throwOn = 'INSERT INTO portfolio_history'
    await expect(stateStore.savePortfolioHistory([point])).resolves.toBeUndefined()
  })

  it('short-circuits on an empty series and in file-only mode', async () => {
    const { stateStore } = await freshModule()
    await stateStore.savePortfolioHistory([])
    await stateStore.savePortfolioHistory([point])
    expect(pg.calls).toHaveLength(0)
  })
})
