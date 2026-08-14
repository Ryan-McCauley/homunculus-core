import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchRoster, fetchCubicle, updatePersonnel, addJournalEntry, recordThought,
  fetchBoard, postThread, replyToThread, resolveThread,
} from './officeApi'

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

describe('fetchRoster', () => {
  it('returns the roster on success', async () => {
    const roster = [{ id: 'e1', name: 'A', title: 'T', personnel: {}, inbox: 0 }]
    const fetchMock = mockFetch({ ok: true, roster })
    const result = await fetchRoster()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/office')
    expect(result).toEqual(roster)
  })

  it('returns an empty array when roster is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchRoster()).toEqual([])
  })

  it('propagates a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchRoster()).rejects.toThrow('offline')
  })
})

describe('fetchCubicle', () => {
  it('returns the cubicle view for an agent id', async () => {
    const cubicle = { agentId: 'e1' }
    const fetchMock = mockFetch({ ok: true, cubicle })
    const result = await fetchCubicle('e 1')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/office/e%201')
    expect(result).toEqual(cubicle)
  })

  it('returns null when cubicle is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchCubicle('missing')).toBeNull()
  })
})

describe('updatePersonnel', () => {
  it('PATCHes the personnel patch to the agent path', async () => {
    const fetchMock = mockFetch({ ok: true, personnel: {} })
    await updatePersonnel('e1', { title: 'Lead' } as any)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/e1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ title: 'Lead' })
  })
})

describe('addJournalEntry', () => {
  it('POSTs the entry to the /journal sub-path', async () => {
    const fetchMock = mockFetch({ ok: true, entry: { title: 't', body: 'b' } })
    await addJournalEntry('e1', { body: 'note', tags: ['x'] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/e1/journal')
    expect(JSON.parse(init.body)).toEqual({ body: 'note', tags: ['x'] })
  })
})

describe('recordThought', () => {
  it('POSTs the thought to the /mind sub-path', async () => {
    const fetchMock = mockFetch({ ok: true, thought: { text: 'hmm' } })
    await recordThought('e1', { kind: 'idea', text: 'hmm' } as any)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/e1/mind')
    expect(JSON.parse(init.body)).toEqual({ kind: 'idea', text: 'hmm' })
  })
})

describe('fetchBoard', () => {
  it('returns the threads on success', async () => {
    const threads = [{ id: 't1' }]
    const fetchMock = mockFetch({ ok: true, threads })
    const result = await fetchBoard()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/office/board')
    expect(result).toEqual(threads)
  })

  it('returns an empty array when threads is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchBoard()).toEqual([])
  })
})

describe('postThread', () => {
  it('POSTs the new thread input', async () => {
    const fetchMock = mockFetch({ ok: true, thread: { id: 't1' } })
    const input = { authorId: 'e1', title: 'T', body: 'B' }
    await postThread(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/board')
    expect(JSON.parse(init.body)).toEqual(input)
  })
})

describe('replyToThread', () => {
  it('POSTs the reply to the /reply sub-path', async () => {
    const fetchMock = mockFetch({ ok: true, thread: { id: 't1' } })
    await replyToThread('t1', { authorId: 'e1', body: 'reply' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/board/t1/reply')
    expect(JSON.parse(init.body)).toEqual({ authorId: 'e1', body: 'reply' })
  })
})

describe('resolveThread', () => {
  it('POSTs the resolved flag to the /resolve sub-path', async () => {
    const fetchMock = mockFetch({ ok: true, thread: { id: 't1' } })
    await resolveThread('t1', true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/board/t1/resolve')
    expect(JSON.parse(init.body)).toEqual({ resolved: true })
  })
})
