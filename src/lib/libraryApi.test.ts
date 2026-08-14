import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchLibrary, fetchArtifact, fileArtifact, updateArtifact, deleteArtifact } from './libraryApi'

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

describe('fetchLibrary', () => {
  it('returns the artifacts list on success', async () => {
    const artifacts = [{ id: 'a1' }]
    const fetchMock = mockFetch({ ok: true, artifacts })
    const result = await fetchLibrary()
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/office/library')
    expect(result).toEqual(artifacts)
  })

  it('returns an empty array when artifacts is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchLibrary()).toEqual([])
  })

  it('propagates a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    await expect(fetchLibrary()).rejects.toThrow('down')
  })
})

describe('fetchArtifact', () => {
  it('returns the artifact by id on success', async () => {
    const artifact = { id: 'a1', body: 'text' }
    const fetchMock = mockFetch({ ok: true, artifact })
    const result = await fetchArtifact('a 1')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/crypto/office/library/a%201')
    expect(result).toEqual(artifact)
  })

  it('returns null when artifact is absent', async () => {
    mockFetch({ ok: true })
    expect(await fetchArtifact('missing')).toBeNull()
  })
})

describe('fileArtifact', () => {
  it('POSTs the input to the library root', async () => {
    const fetchMock = mockFetch({ ok: true, artifact: { id: 'a1' } })
    const input = { title: 'Doc', body: 'x' } as any
    const result = await fileArtifact(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/library')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(input)
    expect(result).toEqual({ ok: true, artifact: { id: 'a1' } })
  })
})

describe('updateArtifact', () => {
  it('PATCHes the id-scoped path with the patch', async () => {
    const fetchMock = mockFetch({ ok: true, artifact: { id: 'a1' } })
    await updateArtifact('a1', { title: 'New' } as any)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/library/a1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ title: 'New' })
  })
})

describe('deleteArtifact', () => {
  it('DELETEs the id-scoped path', async () => {
    const fetchMock = mockFetch({ ok: true })
    const result = await deleteArtifact('a1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8787/api/crypto/office/library/a1')
    expect(init.method).toBe('DELETE')
    expect(result).toEqual({ ok: true })
  })
})
