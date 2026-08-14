import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleScreenerRequest, type ScreenerApiDeps } from './screenerApi'
import { normalizeScreenerDef, type ScreenerDef, type ScreenerResult } from '../shared/screener'

function def(id: string, over: Record<string, unknown> = {}): ScreenerDef {
  return normalizeScreenerDef({ id, name: id.toUpperCase(), createdAt: 1, updatedAt: 1, ...over })
}

function result(screenerId: string): ScreenerResult {
  return {
    schemaVersion: 1, screenerId, timeframe: '1hr', scannedAt: 5,
    universe: 3, passing: 1, candidates: [], funnel: [], degradedGates: [], errors: [],
  }
}

let deps: ScreenerApiDeps
let store: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  store = {
    list: vi.fn(() => [def('dip-hunter')]),
    get: vi.fn((id: string) => (id === 'dip-hunter' ? def('dip-hunter') : undefined)),
    create: vi.fn(() => ({ ok: true, screener: def('new-one') })),
    update: vi.fn(() => ({ ok: true, screener: def('dip-hunter') })),
    remove: vi.fn(() => ({ ok: true })),
  }
  deps = {
    store: store as unknown as ScreenerApiDeps['store'],
    run: vi.fn(async () => ({ ok: true, result: result('dip-hunter'), error: '' })),
    strategies: { sniper: { label: 'SNIPER' }, trapline: { label: 'TRAPLINE' } },
  }
})

const call = (method: string, path: string, body: Record<string, unknown> = {}) =>
  handleScreenerRequest(method, path, body, deps)

describe('routing', () => {
  it('ignores paths that belong to someone else', async () => {
    expect(await call('GET', '/api/crypto/snapshot')).toBeNull()
    expect(await call('GET', '/api/library')).toBeNull()
  })

  it('ignores an unsupported method on a path it owns', async () => {
    expect(await call('PUT', '/api/crypto/screeners')).toBeNull()
  })
})

describe('GET /api/crypto/screeners', () => {
  it('returns the saved library', async () => {
    const r = await call('GET', '/api/crypto/screeners')
    expect(r!.code).toBe(200)
    expect((r!.body as { screeners: ScreenerDef[] }).screeners).toHaveLength(1)
  })

  it('includes the importable strategy presets for the create flow', async () => {
    const r = await call('GET', '/api/crypto/screeners')
    expect((r!.body as { strategies: Array<{ id: string }> }).strategies.map((s) => s.id))
      .toEqual(['sniper', 'trapline'])
  })
})

describe('POST /api/crypto/screeners', () => {
  it('creates and returns the new screener', async () => {
    const r = await call('POST', '/api/crypto/screeners', { name: 'New One' })
    expect(r!.code).toBe(200)
    expect(store['create']).toHaveBeenCalledWith(expect.objectContaining({ name: 'New One' }))
  })

  it('passes the create options through', async () => {
    await call('POST', '/api/crypto/screeners', {
      name: 'X', timeframe: '4hr', universe: 'HELD', copyFromId: 'dip-hunter', importStrategy: 'sniper',
    })
    expect(store['create']).toHaveBeenCalledWith(expect.objectContaining({
      timeframe: '4hr', universe: 'HELD', copyFromId: 'dip-hunter', importStrategy: 'sniper',
    }))
  })

  it('rejects a request with no name before reaching the store', async () => {
    const r = await call('POST', '/api/crypto/screeners', {})
    expect(r!.code).toBe(400)
    expect(store['create']).not.toHaveBeenCalled()
  })

  it('reports store validation failures as 400 with the reasons', async () => {
    store['create'] = vi.fn(() => ({ ok: false, errors: ['rsi min is above its max'] }))
    const r = await call('POST', '/api/crypto/screeners', { name: 'Bad' })
    expect(r!.code).toBe(400)
    expect((r!.body as { error: string }).error).toMatch(/rsi min/)
  })
})

describe('PATCH /api/crypto/screeners/:id', () => {
  it('updates the named screener', async () => {
    const r = await call('PATCH', '/api/crypto/screeners/dip-hunter', { name: 'Renamed' })
    expect(r!.code).toBe(200)
    expect(store['update']).toHaveBeenCalledWith('dip-hunter', expect.objectContaining({ name: 'Renamed' }))
  })

  it('passes edited gates through', async () => {
    const gates = { rsi: { enabled: true, min: null, max: 40 } }
    await call('PATCH', '/api/crypto/screeners/dip-hunter', { gates })
    expect(store['update']).toHaveBeenCalledWith('dip-hunter', expect.objectContaining({ gates }))
  })

  it('404s an unknown screener', async () => {
    store['update'] = vi.fn(() => ({ ok: false, errors: ['no screener named ghost'] }))
    const r = await call('PATCH', '/api/crypto/screeners/ghost', { name: 'X' })
    expect(r!.code).toBe(404)
  })

  it('400s an edit the store rejects as invalid', async () => {
    store['update'] = vi.fn(() => ({ ok: false, errors: ['rsi min is above its max'] }))
    const r = await call('PATCH', '/api/crypto/screeners/dip-hunter', { gates: {} })
    expect(r!.code).toBe(400)
  })

  it('rejects a path with no id', async () => {
    const r = await call('PATCH', '/api/crypto/screeners/', { name: 'X' })
    expect(r!.code).toBe(400)
  })
})

describe('DELETE /api/crypto/screeners/:id', () => {
  it('deletes the named screener', async () => {
    const r = await call('DELETE', '/api/crypto/screeners/dip-hunter')
    expect(r!.code).toBe(200)
    expect(store['remove']).toHaveBeenCalledWith('dip-hunter')
  })

  it('404s an unknown screener', async () => {
    store['remove'] = vi.fn(() => ({ ok: false, errors: ['no screener named ghost'] }))
    expect((await call('DELETE', '/api/crypto/screeners/ghost'))!.code).toBe(404)
  })

  it('does not mistake the run route for a delete', async () => {
    const r = await call('DELETE', '/api/crypto/screeners/dip-hunter/run')
    expect(r).toBeNull()
    expect(store['remove']).not.toHaveBeenCalled()
  })
})

describe('POST /api/crypto/screeners/:id/run', () => {
  it('runs the saved screener and returns its result', async () => {
    const r = await call('POST', '/api/crypto/screeners/dip-hunter/run')
    expect(r!.code).toBe(200)
    expect((r!.body as { result: ScreenerResult }).result.screenerId).toBe('dip-hunter')
  })

  it('404s an unknown screener', async () => {
    const r = await call('POST', '/api/crypto/screeners/ghost/run')
    expect(r!.code).toBe(404)
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('runs an unsaved draft definition sent in the body', async () => {
    // The rail is live: editing a gate re-runs before anything is saved.
    const draft = def('dip-hunter', { gates: { rsi: { enabled: true, max: 20 } } })
    await call('POST', '/api/crypto/screeners/dip-hunter/run', { screener: draft })
    expect(deps.run).toHaveBeenCalledWith(expect.objectContaining({
      gates: expect.objectContaining({ rsi: expect.objectContaining({ max: 20 }) }),
    }))
  })

  it('rejects a draft that fails validation instead of running it', async () => {
    const bad = { ...def('dip-hunter'), gates: { ...def('dip-hunter').gates, rsi: { enabled: true, min: 90, max: 10 } } }
    const r = await call('POST', '/api/crypto/screeners/dip-hunter/run', { screener: bad })
    expect(r!.code).toBe(400)
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('keeps the saved id even when the draft claims another', async () => {
    // Otherwise a draft could quietly write results under a different screener.
    const draft = def('somebody-else')
    await call('POST', '/api/crypto/screeners/dip-hunter/run', { screener: draft })
    expect(deps.run).toHaveBeenCalledWith(expect.objectContaining({ id: 'dip-hunter' }))
  })

  it('reports an engine failure as 500 with the reason', async () => {
    deps.run = vi.fn(async () => ({ ok: false, error: 'screener engine timed out after 30000ms' }))
    const r = await call('POST', '/api/crypto/screeners/dip-hunter/run')
    expect(r!.code).toBe(500)
    expect((r!.body as { error: string }).error).toMatch(/timed out/)
  })

  it('never throws when the engine rejects outright', async () => {
    deps.run = vi.fn(async () => { throw new Error('spawn exploded') })
    const r = await call('POST', '/api/crypto/screeners/dip-hunter/run')
    expect(r!.code).toBe(500)
    expect((r!.body as { error: string }).error).toMatch(/spawn exploded/)
  })
})
