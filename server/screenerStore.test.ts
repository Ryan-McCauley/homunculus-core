import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads its file at import time, so every test needs a fresh module
// instance over a controllable virtual file — same approach as
// cryptoStrategySettings.test.ts, for the same reason.
const fsState = vi.hoisted(() => ({ exists: false, content: '' }))

vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((_file: string, fallback: unknown) =>
      (fsState.exists ? JSON.parse(fsState.content) : fallback)),
    writeJson: vi.fn((_file: string, value: unknown) => {
      fsState.content = JSON.stringify(value)
      fsState.exists = true
    }),
  },
}))

const audit = vi.hoisted(() => ({ record: vi.fn(), note: vi.fn() }))

vi.mock('./auditLog', () => ({
  auditLog: audit,
  withActor: <T,>(_actor: string, fn: () => T) => fn(),
  currentActor: () => 'operator',
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  audit.record.mockClear()
  audit.note.mockClear()
  fsState.exists = false
  fsState.content = ''
})

async function freshStore() {
  return (await import('./screenerStore')).screenerStore
}

describe('seeding', () => {
  it('seeds starter screeners when no file exists', async () => {
    const store = await freshStore()
    expect(store.list().length).toBeGreaterThan(0)
  })

  it('gives every seeded screener a valid definition', async () => {
    const { validateScreenerDef } = await import('../shared/screener')
    const store = await freshStore()
    for (const s of store.list()) {
      expect(validateScreenerDef(s), `${s.id}: ${validateScreenerDef(s).errors.join(', ')}`)
        .toMatchObject({ ok: true })
    }
  })

  it('seeds distinct ids', async () => {
    const store = await freshStore()
    const ids = store.list().map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('persists the seed so the next boot does not re-seed', async () => {
    const first = await freshStore()
    const created = first.list()[0]!.createdAt
    vi.resetModules()
    const second = await freshStore()
    expect(second.list()[0]!.createdAt).toBe(created)
  })

  it('loads existing screeners instead of seeding over them', async () => {
    fsState.exists = true
    fsState.content = JSON.stringify([{ id: 'mine', name: 'MINE', gates: {}, createdAt: 1, updatedAt: 1 }])
    const store = await freshStore()
    expect(store.list().map((s) => s.id)).toEqual(['mine'])
  })

  it('normalizes a stored screener that predates a newly added gate', async () => {
    fsState.exists = true
    fsState.content = JSON.stringify([{ id: 'old', name: 'OLD', gates: { rsi: { enabled: true, max: 35 } } }])
    const store = await freshStore()
    const got = store.get('old')!
    expect(got.gates.rsi.max).toBe(35)
    expect(got.gates.bbWidth.enabled).toBe(false)
  })

  it('skips an unreadable entry rather than failing to boot', async () => {
    fsState.exists = true
    fsState.content = JSON.stringify([null, { id: 'ok', name: 'OK', gates: {} }, 'garbage'])
    const store = await freshStore()
    expect(store.list().map((s) => s.id)).toEqual(['ok'])
  })
})

describe('create', () => {
  it('creates a blank screener and returns it', async () => {
    const store = await freshStore()
    const r = store.create({ name: 'Momentum Breakouts' })
    expect(r.ok).toBe(true)
    expect(r.screener!.name).toBe('Momentum Breakouts')
    expect(store.get('momentum-breakouts')).toBeTruthy()
  })

  it('rejects a blank name', async () => {
    const store = await freshStore()
    const r = store.create({ name: '  ' })
    expect(r.ok).toBe(false)
    expect(r.errors!.join(' ')).toMatch(/name/)
  })

  it('disambiguates a duplicate name instead of overwriting', async () => {
    const store = await freshStore()
    store.create({ name: 'Dip Hunter' })
    const second = store.create({ name: 'Dip Hunter' })
    expect(second.ok).toBe(true)
    expect(second.screener!.id).not.toBe('dip-hunter')
    expect(store.list().filter((s) => s.name.startsWith('Dip Hunter')).length).toBe(2)
  })

  it('copies gates from an existing screener without aliasing it', async () => {
    const store = await freshStore()
    const source = store.create({ name: 'Source', gates: { rsi: { enabled: true, min: null, max: 35 } } }).screener!
    const copy = store.create({ name: 'Copy', copyFromId: source.id }).screener!
    expect(copy.gates.rsi.max).toBe(35)
    expect(copy.origin).toEqual({ kind: 'copy', from: source.id })

    store.update(copy.id, { gates: { ...copy.gates, rsi: { enabled: true, min: null, max: 50 } } })
    expect(store.get(source.id)!.gates.rsi.max).toBe(35)
  })

  it('rejects a copy of a screener that does not exist', async () => {
    const store = await freshStore()
    expect(store.create({ name: 'X', copyFromId: 'nope' }).ok).toBe(false)
  })

  it('imports a strategy gate snapshot and records its origin', async () => {
    const store = await freshStore()
    const r = store.create({ name: 'Sniper Gates', importStrategy: 'sniper' })
    expect(r.ok).toBe(true)
    expect(r.screener!.origin).toEqual({ kind: 'strategy', from: 'sniper' })
    expect(r.screener!.gates.rsi.enabled).toBe(true)
  })

  it('rejects an unknown strategy import', async () => {
    const store = await freshStore()
    expect(store.create({ name: 'X', importStrategy: 'not-a-strategy' }).ok).toBe(false)
  })

  it('rejects a definition that fails validation', async () => {
    const store = await freshStore()
    const r = store.create({ name: 'Bad', gates: { rsi: { enabled: true, min: 70, max: 30 } } })
    expect(r.ok).toBe(false)
  })
})

describe('update', () => {
  it('saves edited gates and bumps updatedAt', async () => {
    const store = await freshStore()
    const made = store.create({ name: 'Edit Me' }).screener!
    const r = store.update(made.id, {
      gates: { ...made.gates, rsi: { enabled: true, min: null, max: 40 } },
      updatedAt: made.updatedAt + 1000,
    })
    expect(r.ok).toBe(true)
    expect(store.get(made.id)!.gates.rsi.max).toBe(40)
    expect(store.get(made.id)!.updatedAt).toBeGreaterThan(made.updatedAt)
  })

  it('renames without changing the id, so links keep working', async () => {
    const store = await freshStore()
    const made = store.create({ name: 'Old Name' }).screener!
    store.update(made.id, { name: 'New Name' })
    expect(store.get(made.id)!.name).toBe('New Name')
  })

  it('refuses an edit that would make the screener invalid', async () => {
    const store = await freshStore()
    const made = store.create({ name: 'Valid' }).screener!
    const r = store.update(made.id, { gates: { ...made.gates, rsi: { enabled: true, min: 90, max: 10 } } })
    expect(r.ok).toBe(false)
    expect(store.get(made.id)!.gates.rsi.enabled).toBe(false)
  })

  it('reports a missing screener rather than creating one', async () => {
    const store = await freshStore()
    expect(store.update('ghost', { name: 'X' }).ok).toBe(false)
    expect(store.get('ghost')).toBeUndefined()
  })

  it('ignores an attempt to change the id', async () => {
    const store = await freshStore()
    const made = store.create({ name: 'Fixed' }).screener!
    store.update(made.id, { id: 'hijacked' } as never)
    expect(store.get(made.id)).toBeTruthy()
    expect(store.get('hijacked')).toBeUndefined()
  })
})

describe('remove', () => {
  it('deletes a screener', async () => {
    const store = await freshStore()
    const made = store.create({ name: 'Temp' }).screener!
    expect(store.remove(made.id).ok).toBe(true)
    expect(store.get(made.id)).toBeUndefined()
  })

  it('reports a missing screener', async () => {
    const store = await freshStore()
    expect(store.remove('ghost').ok).toBe(false)
  })
})

describe('persistence', () => {
  it('survives a reload', async () => {
    const first = await freshStore()
    first.create({ name: 'Durable', gates: { volume24h: { enabled: true, min: 2_000_000, max: null } } })
    vi.resetModules()
    const second = await freshStore()
    expect(second.get('durable')!.gates.volume24h.min).toBe(2_000_000)
  })

  it('records mutations in the audit log', async () => {
    const store = await freshStore()
    audit.note.mockClear()
    store.create({ name: 'Audited' })
    expect(audit.note).toHaveBeenCalled()
  })
})

describe('strategy presets', () => {
  it('exposes the importable strategy gate snapshots', async () => {
    const { STRATEGY_PRESETS } = await import('./screenerStore')
    expect(Object.keys(STRATEGY_PRESETS).length).toBeGreaterThan(0)
  })

  it('every preset is a valid screener gate-set', async () => {
    const { STRATEGY_PRESETS } = await import('./screenerStore')
    const { validateScreenerDef, normalizeScreenerDef } = await import('../shared/screener')
    for (const [id, preset] of Object.entries(STRATEGY_PRESETS)) {
      const def = normalizeScreenerDef({ id, name: id, gates: preset.gates, timeframe: preset.timeframe })
      expect(validateScreenerDef(def), `${id}: ${validateScreenerDef(def).errors.join(', ')}`)
        .toMatchObject({ ok: true })
    }
  })
})

describe('empty start-from references', () => {
  // Found in the browser: the create overlay can post importStrategy:"" before the
  // strategy list has loaded. An empty string is falsy, so the import branch was
  // skipped entirely and the user silently got a BLANK screener — they asked for
  // sniper's gates, got nothing, and saw no error. An unknown id already errored;
  // an empty one has to as well.
  it('rejects an empty importStrategy rather than silently creating a blank screener', async () => {
    const store = await freshStore()
    const r = store.create({ name: 'Silent', importStrategy: '' })
    expect(r.ok).toBe(false)
    expect(store.get('silent')).toBeUndefined()
  })

  it('rejects an empty copyFromId', async () => {
    const store = await freshStore()
    const r = store.create({ name: 'Silent Copy', copyFromId: '' })
    expect(r.ok).toBe(false)
    expect(store.get('silent-copy')).toBeUndefined()
  })

  it('still allows omitting both, which is a genuine blank screener', async () => {
    const store = await freshStore()
    const r = store.create({ name: 'Truly Blank' })
    expect(r.ok).toBe(true)
    expect(r.screener!.origin).toEqual({ kind: 'blank' })
  })
})
