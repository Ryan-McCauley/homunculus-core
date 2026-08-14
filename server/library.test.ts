import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { MAX_ARTIFACT_BYTES, type NewArtifactInput } from '../shared/library'

// `library` is a module-level singleton that loads every *.json in LIBRARY_DIR at
// construction time via raw fs (existsSync/readdirSync) + stateStore.readJson, and
// persists through stateStore.writeJson + a raw writeFileSync markdown mirror. Each
// test needs a fresh singleton over a controllable virtual fs/store — same shape as
// cryptoAlerts.test.ts and cryptoStrategySettings.test.ts.
const LIBRARY_DIR = join(process.cwd(), 'data', 'crypto', 'office', 'library')

const fsState = vi.hoisted(() => ({
  exists: false,
  files: new Map<string, string>(), // basename -> markdown content (writeFileSync)
  removed: new Set<string>(),
}))
const store = vi.hoisted(() => ({ map: new Map<string, unknown>() }))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  mkdirSync: vi.fn(() => { fsState.exists = true }),
  readdirSync: vi.fn(() => {
    // Directory listing is derived from whatever *.json keys exist in the store map,
    // matching how the real Library reads its own persisted state back at boot.
    return [...store.map.keys()]
      .filter((k) => k.startsWith(LIBRARY_DIR))
      .map((k) => k.slice(LIBRARY_DIR.length + 1))
  }),
  writeFileSync: vi.fn((path: string, data: string) => { fsState.files.set(path, data) }),
  rmSync: vi.fn((path: string) => { fsState.files.delete(path); fsState.removed.add(path) }),
}))

vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (store.map.has(file) ? store.map.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { store.map.set(file, value) }),
    deleteJson: vi.fn((file: string) => { store.map.delete(file) }),
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists = false
  fsState.files.clear()
  fsState.removed.clear()
  store.map.clear()
})

async function freshLibrary() {
  const mod = await import('./library')
  return mod.library
}

const noteInput = (over: Partial<NewArtifactInput> = {}): NewArtifactInput => ({
  title: 'Base rates for oversold bounces',
  body: 'the body',
  ...over,
})

describe('constructor load', () => {
  it('starts empty when the library directory does not exist', async () => {
    const lib = await freshLibrary()
    expect(lib.list()).toHaveLength(0)
  })

  it('loads previously persisted artifacts on construction', async () => {
    fsState.exists = true
    const rec = {
      id: 'abc-123', title: 'Prior Research', kind: 'research', format: 'markdown',
      authorId: 'operator', createdAt: 1, updatedAt: 1, revision: 1, summary: '', tags: [],
      symbols: [], body: 'hello', resolvesAt: null, outcome: 'none', resolution: '',
      supersedes: null, pinned: false,
    }
    store.map.set(join(LIBRARY_DIR, 'prior-research-abc-123.json'), rec)
    const lib = await freshLibrary()
    expect(lib.get('abc-123')).toEqual(rec)
  })

  it('skips a non-json file and an unreadable record without throwing', async () => {
    fsState.exists = true
    store.map.set(join(LIBRARY_DIR, 'notes.txt'), 'ignored')
    // A record with no id — readJson resolves fine but `rec?.id` guard skips it.
    store.map.set(join(LIBRARY_DIR, 'broken-00000000.json'), { title: 'no id' })
    const lib = await freshLibrary()
    expect(lib.list()).toHaveLength(0)
  })
})

describe('create', () => {
  it('fills in defaults and files the artifact', async () => {
    const lib = await freshLibrary()
    const res = lib.create(noteInput())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.kind).toBe('note')
    expect(res.artifact.format).toBe('markdown')
    expect(res.artifact.authorId).toBe('operator')
    expect(res.artifact.revision).toBe(1)
    expect(res.artifact.outcome).toBe('none')
    expect(res.artifact.pinned).toBe(false)
  })

  it('rejects an empty (or whitespace-only) title', async () => {
    const lib = await freshLibrary()
    const res = lib.create(noteInput({ title: '   ' }))
    expect(res.ok).toBe(false)
  })

  it('rejects a body over MAX_ARTIFACT_BYTES', async () => {
    const lib = await freshLibrary()
    const res = lib.create(noteInput({ body: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/exceeds/)
  })

  it('rejects supersedes pointing at an unknown artifact', async () => {
    const lib = await freshLibrary()
    const res = lib.create(noteInput({ supersedes: 'nope' }))
    expect(res.ok).toBe(false)
  })

  it('accepts supersedes pointing at a real artifact', async () => {
    const lib = await freshLibrary()
    const original = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const res = lib.create(noteInput({ title: 'v2', supersedes: original.artifact.id }))
    expect(res.ok).toBe(true)
  })

  it('sets outcome to pending when resolvesAt is provided, none otherwise', async () => {
    const lib = await freshLibrary()
    const withResolve = lib.create(noteInput({ resolvesAt: Date.now() + 1000 })) as { ok: true; artifact: { outcome: string } }
    const without = lib.create(noteInput()) as { ok: true; artifact: { outcome: string } }
    expect(withResolve.artifact.outcome).toBe('pending')
    expect(without.artifact.outcome).toBe('none')
  })

  it('uppercases symbols', async () => {
    const lib = await freshLibrary()
    const res = lib.create(noteInput({ symbols: ['wifusd', 'btcusd'] })) as { ok: true; artifact: { symbols: string[] } }
    expect(res.artifact.symbols).toEqual(['WIFUSD', 'BTCUSD'])
  })

  it('persists the .json via stateStore and writes a .md mirror for markdown/text bodies', async () => {
    const lib = await freshLibrary()
    const res = lib.create(noteInput({ format: 'markdown' })) as { ok: true; artifact: { id: string } }
    const jsonKeys = [...store.map.keys()].filter((k) => k.endsWith('.json'))
    expect(jsonKeys).toHaveLength(1)
    const mdKeys = [...fsState.files.keys()].filter((k) => k.endsWith('.md'))
    expect(mdKeys).toHaveLength(1)
    expect(fsState.files.get(mdKeys[0]!)).toContain('Base rates for oversold bounces')
    void res
  })

  it('does not write a .md mirror for json/csv format artifacts', async () => {
    const lib = await freshLibrary()
    lib.create(noteInput({ format: 'json', body: '{}' }))
    expect(fsState.files.size).toBe(0)
  })
})

describe('update', () => {
  it('returns an error for an unknown id', async () => {
    const lib = await freshLibrary()
    const res = lib.update('nope', { title: 'x' })
    expect(res.ok).toBe(false)
  })

  it('bumps revision when the body or title actually changes', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const res = lib.update(created.artifact.id, { body: 'new body' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.revision).toBe(2)
  })

  it('does not bump revision for metadata-only changes (pinning, grading)', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const res = lib.update(created.artifact.id, { pinned: true, outcome: 'correct' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.revision).toBe(1)
    expect(res.artifact.pinned).toBe(true)
    expect(res.artifact.outcome).toBe('correct')
  })

  it('does not bump revision when body/title are set to their existing values', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string; body: string; title: string } }
    const res = lib.update(created.artifact.id, { body: created.artifact.body, title: created.artifact.title })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.revision).toBe(1)
  })

  it('rejects a body update over MAX_ARTIFACT_BYTES', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const res = lib.update(created.artifact.id, { body: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) })
    expect(res.ok).toBe(false)
  })

  it('setting resolvesAt on a none-outcome artifact promotes it to pending', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const res = lib.update(created.artifact.id, { resolvesAt: Date.now() + 1000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.outcome).toBe('pending')
  })

  it('re-uppercases symbols on update', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const res = lib.update(created.artifact.id, { symbols: ['ethusd'] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifact.symbols).toEqual(['ETHUSD'])
  })
})

describe('remove', () => {
  it('removes a known artifact, deletes its json via stateStore, and rms its md mirror', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    expect(lib.remove(created.artifact.id)).toBe(true)
    expect(lib.get(created.artifact.id)).toBeNull()
    expect([...store.map.keys()].some((k) => k.endsWith('.json'))).toBe(false)
  })

  it('returns false for an unknown id', async () => {
    const lib = await freshLibrary()
    expect(lib.remove('nope')).toBe(false)
  })

  it('keeps the file basename stable across a retitle, so remove never orphans a file', async () => {
    const lib = await freshLibrary()
    const created = lib.create(noteInput({ title: 'Original Title' })) as { ok: true; artifact: { id: string } }
    lib.update(created.artifact.id, { title: 'Completely Different Title' })
    expect(lib.remove(created.artifact.id)).toBe(true)
    // Only one .md ever existed and it must have been rm'd — no orphaned second file.
    const mdRemoved = [...fsState.removed].filter((p) => p.endsWith('.md'))
    expect(mdRemoved).toHaveLength(1)
    expect(mdRemoved[0]).toContain('original-title')
  })
})

describe('list', () => {
  it('sorts pinned first even when it is the older, less-recently-updated item', async () => {
    const lib = await freshLibrary()
    const b = lib.create(noteInput({ title: 'B' })) as { ok: true; artifact: { id: string } }
    const a = lib.create(noteInput({ title: 'A' })) as { ok: true; artifact: { id: string } }
    // Flip `pinned` on the live record directly (bypassing update(), which would also
    // bump updatedAt and defeat the point of proving pinned beats recency).
    lib.get(b.artifact.id)!.pinned = true
    const ids = lib.list().map((x) => x.id)
    expect(ids[0]).toBe(b.artifact.id)
    expect(ids[1]).toBe(a.artifact.id)
  })

  it('omits the body and includes byte length', async () => {
    const lib = await freshLibrary()
    lib.create(noteInput({ body: 'hello world' }))
    const [summary] = lib.list()
    expect(summary).not.toHaveProperty('body')
    expect(summary!.bytes).toBe(Buffer.byteLength('hello world', 'utf8'))
  })

  it('flags supersededBy on the artifact a newer one replaces', async () => {
    const lib = await freshLibrary()
    const original = lib.create(noteInput()) as { ok: true; artifact: { id: string } }
    const next = lib.create(noteInput({ title: 'v2', supersedes: original.artifact.id })) as { ok: true; artifact: { id: string } }
    const list = lib.list()
    const originalSummary = list.find((x) => x.id === original.artifact.id)!
    expect(originalSummary.supersededBy).toBe(next.artifact.id)
  })
})

describe('promptDigest', () => {
  it('reports an empty library', async () => {
    const lib = await freshLibrary()
    expect(lib.promptDigest()).toMatch(/empty/)
  })

  it('excludes superseded artifacts and includes kind/title/author', async () => {
    const lib = await freshLibrary()
    const original = lib.create(noteInput({ title: 'Old Take' })) as { ok: true; artifact: { id: string } }
    lib.create(noteInput({ title: 'New Take', supersedes: original.artifact.id }))
    const digest = lib.promptDigest()
    expect(digest).toContain('New Take')
    expect(digest).not.toContain('Old Take')
  })

  it('respects the limit parameter', async () => {
    const lib = await freshLibrary()
    for (let i = 0; i < 5; i++) lib.create(noteInput({ title: `Item ${i}` }))
    const digest = lib.promptDigest(2)
    expect(digest.split('\n').length).toBe(2)
  })
})
