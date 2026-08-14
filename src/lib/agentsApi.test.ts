import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchAgents, createAgent, updateAgent, deleteAgent, runAgent, chatWithAgent, clearAgentChat,
} from './agentsApi'

/** Mirrors api.ts's apiBase()/token() resolution, but every call here also
 *  appends `?token=` (or `&token=`) from the URL search string / injected
 *  global — cover that path explicitly since it differs subtly per file. */
function stubEnv(opts: { apiOverride?: string; port?: string; origin?: string; search?: string; tokenGlobal?: string } = {}) {
  vi.stubGlobal('window', {
    __HOMUNCULUS_API__: opts.apiOverride,
    __HOMUNCULUS_TOKEN__: opts.tokenGlobal,
  })
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

describe('token handling', () => {
  it('appends the token from the URL search string', async () => {
    stubEnv({ search: '?token=abc123' })
    const fetchMock = mockFetch({ ok: true, agents: [] })
    await fetchAgents()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/agents?token=abc123')
  })

  it('falls back to the injected __HOMUNCULUS_TOKEN__ global', async () => {
    stubEnv({ tokenGlobal: 'from-global' })
    const fetchMock = mockFetch({ ok: true, agents: [] })
    await fetchAgents()
    expect(fetchMock.mock.calls[0][0]).toContain('token=from-global')
  })

  it('omits the token param entirely when none is available', async () => {
    const fetchMock = mockFetch({ ok: true, agents: [] })
    await fetchAgents()
    expect(fetchMock.mock.calls[0][0]).not.toContain('token=')
  })
})

describe('fetchAgents', () => {
  it('returns the agents list on success', async () => {
    const agents = [{ id: 'a1' }]
    mockFetch({ ok: true, agents })
    expect(await fetchAgents()).toEqual(agents)
  })

  it('returns an empty array when agents is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchAgents()).toEqual([])
  })

  it('propagates a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(fetchAgents()).rejects.toThrow('network down')
  })
})

describe('createAgent', () => {
  it('POSTs the input as JSON and returns the parsed response', async () => {
    const fetchMock = mockFetch({ ok: true, agent: { id: 'a1' } })
    const input = { name: 'Bot', role: 'trader' } as any
    const result = await createAgent(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/agents')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual(input)
    expect(result).toEqual({ ok: true, agent: { id: 'a1' } })
  })

  it('resolves with the server error body rather than throwing on failure', async () => {
    mockFetch({ ok: false, error: 'name taken' }, false)
    const result = await createAgent({ name: 'Bot' } as any)
    expect(result).toEqual({ ok: false, error: 'name taken' })
  })
})

describe('updateAgent', () => {
  it('PATCHes the id-scoped path with the partial patch', async () => {
    const fetchMock = mockFetch({ ok: true, agent: { id: 'a1' } })
    await updateAgent('a 1', { name: 'New' } as any)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/agents/a%201')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ name: 'New' })
  })
})

describe('deleteAgent', () => {
  it('DELETEs the id-scoped path with no body', async () => {
    const fetchMock = mockFetch({ ok: true })
    await deleteAgent('a1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/agents/a1')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })
})

describe('runAgent', () => {
  it('POSTs to the /run sub-path with an empty body', async () => {
    const fetchMock = mockFetch({ ok: true })
    await runAgent('a1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/agents/a1/run')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})
  })
})

describe('chatWithAgent', () => {
  it('POSTs the message and returns the reply/transcript', async () => {
    const fetchMock = mockFetch({ ok: true, reply: 'hi', transcript: [] })
    const result = await chatWithAgent('a1', 'hello')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/agents/a1/chat')
    expect(JSON.parse(init.body)).toEqual({ message: 'hello' })
    expect(result).toEqual({ ok: true, reply: 'hi', transcript: [] })
  })
})

describe('clearAgentChat', () => {
  it('DELETEs the /chat sub-path', async () => {
    const fetchMock = mockFetch({ ok: true })
    await clearAgentChat('a1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/agents/a1/chat')
    expect(init.method).toBe('DELETE')
  })
})
