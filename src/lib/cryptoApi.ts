// REST client for the CRYPTO tab. Mirrors financeApi.ts conventions.

import type { CryptoSnapshot, CryptoPositionsSnapshot, TradeRecord, StrategyDefinition } from '../../shared/crypto'
import type { CryptoAlert, AlertSourceId, AlertAction, AlertTimeframe } from '../../shared/alerts'
import type { AuditEntry, AuditVerifyResult } from '../../shared/audit'
import type { TimelinePayload } from '../../shared/timeline'
import type { ClaudeProcess } from '../../shared/claude'

function apiBase(): string {
  const explicit = (window as any).__HOMUNCULUS_API__ as string | undefined
  if (explicit) return explicit.replace(/\/$/, '')
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:8787`
  return location.origin
}

function token(): string {
  const q = new URLSearchParams(location.search)
  return q.get('token') || (window as any).__HOMUNCULUS_TOKEN__ || ''
}

function withToken(path: string): string {
  const t = token()
  if (!t) return path
  return path + (path.includes('?') ? '&' : '?') + `token=${encodeURIComponent(t)}`
}

export async function fetchCryptoSnapshot(): Promise<CryptoSnapshot> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/snapshot')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { ok: boolean; snapshot: CryptoSnapshot }
  return data.snapshot
}

/** The open-position slice (a few KB) rather than the whole ~750 KB snapshot. Use this
 *  for anything that polls continuously; fetchCryptoSnapshot is for the CRYPTO tab, which
 *  genuinely renders signals/tradeHistory/reports. */
export async function fetchCryptoPositions(): Promise<CryptoPositionsSnapshot> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/positions')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { ok: boolean; snapshot: CryptoPositionsSnapshot }
  return data.snapshot
}

export async function fetchCryptoTrades(): Promise<TradeRecord[]> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/trades')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { ok: boolean; trades: TradeRecord[] }
  return data.trades
}

export async function executeTrade(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/trade/${id}/execute`)}`, {
    method: 'POST',
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function dismissTrade(id: string): Promise<void> {
  await fetch(`${apiBase()}${withToken(`/api/crypto/trade/${id}/dismiss`)}`, { method: 'POST' })
}

export async function refreshCrypto(): Promise<void> {
  await fetch(`${apiBase()}${withToken('/api/crypto/refresh')}`, { method: 'POST' })
}

export async function resetPortfolioBaseline(): Promise<void> {
  await fetch(`${apiBase()}${withToken('/api/crypto/portfolio-baseline/reset')}`, { method: 'POST' })
}

// Reconstruct the baseline as of a past date (unix ms) from trade + transfer history.
export async function reconstructPortfolioBaseline(fromMs: number): Promise<{ truncated: boolean }> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/portfolio-baseline')}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reconstructFrom: fromMs }),
  })
  const data = (await res.json()) as { truncated?: boolean }
  return { truncated: !!data.truncated }
}

// Manually set the baseline BTC/USD held at a given time (unix ms).
export async function setPortfolioBaseline(btc: number, usd: number, at: number): Promise<void> {
  await fetch(`${apiBase()}${withToken('/api/crypto/portfolio-baseline')}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ btc, usd, at }),
  })
}

export interface AutoExecuteConfig {
  enabled: boolean
  btcLadderMaxUsd: number
  altMaxUsd: number
  /** Per-strategy opt-out. Absent key ⇒ opted in. `enabled` is the master switch: a
   *  strategy runs autonomously only when both it and the master are on. */
  perStrategy: Record<string, boolean>
}

export async function fetchAutoExecute(): Promise<AutoExecuteConfig> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/auto-execute')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { config: AutoExecuteConfig }
  return data.config
}

export async function setAutoExecute(patch: { enabled?: boolean; btcLadderMaxUsd?: number; altMaxUsd?: number; perStrategy?: Record<string, boolean> }): Promise<AutoExecuteConfig> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/auto-execute')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = (await res.json()) as { config: AutoExecuteConfig }
  return data.config
}

export type StrategyRunState = 'idle' | 'running' | 'done' | 'error'
export type StrategyId = 'crypto-strategy' | 'btc-ladder' | 'fast-cash' | 'oversold' | 'crypto-candles' | 'firecracker' | 'sniper' | 'reaper' | 'trapline'

// Selectable strategies — mirrors STRATEGIES in server/strategyRunner.ts.
export const STRATEGY_OPTIONS: { id: StrategyId; label: string }[] = [
  { id: 'crypto-strategy', label: 'CRYPTO STRATEGY' },
  { id: 'btc-ladder', label: 'BTC LADDER' },
  { id: 'fast-cash', label: 'FAST CASH' },
  { id: 'oversold', label: 'OVERSOLD' },
  { id: 'crypto-candles', label: 'CANDLES' },
  { id: 'firecracker', label: 'FIRECRACKER' },
  { id: 'sniper', label: 'SNIPER' },
  { id: 'reaper', label: 'REAPER' },
  { id: 'trapline', label: 'TRAPLINE' }
]

export type StrategyRunSource = 'app' | 'routine'

export interface StrategyRunStatus {
  state: StrategyRunState
  strategy: StrategyId
  source: StrategyRunSource // 'app' = RUN button, 'routine' = headless/scheduled run
  startedAt: number | null
  endedAt: number | null
  activity: string
  error: string | null
}

// Manually trigger a strategy skill. Returns ok:false if one is already running.
export async function runCryptoStrategy(strategy: StrategyId = 'crypto-strategy'): Promise<{ ok: boolean; error?: string; status: StrategyRunStatus }> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/run')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy })
  })
  return res.json() as Promise<{ ok: boolean; error?: string; status: StrategyRunStatus }>
}

// Loop mode — auto-run the enabled strategy ~10s after a position closes.
export async function fetchLoopMode(): Promise<boolean> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/loop-mode')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { enabled: boolean }
  return data.enabled
}

export async function setLoopMode(enabled: boolean): Promise<boolean> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/loop-mode')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  const data = (await res.json()) as { enabled: boolean }
  return data.enabled
}

// Interval timer: auto-run the enabled strategy every N minutes server-side (0 = off).
export async function fetchStrategyInterval(): Promise<number> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/interval')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { minutes: number }
  return data.minutes
}

export async function setStrategyInterval(minutes: number): Promise<number> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/interval')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  })
  const data = (await res.json()) as { minutes: number }
  return data.minutes
}

// Per-strategy interval timers — each strategy can carry its own auto-run cadence
// instead of sharing the single universal interval above. Setting any of these makes
// the universal one go inert (see server/crypto.ts armIntervalTimer).
export async function fetchStrategyIntervals(): Promise<Record<string, number>> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/intervals')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { intervals: Record<string, number> }
  return data.intervals
}

export async function setStrategyIntervalFor(strategy: StrategyId, minutes: number): Promise<Record<string, number>> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/strategy/intervals?strategy=${encodeURIComponent(strategy)}`)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  })
  const data = (await res.json()) as { intervals: Record<string, number> }
  return data.intervals
}

// Admin panel — every strategy's tunable knobs (bid size, TP%, RSI/score floors,
// spread caps). Strategies are data, not a fixed union — new ones can be created via
// createStrategy() below without a code change.
export async function fetchStrategyDefinitions(): Promise<StrategyDefinition[]> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/settings')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { definitions: StrategyDefinition[] }
  return data.definitions
}

export async function setStrategySettings(strategy: string, patch: Record<string, number>): Promise<Record<string, number>> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/strategy/settings?strategy=${encodeURIComponent(strategy)}`)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = (await res.json()) as { settings: Record<string, number> }
  return data.settings
}

export async function resetStrategySettings(strategy: string): Promise<Record<string, number>> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/strategy/settings?strategy=${encodeURIComponent(strategy)}&reset=1`)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = (await res.json()) as { settings: Record<string, number> }
  return data.settings
}

export interface NewStrategyField { key: string; label: string; min: number; max: number; step: number; unit: string; default: number }

export async function createStrategy(input: { label: string; description?: string; fields: NewStrategyField[] }): Promise<StrategyDefinition> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/create')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json()) as { ok: boolean; error?: string; definition: StrategyDefinition }
  if (!data.ok) throw new Error(data.error || 'create failed')
  return data.definition
}

export async function fetchStrategyStatus(): Promise<StrategyRunStatus> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/status')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { status: StrategyRunStatus }
  return data.status
}

// The persisted "which strategy is enabled" preference — the single source of truth
// a headless routine (/crypto-strategy) dispatches on. The segmented control writes it.
export async function fetchEnabledStrategy(): Promise<StrategyId> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/enabled')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { strategy: StrategyId }
  return data.strategy
}

export async function setEnabledStrategy(strategy: StrategyId): Promise<StrategyId> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/strategy/enabled')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy })
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { strategy: StrategyId }
  return data.strategy
}

// `symbol` targets a specific plan — multiple plans (different symbols) can be active
// concurrently, so most controls need to say which one they mean. Omit it only when
// you know exactly one plan exists; the server rejects an ambiguous omitted call.
export async function startAutoPlan(): Promise<void> {
  await fetch(`${apiBase()}${withToken('/api/crypto/autoplan/start')}`, { method: 'POST' })
}
export async function stopAutoPlan(symbol?: string): Promise<void> {
  const path = symbol ? `/api/crypto/autoplan/stop?symbol=${encodeURIComponent(symbol)}` : '/api/crypto/autoplan/stop'
  await fetch(`${apiBase()}${withToken(path)}`, { method: 'POST' })
}
export async function resetAutoPlan(symbol?: string): Promise<void> {
  const path = symbol ? `/api/crypto/autoplan/reset?symbol=${encodeURIComponent(symbol)}` : '/api/crypto/autoplan/reset'
  await fetch(`${apiBase()}${withToken(path)}`, { method: 'POST' })
}
export async function confirmAutoPlan(symbol?: string): Promise<void> {
  const path = symbol ? `/api/crypto/autoplan/confirm?symbol=${encodeURIComponent(symbol)}` : '/api/crypto/autoplan/confirm'
  await fetch(`${apiBase()}${withToken(path)}`, { method: 'POST' })
}
export async function patchAutoPlanStep(
  stepId: string,
  patch: { limitPrice?: string; stopPrice?: string; amountSpec?: string; tp1Price?: string; approved?: boolean },
  symbol?: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/autoplan/step/${stepId}`)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(symbol ? { ...patch, symbol } : patch),
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

// Lock/unlock a live managed bracket — while locked, the monitor freezes the trade exactly
// as-is (no TP scale-out, final exit, trailing ratchet, or position time-stop exit).
export async function setBracketLock(symbol: string, locked: boolean): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/bracket/lock')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol, locked }),
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function stageTrade(trade: {
  symbol: string; side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop-limit'
  amount: string; price?: string; stopPrice?: string
  orderOptions?: ('maker-or-cancel' | 'immediate-or-cancel' | 'fill-or-kill')[]
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/stage')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(trade),
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function cancelOpenOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/order/${orderId}/cancel`)}`, { method: 'POST' })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

// Cancel a resting order and immediately re-open it as a marketable limit at the current
// market price, closing the position now.
export async function closePosition(orderId: string): Promise<{ ok: boolean; error?: string; newOrderId?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/order/${orderId}/close`)}`, { method: 'POST' })
  return res.json() as Promise<{ ok: boolean; error?: string; newOrderId?: string }>
}

// Cancel every resting order for a symbol and sell 100% of the held quantity as a single
// limit order priced 0.1% above the current market price.
export async function closeSymbolPosition(symbol: string): Promise<{ ok: boolean; error?: string; newOrderId?: string; cancelledOrderIds?: string[] }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/position/${symbol}/close`)}`, { method: 'POST' })
  return res.json() as Promise<{ ok: boolean; error?: string; newOrderId?: string; cancelledOrderIds?: string[] }>
}

// Modify a resting order (cancel-and-replace under the hood — Gemini has no native amend).
// Only the fields you pass change; the rest keep the order's current values.
export async function modifyOpenOrder(
  orderId: string,
  patch: { price?: string; amount?: string; stopPrice?: string },
): Promise<{ ok: boolean; error?: string; newOrderId?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/order/${orderId}/modify`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return res.json() as Promise<{ ok: boolean; error?: string; newOrderId?: string }>
}

// Arm a software-side synthetic stop (safe mode) on a resting SELL order: the server watches
// the price and, when it drops stopPct below the arm price, cancels the order and re-lists a
// SELL limit exitPct above market. Pass enabled:false to disarm.
export async function setSafeMode(
  orderId: string,
  opts: { enabled: boolean; stopPct?: number; exitPct?: number },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/order/${orderId}/safe-mode`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

// Move/alter an already-armed safe-mode stop IN PLACE — the resting order is never cancelled
// or re-placed, so the guarded SELL keeps working. Adjusts the % off the fixed arm-price basis
// (or set an absolute triggerPrice). Only supplied fields change; omit the rest to leave them.
export async function adjustSafeMode(
  orderId: string,
  opts: { stopPct?: number; exitPct?: number; triggerPrice?: number },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/order/${orderId}/safe-mode`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adjust: true, ...opts }),
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function postPlanReport(report: string): Promise<void> {
  await fetch(`${apiBase()}${withToken('/api/crypto/plan-report')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ report }),
  })
}

/** Fetch cached candle data for a symbol+timeframe. Returns oldest-first tuples [ts,o,h,l,c,v]. */
export async function fetchCandles(symbol: string, tf: string): Promise<[number,number,number,number,number,number][]> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/candles/${symbol}/${tf}`)}`)
  if (!res.ok) throw new Error(`${res.status}`)
  const data = (await res.json()) as { candles: [number,number,number,number,number,number][] }
  return data.candles
}

// ── MARKET indicator alerts ──────────────────────────────────────────────────
// Alerts live and fire on the server so they keep working with the app closed;
// these calls are the arming console, not the engine.

export async function fetchAlerts(symbol?: string): Promise<CryptoAlert[]> {
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/alerts${q}`)}`)
  const data = (await res.json()) as { ok: boolean; alerts?: CryptoAlert[] }
  return data.alerts ?? []
}

export async function createAlert(input: {
  symbol: string; source: AlertSourceId; condition: string; value: number | null
  tf: AlertTimeframe; action: AlertAction; stageUsd?: number; once?: boolean
  /** Agent to start when this fires. Independent of `action`. */
  wakeAgentId?: string | null
}): Promise<{ ok: boolean; error?: string; alert?: CryptoAlert }> {
  const res = await fetch(`${apiBase()}${withToken('/api/crypto/alerts')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return res.json() as Promise<{ ok: boolean; error?: string; alert?: CryptoAlert }>
}

export async function deleteAlert(id: string): Promise<void> {
  await fetch(`${apiBase()}${withToken(`/api/crypto/alerts/${id}`)}`, { method: 'DELETE' })
}

export async function setAlertArmed(id: string, armed: boolean): Promise<void> {
  await fetch(`${apiBase()}${withToken(`/api/crypto/alerts/${id}/arm`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ armed }),
  })
}

// ── Audit log ────────────────────────────────────────────────────────────
// Read-only. There is deliberately no client function that edits or deletes an
// entry, because there is no server route that would accept one.

export async function fetchAuditEntries(
  filter: { actor?: string; action?: string; resource?: string; limit?: number; before?: number } = {},
): Promise<{ entries: AuditEntry[]; nextCursor: number | null }> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') q.set(k, String(v))
  const query = q.toString()
  const res = await fetch(`${apiBase()}${withToken(`/api/audit${query ? `?${query}` : ''}`)}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { entries: AuditEntry[]; nextCursor: number | null }
  return { entries: data.entries, nextCursor: data.nextCursor }
}

export async function verifyAuditChain(): Promise<AuditVerifyResult> {
  const res = await fetch(`${apiBase()}${withToken('/api/audit/verify')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { result: AuditVerifyResult }
  return data.result
}

export async function fetchTimeline(since: number, until: number): Promise<TimelinePayload> {
  const res = await fetch(`${apiBase()}${withToken(`/api/crypto/timeline?since=${since}&until=${until}`)}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { timeline: TimelinePayload }
  return data.timeline
}

// ── Live Claude sessions ─────────────────────────────────────────────────

export async function fetchRunningClaude(): Promise<ClaudeProcess[]> {
  const res = await fetch(`${apiBase()}${withToken('/api/claude/running')}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const data = (await res.json()) as { processes: ClaudeProcess[] }
  return data.processes
}

/** Stops one session. `ok: false` usually means it finished first — not an error. */
export async function stopClaudeProcess(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${apiBase()}${withToken(`/api/claude/${id}/stop`)}`, { method: 'POST' })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}
