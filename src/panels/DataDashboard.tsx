// The full-width DATA tab — the "Worldline" metrics warehouse. Surfaces the
// time-series history captured by HistoryHub (server/history.ts) via the
// /api/history/* REST endpoints: pick a source (a system telemetry metric or a
// Home-Assistant entity) + a time range, render a phosphor line chart with
// min/max/avg/now stat tiles. LIVE toggle short-polls the tail.
//
// Plan: docs/data-archive-plan.md (Part D-A: DA1 chart · DA2 range+live · DA3
// HA browser · DA4 stat readouts).

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchTelemetryHistory, fetchHaHistory, fetchHaEntities, type HistoryPoint } from '../lib/api'

// ── Telemetry metric catalogue ───────────────────────────────────────────────
type Unit = '%' | '°C' | 'Mb/s'
type Metric = { key: string; label: string; unit: Unit; max?: number }
const METRICS: Metric[] = [
  { key: 'cpu_load', label: 'CPU LOAD', unit: '%', max: 100 },
  { key: 'cpu_temp_c', label: 'CPU TEMP', unit: '°C' },
  { key: 'mem_pct', label: 'MEMORY', unit: '%', max: 100 },
  { key: 'swap_pct', label: 'SWAP', unit: '%', max: 100 },
  { key: 'rx_mbps', label: 'NET RX', unit: 'Mb/s' },
  { key: 'tx_mbps', label: 'NET TX', unit: 'Mb/s' },
  { key: 'storage_pct', label: 'STORAGE', unit: '%', max: 100 }
]

// ── Range presets ─────────────────────────────────────────────────────────────
type Range = { key: string; label: string; ms: number; limit: number }
const RANGES: Range[] = [
  { key: '1h', label: '1H', ms: 60 * 60 * 1000, limit: 1200 },
  { key: '6h', label: '6H', ms: 6 * 60 * 60 * 1000, limit: 1500 },
  { key: '24h', label: '24H', ms: 24 * 60 * 60 * 1000, limit: 2000 },
  { key: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000, limit: 3000 },
  { key: '30d', label: '30D', ms: 30 * 24 * 60 * 60 * 1000, limit: 5000 }
]

const LIVE_POLL_MS = 4000

type Source =
  | { kind: 'telemetry'; metric: Metric }
  | { kind: 'ha'; entityId: string }

function sourceLabel(s: Source): string {
  return s.kind === 'telemetry' ? s.metric.label : s.entityId
}
function sourceUnit(s: Source): string {
  return s.kind === 'telemetry' ? s.metric.unit : ''
}
function sourceMax(s: Source): number | undefined {
  return s.kind === 'telemetry' ? s.metric.max : undefined
}

// ── Time-axis formatting ──────────────────────────────────────────────────────
function fmtTick(ts: number, spanMs: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (spanMs > 3 * 24 * 60 * 60 * 1000) {
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return `${hh}:${mm}`
}
function fmtVal(v: number, unit: string): string {
  const abs = Math.abs(v)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return `${v.toFixed(digits)}${unit ? ' ' + unit : ''}`
}

// ── Stat tile ─────────────────────────────────────────────────────────────────
function StatTile({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '8px 10px', background: 'var(--bg-panel)', border: '0.5px solid var(--border)' }}>
      <div style={{ fontSize: 12, letterSpacing: 1.5, color: 'var(--green-dim)' }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)', fontSize: 20, marginTop: 2,
        color: accent ? 'var(--green)' : 'var(--green-soft)',
        textShadow: accent ? 'var(--glow-green)' : 'none',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }}>{value}</div>
    </div>
  )
}

// ── Line chart (SVG) ──────────────────────────────────────────────────────────
const CHART_W = 1000
const CHART_H = 320
const PAD = { l: 52, r: 16, t: 16, b: 26 }

function LineChart({ points, unit, forceMax }: { points: HistoryPoint[]; unit: string; forceMax?: number }): JSX.Element {
  const [hover, setHover] = useState<{ x: number; pt: HistoryPoint } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const valid = useMemo(() => points.filter((p) => p.value != null) as Array<{ ts: number; value: number }>, [points])

  const geom = useMemo(() => {
    if (valid.length === 0) return null
    const tMin = valid[0]!.ts
    const tMax = valid[valid.length - 1]!.ts
    const tSpan = Math.max(1, tMax - tMin)
    let vMin = Math.min(...valid.map((p) => p.value))
    let vMax = forceMax ?? Math.max(...valid.map((p) => p.value))
    if (forceMax == null) {
      const padV = (vMax - vMin) * 0.12 || 1
      vMin = Math.max(0, vMin - padV)
      vMax = vMax + padV
    } else {
      vMin = 0
    }
    const vSpan = Math.max(1e-6, vMax - vMin)
    const px = (ts: number): number => PAD.l + ((ts - tMin) / tSpan) * (CHART_W - PAD.l - PAD.r)
    const py = (v: number): number => CHART_H - PAD.b - ((v - vMin) / vSpan) * (CHART_H - PAD.t - PAD.b)
    return { tMin, tMax, tSpan, vMin, vMax, px, py }
  }, [valid, forceMax])

  if (!geom || valid.length === 0) {
    return (
      <div style={{
        height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '0.5px solid var(--border)', background: 'var(--svg-deep)',
        fontSize: 14, letterSpacing: 2, color: 'var(--green-dim)'
      }}>
        NO DATA IN RANGE
      </div>
    )
  }

  const line = valid.map((p) => `${geom.px(p.ts).toFixed(1)},${geom.py(p.value).toFixed(1)}`).join(' ')
  const area = `${PAD.l},${CHART_H - PAD.b} ${line} ${geom.px(geom.tMax).toFixed(1)},${CHART_H - PAD.b}`

  // 4 horizontal gridlines + value labels
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => geom.vMin + f * (geom.vMax - geom.vMin))
  // ~6 vertical time ticks
  const xCount = 6
  const xTicks = Array.from({ length: xCount + 1 }, (_, i) => geom.tMin + (i / xCount) * geom.tSpan)

  const onMove = (e: React.MouseEvent): void => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const xRatio = (e.clientX - rect.left) / rect.width
    const tx = geom.tMin + xRatio * geom.tSpan
    // nearest point by ts (binary-ish linear; series is small enough)
    let nearest = valid[0]!
    let best = Infinity
    for (const p of valid) {
      const d = Math.abs(p.ts - tx)
      if (d < best) { best = d; nearest = p }
    }
    setHover({ x: geom.px(nearest.ts), pt: nearest })
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: 300, display: 'block', background: 'var(--svg-deep)', border: '0.5px solid var(--border)' }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* gridlines + y labels */}
      {yTicks.map((v, i) => {
        const y = geom.py(v)
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={CHART_W - PAD.r} y2={y} stroke="var(--green-line)" strokeWidth={0.5} />
            <text x={PAD.l - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--green-dim)" fontFamily="var(--font-mono)">
              {fmtVal(v, '')}
            </text>
          </g>
        )
      })}
      {/* x time labels */}
      {xTicks.map((t, i) => (
        <text key={i} x={geom.px(t)} y={CHART_H - 8} textAnchor="middle" fontSize={9} fill="var(--green-dim)" fontFamily="var(--font-mono)">
          {fmtTick(t, geom.tSpan)}
        </text>
      ))}
      {/* area fill + line */}
      <polygon points={area} fill="var(--green)" opacity={0.08} />
      <polyline
        points={line} fill="none" stroke="var(--green)" strokeWidth={1.4}
        strokeLinejoin="round" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 3px var(--green))' }}
      />
      {/* hover crosshair */}
      {hover && (
        <g>
          <line x1={hover.x} y1={PAD.t} x2={hover.x} y2={CHART_H - PAD.b} stroke="var(--amber)" strokeWidth={0.6} strokeDasharray="3 3" />
          <circle cx={hover.x} cy={geom.py(hover.pt.value!)} r={3} fill="var(--amber)" />
          <text
            x={Math.min(hover.x + 6, CHART_W - PAD.r - 80)} y={PAD.t + 12}
            fontSize={11} fill="var(--amber)" fontFamily="var(--font-mono)"
          >
            {fmtVal(hover.pt.value!, unit)} · {fmtTick(hover.pt.ts, geom.tSpan)}
          </text>
        </g>
      )}
    </svg>
  )
}

// ── Selector pill ─────────────────────────────────────────────────────────────
function Pill({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: 1, padding: '5px 11px', cursor: 'pointer',
        color: active ? 'var(--bg)' : 'var(--green-dim)',
        background: active ? 'var(--green)' : 'transparent',
        border: `0.5px solid ${active ? 'var(--green)' : 'var(--border)'}`,
        textShadow: 'none', whiteSpace: 'nowrap'
      }}
    >
      {children}
    </button>
  )
}

// ── HA entity grouping ────────────────────────────────────────────────────────
// The raw entity_id wall is unfriendly. Bucket entities into subject areas
// (mirroring the app's other tabs), strip the redundant subject prefix from each
// label, and humanize what's left. `title` keeps the full entity_id on hover.
type EntityCat = {
  key: string
  label: string
  icon: string
  match: (id: string) => boolean
  strip?: RegExp // removed from the label after the domain prefix
}
const ENTITY_CATS: EntityCat[] = [
  { key: 'pets', label: 'PETS', icon: 'ti-paw', match: (id) => /(smithers|willow|zelda|pazoozoo|piggy|r2peepoo)/.test(id) },
  { key: 'climate', label: 'CLIMATE', icon: 'ti-temperature', match: (id) => /thermostat/.test(id), strip: /^thermostat_?/ },
  { key: 'laundry', label: 'LAUNDRY', icon: 'ti-wash-machine', match: (id) => /(washer|dryer)/.test(id) },
  { key: 'vehicle', label: 'VEHICLE · VOLTAIRE', icon: 'ti-car', match: (id) => /voltaire/.test(id), strip: /^voltaire_?/ },
  { key: 'lists', label: 'LISTS', icon: 'ti-list-check', match: (id) => id.startsWith('todo.') },
  { key: 'other', label: 'OTHER', icon: 'ti-dots', match: () => true }
]

function catFor(id: string): EntityCat {
  return ENTITY_CATS.find((c) => c.match(id))!
}

/** entity_id → friendly label, e.g. sensor.voltaire_tire_pressure_front_left → "Tire pressure front left". */
function prettyEntity(id: string, cat: EntityCat): string {
  let s = id.split('.').slice(1).join('.') // drop the domain (sensor./number./todo.)
  if (cat.strip) s = s.replace(cat.strip, '')
  s = s.replace(/_/g, ' ').trim()
  if (!s) s = id.split('.').slice(1).join('.').replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

type EntityRow = { id: string; label: string }
type EntityGroup = { cat: EntityCat; rows: EntityRow[] }

// ── Root ──────────────────────────────────────────────────────────────────────
export function DataDashboard(): JSX.Element {
  const [source, setSource] = useState<Source>({ kind: 'telemetry', metric: METRICS[0]! })
  const [range, setRange] = useState<Range>(RANGES[2]!) // 24h
  const [live, setLive] = useState(false)
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [haEntities, setHaEntities] = useState<string[]>([])
  const [haFilter, setHaFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)

  // Load HA entity list once.
  useEffect(() => {
    fetchHaEntities().then(setHaEntities).catch(() => setHaEntities([]))
  }, [])

  // Fetch series whenever source/range changes, and on the live poll.
  useEffect(() => {
    let cancelled = false
    const load = async (showSpinner: boolean): Promise<void> => {
      const id = ++reqId.current
      if (showSpinner) setLoading(true)
      try {
        const to = Date.now()
        const from = to - range.ms
        const pts = source.kind === 'telemetry'
          ? await fetchTelemetryHistory(source.metric.key, from, to, range.limit)
          : await fetchHaHistory(source.entityId, from, to, range.limit)
        if (cancelled || id !== reqId.current) return
        setPoints(pts)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError((err as Error).message)
        setPoints([])
      } finally {
        if (!cancelled && id === reqId.current) setLoading(false)
      }
    }
    void load(true)
    if (!live) return () => { cancelled = true }
    const timer = setInterval(() => void load(false), LIVE_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [source, range, live])

  // Stats over the current series.
  const stats = useMemo(() => {
    const vals = points.map((p) => p.value).filter((v): v is number => v != null)
    if (vals.length === 0) return null
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length
    const cur = vals[vals.length - 1]!
    return { min, max, avg, cur, count: vals.length }
  }, [points])

  const unit = sourceUnit(source)

  // Group HA entities into subject buckets, filter, and sort each bucket by
  // friendly label. Empty buckets are dropped.
  const haGroups = useMemo<EntityGroup[]>(() => {
    const q = haFilter.trim().toLowerCase()
    const byKey = new Map<string, EntityGroup>()
    for (const id of haEntities) {
      const cat = catFor(id)
      const label = prettyEntity(id, cat)
      if (q && !id.toLowerCase().includes(q) && !label.toLowerCase().includes(q)) continue
      let g = byKey.get(cat.key)
      if (!g) byKey.set(cat.key, (g = { cat, rows: [] }))
      g.rows.push({ id, label })
    }
    return ENTITY_CATS
      .map((c) => byKey.get(c.key))
      .filter((g): g is EntityGroup => !!g)
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.label.localeCompare(b.label)) }))
  }, [haEntities, haFilter])

  const filtering = haFilter.trim().length > 0
  const toggleCat = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      {/* masthead */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid var(--border-crimson)', paddingBottom: 9, marginBottom: 14
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, letterSpacing: 4, color: 'var(--green)', textShadow: 'var(--glow-green)' }}>
          <i className="ti ti-chart-line" style={{ marginRight: 8 }} />WORLDLINE · DATA
        </div>
        <div style={{ fontSize: 13, letterSpacing: 2, color: 'var(--green-dim)' }}>
          {loading ? 'QUERYING…' : error ? <span style={{ color: 'var(--crimson)' }}>HISTORY OFFLINE</span>
            : <>{stats ? `${stats.count} PTS` : 'NO DATA'} · {range.label}</>}
        </div>
      </div>

      {error && (
        <div className="card" style={{ fontSize: 14, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 20, marginBottom: 14 }}>
          HISTORY DATABASE UNREACHABLE — CHECK DATABASE_URL IN .ENV ({error})
        </div>
      )}

      {/* source + range controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginRight: 2 }}>SYSTEM</span>
        {METRICS.map((m) => (
          <Pill key={m.key} active={source.kind === 'telemetry' && source.metric.key === m.key} onClick={() => setSource({ kind: 'telemetry', metric: m })}>
            {m.label}
          </Pill>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginRight: 2 }}>RANGE</span>
        {RANGES.map((r) => (
          <Pill key={r.key} active={range.key === r.key} onClick={() => setRange(r)}>{r.label}</Pill>
        ))}
        <div style={{ width: 12 }} />
        <button
          onClick={() => setLive((v) => !v)}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: 1, padding: '5px 11px', cursor: 'pointer',
            color: live ? 'var(--bg)' : 'var(--green-dim)', background: live ? 'var(--amber)' : 'transparent',
            border: `0.5px solid ${live ? 'var(--amber)' : 'var(--border)'}`
          }}
        >
          <span style={{ animation: live ? 'blink 1.4s step-start infinite' : 'none', marginRight: 5 }}>●</span>
          {live ? 'LIVE' : 'LIVE OFF'}
        </button>
      </div>

      {/* stat tiles */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <StatTile label={`NOW (${sourceLabel(source)})`} value={stats ? fmtVal(stats.cur, unit) : '—'} accent />
        <StatTile label="MIN" value={stats ? fmtVal(stats.min, unit) : '—'} />
        <StatTile label="AVG" value={stats ? fmtVal(stats.avg, unit) : '—'} />
        <StatTile label="MAX" value={stats ? fmtVal(stats.max, unit) : '—'} />
      </div>

      {/* chart */}
      <LineChart points={points} unit={unit} forceMax={sourceMax(source)} />

      {/* HA entity browser */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 13, letterSpacing: 2, color: 'var(--green-soft)', fontFamily: 'var(--font-display)' }}>
            <i className="ti ti-home-cog" style={{ marginRight: 6 }} />HOME ASSISTANT ENTITIES
          </span>
          <span style={{ fontSize: 12, color: 'var(--green-dim)', letterSpacing: 1 }}>{haEntities.length} TRACKED</span>
          <input
            value={haFilter}
            onChange={(e) => setHaFilter(e.target.value)}
            placeholder="filter…"
            style={{
              marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 14, padding: '4px 8px',
              background: 'var(--bg-panel)', border: '0.5px solid var(--border)', color: 'var(--green-soft)', width: 200
            }}
          />
        </div>
        {haEntities.length === 0 ? (
          <div style={{ fontSize: 14, color: 'var(--green-dim)', letterSpacing: 1, padding: '10px 0' }}>
            NO HA HISTORY YET — NUMERIC ENTITIES ACCRUE AS THE CAPTURE RUNS
          </div>
        ) : haGroups.length === 0 ? (
          <div style={{ fontSize: 14, color: 'var(--green-dim)', letterSpacing: 1, padding: '10px 0' }}>
            NO ENTITIES MATCH “{haFilter.trim()}”
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {haGroups.map((g) => {
              const isCollapsed = !filtering && collapsed.has(g.cat.key)
              return (
                <div key={g.cat.key}>
                  <button
                    onClick={() => toggleCat(g.cat.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, width: '100%', cursor: 'pointer',
                      background: 'transparent', border: 'none', padding: '2px 0', marginBottom: 6,
                      borderBottom: '0.5px solid var(--border)', color: 'var(--green-soft)'
                    }}
                  >
                    <i className={`ti ${isCollapsed ? 'ti-chevron-right' : 'ti-chevron-down'}`} style={{ fontSize: 16, color: 'var(--green-dim)' }} />
                    <i className={`ti ${g.cat.icon}`} style={{ fontSize: 16, color: 'var(--green)' }} />
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, letterSpacing: 2 }}>{g.cat.label}</span>
                    <span style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)' }}>{g.rows.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingLeft: 18 }}>
                      {g.rows.map((r) => (
                        <Pill
                          key={r.id}
                          title={r.id}
                          active={source.kind === 'ha' && source.entityId === r.id}
                          onClick={() => setSource({ kind: 'ha', entityId: r.id })}
                        >
                          {r.label}
                        </Pill>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
