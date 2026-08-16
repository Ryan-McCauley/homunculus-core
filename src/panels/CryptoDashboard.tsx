import { useState, useEffect, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { CryptoSnapshot, Ticker, Signal, PendingTrade, TradeRecord, GeminiOpenOrder, GeminiTrade, BtcLadderAlert, BtcLadderCycle, AutoExecuteConfig, PortfolioGrowth, PlanReportEntry, SafeModeArm, StrategyDefinition, StrategySettingsField } from '../../shared/crypto'
import { TRADE_HISTORY_SINCE_MS, GLOBAL_STRATEGY_ID } from '../../shared/crypto'
import { fetchCryptoSnapshot, fetchCryptoTrades, executeTrade, dismissTrade, refreshCrypto, stageTrade, stopAutoPlan, resetAutoPlan, cancelOpenOrder, closePosition, closeSymbolPosition, modifyOpenOrder, setSafeMode, adjustSafeMode, confirmAutoPlan, patchAutoPlanStep, setBracketLock, runCryptoStrategy, fetchStrategyStatus, fetchEnabledStrategy, setEnabledStrategy as setEnabledStrategyApi, fetchLoopMode, setLoopMode, fetchStrategyInterval, setStrategyInterval, fetchStrategyIntervals, setStrategyIntervalFor, fetchAutoExecute, setAutoExecute, resetPortfolioBaseline, reconstructPortfolioBaseline, setPortfolioBaseline, STRATEGY_OPTIONS, fetchStrategyDefinitions, setStrategySettings, resetStrategySettings, createStrategy } from '../lib/cryptoApi'
import type { StrategyRunStatus, StrategyId, NewStrategyField } from '../lib/cryptoApi'
import { fetchAuditEntries, verifyAuditChain } from '../lib/cryptoApi'
import type { AuditEntry, AuditVerifyResult } from '../../shared/audit'

const STRATEGY_PREF_KEY = 'homunculus.crypto.strategy'
import type { AutoPlanStatus, AutoStep } from '../../shared/crypto'
import { IntelligenceSection } from './IntelligenceSection'
import { MarketSection } from './market/MarketSection'
import { ScreenersSection } from './Screeners'

// ── Types ──────────────────────────────────────────────────────────────
type Section = 'OVERVIEW' | 'MARKET' | 'SCREENERS' | 'TRADES' | 'INTELLIGENCE' | 'SETTINGS' | 'AUDIT'

// ── Style constants ────────────────────────────────────────────────────
const G = 'var(--green)'
const GD = 'var(--green-dim)'
const CR = 'var(--crimson)'
const BORDER = '0.5px solid var(--border)'
// Orbital-dial palette: buys read cool/blue, sells crimson, and anything within
// 1% of its trigger burns amber regardless of side.
const BUY_C = 'var(--blue)'
const HOT_C = 'var(--amber)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

// ── Formatting helpers ─────────────────────────────────────────────────
function fmtPrice(n: number | string): string {
  const v = Number(n)
  if (isNaN(v) || v === 0) return '—'
  if (v >= 10000) return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (v >= 1000) return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (v >= 1) return '$' + v.toFixed(4)
  return '$' + v.toPrecision(4)
}

function fmtNum(n: number | string, d = 2): string {
  const v = Number(n)
  return isNaN(v) ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** Signed USD amount: "+$1.23" / "−$1.23". Every P&L figure must carry its sign —
 *  rendering a loss as a bare "$0.07" (abs value, sign only on the neighbouring
 *  percentage) reads as a gain at a glance. Uses a true minus sign to match the
 *  percentages beside it. */
function fmtSignedUsd(n: number, d = 2): string {
  const v = Number(n) || 0
  return `${v < 0 ? '−' : '+'}$${fmtNum(Math.abs(v), d)}`
}
function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function changeColor(c: number) { return c > 0 ? G : c < 0 ? CR : GD }

function Lbl({ c = GD, children, size = 11 }: { c?: string; children: React.ReactNode; size?: number }) {
  return <span style={{ fontSize: size, letterSpacing: 0.8, color: c, ...MONO }}>{children}</span>
}

function Val({ c = G, children, size = 13 }: { c?: string; children: React.ReactNode; size?: number }) {
  return <span style={{ fontSize: size, color: c, ...MONO }}>{children}</span>
}

function MiniBar({ pct, color = G, height = 2 }: { pct: number; color?: string; height?: number }) {
  return (
    <div style={{ height, background: 'var(--bg-elev)', borderRadius: 1, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', background: color, borderRadius: 1, transition: 'width 0.4s' }} />
    </div>
  )
}

// Tug-of-war price bar: the two poles are the order's limit/stop (the exit floor)
// and its take-profit target (the goal). The current price rides between them as a
// marker — the closer it sits to a pole, the closer that outcome. Left pole is the
// downside (limit/stop), right pole the upside (target); the marker is a bright tick.
function TugOfWarBar({ low, high, current, lowLabel, highLabel, lowColor = CR, highColor = G }: {
  low: number; high: number; current: number
  lowLabel: string; highLabel: string
  lowColor?: string; highColor?: string
}) {
  const span = high - low
  const raw = span !== 0 ? ((current - low) / span) * 100 : 50
  const pos = Math.max(0, Math.min(100, raw))
  // Marker sits above the losing (crimson) region until it crosses the midpoint.
  const markColor = pos >= 50 ? highColor : lowColor
  return (
    <div>
      <div style={{ position: 'relative', height: 6, marginBottom: 3 }}>
        {/* two-tone track: crimson downside on the left, green upside on the right */}
        <div style={{ position: 'absolute', inset: 0, borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: `${pos}%`, background: lowColor, opacity: 0.28 }} />
          <div style={{ flex: 1, background: highColor, opacity: 0.28 }} />
        </div>
        {/* current-price marker */}
        <div style={{
          position: 'absolute', top: -2, bottom: -2, left: `${pos}%`, width: 2,
          marginLeft: -1, background: markColor, boxShadow: `0 0 4px ${markColor}`,
          transition: 'left 0.4s',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Lbl size={9} c={lowColor}>{lowLabel}</Lbl>
        <Val size={11} c={markColor}>{fmtPrice(current)}</Val>
        <Lbl size={9} c={highColor}>{highLabel}</Lbl>
      </div>
    </div>
  )
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ borderBottom: BORDER, paddingBottom: 5, marginBottom: 10 }}>
      <span style={{ fontSize: 17, letterSpacing: 2, color: G, ...MONO }}>{title}</span>
      {sub && <span style={{ fontSize: 16, letterSpacing: 0.8, color: GD, ...MONO }}> · {sub}</span>}
    </div>
  )
}


function SeedBar({ total, seeded, active }: { total: number; seeded: number; active: boolean }) {
  if (!active && seeded >= total && total > 0) return null
  const pct = total > 0 ? (seeded / total) * 100 : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...MONO }}>
      <Lbl>SEEDING {seeded}/{total}</Lbl>
      <div style={{ flex: 1, height: 2, background: 'var(--bg-elev)', borderRadius: 1 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: G, borderRadius: 1, transition: 'width 0.5s' }} />
      </div>
      <Lbl>{pct.toFixed(0)}%</Lbl>
    </div>
  )
}
function PendingCard({ trade, ticker, onExecute, onDismiss }: {
  trade: PendingTrade; ticker?: Ticker; onExecute: () => void; onDismiss: () => void
}) {
  const currentPrice = ticker ? Number(ticker.last) : null
  const limitPrice = trade.price ? Number(trade.price) : null
  const sideCol = trade.side === 'buy' ? G : CR

  // Distance from current price to limit trigger
  // BUY limit: fills when price drops to limitPrice — negative distance = already past limit
  // SELL limit: fills when price rises to limitPrice
  let distPct: number | null = null
  let progressPct = 0
  let proximityColor = GD
  if (currentPrice && limitPrice) {
    if (trade.side === 'buy') {
      distPct = ((currentPrice - limitPrice) / limitPrice) * 100  // positive = price needs to fall
    } else {
      distPct = ((limitPrice - currentPrice) / currentPrice) * 100  // positive = price needs to rise
    }
    // Progress bar: 100% = at limit, 0% = far away (>10% from limit)
    progressPct = Math.max(0, Math.min(100, 100 - Math.abs(distPct) * 10))
    proximityColor = Math.abs(distPct) < 1 ? G : Math.abs(distPct) < 3 ? '#c8a227' : GD
  }

  return (
    <div style={{ border: `0.5px solid ${sideCol}66`, padding: '10px 12px', marginBottom: 8 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontSize: 18, color: sideCol, letterSpacing: 1, ...MONO }}>
          {trade.side.toUpperCase()} {trade.symbol}
        </span>
        <Lbl size={9}>{ago(trade.createdAt)}</Lbl>
      </div>

      {/* Amount + type */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 5 }}>
        <div>
          <Lbl>TYPE</Lbl>
          <div><Val size={10}>{trade.type.toUpperCase()}</Val></div>
        </div>
        <div>
          <Lbl>AMOUNT</Lbl>
          <div><Val size={10}>{trade.amount} {trade.symbol.replace(/USD$/, '')}</Val></div>
          {(() => {
            const refPrice = limitPrice ?? currentPrice
            const usd = refPrice ? Number(trade.amount) * refPrice : null
            return usd ? <div><Lbl size={9}>≈ ${usd.toFixed(2)}</Lbl></div> : null
          })()}
        </div>
        {trade.stopPrice && (
          <div>
            <Lbl>STOP TRIGGER</Lbl>
            <div><Val size={10} c='#c8a227'>{fmtPrice(Number(trade.stopPrice))}</Val></div>
          </div>
        )}
        {limitPrice && (
          <div>
            <Lbl>LIMIT</Lbl>
            <div><Val size={10}>{fmtPrice(limitPrice)}</Val></div>
          </div>
        )}
        {currentPrice && (
          <div>
            <Lbl>CURRENT</Lbl>
            <div><Val size={10}>{fmtPrice(currentPrice)}</Val></div>
          </div>
        )}
        {trade.orderOptions && trade.orderOptions.length > 0 && (
          <div>
            <Lbl>OPTION</Lbl>
            <div><Val size={9} c={GD}>{trade.orderOptions[0].toUpperCase()}</Val></div>
          </div>
        )}
      </div>

      {/* Distance to limit gauge */}
      {limitPrice && currentPrice && distPct !== null && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <Lbl c={proximityColor} size={9}>
              {Math.abs(distPct) < 0.1
                ? '⚡ AT LIMIT — READY TO FILL'
                : distPct < 0
                  ? `✓ PAST LIMIT (${Math.abs(distPct).toFixed(2)}% through)`
                  : `${distPct.toFixed(2)}% to ${trade.side === 'buy' ? 'drop' : 'rise'} to limit`}
            </Lbl>
            <Lbl c={proximityColor} size={9}>{progressPct.toFixed(0)}% close</Lbl>
          </div>
          <MiniBar pct={progressPct} color={proximityColor} height={4} />
        </div>
      )}

      {/* Reason */}
      <div style={{ marginBottom: 8, padding: '4px 6px', background: 'var(--bg-elev)' }}>
        <Lbl size={9}>{trade.reason}</Lbl>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onExecute} style={{ ...MONO, fontSize: 13, letterSpacing: 1, padding: '5px 14px', background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer' }}>EXECUTE NOW</button>
        <button onClick={onDismiss} style={{ ...MONO, fontSize: 13, letterSpacing: 1, padding: '5px 14px', background: 'transparent', border: `0.5px solid ${CR}`, color: CR, cursor: 'pointer' }}>DISMISS</button>
      </div>
    </div>
  )
}

function TradeRow({ trade }: { trade: TradeRecord }) {
  const col = trade.status === 'executed' ? G : trade.status === 'failed' ? CR : GD
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 76px 44px 52px 1fr', gap: 4, padding: '4px 6px', borderBottom: BORDER, fontSize: 14, ...MONO }}>
      <span style={{ color: GD }}>{new Date(trade.settledAt).toLocaleDateString()}</span>
      <span style={{ color: G }}>{trade.symbol}</span>
      <span style={{ color: trade.side === 'buy' ? G : CR }}>{trade.side.toUpperCase()}</span>
      <span style={{ color: col }}>● {trade.status.slice(0, 4).toUpperCase()}</span>
      <span style={{ color: GD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.orderId ?? trade.error ?? '—'}</span>
    </div>
  )
}

// ── Completed trades: FIFO-pair Gemini fills into closed round-trips ──
// Each row is one exit (a sell) matched back to the buy lot(s) it closed, FIFO.
// Sourced from the authoritative Gemini fill history — the app's own audit log is
// mostly one-sided (buys happen on-exchange or via brackets), so pairing there
// leaves everything unmatched. A sell that consumes several buy lots shows a
// blended entry price; the P&L is net of both legs' prorated USD fees.
interface CompletedTrade {
  symbol: string
  qty: number
  entryPx: number  // volume-weighted cost of the buy lots this exit closed
  exitPx: number
  entryAt: number  // oldest matched buy lot (FIFO front)
  exitAt: number
  pnl: number      // proceeds − cost on the matched quantity (fees ignored by design)
  pnlPct: number
}

function pairCompletedTrades(geminiTrades: GeminiTrade[]): CompletedTrade[] {
  const bySym = new Map<string, GeminiTrade[]>()
  for (const t of geminiTrades) {
    const g = bySym.get(t.symbol)
    if (g) g.push(t); else bySym.set(t.symbol, [t])
  }
  const completed: CompletedTrade[] = []
  for (const [symbol, fills] of bySym) {
    const asc = [...fills].sort((a, b) => a.timestampMs - b.timestampMs) // oldest first for FIFO
    // FIFO lot matching by crypto quantity: each sell closes the oldest open buy lot(s) unit
    // for unit. Realized P&L is purely the (sell − buy) price spread on the matched qty —
    // fees are IGNORED by design (operator rule): total sold minus total bought, nothing else.
    type Lot = { qty: number; px: number; at: number }
    const lots: Lot[] = []
    for (const t of asc) {
      const qty = Number(t.amount)
      const px = Number(t.price)
      if (!(qty > 0) || !(px > 0)) continue
      if (t.side === 'buy') {
        lots.push({ qty, px, at: t.timestampMs })
      } else {
        let rem = qty
        let matched = 0, cost = 0, entryAt = t.timestampMs
        let first = true
        while (rem > 1e-12 && lots.length) {
          const lot = lots[0]
          const m = Math.min(lot.qty, rem)
          if (first) { entryAt = lot.at; first = false }
          matched += m
          cost += m * lot.px
          lot.qty -= m; rem -= m
          if (lot.qty <= 1e-12) lots.shift()
        }
        if (matched <= 1e-12) continue // no buy on record — surfaced as "partial" in FILLED ORDERS
        const pnl = matched * px - cost
        completed.push({
          symbol, qty: matched, entryPx: cost / matched, exitPx: px,
          entryAt, exitAt: t.timestampMs,
          pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
        })
      }
    }
  }
  return completed.sort((a, b) => b.exitAt - a.exitAt) // newest close first
}

function CompletedTradeRow({ t }: { t: CompletedTrade }) {
  const base = t.symbol.replace(/USD$/, '')
  const col = t.pnl > 0 ? G : t.pnl < 0 ? CR : GD
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 72px 66px 132px 1fr', gap: 4, padding: '4px 6px', borderBottom: BORDER, fontSize: 14, ...MONO }}>
      <span style={{ color: GD }}>{new Date(t.exitAt).toLocaleDateString()}</span>
      <span style={{ color: G }}>{t.symbol}</span>
      <span style={{ color: GD }}>{t.qty.toFixed(4)} {base}</span>
      <span style={{ color: GD }}>{fmtPrice(t.entryPx)} → {fmtPrice(t.exitPx)}</span>
      <span style={{ color: col }}>{signedUsd(t.pnl)} <Lbl size={11}>({t.pnlPct >= 0 ? '+' : '−'}{Math.abs(t.pnlPct).toFixed(2)}%)</Lbl></span>
    </div>
  )
}

function CompletedTrades({ geminiTrades }: { geminiTrades: GeminiTrade[] }) {
  const [open, setOpen] = useState(false) // collapsed by default, like FILLED ORDERS
  const completed = pairCompletedTrades(geminiTrades)
  if (completed.length === 0) return null
  const total = completed.reduce((s, t) => s + t.pnl, 0)
  const totalCol = total > 0 ? G : total < 0 ? CR : GD
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: BORDER, paddingBottom: 5, marginBottom: 8, cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 14, color: GD, width: 12, ...MONO }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 17, letterSpacing: 2, color: G, ...MONO }}>COMPLETED TRADES</span>
        <span style={{ fontSize: 16, letterSpacing: 0.8, color: GD, ...MONO }}>· {completed.length} round-trip{completed.length === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 15, ...MONO }} title="Total P&L across completed (entry→exit) round-trips — traded totals only, fees ignored">
          <Lbl size={12}>P&L </Lbl><span style={{ color: totalCol }}>{signedUsd(total)}</span>
        </span>
      </div>
      {open && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '64px 72px 66px 132px 1fr', gap: 4, padding: '2px 6px', borderBottom: BORDER }}>
            {['CLOSED', 'PAIR', 'QTY', 'ENTRY → EXIT', 'P&L'].map((h) => <Lbl key={h}>{h}</Lbl>)}
          </div>
          {completed.map((t, i) => <CompletedTradeRow key={`${t.symbol}-${t.exitAt}-${i}`} t={t} />)}
        </>
      )}
    </div>
  )
}

// Homunculus staged-trade audit log — collapsed by default, newest first.
function TradeHistory({ trades }: { trades: TradeRecord[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div
        onClick={() => trades.length > 0 && setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: BORDER, paddingBottom: 5, marginBottom: 10, cursor: trades.length > 0 ? 'pointer' : 'default', userSelect: 'none' }}
      >
        <span style={{ fontSize: 14, color: GD, width: 12, ...MONO }}>{trades.length === 0 ? '' : open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 17, letterSpacing: 2, color: G, ...MONO }}>TRADE HISTORY</span>
        <span style={{ fontSize: 16, letterSpacing: 0.8, color: GD, ...MONO }}>· {trades.length} record{trades.length === 1 ? '' : 's'}</span>
      </div>
      {open && (trades.length === 0 ? <Lbl>No trades yet.</Lbl> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '60px 70px 50px 60px 1fr', gap: 4, padding: '2px 6px', borderBottom: BORDER }}>
            {['DATE', 'PAIR', 'SIDE', 'STATUS', 'ORDER ID'].map((h) => <Lbl key={h}>{h}</Lbl>)}
          </div>
          {[...trades].reverse().map((t) => <TradeRow key={t.id} trade={t} />)}
        </>
      ))}
    </div>
  )
}

// ── Filled Orders (Gemini) — collapsed by default, grouped by pair ─────
const FILLS_PER_PAIR = 50

type PairPnl = {
  realized: number          // USD realized on matched (closed) qty (fees ignored by design)
  matchedQty: number        // base units that were bought AND sold (round-tripped)
  openQty: number           // unmatched buy units still open (current position)
  openCost: number          // USD cost basis of the open units (traded notional, no fees)
  unmatchedSellQty: number  // sells with no buy on record → history truncated, basis unknown
}

/** FIFO-match a pair's fills by crypto quantity: each sell closes the oldest open buy lot(s)
 *  unit for unit. Realized P&L on the matched quantity is the (sell − buy) price spread
 *  alone — fees are ignored by design. Leftover buys are the still-open position; sells with no
 *  matching buy (Gemini caps trade history, so early buys can be missing) are surfaced as
 *  `unmatchedSellQty` rather than silently inventing a zero basis. */
function computeRealizedPnl(fills: GeminiTrade[]): PairPnl {
  const asc = [...fills].sort((a, b) => a.timestampMs - b.timestampMs) // oldest first for FIFO
  type Lot = { qty: number; price: number }
  const lots: Lot[] = []
  let realized = 0, matchedQty = 0, unmatchedSellQty = 0
  for (const t of asc) {
    const amt = Number(t.amount)
    if (amt <= 0) continue
    const price = Number(t.price)
    if (t.side === 'buy') {
      lots.push({ qty: amt, price })
    } else {
      let rem = amt
      while (rem > 1e-12 && lots.length) {
        const lot = lots[0]
        const m = Math.min(lot.qty, rem)
        realized += m * (price - lot.price)
        matchedQty += m
        lot.qty -= m
        rem -= m
        if (lot.qty <= 1e-12) lots.shift()
      }
      if (rem > 1e-9) unmatchedSellQty += rem
    }
  }
  const openQty = lots.reduce((s, l) => s + l.qty, 0)
  const openCost = lots.reduce((s, l) => s + l.qty * l.price, 0)
  return { realized, matchedQty, openQty, openCost, unmatchedSellQty }
}

function signedUsd(n: number): string { return `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}` }

function PairFills({ symbol, fills, pnl }: { symbol: string; fills: GeminiTrade[]; pnl: PairPnl }) {
  const [open, setOpen] = useState(false)
  const sorted = [...fills].sort((a, b) => b.timestampMs - a.timestampMs) // newest first
  const buys = sorted.filter((t) => t.side === 'buy').length
  const base = symbol.replace(/USD$/, '')
  const pnlColor = pnl.matchedQty <= 0 ? GD : pnl.realized > 0 ? G : pnl.realized < 0 ? CR : GD
  return (
    <div style={{ borderBottom: BORDER }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 12, color: GD, width: 10, ...MONO }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 15, color: G, letterSpacing: 1, ...MONO }}>{symbol}</span>
        {pnl.matchedQty > 0 && (
          <span style={{ fontSize: 14, color: pnlColor, ...MONO }} title="Realized P&L on round-tripped quantity — traded totals only, fees ignored">
            {signedUsd(pnl.realized)}
          </span>
        )}
        {pnl.unmatchedSellQty > 1e-9 && <span title="Some sells have no matching buy on record — Gemini caps trade history, so realized P&L is partial"><Lbl c="#c8a227" size={11}>⚠ partial</Lbl></span>}
        <div style={{ flex: 1 }} />
        <Lbl size={12}>{fills.length} fill{fills.length === 1 ? '' : 's'} · {buys}B/{fills.length - buys}S</Lbl>
      </div>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '4px 8px 6px 24px', background: 'var(--bg-elev)' }}>
          <span style={{ fontSize: 12, ...MONO }}><Lbl size={11}>REALIZED </Lbl><span style={{ color: pnlColor }}>{pnl.matchedQty > 0 ? signedUsd(pnl.realized) : '—'}</span></span>
          <span style={{ fontSize: 12, ...MONO }}><Lbl size={11}>ROUND-TRIPPED </Lbl><span style={{ color: GD }}>{pnl.matchedQty.toFixed(6)} {base}</span></span>
          <span style={{ fontSize: 12, ...MONO }}><Lbl size={11}>OPEN </Lbl><span style={{ color: GD }}>{pnl.openQty.toFixed(6)} {base}{pnl.openQty > 1e-9 ? ` @ $${(pnl.openCost / pnl.openQty).toFixed(pnl.openCost / pnl.openQty >= 1 ? 2 : 6)}` : ''}</span></span>
        </div>
      )}
      {open && (
        <div style={{ paddingBottom: 4 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '72px 36px 72px 72px 64px 1fr', gap: 4, padding: '2px 6px', borderBottom: BORDER }}>
            {['DATE', 'SIDE', 'PRICE', 'AMOUNT', 'TOTAL', 'MAKER/TAKER · FEE'].map((h) => <Lbl key={h}>{h}</Lbl>)}
          </div>
          {sorted.slice(0, FILLS_PER_PAIR).map((t) => <PairFillRow key={`${t.tradeId}-${t.timestampMs}`} trade={t} />)}
          {sorted.length > FILLS_PER_PAIR && (
            <div style={{ padding: '4px 6px' }}><Lbl>… {sorted.length - FILLS_PER_PAIR} older fills</Lbl></div>
          )}
        </div>
      )}
    </div>
  )
}

// Per-pair fill row — like GeminiTradeRow but without the (redundant) PAIR column.
function PairFillRow({ trade }: { trade: GeminiTrade }) {
  const sideColor = trade.side === 'buy' ? G : CR
  const total = (Number(trade.price) * Number(trade.amount)).toFixed(2)
  const fee = Number(trade.feeAmount) > 0 ? `-$${Number(trade.feeAmount).toFixed(4)} fee` : ''
  const makerTaker = trade.isAggressor ? 'TAKER' : 'MAKER'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 36px 72px 72px 64px 1fr', gap: 4, padding: '4px 6px', borderBottom: BORDER, fontSize: 14, ...MONO }}>
      <span style={{ color: GD }}>{new Date(trade.timestampMs).toLocaleDateString()}</span>
      <span style={{ color: sideColor }}>{trade.side.toUpperCase()}</span>
      <span style={{ color: G }}>{fmtPrice(Number(trade.price))}</span>
      <span style={{ color: GD }}>{Number(trade.amount).toFixed(4)}</span>
      <span style={{ color: G }}>${total}</span>
      <span style={{ color: GD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{makerTaker}{fee ? ` · ${fee}` : ''}</span>
    </div>
  )
}

function FilledOrders({ trades }: { trades: GeminiTrade[] }) {
  const [open, setOpen] = useState(false) // collapsed by default
  // Group by pair, order groups by most-recent fill first.
  const groups = (() => {
    const m = new Map<string, GeminiTrade[]>()
    for (const t of trades) {
      const g = m.get(t.symbol)
      if (g) g.push(t); else m.set(t.symbol, [t])
    }
    return [...m.entries()]
      .map(([symbol, fills]) => ({ symbol, fills, pnl: computeRealizedPnl(fills), latest: Math.max(...fills.map((f) => f.timestampMs)) }))
      .sort((a, b) => b.latest - a.latest)
  })()
  const totalRealized = groups.reduce((s, g) => s + g.pnl.realized, 0)
  const anyPartial = groups.some((g) => g.pnl.unmatchedSellQty > 1e-9)
  const totalColor = totalRealized > 0 ? G : totalRealized < 0 ? CR : GD

  return (
    <div>
      <div
        onClick={() => trades.length > 0 && setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: BORDER, paddingBottom: 5, marginBottom: 10,
          cursor: trades.length > 0 ? 'pointer' : 'default', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 14, color: GD, width: 12, ...MONO }}>{trades.length === 0 ? '' : open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 17, letterSpacing: 2, color: G, ...MONO }}>FILLED ORDERS (GEMINI)</span>
        <span style={{ fontSize: 16, letterSpacing: 0.8, color: GD, ...MONO }}>
          · {trades.length === 0 ? 'none' : `${groups.length} pair${groups.length === 1 ? '' : 's'} · ${trades.length} fills`}
        </span>
        <div style={{ flex: 1 }} />
        {trades.length > 0 && (
          <span style={{ fontSize: 15, ...MONO }} title="Total realized P&L across all pairs (FIFO-matched, fees ignored)">
            <Lbl size={12}>REALIZED{anyPartial ? '*' : ''} </Lbl><span style={{ color: totalColor }}>{signedUsd(totalRealized)}</span>
          </span>
        )}
      </div>
      {open && groups.map((g) => <PairFills key={g.symbol} symbol={g.symbol} fills={g.fills} pnl={g.pnl} />)}
    </div>
  )
}

// ── Auto Plan Panel ───────────────────────────────────────────────────

/** Renders a step's amountSpec as a display string + USD estimate, given a reference
 *  price (limit price, falling back to current ticker price). "USD:40" is already a
 *  dollar amount; "ALL:X"/"ALL_USD" can't be sized without the live balance. */
function describeAmountSpec(amountSpec: string, symbol: string, refPrice: number | null): { label: string; usd: number | null } {
  const base = symbol.replace(/USD$/, '')
  if (amountSpec.startsWith('USD:')) {
    // Already a dollar figure — no separate USD estimate to append.
    const usd = Number(amountSpec.slice(4))
    return { label: `$${Number.isFinite(usd) ? usd.toFixed(2) : amountSpec.slice(4)}`, usd: null }
  }
  if (amountSpec.startsWith('ALL')) {
    return { label: amountSpec === 'ALL_USD' ? 'ALL USD → BTC' : `ALL ${base}`, usd: null }
  }
  const qty = Number(amountSpec)
  if (!Number.isFinite(qty)) return { label: amountSpec, usd: null }
  const usd = refPrice ? qty * refPrice : null
  return { label: `${qty} ${base}`, usd }
}

// Base-currency quantity implied by an amountSpec at a given entry price. Returns null
// when it can't be sized without live balance ("ALL…").
function baseQtyFromSpec(amountSpec: string, entryPrice: number): number | null {
  if (amountSpec.startsWith('USD:')) {
    const usd = Number(amountSpec.slice(4))
    return entryPrice > 0 && Number.isFinite(usd) ? usd / entryPrice : null
  }
  if (amountSpec.startsWith('ALL')) return null
  const qty = Number(amountSpec)
  return Number.isFinite(qty) ? qty : null
}

// Proposed take-profit exit derived from a bracket spec + entry price: the tp1 (and tp2)
// prices, the blended % gain, and the USD profit if it plays out as planned.
function bracketExit(step: AutoStep, entryPrice: number): {
  tp1Price: number; tp2Price: number | null; tp1Frac: number
  blendedPct: number; profitUsd: number | null; qty: number | null
} | null {
  if (step.kind !== 'bracket' || !step.bracket || !(entryPrice > 0)) return null
  const b = step.bracket
  const tp1Price = entryPrice * (1 + b.tp1.pricePct)
  const tp2Price = b.tp2 ? entryPrice * (1 + b.tp2.pricePct) : null
  const tp1Frac = b.tp1.sizeFraction
  const restPrice = tp2Price ?? tp1Price
  const blendedPct = (tp1Frac * b.tp1.pricePct + (1 - tp1Frac) * (b.tp2?.pricePct ?? b.tp1.pricePct)) * 100
  const qty = baseQtyFromSpec(b.entry.amountSpec, entryPrice)
  const profitUsd = qty !== null
    ? (qty * tp1Frac * tp1Price + qty * (1 - tp1Frac) * restPrice) - qty * entryPrice
    : null
  return { tp1Price, tp2Price, tp1Frac, blendedPct, profitUsd, qty }
}

const STEP_COLORS: Record<AutoStep['status'], string> = {
  pending: 'var(--border)',
  executing: '#c8a227',
  monitoring: '#c8a227',
  filled: 'var(--green)',
  failed: 'var(--crimson)',
  skipped: 'var(--green-dim)',
}
const STEP_ICON: Record<AutoStep['status'], string> = {
  pending: '○', executing: '◉', monitoring: '◎', filled: '●', failed: '✗', skipped: '⊘',
}

function AutoPlanPanel({ plan, tickers, onStop, onReset, onConfirm, onPatchStep }: {
  plan: AutoPlanStatus; tickers: Ticker[]
  onStop: () => void; onReset: () => void
  onConfirm: () => void
  onPatchStep: (stepId: string, patch: { limitPrice?: string; stopPrice?: string; amountSpec?: string; tp1Price?: string; approved?: boolean }) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [editingStep, setEditingStep] = useState<string | null>(null)
  const [editVals, setEditVals] = useState<{ limitPrice: string; stopPrice: string; amountSpec: string; tp1Price: string }>({ limitPrice: '', stopPrice: '', amountSpec: '', tp1Price: '' })
  const [saving, setSaving] = useState(false)

  const completedCount = plan.steps.filter((s) => s.status === 'filled' || s.status === 'skipped').length
  const failedCount = plan.steps.filter((s) => s.status === 'failed').length
  const isProposed = plan.isProposed && !plan.active
  const approvedCount = plan.steps.filter((s) => s.approved !== false).length
  const borderColor = plan.active ? 'var(--green)' : isProposed ? '#c8a227' : failedCount > 0 ? 'var(--crimson)' : 'var(--border)'

  const startEdit = (step: AutoStep) => {
    setEditingStep(step.id)
    // Seed the take-profit / stop inputs from the bracket's proposed levels (stored as pcts).
    const entryRef = Number(step.limitPrice ?? step.bracket?.entry.limitPrice ?? 0)
    const ex = bracketExit(step, entryRef)
    const stopSeed = step.stopPrice
      ?? (step.bracket && entryRef > 0 ? (entryRef * (1 - step.bracket.stopPct)).toFixed(6) : '')
    setEditVals({
      limitPrice: step.limitPrice ?? step.bracket?.entry.limitPrice ?? '',
      stopPrice: stopSeed,
      amountSpec: step.amountSpec ?? '',
      tp1Price: ex ? ex.tp1Price.toFixed(6) : '',
    })
  }
  const saveEdit = async (stepId: string) => {
    setSaving(true)
    await onPatchStep(stepId, {
      limitPrice: editVals.limitPrice || undefined,
      stopPrice: editVals.stopPrice || undefined,
      amountSpec: editVals.amountSpec || undefined,
      tp1Price: editVals.tp1Price || undefined,
    })
    setSaving(false)
    setEditingStep(null)
  }

  return (
    <div style={{ border: `0.5px solid ${borderColor}`, marginBottom: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: expanded ? BORDER : 'none', cursor: 'pointer' }}
        onClick={() => setExpanded((v) => !v)}>
        <span style={{ fontSize: 14, color: plan.active ? G : isProposed ? '#c8a227' : GD, letterSpacing: 1.5, ...MONO }}>
          {plan.active ? '◉ EXECUTING APPROVED TRADES' : isProposed ? '⚠ RECOMMENDED TRADES — REVIEW & APPROVE' : plan.steps.length > 0 ? '○ RECOMMENDED TRADES' : '○ RECOMMENDED TRADES'}
        </span>
        {plan.steps.length > 0 && (
          <span style={{ fontSize: 12, color: GD, ...MONO }}>{completedCount}/{plan.steps.length} steps</span>
        )}
        {plan.active && plan.startedAt && (
          <span style={{ fontSize: 12, color: G, ...MONO }}>running {Math.round((Date.now() - plan.startedAt) / 60000)}m</span>
        )}
        <div style={{ flex: 1 }} />
        <Lbl>{expanded ? '▲' : '▼'}</Lbl>
      </div>

      {expanded && (
        <div style={{ padding: '10px 12px' }}>

          {/* Plan metadata — label + timestamps */}
          {(isProposed || plan.active) && plan.steps.length > 0 && (
            <div style={{ background: 'var(--bg-elev)', padding: '6px 10px', marginBottom: 10, borderLeft: `2px solid ${isProposed ? '#c8a227' : G}` }}>
              <div style={{ fontSize: 14, color: isProposed ? '#c8a227' : G, ...MONO, marginBottom: 2 }}>
                {plan.proposedLabel || 'Trading Plan'}
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                {plan.proposedAt && (
                  <Lbl size={8}>Proposed: {new Date(plan.proposedAt).toLocaleTimeString()}</Lbl>
                )}
                {plan.startedAt && (
                  <Lbl size={8} c={G}>Confirmed & started: {new Date(plan.startedAt).toLocaleTimeString()}</Lbl>
                )}
              </div>
              {isProposed && (
                <Lbl size={8} c={'#c8a227'}>Review each trade below. Approve or deny each one (edit prices if needed), then CONFIRM to execute only the approved trades.</Lbl>
              )}
            </div>
          )}

          {/* Empty state — no recommended trades yet */}
          {plan.steps.length === 0 && (
            <div style={{ marginBottom: 10 }}>
              <Lbl>No recommended trades. Run /crypto-strategy to generate recommendations — they appear here for you to review and approve before anything is sent to the exchange.</Lbl>
            </div>
          )}

          {/* Steps */}
          {plan.steps.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {plan.steps.map((step, i) => {
                const stepTicker = tickers.find((t) => t.symbol === step.symbol)
                const currentP = stepTicker ? Number(stepTicker.last) : null
                const limitP = step.limitPrice ? Number(step.limitPrice) : null
                let distPct: number | null = null
                let proxColor = GD
                if (currentP && limitP && (step.status === 'monitoring' || step.status === 'executing')) {
                  distPct = step.side === 'buy'
                    ? ((currentP - limitP) / limitP) * 100
                    : ((limitP - currentP) / currentP) * 100
                  proxColor = Math.abs(distPct) < 1 ? G : Math.abs(distPct) < 3 ? '#c8a227' : GD
                }
                const isEditing = editingStep === step.id
                const amountDesc = describeAmountSpec(step.amountSpec, step.symbol, limitP ?? currentP)
                // Proposed take-profit exit for bracket steps — shown as a second order.
                const exit = bracketExit(step, Number(step.limitPrice ?? step.bracket?.entry.limitPrice ?? 0))
                return (
                  <div key={step.id} style={{
                    padding: '8px 0', borderBottom: i < plan.steps.length - 1 ? BORDER : 'none',
                    opacity: (isProposed && step.approved === false) ? 0.4 : (!isProposed && step.status === 'pending') ? 0.45 : 1,
                  }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 18, color: isProposed ? (step.approved === false ? CR : '#c8a227') : STEP_COLORS[step.status], ...MONO, minWidth: 14, marginTop: 1 }}>
                        {isProposed ? (step.approved === false ? '✕' : '○') : STEP_ICON[step.status]}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 14, color: G, ...MONO }}>{step.symbol}</span>
                          <span style={{ fontSize: 13, color: step.side === 'buy' ? G : CR, ...MONO }}>{step.side.toUpperCase()}</span>
                          <span style={{ fontSize: 12, color: GD, ...MONO }}>{step.type}</span>
                          {!isEditing && (
                            <span style={{ fontSize: 12, color: GD, ...MONO }}>
                              {amountDesc.label}{amountDesc.usd != null ? ` (≈ $${amountDesc.usd.toFixed(2)})` : ''}
                            </span>
                          )}
                          {step.limitPrice && !isEditing && <span style={{ fontSize: 12, color: GD, ...MONO }}>limit {fmtPrice(Number(step.limitPrice))}</span>}
                          {step.stopPrice && !isEditing && <span style={{ fontSize: 12, color: '#c8a227', ...MONO }}>stop {fmtPrice(Number(step.stopPrice))}</span>}
                          {!isProposed && <span style={{ fontSize: 12, color: STEP_COLORS[step.status], ...MONO }}>{step.status.toUpperCase()}</span>}
                          {/* Per-trade approve/deny + edit — only while proposed */}
                          {isProposed && !isEditing && (
                            <>
                              <span style={{ fontSize: 12, color: step.approved === false ? CR : G, ...MONO, marginLeft: 4 }}>
                                {step.approved === false ? '✕ DENIED' : '✓ APPROVED'}
                              </span>
                              <button onClick={() => onPatchStep(step.id, { approved: step.approved === false })} style={{
                                ...MONO, fontSize: 12, padding: '1px 8px',
                                background: 'transparent',
                                border: `0.5px solid ${step.approved === false ? G : CR}`,
                                color: step.approved === false ? G : CR, cursor: 'pointer',
                              }}>{step.approved === false ? 'APPROVE' : 'DENY'}</button>
                              <button onClick={() => startEdit(step)} style={{
                                ...MONO, fontSize: 12, padding: '1px 8px',
                                background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
                              }}>EDIT</button>
                            </>
                          )}
                        </div>
                        <Lbl size={9}>{step.label}</Lbl>

                        {/* Proposed EXIT — the take-profit order paired with this entry.
                            Adjustable via the same EDIT form (take-profit price). */}
                        {exit && (
                          <div style={{ marginTop: 4, padding: '5px 8px', background: 'var(--bg-elev)', borderLeft: `2px solid ${G}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, color: G, letterSpacing: 0.5, ...MONO }}>↳ EXIT</span>
                              <span style={{ fontSize: 12, color: CR, ...MONO }}>SELL</span>
                              <span style={{ fontSize: 12, color: GD, ...MONO }}>limit</span>
                              <span style={{ fontSize: 13, color: G, ...MONO }}>{fmtPrice(exit.tp1Price)}</span>
                              {exit.tp2Price && <span style={{ fontSize: 11, color: GD, ...MONO }}>· T2 {fmtPrice(exit.tp2Price)}</span>}
                              <span style={{ fontSize: 12, color: G, ...MONO }}>+{exit.blendedPct.toFixed(2)}%</span>
                              {exit.profitUsd !== null && (
                                <span style={{ fontSize: 12, color: exit.profitUsd >= 0 ? G : CR, ...MONO }}>
                                  {fmtSignedUsd(exit.profitUsd)}
                                </span>
                              )}
                              {isProposed && !isEditing && (
                                <button onClick={() => startEdit(step)} style={{
                                  ...MONO, fontSize: 11, padding: '1px 8px',
                                  background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
                                }}>EDIT</button>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Inline edit form */}
                        {isEditing && (
                          <div style={{ marginTop: 6, padding: '8px', background: 'var(--bg-elev)', border: `0.5px solid #c8a227` }}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                              <div>
                                <Lbl size={8}>Limit price</Lbl>
                                <input value={editVals.limitPrice} onChange={(e) => setEditVals((v) => ({ ...v, limitPrice: e.target.value }))}
                                  style={{ ...MONO, fontSize: 13, background: 'var(--bg)', border: BORDER, color: G, padding: '3px 6px', width: 100 }} />
                              </div>
                              {(step.type === 'stop-limit' || editVals.stopPrice) && (
                                <div>
                                  <Lbl size={8}>Stop trigger</Lbl>
                                  <input value={editVals.stopPrice} onChange={(e) => setEditVals((v) => ({ ...v, stopPrice: e.target.value }))}
                                    style={{ ...MONO, fontSize: 13, background: 'var(--bg)', border: BORDER, color: '#c8a227', padding: '3px 6px', width: 100 }} />
                                </div>
                              )}
                              {step.kind === 'bracket' && (
                                <div>
                                  <Lbl size={8}>Take-profit price</Lbl>
                                  <input value={editVals.tp1Price} onChange={(e) => setEditVals((v) => ({ ...v, tp1Price: e.target.value }))}
                                    style={{ ...MONO, fontSize: 13, background: 'var(--bg)', border: BORDER, color: G, padding: '3px 6px', width: 100 }} />
                                </div>
                              )}
                              <div>
                                <Lbl size={8}>Amount spec</Lbl>
                                <input value={editVals.amountSpec} onChange={(e) => setEditVals((v) => ({ ...v, amountSpec: e.target.value }))}
                                  style={{ ...MONO, fontSize: 13, background: 'var(--bg)', border: BORDER, color: GD, padding: '3px 6px', width: 120 }} />
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => saveEdit(step.id)} disabled={saving} style={{
                                ...MONO, fontSize: 12, padding: '3px 12px',
                                background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
                              }}>SAVE</button>
                              <button onClick={() => setEditingStep(null)} style={{
                                ...MONO, fontSize: 12, padding: '3px 10px',
                                background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
                              }}>CANCEL</button>
                            </div>
                          </div>
                        )}

                        {/* Live distance for active steps */}
                        {distPct !== null && currentP && limitP && (
                          <div style={{ marginTop: 3 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                              <Lbl c={proxColor} size={8}>
                                {Math.abs(distPct) < 0.1 ? '⚡ AT LIMIT' : `${distPct > 0 ? distPct.toFixed(2) + '% to go' : Math.abs(distPct).toFixed(2) + '% past limit'}`}
                              </Lbl>
                              <Lbl c={proxColor} size={8}>now {fmtPrice(currentP)}</Lbl>
                            </div>
                            <MiniBar pct={Math.max(0, 100 - Math.abs(distPct) * 10)} color={proxColor} height={3} />
                          </div>
                        )}
                        {step.geminiOrderId && <div><Lbl c={GD} size={8}>Order: {step.geminiOrderId}</Lbl></div>}
                        {step.filledAmount && <div><Lbl c={G} size={9}>Filled: {step.filledAmount}</Lbl></div>}
                        {step.error && <div><Lbl c={CR} size={9}>Error: {step.error}</Lbl></div>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Controls */}
          <div style={{ display: 'flex', gap: 6, marginBottom: plan.log.length > 0 ? 8 : 0 }}>
            {isProposed ? (
              <>
                <button onClick={onConfirm} disabled={approvedCount === 0} style={{
                  ...MONO, fontSize: 13, letterSpacing: 1, padding: '5px 20px',
                  background: approvedCount === 0 ? 'transparent' : G, border: `0.5px solid ${G}`,
                  color: approvedCount === 0 ? GD : 'var(--bg)', cursor: approvedCount === 0 ? 'not-allowed' : 'pointer', fontWeight: 700,
                }}>✓ CONFIRM &amp; EXECUTE {approvedCount}/{plan.steps.length}</button>
                <button onClick={onReset} style={{
                  ...MONO, fontSize: 13, padding: '5px 12px',
                  background: 'transparent', border: `0.5px solid ${CR}`, color: CR, cursor: 'pointer',
                }}>✕ DENY ALL</button>
              </>
            ) : !plan.active ? (
              // No START button — execution only ever happens via CONFIRM on a human-approved
              // proposal. A leftover/completed plan can only be cleared.
              plan.steps.length > 0 ? (
                <button onClick={onReset} style={{
                  ...MONO, fontSize: 13, padding: '5px 12px',
                  background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
                }}>CLEAR</button>
              ) : <></>
            ) : (
              <button onClick={onStop} style={{
                ...MONO, fontSize: 13, letterSpacing: 1, padding: '5px 16px',
                background: 'transparent', border: `0.5px solid ${CR}`, color: CR, cursor: 'pointer',
              }}>■ STOP</button>
            )}
            {plan.log.length > 0 && (
              <button onClick={() => setShowLog((v) => !v)} style={{
                ...MONO, fontSize: 13, padding: '5px 10px',
                background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
              }}>LOG {showLog ? '▲' : '▼'}</button>
            )}
          </div>

          {/* Log */}
          {showLog && plan.log.length > 0 && (
            <div style={{ maxHeight: 140, overflowY: 'auto', background: 'var(--bg-elev)', padding: 6 }}>
              {[...plan.log].reverse().map((entry, i) => (
                <div key={i} style={{ fontSize: 12, color: GD, ...MONO, marginBottom: 1 }}>{entry}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Stage Trade Form ──────────────────────────────────────────────────

// ── Countdown timer for orders with a time-stop (e.g. a bracket entry that the
//    engine cancels if unfilled by its deadline). Ticks every second; turns amber
//    under 5 min and red under 1 min; shows "EXPIRING…" once the deadline passes
//    (the engine cancels on its next poll, up to ~15s later). ──────────────────
function Countdown({ deadlineMs }: { deadlineMs: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const remaining = deadlineMs - now
  if (remaining <= 0) {
    return <Lbl size={9} c={CR}>⏱ EXPIRING…</Lbl>
  }
  const totalSec = Math.floor(remaining / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  const col = remaining < 60_000 ? CR : remaining < 300_000 ? '#c8a227' : GD
  return <Lbl size={9} c={col}>⏱ {mm}:{String(ss).padStart(2, '0')}</Lbl>
}

// ── Active-trade orbital gauge ────────────────────────────────────────
// Each live order renders as a small planet. The lit sphere at the center
// carries the numbers; around it, an arc of orbit fills as price closes on the
// trigger, with a satellite riding the arc's leading edge. A thin inner ring
// tracks partial fills. Click the planet to expand the full management card.
function OpenOrderRing({ order, ticker, safeArm, origin, active, onClick }: {
  order: GeminiOpenOrder; ticker?: Ticker; safeArm?: SafeModeArm
  /** Which strategy placed this order, if we can attribute it. */
  origin?: OrderOrigin
  active: boolean; onClick: () => void
}) {
  const originMeta = origin ? STRATEGY_META[origin.strategy] : undefined
  const sideCol = order.side === 'buy' ? BUY_C : CR
  const currentPrice = ticker ? Number(ticker.last) : null
  const isStopLimit = order.type.includes('stop')
  const limitPrice = Number(order.price)
  const stopPrice = order.stopPrice ? Number(order.stopPrice) : null
  const refPrice = isStopLimit && stopPrice ? stopPrice : limitPrice
  const filledPct = Number(order.originalAmount) > 0
    ? (Number(order.executedAmount) / Number(order.originalAmount)) * 100 : 0

  let distPct: number | null = null
  if (currentPrice && refPrice) {
    distPct = order.side === 'buy'
      ? ((currentPrice - refPrice) / refPrice) * 100
      : ((refPrice - currentPrice) / currentPrice) * 100
  }
  const absDist = distPct == null ? null : Math.abs(distPct)
  // Hue carries the side; heat carries proximity. Anything inside 1% of its
  // trigger burns amber so the eye lands on it first across a wall of planets.
  const hot = absDist != null && absDist < 1
  const arcCol = absDist == null ? GD : hot ? HOT_C : absDist < 3 ? sideCol : sideCol
  const arcOpacity = absDist == null ? 0.4 : hot ? 1 : absDist < 3 ? 0.85 : 0.55
  const atTrigger = absDist != null && absDist < 0.1
  const past = distPct != null && distPct < 0

  // Orbit fills as the price closes on the trigger: 0% distance → full orbit.
  const ringPct = absDist == null ? 0 : Math.max(3, Math.min(100, 100 - absDist * 10))

  const SIZE = 112, STROKE = 3
  const C = SIZE / 2
  const R = C - 10                    // orbital radius
  const CIRC = 2 * Math.PI * R
  const CORE = R - 12                 // planet radius
  const innerR = CORE + 5             // partial-fill ring, just above the surface
  const innerCirc = 2 * Math.PI * innerR
  // Satellite rides the leading edge of the filled arc (arc starts at 12 o'clock).
  const satAngle = (ringPct / 100) * 360 - 90
  const satX = C + R * Math.cos((satAngle * Math.PI) / 180)
  const satY = C + R * Math.sin((satAngle * Math.PI) / 180)
  const label = order.symbol.replace(/USD$/, '')
  const uid = `p${order.orderId}`

  return (
    <button className="orbital" onClick={onClick} title={`#${order.orderId} — click for controls`} style={{
      position: 'relative', width: SIZE, height: SIZE, padding: 0, cursor: 'pointer',
      background: 'transparent', border: 'none', borderRadius: '50%', ...MONO,
    }}>
      <svg width={SIZE} height={SIZE} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <defs>
          {/* Sphere lit from the upper-left, falling to a dark limb. */}
          <radialGradient id={`${uid}-core`} cx="34%" cy="30%" r="78%">
            <stop offset="0%" stopColor={sideCol} stopOpacity={hot ? 0.4 : 0.26} />
            <stop offset="45%" stopColor={sideCol} stopOpacity={0.1} />
            <stop offset="100%" stopColor="#000" stopOpacity={0.92} />
          </radialGradient>
          {/* Atmosphere: bright at the limb, transparent over the disc. */}
          <radialGradient id={`${uid}-atmo`} cx="50%" cy="50%" r="50%">
            <stop offset="72%" stopColor={arcCol} stopOpacity={0} />
            <stop offset="94%" stopColor={arcCol} stopOpacity={hot ? 0.5 : 0.28} />
            <stop offset="100%" stopColor={arcCol} stopOpacity={0} />
          </radialGradient>
          <clipPath id={`${uid}-disc`}>
            <circle cx={C} cy={C} r={CORE} />
          </clipPath>
        </defs>

        {/* Atmospheric halo, slowly breathing. */}
        <circle className="orbit-halo" cx={C} cy={C} r={CORE + 7} fill={`url(#${uid}-atmo)`} />

        {/* Rotating survey ring — doubles as the strategy's signature: it takes the owning
            strategy's colour, so a glance across the constellation shows which system placed
            what. Falls back to the side colour for a manual order. */}
        <circle className="orbit-track" cx={C} cy={C} r={R + 4} fill="none"
          stroke={originMeta?.color ?? sideCol} strokeOpacity={active ? 0.7 : originMeta ? 0.5 : 0.2}
          strokeWidth={originMeta ? 1.25 : 0.75}
          strokeDasharray={originMeta ? '3 5' : '2 7'} />
        <circle className="orbit-track retro" cx={C} cy={C} r={R - 4} fill="none"
          stroke={sideCol} strokeOpacity={0.12} strokeWidth={0.5} strokeDasharray="1 12" />

        <g transform={`rotate(-90 ${C} ${C})`}>
          {/* Unlit remainder of the orbit. */}
          <circle cx={C} cy={C} r={R} fill="none" stroke={sideCol} strokeOpacity={0.16} strokeWidth={STROKE} />
          {/* Distance-to-trigger arc. */}
          <circle cx={C} cy={C} r={R} fill="none" stroke={arcCol} strokeOpacity={arcOpacity}
            strokeWidth={STROKE} strokeLinecap="round"
            strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - ringPct / 100)}
            style={{ filter: hot ? `drop-shadow(0 0 4px ${arcCol})` : 'none' }} />
          {filledPct > 0 && (
            <circle cx={C} cy={C} r={innerR} fill="none" stroke={G} strokeWidth={1.5}
              strokeLinecap="round" strokeDasharray={innerCirc}
              strokeDashoffset={innerCirc * (1 - filledPct / 100)} opacity={0.8} />
          )}
        </g>

        {/* Satellite on the leading edge of the arc. */}
        {absDist != null && (
          <circle cx={satX} cy={satY} r={2.6} fill={arcCol}
            style={{ filter: `drop-shadow(0 0 5px ${arcCol})` }} />
        )}

        {/* Planet body: shaded disc, two tilted surface bands, terminator. */}
        <circle cx={C} cy={C} r={CORE} fill={`url(#${uid}-core)`}
          stroke={sideCol} strokeOpacity={active ? 0.7 : 0.35} strokeWidth={0.75} />
        <g clipPath={`url(#${uid}-disc)`} opacity={0.5}>
          <ellipse cx={C} cy={C - CORE * 0.34} rx={CORE} ry={CORE * 0.34}
            fill="none" stroke={sideCol} strokeOpacity={0.22} strokeWidth={0.5} />
          <ellipse cx={C} cy={C + CORE * 0.42} rx={CORE} ry={CORE * 0.4}
            fill="none" stroke={sideCol} strokeOpacity={0.16} strokeWidth={0.5} />
          <circle cx={C + CORE * 0.62} cy={C + CORE * 0.3} r={CORE} fill="#000" opacity={0.34} />
        </g>
      </svg>

      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 0, overflow: 'hidden', borderRadius: '50%',
      }}>
        {/* Scan line drifting across the face. */}
        <span className="orbit-scan" style={{
          position: 'absolute', left: 0, right: 0, height: 1, top: '50%',
          background: `linear-gradient(90deg, transparent, ${sideCol}, transparent)`,
          pointerEvents: 'none',
        }} />
        <span style={{ fontSize: 8, color: sideCol, letterSpacing: 1.2, opacity: 0.85 }}>
          {order.side === 'buy' ? '▲' : '▼'} {label}
        </span>
        {atTrigger ? (
          <span style={{ fontSize: 12, color: arcCol, letterSpacing: 0.5 }}>⚡{isStopLimit ? 'TRIG' : 'LIMIT'}</span>
        ) : absDist != null ? (
          <>
            <span style={{
              fontSize: 21, lineHeight: 1.1, color: arcCol, letterSpacing: -0.5,
              textShadow: hot ? `0 0 10px ${arcCol}99` : 'none',
            }}>{absDist.toFixed(1)}<span style={{ fontSize: 11 }}>%</span></span>
            <span style={{ fontSize: 6, color: GD, letterSpacing: 1.2 }}>
              {past ? `PAST ${isStopLimit ? 'TRIG' : 'LIMIT'}` : `TO ${isStopLimit ? 'TRIGGER' : 'FILL'}`}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 10, color: GD }}>—</span>
        )}
        <span style={{ fontSize: 7, color: GD, marginTop: 2, letterSpacing: 0.5 }}>{fmtPrice(refPrice)}</span>
        {/* Owning strategy. Unattributed orders say MANUAL rather than guessing. */}
        <span
          title={origin ? `Placed by ${originMeta?.label ?? origin.strategy} — ${origin.role}` : 'Placed manually — no strategy owns this order'}
          style={{ fontSize: 6, letterSpacing: 0.8, marginTop: 1, color: originMeta?.color ?? GD, opacity: origin ? 1 : 0.55 }}
        >
          {origin ? `${originMeta?.glyph ?? ''}${originMeta?.short ?? origin.strategy.toUpperCase()}` : 'MANUAL'}
        </span>
        {(filledPct > 0 || safeArm) && (
          <span style={{ display: 'flex', gap: 3, marginTop: 1 }}>
            {filledPct > 0 && <span style={{ fontSize: 6, color: G }}>◐{filledPct.toFixed(0)}%</span>}
            {safeArm && <span style={{ fontSize: 8, color: G }} title="safe mode armed">🛡</span>}
          </span>
        )}
      </div>
    </button>
  )
}

// ── Open Orders (live from Gemini) ────────────────────────────────────
function OpenOrderCard({ order, ticker, signal, bracketTargets, ladderCycle, expiresAt, onCancel, onClose, onModify, safeArm, origin, onSafeMode, onLockToggle }: {
  order: GeminiOpenOrder; ticker?: Ticker
  // The composite signal for this order's symbol, if seeded — used to show live RSI.
  signal?: Signal
  // Epoch-ms deadline when this order is auto-cancelled by its time-stop (bracket
  // entry orders only). Undefined for orders with no expiry (stops, TPs, manual limits).
  expiresAt?: number
  // When this order is the protective stop of a managed bracket, its take-profit
  // targets (derived from the bracket entry + tp1/tp2 pcts) so we can show the
  // upside P&L alongside the stop-exit P&L. Undefined for plain non-bracket orders.
  bracketTargets?: { entryPrice: number; tp1Price: number; tp1Fraction: number; tp2Price: number | null; phase: string; symbol: string; locked: boolean }
  // When this BUY order is a BTC ladder buy-back, its paired sell slice — so we can show
  // the BTC gained by closing the round-trip at the current market price.
  ladderCycle?: BtcLadderCycle
  onCancel: () => void
  onClose: () => Promise<void>
  onModify: (patch: { price?: string; amount?: string; stopPrice?: string }) => Promise<{ ok: boolean; error?: string }>
  // The active software-side stop guarding this order, if any.
  safeArm?: SafeModeArm
  /** Which strategy placed this order, and its role in that strategy's bracket. */
  origin?: OrderOrigin
  onSafeMode: (opts:
    | { enabled: boolean; stopPct?: number; exitPct?: number }
    | { adjust: true; stopPct?: number; exitPct?: number; triggerPrice?: number }
  ) => Promise<void>
  // Lock/unlock the managed bracket this stop belongs to (undefined when bracketTargets is).
  onLockToggle?: (symbol: string, locked: boolean) => Promise<void>
}) {
  const [cancelling, setCancelling] = useState(false)
  const [closing, setClosing] = useState(false)
  const [modifyOpen, setModifyOpen] = useState(false)  // showing the modify form
  const [modifying, setModifying] = useState(false)
  const [modPrice, setModPrice] = useState('')
  const [modAmount, setModAmount] = useState('')
  const [modStop, setModStop] = useState('')
  const [safeOpen, setSafeOpen] = useState(false)   // showing the arm form
  const [adjustOpen, setAdjustOpen] = useState(false)   // showing the in-place adjust form
  const [safeBusy, setSafeBusy] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  const [stopPct, setStopPct] = useState('5')
  const [exitPct, setExitPct] = useState('0.1')
  const [adjStop, setAdjStop] = useState('5')
  const [adjExit, setAdjExit] = useState('0.1')
  const sideCol = order.side === 'buy' ? G : CR
  const filledPct = Number(order.originalAmount) > 0
    ? (Number(order.executedAmount) / Number(order.originalAmount)) * 100 : 0
  const currentPrice = ticker ? Number(ticker.last) : null
  const limitPrice = Number(order.price)
  const stopPrice = order.stopPrice ? Number(order.stopPrice) : null
  const isStopLimit = order.type.includes('stop')
  const avgFill = Number(order.avgExecutionPrice)
  const filledAmt = Number(order.executedAmount)
  // Live RSI for this position — take the shortest available timeframe (most current)
  // that has a seeded RSI-14 reading. Held coins carry 5m/1m, so a scalp shows 5m RSI.
  const rsiTf = (['5m', '15m', '1hr', '1day', '1m'] as const)
    .map((tf) => signal?.timeframes.find((t) => t.tf === tf && t.rsi14 != null))
    .find(Boolean)
  const rsi = rsiTf?.rsi14 ?? null
  const rsiColor = rsi == null ? GD : rsi >= 70 ? CR : rsi <= 30 ? G : GD
  const filledPnl = (avgFill > 0 && filledAmt > 0 && currentPrice)
    ? (order.side === 'buy' ? (currentPrice - avgFill) : (avgFill - currentPrice)) * filledAmt
    : null
  const filledPnlPct = (avgFill > 0 && currentPrice)
    ? (order.side === 'buy' ? (currentPrice - avgFill) / avgFill : (avgFill - currentPrice) / avgFill) * 100
    : null

  // Position P&L — only meaningful for SELL orders (selling a held position)
  const costBasis = order.costBasis
  const totalAmt = Number(order.originalAmount)
  const positionPnlAtLimit = (costBasis && costBasis > 0 && order.side === 'sell')
    ? (limitPrice - costBasis) * totalAmt : null
  const positionPnlAtLimitPct = (costBasis && costBasis > 0 && order.side === 'sell')
    ? (limitPrice - costBasis) / costBasis * 100 : null
  const positionPnlNow = (costBasis && costBasis > 0 && currentPrice && order.side === 'sell')
    ? (currentPrice - costBasis) * totalAmt : null
  const positionPnlNowPct = (costBasis && costBasis > 0 && currentPrice && order.side === 'sell')
    ? (currentPrice - costBasis) / costBasis * 100 : null

  // Upside: P&L if the bracket's take-profits fill as planned — the "successful exit"
  // counterpart to P&L AT LIMIT (the stop exit). Uses the same cost-basis reference so
  // all three (target / current / stop) are directly comparable. Before TP1 fills the
  // plan sells tp1Fraction at TP1 and the remainder at TP2 (or TP1 if no TP2); once TP1
  // has filled the resting stop protects only the remainder, which targets TP2.
  const targetRestPrice = bracketTargets ? (bracketTargets.tp2Price ?? bracketTargets.tp1Price) : null
  const pnlAtTarget = (bracketTargets && costBasis && costBasis > 0 && order.side === 'sell')
    ? (() => {
        const cost = costBasis * totalAmt
        const proceeds = (bracketTargets.phase === 'tp1_filled' || bracketTargets.phase === 'exiting')
          ? totalAmt * (targetRestPrice ?? bracketTargets.tp1Price)
          : totalAmt * bracketTargets.tp1Fraction * bracketTargets.tp1Price
            + totalAmt * (1 - bracketTargets.tp1Fraction) * (targetRestPrice ?? bracketTargets.tp1Price)
        return proceeds - cost
      })()
    : null
  const pnlAtTargetPct = (pnlAtTarget !== null && costBasis && costBasis > 0)
    ? (pnlAtTarget / (costBasis * totalAmt)) * 100 : null

  let distPct: number | null = null
  let proximityColor = GD
  const refPrice = isStopLimit && stopPrice ? stopPrice : limitPrice
  if (currentPrice && refPrice) {
    distPct = order.side === 'buy'
      ? ((currentPrice - refPrice) / refPrice) * 100
      : ((refPrice - currentPrice) / currentPrice) * 100
    proximityColor = Math.abs(distPct) < 1 ? G : Math.abs(distPct) < 3 ? '#c8a227' : GD
  }

  const handleCancel = async () => {
    setCancelling(true)
    await onCancel()
    setCancelling(false)
  }

  const handleClose = async () => {
    const base = order.symbol.replace(/USD$/, '')
    if (!confirm(`Close position: cancel this ${order.side.toUpperCase()} order and re-open ${fmtNum(order.remainingAmount, 6)} ${base} as a limit at the current market price?`)) return
    setClosing(true)
    await onClose()
    setClosing(false)
  }

  // Open the modify form seeded with the order's current terms.
  const openModify = () => {
    setModPrice(order.price)
    setModAmount(order.remainingAmount)
    setModStop(order.stopPrice ?? '')
    setModifyOpen(true)
  }

  const handleModify = async () => {
    const patch: { price?: string; amount?: string; stopPrice?: string } = {}
    if (modPrice && modPrice !== order.price) patch.price = modPrice
    if (modAmount && modAmount !== order.remainingAmount) patch.amount = modAmount
    if (isStopLimit && modStop && modStop !== (order.stopPrice ?? '')) patch.stopPrice = modStop
    if (Object.keys(patch).length === 0) { setModifyOpen(false); return }
    if (Number(modPrice) <= 0 || Number(modAmount) <= 0 || (isStopLimit && Number(modStop) <= 0)) {
      alert('Price and amount must be greater than 0'); return
    }
    const base = order.symbol.replace(/USD$/, '')
    if (!confirm(`Modify this ${order.side.toUpperCase()} ${base} order to ${modAmount} @ $${modPrice}${isStopLimit ? ` (stop $${modStop})` : ''}?\n\nThis cancels the current order and re-places it (Gemini has no in-place amend).`)) return
    setModifying(true)
    const r = await onModify(patch)
    setModifying(false)
    if (r.ok) setModifyOpen(false)
    else alert(`Modify failed: ${r.error ?? 'unknown error'}`)
  }

  const handleArm = async () => {
    const sp = Number(stopPct), ep = Number(exitPct)
    if (!(sp > 0) || !(ep >= 0)) { alert('Stop % must be > 0 and resell % ≥ 0'); return }
    setSafeBusy(true)
    await onSafeMode({ enabled: true, stopPct: sp, exitPct: ep })
    setSafeBusy(false)
    setSafeOpen(false)
  }

  const handleDisarm = async () => {
    setSafeBusy(true)
    await onSafeMode({ enabled: false })
    setSafeBusy(false)
  }

  // Open the in-place adjust form seeded with the live arm's current values.
  const openAdjust = () => {
    if (safeArm) { setAdjStop(String(safeArm.stopPct)); setAdjExit(String(safeArm.exitPct)) }
    setAdjustOpen(true)
  }

  const handleAdjust = async () => {
    const sp = Number(adjStop), ep = Number(adjExit)
    if (!(sp > 0) || !(ep >= 0)) { alert('Stop % must be > 0 and resell % ≥ 0'); return }
    setSafeBusy(true)
    // In-place move — the resting order is never cancelled/replaced.
    await onSafeMode({ adjust: true, stopPct: sp, exitPct: ep })
    setSafeBusy(false)
    setAdjustOpen(false)
  }

  const handleLockToggle = async () => {
    if (!bracketTargets || !onLockToggle) return
    setLockBusy(true)
    await onLockToggle(bracketTargets.symbol, !bracketTargets.locked)
    setLockBusy(false)
  }

  return (
    <div style={{ border: `0.5px solid ${sideCol}55`, padding: '10px 12px', marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 18, color: sideCol, letterSpacing: 1, ...MONO }}>
            {order.side.toUpperCase()} {order.symbol}
          </span>
          {rsi != null && (
            <span style={{ fontSize: 11, color: rsiColor, ...MONO, border: `0.5px solid ${rsiColor}55`, borderRadius: 2, padding: '0 4px' }}
              title={`RSI-14 (${rsiTf?.tf}) — live`}>
              RSI {rsi.toFixed(0)}
            </span>
          )}
          {/* Owning strategy + this order's role within its bracket. */}
          {(() => {
            const m = origin ? STRATEGY_META[origin.strategy] : undefined
            const col = m?.color ?? GD
            return (
              <span
                title={origin
                  ? `Placed by ${m?.label ?? origin.strategy} as the ${origin.role} of its bracket`
                  : 'Placed manually — no strategy owns this order'}
                style={{ fontSize: 11, color: col, ...MONO, border: `0.5px solid ${col}55`, borderRadius: 2, padding: '0 4px', opacity: origin ? 1 : 0.6 }}
              >
                {origin ? `${m?.glyph ?? ''} ${m?.label ?? origin.strategy.toUpperCase()} · ${origin.role}` : '✋ MANUAL'}
              </span>
            )
          })()}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Lbl size={8} c={GD}>{order.type.replace('exchange ', '').toUpperCase()}</Lbl>
          {expiresAt != null && <Countdown deadlineMs={expiresAt} />}
          <Lbl size={9}>{ago(order.timestampMs)}</Lbl>
        </div>
      </div>

      {/* Prices row */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
        {isStopLimit && stopPrice && (
          <div>
            <Lbl>STOP TRIGGER</Lbl>
            <div><Val size={10} c='#c8a227'>{fmtPrice(stopPrice)}</Val></div>
          </div>
        )}
        <div>
          <Lbl>LIMIT</Lbl>
          <div><Val size={10}>{fmtPrice(limitPrice)}</Val></div>
        </div>
        {currentPrice && (
          <div>
            <Lbl>CURRENT</Lbl>
            <div><Val size={10} c={changeColor(ticker?.change ?? 0)}>{fmtPrice(currentPrice)}</Val></div>
          </div>
        )}
        <div>
          <Lbl>AMOUNT</Lbl>
          <div><Val size={10}>{fmtNum(order.remainingAmount, 6)} remaining</Val></div>
        </div>
        {Number(order.executedAmount) > 0 && (
          <div>
            <Lbl>FILLED</Lbl>
            <div><Val size={10} c={G}>{fmtNum(order.executedAmount, 6)}</Val></div>
          </div>
        )}
      </div>

      {/* BTC ladder buy-back — the P&L that matters is BTC gained vs the price the
          paired slice was SOLD at, not the resting limit. If price has fallen since
          the sell, closing the round-trip at market now reacquires MORE BTC than was
          sold (+% minus fees); if price rose, a market-buy loses BTC — wait for the
          limit. This is the read for "is it good to close and buy at market?". */}
      {ladderCycle && currentPrice && ladderCycle.soldPrice > 0 && (() => {
        const S = ladderCycle.soldPrice, P = currentPrice
        const grossPct = (S / P - 1) * 100          // BTC gain % from buying back at P vs selling at S
        const FEE_PCT = 0.7                          // round-trip taker fees (see crypto_common.py)
        const netPct = grossPct - FEE_PCT
        const netBtc = ladderCycle.soldBtc * (S / P) - ladderCycle.soldBtc - ladderCycle.soldBtc * (FEE_PCT / 100)
        const good = netPct >= 0
        const col = good ? G : CR
        return (
          <div style={{ padding: '6px 10px', background: 'var(--bg-elev)', border: `0.5px solid ${col}55`, marginBottom: 8 }}>
            <Lbl size={8} c={col}>◇ LADDER BTC P&L — CLOSE AT MARKET</Lbl>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 1 }}>
              <span style={{ fontSize: 22, color: col, ...MONO }}>{netPct >= 0 ? '+' : ''}{netPct.toFixed(2)}%</span>
              <span style={{ fontSize: 13, color: col, ...MONO }}>{netBtc >= 0 ? '+' : ''}{fmtNum(netBtc, 8)} BTC</span>
              <span style={{ fontSize: 11, color: GD, ...MONO }}>net of ~{FEE_PCT}% fees</span>
            </div>
            <div style={{ fontSize: 11, color: GD, ...MONO, marginTop: 2 }}>
              sold {fmtNum(ladderCycle.soldBtc, 8)} BTC @ {fmtPrice(S)} · market {fmtPrice(P)} ({grossPct >= 0 ? '+' : ''}{grossPct.toFixed(2)}% gross)
              {good
                ? ' — closing now banks BTC'
                : ' — market-buy would lose BTC; hold for the limit'}
            </div>
          </div>
        )
      })()}

      {/* BUY offer vs current market — the instant unrealized P&L you'd bank the
          moment this resting buy fills, measured against the live price. Positive =
          your offer sits below market, so a fill enters that much in profit and
          buying at market now would cost more; negative = market has dropped below
          your offer (it should be filling), so a market-buy would be cheaper. This
          is the read for "should I cancel and just buy at market?". Suppressed for
          BTC ladder buy-backs, which show the BTC-terms P&L above instead. */}
      {!ladderCycle && order.side === 'buy' && currentPrice && limitPrice > 0 && (() => {
        const edgePct = (currentPrice - limitPrice) / limitPrice * 100
        const edgeUsd = (currentPrice - limitPrice) * totalAmt
        const below = edgePct >= 0  // offer below market
        const col = below ? G : CR
        return (
          <div style={{ padding: '6px 10px', background: 'var(--bg-elev)', marginBottom: 8 }}>
            <Lbl size={8}>P&L vs MARKET (if filled now)</Lbl>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 1 }}>
              <span style={{ fontSize: 20, color: col, ...MONO }}>{below ? '+' : ''}{edgePct.toFixed(2)}%</span>
              <span style={{ fontSize: 13, color: col, ...MONO }}>{below ? '+' : '-'}${fmtNum(Math.abs(edgeUsd))}</span>
            </div>
            <div style={{ fontSize: 11, color: GD, ...MONO, marginTop: 2 }}>
              {below
                ? `offer ${edgePct.toFixed(2)}% below market — buying at market now costs $${fmtNum(Math.abs(edgeUsd))} more`
                : `offer ${Math.abs(edgePct).toFixed(2)}% above market — should fill; market-buy is $${fmtNum(Math.abs(edgeUsd))} cheaper`}
            </div>
          </div>
        )
      })()}

      {/* Position P&L (cost basis vs limit / current) for sell orders */}
      {positionPnlAtLimit !== null && (
        <div style={{ padding: '6px 10px', background: 'var(--bg-elev)', marginBottom: 8, display: 'flex', gap: 16 }}>
          <div>
            <Lbl size={8}>P&L AT LIMIT</Lbl>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 1 }}>
              <span style={{ fontSize: 18, color: (positionPnlAtLimit ?? 0) >= 0 ? G : CR, ...MONO }}>
                {fmtSignedUsd(positionPnlAtLimit ?? 0)}
              </span>
              {positionPnlAtLimitPct !== null && (
                <span style={{ fontSize: 13, color: positionPnlAtLimitPct >= 0 ? G : CR, ...MONO }}>
                  {positionPnlAtLimitPct >= 0 ? '+' : ''}{positionPnlAtLimitPct.toFixed(2)}%
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: GD, ...MONO, marginTop: 1 }}>avg cost {fmtPrice(costBasis!)}</div>
          </div>
          {positionPnlNow !== null && (
            <div>
              <Lbl size={8}>P&L NOW</Lbl>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 1 }}>
                <span style={{ fontSize: 18, color: (positionPnlNow ?? 0) >= 0 ? G : CR, ...MONO }}>
                  {fmtSignedUsd(positionPnlNow ?? 0)}
                </span>
                {positionPnlNowPct !== null && (
                  <span style={{ fontSize: 13, color: positionPnlNowPct >= 0 ? G : CR, ...MONO }}>
                    {positionPnlNowPct >= 0 ? '+' : ''}{positionPnlNowPct.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          )}
          {pnlAtTarget !== null && bracketTargets && (
            <div>
              <Lbl size={8}>P&L AT TARGET</Lbl>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 1 }}>
                <span style={{ fontSize: 18, color: pnlAtTarget >= 0 ? G : CR, ...MONO }}>
                  {fmtSignedUsd(pnlAtTarget)}
                </span>
                {pnlAtTargetPct !== null && (
                  <span style={{ fontSize: 13, color: pnlAtTargetPct >= 0 ? G : CR, ...MONO }}>
                    {pnlAtTargetPct >= 0 ? '+' : ''}{pnlAtTargetPct.toFixed(2)}%
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: GD, ...MONO, marginTop: 1 }}>
                T1 {fmtPrice(bracketTargets.tp1Price)}{bracketTargets.tp2Price ? ` · T2 ${fmtPrice(bracketTargets.tp2Price)}` : ''}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fill progress + P&L on filled portion */}
      {filledPct > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <Lbl size={8}>FILL PROGRESS</Lbl>
            <Lbl size={8} c={G}>{filledPct.toFixed(1)}%</Lbl>
          </div>
          <MiniBar pct={filledPct} color={G} height={3} />
        </div>
      )}
      {/* Unrealized P&L on filled portion */}
      {filledPnl !== null && filledAmt > 0 && (
        <div style={{ padding: '5px 8px', background: 'var(--bg-elev)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Lbl size={8}>UNREALIZED P&L (filled portion)</Lbl>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 1 }}>
              <span style={{ fontSize: 17, color: filledPnl >= 0 ? G : CR, ...MONO }}>
                {fmtSignedUsd(filledPnl)}
              </span>
              {filledPnlPct !== null && (
                <span style={{ fontSize: 13, color: filledPnl >= 0 ? G : CR, ...MONO }}>
                  {filledPnlPct >= 0 ? '+' : ''}{filledPnlPct.toFixed(2)}%
                </span>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Lbl size={8}>AVG FILL</Lbl>
            <div style={{ fontSize: 13, color: GD, ...MONO, marginTop: 1 }}>{fmtPrice(avgFill)}</div>
          </div>
        </div>
      )}

      {/* Price positioning — tug-of-war between the exit floor (limit/stop) and the
          take-profit target when this is a managed bracket; otherwise a simple
          distance-to-trigger meter. */}
      {targetRestPrice !== null && currentPrice && refPrice ? (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Lbl c={proximityColor} size={9}>
              {distPct !== null && Math.abs(distPct) < 0.1
                ? `⚡ AT ${isStopLimit ? 'TRIGGER' : 'LIMIT'}`
                : distPct !== null && distPct < 0
                  ? `${Math.abs(distPct).toFixed(2)}% past ${isStopLimit ? 'trigger' : 'limit'}`
                  : distPct !== null
                    ? `${distPct.toFixed(2)}% to ${isStopLimit ? 'trigger' : 'fill'}`
                    : ''}
            </Lbl>
            <Lbl size={8} c={GD}>#{order.orderId}</Lbl>
          </div>
          <TugOfWarBar
            low={refPrice} high={targetRestPrice} current={currentPrice}
            lowLabel={`${isStopLimit ? 'STOP' : 'LIMIT'} ${fmtPrice(refPrice)}`}
            highLabel={`TARGET ${fmtPrice(targetRestPrice)}`}
          />
        </div>
      ) : distPct !== null && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <Lbl c={proximityColor} size={9}>
              {Math.abs(distPct) < 0.1
                ? `⚡ AT ${isStopLimit ? 'TRIGGER' : 'LIMIT'}`
                : distPct < 0
                  ? `${Math.abs(distPct).toFixed(2)}% past ${isStopLimit ? 'trigger' : 'limit'}`
                  : `${distPct.toFixed(2)}% to ${isStopLimit ? 'trigger' : 'fill'}`}
            </Lbl>
            <Lbl size={8} c={GD}>#{order.orderId}</Lbl>
          </div>
          <MiniBar pct={Math.max(0, 100 - Math.abs(distPct) * 10)} color={proximityColor} height={3} />
        </div>
      )}

      {/* Safe mode — software-side synthetic stop (SELL orders only) */}
      {order.side === 'sell' && (safeArm ? (
        <div style={{ marginBottom: 8, padding: '6px 8px', background: 'var(--bg-elev)', border: `0.5px solid ${G}55`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: G, letterSpacing: 1, ...MONO }}>🛡 SAFE MODE ON</span>
          <Lbl size={10}>
            stop −{fmtNum(safeArm.stopPct, 2)}% @ {fmtPrice(safeArm.triggerPrice)} → resell +{safeArm.exitPct}% over market
          </Lbl>
          <div style={{ flex: 1 }} />
          {adjustOpen ? (
            <>
              <Lbl size={10}>STOP −</Lbl>
              <input value={adjStop} onChange={(e) => setAdjStop(e.target.value)} style={{ width: 46, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: G, padding: '2px 4px' }} />
              <Lbl size={10}>%   RESELL +</Lbl>
              <input value={adjExit} onChange={(e) => setAdjExit(e.target.value)} style={{ width: 46, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: G, padding: '2px 4px' }} />
              <Lbl size={10}>%</Lbl>
              {Number(adjStop) > 0 && (
                <Lbl size={9} c={GD}>trigger ≈ {fmtPrice(safeArm.armPrice * (1 - Number(adjStop) / 100))} (order stays live)</Lbl>
              )}
              <button onClick={handleAdjust} disabled={safeBusy} style={{
                ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
                background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
              }}>{safeBusy ? 'MOVING…' : 'APPLY'}</button>
              <button onClick={() => setAdjustOpen(false)} disabled={safeBusy} style={{
                ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
                background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
              }}>CANCEL</button>
            </>
          ) : (
            <>
              <button onClick={openAdjust} disabled={safeBusy} style={{
                ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
                background: 'transparent', border: `0.5px solid ${GD}`, color: GD, cursor: 'pointer',
              }}>ADJUST</button>
              <button onClick={handleDisarm} disabled={safeBusy} style={{
                ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
                background: 'transparent', border: `0.5px solid ${CR}`, color: CR, cursor: 'pointer',
              }}>{safeBusy ? '…' : 'DISARM'}</button>
            </>
          )}
        </div>
      ) : safeOpen ? (
        <div style={{ marginBottom: 8, padding: '6px 8px', background: 'var(--bg-elev)', border: BORDER, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Lbl size={10}>STOP −</Lbl>
          <input value={stopPct} onChange={(e) => setStopPct(e.target.value)} style={{ width: 46, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: G, padding: '2px 4px' }} />
          <Lbl size={10}>%   RESELL +</Lbl>
          <input value={exitPct} onChange={(e) => setExitPct(e.target.value)} style={{ width: 46, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: G, padding: '2px 4px' }} />
          <Lbl size={10}>%</Lbl>
          {currentPrice && Number(stopPct) > 0 && (
            <Lbl size={9} c={GD}>trigger ≈ {fmtPrice(currentPrice * (1 - Number(stopPct) / 100))}</Lbl>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={handleArm} disabled={safeBusy} style={{
            ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
            background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
          }}>{safeBusy ? 'ARMING…' : 'ARM'}</button>
          <button onClick={() => setSafeOpen(false)} disabled={safeBusy} style={{
            ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
            background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
          }}>CANCEL</button>
        </div>
      ) : null)}

      {/* Modify (cancel-and-replace) — change resting price / amount / stop trigger */}
      {modifyOpen && (
        <div style={{ marginBottom: 8, padding: '6px 8px', background: 'var(--bg-elev)', border: BORDER, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {isStopLimit && (
            <>
              <Lbl size={10}>STOP</Lbl>
              <input value={modStop} onChange={(e) => setModStop(e.target.value)} placeholder={order.stopPrice}
                style={{ width: 84, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: '#c8a227', padding: '2px 4px' }} />
            </>
          )}
          <Lbl size={10}>LIMIT</Lbl>
          <input value={modPrice} onChange={(e) => setModPrice(e.target.value)} placeholder={order.price}
            style={{ width: 84, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: G, padding: '2px 4px' }} />
          <Lbl size={10}>AMOUNT</Lbl>
          <input value={modAmount} onChange={(e) => setModAmount(e.target.value)} placeholder={order.remainingAmount}
            style={{ width: 96, ...MONO, fontSize: 12, background: 'var(--bg)', border: BORDER, color: G, padding: '2px 4px' }} />
          {currentPrice && Number(modPrice) > 0 && (
            <Lbl size={9} c={GD}>≈ ${fmtNum(Number(modPrice) * Number(modAmount || '0'))} · {(((Number(modPrice) - currentPrice) / currentPrice) * 100).toFixed(2)}% vs mkt</Lbl>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={handleModify} disabled={modifying} style={{
            ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
            background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
          }}>{modifying ? 'APPLYING…' : 'APPLY'}</button>
          <button onClick={() => setModifyOpen(false)} disabled={modifying} style={{
            ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px',
            background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
          }}>CANCEL</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={handleCancel} disabled={cancelling || closing || modifying} style={{
          ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px',
          background: 'transparent', border: `0.5px solid ${CR}`, color: CR, cursor: 'pointer',
        }}>{cancelling ? 'CANCELLING…' : 'CANCEL ORDER'}</button>
        <button onClick={handleClose} disabled={cancelling || closing || modifying} style={{
          ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px',
          background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
        }}>{closing ? 'CLOSING…' : 'CLOSE POSITION'}</button>
        {!modifyOpen && (
          <button onClick={openModify} disabled={cancelling || closing} style={{
            ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px',
            background: 'transparent', border: `0.5px solid ${GD}`, color: GD, cursor: 'pointer',
          }}>MODIFY</button>
        )}
        {order.side === 'sell' && !safeArm && !safeOpen && (
          <button onClick={() => setSafeOpen(true)} style={{
            ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px',
            background: 'transparent', border: `0.5px solid ${GD}`, color: GD, cursor: 'pointer',
          }}>SAFE MODE</button>
        )}
        {bracketTargets && onLockToggle && (
          <button onClick={handleLockToggle} disabled={lockBusy}
            title={bracketTargets.locked ? 'Unlock — resume auto-management' : "Lock — auto-trade won't move this trade"}
            style={{
              ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px',
              background: bracketTargets.locked ? '#c8a227' : 'transparent',
              border: `0.5px solid ${bracketTargets.locked ? '#c8a227' : GD}`,
              color: bracketTargets.locked ? '#000' : GD, cursor: 'pointer',
            }}>{lockBusy ? '…' : bracketTargets.locked ? '🔒 LOCKED' : '🔓 LOCK'}</button>
        )}
      </div>
    </div>
  )
}

// Triggers the /crypto-strategy skill headlessly and polls its status. When a run
// finishes, the skill posts its report to /api/crypto/plan-report, which the snapshot
// poll picks up automatically.
function loadStrategyPref(): StrategyId {
  try {
    const v = localStorage.getItem(STRATEGY_PREF_KEY)
    if (STRATEGY_OPTIONS.some((o) => o.id === v)) return v as StrategyId
  } catch { /* ignore */ }
  return 'crypto-strategy'
}

function RunStrategyButton() {
  const [status, setStatus] = useState<StrategyRunStatus | null>(null)
  const [strategy, setStrategy] = useState<StrategyId>(loadStrategyPref)
  const [loop, setLoop] = useState(false)
  const [loopBusy, setLoopBusy] = useState(false)
  const [intervalMin, setIntervalMin] = useState(0)   // server setting (0 = off)
  const [intervalDraft, setIntervalDraft] = useState('') // what's typed in the box
  // Any strategy with its own individual interval (SETTINGS section) makes the
  // universal one below go inert server-side — reflect that in the UI too.
  const [perStrategyIntervalsActive, setPerStrategyIntervalsActive] = useState(false)
  const running = status?.state === 'running'
  // While a run is active it owns the selector — reflect the strategy actually running.
  const selected = running && status ? status.strategy : strategy

  // Poll status while a run is active (or just after a click) so the button reflects progress.
  useEffect(() => {
    if (!running) return
    const id = setInterval(async () => {
      try { setStatus(await fetchStrategyStatus()) } catch { /* ignore transient */ }
    }, 3000)
    return () => clearInterval(id)
  }, [running])

  // On mount, sync with any run already in flight (e.g. started before this panel rendered),
  // and adopt the server's persisted enabled-strategy as the source of truth (a headless
  // routine dispatches on it, so the control must reflect and set the same value).
  useEffect(() => {
    fetchStrategyStatus().then(setStatus).catch(() => {})
    fetchEnabledStrategy()
      .then((id) => { setStrategy(id); try { localStorage.setItem(STRATEGY_PREF_KEY, id) } catch { /* ignore */ } })
      .catch(() => {})
    fetchLoopMode().then(setLoop).catch(() => {})
    fetchStrategyInterval().then((m) => { setIntervalMin(m); setIntervalDraft(m > 0 ? String(m) : '') }).catch(() => {})
    fetchStrategyIntervals().then((m) => setPerStrategyIntervalsActive(Object.values(m).some((v) => v > 0))).catch(() => {})
  }, [])

  const toggleLoop = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setLoopBusy(true)
    try { setLoop(await setLoopMode(!loop)) } finally { setLoopBusy(false) }
  }

  // Commit the typed interval (blur/Enter). Empty or 0 turns it off; server clamps 1–1440.
  const commitInterval = async () => {
    const parsed = Math.round(Number(intervalDraft))
    const want = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    try {
      const m = await setStrategyInterval(want)
      setIntervalMin(m); setIntervalDraft(m > 0 ? String(m) : '')
    } catch { /* leave draft as-is for retry */ }
  }

  // Explicit one-click disable — the control sits next to the LOOP toggle and reads as a
  // toggle, so clicking ✕ turns the interval off directly (0 = off) rather than requiring
  // the user to clear the number field and blur.
  const disableInterval = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    try {
      const m = await setStrategyInterval(0)
      setIntervalMin(m); setIntervalDraft('')
    } catch { /* ignore */ }
  }

  const pick = (id: StrategyId) => {
    if (running) return
    setStrategy(id)
    try { localStorage.setItem(STRATEGY_PREF_KEY, id) } catch { /* ignore */ }
    // Persist server-side so /crypto-strategy (headless) dispatches on this choice.
    void setEnabledStrategyApi(id).catch(() => {})
  }

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (running) return
    setStatus({ state: 'running', strategy, source: 'app', startedAt: Date.now(), endedAt: null, activity: 'Starting…', error: null })
    try {
      const res = await runCryptoStrategy(strategy)
      setStatus(res.status)
    } catch (err) {
      setStatus({ state: 'error', strategy, source: 'app', startedAt: null, endedAt: Date.now(), activity: '', error: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
      {/* Strategy switch — dropdown of the Claude trading methods, disabled mid-run */}
      <select
        value={selected}
        disabled={running}
        onChange={(e) => { e.stopPropagation(); pick(e.target.value as StrategyId) }}
        title="Choose which strategy the run button executes"
        style={{ ...MONO, fontSize: 12, letterSpacing: 1, padding: '4px 10px', background: 'transparent', border: `0.5px solid ${running ? GD : G}`, color: running ? GD : G, cursor: running ? 'default' : 'pointer' }}
      >
        {STRATEGY_OPTIONS.map((o) => (
          <option key={o.id} value={o.id} style={{ background: '#000', color: G }}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        onClick={onClick}
        disabled={running}
        title={`Run the /${selected} skill now`}
        style={{ ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px', background: 'transparent', border: `0.5px solid ${running ? GD : G}`, color: running ? GD : G, cursor: running ? 'default' : 'pointer' }}
      >
        {running ? '◈ RUNNING…' : '▶ RUN'}
      </button>
      <button
        onClick={toggleLoop}
        disabled={loopBusy}
        title="Loop mode: auto-run the enabled strategy ~10s after a position closes (throttled to once per 10 min)"
        style={{ ...MONO, fontSize: 13, letterSpacing: 1, padding: '4px 12px', background: loop ? G : 'transparent', border: `0.5px solid ${loop ? G : GD}`, color: loop ? '#000' : GD, cursor: loopBusy ? 'default' : 'pointer' }}
      >
        {loop ? '↻ LOOP: ON' : '↻ LOOP: OFF'}
      </button>
      {/* Interval timer — auto-run the enabled strategy every N minutes (blank = off).
          Goes inert server-side (and disabled here) once any strategy has its own
          individual interval set in SETTINGS — scheduling has moved there instead. */}
      <label
        title={perStrategyIntervalsActive
          ? 'Disabled — one or more strategies have their own individual interval (see SETTINGS)'
          : 'Interval timer: auto-run the enabled strategy every N minutes (server-side; blank/0 = off)'}
        style={{ display: 'flex', alignItems: 'center', gap: 4, ...MONO, fontSize: 12, letterSpacing: 1, color: perStrategyIntervalsActive ? GD : (intervalMin > 0 ? G : GD), border: `0.5px solid ${GD}`, padding: '3px 8px', opacity: perStrategyIntervalsActive ? 0.5 : 1 }}
      >
        <span>⏱ EVERY</span>
        <input
          type="number" min={1} max={1440} step={1} placeholder="off"
          value={intervalDraft}
          disabled={perStrategyIntervalsActive}
          onChange={(e) => setIntervalDraft(e.target.value)}
          onBlur={commitInterval}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
          style={{ width: 40, background: 'transparent', border: 'none', borderBottom: `0.5px solid ${GD}`, color: perStrategyIntervalsActive ? GD : (intervalMin > 0 ? G : GD), ...MONO, fontSize: 12, textAlign: 'right', outline: 'none' }}
        />
        <span>MIN</span>
        {intervalMin > 0 && !perStrategyIntervalsActive && (
          <button
            onClick={disableInterval}
            title="Turn the interval timer off"
            style={{ ...MONO, fontSize: 12, marginLeft: 2, background: 'transparent', border: 'none', color: G, cursor: 'pointer', padding: 0, lineHeight: 1 }}
          >
            ✕
          </button>
        )}
      </label>
      {running && status?.activity && (
        <span style={{ fontSize: 12, color: GD, ...MONO, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.activity}</span>
      )}
      {status?.state === 'error' && status.error && (
        <span style={{ fontSize: 12, color: 'var(--crimson)', ...MONO }}>{status.error}</span>
      )}
    </div>
  )
}

// Per-skill accent + label for the report-history cards.
const REPORT_KIND_META: Record<PlanReportEntry['kind'], { color: string; label: string; glyph: string }> = {
  strategy: { color: 'var(--green)', label: 'STRATEGY', glyph: '◈' },
  'fast-cash': { color: '#e0a020', label: 'FAST-CASH', glyph: '⚡' },
  candle: { color: '#4aa3df', label: 'CANDLE', glyph: '▤' },
  oversold: { color: '#c060d0', label: 'OVERSOLD', glyph: '🟢' },
  firecracker: { color: '#e05a3c', label: 'FIRECRACKER', glyph: '🧨' },
  sniper: { color: '#3cc9a7', label: 'SNIPER', glyph: '🎯' },
  'btc-ladder': { color: '#f7931a', label: 'BTC LADDER', glyph: '🪜' },
  trapline: { color: '#42e8d5', label: 'TRAPLINE', glyph: '⌇' },
  reaper: { color: '#b06cd0', label: 'REAPER', glyph: '☠' },
}

/** Per-strategy identity for order attribution — keyed by strategy id (AutoStep.strategy /
 *  PendingTrade.strategy), which is NOT the same key space as REPORT_KIND_META's report
 *  kinds ('crypto-strategy' vs 'strategy', 'crypto-candles' vs 'candle'). Colours are kept
 *  in sync with the report cards on purpose: one strategy reads the same colour whether
 *  you're looking at its report or at an order it placed. `short` fits inside a planet. */
const STRATEGY_META: Record<string, { color: string; label: string; short: string; glyph: string }> = {
  'crypto-strategy': { color: 'var(--green)', label: 'CRYPTO STRATEGY', short: 'STRAT', glyph: '◈' },
  'fast-cash': { color: '#e0a020', label: 'FAST CASH', short: 'FAST', glyph: '⚡' },
  'crypto-candles': { color: '#4aa3df', label: 'CANDLES', short: 'CNDL', glyph: '▤' },
  oversold: { color: '#c060d0', label: 'OVERSOLD', short: 'OVSD', glyph: '🟢' },
  firecracker: { color: '#e05a3c', label: 'FIRECRACKER', short: 'FIRE', glyph: '🧨' },
  sniper: { color: '#3cc9a7', label: 'SNIPER', short: 'SNIP', glyph: '🎯' },
  'btc-ladder': { color: '#f7931a', label: 'BTC LADDER', short: 'LADR', glyph: '🪜' },
  trapline: { color: '#42e8d5', label: 'TRAPLINE', short: 'TRAP', glyph: '⌇' },
  reaper: { color: '#b06cd0', label: 'REAPER', short: 'REAP', glyph: '☠' },
}

/** Which strategy placed a resting order, and what the order does within that strategy's
 *  bracket. Orders placed by hand carry no attribution and render as MANUAL. */
interface OrderOrigin { strategy: string; role: string }

/** Build orderId → origin for every resting order we can attribute.
 *
 *  Two sources, in precedence order:
 *   1. Live bracket state — the authoritative one. Every id a bracket places is tracked on
 *      its BracketState (entry, entry legs + their per-leg TPs, stop, TP1/TP2, exit legs),
 *      so the role is known exactly, not guessed.
 *   2. The executed-trade log — covers strategy trades placed outside a managed bracket
 *      (staged pending trades that carry `strategy`). Role is unknown here, so it's labelled
 *      by side.
 *  Anything still unmatched was placed manually and is left out deliberately: showing a
 *  wrong strategy on an order would be worse than showing none. */
function buildOrderOrigins(autoPlans: AutoPlanStatus[], trades: TradeRecord[]): Map<string, OrderOrigin> {
  const map = new Map<string, OrderOrigin>()
  // Lowest precedence first, so bracket state overwrites the coarser trade-log guess.
  for (const t of trades) {
    if (t.orderId && t.strategy && t.status === 'executed') {
      map.set(t.orderId, { strategy: t.strategy, role: t.side === 'buy' ? 'entry' : 'exit' })
    }
  }
  for (const plan of autoPlans) {
    for (const step of plan.steps) {
      const strategy = step.strategy
      if (!strategy) continue
      const st = step.bracketState
      const put = (id: string | null | undefined, role: string) => { if (id) map.set(id, { strategy, role }) }
      if (!st) {
        // Non-bracket step: its own resting order, if it has been placed.
        put(step.geminiOrderId, step.side === 'buy' ? 'entry' : 'exit')
        continue
      }
      put(st.entryId, 'entry')
      put(st.stopId, 'stop')
      put(st.tp1Id, 'take-profit')
      put(st.tp2Id, 'take-profit 2')
      st.entryLegs?.forEach((leg, i) => {
        put(leg.orderId, `entry leg ${i + 2}`)   // leg 1 is entryId above
        put(leg.tpId, `take-profit leg ${i + 2}`)
      })
      st.exitLegs?.forEach((leg, i) => put(leg.orderId, `exit leg ${i + 1}`))
    }
  }
  return map
}

function ageLabelFrom(ageMin: number | null): string {
  return ageMin === null ? 'unknown age'
    : ageMin < 1 ? 'just now'
    : ageMin < 60 ? `${ageMin}m ago`
    : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`
}

// Lightweight markdown line renderer shared by the live-status panel and report cards.
function renderReportLines(report: string): React.ReactNode {
  return report.split('\n').map((line, i) => {
    const isH2 = line.startsWith('## ')
    const isH3 = line.startsWith('### ')
    const isBullet = line.startsWith('- ') || line.startsWith('* ')
    const isBold = /^\*\*(.+)\*\*/.test(line.trim())
    const isHr = /^---+$/.test(line.trim())
    if (isHr) return <div key={i} style={{ borderBottom: BORDER, margin: '6px 0' }} />
    if (isH2) return <div key={i} style={{ fontSize: 14, color: G, letterSpacing: 1.5, ...MONO, marginTop: 10, marginBottom: 4 }}>{line.replace(/^## /, '')}</div>
    if (isH3) return <div key={i} style={{ fontSize: 13, color: G, letterSpacing: 1, ...MONO, marginTop: 8, marginBottom: 2 }}>{line.replace(/^### /, '')}</div>
    if (isBullet) return <div key={i} style={{ fontSize: 13, color: GD, ...MONO, paddingLeft: 8 }}>{line}</div>
    if (!line.trim()) return <div key={i} style={{ height: 4 }} />
    const cleaned = line.replace(/\*\*([^*]+)\*\*/g, '$1')
    return <div key={i} style={{ fontSize: 13, color: isBold ? G : GD, ...MONO }}>{cleaned}</div>
  })
}

// One collapsible report card in the history, colour-keyed by which skill produced it.
function ReportCard({ entry, defaultOpen, now }: { entry: PlanReportEntry; defaultOpen: boolean; now: number }) {
  const [open, setOpen] = useState(defaultOpen)
  const meta = REPORT_KIND_META[entry.kind] ?? REPORT_KIND_META.strategy
  const ageMin = Math.floor((now - entry.at) / 60_000)
  const stamp = new Date(entry.at).toLocaleString()
  return (
    <div style={{ borderLeft: `2px solid ${meta.color}`, border: BORDER, borderLeftWidth: 2, marginBottom: 6 }}>
      <div onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: open ? BORDER : 'none' }}>
        <span style={{ fontSize: 12, color: meta.color, ...MONO }}>{meta.glyph}</span>
        <span style={{ fontSize: 11, color: meta.color, letterSpacing: 1, ...MONO, fontWeight: 700, background: `${meta.color}1a`, padding: '1px 6px', borderRadius: 2 }}>{meta.label}</span>
        <span style={{ fontSize: 12, color: GD, ...MONO }}>{ageLabelFrom(ageMin)}</span>
        <Lbl size={8}>{stamp}</Lbl>
        <div style={{ flex: 1 }} />
        <Lbl>{open ? '▲' : '▼'}</Lbl>
      </div>
      {open && (
        <div style={{ padding: '8px 12px', maxHeight: 420, overflowY: 'auto' }}>
          {renderReportLines(entry.report)}
        </div>
      )}
    </div>
  )
}

// The last 10 analysis reports (strategy / fast-cash / candle), newest first, each
// collapsed by default — click any card to expand it.
function ReportsHistoryPanel({ reports }: { reports: PlanReportEntry[] }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  if (!reports.length) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 6px' }}>
        <span style={{ fontSize: 13, color: G, letterSpacing: 1.5, ...MONO }}>◈ REPORTS</span>
        <Lbl size={10}>last {reports.length} · newest first</Lbl>
      </div>
      {reports.map((r) => (
        <ReportCard key={r.at} entry={r} defaultOpen={false} now={now} />
      ))}
    </div>
  )
}

function PlanReportPanel({ report, reportAt }: { report: string; reportAt: number | null }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  // Tick every 30s so staleness label stays current
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Only the live order-status ping shows here; full analysis reports live in the
  // ReportsHistoryPanel above. If the latest post was a full report (classified), skip
  // it here to avoid duplicating a history card.
  const isFullReport = /##[^\n]*(STRATEGY REPORT|FAST-CASH REPORT|CANDLE[^\n]*REPORT)/.test(report)
  if (!report || isFullReport) return null

  const ageMs = reportAt ? now - reportAt : null
  const ageMin = ageMs ? Math.floor(ageMs / 60_000) : null
  const ageColor = ageMin === null ? GD : ageMin < 5 ? G : ageMin < 30 ? '#c8a227' : 'var(--crimson)'
  const timestamp = reportAt ? new Date(reportAt).toLocaleTimeString() : null

  return (
    <div style={{ border: `0.5px solid ${ageColor}44`, marginBottom: 12 }}>
      <div onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', borderBottom: open ? BORDER : 'none' }}>
        <span style={{ fontSize: 13, color: ageColor, letterSpacing: 1.5, ...MONO }}>◎ LIVE ORDER STATUS</span>
        <span style={{ fontSize: 12, color: ageColor, ...MONO }}>{ageLabelFrom(ageMin)}</span>
        {timestamp && <Lbl size={8}>{timestamp}</Lbl>}
        <div style={{ flex: 1 }} />
        <Lbl>{open ? '▲' : '▼'}</Lbl>
      </div>
      {open && (
        <div style={{ padding: '10px 12px', maxHeight: 360, overflowY: 'auto' }}>
          {renderReportLines(report)}
        </div>
      )}
    </div>
  )
}

// ── Ammo-box growth plate ───────────────────────────────────────────────
// The account's total value stamped like an ordnance spec-plate: a hero TOTAL in USD·BTC, the
// BTC actually held + USD cash as spec rows, a strip of change "stamps" over 24H/7D/30D/YTD (in
// both USD and BTC), and — as a separate readout — the net BTC BANKED by the ladder's round-trips.
// Baseline can be anchored to Jan 1 (YTD, reconstructed), reset to now, or edited.
const AMBER = 'var(--amber)'

// A stencilled section label — uppercase, wide-tracked, muted amber like stamped paint.
function Stencil({ children, size = 11, c = AMBER }: { children: ReactNode; size?: number; c?: string }) {
  return <span style={{ fontSize: size, color: c, letterSpacing: 2, ...MONO, textTransform: 'uppercase', opacity: 0.85 }}>{children}</span>
}

function PortfolioGrowthPanel({ growth, onReset, btcPrice, cycles }: { growth: PortfolioGrowth | null; onReset: () => void; btcPrice: number; cycles: BtcLadderCycle[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [btcIn, setBtcIn] = useState('')
  const [usdIn, setUsdIn] = useState('')
  if (!growth) return null

  const pctColor = (p: number | null) => (p === null ? GD : p > 0 ? G : p < 0 ? CR : GD)
  const fmtPct = (p: number | null) => (p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`)
  const trimBtc = (n: number) => n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  // BTC deltas are small — render them signed to 5 dp (₿), the ammo-plate's "rounds" count.
  const fmtBtcDelta = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : '−'}₿${Math.abs(n).toFixed(5)}`)
  const since = new Date(growth.since).toLocaleDateString()

  const btn = (label: string, key: string, fn: () => Promise<void>, title: string) => (
    <button
      onClick={async () => { setBusy(key); setNote(null); try { await fn(); onReset() } finally { setBusy(null) } }}
      disabled={busy !== null}
      title={title}
      style={{ ...MONO, fontSize: 11, letterSpacing: 1.5, padding: '2px 7px', background: 'transparent', border: `0.5px solid var(--border)`, color: GD, cursor: busy ? 'default' : 'pointer' }}
    >
      {busy === key ? '…' : label}
    </button>
  )

  const doYtd = async () => {
    const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime()
    const { truncated } = await reconstructPortfolioBaseline(jan1)
    setNote(truncated ? '⚠ history truncated by Gemini — verify/edit the baseline below' : null)
  }
  const doEdit = () => { setBtcIn(trimBtc(growth.btc.baseline)); setUsdIn(growth.usd.baseline.toFixed(2)); setEditing(true) }
  const saveEdit = async () => {
    const b = Number(btcIn), u = Number(usdIn)
    if (!Number.isFinite(b) || !Number.isFinite(u) || b < 0 || u < 0) return
    setBusy('save')
    try { await setPortfolioBaseline(b, u, growth.since); onReset(); setEditing(false) } finally { setBusy(null) }
  }

  const totalBtcNow = btcPrice > 0 ? growth.total.current / btcPrice : null
  const periods = growth.periods ?? []

  // Net BTC banked by the ladder: reacquired − sold across every CLOSED round-trip (scaleouts
  // are intentional sells to USD dry powder, not round-trips, so they're excluded). This is the
  // whole point of the ladder — every completed cycle should net more BTC than it gave up.
  const ladder = cycles.reduce(
    (acc, c) => {
      if ((c.kind ?? 'roundtrip') !== 'roundtrip') return acc
      if (c.status === 'closed' && typeof c.boughtBtc === 'number') {
        acc.bankedBtc += c.boughtBtc - c.soldBtc
        acc.closed += 1
      } else if (c.status !== 'closed') acc.working += 1
      return acc
    },
    { bankedBtc: 0, closed: 0, working: 0 },
  )

  // Spec row: a labelled holding — big current value, small "from baseline" under it.
  const specRow = (label: string, current: string, baseline: string, pct: number | null) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '2px 0' }}>
      <Stencil size={11} c={GD}>{label}</Stencil>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 15, color: G, ...MONO, lineHeight: 1.15 }}>{current}</span>
        <span style={{ fontSize: 10, color: GD, ...MONO, opacity: 0.6 }}>from {baseline}</span>
      </div>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 13, color: pctColor(pct), ...MONO, fontWeight: 700 }}>{fmtPct(pct)}</span>
    </div>
  )

  return (
    <div style={{ border: `0.5px solid var(--border)`, borderTop: `2px solid ${AMBER}`, padding: '8px 11px' }}>
      {/* Spec-plate header: stencilled title + lot number (since date) + baseline controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, paddingBottom: 5, borderBottom: `0.5px solid var(--border)` }}>
        <Stencil size={12} c={AMBER}>◈ Growth Through Trading</Stencil>
        <Stencil size={10} c={GD}>lot · {since}</Stencil>
        <div style={{ flex: 1 }} />
        {btn('YTD', 'ytd', doYtd, 'Anchor to Jan 1 this year (reconstructed from trade + transfer history)')}
        {btn('NOW', 'now', async () => { await resetPortfolioBaseline() }, 'Reset baseline to current balances')}
        {btn('EDIT', 'edit-open', async () => { doEdit() }, 'Manually set the baseline BTC/USD')}
      </div>

      {/* Hero: total account value stamped in USD, with the BTC-denominated total beneath it */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Stencil size={10} c={GD}>Total Value</Stencil>
          <span style={{ fontSize: 30, color: G, ...MONO, fontWeight: 700, lineHeight: 1.05, letterSpacing: 0.5 }}>
            ${fmtNum(growth.total.current, 2)}
          </span>
          {totalBtcNow !== null && (
            <span style={{ fontSize: 15, color: AMBER, ...MONO, opacity: 0.85 }}>₿{totalBtcNow.toFixed(6)}</span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 20, color: pctColor(growth.total.pctChange), ...MONO, fontWeight: 700 }}>
          {fmtPct(growth.total.pctChange)}
        </span>
      </div>

      {/* Change stamps: total-value change over each look-back window, in USD and BTC */}
      {periods.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${periods.length}, 1fr)`, gap: 0, marginBottom: 8, border: `0.5px solid var(--border)` }}>
          {periods.map((p, i) => (
            <div key={p.key} title={p.partial ? `partial — measured from ${new Date(p.startedAt).toLocaleString()} (history doesn't reach the full window yet)` : `since ${new Date(p.startedAt).toLocaleString()}`}
              style={{ padding: '4px 6px', borderLeft: i === 0 ? 'none' : `0.5px solid var(--border)`, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Stencil size={10} c={GD}>{p.label}{p.partial ? '*' : ''}</Stencil>
              <span style={{ fontSize: 13, color: pctColor(p.usdPct), ...MONO, fontWeight: 700 }}>
                {p.usdChange === null ? '—' : fmtSignedUsd(p.usdChange, 0)}
              </span>
              <span style={{ fontSize: 10, color: pctColor(p.btcPct), ...MONO, opacity: 0.8 }}>
                {fmtBtcDelta(p.btcChange)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Spec rows: what's actually held */}
      <div style={{ borderTop: `0.5px solid var(--border)`, paddingTop: 4 }}>
        {specRow('BTC', `${trimBtc(growth.btc.current)} ₿`, `${trimBtc(growth.btc.baseline)} ₿`, growth.btc.pctChange)}
        {specRow('USD', `$${fmtNum(growth.usd.current, 2)}`, `$${fmtNum(growth.usd.baseline, 2)}`, growth.usd.pctChange)}
      </div>

      {/* Separate readout: net BTC banked by the ladder's completed round-trips */}
      <div style={{ marginTop: 8, border: `0.5px solid var(--border)`, borderLeft: `2px solid ${AMBER}`, padding: '5px 9px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Stencil size={10} c={AMBER}>◇ Ladder · BTC Banked</Stencil>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 16, color: ladder.bankedBtc >= 0 ? G : CR, ...MONO, fontWeight: 700 }}>
          {ladder.bankedBtc >= 0 ? '+' : '−'}₿{trimBtc(Math.abs(ladder.bankedBtc)) || '0'}
        </span>
        <Stencil size={10} c={GD}>{ladder.closed} closed · {ladder.working} working</Stencil>
      </div>

      {note && <div style={{ fontSize: 11, color: AMBER, ...MONO, marginTop: 5 }}>{note}</div>}
      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <Stencil size={11} c={GD}>BTC</Stencil>
          <input value={btcIn} onChange={(e) => setBtcIn(e.target.value)} inputMode="decimal" style={{ ...MONO, fontSize: 13, width: 90, background: 'transparent', border: BORDER, color: G, padding: '2px 5px', outline: 'none' }} />
          <Stencil size={11} c={GD}>USD</Stencil>
          <input value={usdIn} onChange={(e) => setUsdIn(e.target.value)} inputMode="decimal" style={{ ...MONO, fontSize: 13, width: 70, background: 'transparent', border: BORDER, color: G, padding: '2px 5px', outline: 'none' }} />
          <button onClick={saveEdit} disabled={busy !== null} style={{ ...MONO, fontSize: 12, letterSpacing: 1, padding: '2px 8px', background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer' }}>SAVE</button>
          <button onClick={() => setEditing(false)} style={{ ...MONO, fontSize: 12, letterSpacing: 1, padding: '2px 8px', background: 'transparent', border: BORDER, color: GD, cursor: 'pointer' }}>CANCEL</button>
        </div>
      )}
    </div>
  )
}


// Surfaces the BTC ladder invariant check: any sell that currently lacks a resting buy-back
// below it. The server auto-stages a confirm-first buy-back for each; this makes the gap
// impossible to miss and points at the pending proposal to approve.
// Opt-in autonomy control. When ON, staged plans whose every trade is ≤ the cap confirm and
// execute WITHOUT manual approval. Deliberately loud styling — this bypasses confirm-first.
function AutoExecutePanel({ config, onChanged }: { config: AutoExecuteConfig; onChanged: () => void }) {
  const [btcCap, setBtcCap] = useState(String(config.btcLadderMaxUsd))
  const [altCap, setAltCap] = useState(String(config.altMaxUsd))
  const [busy, setBusy] = useState(false)
  // Keep the cap fields in sync when the server pushes a new value (another client, reload).
  useEffect(() => { setBtcCap(String(config.btcLadderMaxUsd)) }, [config.btcLadderMaxUsd])
  useEffect(() => { setAltCap(String(config.altMaxUsd)) }, [config.altMaxUsd])

  const on = config.enabled
  const toggle = async () => {
    setBusy(true)
    try { await setAutoExecute({ enabled: !on }); onChanged() } finally { setBusy(false) }
  }
  const commitCap = (key: 'btcLadderMaxUsd' | 'altMaxUsd', raw: string, current: number, reset: (s: string) => void) => async () => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) { reset(String(current)); return }
    if (n === current) return
    setBusy(true)
    try { await setAutoExecute({ [key]: n }); onChanged() } finally { setBusy(false) }
  }

  const accent = on ? '#c8a227' : GD
  const capField = (label: string, val: string, setVal: (s: string) => void, commit: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13, color: GD, ...MONO, letterSpacing: 1 }}>{label} $</span>
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        inputMode="decimal"
        style={{ ...MONO, fontSize: 14, width: 60, background: 'transparent', border: BORDER, color: G, padding: '3px 6px', outline: 'none' }}
      />
    </div>
  )
  return (
    <div style={{ border: `0.5px solid ${on ? '#c8a227' : 'var(--border)'}`, background: on ? 'rgba(200,162,39,0.06)' : 'transparent', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <button
        onClick={toggle}
        disabled={busy}
        title={on ? 'Auto-execute is ON — staged plans within their category cap execute without approval' : 'Turn on to let within-cap plans execute without manual approval'}
        style={{ ...MONO, fontSize: 14, letterSpacing: 1, padding: '5px 14px', cursor: busy ? 'default' : 'pointer', background: on ? '#c8a227' : 'transparent', border: `0.5px solid ${accent}`, color: on ? '#000' : GD, fontWeight: 700 }}
      >
        {on ? '⚡ AUTO-EXECUTE: ON' : '○ AUTO-EXECUTE: OFF'}
      </button>
      {capField('BTC LADDER', btcCap, setBtcCap, commitCap('btcLadderMaxUsd', btcCap, config.btcLadderMaxUsd, setBtcCap))}
      {capField('ALT', altCap, setAltCap, commitCap('altMaxUsd', altCap, config.altMaxUsd, setAltCap))}
      <span style={{ fontSize: 12, color: GD, ...MONO, opacity: 0.85, flex: 1, minWidth: 220 }}>
        {on
          ? `BTC ladder trades ≤ $${config.btcLadderMaxUsd} and alt trades ≤ $${config.altMaxUsd} confirm automatically. Anything larger stays staged for you.`
          : 'Confirm-first: every plan waits for your approval.'}
      </span>
    </div>
  )
}

// Starter field template offered by the "+ NEW STRATEGY" form — the common vocabulary
// shared across the 5 hand-authored strategies (size, target, floor, spread cap,
// time-stop, concurrency). the operator can edit/remove/add to these before creating.
const NEW_STRATEGY_FIELD_TEMPLATE: NewStrategyField[] = [
  { key: 'sizeUsd', label: 'Position/bid size', min: 1, max: 200, step: 1, unit: '$', default: 10 },
  { key: 'tpPct', label: 'Take-profit target', min: 0.5, max: 20, step: 0.5, unit: '%', default: 3 },
  { key: 'scoreFloor', label: 'Score/RSI floor', min: 0, max: 100, step: 1, unit: '', default: 50 },
  { key: 'spreadCapPct', label: 'Spread cap', min: 0.1, max: 5, step: 0.1, unit: '%', default: 1.5 },
  { key: 'positionTimeStopMin', label: 'Position time-stop', min: 5, max: 20160, step: 5, unit: 'min', default: 60 },
  { key: 'maxConcurrent', label: 'Concurrency cap', min: 1, max: 10, step: 1, unit: '', default: 3 }
]

// "+ NEW STRATEGY" — captures the starting shape (name, thesis notes, tunable settings)
// for a brand-new strategy. Creating it here only persists a settings definition; the
// actual trading logic doc (.claude/commands/<id>.md) is authored afterward by running
// the /new-strategy skill in Claude Code, which reads this definition as its brief.
function NewStrategyForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [fields, setFields] = useState<NewStrategyField[]>(NEW_STRATEGY_FIELD_TEMPLATE.map((f) => ({ ...f })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const slug = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || '—'

  const updateField = (i: number, patch: Partial<NewStrategyField>) => {
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  }
  const removeField = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i))
  const addField = () => setFields((fs) => [...fs, { key: `field${fs.length + 1}`, label: 'New field', min: 0, max: 100, step: 1, unit: '', default: 0 }])

  const submit = async () => {
    if (!label.trim()) { setErr('Name is required'); return }
    if (fields.some((f) => !f.key.trim())) { setErr('Every field needs a key'); return }
    setBusy(true)
    setErr(null)
    try {
      await createStrategy({ label, description, fields })
      onCreated()
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const inp = { ...MONO, fontSize: 13, background: 'transparent', border: BORDER, color: G, padding: '4px 7px', outline: 'none' }

  return (
    <div style={{ border: `0.5px solid ${G}`, background: 'rgba(0,255,140,0.03)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 14, letterSpacing: 1.5, color: G, ...MONO, fontWeight: 700 }}>+ NEW STRATEGY</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Lbl size={12}>NAME</Lbl>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. VWAP Reversion" style={{ ...inp, width: 220 }} />
        <Lbl size={11} c={GD}>id: {slug}</Lbl>
      </div>
      <div>
        <Lbl size={12}>THESIS / NOTES — what it trades and why (read by the /new-strategy skill)</Lbl>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Mean-reversion off VWAP on the 15m chart when volume confirms..."
          rows={3}
          style={{ ...inp, width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: 3, fontFamily: 'var(--font-mono)' }}
        />
      </div>
      <div>
        <Lbl size={12}>STARTING SETTINGS — the tunable knobs this strategy will read at runtime</Lbl>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
          {fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="label" style={{ ...inp, width: 150 }} />
              <input value={f.key} onChange={(e) => updateField(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })} placeholder="key" style={{ ...inp, width: 100, color: GD }} />
              <input type="number" value={f.default} onChange={(e) => updateField(i, { default: Number(e.target.value) })} placeholder="default" style={{ ...inp, width: 60 }} />
              <input value={f.unit} onChange={(e) => updateField(i, { unit: e.target.value })} placeholder="unit" style={{ ...inp, width: 40 }} />
              <input type="number" value={f.min} onChange={(e) => updateField(i, { min: Number(e.target.value) })} placeholder="min" style={{ ...inp, width: 50 }} />
              <input type="number" value={f.max} onChange={(e) => updateField(i, { max: Number(e.target.value) })} placeholder="max" style={{ ...inp, width: 50 }} />
              <input type="number" value={f.step} onChange={(e) => updateField(i, { step: Number(e.target.value) })} placeholder="step" style={{ ...inp, width: 50 }} />
              <button onClick={() => removeField(i)} style={{ ...MONO, fontSize: 11, padding: '3px 8px', background: 'transparent', border: BORDER, color: CR, cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          <button onClick={addField} style={{ ...MONO, fontSize: 11, letterSpacing: 1, padding: '3px 10px', background: 'transparent', border: BORDER, color: GD, cursor: 'pointer', alignSelf: 'flex-start' }}>+ ADD FIELD</button>
        </div>
      </div>
      {err && <div style={{ fontSize: 12, color: CR, ...MONO }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy} style={{ ...MONO, fontSize: 13, letterSpacing: 1, padding: '5px 14px', background: G, border: `0.5px solid ${G}`, color: '#000', fontWeight: 700, cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'CREATING…' : 'CREATE DRAFT'}
        </button>
        <button onClick={onCancel} disabled={busy} style={{ ...MONO, fontSize: 13, padding: '5px 12px', background: 'transparent', border: BORDER, color: GD, cursor: 'pointer' }}>CANCEL</button>
      </div>
    </div>
  )
}

// Admin/control panel: per-strategy tunable knobs (bid size, TP%, RSI/score floors,
// spread caps, concurrency/exposure caps). Each strategy skill reads these live at the
// start of its run (see .claude/commands/<id>.md Step 0) instead of using hardcoded
// constants, so editing a field here retunes the next run without touching prompt text.
// Strategies are dynamic — new ones show up here as soon as they're created via
// "+ NEW STRATEGY", before the /new-strategy skill has authored their actual doc.
// Render order for settings sub-headings, roughly the order a trade moves through: how big,
// what has to be true to take it, where to get in, where to get out, how it's scored, what's
// recorded. Groups not listed here sort alphabetically after these.
const GROUP_ORDER = ['GENERAL', 'SIZING', 'GATES', 'DYNAMIC', 'SCALE-OUT', 'TIERS', 'ENTRY', 'EXITS', 'SCORING', 'LEDGER']

function groupFields(fields: StrategySettingsField[]): [string, StrategySettingsField[]][] {
  const byGroup = new Map<string, StrategySettingsField[]>()
  for (const f of fields) {
    const g = f.group || 'GENERAL'
    const list = byGroup.get(g)
    if (list) list.push(f)
    else byGroup.set(g, [f])
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g)
    return i === -1 ? GROUP_ORDER.length : i
  }
  return Array.from(byGroup.entries())
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
}

function StrategyAdminPanel() {
  const [definitions, setDefinitions] = useState<StrategyDefinition[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [intervals, setIntervals] = useState<Record<string, number>>({})
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({})
  const [autoExec, setAutoExec] = useState<AutoExecuteConfig | null>(null)
  const dispatchableIds = new Set(STRATEGY_OPTIONS.map((o) => o.id as string))

  const load = useCallback(() => {
    fetchStrategyDefinitions().then(setDefinitions).catch((e) => setErr(String(e?.message || e)))
    fetchStrategyIntervals().then(setIntervals).catch(() => {})
    fetchAutoExecute().then(setAutoExec).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  // A refetch must never land on top of a write we just sent — the POST response is the
  // authority on the new value, and clobbering it would flicker the field back.
  const busyRef = useRef<string | null>(null)
  useEffect(() => { busyRef.current = busy }, [busy])

  // The settings SCHEMA can change under a live page: a field added to SEED server-side reaches
  // an existing install through reconcileWithSeed, but this panel fetched its copy once on mount
  // and would keep rendering the old field list (and a stale "N settings" count) until someone
  // manually reloaded. Refetch whenever the page is looked at again — that is the moment the
  // stale count is actually read.
  useEffect(() => {
    const refresh = () => {
      if (busyRef.current || document.visibilityState !== 'visible') return
      load()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  /** A strategy auto-executes only if the master switch is on AND its own flag isn't false. */
  const autoOn = (id: string) => !!autoExec?.enabled && autoExec.perStrategy[id] !== false

  const toggleAuto = (id: string) => async () => {
    if (!autoExec) return
    setBusy(id)
    setErr(null)
    try {
      // Send the explicit boolean rather than a delete, so "on" is recorded as opted-in
      // rather than merely absent — the two read the same today but the intent differs.
      const next = await setAutoExecute({ perStrategy: { [id]: autoExec.perStrategy[id] === false } })
      setAutoExec(next)
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setBusy(null)
    }
  }

  const commitInterval = (id: string) => async () => {
    const raw = intervalDrafts[id]
    const parsed = Math.round(Number(raw))
    const want = raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    setBusy(id)
    try {
      const next = await setStrategyIntervalFor(id as StrategyId, want)
      setIntervals(next)
      setIntervalDrafts((d) => ({ ...d, [id]: next[id] ? String(next[id]) : '' }))
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setBusy(null)
    }
  }

  const draftKey = (id: string, key: string) => `${id}.${key}`

  const commit = (id: string, key: string, currentVal: number, min: number, max: number) => async () => {
    const raw = drafts[draftKey(id, key)]
    const n = Number(raw)
    if (raw === undefined || !Number.isFinite(n)) {
      setDrafts((d) => ({ ...d, [draftKey(id, key)]: String(currentVal) }))
      return
    }
    const clamped = Math.min(max, Math.max(min, n))
    if (clamped === currentVal) {
      setDrafts((d) => ({ ...d, [draftKey(id, key)]: String(currentVal) }))
      return
    }
    setBusy(id)
    setErr(null)
    try {
      const values = await setStrategySettings(id, { [key]: clamped })
      setDefinitions((defs) => defs && defs.map((d) => (d.id === id ? { ...d, values } : d)))
      setDrafts((d) => ({ ...d, [draftKey(id, key)]: String(clamped) }))
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setBusy(null)
    }
  }

  // Toggles commit on click rather than on blur — there's no intermediate text state to hold,
  // so they bypass `drafts` entirely.
  const toggleOne = (id: string, key: string, currentVal: number) => async () => {
    setBusy(id)
    setErr(null)
    try {
      const values = await setStrategySettings(id, { [key]: currentVal ? 0 : 1 })
      setDefinitions((defs) => defs && defs.map((d) => (d.id === id ? { ...d, values } : d)))
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setBusy(null)
    }
  }

  const resetOne = (id: string) => async () => {
    setBusy(id)
    setErr(null)
    try {
      const values = await resetStrategySettings(id)
      setDefinitions((defs) => defs && defs.map((d) => (d.id === id ? { ...d, values } : d)))
      setDrafts((d) => {
        const next = { ...d }
        for (const k of Object.keys(values)) delete next[draftKey(id, k)]
        return next
      })
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ border: BORDER, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, letterSpacing: 1.5, color: GD, ...MONO, fontWeight: 700 }}>⚙ ADMIN — STRATEGY SETTINGS</span>
        <span style={{ fontSize: 12, color: GD, ...MONO, opacity: 0.75, flex: 1, minWidth: 220 }}>
          Bid size, TP%, RSI/score floors, spread + exposure caps — read live by each strategy at the start of its run.
        </span>
        {!showNewForm && (
          <button onClick={() => setShowNewForm(true)} style={{ ...MONO, fontSize: 12, letterSpacing: 1, padding: '4px 10px', background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer', fontWeight: 700 }}>
            + NEW STRATEGY
          </button>
        )}
      </div>
      {showNewForm && (
        <NewStrategyForm
          onCreated={() => { setShowNewForm(false); load() }}
          onCancel={() => setShowNewForm(false)}
        />
      )}
      {err && <div style={{ fontSize: 12, color: CR, ...MONO }}>{err}</div>}
      {!definitions ? (
        <Lbl>loading strategy settings…</Lbl>
      ) : definitions.map((def) => {
        const isOpen = open === def.id
        const isGlobal = def.id === GLOBAL_STRATEGY_ID
        const dispatchable = dispatchableIds.has(def.id)
        const everyMin = intervals[def.id] ?? 0
        const auto = autoOn(def.id)
        // "Live" = this strategy can actually act on its own: it's wired into the RUN button
        // AND has a timer scheduled. Anything else — a draft with no trading logic, or a
        // strategy sitting at interval OFF — is inert, and greys out to say so. The
        // shared-assumptions bucket is never "live"; it has nothing to run.
        const live = dispatchable && everyMin > 0
        const dim = !isGlobal && !live
        return (
          <div key={def.id} style={{ border: '0.5px solid var(--border)', opacity: dim && !isOpen ? 0.45 : 1 }}>
            <button
              // Expanding is the other moment a stale schema shows: pull fresh field defs so the
              // drilled-in view can't be older than the row that opened it.
              onClick={() => {
                const next = isOpen ? null : def.id
                setOpen(next)
                if (next && !busy) load()
              }}
              style={{ ...MONO, fontSize: 13, letterSpacing: 1, width: '100%', textAlign: 'left', padding: '6px 10px', background: isOpen ? 'var(--bg-elev)' : 'transparent', border: 'none', color: dim ? GD : G, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <span style={{ flex: 1, minWidth: 120 }}>
                {isOpen ? '▾' : '▸'} {def.label}
                {!def.builtin && <span style={{ color: GD, marginLeft: 6, fontSize: 10 }}>DRAFT</span>}
              </span>
              {/* Collapsed-row status: schedule + autonomy, so the whole board reads at a
                  glance without expanding anything. _global has neither. */}
              {!isGlobal && (
                <>
                  <span
                    title={everyMin > 0 ? `Runs automatically every ${everyMin} minutes` : 'No timer — only runs when you press RUN'}
                    style={{ fontSize: 11, color: everyMin > 0 ? G : GD, opacity: everyMin > 0 ? 1 : 0.7, letterSpacing: 0.5 }}
                  >
                    ⏱ {everyMin > 0 ? `${everyMin}m` : 'OFF'}
                  </span>
                  <span
                    title={
                      !dispatchable ? 'Not wired into the RUN button yet'
                        : auto ? 'Auto-execute ON — trades within cap send without asking'
                        : autoExec && !autoExec.enabled ? 'Master auto-execute is OFF — every trade waits for your approval'
                        : 'Auto-execute OFF for this strategy — its trades wait for your approval'
                    }
                    style={{ fontSize: 11, color: auto ? HOT_C : GD, opacity: auto ? 1 : 0.7, letterSpacing: 0.5, minWidth: 62, textAlign: 'right' }}
                  >
                    {auto ? '🤖 AUTO' : '✋ MANUAL'}
                  </span>
                </>
              )}
              <span style={{ color: GD, fontSize: 11, minWidth: 68, textAlign: 'right' }}>{def.fields.length} settings</span>
            </button>
            {isOpen && (
              <div style={{ padding: '6px 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {def.description && <Lbl size={12} c={GD}>{def.description}</Lbl>}
                {!def.builtin && (
                  <Lbl size={11} c={G}>Run /new-strategy in Claude Code to finish building this strategy's trading logic.</Lbl>
                )}
                {/* _global is a shared-assumptions bucket, not a strategy — it has nothing to
                    schedule and no /new-strategy path, so it gets neither control. */}
                {def.id === GLOBAL_STRATEGY_ID ? null : dispatchableIds.has(def.id) ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '0.5px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                    <span style={{ fontSize: 12, color: intervals[def.id] ? G : GD, ...MONO, flex: 1, minWidth: 180 }}>⏱ Individual interval</span>
                    <input
                      value={intervalDrafts[def.id] ?? (intervals[def.id] ? String(intervals[def.id]) : '')}
                      onChange={(e) => setIntervalDrafts((d) => ({ ...d, [def.id]: e.target.value }))}
                      onBlur={commitInterval(def.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      disabled={busy === def.id}
                      placeholder="off"
                      inputMode="numeric"
                      style={{ ...MONO, fontSize: 13, width: 70, background: 'transparent', border: BORDER, color: intervals[def.id] ? G : GD, padding: '3px 6px', outline: 'none' }}
                    />
                    <span style={{ fontSize: 12, color: GD, ...MONO, width: 24 }}>min</span>
                    <span style={{ fontSize: 10, color: GD, ...MONO, opacity: 0.6 }}>[1–1440]</span>
                  </div>
                ) : (
                  <Lbl size={11} c={GD}>Run /new-strategy to wire this into the RUN button before scheduling it.</Lbl>
                )}
                {/* Per-strategy autonomy. Gated on the master switch in SETTINGS above:
                    with that off, this toggle still records your intent but nothing sends. */}
                {!isGlobal && dispatchable && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: auto ? HOT_C : GD, ...MONO, flex: 1, minWidth: 180 }}>
                      🤖 Auto-execute this strategy
                    </span>
                    <button
                      onClick={toggleAuto(def.id)}
                      disabled={busy === def.id || !autoExec}
                      title={
                        autoExec && !autoExec.enabled
                          ? 'Master auto-execute is OFF in SETTINGS — nothing sends until you turn it on'
                          : 'Trades staged by this strategy send automatically when within the per-trade cap'
                      }
                      style={{ ...MONO, fontSize: 12, width: 70, background: 'transparent', border: BORDER, color: autoExec?.perStrategy[def.id] === false ? GD : HOT_C, padding: '3px 6px', cursor: busy === def.id ? 'default' : 'pointer', letterSpacing: 1 }}
                    >
                      {autoExec?.perStrategy[def.id] === false ? 'OFF' : 'ON'}
                    </button>
                    <span style={{ fontSize: 12, color: GD, ...MONO, width: 24 }} />
                    <span style={{ fontSize: 10, color: GD, ...MONO, opacity: 0.6 }}>
                      {autoExec && !autoExec.enabled ? 'master OFF' : ''}
                    </span>
                  </div>
                )}
                {groupFields(def.fields).map(([group, fields]) => (
                  <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ ...MONO, fontSize: 10, letterSpacing: 1.5, color: GD, opacity: 0.7, borderBottom: '0.5px solid var(--border)', paddingBottom: 2, marginTop: 4 }}>
                      {group}
                    </div>
                    {fields.map((f) => {
                      const key = draftKey(def.id, f.key)
                      const val = drafts[key] ?? String(def.values[f.key] ?? '')
                      const on = !!def.values[f.key]
                      return (
                        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, color: GD, ...MONO, flex: 1, minWidth: 180 }}>{f.label}</span>
                          {f.type === 'toggle' ? (
                            <button
                              onClick={toggleOne(def.id, f.key, def.values[f.key])}
                              disabled={busy === def.id}
                              style={{ ...MONO, fontSize: 12, width: 70, background: 'transparent', border: BORDER, color: on ? G : GD, padding: '3px 6px', cursor: busy === def.id ? 'default' : 'pointer', letterSpacing: 1 }}
                            >
                              {on ? 'ON' : 'OFF'}
                            </button>
                          ) : (
                            <input
                              value={val}
                              onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                              onBlur={commit(def.id, f.key, def.values[f.key], f.min, f.max)}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                              disabled={busy === def.id}
                              inputMode="decimal"
                              style={{ ...MONO, fontSize: 13, width: 70, background: 'transparent', border: BORDER, color: G, padding: '3px 6px', outline: 'none' }}
                            />
                          )}
                          <span style={{ fontSize: 12, color: GD, ...MONO, width: 24 }}>{f.unit}</span>
                          <span style={{ fontSize: 10, color: GD, ...MONO, opacity: 0.6 }}>
                            {f.type === 'toggle' ? '' : `[${f.min}–${f.max}]`}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
                <button
                  onClick={resetOne(def.id)}
                  disabled={busy === def.id}
                  style={{ ...MONO, fontSize: 11, letterSpacing: 1, padding: '3px 10px', background: 'transparent', border: BORDER, color: GD, cursor: busy === def.id ? 'default' : 'pointer', alignSelf: 'flex-start', marginTop: 2 }}
                >
                  RESET TO DEFAULTS
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// SETTINGS section: the auto-execute autonomy toggle + per-strategy admin panel. Owns its
// own auto-execute fetch since it's independent of the snapshot poll driving the rest of
// the tab.
function SettingsSection() {
  const [autoExecute, setAutoExecuteState] = useState<AutoExecuteConfig | null>(null)
  const reloadAutoExecute = useCallback(() => {
    fetchAutoExecute().then(setAutoExecuteState).catch(() => {})
  }, [])
  useEffect(() => { reloadAutoExecute() }, [reloadAutoExecute])

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      <SectionHead title="SETTINGS" sub="Admin/control — auto-execute autonomy + per-strategy tunable knobs" />
      {autoExecute
        ? <AutoExecutePanel config={autoExecute} onChanged={reloadAutoExecute} />
        : <div style={{ border: BORDER, padding: '8px 12px' }}><Lbl>loading auto-execute config…</Lbl></div>}
      <StrategyAdminPanel />
    </div>
  )
}

// ── AUDIT ────────────────────────────────────────────────────────────────
// A read-only window onto data/audit/audit-YYYY-MM.jsonl. Nothing here can edit
// the record — the server exposes no route that would, and amending it at all
// takes the admin token from a shell. This view exists so the chain can be read
// and checked from the app, not so it can be managed from it.

const ACTOR_COLORS: Record<string, string> = { operator: G, system: '#c9a227' }

function actorColor(actor: string): string {
  if (ACTOR_COLORS[actor]) return ACTOR_COLORS[actor]!
  return actor.startsWith('agent:') ? '#4aa3df' : '#b06fd0'
}

const AUDIT_FILTERS: { label: string; actor?: string }[] = [
  { label: 'ALL' },
  { label: 'OPERATOR', actor: 'operator' },
  { label: 'SYSTEM', actor: 'system' },
]

function AuditSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [actor, setActor] = useState<string | undefined>(undefined)
  const [chain, setChain] = useState<AuditVerifyResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchAuditEntries({ ...(actor ? { actor } : {}), limit: 200 })
      .then((r) => { setEntries(r.entries); setError(null) })
      .catch((e) => setError((e as Error).message))
  }, [actor])
  useEffect(() => { load() }, [load])

  const check = useCallback(() => {
    setChecking(true)
    verifyAuditChain().then(setChain).catch((e) => setError((e as Error).message)).finally(() => setChecking(false))
  }, [])
  useEffect(() => { check() }, [check])

  // Agents and skills each get their own filter chip, discovered from what has
  // actually been recorded rather than from a hardcoded roster.
  const dynamicActors = [...new Set(entries.map((e) => e.actor))]
    .filter((a) => a !== 'operator' && a !== 'system')
    .sort()

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden', height: '100%' }}>
      <SectionHead title="AUDIT" sub="Append-only, hash-chained record of every change — read-only" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {[...AUDIT_FILTERS, ...dynamicActors.map((a) => ({ label: a.toUpperCase(), actor: a }))].map((f) => (
          <button key={f.label} onClick={() => setActor(f.actor)} style={{
            ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 9px', cursor: 'pointer',
            background: actor === f.actor ? 'var(--bg-elev)' : 'transparent',
            border: BORDER, color: actor === f.actor ? 'var(--green-soft)' : GD,
          }}>{f.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => { load(); check() }} disabled={checking} style={{
          ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 9px', cursor: 'pointer',
          background: 'transparent', border: BORDER, color: GD,
        }}>{checking ? '…' : '↻ VERIFY CHAIN'}</button>
      </div>

      {chain && (
        <div style={{
          border: `0.5px solid ${chain.ok ? G : CR}`,
          background: chain.ok ? 'transparent' : 'rgba(200,40,40,0.06)',
          padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <Lbl c={chain.ok ? G : CR} size={13}>
            {chain.ok
              ? `✓ CHAIN INTACT — ${chain.entries} entries verified across ${chain.files.length} file(s)`
              : chain.brokenAt
                ? `⚠ CHAIN BROKEN AT SEQ ${chain.brokenAt} — ${chain.reason}`
                : `⚠ ${chain.db?.reason ?? chain.reason ?? 'verification failed'}`}
          </Lbl>
          {/* The database copy is checked against the file independently — a row
              edited behind the triggers shows up here and nowhere else. */}
          <Lbl c={chain.db ? (chain.db.ok ? GD : CR) : GD} size={12}>
            {!chain.db
              ? 'postgres: not connected — file-only (set DATABASE_URL to mirror the record)'
              : chain.db.ok
                ? `postgres: ${chain.db.rows} rows match the file` +
                  (chain.db.missing ? ` · ${chain.db.missing} queued` : '')
                : `postgres: DIVERGED — ${chain.db.reason}`}
          </Lbl>
        </div>
      )}

      {error && <div style={{ border: `0.5px solid ${CR}`, padding: '6px 12px' }}><Lbl c={CR} size={13}>{error}</Lbl></div>}

      <div style={{ border: BORDER, overflow: 'auto', flex: 1, minHeight: 0 }}>
        {entries.length === 0 ? (
          <div style={{ padding: '10px 12px' }}><Lbl>no entries recorded yet</Lbl></div>
        ) : entries.map((e) => (
          <div key={e.seq} style={{ display: 'grid', gridTemplateColumns: '54px 128px 116px 1fr', gap: 10, padding: '5px 12px', borderBottom: BORDER, alignItems: 'baseline' }}>
            <Lbl size={12}>#{e.seq}</Lbl>
            <Lbl size={12}>{e.ts.replace('T', ' ').slice(0, 19)}</Lbl>
            <Lbl c={actorColor(e.actor)} size={12}>{e.actor}</Lbl>
            <span>
              <Val size={13}>{e.summary}</Val>
              <Lbl size={11}> · {e.action}</Lbl>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function BtcLadderAlertBanner({ alerts }: { alerts: BtcLadderAlert[] }) {
  if (!alerts || alerts.length === 0) return null
  return (
    <div style={{ border: `0.5px solid ${CR}`, background: 'rgba(200,40,40,0.06)', padding: '8px 12px' }}>
      <div style={{ fontSize: 14, color: CR, letterSpacing: 1.5, ...MONO, fontWeight: 700, marginBottom: 4 }}>
        ⚠ BTC LADDER — {alerts.length} UNHEDGED SELL{alerts.length > 1 ? 'S' : ''}
      </div>
      {alerts.map((a) => (
        <div key={a.cycleId} style={{ fontSize: 13, color: GD, ...MONO, paddingLeft: 4 }}>
          {a.status === 'staged'
            ? '↳ buy-back staged — approve it in the queue below'
            : a.status === 'open'
            ? '↳ no buy-back resting'
            : `↳ ${a.status}`}
          {' · '}{a.message}
        </div>
      ))}
      <div style={{ fontSize: 12, color: GD, ...MONO, paddingLeft: 4, marginTop: 3, opacity: 0.8 }}>
        Every BTC sell must have a resting buy-back below it. A confirm-first rebuy is staged automatically — nothing sends until you approve.
      </div>
    </div>
  )
}

function TradesSection({ pending, openOrders, safeMode, trades, geminiTrades, autoPlans, planReport, planReportAt, planReports, btcLadderAlerts, btcLadderCycles, onExecute, onDismiss, onStaged, onCancelOrder, onClosePosition, onModifyOrder, onSafeMode, tickers, signals, onConfirmPlan, onPatchStep, onLockToggle }: {
  pending: PendingTrade[]; openOrders: GeminiOpenOrder[]; safeMode: SafeModeArm[]; trades: TradeRecord[]; geminiTrades: GeminiTrade[]
  autoPlans: AutoPlanStatus[]; planReport: string; planReportAt: number | null; planReports: PlanReportEntry[]; btcLadderAlerts: BtcLadderAlert[]
  btcLadderCycles: BtcLadderCycle[]
  onExecute: (id: string) => void; onDismiss: (id: string) => void
  onStaged: () => void; onCancelOrder: (orderId: string) => Promise<void>
  onClosePosition: (orderId: string) => Promise<void>
  onModifyOrder: (orderId: string, patch: { price?: string; amount?: string; stopPrice?: string }) => Promise<{ ok: boolean; error?: string }>
  onSafeMode: (orderId: string, opts:
    | { enabled: boolean; stopPct?: number; exitPct?: number }
    | { adjust: true; stopPct?: number; exitPct?: number; triggerPrice?: number }
  ) => Promise<void>
  tickers: Ticker[]
  signals: Signal[]
  onConfirmPlan: (planSymbol: string) => void
  onPatchStep: (stepId: string, patch: { limitPrice?: string; stopPrice?: string; amountSpec?: string; tp1Price?: string }, planSymbol: string) => Promise<void>
  onLockToggle: (symbol: string, locked: boolean) => Promise<void>
}) {
  const [symbol, setSymbol] = useState('BTCUSD')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [type, setType] = useState<'market' | 'limit' | 'stop-limit'>('market')
  const [amount, setAmount] = useState('')
  const [price, setPrice] = useState('')
  const [stopPrice, setStopPrice] = useState('')
  const [orderOption, setOrderOption] = useState<'' | 'maker-or-cancel' | 'immediate-or-cancel' | 'fill-or-kill'>('')
  const [reason, setReason] = useState('')
  const [staging, setStaging] = useState(false)
  const [stageErr, setStageErr] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  // Which active-trade circular widget is expanded to its full management card.
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null)

  const ticker = tickers.find((t) => t.symbol === symbol.toUpperCase())
  const estimatedUsd = ticker && amount ? (Number(amount) * Number(ticker.last)).toFixed(2) : null

  // Only surface this year's activity — drop pre-2026 fills and audit records.
  const geminiTrades2026 = geminiTrades.filter((t) => t.timestampMs >= TRADE_HISTORY_SINCE_MS)
  const trades2026 = trades.filter((t) => t.settledAt >= TRADE_HISTORY_SINCE_MS)

  const handleStage = async () => {
    if (!amount || !reason) { setStageErr('Amount and reason required'); return }
    if (type === 'stop-limit' && (!price || !stopPrice)) { setStageErr('Stop-limit requires both limit price and stop trigger price'); return }
    setStaging(true); setStageErr(null)
    const result = await stageTrade({
      symbol: symbol.toUpperCase(), side, type, amount,
      price: type !== 'market' ? price : undefined,
      stopPrice: type === 'stop-limit' ? stopPrice : undefined,
      orderOptions: orderOption ? [orderOption] : undefined,
      reason,
    })
    setStaging(false)
    if (result.ok) {
      setAmount(''); setPrice(''); setStopPrice(''); setOrderOption(''); setReason(''); setShowForm(false)
      onStaged()
    } else {
      setStageErr(result.error ?? 'Stage failed')
    }
  }

  const inp = {
    background: 'transparent', border: BORDER, color: G,
    fontSize: 14, padding: '4px 7px', outline: 'none',
    fontFamily: 'var(--font-mono)', width: '100%', boxSizing: 'border-box' as const,
  }
  const sel = { ...inp, cursor: 'pointer' }

  const needsPrice = type === 'limit' || type === 'stop-limit'
  const needsStop = type === 'stop-limit'

  // Map each managed bracket's protective-stop Gemini order ID → its take-profit prices,
  // so the OPEN ON EXCHANGE card for that stop can also show the upside (P&L at target),
  // not just the downside (P&L if stopped). Keyed by stopId since that's the order that
  // actually rests on the exchange; TP1/TP2 are monitored triggers, not resting orders.
  const bracketStopTargets = new Map<string, { entryPrice: number; tp1Price: number; tp1Fraction: number; tp2Price: number | null; phase: string; symbol: string; locked: boolean }>()
  for (const ap of autoPlans) {
    for (const s of ap.steps) {
      const st = s.bracketState
      const spec = s.bracket
      if (st?.stopId && spec && st.entryPrice && st.entryPrice > 0) {
        bracketStopTargets.set(st.stopId, {
          entryPrice: st.entryPrice,
          tp1Price: st.entryPrice * (1 + spec.tp1.pricePct),
          tp1Fraction: spec.tp1.sizeFraction,
          tp2Price: spec.tp2 ? st.entryPrice * (1 + spec.tp2.pricePct) : null,
          phase: st.phase,
          symbol: s.symbol,
          locked: !!st.locked,
        })
      }
    }
  }

  // Map a bracket ENTRY order still awaiting fill → its entry time-stop (minutes), so the
  // OPEN ON EXCHANGE card can show a live countdown to the engine's auto-cancel. Only the
  // entry expires this way; once filled the order leaves the book, and stops/TPs don't
  // time-expire (a position time-stop exits the position, it doesn't cancel a resting order).
  const orderTimeStopMin = new Map<string, number>()
  for (const ap of autoPlans) {
    for (const s of ap.steps) {
      const st = s.bracketState
      const min = s.bracket?.entry?.timeStopMin
      if (st?.entryId && st.phase === 'entering' && min) orderTimeStopMin.set(st.entryId, min)
    }
  }

  // "Proposed" = anything staged for your approval that hasn't been sent to the exchange:
  // confirm-first pending trades + auto-plans still in their proposed (pre-execute) state.
  // These surface at the very top so a fresh recommendation can't be missed.
  const proposedPlans = autoPlans.filter((p) => p.isProposed)
  const livePlans = autoPlans.filter((p) => !p.isProposed)
  const proposedCount = pending.length + proposedPlans.length

  // The open order whose control card is docked below the constellation. Resolved
  // here (not per-group) so the planet grid never reflows around it.
  const expandedOrderData = openOrders.find((o) => o.orderId === expandedOrder)

  // Which strategy placed each resting order (see buildOrderOrigins).
  const orderOrigins = buildOrderOrigins(autoPlans, trades)

  return (
    <div style={{ padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Proposed trades — pinned to the top, above the reports, so new recommendations
          awaiting approval are the first thing seen. */}
      {proposedCount > 0 && (
        <div style={{ border: `0.5px solid ${G}`, background: 'rgba(80,200,120,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: BORDER }}>
            <span style={{ fontSize: 14, color: G, letterSpacing: 1.5, ...MONO, fontWeight: 700 }}>
              <span style={{ animation: 'blink 1.4s step-start infinite' }}>◈</span> PROPOSED TRADES
            </span>
            <span style={{ fontSize: 13, color: '#000', background: G, ...MONO, fontWeight: 700, padding: '1px 7px', borderRadius: 8 }}>{proposedCount}</span>
            <span style={{ fontSize: 12, color: GD, ...MONO }}>awaiting your approval — nothing sends until you confirm</span>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {proposedPlans.map((p) => (
              <AutoPlanPanel
                key={p.id}
                plan={p}
                tickers={tickers}
                onStop={() => stopAutoPlan(p.id).then(onStaged)}
                onReset={() => resetAutoPlan(p.id).then(onStaged)}
                onConfirm={() => onConfirmPlan(p.id)}
                onPatchStep={(stepId, patch) => onPatchStep(stepId, patch, p.id)}
              />
            ))}
            {pending.map((t) => (
              <PendingCard key={t.id} trade={t}
                ticker={tickers.find((tk) => tk.symbol === t.symbol)}
                onExecute={() => onExecute(t.id)}
                onDismiss={() => onDismiss(t.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Crypto Strategy toggle + run/loop controls — pinned above the open-orders dials
          for now (the analysis reports themselves live below OPEN ON EXCHANGE). */}
      <div style={{ border: BORDER, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: G, letterSpacing: 1.5, ...MONO }}>◈ STRATEGY</span>
        <div style={{ flex: 1 }} />
        <RunStrategyButton />
      </div>

      {/* Live open orders from Gemini. Grouped into rows by coin, with BUY / SELL as
          separate columns so it's easy to scan a symbol's full resting-order picture
          at once. */}
      {openOrders.length > 0 && (
        <div>
          <SectionHead title="OPEN ON EXCHANGE" sub={`${openOrders.length} active${expandedOrder ? '' : ' · click a planet for controls'}`} />
          {/* Side is carried by hue on each planet, so the old half-width BUY /
              SELL columns are just a legend now — the dials pack the full width. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 8 }}>
            <Lbl c={BUY_C}>▲ BUY</Lbl>
            <Lbl c={CR}>▼ SELL</Lbl>
            <Lbl c={HOT_C}>◉ WITHIN 1%</Lbl>
          </div>
          {/* Symbol groups flow as a constellation — several across a wide panel
              rather than one lonely planet per full-width row. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
          {Array.from(
            openOrders.reduce((m, o) => {
              (m.get(o.symbol) ?? m.set(o.symbol, []).get(o.symbol)!).push(o)
              return m
            }, new Map<string, GeminiOpenOrder[]>())
          ).map(([sym, orders]) => (
            <div key={sym} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* System caption above the cluster. Each planet is self-labeled,
                  so this only has to name the group it belongs to. */}
              <span style={{
                fontSize: 10, color: G, letterSpacing: 1.5, ...MONO, opacity: 0.75,
                borderBottom: `1px solid ${G}33`, paddingBottom: 2, textAlign: 'center',
              }}>{sym.replace(/USD$/, '')}{orders.length > 1 ? ` ·${orders.length}` : ''}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {/* Buys first, then sells — closest to filling leads each group. */}
                {[...orders]
                  .sort((a, b) => (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1))
                  .map((o) => (
                    <OpenOrderRing key={o.orderId} order={o}
                      ticker={tickers.find((t) => t.symbol === o.symbol)}
                      safeArm={safeMode.find((a) => a.orderId === o.orderId)}
                      origin={orderOrigins.get(o.orderId)}
                      active={expandedOrder === o.orderId}
                      onClick={() => setExpandedOrder((cur) => (cur === o.orderId ? null : o.orderId))} />
                  ))}
              </div>
            </div>
          ))}
          </div>

          {/* The control card docks BELOW the whole constellation rather than beside
              the planet that opened it. Inlining it forced that symbol's group to a
              full-width row, which reflowed every other planet and left the grid full
              of holes; docking keeps the constellation fixed as you click through it. */}
          {expandedOrderData && (
            <div style={{ marginTop: 10, borderTop: `1px solid ${G}33`, paddingTop: 8 }}>
              <OpenOrderCard key={expandedOrderData.orderId} order={expandedOrderData}
                expiresAt={orderTimeStopMin.has(expandedOrderData.orderId) ? expandedOrderData.timestampMs + orderTimeStopMin.get(expandedOrderData.orderId)! * 60_000 : undefined}
                ticker={tickers.find((t) => t.symbol === expandedOrderData.symbol)}
                signal={signals.find((s) => s.symbol === expandedOrderData.symbol)}
                bracketTargets={bracketStopTargets.get(expandedOrderData.orderId)}
                ladderCycle={btcLadderCycles.find((c) => c.rebuyOrderId === expandedOrderData.orderId)}
                safeArm={safeMode.find((a) => a.orderId === expandedOrderData.orderId)}
                origin={orderOrigins.get(expandedOrderData.orderId)}
                onCancel={() => onCancelOrder(expandedOrderData.orderId)}
                onClose={() => onClosePosition(expandedOrderData.orderId)}
                onModify={(patch) => onModifyOrder(expandedOrderData.orderId, patch)}
                onSafeMode={(opts) => onSafeMode(expandedOrderData.orderId, opts)}
                onLockToggle={onLockToggle} />
            </div>
          )}
        </div>
      )}

      {/* Live Auto Plans — executing/monitoring (proposed ones are pinned at the top).
          These sit directly beneath the planets: a bracket's detail belongs next to the
          resting orders it placed, not below the ladder banner and analysis report. */}
      {autoPlans.length === 0 ? (
        <div style={{ border: BORDER, padding: '10px 12px', marginBottom: 12 }}>
          <Lbl>No recommended trades. Run /crypto-strategy to generate recommendations — they appear here for you to review and approve before anything is sent to the exchange.</Lbl>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {livePlans.map((p) => (
            <AutoPlanPanel
              key={p.id}
              plan={p}
              tickers={tickers}
              onStop={() => stopAutoPlan(p.id).then(onStaged)}
              onReset={() => resetAutoPlan(p.id).then(onStaged)}
              onConfirm={() => onConfirmPlan(p.id)}
              onPatchStep={(stepId, patch) => onPatchStep(stepId, patch, p.id)}
            />
          ))}
        </div>
      )}

      {/* BTC ladder invariant: unhedged sells needing a buy-back */}
      <BtcLadderAlertBanner alerts={btcLadderAlerts} />

      {/* Live order-status ping */}
      <PlanReportPanel report={planReport} reportAt={planReportAt} />

      {/* Stage new trade */}
      <div style={{ border: `0.5px solid ${GD}44` }}>
        <div
          onClick={() => setShowForm((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', borderBottom: showForm ? BORDER : 'none' }}
        >
          <Lbl c={G}>+ STAGE TRADE</Lbl>
          <Lbl>{showForm ? '▲' : '▼'}</Lbl>
        </div>
        {showForm && (
          <div style={{ padding: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {/* Row 1: Pair + Side */}
            <div>
              <Lbl>PAIR</Lbl>
              <input style={inp} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="BTCUSD" list="pairs-list" />
              <datalist id="pairs-list">
                {tickers.map((t) => <option key={t.symbol} value={t.symbol} />)}
              </datalist>
              {ticker && <div style={{ marginTop: 2 }}><Lbl>now: {fmtPrice(Number(ticker.last))} · 24h {ticker.change > 0 ? '+' : ''}{ticker.change}%</Lbl></div>}
            </div>
            <div>
              <Lbl>SIDE</Lbl>
              <select style={sel} value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}>
                <option value="buy">BUY</option>
                <option value="sell">SELL</option>
              </select>
            </div>
            {/* Row 2: Type + Amount */}
            <div>
              <Lbl>ORDER TYPE</Lbl>
              <select style={sel} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="market">MARKET — execute immediately at best price</option>
                <option value="limit">LIMIT — wait for your price</option>
                <option value="stop-limit">STOP-LIMIT — trigger then limit</option>
              </select>
            </div>
            <div>
              <Lbl>AMOUNT (base currency)</Lbl>
              <input style={inp} value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder={`e.g. 0.001 ${symbol.replace('USD', '')}`} type="number" step="any" />
              {estimatedUsd && <div style={{ marginTop: 2 }}><Lbl>≈ ${estimatedUsd} USD</Lbl></div>}
            </div>
            {/* Limit price (shown for limit + stop-limit) */}
            {needsPrice && (
              <div>
                <Lbl>LIMIT PRICE (USD){needsStop ? ' — execute at this price after trigger' : ''}</Lbl>
                <input style={inp} value={price} onChange={(e) => setPrice(e.target.value)}
                  placeholder={ticker ? Number(ticker.last).toFixed(2) : '0.00'} type="number" step="any" />
              </div>
            )}
            {/* Stop trigger price (stop-limit only) */}
            {needsStop && (
              <div>
                <Lbl>STOP TRIGGER PRICE (USD) — when to activate</Lbl>
                <input style={inp} value={stopPrice} onChange={(e) => setStopPrice(e.target.value)}
                  placeholder={ticker ? (Number(ticker.last) * (side === 'sell' ? 0.97 : 1.03)).toFixed(2) : '0.00'}
                  type="number" step="any" />
                {stopPrice && price && (
                  <div style={{ marginTop: 2 }}>
                    <Lbl c={GD}>Triggers @ {fmtPrice(Number(stopPrice))} → fills @ {fmtPrice(Number(price))}</Lbl>
                  </div>
                )}
              </div>
            )}
            {/* Execution option (limit orders only) */}
            {needsPrice && (
              <div>
                <Lbl>EXECUTION OPTION (optional)</Lbl>
                <select style={sel} value={orderOption} onChange={(e) => setOrderOption(e.target.value as typeof orderOption)}>
                  <option value="">GTC — Good Till Cancelled (default)</option>
                  <option value="maker-or-cancel">Maker-or-Cancel — post only, no taker fee</option>
                  <option value="immediate-or-cancel">Immediate-or-Cancel — fill what's available now</option>
                  <option value="fill-or-kill">Fill-or-Kill — all or nothing, immediately</option>
                </select>
              </div>
            )}
            {/* Reason */}
            <div style={{ gridColumn: '1 / -1' }}>
              <Lbl>REASON / NOTE</Lbl>
              <input style={inp} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. BTC accumulation — JTO rotation T1" />
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={handleStage} disabled={staging} style={{
                ...MONO, fontSize: 13, letterSpacing: 1, padding: '5px 16px',
                background: 'transparent', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
              }}>{staging ? 'STAGING…' : 'STAGE FOR REVIEW'}</button>
              <button onClick={() => setShowForm(false)} style={{
                ...MONO, fontSize: 13, padding: '5px 12px',
                background: 'transparent', border: BORDER, color: GD, cursor: 'pointer',
              }}>CANCEL</button>
              {stageErr && <Lbl c={CR}>{stageErr}</Lbl>}
            </div>
          </div>
        )}
      </div>

      {/* (Staged / proposed trades are pinned to the top of this tab.) */}

      {/* Analysis reports (strategy / fast-cash / candle) — below the open positions,
          all collapsed by default, newest first. */}
      {planReports.length > 0 ? (
        <ReportsHistoryPanel reports={planReports} />
      ) : (
        <div style={{ border: BORDER, marginBottom: 12, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: GD, ...MONO }}>◈ NO REPORTS — run a strategy skill (controls at the top) to generate one</span>
        </div>
      )}

      {/* Gemini filled order history — collapsed, grouped by pair */}
      <FilledOrders trades={geminiTrades2026} />

      {/* Completed round-trips: entry→exit pairs with per-trade + total P&L */}
      <CompletedTrades geminiTrades={geminiTrades2026} />

      {/* Homunculus staged-trade history — collapsible */}
      <TradeHistory trades={trades2026} />
    </div>
  )
}

// ── Main Dashboard ─────────────────────────────────────────────────────
// ── Synthesis overview (2026-08 redesign) ──────────────────────────────
// Instrument deck + positions/exit-plan table + distance-to-fill orders +
// BTC ladder rungs + confirm queue + strategy fleet. Everything is expressed
// against the global.css tokens, so the occult/prism themes restyle it too.

/** Categorical slice palette for the allocation donut. Built from the themed indicator
 *  tokens (not fixed hexes) so occult/prism restyle the chart along with everything else. */
const SLICE_COLORS = [
  'var(--green)', 'var(--ind-band)', 'var(--ind-fast)', 'var(--ind-slow)',
  'var(--holo)', 'var(--ind-rsi)', 'var(--blue)', 'var(--amber)',
  'var(--crimson)', 'var(--green-dim)',
]

/** Portfolio allocation: donut of every holding by USD value, total in the hub, legend
 *  beside it. Cash counts as a slice — this is the whole book, not just the traded part. */
function AllocationPanel({ holdings, tickerMap, onSelect }: {
  holdings: CryptoSnapshot['holdings']; tickerMap: Map<string, Ticker>
  onSelect: (symbol: string) => void
}) {
  const valued = holdings
    .map((h) => {
      const isCash = h.currency === 'USD' || h.currency === 'USDT'
      return { currency: h.currency, isCash, usd: isCash ? Number(h.amount) : Number(h.amount) * Number(tickerMap.get(`${h.currency}USD`)?.last ?? 0) }
    })
    .filter((v) => v.usd > 0)
    .sort((a, b) => b.usd - a.usd)
  const total = valued.reduce((s, v) => s + v.usd, 0)
  if (total <= 0) return <Lbl>No holdings to allocate.</Lbl>

  // Anything under 1.5% of the book collapses into one OTHER wedge so the donut stays
  // readable; the legend still reports how many assets it stands for.
  const big = valued.filter((v) => v.usd / total >= 0.015)
  const smalls = valued.filter((v) => v.usd / total < 0.015)
  const smallSum = smalls.reduce((s, v) => s + v.usd, 0)
  const slices = smallSum > 0
    ? [...big, { currency: 'OTHER', isCash: false, usd: smallSum }]
    : big

  const cashUsd = valued.filter((v) => v.isCash).reduce((s, v) => s + v.usd, 0)
  const cryptoUsd = total - cashUsd
  const size = 138, r = 56, cx = size / 2, cy = size / 2, sw = 20
  const C = 2 * Math.PI * r
  let offset = 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', flexShrink: 0 }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-elev)" strokeWidth={sw} />
          {slices.map((s, i) => {
            const len = (s.usd / total) * C
            const el = (
              <circle key={s.currency} cx={cx} cy={cy} r={r} fill="none"
                stroke={SLICE_COLORS[i % SLICE_COLORS.length]} strokeWidth={sw}
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
                transform={`rotate(-90 ${cx} ${cy})`}>
                <title>{s.currency} — ${fmtNum(s.usd)} ({fmtNum((s.usd / total) * 100, 1)}%)</title>
              </circle>
            )
            offset += len
            return el
          })}
        </svg>
        {/* Hub: the number the donut is a breakdown of */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ fontSize: 15, color: 'var(--green-soft)', ...MONO }}>${fmtNum(total, 0)}</span>
          <span style={{ fontSize: 8, letterSpacing: 1.6, color: GD, ...MONO }}>TOTAL BOOK</span>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: '2px 14px' }}>
          {slices.map((s, i) => (
            <div key={s.currency}
              onClick={() => { if (s.currency !== 'OTHER' && !s.isCash) onSelect(`${s.currency}USD`) }}
              title={s.currency === 'OTHER'
                ? `${smalls.length} holdings under 1.5% each: ${smalls.map((v) => v.currency).join(', ')}`
                : `${s.currency} — $${fmtNum(s.usd)}`}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 3px', cursor: s.currency !== 'OTHER' && !s.isCash ? 'pointer' : 'default' }}>
              <span style={{ width: 8, height: 8, background: SLICE_COLORS[i % SLICE_COLORS.length], flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--green-soft)', ...MONO, minWidth: 42 }}>{s.currency}</span>
              <span style={{ fontSize: 11, color: GD, ...MONO, fontVariantNumeric: 'tabular-nums' }}>${fmtNum(s.usd)}</span>
              <span style={{ fontSize: 11, color: GD, ...MONO, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{fmtNum((s.usd / total) * 100, 1)}%</span>
            </div>
          ))}
        </div>
        {/* Deployed-vs-dry-powder split, the one cut the donut can't show on its own */}
        <div style={{ display: 'flex', gap: 16, paddingTop: 6, borderTop: BORDER, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: GD, ...MONO }}>
            CRYPTO <span style={{ color: G }}>${fmtNum(cryptoUsd)}</span> · {fmtNum((cryptoUsd / total) * 100, 1)}%
          </span>
          <span style={{ fontSize: 11, color: GD, ...MONO }}>
            CASH <span style={{ color: 'var(--holo)' }}>${fmtNum(cashUsd)}</span> · {fmtNum((cashUsd / total) * 100, 1)}%
          </span>
          <span style={{ fontSize: 11, color: GD, ...MONO }}>
            {valued.filter((v) => !v.isCash).length} ASSETS{smalls.length > 0 && ` · ${smalls.length} rolled into OTHER`}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Small SVG ring gauge — track + arc, value in the middle. */
function RingGauge({ pct, color, text }: { pct: number; color: string; text: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const CIRC = 2 * Math.PI * 20
  return (
    <svg width={46} height={46} viewBox="0 0 46 46" style={{ flexShrink: 0 }}>
      <circle cx={23} cy={23} r={20} fill="none" stroke="var(--bg-elev)" strokeWidth={4.5} />
      <circle cx={23} cy={23} r={20} fill="none" stroke={color} strokeWidth={4.5} strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * CIRC} ${CIRC}`} transform="rotate(-90 23 23)" />
      <text x={23} y={27} textAnchor="middle" fill="var(--green-soft)" fontSize={11} fontFamily="var(--font-mono)">{text}</text>
    </svg>
  )
}

/** Dashed horizon rule with a stencilled label — section divider inside the overview. */
function HRule({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0' }}>
      <span style={{ fontSize: 10, letterSpacing: 2.5, color: GD, ...MONO }}>{children}</span>
      <div style={{ flex: 1, height: 1, backgroundImage: 'repeating-linear-gradient(90deg, var(--border-strong) 0 6px, transparent 6px 12px)' }} />
    </div>
  )
}

/** Net BTC banked by closed ladder round-trips (same math as PortfolioGrowthPanel). */
function ladderSummary(cycles: BtcLadderCycle[]) {
  return cycles.reduce(
    (acc, c) => {
      if ((c.kind ?? 'roundtrip') !== 'roundtrip') return acc
      if (c.status === 'closed' && typeof c.boughtBtc === 'number') {
        acc.bankedBtc += c.boughtBtc - c.soldBtc
        acc.closed += 1
      } else if (c.status !== 'closed') acc.working += 1
      return acc
    },
    { bankedBtc: 0, closed: 0, working: 0 },
  )
}

/** Top instrument deck: portfolio · deployed ring · unrealized · ladder sats. */
function InstrumentDeck({ holdings, tickerMap, cycles }: {
  holdings: CryptoSnapshot['holdings']; tickerMap: Map<string, Ticker>; cycles: BtcLadderCycle[]
}) {
  const valued = holdings.map((h) => ({
    h,
    usd: h.currency === 'USD' || h.currency === 'USDT'
      ? Number(h.amount)
      : Number(h.amount) * Number(tickerMap.get(`${h.currency}USD`)?.last ?? 0),
  }))
  const totalUsd = valued.reduce((s, v) => s + v.usd, 0)
  const cashUsd = valued.filter((v) => v.h.currency === 'USD' || v.h.currency === 'USDT').reduce((s, v) => s + v.usd, 0)
  const deployedUsd = totalUsd - cashUsd
  const deployedPct = totalUsd > 0 ? (deployedUsd / totalUsd) * 100 : 0
  const positions = valued.filter((v) => v.usd >= 1 && v.h.currency !== 'USD' && v.h.currency !== 'USDT')
  const unrealized = positions.reduce((s, v) => s + (v.h.unrealizedPnl ?? 0), 0)
  const ladder = ladderSummary(cycles)
  const sats = Math.round(ladder.bankedBtc * 1e8)
  const plCol = unrealized >= 0 ? G : CR

  const cell = (body: ReactNode, last = false) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 14px', borderRight: last ? undefined : BORDER, minWidth: 0 }}>{body}</div>
  )
  const kv = (k: string, v: ReactNode, d?: ReactNode) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: 2, color: GD, ...MONO }}>{k}</div>
      <div style={{ fontSize: 17, color: 'var(--green-soft)', ...MONO, whiteSpace: 'nowrap' }}>{v}</div>
      {d && <div style={{ fontSize: 10, color: GD, ...MONO, whiteSpace: 'nowrap' }}>{d}</div>}
    </div>
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderBottom: BORDER, flexShrink: 0 }}>
      {cell(kv('PORTFOLIO', `$${fmtNum(totalUsd)}`, `cash $${fmtNum(cashUsd)}`))}
      {cell(<>
        <RingGauge pct={deployedPct} color="var(--holo)" text={`${Math.round(deployedPct)}%`} />
        {kv('DEPLOYED', `$${fmtNum(deployedUsd)}`, `of $${fmtNum(totalUsd)}`)}
      </>)}
      {cell(kv('UNREALIZED P&L',
        <span style={{ color: plCol }}>{unrealized >= 0 ? '+' : '−'}${fmtNum(Math.abs(unrealized))}</span>,
        `${positions.length} position${positions.length === 1 ? '' : 's'}`))}
      {cell(kv('BTC LADDER',
        <span style={{ color: 'var(--holo)' }}>{sats >= 0 ? '+' : '−'}{Math.abs(sats).toLocaleString()} sats</span>,
        `${ladder.closed} closed · ${ladder.working} working`), true)}
    </div>
  )
}

/** One-line exit plan for a position: live bracket state, else resting sell, else safe-mode arm. */
function exitPlanFor(currency: string, autoPlans: AutoPlanStatus[], openOrders: GeminiOpenOrder[], safeMode: SafeModeArm[]): string {
  const symbol = `${currency}USD`
  const plan = autoPlans.find((p) => p.active && !p.isProposed && p.steps.some((s) => s.symbol === symbol))
  if (plan) {
    const step = plan.steps[plan.currentStepIndex] ?? plan.steps[plan.steps.length - 1]
    const st = step?.bracketState
    if (st?.phase) return `bracket · ${st.phase}`
    if (step) return step.label || `step ${plan.currentStepIndex + 1}/${plan.steps.length}`
  }
  const sell = openOrders.find((o) => o.symbol === symbol && o.side === 'sell')
  if (sell) return `sell ${fmtPrice(sell.price)} resting`
  const arm = safeMode.find((a) => a.symbol === symbol)
  if (arm) return `safe-mode −${arm.stopPct}%`
  return '—'
}

/** Which strategy opened a position — latest executed buy record wins, else plan step, else manual. */
function positionStrategy(currency: string, trades: TradeRecord[], autoPlans: AutoPlanStatus[]): string | undefined {
  const symbol = `${currency}USD`
  const buys = trades.filter((t) => t.symbol === symbol && t.side === 'buy' && t.status === 'executed' && t.strategy)
  if (buys.length) return buys.sort((a, b) => b.settledAt - a.settledAt)[0].strategy
  const step = autoPlans.flatMap((p) => p.steps).find((s) => s.symbol === symbol && s.strategy)
  return step?.strategy
}

/** Positions table with strategy attribution + exit-plan column. Click a row → chart it. */
function PositionsTable({ holdings, tickerMap, autoPlans, openOrders, safeMode, trades, showDust, onToggleDust, onSelect, onClosePosition }: {
  holdings: CryptoSnapshot['holdings']; tickerMap: Map<string, Ticker>
  autoPlans: AutoPlanStatus[]; openOrders: GeminiOpenOrder[]; safeMode: SafeModeArm[]; trades: TradeRecord[]
  showDust: boolean; onToggleDust: () => void; onSelect: (symbol: string) => void
  onClosePosition: (currency: string) => void
}) {
  const rows = holdings
    .filter((h) => h.currency !== 'USD' && h.currency !== 'USDT')
    .map((h) => ({ h, usd: Number(h.amount) * Number(tickerMap.get(`${h.currency}USD`)?.last ?? 0) }))
    .sort((a, b) => b.usd - a.usd)
  const dustCount = rows.filter((r) => r.usd < 1).length
  const visible = showDust ? rows : rows.filter((r) => r.usd >= 1)
  const th = (label: string, right = false) => (
    <th style={{ textAlign: right ? 'right' : 'left', fontSize: 9, letterSpacing: 1.8, color: GD, padding: '4px 8px', fontWeight: 400, borderBottom: BORDER, ...MONO }}>{label}</th>
  )
  return (
    // flexShrink 0: an overflow:auto flex child may shrink to 0 height inside the
    // scrolling overview column — the column itself scrolls, so never collapse.
    <div style={{ overflowX: 'auto', flexShrink: 0 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr>{th('SYM')}{th('STRATEGY')}{th('ENTRY', true)}{th('MARK', true)}{th('VALUE', true)}{th('P&L', true)}{th('EXIT PLAN')}{th('')}</tr></thead>
        <tbody>
          {visible.map(({ h, usd }) => {
            const t = tickerMap.get(`${h.currency}USD`)
            const strat = positionStrategy(h.currency, trades, autoPlans)
            const meta = strat ? STRATEGY_META[strat] : undefined
            const pl = h.unrealizedPnlPct
            const td = (body: ReactNode, right = false) => (
              <td style={{ padding: '5px 8px', borderBottom: '0.5px solid var(--border)', fontSize: 12, color: GD, textAlign: right ? 'right' : 'left', ...MONO, whiteSpace: 'nowrap' }}>{body}</td>
            )
            return (
              <tr key={h.currency} onClick={() => onSelect(`${h.currency}USD`)} style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elev)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                {td(<span style={{ color: 'var(--green-soft)', fontWeight: 700 }}>{h.currency}</span>)}
                {td(<span style={{ fontSize: 9, letterSpacing: 1.2, padding: '1px 6px', border: `0.5px solid ${meta?.color ?? 'var(--border)'}`, borderRadius: 2, color: meta?.color ?? GD }}>{meta?.label ?? (strat ? strat.toUpperCase() : 'MANUAL')}</span>)}
                {td(h.costBasis ? fmtPrice(h.costBasis) : '—', true)}
                {td(t ? fmtPrice(t.last) : '—', true)}
                {td(`$${fmtNum(usd)}`, true)}
                {td(pl == null ? '—' : <span style={{ color: pl >= 0 ? G : CR }}>{pl >= 0 ? '+' : ''}{pl.toFixed(1)}%</span>, true)}
                {td(exitPlanFor(h.currency, autoPlans, openOrders, safeMode))}
                {td(
                  <button
                    title={`Close ${h.currency}: cancel its orders and sell 100% at 0.1% above market`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`Cancel all ${h.currency} orders and sell 100% (${fmtNum(h.amount, 6)} ${h.currency}) at 0.1% above market?`)) onClosePosition(h.currency)
                    }}
                    style={{ ...MONO, fontSize: 10, padding: '1px 7px', background: 'transparent', border: `0.5px solid ${CR}`, color: CR, cursor: 'pointer' }}
                  >✕</button>,
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {dustCount > 0 && (
        <button onClick={onToggleDust} style={{ ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 10px', marginTop: 4, background: 'transparent', border: BORDER, color: GD, cursor: 'pointer' }}>
          {showDust ? `HIDE ${dustCount} DUST` : `SHOW ${dustCount} DUST (<$1)`}
        </button>
      )}
    </div>
  )
}

/** Resting orders as distance-to-fill tracks: dot position = closeness to trigger. */
function DistanceToFill({ openOrders, tickerMap }: { openOrders: GeminiOpenOrder[]; tickerMap: Map<string, Ticker> }) {
  if (!openOrders.length) return <Lbl>No resting orders.</Lbl>
  const rows = openOrders.map((o) => {
    const last = Number(tickerMap.get(o.symbol)?.last ?? 0)
    const price = Number(o.price)
    // Signed distance from market to trigger: buys fill on a drop, sells on a rise.
    const dist = last > 0 && price > 0
      ? (o.side === 'buy' ? (last - price) / last : (price - last) / last) * 100
      : null
    return { o, dist }
  }).sort((a, b) => Math.abs(a.dist ?? 99) - Math.abs(b.dist ?? 99))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map(({ o, dist }) => {
        // 0% away → dot at the right edge; ≥10% away → far left.
        const pos = dist == null ? 0 : Math.max(2, Math.min(96, 100 - Math.abs(dist) * 10))
        const hot = dist != null && Math.abs(dist) < 1
        const dotCol = hot ? 'var(--amber)' : o.side === 'buy' ? G : CR
        return (
          <div key={o.orderId} style={{ display: 'grid', gridTemplateColumns: '58px 36px 1fr 90px 84px', gap: 10, alignItems: 'center', padding: '4px 6px', fontSize: 12, ...MONO }}>
            <span style={{ color: 'var(--green-soft)', fontWeight: 700 }}>{o.symbol.replace('USD', '')}</span>
            <span style={{ color: o.side === 'buy' ? G : CR, fontSize: 10, letterSpacing: 1 }}>{o.side.toUpperCase()}</span>
            <div style={{ height: 3, background: 'var(--bg-elev)', borderRadius: 2, position: 'relative' }}>
              <div style={{ position: 'absolute', top: -2.5, left: `${pos}%`, width: 8, height: 8, borderRadius: '50%', background: dotCol, boxShadow: `0 0 6px ${hot ? 'var(--amber)' : 'transparent'}` }} />
            </div>
            <span style={{ color: GD, textAlign: 'right' }}>{fmtPrice(o.price)}</span>
            <span style={{ color: hot ? 'var(--amber)' : GD, fontSize: 10, textAlign: 'right' }}>{dist == null ? '—' : `${dist >= 0 ? '−' : '+'}${Math.abs(dist).toFixed(1)}% away`}</span>
          </div>
        )
      })}
    </div>
  )
}

/** BTC ladder rebuy rungs: each open/staged/resting cycle as a rung with fill proximity. */
function LadderRungs({ cycles, tickerMap }: { cycles: BtcLadderCycle[]; tickerMap: Map<string, Ticker> }) {
  const btcLast = Number(tickerMap.get('BTCUSD')?.last ?? 0)
  const open = cycles.filter((c) => (c.kind ?? 'roundtrip') === 'roundtrip' && c.status !== 'closed')
  if (!open.length) return <Lbl>No working rungs — all cycles closed.</Lbl>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {open.sort((a, b) => (b.rebuyPrice ?? 0) - (a.rebuyPrice ?? 0)).map((c) => {
        const rebuy = c.rebuyPrice
        const dist = rebuy && btcLast > 0 ? ((btcLast - rebuy) / btcLast) * 100 : null
        const width = dist == null ? 5 : Math.max(5, Math.min(95, 100 - dist * 8))
        const statusText = c.status === 'open' ? 'UNHEDGED' : c.status.toUpperCase()
        const statusCol = c.status === 'open' ? CR : GD
        return (
          <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '76px 1fr 150px', gap: 10, alignItems: 'center', fontSize: 12, ...MONO }}>
            <span style={{ color: 'var(--holo)' }}>{rebuy ? fmtPrice(rebuy) : '—'}</span>
            <div style={{ height: 5, background: 'var(--bg-elev)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${width}%`, height: '100%', background: 'linear-gradient(90deg, transparent, var(--holo))' }} />
            </div>
            <span style={{ color: statusCol, fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>
              {statusText}{dist != null && ` · −${dist.toFixed(1)}%`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Report kinds and strategy ids are separate key spaces (see STRATEGY_META's note).
 *  This is the bridge, so a run's report can be tied to the trades that run staged. */
const REPORT_KIND_TO_STRATEGY: Record<PlanReportEntry['kind'], string> = {
  strategy: 'crypto-strategy',
  'fast-cash': 'fast-cash',
  candle: 'crypto-candles',
  oversold: 'oversold',
  firecracker: 'firecracker',
  sniper: 'sniper',
  'btc-ladder': 'btc-ladder',
  trapline: 'trapline',
  reaper: 'reaper',
}

/** Recent strategy runs, newest first: which strategy ran, how long ago, and what it
 *  actually did. A run's output is the trades its strategy staged between that report
 *  and the next report from the same strategy — attribution by window, not guesswork. */
function RecentRuns({ reports, trades, status, onOpenReports }: {
  reports: PlanReportEntry[]; trades: TradeRecord[]
  status: StrategyRunStatus | null; onOpenReports: () => void
}) {
  const sorted = [...reports].sort((a, b) => b.at - a.at)
  const running = status?.state === 'running' ? status : null

  // What a run produced. Most trade records carry no `strategy` field (only 8 of 122 at
  // time of writing), so attribution is asserted ONLY when the record actually says so —
  // otherwise this would report "no entries" for every run and read as "nothing happened".
  const outcomeFor = (r: PlanReportEntry, index: number) => {
    const stratId = REPORT_KIND_TO_STRATEGY[r.kind]
    // The run owns the interval until the next report of ANY kind — that's the stretch
    // where it was the latest activity.
    const until = index > 0 ? sorted[index - 1].at : Infinity
    const inWindow = trades.filter((t) => t.createdAt >= r.at && t.createdAt < until)
    const mine = inWindow.filter((t) => t.strategy === stratId)
    if (mine.length) {
      const executed = mine.filter((t) => t.status === 'executed').length
      return {
        text: executed ? `${mine.length} staged · ${executed} executed` : `${mine.length} staged`,
        color: executed ? G : 'var(--amber)',
      }
    }
    // Nothing staged by anyone in the window is a fact we can state regardless of attribution.
    if (!inWindow.length) return { text: 'no trades staged', color: GD }
    return { text: `${inWindow.length} staged in window · unattributed`, color: GD }
  }

  if (!running && !sorted.length) return <Lbl>No strategy runs recorded yet.</Lbl>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {running && (() => {
        const meta = STRATEGY_META[running.strategy]
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', border: '0.5px solid var(--amber)', background: 'color-mix(in srgb, var(--amber) 6%, transparent)' }}>
            <span style={{ color: 'var(--amber)', fontSize: 11, animation: 'blink 1.4s step-start infinite' }}>◈</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, color: meta?.color ?? 'var(--green-soft)', fontWeight: 700, letterSpacing: 1, ...MONO }}>{meta?.label ?? running.strategy.toUpperCase()}</div>
              <div style={{ fontSize: 9, color: GD, ...MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {running.source === 'routine' ? 'scheduled routine' : 'launched here'} · {running.startedAt ? ago(running.startedAt) : 'just now'}
              </div>
            </div>
            <span style={{ fontSize: 9, letterSpacing: 1, color: 'var(--amber)', ...MONO }}>RUNNING</span>
          </div>
        )
      })()}
      {sorted.slice(0, 8).map((r, i) => {
        const meta = REPORT_KIND_META[r.kind]
        const outcome = outcomeFor(r, i)
        return (
          <div key={`${r.kind}-${r.at}`} onClick={onOpenReports}
            title={`${r.title} · ${new Date(r.at).toLocaleString()} — click to read it in TRADES`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', border: BORDER, background: 'var(--bg-panel)', cursor: 'pointer' }}>
            <span style={{ fontSize: 10, color: meta?.color ?? GD, flexShrink: 0 }}>{meta?.glyph ?? '◈'}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, color: meta?.color ?? 'var(--green-soft)', fontWeight: 700, letterSpacing: 1, ...MONO }}>{meta?.label ?? r.kind.toUpperCase()}</div>
              <div style={{ fontSize: 9, color: outcome.color, ...MONO }}>{outcome.text}</div>
            </div>
            <span style={{ fontSize: 10, color: GD, ...MONO, flexShrink: 0 }}>{ago(r.at)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Strategy fleet: every strategy as a status tile — running/looping state at a glance. */
function StrategyFleet({ status, onRun }: { status: StrategyRunStatus | null; onRun: (id: StrategyId) => void }) {
  const [intervals, setIntervals] = useState<Record<string, number>>({})
  useEffect(() => {
    fetchStrategyIntervals().then((m) => setIntervals(m ?? {})).catch(() => {})
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {STRATEGY_OPTIONS.map(({ id, label }) => {
        const meta = STRATEGY_META[id]
        const running = status?.state === 'running' && status.strategy === id
        const loopMin = intervals[id]
        const dotCol = running ? 'var(--amber)' : loopMin ? G : GD
        return (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 9px', border: BORDER, background: 'var(--bg-panel)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotCol, boxShadow: running || loopMin ? `0 0 7px ${dotCol}` : 'none', flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, color: meta?.color ?? 'var(--green-soft)', fontWeight: 700, letterSpacing: 1, ...MONO }}>{label}</div>
              <div style={{ fontSize: 9, color: GD, ...MONO }}>
                {running ? (status?.activity || 'running…') : loopMin ? `loop every ${loopMin}m` : 'idle'}
              </div>
            </div>
            <button onClick={() => onRun(id)} disabled={status?.state === 'running'}
              title={status?.state === 'running' ? 'A strategy is already running' : `Run ${label} now (confirm-first — trades land in the queue)`}
              style={{ ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 9px', background: 'transparent', border: `0.5px solid ${running ? 'var(--amber)' : 'var(--border)'}`, color: running ? 'var(--amber)' : GD, cursor: status?.state === 'running' ? 'default' : 'pointer' }}>
              {running ? '◈ LIVE' : '▶'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function CryptoDashboard() {
  const [snapshot, setSnapshot] = useState<CryptoSnapshot | null>(null)
  const [trades, setTrades] = useState<TradeRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('OVERVIEW')
  const [chartSymbol, setChartSymbol] = useState<string>('BTCUSD')
  const [showDust, setShowDust] = useState(false) // sub-$1 holdings hidden by default
  const [refreshing, setRefreshing] = useState(false)
  const [strategyStatus, setStrategyStatus] = useState<StrategyRunStatus | null>(null)

  const load = useCallback(async () => {
    try {
      const [snap, tradeList] = await Promise.all([fetchCryptoSnapshot(), fetchCryptoTrades()])
      setSnapshot(snap)
      setTrades(tradeList)
      setError(null)
      // Auto-select highest-value holding for chart if still on default
      if (snap.holdings.length && chartSymbol === 'BTCUSD') {
        const byValue = [...snap.holdings]
          .map((h) => {
            const t = snap.tickers.find((tk) => tk.symbol === `${h.currency}USD`)
            return { currency: h.currency, usd: t ? Number(h.amount) * Number(t.last) : 0 }
          })
          .sort((a, b) => b.usd - a.usd)
        if (byValue[0]) setChartSymbol(`${byValue[0].currency}USD`)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [chartSymbol])

  /**
   * Executes a staged trade and REPORTS THE OUTCOME.
   *
   * The bare `executeTrade(id).then(load)` this replaces discarded the server's
   * `{ok, error}` and had no catch. When Gemini rejected an order — insufficient
   * balance, below min size, expired key — the pending card simply vanished on the
   * next poll (the server removes the pending entry before it calls the exchange),
   * so a failed order was indistinguishable from a filled one. On real money, that
   * is the worst possible way to fail. Every sibling action here already checks its
   * result; this now matches them.
   */
  const runExecuteTrade = useCallback(async (id: string) => {
    try {
      const r = await executeTrade(id)
      await load()
      if (!r.ok) alert(`Trade failed: ${r.error ?? 'unknown error'}`)
    } catch (e) {
      await load().catch(() => {})
      alert(`Trade failed: ${(e as Error).message}`)
    }
  }, [load])

  const onClosePositionSymbol = useCallback(async (symbol: string) => {
    const r = await closeSymbolPosition(symbol)
    await load()
    if (!r.ok) alert(`Close position failed: ${r.error ?? 'unknown error'}`)
  }, [load])

  useEffect(() => {
    void load()
    // Poll every 8s so the TRADES tab's open orders / proposed trades stay fresh —
    // the server's hot loop re-prices open positions even faster (~7s) behind this.
    const id = setInterval(load, 8_000)
    return () => clearInterval(id)
  }, [load])

  // Poll the strategy runner so the header can flag when a run is live — including the
  // hourly routine, which runs the skill in its own session and only pings a heartbeat.
  useEffect(() => {
    const tick = () => { fetchStrategyStatus().then(setStrategyStatus).catch(() => {}) }
    tick()
    const id = setInterval(tick, 8_000)
    return () => clearInterval(id)
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await refreshCrypto()
    await load()
    setRefreshing(false)
  }

  if (!snapshot && !error) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: GD, fontSize: 14, ...MONO }}>LOADING…</div>
  }

  if (error) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: CR, fontSize: 14, ...MONO }}>ERROR: {error}</div>
  }

  const snap = snapshot!
  const tickers = snap.tickers
  const signals = snap.signals
  const pending = snap.pending
  // Trades proposed for approval but not yet sent: confirm-first pending + proposed plans.
  const proposedCount = pending.length + (snap.autoPlans ?? []).filter((p) => p.isProposed).length
  const seed = snap.seedProgress
  const usdTickers = tickers.filter((t) => t.symbol.endsWith('USD'))
  const tickerMap = new Map(usdTickers.map((t) => [t.symbol, t]))
  // Position + fills + resting orders for the charted symbol, overlaid on the chart.

  const SECTIONS: Section[] = ['OVERVIEW', 'MARKET', 'SCREENERS', 'TRADES', 'INTELLIGENCE', 'SETTINGS', 'AUDIT']
  const seedVisible = (seed.active || seed.seeded < seed.total) && seed.total > 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '156px 1fr', height: '100%', overflow: 'hidden' }}>
      {/* ── Nav rail (vertical, left) ── */}
      <div style={{ borderRight: BORDER, background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', padding: '10px 6px', gap: 2, overflow: 'hidden' }}>
        <div style={{ padding: '0 8px 8px', borderBottom: BORDER, marginBottom: 6 }}>
          <Lbl c={G} size={13}>CRYPTO</Lbl>
        </div>
        {SECTIONS.map((s) => (
          <button key={s} onClick={() => setSection(s)} style={{
            ...MONO, fontSize: 13, letterSpacing: 1, padding: '7px 10px', textAlign: 'left',
            display: 'flex', alignItems: 'center',
            background: section === s ? 'var(--bg-elev)' : 'transparent',
            border: 'none', boxShadow: section === s ? `inset 2px 0 0 ${G}` : 'none',
            color: section === s ? 'var(--green-soft)' : GD, cursor: 'pointer',
          }}>
            {s}
            {s === 'TRADES' && proposedCount > 0 && (
              <span title={`${proposedCount} proposed trade${proposedCount > 1 ? 's' : ''} awaiting approval`} style={{ marginLeft: 'auto', fontSize: 11, color: '#000', background: G, fontWeight: 700, padding: '0 6px', borderRadius: 8, animation: 'blink 1.4s step-start infinite' }}>{proposedCount}</span>
            )}
            {s === 'TRADES' && proposedCount === 0 && (snap.openOrders?.length ?? 0) > 0 && <span style={{ color: GD, marginLeft: 'auto' }}>{snap.openOrders?.length ?? 0}</span>}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={handleRefresh} disabled={refreshing} style={{ ...MONO, fontSize: 13, padding: '5px 10px', background: 'transparent', border: BORDER, color: GD, cursor: 'pointer' }}>
          {refreshing ? '…' : '↻ REFRESH'}
        </button>
      </div>

      {/* ── Right side: status bar / seed / body ── */}
      <div style={{ display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr)', overflow: 'hidden', minWidth: 0 }}>
      {/* ── Status bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderBottom: BORDER }}>
        <span style={{ fontSize: 14, color: snap.connected ? G : CR, ...MONO }}>{snap.connected ? '● LIVE' : '○ OFFLINE'}</span>
        {!snap.keysConfigured && <span style={{ fontSize: 14, color: CR, ...MONO }}>KEYS NOT CONFIGURED</span>}
        <span style={{ fontSize: 14, color: GD, ...MONO }}>{usdTickers.length} pairs · {ago(snap.lastRefresh)}</span>
        {(snap.btcLadderAlerts?.length ?? 0) > 0 && (
          <span
            onClick={() => setSection('TRADES')}
            title="A BTC sell has no resting buy-back — see TRADES"
            style={{ fontSize: 14, color: CR, ...MONO, fontWeight: 700, cursor: 'pointer', border: `0.5px solid ${CR}`, padding: '2px 6px' }}
          >
            ⚠ BTC UNHEDGED ×{snap.btcLadderAlerts!.length}
          </span>
        )}
        {proposedCount > 0 && (
          <span
            onClick={() => setSection('TRADES')}
            title={`${proposedCount} trade${proposedCount > 1 ? 's' : ''} proposed and awaiting your approval — see TRADES`}
            style={{ fontSize: 14, color: '#000', background: G, ...MONO, fontWeight: 700, cursor: 'pointer', padding: '2px 8px', borderRadius: 9 }}
          >
            <span style={{ animation: 'blink 1.4s step-start infinite' }}>◈</span> {proposedCount} PROPOSED
          </span>
        )}
        {snap.autoExecute?.enabled && (
          <span
            onClick={() => setSection('TRADES')}
            title={`Auto-execute is ON — BTC ladder ≤ $${snap.autoExecute.btcLadderMaxUsd}, alt ≤ $${snap.autoExecute.altMaxUsd} execute without approval`}
            style={{ fontSize: 14, color: '#c8a227', ...MONO, fontWeight: 700, cursor: 'pointer', border: '0.5px solid #c8a227', padding: '2px 6px' }}
          >
            ⚡ AUTO BTC≤${snap.autoExecute.btcLadderMaxUsd}·ALT≤${snap.autoExecute.altMaxUsd}
          </span>
        )}
        {strategyStatus?.state === 'running' && (
          <span
            onClick={() => setSection('TRADES')}
            title={
              (strategyStatus.source === 'routine'
                ? 'The scheduled hourly crypto routine is running — updating strategy verdicts & staged plans.'
                : 'A strategy run launched from this app is in progress.') +
              (strategyStatus.activity ? `\n${strategyStatus.activity}` : '')
            }
            style={{ fontSize: 14, color: G, ...MONO, fontWeight: 700, cursor: 'pointer', border: `0.5px solid ${G}`, padding: '2px 6px' }}
          >
            <span style={{ animation: 'blink 1.4s step-start infinite' }}>◈</span>{' '}
            {strategyStatus.source === 'routine' ? 'ROUTINE RUNNING' : 'STRATEGY RUNNING'}
          </span>
        )}
        <div style={{ flex: 1 }} />
      </div>

      {/* ── Seed progress ──
          The wrapper renders unconditionally even when there's nothing to show:
          this grid is `auto auto 1fr`, so if the seed row disappeared entirely the
          body would slide up into the second (auto) row and size to its content
          instead of filling the pane. Empty auto row = 0px, so nothing is lost. */}
      <div style={seedVisible ? { padding: '3px 12px', borderBottom: BORDER } : undefined}>
        {seedVisible && <SeedBar {...seed} />}
      </div>

      {/* ── Body ── */}
      {section === 'OVERVIEW' && (
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', overflow: 'hidden', minWidth: 0 }}>
          <InstrumentDeck holdings={snap.holdings} tickerMap={tickerMap} cycles={snap.btcLadderCycles ?? []} />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', overflow: 'hidden' }}>

            {/* Left: state — positions, resting orders, ladder, growth */}
            <div style={{ borderRight: BORDER, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <HRule>PORTFOLIO ALLOCATION</HRule>
              <AllocationPanel
                holdings={snap.holdings} tickerMap={tickerMap}
                onSelect={(symbol) => { setChartSymbol(symbol); setSection('MARKET') }}
              />
              <HRule>OPEN POSITIONS</HRule>
              {snap.holdings.length === 0 ? <Lbl>No holdings found.</Lbl> : (
                <PositionsTable
                  holdings={snap.holdings} tickerMap={tickerMap}
                  autoPlans={snap.autoPlans ?? []} openOrders={snap.openOrders ?? []}
                  safeMode={snap.safeMode ?? []} trades={trades}
                  showDust={showDust} onToggleDust={() => setShowDust((v) => !v)}
                  onSelect={(symbol) => { setChartSymbol(symbol); setSection('MARKET') }}
                  onClosePosition={(currency) => onClosePositionSymbol(`${currency}USD`)}
                />
              )}
              <HRule>RESTING ORDERS · DISTANCE TO FILL</HRule>
              <DistanceToFill openOrders={snap.openOrders ?? []} tickerMap={tickerMap} />
              <HRule>BTC LADDER · REBUY RUNGS</HRule>
              <LadderRungs cycles={snap.btcLadderCycles ?? []} tickerMap={tickerMap} />
              {snap.portfolioGrowth && (
                <PortfolioGrowthPanel growth={snap.portfolioGrowth} onReset={load} btcPrice={Number(tickerMap.get('BTCUSD')?.last) || 0} cycles={snap.btcLadderCycles} />
              )}
            </div>

            {/* Right: decisions — confirm queue, strategy fleet */}
            <div style={{ overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ border: '0.5px solid var(--amber)', background: 'color-mix(in srgb, var(--amber) 6%, transparent)', padding: '8px 10px' }}>
                <div style={{ marginBottom: 6 }}><Lbl c={'var(--amber)'} size={11}>PROPOSED · AWAITING CONFIRM · {pending.length}</Lbl></div>
                {pending.length === 0 ? <Lbl>Queue clear — nothing awaiting approval.</Lbl> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {pending.map((t) => (
                      <PendingCard key={t.id} trade={t} ticker={tickerMap.get(t.symbol)}
                        onExecute={() => runExecuteTrade(t.id)}
                        onDismiss={() => dismissTrade(t.id).then(load)}
                      />
                    ))}
                  </div>
                )}
              </div>
              <HRule>RECENT RUNS</HRule>
              <RecentRuns
                reports={snap.planReports ?? []} trades={trades}
                status={strategyStatus} onOpenReports={() => setSection('TRADES')}
              />
              <HRule>STRATEGY FLEET</HRule>
              <StrategyFleet status={strategyStatus} onRun={async (id) => {
                const r = await runCryptoStrategy(id)
                if (!r.ok) alert(`Run failed: ${r.error ?? 'unknown error'}`)
                fetchStrategyStatus().then(setStrategyStatus).catch(() => {})
              }} />
            </div>
          </div>
        </div>
      )}

      {section === 'MARKET' && (
        <MarketSection snap={snap} focusSymbol={chartSymbol} onStaged={() => { void load() }} />
      )}

      {/* Prescreening lives in its own panel: it owns a saved-screener library, a
          filter rail and its own Python screening engine, none of which the rest of
          this dashboard needs to know about. The `signals` feed is untouched — the
          TRADES tab and the order internals still read it. */}
      {section === 'SCREENERS' && <ScreenersSection />}

      {section === 'TRADES' && (
        <TradesSection
          pending={pending} openOrders={snap.openOrders ?? []} safeMode={snap.safeMode ?? []} trades={trades} geminiTrades={snap.tradeHistory ?? []}
          autoPlans={snap.autoPlans} planReport={snap.planReport ?? ''} planReportAt={snap.planReportAt ?? null}
          planReports={snap.planReports ?? []}
          btcLadderAlerts={snap.btcLadderAlerts ?? []}
          btcLadderCycles={snap.btcLadderCycles ?? []}
          onExecute={(id) => runExecuteTrade(id)}
          onDismiss={(id) => dismissTrade(id).then(load)}
          onStaged={load}
          onCancelOrder={async (orderId) => { await cancelOpenOrder(orderId); await load() }}
          onClosePosition={async (orderId) => { const r = await closePosition(orderId); await load(); if (!r.ok) alert(`Close failed: ${r.error ?? 'unknown error'}`) }}
          onModifyOrder={async (orderId, patch) => { const r = await modifyOpenOrder(orderId, patch); await load(); return r }}
          onSafeMode={async (orderId, opts) => { const r = 'adjust' in opts ? await adjustSafeMode(orderId, opts) : await setSafeMode(orderId, opts); await load(); if (!r.ok) alert(`Safe mode failed: ${r.error ?? 'unknown error'}`) }}
          tickers={usdTickers}
          signals={signals}
          onConfirmPlan={(planSymbol) => confirmAutoPlan(planSymbol).then(load)}
          onPatchStep={async (stepId, patch, planSymbol) => { await patchAutoPlanStep(stepId, patch, planSymbol); await load() }}
          onLockToggle={async (symbol, locked) => { const r = await setBracketLock(symbol, locked); await load(); if (!r.ok) alert(`Lock toggle failed: ${r.error ?? 'unknown error'}`) }}
        />
      )}

      {section === 'INTELLIGENCE' && <IntelligenceSection />}

      {section === 'SETTINGS' && <SettingsSection />}
      {section === 'AUDIT' && <AuditSection />}
      </div>
    </div>
  )
}
