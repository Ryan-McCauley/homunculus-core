import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SyncManifest } from '../shared/sync'

// The module resolves its data dir and reads its config at import time, so every
// test gets a fresh temp tree and a fresh module — same approach as
// screenerStore.test.ts, for the same reason.

const audit = vi.hoisted(() => ({ record: vi.fn(), note: vi.fn() }))

vi.mock('./auditLog', () => ({
  auditLog: audit,
  withActor: <T,>(_actor: string, fn: () => T) => fn(),
  currentActor: () => 'operator'
}))

// stateStore is the JSON read/write seam everywhere else in the server; keep it
// real-but-simple here so sync.json round-trips through actual disk.
vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: <T,>(file: string, fallback: T): T => {
      try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
    },
    writeJson: (file: string, value: unknown): void => {
      writeFileSync(file, JSON.stringify(value, null, 2))
    }
  }
}))

let dir = ''
type SyncModule = typeof import('./sync')
let sync: SyncModule

function write(rel: string, body: string, mtimeMs?: number): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
  if (mtimeMs !== undefined) utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000)
}

async function loadModule(config?: unknown): Promise<SyncModule> {
  if (config !== undefined) writeFileSync(join(dir, 'sync.json'), JSON.stringify(config))
  vi.resetModules()
  return await import('./sync')
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homunculus-sync-'))
  vi.stubEnv('HOMUNCULUS_DATA_DIR', dir)
  audit.note.mockClear()
  sync = await loadModule()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

// ── manifest ───────────────────────────────────────────────────────────────

describe('buildManifest', () => {
  it('hashes every file in the enabled areas and nothing else', async () => {
    write('layout.json', '{"tabs":[]}')
    write('crypto/trades.json', '[]')
    write('finance/budget.json', '{}')
    sync = await loadModule({ areas: ['layout', 'crypto'], peers: [] })

    const m = sync.buildManifest()
    expect(m.files.map((f) => f.path)).toEqual(['crypto/trades.json', 'layout.json'])
    expect(m.files[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(m.files.find((f) => f.path === 'layout.json')?.size).toBe(11)
  })

  it('skips excluded junk inside an enabled area', async () => {
    write('crypto/trades.json', '[]')
    write('crypto/.DS_Store', 'x')
    write('crypto/candle-cache.json', '{}')
    write('crypto/trades.20260721T000000Z.bak.json', '[]')
    sync = await loadModule({ areas: ['crypto'], peers: [] })

    expect(sync.buildManifest().files.map((f) => f.path)).toEqual(['crypto/trades.json'])
  })

  it('never lists sync.json — it holds this node peer tokens', async () => {
    sync = await loadModule({ areas: ['layout', 'crypto'], peers: [{ id: 'a', url: 'http://x:8787' }] })
    expect(sync.buildManifest().files.map((f) => f.path)).not.toContain('sync.json')
  })

  it('narrows to the requested areas but never widens past the configured ones', async () => {
    write('layout.json', '{}')
    write('crypto/trades.json', '[]')
    write('finance/budget.json', '{}')
    sync = await loadModule({ areas: ['layout', 'crypto'], peers: [] })

    expect(sync.buildManifest(['crypto']).files.map((f) => f.path)).toEqual(['crypto/trades.json'])
    // A peer asking for FINANCE gets nothing: it is off here.
    expect(sync.buildManifest(['finance']).files).toEqual([])
  })

  it('reports mtime in epoch ms so the diff can compare across nodes', async () => {
    write('layout.json', '{}', 1_700_000_000_000)
    sync = await loadModule({ areas: ['layout'], peers: [] })
    expect(sync.buildManifest().files[0]?.mtime).toBe(1_700_000_000_000)
  })
})

// ── path safety ────────────────────────────────────────────────────────────

describe('resolveSyncPath', () => {
  it('resolves ordinary paths under the data dir', () => {
    expect(sync.resolveSyncPath('crypto/trades.json')).toBe(join(dir, 'crypto/trades.json'))
  })

  it('refuses to leave the data dir', () => {
    for (const bad of ['../secrets.json', 'crypto/../../etc/passwd', '/etc/passwd', 'crypto\\x.json', '']) {
      expect(sync.resolveSyncPath(bad), bad).toBeNull()
    }
  })
})

describe('readSyncFile', () => {
  it('returns base64 content and the mtime', async () => {
    write('layout.json', '{"tabs":[]}', 1_700_000_000_000)
    sync = await loadModule({ areas: ['layout'], peers: [] })

    const got = sync.readSyncFile('layout.json')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(Buffer.from(got.content, 'base64').toString()).toBe('{"tabs":[]}')
    expect(got.mtime).toBe(1_700_000_000_000)
  })

  it('refuses traversal, unclaimed paths, and areas this node has switched off', async () => {
    write('finance/budget.json', '{}')
    sync = await loadModule({ areas: ['layout'], peers: [] })

    expect(sync.readSyncFile('../../etc/passwd')).toEqual({ ok: false, error: 'unsafe path' })
    expect(sync.readSyncFile('mystery.txt')).toEqual({ ok: false, error: 'path is not in any sync area' })
    expect(sync.readSyncFile('finance/budget.json'))
      .toEqual({ ok: false, error: 'area finance is not enabled on this node' })
  })

  it('refuses to serve its own sync.json', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [] })
    expect(sync.readSyncFile('sync.json').ok).toBe(false)
  })
})

describe('writeSyncFile', () => {
  it('creates missing directories and stamps the source mtime, not now()', async () => {
    sync = await loadModule({ areas: ['office'], peers: [] })
    const at = 1_600_000_000_000

    const r = sync.writeSyncFile('crypto/office/blockers.json', Buffer.from('[]').toString('base64'), at)
    expect(r).toEqual({ ok: true })

    const abs = join(dir, 'crypto/office/blockers.json')
    expect(readFileSync(abs, 'utf8')).toBe('[]')
    // Preserved mtime is what stops the next run pushing these bytes straight back.
    expect(Math.round(statSync(abs).mtimeMs)).toBe(at)
  })

  it('leaves no temp file behind', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [] })
    sync.writeSyncFile('layout.json', Buffer.from('{}').toString('base64'), 1_600_000_000_000)
    expect(sync.buildManifest().files.map((f) => f.path)).toEqual(['layout.json'])
  })

  it('refuses traversal and disabled areas', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [] })
    const payload = Buffer.from('pwned').toString('base64')

    expect(sync.writeSyncFile('../evil.json', payload, 1)).toEqual({ ok: false, error: 'unsafe path' })
    expect(sync.writeSyncFile('crypto/trades.json', payload, 1))
      .toEqual({ ok: false, error: 'area crypto is not enabled on this node' })
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('getSyncConfig / setSyncConfig', () => {
  it('stores a peer token but never hands it back', async () => {
    sync.setSyncConfig({ peers: [{ id: 'desk', label: 'Desk PC', url: 'desk-pc:8787', token: 'sekrit' }] })

    const view = sync.getSyncConfig()
    expect(view.peers[0]).toEqual({
      id: 'desk', label: 'Desk PC', url: 'http://desk-pc:8787', enabled: true, hasToken: true
    })
    expect(JSON.stringify(view)).not.toContain('sekrit')
  })

  it('keeps the stored token when a later save omits it', async () => {
    sync.setSyncConfig({ peers: [{ id: 'desk', url: 'desk-pc:8787', token: 'sekrit' }] })
    sync.setSyncConfig({ peers: [{ id: 'desk', url: 'desk-pc:8787', label: 'Renamed' }] })

    expect(sync.getSyncConfig().peers[0]?.hasToken).toBe(true)
    expect(sync.getSyncConfig().peers[0]?.label).toBe('Renamed')
  })

  it('clears a token on request and drops tokens for removed peers', async () => {
    sync.setSyncConfig({ peers: [{ id: 'desk', url: 'desk-pc:8787', token: 'sekrit' }] })
    sync.setSyncConfig({ peers: [{ id: 'desk', url: 'desk-pc:8787', clearToken: true }] })
    expect(sync.getSyncConfig().peers[0]?.hasToken).toBe(false)

    sync.setSyncConfig({ peers: [{ id: 'desk', url: 'desk-pc:8787', token: 'sekrit' }] })
    sync.setSyncConfig({ peers: [] })
    expect(readFileSync(join(dir, 'sync.json'), 'utf8')).not.toContain('sekrit')
  })

  it('survives a restart', async () => {
    sync.setSyncConfig({ peers: [{ id: 'desk', url: 'desk-pc:8787', token: 't' }], areas: ['crypto'] })
    const reloaded = await loadModule()
    expect(reloaded.getSyncConfig().areas).toEqual(['crypto'])
    expect(reloaded.getSyncConfig().peers[0]?.hasToken).toBe(true)
  })
})

// ── the run ────────────────────────────────────────────────────────────────

/** A peer backend in a variable: manifest + file store, served over stubbed fetch. */
function fakePeer(files: Record<string, { body: string; mtime: number }>) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const manifestOf = (): SyncManifest => ({
    node: 'peer', at: 0, areas: ['layout', 'crypto', 'office'],
    files: Object.entries(files).map(([path, f]) => ({
      path, size: f.body.length, mtime: f.mtime,
      hash: createHash('sha256').update(f.body).digest('hex')
    }))
  })

  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })

    const json = (payload: unknown): Response =>
      ({ ok: true, status: 200, json: async () => payload }) as Response

    if (parsed.pathname === '/api/sync/manifest') return json({ ok: true, manifest: manifestOf() })
    if (parsed.pathname === '/api/sync/file' && method === 'GET') {
      const path = parsed.searchParams.get('path') ?? ''
      const f = files[path]
      if (!f) return json({ ok: false, error: 'not found' })
      return json({ ok: true, content: Buffer.from(f.body).toString('base64'), mtime: f.mtime })
    }
    if (parsed.pathname === '/api/sync/file' && method === 'POST') {
      files[body.path] = { body: Buffer.from(body.content, 'base64').toString(), mtime: body.mtime }
      return json({ ok: true })
    }
    return ({ ok: false, status: 404, json: async () => ({ ok: false }) }) as Response
  })

  return { files, calls, fetchStub }
}

describe('runSync', () => {
  const PEER = { id: 'desk', label: 'desk-pc', url: 'http://desk-pc:8787', token: 't' }

  // Sentinel mtimes below stay under 2^32 seconds (~year 2106). write() round-trips
  // a given ms through utimesSync, and on Windows a value past that wraps silently
  // instead of erroring — e.g. 9_000_000_000_000 ms (~year 2255) came back out of a
  // real stat() as 410_065_408_000, which read as OLDER than the peer's honest
  // (mock, not filesystem-backed) mtime and made this test pull a file it should
  // have pushed. 1_700_000_000_000 elsewhere in this file (~year 2023) has always
  // been safe; these just needed to be brought under the same ceiling.
  it('pulls what the peer has newer and pushes what we have newer, in one run', async () => {
    write('layout.json', 'LOCAL-NEW', 2_100_000_000_000)
    write('crypto/trades.json', 'LOCAL-OLD', 1_000_000_000_000)
    sync = await loadModule({ areas: ['layout', 'crypto'], peers: [PEER], tokens: { desk: 't' } })

    const peer = fakePeer({
      'layout.json': { body: 'PEER-OLD', mtime: 1_000_000_000_000 },
      'crypto/trades.json': { body: 'PEER-NEW', mtime: 2_100_000_000_000 },
      'crypto/cost-basis.json': { body: 'ONLY-ON-PEER', mtime: 1_900_000_000_000 }
    })
    vi.stubGlobal('fetch', peer.fetchStub)

    const report = await sync.runSync()
    const r = report.peers[0]

    expect(r?.ok).toBe(true)
    expect(r?.pulled).toBe(2)   // trades.json (newer) + cost-basis.json (absent here)
    expect(r?.pushed).toBe(1)   // layout.json
    expect(r?.failed).toEqual([])

    expect(readFileSync(join(dir, 'crypto/trades.json'), 'utf8')).toBe('PEER-NEW')
    expect(readFileSync(join(dir, 'crypto/cost-basis.json'), 'utf8')).toBe('ONLY-ON-PEER')
    expect(peer.files['layout.json']?.body).toBe('LOCAL-NEW')
  })

  it('converges — a second run straight after transfers nothing', async () => {
    write('layout.json', 'LOCAL-NEW', 2_100_000_000_000)
    sync = await loadModule({ areas: ['layout'], peers: [PEER], tokens: { desk: 't' } })
    const peer = fakePeer({ 'layout.json': { body: 'PEER-OLD', mtime: 1_000_000_000_000 } })
    vi.stubGlobal('fetch', peer.fetchStub)

    await sync.runSync()
    const second = await sync.runSync()

    expect(second.peers[0]?.pulled).toBe(0)
    expect(second.peers[0]?.pushed).toBe(0)
    expect(second.peers[0]?.identical).toBe(1)
  })

  it('deletes nothing — a file only this node has is pushed, not removed', async () => {
    write('layout.json', 'ONLY-LOCAL', 1_900_000_000_000)
    sync = await loadModule({ areas: ['layout'], peers: [PEER], tokens: { desk: 't' } })
    const peer = fakePeer({})
    vi.stubGlobal('fetch', peer.fetchStub)

    await sync.runSync()
    expect(readFileSync(join(dir, 'layout.json'), 'utf8')).toBe('ONLY-LOCAL')
    expect(peer.files['layout.json']?.body).toBe('ONLY-LOCAL')
  })

  it('sends the peer token as a header', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [PEER], tokens: { desk: 'sekrit' } })
    const peer = fakePeer({})
    vi.stubGlobal('fetch', peer.fetchStub)

    await sync.runSync()
    const headers = (peer.fetchStub.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers['x-homunculus-token']).toBe('sekrit')
  })

  it('reports an unreachable peer instead of throwing', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [PEER], tokens: {} })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const report = await sync.runSync()
    expect(report.peers[0]?.ok).toBe(false)
    expect(report.peers[0]?.error).toBe('ECONNREFUSED')
  })

  it('explains a 401 in terms of the token', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [PEER], tokens: {} })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response))

    expect((await sync.runSync()).peers[0]?.error).toContain('HOMUNCULUS_TOKEN')
  })

  it('skips disabled peers and records the run in the audit log', async () => {
    sync = await loadModule({
      areas: ['layout'],
      peers: [{ ...PEER, enabled: false }],
      tokens: { desk: 't' }
    })
    const peer = fakePeer({})
    vi.stubGlobal('fetch', peer.fetchStub)

    const report = await sync.runSync()
    expect(report.peers).toEqual([])
    expect(peer.fetchStub).not.toHaveBeenCalled()
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync.run' }))
  })

  it('stamps lastRunAt so Settings can show when the nodes last agreed', async () => {
    sync = await loadModule({ areas: ['layout'], peers: [], tokens: {} })
    expect(sync.getSyncConfig().lastRunAt).toBe(0)
    await sync.runSync()
    expect(sync.getSyncConfig().lastRunAt).toBeGreaterThan(0)
  })
})
