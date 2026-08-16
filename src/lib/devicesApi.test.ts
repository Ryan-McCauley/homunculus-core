import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchIntegrations, fetchEntries, fetchDiscovered,
  beginFlow, advanceFlow, cancelFlow, removeEntry, reloadIntegration,
} from './devicesApi'

function stubEnv(opts: { search?: string } = {}) {
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', {
    port: '5173', protocol: 'http:', hostname: 'localhost',
    origin: 'http://localhost:5173', search: opts.search ?? '',
  })
}

function mockFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: { method?: string; body?: string }) => ({
    ok, status, statusText: 'err', json: async () => body,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => stubEnv())
afterEach(() => vi.unstubAllGlobals())

describe('fetchIntegrations', () => {
  it('returns the handler list', async () => {
    const fetchMock = mockFetch({ ok: true, handlers: ['hue', 'sonos'] })
    expect(await fetchIntegrations()).toEqual(['hue', 'sonos'])
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8787/api/ha/integrations')
  })

  it('returns an empty list when the field is missing', async () => {
    mockFetch({ ok: true })
    expect(await fetchIntegrations()).toEqual([])
  })

  it('carries the page token', async () => {
    stubEnv({ search: '?token=t1' })
    const fetchMock = mockFetch({ ok: true, handlers: [] })
    await fetchIntegrations()
    expect(fetchMock.mock.calls[0]![0]).toContain('token=t1')
  })
})

describe('fetchEntries / fetchDiscovered', () => {
  it('returns configured entries', async () => {
    mockFetch({ ok: true, entries: [{ entry_id: 'e1', domain: 'hue', title: 'Hue', state: 'loaded' }] })
    expect((await fetchEntries())[0]?.domain).toBe('hue')
  })

  it('returns discovered flows', async () => {
    mockFetch({ ok: true, flows: [{ flowId: 'f1', handler: 'hue', source: 'zeroconf', title: 'Bridge' }] })
    expect((await fetchDiscovered())[0]?.flowId).toBe('f1')
  })

  it('degrades to an empty list when discovery is unavailable', async () => {
    mockFetch({ ok: true })
    expect(await fetchDiscovered()).toEqual([])
  })
})

describe('beginFlow', () => {
  it('posts the handler', async () => {
    const fetchMock = mockFetch({ ok: true, step: { type: 'form', flow_id: 'f1' } })
    const outcome = await beginFlow('hue')
    expect(outcome.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe('http://localhost:8787/api/ha/flow')
    expect(JSON.parse(init.body)).toEqual({ handler: 'hue' })
  })

  it('surfaces a transport failure as a flow outcome rather than throwing', async () => {
    mockFetch({}, false, 502)
    const outcome = await beginFlow('hue')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/502/)
  })
})

describe('advanceFlow', () => {
  it('posts the values under a values key', async () => {
    const fetchMock = mockFetch({ ok: true, step: { type: 'create_entry' } })
    await advanceFlow('f1', { host: '10.0.0.4' })
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe('http://localhost:8787/api/ha/flow/f1')
    expect(JSON.parse(init.body)).toEqual({ values: { host: '10.0.0.4' } })
  })

  it('passes field errors back through', async () => {
    mockFetch({ ok: false, error: 'rejected', fieldErrors: { host: 'invalid host' } })
    const outcome = await advanceFlow('f1', {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.fieldErrors).toEqual({ host: 'invalid host' })
  })

  it('url-encodes the flow id', async () => {
    const fetchMock = mockFetch({ ok: true, step: {} })
    await advanceFlow('a b', {})
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/ha/flow/a%20b')
  })
})

describe('cancelFlow / removeEntry / reloadIntegration', () => {
  it('deletes the flow', async () => {
    const fetchMock = mockFetch({ ok: true })
    await cancelFlow('f1')
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }]
    expect(url).toBe('http://localhost:8787/api/ha/flow/f1')
    expect(init.method).toBe('DELETE')
  })

  it('deletes an entry', async () => {
    const fetchMock = mockFetch({ ok: true, requireRestart: false })
    expect(await removeEntry('e1')).toEqual({ ok: true, requireRestart: false })
    expect((fetchMock.mock.calls[0]![1] as { method: string }).method).toBe('DELETE')
  })

  it('reloads an entry', async () => {
    const fetchMock = mockFetch({ ok: true, requireRestart: false })
    await reloadIntegration('e1')
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8787/api/ha/entries/e1/reload')
  })
})
