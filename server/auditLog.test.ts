import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { adminTokenMatches, canonicalJson, deriveActor, GENESIS_HASH } from '../shared/audit'
import type { AuditEntry } from '../shared/audit'

// The log recovers its chain head from disk at first use, so every test needs a
// fresh module instance (vi.resetModules + dynamic import) over a controllable
// virtual filesystem. The mock is a plain path -> contents map implementing the
// four fs calls auditLog.ts makes; appendFileSync concatenates, matching real
// append semantics, which is what the chain-continuation tests depend on.
const fsState = vi.hoisted(() => ({ files: new Map<string, string>(), failWrites: false }))

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => fsState.files.has(p) || [...fsState.files.keys()].some((f) => f.startsWith(p + '/'))),
  readFileSync: vi.fn((p: string) => {
    const v = fsState.files.get(p)
    if (v === undefined) throw new Error(`ENOENT: ${p}`)
    return v
  }),
  appendFileSync: vi.fn((p: string, data: string) => {
    if (fsState.failWrites) throw new Error('EACCES: disk is read-only')
    fsState.files.set(p, (fsState.files.get(p) ?? '') + data)
  }),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn((dir: string) => (
    [...fsState.files.keys()]
      .filter((f) => f.startsWith(dir + '/'))
      .map((f) => f.slice(dir.length + 1))
  )),
}))

const AUDIT_DIR = join(process.cwd(), 'data', 'audit')
const fileFor = (month: string) => join(AUDIT_DIR, `audit-${month}.jsonl`)

function seed(month: string, entries: AuditEntry[]): void {
  fsState.files.set(fileFor(month), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function linesOf(month: string): AuditEntry[] {
  return (fsState.files.get(fileFor(month)) ?? '')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditEntry)
}

/** Every entry written, across all months, oldest first. */
function allEntries(): AuditEntry[] {
  return [...fsState.files.keys()].sort()
    .flatMap((f) => (fsState.files.get(f) ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditEntry))
}

beforeEach(() => {
  vi.resetModules()
  fsState.files.clear()
  fsState.failWrites = false
  vi.restoreAllMocks()
})

async function freshModule() {
  return import('./auditLog')
}

const sample = {
  actor: 'operator' as const,
  origin: 'http' as const,
  action: 'strategy.settings.set',
  resource: 'strategy:sniper',
  summary: 'changed rsiMax',
}

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('sorts keys recursively and preserves array order', () => {
    expect(canonicalJson({ z: { d: 1, c: [3, 1, 2] } })).toBe('{"z":{"c":[3,1,2],"d":1}}')
  })

  it('omits undefined members so an absent field cannot change the hash', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('deriveActor', () => {
  it('defaults to operator when the header is absent or empty', () => {
    expect(deriveActor(undefined)).toBe('operator')
    expect(deriveActor('   ')).toBe('operator')
  })

  it('accepts well-formed agent and skill actors', () => {
    expect(deriveActor('agent:ag_123')).toBe('agent:ag_123')
    expect(deriveActor('skill:fast-cash')).toBe('skill:fast-cash')
  })

  it('refuses to let an HTTP caller pose as system automation', () => {
    expect(deriveActor('system')).toBe('operator')
  })

  it('rejects malformed actors rather than trusting them', () => {
    expect(deriveActor('agent:bad id')).toBe('operator')
    expect(deriveActor('root')).toBe('operator')
    expect(deriveActor('skill:' + 'x'.repeat(65))).toBe('operator')
  })

  it('takes the first value when a header arrives repeated', () => {
    expect(deriveActor(['skill:sniper', 'operator'])).toBe('skill:sniper')
  })
})

describe('record', () => {
  it('writes a genesis entry with seq 1 and the genesis prevHash', async () => {
    const m = await freshModule()
    const entry = m.auditLog.record(sample)!
    expect(entry.seq).toBe(1)
    expect(entry.prevHash).toBe(GENESIS_HASH)
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(allEntries()).toHaveLength(1)
  })

  it('chains each entry to the hash of the one before it', async () => {
    const m = await freshModule()
    const a = m.auditLog.record(sample)!
    const b = m.auditLog.record({ ...sample, action: 'agent.update' })!
    expect(b.seq).toBe(2)
    expect(b.prevHash).toBe(a.hash)
  })

  it('appends rather than rewriting the file', async () => {
    const m = await freshModule()
    m.auditLog.record(sample)
    m.auditLog.record(sample)
    m.auditLog.record(sample)
    expect(allEntries().map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('carries before/after snapshots through to disk', async () => {
    const m = await freshModule()
    m.auditLog.record({ ...sample, before: { rsiMax: 35 }, after: { rsiMax: 30 } })
    expect(allEntries()[0]).toMatchObject({ before: { rsiMax: 35 }, after: { rsiMax: 30 } })
  })

  it('never throws when the write fails, so business logic is unaffected', async () => {
    const m = await freshModule()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    fsState.failWrites = true
    expect(() => m.auditLog.record(sample)).not.toThrow()
    expect(m.auditLog.record(sample)).toBeUndefined()
    expect(errors).toHaveBeenCalled()
  })
})

describe('startup recovery', () => {
  it('continues the chain from an existing file instead of restarting at seq 1', async () => {
    const first = await freshModule()
    const a = first.auditLog.record(sample)!
    const b = first.auditLog.record(sample)!

    vi.resetModules()
    const restarted = await freshModule()
    const c = restarted.auditLog.record(sample)!
    expect(c.seq).toBe(3)
    expect(c.prevHash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
    expect((await restarted.auditLog.verify()).ok).toBe(true)
  })

  it('warns about a torn trailing line and chains from the last valid entry', async () => {
    const seeded = await freshModule()
    const a = seeded.auditLog.record(sample)!
    const month = a.ts.slice(0, 7)
    fsState.files.set(fileFor(month), fsState.files.get(fileFor(month))! + '{"seq":2,"partial')

    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const restarted = await freshModule()
    const next = restarted.auditLog.record(sample)!
    expect(warn).toHaveBeenCalled()
    expect(next.seq).toBe(2)
    expect(next.prevHash).toBe(a.hash)
    // The torn line stays on disk as evidence, and verify still reports it.
    expect((await restarted.auditLog.verify()).ok).toBe(false)
  })
})

describe('monthly rotation', () => {
  it('continues both the hash chain and seq across a new month file', async () => {
    const m = await freshModule()
    const july = m.auditLog.record({ ...sample, ts: '2026-07-31T23:59:00.000Z' })!
    const august = m.auditLog.record({ ...sample, ts: '2026-08-01T00:01:00.000Z' })!

    expect(linesOf('2026-07')).toHaveLength(1)
    expect(linesOf('2026-08')).toHaveLength(1)
    expect(august.seq).toBe(2)
    expect(august.prevHash).toBe(july.hash)
    expect(await m.auditLog.verify()).toMatchObject({ ok: true, entries: 2 })
  })

  it('recovers from the newest month file after a restart', async () => {
    const m = await freshModule()
    m.auditLog.record({ ...sample, ts: '2026-07-31T23:59:00.000Z' })
    const august = m.auditLog.record({ ...sample, ts: '2026-08-01T00:01:00.000Z' })!

    vi.resetModules()
    const restarted = await freshModule()
    const next = restarted.auditLog.record({ ...sample, ts: '2026-08-02T00:00:00.000Z' })!
    expect(next.seq).toBe(3)
    expect(next.prevHash).toBe(august.hash)
  })
})

describe('verify', () => {
  it('passes on an untouched chain', async () => {
    const m = await freshModule()
    m.auditLog.record(sample)
    m.auditLog.record(sample)
    expect(await m.auditLog.verify()).toMatchObject({ ok: true, entries: 2 })
  })

  it('passes on an empty log', async () => {
    const m = await freshModule()
    expect(await m.auditLog.verify()).toMatchObject({ ok: true, entries: 0 })
  })

  it('detects a field edited after the fact', async () => {
    const m = await freshModule()
    m.auditLog.record(sample)
    m.auditLog.record({ ...sample, summary: 'original' })
    const month = allEntries()[0]!.ts.slice(0, 7)
    const rows = linesOf(month)
    rows[1]!.summary = 'tampered'
    seed(month, rows)

    const result = await m.auditLog.verify()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(2)
    expect(result.reason).toMatch(/altered/)
  })

  it('detects a deleted line', async () => {
    const m = await freshModule()
    m.auditLog.record(sample)
    m.auditLog.record(sample)
    m.auditLog.record(sample)
    const month = allEntries()[0]!.ts.slice(0, 7)
    const rows = linesOf(month)
    seed(month, [rows[0]!, rows[2]!])

    const result = await m.auditLog.verify()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(3)
    expect(result.reason).toMatch(/sequence gap/)
  })

  it('detects a re-hashed entry whose link to its predecessor no longer holds', async () => {
    const m = await freshModule()
    m.auditLog.record(sample)
    m.auditLog.record(sample)
    const month = allEntries()[0]!.ts.slice(0, 7)
    const rows = linesOf(month)
    // A forger who edits an entry AND recomputes its own hash still cannot fix
    // prevHash without rewriting every entry before it.
    rows[1]!.summary = 'tampered'
    rows[1]!.prevHash = 'f'.repeat(64)
    rows[1]!.hash = 'e'.repeat(64)
    seed(month, rows)

    const result = await m.auditLog.verify()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(2)
    expect(result.reason).toMatch(/broken link/)
  })

  it('reports a torn write', async () => {
    const m = await freshModule()
    const a = m.auditLog.record(sample)!
    const month = a.ts.slice(0, 7)
    fsState.files.set(fileFor(month), fsState.files.get(fileFor(month))! + '{"seq":2,"tr')
    expect(await m.auditLog.verify()).toMatchObject({ ok: false, reason: expect.stringMatching(/torn/) })
  })
})

describe('read', () => {
  async function seeded() {
    const m = await freshModule()
    m.auditLog.record({ ...sample, actor: 'operator', action: 'trade.stage', resource: 'trade:1', ts: '2026-08-01T00:00:00.000Z' })
    m.auditLog.record({ ...sample, actor: 'agent:ag_1', action: 'agent.update', resource: 'agent:ag_1', ts: '2026-08-02T00:00:00.000Z' })
    m.auditLog.record({ ...sample, actor: 'skill:sniper', action: 'strategy.settings.set', resource: 'strategy:sniper', ts: '2026-08-03T00:00:00.000Z' })
    return m
  }

  it('returns entries newest first', async () => {
    const m = await seeded()
    expect((await m.auditLog.read()).map((e) => e.seq)).toEqual([3, 2, 1])
  })

  it('filters by actor', async () => {
    const m = await seeded()
    expect((await m.auditLog.read({ actor: 'agent:ag_1' })).map((e) => e.seq)).toEqual([2])
  })

  it('filters by resource', async () => {
    const m = await seeded()
    expect((await m.auditLog.read({ resource: 'strategy:sniper' })).map((e) => e.seq)).toEqual([3])
  })

  it('matches action by prefix so a family can be filtered at once', async () => {
    const m = await seeded()
    expect((await m.auditLog.read({ action: 'strategy.' })).map((e) => e.seq)).toEqual([3])
  })

  it('filters by time range', async () => {
    const m = await seeded()
    const got = await m.auditLog.read({ since: '2026-08-02T00:00:00.000Z', until: '2026-08-02T23:59:59.999Z' })
    expect(got.map((e) => e.seq)).toEqual([2])
  })

  it('pages with a seq cursor', async () => {
    const m = await seeded()
    const page1 = await m.auditLog.read({ limit: 2 })
    expect(page1.map((e) => e.seq)).toEqual([3, 2])
    const page2 = await m.auditLog.read({ limit: 2, before: page1[page1.length - 1]!.seq })
    expect(page2.map((e) => e.seq)).toEqual([1])
  })

  it('reads across month files', async () => {
    const m = await freshModule()
    m.auditLog.record({ ...sample, ts: '2026-07-15T00:00:00.000Z' })
    m.auditLog.record({ ...sample, ts: '2026-08-15T00:00:00.000Z' })
    expect((await m.auditLog.read()).map((e) => e.seq)).toEqual([2, 1])
  })
})

describe('actor context', () => {
  it('defaults to system outside any request or run', async () => {
    const m = await freshModule()
    expect(m.currentActor()).toBe('system')
  })

  it('carries the actor through nested async work', async () => {
    const m = await freshModule()
    const seen = await m.withActor('skill:trapline', async () => {
      await Promise.resolve()
      return m.currentActor()
    })
    expect(seen).toBe('skill:trapline')
  })

  it('restores the previous actor after the scope ends', async () => {
    const m = await freshModule()
    m.withActor('agent:ag_9', () => expect(m.currentActor()).toBe('agent:ag_9'))
    expect(m.currentActor()).toBe('system')
  })

  it('note() attributes to the ambient actor', async () => {
    const m = await freshModule()
    const entry = m.withActor('agent:ag_9', () =>
      m.auditLog.note({ action: 'agent.proposal', resource: 'agent:ag_9', summary: 'staged BTC' })
    )!
    expect(entry.actor).toBe('agent:ag_9')
    expect(entry.origin).toBe('internal')
  })
})

describe('listFiles', () => {
  it('reports the seq span held in each file', async () => {
    const m = await freshModule()
    m.auditLog.record({ ...sample, ts: '2026-07-15T00:00:00.000Z' })
    m.auditLog.record({ ...sample, ts: '2026-08-15T00:00:00.000Z' })
    m.auditLog.record({ ...sample, ts: '2026-08-16T00:00:00.000Z' })
    expect(m.auditLog.listFiles()).toEqual([
      { file: fileFor('2026-07'), entries: 1, firstSeq: 1, lastSeq: 1 },
      { file: fileFor('2026-08'), entries: 2, firstSeq: 2, lastSeq: 3 },
    ])
  })
})

describe('adminTokenMatches', () => {
  it('never matches when no admin token is configured, whatever is presented', () => {
    expect(adminTokenMatches('', '')).toBe(false)
    expect(adminTokenMatches('anything', '')).toBe(false)
  })

  it('matches only the exact secret', () => {
    expect(adminTokenMatches('s3cret', 's3cret')).toBe(true)
    expect(adminTokenMatches('s3creT', 's3cret')).toBe(false)
    expect(adminTokenMatches('s3cre', 's3cret')).toBe(false)
    expect(adminTokenMatches('s3cret ', 's3cret')).toBe(false)
  })
})

describe('postgres mirror (file-only path)', () => {
  // These run with DATABASE_URL unset, which is the app's documented "optional
  // Postgres" state. The DB-connected behaviour — trigger enforcement, backfill
  // after an outage, and file/table divergence detection — is exercised against
  // a real database, since mocking a driver would only prove the mock works.
  const saved = process.env['DATABASE_URL']
  beforeEach(() => { delete process.env['DATABASE_URL'] })
  afterAll(() => { if (saved !== undefined) process.env['DATABASE_URL'] = saved })

  it('reports not connected when DATABASE_URL is unset', async () => {
    const m = await freshModule()
    await m.auditLog.start()
    expect(m.auditLog.dbStatus()).toMatchObject({ connected: false })
  })

  it('still records to the file with no database configured', async () => {
    const m = await freshModule()
    await m.auditLog.start()
    const entry = m.auditLog.record(sample)
    expect(entry?.seq).toBe(1)
    expect(allEntries()).toHaveLength(1)
  })

  it('serves reads and verification from the file when there is no database', async () => {
    const m = await freshModule()
    await m.auditLog.start()
    m.auditLog.record(sample)
    expect((await m.auditLog.read()).map((e) => e.seq)).toEqual([1])
    const v = await m.auditLog.verify()
    expect(v).toMatchObject({ ok: true, entries: 1 })
    // No db block at all, rather than a passing one — absence is the signal the
    // UI keys off to say "file-only" instead of claiming the mirror is healthy.
    expect(v.db).toBeUndefined()
  })
})
