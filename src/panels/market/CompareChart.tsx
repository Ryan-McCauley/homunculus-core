// COMPARE mode: every open tab on one normalized %-change axis.
//
// Normalizing to "percent change since the left edge of the window" is the point —
// BTC at $62,000 and DOGE at $0.18 are not comparable in price space, but they are
// in relative-move space, which is what answers "is this an alt move or a market
// move". Each line starts at 0% on the left edge.

import { useState, useEffect, useRef } from 'react'
import type { Ticker } from '../../../shared/crypto'
import type { Candle } from '../../../shared/indicators'
import { fetchCandles } from '../../lib/cryptoApi'
import { G, GD, CR, MONO, BORDER, Lbl } from '../../lib/cryptoUi'
import type { TF } from '../../lib/cryptoUi'

/** Distinct, theme-aware line colours — categorical, so they must stay apart. */
const LINE_COLORS = [
  'var(--green)', 'var(--ind-band)', 'var(--ind-slow)', 'var(--amber)',
  'var(--blue)', 'var(--ind-rsi)', 'var(--holo)', 'var(--ind-fast)',
]

export function CompareChart({ symbols, tf, tickerMap }: {
  symbols: string[]
  tf: TF
  tickerMap: Map<string, Ticker>
}) {
  const [data, setData] = useState<Record<string, Candle[]>>({})
  const [loading, setLoading] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all(symbols.map((s) =>
      fetchCandles(s, tf).then((c) => [s, c as Candle[]] as const).catch(() => [s, [] as Candle[]] as const)
    )).then((pairs) => {
      if (!alive) return
      setData(Object.fromEntries(pairs))
      setLoading(false)
    })
    return () => { alive = false }
  }, [symbols, tf])

  const W = size.w || 600, H = size.h || 320
  const ML = 54, MR = 76, MT = 14, MB = 22
  const plotH = Math.max(40, H - MT - MB)
  const plotW = Math.max(1, W - ML - MR)

  // Align every series to the shortest loaded history so all lines share an x-axis.
  const loaded = symbols.map((s) => ({ symbol: s, candles: (data[s] ?? []).slice(-120) })).filter((d) => d.candles.length > 2)
  const n = loaded.length ? Math.min(...loaded.map((d) => d.candles.length)) : 0

  const seriesPct = loaded.map((d, k) => {
    const win = d.candles.slice(-n)
    const base = win[0]![4] || 1
    return {
      symbol: d.symbol,
      color: LINE_COLORS[k % LINE_COLORS.length]!,
      pts: win.map((c) => ((c[4] - base) / base) * 100),
    }
  })

  const allPct = seriesPct.flatMap((s) => s.pts)
  const lo = allPct.length ? Math.min(...allPct, 0) : -1
  const hi = allPct.length ? Math.max(...allPct, 0) : 1
  const pad = (hi - lo) * 0.08 || 1
  const yMin = lo - pad, yMax = hi + pad
  const py = (v: number) => MT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH
  const px = (i: number) => ML + (n <= 1 ? 0 : (i / (n - 1)) * plotW)

  const gridVals = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4)

  return (
    <div ref={boxRef} style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--bg-panel)' }}>
      {loading || !seriesPct.length ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', ...MONO, fontSize: 12, color: GD }}>
          {loading ? 'LOADING COMPARISON…' : 'OPEN TWO OR MORE PAIRS TO COMPARE'}
        </div>
      ) : (
        <>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
            {gridVals.map((v, i) => (
              <g key={i}>
                <line x1={ML} y1={py(v)} x2={W - MR} y2={py(v)}
                  stroke={Math.abs(v) < 1e-9 ? GD : 'var(--border)'} strokeWidth="0.5" />
                <text x={ML - 5} y={py(v) + 3} fontSize="9" fill={GD} textAnchor="end" fontFamily="var(--font-mono)">
                  {v > 0 ? '+' : ''}{v.toFixed(1)}%
                </text>
              </g>
            ))}
            {/* zero baseline: where every series starts */}
            <line x1={ML} y1={py(0)} x2={W - MR} y2={py(0)} stroke={GD} strokeWidth="0.8" strokeDasharray="4 3" />

            {seriesPct.map((s) => (
              <g key={s.symbol}>
                <path
                  d={s.pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')}
                  fill="none" stroke={s.color} strokeWidth="1.6" />
                <text x={W - MR + 4} y={py(s.pts[s.pts.length - 1]!) + 3} fontSize="10" fill={s.color} fontFamily="var(--font-mono)">
                  {s.symbol.replace(/USD$/, '')} {s.pts[s.pts.length - 1]! >= 0 ? '+' : ''}{s.pts[s.pts.length - 1]!.toFixed(2)}%
                </text>
              </g>
            ))}
          </svg>

          <div style={{
            position: 'absolute', top: 8, left: ML + 6, display: 'flex', flexDirection: 'column', gap: 2,
            padding: '4px 8px', background: 'var(--bg)', opacity: 0.9, border: BORDER, pointerEvents: 'none',
          }}>
            <Lbl size={9}>NORMALIZED % · WINDOW START = 0</Lbl>
            {seriesPct.map((s) => {
              const t = tickerMap.get(s.symbol)
              const move = s.pts[s.pts.length - 1]!
              return (
                <span key={s.symbol} style={{ ...MONO, fontSize: 10, color: s.color, display: 'flex', gap: 6 }}>
                  <span style={{ width: 14, height: 2, background: s.color, alignSelf: 'center' }} />
                  {s.symbol.replace(/USD$/, '')}
                  <span style={{ color: move >= 0 ? G : CR }}>{move >= 0 ? '+' : ''}{move.toFixed(2)}%</span>
                  {t && <span style={{ color: GD }}>24h {t.change > 0 ? '+' : ''}{t.change}%</span>}
                </span>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
