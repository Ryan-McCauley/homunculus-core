// CRYPTO tab server hub — multi-timeframe day/swing trading signals.
//
// Indicators: RSI-14, MACD(12/26/9), Bollinger Bands(20,2σ), MA20/50/200,
//   OBV, VWAP, ADX-14, Ichimoku Cloud, Fibonacci retracement.
// Signal categories: SHORT-TERM (15m/1hr) and MEDIUM-TERM (1day/1hr).
// Candle cache: persisted to disk so restarts skip re-seeding.

import { createHmac, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import type {
  CryptoSnapshot, Ticker, Holding, Signal, SignalDirection, EntryQuality,
  TimeframeSignal, MACDReading, BollingerReading, PendingTrade, TradeRecord,
  AutoStep, AutoPlanStatus, GeminiOrderOption, GeminiOpenOrder, GeminiTrade,
  BracketState, BracketSpec, BracketAdjust, BtcLadderCycle, BtcLadderAlert, AutoExecuteConfig,
  PortfolioGrowth, PeriodChange, PlanReportEntry, SafeModeArm, FeeRates,
  ClosedTrade, ClosedTradeStats, ClosedTradeBucket, ClosedTradeReport,
  CryptoPositionsSnapshot,
} from '../shared/crypto'
import { broadcastProactive } from './chat'
import { strategyRunner, getEnabledStrategy, isStrategyId, type StrategyId } from './strategyRunner'
import { alertStore } from './cryptoAlerts'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'
import { fetchCmcVolumes, cmcConfigured, type CmcVolumeRead } from './cmc'
import { AGENT_MAX_USD_CEILING, isAgentStrategyId } from '../shared/agents'

/** Fire a CRYPTO toast + archive record for a trade lifecycle event. Kept out of
 *  the ComputerCore conversation (chatLog:false) so fills don't spam the chat. */
function cryptoToast(
  head: string, sub: string,
  severity: 'info' | 'notice' | 'warn' | 'critical' = 'notice',
  icon = 'ti-currency-bitcoin'
): void {
  broadcastProactive(head, { source: 'CRYPTO', severity, title: head, sub, icon, chatLog: false })
}

const DATA_DIR = join(process.cwd(), 'data', 'crypto')
const TRADES_FILE = join(DATA_DIR, 'trades.json')
const PENDING_FILE = join(DATA_DIR, 'pending.json')
const CANDLE_CACHE_FILE = join(DATA_DIR, 'candle-cache.json')
const COST_BASIS_FILE = join(DATA_DIR, 'cost-basis.json')
const ACTIVE_BRACKET_FILE = join(DATA_DIR, 'active-bracket.json')
const CLOSED_TRADES_FILE = join(DATA_DIR, 'closed-trades.json')
const PLAN_REPORT_FILE = join(DATA_DIR, 'plan-report.json')
const PLAN_REPORTS_ARCHIVE_DIR = join(DATA_DIR, 'plan-reports')
const ACTIVE_PLANS_FILE = join(DATA_DIR, 'active-plans.json')
const BTC_CYCLES_FILE = join(DATA_DIR, 'btc-ladder-cycles.json')
const AUTO_EXECUTE_FILE = join(DATA_DIR, 'auto-execute.json')
const PORTFOLIO_BASELINE_FILE = join(DATA_DIR, 'portfolio-baseline.json')
const SAFE_MODE_FILE = join(DATA_DIR, 'safe-mode.json')
const SAFE_MODE_OPTOUT_FILE = join(DATA_DIR, 'safe-mode-optout.json')
// Safe mode is ON by default: eligible resting SELL orders are auto-armed with these
// levels unless the user has explicitly disarmed that order.
const SAFE_MODE_DEFAULT_STOP_PCT = 5
const SAFE_MODE_DEFAULT_EXIT_PCT = 0.1
const LOOP_MODE_FILE = join(DATA_DIR, 'loop-mode.json')
const RESTRICTED_SYMBOLS_FILE = join(DATA_DIR, 'restricted-symbols.json')
const GEMINI_REST = 'https://api.gemini.com'

type Timeframe = '1m' | '5m' | '15m' | '1hr' | '4hr' | '1day'
// Gemini candle: [timestamp_ms, open, high, low, close, volume]
type Candle = [number, number, number, number, number, number]

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// Symbols Gemini refuses to let this account trade (403 RestrictedSymbol). The public
// /v1/symbols list still includes them (e.g. WLFIUSD), so they'd otherwise be tracked and
// proposed — only order placement reveals the restriction. We learn them at order time,
// persist, and filter them out of the tracked universe so they're never proposed again.
function loadRestrictedSymbols(): string[] {
  try {
    return stateStore.readJson<string[]>(RESTRICTED_SYMBOLS_FILE, [])
  } catch { /* ignore */ }
  return []
}

const restrictedSymbols = new Set<string>(loadRestrictedSymbols().map((s) => s.toUpperCase()))

function isRestrictedSymbol(symbol: string): boolean {
  return restrictedSymbols.has(symbol.toUpperCase())
}

function markRestrictedSymbol(symbol: string): void {
  const s = symbol.toUpperCase()
  if (restrictedSymbols.has(s)) return
  restrictedSymbols.add(s)
  ensureDir()
  stateStore.writeJson(RESTRICTED_SYMBOLS_FILE, [...restrictedSymbols])
}

// ── Gemini public REST ─────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000), ...init })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

// Canonical USD-quoted pairs only. Everything else (BTC/ETH crosses, and the
// GUSD/RLUSD/USDT-quoted duplicates that end in GUSD/RLUSD/USDT) is noise data
// for this dashboard, so we drop it at the source — that shrinks the whole
// tracked universe: tickers, candle seeding, and signals all follow from here.
function isUsdPair(sym: string): boolean {
  const s = sym.toUpperCase()
  return s.endsWith('USD') && !s.endsWith('GUSD') && !s.endsWith('RLUSD')
}

async function fetchSymbols(): Promise<string[]> {
  const all = await fetchJson<string[]>(`${GEMINI_REST}/v1/symbols`)
  return all.filter(isUsdPair).filter((s) => !isRestrictedSymbol(s))
}

async function fetchTicker(symbol: string): Promise<Ticker | null> {
  try {
    // v2/ticker returns a real 24h open/high/low/close — v1/pubticker has NO open
    // field, which silently made every 24h change read 0.00%. v2 has no volume,
    // so we leave volume blank here and enrich it from the candle cache upstream.
    const raw = await fetchJson<{
      symbol: string; open: string; high: string; low: string; close: string
      changes: string[]; bid: string; ask: string
    }>(`${GEMINI_REST}/v2/ticker/${symbol.toLowerCase()}`)

    const last = Number(raw.close)
    const open = Number(raw.open)
    const change = open ? ((last - open) / open) * 100 : 0

    return {
      symbol: symbol.toUpperCase(),
      bid: raw.bid, ask: raw.ask, last: raw.close,
      volume: '0', open: raw.open, high: raw.high, low: raw.low,
      change: Number(change.toFixed(2)),
      updatedAt: Date.now(),
    }
  } catch {
    return null
  }
}

/** Roll oldest-first 1hr candles up into 4hr bars on UTC-aligned 4-hour buckets.
 *  Gemini's /v2/candles has no native 4hr feed (1m/5m/15m/30m/1hr/6hr/1day), and the
 *  4hr chart is the strategy's primary decision timeframe — so it's derived locally:
 *  open = first bar's open, high/low = extremes, close = last bar's close, volume =
 *  sum. The newest bucket is the forming 4hr bar (built from however many hourly
 *  bars have printed so far, including Gemini's live in-progress 1hr candle). */
const FOUR_H_MS = 4 * 60 * 60 * 1000
function aggregateTo4h(hourly: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const c of hourly) {
    const bucket = Math.floor(c[0] / FOUR_H_MS) * FOUR_H_MS
    const last = out[out.length - 1]
    if (last && last[0] === bucket) {
      last[2] = Math.max(last[2], c[2])
      last[3] = Math.min(last[3], c[3])
      last[4] = c[4]
      last[5] += c[5]
    } else {
      out.push([bucket, c[1], c[2], c[3], c[4], c[5]])
    }
  }
  return out
}

/** Fetch up to 500 candles for a symbol+timeframe. Returns oldest-first.
 *  '4hr' is synthesized from the 1hr feed (no native Gemini 4hr endpoint). */
async function fetchCandlesFromGemini(symbol: string, tf: Timeframe): Promise<Candle[]> {
  if (tf === '4hr') {
    const hourly = await fetchJson<Candle[]>(`${GEMINI_REST}/v2/candles/${symbol.toLowerCase()}/1hr`)
    return aggregateTo4h(hourly.slice(0, 500).reverse())
  }
  const raw = await fetchJson<Candle[]>(
    `${GEMINI_REST}/v2/candles/${symbol.toLowerCase()}/${tf}`
  )
  return raw.slice(0, 500).reverse()
}

// ── Gemini authenticated REST ──────────────────────────────────────────

// Gemini requires each nonce to strictly increase call-over-call. Date.now() alone
// collides when requests fire within the same millisecond (e.g. bracket legs placed
// back-to-back), which Gemini rejects with InvalidNonce. Track the last-issued value
// and bump past it so every call gets a unique, monotonically increasing nonce.
let lastNonce = 0
function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1)
  return lastNonce
}

function geminiAuthHeaders(endpoint: string, payload: Record<string, unknown>): Record<string, string> {
  const key = process.env['GEMINI_API_KEY'] || ''
  const secret = process.env['GEMINI_API_SECRET'] || ''
  if (!key || !secret) throw new Error('GEMINI_API_KEY / GEMINI_API_SECRET not set')
  const nonce = nextNonce()
  const body = { request: endpoint, nonce, ...payload }
  const b64 = Buffer.from(JSON.stringify(body)).toString('base64')
  const sig = createHmac('sha384', secret).update(b64).digest('hex')
  return {
    'Content-Type': 'text/plain',
    'X-GEMINI-APIKEY': key,
    'X-GEMINI-PAYLOAD': b64,
    'X-GEMINI-SIGNATURE': sig,
  }
}

// ── Serialize EVERY Gemini private REST call ────────────────────────────────
// Gemini rejects any private request whose nonce is <= the highest it has already
// processed. Fired concurrently (a refresh races holdings + open-orders + per-symbol
// order-status polls + placements/cancels), their monotonic nonces ARRIVE at Gemini out
// of order and every request landing after a higher one comes back InvalidNonce — which
// surfaces as a silent `[]`, a thrown error, or (worst) a failed order placement/cancel.
// That intermittently dropped trade history AND lost the WLD take-profit when its
// cancel/replace raced other calls. Chaining every private call so each fully completes
// before the next is sent guarantees in-order arrival. The nonce is generated INSIDE the
// chain (right before send) so generation order matches send order. Public calls
// (candles/ticker/symbols — no nonce) are unaffected and stay parallel.
let geminiPrivateChain: Promise<unknown> = Promise.resolve()
function geminiPrivateFetch(endpoint: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<Response> {
  const send = (): Promise<Response> => {
    const headers = geminiAuthHeaders(endpoint, payload)
    return fetch(`${GEMINI_REST}${endpoint}`, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) })
  }
  const run = geminiPrivateChain.then(send, send)   // run whether the prior call resolved or rejected
  geminiPrivateChain = run.then(() => undefined, () => undefined)
  return run
}

// Cache tick sizes so we don't re-fetch on every order
const tickSizeCache = new Map<string, number>()

async function fetchTickSize(symbol: string): Promise<number> {
  const cached = tickSizeCache.get(symbol)
  if (cached !== undefined) return cached
  const res = await fetch(`${GEMINI_REST}/v1/symbols/details/${symbol.toLowerCase()}`, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) return 1e-8  // safe fallback
  const data = await res.json() as { tick_size?: number }
  const ts = data.tick_size ?? 1e-8
  tickSizeCache.set(symbol, ts)
  return ts
}

// Truncate (floor) amount to the symbol's allowed decimal precision
async function floorToTickSize(amount: number, symbol: string): Promise<string> {
  const ts = await fetchTickSize(symbol)
  const decimals = Math.round(-Math.log10(ts))
  const factor = Math.pow(10, decimals)
  return (Math.floor(amount * factor) / factor).toFixed(decimals)
}

// Gemini rejects prices that don't conform to the symbol's quote increment.
const quoteIncrementCache = new Map<string, number>()
async function fetchQuoteIncrement(symbol: string): Promise<number> {
  const cached = quoteIncrementCache.get(symbol)
  if (cached !== undefined) return cached
  try {
    const res = await fetch(`${GEMINI_REST}/v1/symbols/details/${symbol.toLowerCase()}`, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return 1e-8
    const data = await res.json() as { quote_increment?: number }
    const qi = data.quote_increment ?? 1e-8
    quoteIncrementCache.set(symbol, qi)
    return qi
  } catch { return 1e-8 }
}

/** Round a computed price to the symbol's quote increment so the order is accepted. */
async function roundToQuoteIncrement(price: number, symbol: string): Promise<string> {
  const qi = await fetchQuoteIncrement(symbol)
  const decimals = Math.max(0, Math.round(-Math.log10(qi)))
  const factor = Math.pow(10, decimals)
  return (Math.round(price * factor) / factor).toFixed(decimals)
}

async function fetchHoldings(): Promise<Holding[]> {
  const endpoint = '/v1/balances'
  const res = await geminiPrivateFetch(endpoint, { account: 'primary' })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Gemini balances ${res.status}: ${errBody}`)
  }
  const raw = await res.json() as Array<{ currency: string; amount: string; available: string }>
  const holdings = raw
    .filter((b) => Number(b.amount) > 0)
    .map((b) => ({ currency: b.currency, amount: b.amount, available: b.available, amountNotional: '' }))
  // Always include USD even if Gemini omits it (zero balance or all locked in orders)
  if (!holdings.find((h) => h.currency === 'USD')) {
    const usd = raw.find((b) => b.currency === 'USD')
    holdings.unshift({ currency: 'USD', amount: usd?.amount ?? '0', available: usd?.available ?? '0', amountNotional: '' })
  }
  return holdings
}

/** Suspected cause of the opaque "Entry cancelled on exchange" bracket failures: placing a
 *  resting BUY at/above one of our own resting SELLs on the same symbol (e.g. an older
 *  bracket's take-profit the market has since fallen back below) would cross our own book.
 *  Gemini's self-trade handling appears to cancel the crossing order in that case rather
 *  than fill it, and the bracket only finds out once its poll loop sees is_cancelled — with
 *  no indication of why. Check open orders before placing so we reprice a hair clear of our
 *  own resting order instead of finding out only after the cancel. Symmetric on both sides
 *  (a resting SELL crossing one of our own resting BUYs is the same failure mode reversed). */
async function avoidSelfCross(symbol: string, side: 'buy' | 'sell', price: string): Promise<string> {
  try {
    const opposite = side === 'buy' ? 'sell' : 'buy'
    const open = (await fetchOpenOrders()).filter((o) => o.symbol === symbol && o.side === opposite)
    if (!open.length) return price
    const p = Number(price)
    if (side === 'buy') {
      const lowestSell = Math.min(...open.map((o) => Number(o.price)))
      if (p >= lowestSell) return (lowestSell * 0.999).toFixed(8)
    } else {
      const highestBuy = Math.max(...open.map((o) => Number(o.price)))
      if (p <= highestBuy) return (highestBuy * 1.001).toFixed(8)
    }
  } catch { /* best effort — fall through to the original price if the open-orders check fails */ }
  return price
}

/** ── Exit fee policy ──────────────────────────────────────────────────────
 *  Gemini charges the MAKER fee on an order that rests on the book and the TAKER fee on
 *  one that crosses the spread. On this account that's 0.6% vs 1.2% — the exit fee is
 *  double if we cross. An audit of the full fill history (2026-07-18) found 53 taker sell
 *  exits that paid $28.73 where maker pricing would have cost $7.48: $21.25 of avoidable
 *  fees, on a portfolio under $900.
 *
 *  Policy, per operator directive: NO exit crosses the book automatically. Every automated
 *  sell rests. Downside protection comes from safe mode (a resting maker sell), not from a
 *  stop that prices through the trigger to guarantee its fill. Where an exit genuinely has
 *  to cross, it is staged as a confirm-first pending trade showing the fee delta and sends
 *  nothing until the operator approves it — never placed silently.
 *
 *  The trade-off this accepts, stated plainly: a resting exit can go unfilled if price runs
 *  away from it. That is the cost of not paying 1.2%, and it is the behaviour the operator chose. */
const MAKER_ONLY: GeminiOrderOption[] = ['maker-or-cancel']

/**
 * Per-timeframe weights for the composite signal — the single source of truth.
 *
 * 4hr=40% is the heaviest tier: the strategy's primary decision timeframe (the operator
 * 2026-07-05 — BB + volume on 4hr candles drive trade selection). 1day=30% anchors
 * regime; 1hr=20% and 15m=10% are timing colour. 5m/1m exist only for portfolio
 * holdings (see FAST_TIMEFRAMES) and add on top — totalWeight normalizes over
 * whichever tiers are actually present.
 *
 * Exported as a constant because the intel report prints these in its footer, and
 * that footer spent a long time quoting a stale set (1day=40 / 1hr=35 / 15m=25) that
 * no longer matched the code. The report is read by the trading model, so a wrong
 * footer is not a documentation nit — it tells the model the wrong hierarchy.
 */
const SIGNAL_WEIGHTS: Record<Timeframe, number> = {
  '1day': 0.30, '4hr': 0.40, '1hr': 0.20, '15m': 0.10, '5m': 0.08, '1m': 0.05,
}

async function placeOrder(
  symbol: string, side: 'buy' | 'sell', amount: string,
  price?: string, stopPrice?: string, orderOptions?: GeminiOrderOption[],
  clientOrderId?: string,
): Promise<string> {
  const endpoint = '/v1/order/new'
  const isStopLimit = !!stopPrice
  const isMarket = !price && !stopPrice
  // Only resting limit orders can sit on the book long enough to cross a stale order of
  // ours on the other side — market/IOC orders fill-or-die immediately, no guard needed.
  const crossSafe = (price && !isStopLimit) ? await avoidSelfCross(symbol, side, price) : price
  // Gemini rejects any price that doesn't conform to the symbol's quote increment
  // ("Invalid price for symbol …"). Round every price/stop-price to that increment HERE so
  // callers can pass a raw computed price (e.g. firecracker's RSI-scaled entry legs) without
  // each having to pre-round — and so avoidSelfCross's .toFixed(8) reprice can't slip through
  // with too many decimals either. Idempotent: an already-rounded price rounds to itself.
  const safePrice = crossSafe != null ? await roundToQuoteIncrement(Number(crossSafe), symbol) : crossSafe
  const safeStop = stopPrice != null ? await roundToQuoteIncrement(Number(stopPrice), symbol) : stopPrice
  // Gemini rejects amounts with more precision than the symbol's tick size ("Invalid quantity
  // for symbol …"). Floor (never round up — can't sell/buy more than intended) HERE so callers
  // passing a raw held/remaining balance (e.g. closePosition's full PEPE bag, modify's
  // remainingAmount) conform without each pre-flooring. Idempotent: an already-floored amount
  // floors to itself.
  const safeAmount = await floorToTickSize(Number(amount), symbol)
  const payload: Record<string, unknown> = {
    symbol: symbol.toLowerCase(), amount: safeAmount, side, account: 'primary',
    type: isStopLimit ? 'exchange stop limit' : isMarket ? 'exchange market' : 'exchange limit',
    options: (orderOptions && orderOptions.length > 0) ? orderOptions : (isMarket ? ['immediate-or-cancel'] : []),
  }
  // Gemini dedupes on client_order_id: resubmitting the same id is rejected, which — together
  // with the reconcile in runBracket — guarantees an entry can never be placed twice.
  if (clientOrderId) payload['client_order_id'] = clientOrderId
  if (safePrice) payload['price'] = safePrice
  if (safeStop) payload['stop_price'] = safeStop
  let res = await geminiPrivateFetch(endpoint, payload, 15_000)
  if (!res.ok) {
    let body = await res.text().catch(() => '')
    // InvalidQuantity has been observed even after flooring to the symbol's tick size
    // (e.g. large-supply meme coins — a 2026-07-10 PEPE exit-sweep sell rejected at 6
    // decimals). Root cause unconfirmed (possibly a total-significant-digits cap Gemini
    // doesn't document), so self-heal instead of chasing it further: retry with
    // progressively fewer decimals (one fewer each attempt, down to a whole number)
    // before giving up. A client_order_id can only be submitted once, so retries omit it
    // — the caller's reconcile logic (idempotent entries) is unaffected since this path
    // is for exits/manual sells, never bracket entries with a clientOrderId collision risk.
    if (res.status === 400 && body.includes('InvalidQuantity') && !clientOrderId) {
      const startDecimals = (payload['amount'] as string).split('.')[1]?.length ?? 0
      for (let d = startDecimals - 1; d >= 0 && !res.ok; d--) {
        const retryAmount = Number(safeAmount).toFixed(d)
        if (Number(retryAmount) <= 0) break
        payload['amount'] = retryAmount
        res = await geminiPrivateFetch(endpoint, payload, 15_000)
        if (!res.ok) body = await res.text().catch(() => '')
      }
    }
    if (!res.ok) {
      // Gemini 403s symbols this account can't trade (e.g. WLFIUSD). Learn it so the tracked
      // universe drops it on the next refresh and it's never proposed/staged again.
      if (res.status === 403 && body.includes('RestrictedSymbol')) markRestrictedSymbol(symbol)
      throw new Error(`Order failed ${res.status}: ${body}`)
    }
  }
  const data = await res.json() as { order_id: string }
  return data.order_id
}

// `price` is the order's own resting limit price (Gemini returns it on every order
// record). It's the authoritative, just-fetched value for a live order — prefer it over
// the CryptoHub snapshot's openOrders mirror, which only refreshes every ~30s.
async function fetchOrderStatus(orderId: string): Promise<{
  order_id: string; symbol: string; side: 'buy' | 'sell'; price: string
  is_live: boolean; is_cancelled: boolean
  executed_amount: string; remaining_amount: string; avg_execution_price: string
}> {
  const endpoint = '/v1/order/status'
  const res = await geminiPrivateFetch(endpoint, { order_id: orderId, account: 'primary' })
  if (!res.ok) throw new Error(`Order status ${res.status}`)
  return res.json() as Promise<{
    order_id: string; symbol: string; side: 'buy' | 'sell'; price: string
    is_live: boolean; is_cancelled: boolean
    executed_amount: string; remaining_amount: string; avg_execution_price: string
  }>
}

/** Real USD fees paid on a specific order, read from the filled-order trade records
 *  (/v1/mytrades). This is the authoritative fee source — each fill carries its own
 *  fee_amount/fee_currency — so we sum the USD fees across every fill of `orderId`.
 *  Non-USD-denominated fees are ignored (they reduce the received base amount, which is
 *  already reflected in the balance). Best effort: returns 0 if the lookup fails. */
async function feeUsdForOrder(symbol: string, orderId: string): Promise<number> {
  if (!orderId) return 0
  try {
    const trades = await fetchMyTrades(symbol, 200)
    return trades.reduce(
      (s, t) => s + (t.order_id === orderId && t.fee_currency === 'USD' ? Number(t.fee_amount) : 0),
      0,
    )
  } catch { return 0 }
}

async function fetchCurrencyBalance(currency: string): Promise<number> {
  const holdings = await fetchHoldings()
  const h = holdings.find((h) => h.currency === currency.toUpperCase())
  // Use available (free-to-trade) balance for order sizing — avoids spending locked funds
  return Number(h?.available ?? h?.amount ?? '0')
}

/** Total balance INCLUDING amounts locked in resting orders. Used to decide whether a
 *  position still exists — `available` reads ~0 while the position is locked in its
 *  protective stop, which must NOT be mistaken for "position closed". */
async function fetchCurrencyTotal(currency: string): Promise<number> {
  const holdings = await fetchHoldings()
  const h = holdings.find((h) => h.currency === currency.toUpperCase())
  return Number(h?.amount ?? '0')
}

async function fetchOpenOrders(): Promise<GeminiOpenOrder[]> {
  const endpoint = '/v1/orders'
  const res = await geminiPrivateFetch(endpoint, { account: 'primary' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`fetchOpenOrders ${res.status}: ${body}`)
  }
  const raw = await res.json() as Array<{
    order_id: string; symbol: string; side: string; type: string
    price: string; stop_price?: string
    original_amount: string; executed_amount: string; remaining_amount: string
    avg_execution_price: string; timestampms: number; client_order_id?: string
  }>
  return raw.map((o) => ({
    orderId: o.order_id,
    symbol: o.symbol.toUpperCase(),
    side: o.side as 'buy' | 'sell',
    type: o.type,
    price: o.price,
    stopPrice: o.stop_price,
    originalAmount: o.original_amount,
    executedAmount: o.executed_amount,
    remainingAmount: o.remaining_amount,
    avgExecutionPrice: o.avg_execution_price,
    timestampMs: o.timestampms,
    clientOrderId: o.client_order_id,
  }))
}

async function fetchMyTrades(symbol: string, limitTrades = 100, sinceMs?: number): Promise<Array<{
  tid: string; order_id: string; price: string; amount: string; type: 'Buy' | 'Sell'
  timestampms: number; fee_currency: string; fee_amount: string; aggressor: boolean
}>> {
  const endpoint = '/v1/mytrades'
  const payload: Record<string, unknown> = { symbol: symbol.toUpperCase(), limit_trades: limitTrades, account: 'primary' }
  // `timestamp` lower-bounds the result; Gemini accepts seconds. We also filter client-side.
  if (sinceMs) payload['timestamp'] = Math.floor(sinceMs / 1000)
  const res = await geminiPrivateFetch(endpoint, payload)
  if (!res.ok) return []
  return res.json() as Promise<Array<{
    tid: string; order_id: string; price: string; amount: string; type: 'Buy' | 'Sell'
    timestampms: number; fee_currency: string; fee_amount: string; aggressor: boolean
  }>>
}

/** Deposits/withdrawals since `sinceMs` (best effort, up to 50). Used to net out external
 *  transfers when reconstructing a historical balance baseline, so growth stays trading-only. */
async function fetchTransfers(sinceMs?: number): Promise<Array<{
  type: string; status: string; currency: string; amount: string; timestampms: number
}>> {
  const endpoint = '/v1/transfers'
  const payload: Record<string, unknown> = { limit_transfers: 50, account: 'primary' }
  if (sinceMs) payload['timestamp'] = Math.floor(sinceMs / 1000)
  try {
    const res = await geminiPrivateFetch(endpoint, payload)
    if (!res.ok) return []
    return res.json() as Promise<Array<{ type: string; status: string; currency: string; amount: string; timestampms: number }>>
  } catch { return [] }
}

/** Manual cost-basis overrides ({ "JTO": 0.81, ... }) for positions Gemini's
 *  trade history can't reconstruct (transfers in, trades older than the window,
 *  or buys executed off this account). Takes precedence over computed basis. */
function loadCostBasisOverrides(): Record<string, number> {
  try {
    return stateStore.readJson<Record<string, number>>(COST_BASIS_FILE, {})
  } catch { /* ignore */ }
  return {}
}

function saveCostBasisOverride(currency: string, price: number | null): Record<string, number> {
  ensureDir()
  const overrides = loadCostBasisOverrides()
  if (price === null) delete overrides[currency.toUpperCase()]
  else overrides[currency.toUpperCase()] = price
  stateStore.writeJson(COST_BASIS_FILE, overrides)
  return overrides
}

/** Weighted average cost basis for a currency. Manual override wins; otherwise
 *  reconstruct from recent trade history. Returns null when basis is unknown
 *  (NEVER 0 — a 0 basis would render the whole position as fake profit). */
async function computeCostBasis(currency: string, currentAmount: number): Promise<number | null> {
  if (currency === 'USD' || currency === 'USDT' || currency === 'GUSD') return 1
  if (currentAmount <= 0) return null
  // Manual override takes precedence over computed basis
  const override = loadCostBasisOverrides()[currency.toUpperCase()]
  if (typeof override === 'number' && override > 0) return override
  try {
    const trades = await fetchMyTrades(`${currency}USD`, 200)
    // Walk trades newest-first, accumulate buy lots until we cover current position
    const buys = trades
      .filter((t) => t.type === 'Buy')
      .sort((a, b) => b.timestampms - a.timestampms)
    // No buy history → basis genuinely unknown. Return null, not 0.
    if (buys.length === 0) return null
    let remaining = currentAmount
    let totalCost = 0
    for (const t of buys) {
      if (remaining <= 0) break
      const lotAmt = Number(t.amount)
      const amt = Math.min(lotAmt, remaining)
      // Fees are deliberately IGNORED (operator rule): the basis is the raw traded
      // notional, price × amount. Gemini's fee is already reflected in the totals
      // the account settles at, so adding it here double-counts and skews P&L.
      totalCost += amt * Number(t.price)
      remaining -= amt
    }
    // Sub-1% remainder is dust (rounding from fees/partial sells), not a real
    // uncovered lot — ignore it rather than dragging in a stale historical price.
    const isDust = remaining > 0 && remaining / currentAmount < 0.01
    if (remaining > 0 && !isDust) {
      // More held than we have buy records — fill remaining at oldest known price
      const oldestPrice = Number(buys[buys.length - 1].price)
      totalCost += remaining * oldestPrice
    } else if (isDust) {
      remaining = 0
    }
    const basis = totalCost / currentAmount
    return basis > 0 ? basis : null
  } catch {
    return null
  }
}

/** Measure the account's REAL effective fee rates from its own recent fills, so P&L
 *  uses the fees Gemini actually charged rather than a fixed assumption. Rate =
 *  fee_amount ÷ notional, notional-weighted (which de-emphasizes tiny orders whose
 *  effective % is inflated by Gemini's per-trade minimum), split maker vs taker.
 *  Only USD-denominated fees count — a base-currency fee reduces the amount received,
 *  which the balance already reflects (same rule as computeCostBasis). Falls back to
 *  Gemini's ActiveTrader entry-tier rates until there are fills to measure. */
function measureFeeRates(fills: GeminiTrade[]): FeeRates {
  let mFee = 0, mNot = 0, tFee = 0, tNot = 0, samples = 0
  for (const t of fills) {
    if (t.feeCurrency !== 'USD') continue
    const notional = Number(t.price) * Number(t.amount)
    const fee = Number(t.feeAmount)
    if (!(notional > 0) || !(fee >= 0)) continue
    samples++
    if (t.isAggressor) { tFee += fee; tNot += notional } else { mFee += fee; mNot += notional }
  }
  const maker = mNot > 0 ? mFee / mNot : 0.002   // 0.20% ActiveTrader entry-tier default
  const taker = tNot > 0 ? tFee / tNot : 0.004   // 0.40% default
  const blended = (mNot + tNot) > 0 ? (mFee + tFee) / (mNot + tNot) : 0.003
  return {
    maker: Number(maker.toFixed(5)),
    taker: Number(taker.toFixed(5)),
    blended: Number(blended.toFixed(5)),
    samples,
  }
}

async function cancelOrder(orderId: string): Promise<void> {
  const endpoint = '/v1/order/cancel'
  const res = await geminiPrivateFetch(endpoint, { order_id: orderId, account: 'primary' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`cancelOrder ${res.status}: ${body}`)
  }
}

/** How long to wait after a verified cancel before spending the freed balance.
 *  Gemini releases the locked funds asynchronously, so an immediate replacement can
 *  be rejected for insufficient funds even though the cancel succeeded. */
const BALANCE_RELEASE_MS = 1_500

/**
 * Cancel, confirm the order actually left the book, then wait for the balance.
 *
 * The planner has always done this (AutoPlanner.cancelOrder); the CryptoHub
 * cancel-and-replace paths — closePosition, modifyOpenOrder, closeSymbolPosition,
 * fireSafeMode — called the bare cancelOrder above and placed the replacement
 * immediately. Both halves matter: Gemini can 200 a cancel while the order is still
 * briefly live, and the freed balance lands later still. Getting either wrong leaves
 * the replacement rejected and the position uncovered — which, for fireSafeMode,
 * is precisely during the drop the stop exists for.
 */
async function cancelOrderVerified(orderId: string, waitForBalance = true): Promise<void> {
  await cancelOrder(orderId)
  try {
    const s = await fetchOrderStatus(orderId)
    if (s.is_live) throw new Error(`${orderId} still live after cancel`)
  } catch (err) {
    throw new Error(`cancel verify failed: ${(err as Error).message}`)
  }
  // Callers cancelling a batch skip the per-order wait and sleep once at the end.
  if (waitForBalance) await sleep(BALANCE_RELEASE_MS)
}

// ── Indicator math ─────────────────────────────────────────────────────

function closes(candles: Candle[]): number[] { return candles.map((c) => c[4]) }
function highs(candles: Candle[]): number[] { return candles.map((c) => c[2]) }
function lows(candles: Candle[]): number[] { return candles.map((c) => c[3]) }
function volumes(candles: Candle[]): number[] { return candles.map((c) => c[5]) }

function sma(prices: number[], n: number): number | null {
  if (prices.length < n) return null
  return prices.slice(-n).reduce((a, b) => a + b, 0) / n
}

function ema(prices: number[], n: number): number[] {
  if (prices.length < n) return []
  const k = 2 / (n + 1)
  const result: number[] = []
  let val = prices.slice(0, n).reduce((a, b) => a + b, 0) / n
  result.push(val)
  for (let i = n; i < prices.length; i++) {
    val = prices[i]! * k + val * (1 - k)
    result.push(val)
  }
  return result
}

/** Weighted moving average series (weight = position, most-recent heaviest).
 *  Returns one value per index where a full window is available (index n-1 onward). */
function wmaSeries(prices: number[], n: number): number[] {
  if (n < 1 || prices.length < n) return []
  const denom = (n * (n + 1)) / 2
  const out: number[] = []
  for (let i = n - 1; i < prices.length; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += prices[i - n + 1 + j]! * (j + 1)
    out.push(s / denom)
  }
  return out
}

/** Hull Moving Average — HMA(n) = WMA(2·WMA(n/2) − WMA(n), round(√n)).
 *  Near-zero-lag trend line; used as the reversal "reclaim" trigger for bounce
 *  entries (price back above its fast Hull MA = the turn is confirmed, not a
 *  still-falling knife). Returns the latest HMA value, or null if too little data. */
function hma(prices: number[], n: number): number | null {
  const half = Math.round(n / 2)
  const sqrtN = Math.round(Math.sqrt(n))
  if (half < 1 || sqrtN < 1) return null
  const wHalf = wmaSeries(prices, half)
  const wFull = wmaSeries(prices, n)
  const len = Math.min(wHalf.length, wFull.length)
  if (len < sqrtN) return null
  const raw: number[] = []
  for (let i = 0; i < len; i++) {
    raw.push(2 * wHalf[wHalf.length - len + i]! - wFull[wFull.length - len + i]!)
  }
  const hmaSeries = wmaSeries(raw, sqrtN)
  return hmaSeries.length ? hmaSeries[hmaSeries.length - 1]! : null
}

/** On-Balance Volume as a full series (index i = OBV as of candles[i]). */
function calcOBVSeries(candles: Candle[]): number[] {
  if (candles.length < 2) return []
  const out: number[] = [0]
  let obv = 0
  for (let i = 1; i < candles.length; i++) {
    const close = candles[i]![4], prevClose = candles[i - 1]![4], vol = candles[i]![5]
    if (close > prevClose) obv += vol
    else if (close < prevClose) obv -= vol
    out.push(obv)
  }
  return out
}

/** Wilder-smoothed RSI series over the full price array (index i = RSI as of prices[i]).
 *  Uses the standard Wilder recursive average (avg = (avg*(n-1) + new)/n) after an
 *  initial simple-average seed over the first `period` deltas — this is what every
 *  charting platform (TradingView, exchanges) means by "RSI-14," and it's what the
 *  score thresholds in this file (RSI<30, <45, >70, etc.) were tuned against.
 *  A plain rolling-simple-average RSI (the old implementation) numerically diverges
 *  from this, especially in trending markets, which silently skews every threshold. */
function wilderRsiSeries(prices: number[], period = 14): number[] {
  if (prices.length < period + 1) return []
  const deltas: number[] = []
  for (let i = 1; i < prices.length; i++) deltas.push(prices[i]! - prices[i - 1]!)
  let avgGain = 0, avgLoss = 0
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!
    if (d >= 0) avgGain += d; else avgLoss += -d
  }
  avgGain /= period
  avgLoss /= period
  const series: number[] = []
  const rsiFrom = (g: number, l: number): number => (l === 0 ? 100 : Number((100 - 100 / (1 + g / l)).toFixed(2)))
  series.push(rsiFrom(avgGain, avgLoss))
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!
    const gain = d >= 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    series.push(rsiFrom(avgGain, avgLoss))
  }
  return series
}

function rsi14(prices: number[]): number | null {
  const series = wilderRsiSeries(prices, 14)
  return series.length ? series[series.length - 1]! : null
}

/** Invert Wilder RSI-14: the next-candle close price at which RSI would equal
 *  `targetRsi`. Used by the FLASH-DIP track to stage a resting limit AT the
 *  predicted RSI-30–33 bottom instead of reacting after the fact.
 *
 *  Recomputes the trailing avgGain/avgLoss (the same Wilder recurrence as
 *  `wilderRsiSeries`), then — assuming a DOWN move next bar (gain = 0) — solves
 *  for the loss that lands RSI on target:
 *    avgGain' = avgGain·(p-1)/p ;  RS_target = T/(100-T) ;  avgLoss' = avgGain'/RS_target
 *    loss = avgLoss'·p − avgLoss·(p-1) ;  predictedPrice = lastClose − loss
 *  `alreadyThere` when loss ≤ 0 (RSI already at/through the target — no further
 *  drop needed). Returns null when there isn't enough history. This is a
 *  single-next-candle estimate: a real dip to the target may take several bars,
 *  so the caller pairs it with a hard stop + short expiry. */
function predictPriceForRsi(
  prices: number[],
  targetRsi: number,
  period = 14,
): { predictedPrice: number; lossNeeded: number; alreadyThere: boolean } | null {
  if (prices.length < period + 1) return null
  if (targetRsi <= 0 || targetRsi >= 100) return null
  const deltas: number[] = []
  for (let i = 1; i < prices.length; i++) deltas.push(prices[i]! - prices[i - 1]!)
  let avgGain = 0, avgLoss = 0
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!
    if (d >= 0) avgGain += d; else avgLoss += -d
  }
  avgGain /= period
  avgLoss /= period
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!
    const gain = d >= 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  const lastClose = prices[prices.length - 1]!
  const avgGainNext = (avgGain * (period - 1)) / period // gain = 0 on a down move
  const rsTarget = targetRsi / (100 - targetRsi)
  if (rsTarget <= 0) return null
  const avgLossTarget = avgGainNext / rsTarget
  const lossNeeded = avgLossTarget * period - avgLoss * (period - 1)
  if (lossNeeded <= 0) {
    // RSI is already at or below the target — no further drop required.
    return { predictedPrice: lastClose, lossNeeded, alreadyThere: true }
  }
  return { predictedPrice: lastClose - lossNeeded, lossNeeded, alreadyThere: false }
}

function calcMacd(prices: number[]): MACDReading | null {
  if (prices.length < 35) return null
  const ema12 = ema(prices, 12)
  const ema26 = ema(prices, 26)
  if (!ema12.length || !ema26.length) return null
  const len = Math.min(ema12.length, ema26.length)
  const macdLine = ema12.slice(-len).map((v, i) => v - ema26.slice(-len)[i]!)
  const signalLine = ema(macdLine, 9)
  if (!signalLine.length) return null
  const macdVal = macdLine[macdLine.length - 1]!
  const sigVal = signalLine[signalLine.length - 1]!
  return {
    macd: Number(macdVal.toFixed(6)),
    signal: Number(sigVal.toFixed(6)),
    histogram: Number((macdVal - sigVal).toFixed(6)),
  }
}

function bollingerBands(prices: number[], n = 20, stdDevMult = 2): BollingerReading | null {
  if (prices.length < n) return null
  const slice = prices.slice(-n)
  const middle = slice.reduce((a, b) => a + b, 0) / n
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - middle, 2), 0) / n
  const stdDev = Math.sqrt(variance)
  const upper = middle + stdDevMult * stdDev
  const lower = middle - stdDevMult * stdDev
  const lastPrice = prices[prices.length - 1]!
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0
  const percentB = (upper - lower) > 0 ? (lastPrice - lower) / (upper - lower) : 0.5
  return {
    upper: Number(upper.toFixed(6)),
    middle: Number(middle.toFixed(6)),
    lower: Number(lower.toFixed(6)),
    bandwidth: Number(bandwidth.toFixed(4)),
    percentB: Number(percentB.toFixed(4)),
  }
}

/** On-Balance Volume: cumulative volume with direction tied to close vs prev close */
function calcOBV(candles: Candle[]): number | null {
  if (candles.length < 2) return null
  let obv = 0
  for (let i = 1; i < candles.length; i++) {
    const close = candles[i]![4]
    const prevClose = candles[i - 1]![4]
    const vol = candles[i]![5]
    if (close > prevClose) obv += vol
    else if (close < prevClose) obv -= vol
  }
  return obv
}

/** ADX-14: trend strength 0-100. Returns { adx, plusDI, minusDI } */
function calcADX(candles: Candle[], n = 14): { adx: number; plusDI: number; minusDI: number } | null {
  if (candles.length < n * 2) return null
  const tr: number[] = []
  const plusDM: number[] = []
  const minusDM: number[] = []

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i]![2]
    const low = candles[i]![3]
    const prevHigh = candles[i - 1]![2]
    const prevLow = candles[i - 1]![3]
    const prevClose = candles[i - 1]![4]

    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
    const upMove = high - prevHigh
    const downMove = prevLow - low
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Wilder's smoothing
  function wilderSmooth(arr: number[], period: number): number[] {
    const result: number[] = []
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0)
    result.push(sum)
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i]!
      result.push(sum)
    }
    return result
  }

  const smoothTR = wilderSmooth(tr, n)
  const smoothPlusDM = wilderSmooth(plusDM, n)
  const smoothMinusDM = wilderSmooth(minusDM, n)

  const dx: number[] = []
  for (let i = 0; i < smoothTR.length; i++) {
    const atr = smoothTR[i]!
    if (atr === 0) { dx.push(0); continue }
    const pdi = (smoothPlusDM[i]! / atr) * 100
    const mdi = (smoothMinusDM[i]! / atr) * 100
    dx.push(Math.abs(pdi - mdi) / (pdi + mdi || 1) * 100)
  }

  // ADX = Wilder-smoothed AVERAGE of DX (dx is already a 0-100 percentage series).
  // BUG FIX: this used to reuse `wilderSmooth` above, which is a sum-accumulating
  // smoother appropriate for TR/+DM/-DM (whose ratio cancels the scale in pdi/mdi)
  // but NOT for an already-normalized 0-100 series — applying it to dx summed 14
  // percentages instead of averaging them, inflating ADX up to ~14x (values like
  // "ADX 396" were showing up in real reports). This seeds with a simple average
  // over the first `period` dx values, then applies the standard Wilder recursive
  // average: adx = (prevAdx*(period-1) + dx[i]) / period.
  if (dx.length < n) return null
  let adxVal = dx.slice(0, n).reduce((a, b) => a + b, 0) / n
  for (let i = n; i < dx.length; i++) {
    adxVal = (adxVal * (n - 1) + dx[i]!) / n
  }

  const lastI = smoothTR.length - 1
  const lastATR = smoothTR[lastI]!
  const plusDI = lastATR > 0 ? (smoothPlusDM[lastI]! / lastATR) * 100 : 0
  const minusDI = lastATR > 0 ? (smoothMinusDM[lastI]! / lastATR) * 100 : 0

  return {
    adx: Number(adxVal.toFixed(2)),
    plusDI: Number(plusDI.toFixed(2)),
    minusDI: Number(minusDI.toFixed(2)),
  }
}

/** VWAP: typical price × volume / cumulative volume */
function calcVWAP(candles: Candle[]): number | null {
  if (candles.length < 2) return null
  // Use last session (last 96 candles for 15m ≈ 1 day, last 24 for 1hr)
  const session = candles.slice(-96)
  let tpv = 0, totalVol = 0
  for (const c of session) {
    const tp = (c[2] + c[3] + c[4]) / 3 // (high + low + close) / 3
    tpv += tp * c[5]
    totalVol += c[5]
  }
  return totalVol > 0 ? tpv / totalVol : null
}

/** Ichimoku Cloud (9/26/52) — returns key values relative to current price */
function calcIchimoku(candles: Candle[]): {
  tenkan: number | null; kijun: number | null
  senkouA: number | null; senkouB: number | null
  aboveCloud: boolean | null; cloudBullish: boolean | null
} | null {
  if (candles.length < 52) return null

  function midpoint(arr: Candle[], period: number, offset = 0): number | null {
    const slice = arr.slice(-(period + offset), offset > 0 ? -offset : undefined)
    if (slice.length < period) return null
    const h = Math.max(...slice.map((c) => c[2]))
    const l = Math.min(...slice.map((c) => c[3]))
    return (h + l) / 2
  }

  const tenkan = midpoint(candles, 9)
  const kijun = midpoint(candles, 26)
  // Senkou spans are plotted 26 periods ahead; we read the current cloud
  const senkouA = (tenkan !== null && kijun !== null) ? (tenkan + kijun) / 2 : null
  const senkouB = midpoint(candles, 52)

  const close = candles[candles.length - 1]![4]
  const cloudTop = senkouA !== null && senkouB !== null ? Math.max(senkouA, senkouB) : null

  return {
    tenkan, kijun, senkouA, senkouB,
    aboveCloud: cloudTop !== null ? close > cloudTop : null,
    cloudBullish: senkouA !== null && senkouB !== null ? senkouA > senkouB : null,
  }
}

/** Stochastic RSI (3/3/14/14) — returns %K and %D in 0-100 range */
function calcStochRSI(prices: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number } | null {
  if (prices.length < rsiPeriod + stochPeriod + kSmooth + dSmooth) return null
  // Wilder-smoothed RSI series (was a rolling simple-average loop — see wilderRsiSeries).
  const rsiSeries = wilderRsiSeries(prices, rsiPeriod)
  if (rsiSeries.length < stochPeriod) return null
  // Stochastic of RSI series
  const kRaw: number[] = []
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1)
    const lo = Math.min(...window), hi = Math.max(...window)
    kRaw.push(hi === lo ? 50 : ((rsiSeries[i]! - lo) / (hi - lo)) * 100)
  }
  if (kRaw.length < kSmooth) return null
  const kSmoothed = kRaw.slice(-kSmooth).reduce((a, b) => a + b, 0) / kSmooth
  // D = SMA of last dSmooth k values
  const kForD = kRaw.slice(-dSmooth)
  if (kForD.length < dSmooth) return null
  const d = kForD.reduce((a, b) => a + b, 0) / dSmooth
  return { k: Number(kSmoothed.toFixed(2)), d: Number(d.toFixed(2)) }
}

/** Find local swing pivots in a series: index i is a low pivot if it's the minimum
 *  (high pivot: maximum) within [i-radius, i+radius]. This is standard fractal/zigzag
 *  pivot detection — used instead of an arbitrary window-half min/max split so that
 *  divergence compares two *actual* swing points rather than two window extremes that
 *  may not correspond to real turning points (which can straddle the split boundary
 *  and produce false positives, or miss a real divergence whose pivots don't happen
 *  to land on either side of the midpoint). */
function findPivots(values: number[], radius: number, kind: 'low' | 'high'): number[] {
  const pivots: number[] = []
  for (let i = radius; i < values.length - radius; i++) {
    const window = values.slice(i - radius, i + radius + 1)
    const v = values[i]!
    const isPivot = kind === 'low' ? v === Math.min(...window) : v === Math.max(...window)
    if (isPivot) pivots.push(i)
  }
  return pivots
}

/** Detect RSI divergence over the most recent N candles, using real swing pivots
 *  (not a naive window-half split) for both price and RSI.
 *  Bullish: price makes a lower low but RSI makes a higher low → reversal signal.
 *  Bearish: price makes a higher high but RSI makes a lower high → reversal signal.
 *  Returns null if insufficient data, fewer than two pivots, or no divergence found. */
function detectRSIDivergence(
  candles: Candle[],
  prices: number[],
  lookback = 20
): { type: 'bullish' | 'bearish'; strength: 'strong' | 'moderate'; priceChange: number; rsiChange: number } | null {
  const period = 14
  if (candles.length < lookback + period || prices.length < lookback + period) return null
  const recentCandles = candles.slice(-lookback)

  // Full Wilder RSI series, then align so rsiForRecent[j] is "RSI as of recentCandles[j]".
  const fullRsi = wilderRsiSeries(prices, period)
  if (fullRsi.length < lookback) return null
  const rsiForRecent = fullRsi.slice(-lookback)

  const lows = recentCandles.map((c) => c[3])
  const highs = recentCandles.map((c) => c[2])
  const minSeparation = 3 // pivots closer than this are the same swing, not two distinct ones

  // ── Bullish: two most recent distinct swing lows, lower-low in price / higher-low in RSI ──
  const lowPivots = findPivots(lows, 2, 'low')
  if (lowPivots.length >= 2) {
    const p2 = lowPivots[lowPivots.length - 1]!
    const p1 = lowPivots[lowPivots.length - 2]!
    if (p2 - p1 >= minSeparation) {
      const priceLow1 = lows[p1]!, priceLow2 = lows[p2]!
      const rsiLow1 = rsiForRecent[p1]!, rsiLow2 = rsiForRecent[p2]!
      // Only tradeable when the recent pivot is in oversold territory — a higher RSI
      // low up at 55 is noise. Require RSI ≤ 45 and ≥3pt separation (not a 2pt wiggle).
      if (priceLow2 < priceLow1 * 0.995 && rsiLow2 > rsiLow1 + 3 && rsiLow2 <= 45) {
        const priceChange = ((priceLow2 - priceLow1) / priceLow1) * 100
        const rsiChange = rsiLow2 - rsiLow1
        // Reject data-artifact swings: a >20% gap between adjacent pivots is almost
        // always a listing gap / missing candle, not a tradeable divergence.
        if (Math.abs(priceChange) <= 20) {
          const strength = rsiChange > 8 || Math.abs(priceChange) > 3 ? 'strong' : 'moderate'
          return { type: 'bullish', strength, priceChange: Number(priceChange.toFixed(2)), rsiChange: Number(rsiChange.toFixed(1)) }
        }
      }
    }
  }

  // ── Bearish: two most recent distinct swing highs, higher-high in price / lower-high in RSI ──
  const highPivots = findPivots(highs, 2, 'high')
  if (highPivots.length >= 2) {
    const p2 = highPivots[highPivots.length - 1]!
    const p1 = highPivots[highPivots.length - 2]!
    if (p2 - p1 >= minSeparation) {
      const priceHigh1 = highs[p1]!, priceHigh2 = highs[p2]!
      const rsiHigh1 = rsiForRecent[p1]!, rsiHigh2 = rsiForRecent[p2]!
      // Mirror gate: bearish divergence only counts in overbought territory (RSI ≥ 55).
      if (priceHigh2 > priceHigh1 * 1.005 && rsiHigh2 < rsiHigh1 - 3 && rsiHigh2 >= 55) {
        const priceChange = ((priceHigh2 - priceHigh1) / priceHigh1) * 100
        const rsiChange = rsiHigh2 - rsiHigh1
        if (Math.abs(priceChange) <= 20) {
          const strength = Math.abs(rsiChange) > 8 || Math.abs(priceChange) > 3 ? 'strong' : 'moderate'
          return { type: 'bearish', strength, priceChange: Number(priceChange.toFixed(2)), rsiChange: Number(rsiChange.toFixed(1)) }
        }
      }
    }
  }

  return null
}

/** Detect candlestick reversal patterns on the most recent candles.
 *  Hammer: small body near top of range, long lower wick ≥ 2× body — bullish reversal at lows.
 *  Bullish engulfing: current green candle body fully covers prior red candle body.
 *  Shooting star: inverse hammer at highs — bearish reversal. */
function detectCandlePatterns(candles: Candle[]): string[] {
  const patterns: string[] = []
  if (candles.length < 2) return patterns
  const [, open, high, low, close] = candles[candles.length - 1]!
  const prev = candles[candles.length - 2]!
  const body = Math.abs(close - open)
  const range = high - low
  const lowerWick = Math.min(open, close) - low
  const upperWick = high - Math.max(open, close)

  // Hammer / inverted hammer (at recent low → bullish reversal)
  const recentLow = Math.min(...candles.slice(-10).map((c) => c[3]))
  const nearLow = low <= recentLow * 1.02
  if (nearLow && body > 0 && lowerWick >= body * 2 && upperWick < body * 0.5) {
    patterns.push('hammer (bullish reversal)')
  }

  // Shooting star (at recent high → bearish reversal)
  const recentHigh = Math.max(...candles.slice(-10).map((c) => c[2]))
  const nearHigh = high >= recentHigh * 0.98
  if (nearHigh && body > 0 && upperWick >= body * 2 && lowerWick < body * 0.5) {
    patterns.push('shooting star (bearish reversal)')
  }

  // Bullish engulfing
  const prevBody = Math.abs(prev[4] - prev[1])
  if (close > open && prev[4] < prev[1] && close > prev[1] && open < prev[4] && prevBody > 0) {
    patterns.push('bullish engulfing')
  }

  // Bearish engulfing
  if (close < open && prev[4] > prev[1] && close < prev[1] && open > prev[4] && prevBody > 0) {
    patterns.push('bearish engulfing')
  }

  // Doji at extreme (indecision)
  if (range > 0 && body / range < 0.1 && range > 0) {
    if (nearLow) patterns.push('doji at low (indecision → possible reversal)')
    if (nearHigh) patterns.push('doji at high (indecision → possible reversal)')
  }

  return patterns
}

/** Detect capitulation: unusually large-volume red candle at or near a recent low.
 *  Classic exhaustion signal that often precedes a bounce. */
function detectCapitulation(candles: Candle[]): { detected: boolean; volumeMultiple: number } {
  if (candles.length < 20) return { detected: false, volumeMultiple: 0 }
  const last = candles[candles.length - 1]!
  const avgVol = candles.slice(-20, -1).reduce((s, c) => s + c[5], 0) / 19
  const volumeMultiple = avgVol > 0 ? last[5] / avgVol : 0
  const isBearishCandle = last[4] < last[1]
  const recentLow = Math.min(...candles.slice(-10).map((c) => c[3]))
  const nearLow = last[3] <= recentLow * 1.01
  const bodyPct = Math.abs(last[4] - last[1]) / (last[2] - last[3] || 1)
  // Capitulation = high volume + bearish candle + at low + large body
  const detected = volumeMultiple >= 1.8 && isBearishCandle && nearLow && bodyPct > 0.5
  return { detected, volumeMultiple: Number(volumeMultiple.toFixed(2)) }
}

/** Fibonacci retracement levels from recent swing high/low */
function calcFibLevels(candles: Candle[]): {
  swingHigh: number; swingLow: number
  levels: Record<string, number>
} | null {
  if (candles.length < 20) return null
  const recent = candles.slice(-50)
  const swingHigh = Math.max(...recent.map((c) => c[2]))
  const swingLow = Math.min(...recent.map((c) => c[3]))
  const range = swingHigh - swingLow
  return {
    swingHigh, swingLow,
    levels: {
      '23.6%': swingHigh - range * 0.236,
      '38.2%': swingHigh - range * 0.382,
      '50.0%': swingHigh - range * 0.500,
      '61.8%': swingHigh - range * 0.618,
      '78.6%': swingHigh - range * 0.786,
    },
  }
}

// ── Per-timeframe signal computation ──────────────────────────────────

// ── Market-history summarizer (for the trading skill's own analysis) ────
// Condenses up to 500 raw candles per timeframe into structured stats the model
// can reason over — support/resistance, range position, volatility, trend — so
// it isn't flooded with thousands of raw rows.

function recentSlice<T>(arr: T[], n: number): T[] { return arr.length > n ? arr.slice(-n) : arr }

function linregSlope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0
  const xs = ys.map((_, i) => i)
  const sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0)
  const sxx = xs.reduce((a, b) => a + b * b, 0)
  const sxy = xs.reduce((a, _b, i) => a + xs[i]! * ys[i]!, 0)
  const d = n * sxx - sx * sx
  return d === 0 ? 0 : (n * sxy - sx * sy) / d
}

function atr(candles: Candle[], n = 14): number | null {
  if (candles.length < n + 1) return null
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    const h = candles[i]![2], l = candles[i]![3], pc = candles[i - 1]![4]
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  return sum / n
}

/** Pivot highs/lows: a bar whose high/low is the extreme of a ±k window. */
function pivots(candles: Candle[], k = 3): { resistance: number[]; support: number[] } {
  const resistance: number[] = [], support: number[] = []
  for (let i = k; i < candles.length - k; i++) {
    const h = candles[i]![2], l = candles[i]![3]
    let isHi = true, isLo = true
    for (let j = i - k; j <= i + k; j++) {
      if (candles[j]![2] > h) isHi = false
      if (candles[j]![3] < l) isLo = false
    }
    if (isHi) resistance.push(h)
    if (isLo) support.push(l)
  }
  return { resistance, support }
}

function summarizeCandles(candles: Candle[], tf: Timeframe): Record<string, unknown> {
  if (candles.length < 20) return { insufficient: true, candleCount: candles.length }
  const cl = closes(candles)
  const last = cl[cl.length - 1]!
  const window = recentSlice(candles, tf === '1day' ? 120 : 200)
  const hh = Math.max(...highs(window)), ll = Math.min(...lows(window))
  const piv = pivots(recentSlice(candles, 150))
  const nearestRes = piv.resistance.filter((p) => p > last).sort((a, b) => a - b).slice(0, 3)
  const nearestSup = piv.support.filter((p) => p < last).sort((a, b) => b - a).slice(0, 3)
  const recentCl = recentSlice(cl, 31)
  const rets: number[] = []
  for (let i = 1; i < recentCl.length; i++) rets.push((recentCl[i]! - recentCl[i - 1]!) / recentCl[i - 1]!)
  const vol = rets.length ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) : 0
  const a = atr(candles)
  return {
    candleCount: candles.length,
    last: Number(last.toFixed(8)),
    periodHigh: Number(hh.toFixed(8)), periodLow: Number(ll.toFixed(8)),
    pctFromHigh: Number(((last - hh) / hh * 100).toFixed(2)),
    pctFromLow: Number(((last - ll) / ll * 100).toFixed(2)),
    rangePosition: Number(((last - ll) / ((hh - ll) || 1)).toFixed(3)),
    ma20: sma(cl, 20), ma50: sma(cl, 50), ma200: sma(cl, 200),
    bb: bollingerBands(cl),
    atr: a != null ? Number(a.toFixed(8)) : null,
    atrPct: a != null ? Number((a / last * 100).toFixed(2)) : null,
    realizedVolPct: Number((vol * 100).toFixed(2)),
    trendSlopePctPerBar: Number((linregSlope(recentSlice(cl, 30)) / last * 100).toFixed(4)),
    nearestResistance: nearestRes.map((p) => Number(p.toFixed(8))),
    nearestSupport: nearestSup.map((p) => Number(p.toFixed(8))),
  }
}

function computeTimeframeSignal(tf: Timeframe, candles: Candle[], lastPrice: number): TimeframeSignal {
  // Refresh the forming candle's close (and widen its high/low if the live price is
  // a new extreme) with the current price INSTEAD of appending it as an extra bar.
  // The old code did `[...closes(candles), lastPrice]`, which pushed a phantom extra
  // period onto every windowed indicator (RSI-14 last-15, BB(20), MA200, etc.) — that
  // shifts every period-based average by one slot and effectively double-counts the
  // most recent move once the exchange candle feed itself already reflects it (Gemini's
  // candle endpoint returns the in-progress bar live). Patching in place keeps window
  // lengths correct while still giving a live-updating current bar.
  const liveCandles: Candle[] = candles.length > 0
    ? [...candles.slice(0, -1), (() => {
        const last = candles[candles.length - 1]!
        return [last[0], last[1], Math.max(last[2], lastPrice), Math.min(last[3], lastPrice), lastPrice, last[5]] as Candle
      })()]
    : candles
  const prices = closes(liveCandles)

  const rsiVal = rsi14(prices)
  const macdVal = calcMacd(prices)
  const bbVal = bollingerBands(prices)
  const ma20Val = sma(prices, 20)
  const ma50Val = sma(prices, 50)
  const ma200Val = sma(prices, 200)
  const obvVal = calcOBV(liveCandles)
  const adxVal = calcADX(liveCandles)
  const vwapVal = calcVWAP(liveCandles)
  const ichimokuVal = calcIchimoku(liveCandles)
  const fibVal = calcFibLevels(liveCandles)
  const stochRsiVal = calcStochRSI(prices)
  const divergence = detectRSIDivergence(liveCandles, prices)
  const candlePatterns = detectCandlePatterns(liveCandles)
  const capitulation = detectCapitulation(liveCandles)

  const reasons: string[] = []
  let score = 50
  let bullishSignals = 0, bearishSignals = 0

  // ── RSI ──
  if (rsiVal !== null) {
    if (rsiVal < 30) { reasons.push(`RSI ${rsiVal} oversold`); score += 20; bullishSignals++ }
    else if (rsiVal < 40) { reasons.push(`RSI ${rsiVal} approaching oversold`); score += 8 }
    else if (rsiVal > 70) { reasons.push(`RSI ${rsiVal} overbought`); score -= 20; bearishSignals++ }
    else if (rsiVal > 60) { reasons.push(`RSI ${rsiVal} approaching overbought`); score -= 8 }
    else reasons.push(`RSI ${rsiVal} neutral`)
  }

  // ── MACD ──
  if (macdVal !== null) {
    if (macdVal.histogram > 0 && macdVal.macd > macdVal.signal) {
      reasons.push('MACD bullish crossover'); score += 18; bullishSignals++
    } else if (macdVal.histogram < 0 && macdVal.macd < macdVal.signal) {
      reasons.push('MACD bearish crossover'); score -= 18; bearishSignals++
    } else if (macdVal.histogram > 0) {
      reasons.push('MACD histogram positive'); score += 6
    } else {
      reasons.push('MACD histogram negative'); score -= 6
    }
  }

  // ── Bollinger Bands ──
  if (bbVal !== null) {
    if (bbVal.percentB < 0.05) { reasons.push('BB lower band touch (oversold squeeze)'); score += 18; bullishSignals++ }
    else if (bbVal.percentB < 0.2) { reasons.push(`BB lower zone (%B ${(bbVal.percentB * 100).toFixed(0)}%)`); score += 8 }
    else if (bbVal.percentB > 0.95) { reasons.push('BB upper band touch (overbought squeeze)'); score -= 18; bearishSignals++ }
    else if (bbVal.percentB > 0.8) { reasons.push(`BB upper zone (%B ${(bbVal.percentB * 100).toFixed(0)}%)`); score -= 8 }
    if (bbVal.bandwidth < 0.015) reasons.push(`BB tight squeeze (bw ${bbVal.bandwidth}) — breakout imminent`)
    else if (bbVal.bandwidth > 0.1) reasons.push(`BB wide (bw ${bbVal.bandwidth}) — high volatility`)
  }

  // ── Moving Averages ──
  if (ma20Val !== null) {
    if (lastPrice > ma20Val) { score += 5 }
    else { score -= 5 }
  }
  if (ma50Val !== null) {
    if (lastPrice > ma50Val) { reasons.push(`Above MA50`); score += 8 }
    else { reasons.push(`Below MA50`); score -= 8 }
  }
  if (ma200Val !== null) {
    if (lastPrice > ma200Val) { reasons.push('Above MA200 (bull market structure)'); score += 12; bullishSignals++ }
    else { reasons.push('Below MA200 (bear market structure)'); score -= 12; bearishSignals++ }
  }
  if (ma50Val !== null && ma200Val !== null) {
    if (ma50Val > ma200Val) { reasons.push('Golden cross (MA50 > MA200)'); score += 12 }
    else { reasons.push('Death cross (MA50 < MA200)'); score -= 12 }
  }

  // ── OBV ──
  if (obvVal !== null && liveCandles.length >= 10) {
    // Compare OBV trend: last 10 candles
    const prevOBV = (() => {
      let o = 0
      for (let i = 1; i < liveCandles.length - 10; i++) {
        const d = liveCandles[i]![4] - liveCandles[i - 1]![4]
        o += d > 0 ? liveCandles[i]![5] : d < 0 ? -liveCandles[i]![5] : 0
      }
      return o
    })()
    if (obvVal > prevOBV * 1.02) { reasons.push('OBV rising (buying pressure)'); score += 8; bullishSignals++ }
    else if (obvVal < prevOBV * 0.98) { reasons.push('OBV falling (selling pressure)'); score -= 8; bearishSignals++ }
  }

  // ── HMA(13) reclaim + OBV(3/8) MA cross — reversal-turn confirmation ──
  // Two "is the turn real yet?" checks adapted from the Micropulse reversal method
  // (fee-aware port: signals only, targets/fees/gates unchanged). HMA reclaim = price
  // back at/above its near-zero-lag Hull MA (no longer a falling knife). OBV MA cross =
  // fast cumulative-volume flow crossing above slow = buyers actively stepping in
  // (leading, distinct from the one-bar VolExpansion participation gate).
  const hmaVal = hma(prices, 13)
  if (hmaVal !== null && lastPrice >= hmaVal * 0.995) {
    reasons.push('HMA13 reclaim (price back above fast Hull MA)')
  }
  {
    const obvSeries = calcOBVSeries(liveCandles)
    if (obvSeries.length >= 9) {
      const s3 = sma(obvSeries, 3), s8 = sma(obvSeries, 8)
      const s3Prev = sma(obvSeries.slice(0, -1), 3), s8Prev = sma(obvSeries.slice(0, -1), 8)
      if (s3 !== null && s8 !== null && s3 > s8) {
        reasons.push('OBV MA bullish (3>8 flow up)')
        if (s3Prev !== null && s8Prev !== null && s3Prev <= s8Prev) {
          reasons.push('OBV MA cross-up (fresh buyer flow)')
        }
      }
    }
  }

  // ── ADX ──
  if (adxVal !== null) {
    const { adx, plusDI, minusDI } = adxVal
    if (adx > 25) {
      if (plusDI > minusDI) { reasons.push(`ADX ${adx} strong uptrend (+DI>${minusDI.toFixed(0)})`); score += 10; bullishSignals++ }
      else { reasons.push(`ADX ${adx} strong downtrend (-DI>${plusDI.toFixed(0)})`); score -= 10; bearishSignals++ }
    } else {
      reasons.push(`ADX ${adx} (ranging — low trend confidence)`)
    }
  }

  // ── VWAP ──
  if (vwapVal !== null) {
    if (lastPrice > vwapVal * 1.005) { reasons.push(`Above VWAP $${vwapVal.toFixed(4)}`); score += 6 }
    else if (lastPrice < vwapVal * 0.995) { reasons.push(`Below VWAP $${vwapVal.toFixed(4)}`); score -= 6 }
    else reasons.push(`At VWAP $${vwapVal.toFixed(4)}`)
  }

  // ── Ichimoku ──
  if (ichimokuVal !== null) {
    if (ichimokuVal.aboveCloud === true) {
      reasons.push('Above Ichimoku cloud (bullish)'); score += 12; bullishSignals++
    } else if (ichimokuVal.aboveCloud === false) {
      reasons.push('Below Ichimoku cloud (bearish)'); score -= 12; bearishSignals++
    }
    if (ichimokuVal.tenkan !== null && ichimokuVal.kijun !== null) {
      if (ichimokuVal.tenkan > ichimokuVal.kijun) { score += 5 }
      else { score -= 5 }
    }
    if (ichimokuVal.cloudBullish === true) score += 5
    else if (ichimokuVal.cloudBullish === false) score -= 5
  }

  // ── Fibonacci ──
  if (fibVal !== null) {
    const close = lastPrice
    const fib382 = fibVal.levels['38.2%']!
    const fib618 = fibVal.levels['61.8%']!
    const fib500 = fibVal.levels['50.0%']!
    if (Math.abs(close - fib618) / close < 0.015) { reasons.push('Near Fib 61.8% support'); score += 8 }
    else if (Math.abs(close - fib382) / close < 0.015) { reasons.push('Near Fib 38.2% support'); score += 5 }
    else if (Math.abs(close - fib500) / close < 0.015) { reasons.push('Near Fib 50% level') }
  }

  // ── Stochastic RSI ──
  if (stochRsiVal !== null) {
    const { k, d } = stochRsiVal
    if (k < 20 && d < 20) {
      reasons.push(`StochRSI oversold (K:${k} D:${d}) — high-probability bounce zone`)
      score += 15; bullishSignals++
    } else if (k < 20 && d >= 20) {
      reasons.push(`StochRSI K oversold (${k}) approaching signal line — early bounce`)
      score += 8
    } else if (k > 80 && d > 80) {
      reasons.push(`StochRSI overbought (K:${k} D:${d}) — reversal risk`)
      score -= 15; bearishSignals++
    } else if (k > 80 && d <= 80) {
      reasons.push(`StochRSI K overbought (${k}) — watch for rollover`)
      score -= 8
    } else if (k > d && k < 50) {
      reasons.push(`StochRSI bullish cross below midline (K:${k})`)
      score += 6
    } else if (k < d && k > 50) {
      reasons.push(`StochRSI bearish cross above midline (K:${k})`)
      score -= 6
    }
  }

  // ── RSI Divergence ──
  if (divergence !== null) {
    if (divergence.type === 'bullish') {
      const boost = divergence.strength === 'strong' ? 20 : 12
      reasons.push(`Bullish RSI divergence (${divergence.strength}): price -${Math.abs(divergence.priceChange)}% but RSI +${divergence.rsiChange}pts — reversal signal`)
      score += boost; bullishSignals++
    } else {
      const drag = divergence.strength === 'strong' ? 20 : 12
      reasons.push(`Bearish RSI divergence (${divergence.strength}): price +${divergence.priceChange}% but RSI ${divergence.rsiChange}pts — reversal risk`)
      score -= drag; bearishSignals++
    }
  }

  // ── Candlestick patterns ──
  for (const pattern of candlePatterns) {
    if (pattern.includes('bullish') || pattern.includes('hammer') || pattern.includes('doji at low')) {
      reasons.push(`Candle: ${pattern}`); score += 10; bullishSignals++
    } else if (pattern.includes('bearish') || pattern.includes('shooting star') || pattern.includes('doji at high')) {
      reasons.push(`Candle: ${pattern}`); score -= 10; bearishSignals++
    }
  }

  // ── Capitulation ──
  if (capitulation.detected) {
    reasons.push(`Capitulation candle: ${capitulation.volumeMultiple}× avg volume at low — exhaustion reversal likely`)
    score += 18; bullishSignals++
  }

  // ── Volume expansion (bounce confirmation) ──
  // Mean-reversion longs are only reliable when the bounce candle shows real
  // participation. Flag when the latest closed bar's volume ≥ 1.3× the trailing
  // 20-bar average — used downstream as a hard entry gate, not just a bonus.
  const vols = volumes(liveCandles)
  if (vols.length >= 21) {
    const latestVol = vols[vols.length - 1]!
    const avgVol = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
    if (avgVol > 0 && latestVol >= avgVol * 1.3) {
      reasons.push(`VolExpansion: ${(latestVol / avgVol).toFixed(1)}× 20-bar avg volume — participation confirms move`)
    }
  }

  // ── Volume ratio + trend (participation building vs fading) ──
  // Both computed on CLOSED bars only — Gemini's feed includes the in-progress bar,
  // and a 4hr bucket that opened minutes ago has near-zero volume, which would fake
  // a "falling" read for the first hours of every bar. Dropping the forming bar
  // keeps the volume gate honest across the whole bucket.
  // volTrend: 3-bar vs 8-bar volume SMA — rising = participation expanding across
  // the last few closed bars (not just one spike). This is the primary volume
  // confirmation for the 4hr BB swing strategy.
  const closedVols = vols.slice(0, -1)
  let volRatio: number | null = null
  if (closedVols.length >= 21) {
    const lastClosed = closedVols[closedVols.length - 1]!
    const avgClosed = closedVols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
    if (avgClosed > 0) volRatio = Number((lastClosed / avgClosed).toFixed(2))
  }
  let volTrend: 'rising' | 'falling' | 'flat' | null = null
  if (closedVols.length >= 9) {
    const v3 = sma(closedVols, 3), v8 = sma(closedVols, 8)
    if (v3 !== null && v8 !== null && v8 > 0) {
      volTrend = v3 > v8 * 1.05 ? 'rising' : v3 < v8 * 0.95 ? 'falling' : 'flat'
      if (volTrend === 'rising') reasons.push(`VolTrend rising: 3-bar avg ${(v3 / v8).toFixed(2)}× 8-bar avg (closed bars) — participation building`)
      else if (volTrend === 'falling') reasons.push(`VolTrend falling: 3-bar avg ${(v3 / v8).toFixed(2)}× 8-bar avg (closed bars) — participation fading`)
    }
  }

  score = Math.max(0, Math.min(100, score))
  const direction: SignalDirection = score >= 60 ? 'BUY' : score <= 40 ? 'SELL' : 'HOLD'

  return {
    tf, direction, strength: score,
    rsi14: rsiVal, macd: macdVal, bb: bbVal,
    ma50: ma50Val, ma200: ma200Val,
    adx: adxVal ? { adx: adxVal.adx, plusDI: adxVal.plusDI, minusDI: adxVal.minusDI } : null,
    volRatio, volTrend,
    candleCount: candles.length, reasons,
  }
}

// ── Composite signal across timeframes ────────────────────────────────

function computeCompositeSignal(symbol: string, ticker: Ticker, tfSignals: TimeframeSignal[]): Signal {
  const lastPrice = Number(ticker.last)
  const seeded = tfSignals.some((t) => t.candleCount >= 30)

  if (!seeded || tfSignals.length === 0) {
    return {
      symbol, direction: 'HOLD', strength: 50, entryQuality: 'INSUFFICIENT_DATA',
      confluence: 0, timeframes: tfSignals, reasons: ['Loading candle history…'],
      computedAt: Date.now(), seeded: false,
    }
  }

  // Weighted composite — see SIGNAL_WEIGHTS for the values and the rationale.
  const weights: Record<Timeframe, number> = SIGNAL_WEIGHTS
  let weightedScore = 0
  let totalWeight = 0
  for (const tf of tfSignals) {
    const w = weights[tf.tf]
    weightedScore += tf.strength * w
    totalWeight += w
  }
  const composite = totalWeight > 0 ? weightedScore / totalWeight : 50

  // Confluence: how many timeframes agree on direction
  const directions = tfSignals.map((t) => t.direction)
  const buys = directions.filter((d) => d === 'BUY').length
  const sells = directions.filter((d) => d === 'SELL').length
  const holds = directions.filter((d) => d === 'HOLD').length
  const confluence = Math.max(buys, sells, holds)

  const direction: SignalDirection = composite >= 60 ? 'BUY' : composite <= 40 ? 'SELL' : 'HOLD'

  let entryQuality: EntryQuality = 'LOW'
  if (confluence >= 3 && Math.abs(composite - 50) >= 20) entryQuality = 'HIGH'
  else if (confluence >= 2 && Math.abs(composite - 50) >= 12) entryQuality = 'MEDIUM'

  const reasons: string[] = []
  const tfCount = tfSignals.length
  if (buys > 0 && direction === 'BUY') reasons.push(`${buys}/${tfCount} timeframes bullish`)
  if (sells > 0 && direction === 'SELL') reasons.push(`${sells}/${tfCount} timeframes bearish`)
  const daily = tfSignals.find((t) => t.tf === '1day')
  if (daily?.ma200 !== null && daily) {
    reasons.push(lastPrice > (daily.ma200 ?? 0) ? 'Daily: above MA200' : 'Daily: below MA200')
  }
  // 4hr BB %B + volume trend — the primary indicators for trade selection.
  const h4 = tfSignals.find((t) => t.tf === '4hr')
  if (h4?.bb) {
    const pctB = h4.bb.percentB * 100
    if (pctB <= 10) reasons.push(`4hr: at/below lower Bollinger Band (%B ${pctB.toFixed(0)}%) — primary entry zone`)
    else if (pctB >= 90) reasons.push(`4hr: at/above upper Bollinger Band (%B ${pctB.toFixed(0)}%) — primary exit zone`)
  }
  if (h4?.volTrend === 'rising') reasons.push('4hr: volume trend rising — participation confirms')
  else if (h4?.volTrend === 'falling') reasons.push('4hr: volume trend falling — no participation')
  const hourly = tfSignals.find((t) => t.tf === '1hr')
  if (hourly?.macd) {
    reasons.push(hourly.macd.histogram > 0 ? 'Hourly MACD bullish' : 'Hourly MACD bearish')
  }
  const m15 = tfSignals.find((t) => t.tf === '15m')
  if (m15?.rsi14 !== null && m15) {
    if ((m15.rsi14 ?? 50) < 35) reasons.push('15m: RSI oversold — entry signal')
    else if ((m15.rsi14 ?? 50) > 65) reasons.push('15m: RSI overbought — exit signal')
  }
  // 5m/1m only exist for portfolio holdings (FAST_TIMEFRAMES) — surface them as a
  // fine-grained entry-timing confirmation alongside the 15m read.
  const m5 = tfSignals.find((t) => t.tf === '5m')
  const m1 = tfSignals.find((t) => t.tf === '1m')
  if (m5?.rsi14 !== null && m5) {
    if ((m5.rsi14 ?? 50) < 30) reasons.push('5m: RSI oversold — fast confirmation')
    else if ((m5.rsi14 ?? 50) > 70) reasons.push('5m: RSI overbought — fast confirmation')
  }
  if (m1?.rsi14 !== null && m1) {
    if ((m1.rsi14 ?? 50) < 25) reasons.push('1m: RSI oversold — precise entry window')
    else if ((m1.rsi14 ?? 50) > 75) reasons.push('1m: RSI overbought — precise exit window')
  }
  if (ticker.change > 5) reasons.push(`+${ticker.change}% 24h momentum`)
  else if (ticker.change < -5) reasons.push(`${ticker.change}% 24h pullback`)

  return {
    symbol, direction, strength: Math.round(composite), entryQuality,
    confluence, timeframes: tfSignals, reasons,
    computedAt: Date.now(), seeded: true,
  }
}

// ── Trade horizon classifier ────────────────────────────────────────────
// Short-term: driven by 15m + 1hr signals
// Medium-term: driven by 1day + 1hr signals

function classifyHorizon(signal: Signal): 'SHORT' | 'MEDIUM' | 'BOTH' | 'NONE' {
  const m15 = signal.timeframes.find((t) => t.tf === '15m')
  const h1 = signal.timeframes.find((t) => t.tf === '1hr')
  const d1 = signal.timeframes.find((t) => t.tf === '1day')

  const shortBullish = (m15?.direction === 'BUY' || h1?.direction === 'BUY') && signal.direction === 'BUY'
  const shortBearish = (m15?.direction === 'SELL' || h1?.direction === 'SELL') && signal.direction === 'SELL'
  const medBullish = (d1?.direction === 'BUY' && h1?.direction === 'BUY') && signal.direction === 'BUY'
  const medBearish = (d1?.direction === 'SELL' && h1?.direction === 'SELL') && signal.direction === 'SELL'

  const isShort = shortBullish || shortBearish
  const isMed = medBullish || medBearish

  if (isShort && isMed) return 'BOTH'
  if (isShort) return 'SHORT'
  if (isMed) return 'MEDIUM'
  return 'NONE'
}

// ── Entry/Exit target calculator ───────────────────────────────────────

function calcTradeTargets(signal: Signal, ticker: Ticker): {
  entry: number; stopLoss: number; target1: number; target2: number
  riskPct: number; reward1Pct: number; reward2Pct: number; rrRatio: number
} | null {
  if (!signal.seeded || signal.direction === 'HOLD') return null
  const price = Number(ticker.last)
  if (!price) return null

  const tf15 = signal.timeframes.find((t) => t.tf === '15m')
  const tf1h = signal.timeframes.find((t) => t.tf === '1hr')
  const tf4h = signal.timeframes.find((t) => t.tf === '4hr')
  const tf1d = signal.timeframes.find((t) => t.tf === '1day')

  const isBuy = signal.direction === 'BUY'

  // Stop loss: use Bollinger lower/upper band or ATR-based 3% default.
  // 4hr bands first — the strategy's primary decision timeframe.
  let stopPct = 0.03 // 3% default
  const bb = tf4h?.bb ?? tf1h?.bb ?? tf15?.bb ?? tf1d?.bb
  if (bb) {
    // BUY: stop below lower band; SELL: stop above upper band
    const bandStop = isBuy
      ? (price - bb.lower) / price
      : (bb.upper - price) / price
    if (bandStop > 0.005 && bandStop < 0.15) stopPct = bandStop
  }

  // For medium-term, widen stop slightly
  const horizon = classifyHorizon(signal)
  if (horizon === 'MEDIUM' || horizon === 'BOTH') stopPct = Math.max(stopPct, 0.04)

  const stopLoss = isBuy ? price * (1 - stopPct) : price * (1 + stopPct)

  // Targets: R:R 1.5 (T1) and R:R 2.5 (T2)
  const riskAmt = Math.abs(price - stopLoss)
  const target1 = isBuy ? price + riskAmt * 1.5 : price - riskAmt * 1.5
  const target2 = isBuy ? price + riskAmt * 2.5 : price - riskAmt * 2.5

  const riskPct = (Math.abs(price - stopLoss) / price) * 100
  const reward1Pct = (Math.abs(target1 - price) / price) * 100
  const reward2Pct = (Math.abs(target2 - price) / price) * 100
  const rrRatio = reward2Pct / riskPct

  return {
    entry: price,
    stopLoss: Number(stopLoss.toFixed(6)),
    target1: Number(target1.toFixed(6)),
    target2: Number(target2.toFixed(6)),
    riskPct: Number(riskPct.toFixed(2)),
    reward1Pct: Number(reward1Pct.toFixed(2)),
    reward2Pct: Number(reward2Pct.toFixed(2)),
    rrRatio: Number(rrRatio.toFixed(2)),
  }
}

// ── Intel report ───────────────────────────────────────────────────────

function buildIntelReport(tickers: Ticker[], signals: Signal[], holdings: Holding[], tradeHistory: GeminiTrade[] = [], enabledStrategy = 'crypto-strategy', cmcVolumes: Map<string, CmcVolumeRead> = new Map()): string {
  const now = new Date().toISOString()

  // ── Strategy-aware section gating ──────────────────────────────────────
  // One shared report field feeds whichever strategy is enabled. Rendering every
  // section every run floods the model with content the active strategy is told to
  // ignore (crypto-strategy explicitly ignores FLASH-DIP/OVERSOLD/SWING/BREAKOUT).
  // Emit only what the enabled strategy consumes; PORTFOLIO/REGIME/COOLDOWN/SUMMARY
  // are always kept as shared context. The retired BREAKOUT watch (paper-training
  // only, no live orders) is dropped for EVERY strategy — its paper backfill scores
  // saved plan files, not this section. `show` also gates the expensive FLASH-DIP
  // sweep below so hidden sections cost no compute, not just no output.
  const SHARED_SECTIONS = ['divergences', 'overbought', 'movers']
  const STRATEGY_SECTIONS: Record<string, string[]> = {
    'crypto-strategy': [...SHARED_SECTIONS, 'bbswing'],
    'fast-cash':       [...SHARED_SECTIONS, 'flashdip', 'oversold'],
    'crypto-candles':  [...SHARED_SECTIONS, 'flashdip', 'oversold'],
    'oversold':        [...SHARED_SECTIONS, 'oversold', 'swing'],
    // firecracker ignores the intel report entirely (whole-market candle+RSI scan);
    // render only the shared context sections so it costs no extra compute.
    'firecracker':     [...SHARED_SECTIONS],
    // sniper is gate-driven off the scan + snapshot only, same as firecracker.
    'sniper':          [...SHARED_SECTIONS],
  }
  // Unknown/other strategy → render every live section (still no retired BREAKOUT).
  const show = new Set(STRATEGY_SECTIONS[enabledStrategy] ??
    [...SHARED_SECTIONS, 'bbswing', 'flashdip', 'oversold', 'swing', 'shortterm', 'medterm'])
  const tickerMap = new Map(tickers.map((t) => [t.symbol, t]))
  const signalMap = new Map(signals.map((s) => [s.symbol, s]))
  const fr = measureFeeRates(tradeHistory) // real fee rate from the account's own fills
  const px = (n: number | null): string => {
    if (n === null || !isFinite(n)) return '?'
    return n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : Number(n.toPrecision(4)).toString()
  }

  // Canonical USD pair: keep BTCUSD, drop the GUSD/RLUSD stablecoin-quoted duplicates
  // that otherwise triple every watch-list entry.
  const isCanonicalUsd = (sym: string) => sym.endsWith('USD') && !sym.endsWith('GUSD') && !sym.endsWith('RLUSD')
  const STABLES = new Set(['USD', 'USDT', 'GUSD', 'USDC', 'DAI', 'RLUSD', 'PYUSD'])
  // Watchable = canonical USD pair whose BASE isn't a dollar stable. A stablecoin's
  // RSI/breakout on a $1 peg is pure noise (USDTUSD once scored a "7/7 breakout").
  const isWatchable = (sym: string) => isCanonicalUsd(sym) && !STABLES.has(sym.slice(0, -3))
  // Single source of truth for a holding's USD value — the PORTFOLIO OVERVIEW total
  // and the MARKET REGIME portfolio line must agree, so both use this.
  const holdingUsd = (h: Holding): number => {
    if (h.currency === 'USD') return Number(h.amount)
    const t = tickerMap.get(`${h.currency}USD`)
    if (t) return Number(h.amount) * Number(t.last)
    // Dollar stables with no traded ${cur}USD pair (e.g. GUSD) are worth face value
    return STABLES.has(h.currency) ? Number(h.amount) : 0
  }
  // A timeframe read is trustworthy only with enough real candles; RSI from a tiny/flat
  // window degenerates to exactly 0 or 100 on illiquid pairs.
  const validRsi = (tf: TimeframeSignal | undefined): number | null =>
    (tf && tf.candleCount >= 30 && tf.rsi14 !== null && tf.rsi14 > 0 && tf.rsi14 < 100) ? tf.rsi14 : null

  // ── Portfolio section with full analysis ──
  const portfolioLines: string[] = []
  let totalPortfolioUSD = 0
  for (const h of holdings) {
    const t = tickerMap.get(`${h.currency}USD`)
    const sig = signalMap.get(`${h.currency}USD`)
    const usd = holdingUsd(h)
    totalPortfolioUSD += usd
    const usdStr = usd > 0 ? `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'n/a'
    portfolioLines.push(`### ${h.currency}`)
    portfolioLines.push(`- Balance: ${Number(h.amount).toFixed(8)} ${h.currency} ≈ **${usdStr}**`)
    if (t) {
      portfolioLines.push(`- Price: $${Number(t.last).toLocaleString()} | 24h: ${t.change > 0 ? '+' : ''}${t.change}%`)
    }
    if (STABLES.has(h.currency)) {
      // Cash / dollar-stable balance — no signal analysis applies, don't print "seeding…"
    } else if (sig?.seeded) {
      portfolioLines.push(`- Signal: **${sig.direction}** [${sig.entryQuality}] strength ${sig.strength}/100 confluence ${sig.confluence}/${sig.timeframes.length}`)
      const horizon = classifyHorizon(sig)
      portfolioLines.push(`- Trade horizon: **${horizon}**`)
      if (t) {
        const targets = calcTradeTargets(sig, t)
        if (targets) {
          portfolioLines.push(`- Entry: $${targets.entry.toLocaleString()} | Stop: $${targets.stopLoss.toLocaleString()} (-${targets.riskPct}%)`)
          portfolioLines.push(`- T1 (1.5R): $${targets.target1.toLocaleString()} (+${targets.reward1Pct}%) | T2 (2.5R): $${targets.target2.toLocaleString()} (+${targets.reward2Pct}%)`)
          portfolioLines.push(`- Risk:Reward = 1:${targets.rrRatio}`)
        }
      }
      // Timeframe breakdown
      for (const tfSig of sig.timeframes) {
        const rsiStr = tfSig.rsi14 !== null ? ` RSI:${tfSig.rsi14}` : ''
        const macdStr = tfSig.macd ? ` MACD:${tfSig.macd.histogram > 0 ? '▲' : '▼'}` : ''
        const bbStr = tfSig.bb ? ` BB:%B=${(tfSig.bb.percentB * 100).toFixed(0)}%` : ''
        portfolioLines.push(`  - ${tfSig.tf}: ${tfSig.direction} (${tfSig.strength})${rsiStr}${macdStr}${bbStr}`)
      }
      portfolioLines.push(`- Reasons: ${sig.reasons.join('; ')}`)
    } else {
      portfolioLines.push(`- Signal: seeding…`)
    }
    portfolioLines.push('')
  }

  // ── Short-term signals (15m/1hr driven) ──
  const shortTermSignals = signals
    .filter((s) => s.seeded && s.direction !== 'HOLD' && s.entryQuality !== 'INSUFFICIENT_DATA')
    .filter((s) => { const h = classifyHorizon(s); return h === 'SHORT' || h === 'BOTH' })
    .sort((a, b) => {
      const qOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
      return (qOrder[a.entryQuality] ?? 3) - (qOrder[b.entryQuality] ?? 3) || b.strength - a.strength
    })
    .slice(0, 10)

  // ── Medium-term signals (1day/1hr driven) ──
  const medTermSignals = signals
    .filter((s) => s.seeded && s.direction !== 'HOLD' && s.entryQuality !== 'INSUFFICIENT_DATA')
    .filter((s) => { const h = classifyHorizon(s); return h === 'MEDIUM' || h === 'BOTH' })
    .sort((a, b) => {
      const qOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
      return (qOrder[a.entryQuality] ?? 3) - (qOrder[b.entryQuality] ?? 3) || b.strength - a.strength
    })
    .slice(0, 10)

  function formatSignalBlock(sigs: Signal[]): string {
    if (!sigs.length) return '  None meeting criteria currently.\n'
    return sigs.map((s) => {
      const t = tickerMap.get(s.symbol)
      const price = t ? `$${Number(t.last).toLocaleString()}` : ''
      const tf = s.timeframes.map((tf) => `${tf.tf}:${tf.direction}[${tf.strength}]`).join(' | ')
      let out = `**${s.symbol}** ${s.direction} [${s.entryQuality}] str:${s.strength} | ${price} | ${t?.change ?? '?'}% 24h\n`
      out += `  Timeframes: ${tf}\n`
      if (t) {
        const targets = calcTradeTargets(s, t)
        if (targets) {
          out += `  Entry: ${price} | Stop: $${targets.stopLoss.toLocaleString()} (-${targets.riskPct}%)\n`
          out += `  T1: $${targets.target1.toLocaleString()} (+${targets.reward1Pct}%) | T2: $${targets.target2.toLocaleString()} (+${targets.reward2Pct}%) | R:R 1:${targets.rrRatio}\n`
        }
      }
      out += `  ${s.reasons.join(' · ')}\n`
      return out
    }).join('\n')
  }

  // ── Top movers ──
  const movers = tickers
    .filter((t) => isCanonicalUsd(t.symbol))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 10)
    .map((t) => `  - **${t.symbol}** $${Number(t.last).toLocaleString()} (${t.change > 0 ? '+' : ''}${t.change}% 24h) vol: ${Number(t.volume).toLocaleString()}`)
    .join('\n')

  // ── Oversold watch (bounce candidates) ──
  // Use 15m RSI where available; fall back to 1hr. Sort by most oversold first.
  type OversoldEntry = { symbol: string; price: string; change: number; rsi15m: number | null; rsi1hr: number | null; rsiDay: number | null; stochK: number | null; bbPctB: number | null; divergence: string | null; divBullishHi: boolean; capitulation: boolean; volumeConfirmed: boolean; patterns: string[]; confluenceScore: number; swingScore: number; trendStrongDown: boolean; hmaReclaim: boolean; obvBullish: boolean; obvCrossUp: boolean; freshTrigger: boolean; p1h28: number | null; p1h25: number | null; floor1hOk: boolean }
  const oversoldList: OversoldEntry[] = []
  const overboughtList: OversoldEntry[] = []
  const swingList: OversoldEntry[] = []  // 4-24h bounce candidates, ranked by 1hr/1day oversold + reversal trigger
  const allEntries: OversoldEntry[] = [] // every seeded watchable entry — the flash-dip sweep ranks over this

  // Momentum-continuation candidates — the mirror image of the bounce tracks: buy
  // strength that's just breaking out, not weakness that's just bottoming. Scored
  // separately (BreakoutEntry) because the entry thesis (trend confirmation, volume
  // surge, freshness) is the opposite of what makes a bounce tradeable.
  type BreakoutEntry = { symbol: string; price: string; change: number; rsi15m: number | null; rsi1hr: number | null; bbPctB15m: number | null; bbPctB1h: number | null; adx1h: number | null; plusDI1h: number | null; minusDI1h: number | null; volumeConfirmed: boolean; macdBullish: boolean; aboveDailyMa50: boolean; breakoutScore: number; alreadyExtended: boolean; extendedEntry: boolean; retestLevel: number | null }
  const breakoutList: BreakoutEntry[] = []

  for (const sig of signals) {
    if (!sig.seeded) continue
    if (!isWatchable(sig.symbol)) continue // drop GUSD/RLUSD duplicates + stablecoin bases (USDTUSD etc.)
    const ticker = tickerMap.get(sig.symbol)
    if (!ticker) continue
    const tf15 = sig.timeframes.find((t) => t.tf === '15m')
    const tf1h = sig.timeframes.find((t) => t.tf === '1hr')
    const tfDay = sig.timeframes.find((t) => t.tf === '1day')
    // Only trust RSI from timeframes with enough real candles (excludes 0/100 degenerates)
    const rsi15m = validRsi(tf15)
    const rsi1hr = validRsi(tf1h)
    const rsiDay = validRsi(tfDay)
    // Require at least one trustworthy RSI read to appear in any watch list
    if (rsi15m === null && rsi1hr === null) continue

    // Extract StochRSI K from 15m reasons (we embedded it there)
    const stochMatch = tf15?.reasons.join(' ').match(/StochRSI.*?K:(\d+\.?\d*)/)
    const stochK = stochMatch ? Number(stochMatch[1]) : null

    const bbPctB = tf15?.bb?.percentB ?? null

    // Divergence from 15m reasons
    const divBullish = tf15?.reasons.some((r) => r.includes('Bullish RSI divergence')) || tf1h?.reasons.some((r) => r.includes('Bullish RSI divergence'))
    const divBearish = tf15?.reasons.some((r) => r.includes('Bearish RSI divergence')) || tf1h?.reasons.some((r) => r.includes('Bearish RSI divergence'))
    const divergenceLabel = divBullish ? 'bullish' : divBearish ? 'bearish' : null
    // Higher-timeframe bullish divergence (1hr/1day) — the reversal trigger that
    // makes a 4-24h swing bounce tradeable even in a downtrend.
    const divBullishHi = (tf1h?.reasons.some((r) => r.includes('Bullish RSI divergence')) ?? false)
      || (tfDay?.reasons.some((r) => r.includes('Bullish RSI divergence')) ?? false)

    const capitulationDetected = tf15?.reasons.some((r) => r.includes('Capitulation')) || false
    // Volume confirmation: a real bounce shows participation. Capitulation already
    // implies an outsized volume spike, so either flag confirms.
    const volumeConfirmed = capitulationDetected
      || (tf15?.reasons.some((r) => r.includes('VolExpansion')) ?? false)
      || (tf1h?.reasons.some((r) => r.includes('VolExpansion')) ?? false)
    const patterns = [...(tf15?.reasons.filter((r) => r.startsWith('Candle:')) ?? []), ...(tf1h?.reasons.filter((r) => r.startsWith('Candle:')) ?? [])]

    // Micropulse-derived turn-confirmation flags (15m): HMA13 reclaim + OBV(3/8) flow.
    const hmaReclaim = tf15?.reasons.some((r) => r.includes('HMA13 reclaim')) ?? false
    const obvBullish = tf15?.reasons.some((r) => r.includes('OBV MA bullish')) ?? false
    const obvCrossUp = tf15?.reasons.some((r) => r.includes('OBV MA cross-up')) ?? false
    const stochCross = tf15?.reasons.some((r) => r.includes('StochRSI bullish cross')) ?? false
    // Required reversal-turn trigger for a FAST/MICRO bounce entry: never buy a still-
    // falling knife. At least one fresh confirmation must be present — HMA reclaim, a
    // fresh OBV cross-up, a StochRSI bullish cross, or the stronger divergence/
    // capitulation signals (which already qualify on their own). Deep-oversold RSI/BB
    // alone is NOT a trigger — that's the knife. The score can still be high without a
    // trigger; the skill uses freshTrigger as the entry gate, not the score.
    const freshTrigger = hmaReclaim || obvCrossUp || stochCross || divBullish || capitulationDetected

    // Predicted 1hr bottom (tuning from the 2026-06-28→07-04 trade review): the week's
    // real bottoms printed at 1hr RSI ≈ 25–26 while every losing entry filled at 1hr
    // RSI ≥ 38 (JTO 8–17% above the eventual low). Invert Wilder RSI on the 1hr closes
    // so patient entries can rest AT the predicted bottom instead of at the bid/last
    // swing low. floor1hOk mirrors the skills' hard gate: no FAST/MICRO bounce entry
    // while 1hr RSI > 35.
    const c1hCloses = closes(candleCache.get(sig.symbol)?.['1hr'] ?? [])
    const p1h28 = c1hCloses.length >= 30 ? (predictPriceForRsi(c1hCloses, 28)?.predictedPrice ?? null) : null
    const p1h25 = c1hCloses.length >= 30 ? (predictPriceForRsi(c1hCloses, 25)?.predictedPrice ?? null) : null
    const floor1hOk = rsi1hr !== null && rsi1hr <= 35

    // Trend-strength filter: a bounce candidate fighting a strong, established
    // 1hr downtrend (ADX>25 with -DI dominant) is the classic "oversold stays
    // oversold" failure mode. A reversal trigger (divergence/capitulation) is
    // exactly the evidence that the trend may be exhausting — so the penalty
    // only applies when NO such trigger is present; a confirmed divergence
    // inside a strong downtrend is the highest-conviction case, not a penalty.
    const reversalTrigger = divBullish || divBullishHi || capitulationDetected
    const trendStrongDown = !!(tf1h?.adx && tf1h.adx.adx > 25 && tf1h.adx.minusDI > tf1h.adx.plusDI) && !reversalTrigger

    // Bounce confluence score (0-9) for oversold candidates
    let bounceScore = 0
    if (rsi15m !== null && rsi15m < 30) bounceScore++
    if (rsi1hr !== null && rsi1hr < 45) bounceScore++
    if (bbPctB !== null && bbPctB < 0.1) bounceScore++
    if (stochK !== null && stochK < 20) bounceScore++
    if (divBullish) bounceScore += 2
    if (capitulationDetected) bounceScore++
    if (patterns.some((p) => p.includes('hammer') || p.includes('bullish engulfing'))) bounceScore++
    if (hmaReclaim) bounceScore++                          // price reclaimed fast Hull MA
    if (obvBullish) bounceScore++                          // cumulative volume flow turned up
    if (trendStrongDown) bounceScore = Math.max(0, bounceScore - 1)

    // Swing-bounce confluence score (0-7) — weighted toward the HIGHER timeframes
    // (1hr/1day), because deeper multi-hour oversold = a bigger mean-reversion
    // bounce to ride over 4-24h. RSI is the spine of this score.
    let swingScore = 0
    if (rsi1hr !== null && rsi1hr < 35) swingScore++
    if (rsi1hr !== null && rsi1hr < 25) swingScore++       // deep 1hr oversold
    if (rsiDay !== null && rsiDay < 40) swingScore++
    if (rsiDay !== null && rsiDay < 30) swingScore++       // deep daily oversold
    if (divBullishHi) swingScore += 2                       // higher-TF reversal trigger
    if (capitulationDetected) swingScore++
    if (trendStrongDown) swingScore = Math.max(0, swingScore - 1)

    const entry: OversoldEntry = {
      symbol: sig.symbol,
      price: ticker.last,
      change: ticker.change,
      rsi15m, rsi1hr, rsiDay, stochK, bbPctB,
      divergence: divergenceLabel,
      divBullishHi,
      capitulation: capitulationDetected,
      volumeConfirmed,
      patterns,
      confluenceScore: bounceScore,
      swingScore,
      trendStrongDown,
      hmaReclaim,
      obvBullish,
      obvCrossUp,
      freshTrigger,
      p1h28, p1h25, floor1hOk,
    }

    const isOversold = (rsi15m !== null && rsi15m < 35) || (rsi1hr !== null && rsi1hr < 35)
    const isOverbought = (rsi15m !== null && rsi15m > 65) || (rsi1hr !== null && rsi1hr > 65)
    // Swing candidate: oversold on the swing timeframes (1hr or 1day), regardless
    // of the 15m scalp read.
    const isSwingOversold = (rsi1hr !== null && rsi1hr < 40) || (rsiDay !== null && rsiDay < 42)

    allEntries.push(entry)
    if (isOversold) oversoldList.push(entry)
    else if (isOverbought) overboughtList.push(entry)
    if (isSwingOversold) swingList.push(entry)

    // ── Breakout candidate scoring ──
    // A breakout is a price break above a key level (upper Bollinger Band = the
    // synchronous, no-extra-fetch proxy for "broke resistance") with trend + volume
    // confirmation. This is the mirror image of the bounce score: it rewards
    // strength that's just starting, not weakness that's just bottoming.
    const bbPctB15m = tf15?.bb?.percentB ?? null
    const bbPctB1h = tf1h?.bb?.percentB ?? null
    const bbBreakout15m = bbPctB15m !== null && bbPctB15m > 1.0
    const bbBreakout1h = bbPctB1h !== null && bbPctB1h > 1.0
    const adx1hVal = tf1h?.adx ?? null
    const adxStrongUp = !!(adx1hVal && adx1hVal.adx > 25 && adx1hVal.plusDI > adx1hVal.minusDI)
    const isBreakoutCandidate = bbBreakout15m || bbBreakout1h || adxStrongUp

    if (isBreakoutCandidate) {
      const macdBullish = (tf15?.macd?.histogram ?? 0) > 0 || (tf1h?.macd?.histogram ?? 0) > 0
      const aboveDailyMa50 = tfDay?.ma50 != null && Number(ticker.last) > tfDay.ma50
      // Already-extended check: chasing a move that's blown off is the breakout
      // track's version of "oversold stays oversold" — the classic failure mode
      // here is buying the exhaustion spike, not the initial break.
      const alreadyExtended = (rsi1hr !== null && rsi1hr >= 88) || ticker.change > 25
      const freshRoom = rsi1hr !== null && rsi1hr >= 55 && rsi1hr < 85
      // Extended-ENTRY check (tuning from the 2026-07-04 LINK trade: a 7/7 breakout
      // bought at 15m %B 139 / RSI 75 faded −2.2% in 3h; the BREAKOUT bucket runs
      // −1.38%/trade net). Distinct from alreadyExtended (which docks the score):
      // this flags that a MARKET/at-the-bid entry is disallowed RIGHT NOW — price is
      // through the upper band or 15m-hot, so the only acceptable entry is a resting
      // limit at the broken level (the retest), or skip.
      const extendedEntry = (bbPctB15m !== null && bbPctB15m > 1.0) || (rsi15m !== null && rsi15m >= 70)
      // The retest level = the band that broke (prefer the 1hr band — the stronger
      // level); fall back to the 15m band.
      const retestLevel = bbBreakout1h ? (tf1h?.bb?.upper ?? null)
        : bbBreakout15m ? (tf15?.bb?.upper ?? null)
        : (tf1h?.bb?.upper ?? tf15?.bb?.upper ?? null)

      let breakoutScore = 0
      if (bbBreakout15m) breakoutScore++
      if (bbBreakout1h) breakoutScore++
      if (adxStrongUp) breakoutScore += 2
      if (volumeConfirmed) breakoutScore++
      if (macdBullish) breakoutScore++
      if (freshRoom) breakoutScore++
      if (aboveDailyMa50) breakoutScore++
      if (alreadyExtended) breakoutScore = Math.max(0, breakoutScore - 1)

      breakoutList.push({
        symbol: sig.symbol, price: ticker.last, change: ticker.change,
        rsi15m, rsi1hr, bbPctB15m, bbPctB1h,
        adx1h: adx1hVal?.adx ?? null, plusDI1h: adx1hVal?.plusDI ?? null, minusDI1h: adx1hVal?.minusDI ?? null,
        volumeConfirmed, macdBullish, aboveDailyMa50,
        breakoutScore, alreadyExtended, extendedEntry, retestLevel,
      })
    }
  }

  oversoldList.sort((a, b) => {
    // Primary: bounce score descending; secondary: lowest RSI first
    if (b.confluenceScore !== a.confluenceScore) return b.confluenceScore - a.confluenceScore
    const aRsi = a.rsi15m ?? a.rsi1hr ?? 100
    const bRsi = b.rsi15m ?? b.rsi1hr ?? 100
    return aRsi - bRsi
  })
  overboughtList.sort((a, b) => {
    const aRsi = a.rsi15m ?? a.rsi1hr ?? 0
    const bRsi = b.rsi15m ?? b.rsi1hr ?? 0
    return bRsi - aRsi
  })
  swingList.sort((a, b) => {
    // Primary: swing score descending; secondary: lowest 1hr (then daily) RSI first
    if (b.swingScore !== a.swingScore) return b.swingScore - a.swingScore
    const aRsi = a.rsi1hr ?? a.rsiDay ?? 100
    const bRsi = b.rsi1hr ?? b.rsiDay ?? 100
    return aRsi - bRsi
  })
  breakoutList.sort((a, b) => {
    // Primary: breakout score descending; secondary: strongest 1hr ADX first
    if (b.breakoutScore !== a.breakoutScore) return b.breakoutScore - a.breakoutScore
    return (b.adx1h ?? 0) - (a.adx1h ?? 0)
  })

  // ── 4HR BB SWING sweep — THE PRIMARY STRATEGY WATCH (operator directive 2026-07-05) ────
  // Bollinger Bands + volume on the 4hr chart decide whether a trade may be taken;
  // everything else (RSI, divergence, candles) is secondary confirmation. Two hard
  // gates per row: BB gate = 4hr %B ≤ 10 (price at/below the lower band), volume
  // gate = RISING volume trend. T1 is the 4hr midband, the runner target the upper band.
  // Volume gate source (2026-07-09): PRIMARY is CoinMarketCap's aggregated cross-exchange
  // 24h volume change (see server/cmc.ts) — Gemini alone is thin next to Binance/
  // Coinbase/etc., so its own 4hr 3-bar/8-bar volume SMA trend routinely read 'falling'
  // while a coin was genuinely breaking out market-wide, blocking good entries. Gemini's
  // own volTrend is now only a FALLBACK, used when CMC has no listing for the symbol or
  // CMC_API_KEY isn't configured. volRatio (single-bar spike vs 20-bar avg) stays a
  // Gemini-only scoring bonus — that's about entry-candle participation, not the gate.
  type Swing4hEntry = {
    symbol: string; price: string; change: number
    pctB4h: number; bw4h: number; lower: number; mid: number; upper: number
    roomToMidPct: number; roomToUpperPct: number
    rsi4h: number | null; rsi1h: number | null; rsiDay: number | null; pctBDay: number | null
    volTrend: 'rising' | 'falling' | 'flat' | null; volRatio: number | null
    divBull: boolean; reversalCandle: boolean
    bbGateOk: boolean; volGateOk: boolean; cmcTrend: 'rising' | 'falling' | 'flat' | null; geminiFallback: boolean; qualified: boolean
    held: boolean; score: number
  }
  const heldSet = new Set(
    holdings.filter((h) => Number(h.amount) > 0 && !STABLES.has(h.currency)).map((h) => `${h.currency}USD`)
  )
  const swing4hList: Swing4hEntry[] = []
  const swing4hExitList: Swing4hEntry[] = []
  for (const sig of signals) {
    if (!sig.seeded || !isWatchable(sig.symbol)) continue
    const ticker = tickerMap.get(sig.symbol)
    if (!ticker) continue
    const tf4h = sig.timeframes.find((t) => t.tf === '4hr')
    const tf1h = sig.timeframes.find((t) => t.tf === '1hr')
    const tfDay = sig.timeframes.find((t) => t.tf === '1day')
    // Need a real 4hr read: enough bars for BB(20) + volume SMA(8), and live bands.
    if (!tf4h || tf4h.candleCount < 30 || !tf4h.bb) continue
    const last = Number(ticker.last)
    if (!last) continue
    const { lower, middle: mid, upper, percentB: pctB4h, bandwidth: bw4h } = tf4h.bb
    // A near-zero bandwidth means a flat/stale tape (AUDUSD prints identical bands) —
    // there is no band cycle to trade; %B on a degenerate band is noise.
    if (bw4h < 0.005) continue
    const rsi4h = validRsi(tf4h)
    const rsi1h = validRsi(tf1h)
    const rsiDay = validRsi(tfDay)
    const pctBDay = tfDay?.bb?.percentB ?? null
    const divBull = (tf4h.reasons.some((r) => r.includes('Bullish RSI divergence')))
      || (tfDay?.reasons.some((r) => r.includes('Bullish RSI divergence')) ?? false)
    const reversalCandle = tf4h.reasons.some((r) =>
      r.startsWith('Candle:') && (r.includes('hammer') || r.includes('bullish engulfing') || r.includes('doji at low')))
    const volTrend = tf4h.volTrend
    const volRatio = tf4h.volRatio

    const bbGateOk = pctB4h <= 0.10
    // Volume gate source: CMC's cross-exchange 24h volume change is PRIMARY — Gemini
    // alone is thin next to Binance/Coinbase/etc., so its own 3-bar/8-bar SMA trend
    // routinely reads 'falling' while the coin is genuinely breaking out market-wide.
    // A small deadband avoids flapping the gate on noise right around 0%. Falls back
    // to Gemini's own volTrend only when CMC has no read for the symbol (not
    // configured, or the symbol isn't listed on CMC).
    const CMC_RISING_PCT = 3
    const CMC_FALLING_PCT = -3
    const cmcVol = cmcVolumes.get(sig.symbol.replace(/USD$/, ''))
    const cmcTrend: 'rising' | 'falling' | 'flat' | null = cmcVol
      ? (cmcVol.volumeChange24h >= CMC_RISING_PCT ? 'rising' : cmcVol.volumeChange24h <= CMC_FALLING_PCT ? 'falling' : 'flat')
      : null
    const geminiFallback = cmcVol === undefined // true = no CMC read for this symbol, used Gemini's own trend
    const volGateOk = cmcTrend !== null ? cmcTrend === 'rising' : volTrend === 'rising'

    // 1hr-RSI washout read + "bottom not in" warning (retired-plan analysis 2026-07-07):
    // across every DECIDED mean-reversion setup in the retired ledger, 1hr RSI at entry
    // perfectly separated outcomes — 3/5 winners at 1hr RSI ≤ 28, but 0/9 winners at
    // 1hr RSI > 32 (corroborates the 06-28→07-04 finding that bottoms print at 1hr RSI
    // ≈ 25–26). So the RSI-washout point now rewards the 1hr depth (the predictive read),
    // falling back to 4hr only when 1hr is unavailable; and a still-elevated 1hr on an
    // otherwise-qualifying lower-band tag raises a `shallow1h` caution — a confirmation,
    // never a gate (BB + volume remain the only gates per the redesign).
    const rsiWashed = rsi1h !== null ? rsi1h <= 30 : (rsi4h !== null && rsi4h < 35)

    // BB-swing score (0–10) — BB position + volume dominate by construction (6 of
    // 10 available points); the rest are confirmations, never a substitute for the
    // two gates.
    let score = 0
    if (bbGateOk) score += 2                                   // at/below the lower band zone
    if (pctB4h < 0) score += 1                                 // closed BELOW the band — deep tag
    if (volGateOk) score += 2                                  // participation building (the volume gate)
    if (volRatio !== null && volRatio >= 1.3) score += 1       // latest bar itself above average
    if (rsiWashed) score += 1                                  // 1hr RSI ≤30 washed out (4hr<35 fallback)
    if (pctBDay !== null && pctBDay < 0.2) score += 1          // daily agrees price is low in its bands
    if (divBull) score += 1                                    // bullish divergence (4hr or 1day)
    if (reversalCandle) score += 1                             // 4hr reversal candle at the low

    const entry: Swing4hEntry = {
      symbol: sig.symbol, price: ticker.last, change: ticker.change,
      pctB4h, bw4h, lower, mid, upper,
      roomToMidPct: last > 0 ? ((mid - last) / last) * 100 : 0,
      roomToUpperPct: last > 0 ? ((upper - last) / last) * 100 : 0,
      rsi4h, rsi1h, rsiDay, pctBDay, volTrend, volRatio, divBull, reversalCandle,
      bbGateOk, volGateOk, cmcTrend, geminiFallback, qualified: bbGateOk && volGateOk,
      held: heldSet.has(sig.symbol), score,
    }
    // Entry side: anywhere near the lower half of the bands is worth listing so the
    // skill can see what's approaching the zone; exit side: held coins at/above the
    // upper band (%B ≥ 90) are trim/exit candidates.
    if (pctB4h <= 0.25) swing4hList.push(entry)
    if (entry.held && pctB4h >= 0.90) swing4hExitList.push(entry)
  }
  swing4hList.sort((a, b) =>
    Number(b.qualified) - Number(a.qualified) ||
    b.score - a.score ||
    a.pctB4h - b.pctB4h)
  swing4hExitList.sort((a, b) => b.pctB4h - a.pctB4h)

  function formatSwing4hBlock(list: Swing4hEntry[]): string {
    if (!list.length) return '  None — nothing in the lower quarter of its 4hr Bollinger Bands right now.\n'
    const qualified = list.filter((e) => e.qualified)
    const rows = list.slice(0, 14)
    for (const e of qualified) if (!rows.includes(e)) rows.push(e)
    return rows.map((e) => {
      const gates = e.qualified
        ? '✅ BOTH GATES'
        : [e.bbGateOk ? 'BB✓' : `BB ✗gate (%B ${(e.pctB4h * 100).toFixed(0)}%)`,
           e.volGateOk ? (e.geminiFallback ? 'volT✓(Gemini, no CMC)' : 'volT✓(CMC)') : `volT ✗gate (${e.geminiFallback ? e.volTrend : e.cmcTrend} — ${e.geminiFallback ? 'Gemini, no CMC' : 'CMC'})`].join(' · ')
      const extras: string[] = []
      if (e.geminiFallback) extras.push('⚠ no CMC listing — volume gate fell back to Gemini-only')
      if (e.volRatio !== null) extras.push(`vol ${e.volRatio}× 20-bar`)
      if (e.rsi4h !== null) extras.push(`4hr RSI ${e.rsi4h}`)
      // 1hr RSI depth: the strongest single win/loss discriminator in the retired-plan
      // analysis (0/9 winners at 1hr RSI >32). Flag a still-elevated 1hr as a caution —
      // a lower-band tag whose 1hr says the bottom isn't in yet is where the losers lived.
      if (e.rsi1h !== null) extras.push(e.rsi1h > 35 ? `⚠ 1hr RSI ${e.rsi1h} (bottom likely not in)` : `1hr RSI ${e.rsi1h}✓`)
      if (e.rsiDay !== null) extras.push(`1d RSI ${e.rsiDay}`)
      if (e.pctBDay !== null) extras.push(`1d %B ${(e.pctBDay * 100).toFixed(0)}%`)
      if (e.divBull) extras.push('⚡ BULLISH DIV')
      if (e.reversalCandle) extras.push('🕯 reversal candle')
      if (e.held) extras.push('📌 HELD')
      const scoreStr = e.score >= 7 ? `★★ BB-SWING ${e.score}/10` : e.score >= 5 ? `★ BB-SWING ${e.score}/10` : `bb-swing ${e.score}/10`
      // Pre-resolve the capital-gate verdict per the live-vs-paper policy (skill:
      // ≥5 LIVE at flat $5–$10, 3-4 PAPER, room-to-mid ≥ +1.5% or the band's too
      // tight to pay fees) so the strategy reads a decision, not inputs.
      const tierTag = !e.qualified ? ''
        : e.roomToMidPct < 1.5 ? ' → ⛔ SKIP (room <1.5%, fees eat it)'
        : e.score >= 7 ? ' → 🟢 LIVE $5–10 (PRIME 7+)'
        : e.score >= 5 ? ' → 🟢 LIVE $5–10 (HIGH 5-6)'
        : e.score >= 3 ? ' → 📝 PAPER (3-4, paper_only)'
        : ' → below gate'
      return `  **${e.symbol}** $${px(Number(e.price))} (${e.change > 0 ? '+' : ''}${e.change}% 24h) | %B ${(e.pctB4h * 100).toFixed(0)}% bw ${(e.bw4h * 100).toFixed(1)}% | ${gates} | lower $${px(e.lower)} · mid $${px(e.mid)} (+${e.roomToMidPct.toFixed(1)}%) · upper $${px(e.upper)} (+${e.roomToUpperPct.toFixed(1)}%)${extras.length ? ' | ' + extras.join(' · ') : ''} | ${scoreStr}${tierTag}`
    }).join('\n')
  }
  const swing4hExitBlock = swing4hExitList.length === 0
    ? '  None — no held coin is at/above its 4hr upper band.\n'
    : swing4hExitList.map((e) =>
        `  **${e.symbol}** $${px(Number(e.price))} | %B ${(e.pctB4h * 100).toFixed(0)}% at/above the upper band ($${px(e.upper)}) — TRIM/EXIT zone; midband $${px(e.mid)} is the round-trip target${e.rsi4h !== null ? ` · 4hr RSI ${e.rsi4h}` : ''}`
      ).join('\n')

  // Tradeable subsets computed ONCE so the concurrency advisories and the watch
  // blocks can't disagree: every candidate an advisory names must have a full row
  // in its watch block (RSI/ADX/score components inspectable), even when it ranks
  // below the top-15 display cut.
  const swingTradeable = swingList.filter((e) => e.volumeConfirmed && (e.divBullishHi || e.capitulation))
  function watchRows<T>(list: T[], mustInclude: T[], topN = 15): T[] {
    const rows = list.slice(0, topN)
    for (const e of mustInclude) if (!rows.includes(e)) rows.push(e)
    return rows
  }

  function formatOversoldBlock(list: OversoldEntry[]): string {
    if (!list.length) return '  None currently.\n'
    return list.slice(0, 15).map((e) => {
      const rsiStr = [
        e.rsi15m !== null ? `15m:${e.rsi15m}` : null,
        e.rsi1hr !== null ? `1hr:${e.rsi1hr}` : null,
        e.rsiDay !== null ? `1d:${e.rsiDay}` : null,
      ].filter(Boolean).join(' | ')
      const extras: string[] = []
      if (e.stochK !== null) extras.push(`StochRSI K:${e.stochK}`)
      if (e.bbPctB !== null) extras.push(`BB %B:${(e.bbPctB * 100).toFixed(0)}%`)
      if (e.divergence) extras.push(`⚡ ${e.divergence.toUpperCase()} DIV`)
      if (e.capitulation) extras.push('🔥 CAPITULATION')
      if (e.hmaReclaim) extras.push('HMA✓ reclaim')
      if (e.obvCrossUp) extras.push('OBV⤴ cross-up')
      else if (e.obvBullish) extras.push('OBV↑ 3>8')
      extras.push(e.volumeConfirmed ? 'vol✓' : 'NO-VOL ✗gate')
      extras.push(e.freshTrigger ? 'TRIG✓' : 'no-trigger ✗gate')
      // 1hr-RSI floor (skills' hard gate for FAST/MICRO bounce entries) + the
      // predicted bottom price so a patient limit can rest AT it, not at the bid.
      extras.push(e.floor1hOk ? '1hr-floor✓ (≤35)' : `1hr-floor ✗gate (1hr RSI ${e.rsi1hr ?? '?'} > 35 — no FAST/MICRO entry)`)
      // Already at/below RSI 28 → the inversion returns the current price (no
      // deeper drop needed); say so instead of printing a degenerate "band".
      if (e.rsi1hr !== null && e.rsi1hr <= 28) extras.push('🎯 1hr already ≤28 — bottom-grade NOW, patient limit at bid/recent-low')
      else if (e.p1h25 !== null) extras.push(`🎯 P@1hrRSI25 $${px(e.p1h25)}${e.p1h28 !== null ? ` (RSI28 $${px(e.p1h28)})` : ''}`)
      if (e.trendStrongDown) extras.push('📉 1hr ADX strong downtrend (no reversal trigger) −1')
      if (e.patterns.length) extras.push(e.patterns.map((p) => p.replace('Candle: ', '')).join(', '))
      const extStr = extras.length ? ` | ${extras.join(' · ')}` : ''
      const scoreStr = e.confluenceScore >= 5 ? ` ★★ SCORE ${e.confluenceScore}/9` : e.confluenceScore >= 3 ? ` ★ SCORE ${e.confluenceScore}/9` : ` score ${e.confluenceScore}/9`
      return `  **${e.symbol}** $${Number(e.price).toLocaleString()} (${e.change > 0 ? '+' : ''}${e.change}% 24h) | RSI ${rsiStr}${extStr}${scoreStr}`
    }).join('\n')
  }

  // Crypto alts are highly correlated as an asset class — multiple concurrent SWING
  // positions are rarely the independent bets they look like on paper. This is a
  // simple gate-count heuristic, not a real pairwise return-correlation calculation
  // (that would need historical-return data plumbed into this function); it's meant
  // as an honest "don't stack these" nudge, not a precise correlation coefficient.
  function swingConcurrencyAdvisory(tradeable: OversoldEntry[]): string {
    if (tradeable.length <= 1) return ''
    const names = tradeable.slice(0, 5).map((e) => e.symbol).join(', ')
    return `\n⚠️ ${tradeable.length} SWING candidates cleared vol✓+REVERSAL✓ simultaneously (${names}) — alts move together, these are not independent bets. Avoid opening more than 1–2 concurrent SWING positions; if forced to choose, take the highest score and skip the rest.\n`
  }

  // Renders the rows it's given (already cut + advisory-extended via watchRows).
  function formatSwingBlock(list: OversoldEntry[]): string {
    if (!list.length) return '  None currently.\n'
    return list.map((e) => {
      const rsiStr = [
        e.rsi1hr !== null ? `1hr:${e.rsi1hr}` : null,
        e.rsiDay !== null ? `1d:${e.rsiDay}` : null,
        e.rsi15m !== null ? `15m:${e.rsi15m}` : null,
      ].filter(Boolean).join(' | ')
      const extras: string[] = []
      if (e.divBullishHi) extras.push('⚡ HI-TF BULLISH DIV (reversal trigger)')
      else if (e.divergence === 'bullish') extras.push('⚡ 15m bullish div')
      if (e.capitulation) extras.push('🔥 CAPITULATION')
      extras.push(e.volumeConfirmed ? 'vol✓' : 'NO-VOL ✗gate')
      if (e.trendStrongDown) extras.push('📉 1hr ADX strong downtrend (no reversal trigger) −1')
      // A swing long is allowed in RISK-OFF only with a confirmed reversal trigger.
      const reversalTrigger = e.divBullishHi || e.capitulation
      extras.push(reversalTrigger ? 'REVERSAL✓ (counter-trend OK)' : 'no-reversal (RISK-OFF→skip)')
      // Predicted-bottom tranche prices — SWING entries rest ½ at the 1hr RSI-28
      // price and ½ at the RSI-25 price (where bottoms actually print), never
      // "½ at bid, ½ −1–2% deeper". Already ≤28 → the inversion returns the
      // current price; say the coin is in the zone rather than print a fake band.
      if (e.rsi1hr !== null && e.rsi1hr <= 28) extras.push('🎯 already in the bottom zone (1hr RSI ≤28) — tranches at bid / recent low')
      else if (e.p1h28 !== null && e.p1h25 !== null) extras.push(`🎯 tranches ½ $${px(e.p1h28)} (1hr RSI28) · ½ $${px(e.p1h25)} (RSI25)`)
      const extStr = ` | ${extras.join(' · ')}`
      const scoreStr = e.swingScore >= 4 ? ` ★★ SWING ${e.swingScore}/7` : e.swingScore >= 2 ? ` ★ SWING ${e.swingScore}/7` : ` swing ${e.swingScore}/7`
      return `  **${e.symbol}** $${Number(e.price).toLocaleString()} (${e.change > 0 ? '+' : ''}${e.change}% 24h) | RSI ${rsiStr}${extStr}${scoreStr}`
    }).join('\n')
  }

  // NOTE: the BREAKOUT watch is retired (paper-training only) and no longer rendered
  // in the intel report, so its row formatter + concurrency advisory were removed.
  // `breakoutList` is still computed for the MARKET SUMMARY count and paper backfill.

  // ── RSI divergences across all seeded signals (canonical USD pairs only) ──
  // Rank by RSI-point magnitude so the strongest, most actionable setups lead.
  const divMagnitude = (s: Signal, kind: 'Bullish' | 'Bearish'): number => {
    const reason = s.timeframes.flatMap((tf) => tf.reasons).find((r) => r.includes(`${kind} RSI divergence`)) ?? ''
    const m = reason.match(/RSI ([+-]?\d+\.?\d*)pts/)
    return m ? Math.abs(Number(m[1])) : 0
  }
  const bullishDivList = signals
    .filter((s) => s.seeded && isWatchable(s.symbol) && s.timeframes.some((t) => t.reasons.some((r) => r.includes('Bullish RSI divergence'))))
    .sort((a, b) => divMagnitude(b, 'Bullish') - divMagnitude(a, 'Bullish'))
  const bearishDivList = signals
    .filter((s) => s.seeded && isWatchable(s.symbol) && s.timeframes.some((t) => t.reasons.some((r) => r.includes('Bearish RSI divergence'))))
    .sort((a, b) => divMagnitude(b, 'Bearish') - divMagnitude(a, 'Bearish'))

  // ── Market regime + portfolio risk guards ──
  // RISK-OFF disables new mean-reversion longs: oversold stays oversold in a
  // downtrend, which is the documented #1 failure mode of bounce strategies.
  const VOL_MULT = 1.3

  const btcTicker = tickerMap.get('BTCUSD')
  const btcSig = signalMap.get('BTCUSD')
  const btcDaily = btcSig?.timeframes.find((t) => t.tf === '1day')
  const btcPrice = btcTicker ? Number(btcTicker.last) : null
  const btcBelowMa200 = (btcDaily?.ma200 != null && btcPrice != null) ? btcPrice < btcDaily.ma200 : null
  const btcBearishTfs = btcSig ? btcSig.timeframes.filter((t) => t.direction === 'SELL').length : 0
  const btcDailySell = btcDaily?.direction === 'SELL'
  let regime: 'RISK-ON' | 'RISK-OFF' | 'NEUTRAL' = 'NEUTRAL'
  if (btcDailySell || btcBelowMa200 === true || btcBearishTfs >= 2) regime = 'RISK-OFF'
  else if (btcDaily?.direction === 'BUY' && btcBelowMa200 === false) regime = 'RISK-ON'

  // Same computation as PORTFOLIO OVERVIEW (summed via holdingUsd above) — the two
  // totals must never disagree again.
  const totalValue = totalPortfolioUSD
  const cashValue = holdings.filter((h) => STABLES.has(h.currency)).reduce((s, h) => s + holdingUsd(h), 0)
  const btcValue = holdings.filter((h) => h.currency === 'BTC').reduce((s, h) => s + holdingUsd(h), 0)
  const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : 0
  const btcPct = totalValue > 0 ? (btcValue / totalValue) * 100 : 0

  const regimeIcon = regime === 'RISK-OFF' ? '🔴' : regime === 'RISK-ON' ? '🟢' : '🟡'
  const ma200Str = btcBelowMa200 === null ? 'MA200 n/a' : btcBelowMa200 ? 'below MA200' : 'above MA200'
  const longsRule = regime === 'RISK-OFF'
    ? '⚠️ RISK-OFF is CONTEXT ONLY — it does NOT block or veto alt entries (operator directive 2026-07-07: alts pump and dive fast; letting BTC\'s regime disqualify a valid alt setup sandbags the system). A setup that clears the two hard gates (BB + volume) is tradeable in ANY regime. Caution is warranted (fast dives → keep stops/safe-mode tight), and a reversal confirmation raises conviction, but regime alone never kills or shrinks the trade. Alts may of course be trimmed/exited too. BTC is unaffected — see BTC TOP-SELL policy.'
    : '✅ Alt long bounce entries permitted (subject to per-setup scoring + volume gate). BTC is unaffected by this gate — see BTC TOP-SELL policy.'
  const regimeBlock = `## ${regimeIcon} MARKET REGIME — ${regime}
- BTC: ${btcPrice != null ? '$' + btcPrice.toLocaleString() : '?'} | daily ${btcDaily?.direction ?? '?'} | ${ma200Str} | ${btcBearishTfs}/3 TFs bearish
- ${longsRule}
- Portfolio: total $${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | cash ${cashPct.toFixed(1)}% | BTC ${btcPct.toFixed(1)}% of portfolio (this is the target allocation, not a risk — no concentration cap or cash floor applies to BTC)
- Bounce entry gate (alts only): volume confirmation REQUIRED (latest bar ≥ ${VOL_MULT}× 20-bar avg, shown as \`vol✓\` in Oversold Watch). \`NO-VOL\` candidates are disqualified regardless of score.
- 1hr-RSI floor (FAST/MICRO bounce entries): 1hr RSI must be ≤ 35 (\`1hr-floor✓\` in Oversold Watch). Patient entries rest at the 🎯 predicted 1hr RSI-25 price per row, not at the bid — bottoms print at 1hr RSI ≈ 25–26 (2026-07-04 tuning).
- 4hr BB-swing gates (crypto-strategy primary, 2026-07-05): a trade may only be taken when the 4hr chart agrees — **BB gate** (4hr %B ≤ 10, price at/below the lower Bollinger Band) AND **volume gate** (RISING 4hr volume trend, 3-bar avg > 8-bar avg, \`volT✓\` in the 🌊 watch). Both gates are unconditional; confirmations (RSI, divergence, candles) never substitute for them.
- **Real fee rate (measured from your own fills${fr.samples > 0 ? `, n=${fr.samples}` : ' — none yet, using defaults'}): maker ${(fr.maker * 100).toFixed(2)}% / taker ${(fr.taker * 100).toFixed(2)}% per side.** Quote net P&L using THESE, not a fixed 0.7% round-trip. Resting-limit exits (targets) pay the **maker** rate; market/stop/safe-mode exits pay **taker**. Position P&L below is already NET of the maker exit fee (cost basis already includes the real entry fee). A maker→maker round-trip costs ~${((fr.maker * 2) * 100).toFixed(2)}%; the +1.0% gross viability floor still applies.`

  const usdPairs = tickers.filter((t) => t.symbol.endsWith('USD'))
  const seeded = signals.filter((s) => s.seeded).length
  const buyHigh = signals.filter((s) => s.direction === 'BUY' && s.entryQuality === 'HIGH').length
  const sellHigh = signals.filter((s) => s.direction === 'SELL' && s.entryQuality === 'HIGH').length
  const buyMed = signals.filter((s) => s.direction === 'BUY' && s.entryQuality === 'MEDIUM').length
  const sellMed = signals.filter((s) => s.direction === 'SELL' && s.entryQuality === 'MEDIUM').length

  // Market bias is DERIVED FROM the regime — the MARKET REGIME block governs per the
  // strategy skill, so the bottom line can't contradict it. The per-coin BUY/SELL
  // signal skew only breaks the tie when BTC says the regime is NEUTRAL.
  const signalSkew = `BUY H+M ${buyHigh + buyMed} vs SELL H+M ${sellHigh + sellMed}`
  const marketBias = regime === 'RISK-OFF'
    ? `🔴 BEARISH — regime RISK-OFF governs (signal mix: ${signalSkew})`
    : regime === 'RISK-ON'
      ? `🟢 BULLISH — regime RISK-ON governs (signal mix: ${signalSkew})`
      : buyHigh + buyMed > sellHigh + sellMed
        ? `🟢 BULLISH — regime NEUTRAL, signal mix decides (${signalSkew})`
        : sellHigh + sellMed > buyHigh + buyMed
          ? `🔴 BEARISH — regime NEUTRAL, signal mix decides (${signalSkew})`
          : `⚪ NEUTRAL (${signalSkew})`

  // ── FLASH-DIP sweep: predictive RSI-30–33 entries on 5m/1m ──────────────
  // Rank the near-oversold watchable universe by next-hour swing potential, take
  // the top ~10, and invert Wilder RSI to price a resting limit AT the predicted
  // 30–33 bottom. 5m/1m for the winners are prefetched by tickerRefresh (see
  // flashDipSelected); a symbol still warming falls back to 15m closes so the
  // section always renders a level. Fixed +1–2% target, hard stop, short expiry.
  // A fast-timeframe RSI is trustworthy only with enough real candles and a non-
  // degenerate value — illiquid/flat 5m/1m windows collapse to exactly 0 or 100
  // (KMNO/TON show 5m:0), which would otherwise fake an "AT TARGET NOW".
  const fastRsi = (candles: Candle[]): number | null => {
    if (candles.length < 30) return null
    const r = rsi14(closes(candles))
    return (r !== null && r > 0 && r < 100) ? r : null
  }
  const flashCandidates = !show.has('flashdip') ? [] : allEntries
    .filter((e) => (e.rsi15m !== null && e.rsi15m < 45) || (e.rsi1hr !== null && e.rsi1hr < 48))
    .map((e) => {
      const cache = candleCache.get(e.symbol)
      const c5 = cache?.['5m'] ?? []
      const c1 = cache?.['1m'] ?? []
      const c15 = cache?.['15m'] ?? []
      const rsi5m = fastRsi(c5)
      const rsi1m = fastRsi(c1)
      // Prediction timeframe: prefer 5m ONLY when its RSI is trustworthy AND already
      // leaning toward the zone (<50). A single-candle inversion off a HIGH RSI
      // over-promises how near the RSI-33 price is (a coin at 5m RSI 75 "reaching 33
      // next bar" is noise, not a bottom) — fall back to 15m, whose current RSI is
      // the reliable oversold read for these candidates.
      const use5m = rsi5m !== null && rsi5m < 50
      const primaryTf: '5m' | '15m' = use5m ? '5m' : '15m'
      const primaryRsi = use5m ? rsi5m : e.rsi15m // e.rsi15m is validRsi-guarded (null if degenerate)
      const primaryCloses = use5m ? closes(c5) : closes(c15)
      const p33 = predictPriceForRsi(primaryCloses, 33) // shallower dip → higher price (nearer edge)
      const p30 = predictPriceForRsi(primaryCloses, 30) // deeper dip → lower price
      // 1m refinement band only off a trustworthy, non-free-fall 1m read (1m is the
      // noisiest tier — degenerate 0.05/95 reads would print a meaningless band).
      const show1m = rsi1m !== null && rsi1m >= 5 && rsi1m < 50
      const p33_1m = show1m ? predictPriceForRsi(closes(c1), 33) : null
      const p30_1m = show1m ? predictPriceForRsi(closes(c1), 30) : null
      const last = Number(e.price)
      // AT TARGET only off a trustworthy read that's genuinely already ≤33.
      const atTarget = primaryRsi !== null && primaryRsi <= 33
      const bandHi = atTarget ? last : (p33?.predictedPrice ?? null)
      const bandLo = p30?.predictedPrice ?? null
      const distPct = (bandHi !== null && last > 0) ? ((last - bandHi) / last) * 100 : null
      const warming = c5.length < 30 ? '5m warming' : (!use5m && rsi5m !== null ? '5m not oversold' : null)

      let flashScore = 0
      if (e.rsi15m !== null && e.rsi15m >= 30 && e.rsi15m < 45) flashScore += 2 // approaching the zone
      else if (e.rsi15m !== null && e.rsi15m < 30) flashScore += 1              // already deep
      if (e.rsi1hr !== null && e.rsi1hr < 50) flashScore += 1                   // higher-TF room to rally
      if (e.bbPctB !== null && e.bbPctB < 0.2) flashScore += 1
      if (e.volumeConfirmed) flashScore += 1
      if (distPct !== null && distPct >= 0 && distPct <= 3) flashScore += 2     // dip reachable within the hour
      else if (distPct !== null && distPct > 3 && distPct <= 6) flashScore += 1
      if (Math.abs(e.change) >= 3) flashScore += 1                             // enough movement to travel 1–2%
      if (atTarget) flashScore += 1                                           // already in the zone now

      // 1hr position-grade band (operator directive 2026-07-04 "extend the flash dip"):
      // the 5m/15m RSI-30–33 band is the scalp entry; the 1hr RSI-28→25 band is where
      // real bottoms print (the week's lows all hit 1hr RSI ≈ 25–26). A scalp entry
      // that sits AT/inside the 1hr band is a scalp at a position-grade bottom — the
      // highest-quality flash fill there is.
      const atPositionBottom = (e.rsi1hr !== null && e.rsi1hr <= 28)
        || (bandHi !== null && e.p1h28 !== null && bandHi <= e.p1h28)
      return { e, last, rsi5m, rsi1m, primaryTf, primaryRsi, warming, bandHi, bandLo, atTarget, distPct,
               band1mHi: p33_1m?.predictedPrice ?? null, band1mLo: p30_1m?.predictedPrice ?? null,
               atPositionBottom, flashScore }
    })
    // Keep only candidates with a reliable read and a valid predicted dip near price.
    // Floor the RSI at 5: a near-zero read is relentless one-way dumping (illiquid or
    // a hard knife), not the 30–33 bounce zone — "oversold stays oversold", not a setup.
    .filter((c) => c.primaryRsi !== null && c.primaryRsi >= 5 && c.bandHi !== null && (c.distPct === null || (c.distPct >= -1 && c.distPct <= 8)))
    // vol✓ first (NO-VOL can't be traded — don't let it crowd out tradeable rows),
    // then flash score, then nearest dip.
    .sort((a, b) =>
      (Number(b.e.volumeConfirmed) - Number(a.e.volumeConfirmed)) ||
      (b.flashScore - a.flashScore) ||
      ((a.distPct ?? 99) - (b.distPct ?? 99)))
    .slice(0, 10)

  flashDipSelected = flashCandidates.map((c) => c.e.symbol)

  const flashDipBlock = flashCandidates.length === 0
    ? '  No flash-dip candidates near the RSI 30–33 zone right now.\n'
    : flashCandidates.map((c) => {
      const entryPx = c.atTarget ? c.last : (c.bandHi ?? c.last) // enter at the RSI-33 edge
      const t1 = entryPx * 1.015 // fixed +1.5% (mid of the 1–2% band), full exit
      const stop = entryPx * 0.985 // −1.5% hard stop
      const rsiStr = [
        c.rsi5m !== null ? `5m:${c.rsi5m}` : null,
        c.rsi1m !== null ? `1m:${c.rsi1m}` : null,
        c.e.rsi15m !== null ? `15m:${c.e.rsi15m}` : null,
        c.e.rsi1hr !== null ? `1hr:${c.e.rsi1hr}` : null,
      ].filter(Boolean).join(' ')
      const warming = c.warming ? ` _(${c.warming} — using 15m)_` : ''
      const deep = c.atTarget && c.primaryRsi !== null && c.primaryRsi < 25
      const bandStr = c.atTarget
        ? `⚠️ ${deep ? 'DEEP — PAST ZONE' : 'AT TARGET NOW'} (${c.primaryTf} RSI ${c.primaryRsi}${deep ? ', below the 30–33 zone — bigger bounce but knife-risk' : ' ≤33 — stage/enter immediately'})`
        : `🎯 entry $${px(c.bandHi)}→$${px(c.bandLo)} (RSI33→30, ${c.primaryTf})` +
          (c.band1mHi !== null ? ` · 1m band $${px(c.band1mHi)}→$${px(c.band1mLo)}` : '')
      const distStr = c.distPct !== null ? ` · dist ${c.distPct >= 0 ? '−' : '+'}${Math.abs(c.distPct).toFixed(2)}% to zone` : ''
      const volStr = c.e.volumeConfirmed ? ' · vol✓' : ' · NO-VOL ✗gate'
      // 1hr position-grade band alongside the scalp band: where the deeper bottom
      // prints. 💪 = the scalp entry is at/inside it (highest-quality fill).
      const hrBandStr = c.e.rsi1hr !== null && c.e.rsi1hr <= 28
        ? ' · 💪 1hr already ≤28 (position-grade bottom NOW)'
        : c.e.p1h28 !== null && c.e.p1h25 !== null
          ? ` · 1hr band $${px(c.e.p1h28)}→$${px(c.e.p1h25)} (RSI28→25)${c.atPositionBottom ? ' 💪 scalp entry AT position-grade bottom' : ''}`
          : ''
      const scoreStr = c.flashScore >= 6 ? ` ★★ FLASH ${c.flashScore}/9` : c.flashScore >= 4 ? ` ★ FLASH ${c.flashScore}/9` : ` flash ${c.flashScore}/9`
      return `  **${c.e.symbol}** $${px(c.last)} (${c.e.change > 0 ? '+' : ''}${c.e.change}% 24h) | RSI ${rsiStr}${warming} | ${bandStr}${distStr}${hrBandStr}${volStr} | T1 $${px(t1)} (+1.5%) stop $${px(stop)} (−1.5%) · expiry 20–30m${scoreStr}`
    }).join('\n')

  // ── Re-entry cooldown: banked sells in the last 4h ──────────────────────
  // Tuning from the 2026-07-04 XRP round-trip: after a green exit, re-buying the
  // same coin above the banked price within hours is a chase (+4.3% bank →
  // re-entered 3.5h later 0.1% below the exit → −1.7% net loss). Surface every
  // symbol with a sell fill in the last 4h so the skills enforce the cooldown
  // without re-deriving it from raw fills.
  const COOLDOWN_MS = 4 * 3_600_000
  const nowMsCd = Date.now()
  const recentSells = new Map<string, { price: number; at: number }>()
  for (const f of tradeHistory) {
    if (f.side !== 'sell') continue
    if (nowMsCd - f.timestampMs > COOLDOWN_MS) continue
    const cd = recentSells.get(f.symbol) ?? { price: 0, at: 0 }
    cd.price = Math.max(cd.price, Number(f.price))   // highest banked price in-window
    cd.at = Math.max(cd.at, f.timestampMs)           // most recent sell fill
    recentSells.set(f.symbol, cd)
  }
  const cooldownBlock = recentSells.size === 0
    ? '  None — no sell fills in the last 4h. No re-entry cooldowns active.\n'
    : [...recentSells.entries()].sort((a, b) => b[1].at - a[1].at).map(([sym, c]) => {
        const agoMin = Math.round((nowMsCd - c.at) / 60_000)
        const untilZ = new Date(c.at + COOLDOWN_MS).toISOString().slice(11, 16)
        return `  - **${sym}** banked @ $${px(c.price)} (${agoMin}m ago) — ⛔ no re-entry above $${px(c.price)} until ${untilZ}Z, unless 1hr RSI ≤ 35 or a fresh FLASH-DIP band fill`
      }).join('\n')

  // ── Assemble the middle sections, each gated by `show` ─────────────────
  // PORTFOLIO / REGIME / COOLDOWN / MARKET SUMMARY are always kept (shared
  // context, cheap); everything below renders only for strategies that consume
  // it. Separators are inserted by the join so a hidden section leaves no orphan
  // `---`. The retired BREAKOUT watch is intentionally absent (dropped for all).
  const midSections: Array<[string, string]> = [
    ['bbswing', `## 🌊 4HR BB SWING WATCH — PRIMARY STRATEGY (BB + volume decide; everything else confirms)
*The crypto-strategy skill's main trade-selection section (operator directive 2026-07-05). Candidates in the lower quarter of their **4hr Bollinger Bands**, hunting the mean-reversion swing from the lower band to the midband/upper band over hours-to-days. Two **hard gates** per row — \`BB✓\` (4hr %B ≤ 10) and \`volT✓\` (RISING 4hr volume: 3-bar avg > 8-bar avg, participation building rather than one spike). **✅ BOTH GATES = tradeable; any ✗gate = no trade regardless of score.***
*Score (0–10), weighted so BB + volume dominate: %B ≤ 10 (+2), close below the band (+1), rising volume trend (+2), latest bar ≥ 1.3× 20-bar avg (+1), 1hr RSI ≤ 30 washed out (+1; 4hr<35 fallback), 1day %B < 20 (+1), bullish divergence 4hr/1day (+1), 4hr reversal candle (+1). Row shows the exact band prices: entry structure = the lower band, T1 = the midband (+% shown), runner = the upper band. The **→ verdict** per qualifying row applies the live-vs-paper capital gate: 🟢 LIVE $5–10 (score ≥5) · 📝 PAPER (3-4) · ⛔ SKIP (room to mid <1.5%, fees eat it). **⚠ 1hr RSI (bottom likely not in)** = elevated 1hr on a lower-band tag → lower conviction (0/9 retired winners had 1hr RSI >32); prefer \`1hr RSI ≤30✓\` rows.*
*The 4hr feed is derived from Gemini's 1hr candles (UTC-aligned 4-hour buckets); the newest bar is the forming 4hr candle.*

${formatSwing4hBlock(swing4hList)}

**📌 HELD — 4HR UPPER-BAND EXIT ZONE** (mirror side: held coins printing %B ≥ 90 — trim/exit into strength):

${swing4hExitBlock}`],
    ['flashdip', `## ⚡ FLASH-DIP — RSI-30 PREDICTIVE ENTRIES (fast <1h scalps)
*Predicts the price where RSI-14 enters the **30–33 zone** on 5m/1m by inverting Wilder RSI, so a resting limit can be staged AT the predicted bottom. Ranked (0–9) by next-hour swing potential; top 10 shown. Target a **fixed +1–2%** and exit fast — no holding; re-enter on the next dip if the reversal continues.*
*Gate (loosened for this track only): **volume still required** (\`NO-VOL\` disqualifies); the turn-trigger is **waived** (the resting limit IS the wait for the dip); protection is the **−1.5% hard stop + 20–30m entry expiry**; in RISK-OFF trade at **half size** (not blocked). Entry rests at the RSI-33 edge (fills as price enters the zone); the −1.5% stop and +1.5% T1 shown are off that edge.*
*Each row also shows the **1hr band $RSI28→$RSI25** — the position-grade bottom (the 06-28→07-04 lows all printed at 1hr RSI ≈ 25–26). **💪 = the scalp entry sits at/inside that band**: a flash fill at a real bottom, the highest-quality setup on this list — prefer 💪 rows at equal score. A scalp band far ABOVE the 1hr band means the dip likely has further to travel; take the quick +1.5% and don't linger.*

${flashDipBlock}`],
    ['oversold', `## 🟢 OVERSOLD WATCH — BOUNCE CANDIDATES
*RSI < 35 on 15m or 1hr. Score 5+/9 = high-probability bounce. Columns: RSI per TF | StochRSI K | BB %B | divergence | HMA/OBV turn | TRIG gate | patterns.*
*Score criteria: 15m RSI<30 (+1), 1hr RSI<45 (+1), BB %B<10% (+1), StochRSI K<20 (+1), bullish divergence (+2), capitulation (+1), hammer/engulfing (+1), HMA13 reclaim (+1), OBV 3>8 flow up (+1)*
*TRIG✓ gate (FAST/MICRO entries): requires a fresh reversal-turn trigger — HMA reclaim, OBV cross-up, StochRSI bullish cross, divergence, or capitulation. "no-trigger ✗gate" = deep-oversold but the turn isn't confirmed → do not enter (falling-knife guard), regardless of score.*
*1hr-floor gate (FAST/MICRO entries): 1hr RSI must be ≤ 35 — a 15m oversold with a neutral 1hr is a bounce within a fall, not a bottom (the 06-28→07-04 bottoms printed at 1hr RSI ≈ 25–26; entries made at 1hr RSI 38+ filled 8–17% above the eventual low). 🎯 P@1hrRSI25 = the predicted price where the 1hr RSI prints 25 (Wilder inversion) — rest patient limits AT it, not at the bid.*

${formatOversoldBlock(oversoldList)}`],
    ['swing', `## 🔵 SWING BOUNCE WATCH — 4–24h MEAN-REVERSION (buy the bottom, sell the rebound)
*Catch deeper-oversold coins near the low and ride the rebound over 4–24h (up to ~3 days). Ranked by SWING score (0–7), weighted to the 1hr/1day timeframes — RSI is the spine.*
*Score: 1hr RSI<35 (+1), 1hr RSI<25 (+1), 1day RSI<40 (+1), 1day RSI<30 (+1), higher-TF bullish divergence (+2), capitulation (+1). Wider stops (−3 to −5%), bigger targets (rebound high / MA retest, +4–12%), longer time-stops (hours, not 90m).*
*RISK-OFF rule: a swing long needs a REVERSAL✓ trigger (higher-TF bullish divergence OR capitulation) + vol✓ to be tradeable counter-trend. Without it, it's a falling knife — skip.*
*Entry pricing: rest the two tranches at the 🎯 predicted-bottom prices shown per row — ½ at the 1hr RSI-28 price, ½ at the RSI-25 price (each capped at the bid, never above). Bottoms print at 1hr RSI ≈ 25–26, not at "the bid" or the last swing low; if price never reaches the band, the trade wasn't there.*

${formatSwingBlock(watchRows(swingList, swingTradeable))}
${swingConcurrencyAdvisory(swingTradeable)}`],
    ['overbought', `## 🔴 OVERBOUGHT WATCH — REVERSAL / SHORT CANDIDATES
*RSI > 65 on 15m or 1hr. Watch for bearish divergence or shooting star patterns before shorting.*

${overboughtList.length === 0 ? '  None currently.\n' : overboughtList.slice(0, 10).map((e) => {
    const rsiStr = [
      e.rsi15m !== null ? `15m:${e.rsi15m}` : null,
      e.rsi1hr !== null ? `1hr:${e.rsi1hr}` : null,
    ].filter(Boolean).join(' | ')
    const extras: string[] = []
    if (e.stochK !== null && e.stochK > 80) extras.push(`StochRSI K:${e.stochK}`)
    if (e.divergence === 'bearish') extras.push('⚡ BEARISH DIV')
    if (e.patterns.length) extras.push(e.patterns.map((p) => p.replace('Candle: ', '')).join(', '))
    return `  **${e.symbol}** $${Number(e.price).toLocaleString()} (${e.change > 0 ? '+' : ''}${e.change}% 24h) | RSI ${rsiStr}${extras.length ? ' | ' + extras.join(' · ') : ''}`
  }).join('\n')}`],
    ['divergences', `## ⚡ RSI DIVERGENCES — HIGH-CONVICTION REVERSAL SETUPS
*Divergences are among the strongest reversal signals: price and RSI moving in opposite directions.*

*Ranked by RSI-point magnitude (strongest first). Only fires at RSI extremes — oversold for bullish, overbought for bearish. Showing top 12.*

${bullishDivList.length === 0 && bearishDivList.length === 0 ? '  No active divergences detected.\n' : ''}
${bullishDivList.length > 0 ? `**BULLISH DIVERGENCES** (price lower low, RSI higher low — expect bounce) — ${bullishDivList.length} total:\n${bullishDivList.slice(0, 12).map((s) => {
  const t = tickerMap.get(s.symbol)
  const chg = t ? ` (${t.change > 0 ? '+' : ''}${t.change}% 24h)` : ''
  const reason = s.timeframes.flatMap((tf) => tf.reasons).find((r) => r.includes('Bullish RSI divergence')) ?? ''
  return `  - **${s.symbol}** $${t ? Number(t.last).toLocaleString() : '?'}${chg} | ${reason}`
}).join('\n')}` : '  No bullish divergences.'}

${bearishDivList.length > 0 ? `**BEARISH DIVERGENCES** (price higher high, RSI lower high — expect pullback) — ${bearishDivList.length} total:\n${bearishDivList.slice(0, 12).map((s) => {
  const t = tickerMap.get(s.symbol)
  const chg = t ? ` (${t.change > 0 ? '+' : ''}${t.change}% 24h)` : ''
  const reason = s.timeframes.flatMap((tf) => tf.reasons).find((r) => r.includes('Bearish RSI divergence')) ?? ''
  return `  - **${s.symbol}** $${t ? Number(t.last).toLocaleString() : '?'}${chg} | ${reason}`
}).join('\n')}` : '  No bearish divergences.'}`],
    ['shortterm', `## SHORT-TERM OPPORTUNITIES (15m / 1hr)
*Day trading setups — hold minutes to hours. Use tighter stops.*

${formatSignalBlock(shortTermSignals)}`],
    ['medterm', `## MEDIUM-TERM OPPORTUNITIES (1hr / 1day)
*Swing trading setups — hold hours to days. Wider stops tolerated.*

${formatSignalBlock(medTermSignals)}`],
    ['movers', `## TOP 24h MOVERS
${movers}`],
  ]
  const gatedBody = midSections.filter(([k]) => show.has(k)).map(([, md]) => md).join('\n\n---\n\n')

  return `# CRYPTO INTEL REPORT
*Generated: ${now} · tailored for the **${enabledStrategy}** strategy — sections it doesn't use are omitted*

---

## PORTFOLIO OVERVIEW
**Total Estimated Value: $${totalPortfolioUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**

${portfolioLines.join('\n')}

---

${regimeBlock}

---

## ⏳ RE-ENTRY COOLDOWN — banked exits in the last 4h
*After a green exit, do NOT re-buy the same coin above the banked price for 4h (the 07-04 XRP lesson: +4.3% bank, re-entered 3.5h later at −0.1% below the exit, −1.7% net loss). A fresh entry needs a fresh dip: price meaningfully below the banked exit, or 1hr RSI back ≤ 35.*

${cooldownBlock}

---

${gatedBody}

---

## MARKET SUMMARY
- USD pairs tracked: ${usdPairs.length}
- Candle history seeded: ${seeded}/${signals.length} symbols
- BUY signals — HIGH: ${buyHigh} | MEDIUM: ${buyMed} | Total: ${signals.filter((s) => s.direction === 'BUY').length}
- SELL signals — HIGH: ${sellHigh} | MEDIUM: ${sellMed} | Total: ${signals.filter((s) => s.direction === 'SELL').length}
- HOLD: ${signals.filter((s) => s.direction === 'HOLD').length}
- Oversold (RSI<35): ${oversoldList.length} symbols | Overbought (RSI>65): ${overboughtList.length} symbols
- Swing-bounce candidates (1hr/1day oversold): ${swingList.length} symbols | with reversal trigger: ${swingList.filter((e) => e.divBullishHi || e.capitulation).length}
- Breakout candidates: ${breakoutList.length} symbols | score 4+/7 with vol✓: ${breakoutList.filter((e) => e.breakoutScore >= 4 && e.volumeConfirmed).length}
- Bullish divergences: ${bullishDivList.length} | Bearish divergences: ${bearishDivList.length}
- Market bias: ${marketBias}

---
*Indicators: RSI-14, StochRSI(14/14/3/3), MACD(12/26/9), Bollinger Bands(20,2σ), MA20/50/200, HMA-13, OBV + OBV(3/8) MA cross, ADX-14, VWAP, Ichimoku(9/26/52), Fibonacci, RSI Divergence, Candlestick Patterns, Capitulation Detection*
*Signal weights: 4hr=40%, 1day=30%, 1hr=20%, 15m=10% (see SIGNAL_WEIGHTS)*
`
}

// ── Candle cache ───────────────────────────────────────────────────────

interface CandleCache {
  '1m': Candle[]
  '5m': Candle[]
  '15m': Candle[]
  '1hr': Candle[]
  '4hr': Candle[]   // derived — always aggregateTo4h(cache['1hr']), never fetched
  '1day': Candle[]
}
const candleCache = new Map<string, CandleCache>()

// Symbols the FLASH-DIP sweep selected last report build (top ~10 next-hour swing
// candidates). tickerRefresh keeps their 1m/5m candles fresh — the same "prefetch
// + store locally" treatment holdings get — so predictive RSI-30 entries are priced
// off live fast-timeframe data instead of re-fetching the whole universe every run.
let flashDipSelected: string[] = []
export function getFlashDipSelected(): string[] { return flashDipSelected }

/**
 * A syntactically valid Gemini trading pair.
 *
 * Guards two things at once: path injection (the symbol is interpolated straight
 * into the public candles URL, so `btcusd/../../v1/x` would steer the request) and
 * unbounded cache growth (getCache mints a persistent entry per distinct string).
 * Deliberately a shape check rather than a membership test against the live symbol
 * list — a newly listed pair should work the moment Gemini has it, without waiting
 * for our next universe refresh.
 */
function isValidSymbol(symbol: string): boolean {
  return /^[A-Za-z0-9]{5,15}$/.test(symbol)
}

function getCache(symbol: string): CandleCache {
  if (!candleCache.has(symbol)) {
    candleCache.set(symbol, { '1m': [], '5m': [], '15m': [], '1hr': [], '4hr': [], '1day': [] })
  }
  return candleCache.get(symbol)!
}

// 1m/5m are only kept fresh for portfolio holdings (see tickerRefresh/seedAll) —
// seeding all ~235 tracked symbols at 1-minute granularity would multiply the
// Gemini candle-fetch load ~2.7x for data the broader Oversold/Swing watch
// (which scans the whole universe) doesn't use. Held coins get the fast tiers
// for precise FAST-track entry timing; everything else stays 15m/1hr/1day.
const FAST_TIMEFRAMES: Timeframe[] = ['5m', '1m']

// ── Candle persistence ─────────────────────────────────────────────────

interface PersistedCache {
  savedAt: number
  symbols: Record<string, CandleCache>
}

function loadCandleCache(): void {
  try {
    if (!existsSync(CANDLE_CACHE_FILE)) return
    const raw = readFileSync(CANDLE_CACHE_FILE, 'utf8')
    const data = JSON.parse(raw) as PersistedCache
    // Cache is stale if older than 2 hours — daily candles are fine, but 15m gets stale
    const ageMs = Date.now() - data.savedAt
    const maxAge = 2 * 60 * 60 * 1000 // 2 hours
    if (ageMs > maxAge) {
      console.log(`[crypto] candle cache stale (${Math.round(ageMs / 60000)}m old) — will re-seed`)
      return
    }
    let count = 0
    for (const [symbol, cache] of Object.entries(data.symbols)) {
      // Backfill '1m'/'5m' for caches persisted before those tiers existed, and
      // re-derive '4hr' from the hourly bars (cheap, and always in sync with 1hr).
      candleCache.set(symbol, {
        ...cache,
        '1m': cache['1m'] ?? [], '5m': cache['5m'] ?? [],
        '4hr': aggregateTo4h(cache['1hr'] ?? []),
      })
      count++
    }
    console.log(`[crypto] loaded candle cache: ${count} symbols (${Math.round(ageMs / 60000)}m old)`)
  } catch (e) {
    console.warn('[crypto] candle cache load failed:', (e as Error).message)
  }
}

function saveCandleCache(): void {
  try {
    ensureDir()
    const symbols: Record<string, CandleCache> = {}
    for (const [symbol, cache] of candleCache.entries()) {
      // Only persist symbols with meaningful data
      if (cache['1day'].length > 0 || cache['1hr'].length > 0) {
        symbols[symbol] = cache
      }
    }
    const data: PersistedCache = { savedAt: Date.now(), symbols }
    writeFileSync(CANDLE_CACHE_FILE, JSON.stringify(data))
    console.log(`[crypto] candle cache saved: ${Object.keys(symbols).length} symbols`)
  } catch (e) {
    console.warn('[crypto] candle cache save failed:', (e as Error).message)
  }
}

async function seedSymbol(symbol: string): Promise<void> {
  const cache = getCache(symbol)
  await Promise.allSettled([
    fetchCandlesFromGemini(symbol, '1day').then((c) => { cache['1day'] = c }),
    fetchCandlesFromGemini(symbol, '1hr').then((c) => {
      cache['1hr'] = c
      cache['4hr'] = aggregateTo4h(c) // 4hr is derived from the same fetch — no extra API load
    }),
    fetchCandlesFromGemini(symbol, '15m').then((c) => { cache['15m'] = c }),
  ])
}

// Throttle live candle refetches per symbol|tf so frontend chart polling can't
// hammer Gemini. 10s is short enough that the in-progress (live) candle still
// updates in near real-time, but coalesces rapid polls.
const candleRefreshThrottle = new Map<string, number>()
const CANDLE_REFRESH_MIN_MS = 10_000

/** Refetch a single symbol+tf from Gemini on demand, updating the cache in place.
 *  Throttled per symbol|tf; returns the freshest candles available (falls back to
 *  the existing cache on throttle or fetch error). This is what keeps an actively
 *  viewed chart live even though the symbol was seeded long ago. */
async function refreshCandle(symbol: string, tf: Timeframe): Promise<Candle[]> {
  const sym = symbol.toUpperCase()
  const cache = getCache(sym)
  const key = `${sym}|${tf}`
  const now = Date.now()
  if (now - (candleRefreshThrottle.get(key) ?? 0) < CANDLE_REFRESH_MIN_MS) return cache[tf]
  candleRefreshThrottle.set(key, now)
  try {
    const fresh = await fetchCandlesFromGemini(sym, tf)
    if (fresh.length) {
      cache[tf] = fresh
      if (tf === '1hr') cache['4hr'] = aggregateTo4h(fresh) // keep the derived tier in lockstep
    }
  } catch { /* keep last good cache */ }
  return cache[tf]
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Gemini's /v2/candles 1day feed omits the current (in-progress) UTC day — its
 *  newest bar is always yesterday's completed candle. Synthesize today's forming
 *  candle from the hourly candles so the daily chart's rightmost bar tracks live
 *  price instead of showing a 1-day-stale close. */
function appendFormingDaily(daily: Candle[], hourly: Candle[]): Candle[] {
  if (!hourly.length) return daily
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS // epoch is UTC-aligned → 00:00 UTC
  const newestDailyTs = daily.length ? daily[daily.length - 1]![0] : 0
  if (newestDailyTs >= todayStart) return daily // Gemini already published today's candle
  const todays = hourly.filter((c) => c[0] >= todayStart)
  if (!todays.length) return daily
  const forming: Candle = [
    todayStart,
    todays[0]![1],                              // open: first hour's open
    Math.max(...todays.map((c) => c[2])),       // high
    Math.min(...todays.map((c) => c[3])),       // low
    todays[todays.length - 1]![4],              // close: latest hour's close (live)
    todays.reduce((s, c) => s + c[5], 0),       // volume
  ]
  return [...daily, forming]
}

// ── Persistence ────────────────────────────────────────────────────────

function loadTrades(): TradeRecord[] {
  try {
    return stateStore.readJson<TradeRecord[]>(TRADES_FILE, [])
  } catch { /* ignore */ }
  return []
}

function saveTrades(trades: TradeRecord[]): void {
  ensureDir()
  stateStore.writeJson(TRADES_FILE, trades)
}

function loadPending(): PendingTrade[] {
  try {
    return stateStore.readJson<PendingTrade[]>(PENDING_FILE, [])
  } catch { /* ignore */ }
  return []
}

function savePending(pending: PendingTrade[]): void {
  ensureDir()
  stateStore.writeJson(PENDING_FILE, pending)
}

function loadPlanReport(): { report: string; at: number | null } {
  try {
    return stateStore.readJson<{ report: string; at: number | null }>(PLAN_REPORT_FILE, { report: '', at: null })
  } catch { /* ignore */ }
  return { report: '', at: null }
}

function savePlanReport(report: string, at: number): void {
  ensureDir()
  stateStore.writeJson(PLAN_REPORT_FILE, { report, at })
}

/** Classify a posted report by its markdown header. Returns the kind + display title for
 *  a full analysis report (strategy / fast-cash / candle — each posted once per run and
 *  worth archiving forever), or null for the frequent (~30s) order-status STATUS pings
 *  that reuse the same endpoint (archiving those would flood disk with near-duplicates). */
function classifyReport(report: string): { kind: PlanReportEntry['kind']; title: string } | null {
  if (report.includes('## STRATEGY REPORT')) return { kind: 'strategy', title: 'STRATEGY REPORT' }
  if (/##[^\n]*FAST-CASH REPORT/.test(report)) return { kind: 'fast-cash', title: 'FAST-CASH REPORT' }
  if (/##[^\n]*OVERSOLD REPORT/.test(report)) return { kind: 'oversold', title: 'OVERSOLD REPORT' }
  if (/##[^\n]*CANDLE[^\n]*REPORT/.test(report)) return { kind: 'candle', title: 'CANDLE REPORT' }
  if (/##[^\n]*FIRECRACKER[^\n]*REPORT/.test(report)) return { kind: 'firecracker', title: 'FIRECRACKER REPORT' }
  if (/##[^\n]*SNIPER[^\n]*REPORT/.test(report)) return { kind: 'sniper', title: 'SNIPER REPORT' }
  // btc-ladder posts "## BTC LADDER REPORT — <date>". Without this case it fell through to
  // the null return below, which means "this is a 30s STATUS ping, don't archive it" — so
  // every ladder report was silently discarded and never reached the reports section.
  if (/##[^\n]*BTC LADDER[^\n]*REPORT/.test(report)) return { kind: 'btc-ladder', title: 'BTC LADDER REPORT' }
  // trapline + reaper post their own reports and hit the same silent-discard trap the
  // ladder did above: unclassified → null → treated as a STATUS ping and thrown away.
  if (/##[^\n]*TRAPLINE[^\n]*REPORT/.test(report)) return { kind: 'trapline', title: 'TRAPLINE REPORT' }
  if (/##[^\n]*REAPER[^\n]*REPORT/.test(report)) return { kind: 'reaper', title: 'REAPER REPORT' }
  return null
}

/** How many archived reports to keep on disk. Interval-driven strategies can post
 *  one every few minutes; without a cap the directory grows forever AND every
 *  listArchivedPlanReports() call re-reads and re-parses all of it, synchronously,
 *  on the setPlanReport hot path. 500 is comfortably more than the UI's last-10
 *  view or a skill reaching back over past runs ever asks for. */
const PLAN_REPORTS_KEEP = 500

function archivePlanReport(report: string, at: number, kind: PlanReportEntry['kind'], title: string): void {
  if (!existsSync(PLAN_REPORTS_ARCHIVE_DIR)) mkdirSync(PLAN_REPORTS_ARCHIVE_DIR, { recursive: true })
  const file = join(PLAN_REPORTS_ARCHIVE_DIR, `report-${at}.json`)
  writeFileAtomic(file, JSON.stringify({ report, at, kind, title }, null, 2))
  prunePlanReportArchive()
}

/** Drops the oldest archived reports past PLAN_REPORTS_KEEP. Filenames carry the
 *  timestamp, so this sorts by name and never needs to open a file. */
function prunePlanReportArchive(): void {
  try {
    const files = readdirSync(PLAN_REPORTS_ARCHIVE_DIR)
      .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - PLAN_REPORTS_KEEP))) {
      try { rmSync(join(PLAN_REPORTS_ARCHIVE_DIR, f), { force: true }) } catch { /* next time */ }
    }
  } catch { /* archive dir unreadable — nothing to prune */ }
}

/** List every archived full report (newest first). Legacy files predate the kind/title
 *  fields, so re-derive them via classifyReport (older files are all strategy runs). */
function listArchivedPlanReports(): PlanReportEntry[] {
  if (!existsSync(PLAN_REPORTS_ARCHIVE_DIR)) return []
  const files = readdirSync(PLAN_REPORTS_ARCHIVE_DIR).filter((f) => f.endsWith('.json'))
  const entries = files.map((f) => {
    try {
      const e = JSON.parse(readFileSync(join(PLAN_REPORTS_ARCHIVE_DIR, f), 'utf8')) as Partial<PlanReportEntry>
      if (typeof e.report !== 'string' || typeof e.at !== 'number') return null
      const cls = classifyReport(e.report) ?? { kind: 'strategy' as const, title: 'STRATEGY REPORT' }
      return { report: e.report, at: e.at, kind: e.kind ?? cls.kind, title: e.title ?? cls.title }
    } catch {
      return null
    }
  }).filter((e): e is PlanReportEntry => e !== null)
  return entries.sort((a, b) => b.at - a.at)
}

// ── Active bracket persistence (restart-resume) ─────────────────────────
// Every in-flight managed bracket is mirrored to disk, keyed by plan id (symbol), so a
// server restart (or crash) can re-attach ALL of their monitor loops and reconcile
// against Gemini instead of orphaning resting stop/take-profit orders. Multiple brackets
// for different symbols persist side by side in this one file.
function saveActiveBrackets(brackets: Record<string, AutoStep>): void {
  ensureDir()
  try {
    if (Object.keys(brackets).length) stateStore.writeJson(ACTIVE_BRACKET_FILE, brackets)
    else stateStore.deleteJson(ACTIVE_BRACKET_FILE)
  } catch (e) { console.warn('[crypto] active-bracket persist failed:', (e as Error).message) }
}

function loadActiveBrackets(): Record<string, AutoStep> {
  try {
    if (existsSync(ACTIVE_BRACKET_FILE)) {
      const raw = stateStore.readJson<unknown>(ACTIVE_BRACKET_FILE, undefined)
      // Migrate the old single-bracket format (a bare AutoStep, pre-multi-bracket engine)
      // into the new { [symbol]: AutoStep } map.
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'bracket' in raw) {
        const step = raw as AutoStep
        return step.symbol ? { [step.symbol]: step } : {}
      }
      return raw as Record<string, AutoStep>
    }
  } catch { /* ignore */ }
  return {}
}

// ── Closed-trade ledger (realized win/loss history) ─────────────────────
// A bracket's realized P&L used to be logged to the activity feed and then discarded
// when the bracket cleared. This appends a durable record per closed round-trip so
// per-strategy win rate is an actual tracked number. Append-only, newest last.
/** Temp-file + rename, so a crash mid-write can never leave a torn file. Used for
 *  the whole-file rewrites below: each one replaces the entire history, so a
 *  truncated write is not a lost update but a lost ledger. */
function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw e
  }
}

/**
 * Reads the realized-P&L ledger.
 *
 * A corrupt ledger is NOT treated as empty: appendClosedTrade rewrites the whole
 * file from whatever this returns, so answering `[]` to a parse failure would
 * replace the entire trade history with a single trade on the very next close.
 * Throwing instead makes the caller skip the rewrite and keep the bytes.
 */
function loadClosedTrades(): ClosedTrade[] {
  if (!existsSync(CLOSED_TRADES_FILE)) return []
  const raw = JSON.parse(readFileSync(CLOSED_TRADES_FILE, 'utf8'))
  if (!Array.isArray(raw)) throw new Error('closed-trades ledger is not an array')
  return raw as ClosedTrade[]
}

/** Same read, but for callers that only want to display the ledger and must not
 *  fail because of it. Never feeds a write path. */
function loadClosedTradesSafe(): ClosedTrade[] {
  try { return loadClosedTrades() } catch { return [] }
}

function appendClosedTrade(t: ClosedTrade): void {
  ensureDir()
  try {
    const all = loadClosedTrades()
    if (all.some((x) => x.id === t.id)) return  // idempotent: never double-record one bracket
    all.push(t)
    writeFileAtomic(CLOSED_TRADES_FILE, JSON.stringify(all, null, 2))
    // The table is the queryable copy; the file stays as the local replica. One
    // INSERT rather than the 3MB rewrite above, which is why this one is a real
    // table instead of a JSONB blob in app_state.
    void stateStore.saveClosedTrades([t as unknown as Record<string, unknown>])
  } catch (e) { console.warn('[crypto] closed-trade append failed:', (e as Error).message) }
}

/** Build a ClosedTrade from a finalized bracket step. Outcome is decided by fee-free
 *  realizedUsd (the account convention); a $0 realized close is 'flat' and excluded from
 *  the win/loss denominator. */
function buildClosedTrade(step: AutoStep, exitReason: string, closedAt: number): ClosedTrade {
  const st = step.bracketState
  const realizedUsd = Number((st?.realizedUsd ?? 0).toFixed(2))
  const feeUsd = Number((st?.feeUsd ?? 0).toFixed(4))
  const entryPrice = st?.entryPrice ?? null
  const amount = st?.filledAmount ?? 0
  const basis = entryPrice && amount ? entryPrice * amount : 0
  const outcome: ClosedTrade['outcome'] = realizedUsd > 0 ? 'win' : realizedUsd < 0 ? 'loss' : 'flat'
  return {
    id: step.id,
    source: 'real',
    strategy: step.strategy ?? 'unattributed',
    symbol: step.symbol,
    label: step.label,
    side: step.side,
    entryPrice,
    exitReason,
    amount,
    realizedUsd,
    feeUsd,
    returnPct: basis > 0 ? Number((realizedUsd / basis * 100).toFixed(2)) : null,
    outcome,
    entryAt: st?.filledAt ?? null,
    closedAt,
  }
}

function emptyBucket(): ClosedTradeBucket {
  return { trades: 0, wins: 0, losses: 0, flat: 0, winRate: null, netRealizedUsd: 0, feesUsd: 0 }
}
function tallyInto(b: ClosedTradeBucket, t: ClosedTrade): void {
  b.trades++
  if (t.outcome === 'win') b.wins++
  else if (t.outcome === 'loss') b.losses++
  else b.flat++
  b.netRealizedUsd = Number((b.netRealizedUsd + t.realizedUsd).toFixed(2))
  b.feesUsd = Number((b.feesUsd + t.feeUsd).toFixed(4))
  const decided = b.wins + b.losses
  b.winRate = decided > 0 ? Number((b.wins / decided * 100).toFixed(1)) : null
}

function computeClosedTradeStats(trades: ClosedTrade[]): ClosedTradeStats {
  const overall = emptyBucket()
  const byStrategy: Record<string, ClosedTradeBucket> = {}
  for (const t of trades) {
    tallyInto(overall, t)
    ;(byStrategy[t.strategy] ??= emptyBucket())
    tallyInto(byStrategy[t.strategy], t)
  }
  return { overall, byStrategy }
}

/** Split the ledger into real vs paper win-rate summaries (+ a combined view) so the two
 *  are never blended in a single unlabelled number. */
function computeClosedTradeReport(trades: ClosedTrade[]): ClosedTradeReport {
  return {
    real: computeClosedTradeStats(trades.filter((t) => t.source === 'real')),
    paper: computeClosedTradeStats(trades.filter((t) => t.source === 'paper')),
    all: computeClosedTradeStats(trades),
  }
}

// ── Active (non-bracket) plan persistence (restart-resume) ──────────────
// Plain limit-order plans — the BTC accumulation ladder (LADDER-SELL / REBUY / DIP-BUY)
// and any other sequential autoplan — live only in AutoPlanner's in-memory map. Without
// this, a restart silently drops them: a staged proposal vanishes, and an executing plan's
// resting Gemini order is orphaned. We mirror every staged/in-flight non-bracket plan to
// disk keyed by plan id (symbol) and reconcile on boot, mirroring the bracket resume path.
// Managed brackets persist separately in active-bracket.json and are excluded here.
function saveActivePlans(plans: Record<string, AutoPlanStatus>): void {
  ensureDir()
  try {
    if (Object.keys(plans).length) stateStore.writeJson(ACTIVE_PLANS_FILE, plans)
    else stateStore.deleteJson(ACTIVE_PLANS_FILE)
  } catch (e) { console.warn('[crypto] active-plans persist failed:', (e as Error).message) }
}

function loadActivePlans(): Record<string, AutoPlanStatus> {
  try {
    return stateStore.readJson<Record<string, AutoPlanStatus>>(ACTIVE_PLANS_FILE, {})
  } catch { /* ignore */ }
  return {}
}

// ── BTC ladder cycle tracking (invariant: every sell has a lower buy-back) ─────
// Persisted immediately at sell-fill time so a process death BEFORE the rebuy is placed
// still leaves an on-disk 'open' cycle — which the reconciler catches on the next refresh
// and auto-stages the buy-back for. This is the durable record the verifier checks against.
function loadBtcCycles(): BtcLadderCycle[] {
  try {
    return stateStore.readJson<BtcLadderCycle[]>(BTC_CYCLES_FILE, [])
  } catch { /* ignore */ }
  return []
}

function saveBtcCycles(cycles: BtcLadderCycle[]): void {
  ensureDir()
  try { stateStore.writeJson(BTC_CYCLES_FILE, cycles) }
  catch (e) { console.warn('[crypto] btc-ladder-cycles persist failed:', (e as Error).message) }
}

/** Record a BTC sell slice as an OPEN (unhedged) ladder cycle. `rebuyPrice` comes from the
 *  paired buy-back step when the plan has one; null means "derive a level in the reconciler."
 *  Idempotent-ish: a sell already logged (same order id or same time+size) is not duplicated. */
function openBtcLadderCycle(input: { soldAt: number; soldBtc: number; soldUsd: number; soldPrice: number; rebuyPrice: number | null; note?: string; dedupeKey?: string; kind?: 'roundtrip' | 'scaleout' }): BtcLadderCycle {
  const cycles = loadBtcCycles()
  const dupe = cycles.find((c) =>
    c.status !== 'closed' &&
    Math.abs(c.soldAt - input.soldAt) < 5_000 &&
    Math.abs(c.soldBtc - input.soldBtc) < 1e-9,
  )
  if (dupe) return dupe
  const kind = input.kind ?? 'roundtrip'
  const cycle: BtcLadderCycle = {
    id: `cyc_${input.soldAt}_${Math.round(input.soldBtc * 1e8)}`,
    soldAt: input.soldAt, soldBtc: input.soldBtc, soldUsd: input.soldUsd, soldPrice: input.soldPrice,
    rebuyPrice: input.rebuyPrice, rebuyOrderId: null, status: 'open', note: input.note, kind,
  }
  cycles.push(cycle)
  saveBtcCycles(cycles)
  if (kind === 'scaleout') {
    console.log('[crypto] 🟦 BTC ladder SCALE-OUT recorded (naked sell → USD dry powder, no rebuy demanded):', cycle.id, `${input.soldBtc} BTC @ $${input.soldPrice}`)
  } else {
    console.log('[crypto] 🔴 BTC ladder cycle OPENED (unhedged):', cycle.id, `${input.soldBtc} BTC @ $${input.soldPrice}`)
  }
  return cycle
}

/** Attach a just-placed BTC buy-back order to the cycle it was staged for.
 *  Prefers a 'staged' cycle over a bare 'open' one: the staging loop in reconcileBtcLadder
 *  only ever has ONE BTCUSD plan in flight (the `hasBtcPlan` gate), so the staged cycle IS
 *  the one this order was placed for. Falling back to oldest-open is only for a rebuy placed
 *  outside that path. The link written here is what makes the later close unambiguous —
 *  without it, closing degrades to guessing by age. */
function linkBtcRebuyOrder(orderId: string): void {
  const cycles = loadBtcCycles()
  const byAge = (a: BtcLadderCycle, b: BtcLadderCycle) => a.soldAt - b.soldAt
  const target = cycles.filter((c) => c.status === 'staged').sort(byAge)[0]
    ?? cycles.filter((c) => c.status === 'open').sort(byAge)[0]
  if (!target) return
  target.rebuyOrderId = orderId
  target.status = 'resting'
  saveBtcCycles(cycles)
  console.log('[crypto] 🟢 BTC buy-back linked to cycle', target.id, '→ resting order', orderId)
}

/** Close the ladder cycle whose buy-back order actually filled, identified by ORDER ID.
 *
 *  This used to close "the oldest resting cycle" regardless of which order filled. With 2-3
 *  cycles resting concurrently (normal — the cap is 30% of the stack) any out-of-order fill
 *  cross-attributed the rebuy, which is how the 2026-07 ledger ended up with two cycles
 *  claiming order 73771287194161756 and a 07-03 cycle marked closed against a buy that had
 *  never happened. Matching on the linked order id is exact; if a cycle has no link we now
 *  DECLINE to close anything rather than corrupt a good cycle with a guess — the trade-history
 *  reconciler (findBtcRebuyFill) resolves those with more evidence on the next pass. */
function closeBtcLadderCycle(boughtBtc: number, at: number, orderId?: string): void {
  const cycles = loadBtcCycles()
  const resting = cycles.filter((c) => c.status === 'resting')
  const target = orderId ? resting.find((c) => c.rebuyOrderId === orderId) : undefined
  if (!target) {
    console.warn(
      '[crypto] ⚠ BTC buy-back filled but no resting cycle claims order', orderId ?? '(none supplied)',
      `— leaving all ${resting.length} resting cycle(s) untouched; the trade-history reconciler will pair it.`,
    )
    return
  }
  target.status = 'closed'
  target.boughtBtc = boughtBtc
  target.closedAt = at
  saveBtcCycles(cycles)
  const delta = boughtBtc - target.soldBtc
  console.log('[crypto] ✅ BTC ladder cycle CLOSED', target.id, `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(8)} BTC`)
}

// ── Auto-execute config persistence ─────────────────────────────────────
const AUTO_EXECUTE_DEFAULT: AutoExecuteConfig = { enabled: false, btcLadderMaxUsd: 100, altMaxUsd: 100, perStrategy: {} }
function loadAutoExecute(): AutoExecuteConfig {
  try {
    if (existsSync(AUTO_EXECUTE_FILE)) {
      // `maxUsd` is the pre-split single-cap field — migrate it to both new caps.
      const raw = stateStore.readJson<Partial<AutoExecuteConfig> & { maxUsd?: number }>(AUTO_EXECUTE_FILE, {})
      const pos = (n: unknown, fallback: number) => (typeof n === 'number' && n > 0 ? n : fallback)
      const legacy = pos(raw.maxUsd, AUTO_EXECUTE_DEFAULT.btcLadderMaxUsd)
      // A config written before per-strategy toggles existed has no `perStrategy` key;
      // defaulting it to {} means every strategy reads as opted-in, preserving the exact
      // behaviour that config had when it was saved.
      const per = (raw.perStrategy && typeof raw.perStrategy === 'object') ? raw.perStrategy : {}
      return {
        enabled: !!raw.enabled,
        btcLadderMaxUsd: pos(raw.btcLadderMaxUsd, legacy),
        altMaxUsd: pos(raw.altMaxUsd, legacy),
        perStrategy: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, !!v])),
      }
    }
  } catch { /* ignore */ }
  return { ...AUTO_EXECUTE_DEFAULT }
}

function saveAutoExecute(cfg: AutoExecuteConfig): void {
  ensureDir()
  try { stateStore.writeJson(AUTO_EXECUTE_FILE, cfg) }
  catch (e) { console.warn('[crypto] auto-execute persist failed:', (e as Error).message) }
}

// ── Safe mode (software-side synthetic stop) arms, keyed by resting order id ──
function loadSafeMode(): SafeModeArm[] {
  try {
    if (existsSync(SAFE_MODE_FILE)) {
      const raw = stateStore.readJson<SafeModeArm[]>(SAFE_MODE_FILE, [])
      if (Array.isArray(raw)) return raw.filter((a) => a && typeof a.orderId === 'string' && a.triggerPrice > 0)
    }
  } catch { /* ignore */ }
  return []
}
function saveSafeMode(arms: SafeModeArm[]): void {
  ensureDir()
  try { stateStore.writeJson(SAFE_MODE_FILE, arms) }
  catch (e) { console.warn('[crypto] safe-mode persist failed:', (e as Error).message) }
}

// Orders the user has explicitly disarmed — kept so default-on auto-arm doesn't re-arm them.
function loadSafeModeOptOut(): string[] {
  try {
    if (existsSync(SAFE_MODE_OPTOUT_FILE)) {
      const raw = stateStore.readJson<unknown>(SAFE_MODE_OPTOUT_FILE, [])
      if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
    }
  } catch { /* ignore */ }
  return []
}
function saveSafeModeOptOut(ids: string[]): void {
  ensureDir()
  try { stateStore.writeJson(SAFE_MODE_OPTOUT_FILE, ids) }
  catch (e) { console.warn('[crypto] safe-mode opt-out persist failed:', (e as Error).message) }
}

// ── Loop mode: auto-run the strategy shortly after a position closes ──
function loadLoopMode(): boolean {
  try {
    if (existsSync(LOOP_MODE_FILE)) {
      const raw = stateStore.readJson<{ enabled?: unknown }>(LOOP_MODE_FILE, {})
      return !!raw.enabled
    }
  } catch { /* ignore */ }
  return false
}
function saveLoopMode(enabled: boolean): void {
  ensureDir()
  try { stateStore.writeJson(LOOP_MODE_FILE, { enabled }) }
  catch (e) { console.warn('[crypto] loop-mode persist failed:', (e as Error).message) }
}
// How long after a close to fire, and the min gap since the last run to allow it.
const LOOP_FIRE_DELAY_MS = 10_000
const LOOP_MIN_GAP_MS = 10 * 60 * 1000

// ── Interval timer: auto-run the enabled strategy every N minutes (0 = off) ──
const STRATEGY_INTERVAL_FILE = join(DATA_DIR, 'strategy-interval.json')
const INTERVAL_MIN_MINUTES = 1
const INTERVAL_MAX_MINUTES = 1440
function loadStrategyInterval(): number {
  try {
    if (existsSync(STRATEGY_INTERVAL_FILE)) {
      const raw = stateStore.readJson<{ minutes?: unknown }>(STRATEGY_INTERVAL_FILE, {})
      const n = Number(raw.minutes)
      if (Number.isFinite(n) && n > 0) return Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(n)))
    }
  } catch { /* ignore */ }
  return 0
}
function saveStrategyInterval(minutes: number): void {
  ensureDir()
  try { stateStore.writeJson(STRATEGY_INTERVAL_FILE, { minutes }) }
  catch (e) { console.warn('[crypto] strategy-interval persist failed:', (e as Error).message) }
}

// ── Per-strategy interval timers — each strategy can carry its own auto-run cadence
// instead of sharing the single "enabled strategy" timer above. As soon as any
// strategy has its own interval set, the universal timer goes inert (see
// armIntervalTimer's early-return) rather than double-firing the same strategy. ──
const STRATEGY_INTERVALS_FILE = join(DATA_DIR, 'strategy-intervals.json')
function loadStrategyIntervals(): Record<string, number> {
  try {
    if (existsSync(STRATEGY_INTERVALS_FILE)) {
      const raw = stateStore.readJson<Record<string, unknown>>(STRATEGY_INTERVALS_FILE, {})
      const out: Record<string, number> = {}
      for (const [id, v] of Object.entries(raw)) {
        const n = Number(v)
        if (Number.isFinite(n) && n > 0) out[id] = Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(n)))
      }
      return out
    }
  } catch { /* ignore */ }
  return {}
}
function saveStrategyIntervals(intervals: Record<string, number>): void {
  ensureDir()
  try { stateStore.writeJson(STRATEGY_INTERVALS_FILE, intervals) }
  catch (e) { console.warn('[crypto] strategy-intervals persist failed:', (e as Error).message) }
}

// ── Portfolio growth baseline (BTC & USD held, % change since a start point) ──
// `btcPrice` is the BTC/USD rate captured with the baseline so the total can be expressed in
// BTC terms later; 0 marks "unknown" (legacy baselines) and disables the baseline BTC change.
interface PortfolioBaseline { btc: number; usd: number; totalUsd: number; btcPrice: number; at: number }
function loadPortfolioBaseline(): PortfolioBaseline | null {
  try {
    if (existsSync(PORTFOLIO_BASELINE_FILE)) {
      const raw = stateStore.readJson<Partial<PortfolioBaseline>>(PORTFOLIO_BASELINE_FILE, {})
      if (typeof raw.btc === 'number' && typeof raw.usd === 'number' && typeof raw.at === 'number') {
        // totalUsd was added after the btc/usd fields — older baseline files won't have it;
        // 0 marks "no basis" so pctChange comes back null until the baseline is reset.
        return {
          btc: raw.btc, usd: raw.usd,
          totalUsd: typeof raw.totalUsd === 'number' ? raw.totalUsd : 0,
          btcPrice: typeof raw.btcPrice === 'number' ? raw.btcPrice : 0,
          at: raw.at,
        }
      }
    }
  } catch { /* ignore */ }
  return null
}
function savePortfolioBaseline(b: PortfolioBaseline): void {
  ensureDir()
  try { stateStore.writeJson(PORTFOLIO_BASELINE_FILE, b) }
  catch (e) { console.warn('[crypto] portfolio-baseline persist failed:', (e as Error).message) }
}

// ── Portfolio value history (rolling samples for 24h/7d/30d change windows) ──
// A lightweight append-only series of total-account-value samples. Sampled at most once per
// SAMPLE_INTERVAL_MS (individual buys/sells barely move the total, so coarse sampling is fine
// and keeps the file tiny) and pruned to HISTORY_RETENTION_MS so it can't grow without bound.
const PORTFOLIO_HISTORY_FILE = join(DATA_DIR, 'portfolio-history.json')
const HISTORY_SAMPLE_INTERVAL_MS = 15 * 60_000        // ≥15 min between recorded samples
const HISTORY_RETENTION_MS = 400 * 24 * 60 * 60_000   // keep ~13 months (covers YTD + 30d)
interface ValueSample { at: number; btc: number; usd: number; totalUsd: number; btcPrice: number }
function loadPortfolioHistory(): ValueSample[] {
  try {
    if (existsSync(PORTFOLIO_HISTORY_FILE)) {
      const raw = JSON.parse(readFileSync(PORTFOLIO_HISTORY_FILE, 'utf8')) as unknown
      if (Array.isArray(raw)) return raw.filter((s): s is ValueSample =>
        s && typeof s.at === 'number' && typeof s.totalUsd === 'number' && typeof s.btcPrice === 'number')
    }
  } catch { /* ignore */ }
  return []
}
function savePortfolioHistory(series: ValueSample[]): void {
  ensureDir()
  void stateStore.savePortfolioHistory(series)
  // Atomic: this rewrites the entire series, so a torn write loses the history.
  try { writeFileAtomic(PORTFOLIO_HISTORY_FILE, JSON.stringify(series)) }
  catch (e) { console.warn('[crypto] portfolio-history persist failed:', (e as Error).message) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Auto Planner ───────────────────────────────────────────────────────
// Executes a sequential BTC-accumulation trade plan automatically.
// Each step waits for the previous to fill before proceeding.
// Market orders settle in ~3s; limit orders are polled every 30s.

const LIMIT_TIMEOUT_MS = 8 * 60 * 60 * 1000 // 8 hours before a limit falls back to market

// NOTE: the old hardcoded `makeBtcAccumPlan()` demo (Sell CHILLGUY → Buy JTO → …)
// was REMOVED — it was a footgun that placed real orders when start() was called with
// no steps. The engine now only ever executes trades a human explicitly approved in the
// Homunculus app: the skill /proposes, the user reviews + approves each trade, then confirms.

/** Per-symbol control-flow state that used to be single global fields on AutoPlanner
 *  (`aborted`/`haltAfterStep`/`runId`). Each plan (keyed by its primary symbol) gets its
 *  own, so a symbol's stale coroutine check never interferes with a different symbol's
 *  in-flight plan — this is what lets multiple brackets run truly concurrently. */
interface PlanEntry {
  status: AutoPlanStatus
  aborted: boolean
  haltAfterStep: boolean
  runId: number
}

class AutoPlanner {
  private plans = new Map<string, PlanEntry>()
  private persistedBrackets: Record<string, AutoStep> = {}
  private listeners = new Set<() => void>()
  private autoExec: AutoExecuteConfig = loadAutoExecute()
  private autoHeld = new Set<string>()   // plan ids already logged as over-cap (avoid spam)
  private autoEvalRunning = false          // reentrancy guard (confirm → notify → onChange → eval)

  /** The primary symbol a batch of steps trades — this is the plan's id / map key.
   *  Propose one call per symbol to run independent tracks concurrently; two calls for
   *  the SAME symbol still serialize (they'd fight over the same balance anyway). */
  private keyOf(steps: AutoStep[]): string {
    return steps[0]?.symbol ?? '_unknown'
  }

  private emptyStatus(id: string): AutoPlanStatus {
    return { id, active: false, isProposed: false, proposedAt: null, proposedLabel: '', startedAt: null, currentStepIndex: 0, steps: [], log: [] }
  }

  private entry(id: string): PlanEntry {
    let e = this.plans.get(id)
    if (!e) {
      e = { status: this.emptyStatus(id), aborted: false, haltAfterStep: false, runId: 0 }
      this.plans.set(id, e)
    }
    return e
  }

  /** Resolve an id-less call to a single plan, restricted to entries matching `filter`.
   *  Returns the id only when exactly one candidate qualifies — ambiguous (0 or 2+)
   *  callers must pass an explicit symbol instead of guessing. */
  private resolveImplicit(filter: (e: PlanEntry) => boolean): string | undefined {
    const candidates = [...this.plans.entries()].filter(([, e]) => filter(e))
    return candidates.length === 1 ? candidates[0]![0] : undefined
  }

  /** Get one plan's status by symbol; with no id, resolves only if exactly one plan
   *  exists total (kept for simple single-plan callers/back-compat). */
  getStatus(id?: string): AutoPlanStatus {
    if (id) return this.plans.get(id)?.status ?? this.emptyStatus(id)
    const onlyId = this.resolveImplicit(() => true)
    return onlyId ? this.plans.get(onlyId)!.status : this.emptyStatus('')
  }

  /** Every plan currently tracked (proposed, active, or just-finished) — one entry per
   *  symbol. This is what the snapshot/UI renders: one card per symbol, independently. */
  getAllStatuses(): AutoPlanStatus[] {
    return [...this.plans.values()].map((e) => e.status)
  }

  /** USD exposure per strategy per symbol, counting only steps that strategy opened.
   *
   *  Strategies cap themselves per-coin (firecracker $20, sniper $20 + a $100 bankroll). Those
   *  caps used to be computed from the raw portfolio holding — "the coin's entire current
   *  holding, whatever opened it" — which conflates tracks: any coin another strategy already
   *  holds looks maxed out. Counting own-tagged exposure keeps each track's budget its own.
   *
   *  Counts a resting (unfilled) entry at its full notional — a bid on the book is committed
   *  capital for cap purposes — plus any filled position still held, marked to current price.
   *  Steps with no `strategy` land in 'unattributed': visible, but nobody's cap. */
  exposureByStrategy(priceOf: (symbol: string) => number | null): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {}
    const add = (strategy: string, symbol: string, usd: number) => {
      if (!(usd > 0)) return
      const bucket = out[strategy] ?? (out[strategy] = {})
      bucket[symbol] = (bucket[symbol] ?? 0) + usd
    }
    for (const entry of this.plans.values()) {
      for (const step of entry.status.steps) {
        if (step.status === 'failed' || step.status === 'skipped') continue
        const strategy = step.strategy || 'unattributed'
        const symbol = (step.symbol || '').toUpperCase()
        if (!symbol) continue
        const price = priceOf(symbol)
        const bs = step.bracketState
        if (bs) {
          if (bs.positionAmount && price) add(strategy, symbol, bs.positionAmount * price)
          // A resting entry that hasn't filled yet still ties up the budget.
          else if (bs.phase === 'entering') add(strategy, symbol, this.notionalOf(step, price))
        } else if (step.status === 'pending' || step.status === 'executing' || step.status === 'monitoring') {
          if (step.side === 'buy') add(strategy, symbol, this.notionalOf(step, price))
        }
      }
    }
    return out
  }

  /** Best-effort USD notional of a step from its amountSpec — "USD:20" is exact; a base-unit
   *  amount needs a price. Returns 0 when it can't be determined rather than guessing, so an
   *  unpriceable step never inflates a cap into blocking a legitimate trade.
   *
   *  Staged bracket entry legs count too: this feeds per-strategy exposure, and a
   *  bracket's committed capital is its primary entry plus every resting leg. */
  private notionalOf(step: AutoStep, price: number | null): number {
    const one = (raw: string): number => {
      const usdMatch = /^USD:([0-9.]+)$/i.exec(raw)
      if (usdMatch) return Number(usdMatch[1]) || 0
      const amount = Number(raw)
      if (Number.isFinite(amount) && amount > 0 && price) return amount * price
      return 0
    }
    let total = one(String(step.amountSpec || ''))
    for (const leg of step.bracket?.entry?.legs ?? []) total += one(String(leg.amountSpec || ''))
    return total
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    this.persistPlans()
    for (const cb of this.listeners) cb()
  }

  /** Mirror every staged/in-flight NON-bracket plan to disk so a restart can restore
   *  proposals and re-attach executing plans (reconciling resting Gemini orders). Managed
   *  brackets are excluded — they persist separately via persistBracket/active-bracket.json.
   *  Completed/idle plans (neither proposed nor active) are dropped so they don't resurrect. */
  private persistPlans(): void {
    const out: Record<string, AutoPlanStatus> = {}
    for (const [id, e] of this.plans) {
      const st = e.status
      const isBracket = st.steps.length === 1 && st.steps[0]?.kind === 'bracket'
      // An ACTIVE bracket resumes from active-bracket.json (its execution state), so skip it
      // here. A PROPOSED bracket has no execution to resume and lives only in memory — it MUST
      // be mirrored here or a server restart silently wipes the staged proposal. Idle/completed
      // plans are dropped either way so they don't resurrect.
      if (isBracket && st.active) continue
      if (st.isProposed || st.active) out[id] = st
    }
    saveActivePlans(out)
  }

  private log(e: PlanEntry, msg: string): void {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`
    e.status.log.push(line)
    if (e.status.log.length > 200) e.status.log.shift()
    console.log('[autoplan]', `[${e.status.id}]`, msg)
    this.notify()
  }

  /** Stage steps for review — does NOT execute. User must call confirmProposal() to start.
   *  Returns false (leaving that symbol's current plan untouched) only if a plan for the
   *  SAME symbol is already running. Plans for different symbols never block each other —
   *  propose one call per symbol to run them concurrently. */
  propose(steps: AutoStep[], label: string): boolean {
    const id = this.keyOf(steps)
    const e = this.entry(id)
    if (e.status.active) { this.log(e, 'Cannot propose while a plan is running for this symbol — stop it first'); return false }
    // BTCUSD reservation: an unhedged ladder slice owns the BTCUSD plan slot until it's hedged.
    // Plans are keyed by symbol, so a foreign plan taking that slot would leave the ladder
    // unable to stage its buy-back — the "every BTC sell has a lower buy" invariant broken with
    // real BTC exposure and no automated way out. The ladder always wins this race.
    if (steps.some((s) => s.symbol?.toUpperCase() === 'BTCUSD' && !this.isLadderOwned(s))) {
      // Only 'open' and 'staged' reserve the slot — those are the states where the ladder still
      // needs to place a buy-back. A 'resting' cycle already has its hedge on the book, so it
      // doesn't need the slot, and reserving on it would keep BTC fenced off from other
      // strategies almost permanently (a cycle usually is resting). If a resting order later
      // vanishes unfilled the cycle reopens and the reconciler now says so loudly in its alert.
      // Scale-out cycles hold USD and demand no buy-back, so they must NOT reserve the slot —
      // otherwise banked dry powder would fence BTCUSD off from every other strategy indefinitely.
      const needsSlot = loadBtcCycles().filter((c) => (c.status === 'open' || c.status === 'staged') && c.kind !== 'scaleout')
      if (needsSlot.length) {
        this.log(e, `Cannot propose a non-ladder BTCUSD plan: ${needsSlot.length} ladder cycle(s) still unhedged — `
          + 'BTCUSD is reserved for the ladder until every sold slice has its buy-back.')
        return false
      }
    }
    // Each trade defaults to approved; the user can DENY individual trades in the app
    // before confirming. Denied trades are never sent to the exchange.
    const reviewed = steps.map((s) => ({ ...s, approved: s.approved ?? true }))
    e.status = {
      id,
      active: false,
      isProposed: true,
      proposedAt: Date.now(),
      proposedLabel: label,
      startedAt: null,
      currentStepIndex: 0,
      steps: reviewed,
      log: [`[${new Date().toISOString().slice(11, 19)}] Trades proposed for review: ${label}`],
    }
    this.notify()
    return true
  }

  /** Edit a single step's prices, or approve/deny it, before confirming the proposal.
   *  Pass `symbol` to disambiguate when more than one plan is staged — legacy multi-step
   *  ids like "step_1" aren't guaranteed unique across different symbols' plans. */
  patchStep(stepId: string, patch: { limitPrice?: string; stopPrice?: string; amountSpec?: string; tp1Price?: string; approved?: boolean }, symbol?: string): boolean {
    const candidates = symbol ? (this.plans.has(symbol) ? [this.plans.get(symbol)!] : []) : [...this.plans.values()]
    for (const e of candidates) {
      const step = e.status.steps.find((s) => s.id === stepId)
      if (!step) continue
      if (e.status.active) return false
      if (patch.limitPrice !== undefined) step.limitPrice = patch.limitPrice
      if (patch.stopPrice !== undefined) step.stopPrice = patch.stopPrice
      if (patch.amountSpec !== undefined) step.amountSpec = patch.amountSpec
      // A bracket step carries its own copy of entry amount/price inside `bracket.entry`,
      // and the bracket engine executes off THAT copy (see runBracket). Mirror the edits
      // into it so a user-adjusted size/price actually takes effect instead of silently
      // reverting to the originally-proposed defaults.
      if (step.kind === 'bracket' && step.bracket) {
        if (patch.amountSpec !== undefined) step.bracket.entry.amountSpec = patch.amountSpec
        if (patch.limitPrice !== undefined) step.bracket.entry.limitPrice = patch.limitPrice
        // The exit target/stop are stored as pcts relative to the entry limit. Convert the
        // user's absolute prices back into pcts so the bracket engine honours the edit.
        const entryRef = Number(step.bracket.entry.limitPrice)
        if (patch.tp1Price !== undefined && entryRef > 0) {
          const tp = Number(patch.tp1Price)
          if (tp > 0) step.bracket.tp1 = { ...step.bracket.tp1, pricePct: tp / entryRef - 1 }
        }
        if (patch.stopPrice !== undefined && entryRef > 0) {
          const sp = Number(patch.stopPrice)
          if (sp > 0) step.bracket.stopPct = 1 - sp / entryRef
        }
      }
      if (patch.approved !== undefined) {
        step.approved = patch.approved
        this.log(e, `Trade ${patch.approved ? 'APPROVED' : 'DENIED'}: ${step.label}`)
      }
      this.notify()
      return true
    }
    return false
  }

  /** Toggle the user lock on a symbol's live managed bracket. While locked, monitorBracket
   *  will not scale out at TP1, exit at the final target, ratchet the trailing stop, or fire
   *  the position time-stop — the trade is frozen exactly as-is until unlocked. Works on any
   *  in-flight bracket regardless of phase (unlike liveBracketStep, which only allows
   *  protected/tp1_filled) so a user can lock a trade the moment it's placed. */
  lockBracket(symbol: string, locked: boolean): { ok: boolean; error?: string } {
    const e = this.plans.get(symbol)
    const step = e?.status.steps.find((s) => s.kind === 'bracket' && s.bracketState)
    if (!e || !step || !step.bracketState) return { ok: false, error: `${symbol} has no managed bracket` }
    step.bracketState.locked = locked
    this.log(e, `${locked ? '🔒 Locked' : '🔓 Unlocked'} ${symbol} — auto-management ${locked ? 'paused' : 'resumed'}`)
    this.persistBracket(e.status.id, step); this.notify()
    return { ok: true }
  }

  /** Locate the LIVE bracket step for a symbol that is holding a position (phase
   *  protected/tp1_filled) — the only state in which a discretionary stop/TP adjust
   *  makes sense. Returns null with a reason otherwise. */
  private liveBracketStep(symbol: string): { e: PlanEntry; step: AutoStep } | { error: string } {
    const e = this.plans.get(symbol)
    if (!e || !e.status.active) return { error: `No active plan for ${symbol}` }
    const step = e.status.steps.find((s) => s.kind === 'bracket' && s.bracket && s.bracketState)
    if (!step) return { error: `${symbol} has no managed bracket` }
    if (step.bracketState!.locked) return { error: `${symbol} bracket is locked — unlock it before adjusting stop/TP` }
    const ph = step.bracketState!.phase
    if (ph !== 'protected' && ph !== 'tp1_filled') {
      return { error: `${symbol} bracket is '${ph}', not holding a position — nothing to adjust` }
    }
    if (step.bracketState!.entryPrice == null) return { error: `${symbol} bracket has no fill price yet` }
    return { e, step }
  }

  /** Build a BracketAdjust from requested absolute levels, computing the widens-risk flag
   *  against the CURRENT live stop. Shared by both propose (confirm-first) and auto paths. */
  private buildAdjust(step: AutoStep, req: { stopPrice?: number; tp1Price?: number; tp2Price?: number; trailPct?: number; note?: string }): BracketAdjust {
    const cur = step.bracketState!.stopPrice
    // side is always 'buy' (long) today → a LOWER stop is further from price = more risk.
    const widensRisk = req.stopPrice != null && cur != null && req.stopPrice < cur
    return {
      stopPrice: req.stopPrice, tp1Price: req.tp1Price, tp2Price: req.tp2Price,
      trailPct: req.trailPct, widensRisk, note: req.note, proposedAt: Date.now(),
    }
  }

  /** Stage a discretionary stop/TP adjustment on a live bracket for later confirmation
   *  (confirm-first, the default). Does NOT touch the exchange yet — the existing
   *  protective stop stays live at its current level until confirmAdjust runs. */
  proposeBracketAdjust(symbol: string, req: { stopPrice?: number; tp1Price?: number; tp2Price?: number; trailPct?: number; note?: string }): { ok: boolean; error?: string; adjust?: BracketAdjust } {
    const found = this.liveBracketStep(symbol)
    if ('error' in found) return { ok: false, error: found.error }
    const adjust = this.buildAdjust(found.step, req)
    found.step.pendingAdjust = adjust
    this.log(found.e, `📐 Adjustment proposed for ${symbol}${adjust.widensRisk ? ' ⚠ WIDENS RISK' : ''}: ${this.describeAdjust(adjust)}${adjust.note ? ` — ${adjust.note}` : ''}`)
    this.persistBracket(found.e.status.id, found.step); this.notify()
    return { ok: true, adjust }
  }

  /** Confirm and apply the staged adjustment for a symbol's bracket. */
  async confirmBracketAdjust(symbol: string): Promise<{ ok: boolean; error?: string }> {
    const e = this.plans.get(symbol)
    const step = e?.status.steps.find((s) => s.kind === 'bracket' && s.pendingAdjust)
    if (!e || !step || !step.pendingAdjust) return { ok: false, error: `No pending adjustment for ${symbol}` }
    if (step.bracketState?.locked) return { ok: false, error: `${symbol} bracket is locked — unlock it before adjusting stop/TP` }
    const adjust = step.pendingAdjust
    await this.applyAdjust(e, step, adjust)
    step.pendingAdjust = null
    this.persistBracket(e.status.id, step); this.notify()
    return { ok: true }
  }

  /** Discard a staged (unconfirmed) adjustment without touching the exchange. */
  cancelBracketAdjust(symbol: string): { ok: boolean; error?: string } {
    const e = this.plans.get(symbol)
    const step = e?.status.steps.find((s) => s.kind === 'bracket' && s.pendingAdjust)
    if (!e || !step) return { ok: false, error: `No pending adjustment for ${symbol}` }
    step.pendingAdjust = null
    this.log(e, `📐 Adjustment proposal discarded for ${symbol}`)
    this.persistBracket(e.status.id, step); this.notify()
    return { ok: true }
  }

  /** Apply an adjustment immediately (auto mode) — validates the bracket is live+holding,
   *  then mutates TP levels / trail and reprices the resting stop in place. */
  async autoBracketAdjust(symbol: string, req: { stopPrice?: number; tp1Price?: number; tp2Price?: number; trailPct?: number; note?: string }): Promise<{ ok: boolean; error?: string; adjust?: BracketAdjust }> {
    const found = this.liveBracketStep(symbol)
    if ('error' in found) return { ok: false, error: found.error }
    const adjust = this.buildAdjust(found.step, req)
    await this.applyAdjust(found.e, found.step, adjust)
    this.persistBracket(found.e.status.id, found.step); this.notify()
    return { ok: true, adjust }
  }

  private describeAdjust(a: BracketAdjust): string {
    const parts: string[] = []
    if (a.stopPrice != null) parts.push(`stop→$${a.stopPrice}`)
    if (a.tp1Price != null) parts.push(`TP1→$${a.tp1Price}`)
    if (a.tp2Price != null) parts.push(`TP2→$${a.tp2Price}`)
    if (a.trailPct != null) parts.push(`trail→${(a.trailPct * 100).toFixed(1)}%`)
    return parts.join(', ') || '(no-op)'
  }

  /** Mutate the live bracket's spec (TP pcts / trail) and reprice the resting stop.
   *  TP absolute prices are converted to pricePct against the fill so the monitor loop's
   *  existing target math picks them up automatically on the next cycle. */
  private async applyAdjust(e: PlanEntry, step: AutoStep, a: BracketAdjust): Promise<void> {
    const spec = step.bracket!
    const st = step.bracketState!
    const entry = st.entryPrice!
    if (a.tp1Price != null) spec.tp1 = { ...spec.tp1, pricePct: a.tp1Price / entry - 1 }
    if (a.tp2Price != null) spec.tp2 = { pricePct: a.tp2Price / entry - 1 }
    if (a.trailPct != null) spec.trailPct = a.trailPct
    if (a.stopPrice != null) {
      st.stopPrice = a.stopPrice
      // Only reprice the resting stop when one is actually live on the book (position
      // protected, no TP resting-limit currently holding the balance). Otherwise just
      // record the new level — the monitor's self-heal will place it at st.stopPrice.
      if (st.phase === 'protected' && st.stopId && !st.tp1Id) {
        // Cancel failed ⇒ the old stop is still resting and still protecting the position.
        // Leave it; the monitor's trailing/self-heal path reprices to st.stopPrice next tick.
        if (await this.cancelStop(st)) {
          await this.placeStop(e, step, spec, a.stopPrice, st.positionAmount ?? st.filledAmount ?? 0)
        } else {
          this.log(e, `  ⚠ Stop reprice deferred — cancel of the resting stop failed; it stays live and the monitor retries`)
        }
      }
    }
    this.log(e, `  ✓ Adjustment applied to ${spec.symbol}: ${this.describeAdjust(a)}`)
  }

  /** Confirm a staged proposal and begin execution of the APPROVED trades only.
   *  Pass `symbol` to target a specific plan; omitted, it resolves only when exactly one
   *  plan is currently staged-for-review (ambiguous otherwise — pass symbol explicitly). */
  confirmProposal(symbol?: string): boolean {
    const id = symbol ?? this.resolveImplicit((e) => e.status.isProposed && !e.status.active)
    if (!id) { console.log('[autoplan] confirmProposal: no symbol given and proposal is ambiguous (0 or 2+ staged) — pass ?symbol='); return false }
    const e = this.entry(id)
    if (e.status.active) { this.log(e, 'Already running'); return false }
    if (!e.status.isProposed || !e.status.steps.length) { this.log(e, 'No proposal to confirm'); return false }
    // Mark denied trades as skipped so they never reach the exchange.
    let approvedCount = 0
    for (const s of e.status.steps) {
      if (s.approved === false) { s.status = 'skipped'; s.error = 'Denied by user' }
      else approvedCount++
    }
    if (approvedCount === 0) { this.log(e, 'All trades denied — nothing to execute'); this.notify(); return false }
    e.aborted = false
    e.runId++
    e.status = {
      ...e.status,
      active: true,
      isProposed: false,
      startedAt: Date.now(),
      currentStepIndex: 0,
      log: [...e.status.log, `[${new Date().toISOString().slice(11, 19)}] Confirmed — executing ${approvedCount} approved trade(s)`],
    }
    void this.run(id, e.runId)
    return true
  }

  start(steps?: AutoStep[]): boolean {
    // No hardcoded fallback plan — execution requires explicit, human-approved trades.
    if (!steps?.length) { console.log('[autoplan] No trades to start — propose and approve in the app first'); return false }
    const id = this.keyOf(steps)
    const e = this.entry(id)
    if (e.status.active) { this.log(e, 'Already running'); return false }
    e.aborted = false
    e.runId++
    e.status = {
      id, active: true, isProposed: false, proposedAt: null, proposedLabel: '',
      startedAt: Date.now(), currentStepIndex: 0, steps, log: [],
    }
    this.log(e, 'Recommended trades — executing')
    void this.run(id, e.runId)
    return true
  }

  /** Stop a specific plan (symbol) — or, with no arg, the only currently-active one.
   *  With more than one plan active, `symbol` is required; this never guesses which to kill. */
  stop(symbol?: string, force = false): boolean {
    const id = symbol ?? this.resolveImplicit((e) => e.status.active)
    if (!id) { console.log('[autoplan] stop: no symbol given and more than one (or zero) plan is active — pass ?symbol='); return false }
    const e = this.plans.get(id)
    if (!e) return true
    // Naked-sell guard (2026-07-21): a BTC ladder sell places its paired rebuy only AFTER the sell
    // fills (sequential). Aborting in that gap — filled sell, rebuy step still pending — orphans the
    // sell into a naked position, and re-proposing then double-sells. This is exactly the incident
    // the operator hit. Refuse unless forced; the fix is to adjust the resting rebuy in place, never reset.
    // (A rebuy already placed shows 'monitoring'/'filled', so resetting a hedged plan is still fine.)
    if (!force) {
      const steps = e.status.steps
      const filledSell = steps.some((s) => s.symbol === 'BTCUSD' && s.side === 'sell' && s.status === 'filled')
      const unplacedRebuy = steps.some((s) => s.symbol === 'BTCUSD' && s.side === 'buy' && (s.status === 'pending' || s.status === 'executing'))
      if (filledSell && unplacedRebuy) {
        this.log(e, '⛔ Refusing to stop/reset: a BTC ladder sell has FILLED but its rebuy is not yet placed — '
          + 'stopping now would orphan it into a NAKED sell. Wait for the rebuy to place, adjust it in place, or force.')
        this.notify()
        return false
      }
    }
    e.aborted = true
    e.status.active = false
    // Kill switch — cancel any live bracket orders and clear persisted state.
    const bracketStep = e.status.steps.find((s) => s.kind === 'bracket')
    if (bracketStep?.bracketState) {
      const st = bracketStep.bracketState
      void this.cancelBracketOrders(st).then(() => {
        st.phase = 'aborted'; st.note = 'Killed by user'
        this.clearPersistedBracket(id)
        this.log(e, '🧯 Kill switch — bracket orders cancelled')
        this.notify()
      })
    }
    this.log(e, 'Plan stopped by user')
    this.notify()
    return true
  }

  /** Clear a plan (symbol) entirely — or, with no arg, the only plan that exists.
   *  Returns false (and leaves the plan intact) when the naked-sell guard in stop() refuses. */
  reset(symbol?: string, force = false): boolean {
    const id = symbol ?? this.resolveImplicit(() => true)
    if (!id) { console.log('[autoplan] reset: no symbol given and 0 or 2+ plans exist — pass ?symbol='); return false }
    if (!this.stop(id, force)) return false
    this.plans.delete(id)
    this.notify()
    return true
  }

  private async run(id: string, myRunId: number): Promise<void> {
    const e = this.entry(id)
    const steps = e.status.steps
    e.haltAfterStep = false

    // Managed bracket plans are a single self-managing step (enter→protect→manage→exit).
    if (steps.length === 1 && steps[0]?.kind === 'bracket') {
      if (steps[0]!.approved === false) { this.log(e, 'Bracket denied — not executing'); e.status.active = false; this.notify(); return }
      await this.runBracket(e, steps[0]!, myRunId)
      if (e.runId === myRunId) { e.status.active = false; this.notify() }
      return
    }

    for (let i = 0; i < steps.length; i++) {
      if (e.aborted || e.runId !== myRunId) break
      e.status.currentStepIndex = i
      const step = steps[i]!
      // Skip trades the user denied during review.
      if (step.approved === false) { step.status = 'skipped'; this.log(e, `⊘ Skipped (denied): ${step.label}`); continue }
      // Resume-safe: a step that already completed in a prior (pre-restart) run is not
      // re-executed. 'monitoring' steps still have a resting order — executeStep re-attaches.
      if (step.status === 'filled' || step.status === 'skipped') { this.log(e, `↩ Already ${step.status}, skipping: ${step.label}`); continue }
      await this.executeStep(e, step, steps)
      // Cast escapes TS's stale control-flow narrowing — executeStep mutates step.status.
      if ((step.status as string) === 'filled') this.onStepFilled(step, steps)
      this.notify()

      if (step.status === 'failed') {
        this.log(e, `⛔ Plan halted at step ${i + 1} — ${step.error}`)
        e.status.active = false
        this.notify()
        return
      }

      // A timed-out entry leaves no position — abort the remaining bracket
      // (stop-loss / take-profit steps) so we don't place orphan orders.
      if (e.haltAfterStep) {
        for (let j = i + 1; j < steps.length; j++) {
          steps[j]!.status = 'skipped'
          steps[j]!.error = 'Skipped — entry timed out, no position to manage'
        }
        this.log(e, `⏹ Bracket aborted at step ${i + 1} — entry timed out, remaining steps skipped`)
        e.status.active = false
        this.notify()
        return
      }
    }

    if (!e.aborted) {
      e.status.active = false
      this.log(e, '✅ Recommended trades complete')
      this.notify()
    }
  }

  private async executeStep(e: PlanEntry, step: AutoStep, allSteps: AutoStep[]): Promise<void> {
    // Resume path: this step already had a live order resting on Gemini before a restart.
    // Do NOT place a second order — reconnect to the existing one and reconcile (waitForFill's
    // first poll detects a fill/cancel that happened while the server was down).
    if (step.status === 'monitoring' && step.geminiOrderId) {
      this.log(e, `♻ Re-attaching to resting order ${step.geminiOrderId}: ${step.label}`)
      await this.waitForFill(e, step)
      return
    }

    this.log(e, `▶ Step: ${step.label}`)
    step.status = 'executing'
    step.executedAt = Date.now()
    this.notify()

    try {
      // Resolve amount
      const amount = await this.resolveAmount(step, allSteps)
      if (!amount || Number(amount) <= 0) {
        step.status = 'skipped'
        this.log(e, `⏭ Skipped (zero balance): ${step.label}`)
        return
      }

      this.log(e, `  Amount: ${amount} ${step.symbol.replace('USD', '')}`)

      const orderId = await placeOrder(step.symbol, step.side, amount, step.limitPrice, step.stopPrice, step.orderOptions)
      step.geminiOrderId = orderId
      this.log(e, `  Order placed: ${orderId}`)
      // Reflect the new resting order in "Open on Exchange" right away.
      void cryptoHub.refreshOpenOrders()
      // If this is a BTC buy-back, attach it to its open ladder cycle so the verifier sees
      // the invariant satisfied (a resting buy below the sell price).
      if (this.isBtcRebuyStep(step, allSteps)) linkBtcRebuyOrder(orderId)

      if (step.type === 'limit' || step.type === 'stop-limit') {
        step.status = 'monitoring'
        this.notify()
        await this.waitForFill(e, step)
      } else {
        // Market order — allow a moment for settlement, then READ what actually
        // happened. The comment said "then confirm" but the code confirmed nothing:
        // it slept 5s and asserted a full fill at the requested amount. An IOC market
        // order can cancel unfilled or fill partially, and everything downstream
        // (ladder cycle bookkeeping, later steps sized off filledAmount) then built
        // on a quantity that never traded — a rebuy for BTC that was never sold.
        await sleep(5_000)
        let executed = 0
        let avgPrice: number | null = null
        try {
          const s = await fetchOrderStatus(orderId)
          executed = Number(s.executed_amount) || 0
          avgPrice = Number(s.avg_execution_price) || null
        } catch (err) {
          this.log(e, `  ⚠ Market order status read failed: ${(err as Error).message}`)
          // Unknown, not assumed-good: fail the step rather than report a fill that
          // may not exist. A halted plan is recoverable; a phantom fill is not.
          throw new Error(`market order placed but its fill could not be confirmed: ${(err as Error).message}`)
        }
        if (executed <= 0) {
          throw new Error('market order did not fill (cancelled or rejected by the exchange)')
        }
        step.status = 'filled'
        step.filledAt = Date.now()
        step.filledAmount = String(executed)
        const partial = Math.abs(executed - Number(amount)) / Math.max(Number(amount), 1e-12) > 0.01
        this.log(e, `  ✓ Market order filled ${executed}${partial ? ` of ${amount} (PARTIAL)` : ''}${avgPrice ? ` @ $${avgPrice}` : ''}`)
      }
    } catch (err) {
      step.status = 'failed'
      step.error = (err as Error).message
      this.log(e, `  ✗ Failed: ${step.error}`)
    }
  }

  private async waitForFill(e: PlanEntry, step: AutoStep): Promise<void> {
    const startedAt = Date.now()
    let polls = 0

    while (!e.aborted) {
      await sleep(30_000) // poll every 30s
      polls++

      try {
        const orderStatus = await fetchOrderStatus(step.geminiOrderId!)
        this.log(e, `  Poll #${polls}: executed=${orderStatus.executed_amount} remaining=${orderStatus.remaining_amount}`)

        if (!orderStatus.is_live && !orderStatus.is_cancelled) {
          step.status = 'filled'
          step.filledAt = Date.now()
          step.filledAmount = orderStatus.executed_amount
          this.log(e, `  ✓ Limit filled @ avg $${orderStatus.avg_execution_price}`)
          return
        }

        if (orderStatus.is_cancelled) {
          step.status = 'failed'
          step.error = 'Order cancelled on exchange'
          return
        }
      } catch (err) {
        this.log(e, `  Poll error: ${(err as Error).message}`)
      }

      // Time-stop: per-step override (minutes), else the default 8h limit timeout.
      // Bounce entries set timeStopMin:90 so a stale unfilled bid is cancelled
      // instead of chasing a falling tape. No market fallback — not all symbols
      // support market orders.
      const timeoutMs = (step.timeStopMin && step.timeStopMin > 0) ? step.timeStopMin * 60_000 : LIMIT_TIMEOUT_MS
      if (Date.now() - startedAt > timeoutMs) {
        const mins = Math.round(timeoutMs / 60_000)
        this.log(e, `  ⏰ Time-stop (${mins}m) — cancelling unfilled order`)
        try { await this.cancelOrder(step.geminiOrderId!) }
        catch (err) { this.log(e, `  ⚠ Cancel may have failed — check Gemini for a stale ${step.symbol} order: ${(err as Error).message}`) }
        if (step.side === 'buy') {
          // Entry never filled — there is no position, so skip the rest of the bracket.
          step.status = 'skipped'
          step.error = `Entry time-stop: unfilled after ${mins}m, cancelled (no chase)`
          e.haltAfterStep = true
        } else {
          step.status = 'failed'
          step.error = `Exit limit timed out after ${mins}m without filling`
        }
        return
      }
    }

    // Aborted mid-wait
    step.status = 'failed'
    step.error = 'Stopped by user'
  }

  private async cancelOrder(orderId: string): Promise<void> {
    const endpoint = '/v1/order/cancel'
    const res = await geminiPrivateFetch(endpoint, { order_id: orderId, account: 'primary' })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`cancelOrder ${res.status}: ${body}`)
    }
    // Verify the order actually left the book. Gemini can 200 the cancel yet still
    // report the order live briefly, and a swallowed failure here is what leaves a
    // "expired locally, still resting on Gemini" ghost order. Confirm is_live=false.
    try {
      const s = await fetchOrderStatus(orderId)
      if (s.is_live) throw new Error(`cancelOrder: ${orderId} still live after cancel`)
    } catch (err) {
      throw new Error(`cancelOrder verify failed: ${(err as Error).message}`)
    }
  }

  /** Cancel-and-replace a resting SELL at a new price, for the amount still unfilled.
   *
   *  CryptoHub.modifyOpenOrder does the same thing for user-initiated edits, but it reads
   *  the order out of the hub's snapshot and belongs to a different class; the bracket
   *  monitor owns its order ids directly and must not reach across. The two failure modes
   *  are reported separately because they demand opposite responses from the caller:
   *
   *    'cancel-failed'  → the old order is STILL RESTING. Position stays covered; keep the
   *                       existing order id and try again next tick.
   *    'replace-failed' → the old order is GONE and nothing replaced it. The position is
   *                       naked; the caller must drop the stale id so the monitor's
   *                       re-place path can cover it (same tick, not next).
   */
  private async repriceRestingSell(
    symbol: string, orderId: string, amount: string, newPrice: string
  ): Promise<
    | { ok: true; newOrderId: string }
    | { ok: false; reason: 'cancel-failed' | 'replace-failed'; error: string }
  > {
    try {
      await this.cancelOrder(orderId)
    } catch (e) {
      return { ok: false, reason: 'cancel-failed', error: (e as Error).message }
    }
    try {
      // placeOrder rounds price to the symbol's quote increment and floors amount to its
      // tick size, so the raw computed values above are safe to pass through.
      const newOrderId = await placeOrder(symbol, 'sell', amount, newPrice)
      return { ok: true, newOrderId }
    } catch (e) {
      return { ok: false, reason: 'replace-failed', error: (e as Error).message }
    }
  }

  private async resolveAmount(step: AutoStep, _allSteps: AutoStep[]): Promise<string> {
    const spec = step.amountSpec

    // ALL:<CURRENCY> — sell entire balance of that currency
    if (spec.startsWith('ALL:')) {
      const currency = spec.slice(4)
      const bal = await fetchCurrencyBalance(currency)
      if (bal <= 0) return '0'
      return floorToTickSize(bal, step.symbol)
    }

    // ALL_USD — use all available USD (minus $2 reserve for fees)
    if (spec === 'ALL_USD') {
      const usdBal = await fetchCurrencyBalance('USD')
      const usable = Math.max(0, usdBal - 2)
      if (usable < 1) return '0'
      const snap = cryptoHub.getSnapshot()
      const btcPrice = Number(snap.tickers.find((t) => t.symbol === 'BTCUSD')?.last ?? '0')
      if (!btcPrice) throw new Error('No BTC price available')
      return floorToTickSize(usable / btcPrice, step.symbol)
    }

    // USD:<amount> — convert dollar target to base currency amount.
    // Size a LIMIT order against its OWN limit price, not the live price: a resting buy below
    // market must spend the FULL target USD when it fills, so it buys back MORE base than a sell of
    // the same USD did higher up — that spread IS the ladder's BTC gain. Dividing by the (higher)
    // current price undersizes the order (it would spend only usdTarget × limit/live at fill), so a
    // USD-sized rebuy bought back ~the same BTC it sold and netted zero — the 2026-07-21 bug the operator
    // caught ($113 sold, $108 rebuy). Market orders (no meaningful limit) still use the live price.
    if (spec.startsWith('USD:')) {
      const usdTarget = parseFloat(spec.slice(4))
      const snap = cryptoHub.getSnapshot()
      const ticker = snap.tickers.find((t) => t.symbol === step.symbol)
      const livePrice = Number(ticker?.last ?? '0')
      const limitPrice = step.type === 'limit' && step.limitPrice ? Number(step.limitPrice) : NaN
      const price = Number.isFinite(limitPrice) && limitPrice > 0 ? limitPrice : livePrice
      if (!price) throw new Error(`No price for ${step.symbol}`)
      const usdBal = await fetchCurrencyBalance('USD')
      const actualUsd = Math.min(usdTarget, usdBal - 2)
      if (actualUsd < 1) return '0'
      return floorToTickSize(actualUsd / price, step.symbol)
    }

    // Fixed amount string
    return spec
  }

  // ── Managed bracket lifecycle ──────────────────────────────────────────
  // Design: only the protective STOP rests on Gemini (Gemini has no native OCO,
  // and every resting sell locks balance — so a full-size stop AND take-profits
  // can't coexist). Take-profits are MONITORED triggers that fire a marketable
  // exit when price crosses them. Benefit: hard protection survives a server
  // restart on the exchange, and TPs capture moves that wick through a limit.
  // Multiple symbols' brackets persist side by side, keyed by plan id, so a restart
  // reconciles and resumes ALL of them, not just one.

  private persistBracket(id: string, step: AutoStep): void {
    const ph = step.bracketState?.phase
    if (ph && ph !== 'flat' && ph !== 'aborted') this.persistedBrackets[id] = step
    else delete this.persistedBrackets[id]
    saveActiveBrackets(this.persistedBrackets)
  }

  private clearPersistedBracket(id: string): void {
    delete this.persistedBrackets[id]
    saveActiveBrackets(this.persistedBrackets)
  }

  private async cancelBracketOrders(st: BracketState): Promise<void> {
    const entryLegIds = (st.entryLegs ?? []).filter((l) => !l.filled).map((l) => l.orderId)
    const legTpIds = (st.entryLegs ?? []).map((l) => l.tpId ?? null)   // per-leg take-profit sells
    const exitLegIds = (st.exitLegs ?? []).filter((l) => !l.filled).map((l) => l.orderId)
    for (const id of [st.entryId, st.stopId, st.tp1Id, st.tp2Id, ...entryLegIds, ...legTpIds, ...exitLegIds]) {
      if (id) { try { await this.cancelOrder(id) } catch { /* ignore */ } }
    }
  }

  private failBracket(e: PlanEntry, step: AutoStep, reason: string): void {
    const st = step.bracketState!
    st.phase = 'aborted'; st.note = reason
    step.status = 'skipped'; step.error = reason
    this.log(e, `⏹ Bracket aborted: ${reason}`)
    for (const leg of st.entryLegs ?? []) {
      if (!leg.filled && !leg.cancelled && leg.orderId) {
        this.cancelOrder(leg.orderId).catch(() => { /* ignore */ })
        leg.cancelled = true
      }
    }
    this.clearPersistedBracket(e.status.id)
    this.notify()
  }

  private async runBracket(e: PlanEntry, step: AutoStep, myRunId: number): Promise<void> {
    const spec = step.bracket!
    const base = spec.symbol.replace('USD', '')
    const st: BracketState = step.bracketState ?? {
      phase: 'entering', entryId: null, stopId: null, tp1Id: null, tp2Id: null,
      entryPrice: null, filledAmount: null, positionAmount: null, stopPrice: null,
      highWater: null, filledAt: null, realizedUsd: 0, feeUsd: 0, note: 'Placing entry',
    }
    step.bracketState = st
    step.status = 'executing'
    this.notify()

    try {
      // ── ENTER (confirm-first; marketable limit with entry time-stop) ──
      if (st.phase === 'entering') {
        if (!st.entryId) {
          // Idempotency: assign + PERSIST a client_order_id BEFORE touching the exchange, so
          // the intent is durable even if we die mid-place. On any re-entry (restart resume,
          // repeated confirm) reconcile against the live book by that id first — if the entry
          // is already resting we adopt it instead of placing a second identical order. This is
          // what prevents the "10 identical resting entries" duplicate-order bug.
          if (!st.entryClientId) {
            st.entryClientId = `hmx-${e.status.id}-${randomUUID().slice(0, 8)}`
            this.persistBracket(e.status.id, step)
          } else {
            try {
              const existing = (await fetchOpenOrders()).find((o) => o.clientOrderId === st.entryClientId)
              if (existing) {
                st.entryId = existing.orderId
                this.log(e, `↩ Adopted already-resting entry (client ${st.entryClientId}, id ${existing.orderId}) — not re-placing`)
                this.persistBracket(e.status.id, step); this.notify()
              }
            } catch (err) { this.log(e, `  entry reconcile failed (will place fresh): ${(err as Error).message}`) }
          }
          if (!st.entryId) {
            const entryStep = { ...step, side: 'buy' as const, type: 'limit' as const, amountSpec: spec.entry.amountSpec }
            const amount = await this.resolveAmount(entryStep, [step])
            if (!amount || Number(amount) <= 0) { this.failBracket(e, step, 'Zero entry amount — insufficient USD'); return }
            st.entryId = await placeOrder(spec.symbol, 'buy', amount, spec.entry.limitPrice, undefined, undefined, st.entryClientId!)
            st.note = `Entry resting: buy ${amount} ${base} @ ${spec.entry.limitPrice}`
            void cryptoHub.refreshOpenOrders()
            this.log(e, `▶ Bracket ENTER: ${st.note} (id ${st.entryId})`)
            this.persistBracket(e.status.id, step); this.notify()
          }
        }
        // Stage any additional entry legs (2nd/3rd purchases) alongside the primary — each
        // rests independently at its own (lower) limit price so the position builds via
        // 2-3 orders instead of one. Same idempotent client_order_id + reconcile pattern.
        if (spec.entry.legs?.length) {
          if (!st.entryLegs) st.entryLegs = []
          for (let i = 0; i < spec.entry.legs.length; i++) {
            const legSpec = spec.entry.legs[i]
            let leg = st.entryLegs[i]
            if (!leg) {
              leg = {
                clientId: `hmx-${e.status.id}-leg${i + 2}-${randomUUID().slice(0, 8)}`,
                orderId: null, limitPrice: legSpec.limitPrice, amountSpec: legSpec.amountSpec,
                filled: false, cancelled: false, filledAmount: null, filledPrice: null,
              }
              st.entryLegs[i] = leg
              this.persistBracket(e.status.id, step)
            }
            if (!leg.orderId && !leg.filled && !leg.cancelled) {
              try {
                const existing = (await fetchOpenOrders()).find((o) => o.clientOrderId === leg.clientId)
                if (existing) {
                  leg.orderId = existing.orderId
                  this.log(e, `↩ Adopted already-resting entry leg ${i + 2} (client ${leg.clientId}, id ${existing.orderId})`)
                }
              } catch (err) { this.log(e, `  entry leg ${i + 2} reconcile failed (will place fresh): ${(err as Error).message}`) }
              if (!leg.orderId) {
                const legStep = { ...step, side: 'buy' as const, type: 'limit' as const, amountSpec: leg.amountSpec }
                const legAmount = await this.resolveAmount(legStep, [step])
                if (legAmount && Number(legAmount) > 0) {
                  leg.orderId = await placeOrder(spec.symbol, 'buy', legAmount, leg.limitPrice, undefined, undefined, leg.clientId)
                  this.log(e, `▶ Bracket ENTER leg ${i + 2}: buy ${legAmount} ${base} @ ${leg.limitPrice} (id ${leg.orderId})`)
                  void cryptoHub.refreshOpenOrders()
                } else {
                  leg.cancelled = true
                  this.log(e, `  ⚠ Entry leg ${i + 2} skipped — zero resolvable amount`)
                }
              }
              this.persistBracket(e.status.id, step); this.notify()
            }
          }
        }

        const filled = await this.awaitEntryFill(e, step, spec, myRunId)
        if (!filled || e.aborted || e.runId !== myRunId) return
      }

      // ── PROTECT (place the resting stop/TP) ── awaitEntryFill now places protection the
      // instant the primary leg fills, so this only fires as a fallback (e.g. a resumed
      // bracket that filled but never got protection placed). The !tp1Id guard prevents a
      // double-placement for tpFirst brackets, where !stopId alone wouldn't (no resting stop).
      if (st.phase === 'protected' && !st.stopId && !st.tp1Id) {
        await this.placeProtection(e, step, spec)
      }

      // ── MONITOR (OCO / scale-out / trailing / time-stop) ──
      await this.monitorBracket(e, step, spec, myRunId)
    } catch (err) {
      this.log(e, `✗ Bracket error: ${(err as Error).message}`)
      step.status = 'failed'; step.error = (err as Error).message
      st.note = `Error: ${(err as Error).message}`
      this.persistBracket(e.status.id, step); this.notify()
    }
  }

  /** Polls any not-yet-resolved additional entry legs and updates their fill state in place.
   *  Called on every tick of awaitEntryFill so a staged lower leg can fill independently of
   *  (before or after) the primary leg. */
  private async pollEntryLegs(e: PlanEntry, st: BracketState, spec: BracketSpec): Promise<void> {
    if (!st.entryLegs?.length) return
    for (let i = 0; i < st.entryLegs.length; i++) {
      const leg = st.entryLegs[i]
      if (leg.filled || leg.cancelled || !leg.orderId) continue
      let s: Awaited<ReturnType<typeof fetchOrderStatus>>
      try { s = await fetchOrderStatus(leg.orderId) } catch (err) { this.log(e, `  entry leg ${i + 2} poll error: ${(err as Error).message}`); continue }
      if (!s.is_live && !s.is_cancelled && Number(s.executed_amount) > 0) {
        leg.filled = true
        leg.filledAmount = Number(s.executed_amount)
        leg.filledPrice = Number(s.avg_execution_price)
        const legFee = await feeUsdForOrder(spec.symbol, leg.orderId)
        st.feeUsd = (st.feeUsd ?? 0) + legFee   // tracked for reference; NOT netted into realizedUsd
        this.log(e, `  ✓ Entry leg ${i + 2} filled: ${leg.filledAmount} @ $${leg.filledPrice}`)
      } else if (s.is_cancelled) {
        leg.cancelled = true
      }
    }
  }

  /** Once the primary leg has filled (or the time-stop is reached), gives any still-resting
   *  additional legs the remainder of the time budget to fill, then cancels stragglers and
   *  aggregates all filled legs (primary + additional) into st.entryPrice/filledAmount as a
   *  single weighted-average position. */
  private async settleEntryLegs(e: PlanEntry, step: AutoStep, spec: BracketSpec, myRunId: number, deadline: number): Promise<void> {
    const st = step.bracketState!
    const primaryAmount = st.filledAmount ?? 0
    const primaryPrice = st.entryPrice ?? 0

    // Place an INDEPENDENT take-profit sell for each additional leg the moment it fills, sized
    // to that leg's own filled amount, resting at the shared midband target (operator directive 2026-07-07:
    // one sell per buy). Each leg sells only its own quantity — one filling never cancels or
    // resizes another (no cancel/replace seam). The primary leg keeps its own TP as st.tp1Id.
    const placeLegTps = async (): Promise<void> => {
      if (!st.tpTargetPrice || !st.entryLegs) return
      for (let i = 0; i < st.entryLegs.length; i++) {
        const leg = st.entryLegs[i]
        if (!leg.filled || leg.tpId || leg.tpDone || !leg.filledAmount) continue
        leg.tpId = await this.placeRestingSell(spec.symbol, leg.filledAmount, st.tpTargetPrice)
        if (leg.tpId) this.log(e, `  🎯 Leg ${i + 2} TP: resting sell ${leg.filledAmount} ${spec.symbol.replace('USD', '')} @ $${st.tpTargetPrice.toFixed(6)} (independent of the primary/other legs)`)
        else this.log(e, `  ⚠ Leg ${i + 2} TP placement failed — ${leg.filledAmount} ${spec.symbol.replace('USD', '')} briefly without a resting sell; will retry`)
        this.persistBracket(e.status.id, step); this.notify()
      }
    }

    await placeLegTps()  // a lower leg may have filled BEFORE the primary — cover it now
    while (st.entryLegs?.some((l) => !l.filled && !l.cancelled) && Date.now() < deadline && !e.aborted && e.runId === myRunId) {
      await sleep(15_000)
      await this.pollEntryLegs(e, st, spec)
      await placeLegTps()
    }
    if (st.entryLegs?.length) {
      for (let i = 0; i < st.entryLegs.length; i++) {
        const leg = st.entryLegs[i]
        if (!leg.filled && !leg.cancelled && leg.orderId) {
          try { await this.cancelOrder(leg.orderId) }
          catch (err) { this.log(e, `  ⚠ Entry leg ${i + 2} cancel may have failed: ${(err as Error).message}`) }
          leg.cancelled = true
          this.log(e, `  ⏹ Entry leg ${i + 2} unfilled after time-stop — cancelled (position built from filled legs only)`)
        }
      }
      const filledLegs = st.entryLegs.filter((l) => l.filled && l.filledAmount && l.filledPrice)
      if (filledLegs.length) {
        const legsAmount = filledLegs.reduce((sum, l) => sum + (l.filledAmount ?? 0), 0)
        const totalAmount = primaryAmount + legsAmount
        const weightedPrice = (primaryAmount * primaryPrice + filledLegs.reduce((sum, l) => sum + (l.filledAmount ?? 0) * (l.filledPrice ?? 0), 0)) / totalAmount
        st.filledAmount = totalAmount
        st.positionAmount = totalAmount
        st.entryPrice = weightedPrice
        st.note = `Filled ${totalAmount} @ avg $${weightedPrice.toFixed(6)} (${1 + filledLegs.length}/${1 + st.entryLegs.length} legs)`
        this.log(e, `  ✓ Staged entry complete: ${st.note}`)
      }
    }
    await placeLegTps()  // final safety net — every filled leg has its own resting TP
    this.persistBracket(e.status.id, step); this.notify()
  }

  private async awaitEntryFill(e: PlanEntry, step: AutoStep, spec: BracketSpec, myRunId: number): Promise<boolean> {
    const st = step.bracketState!
    const deadline = Date.now() + spec.entry.timeStopMin * 60_000
    while (!e.aborted && e.runId === myRunId) {
      await sleep(15_000)
      await this.pollEntryLegs(e, st, spec)
      let s: Awaited<ReturnType<typeof fetchOrderStatus>>
      try { s = await fetchOrderStatus(st.entryId!) } catch (err) { this.log(e, `  entry poll error: ${(err as Error).message}`); continue }
      if (!s.is_live && !s.is_cancelled && Number(s.executed_amount) > 0) {
        st.entryPrice = Number(s.avg_execution_price)
        st.filledAmount = Number(s.executed_amount)
        st.positionAmount = Number(s.executed_amount)
        const entryFee = await feeUsdForOrder(spec.symbol, st.entryId!)  // entry-side fee, from filled-order records
        st.feeUsd = (st.feeUsd ?? 0) + entryFee  // tracked for reference; NOT netted into realizedUsd
        st.filledAt = Date.now()
        st.highWater = st.entryPrice
        st.note = `Filled ${st.filledAmount} @ $${st.entryPrice}`
        this.log(e, `  ✓ Bracket entry filled: ${st.note}`)
        cryptoToast(
          `${spec.symbol.replace('USD', '')} entry filled`,
          `${st.filledAmount} @ $${st.entryPrice} — stop/targets now managed`,
          'notice', 'ti-target-arrow'
        )
        this.persistBracket(e.status.id, step); this.notify()
        // Place the take-profit for the primary fill IMMEDIATELY — do NOT wait for the pending
        // lower legs to settle first (operator directive 2026-07-07: every buy gets its sell placed right
        // after it completes, even with a lower buy still resting). settleEntryLegs then GROWS
        // this resting TP to cover each additional leg as it fills.
        st.phase = 'protected'
        await this.placeProtection(e, step, spec)
        this.persistBracket(e.status.id, step); this.notify()
        await this.settleEntryLegs(e, step, spec, myRunId, deadline)
        return true
      }
      if (s.is_cancelled) {
        // A cancelled entry may still have filled part-way first. Abandoning it here
        // left those coins held with no stop, no take-profit, no ledger entry, and
        // nothing for safe mode to arm (there is no resting sell) — a silently naked
        // position. Adopt whatever actually filled instead.
        if (await this.adoptPartialEntry(e, step, spec, s, myRunId, deadline, 'Entry cancelled on exchange')) return true
        return false
      }
      if (Date.now() > deadline) {
        try { await this.cancelOrder(st.entryId!) }
        catch (err) { this.log(e, `  ⚠ Entry cancel may have failed — check Gemini for a stale ${spec.symbol} bid: ${(err as Error).message}`) }
        // Re-read after the cancel: the deadline can race a fill, and the status we
        // polled up to 15s ago is not authoritative about what we now hold.
        let after = s
        try { after = await fetchOrderStatus(st.entryId!) } catch { /* keep the pre-cancel read */ }
        if (await this.adoptPartialEntry(
          e, step, spec, after, myRunId, deadline,
          `Entry unfilled after ${spec.entry.timeStopMin}m — abandoned (no chase)`
        )) return true
        return false
      }
    }
    return false
  }

  /**
   * An entry that was cancelled — by the exchange, or by our own time-stop — may have
   * filled part-way first. Adopt that partial as the bracket's position and protect
   * it; only genuinely-nothing-filled entries fail the bracket.
   *
   * Returns true when a position was adopted (caller should treat the bracket as
   * live), false when there was nothing to adopt and the bracket has been failed.
   *
   * Why this matters more than it looks: a partially-filled-then-abandoned entry
   * leaves coins in the account that NOTHING is watching. There is no resting sell,
   * so safe mode cannot arm one; the bracket is gone, so the monitor's stop/TP/
   * time-stop never run; and no ClosedTrade is ever written, so the P&L ledger does
   * not know the position exists. It just sits there until someone notices.
   */
  private async adoptPartialEntry(
    e: PlanEntry,
    step: AutoStep,
    spec: BracketSpec,
    s: Awaited<ReturnType<typeof fetchOrderStatus>>,
    myRunId: number,
    deadline: number,
    failReason: string,
  ): Promise<boolean> {
    const st = step.bracketState!
    const executed = Number(s.executed_amount) || 0
    const avg = Number(s.avg_execution_price) || 0
    const last = Number(cryptoHub.getSnapshot().tickers.find((t) => t.symbol === spec.symbol)?.last) || avg
    // Below ~$1 of notional is exchange dust, not a position worth managing — and is
    // usually unsellable anyway (min order size), so protecting it would only produce
    // rejected orders every tick.
    if (executed <= 0 || executed * (avg || last) < 1) {
      this.failBracket(e, step, failReason)
      return false
    }

    st.entryPrice = avg || last
    st.filledAmount = executed
    st.positionAmount = executed
    try {
      st.feeUsd = (st.feeUsd ?? 0) + await feeUsdForOrder(spec.symbol, st.entryId!)
    } catch { /* fee lookup is reference-only; never block adopting the position */ }
    st.filledAt = Date.now()
    st.highWater = st.entryPrice
    st.note = `Partial fill adopted: ${executed} @ $${st.entryPrice} (${failReason})`
    this.log(e, `  ⚠ ${failReason} — but ${executed} ${spec.symbol.replace('USD', '')} had already filled. Adopting and protecting it.`)
    cryptoToast(
      `${spec.symbol.replace('USD', '')} partial entry adopted`,
      `${executed} @ $${st.entryPrice} — stop/targets now managed`,
      'warn', 'ti-target-arrow'
    )
    st.phase = 'protected'
    await this.placeProtection(e, step, spec)
    this.persistBracket(e.status.id, step); this.notify()
    // Any staged lower legs are still resting against a plan that just lost its
    // primary entry; settle them the same way a clean fill would.
    await this.settleEntryLegs(e, step, spec, myRunId, deadline)
    return true
  }

  /** "buy then immediately sell" mode is eligible only for a full-exit bracket — one
   *  TP for the whole position, no scale-out — since a full-size resting TP can't
   *  coexist with a full-size resting stop (each locks the entire balance). */
  private tpFirstEligible(spec: BracketSpec): boolean {
    return !!spec.tpFirst && !spec.tp2 && spec.tp1.sizeFraction >= 1
  }

  /**
   * How many base units THIS bracket may sell — its own position, never the wallet's.
   *
   * The distinction is the whole point. `fetchCurrencyTotal` is the account-wide
   * balance of the coin, which includes long-term holdings the bracket never
   * bought. Sizing an exit off it meant a $10 bracket on a coin you also hold 500
   * of would place a resting sell for all 504 and then liquidate the remainder in
   * finalizeBracket. placeProtection got this right (`Math.min(filledAmount, held)`)
   * and the monitor loop overwrote it with the raw balance on every tick.
   *
   * The account balance still matters, as a CLAMP rather than a source: if the
   * operator sold the coins by hand, or a leg TP already took some, the bracket
   * cannot sell what is no longer there. Hence min() — and hence "position closed"
   * is judged on this value too, so a bracket finishes when ITS position is gone
   * rather than waiting for an unrelated long-term holding to disappear.
   */
  private bracketPosition(st: BracketState, held: number): number {
    const own = st.positionAmount ?? st.filledAmount ?? held
    return Math.max(0, Math.min(own, held))
  }

  private async placeProtection(e: PlanEntry, step: AutoStep, spec: BracketSpec): Promise<void> {
    const st = step.bracketState!
    const held = await fetchCurrencyTotal(spec.symbol.replace('USD', ''))
    st.positionAmount = Math.min(st.filledAmount ?? held, held)
    // stopPct <= 0 means NO protective stop at all (fast-cash's take-profit-only mode):
    // no resting stop, no monitored stop trigger. The only exits are the resting TP and
    // the position time-stop. st.stopPrice stays null so nothing ever places a stop.
    const noStop = spec.stopPct <= 0
    const stopTrigger = st.entryPrice! * (1 - spec.stopPct)

    // ── tpFirst: rest the take-profit sell at target RIGHT NOW (a true bracket order).
    //    With a stop (stopPct>0) the stop is a MONITORED trigger; with noStop the TP and
    //    the position time-stop are the only exits. This is "buy and immediately sell". ──
    if (this.tpFirstEligible(spec)) {
      const tpPrice = st.entryPrice! * (1 + spec.tp1.pricePct)
      st.tpTargetPrice = tpPrice                    // fixed target; staged legs grow the TP to it
      st.stopPrice = noStop ? null : stopTrigger   // monitored trigger only — never resting
      // Staged entries (entry.legs — the BB_SWING default) place a SINGLE resting TP that is
      // grown as each additional leg fills (see settleEntryLegs), so use a plain resting
      // sell here rather than placeStagedExit's higher-scaled exit legs, which don't compose
      // with a growing position. Non-staged brackets keep the full staged-exit behavior.
      const staged = !!st.entryLegs?.length
      st.tp1Id = staged
        ? await this.placeRestingSell(spec.symbol, st.positionAmount, tpPrice)
        : await this.placeStagedExit(e, step, spec, spec.symbol, st.positionAmount, tpPrice)
      const stopNote = noStop ? 'no stop (take-profit only)' : `stop $${stopTrigger.toFixed(6)} monitored`
      st.note = st.tp1Id
        ? `TP resting @ $${tpPrice.toFixed(6)} (placed on fill); ${stopNote}`
        : `⚠ TP placement failed; ${stopNote}`
      this.log(e, `  🎯 tpFirst: resting TP sell @ $${tpPrice.toFixed(6)} for ${st.positionAmount} ${spec.symbol.replace('USD', '')} immediately on fill (${stopNote})`)
      this.persistBracket(e.status.id, step); this.notify()
      return
    }

    if (noStop) {
      // Stopless scale-out (sniper's shape: stopPct 0 + tp2 + tp1.sizeFraction < 1). Without a
      // resting order, safe mode has nothing to arm against — the position sits fully naked
      // until price organically reaches TP1 (operator directive 2026-07-20: 3 consecutive sniper runs found
      // live positions sitting naked for hours because of exactly this gap). Mirror tpFirst's
      // "rest the TP immediately on fill" behavior, but sized to tp1.sizeFraction so the
      // remainder still participates as a trailing runner once TP1 actually fills.
      if (spec.tp2 && spec.tp1.sizeFraction < 1) {
        const tpPrice = st.entryPrice! * (1 + spec.tp1.pricePct)
        st.tpTargetPrice = tpPrice
        const sellAmt = st.positionAmount * spec.tp1.sizeFraction
        st.tp1Id = await this.adoptOrPlaceTp1Sell(spec.symbol, sellAmt, tpPrice)
        const base = spec.symbol.replace('USD', '')
        st.note = st.tp1Id
          ? `TP1 resting @ $${tpPrice.toFixed(6)} for ${sellAmt.toFixed(6)} ${base} (placed on fill; no stop — safe mode carries the downside)`
          : `⚠ TP1 placement failed; no stop — position uncovered until self-heal retries`
        this.log(e, `  🎯 noStop scale-out: resting TP1 sell @ $${tpPrice.toFixed(6)} for ${sellAmt.toFixed(6)} ${base} immediately on fill (no resting stop; safe mode is the downside control)`)
        this.persistBracket(e.status.id, step); this.notify()
        return
      }
      // Non-tpFirst, no tp2, stopless: monitor TPs as usual, just never place a stop.
      const tp1 = (st.entryPrice! * (1 + spec.tp1.pricePct)).toFixed(6)
      st.note = `No stop (take-profit only) — TP1 $${tp1} (monitored)`
      this.persistBracket(e.status.id, step); this.notify()
      return
    }

    await this.placeStop(e, step, spec, stopTrigger, st.positionAmount)
    const tp1 = (st.entryPrice! * (1 + spec.tp1.pricePct)).toFixed(6)
    const tp2 = spec.tp2 ? `, TP2 $${(st.entryPrice! * (1 + spec.tp2.pricePct)).toFixed(6)}` : ''
    st.note = `Protected — stop $${stopTrigger.toFixed(6)}; TP1 $${tp1}${tp2} (monitored)`
    this.persistBracket(e.status.id, step); this.notify()
  }

  /** Cancels the resting stop. Returns TRUE only when the stop is confirmed gone from the
   *  book — the caller may then place its replacement (a new stop, or the sell that needs
   *  the balance the stop was locking).
   *
   *  A FAILED cancel used to null st.stopId anyway. That orphaned a still-live stop-limit
   *  the engine no longer knew about, and the monitor's stop self-heal then placed a second
   *  one on the very next tick — the "multiple stop-limit orders" duplication (UNI, 2026-08-05:
   *  five identical 2.544594 stop-limit sells). Now the id is kept on failure, so the position
   *  stays covered by the order that is actually resting and nothing double-places; the caller
   *  simply retries its cancel-and-replace on the next 20s tick. */
  private async cancelStop(st: BracketState): Promise<boolean> {
    if (!st.stopId) return true
    try {
      await this.cancelOrder(st.stopId)
    } catch {
      return false   // still resting — keep st.stopId so no duplicate is placed against it
    }
    st.stopId = null
    await sleep(1_500) // let Gemini release the locked balance before we sell it
    return true
  }

  private async placeStop(e: PlanEntry, step: AutoStep, spec: BracketSpec, stopTrigger: number, amountBase: number): Promise<void> {
    const st = step.bracketState!
    const amt = await floorToTickSize(amountBase, spec.symbol)
    if (Number(amt) <= 0) return
    const trigger = await roundToQuoteIncrement(stopTrigger, spec.symbol)
    // A Gemini stop-limit SELL is structurally a taker exit and cannot be made otherwise:
    //   · "No options can be applied to stop-limit orders at this time" — no post-only flag.
    //   · "sell orders require the stop_price to be greater than the price" — the limit MUST
    //     sit strictly below the trigger, so once triggered it is marketable by construction.
    // The 0.5% offset below therefore isn't the reason this pays taker; the order type is.
    // Making stop exits maker means not using exchange stops at all and letting safe mode
    // (a resting maker sell) carry the downside — see the exit fee policy above placeOrder.
    const limit = await roundToQuoteIncrement(stopTrigger * 0.995, spec.symbol)
    // Reconcile against the book BEFORE placing (same adopt-or-place pattern as entries,
    // entry legs and adoptOrPlaceTp1Sell — the stop path never got it, which is why stops
    // were the one order type that could stack). A stop-limit sell already resting on this
    // symbol is ours: adopt it rather than placing a second, and cancel any extra ones left
    // orphaned by an earlier failed cancel or a place that threw after Gemini accepted it.
    const adopted = await this.reconcileRestingStops(e, spec.symbol, trigger)
    if (adopted) {
      st.stopId = adopted.orderId
      st.stopPrice = Number(adopted.stopPrice ?? trigger)
      this.log(e, `  ↩ Adopted already-resting stop @ $${st.stopPrice.toFixed(6)} (id ${adopted.orderId}) — not placing a duplicate`)
      this.persistBracket(e.status.id, step); this.notify()
      return
    }
    try {
      st.stopId = await placeOrder(spec.symbol, 'sell', amt, limit, trigger)
      st.stopPrice = stopTrigger
      this.log(e, `  🛡 Stop (re)placed @ $${stopTrigger.toFixed(6)} for ${amt} ${spec.symbol.replace('USD', '')}`)
    } catch (err) { this.log(e, `  ⚠ Stop placement failed: ${(err as Error).message}`) }
    this.persistBracket(e.status.id, step); this.notify()
  }

  /** Returns the one stop-limit sell already resting on `symbol` (preferring the one closest
   *  to `wantTrigger`), cancelling every other resting stop-limit sell on that symbol so at
   *  most one survives. Returns null when the book is clear and the caller should place fresh.
   *
   *  Two things put a stop on the book that st.stopId doesn't know about: a placeOrder that
   *  threw AFTER Gemini accepted it (transient network/parse hiccup on our end), and a cancel
   *  that failed while the caller carried on. Both used to be invisible to the engine, and the
   *  20s stop self-heal (`!st.stopId` ⇒ place one) then re-placed on every tick — one live stop
   *  per tick, all for the identical amount. Best-effort: if /v1/orders is unreachable we fall
   *  through and place fresh, exactly as before. */
  private async reconcileRestingStops(
    e: PlanEntry, symbol: string, wantTrigger: string
  ): Promise<GeminiOpenOrder | null> {
    let resting: GeminiOpenOrder[]
    try {
      resting = (await fetchOpenOrders()).filter((o) =>
        o.symbol === symbol && o.side === 'sell' && !!o.stopPrice)
    } catch { return null }
    if (!resting.length) return null
    const want = Number(wantTrigger)
    const keep = resting.reduce((best, o) =>
      Math.abs(Number(o.stopPrice) - want) < Math.abs(Number(best.stopPrice) - want) ? o : best)
    for (const o of resting) {
      if (o.orderId === keep.orderId) continue
      try {
        await this.cancelOrder(o.orderId)
        this.log(e, `  🧹 Cancelled orphaned duplicate stop @ $${o.stopPrice} (id ${o.orderId})`)
      } catch (err) {
        this.log(e, `  ⚠ Could not cancel orphaned duplicate stop ${o.orderId}: ${(err as Error).message}`)
      }
    }
    return keep
  }

  /** Post-only sell — used as the safety net when a bracket is closing out for a reason
   *  unrelated to hitting a target (e.g. tidying up dust after the stop already filled, or
   *  reconciling an externally-closed position).
   *
   *  This used to cross the spread (bid × 0.997) AND pass immediate-or-cancel: doubly
   *  taker, at 1.2%. It now rests at the ask as maker-or-cancel. None of its callers are
   *  urgent — they're cleanup and reconciliation — so a slower fill is the right trade
   *  against halving the fee. If it can't rest, Gemini rejects it and the caller logs the
   *  failure rather than silently paying taker. See the exit fee policy above placeOrder. */
  private async sellToUsd(symbol: string, amountBase: number): Promise<{ filled: number; avgPrice: number; feeUsd: number }> {
    const amt = await floorToTickSize(amountBase, symbol)
    if (Number(amt) <= 0) return { filled: 0, avgPrice: 0, feeUsd: 0 }
    const snap = cryptoHub.getSnapshot()
    const ticker = snap.tickers.find((t) => t.symbol === symbol)
    const bid = Number(ticker?.bid ?? ticker?.last ?? '0')
    // Rest at the ask so the order posts instead of crossing.
    const ask = Number(ticker?.ask ?? 0) || bid
    const px = await roundToQuoteIncrement(ask, symbol)
    const id = await placeOrder(symbol, 'sell', amt, px, undefined, MAKER_ONLY)
    await sleep(3_000)
    try {
      const s = await fetchOrderStatus(id)
      const feeUsd = await feeUsdForOrder(symbol, id)  // from filled-order records
      return { filled: Number(s.executed_amount), avgPrice: Number(s.avg_execution_price) || bid, feeUsd }
    } catch { return { filled: Number(amt), avgPrice: bid, feeUsd: 0 } }
  }

  /** Places a genuine resting (GTC) limit sell — priced at the current best ask, so it
   *  never crosses the spread / never fills as a taker-market order. This is how every
   *  TP and time-stop exit executes now: a real limit order sitting on the book, not an
   *  immediate-or-cancel fill. Trade-off, stated plainly: this can take longer to fill
   *  than a market order would, and in the rare case price reverses hard before it fills,
   *  it may not fill at all — the position then just sits, protected by the stop that's
   *  still resting for any un-exited portion, until the next run reviews it. */
  private async placeRestingSell(symbol: string, amountBase: number, limitPrice: number): Promise<string | null> {
    const amt = await floorToTickSize(amountBase, symbol)
    if (Number(amt) <= 0) return null
    const px = await roundToQuoteIncrement(limitPrice, symbol)
    return placeOrder(symbol, 'sell', amt, px)
  }

  /** Places a TP1 sell, but first checks whether one is already resting near the target
   *  price and adopts it instead of placing a second one. A prior attempt can succeed on
   *  Gemini's side even when the client-side promise throws afterward (a transient
   *  network/parse hiccup on our end after the exchange already accepted the order) — the
   *  caller sees an exception, tp1Id never gets recorded, and every retry (e.g. a watchdog
   *  revival re-entering placeProtection) would otherwise place another real duplicate.
   *  (operator directive 2026-07-20: exactly this raced POL/WLD/FIL into stacked duplicate resting sells
   *  the first time the noStop+tp2 branch below went live.) Mirrors the "adopt already-
   *  resting entry leg" reconciliation pattern used for entry legs. */
  private async adoptOrPlaceTp1Sell(symbol: string, amountBase: number, targetPrice: number): Promise<string | null> {
    try {
      const existing = (await fetchOpenOrders()).find((o) =>
        o.symbol === symbol && o.side === 'sell' && Math.abs(Number(o.price) - targetPrice) / targetPrice < 0.002)
      if (existing) return existing.orderId
    } catch { /* reconciliation failed — fall through to placing fresh, same as before */ }
    return this.placeRestingSell(symbol, amountBase, targetPrice)
  }

  /** Stages a FULL/FINAL exit as 2-3 resting sell orders instead of one, per spec.exitLegs:
   *  the primary tranche rests at basePrice (returned, for the caller to store as tp1Id as
   *  usual); any additional legs rest ABOVE it at basePrice × (1 + pricePct), each carved out
   *  of totalAmount by its own sizeFraction, tracked in st.exitLegs for later polling. Falls
   *  back to a single plain resting sell when no exitLegs are configured. */
  private async placeStagedExit(e: PlanEntry, step: AutoStep, spec: BracketSpec, sym: string, totalAmount: number, basePrice: number): Promise<string | null> {
    const st = step.bracketState!
    const legSpecs = spec.exitLegs ?? []
    if (!legSpecs.length) { st.exitLegs = undefined; st.exitLegsDeadline = null; return this.placeRestingSell(sym, totalAmount, basePrice) }

    const legFractionSum = legSpecs.reduce((sum, l) => sum + l.sizeFraction, 0)
    const primaryAmount = totalAmount * Math.max(0, 1 - legFractionSum)
    const primaryId = await this.placeRestingSell(sym, primaryAmount, basePrice)
    this.log(e, `  🎯 Staged exit leg 1: resting sell ${primaryAmount.toFixed(6)} ${sym.replace('USD', '')} @ $${basePrice.toFixed(6)}`)

    st.exitLegs = []
    for (let i = 0; i < legSpecs.length; i++) {
      const legSpec = legSpecs[i]
      const legPrice = basePrice * (1 + legSpec.pricePct)
      const legAmount = totalAmount * legSpec.sizeFraction
      const orderId = await this.placeRestingSell(sym, legAmount, legPrice)
      st.exitLegs.push({ orderId, price: legPrice, sizeFraction: legSpec.sizeFraction, filled: false, cancelled: false, filledAmount: null, filledPrice: null })
      this.log(e, `  🎯 Staged exit leg ${i + 2}: resting sell ${legAmount.toFixed(6)} ${sym.replace('USD', '')} @ $${legPrice.toFixed(6)} (id ${orderId})`)
    }
    // Give legs the same window as the position time-stop (or 24h, whichever's shorter) to
    // fill before they're cancelled and the bracket finalizes on whatever did fill.
    st.exitLegsDeadline = Date.now() + Math.min(spec.positionTimeStopMin, 1440) * 60_000
    return primaryId
  }

  /** Polls any not-yet-resolved additional exit legs and credits their fills into
   *  realizedUsd/feeUsd in place. Called on every monitorBracket tick so a staged higher
   *  leg can fill independently of (before or after) the primary exit order. */
  private async pollExitLegs(e: PlanEntry, st: BracketState, spec: BracketSpec): Promise<void> {
    if (!st.exitLegs?.length) return
    for (let i = 0; i < st.exitLegs.length; i++) {
      const leg = st.exitLegs[i]
      if (leg.filled || leg.cancelled || !leg.orderId) continue
      let s: Awaited<ReturnType<typeof fetchOrderStatus>>
      try { s = await fetchOrderStatus(leg.orderId) } catch (err) { this.log(e, `  exit leg ${i + 2} poll error: ${(err as Error).message}`); continue }
      if (!s.is_live && !s.is_cancelled && Number(s.executed_amount) > 0) {
        leg.filled = true
        leg.filledAmount = Number(s.executed_amount)
        leg.filledPrice = Number(s.avg_execution_price)
        st.realizedUsd += (leg.filledPrice - st.entryPrice!) * leg.filledAmount
        const legFee = await feeUsdForOrder(spec.symbol, leg.orderId)
        st.feeUsd = (st.feeUsd ?? 0) + legFee    // reference only — realizedUsd stays fee-free
        this.log(e, `  ✓ Exit leg ${i + 2} filled: ${leg.filledAmount} @ $${leg.filledPrice} — realized now ~$${st.realizedUsd.toFixed(2)}`)
      } else if (s.is_cancelled) {
        leg.cancelled = true
      }
    }
  }

  /** True once every staged exit leg has either filled or been cancelled — the gate on
   *  finalizing a full/final exit to 'flat' when legs are in play. */
  private exitLegsSettled(st: BracketState): boolean {
    return !st.exitLegs?.some((l) => !l.filled && !l.cancelled)
  }

  /** Polls each staged ENTRY leg's independent take-profit sell (entryLegs[].tpId) and credits
   *  its fill into realizedUsd. Mirrors pollExitLegs but for the per-leg TPs — one sell per
   *  buy leg, each filling independently of the primary and the other legs. */
  private async pollLegTps(e: PlanEntry, step: AutoStep, spec: BracketSpec): Promise<void> {
    const st = step.bracketState!
    if (!st.entryLegs?.length) return
    for (let i = 0; i < st.entryLegs.length; i++) {
      const leg = st.entryLegs[i]
      if (!leg.tpId || leg.tpDone) continue
      let s: Awaited<ReturnType<typeof fetchOrderStatus>>
      try { s = await fetchOrderStatus(leg.tpId) } catch (err) { this.log(e, `  leg ${i + 2} TP poll error: ${(err as Error).message}`); continue }
      if (!s.is_live && !s.is_cancelled && Number(s.executed_amount) > 0) {
        const amt = Number(s.executed_amount), px = Number(s.avg_execution_price)
        st.realizedUsd += (px - st.entryPrice!) * amt
        const fee = await feeUsdForOrder(spec.symbol, leg.tpId)
        st.feeUsd = (st.feeUsd ?? 0) + fee       // reference only — realizedUsd stays fee-free
        this.log(e, `  ✓ Leg ${i + 2} TP filled: ${amt} @ $${px} — realized now ~$${st.realizedUsd.toFixed(2)}`)
        leg.tpId = null; leg.tpDone = true
        this.persistBracket(e.status.id, step); this.notify()
      } else if (s.is_cancelled) {
        leg.tpId = null; leg.tpDone = true
      }
    }
  }

  /** Cancels any exit legs still resting past their deadline (called right before a
   *  full/final exit finalizes to 'flat'). */
  private async cancelStaleExitLegs(e: PlanEntry, st: BracketState): Promise<void> {
    if (!st.exitLegs?.length) return
    for (let i = 0; i < st.exitLegs.length; i++) {
      const leg = st.exitLegs[i]
      if (!leg.filled && !leg.cancelled && leg.orderId) {
        try { await this.cancelOrder(leg.orderId) }
        catch (err) { this.log(e, `  ⚠ Exit leg ${i + 2} cancel may have failed: ${(err as Error).message}`) }
        leg.cancelled = true
        this.log(e, `  ⏹ Exit leg ${i + 2} unfilled past deadline — cancelled`)
      }
    }
  }

  private async finalizeBracket(e: PlanEntry, step: AutoStep, spec: BracketSpec, reason: string): Promise<void> {
    const st = step.bracketState!
    st.phase = 'exiting'
    await this.cancelBracketOrders(st)
    st.stopId = st.tp1Id = st.tp2Id = null
    await sleep(1_500) // let Gemini release locked balance before selling
    const base = spec.symbol.replace('USD', '')
    const available = await fetchCurrencyBalance(base)
    const snap = cryptoHub.getSnapshot()
    const last = Number(snap.tickers.find((t) => t.symbol === spec.symbol)?.last ?? '0')
    // Sell only what this bracket is holding, clamped by what is actually free.
    // Selling the raw balance here liquidated any long-term holding of the same
    // coin the moment a $10 bracket hit its time-stop — see bracketPosition().
    const toSell = this.bracketPosition(st, available)
    if (toSell * last >= 1) {
      const r = await this.sellToUsd(spec.symbol, toSell)
      if (st.entryPrice) st.realizedUsd += (r.avgPrice - st.entryPrice) * r.filled
      st.feeUsd = (st.feeUsd ?? 0) + r.feeUsd    // exit-side fee, reference only
    }
    st.phase = 'flat'
    const feeNote = (st.feeUsd ?? 0) > 0 ? ` ($${(st.feeUsd ?? 0).toFixed(2)} fees paid, not deducted)` : ''
    st.note = `Closed (${reason}). Realized ~$${st.realizedUsd.toFixed(2)}${feeNote}`
    step.status = 'filled'
    this.log(e, `  ✅ Bracket closed (${reason}). Realized ~$${st.realizedUsd.toFixed(2)}${feeNote} → banked to USD`)
    cryptoToast(
      `${spec.symbol.replace('USD', '')} position closed`,
      `${reason} · realized ~$${st.realizedUsd.toFixed(2)}${feeNote}`,
      st.realizedUsd >= 0 ? 'notice' : 'warn',
      st.realizedUsd >= 0 ? 'ti-trending-up' : 'ti-trending-down'
    )
    appendClosedTrade(buildClosedTrade(step, reason, Date.now()))
    this.clearPersistedBracket(e.status.id)
    this.notify()
  }

  private async monitorBracket(e: PlanEntry, step: AutoStep, spec: BracketSpec, myRunId: number): Promise<void> {
    const st = step.bracketState!
    const sym = spec.symbol
    const base = sym.replace('USD', '')
    this.log(e, `  👁 Monitoring bracket ${sym} — phase ${st.phase}`)
    while (!e.aborted && e.runId === myRunId) {
      await sleep(20_000)
      // One transient Gemini timeout must NOT kill the whole bracket. Guard the entire
      // poll cycle so a failed balance/order/price call just logs and retries on the next
      // tick — the protective stop stays resting on the exchange and monitoring stays alive.
      // (The inner stop/TP polls already swallow their own errors; this backstops every
      // other await in the cycle: fetchCurrencyTotal, placeStop, placeRestingSell, etc.)
      try {
      const snap = cryptoHub.getSnapshot()
      const last = Number(snap.tickers.find((t) => t.symbol === sym)?.last ?? '0')
      if (!last) continue

      // Staged exit legs (spec.exitLegs) and per-leg entry TPs (entryLegs[].tpId) each fill
      // independently of the primary tp1Id order — credit both before evaluating exits.
      await this.pollExitLegs(e, st, spec)
      await this.pollLegTps(e, step, spec)

      // Did the resting stop fill? (stopped out)
      if (st.stopId) {
        const stopId = st.stopId
        try {
          const ss = await fetchOrderStatus(stopId)
          if (!ss.is_live && !ss.is_cancelled && Number(ss.executed_amount) > 0) {
            this.log(e, `  🛑 Stopped out @ ~$${ss.avg_execution_price}`)
            if (st.entryPrice) st.realizedUsd += (Number(ss.avg_execution_price) - st.entryPrice) * Number(ss.executed_amount)
            const stopFee = await feeUsdForOrder(sym, stopId)  // exit-side fee, from filled-order records
            st.feeUsd = (st.feeUsd ?? 0) + stopFee  // reference only — realizedUsd stays fee-free
            st.stopId = null
            await this.finalizeBracket(e, step, spec, 'stopped out')
            return
          }
          if (ss.is_cancelled) st.stopId = null
        } catch { /* keep last known */ }
      }

      // Did a resting TP/time-stop exit limit fill? (tp1Id doubles as "the one pending
      // exit order" — a TP1 partial while phase is 'protected', or a full close while
      // phase is 'exiting'. Never an IOC fill: this only ever resolves a GTC limit that
      // was resting on the book.)
      if (st.tp1Id) {
        const tp1Id = st.tp1Id
        try {
          const es = await fetchOrderStatus(tp1Id)
          if (!es.is_live && !es.is_cancelled && Number(es.executed_amount) > 0) {
            const filled = Number(es.executed_amount)
            const avgPrice = Number(es.avg_execution_price) || last
            st.realizedUsd += (avgPrice - st.entryPrice!) * filled
            const tpFee = await feeUsdForOrder(sym, tp1Id)  // exit-side fee, from filled-order records
            st.feeUsd = (st.feeUsd ?? 0) + tpFee    // reference only — realizedUsd stays fee-free
            st.tp1Id = null
            // A full-exit resting TP (tpFirst) or an 'exiting'-phase exit closes the
            // whole position — there is no runner to protect. If staged exit legs are
            // still resting above this price, give them until their deadline before
            // finalizing, so a higher leg can still bank more than the primary price.
            if (st.phase === 'exiting' || this.tpFirstEligible(spec)) {
              if (!this.exitLegsSettled(st) && st.exitLegsDeadline && Date.now() < st.exitLegsDeadline) {
                st.phase = 'exiting'
                st.note = `Primary exit filled @ $${avgPrice.toFixed(6)}; waiting on staged leg(s) above it`
                this.persistBracket(e.status.id, step); this.notify()
                continue
              }
              // Independent per-leg entry TPs each hold their own coins — the primary filling
              // must NOT cancel them. Only finalize once the ACTUAL balance is gone; while a
              // leg TP still holds coins, keep monitoring (they stay resting) and let the
              // held-balance check / position time-stop close things out.
              const legTpsResting = (st.entryLegs ?? []).some((l) => l.tpId)
              if (legTpsResting) {
                // Clamped to this bracket's own position for the same reason as the
                // monitor loop: a long-term holding of the coin is not ours to sell.
                const heldAfter = this.bracketPosition(st, await fetchCurrencyTotal(base))
                if (heldAfter * last >= 1) {
                  st.phase = 'exiting'
                  st.positionAmount = heldAfter
                  st.note = `Primary TP filled @ $${avgPrice.toFixed(6)}; ${heldAfter.toFixed(6)} ${base} still resting on per-leg TP(s)`
                  this.persistBracket(e.status.id, step); this.notify()
                  continue
                }
              }
              await this.cancelStaleExitLegs(e, st)
              st.phase = 'flat'
              st.note = `Closed via resting limit @ $${avgPrice.toFixed(6)}. Realized ~$${st.realizedUsd.toFixed(2)}`
              step.status = 'filled'
              this.log(e, `  ✅ Bracket closed via resting limit @ $${avgPrice.toFixed(6)}. Realized ~$${st.realizedUsd.toFixed(2)} → banked to USD`)
              cryptoToast(
                `${spec.symbol.replace('USD', '')} position closed`,
                `target hit @ $${avgPrice.toFixed(6)} · realized ~$${st.realizedUsd.toFixed(2)}`,
                st.realizedUsd >= 0 ? 'notice' : 'warn',
                st.realizedUsd >= 0 ? 'ti-trending-up' : 'ti-trending-down'
              )
              appendClosedTrade(buildClosedTrade(step, `target hit @ $${avgPrice.toFixed(6)}`, Date.now()))
              this.clearPersistedBracket(e.status.id); this.notify()
              return
            }
            st.phase = 'tp1_filled'
            st.note = `TP1 filled ${filled} @ $${avgPrice.toFixed(6)} (resting limit, not a market fill)`
            cryptoToast(
              `${spec.symbol.replace('USD', '')} TP1 hit`,
              `sold ${filled} @ $${avgPrice.toFixed(6)} · stop moves to break-even`,
              'info', 'ti-target-arrow'
            )
            this.persistBracket(e.status.id, step); this.notify()
          } else if (es.is_cancelled) {
            st.tp1Id = null // fell through externally — will be re-evaluated below
          } else {
            // Still resting on the book — leave it; don't re-trigger the same exit twice.
            // Exception: a full close ('exiting') that the market has already run past would
            // otherwise fill at a stale, cheaper price once it catches up. Chase it up instead —
            // reprice the resting sell to just above spot every ~20s (this loop's own cadence)
            // for as long as price keeps climbing past it. Never chases DOWN, so a pullback just
            // leaves the last (highest) resting price in place.
            if (st.phase === 'exiting') {
              // `es` was fetched for this order moments ago, so its price/remaining_amount
              // are authoritative. Re-placing must use remaining_amount, never the original
              // size — a partially-filled exit would otherwise try to oversell.
              const restPrice = Number(es.price)
              const remaining = Number(es.remaining_amount)
              if (restPrice > 0 && remaining > 0 && last > restPrice) {
                const chased = (last * 1.0003).toFixed(6)
                const r = await this.repriceRestingSell(sym, tp1Id, es.remaining_amount, chased)
                if (r.ok) {
                  st.tp1Id = r.newOrderId
                  st.tpTargetPrice = Number(chased)
                  st.note = `Chasing exit up — resting sell now $${chased} (market ran past old price)`
                  this.log(e, `  📈 Market ran past resting exit @ $${restPrice} — repriced to $${chased}`)
                  this.persistBracket(e.status.id, step); this.notify()
                  continue
                }
                if (r.reason === 'cancel-failed') {
                  // Old order still on the book — position stays covered. Leave st.tp1Id
                  // pointing at it and retry on the next pass.
                  this.log(e, `  ⚠ Exit chase skipped — cancel failed (${r.error}); order still resting @ $${restPrice}`)
                } else {
                  // Cancelled but not replaced: the position is uncovered RIGHT NOW. Drop the
                  // dead id and fall through (no `continue`) so this same iteration reaches
                  // the "final target hit" re-place below — which fires because we only chase
                  // when last has run past the exit, so last >= finalTp holds.
                  st.tp1Id = null
                  this.log(e, `  🚨 Exit chase left position UNCOVERED — cancelled @ $${restPrice} but replace failed (${r.error}); re-placing now`)
                  cryptoToast(
                    `${base} exit order cancelled but NOT replaced`,
                    `${r.error} — position is uncovered; the monitor is re-placing it`,
                    'critical', 'ti-alert-triangle'
                  )
                  this.persistBracket(e.status.id, step); this.notify()
                }
              }
            }
            // tpFirst: the TP rests immediately on fill, so the −stop and position
            // time-stop are MONITORED here. If either fires, cancel the resting TP and
            // exit (the one case where a full-size stop and TP can't both rest at once).
            if (this.tpFirstEligible(spec) && st.phase === 'protected') {
              const stopHit = st.stopPrice != null && last <= st.stopPrice
              const timedOut = st.filledAt != null && Date.now() - st.filledAt > spec.positionTimeStopMin * 60_000
              if (stopHit || timedOut) {
                const why = stopHit ? `stop $${st.stopPrice!.toFixed(6)} hit` : `time-stop ${spec.positionTimeStopMin}m`
                this.log(e, `  ⚠ tpFirst ${why} — cancelling resting TP(s) and exiting`)
                try { await this.cancelOrder(tp1Id) } catch { /* ignore */ }
                st.tp1Id = null
                // Also cancel any independent per-leg TPs — they lock part of the balance, so
                // the full-size force-exit below would otherwise be rejected for insufficient
                // funds (or double-sell). Their held coins fold into heldNow.
                for (const leg of st.entryLegs ?? []) {
                  if (leg.tpId) { try { await this.cancelOrder(leg.tpId) } catch { /* ignore */ } leg.tpId = null; leg.tpDone = true }
                }
                await sleep(1_500) // let Gemini release the balance locked by the TP(s)
                // This bracket's own position, clamped by the freed balance — not the
                // wallet total, which would force-exit unrelated holdings of the coin.
                const heldNow = this.bracketPosition(st, await fetchCurrencyTotal(base))
                if (stopHit) {
                  // Exit via a stop-limit at the trigger (crosses to fill); the stop-fill
                  // detection at the top of the loop then finalizes.
                  await this.placeStop(e, step, spec, st.stopPrice!, heldNow)
                  st.note = `tpFirst stop triggered — exiting near $${st.stopPrice!.toFixed(6)}`
                } else {
                  // Time-stop: rest a sell at the ask to bank whatever's there.
                  st.phase = 'exiting'
                  const askNow = Number(snap.tickers.find((t) => t.symbol === sym)?.ask ?? last)
                  st.tp1Id = await this.placeStagedExit(e, step, spec, sym, heldNow, askNow)
                  st.note = `tpFirst time-stop — exit limit resting @ $${askNow}`
                }
                this.persistBracket(e.status.id, step); this.notify()
                continue
              }
            }
            st.note = `Exit limit resting (not filled yet) @ current ask`
            this.persistBracket(e.status.id, step); this.notify()
            continue
          }
        } catch { /* keep last known, try again next cycle */ }
      }

      // Use TOTAL balance (incl. the amount locked in the resting stop) to judge whether
      // the position still exists — `available` is ~0 while protected and must not be
      // mistaken for a closed position.
      //
      // The balance CLAMPS this bracket's position; it does not define it. Assigning
      // `held` straight into positionAmount here is what let a bracket's exits reach
      // an unrelated long-term holding of the same coin — see bracketPosition().
      const held = await fetchCurrencyTotal(base)
      st.positionAmount = this.bracketPosition(st, held)
      // Everything below sizes and reports off THIS bracket's position, never the
      // wallet's balance of the coin. Named apart from `held` on purpose: the two
      // were the same identifier here, which is how the exits came to reach coins
      // the bracket never bought.
      const position = st.positionAmount
      if (position * last < 1) { await this.finalizeBracket(e, step, spec, 'position closed'); return }

      // Self-heal a MISSING take-profit on a stopless bracket: if we're holding coins that
      // aren't covered by any resting sell (primary tp1Id gone AND no per-leg TP), re-place
      // the TP at the stored (or freshly-derived) target. Covers a TP that failed to place or
      // was cancelled without replacement (e.g. an interrupted cancel/replace, a placement
      // error, or — sniper's case — a bracket that predates the noStop+tp2 fix below and was
      // never placed at all) — without this a stopless position could sit with no sell
      // resting, since the stop self-heal below is skipped when stopPct<=0. (WLD 2026-07-08
      // hit the tpFirst version of this; POL/WLD/FIL 2026-07-19/20 hit the tp2 scale-out
      // version — 3 consecutive sniper runs found live positions naked for hours.)
      const noStopScaleOut = spec.stopPct <= 0 && !!spec.tp2 && spec.tp1.sizeFraction < 1
      // tpFirst keeps its original phase window (anything but 'flat'); the new scale-out case
      // is scoped tighter, to 'protected' only, so it never fights the breakeven self-heal
      // just below once TP1 has actually filled ('tp1_filled').
      const tpFirstHeal = this.tpFirstEligible(spec) && st.phase !== 'flat'
      const scaleOutHeal = noStopScaleOut && st.phase === 'protected'
      if (spec.stopPct <= 0 && (tpFirstHeal || scaleOutHeal) && !st.tp1Id) {
        const targetPrice = st.tpTargetPrice ?? st.entryPrice! * (1 + spec.tp1.pricePct)
        const wantAmt = this.tpFirstEligible(spec) ? position : position * spec.tp1.sizeFraction
        const coveredByLegs = (st.entryLegs ?? []).reduce((s, l) => s + (l.tpId ? (l.filledAmount ?? 0) : 0), 0)
        const uncovered = Math.min(wantAmt, position) - coveredByLegs
        if (uncovered * last >= 1) {
          st.tpTargetPrice = targetPrice
          st.tp1Id = await this.adoptOrPlaceTp1Sell(sym, uncovered, targetPrice)
          if (st.tp1Id) this.log(e, `  🩹 Self-heal: re-placed (or adopted) missing TP — resting sell ${uncovered.toFixed(6)} ${base} @ $${targetPrice.toFixed(6)}`)
          else this.log(e, `  ⚠ Self-heal TP placement failed — ${uncovered.toFixed(6)} ${base} still uncovered; will retry next tick`)
          this.persistBracket(e.status.id, step); this.notify()
        }
      }

      // Self-heal: once TP1 has actually filled on a noStop+tp2 (sniper) bracket, the
      // remainder needs a real stop or it rides completely unprotected forever — spec.tp2
      // disables the generic stop self-heal further below (it only fires for stopPct>0).
      // breakEvenAfterTp1 mandates the stop moves to entry the instant TP1 fills; this is
      // what actually places that stop the first time (the organic same-tick path at the
      // "Scale-out at TP1" trigger below only fires when tp1Id was still null going in, which
      // it no longer is once the fix above starts pre-placing TP1 on fill).
      if (noStopScaleOut && spec.breakEvenAfterTp1 && st.phase === 'tp1_filled' && !st.stopId && !st.tp1Id) {
        await this.placeStop(e, step, spec, st.entryPrice!, position)
        st.note = `TP1 banked — remainder ${position.toFixed(6)} ${base} now stopped at breakeven $${st.entryPrice!.toFixed(6)}`
        this.persistBracket(e.status.id, step); this.notify()
      }

      // Self-heal: ensure a protective stop exists while holding (and no exit is pending).
      // Skipped entirely when stopPct <= 0 (fast-cash take-profit-only mode — no stop ever).
      if (spec.stopPct > 0 && !st.stopId && !st.tp1Id && st.phase !== 'exiting') {
        const trig = st.stopPrice ?? st.entryPrice! * (1 - spec.stopPct)
        await this.placeStop(e, step, spec, trig, position)
      }

      if (st.highWater === null || last > st.highWater) st.highWater = last

      const entry = st.entryPrice!
      const tp1Price = entry * (1 + spec.tp1.pricePct)
      const finalTp = spec.tp2 ? entry * (1 + spec.tp2.pricePct) : tp1Price
      const ask = Number(snap.tickers.find((t) => t.symbol === sym)?.ask ?? last)

      // ── Locked: user has frozen this trade — skip every discretionary "move" below
      //    (scale-out, final exit, trailing ratchet, time-stop) but keep monitoring for
      //    fills and let the self-heal above keep the protective stop resting. ──
      if (st.locked) {
        st.note = `🔒 Locked — holding ${position.toFixed(6)} ${base} @ $${last} | stop $${st.stopPrice?.toFixed(6) ?? '—'}`
        this.persistBracket(e.status.id, step); this.notify()
        continue
      }

      // ── Scale-out at TP1 — a genuine resting limit, sized so the stop can stay live
      //    on the remainder the whole time (no naked window on the runner). ──
      if (!st.tp1Id && st.phase === 'protected' && spec.tp2 && last >= tp1Price) {
        const sellAmt = position * spec.tp1.sizeFraction
        const remainderAmt = position - sellAmt
        this.log(e, `  🎯 TP1 trigger hit ($${last} ≥ $${tp1Price.toFixed(6)}) — placing resting limit sell @ ask $${ask} (never crosses the spread)`)
        // The stop is locking the coins this scale-out needs. If it won't cancel, do nothing
        // this tick — placing the TP1 sell anyway would fail on locked balance, and placing a
        // replacement stop on top of the live one is the duplication bug.
        if (!await this.cancelStop(st)) {
          this.log(e, `  ⚠ TP1 scale-out deferred — stop cancel failed; retrying next tick (position still protected)`)
          this.persistBracket(e.status.id, step); this.notify()
          continue
        }
        if (remainderAmt * last >= 1) {
          const newStop = spec.breakEvenAfterTp1 ? Math.max(entry, st.stopPrice ?? 0) : (st.stopPrice ?? entry * (1 - spec.stopPct))
          await this.placeStop(e, step, spec, newStop, remainderAmt)
        }
        st.tp1Id = await this.placeRestingSell(sym, sellAmt, ask)
        st.note = `TP1 limit resting @ $${ask} for ${sellAmt.toFixed(6)} ${base}`
        this.persistBracket(e.status.id, step); this.notify()
        continue
      }

      // ── Full exit at final target — resting limit for the whole remaining position ──
      if (!st.tp1Id && last >= finalTp) {
        this.log(e, `  🏁 Final target hit ($${last} ≥ $${finalTp.toFixed(6)}) — placing resting limit sell @ ask $${ask} for the remainder`)
        if (!await this.cancelStop(st)) {
          this.log(e, `  ⚠ Final-target exit deferred — stop cancel failed; retrying next tick (position still protected)`)
          this.persistBracket(e.status.id, step); this.notify()
          continue
        }
        st.phase = 'exiting'
        st.tp1Id = await this.placeStagedExit(e, step, spec, sym, position, ask)
        st.note = `Final-target limit resting @ $${ask} for ${position.toFixed(6)} ${base}`
        this.persistBracket(e.status.id, step); this.notify()
        continue
      }

      // ── Trailing stop (ratchet up only) ──
      if (spec.trailPct && st.highWater) {
        const desired = st.highWater * (1 - spec.trailPct)
        if (st.stopPrice !== null && desired > st.stopPrice * 1.001 && desired < last) {
          this.log(e, `  ↗ Trailing stop: $${st.stopPrice.toFixed(6)} → $${desired.toFixed(6)}`)
          // Only ratchet when the old stop is confirmed off the book. A failed cancel leaves
          // it resting and still protecting; replacing it blind is what stacked duplicates.
          if (await this.cancelStop(st)) await this.placeStop(e, step, spec, desired, position)
          else this.log(e, `  ⚠ Trail ratchet deferred — stop cancel failed; old stop still resting, retrying next tick`)
        }
      }

      // ── Position time-stop → resting-limit exit for the remainder (still not a market
      //    fill — this is now a "soft" deadline: it places a real limit at the ask and
      //    waits, so it can outlive the nominal time-stop if the book doesn't come to it) ──
      if (!st.tp1Id && st.filledAt && Date.now() - st.filledAt > spec.positionTimeStopMin * 60_000) {
        this.log(e, `  ⏰ Position time-stop (${spec.positionTimeStopMin}m) — placing resting limit sell @ ask $${ask} for the remainder`)
        if (!await this.cancelStop(st)) {
          this.log(e, `  ⚠ Time-stop exit deferred — stop cancel failed; retrying next tick (position still protected)`)
          this.persistBracket(e.status.id, step); this.notify()
          continue
        }
        st.phase = 'exiting'
        st.tp1Id = await this.placeStagedExit(e, step, spec, sym, position, ask)
        st.note = `Time-stop limit resting @ $${ask} for ${position.toFixed(6)} ${base}`
        this.persistBracket(e.status.id, step); this.notify()
        continue
      }

      st.note = `Holding ${position.toFixed(6)} ${base} @ $${last} | stop $${st.stopPrice?.toFixed(6) ?? '—'} | HWM $${st.highWater?.toFixed(6) ?? '—'}`
      this.persistBracket(e.status.id, step); this.notify()
      } catch (err) {
        // Transient API/network error mid-cycle — the resting protective stop is untouched.
        // Log and let the loop retry on the next 20s tick instead of failing the bracket.
        this.log(e, `  ⚠ Monitor cycle error (protective stop still resting; retrying next poll): ${(err as Error).message}`)
      }
    }
  }

  /** On boot, re-attach monitoring to EVERY in-flight bracket (reconciles each against
   *  Gemini) — not just one, so multiple concurrent brackets all survive a restart. */
  async resumeBracketIfAny(): Promise<void> {
    const brackets = loadActiveBrackets()
    this.persistedBrackets = { ...brackets }
    let resumed = 0
    for (const [id, step] of Object.entries(brackets)) {
      const ph = step.bracketState?.phase
      if (!ph || ph === 'flat' || ph === 'aborted') { delete this.persistedBrackets[id]; continue }
      // Clear any stale failure from the pre-restart run — runBracket re-attaches cleanly and
      // sets status='executing'; a lingering error string would misreport a healthy bracket.
      step.error = undefined
      const e = this.entry(id)
      e.aborted = false
      e.runId++
      const rid = e.runId
      e.status = {
        id, active: true, isProposed: false, proposedAt: null,
        proposedLabel: `Resumed bracket ${step.bracket?.symbol}`,
        startedAt: Date.now(), currentStepIndex: 0, steps: [step], log: e.status.log,
      }
      this.log(e, `♻ Resuming managed bracket ${step.bracket?.symbol} from phase ${ph}`)
      resumed++
      void this.runBracket(e, step, rid).then(() => {
        if (e.runId === rid) { e.status.active = false; this.notify() }
      })
    }
    saveActiveBrackets(this.persistedBrackets)
    if (resumed > 0) console.log(`[crypto] resumed ${resumed} managed bracket(s)${resumed > 1 ? ' concurrently' : ''}`)
  }

  /** Watchdog: a managed bracket whose monitor loop died on an unexpected error is left
   *  status='failed' while its protective stop is STILL resting on the exchange and its
   *  phase is still live (protected / tp1_filled / exiting). Re-attach the monitor so
   *  trailing + take-profit management resume — runBracket reconciles against the live stop
   *  (stopId already set ⇒ it reconnects instead of double-placing). Cheap and idempotent:
   *  only acts on a stalled bracket, and once revived (active=true) it's skipped. Called on
   *  every refresh tick so recovery happens within ~30s without a server restart. */
  reviveStalledBrackets(): number {
    let revived = 0
    for (const e of this.plans.values()) {
      const steps = e.status.steps
      const step = steps.length === 1 && steps[0]?.kind === 'bracket' ? steps[0] : undefined
      const ph = step?.bracketState?.phase
      const live = ph === 'protected' || ph === 'tp1_filled' || ph === 'exiting'
      if (!step || e.status.active || step.status !== 'failed' || !live) continue
      e.aborted = false
      e.runId++
      const rid = e.runId
      step.status = 'executing'
      step.error = undefined
      e.status.active = true
      this.log(e, `♻ Auto-reviving stalled bracket ${step.bracket?.symbol} (phase ${ph}) — monitor died on a transient error; protective stop still resting`)
      revived++
      void this.runBracket(e, step, rid).then(() => {
        if (e.runId === rid) { e.status.active = false; this.notify() }
      })
    }
    if (revived) this.notify()
    return revived
  }

  /** On boot, restore staged proposals and re-attach EVERY in-flight non-bracket plan (the
   *  BTC ladder + any sequential autoplan). Executing plans reconcile against Gemini: a step
   *  still 'monitoring' reconnects to its resting order; one caught mid-place (no confirmed
   *  order id) rewinds to 'pending' so it re-places cleanly. Runs after resumeBracketIfAny. */
  async resumePlansIfAny(): Promise<void> {
    const saved = loadActivePlans()
    let proposals = 0, active = 0
    for (const [id, st] of Object.entries(saved)) {
      // An ACTIVE bracket is owned by resumeBracketIfAny (active-bracket.json) — skip it so
      // we don't double-resume. A PROPOSED bracket, though, is now mirrored to active-plans
      // and is restored below via the generic isProposed branch (no execution to resume).
      if (st.steps.length === 1 && st.steps[0]?.kind === 'bracket' && st.active) continue
      const e = this.entry(id)

      if (st.isProposed && !st.active) {
        e.status = { ...st, active: false, isProposed: true }
        this.log(e, `♻ Restored staged proposal: ${st.proposedLabel || id}`)
        proposals++
        continue
      }

      if (st.active) {
        // A step interrupted mid-placement never got a confirmed order id — rewind it so the
        // resumed run re-places it rather than re-attaching to nothing.
        for (const s of st.steps) if (s.status === 'executing' && !s.geminiOrderId) s.status = 'pending'
        e.status = { ...st }
        e.aborted = false
        e.runId++
        const rid = e.runId
        this.log(e, `♻ Resuming plan ${id} — reconciling resting orders`)
        active++
        void this.run(id, rid).then(() => { if (e.runId === rid) { e.status.active = false; this.notify() } })
      }
    }
    if (proposals || active) console.log(`[crypto] restored ${proposals} staged + resumed ${active} active non-bracket plan(s)`)
  }

  // ── BTC ladder invariant ────────────────────────────────────────────────
  /** A BTC buy step that closes a ladder sell (a "buy-back"), vs an independent dip-buy.
   *  True when it's paired with a BTC sell in the same plan, or labelled as a rebuy. */
  /** Is this BTCUSD step the ladder's, for ledger purposes?
   *
   *  An UNTAGGED step counts as the ladder's: today the ladder is run from crypto-strategy /
   *  firecracker prose and carries no tag, so requiring the tag outright would stop recording
   *  cycles entirely and silently break the "every sell has a lower buy" invariant. Only a step
   *  explicitly tagged to some OTHER strategy is excluded — which is exactly the case that
   *  needs excluding, because a tagged alt strategy taking profit on BTC would otherwise open a
   *  phantom cycle and the reconciler would auto-stage a real-money buy-back against it. */
  private isLadderOwned(step: AutoStep): boolean {
    return !step.strategy || step.strategy === 'btc-ladder'
  }

  /** A ladder BTC sell that is an INTENTIONAL scale-out to USD dry powder (no paired rebuy),
   *  vs a normal round-trip slice. Detected by the mandated label/reason marker — same
   *  label-regex approach as isBtcRebuyStep. The skill doc requires the "SCALE-OUT" marker on
   *  the sell step; without it a lone sell is treated as a (broken) round-trip and alerts, which
   *  is the correct safe default for any un-marked naked BTC sell. */
  private isBtcScaleOutSell(step: AutoStep): boolean {
    if (step.symbol !== 'BTCUSD' || step.side !== 'sell') return false
    if (!this.isLadderOwned(step)) return false
    return /scale[-\s]?out/i.test(`${step.reason} ${step.label}`)
  }

  private isBtcRebuyStep(step: AutoStep, allSteps: AutoStep[]): boolean {
    if (step.symbol !== 'BTCUSD' || step.side !== 'buy') return false
    if (!this.isLadderOwned(step)) return false
    const siblingSell = allSteps.some((s) => s !== step && s.symbol === 'BTCUSD' && s.side === 'sell')
    return siblingSell || /rebuy|buy[-\s]?back|ladder/i.test(`${step.reason} ${step.label}`)
  }

  /** The intended buy-back price for a ladder sell = the paired BTC buy step's limit, if any. */
  private siblingRebuyPrice(sellStep: AutoStep, allSteps: AutoStep[]): number | null {
    const buy = allSteps.find((s) => s !== sellStep && s.symbol === 'BTCUSD' && s.side === 'buy')
    const p = buy?.limitPrice ? Number(buy.limitPrice) : NaN
    return Number.isFinite(p) ? p : null
  }

  /** Called when any step fills: opens a ladder cycle for a BTC sell (persisted immediately,
   *  so a crash before the rebuy is placed still leaves a durable 'open' record), and closes
   *  the matching cycle when a BTC buy-back fills. */
  private onStepFilled(step: AutoStep, allSteps: AutoStep[]): void {
    if (step.symbol === 'BTCUSD' && step.side === 'sell' && this.isLadderOwned(step)) {
      const soldBtc = Number(step.filledAmount || 0)
      const price = Number(step.limitPrice || 0)
      if (soldBtc > 0 && price > 0) {
        const scaleOut = this.isBtcScaleOutSell(step)
        openBtcLadderCycle({
          soldAt: step.filledAt || Date.now(), soldBtc, soldUsd: soldBtc * price,
          // A scale-out demands no buy-back, so it carries no rebuy target and is never alerted on.
          soldPrice: price, rebuyPrice: scaleOut ? null : this.siblingRebuyPrice(step, allSteps),
          note: step.label, kind: scaleOut ? 'scaleout' : 'roundtrip',
        })
      }
    } else if (this.isBtcRebuyStep(step, allSteps)) {
      // Pass the order id so the close targets the cycle this order was actually linked to.
      closeBtcLadderCycle(Number(step.filledAmount || 0), step.filledAt || Date.now(), step.geminiOrderId)
    }
  }

  /** Looks for a BTC buy in trade history that already satisfies a not-yet-closed ladder
   *  cycle — the fix for the case where a rebuy order was placed (staged→resting, or even
   *  placed with the link never persisted) and then FILLED while the process was down or
   *  the plan was otherwise lost across a restart, so the normal fill-hook (isBtcRebuyStep →
   *  closeBtcLadderCycle) never ran. Without this, the cycle sits open/staged forever and
   *  the unhedged alert fires even though the buy-back genuinely happened on the exchange.
   *  Matches by orderId when the cycle already has one linked — that path is exact and is the
   *  one that should normally fire. The unlinked fallback is a GUESS and is deliberately narrow:
   *  price within ±1% of rebuyPrice and amount within ±15% of the sold slice. The old ±5%/±50%
   *  window was wide enough that the 07-03 cycle (rebuy target 61269) swallowed an unrelated
   *  62784.04 fill — 2.5% away at 0.615x size, inside both tolerances. A ladder rebuy is a limit
   *  order at a price we chose, so a genuine fill lands at-or-better by a hair, not 2.5% away.
   *  `usedOrderIds` prevents one fill closing two cycles in a pass; `claimedOrderIds` prevents it
   *  across passes. When nothing matches we leave the cycle open — a stale unhedged alert is
   *  cheap, a mis-paired cycle corrupts the accumulation ledger silently. */
  private async findBtcRebuyFill(
    c: BtcLadderCycle, trades: Awaited<ReturnType<typeof fetchMyTrades>>, usedOrderIds: Set<string>,
    claimedOrderIds: Set<string> = new Set(),
  ): Promise<{ orderId: string; amount: number; price: number; at: number } | null> {
    const buys = trades.filter((t) =>
      t.type === 'Buy' && t.timestampms > c.soldAt &&
      !usedOrderIds.has(t.order_id) &&
      // A fill already attributed to ANOTHER cycle is off-limits. `usedOrderIds` only covered
      // collisions within a single pass; a fill claimed on an earlier pass was still fair game,
      // which is how one buy came to close two cycles across restarts.
      !(claimedOrderIds.has(t.order_id) && t.order_id !== c.rebuyOrderId))
    const byOrder = new Map<string, { amount: number; notional: number; at: number }>()
    for (const t of buys) {
      const prev = byOrder.get(t.order_id) ?? { amount: 0, notional: 0, at: t.timestampms }
      prev.amount += Number(t.amount)
      prev.notional += Number(t.amount) * Number(t.price)
      prev.at = Math.max(prev.at, t.timestampms)
      byOrder.set(t.order_id, prev)
    }
    for (const [orderId, agg] of byOrder) {
      const avgPrice = agg.notional / agg.amount
      const linked = !!c.rebuyOrderId
      const priceOk = linked
        ? orderId === c.rebuyOrderId
        : c.rebuyPrice != null && Math.abs(avgPrice - c.rebuyPrice) / c.rebuyPrice < 0.01
      // A linked order id is proof of identity, so size is informational there (a partial fill
      // of OUR order is still ours). Unlinked, size is one of only two signals — keep it tight.
      const amountOk = linked || (agg.amount >= c.soldBtc * 0.85 && agg.amount <= c.soldBtc * 1.15)
      if (priceOk && amountOk) return { orderId, amount: agg.amount, price: avgPrice, at: agg.at }
    }
    return null
  }

  /** Verify the invariant "every BTC ladder sell has a resting buy-back below it" against the
   *  live order book. Returns alerts for the snapshot and AUTO-STAGES a confirm-first buy-back
   *  for any unhedged sell (never places an order itself). Call each full refresh. */
  async reconcileBtcLadder(openOrders: GeminiOpenOrder[], currentBtcPrice: number | null): Promise<BtcLadderAlert[]> {
    const cycles = loadBtcCycles()
    const liveBtcBuyIds = new Set(
      openOrders.filter((o) => o.symbol === 'BTCUSD' && o.side === 'buy').map((o) => o.orderId),
    )
    // Plans are keyed by symbol, so there is at most one BTCUSD plan — but once strategies
    // other than the ladder are allowed to trade BTC, that plan may not be the ladder's.
    // Distinguish the two: the ladder's own in-flight plan means "already staged, don't
    // double-stage", whereas someone else's means "the slot is occupied" — a very different
    // condition that must NOT be mistaken for the ladder having already acted, or a staged
    // cycle gets reopened and restaged on every pass.
    const btcEntry = this.plans.get('BTCUSD')
    const btcPlanLive = !!btcEntry && (btcEntry.status.active || btcEntry.status.isProposed)
    const btcPlanIsLadder = !btcEntry || btcEntry.status.steps.every((s) => this.isLadderOwned(s))
    const ladderPlanInFlight = btcPlanLive && btcPlanIsLadder
    const foreignPlanHoldsBtc = btcPlanLive && !btcPlanIsLadder
    // Anything that means "do not stage a new rebuy this pass".
    let blockStaging = btcPlanLive
    const alerts: BtcLadderAlert[] = []
    let changed = false

    // Adopt any resting BTCUSD buy order that isn't linked to a cycle — the invariant checker
    // below only trusts liveBtcBuyIds vs. cycle.rebuyOrderId, so an order that was placed but
    // whose link was lost (crash between placeOrder and linkBtcRebuyOrder, a failed cancel that
    // left the order live while the step moved on, restore gap, etc.) would otherwise sit
    // forgotten on the exchange while the tracker considers the BTCUSD slot free and stages a
    // BRAND NEW rebuy on top of it — this is what produced multiple simultaneous resting BTC
    // buys for old, already-abandoned ladder cycles. Reclaim orphans into the oldest open cycle
    // first, and refuse to stage a new rebuy while any orphan can't be reclaimed, rather than
    // let them accumulate silently.
    const linkedOrderIds = new Set(cycles.map((c) => c.rebuyOrderId).filter((id): id is string => !!id))
    const orphanOrderIds = [...liveBtcBuyIds].filter((id) => !linkedOrderIds.has(id))
    if (orphanOrderIds.length) {
      const openCycles = cycles.filter((c) => c.status === 'open' || c.status === 'staged').sort((a, b) => a.soldAt - b.soldAt)
      let unadoptedCount = 0
      for (const orphanId of orphanOrderIds) {
        const target = openCycles.shift()
        if (!target) { unadoptedCount++; continue }
        target.rebuyOrderId = orphanId
        target.status = 'resting'
        changed = true
        console.log('[crypto] 🟡 adopted orphaned resting BTC buy order into cycle', target.id, '→', orphanId)
      }
      if (unadoptedCount > 0) {
        console.warn('[crypto] ⚠ BTC ladder:', unadoptedCount, 'resting buy order(s) have no matching cycle to adopt into — holding off on staging a new rebuy until this is resolved manually')
        blockStaging = true // block new staging this pass; doesn't touch already-resting cycles
      }
    }
    if (changed) saveBtcCycles(cycles)

    // Fetch trade history once per pass (best-effort — a lookup failure just means this
    // pass falls back to the pre-existing open-orders-only check, not a crash).
    let trades: Awaited<ReturnType<typeof fetchMyTrades>> = []
    try { trades = await fetchMyTrades('BTCUSD', 200) } catch { /* best effort */ }
    const usedOrderIds = new Set<string>()
    // Every rebuy order id any cycle already owns — passed to findBtcRebuyFill so one fill can
    // never be attributed to a second cycle, including across restarts.
    const claimedOrderIds = new Set(
      cycles.map((c) => c.rebuyOrderId).filter((id): id is string => !!id),
    )

    for (const c of cycles) {
      if (c.status === 'closed') continue
      // A scale-out is a deliberate naked sell to USD dry powder — it demands no paired buy-back,
      // so it is never "unhedged", never alerts, and is never auto-staged a rebuy. It sits as a
      // durable ledger record until the skill redeploys the USD via the dip ladder.
      if (c.kind === 'scaleout') continue

      // A resting buy-back that vanished from the book leaves the sell unhedged again — but an
      // order also vanishes when it FILLS. Clearing rebuyOrderId here (as this used to, before
      // the trade-history check below ran) threw away the one piece of evidence that identifies
      // the fill exactly, forcing the fuzzy fallback to guess. So: note that it vanished, keep
      // the id, and let the reconciler below try the exact match FIRST. Only a cycle whose order
      // is genuinely gone-without-a-fill gets reopened, at the bottom of this block.
      const vanished = c.status === 'resting' && !(c.rebuyOrderId && liveBtcBuyIds.has(c.rebuyOrderId))
      if (c.status === 'resting' && !vanished) continue // invariant holds

      // A staged buy-back whose plan was dismissed/reset (nothing resting) reopens.
      // Keyed on the LADDER's plan specifically: a foreign plan occupying BTCUSD is not
      // evidence that our staged rebuy was dismissed, and treating it as such would reopen
      // the cycle for restaging on every pass.
      if (c.status === 'staged' && !ladderPlanInFlight) { c.status = 'open'; changed = true }

      // Before alerting/staging, check whether this cycle's buy-back already filled on the
      // exchange without the ledger catching it (lost plan across a restart, etc.).
      if (trades.length) {
        const fill = await this.findBtcRebuyFill(c, trades, usedOrderIds, claimedOrderIds)
        if (fill) {
          usedOrderIds.add(fill.orderId)
          c.status = 'closed'; c.rebuyOrderId = fill.orderId; c.boughtBtc = fill.amount; c.closedAt = fill.at
          c.note = `${c.note ?? ''} — reconciled from trade history: buy-back already filled (order ${fill.orderId}, ${fill.amount.toFixed(8)} BTC @ $${fill.price.toFixed(2)})`.trim()
          changed = true
          console.log('[crypto] ✅ BTC ladder cycle CLOSED via trade-history reconcile', c.id, `order ${fill.orderId}`)
          continue
        }
      }

      // Exact-match reconcile found nothing, so the vanished order really was cancelled (or
      // expired) rather than filled — NOW it's safe to drop the link and reopen as unhedged.
      if (vanished) {
        c.status = 'open'
        if (c.rebuyOrderId) claimedOrderIds.delete(c.rebuyOrderId)
        c.rebuyOrderId = null
        changed = true
        console.log('[crypto] 🔴 BTC ladder cycle reopened — buy-back left the book without filling:', c.id)
      }

      const rebuyPrice = c.rebuyPrice ?? (currentBtcPrice ? Number((currentBtcPrice * 0.98).toFixed(2)) : null)
      const netBtc = rebuyPrice ? c.soldUsd / rebuyPrice - c.soldBtc : 0
      alerts.push({
        cycleId: c.id, soldBtc: c.soldBtc, soldUsd: c.soldUsd, soldPrice: c.soldPrice, rebuyPrice, status: c.status,
        message: `${c.soldBtc.toFixed(8)} BTC ($${c.soldUsd.toFixed(2)}) sold @ $${c.soldPrice.toLocaleString()} has no resting buy-back`
          + (rebuyPrice ? ` — buy-back near $${rebuyPrice.toLocaleString()} (${netBtc >= 0 ? '+' : ''}${netBtc.toFixed(8)} BTC)` : '')
          // Say so out loud. An unhedged slice that CAN'T be hedged because another strategy is
          // holding the BTCUSD plan slot is the failure mode worth shouting about — silently
          // skipping the stage would leave the invariant broken with no visible cause.
          + (foreignPlanHoldsBtc && c.status === 'open'
            ? ` — ⚠ BLOCKED: the BTCUSD plan slot is held by "${btcEntry?.status.steps.find((s) => s.strategy)?.strategy ?? 'another strategy'}"`
              + `; stop that plan to let the ladder hedge this slice`
            : ''),
      })

      // Auto-stage a confirm-first buy-back for a genuinely open cycle. One BTCUSD plan at a
      // time — additional open cycles wait for the next pass once this one clears.
      if (c.status === 'open' && !blockStaging && rebuyPrice) {
        const step: AutoStep = {
          id: `rebuy_${c.id}`,
          label: `BTC LADDER-REBUY — buy back ${c.soldBtc.toFixed(8)} BTC sold @ $${c.soldPrice.toLocaleString()}`,
          symbol: 'BTCUSD', side: 'buy', type: 'limit',
          strategy: 'btc-ladder',
          amountSpec: `USD:${c.soldUsd.toFixed(2)}`, limitPrice: String(rebuyPrice),
          reason: `Auto-staged buy-back for ladder cycle ${c.id} — enforces "every BTC sell has a lower buy". `
            + `Nets ${netBtc >= 0 ? '+' : ''}${netBtc.toFixed(8)} BTC vs the slice sold if it fills.`,
          status: 'pending',
        }
        if (this.propose([step], step.label)) {
          c.status = 'staged'; blockStaging = true; changed = true
          console.log('[crypto] 🟠 auto-staged confirm-first BTC buy-back for cycle', c.id)
        }
      }
    }

    if (changed) saveBtcCycles(cycles)
    return alerts
  }

  // ── Auto-execute (opt-in autonomy, per-trade USD cap) ────────────────────
  getAutoExecute(): AutoExecuteConfig { return { ...this.autoExec } }

  setAutoExecute(patch: Partial<AutoExecuteConfig>): AutoExecuteConfig {
    if (typeof patch.enabled === 'boolean') this.autoExec.enabled = patch.enabled
    if (typeof patch.btcLadderMaxUsd === 'number' && patch.btcLadderMaxUsd > 0) this.autoExec.btcLadderMaxUsd = patch.btcLadderMaxUsd
    if (typeof patch.altMaxUsd === 'number' && patch.altMaxUsd > 0) this.autoExec.altMaxUsd = patch.altMaxUsd
    // Merged, not replaced, so a patch for one strategy can't clear the others.
    if (patch.perStrategy && typeof patch.perStrategy === 'object') {
      this.autoExec.perStrategy = { ...this.autoExec.perStrategy }
      for (const [id, on] of Object.entries(patch.perStrategy)) this.autoExec.perStrategy[id] = !!on
    }
    saveAutoExecute(this.autoExec)
    this.autoHeld.clear() // re-evaluate holds against the new setting on next pass
    console.log('[autoplan] auto-execute set:', JSON.stringify(this.autoExec))
    this.notify()
    return this.getAutoExecute()
  }

  /** USD notional of a single amountSpec. Infinity when it can't be bounded (ALL_USD,
   *  or a raw quantity with no known price) so the cap treats it as over-limit. */
  private specUsd(spec: string, symbol: string, priceOf: (symbol: string) => number | null): number {
    if (/^USD:/i.test(spec)) { const n = Number(spec.slice(4)); return Number.isFinite(n) ? n : Infinity }
    if (/ALL_USD/i.test(spec)) return Infinity
    const qty = Number(spec)
    if (!Number.isFinite(qty) || qty <= 0) return Infinity
    const price = priceOf(symbol)
    return price && price > 0 ? qty * price : Infinity
  }

  /**
   * Total USD this step commits, for the auto-execute cap.
   *
   * A staged bracket commits its primary entry AND every leg in `entry.legs` — they
   * are resting buy orders placed by the same plan, on the same symbol, and they
   * will all fill if price comes to them. Counting only the primary let a bracket
   * staged as USD:15 + two USD:15 legs ($45 of committed capital) pass a $20 cap
   * at $15 and auto-confirm with no human review. The cap is meant to bound what
   * the plan can spend without asking, so it has to sum what the plan can spend.
   */
  private stepUsd(step: AutoStep, priceOf: (symbol: string) => number | null): number {
    const entrySpec = step.amountSpec || step.bracket?.entry?.amountSpec || ''
    let total = this.specUsd(entrySpec, step.symbol, priceOf)
    for (const leg of step.bracket?.entry?.legs ?? []) {
      total += this.specUsd(String(leg.amountSpec || ''), step.symbol, priceOf)
    }
    return total
  }

  /** The per-trade cap that applies to a step: BTC ladder trades (BTCUSD) use the BTC cap,
   *  everything else uses the alt cap. */
  private capForStep(step: AutoStep): number {
    return step.symbol.toUpperCase() === 'BTCUSD' ? this.autoExec.btcLadderMaxUsd : this.autoExec.altMaxUsd
  }

  /** Is auto-execute live for one strategy? The master switch AND that strategy's own
   *  toggle must both allow it; an unset per-strategy flag means opted in. */
  autoExecuteEnabledFor(strategy: string | undefined): boolean {
    if (!this.autoExec.enabled) return false
    if (!strategy) return true   // unattributed plan — governed by the master switch alone
    return this.autoExec.perStrategy[strategy] !== false
  }

  /** When auto-execute is on, confirm each staged plan whose every approved trade is at or
   *  under ITS category cap (BTC ladder vs alt). Plans with any over-cap trade stay staged for
   *  manual review. A plan whose owning strategy has its individual toggle off is skipped
   *  entirely and stays staged for you. Reentrancy-guarded + idempotent — safe to call from
   *  onChange and refresh. */
  evaluateAutoExecute(priceOf: (symbol: string) => number | null): void {
    if (!this.autoExec.enabled || this.autoEvalRunning) return
    this.autoEvalRunning = true
    try {
      for (const [id, e] of this.plans) {
        const st = e.status
        if (!st.isProposed || st.active) continue
        const approved = st.steps.filter((s) => s.approved !== false)
        if (approved.length === 0) continue
        // Owning strategy = whichever staged these steps. Mixed/absent falls back to the
        // master switch so a plan can never slip through unattributed.
        const owner = approved.find((s) => s.strategy)?.strategy
        if (!this.autoExecuteEnabledFor(owner)) {
          if (!this.autoHeld.has(id)) {
            this.autoHeld.add(id)
            this.log(e, `⏸ Auto-execute OFF for ${owner ?? 'this strategy'} — staged for manual approval`)
          }
          continue
        }
        const over = approved.filter((s) => this.stepUsd(s, priceOf) > this.capForStep(s))
        if (over.length > 0) {
          if (!this.autoHeld.has(id)) {
            this.autoHeld.add(id)
            const which = over.map((s) => `${s.symbol} > $${this.capForStep(s)}`).join(', ')
            this.log(e, `⏸ Auto-execute HELD for manual approval — over cap: ${which}`)
          }
          continue
        }
        this.autoHeld.delete(id)
        this.log(e, `🤖 Auto-executing — all trades within cap (BTC ≤ $${this.autoExec.btcLadderMaxUsd}, alt ≤ $${this.autoExec.altMaxUsd})`)
        // Reached from the 30s refresh loop with no request behind it, so it is
        // recorded here explicitly: money moves and nobody pressed anything.
        auditLog.record({
          actor: 'system',
          origin: 'internal',
          action: 'plan.autoexecute',
          resource: `plan:${id}`,
          summary: `auto-executed ${approved.length} step(s) for ${owner ?? 'unattributed strategy'} — all within cap`,
          meta: {
            planId: id,
            strategy: owner ?? null,
            steps: approved.map((s) => ({ symbol: s.symbol, side: s.side, label: s.label, usd: this.stepUsd(s, priceOf) })),
            caps: { btcLadderMaxUsd: this.autoExec.btcLadderMaxUsd, altMaxUsd: this.autoExec.altMaxUsd },
          },
        })
        this.confirmProposal(id)
      }
    } finally {
      this.autoEvalRunning = false
    }
  }
}

export const autoPlanner = new AutoPlanner()

// ── Hub ────────────────────────────────────────────────────────────────

class CryptoHub {
  private snapshot: CryptoSnapshot = (() => {
    const { report, at } = loadPlanReport()
    return {
      tickers: [], holdings: [], signals: [], pending: loadPending(), openOrders: [], tradeHistory: [],
      intelReport: '', planReport: report, planReportAt: at,
      planReports: listArchivedPlanReports().slice(0, 10),
      lastRefresh: 0, connected: false,
      keysConfigured: !!(process.env['GEMINI_API_KEY'] && process.env['GEMINI_API_SECRET']),
      seedProgress: { total: 0, seeded: 0, active: false },
      autoPlans: autoPlanner.getAllStatuses(),
      strategyExposure: {},
      btcLadderAlerts: [],
      btcLadderCycles: loadBtcCycles().filter((c) => c.status !== 'closed'),
      autoExecute: autoPlanner.getAutoExecute(),
      portfolioGrowth: null,
      safeMode: loadSafeMode(),
      loopMode: loadLoopMode(),
      strategyIntervalMin: loadStrategyInterval(),
      strategyIntervals: loadStrategyIntervals(),
      feeRates: { maker: 0.002, taker: 0.004, blended: 0.003, samples: 0 },
      cmcData: [],
    }
  })()
  private trades: TradeRecord[] = loadTrades()
  // Last-good Gemini fills per symbol. A per-cycle fetch that fails/rate-limits for a
  // symbol keeps this symbol's prior fills instead of dropping them — so a transient
  // miss never erases a coin's history from the TRADES tab.
  private tradeHistoryBySymbol = new Map<string, GeminiTrade[]>()
  private safeModeFiring = new Set<string>()
  // Orders the user explicitly disarmed — excluded from default-on auto-arm.
  private safeModeOptOut = new Set<string>(loadSafeModeOptOut())
  // Loop mode: number of held bracket positions seen last poll, and a pending fire timer.
  private prevPositionCount = 0
  private loopTimer: NodeJS.Timeout | null = null
  // Interval timer: recurring auto-run of the enabled strategy every N minutes (0 = off).
  // Goes inert (never armed) once any per-strategy interval below is set.
  private intervalTimer: NodeJS.Timeout | null = null
  // Per-strategy interval timers — each strategy can carry its own independent cadence.
  private perStrategyTimers = new Map<string, NodeJS.Timeout>()
  // A run requested while another is already in flight waits here instead of being
  // dropped; drained by queueDrainTimer the moment strategyRunner goes idle.
  private scheduledQueue: StrategyId[] = []
  private queueDrainTimer: NodeJS.Timeout | null = null
  private listeners = new Set<(snap: CryptoSnapshot) => void>()
  private symbols: string[] = []
  // Cross-exchange volume cross-check (CMC) — refreshed on the tickerRefresh cadence,
  // internally cached ~3min by fetchCmcVolumes so this doesn't burn the free-tier
  // credit budget. Empty map when CMC_API_KEY isn't configured (safe no-op fallback).
  private cmcVolumes = new Map<string, CmcVolumeRead>()
  private refreshTimer: NodeJS.Timeout | null = null
  private hotTimer: NodeJS.Timeout | null = null
  private hotRefreshing = false
  private cacheSaveTimer: NodeJS.Timeout | null = null
  private seedCursor = 0

  subscribe(cb: (snap: CryptoSnapshot) => void): () => void {
    this.listeners.add(cb)
    cb(this.snapshot)
    return () => this.listeners.delete(cb)
  }

  private broadcast(): void {
    for (const cb of this.listeners) cb(this.snapshot)
  }

  getSnapshot(): CryptoSnapshot { return this.snapshot }

  /** The lean slice the always-mounted BRIDGE widgets poll every 6s (see
   *  CryptoPositionsSnapshot). Tickers are narrowed to the symbols an open plan or a
   *  resting order actually references — that's all the P&L math needs — which keeps
   *  this a few KB instead of dragging signals/tradeHistory/planReports along. */
  getPositionsSnapshot(): CryptoPositionsSnapshot {
    const symbols = new Set<string>()
    for (const plan of this.snapshot.autoPlans) {
      for (const step of plan.steps) symbols.add(step.symbol)
    }
    for (const o of this.snapshot.openOrders) symbols.add(o.symbol)
    return {
      tickers: this.snapshot.tickers.filter((t) => symbols.has(t.symbol)),
      openOrders: this.snapshot.openOrders,
      autoPlans: this.snapshot.autoPlans,
      lastRefresh: this.snapshot.lastRefresh,
      connected: this.snapshot.connected,
    }
  }

  getTrades(): TradeRecord[] { return this.trades }
  /** Closed-trade ledger (realized round-trips) + win-rate summary split by source
   *  (real banked vs backfilled paper), newest last. */
  getClosedTrades(): { trades: ClosedTrade[]; stats: ClosedTradeReport } {
    // Read-only display path: a corrupt ledger degrades to empty here rather than
    // failing the API call. The write path deliberately does NOT (see loadClosedTrades).
    const trades = loadClosedTradesSafe()
    return { trades, stats: computeClosedTradeReport(trades) }
  }
  getCandles(symbol: string, tf: Timeframe): Candle[] {
    return candleCache.get(symbol.toUpperCase())?.[tf] ?? []
  }

  /** Market cap in USD by BASE symbol ("BTC", not "BTCUSD"), from the CMC read.
   *  Empty when CMC_API_KEY is unset — the SCREENERS market-cap gate treats an
   *  absent cap as "unknown" and stands aside rather than failing every symbol. */
  getMarketCaps(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [base, read] of this.cmcVolumes.entries()) {
      if (typeof read.marketCap === 'number' && Number.isFinite(read.marketCap)) {
        out.set(base.toUpperCase(), read.marketCap)
      }
    }
    return out
  }

  /** Cross-exchange 24h USD volume by BASE symbol, from the CMC read. The SCREENERS
   *  volume gate runs on this rather than Gemini's own book: Gemini is one thin venue,
   *  and a coin can be liquid market-wide while barely printing here. Empty when
   *  CMC_API_KEY is unset — the gate degrades to ANY, same as market cap. */
  getCmcVolumes(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [base, read] of this.cmcVolumes.entries()) {
      if (typeof read.volume24h === 'number' && Number.isFinite(read.volume24h)) {
        out.set(base.toUpperCase(), read.volume24h)
      }
    }
    return out
  }

  /** Feed the alert engine from this snapshot. A staging alert routes through
   *  addPending(), so an alert-triggered order still waits for the user's
   *  confirmation in TRADES — alerts observe and propose, they never send. */
  private evaluateAlerts(): void {
    const priceOf = (symbol: string): number | null => {
      const t = this.snapshot.tickers.find((x) => x.symbol === symbol.toUpperCase())
      const p = t ? Number(t.last) : NaN
      return Number.isFinite(p) && p > 0 ? p : null
    }
    alertStore.evaluate({
      candles: (symbol, tf) => this.getCandles(symbol, tf as Timeframe),
      lastPrice: priceOf,
      signal: (symbol) => {
        const s = this.snapshot.signals.find((x) => x.symbol === symbol.toUpperCase())
        if (!s || !s.seeded) return null
        return { direction: s.direction, entryQuality: s.entryQuality, confluence: s.confluence }
      },
      stage: ({ symbol, side, usd, reason, tag }) => {
        const price = priceOf(symbol)
        if (price === null) return   // no live price: skip staging rather than guess a size
        this.addPending({
          symbol, side, type: 'market',
          amount: (usd / price).toFixed(8),
          reason, tag,
        })
      },
      notify: (head, sub) => cryptoToast(head, sub, 'notice', 'ti-bell'),
    })
  }

  /** On-demand fresh candles for a single symbol+tf. Refetches from Gemini
   *  (throttled) so an open chart stays live regardless of seed age. */
  async getCandlesFresh(symbol: string, tf: string): Promise<Candle[]> {
    // Validate before the string reaches a URL or the cache. refreshCandle
    // interpolates it into `${GEMINI_REST}/v2/candles/${symbol}/…`, so an input like
    // "btcusd/../../v1/x" steers the request elsewhere on the API host; and getCache()
    // mints a permanent cache entry per distinct string, which then gets persisted —
    // an unbounded map keyed by whatever a caller sends.
    if (!isValidSymbol(symbol)) return []
    const timeframe: Timeframe =
      tf === '15m' || tf === '1hr' || tf === '4hr' || tf === '1day' || tf === '5m' || tf === '1m' ? tf : '1hr'
    const fresh = await refreshCandle(symbol, timeframe)
    if (timeframe === '1day') {
      // Gemini omits the in-progress day — graft it on from the hourly candles.
      const hourly = await refreshCandle(symbol, '1hr')
      return appendFormingDaily(fresh, hourly)
    }
    return fresh
  }

  /** Multi-timeframe market history for the trading skill: per symbol/timeframe,
   *  a condensed summary (support/resistance, range, volatility, trend, MAs/BB)
   *  plus a bounded slice of recent raw candles. */
  async getMarketHistory(symbols: string[], tfs: Timeframe[] = ['15m', '1hr', '4hr', '1day']): Promise<Record<string, unknown>> {
    const rawLimits: Record<Timeframe, number> = { '1m': 60, '5m': 96, '15m': 96, '1hr': 72, '4hr': 90, '1day': 30 }
    const out: Record<string, unknown> = {}
    for (const symbol of symbols.slice(0, 25)) {
      const sym = symbol.toUpperCase()
      const perTf: Record<string, unknown> = {}
      for (const tf of tfs) {
        const candles = await this.getCandlesFresh(sym, tf)
        perTf[tf] = {
          summary: summarizeCandles(candles, tf),
          recentCandles: recentSlice(candles, rawLimits[tf]),
        }
      }
      out[sym] = perTf
    }
    return out
  }

  /** Current total held quantities of BTC and USD (incl. amounts locked in open orders). */
  private heldBtcUsd(holdings: Holding[]): { btc: number; usd: number } {
    const amt = (cur: string) => Number(holdings.find((h) => h.currency === cur)?.amount ?? 0) || 0
    return { btc: amt('BTC'), usd: amt('USD') }
  }

  /** Total account value in USD: every holding (BTC, USD/USDT cash, and every alt) valued at
   *  current ticker prices. This is the "overall account balance," not just the BTC/USD legs. */
  private heldTotalUsd(holdings: Holding[]): number {
    return holdings.reduce((sum, h) => {
      const amount = Number(h.amount) || 0
      if (h.currency === 'USD' || h.currency === 'USDT') return sum + amount
      const ticker = this.snapshot.tickers.find((t) => t.symbol === `${h.currency}USD`)
      return sum + (ticker ? amount * Number(ticker.last) : 0)
    }, 0)
  }

  /** Compute BTC & USD held + % growth since the persisted baseline, capturing the baseline
   *  on the first run that has real holdings. Updates the snapshot's portfolioGrowth. */
  private updatePortfolioGrowth(holdings: Holding[]): void {
    const { btc, usd } = this.heldBtcUsd(holdings)
    const totalUsd = this.heldTotalUsd(holdings)
    const btcPrice = this.priceOf('BTCUSD') ?? 0
    let baseline = loadPortfolioBaseline()
    if (!baseline) {
      // First run: today's balances are the starting line (0% growth from here).
      baseline = { btc, usd, totalUsd, btcPrice, at: Date.now() }
      savePortfolioBaseline(baseline)
      console.log('[crypto] portfolio baseline captured:', JSON.stringify(baseline))
    }
    const pct = (base: number, cur: number): number | null =>
      base > 0 ? ((cur - base) / base) * 100 : null
    const growth: PortfolioGrowth = {
      since: baseline.at,
      btc: { baseline: baseline.btc, current: btc, pctChange: pct(baseline.btc, btc) },
      usd: { baseline: baseline.usd, current: usd, pctChange: pct(baseline.usd, usd) },
      total: { baseline: baseline.totalUsd, current: totalUsd, pctChange: pct(baseline.totalUsd, totalUsd) },
      periods: this.computePeriods({ totalUsd, btcPrice }, baseline),
    }
    this.snapshot = { ...this.snapshot, portfolioGrowth: growth }
  }

  /** Append the current total-account value to the rolling history series, throttled so at most
   *  one sample lands per HISTORY_SAMPLE_INTERVAL_MS, and pruned to HISTORY_RETENTION_MS. Called
   *  from the refresh loop after prices are in. Separate from computePeriods so the read path
   *  (which runs every refresh) doesn't rewrite the file every tick. */
  private recordPortfolioSample(holdings: Holding[]): void {
    const btcPrice = this.priceOf('BTCUSD') ?? 0
    if (btcPrice <= 0) return // no BTC price yet — a sample now would corrupt the BTC-terms math
    const { btc, usd } = this.heldBtcUsd(holdings)
    const totalUsd = this.heldTotalUsd(holdings)
    const now = Date.now()
    const series = loadPortfolioHistory()
    const last = series[series.length - 1]
    if (last && now - last.at < HISTORY_SAMPLE_INTERVAL_MS) return
    series.push({ at: now, btc, usd, totalUsd, btcPrice })
    const cutoff = now - HISTORY_RETENTION_MS
    const pruned = series.filter((s) => s.at >= cutoff)
    savePortfolioHistory(pruned)
  }

  /** Build the 24h/7d/30d/baseline change windows for the total account value, each in both USD
   *  and BTC terms. Rolling windows read from the persisted history series (oldest sample within
   *  the window, or the oldest sample overall marked `partial`); the baseline window reads the
   *  persisted baseline. BTC-terms change converts each end's total to BTC at that end's own BTC
   *  price, so it reflects stack growth rather than BTC/USD exchange-rate drift. */
  private computePeriods(cur: { totalUsd: number; btcPrice: number }, baseline: PortfolioBaseline): PeriodChange[] {
    const now = Date.now()
    const day = 24 * 60 * 60_000
    const series = loadPortfolioHistory()
    const curBtc = cur.btcPrice > 0 ? cur.totalUsd / cur.btcPrice : null

    const make = (
      key: PeriodChange['key'], label: string,
      past: { totalUsd: number; btcPrice: number; at: number } | null, partial: boolean,
    ): PeriodChange => {
      if (!past || past.totalUsd <= 0) {
        return { key, label, startedAt: past?.at ?? now, usdChange: null, usdPct: null, btcChange: null, btcPct: null, partial }
      }
      const usdChange = cur.totalUsd - past.totalUsd
      const usdPct = (usdChange / past.totalUsd) * 100
      const pastBtc = past.btcPrice > 0 ? past.totalUsd / past.btcPrice : null
      const btcChange = curBtc !== null && pastBtc !== null ? curBtc - pastBtc : null
      const btcPct = btcChange !== null && pastBtc ? (btcChange / pastBtc) * 100 : null
      return { key, label, startedAt: past.at, usdChange, usdPct, btcChange, btcPct, partial }
    }

    // For a rolling window, use the oldest sample at or after the window start; if the series
    // doesn't reach that far back, fall back to the oldest sample and flag it partial.
    const windowRef = (spanMs: number): { past: ValueSample | null; partial: boolean } => {
      if (series.length === 0) return { past: null, partial: true }
      const start = now - spanMs
      const within = series.filter((s) => s.at >= start)
      if (within.length > 0) return { past: within[0]!, partial: false }
      return { past: series[0]!, partial: true }
    }

    const w24 = windowRef(day), w7 = windowRef(7 * day), w30 = windowRef(30 * day)
    return [
      make('24h', '24H', w24.past, w24.partial),
      make('7d', '7D', w7.past, w7.partial),
      make('30d', '30D', w30.past, w30.partial),
      make('baseline', 'YTD',
        { totalUsd: baseline.totalUsd, btcPrice: baseline.btcPrice, at: baseline.at }, false),
    ]
  }

  /** Reset the growth baseline to the current balances (e.g. after a deposit/withdrawal so the
   *  measure stays trading-only). Returns the new growth snapshot. */
  resetPortfolioBaseline(): PortfolioGrowth | null {
    const { btc, usd } = this.heldBtcUsd(this.snapshot.holdings)
    const totalUsd = this.heldTotalUsd(this.snapshot.holdings)
    const btcPrice = this.priceOf('BTCUSD') ?? 0
    savePortfolioBaseline({ btc, usd, totalUsd, btcPrice, at: Date.now() })
    this.updatePortfolioGrowth(this.snapshot.holdings)
    this.broadcast()
    return this.snapshot.portfolioGrowth
  }

  /** Explicitly set the baseline (manual correction of reconstructed values). */
  setPortfolioBaseline(btc: number, usd: number, at: number): PortfolioGrowth | null {
    // Manual edits only correct the BTC/USD legs; re-derive the total baseline from the
    // current total minus whatever trading-driven delta is implied by this correction.
    const priorBaseline = loadPortfolioBaseline()
    const { btc: curBtc, usd: curUsd } = this.heldBtcUsd(this.snapshot.holdings)
    const curTotalUsd = this.heldTotalUsd(this.snapshot.holdings)
    const btcPrice = this.priceOf('BTCUSD') ?? 0
    const deltaUsd = (curBtc - btc) * btcPrice + (curUsd - usd)
    const totalUsd = priorBaseline ? curTotalUsd - deltaUsd : curTotalUsd
    savePortfolioBaseline({ btc, usd, totalUsd, btcPrice, at })
    this.updatePortfolioGrowth(this.snapshot.holdings)
    this.broadcast()
    return this.snapshot.portfolioGrowth
  }

  /** Reconstruct the BTC & USD balances as of `sinceMs` by walking current balances backward
   *  through trades (BTCUSD + every held alt, for the USD leg) and transfers. Best effort:
   *  Gemini caps mytrades at ~500/symbol with no backward paging, so a very active >6-month
   *  window can truncate — `truncated` flags that so the user can correct the numbers manually. */
  async reconstructBaselineAt(sinceMs: number): Promise<{ growth: PortfolioGrowth | null; truncated: boolean }> {
    const holdings = this.snapshot.holdings
    const { btc: curBtc, usd: curUsd } = this.heldBtcUsd(holdings)
    const heldSyms = holdings
      .map((h) => h.currency)
      .filter((c) => c !== 'USD' && c !== 'USDT' && c !== 'GUSD')
      .map((c) => `${c}USD`)
    const symbols = Array.from(new Set(['BTCUSD', ...heldSyms]))

    let netBtc = 0, netUsd = 0, truncated = false
    for (const sym of symbols) {
      const trades = await fetchMyTrades(sym, 500, sinceMs)
      if (trades.length >= 500) truncated = true
      for (const t of trades) {
        if (t.timestampms < sinceMs) continue
        const amt = Number(t.amount), price = Number(t.price)
        const usd = amt * price
        const feeUsd = t.fee_currency === 'USD' ? Number(t.fee_amount) : 0
        const isBuy = t.type === 'Buy'
        if (sym === 'BTCUSD') netBtc += isBuy ? amt : -amt
        netUsd += isBuy ? -(usd + feeUsd) : (usd - feeUsd) // buys spend USD, sells add USD
      }
    }
    for (const x of await fetchTransfers(sinceMs)) {
      if (x.timestampms < sinceMs || !/complete|advanced|confirmed/i.test(x.status)) continue
      const amt = Number(x.amount), sign = /withdraw/i.test(x.type) ? -1 : 1
      if (x.currency === 'BTC') netBtc += sign * amt
      else if (x.currency === 'USD') netUsd += sign * amt
    }

    // netUsd already nets the USD leg of every traded symbol (BTC + alts), so it's a
    // reasonable proxy for the total account's trading-driven USD flow since sinceMs.
    const curTotalUsd = this.heldTotalUsd(holdings)
    // btcPrice at the historical `sinceMs` isn't recoverable here — store 0 (unknown), which
    // leaves the baseline's USD change intact but shows the BTC-terms change as "—" until the
    // baseline is reset to NOW (which captures a live price).
    savePortfolioBaseline({ btc: curBtc - netBtc, usd: curUsd - netUsd, totalUsd: curTotalUsd - netUsd, btcPrice: 0, at: sinceMs })
    this.updatePortfolioGrowth(holdings)
    this.broadcast()
    console.log(`[crypto] reconstructed baseline @ ${new Date(sinceMs).toISOString()} — BTC ${(curBtc - netBtc).toFixed(8)}, USD ${(curUsd - netUsd).toFixed(2)}${truncated ? ' (TRUNCATED — verify)' : ''}`)
    return { growth: this.snapshot.portfolioGrowth, truncated }
  }

  /** Latest USD price for a symbol from the ticker cache — used to size auto-execute trades. */
  private priceOf(symbol: string): number | null {
    const t = this.snapshot.tickers.find((x) => x.symbol === symbol.toUpperCase())
    return t ? Number(t.last) : (symbol.toUpperCase() === 'USD' ? 1 : null)
  }

  async start(): Promise<void> {
    // Keep autoPlan state synced into snapshot so clients see live updates
    autoPlanner.onChange(() => {
      this.snapshot = {
        ...this.snapshot,
        autoPlans: autoPlanner.getAllStatuses(),
        strategyExposure: autoPlanner.exposureByStrategy((s) => this.priceOf(s)),
        autoExecute: autoPlanner.getAutoExecute(),
      }
      this.broadcast()
      // Auto-confirm any newly-staged within-cap plans (guarded against reentrancy).
      autoPlanner.evaluateAutoExecute((s) => this.priceOf(s))
    })

    // Load persisted candle cache before first refresh
    loadCandleCache()

    // Arm the recurring interval-timer strategy run from the persisted setting.
    this.armIntervalTimer()
    this.armPerStrategyTimers()
    this.queueDrainTimer = setInterval(() => this.drainScheduledQueue(), 5_000)

    await this.fullRefresh()

    // Re-attach monitoring to any bracket that was in-flight at shutdown.
    if (this.snapshot.keysConfigured) {
      try { await autoPlanner.resumeBracketIfAny() } catch (e) { console.warn('[crypto] bracket resume failed:', (e as Error).message) }
      // Restore staged proposals + re-attach any executing non-bracket plan (BTC ladder etc.).
      try { await autoPlanner.resumePlansIfAny() } catch (e) { console.warn('[crypto] plan resume failed:', (e as Error).message) }
    }

    let cycle = 0
    // The whole body is guarded. fullRefresh/tickerRefresh reach the exchange and
    // rebuildIntelReport makes a great many assumptions about data shape; an escaped
    // rejection here is an unhandled rejection, which by default terminates Node —
    // taking down the bracket monitor and alert evaluation with real orders resting
    // on the exchange. The inner try/catches below stay: they let one subsystem fail
    // without skipping the others in the same tick.
    this.refreshTimer = setInterval(async () => {
      try {
        cycle++
        if (cycle % 10 === 0) await this.fullRefresh()
        else await this.tickerRefresh()
        // Self-heal any bracket whose monitor loop stalled on a transient API error —
        // re-attaches management within ~30s, no restart needed (position stayed protected).
        if (this.snapshot.keysConfigured) {
          try { autoPlanner.reviveStalledBrackets() } catch (e) { console.warn('[crypto] bracket revive failed:', (e as Error).message) }
        }
        // MARKET indicator alerts. Evaluated here rather than in the browser so they
        // keep firing with the app closed; the store dedups to one fire per bar.
        try { this.evaluateAlerts() } catch (e) { console.warn('[crypto] alert eval failed:', (e as Error).message) }
      } catch (e) {
        console.error('[crypto] refresh cycle failed:', (e as Error).message)
      }
    }, 30_000)

    // Hot loop: re-price just the user's open positions/orders every ~7s so open
    // trades update between the 30s full sweeps. Cheap — only the handful of open
    // symbols, no signal recompute — and a no-op when nothing is open.
    this.hotTimer = setInterval(() => { void this.hotRefresh() }, 7_000)

    // Periodically save candle cache (every 30 min)
    this.cacheSaveTimer = setInterval(() => {
      saveCandleCache()
    }, 30 * 60 * 1000)
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.hotTimer) clearInterval(this.hotTimer)
    if (this.cacheSaveTimer) clearInterval(this.cacheSaveTimer)
    if (this.queueDrainTimer) clearInterval(this.queueDrainTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    for (const t of this.perStrategyTimers.values()) clearInterval(t)
    saveCandleCache()
  }

  async fullRefresh(): Promise<void> {
    try { this.symbols = await fetchSymbols() } catch (e) {
      console.warn('[crypto] symbol fetch failed:', (e as Error).message)
    }
    await this.tickerRefresh()

    if (this.snapshot.keysConfigured) {
      const [holdingsResult, openOrdersResult] = await Promise.allSettled([
        fetchHoldings(),
        fetchOpenOrders(),
      ])

      if (holdingsResult.status === 'fulfilled') {
        const holdings = holdingsResult.value
        // Set holdings immediately so the UI shows them even if cost basis takes time
        this.snapshot = { ...this.snapshot, holdings }
        this.recordPortfolioSample(holdings)
        this.updatePortfolioGrowth(holdings)
        this.broadcast()
        // Enrich with cost basis in background — don't block or fail the refresh
        void (async () => {
          try {
            // Fees play no part in P&L here — snapshot.feeRates is still measured and
            // exposed for reference, but nothing below nets it out.
            const enriched = await Promise.all(holdings.map(async (h) => {
              const ticker = this.snapshot.tickers.find((t) => t.symbol === `${h.currency}USD`)
              const currentPrice = ticker ? Number(ticker.last) : (h.currency === 'USD' ? 1 : null)
              if (!currentPrice) return h
              const costBasis = await computeCostBasis(h.currency, Number(h.amount))
              if (costBasis === null) return h
              const amount = Number(h.amount)
              // Fee-free P&L (operator rule): traded notional in vs. traded notional out.
              // No entry fee in costBasis, no estimated exit fee subtracted — gross and
              // net are the same number, kept as separate fields only for wire compat.
              const grossUnrealizedPnl = (currentPrice - costBasis) * amount
              const grossUnrealizedPnlPct = costBasis > 0 ? grossUnrealizedPnl / (costBasis * amount) * 100 : 0
              const feeToClose = 0
              const unrealizedPnl = grossUnrealizedPnl
              const unrealizedPnlPct = grossUnrealizedPnlPct
              return { ...h, costBasis, unrealizedPnl, unrealizedPnlPct, grossUnrealizedPnl, grossUnrealizedPnlPct, feeToClose }
            }))
            // Also enrich open orders with cost basis (sell orders only)
            const enrichedOrders = await Promise.all(this.snapshot.openOrders.map(async (o) => {
              if (o.side !== 'sell') return o
              const currency = o.symbol.replace(/USD[TC]?$/i, '')
              // Try holdings first (already computed, free)
              const holding = enriched.find((h) => h.currency === currency)
              if (holding?.costBasis && holding.costBasis > 0) return { ...o, costBasis: holding.costBasis }
              // Holdings may show 0 (funds locked in order) — compute directly from trade history
              const totalAmt = Number(o.originalAmount)
              if (totalAmt <= 0) return o
              try {
                const cb = await computeCostBasis(currency, totalAmt)
                return cb ? { ...o, costBasis: cb } : o
              } catch {
                return o
              }
            }))
            // Note: don't write feeRates back here — the trade-history block owns it and
            // may have refreshed it while our cost-basis awaits were in flight.
            this.snapshot = { ...this.snapshot, holdings: enriched, openOrders: enrichedOrders }
            this.broadcast()
          } catch (e) {
            console.warn('[crypto] cost basis enrichment failed:', (e as Error).message)
          }
        })()
      } else {
        console.warn('[crypto] holdings fetch failed:', holdingsResult.reason)
      }
      if (openOrdersResult.status === 'fulfilled') {
        this.snapshot = { ...this.snapshot, openOrders: openOrdersResult.value }
        // Drop safe-mode arms whose guarded order is no longer live (filled/cancelled),
        // then default-on auto-arm any eligible SELL order the user hasn't disarmed.
        this.pruneSafeMode()
        this.autoArmSafeMode()
      } else {
        console.warn('[crypto] open orders fetch failed:', openOrdersResult.reason)
      }

      // Verify the BTC ladder invariant against the live book: every sell needs a resting
      // buy-back below it. Unhedged sells are flagged and a confirm-first buy-back is staged.
      try {
        const btcTicker = this.snapshot.tickers.find((t) => t.symbol === 'BTCUSD')
        const btcPrice = btcTicker ? Number(btcTicker.last) : null
        const btcLadderAlerts = await autoPlanner.reconcileBtcLadder(this.snapshot.openOrders, btcPrice)
        // Surface open/resting cycles so a resting buy-back order can show its BTC P&L
        // vs the price the paired slice was sold at.
        const btcLadderCycles = loadBtcCycles().filter((c) => c.status !== 'closed')
        this.snapshot = { ...this.snapshot, btcLadderAlerts, btcLadderCycles }
      } catch (e) {
        console.warn('[crypto] btc ladder reconcile failed:', (e as Error).message)
      }

      // Auto-execute pass: confirm any staged within-cap plans (e.g. a just-staged rebuy).
      autoPlanner.evaluateAutoExecute((s) => this.priceOf(s))

      // Fetch filled trade history for all non-USD holdings and merge into snapshot
      void (async () => {
        try {
          // Union of coins we currently hold + coins we've traded (audit log) + coins
          // with a live order. Held-only would drop fully-closed positions (e.g. a coin
          // sold to zero), so their completed round-trips would vanish from history.
          const held = (holdingsResult.status === 'fulfilled' ? holdingsResult.value : this.snapshot.holdings)
            .map((h) => h.currency)
          const traded = this.trades
            .filter((t) => t.status === 'executed')
            .map((t) => t.symbol.replace(/USD$/, ''))
          const ordered = this.snapshot.openOrders.map((o) => o.symbol.replace(/USD$/, ''))
          const currencies = [...new Set([...held, ...traded, ...ordered])]
            .filter((c) => c && c !== 'USD' && c !== 'USDT' && c !== 'GUSD')
          if (currencies.length === 0) return
          // Fetch SEQUENTIALLY, not via Promise.allSettled: Gemini rejects any private
          // request whose nonce is <= the highest it has already processed. Fired in
          // parallel, these per-symbol calls' (monotonic) nonces ARRIVE out of order, so
          // all but the race-winners came back InvalidNonce → !res.ok → [] → silently
          // dropped, and most coins' fills vanished from the TRADES tab. Serial issue
          // keeps nonces in order. A symbol that still fails (or returns empty when we
          // already hold fills for it — an ambiguous miss) keeps its last-good fills.
          for (const c of currencies) {
            const symbol = `${c}USD`
            let raw: Awaited<ReturnType<typeof fetchMyTrades>>
            try { raw = await fetchMyTrades(symbol, 500) }
            catch { continue }  // transient error — retain prior fills for this symbol
            if (raw.length === 0 && this.tradeHistoryBySymbol.has(symbol)) continue
            this.tradeHistoryBySymbol.set(symbol, raw.map((t) => ({
              tradeId: t.tid ?? '',
              orderId: t.order_id,
              symbol,
              side: (t.type === 'Buy' ? 'buy' : 'sell') as 'buy' | 'sell',
              price: t.price,
              amount: t.amount,
              feeCurrency: t.fee_currency ?? '',
              feeAmount: t.fee_amount ?? '0',
              timestampMs: t.timestampms,
              isAggressor: t.aggressor ?? false,
            })))
          }
          // Flatten the retained per-symbol cache, newest first.
          const tradeHistory: GeminiTrade[] = [...this.tradeHistoryBySymbol.values()]
            .flat()
            .sort((a, b) => b.timestampMs - a.timestampMs)
          // Measure real fee rates here, where the fresh fills live — the holdings
          // enrichment (which races this block) reads snapshot.feeRates for the exit
          // fee, so it always reflects the latest fills once this completes.
          this.snapshot = { ...this.snapshot, tradeHistory, feeRates: measureFeeRates(tradeHistory) }
          this.broadcast()
        } catch (e) {
          console.warn('[crypto] trade history fetch failed:', (e as Error).message)
        }
      })()
    }

    void this.seedAll()
    this.rebuildReport()
  }

  private async tickerRefresh(): Promise<void> {
    const usdPairs = this.symbols.filter((s) => s.endsWith('usd'))
    const tickers: Ticker[] = []
    for (let i = 0; i < usdPairs.length; i += 20) {
      const batch = usdPairs.slice(i, i + 20)
      const results = await Promise.allSettled(batch.map(fetchTicker))
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) tickers.push(r.value)
      }
    }

    // Enrich 24h volume from cached 1hr candles (v2/ticker omits volume).
    for (const ticker of tickers) {
      const cache = candleCache.get(ticker.symbol)
      if (cache && cache['1hr'].length > 0) {
        const vol24 = cache['1hr'].slice(-24).reduce((sum, c) => sum + c[5], 0)
        if (vol24 > 0) ticker.volume = String(vol24)
      }
    }

    // Held coins get 1m/5m refreshed every ticker cycle (30s) — that granularity
    // goes stale fast, so it can't wait for the 5-min fullRefresh/seedAll cadence.
    // Bounded to holdings so this doesn't multiply the candle-fetch load across
    // the whole ~235-symbol universe.
    // Held coins PLUS the FLASH-DIP sweep's top ~10 next-hour swing candidates
    // (chosen in the last report build). This is the "prefetch + store locally"
    // that lets predictive RSI-30 entries be priced off live 1m/5m without
    // fetching the whole ~235-symbol universe — bounded to ~10 extra symbols.
    const portfolioCurrencies = new Set(this.snapshot.holdings.map((h) => h.currency))
    const flashSet = new Set(getFlashDipSelected())
    const fastSymbols = tickers
      .map((t) => t.symbol)
      .filter((sym) => portfolioCurrencies.has(sym.replace(/USD$/, '')) || flashSet.has(sym))
    await Promise.allSettled(
      fastSymbols.flatMap((sym) => {
        const cache = getCache(sym)
        return FAST_TIMEFRAMES.map((tf) =>
          fetchCandlesFromGemini(sym, tf).then((c) => { cache[tf] = c }).catch(() => { /* keep last good cache */ })
        )
      })
    )

    const signals = tickers.map((ticker) => {
      const cache = candleCache.get(ticker.symbol)
      if (!cache) return this.emptySignal(ticker.symbol)
      const tfs: Timeframe[] = ['1day', '1hr', '15m']
      if (cache['4hr'].length > 0) tfs.push('4hr') // derived from 1hr — present once seeded
      for (const tf of FAST_TIMEFRAMES) if (cache[tf].length > 0) tfs.push(tf)
      const tfSignals = tfs.map((tf) => computeTimeframeSignal(tf, cache[tf], Number(ticker.last)))
      return computeCompositeSignal(ticker.symbol, ticker, tfSignals)
    })

    if (cmcConfigured()) {
      try {
        const bases = tickers.map((t) => t.symbol.replace(/USD$/, ''))
        this.cmcVolumes = await fetchCmcVolumes(bases)
      } catch (e) {
        console.error('[cmc] volume refresh failed:', e instanceof Error ? e.message : e)
      }
    }

    const cmcData = [...this.cmcVolumes.entries()].map(([base, v]) => ({
      base, volume24h: v.volume24h, volumeChange24h: v.volumeChange24h, marketCap: v.marketCap,
    }))

    this.snapshot = {
      ...this.snapshot, tickers, signals,
      connected: tickers.length > 0,
      lastRefresh: Date.now(),
      keysConfigured: !!(process.env['GEMINI_API_KEY'] && process.env['GEMINI_API_SECRET']),
      autoPlans: autoPlanner.getAllStatuses(),
      strategyExposure: autoPlanner.exposureByStrategy((s) => this.priceOf(s)),
      cmcData,
    }
    this.rebuildReport()
    this.broadcast()
  }

  // Fast, targeted re-pricing of ONLY the symbols the user currently has skin in:
  // live exchange orders + open bracket positions. Runs far more often than the
  // full ~235-symbol tickerRefresh so open-trade marks & P&L stay fresh, without the
  // API cost (or signal recompute) of re-fetching the whole universe. No-op when
  // nothing is open, and self-guards against overlapping runs.
  private async hotRefresh(): Promise<void> {
    if (this.hotRefreshing) return
    // Cheap, unconditional: notice a position closing even when nothing is left to re-price.
    this.detectPositionClose()
    const openPhases = new Set(['entering', 'protected', 'tp1_filled', 'exiting'])
    const syms = new Set<string>()
    for (const o of this.snapshot.openOrders) syms.add(o.symbol.toUpperCase())
    for (const plan of autoPlanner.getAllStatuses()) {
      if (!plan.active) continue
      for (const step of plan.steps) {
        const st = step.bracketState
        if (step.kind === 'bracket' && st && openPhases.has(st.phase)) syms.add(step.symbol.toUpperCase())
      }
    }
    if (syms.size === 0) return
    this.hotRefreshing = true
    try {
      const results = await Promise.allSettled([...syms].map(fetchTicker))
      const fresh = new Map<string, Ticker>()
      for (const r of results) if (r.status === 'fulfilled' && r.value) fresh.set(r.value.symbol, r.value)
      if (fresh.size === 0) return
      // Merge the fresh marks over the last full sweep, preserving the volume the
      // full tickerRefresh enriched from the candle cache (v2/ticker omits volume).
      const tickers = this.snapshot.tickers.map((t) => {
        const f = fresh.get(t.symbol)
        return f ? { ...f, volume: t.volume || f.volume } : t
      })
      this.snapshot = { ...this.snapshot, tickers, lastRefresh: Date.now() }
      this.broadcast()
      // Evaluate software-side stops against the freshest marks.
      if (this.snapshot.safeMode.length > 0) await this.checkSafeMode()
    } finally {
      this.hotRefreshing = false
    }
  }

  private emptySignal(symbol: string): Signal {
    return {
      symbol, direction: 'HOLD', strength: 50, entryQuality: 'INSUFFICIENT_DATA',
      confluence: 0, timeframes: [], reasons: ['Seeding…'],
      computedAt: Date.now(), seeded: false,
    }
  }

  private async seedAll(): Promise<void> {
    const usdSymbols = this.symbols.filter((s) => s.endsWith('usd')).map((s) => s.toUpperCase())

    // Skip symbols that already have fresh candle data from disk cache
    const portfolioCurrencies = new Set(this.snapshot.holdings.map((h) => h.currency))
    const priority = usdSymbols.filter((s) => portfolioCurrencies.has(s.replace('USD', '')))
    const rest = usdSymbols.filter((s) => !portfolioCurrencies.has(s.replace('USD', '')))

    // Determine which symbols need re-seeding
    const needsSeed = (sym: string): boolean => {
      const cache = candleCache.get(sym)
      if (!cache) return true
      // Re-seed if any timeframe is empty
      return cache['1day'].length === 0 || cache['1hr'].length === 0
    }

    const priorityToSeed = priority.filter(needsSeed)
    const restToSeed = rest.filter(needsSeed)
    const ordered = [...priorityToSeed, ...restToSeed]

    // Cache is warm — but candles must NOT freeze, or the overview charts go
    // stale. Continuously refresh: always the portfolio coins (all timeframes),
    // plus a rotating window of the rest of the universe so every symbol's
    // candles keep advancing over successive cycles.
    if (ordered.length === 0) {
      const WINDOW = 30
      const span = rest.length || 1
      const start = this.seedCursor % span
      const rotating = rest.slice(start, start + WINDOW)
      this.seedCursor = (start + WINDOW) % span
      console.log(`[crypto] candle cache warm — continuous refresh: ${priority.length} portfolio + ${rotating.length} rotating (cursor ${start}/${span})`)
      for (const sym of priority) {
        try {
          const cache = getCache(sym)
          cache['15m'] = await fetchCandlesFromGemini(sym, '15m')
          cache['1hr'] = await fetchCandlesFromGemini(sym, '1hr')
          cache['1day'] = await fetchCandlesFromGemini(sym, '1day')
          await sleep(300)
        } catch { /* non-fatal */ }
      }
      for (const sym of rotating) {
        try {
          const cache = getCache(sym)
          cache['15m'] = await fetchCandlesFromGemini(sym, '15m')
          cache['1hr'] = await fetchCandlesFromGemini(sym, '1hr')
          await sleep(300)
        } catch { /* non-fatal */ }
      }
      await this.tickerRefresh()
      saveCandleCache()
      return
    }

    this.snapshot = {
      ...this.snapshot,
      seedProgress: { total: ordered.length, seeded: 0, active: true },
    }
    this.broadcast()

    let seeded = 0
    for (const symbol of ordered) {
      try { await seedSymbol(symbol) } catch { /* non-fatal */ }
      seeded++
      this.snapshot = {
        ...this.snapshot,
        seedProgress: { total: ordered.length, seeded, active: seeded < ordered.length },
      }
      if (seeded % 10 === 0 || seeded <= priorityToSeed.length) {
        await this.tickerRefresh()
      }
      await sleep(500)
    }

    this.snapshot = { ...this.snapshot, seedProgress: { total: ordered.length, seeded, active: false } }
    await this.tickerRefresh()
    saveCandleCache()
    console.log(`[crypto] seeding complete — ${seeded} symbols seeded`)
  }

  private rebuildReport(): void {
    const report = buildIntelReport(this.snapshot.tickers, this.snapshot.signals, this.snapshot.holdings, this.snapshot.tradeHistory, getEnabledStrategy(), this.cmcVolumes)
    this.snapshot = { ...this.snapshot, intelReport: report }
  }

  // ── Trade queue ──────────────────────────────────────────────────────

  addPending(trade: Omit<PendingTrade, 'id' | 'createdAt'>): PendingTrade {
    // Dedup so a re-proposed setup supersedes its stale predecessor, WITHOUT collapsing
    // genuinely-distinct legs of the same symbol (e.g. a stop + TP1 + TP2 scale-out, all
    // sells). When the caller supplies a `tag` (intent id), supersede only the pending with
    // the same (symbol, tag) — distinct tags coexist. With no tag, fall back to the legacy
    // (symbol, side) key so untagged callers behave exactly as before.
    const supersedes = trade.tag
      ? (t: PendingTrade) => t.symbol === trade.symbol && t.tag === trade.tag
      : (t: PendingTrade) => t.symbol === trade.symbol && t.side === trade.side && !t.tag
    const withoutDupes = this.snapshot.pending.filter((t) => !supersedes(t))
    const pending: PendingTrade = {
      ...trade,
      id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
    }
    const updated = [...withoutDupes, pending]
    this.snapshot = { ...this.snapshot, pending: updated }
    savePending(updated)
    this.broadcast()
    return pending
  }

  async executeTrade(id: string): Promise<{ ok: boolean; error?: string }> {
    const trade = this.snapshot.pending.find((t) => t.id === id)
    if (!trade) return { ok: false, error: 'trade not found' }
    this.removePending(id)

    // Defense in depth for agent-originated trades. agents.ts's propose() is the
    // primary gate and already refuses an unpriced or over-cap trade before it
    // ever reaches the pending queue — but this is the last point before real
    // money moves, and the only one a bug anywhere upstream of propose() (a
    // stale pending entry, a future caller of addPending that forgets the gate)
    // cannot route around. Non-agent trades — the operator's own manual stages
    // — are deliberately uncapped here, exactly as they always have been; only
    // trades carrying an agent's strategy id are re-checked.
    if (isAgentStrategyId(trade.strategy)) {
      const last = Number(this.snapshot.tickers.find((t) => t.symbol === trade.symbol)?.last) || 0
      const px = Number(trade.price) || last
      const amountNum = Number(trade.amount)
      const notional = px * amountNum
      const overCap = !(px > 0) || !Number.isFinite(amountNum) || amountNum <= 0 || notional > AGENT_MAX_USD_CEILING
      if (overCap) {
        const error = !(px > 0)
          ? `no live price for ${trade.symbol} — refusing to execute an agent trade with unknown notional`
          : `$${notional.toFixed(2)} exceeds the global agent ceiling of $${AGENT_MAX_USD_CEILING}`
        const record: TradeRecord = { ...trade, status: 'failed', settledAt: Date.now(), error }
        this.trades.push(record)
        saveTrades(this.trades)
        return { ok: false, error }
      }
    }

    try {
      const orderId = await placeOrder(
        trade.symbol, trade.side, trade.amount,
        trade.price, trade.stopPrice, trade.orderOptions,
      )
      const record: TradeRecord = { ...trade, status: 'executed', settledAt: Date.now(), orderId }
      this.trades.push(record)
      saveTrades(this.trades)
      const base = trade.symbol.replace('USD', '')
      cryptoToast(
        `${trade.side === 'buy' ? 'Bought' : 'Sold'} ${trade.amount} ${base}`,
        `@ $${trade.price}${trade.side === 'buy' ? '' : ''} · order ${orderId}`,
        'notice'
      )
      // Surface the new resting order in "Open on Exchange" immediately, don't wait
      // for the ~5-min full sweep. Awaited so the client's follow-up snapshot fetch
      // sees the new order rather than racing the refresh.
      await this.refreshOpenOrders()
      return { ok: true }
    } catch (e) {
      const record: TradeRecord = { ...trade, status: 'failed', settledAt: Date.now(), error: (e as Error).message }
      this.trades.push(record)
      saveTrades(this.trades)
      cryptoToast(`${trade.symbol.replace('USD', '')} trade failed`, (e as Error).message, 'warn', 'ti-alert-triangle')
      return { ok: false, error: (e as Error).message }
    }
  }

  dismissTrade(id: string): void {
    const trade = this.snapshot.pending.find((t) => t.id === id)
    if (!trade) return
    this.removePending(id)
    const record: TradeRecord = { ...trade, status: 'dismissed', settledAt: Date.now() }
    this.trades.push(record)
    saveTrades(this.trades)
  }

  /** Remove trade-log records matching a status and/or minimum age, and persist. Declutters
   *  the TRADES tab of denied (dismissed) / failed entries; never touches live Gemini orders.
   *  A record is removed only when it matches BOTH criteria supplied (status AND age). */
  purgeTrades(opts: { status?: TradeRecord['status']; olderThanMs?: number }): { removed: number } {
    // Safety: refuse to purge with no criteria — an empty filter would match (and delete)
    // every record. A caller must narrow by status and/or age.
    if (opts.status == null && opts.olderThanMs == null) return { removed: 0 }
    const cutoff = opts.olderThanMs != null ? Date.now() - opts.olderThanMs : null
    const before = this.trades.length
    this.trades = this.trades.filter((t) => {
      const statusMatch = opts.status ? t.status === opts.status : true
      const ageMatch = cutoff != null ? (t.createdAt ?? 0) < cutoff : true
      return !(statusMatch && ageMatch) // keep everything that does NOT match both criteria
    })
    const removed = before - this.trades.length
    if (removed > 0) saveTrades(this.trades)
    return { removed }
  }

  private removePending(id: string): void {
    const updated = this.snapshot.pending.filter((t) => t.id !== id)
    this.snapshot = { ...this.snapshot, pending: updated }
    savePending(updated)
    this.broadcast()
  }

  setPlanReport(report: string): void {
    const at = Date.now()
    const cls = classifyReport(report)
    // Always update the live status field (drives the "live order status" panel).
    // A full analysis report (strategy/fast-cash/candle) is additionally archived as its
    // own entry and the last-10 history is refreshed — so a fast-cash or candle run never
    // overwrites the strategy report; each kind coexists in the collapsed report history.
    this.snapshot = { ...this.snapshot, planReport: report, planReportAt: at }
    savePlanReport(report, at)
    if (cls) {
      archivePlanReport(report, at, cls.kind, cls.title)
      this.snapshot = { ...this.snapshot, planReports: listArchivedPlanReports().slice(0, 10) }
    }
    this.broadcast()
  }

  /** Every archived full report (newest first) — the skill reads this to reference and
   *  adjust strategy against past runs, beyond just the last one. */
  getPlanReportArchive(): PlanReportEntry[] {
    return listArchivedPlanReports()
  }

  /** Record (or clear, with price=null) a manual cost-basis override for a coin,
   *  then re-enrich holdings so the dashboard P&L updates immediately. */
  setCostBasisOverride(currency: string, price: number | null): Record<string, number> {
    const overrides = saveCostBasisOverride(currency, price)
    void this.fullRefresh()
    return overrides
  }

  /** Re-fetch just the live Gemini order book and push it into the snapshot. Cheap
   *  (one API call, no ticker/signal recompute) so it can run the instant an order is
   *  placed — the full ~235-symbol sweep only touches open orders every 5 min, which
   *  is far too slow for "Open on Exchange" to reflect a just-placed order. */
  async refreshOpenOrders(): Promise<void> {
    if (!this.snapshot.keysConfigured) return
    try {
      const openOrders = await fetchOpenOrders()
      this.snapshot = { ...this.snapshot, openOrders }
      this.pruneSafeMode()
      this.autoArmSafeMode()
      this.broadcast()
    } catch (e) {
      console.warn('[crypto] open orders quick-refresh failed:', (e as Error).message)
    }
  }

  async cancelOpenOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await cancelOrderVerified(orderId, false)
      // Remove from local openOrders immediately; next refresh will confirm
      this.snapshot = {
        ...this.snapshot,
        openOrders: this.snapshot.openOrders.filter((o) => o.orderId !== orderId),
      }
      this.broadcast()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** Close a position now: cancel the resting order, then place a fresh limit order for its
   *  remaining quantity (same side — a protective SELL stays a SELL, exiting the long).
   *
   *  The limit RESTS (post-only): a sell posts at the ask, a buy at the bid. It used to
   *  cross the book — marketable, immediate, and 1.2% taker. Resting pays 0.6%.
   *  If the post-only order is rejected because it would have crossed, this stages a
   *  confirm-first pending trade at the crossing price showing the extra fee, and places
   *  nothing: crossing is the operator's call to make, not a silent default. */
  async closePosition(orderId: string): Promise<{ ok: boolean; error?: string; newOrderId?: string }> {
    const order = this.snapshot.openOrders.find((o) => o.orderId === orderId)
    if (!order) return { ok: false, error: 'order not found' }

    const amount = order.remainingAmount
    if (!(Number(amount) > 0)) return { ok: false, error: 'no remaining amount to close' }

    const ticker = this.snapshot.tickers.find((t) => t.symbol === order.symbol)
    // Rest on our own side of the book: sell at the ask, buy at the bid.
    const px = order.side === 'sell'
      ? Number(ticker?.ask ?? ticker?.last ?? '0')
      : Number(ticker?.bid ?? ticker?.last ?? '0')
    if (!(px > 0)) return { ok: false, error: 'no current price for symbol' }

    try {
      await cancelOrderVerified(orderId)
      this.snapshot = {
        ...this.snapshot,
        openOrders: this.snapshot.openOrders.filter((o) => o.orderId !== orderId),
      }
      this.broadcast()
    } catch (e) {
      return { ok: false, error: `cancel failed: ${(e as Error).message}` }
    }

    const base = order.symbol.replace('USD', '')
    try {
      const newOrderId = await placeOrder(order.symbol, order.side, amount, String(px), undefined, MAKER_ONLY)
      cryptoToast(
        `Closing ${base} position`,
        `${order.side.toUpperCase()} ${amount} @ $${px} (post-only) · order ${newOrderId}`,
        'notice'
      )
      await this.refreshOpenOrders()
      return { ok: true, newOrderId }
    } catch (e) {
      const staged = this.stageCrossingExit(order.symbol, order.side, amount, ticker, e as Error)
      if (staged) return { ok: false, error: staged }
      cryptoToast(`${base} close failed`, (e as Error).message, 'warn', 'ti-alert-triangle')
      return { ok: false, error: `order cancelled but close order failed: ${(e as Error).message}` }
    }
  }

  /** Post-only exit rejected because it would have crossed? Stage the crossing version as a
   *  confirm-first pending trade instead of placing it, so the taker fee is never paid
   *  without the operator seeing and approving it. Returns a message for the caller, or null when
   *  the failure wasn't a post-only rejection (a real error, which the caller reports). */
  private stageCrossingExit(
    symbol: string, side: 'buy' | 'sell', amount: string,
    ticker: Ticker | undefined, err: Error,
  ): string | null {
    // Gemini rejects a post-only order that would take with this reason code.
    if (!/maker.?or.?cancel|would have (been )?filled|taker/i.test(err.message)) return null
    const crossPx = side === 'sell'
      ? Number(ticker?.bid ?? ticker?.last ?? '0')
      : Number(ticker?.ask ?? ticker?.last ?? '0')
    if (!(crossPx > 0)) return null
    const rates = this.snapshot.feeRates
    const notional = crossPx * Number(amount)
    const extraFee = notional * Math.max(0, rates.taker - rates.maker)
    const base = symbol.replace('USD', '')
    this.addPending({
      symbol, side, amount, price: String(crossPx), type: 'limit',
      tag: 'cross-exit',
      reason:
        `Post-only close could not rest — filling this now crosses the book and pays the ` +
        `${(rates.taker * 100).toFixed(2)}% taker fee instead of ${(rates.maker * 100).toFixed(2)}% maker ` +
        `(≈ $${extraFee.toFixed(2)} extra on $${notional.toFixed(2)}). Approve to cross, or dismiss and ` +
        `let the resting exit wait for a fill.`,
    })
    cryptoToast(
      `${base} close needs approval`,
      `Crossing the book costs ≈$${extraFee.toFixed(2)} extra — staged for your confirmation`,
      'warn', 'ti-alert-triangle',
    )
    return `post-only close would have crossed — staged for your approval (≈$${extraFee.toFixed(2)} extra fee to cross)`
  }

  /** Close an entire position for a symbol: cancel every resting order on that symbol,
   *  then sell 100% of the held base-currency quantity as a single post-only limit order
   *  resting at the ask.
   *
   *  This previously priced at bid × 1.001 and claimed to "cross the bid so it fills
   *  promptly" — which it didn't reliably do: 0.1% above the BID is still below the ask
   *  on any pair with a wider spread, so it rested anyway, making both the fee and the
   *  fill non-deterministic. It now rests deliberately, at the ask, post-only. If it can't
   *  rest, the crossing version is staged for confirmation rather than placed. */
  async closeSymbolPosition(symbol: string): Promise<{ ok: boolean; error?: string; newOrderId?: string; cancelledOrderIds?: string[] }> {
    const sym = symbol.toUpperCase()
    const orders = this.snapshot.openOrders.filter((o) => o.symbol === sym)

    const cancelledOrderIds: string[] = []
    for (const o of orders) {
      try {
        await cancelOrderVerified(o.orderId, false)
        cancelledOrderIds.push(o.orderId)
      } catch (e) {
        return { ok: false, error: `cancel failed for ${o.orderId}: ${(e as Error).message}`, cancelledOrderIds }
      }
    }
    if (cancelledOrderIds.length > 0) {
      this.snapshot = {
        ...this.snapshot,
        openOrders: this.snapshot.openOrders.filter((o) => o.symbol !== sym),
      }
      this.broadcast()
      // One wait for the whole batch (each cancel above skipped its own). Without it
      // `available` below is read while Gemini is still releasing the funds those
      // orders locked, so the sell is sized short and silently closes only part of
      // the position.
      await sleep(BALANCE_RELEASE_MS)
    }

    const base = sym.replace('USD', '')
    const holdings = await fetchHoldings()
    const amount = holdings.find((h) => h.currency === base)?.available ?? '0'
    if (!(Number(amount) > 0)) return { ok: false, error: 'no held quantity to sell', cancelledOrderIds }

    const ticker = this.snapshot.tickers.find((t) => t.symbol === sym)
    // Rest at the ask so the sell posts as maker rather than crossing into the bid.
    const marketPx = Number(ticker?.ask ?? ticker?.last ?? '0')
    if (!(marketPx > 0)) return { ok: false, error: 'no current price for symbol', cancelledOrderIds }
    const px = await roundToQuoteIncrement(marketPx, sym)

    try {
      const newOrderId = await placeOrder(sym, 'sell', amount, px, undefined, MAKER_ONLY)
      cryptoToast(
        `Closing ${base} position`,
        `SELL ${amount} @ $${px} (post-only, resting at ask) · order ${newOrderId}`,
        'notice'
      )
      await this.refreshOpenOrders()
      return { ok: true, newOrderId, cancelledOrderIds }
    } catch (e) {
      const staged = this.stageCrossingExit(sym, 'sell', amount, ticker, e as Error)
      if (staged) return { ok: false, error: staged, cancelledOrderIds }
      cryptoToast(`${base} close failed`, (e as Error).message, 'warn', 'ti-alert-triangle')
      return { ok: false, error: `orders cancelled but sell order failed: ${(e as Error).message}`, cancelledOrderIds }
    }
  }

  /** Modify a resting order's price and/or amount (and stop-trigger for stop-limits).
   *  Gemini has no native amend endpoint, so this is cancel-and-replace: the old order is
   *  cancelled and a fresh one placed at the new terms, same symbol/side/type. Unspecified
   *  fields keep the order's current value (amount defaults to the REMAINING quantity, so a
   *  partially-filled order is re-listed for what's left). There is a brief window where the
   *  order is off the book — if the replacement fails we surface it loudly. */
  async modifyOpenOrder(
    orderId: string,
    patch: { price?: string; amount?: string; stopPrice?: string },
  ): Promise<{ ok: boolean; error?: string; newOrderId?: string }> {
    const order = this.snapshot.openOrders.find((o) => o.orderId === orderId)
    if (!order) return { ok: false, error: 'order not found' }

    const isStopLimit = order.type.includes('stop')
    const newPrice = patch.price && Number(patch.price) > 0 ? patch.price : order.price
    const newAmount = patch.amount && Number(patch.amount) > 0 ? patch.amount : order.remainingAmount
    const newStop = isStopLimit
      ? (patch.stopPrice && Number(patch.stopPrice) > 0 ? patch.stopPrice : order.stopPrice)
      : undefined
    if (!(Number(newPrice) > 0)) return { ok: false, error: 'price must be > 0' }
    if (!(Number(newAmount) > 0)) return { ok: false, error: 'amount must be > 0' }
    if (isStopLimit && !(Number(newStop) > 0)) return { ok: false, error: 'stop trigger must be > 0' }
    // Nothing actually changed — avoid a needless cancel/replace (and the off-book window).
    if (newPrice === order.price && newAmount === order.remainingAmount && newStop === order.stopPrice) {
      return { ok: false, error: 'no change — price/amount are the same' }
    }

    try {
      await cancelOrderVerified(orderId)
      this.snapshot = {
        ...this.snapshot,
        openOrders: this.snapshot.openOrders.filter((o) => o.orderId !== orderId),
      }
      this.broadcast()
    } catch (e) {
      return { ok: false, error: `cancel failed: ${(e as Error).message}` }
    }

    try {
      const newOrderId = await placeOrder(order.symbol, order.side, newAmount, newPrice, newStop)
      const base = order.symbol.replace('USD', '')
      cryptoToast(
        `Modified ${base} order`,
        `${order.side.toUpperCase()} ${newAmount} @ $${newPrice}${newStop ? ` (stop $${newStop})` : ''} · order ${newOrderId}`,
        'notice'
      )
      await this.refreshOpenOrders()
      return { ok: true, newOrderId }
    } catch (e) {
      cryptoToast(
        `${order.symbol.replace('USD', '')} modify failed — order CANCELLED, not replaced`,
        (e as Error).message, 'critical', 'ti-alert-triangle'
      )
      return { ok: false, error: `order cancelled but replacement failed: ${(e as Error).message}` }
    }
  }

  // ── Safe mode: software-side synthetic stop on a resting order ──────────
  private currentPrice(symbol: string): number | null {
    const t = this.snapshot.tickers.find((x) => x.symbol === symbol.toUpperCase())
    const v = t ? Number(t.last) : NaN
    return v > 0 ? v : null
  }

  private setSafeMode(arms: SafeModeArm[]): void {
    saveSafeMode(arms)
    this.snapshot = { ...this.snapshot, safeMode: arms }
    this.broadcast()
  }

  /** Arm (or re-arm) a software-side stop on a resting order. `stopPct` sets the trigger
   *  below the current price; `exitPct` sets how far above market the replacement sell
   *  limit rests when it fires. */
  armSafeMode(orderId: string, stopPct: number, exitPct: number): { ok: boolean; error?: string; arm?: SafeModeArm } {
    const order = this.snapshot.openOrders.find((o) => o.orderId === orderId)
    if (!order) return { ok: false, error: 'order not found' }
    if (order.side !== 'sell') return { ok: false, error: 'safe mode only guards SELL orders' }
    if (!(stopPct > 0) || !(exitPct >= 0)) return { ok: false, error: 'stopPct must be > 0 and exitPct ≥ 0' }
    const armPrice = this.currentPrice(order.symbol)
    if (armPrice === null) return { ok: false, error: 'no current price for symbol' }
    const arm: SafeModeArm = {
      orderId, symbol: order.symbol, armPrice, stopPct, exitPct,
      triggerPrice: armPrice * (1 - stopPct / 100),
      armedAt: Date.now(),
    }
    // An explicit re-arm clears any prior opt-out for this order.
    if (this.safeModeOptOut.delete(orderId)) saveSafeModeOptOut([...this.safeModeOptOut])
    this.setSafeMode([...this.snapshot.safeMode.filter((a) => a.orderId !== orderId), arm])
    return { ok: true, arm }
  }

  disarmSafeMode(orderId: string): { ok: boolean } {
    // Remember the opt-out so default-on auto-arm doesn't immediately re-arm this order.
    if (!this.safeModeOptOut.has(orderId)) { this.safeModeOptOut.add(orderId); saveSafeModeOptOut([...this.safeModeOptOut]) }
    this.setSafeMode(this.snapshot.safeMode.filter((a) => a.orderId !== orderId))
    return { ok: true }
  }

  /** Move/alter an already-armed synthetic stop IN PLACE, without touching the resting
   *  order it guards (no cancel/replace — the Gemini sell keeps working uninterrupted).
   *  Unlike a re-arm, the original `armPrice` basis is preserved, so `stopPct` stays the
   *  fixed distance from the arm reference (e.g. tighten 2% → 1.2%, or trail to break-even)
   *  rather than silently re-basing to the current price. Pass `stopPct` and/or `exitPct`
   *  to nudge the percentages, or an absolute `triggerPrice` to place the stop at an exact
   *  level (stopPct is then back-derived for display). Only supplied fields change. */
  adjustSafeMode(
    orderId: string,
    opts: { stopPct?: number; exitPct?: number; triggerPrice?: number }
  ): { ok: boolean; error?: string; arm?: SafeModeArm } {
    const prev = this.snapshot.safeMode.find((a) => a.orderId === orderId)
    if (!prev) return { ok: false, error: 'order is not armed — arm it first, then adjust' }
    // Guard against adjusting an arm whose order has since gone away.
    if (!this.snapshot.openOrders.some((o) => o.orderId === orderId)) {
      return { ok: false, error: 'guarded order no longer resting' }
    }
    const { stopPct, exitPct, triggerPrice } = opts
    if (stopPct !== undefined && !(stopPct > 0)) return { ok: false, error: 'stopPct must be > 0' }
    if (exitPct !== undefined && !(exitPct >= 0)) return { ok: false, error: 'exitPct must be ≥ 0' }
    if (triggerPrice !== undefined && !(triggerPrice > 0)) return { ok: false, error: 'triggerPrice must be > 0' }
    if (stopPct === undefined && exitPct === undefined && triggerPrice === undefined) {
      return { ok: false, error: 'nothing to adjust — pass stopPct, exitPct, and/or triggerPrice' }
    }

    let nextStopPct = prev.stopPct
    let nextTrigger = prev.triggerPrice
    if (triggerPrice !== undefined) {
      // Absolute placement wins; back-derive the % off the fixed arm basis for display.
      nextTrigger = triggerPrice
      nextStopPct = (1 - triggerPrice / prev.armPrice) * 100
    } else if (stopPct !== undefined) {
      nextStopPct = stopPct
      nextTrigger = prev.armPrice * (1 - stopPct / 100)
    }
    const arm: SafeModeArm = {
      ...prev,
      stopPct: nextStopPct,
      exitPct: exitPct !== undefined ? exitPct : prev.exitPct,
      triggerPrice: nextTrigger,
      adjustedAt: Date.now(),
    }
    // Replace the arm in place — the resting order is never cancelled or re-placed.
    this.setSafeMode([...this.snapshot.safeMode.filter((a) => a.orderId !== orderId), arm])
    return { ok: true, arm }
  }

  /** Drop arms whose guarded order no longer rests (filled or cancelled elsewhere). Called
   *  after each full refresh once openOrders is authoritative. Also prunes stale opt-outs. */
  private pruneSafeMode(): void {
    const live = new Set(this.snapshot.openOrders.map((o) => o.orderId))
    const kept = this.snapshot.safeMode.filter((a) => live.has(a.orderId) || this.safeModeFiring.has(a.orderId))
    if (kept.length !== this.snapshot.safeMode.length) this.setSafeMode(kept)
    // Forget opt-outs for orders that no longer exist so the id set can't grow unbounded.
    let optOutChanged = false
    for (const id of this.safeModeOptOut) if (!live.has(id)) { this.safeModeOptOut.delete(id); optOutChanged = true }
    if (optOutChanged) saveSafeModeOptOut([...this.safeModeOptOut])
  }

  /** Order ids belonging to fast-cash bracket plans (entry/stop/tp legs). fast-cash is
   *  intentionally STOPLESS — auto-arming its resting take-profit with safe mode's default
   *  synthetic stop would silently re-introduce the very stop the strategy forgoes, so these
   *  are excluded from default-on safe mode. (The user can still arm one manually.) */
  /** Order ids AND symbols belonging to any stopless-by-design plan (FAST_CASH or
   *  OVERSOLD). Both tracks run stopless with safe mode disabled by design, so safe mode
   *  must never default-arm their orders. We match on both the tracked bracket order ids
   *  and the plan's symbol: the id set alone misses the position time-stop re-sell (a
   *  fresh order not stored as tp1Id/tp2Id) and any window where the resting TP is live on
   *  the exchange before its id is persisted into bracketState. */
  private fastCashGuard(): { ids: Set<string>; symbols: Set<string> } {
    const ids = new Set<string>()
    const symbols = new Set<string>()
    for (const plan of autoPlanner.getAllStatuses()) {
      // Prefer the explicit strategy tag; fall back to the old free-text label match so plans
      // staged before tagging existed (and any hand-written step) are still covered. The regex
      // was the entire mechanism previously — a grep over prose the agent wrote, which silently
      // stopped protecting a stopless track the moment a label was phrased differently.
      const tagged = plan.steps.some((s) => s.strategy === 'fast-cash' || s.strategy === 'oversold')
      const label = (plan.proposedLabel || '') + ' ' + plan.steps.map((s) => s.label || '').join(' ')
      if (!tagged && !/FAST_CASH|OVERSOLD/i.test(label)) continue
      for (const step of plan.steps) {
        // Never let BTCUSD into the SYMBOL-level exclusion. This set exists to catch a stopless
        // track's re-sells whose order ids aren't known yet, but it excludes by symbol — so a
        // fast-cash/oversold plan that ever touches BTC would also stop safe mode auto-arming
        // the LADDER's BTC sells, which are not stopless and do want protection. Id-level
        // exclusion below still covers this plan's own orders precisely.
        if (step.symbol && step.symbol.toUpperCase() !== 'BTCUSD') symbols.add(step.symbol.toUpperCase())
        const bs = step.bracketState
        if (!bs) continue
        for (const id of [bs.entryId, bs.stopId, bs.tp1Id, bs.tp2Id]) if (id) ids.add(id)
      }
    }
    return { ids, symbols }
  }

  /**
   * Every order id currently owned by a LIVE bracket, whatever strategy staged it.
   *
   * Safe mode and the bracket monitor are two independent controllers. If safe mode
   * arms an order the monitor also manages, they fight: safe mode cancels and
   * re-lists near market, the monitor sees `is_cancelled`, nulls its tp1Id/stopId
   * and self-heals a replacement against a balance safe mode has partly locked.
   * The observed outcomes were a position left UNPROTECTED with the single-shot arm
   * already consumed, a fill safe mode never credited (so the closed-trade ledger
   * recorded the wrong realizedUsd), and duplicate-sell churn every 20s.
   *
   * fastCashGuard() below covers only the stopless tracks and only four id fields.
   * This covers every bracket and every field that can hold a resting order —
   * including per-leg entry TPs and staged exit legs, which the narrower guard
   * missed entirely.
   */
  private bracketOwnedOrderIds(): Set<string> {
    const ids = new Set<string>()
    for (const plan of autoPlanner.getAllStatuses()) {
      for (const step of plan.steps) {
        const bs = step.bracketState
        if (!bs) continue
        // A finished bracket owns nothing; leaving its ids in would permanently
        // exclude recycled order ids from protection.
        if (bs.phase === 'flat') continue
        for (const id of [bs.entryId, bs.stopId, bs.tp1Id, bs.tp2Id]) if (id) ids.add(id)
        for (const leg of bs.entryLegs ?? []) {
          if (leg.orderId) ids.add(leg.orderId)
          if (leg.tpId) ids.add(leg.tpId)
        }
        for (const leg of bs.exitLegs ?? []) if (leg.orderId) ids.add(leg.orderId)
      }
    }
    return ids
  }

  /** Default-on: auto-arm every eligible resting SELL order that isn't already armed and
   *  hasn't been explicitly disarmed. Uses the default stop/exit levels. FAST_CASH and
   *  OVERSOLD orders are excluded — those tracks run stopless by design — as is any
   *  order a live bracket is already managing (see bracketOwnedOrderIds). */
  private autoArmSafeMode(): void {
    const fastCash = this.fastCashGuard()
    const bracketOwned = this.bracketOwnedOrderIds()
    for (const o of this.snapshot.openOrders) {
      if (o.side !== 'sell') continue
      // stopless tracks — never default-arm any of their orders (by id or by symbol,
      // so the position time-stop re-sell and pre-persist windows are covered too).
      if (fastCash.ids.has(o.orderId) || fastCash.symbols.has(o.symbol.toUpperCase())) continue
      // Already has a controller: the bracket monitor manages its own stop/TP legs.
      if (bracketOwned.has(o.orderId)) continue
      if (this.safeModeOptOut.has(o.orderId)) continue
      if (this.snapshot.safeMode.some((a) => a.orderId === o.orderId)) continue
      if (this.currentPrice(o.symbol) === null) continue  // retry next refresh once priced
      this.armSafeMode(o.orderId, SAFE_MODE_DEFAULT_STOP_PCT, SAFE_MODE_DEFAULT_EXIT_PCT)
    }
  }

  /** Evaluate every armed stop against the latest marks. When price has fallen to/through
   *  the trigger, cancel the resting order and re-post a SELL limit just above market. Runs
   *  each hot refresh (~7s). Serialized per-order via `safeModeFiring` so a slow
   *  cancel+replace can't double-fire across ticks. */
  private async checkSafeMode(): Promise<void> {
    for (const arm of this.snapshot.safeMode) {
      if (this.safeModeFiring.has(arm.orderId)) continue
      const price = this.currentPrice(arm.symbol)
      if (price === null || price > arm.triggerPrice) continue
      this.safeModeFiring.add(arm.orderId)
      try {
        await this.fireSafeMode(arm, price)
      } catch (e) {
        console.warn('[crypto] safe-mode fire failed:', (e as Error).message)
      } finally {
        this.safeModeFiring.delete(arm.orderId)
      }
    }
  }

  private async fireSafeMode(arm: SafeModeArm, price: number): Promise<void> {
    const order = this.snapshot.openOrders.find((o) => o.orderId === arm.orderId)
    // Arm is single-shot: remove it up-front so it can't re-fire even if the replace fails.
    this.setSafeMode(this.snapshot.safeMode.filter((a) => a.orderId !== arm.orderId))
    const base = arm.symbol.replace('USD', '')
    if (!order) return  // order vanished (filled/cancelled) between arm and fire — nothing to do
    const amount = order.remainingAmount
    if (!(Number(amount) > 0)) return

    try {
      await cancelOrderVerified(arm.orderId)
      this.snapshot = {
        ...this.snapshot,
        openOrders: this.snapshot.openOrders.filter((o) => o.orderId !== arm.orderId),
      }
      this.broadcast()
    } catch (e) {
      cryptoToast(`${base} SAFE MODE — cancel failed`, (e as Error).message, 'critical', 'ti-alert-triangle')
      return
    }

    const exitPx = price * (1 + arm.exitPct / 100)
    try {
      const newOrderId = await placeOrder(arm.symbol, 'sell', amount, String(exitPx))
      cryptoToast(
        `${base} SAFE MODE triggered @ $${price}`,
        `Re-listed SELL ${amount} @ $${exitPx} (+${arm.exitPct}% over market) · order ${newOrderId}`,
        'notice'
      )
      void this.refreshOpenOrders()
    } catch (e) {
      cryptoToast(`${base} SAFE MODE — re-list failed, position UNPROTECTED`, (e as Error).message, 'critical', 'ti-alert-triangle')
    }
  }

  // ── Loop mode: auto-run the strategy after a position closes ────────────
  getLoopMode(): boolean { return this.snapshot.loopMode }

  setLoopMode(enabled: boolean): boolean {
    saveLoopMode(enabled)
    this.snapshot = { ...this.snapshot, loopMode: enabled }
    if (!enabled && this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null }
    this.broadcast()
    return enabled
  }

  // ── Interval timer: auto-run the enabled strategy every N minutes ────────
  getStrategyInterval(): number { return this.snapshot.strategyIntervalMin }

  /** Set the auto-run interval in minutes (0 or negative = off). Clamped to
   *  [1, 1440]. (Re)arms the recurring server timer; persisted across restarts.
   *  Stays stored (and reactivates automatically) even while inert due to a
   *  per-strategy interval being set — see armIntervalTimer's early-return. */
  setStrategyInterval(minutes: number): number {
    const m = Number.isFinite(minutes) && minutes > 0
      ? Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(minutes)))
      : 0
    saveStrategyInterval(m)
    this.snapshot = { ...this.snapshot, strategyIntervalMin: m }
    this.armIntervalTimer()
    this.broadcast()
    return m
  }

  /** (Re)arm the recurring interval timer from the current setting. Idempotent —
   *  clears any existing timer first. Called on set and once on startup. Inert
   *  (never armed) while any strategy has its own individual interval — scheduling
   *  has moved to armPerStrategyTimers() instead. */
  private armIntervalTimer(): void {
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null }
    if (this.hasAnyPerStrategyInterval()) return
    const m = this.snapshot.strategyIntervalMin
    if (m <= 0) return
    this.intervalTimer = setInterval(() => {
      const strategy = getEnabledStrategy()
      this.enqueueOrRun(strategy, `Interval timer (every ${m}m)`)
    }, m * 60_000)
  }

  // ── Per-strategy interval timers ──────────────────────────────────────────
  getStrategyIntervals(): Record<string, number> { return this.snapshot.strategyIntervals }

  private hasAnyPerStrategyInterval(): boolean {
    return Object.values(this.snapshot.strategyIntervals).some((m) => m > 0)
  }

  /** Set (or clear, with minutes<=0) one strategy's individual interval. Re-arms
   *  both the per-strategy timers and the universal one (which goes inert/reactivates
   *  depending on whether any per-strategy interval remains). Persisted across restarts. */
  setStrategyIntervalFor(strategy: StrategyId, minutes: number): Record<string, number> {
    const next = { ...this.snapshot.strategyIntervals }
    const m = Number.isFinite(minutes) && minutes > 0
      ? Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(minutes)))
      : 0
    if (m > 0) next[strategy] = m
    else delete next[strategy]
    saveStrategyIntervals(next)
    this.snapshot = { ...this.snapshot, strategyIntervals: next }
    this.armPerStrategyTimers()
    this.armIntervalTimer()
    this.broadcast()
    return next
  }

  /** (Re)arm every per-strategy interval timer from the current settings. Idempotent. */
  private armPerStrategyTimers(): void {
    for (const t of this.perStrategyTimers.values()) clearInterval(t)
    this.perStrategyTimers.clear()
    for (const [id, m] of Object.entries(this.snapshot.strategyIntervals)) {
      if (m <= 0 || !isStrategyId(id)) continue
      const timer = setInterval(() => {
        this.enqueueOrRun(id, `${id} interval timer (every ${m}m)`)
      }, m * 60_000)
      this.perStrategyTimers.set(id, timer)
    }
  }

  /** Start a strategy run now, or — if one is already in flight — queue it (deduped)
   *  to run automatically the moment strategyRunner goes idle, rather than dropping
   *  the fire. Shared by both the universal and per-strategy interval timers. */
  private enqueueOrRun(strategy: StrategyId, reason: string): void {
    if (!strategyRunner.isRunning()) {
      if (strategyRunner.start(strategy)) {
        cryptoToast('Interval timer', `Auto-running ${strategy} — ${reason}`, 'notice')
      }
      return
    }
    if (!this.scheduledQueue.includes(strategy)) {
      this.scheduledQueue.push(strategy)
      cryptoToast('Interval timer', `${strategy} — ${reason} — queued behind the in-flight run`, 'notice')
    }
  }

  /** Polled every 5s: starts the next queued strategy once strategyRunner is idle. */
  private drainScheduledQueue(): void {
    if (this.scheduledQueue.length === 0 || strategyRunner.isRunning()) return
    const strategy = this.scheduledQueue.shift()!
    if (strategyRunner.start(strategy)) {
      cryptoToast('Interval timer', `Running queued strategy ${strategy}`, 'notice')
    }
  }

  /** Count bracket positions that actually hold coins right now. 'entering' is excluded
   *  (no fill yet) so an aborted, never-filled entry doesn't read as a close. */
  private heldPositionCount(): number {
    const HELD = new Set<string>(['protected', 'tp1_filled', 'exiting'])
    let n = 0
    for (const plan of autoPlanner.getAllStatuses()) {
      if (!plan.active) continue
      for (const step of plan.steps) {
        const st = step.bracketState
        if (step.kind === 'bracket' && st && HELD.has(st.phase)) n++
      }
    }
    return n
  }

  /** Called every refresh: when the held-position count drops, a position just closed —
   *  schedule a loop-mode strategy run. */
  private detectPositionClose(): void {
    const count = this.heldPositionCount()
    if (count < this.prevPositionCount && this.snapshot.loopMode) this.scheduleLoopRun()
    this.prevPositionCount = count
  }

  private scheduleLoopRun(): void {
    if (this.loopTimer) return  // a fire is already pending — don't stack
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null
      const last = strategyRunner.getLastRunAt()
      if (strategyRunner.isRunning()) return
      if (last !== null && Date.now() - last < LOOP_MIN_GAP_MS) {
        console.log('[crypto] loop mode: skipped — strategy ran within the last 10 min')
        return
      }
      const strategy = getEnabledStrategy()
      if (strategyRunner.start(strategy)) {
        cryptoToast('Loop mode', `Position closed → running ${strategy}`, 'notice')
      }
    }, LOOP_FIRE_DELAY_MS)
  }
}

export const cryptoHub = new CryptoHub()
