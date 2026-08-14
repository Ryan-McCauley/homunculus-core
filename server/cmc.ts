// CoinMarketCap cross-exchange volume cross-check.
//
// The volume gate in server/crypto.ts (see Swing4hEntry) is computed purely from
// Gemini's own candle feed. Gemini is thin relative to Binance/Coinbase/etc., so a
// coin can be genuinely breaking out market-wide while Gemini's own 4hr volume stays
// flat — faking a "falling" volTrend and blocking a good entry. This module fetches
// CMC's aggregated-across-exchanges 24h volume change as a secondary signal to
// override that false negative.
//
// SECURITY: CMC_API_KEY lives in .env only, never sent to the client.
//
// Free tier is 10k credits/mo (~333 calls/day) — one quotes/latest call costs
// 1 credit per ~100 symbols requested, so we cache aggressively and batch all
// watched symbols into a single call per refresh.

const CMC_API = 'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest'
const CACHE_TTL_MS = 3 * 60_000 // stay well under the free-tier daily credit budget

export interface CmcVolumeRead {
  volume24h: number
  volumeChange24h: number // percent, e.g. 12.4 = +12.4% vs prior 24h
  marketCap: number | null
}

let cache: { at: number; data: Map<string, CmcVolumeRead> } | null = null
let inFlight: Promise<Map<string, CmcVolumeRead>> | null = null

function apiKey(): string {
  return process.env['CMC_API_KEY'] || ''
}

export function cmcConfigured(): boolean {
  return !!apiKey()
}

/** Fetch (cached) CMC volume reads for the given base symbols (e.g. "BTC", "ETH"). */
export async function fetchCmcVolumes(baseSymbols: string[]): Promise<Map<string, CmcVolumeRead>> {
  const key = apiKey()
  if (!key || baseSymbols.length === 0) return new Map()

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const unique = [...new Set(baseSymbols.map((s) => s.toUpperCase()))]
      const url = `${CMC_API}?symbol=${encodeURIComponent(unique.join(','))}&aux=cmc_rank`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
        headers: { 'X-CMC_PRO_API_KEY': key, Accept: 'application/json' },
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CMC ${res.status}: ${body}`)
      }
      const json = await res.json() as {
        data: Record<string, Array<{
          cmc_rank: number | null
          quote: { USD: { volume_24h: number; volume_change_24h: number; market_cap: number | null } }
        }>>
      }
      const out = new Map<string, CmcVolumeRead>()
      for (const [sym, entries] of Object.entries(json.data || {})) {
        if (!entries || entries.length === 0) continue
        // Multiple listings can share a ticker (e.g. wrapped variants) — the lowest
        // cmc_rank (highest market cap) is the coin traders actually mean.
        const best = [...entries].sort((a, b) => (a.cmc_rank ?? Infinity) - (b.cmc_rank ?? Infinity))[0]!
        const q = best.quote?.USD
        if (!q) continue
        out.set(sym, {
          volume24h: q.volume_24h,
          volumeChange24h: q.volume_change_24h,
          marketCap: q.market_cap ?? null,
        })
      }
      cache = { at: Date.now(), data: out }
      return out
    } catch (err) {
      console.error('[cmc] fetch failed:', err instanceof Error ? err.message : err)
      // Keep serving the last good cache (even if stale) rather than blocking the gate.
      return cache?.data ?? new Map()
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}
