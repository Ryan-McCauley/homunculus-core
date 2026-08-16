import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchAgentManifest, submitIntent, confirmOps, dryRunIntent } from './agentApi'

function stubEnv(opts: { search?: string } = {}) {
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', {
    port: '5173', protocol: 'http:', hostname: 'localhost',
    origin: 'http://localhost:5173', search: opts.search ?? '',
  })
}

function mockFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, statusText: 'err', json: async () => body })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const EMPTY_RESULT = { ok: true, plan: { manifest: 1, text: '', ops: [], unmatched: [] }, result: { ok: true, ops: [] } }

beforeEach(() => stubEnv())
afterEach(() => vi.unstubAllGlobals())

describe('fetchAgentManifest', () => {
  it('gets the manifest from the agent endpoint', async () => {
    const fetchMock = mockFetch({ ok: true, manifest: 1, routes: [], actions: [] })
    const manifest = await fetchAgentManifest()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/agent/manifest')
    expect(manifest.manifest).toBe(1)
  })

  it('carries the page token through', async () => {
    stubEnv({ search: '?token=t1' })
    const fetchMock = mockFetch({ ok: true, manifest: 1, routes: [], actions: [] })
    await fetchAgentManifest()
    expect(fetchMock.mock.calls[0][0]).toContain('token=t1')
  })

  it('throws on a failed response', async () => {
    mockFetch({}, false, 500)
    await expect(fetchAgentManifest()).rejects.toThrow('500')
  })
})

describe('submitIntent', () => {
  it('posts the text to the intent endpoint', async () => {
    const fetchMock = mockFetch(EMPTY_RESULT)
    await submitIntent('movie mode')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/agent/intent')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ text: 'movie mode' })
  })

  it('returns the plan and the result', async () => {
    mockFetch(EMPTY_RESULT)
    const res = await submitIntent('movie mode')
    expect(res.plan.ops).toEqual([])
    expect(res.result.ok).toBe(true)
  })
})

describe('dryRunIntent', () => {
  it('asks for a dry run so nothing executes', async () => {
    const fetchMock = mockFetch(EMPTY_RESULT)
    await dryRunIntent('lock up')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'lock up', dry_run: true })
  })
})

describe('confirmOps', () => {
  it('re-submits the original text with the confirmed op numbers', async () => {
    const fetchMock = mockFetch(EMPTY_RESULT)
    await confirmOps('lock up', [4])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'lock up', confirm: [4] })
  })

  it('sends structured ops instead of text when given them', async () => {
    const fetchMock = mockFetch(EMPTY_RESULT)
    await confirmOps([{ actionId: 'lock.front_door:unlock' }], [1])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ops: [{ actionId: 'lock.front_door:unlock' }], confirm: [1],
    })
  })
})
