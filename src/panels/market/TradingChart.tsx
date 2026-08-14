// The MARKET trading chart: candles + any subset of the indicator catalog, with
// click-to-trade on the price pane.
//
// Geometry note: this chart measures its container and draws at exactly that pixel
// size (viewBox === element size), rather than using a fixed viewBox scaled to fit.
// That is deliberate — click-to-trade has to convert a mouse Y into a price, and
// with a letterboxed viewBox that conversion is silently wrong wherever the
// container's aspect ratio differs from the viewBox's. Here one SVG unit is one
// CSS pixel, so the price under the cursor is the price you get.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { Signal, GeminiOpenOrder, GeminiTrade } from '../../../shared/crypto'
import type { CryptoAlert } from '../../../shared/alerts'
import * as ind from '../../../shared/indicators'
import type { Candle } from '../../../shared/indicators'
import { fetchCandles } from '../../lib/cryptoApi'
import type { IndicatorId } from '../../lib/marketPrefs'
import { INDICATORS } from '../../lib/marketPrefs'
import { G, GD, CR, AMBER, BORDER, MONO, fmtPrice, fmtK, Lbl } from '../../lib/cryptoUi'
import type { TF } from '../../lib/cryptoUi'

/** A price level the user has staged from the chart but not yet confirmed. */
export interface ChartDraft {
  id: string
  side: 'buy' | 'sell'
  price: number
  usd: number
}

interface Props {
  symbol: string
  tf: TF
  lastPrice: number
  indicators: IndicatorId[]
  signal?: Signal
  costBasis?: number | null
  positionAmount?: number
  trades?: GeminiTrade[]
  openOrders?: GeminiOpenOrder[]
  alerts?: CryptoAlert[]
  drafts?: ChartDraft[]
  /** Click on the price pane. Side is inferred from the level vs last price:
   *  below market reads as an entry (buy), above as an exit (sell). */
  onPickPrice?: (price: number, side: 'buy' | 'sell') => void
  /** Compact mode drops the axes/legend for small multiples in the 4-up grid. */
  compact?: boolean
}

const PANE_H = 52
const PANE_GAP = 10

/** Colours per pane indicator — all tokens, so themes restyle them. */
const PANE_COLOR: Record<string, string> = {
  volume: 'var(--green-dim)',
  rsi: 'var(--ind-rsi)',
  macd: 'var(--ind-band)',
  stoch: 'var(--ind-fast)',
  atr: 'var(--amber)',
  adx: 'var(--ind-slow)',
  obv: 'var(--blue)',
  mfi: 'var(--holo)',
  cci: 'var(--ind-slow)',
}

export function TradingChart(props: Props) {
  const {
    symbol, tf, lastPrice, indicators, signal, costBasis, positionAmount,
    trades, openOrders, alerts, drafts, onPickPrice, compact,
  } = props

  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Measure the container so SVG units line up with CSS pixels (see file header).
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setCandles([])
    fetchCandles(symbol, tf)
      .then((data) => { if (alive) { setCandles(data as Candle[]); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    const pollMs = tf === '1m' ? 10_000 : tf === '5m' ? 20_000 : tf === '15m' ? 30_000
      : tf === '1hr' ? 120_000 : tf === '4hr' ? 300_000 : 600_000
    const timer = setInterval(() => {
      fetchCandles(symbol, tf).then((d) => { if (alive) setCandles(d as Candle[]) }).catch(() => {})
    }, pollMs)
    return () => { alive = false; clearInterval(timer) }
  }, [symbol, tf])

  const on = useCallback((id: IndicatorId) => indicators.includes(id), [indicators])
  const panes = useMemo(
    () => INDICATORS.filter((m) => m.kind === 'pane' && indicators.includes(m.id)).map((m) => m.id),
    [indicators])

  // ── Geometry ───────────────────────────────────────────────────────────────
  const W = size.w || 600
  const H = size.h || 320
  const ML = compact ? 6 : 62
  const MR = compact ? 6 : 62
  const MT = 8
  const MB = compact ? 6 : 20
  // Indicator panes shrink to share a capped slice of the chart rather than each
  // taking a fixed height: with 4+ panes selected a fixed 52px each left the price
  // pane smaller than the stack below it, which inverts what the chart is for.
  const paneH = panes.length
    ? Math.max(26, Math.min(PANE_H, (H * 0.42 - panes.length * PANE_GAP) / panes.length))
    : 0
  const paneStack = panes.length * (paneH + PANE_GAP)
  const priceH = Math.max(60, H - MT - MB - paneStack)

  const maxBars = compact ? 60 : 120
  const n = Math.min(candles.length, maxBars)
  const visible = candles.slice(-n)


  // Indicator series are computed over the FULL history then sliced to the visible
  // window, so the leftmost bar is warmed up rather than seeded from the window.
  const slice = <T,>(arr: T[]): T[] => arr.slice(candles.length - n)
  const allCloses = candles.map((c) => c[4])
  const series = useMemo(() => {
    if (!candles.length) return null
    const bb = ind.bollinger(allCloses, 20, 2)
    const kc = ind.keltner(candles, 20, 1.5)
    const st = ind.supertrend(candles, 10, 3)
    const md = ind.macd(allCloses)
    const sk = ind.stochastic(candles)
    const dx = ind.adx(candles, 14)
    return {
      ema9: slice(ind.ema(allCloses, 9)),
      ema21: slice(ind.ema(allCloses, 21)),
      sma50: slice(ind.sma(allCloses, 50)),
      sma200: slice(ind.sma(allCloses, 200)),
      bb: { upper: slice(bb.upper), lower: slice(bb.lower), middle: slice(bb.middle) },
      keltner: { upper: slice(kc.upper), lower: slice(kc.lower) },
      vwap: slice(ind.vwap(candles)),
      psar: slice(ind.psar(candles)),
      supertrend: { line: slice(st.line), dir: slice(st.dir) },
      pivots: ind.pivotLevels(candles),
      rsi: slice(ind.rsi(allCloses, 14)),
      macd: { macd: slice(md.macd), signal: slice(md.signal), histogram: slice(md.histogram) },
      stoch: { k: slice(sk.k), d: slice(sk.d) },
      atr: slice(ind.atr(candles, 14)),
      adx: { adx: slice(dx.adx), plusDi: slice(dx.plusDi), minusDi: slice(dx.minusDi) },
      obv: slice(ind.obv(candles)),
      mfi: slice(ind.mfi(candles, 14)),
      cci: slice(ind.cci(candles, 20)),
      volAvg: slice(ind.sma(candles.map((c) => c[5]), 20)),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, n])

  // ── Price scale ────────────────────────────────────────────────────────────
  let priceMin = visible.length ? Math.min(...visible.map((c) => c[3])) : lastPrice * 0.97
  let priceMax = visible.length ? Math.max(...visible.map((c) => c[2])) : lastPrice * 1.03
  const widen = (vals: (number | null)[]) => {
    const ok = vals.filter((v): v is number => v != null)
    if (!ok.length) return
    priceMin = Math.min(priceMin, ...ok)
    priceMax = Math.max(priceMax, ...ok)
  }
  if (series) {
    if (on('ema')) { widen(series.ema9); widen(series.ema21) }
    if (on('sma')) { widen(series.sma50); widen(series.sma200) }
    if (on('bb')) { widen(series.bb.upper); widen(series.bb.lower) }
    if (on('keltner')) { widen(series.keltner.upper); widen(series.keltner.lower) }
    if (on('vwap')) widen(series.vwap)
    if (on('supertrend')) widen(series.supertrend.line)
  }
  if (lastPrice) { priceMin = Math.min(priceMin, lastPrice); priceMax = Math.max(priceMax, lastPrice) }
  const padPx = (priceMax - priceMin) * 0.05
  priceMin -= padPx; priceMax += padPx
  const span = priceMax - priceMin || 1

  const py = (p: number) => MT + priceH - ((p - priceMin) / span) * priceH
  /** Inverse of py() — the mapping click-to-trade depends on. */
  const priceAtY = (y: number) => priceMin + ((MT + priceH - y) / priceH) * span

  const innerW = Math.max(1, W - ML - MR)
  const spacing = innerW / Math.max(n, 1)
  const cx = (i: number) => ML + (i + 0.5) * spacing
  const candleW = Math.max(1, spacing * 0.7)

  const linePath = (vals: (number | null)[], scaleY: (v: number) => number) => {
    let d = ''
    vals.forEach((v, i) => {
      if (v == null) return
      d += `${d === '' || vals[i - 1] == null ? 'M' : 'L'}${cx(i).toFixed(1)},${scaleY(v).toFixed(1)} `
    })
    return d.trim()
  }

  // ── Click-to-trade ─────────────────────────────────────────────────────────
  const inPricePane = (y: number) => y >= MT && y <= MT + priceH
  const localXY = (e: React.MouseEvent): { x: number; y: number } => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const ghostPrice = hover && inPricePane(hover.y) ? priceAtY(hover.y) : null
  const ghostSide: 'buy' | 'sell' = ghostPrice != null && ghostPrice < lastPrice ? 'buy' : 'sell'

  const handleMove = (e: React.MouseEvent) => {
    const { x, y } = localXY(e)
    const i = Math.floor((x - ML) / spacing)
    setHover({ i: i >= 0 && i < n ? i : -1, y })
  }
  const handleClick = (e: React.MouseEvent) => {
    if (!onPickPrice || !lastPrice) return
    const { y } = localXY(e)
    if (!inPricePane(y)) return
    const price = priceAtY(y)
    if (!(price > 0)) return
    onPickPrice(price, price < lastPrice ? 'buy' : 'sell')
  }

  const hc = hover && hover.i >= 0 && hover.i < visible.length ? visible[hover.i] : null

  // ── Overlay levels: cost basis, resting orders, alerts, drafts ─────────────
  const showPos = on('position')
  const hasCost = showPos && costBasis != null && costBasis > 0 && (positionAmount ?? 0) > 0
  const orderLevels = (showPos ? (openOrders ?? []) : []).map((o) => {
    const price = Number(o.type.includes('stop') && o.stopPrice ? o.stopPrice : o.price)
    return { side: o.side, price, isStop: o.type.includes('stop') }
  }).filter((o) => o.price > 0)

  // Only price-level alerts have a line to draw; an RSI-cross alert has no y.
  const alertLevels = (alerts ?? []).filter(
    (a) => a.armed && a.source === 'price' && a.value != null && (a.condition === 'above' || a.condition === 'below'))

  const fillMarkers = (() => {
    if (!showPos || !visible.length) return []
    const t0 = visible[0]![0]
    const barMs = visible.length >= 2 ? (visible[visible.length - 1]![0] - t0) / (visible.length - 1) : 0
    return (trades ?? []).map((t) => {
      if (t.timestampMs < t0 || !barMs) return null
      const i = Math.min(n - 1, Math.floor((t.timestampMs - t0) / barMs))
      return { x: cx(i), price: Number(t.price), side: t.side }
    }).filter((m): m is { x: number; price: number; side: 'buy' | 'sell' } => m !== null && m.price > 0)
  })()

  const yLabels = compact ? [] : Array.from({ length: 5 }, (_, i) => {
    const p = priceMin + span * (i / 4)
    return { y: py(p), label: fmtPrice(p) }
  })

  // ── Pane rendering ─────────────────────────────────────────────────────────
  function renderPane(id: IndicatorId, top: number) {
    if (!series) return null
    const bottom = top + paneH
    const color = PANE_COLOR[id] ?? GD
    const frame = (
      <>
        <line x1={ML} y1={bottom} x2={W - MR} y2={bottom} stroke="var(--border)" strokeWidth="0.5" />
        {!compact && <text x={ML + 2} y={top + 9} fontSize="8" fill={color} letterSpacing="1" fontFamily="var(--font-mono)">
          {INDICATORS.find((m) => m.id === id)?.label}
        </text>}
      </>
    )
    /** Scale a 0..100 oscillator into the pane. */
    const osc = (v: number) => bottom - (Math.max(0, Math.min(100, v)) / 100) * paneH
    /** Scale an unbounded series into the pane using its own visible range. */
    const auto = (vals: (number | null)[]) => {
      const ok = vals.filter((v): v is number => v != null)
      const lo = ok.length ? Math.min(...ok) : 0
      const hi = ok.length ? Math.max(...ok) : 1
      const range = hi - lo || 1
      return (v: number) => bottom - ((v - lo) / range) * paneH
    }

    switch (id) {
      case 'volume': {
        const maxVol = Math.max(...visible.map((c) => c[5]), 1)
        const vy = (v: number) => bottom - (v / maxVol) * paneH
        return (
          <g key={id}>
            {frame}
            {visible.map((c, i) => (
              <rect key={i} x={cx(i) - candleW / 2} y={vy(c[5])} width={candleW}
                height={Math.max(0.5, bottom - vy(c[5]))}
                fill={c[4] >= c[1] ? G : CR} opacity="0.4" />
            ))}
            <path d={linePath(series.volAvg, vy)} fill="none" stroke={AMBER} strokeWidth="1" opacity="0.8" />
          </g>
        )
      }
      case 'rsi':
        return (
          <g key={id}>
            {frame}
            <line x1={ML} y1={osc(70)} x2={W - MR} y2={osc(70)} stroke={CR} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <line x1={ML} y1={osc(30)} x2={W - MR} y2={osc(30)} stroke={G} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <path d={linePath(series.rsi, osc)} fill="none" stroke={color} strokeWidth="1.3" />
          </g>
        )
      case 'mfi':
        return (
          <g key={id}>
            {frame}
            <line x1={ML} y1={osc(80)} x2={W - MR} y2={osc(80)} stroke={CR} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <line x1={ML} y1={osc(20)} x2={W - MR} y2={osc(20)} stroke={G} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <path d={linePath(series.mfi, osc)} fill="none" stroke={color} strokeWidth="1.3" />
          </g>
        )
      case 'stoch':
        return (
          <g key={id}>
            {frame}
            <line x1={ML} y1={osc(80)} x2={W - MR} y2={osc(80)} stroke={CR} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <line x1={ML} y1={osc(20)} x2={W - MR} y2={osc(20)} stroke={G} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <path d={linePath(series.stoch.k, osc)} fill="none" stroke={color} strokeWidth="1.3" />
            <path d={linePath(series.stoch.d, osc)} fill="none" stroke={GD} strokeWidth="1" strokeDasharray="3 2" />
          </g>
        )
      case 'macd': {
        const sy = auto([...series.macd.macd, ...series.macd.signal, ...series.macd.histogram])
        const zero = sy(0)
        return (
          <g key={id}>
            {frame}
            <line x1={ML} y1={zero} x2={W - MR} y2={zero} stroke="var(--border)" strokeWidth="0.5" />
            {series.macd.histogram.map((v, i) => v == null ? null : (
              <rect key={i} x={cx(i) - candleW / 2} y={Math.min(zero, sy(v))} width={candleW}
                height={Math.max(0.5, Math.abs(sy(v) - zero))} fill={v >= 0 ? G : CR} opacity="0.45" />
            ))}
            <path d={linePath(series.macd.macd, sy)} fill="none" stroke={color} strokeWidth="1.2" />
            <path d={linePath(series.macd.signal, sy)} fill="none" stroke={AMBER} strokeWidth="1" strokeDasharray="3 2" />
          </g>
        )
      }
      case 'adx': {
        return (
          <g key={id}>
            {frame}
            <line x1={ML} y1={osc(25)} x2={W - MR} y2={osc(25)} stroke={AMBER} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.5" />
            <path d={linePath(series.adx.adx, osc)} fill="none" stroke={color} strokeWidth="1.4" />
            <path d={linePath(series.adx.plusDi, osc)} fill="none" stroke={G} strokeWidth="1" opacity="0.8" />
            <path d={linePath(series.adx.minusDi, osc)} fill="none" stroke={CR} strokeWidth="1" opacity="0.8" />
          </g>
        )
      }
      case 'atr':
        return <g key={id}>{frame}<path d={linePath(series.atr, auto(series.atr))} fill="none" stroke={color} strokeWidth="1.3" /></g>
      case 'obv':
        return <g key={id}>{frame}<path d={linePath(series.obv, auto(series.obv))} fill="none" stroke={color} strokeWidth="1.3" /></g>
      case 'cci': {
        const sy = auto(series.cci)
        return (
          <g key={id}>
            {frame}
            <line x1={ML} y1={sy(100)} x2={W - MR} y2={sy(100)} stroke={CR} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.45" />
            <line x1={ML} y1={sy(-100)} x2={W - MR} y2={sy(-100)} stroke={G} strokeWidth="0.5" strokeDasharray="2 3" opacity="0.45" />
            <path d={linePath(series.cci, sy)} fill="none" stroke={color} strokeWidth="1.3" />
          </g>
        )
      }
      default: return null
    }
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {(loading || !visible.length || !series) ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: GD, fontSize: 12, ...MONO }}>
          {loading ? 'LOADING CHART…' : 'NO CANDLE DATA YET'}
        </div>
      ) : (
        <>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
            {/* price grid */}
            {yLabels.map((l, i) => (
              <g key={i}>
                <line x1={ML} y1={l.y} x2={W - MR} y2={l.y} stroke="var(--border)" strokeWidth="0.5" />
                <text x={ML - 5} y={l.y + 3} fontSize="9" fill={GD} textAnchor="end" fontFamily="var(--font-mono)">{l.label}</text>
              </g>
            ))}

            {/* Bollinger band fill + rails */}
            {on('bb') && (
              <>
                <path d={`${linePath(series.bb.upper, py)} L ${[...series.bb.lower].map((v, i) => v == null ? '' : `${cx(i).toFixed(1)},${py(v).toFixed(1)}`).filter(Boolean).reverse().join(' L ')} Z`}
                  fill="var(--ind-band)" fillOpacity="0.05" stroke="none" />
                <path d={linePath(series.bb.upper, py)} fill="none" stroke="var(--ind-band)" strokeWidth="1" strokeDasharray="2 2" opacity="0.75" />
                <path d={linePath(series.bb.lower, py)} fill="none" stroke="var(--ind-band)" strokeWidth="1" strokeDasharray="2 2" opacity="0.75" />
              </>
            )}
            {on('keltner') && (
              <>
                <path d={linePath(series.keltner.upper, py)} fill="none" stroke="var(--holo)" strokeWidth="0.9" strokeDasharray="5 3" opacity="0.6" />
                <path d={linePath(series.keltner.lower, py)} fill="none" stroke="var(--holo)" strokeWidth="0.9" strokeDasharray="5 3" opacity="0.6" />
              </>
            )}

            {/* candles */}
            {visible.map((c, i) => {
              const up = c[4] >= c[1]
              const col = up ? G : CR
              const bodyTop = py(Math.max(c[1], c[4]))
              const bodyH = Math.max(1, Math.abs(py(c[1]) - py(c[4])))
              return (
                <g key={i}>
                  <line x1={cx(i)} y1={py(c[2])} x2={cx(i)} y2={py(c[3])} stroke={col} strokeWidth="1" />
                  <rect x={cx(i) - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={col} opacity="0.9" />
                </g>
              )
            })}

            {/* trend overlays, drawn over candles so they stay readable */}
            {on('ema') && <>
              <path d={linePath(series.ema9, py)} fill="none" stroke="var(--ind-fast)" strokeWidth="1.5" />
              <path d={linePath(series.ema21, py)} fill="none" stroke="var(--ind-slow)" strokeWidth="1.5" />
            </>}
            {on('sma') && <>
              <path d={linePath(series.sma50, py)} fill="none" stroke="var(--blue)" strokeWidth="1.3" />
              <path d={linePath(series.sma200, py)} fill="none" stroke="var(--holo)" strokeWidth="1.3" strokeDasharray="6 3" />
            </>}
            {on('vwap') && <path d={linePath(series.vwap, py)} fill="none" stroke="var(--ind-cost)" strokeWidth="1.2" strokeDasharray="4 2" opacity="0.85" />}
            {on('supertrend') && series.supertrend.line.map((v, i) => {
              if (v == null || series.supertrend.dir[i] == null) return null
              return <circle key={i} cx={cx(i)} cy={py(v)} r="1.3"
                fill={series.supertrend.dir[i] === 1 ? G : CR} opacity="0.85" />
            })}
            {on('psar') && series.psar.map((v, i) => v == null ? null : (
              <circle key={i} cx={cx(i)} cy={py(v)} r="1" fill={AMBER} opacity="0.75" />
            ))}
            {on('pivots') && series.pivots && ([
              ['R2', series.pivots.r2, CR], ['R1', series.pivots.r1, CR],
              ['P', series.pivots.pivot, AMBER],
              ['S1', series.pivots.s1, G], ['S2', series.pivots.s2, G],
            ] as [string, number, string][]).map(([label, price, col]) => {
              if (price < priceMin || price > priceMax) return null
              return (
                <g key={label}>
                  <line x1={ML} y1={py(price)} x2={W - MR} y2={py(price)} stroke={col} strokeWidth="0.5" strokeDasharray="1 4" opacity="0.6" />
                  {!compact && <text x={ML + 3} y={py(price) - 2} fontSize="8" fill={col} opacity="0.8" fontFamily="var(--font-mono)">{label}</text>}
                </g>
              )
            })}

            {/* position: cost basis + resting orders + historical fills */}
            {hasCost && (
              <g>
                <line x1={ML} y1={py(costBasis!)} x2={W - MR} y2={py(costBasis!)}
                  stroke="var(--ind-cost)" strokeWidth="1" strokeDasharray="5 3" />
                {!compact && <text x={W - MR - 3} y={py(costBasis!) - 3} fontSize="9" fill="var(--ind-cost)" textAnchor="end" fontFamily="var(--font-mono)">
                  COST {fmtPrice(costBasis!)}
                </text>}
              </g>
            )}
            {orderLevels.map((o, i) => {
              if (o.price < priceMin || o.price > priceMax) return null
              const col = o.side === 'buy' ? 'var(--blue)' : CR
              return (
                <g key={`o${i}`}>
                  <line x1={ML} y1={py(o.price)} x2={W - MR} y2={py(o.price)} stroke={col} strokeWidth="1" strokeDasharray="3 3" opacity="0.9" />
                  {!compact && <text x={W - MR - 3} y={py(o.price) - 3} fontSize="9" fill={col} textAnchor="end" fontFamily="var(--font-mono)">
                    ◇ {o.side.toUpperCase()} {fmtPrice(o.price)}{o.isStop ? ' STOP' : ''}
                  </text>}
                </g>
              )
            })}
            {fillMarkers.map((m, i) => (
              <polygon key={`f${i}`}
                points={m.side === 'buy'
                  ? `${m.x},${py(m.price) + 5} ${m.x - 3.5},${py(m.price) + 11} ${m.x + 3.5},${py(m.price) + 11}`
                  : `${m.x},${py(m.price) - 5} ${m.x - 3.5},${py(m.price) - 11} ${m.x + 3.5},${py(m.price) - 11}`}
                fill={m.side === 'buy' ? G : CR} opacity="0.9" />
            ))}

            {/* armed price alerts */}
            {alertLevels.map((a) => {
              const p = a.value!
              if (p < priceMin || p > priceMax) return null
              return (
                <g key={a.id}>
                  <line x1={ML} y1={py(p)} x2={W - MR} y2={py(p)} stroke={AMBER} strokeWidth="1" strokeDasharray="1 3" opacity="0.9" />
                  {!compact && <text x={ML + 4} y={py(p) - 3} fontSize="9" fill={AMBER} fontFamily="var(--font-mono)">⚑ {fmtPrice(p)}</text>}
                </g>
              )
            })}

            {/* drafts staged from the chart but not yet confirmed */}
            {(drafts ?? []).map((d) => {
              if (d.price < priceMin || d.price > priceMax) return null
              const col = d.side === 'buy' ? G : CR
              return (
                <g key={d.id}>
                  <line x1={ML} y1={py(d.price)} x2={W - MR} y2={py(d.price)} stroke={col} strokeWidth="1.2" />
                  {!compact && <text x={ML + 4} y={py(d.price) - 3} fontSize="9" fill={col} fontFamily="var(--font-mono)">
                    ◈ {d.side.toUpperCase()} {fmtPrice(d.price)} · ${d.usd}
                  </text>}
                </g>
              )
            })}

            {/* last price */}
            {lastPrice > 0 && (
              <g>
                <line x1={ML} y1={py(lastPrice)} x2={W - MR} y2={py(lastPrice)} stroke={G} strokeWidth="0.6" opacity="0.5" />
                {!compact && (
                  <>
                    <rect x={W - MR + 1} y={py(lastPrice) - 7} width={MR - 3} height={14} fill={G} opacity="0.9" rx="2" />
                    <text x={W - MR + 4} y={py(lastPrice) + 3} fontSize="9" fill="var(--bg)" fontFamily="var(--font-mono)">{fmtPrice(lastPrice)}</text>
                  </>
                )}
              </g>
            )}

            {/* ghost crosshair + price tag for click-to-trade */}
            {ghostPrice != null && onPickPrice && (
              <g pointerEvents="none">
                <line x1={ML} y1={hover!.y} x2={W - MR} y2={hover!.y}
                  stroke={ghostSide === 'buy' ? G : CR} strokeWidth="0.8" strokeDasharray="4 3" />
                <rect x={ML + 2} y={hover!.y - 15} width={190} height={13} rx="2"
                  fill="var(--bg-elev)" stroke={ghostSide === 'buy' ? G : CR} strokeWidth="0.5" />
                <text x={ML + 6} y={hover!.y - 5} fontSize="9" fill={ghostSide === 'buy' ? G : CR} fontFamily="var(--font-mono)">
                  {fmtPrice(ghostPrice)} · CLICK TO SET {ghostSide === 'buy' ? 'BUY ENTRY' : 'SELL EXIT'}
                </text>
              </g>
            )}

            {/* indicator panes */}
            {panes.map((id, k) => renderPane(id, MT + priceH + PANE_GAP + k * (paneH + PANE_GAP)))}
          </svg>

          {/* Mouse layer. Separate from the SVG so the cursor and hit-testing are
              plain DOM — the SVG is purely presentational. */}
          <div
            onMouseMove={handleMove}
            onMouseLeave={() => setHover(null)}
            onClick={handleClick}
            style={{
              position: 'absolute', inset: 0,
              cursor: onPickPrice ? 'crosshair' : 'default',
            }}
          />

          {/* hover readout */}
          {hc && !compact && (
            <div style={{
              position: 'absolute', top: 4, left: ML + 4, display: 'flex', gap: 9,
              padding: '2px 7px', background: 'var(--bg)', opacity: 0.9, border: BORDER,
              pointerEvents: 'none', ...MONO, fontSize: 11,
            }}>
              {([['O', hc[1]], ['H', hc[2]], ['L', hc[3]], ['C', hc[4]]] as [string, number][]).map(([k, v]) => (
                <span key={k}><Lbl size={10}>{k} </Lbl><span style={{ color: v >= hc[1] ? G : CR }}>{fmtPrice(v)}</span></span>
              ))}
              <span><Lbl size={10}>V </Lbl><span style={{ color: GD }}>{fmtK(hc[5])}</span></span>
              {signal && <span style={{ color: signal.direction === 'BUY' ? G : signal.direction === 'SELL' ? CR : GD }}>
                {signal.direction}
              </span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
