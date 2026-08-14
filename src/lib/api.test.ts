import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchTelemetryHistory, fetchHaHistory, fetchHaEntities } from './api'

/** apiBase() reads `window.__HOMUNCULUS_API__` and falls back to
 *  `location.port`/`protocol`/`hostname`/`origin`. Stub both globals the way
 *  the browser would set them for each scenario under test. */
function stubEnv(opts: { apiOverride?: string; port?: string; origin?: string } = {}) {
  vi.stubGlobal('window', { __HOMUNCULUS_API__: opts.apiOverride })
  vi.stubGlobal('location', {
    port: opts.port ?? '5173',
    protocol: 'http:',
    hostname: 'localhost',
    origin: opts.origin ?? 'http://localhost:5173',
  })
}

function mockFetchOnce(ok: boolean, body: unknown, status = 200, statusText = 'error') {
  const fetchMock = vi.fn().mockResolvedValue({
    ok, status, statusText, json: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  stubEnv()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiBase resolution (via fetchHaEntities URL)', () => {
  it('uses the explicit override when set', async () => {
    stubEnv({ apiOverride: 'https://override.example/' })
    const fetchMock = mockFetchOnce(true, { entities: [] })
    await fetchHaEntities()
    expect(fetchMock.mock.calls[0][0]).toBe('https://override.example/api/history/entities')
  })

  it('targets :8787 when on the vite dev port 5173', async () => {
    stubEnv({ port: '5173' })
    const fetchMock = mockFetchOnce(true, { entities: [] })
    await fetchHaEntities()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/history/entities')
  })

  it('falls back to location.origin outside dev', async () => {
    stubEnv({ port: '8787', origin: 'http://localhost:8787' })
    const fetchMock = mockFetchOnce(true, { entities: [] })
    await fetchHaEntities()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/history/entities')
  })
})

describe('fetchTelemetryHistory', () => {
  it('builds the query string and returns points on success', async () => {
    const points = [{ ts: 1, value: 2 }]
    const fetchMock = mockFetchOnce(true, { metric: 'cpu', points })
    const result = await fetchTelemetryHistory('cpu', 100, 200, 50)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8787/api/history/telemetry?metric=cpu&from=100&to=200&limit=50'
    )
    expect(result).toEqual(points)
  })

  it('defaults limit to 1000', async () => {
    const fetchMock = mockFetchOnce(true, { metric: 'cpu', points: [] })
    await fetchTelemetryHistory('cpu', 0, 1)
    expect(fetchMock.mock.calls[0][0]).toContain('limit=1000')
  })

  it('returns an empty array when points is absent', async () => {
    mockFetchOnce(true, { metric: 'cpu' })
    expect(await fetchTelemetryHistory('cpu', 0, 1)).toEqual([])
  })

  it('throws on a non-ok response', async () => {
    mockFetchOnce(false, {}, 500, 'Internal Server Error')
    await expect(fetchTelemetryHistory('cpu', 0, 1)).rejects.toThrow('500 Internal Server Error')
  })

  it('URL-encodes the metric name', async () => {
    const fetchMock = mockFetchOnce(true, { points: [] })
    await fetchTelemetryHistory('cpu usage', 0, 1)
    expect(fetchMock.mock.calls[0][0]).toContain('metric=cpu%20usage')
  })
})

describe('fetchHaHistory', () => {
  it('builds the query string and returns points on success', async () => {
    const points = [{ ts: 5, value: null }]
    const fetchMock = mockFetchOnce(true, { entity_id: 'sensor.x', points })
    const result = await fetchHaHistory('sensor.x', 10, 20)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:8787/api/history/ha?entity_id=sensor.x&from=10&to=20&limit=1000'
    )
    expect(result).toEqual(points)
  })

  it('returns an empty array when points is absent', async () => {
    mockFetchOnce(true, { entity_id: 'sensor.x' })
    expect(await fetchHaHistory('sensor.x', 0, 1)).toEqual([])
  })

  it('throws on a non-ok response', async () => {
    mockFetchOnce(false, {}, 404, 'Not Found')
    await expect(fetchHaHistory('sensor.x', 0, 1)).rejects.toThrow('404 Not Found')
  })
})

describe('fetchHaEntities', () => {
  it('returns the entities list on success', async () => {
    mockFetchOnce(true, { entities: ['sensor.a', 'sensor.b'] })
    expect(await fetchHaEntities()).toEqual(['sensor.a', 'sensor.b'])
  })

  it('returns an empty array when entities is absent', async () => {
    mockFetchOnce(true, {})
    expect(await fetchHaEntities()).toEqual([])
  })

  it('throws on a non-ok response', async () => {
    mockFetchOnce(false, {}, 503, 'Unavailable')
    await expect(fetchHaEntities()).rejects.toThrow('503 Unavailable')
  })
})
