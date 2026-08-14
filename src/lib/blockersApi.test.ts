import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchBlockers, raiseBlocker, answerBlocker, withdrawBlocker } from './blockersApi'

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

describe('fetchBlockers', () => {
  it('returns the blockers list on success', async () => {
    const blockers = [{ id: 'b1' }]
    mockFetch({ ok: true, blockers })
    expect(await fetchBlockers()).toEqual(blockers)
  })

  it('returns an empty array when blockers is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchBlockers()).toEqual([])
  })

  it('propagates a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchBlockers()).rejects.toThrow('offline')
  })

  it('does not throw on a non-ok HTTP response, resolving with the body instead', async () => {
    mockFetch({ ok: false, error: 'boom' }, false)
    expect(await fetchBlockers()).toEqual([])
  })
})

describe('raiseBlocker', () => {
  it('POSTs the input to the blockers root', async () => {
    const fetchMock = mockFetch({ ok: true, blocker: { id: 'b1' } })
    const input = { text: 'need review' } as any
    const result = await raiseBlocker(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/blockers')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(input)
    expect(result).toEqual({ ok: true, blocker: { id: 'b1' } })
  })
})

describe('answerBlocker', () => {
  it('POSTs the answer to the id-scoped /answer path', async () => {
    const fetchMock = mockFetch({ ok: true, blocker: { id: 'b1' } })
    await answerBlocker('b 1', 'do X')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/blockers/b%201/answer')
    expect(JSON.parse(init.body)).toEqual({ answer: 'do X' })
  })
})

describe('withdrawBlocker', () => {
  it('POSTs an empty body to the id-scoped /withdraw path', async () => {
    const fetchMock = mockFetch({ ok: true, blocker: { id: 'b1' } })
    await withdrawBlocker('b1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/blockers/b1/withdraw')
    expect(JSON.parse(init.body)).toEqual({})
  })
})
