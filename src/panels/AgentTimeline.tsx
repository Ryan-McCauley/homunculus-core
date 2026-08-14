// The INTELLIGENCE tab's activity timeline: what ran, when, and what called what.
//
// A swimlane rather than a month grid, because these runs are short and bursty —
// a calendar cell would show "9 runs" where the interesting part is that seven of
// them fired in the same four minutes. Time runs left→right, one lane per
// component, and the arrows between lanes are calls: an agent staging a trade, a
// skill retuning its own settings, an alert firing into the trade engine.
//
// All of it is read, nothing is written. Runs come from agent_runs; the arrows
// are derived from the audit log, which already records actor + resource for
// every mutation — the same record read edge-first instead of node-first.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TIMELINE_WINDOWS } from '../../shared/timeline'
import type { TimelinePayload, TimelineWindowKey } from '../../shared/timeline'
import { fetchTimeline } from '../lib/cryptoApi'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const AM = 'var(--amber)'
const CR = 'var(--crimson)'
const BORDER = '0.5px solid var(--border)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

const LANE_H = 30
const LABEL_W = 132
const AXIS_H = 20
/** Breathing room at the right edge so "now" is not flush against the border,
 *  and arrows that bow outward at the newest moment still have somewhere to go. */
const RIGHT_PAD = 18
/** A run this short would render as a hairline; floor it so it stays clickable. */
const MIN_BAR_PX = 3

const KIND_COLOR: Record<string, string> = {
  agent: G, skill: '#4aa3df', system: AM, operator: '#b06fd0', service: GD,
}

function fmtClock(at: number, spanMs: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  // Over a day of span the hour alone is ambiguous, so date leads instead.
  if (spanMs > 36 * 60 * 60_000) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
  return `${hh}:${mm}`
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** Evenly spaced ticks across the window, at a granularity the span can carry. */
function axisTicks(since: number, until: number, count = 6): number[] {
  const step = (until - since) / count
  return Array.from({ length: count + 1 }, (_, i) => since + i * step)
}

export function AgentTimeline() {
  const [windowKey, setWindowKey] = useState<TimelineWindowKey>('24h')
  const [data, setData] = useState<TimelinePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showArrows, setShowArrows] = useState(true)
  /** Operator clicks are most of the traffic and are not what this view is for. */
  const [automationOnly, setAutomationOnly] = useState(true)
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)
  const [width, setWidth] = useState(900)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    const ms = TIMELINE_WINDOWS.find((w) => w.key === windowKey)?.ms ?? TIMELINE_WINDOWS[0].ms
    const until = Date.now()
    try {
      setData(await fetchTimeline(until - ms, until))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [windowKey])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    // Same cadence as the fleet poll, so a running bar grows while you watch it.
    const t = setInterval(() => void load(), 8000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [data !== null])

  const view = useMemo(() => {
    if (!data) return null
    const edges = (automationOnly ? data.edges.filter((e) => e.from !== 'operator') : data.edges)
    // Only lanes that carry something in the current filter — an empty lane is a
    // row of noise, and with operator traffic hidden several usually are.
    const active = new Set<string>([
      ...data.runs.map((r) => r.component),
      ...data.events.map((e) => e.component),
      ...edges.flatMap((e) => [e.from, e.to]),
    ])
    const components = data.components.filter((c) => active.has(c.id))
    const laneOf = new Map(components.map((c, i) => [c.id, i]))
    return { edges, components, laneOf }
  }, [data, automationOnly])

  if (error) {
    return (
      <div style={{ padding: 14 }}>
        <span style={{ ...MONO, fontSize: 13, color: CR }}>timeline unavailable — {error}</span>
      </div>
    )
  }
  if (!data || !view) {
    return <div style={{ padding: 14 }}><span style={{ ...MONO, fontSize: 13, color: GD }}>loading timeline…</span></div>
  }

  const { since, until } = data
  const span = Math.max(1, until - since)
  const plot = Math.max(40, width - RIGHT_PAD)
  const xOf = (t: number): number => ((t - since) / span) * plot
  const yOf = (lane: number): number => lane * LANE_H + LANE_H / 2
  const height = Math.max(view.components.length * LANE_H, LANE_H)

  const say = (e: React.MouseEvent, text: string) =>
    setHover({ x: e.clientX, y: e.clientY, text })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Controls ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: BORDER, flexWrap: 'wrap' }}>
        {TIMELINE_WINDOWS.map((w) => (
          <button key={w.key} onClick={() => setWindowKey(w.key)} style={{
            ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px', cursor: 'pointer',
            background: windowKey === w.key ? 'var(--bg-elev)' : 'transparent',
            border: BORDER, color: windowKey === w.key ? 'var(--green-soft)' : GD,
          }}>{w.label}</button>
        ))}
        <div style={{ width: 10 }} />
        <button onClick={() => setShowArrows((v) => !v)} style={{
          ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px', cursor: 'pointer',
          background: showArrows ? 'var(--bg-elev)' : 'transparent', border: BORDER,
          color: showArrows ? 'var(--green-soft)' : GD,
        }}>{showArrows ? '↗ CALLS ON' : '↗ CALLS OFF'}</button>
        <button onClick={() => setAutomationOnly((v) => !v)} style={{
          ...MONO, fontSize: 12, letterSpacing: 1, padding: '3px 10px', cursor: 'pointer',
          background: automationOnly ? 'var(--bg-elev)' : 'transparent', border: BORDER,
          color: automationOnly ? 'var(--green-soft)' : GD,
        }}>{automationOnly ? 'AUTOMATION ONLY' : 'INCLUDING OPERATOR'}</button>
        <div style={{ flex: 1 }} />
        <span style={{ ...MONO, fontSize: 12, color: GD }}>
          {data.runs.length} run{data.runs.length === 1 ? '' : 's'} · {view.edges.length} call{view.edges.length === 1 ? '' : 's'}
          {data.events.length ? ` · ${data.events.length} auto event${data.events.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {view.components.length === 0 ? (
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...MONO, fontSize: 13, color: GD }}>nothing ran in this window.</span>
          <span style={{ ...MONO, fontSize: 12, color: GD, opacity: 0.75 }}>
            Run history starts from when the timeline was added — earlier runs were never recorded.
          </span>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <div style={{ display: 'flex', minHeight: height + AXIS_H }}>
            {/* ── Lane labels ── */}
            <div style={{ width: LABEL_W, flexShrink: 0, borderRight: BORDER }}>
              {view.components.map((c) => (
                <div key={c.id} title={c.id} style={{
                  height: LANE_H, display: 'flex', alignItems: 'center', gap: 6,
                  padding: '0 8px', borderBottom: BORDER, overflow: 'hidden',
                }}>
                  <span style={{ width: 5, height: 5, background: KIND_COLOR[c.kind] ?? GD, flexShrink: 0 }} />
                  <span style={{
                    ...MONO, fontSize: 11, letterSpacing: 0.6, color: KIND_COLOR[c.kind] ?? GD,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{c.label}</span>
                </div>
              ))}
              <div style={{ height: AXIS_H }} />
            </div>

            {/* ── Track ── */}
            <div ref={trackRef} style={{ flex: 1, position: 'relative', minWidth: 240 }}>
              {view.components.map((_, i) => (
                <div key={i} style={{
                  position: 'absolute', left: 0, right: 0, top: i * LANE_H, height: LANE_H,
                  borderBottom: BORDER,
                  background: i % 2 ? 'transparent' : 'rgba(127,127,127,0.035)',
                }} />
              ))}

              {/* Gridlines + axis */}
              {axisTicks(since, until).map((t, i) => (
                <div key={i} style={{
                  position: 'absolute', left: xOf(t), top: 0, height,
                  borderLeft: '0.5px solid var(--border)', opacity: 0.5,
                }} />
              ))}

              {/* Runs */}
              {data.runs.map((r) => {
                const lane = view.laneOf.get(r.component)
                if (lane === undefined) return null
                const end = r.endedAt ?? Math.min(Date.now(), until)
                const x = xOf(Math.max(r.startedAt, since))
                const w = Math.max(MIN_BAR_PX, xOf(Math.min(end, until)) - x)
                const color = r.state === 'error' ? CR : r.state === 'running' ? AM : G
                return (
                  <div
                    key={r.id}
                    onMouseEnter={(e) => say(e, `${r.label} · ${r.trigger} · ${fmtClock(r.startedAt, span)}` +
                      ` · ${r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : 'running'}` +
                      `${r.summary ? ` — ${r.summary.slice(0, 120)}` : ''}`)}
                    onMouseLeave={() => setHover(null)}
                    style={{
                      position: 'absolute', left: x, top: lane * LANE_H + 7, width: w, height: LANE_H - 14,
                      background: color, opacity: r.state === 'running' ? 0.95 : 0.65,
                      border: `0.5px solid ${color}`, cursor: 'pointer',
                    }}
                  />
                )
              })}

              {/* Point events — the unattended paths, which have no duration */}
              {data.events.map((ev, i) => {
                const lane = view.laneOf.get(ev.component)
                if (lane === undefined) return null
                return (
                  <div
                    key={i}
                    onMouseEnter={(e) => say(e, `${fmtClock(ev.at, span)} · ${ev.summary}`)}
                    onMouseLeave={() => setHover(null)}
                    style={{
                      position: 'absolute', left: xOf(ev.at) - 4, top: lane * LANE_H + LANE_H / 2 - 4,
                      width: 8, height: 8, background: AM, transform: 'rotate(45deg)', cursor: 'pointer',
                    }}
                  />
                )
              })}

              {/* Call arrows */}
              {showArrows && (
                <svg
                  width={plot + RIGHT_PAD} height={height}
                  style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
                >
                  <defs>
                    <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                      <path d="M 0 1 L 7 4 L 0 7 z" fill={GD} />
                    </marker>
                  </defs>
                  {view.edges.map((e, i) => {
                    const a = view.laneOf.get(e.from)
                    const b = view.laneOf.get(e.to)
                    if (a === undefined || b === undefined || a === b) return null
                    const x = xOf(e.at)
                    const y1 = yOf(a)
                    const y2 = yOf(b)
                    // Bowed sideways so calls at the same instant between the same
                    // two lanes stay distinguishable instead of stacking into one line.
                    // Bow away from whichever edge is closest, so a call at "now" curves
                    // back into the chart instead of off the side of it.
                    const magnitude = Math.min(26, Math.abs(y2 - y1) * 0.35)
                    const nearRight = x > plot - magnitude - 4
                    const bow = nearRight ? -magnitude : magnitude * (i % 2 ? -1 : 1)
                    const d = `M ${x} ${y1} Q ${x + bow} ${(y1 + y2) / 2} ${x} ${y2}`
                    const tip = `${fmtClock(e.at, span)} · ${e.from} → ${e.to} · ${e.action}\n${e.summary}`
                    const lit = hoveredEdge === i
                    return (
                      <g key={i}>
                        {/* A 0.75px stroke is drawable but not hoverable. This invisible
                            fat twin is the hit area; the thin one stays the picture. */}
                        <path
                          d={d} fill="none" stroke="transparent" strokeWidth={12}
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onMouseEnter={(ev) => { setHoveredEdge(i); say(ev, tip) }}
                          onMouseMove={(ev) => say(ev, tip)}
                          onMouseLeave={() => { setHoveredEdge(null); setHover(null) }}
                        />
                        <path
                          d={d} fill="none" pointerEvents="none"
                          stroke={lit ? G : GD} strokeWidth={lit ? 1.6 : 0.75}
                          opacity={lit ? 1 : 0.5} markerEnd="url(#tl-arrow)"
                        />
                      </g>
                    )
                  })}
                </svg>
              )}

              {/* Axis */}
              <div style={{ position: 'absolute', left: 0, right: 0, top: height, height: AXIS_H }}>
                {axisTicks(since, until).map((t, i, all) => (
                  <span key={i} style={{
                    position: 'absolute', left: xOf(t), top: 3,
                    // The end labels would otherwise be half-clipped by the track edges.
                    transform: i === 0 ? 'none' : i === all.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                    ...MONO, fontSize: 10, color: GD, whiteSpace: 'nowrap',
                  }}>{fmtClock(t, span)}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {hover && (
        <div style={{
          position: 'fixed', left: Math.min(hover.x + 12, window.innerWidth - 340), top: hover.y + 14,
          maxWidth: 330, background: 'var(--bg-panel)', border: BORDER, padding: '5px 8px',
          ...MONO, fontSize: 11, color: 'var(--green-soft)', pointerEvents: 'none',
          whiteSpace: 'pre-wrap', zIndex: 50,
        }}>{hover.text}</div>
      )}
    </div>
  )
}
