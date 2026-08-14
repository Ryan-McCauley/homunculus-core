// Backfill ~12 months of daily Gold / Silver / BTC prices into the ASSETS history
// so the chart has a full year on first paint instead of accumulating live.
//
//   node scripts/backfill-assets.mjs
//
// Source: Yahoo Finance chart API (free, no key) — GC=F gold futures, SI=F silver
// futures, BTC-USD. Yahoo quotes metals as futures (~1% off physical spot), so each
// historical series is splice-aligned to the live gold-api spot price: every past
// close is scaled so the most recent one lands on today's spot. That removes the
// seam where this backfill hands off to the live poller (server/assets.ts), which
// keeps everything in spot terms.
//
// Output: data/assets/history.json — one point per UTC day, ascending. The live
// hub upserts today's point on top of this going forward. Safe to re-run (rebuilds).

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const DAY_MS = 24 * 60 * 60 * 1000
const DATA_DIR = join(process.cwd(), 'data', 'assets')
const HISTORY_FILE = join(DATA_DIR, 'history.json')

// Yahoo futures/crypto symbol per asset.
const YAHOO = { XAU: 'GC=F', XAG: 'SI=F', BTC: 'BTC-USD' }
const GOLD_API = 'https://api.gold-api.com'
const SYMBOLS = ['XAU', 'XAG', 'BTC']

const dayBucket = (t) => Math.floor(t / DAY_MS) * DAY_MS

async function fetchYahooDaily(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Yahoo ${sym} ${res.status}`)
  const json = await res.json()
  const r = json?.chart?.result?.[0]
  if (!r?.timestamp) throw new Error(`Yahoo ${sym} returned no data`)
  const closes = r.indicators.quote[0].close
  // Map<dayBucket, close>, dropping null closes (holidays with an open bar but no print).
  const m = new Map()
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = closes[i]
    if (c == null || !isFinite(c)) continue
    m.set(dayBucket(r.timestamp[i] * 1000), c)
  }
  return m
}

async function fetchSpot(assetSym) {
  const res = await fetch(`${GOLD_API}/price/${assetSym}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`gold-api ${assetSym} ${res.status}`)
  const price = Number((await res.json()).price)
  if (!isFinite(price) || price <= 0) throw new Error(`gold-api ${assetSym} bad price`)
  return price
}

async function main() {
  console.log('Fetching 1y daily history from Yahoo Finance…')
  const [byDay, spots] = await Promise.all([
    Promise.all(SYMBOLS.map((s) => fetchYahooDaily(YAHOO[s]))).then((arr) =>
      Object.fromEntries(SYMBOLS.map((s, i) => [s, arr[i]]))),
    Promise.all(SYMBOLS.map(fetchSpot)).then((arr) =>
      Object.fromEntries(SYMBOLS.map((s, i) => [s, arr[i]]))),
  ])

  // Splice-align: scale each historical series so its latest close == today's spot.
  const scale = {}
  for (const s of SYMBOLS) {
    const days = [...byDay[s].keys()].sort((a, b) => a - b)
    const lastClose = byDay[s].get(days[days.length - 1])
    scale[s] = spots[s] / lastClose
    console.log(`  ${s}: ${byDay[s].size} pts, futures→spot ×${scale[s].toFixed(4)} (spot $${spots[s]})`)
  }

  // Walk every day across the union range; forward-fill each series over gaps
  // (weekends/holidays for the metals) so all three are present at each point.
  const start = dayBucket(Date.now() - 365 * DAY_MS)
  const today = dayBucket(Date.now())
  const last = {}
  const samples = []
  for (let d = start; d <= today; d += DAY_MS) {
    for (const s of SYMBOLS) if (byDay[s].has(d)) last[s] = byDay[s].get(d) * scale[s]
    if (last.XAU == null || last.XAG == null || last.BTC == null) continue // wait until all seeded
    samples.push({ t: d, XAU: round(last.XAU), XAG: round(last.XAG), BTC: round(last.BTC) })
  }

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(HISTORY_FILE, JSON.stringify(samples))
  console.log(`\nWrote ${samples.length} daily points → ${HISTORY_FILE}`)
  console.log(`Range: ${new Date(samples[0].t).toISOString().slice(0, 10)} → ${new Date(samples[samples.length - 1].t).toISOString().slice(0, 10)}`)
}

const round = (n) => Math.round(n * 100) / 100

main().catch((e) => { console.error('Backfill failed:', e.message); process.exit(1) })
