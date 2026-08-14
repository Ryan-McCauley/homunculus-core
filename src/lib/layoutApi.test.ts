import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchLayout, saveLayout, resetLayout, fetchSecrets, fetchSetupComplete, setSetupComplete,
} from './layoutApi'

function stubEnv(opts: { apiOverride?: string; port?: string; origin?: string; search?: string; tokenGlobal?: string } = {}) {
  vi.stubGlobal('window', { __HOMUNCULUS_API__: opts.apiOverride, __HOMUNCULUS_TOKEN__: opts.tokenGlobal })
  vi.stubGlobal('location', {
    port: opts.port ?? '5173',
    protocol: 'http:',
    hostname: 'localhost',
    origin: opts.origin ?? 'http://localhost:5173',
    search: opts.search ?? '',
  })
}

function mockFetch(ok: boolean, body: unknown, status = 200, statusText = 'err') {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, statusText, json: async () => body })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => stubEnv())
afterEach(() => vi.unstubAllGlobals())

describe('token handling (get/post helpers)', () => {
  it('appends the URL token to a GET request', async () => {
    stubEnv({ search: '?token=t1' })
    const fetchMock = mockFetch(true, { layout: {} })
    await fetchLayout()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/layout?token=t1')
  })

  it('omits the token param when none is present', async () => {
    const fetchMock = mockFetch(true, { layout: {} })
    await fetchLayout()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/layout')
  })
})

describe('fetchLayout', () => {
  it('returns the layout on success', async () => {
    const layout = { panels: [] }
    mockFetch(true, { layout })
    expect(await fetchLayout()).toEqual(layout)
  })

  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchLayout()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('saveLayout', () => {
  it('POSTs the layout and returns the saved layout', async () => {
    const layout = { panels: ['a'] }
    const fetchMock = mockFetch(true, { layout })
    const result = await saveLayout(layout as any)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/layout')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual({ layout })
    expect(result).toEqual(layout)
  })

  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 400, 'Bad Request')
    await expect(saveLayout({} as any)).rejects.toThrow('400 Bad Request')
  })
})

describe('resetLayout', () => {
  it('POSTs with an empty default body and returns the reset layout', async () => {
    const layout = { panels: [] }
    const fetchMock = mockFetch(true, { layout })
    const result = await resetLayout()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/layout/reset')
    expect(JSON.parse(init.body)).toEqual({})
    expect(result).toEqual(layout)
  })
})

describe('fetchSecrets', () => {
  it('returns the secrets view on success', async () => {
    const view = { specs: [], secrets: [], modules: {}, capability: 'full' }
    mockFetch(true, view)
    expect(await fetchSecrets()).toEqual(view)
  })

  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 403, 'Forbidden')
    await expect(fetchSecrets()).rejects.toThrow('403 Forbidden')
  })
})

describe('fetchSetupComplete / setSetupComplete', () => {
  it('fetchSetupComplete returns the complete flag', async () => {
    mockFetch(true, { complete: true })
    expect(await fetchSetupComplete()).toBe(true)
  })

  it('setSetupComplete POSTs the flag and returns the response', async () => {
    const fetchMock = mockFetch(true, { complete: false })
    const result = await setSetupComplete(false)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ complete: false })
    expect(result).toEqual({ complete: false })
  })

  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(setSetupComplete(true)).rejects.toThrow('500 Internal Server Error')
  })
})
