import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchScreeners, createScreener, saveScreener, deleteScreener, runScreener } from './screenerApi'

// This is the CLIENT REST wrapper (src/lib/screenerApi.ts), distinct from the
// already-tested server/screenerApi.ts (server route handlers) and
// src/lib/screenerUi.ts (formatting helpers). Its `call()` never throws: a
// rejected fetch is caught and turned into `{ ok: false, error }`, and a
// non-ok HTTP response is just returned as whatever JSON body it carries
// (there's no `res.ok` check) — every caller is expected to branch on `ok`.

function stubEnv(opts: { apiOverride?: string; port?: string; origin?: string; search?: string } = {}) {
  vi.stubGlobal('window', { __HOMUNCULUS_API__: opts.apiOverride })
  vi.stubGlobal('location', {
    port: opts.port ?? '5173',
    protocol: 'http:',
    hostname: 'localhost',
    origin: opts.origin ?? 'http://localhost:5173',
    search: opts.search ?? '',
  })
}

function mockFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, statusText: 'x', json: async () => body })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => stubEnv())
afterEach(() => vi.unstubAllGlobals())

describe('fetchScreeners', () => {
  it('GETs the screeners root and returns the parsed body', async () => {
    const body = { ok: true, screeners: [{ id: 's1' }], strategies: [] }
    const fetchMock = mockFetch(body)
    const result = await fetchScreeners()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/screeners')
    expect(init.method).toBe('GET')
    expect(result).toEqual(body)
  })

  it('resolves to an ok:false error object when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const result = await fetchScreeners()
    expect(result).toEqual({ ok: false, error: 'network down' })
  })

  it('resolves with whatever body a non-ok HTTP response carries, without throwing', async () => {
    mockFetch({ ok: false, error: 'boom' }, false)
    const result = await fetchScreeners()
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})

describe('createScreener', () => {
  it('POSTs the new-screener body', async () => {
    const fetchMock = mockFetch({ ok: true, screener: { id: 's1' } })
    const body = { name: 'My Screen', timeframe: '1h' as any }
    const result = await createScreener(body)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/screeners')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual(body)
    expect(result).toEqual({ ok: true, screener: { id: 's1' } })
  })
})

describe('saveScreener', () => {
  it('PATCHes the id-scoped path with the patch', async () => {
    const fetchMock = mockFetch({ ok: true, screener: { id: 's1' } })
    await saveScreener('s 1', { name: 'Renamed' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/screeners/s%201')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed' })
  })
})

describe('deleteScreener', () => {
  it('DELETEs the id-scoped path', async () => {
    const fetchMock = mockFetch({ ok: true })
    const result = await deleteScreener('s1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/screeners/s1')
    expect(init.method).toBe('DELETE')
    expect(result).toEqual({ ok: true })
  })
})

describe('runScreener', () => {
  it('POSTs an empty body when no draft is given', async () => {
    const fetchMock = mockFetch({ ok: true, result: {} })
    await runScreener('s1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/screeners/s1/run')
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('wraps a draft screener in the body when given', async () => {
    const fetchMock = mockFetch({ ok: true, result: {} })
    const draft = { id: 's1', name: 'Draft' } as any
    await runScreener('s1', draft)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ screener: draft })
  })

  it('URL-encodes the screener id', async () => {
    const fetchMock = mockFetch({ ok: true, result: {} })
    await runScreener('s 1')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/screeners/s%201/run')
  })
})
