import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  listHandlers, listEntries, startFlow, getFlow, submitStep, abortFlow,
  deleteEntry, reloadEntry, parseDiscoveredFlows,
} from './haConfigFlow'

function stubHa(url = 'http://ha.local:8123', token = 'secret-token') {
  vi.stubEnv('HA_URL', url)
  vi.stubEnv('HA_TOKEN', token)
}

function mockFetch(status: number, body: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(async (_url: string, _init?: { method?: string; body?: string; headers?: Record<string, string> }) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const FORM_STEP = {
  type: 'form',
  flow_id: 'abc123',
  handler: 'hue',
  step_id: 'user',
  data_schema: [{ name: 'host', required: true, type: 'string' }],
  errors: null,
}

beforeEach(() => stubHa())
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('listHandlers', () => {
  it('gets the integration handler list', async () => {
    const fetchMock = mockFetch(200, ['hue', 'sonos'])
    const handlers = await listHandlers()
    expect(handlers).toEqual(['hue', 'sonos'])
    expect(fetchMock.mock.calls[0]![0]).toBe('http://ha.local:8123/api/config/config_entries/flow_handlers?type=integration')
  })

  it('sends the bearer token', async () => {
    const fetchMock = mockFetch(200, [])
    await listHandlers()
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers['Authorization']).toBe('Bearer secret-token')
  })

  it('sorts handlers so the picker is stable', async () => {
    mockFetch(200, ['sonos', 'hue', 'ambient'])
    expect(await listHandlers()).toEqual(['ambient', 'hue', 'sonos'])
  })

  it('rejects when Home Assistant is not configured', async () => {
    vi.stubEnv('HA_URL', '')
    await expect(listHandlers()).rejects.toThrow(/not configured/i)
  })
})

describe('listEntries', () => {
  it('returns the configured entries', async () => {
    mockFetch(200, [{ entry_id: 'e1', domain: 'hue', title: 'Hue Bridge', state: 'loaded' }])
    const entries = await listEntries()
    expect(entries[0]).toMatchObject({ entry_id: 'e1', domain: 'hue', state: 'loaded' })
  })

  it('tolerates a non-array body rather than throwing', async () => {
    mockFetch(200, { unexpected: true })
    expect(await listEntries()).toEqual([])
  })
})

describe('startFlow', () => {
  it('posts the handler and returns the first step', async () => {
    const fetchMock = mockFetch(200, FORM_STEP)
    const outcome = await startFlow('hue')
    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.step.flow_id).toBe('abc123')

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe('http://ha.local:8123/api/config/config_entries/flow')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ handler: 'hue' })
  })

  it('reports an unknown handler clearly', async () => {
    mockFetch(404, { message: 'Invalid handler specified' })
    const outcome = await startFlow('nope')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/Invalid handler/)
  })

  it('explains a 401 as an admin-token problem rather than a generic failure', async () => {
    mockFetch(401, {})
    const outcome = await startFlow('hue')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/admin/i)
  })

  it('handles the plain-text failed-dependencies body', async () => {
    mockFetch(400, 'Failed dependencies foo, bar', 'text/plain')
    const outcome = await startFlow('hue')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/Failed dependencies/)
  })
})

describe('submitStep', () => {
  it('posts the answers and returns the next step', async () => {
    const fetchMock = mockFetch(200, { ...FORM_STEP, step_id: 'link' })
    const outcome = await submitStep('abc123', { host: '10.0.0.4' })
    expect(outcome.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(url).toBe('http://ha.local:8123/api/config/config_entries/flow/abc123')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ host: '10.0.0.4' })
  })

  it('maps a 400 validation body to per-field errors', async () => {
    // HA answers a schema violation with 400 {"errors": {...}} — a different
    // shape from a 200 form step that merely carries an `errors` key.
    mockFetch(400, { errors: { host: 'invalid host' } })
    const outcome = await submitStep('abc123', { host: '!' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.fieldErrors).toEqual({ host: 'invalid host' })
  })

  it('keeps a 200 form step that carries errors as a successful step', async () => {
    mockFetch(200, { ...FORM_STEP, errors: { base: 'cannot_connect' } })
    const outcome = await submitStep('abc123', {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.step.errors).toEqual({ base: 'cannot_connect' })
  })

  it('reports an expired or unknown flow', async () => {
    mockFetch(404, { message: 'Invalid flow specified' })
    const outcome = await submitStep('gone', {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/Invalid flow/)
  })

  it('sends an empty object when there is nothing to submit', async () => {
    const fetchMock = mockFetch(200, FORM_STEP)
    await submitStep('abc123', {})
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual({})
  })
})

describe('getFlow', () => {
  it('re-reads the current step', async () => {
    const fetchMock = mockFetch(200, FORM_STEP)
    const outcome = await getFlow('abc123')
    expect(outcome.ok).toBe(true)
    expect(fetchMock.mock.calls[0]![0]).toBe('http://ha.local:8123/api/config/config_entries/flow/abc123')
  })
})

describe('abortFlow', () => {
  it('deletes the flow', async () => {
    const fetchMock = mockFetch(200, { message: 'Flow aborted' })
    expect(await abortFlow('abc123')).toEqual({ ok: true })
    const init = fetchMock.mock.calls[0]![1] as { method: string }
    expect(init.method).toBe('DELETE')
  })

  it('reports a failure without throwing', async () => {
    mockFetch(404, { message: 'Invalid flow specified' })
    const res = await abortFlow('gone')
    expect(res.ok).toBe(false)
  })
})

describe('deleteEntry / reloadEntry', () => {
  it('deletes an entry and reports whether a restart is needed', async () => {
    const fetchMock = mockFetch(200, { require_restart: true })
    const res = await deleteEntry('e1')
    expect(res).toEqual({ ok: true, requireRestart: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }]
    expect(url).toBe('http://ha.local:8123/api/config/config_entries/entry/e1')
    expect(init.method).toBe('DELETE')
  })

  it('reloads an entry', async () => {
    const fetchMock = mockFetch(200, { require_restart: false })
    expect(await reloadEntry('e1')).toEqual({ ok: true, requireRestart: false })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://ha.local:8123/api/config/config_entries/entry/e1/reload')
  })

  it('rejects an entry id that would escape the path', async () => {
    const fetchMock = mockFetch(200, {})
    const res = await deleteEntry('../../states')
    expect(res.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('parseDiscoveredFlows', () => {
  it('summarizes discovery flows', () => {
    const flows = parseDiscoveredFlows([
      {
        flow_id: 'f1', handler: 'hue',
        context: { source: 'zeroconf', title_placeholders: { name: 'Hue Bridge' }, unique_id: 'aa:bb' },
      },
    ])
    expect(flows).toEqual([
      { flowId: 'f1', handler: 'hue', source: 'zeroconf', title: 'Hue Bridge', uniqueId: 'aa:bb' },
    ])
  })

  it('falls back to the handler name when there is no title placeholder', () => {
    const flows = parseDiscoveredFlows([{ flow_id: 'f1', handler: 'sonos', context: { source: 'ssdp' } }])
    expect(flows[0]?.title).toBe('sonos')
  })

  it('skips rows with no flow id', () => {
    expect(parseDiscoveredFlows([{ handler: 'hue', context: {} }])).toEqual([])
  })

  it('tolerates a non-array input', () => {
    expect(parseDiscoveredFlows(null)).toEqual([])
  })
})
