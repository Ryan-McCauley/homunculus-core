// The MARKET workspace: watchlist rail, symbol tabs, multi-chart layouts,
// indicator picker, alert builder, and click-to-trade.
//
// Click-to-trade routes through the same confirm-first path as every other order
// in this app: a click stages a PROPOSED limit that waits in TRADES for an
// explicit confirm. Nothing here can send an order to Gemini.

import { useState, useEffect, useMemo, useCallback } from 'react'
import type { CryptoSnapshot, Ticker, Signal, PendingTrade } from '../../../shared/crypto'
import type { CryptoAlert } from '../../../shared/alerts'
import { stageTrade, fetchAlerts } from '../../lib/cryptoApi'
import {
  loadPrefs, savePrefs, indicatorsFor, isAutoList, AUTO_LISTS, INDICATORS,
} from '../../lib/marketPrefs'
import type { MarketPrefs, ChartLayout, IndicatorId, Watchlist } from '../../lib/marketPrefs'
import { G, GD, CR, AMBER, BORDER, MONO, fmtPrice, fmtNum, changeColor, dirColor, qualColor, Lbl } from '../../lib/cryptoUi'
import type { TF } from '../../lib/cryptoUi'
import { TradingChart } from './TradingChart'
import type { ChartDraft } from './TradingChart'
import { IndicatorModal } from './IndicatorModal'
import { AlertModal } from './AlertModal'
import { CompareChart } from './CompareChart'

const TFS: TF[] = ['1m', '5m', '15m', '1hr', '4hr', '1day']

const LAYOUTS: { id: ChartLayout; label: string; title: string }[] = [
  { id: 'single', label: '▣ 1', title: 'One chart' },
  { id: 'split', label: '▥ 1+2', title: 'Focused chart plus two stacked' },
  { id: 'quad', label: '▦ 4', title: 'Four charts' },
  { id: 'compare', label: '⧉ COMPARE', title: 'All open tabs on one normalized % axis' },
  { id: 'matrix', label: '▤ MATRIX', title: 'Whole list as a sortable table' },
]

const SIZE_CHIPS = [20, 50, 100]

interface Ticket { side: 'buy' | 'sell'; price: number; usd: number }

export function MarketSection({ snap, focusSymbol, onStaged }: {
  snap: CryptoSnapshot
  /** Symbol handed over from OVERVIEW (clicking a position opens it here). */
  focusSymbol?: string
  onStaged: () => void
}) {
  const [prefs, setPrefs] = useState<MarketPrefs>(() => loadPrefs())
  const [tf, setTf] = useState<TF>('1hr')
  const [filter, setFilter] = useState('')
  const [focus, setFocus] = useState<string>(() => loadPrefs().tabs[0] ?? 'BTCUSD')
  const [showIndicators, setShowIndicators] = useState(false)
  const [showAlerts, setShowAlerts] = useState(false)
  const [alerts, setAlerts] = useState<CryptoAlert[]>([])
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [staging, setStaging] = useState(false)
  const [stageError, setStageError] = useState<string | null>(null)

  // Patch may be a function so callers that derive from current prefs (opening a
  // tab, editing a list) read the latest state. Passing a plain object built from
  // a captured `prefs` loses updates when two of them land in the same tick —
  // clicking two rail rows quickly used to open only one tab.
  const update = useCallback((patch: Partial<MarketPrefs> | ((prev: MarketPrefs) => Partial<MarketPrefs>)) => {
    setPrefs((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      savePrefs(next)
      return next
    })
  }, [])

  // Alerts live on the server; poll so fires show up without a manual refresh.
  const reloadAlerts = useCallback(() => { fetchAlerts().then(setAlerts).catch(() => {}) }, [])
  useEffect(() => {
    reloadAlerts()
    const id = setInterval(reloadAlerts, 15_000)
    return () => clearInterval(id)
  }, [reloadAlerts])

  // A symbol arriving from OVERVIEW opens as a tab and takes focus.
  useEffect(() => {
    if (!focusSymbol) return
    setFocus(focusSymbol)
    setPrefs((prev) => {
      if (prev.tabs.includes(focusSymbol)) return prev
      const next = { ...prev, tabs: [...prev.tabs, focusSymbol].slice(-8) }
      savePrefs(next)
      return next
    })
  }, [focusSymbol])

  const usdTickers = useMemo(() => snap.tickers.filter((t) => t.symbol.endsWith('USD')), [snap.tickers])
  const tickerMap = useMemo(() => new Map(usdTickers.map((t) => [t.symbol, t])), [usdTickers])
  const signalMap = useMemo(() => new Map(snap.signals.map((s) => [s.symbol, s])), [snap.signals])
  const heldSymbols = useMemo(
    () => new Set(snap.holdings.filter((h) => Number(h.amount) > 0).map((h) => `${h.currency}USD`)),
    [snap.holdings])
  const orderSymbols = useMemo(
    () => new Set((snap.openOrders ?? []).map((o) => o.symbol)), [snap.openOrders])

  // ── Watchlists ─────────────────────────────────────────────────────────────
  const activeSymbols = useMemo((): string[] => {
    const id = prefs.activeListId
    if (id === 'auto:movers') {
      return [...usdTickers].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 12).map((t) => t.symbol)
    }
    if (id === 'auto:holdings') {
      return [...heldSymbols].filter((s) => tickerMap.has(s))
        .sort((a, b) => {
          const va = Number(snap.holdings.find((h) => `${h.currency}USD` === a)?.amount ?? 0) * Number(tickerMap.get(a)?.last ?? 0)
          const vb = Number(snap.holdings.find((h) => `${h.currency}USD` === b)?.amount ?? 0) * Number(tickerMap.get(b)?.last ?? 0)
          return vb - va
        })
    }
    return prefs.lists.find((l) => l.id === id)?.symbols ?? []
  }, [prefs.activeListId, prefs.lists, usdTickers, heldSymbols, tickerMap, snap.holdings])

  const rows = useMemo(() => activeSymbols
    .map((s) => tickerMap.get(s))
    .filter((t): t is Ticker => !!t)
    .filter((t) => !filter || t.symbol.toLowerCase().includes(filter.toLowerCase())),
    [activeSymbols, tickerMap, filter])

  const activeList = prefs.lists.find((l) => l.id === prefs.activeListId)
  const inActiveList = (symbol: string) => !!activeList?.symbols.includes(symbol)

  const toggleInList = (symbol: string) => {
    if (!activeList) return
    const has = activeList.symbols.includes(symbol)
    update({
      lists: prefs.lists.map((l) => l.id !== activeList.id ? l : {
        ...l, symbols: has ? l.symbols.filter((s) => s !== symbol) : [...l.symbols, symbol],
      }),
    })
  }

  const newList = () => {
    const name = window.prompt('New watchlist name:', 'WATCH')?.trim().toUpperCase()
    if (!name) return
    const list: Watchlist = { id: `list_${Date.now().toString(36)}`, name, symbols: [] }
    update({ lists: [...prefs.lists, list], activeListId: list.id })
  }

  const deleteList = (id: string) => {
    const list = prefs.lists.find((l) => l.id === id)
    if (!list) return
    if (prefs.lists.length === 1) { alert('Keep at least one watchlist.'); return }
    if (!confirm(`Delete watchlist ${list.name}?`)) return
    const remaining = prefs.lists.filter((l) => l.id !== id)
    update({ lists: remaining, activeListId: remaining[0]!.id })
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  const openTab = (symbol: string) => {
    setFocus(symbol)
    update((prev) => prev.tabs.includes(symbol) ? prev : { tabs: [...prev.tabs, symbol].slice(-8) })
  }
  const closeTab = (symbol: string) => {
    update((prev) => {
      const tabs = prev.tabs.filter((s) => s !== symbol)
      return { tabs: tabs.length ? tabs : [symbol] }
    })
    if (focus === symbol) {
      const rest = prefs.tabs.filter((s) => s !== symbol)
      if (rest.length) setFocus(rest[0]!)
    }
  }

  // Which symbols each layout puts on screen.
  const gridSymbols = useMemo((): string[] => {
    const others = prefs.tabs.filter((s) => s !== focus)
    if (prefs.layout === 'split') return [focus, ...others.slice(0, 2)]
    if (prefs.layout === 'quad') return [focus, ...others.slice(0, 3)]
    return [focus]
  }, [prefs.layout, prefs.tabs, focus])

  // ── Click-to-trade ─────────────────────────────────────────────────────────
  const focusTicker = tickerMap.get(focus)
  const lastPrice = focusTicker ? Number(focusTicker.last) : 0

  // Discard a half-built ticket when the focused symbol changes. A price picked on
  // the BTC chart is meaningless on SOL, and leaving it up meant the STAGE button
  // would have submitted a SOL limit at a BTC price.
  useEffect(() => { setTicket(null); setStageError(null) }, [focus])

  const onPickPrice = useCallback((price: number, side: 'buy' | 'sell') => {
    setStageError(null)
    setTicket((prev) => ({ side, price, usd: prev?.usd ?? 20 }))
  }, [])

  const nudge = (pct: number) => setTicket((t) => t ? { ...t, price: t.price * (1 + pct / 100) } : t)

  const stageFromTicket = async () => {
    if (!ticket || !(ticket.price > 0)) return
    setStaging(true); setStageError(null)
    const amount = (ticket.usd / ticket.price).toFixed(8)
    const result = await stageTrade({
      symbol: focus, side: ticket.side, type: 'limit',
      amount, price: ticket.price.toFixed(price_decimals(ticket.price)),
      reason: `Chart ${ticket.side} at ${fmtPrice(ticket.price)} ($${ticket.usd}) — set by clicking the ${focus} chart`,
    })
    setStaging(false)
    if (!result.ok) { setStageError(result.error ?? 'stage failed'); return }
    setTicket(null)
    onStaged()
  }

  // Pending proposals for this symbol are what the chart draws as drafts — real
  // queue state, not a local echo, so the lines disappear when you confirm or
  // dismiss in TRADES.
  const drafts = useMemo((): ChartDraft[] => snap.pending
    .filter((p: PendingTrade) => p.symbol === focus && p.price)
    .map((p) => ({
      id: p.id, side: p.side, price: Number(p.price),
      usd: Math.round(Number(p.amount) * Number(p.price)),
    })), [snap.pending, focus])

  const focusIndicators = indicatorsFor(prefs, focus)
  const setIndicators = (ids: IndicatorId[]) =>
    update({ indicators: { ...prefs.indicators, [focus]: ids } })
  const toggleIndicator = (id: IndicatorId) => setIndicators(
    focusIndicators.includes(id) ? focusIndicators.filter((x) => x !== id) : [...focusIndicators, id])

  const armedFor = (symbol: string) => alerts.filter((a) => a.symbol === symbol && a.armed).length

  const chartFor = (symbol: string, compact: boolean) => {
    const t = tickerMap.get(symbol)
    const holding = snap.holdings.find((h) => `${h.currency}USD` === symbol)
    return (
      <TradingChart
        symbol={symbol}
        tf={tf}
        lastPrice={t ? Number(t.last) : 0}
        indicators={compact ? indicatorsFor(prefs, symbol).filter((i) => i !== 'pivots') : focusIndicators}
        signal={signalMap.get(symbol)}
        costBasis={holding?.costBasis}
        positionAmount={holding ? Number(holding.amount) : 0}
        trades={(snap.tradeHistory ?? []).filter((x) => x.symbol === symbol)}
        openOrders={(snap.openOrders ?? []).filter((o) => o.symbol === symbol)}
        alerts={alerts.filter((a) => a.symbol === symbol)}
        drafts={symbol === focus ? drafts : []}
        onPickPrice={symbol === focus ? onPickPrice : undefined}
        compact={compact}
      />
    )
  }

  const focusSignal = signalMap.get(focus)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '212px 1fr', height: '100%', overflow: 'hidden', position: 'relative' }}>
      {/* ── Watchlist rail ── */}
      <div style={{ borderRight: BORDER, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 7, borderBottom: BORDER, display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
          {prefs.lists.map((l) => (
            <div key={l.id} onClick={() => update({ activeListId: l.id })}
              onDoubleClick={() => deleteList(l.id)}
              title="Double-click to delete this list"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px', cursor: 'pointer',
                borderLeft: `2px solid ${prefs.activeListId === l.id ? G : 'transparent'}`,
                background: prefs.activeListId === l.id ? 'var(--bg-elev)' : 'transparent',
                ...MONO, fontSize: 11, letterSpacing: 1,
                color: prefs.activeListId === l.id ? 'var(--green-soft)' : GD,
              }}>
              <span>◈</span>{l.name}
              <div style={{ flex: 1 }} />
              <Lbl size={9}>{l.symbols.length}</Lbl>
            </div>
          ))}
          {AUTO_LISTS.map((l) => (
            <div key={l.id} onClick={() => update({ activeListId: l.id })} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px', cursor: 'pointer',
              borderLeft: `2px solid ${prefs.activeListId === l.id ? G : 'transparent'}`,
              background: prefs.activeListId === l.id ? 'var(--bg-elev)' : 'transparent',
              ...MONO, fontSize: 11, letterSpacing: 1,
              color: prefs.activeListId === l.id ? 'var(--green-soft)' : GD,
            }}>
              <span>◬</span>{l.name}
              <span style={{ fontSize: 8, color: AMBER, letterSpacing: 0.5 }}>AUTO</span>
            </div>
          ))}
          <div onClick={newList} style={{
            ...MONO, fontSize: 9, letterSpacing: 1.5, color: GD, textAlign: 'center',
            padding: '3px 0', border: '0.5px dashed var(--border-strong)', cursor: 'pointer', marginTop: 3,
          }}>+ NEW LIST</div>
        </div>

        <div style={{ padding: 6, flexShrink: 0 }}>
          <input placeholder="FILTER…" value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ width: '100%', background: 'transparent', border: BORDER, color: G, fontSize: 12, padding: '3px 6px', ...MONO, outline: 'none', boxSizing: 'border-box' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '14px 44px 1fr 46px 16px', gap: 4, padding: '2px 7px', borderBottom: BORDER, flexShrink: 0 }}>
          {['', 'PAIR', 'PRICE', '24H', 'S'].map((h, i) => <Lbl key={i} size={9}>{h}</Lbl>)}
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {rows.length === 0 && (
            <div style={{ padding: 10 }}>
              <Lbl size={10}>
                {isAutoList(prefs.activeListId) ? 'Nothing matches yet.' : 'Empty list — open a pair and tap ☆ to add it.'}
              </Lbl>
            </div>
          )}
          {rows.map((t) => {
            const sig = signalMap.get(t.symbol)
            const held = heldSymbols.has(t.symbol)
            const resting = orderSymbols.has(t.symbol)
            const armed = armedFor(t.symbol)
            return (
              <div key={t.symbol}
                onClick={() => openTab(t.symbol)}
                style={{
                  padding: '4px 7px', cursor: 'pointer',
                  background: focus === t.symbol ? 'var(--bg-elev)' : 'transparent',
                  borderLeft: `2px solid ${focus === t.symbol ? G : 'transparent'}`,
                }}>
                <div style={{ display: 'grid', gridTemplateColumns: '14px 44px 1fr 46px 16px', gap: 4, alignItems: 'center' }}>
                  <span onClick={(e) => { e.stopPropagation(); toggleInList(t.symbol) }}
                    title={activeList ? (inActiveList(t.symbol) ? `Remove from ${activeList.name}` : `Add to ${activeList.name}`) : 'Switch to a custom list to pin'}
                    style={{ ...MONO, fontSize: 10, color: inActiveList(t.symbol) ? AMBER : GD, cursor: 'pointer' }}>
                    {inActiveList(t.symbol) ? '★' : '☆'}
                  </span>
                  <span style={{ ...MONO, fontSize: 12, color: 'var(--green-soft)' }}>{t.symbol.replace(/USD$/, '')}</span>
                  <span style={{ ...MONO, fontSize: 11, color: GD, textAlign: 'right' }}>{fmtPrice(t.last)}</span>
                  <span style={{ ...MONO, fontSize: 11, color: changeColor(t.change), textAlign: 'right' }}>
                    {t.change > 0 ? '+' : ''}{t.change}%
                  </span>
                  <span style={{ ...MONO, fontSize: 10, color: sig ? dirColor(sig.direction) : GD, textAlign: 'center' }}>
                    {sig?.seeded ? sig.direction[0] : '·'}
                  </span>
                </div>
                {(held || resting || armed > 0) && (
                  <div style={{ display: 'flex', gap: 6, paddingLeft: 18, marginTop: 1 }}>
                    {held && <Lbl size={8}>● HELD</Lbl>}
                    {resting && <span style={{ ...MONO, fontSize: 8, color: 'var(--blue)' }}>◇ ORDER</span>}
                    {armed > 0 && <span style={{ ...MONO, fontSize: 8, color: AMBER }}>⚑ {armed}</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Chart workspace ── */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* symbol tabs + layout */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '5px 8px 0', borderBottom: BORDER, flexShrink: 0, flexWrap: 'wrap' }}>
          {prefs.tabs.map((s) => {
            const t = tickerMap.get(s)
            const on = focus === s
            return (
              <div key={s} onClick={() => setFocus(s)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', cursor: 'pointer',
                // Sides set individually rather than `border` + `borderBottom: none`:
                // mixing the shorthand with a longhand override makes React warn and
                // can leave the two out of sync across re-renders.
                borderTop: `0.5px solid ${on ? G : 'var(--border)'}`,
                borderLeft: `0.5px solid ${on ? G : 'var(--border)'}`,
                borderRight: `0.5px solid ${on ? G : 'var(--border)'}`,
                background: on ? 'var(--bg-elev)' : 'transparent',
                ...MONO, fontSize: 11, letterSpacing: 1, color: on ? 'var(--green-soft)' : GD,
              }}>
                <span style={{ color: t ? changeColor(t.change) : GD }}>●</span>
                {s.replace(/USD$/, '')}
                <span onClick={(e) => { e.stopPropagation(); closeTab(s) }} style={{ fontSize: 10, color: GD }}>✕</span>
              </div>
            )
          })}
          <div style={{ flex: 1 }} />
          {LAYOUTS.map((l) => (
            <button key={l.id} onClick={() => update({ layout: l.id })} title={l.title} style={{
              ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 9px', alignSelf: 'center',
              background: prefs.layout === l.id ? 'var(--bg-elev)' : 'transparent',
              border: `0.5px solid ${prefs.layout === l.id ? G : 'var(--border)'}`,
              color: prefs.layout === l.id ? G : GD, cursor: 'pointer',
            }}>{l.label}</button>
          ))}
        </div>

        {/* timeframe + indicator/alert controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderBottom: BORDER, flexShrink: 0, flexWrap: 'wrap' }}>
          {TFS.map((t) => (
            <button key={t} onClick={() => setTf(t)} style={{
              ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 8px',
              background: tf === t ? 'var(--bg-elev)' : 'transparent',
              border: `0.5px solid ${tf === t ? G : 'var(--border)'}`,
              color: tf === t ? G : GD, cursor: 'pointer',
            }}>{t.toUpperCase()}</button>
          ))}
          <div style={{ width: 8 }} />
          <button onClick={() => setShowIndicators(true)} style={{
            ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 10px',
            background: 'var(--bg-elev)', border: `0.5px solid ${G}`, color: G, cursor: 'pointer',
          }}>◫ INDICATORS · {focusIndicators.length}</button>
          <button onClick={() => setShowAlerts(true)} style={{
            ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 10px',
            background: 'transparent', border: `0.5px solid ${AMBER}`, color: AMBER, cursor: 'pointer',
          }}>⚑ ALERTS · {armedFor(focus)}</button>
          {/* active indicator chips — what's drawn, without opening the modal */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {focusIndicators.slice(0, 6).map((id) => (
              <span key={id} style={{ ...MONO, fontSize: 9, letterSpacing: 0.5, padding: '1px 6px', border: BORDER, color: GD }}>
                {INDICATORS.find((m) => m.id === id)?.label.split(' ')[0]}
              </span>
            ))}
            {focusIndicators.length > 6 && <span style={{ ...MONO, fontSize: 9, color: GD }}>+{focusIndicators.length - 6}</span>}
          </div>
          <div style={{ flex: 1 }} />
          <Lbl size={9}>CLICK THE CHART → SET ENTRY / EXIT</Lbl>
        </div>

        {/* charts */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
          {prefs.layout === 'matrix' ? (
            <MatrixView rows={rows} signalMap={signalMap} heldSymbols={heldSymbols}
              onOpen={(s) => { openTab(s); update({ layout: 'single' }) }} />
          ) : prefs.layout === 'compare' ? (
            <CompareChart symbols={prefs.tabs} tf={tf} tickerMap={tickerMap} />
          ) : (
            <div style={{
              flex: 1, minWidth: 0, display: 'grid', gap: 1, background: 'var(--border)',
              gridTemplateColumns: prefs.layout === 'quad' ? '1fr 1fr' : prefs.layout === 'split' ? '1fr 300px' : '1fr',
              gridTemplateRows: prefs.layout === 'quad' ? '1fr 1fr' : '1fr',
            }}>
              {prefs.layout === 'split' ? (
                <>
                  <ChartCell symbol={focus} focused ticker={tickerMap.get(focus)} signal={signalMap.get(focus)}
                    onFocus={() => setFocus(focus)} onClose={() => closeTab(focus)}>
                    {chartFor(focus, false)}
                  </ChartCell>
                  <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 1, background: 'var(--border)', minHeight: 0 }}>
                    {gridSymbols.slice(1).map((s) => (
                      <ChartCell key={s} symbol={s} ticker={tickerMap.get(s)} signal={signalMap.get(s)}
                        onFocus={() => setFocus(s)} onClose={() => closeTab(s)}>
                        {chartFor(s, true)}
                      </ChartCell>
                    ))}
                    {gridSymbols.length < 2 && <EmptyCell />}
                    {gridSymbols.length < 3 && <EmptyCell />}
                  </div>
                </>
              ) : (
                <>
                  {gridSymbols.map((s) => (
                    <ChartCell key={s} symbol={s} focused={s === focus} ticker={tickerMap.get(s)} signal={signalMap.get(s)}
                      onFocus={() => setFocus(s)} onClose={() => closeTab(s)}>
                      {chartFor(s, prefs.layout === 'quad' && s !== focus)}
                    </ChartCell>
                  ))}
                  {prefs.layout === 'quad' && Array.from({ length: Math.max(0, 4 - gridSymbols.length) })
                    .map((_, i) => <EmptyCell key={`e${i}`} />)}
                </>
              )}
            </div>
          )}

          {/* order ticket — appears when you click a price on the focused chart */}
          {ticket && (
            <div style={{
              position: 'absolute', right: 12, top: 12, width: 190, zIndex: 20,
              background: 'var(--bg-elev)', border: `1px solid ${ticket.side === 'buy' ? G : CR}`,
              padding: 10, display: 'flex', flexDirection: 'column', gap: 7,
            }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <Lbl size={9}>ORDER TICKET · FROM CHART</Lbl>
                <div style={{ flex: 1 }} />
                <span onClick={() => setTicket(null)} style={{ ...MONO, fontSize: 11, color: GD, cursor: 'pointer' }}>✕</span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['buy', 'sell'] as const).map((s) => (
                  <span key={s} onClick={() => setTicket({ ...ticket, side: s })} style={{
                    flex: 1, textAlign: 'center', ...MONO, fontSize: 10, letterSpacing: 2, padding: '3px 0', cursor: 'pointer',
                    border: `0.5px solid ${ticket.side === s ? (s === 'buy' ? G : CR) : 'var(--border)'}`,
                    color: ticket.side === s ? (s === 'buy' ? G : CR) : GD,
                    background: ticket.side === s ? 'var(--bg-panel)' : 'transparent',
                  }}>{s.toUpperCase()}</span>
                ))}
              </div>
              <div style={{ ...MONO, fontSize: 17, color: 'var(--green-soft)' }}>{fmtPrice(ticket.price)}</div>
              <div style={{ ...MONO, fontSize: 9, color: GD }}>
                {lastPrice > 0 && `${(((ticket.price - lastPrice) / lastPrice) * 100).toFixed(2)}% vs last`}
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                {[-0.5, -0.1, 0.1, 0.5].map((p) => (
                  <span key={p} onClick={() => nudge(p)} style={{
                    ...MONO, fontSize: 9, padding: '2px 5px', border: BORDER, color: GD, cursor: 'pointer', flex: 1, textAlign: 'center',
                  }}>{p > 0 ? '+' : ''}{p}%</span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                {SIZE_CHIPS.map((v) => (
                  <span key={v} onClick={() => setTicket({ ...ticket, usd: v })} style={{
                    ...MONO, fontSize: 9, padding: '2px 6px', flex: 1, textAlign: 'center', cursor: 'pointer',
                    border: `0.5px solid ${ticket.usd === v ? G : 'var(--border)'}`, color: ticket.usd === v ? G : GD,
                  }}>${v}</span>
                ))}
              </div>
              <div style={{ ...MONO, fontSize: 9, color: GD }}>
                ≈ {fmtNum(ticket.usd / (ticket.price || 1), 6)} {focus.replace(/USD$/, '')}
              </div>
              <button onClick={() => void stageFromTicket()} disabled={staging} style={{
                ...MONO, fontSize: 10, letterSpacing: 1.5, padding: '6px 0', border: 'none',
                background: ticket.side === 'buy' ? G : CR, color: 'var(--bg)',
                cursor: staging ? 'default' : 'pointer', opacity: staging ? 0.6 : 1,
              }}>
                {staging ? 'STAGING…' : `⇢ STAGE LIMIT ${ticket.side.toUpperCase()}`}
              </button>
              {stageError && <span style={{ ...MONO, fontSize: 9, color: CR }}>{stageError}</span>}
              <Lbl size={8}>CONFIRM-FIRST → WAITS IN TRADES</Lbl>
            </div>
          )}
        </div>

        {/* signal drawer */}
        <div style={{
          borderTop: BORDER, background: 'var(--bg-elev)', flexShrink: 0,
          padding: '6px 12px', display: 'flex', gap: 20, alignItems: 'center', overflowX: 'auto',
        }}>
          <div>
            <Lbl size={9}>FOCUSED · {focus.replace(/USD$/, '')}</Lbl>
            <div style={{ ...MONO, fontSize: 15, letterSpacing: 2, color: focusSignal ? dirColor(focusSignal.direction) : GD }}>
              {focusSignal?.seeded ? focusSignal.direction : 'SEEDING'}
            </div>
          </div>
          {focusSignal?.seeded && (
            <>
              <div>
                <Lbl size={9}>
                  ENTRY <span style={{ color: qualColor(focusSignal.entryQuality) }}>{focusSignal.entryQuality}</span>
                  {' '}· CONFLUENCE {focusSignal.confluence}/{focusSignal.timeframes.length} · STR {focusSignal.strength}
                </Lbl>
                <div style={{ height: 4, width: 150, background: 'var(--bg-panel)', marginTop: 3 }}>
                  <div style={{ width: `${focusSignal.strength}%`, height: '100%', background: dirColor(focusSignal.direction) }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 5 }}>
                {focusSignal.timeframes.map((t) => (
                  <span key={t.tf} style={{
                    ...MONO, fontSize: 9, letterSpacing: 0.5, padding: '2px 6px',
                    border: `0.5px solid ${dirColor(t.direction)}55`, color: dirColor(t.direction),
                  }}>{t.tf.toUpperCase()} {t.direction} {t.strength}</span>
                ))}
              </div>
            </>
          )}
          <div style={{ flex: 1 }} />
          <Lbl size={9}>{snap.pending.length} AWAITING CONFIRM</Lbl>
        </div>
      </div>

      {showIndicators && (
        <IndicatorModal
          symbol={focus}
          active={focusIndicators}
          onToggle={toggleIndicator}
          onPreset={setIndicators}
          onClose={() => setShowIndicators(false)}
        />
      )}
      {showAlerts && (
        <AlertModal
          symbol={focus}
          tf={tf}
          alerts={alerts}
          seedPrice={lastPrice}
          onChanged={reloadAlerts}
          onClose={() => setShowAlerts(false)}
        />
      )}
    </div>
  )
}

/** Limit prices need enough precision for sub-dollar pairs but Gemini rejects
 *  over-precise prices on large ones; mirror the display tiers. */
function price_decimals(p: number): number {
  if (p >= 10000) return 2
  if (p >= 1) return 4
  return 8
}

function ChartCell({ symbol, ticker, signal, focused, onFocus, onClose, children }: {
  symbol: string
  ticker?: Ticker
  signal?: Signal
  focused?: boolean
  onFocus: () => void
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div onClick={onFocus} style={{
      background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0,
      outline: focused ? `1px solid ${G}` : 'none', outlineOffset: -1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px', borderBottom: BORDER, flexShrink: 0 }}>
        <span style={{ ...MONO, fontSize: 12, letterSpacing: 1, color: 'var(--green-soft)' }}>{symbol.replace(/USD$/, '')}</span>
        {ticker && (
          <span style={{ ...MONO, fontSize: 11, color: changeColor(ticker.change) }}>
            {fmtPrice(ticker.last)} {ticker.change > 0 ? '+' : ''}{ticker.change}%
          </span>
        )}
        {signal?.seeded && (
          <span style={{ ...MONO, fontSize: 9, color: dirColor(signal.direction) }}>
            {signal.direction} · {signal.entryQuality}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span onClick={(e) => { e.stopPropagation(); onClose() }} style={{ ...MONO, fontSize: 10, color: GD, cursor: 'pointer' }}>✕</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  )
}

function EmptyCell() {
  return (
    <div style={{ background: 'var(--bg-panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Lbl size={10}>OPEN A PAIR FROM THE LIST</Lbl>
    </div>
  )
}

/** Density view: the active list as one scannable table. */
function MatrixView({ rows, signalMap, heldSymbols, onOpen }: {
  rows: Ticker[]
  signalMap: Map<string, Signal>
  heldSymbols: Set<string>
  onOpen: (symbol: string) => void
}) {
  const [sort, setSort] = useState<'change' | 'signal' | 'volume'>('signal')
  const qOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INSUFFICIENT_DATA: 3 }

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    if (sort === 'change') return Math.abs(b.change) - Math.abs(a.change)
    if (sort === 'volume') return Number(b.volume ?? 0) - Number(a.volume ?? 0)
    const sa = signalMap.get(a.symbol), sb = signalMap.get(b.symbol)
    const qa = sa?.seeded ? qOrder[sa.entryQuality] ?? 9 : 9
    const qb = sb?.seeded ? qOrder[sb.entryQuality] ?? 9 : 9
    return qa - qb || (sb?.strength ?? 0) - (sa?.strength ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, sort, signalMap])

  const cols = '58px 92px 78px 64px 74px 60px 1fr'
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '5px 12px', borderBottom: BORDER, flexShrink: 0 }}>
        <Lbl size={9}>SORT</Lbl>
        {(['signal', 'change', 'volume'] as const).map((s) => (
          <button key={s} onClick={() => setSort(s)} style={{
            ...MONO, fontSize: 9, letterSpacing: 1, padding: '2px 8px',
            background: sort === s ? 'var(--bg-elev)' : 'transparent',
            border: `0.5px solid ${sort === s ? G : 'var(--border)'}`, color: sort === s ? G : GD, cursor: 'pointer',
          }}>{s.toUpperCase()}</button>
        ))}
        <div style={{ flex: 1 }} />
        <Lbl size={9}>CLICK A ROW TO OPEN ITS CHART</Lbl>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '5px 12px', borderBottom: BORDER, flexShrink: 0 }}>
        {['PAIR', 'PRICE', '24H', 'SIGNAL', 'CONFLUENCE', 'QUALITY', 'REASON'].map((h) => <Lbl key={h} size={9}>{h}</Lbl>)}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {sorted.map((t) => {
          const s = signalMap.get(t.symbol)
          const heat = Math.min(Math.abs(t.change) / 6, 1)
          return (
            <div key={t.symbol} onClick={() => onOpen(t.symbol)} style={{
              display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '5px 12px',
              borderBottom: '0.5px solid color-mix(in srgb, var(--border) 45%, transparent)',
              cursor: 'pointer', alignItems: 'center',
            }}>
              <span style={{ ...MONO, fontSize: 12, color: 'var(--green-soft)' }}>
                {heldSymbols.has(t.symbol) ? '● ' : ''}{t.symbol.replace(/USD$/, '')}
              </span>
              <span style={{ ...MONO, fontSize: 11, color: GD, textAlign: 'right' }}>{fmtPrice(t.last)}</span>
              <span style={{
                ...MONO, fontSize: 11, textAlign: 'center', color: changeColor(t.change),
                background: `color-mix(in srgb, ${t.change >= 0 ? 'var(--green)' : 'var(--crimson)'} ${Math.round(heat * 30 + 4)}%, transparent)`,
                padding: '1px 0',
              }}>{t.change > 0 ? '+' : ''}{t.change}%</span>
              <span style={{ ...MONO, fontSize: 11, color: s ? dirColor(s.direction) : GD }}>
                {s?.seeded ? s.direction : '—'}
              </span>
              {/* One block per timeframe the engine actually scored, not a fixed
                  three — signals carry up to six, so a hardcoded 3 capped a 6/6
                  reading at "all full" and threw away the distinction. */}
              <span style={{ display: 'flex', gap: 2 }} title={s ? `confluence ${s.confluence}/${s.timeframes.length}` : ''}>
                {Array.from({ length: s?.timeframes.length || 3 }).map((_, i) => (
                  <span key={i} style={{
                    width: 7, height: 8, display: 'block',
                    border: `0.5px solid ${GD}`,
                    background: (s?.confluence ?? 0) > i ? G : 'transparent',
                  }} />
                ))}
              </span>
              <span style={{ ...MONO, fontSize: 10, color: s?.seeded ? qualColor(s.entryQuality) : GD }}>
                {s?.seeded ? s.entryQuality : '···'}
              </span>
              <span style={{ ...MONO, fontSize: 10, color: GD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s?.reasons?.[0] ?? ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
