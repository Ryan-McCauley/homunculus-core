// BRIDGE-sidebar widget: live status of open crypto trades.
//
// "Open trades" = positions the managed-bracket engine is currently holding
// (entry filled, stop + targets live) plus any resting orders on the exchange.
// Fed by useCryptoPositions, which polls the lean /api/crypto/positions slice.
// Read-only by design — execution/kill controls stay on the CRYPTO tab.

import type { Ticker, BracketPhase, GeminiOpenOrder } from '../../shared/crypto'
import { unrealUsd } from '../hooks/useCryptoPositions'
import type { OpenPosition, CryptoPositions } from '../hooks/useCryptoPositions'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const CR = 'var(--crimson)'
const AMBER = 'var(--amber)'
const MONO = { fontFamily: 'var(--font-mono)' } as const
const DISP = { fontFamily: 'var(--font-display)' } as const

const PHASE_META: Record<BracketPhase, { label: string; color: string }> = {
  entering: { label: 'ENTRY RESTING', color: AMBER },
  protected: { label: 'PROTECTED', color: G },
  tp1_filled: { label: 'TP1 · RUNNER', color: G },
  exiting: { label: 'EXITING', color: AMBER },
  flat: { label: 'CLOSED', color: GD },
  aborted: { label: 'ABORTED', color: GD },
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4)
  return n.toPrecision(4)
}
function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}
function ago(ts: number): string {
  if (!ts) return '—'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

function PositionRow({ p }: { p: OpenPosition }): JSX.Element {
  const meta = PHASE_META[p.phase]
  const live = p.entryPrice && p.last ? ((p.last - p.entryPrice) / p.entryPrice) * 100 : null
  const liveUsd = unrealUsd(p)
  const pnlColor = live == null ? GD : live >= 0 ? G : CR
  const stopDist = p.stopPrice && p.last ? ((p.last - p.stopPrice) / p.last) * 100 : null

  return (
    <div style={{ padding: '7px 0', borderBottom: `0.5px solid var(--border)` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 16, color: G, ...DISP, letterSpacing: 1 }}>{p.base}</span>
        <span style={{ fontSize: 11, color: meta.color, ...MONO, letterSpacing: 1 }}>{meta.label}</span>
        <div style={{ flex: 1 }} />
        {live != null && (
          <span style={{ fontSize: 17, color: pnlColor, ...MONO }}>{fmtPct(live)}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, color: GD, ...MONO }}>
        {p.entryPrice != null && <span>entry {fmtPrice(p.entryPrice)}</span>}
        {p.last != null && <span style={{ color: 'var(--green)' }}>now {fmtPrice(p.last)}</span>}
        {p.stopPrice != null && (
          <span style={{ color: AMBER }}>
            stop {fmtPrice(p.stopPrice)}{stopDist != null ? ` (${stopDist >= 0 ? '' : ''}${stopDist.toFixed(1)}%)` : ''}
          </span>
        )}
        {liveUsd != null && <span style={{ color: liveUsd >= 0 ? G : CR }}>{fmtUsd(liveUsd)}</span>}
        {p.realizedUsd !== 0 && <span>banked {fmtUsd(p.realizedUsd)}</span>}
      </div>
    </div>
  )
}

function OrderRow({ o, tickers }: { o: GeminiOpenOrder; tickers: Ticker[] }): JSX.Element {
  const base = o.symbol.replace('USD', '')
  const last = Number(tickers.find((t) => t.symbol === o.symbol)?.last ?? 0)
  const limit = Number(o.price)
  const dist = last && limit ? ((limit - last) / last) * 100 : null
  const sideColor = o.side === 'buy' ? G : CR
  return (
    <div style={{ padding: '6px 0', borderBottom: `0.5px solid var(--border)`, display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, ...MONO }}>
      <span style={{ fontSize: 14, color: G, ...DISP }}>{base}</span>
      <span style={{ color: sideColor }}>{o.side.toUpperCase()}</span>
      <span style={{ color: GD }}>{o.type.replace('exchange ', '')}</span>
      <div style={{ flex: 1 }} />
      <span style={{ color: GD }}>@ {fmtPrice(limit)}</span>
      {dist != null && <span style={{ color: Math.abs(dist) < 1 ? G : GD }}>{dist >= 0 ? '+' : ''}{dist.toFixed(1)}%</span>}
    </div>
  )
}

export function OpenTradesWidget({ data }: { data: CryptoPositions }): JSX.Element {
  const { snap, error: err, positions, orders, totalUnrealUsd: totalUnreal } = data

  return (
    <div style={{ border: '0.5px solid var(--border)', background: 'var(--bg-elev)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 9px', borderBottom: '0.5px solid var(--border)' }}>
        <span style={{ fontSize: 13, letterSpacing: 2, color: G, ...DISP }}>OPEN TRADES</span>
        <span style={{ fontSize: 12, color: GD, ...MONO }}>
          {positions.length} pos{orders.length ? ` · ${orders.length} ord` : ''}
        </span>
        <div style={{ flex: 1 }} />
        {positions.length > 0 && (
          <span style={{ fontSize: 14, color: totalUnreal >= 0 ? G : CR, ...MONO }}>{fmtUsd(totalUnreal)}</span>
        )}
      </div>

      <div style={{ padding: '4px 9px 8px' }}>
        {!snap && !err && (
          <div style={{ fontSize: 13, color: GD, ...MONO, padding: '6px 0' }}>LINKING…</div>
        )}
        {err && (
          <div style={{ fontSize: 12, color: CR, ...MONO, padding: '6px 0' }}>link error · {err}</div>
        )}
        {snap && positions.length === 0 && orders.length === 0 && (
          <div style={{ fontSize: 12, color: GD, ...MONO, padding: '6px 0' }}>
            No open positions. Managed brackets appear here once an entry fills.
          </div>
        )}

        {positions.map((p) => <PositionRow key={p.key} p={p} />)}

        {orders.length > 0 && (
          <>
            <div style={{ fontSize: 11, letterSpacing: 1.5, color: GD, ...MONO, margin: '8px 0 2px' }}>RESTING ON EXCHANGE</div>
            {orders.map((o) => <OrderRow key={o.orderId} o={o} tickers={snap?.tickers ?? []} />)}
          </>
        )}

        {snap && (
          <div style={{ fontSize: 11, color: GD, ...MONO, marginTop: 6, textAlign: 'right' }}>
            {snap.connected ? `sync ${ago(snap.lastRefresh)}` : 'gemini offline'}
          </div>
        )}
      </div>
    </div>
  )
}
