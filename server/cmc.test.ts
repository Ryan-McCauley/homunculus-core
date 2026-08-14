import { describe, it, expect, beforeEach, vi } from 'vitest'

// `cache`/`inFlight` are module-level singletons, and CACHE_TTL_MS is a fixed
// 3 minutes read at call time via Date.now() — so each test needs a fresh
// module instance and controls the clock explicitly rather than racing a real
// 3-minute window.
async function freshModule() {
  vi.resetModules()
  return import('./cmc')
}

function quoteResponse(entries: Record<string, { rank?: number; volume24h: number; volumeChange24h: number; marketCap?: number | null }>) {
  const data: Record<string, unknown[]> = {}
  for (const [sym, e] of Object.entries(entries)) {
    data[sym] = [{
      cmc_rank: e.rank ?? 1,
      quote: { USD: { volume_24h: e.volume24h, volume_change_24h: e.volumeChange24h, market_cap: e.marketCap ?? null } },
    }]
  }
  return { data }
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('CMC_API_KEY', 'test-key')
})

describe('cmcConfigured', () => {
  it('is false with no API key and true once one is set', async () => {
    vi.stubEnv('CMC_API_KEY', '')
    const noKey = await freshModule()
    expect(noKey.cmcConfigured()).toBe(false)

    vi.stubEnv('CMC_API_KEY', 'a-key')
    const withKey = await freshModule()
    expect(withKey.cmcConfigured()).toBe(true)
  })
})

describe('fetchCmcVolumes', () => {
  it('returns an empty map without fetching when no API key is configured', async () => {
    vi.stubEnv('CMC_API_KEY', '')
    const m = await freshModule()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await m.fetchCmcVolumes(['BTC'])
    expect(res.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns an empty map without fetching when given no symbols', async () => {
    const m = await freshModule()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await m.fetchCmcVolumes([])
    expect(res.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches, uppercases and dedupes symbols, and parses the response', async () => {
    const m = await freshModule()
    const fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) => okResponse(quoteResponse({
      BTC: { volume24h: 1_000_000, volumeChange24h: 5.5, marketCap: 900_000_000_000 },
    })))
    vi.stubGlobal('fetch', fetchMock)

    const res = await m.fetchCmcVolumes(['btc', 'BTC'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('symbol=BTC')
    expect(url).not.toContain('BTC%2CBTC')
    const [, opts] = fetchMock.mock.calls[0]!
    expect((opts as RequestInit).headers).toMatchObject({ 'X-CMC_PRO_API_KEY': 'test-key' })

    expect(res.get('BTC')).toEqual({ volume24h: 1_000_000, volumeChange24h: 5.5, marketCap: 900_000_000_000 })
  })

  it('picks the listing with the lowest cmc_rank when a ticker has multiple listings', async () => {
    const m = await freshModule()
    const body = {
      data: {
        XYZ: [
          { cmc_rank: 900, quote: { USD: { volume_24h: 1, volume_change_24h: 1, market_cap: 1 } } },
          { cmc_rank: 5, quote: { USD: { volume_24h: 42, volume_change_24h: 2, market_cap: 42 } } },
        ],
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)))
    const res = await m.fetchCmcVolumes(['XYZ'])
    expect(res.get('XYZ')!.volume24h).toBe(42)
  })

  it('treats a missing cmc_rank as lowest priority (Infinity), not highest', async () => {
    const m = await freshModule()
    const body = {
      data: {
        XYZ: [
          { cmc_rank: null, quote: { USD: { volume_24h: 1, volume_change_24h: 1, market_cap: 1 } } },
          { cmc_rank: 3, quote: { USD: { volume_24h: 42, volume_change_24h: 2, market_cap: 42 } } },
        ],
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)))
    const res = await m.fetchCmcVolumes(['XYZ'])
    expect(res.get('XYZ')!.volume24h).toBe(42)
  })

  it('caches a result and does not refetch within the TTL', async () => {
    const m = await freshModule()
    const fetchMock = vi.fn(async () => okResponse(quoteResponse({ BTC: { volume24h: 1, volumeChange24h: 1 } })))
    vi.stubGlobal('fetch', fetchMock)

    await m.fetchCmcVolumes(['BTC'])
    vi.advanceTimersByTime(2 * 60_000) // still inside the 3-minute TTL
    const res2 = await m.fetchCmcVolumes(['BTC'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res2.get('BTC')!.volume24h).toBe(1)
  })

  it('refetches once the cache TTL has expired', async () => {
    const m = await freshModule()
    const fetchMock = vi.fn(async () => okResponse(quoteResponse({ BTC: { volume24h: 1, volumeChange24h: 1 } })))
    vi.stubGlobal('fetch', fetchMock)

    await m.fetchCmcVolumes(['BTC'])
    vi.advanceTimersByTime(3 * 60_000 + 1)
    await m.fetchCmcVolumes(['BTC'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent calls into a single in-flight fetch', async () => {
    const m = await freshModule()
    let resolveFetch!: (v: unknown) => void
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const p1 = m.fetchCmcVolumes(['BTC'])
    const p2 = m.fetchCmcVolumes(['BTC'])
    resolveFetch(okResponse(quoteResponse({ BTC: { volume24h: 7, volumeChange24h: 1 } })))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r1.get('BTC')).toEqual(r2.get('BTC'))
  })

  it('on a non-ok HTTP response, logs and returns an empty map (no prior cache)', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'server error', json: async () => ({}) })))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await m.fetchCmcVolumes(['BTC'])
    expect(res.size).toBe(0)
    expect(errSpy).toHaveBeenCalled()
  })

  it('on a thrown fetch error, serves the last good cache instead of failing', async () => {
    const m = await freshModule()
    const goodFetch = vi.fn(async () => okResponse(quoteResponse({ BTC: { volume24h: 9, volumeChange24h: 1 } })))
    vi.stubGlobal('fetch', goodFetch)
    await m.fetchCmcVolumes(['BTC'])

    vi.advanceTimersByTime(3 * 60_000 + 1) // expire the cache so the next call refetches
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await m.fetchCmcVolumes(['BTC'])
    expect(res.get('BTC')!.volume24h).toBe(9)
  })

  it('skips a symbol whose data entry is empty or missing a USD quote', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ data: { BTC: [], ETH: [{ cmc_rank: 1, quote: {} }] } })))
    const res = await m.fetchCmcVolumes(['BTC', 'ETH'])
    expect(res.size).toBe(0)
  })
})
