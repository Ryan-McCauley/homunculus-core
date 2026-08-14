// OSINT tab — OSINT watchers monitoring things happening on the internet,
// fronted by a globe.gl globe whose overlay layers are driven by live feeds:
//   • Seismic  — USGS earthquakes (pulsing rings)
//   • Skywatch — military ADS-B (points)
//   • Geomag   — NOAA Kp + OVATION aurora (heatmap)
// Plus the original Pentagon Pizza Index, in collapsible side cards.

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { SplitPane } from '../components/SplitPane'
import { useOsint } from '../hooks/useOsint'
import { tokens } from '../lib/tokens'
import { DEFCON_LABEL, DEFAULT_GEOFENCE, BREACH_ICON } from '../../shared/osint'
import type {
  PizzaReading, PizzaSnapshot,
  SeismicSnapshot, AircraftSnapshot, GeomagSnapshot,
  CyberSnapshot, VesselSnapshot, OutageSnapshot, OutageLevel,
  IpWatchSnapshot,
  GeofenceSnapshot
} from '../../shared/osint'
import type { GlobeLayers, LatLng } from './OsintGlobe'

const HOME_KEY = 'osint_home'
const GEOFENCE_KEY = 'osint_geofence'
// Selectable perimeter radii (km).
const RADIUS_STEPS = [25, 50, 100, 150, 250, 500, 1000]

// Code-split the heavy three.js/globe.gl bundle so it only loads on this tab.
const OsintGlobe = lazy(() => import('./OsintGlobe').then((m) => ({ default: m.OsintGlobe })))

type C = ReturnType<typeof tokens>

function refresh(): void {
  window.homunculus?.osintRefresh()
}

function defconColor(defcon: number, C: C): string {
  if (defcon <= 2) return C.crimson
  if (defcon === 3) return C.amber
  if (defcon === 4) return C.amber + 'cc'
  return C.green
}
function busyColor(r: PizzaReading, C: C): string {
  if (r.isAnomaly) return C.crimson
  if (r.busyness >= 70) return C.amber
  return C.green
}
function magColor(mag: number, C: C): string {
  if (mag >= 6) return C.crimson
  if (mag >= 4.5) return C.amber
  return C.green
}
function kpColor(gScale: number, C: C): string {
  if (gScale >= 3) return C.crimson
  if (gScale >= 1) return C.amber
  return C.green
}
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}
function duration(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function CollapsibleCard({ title, icon, right, defaultOpen = true, children }: {
  title: string; icon: string; right?: JSX.Element; defaultOpen?: boolean; children: ReactNode
}): JSX.Element {
  const C = tokens()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, letterSpacing: 3,
          color: C.dim, textTransform: 'uppercase', borderBottom: `0.5px solid ${C.line}`,
          paddingBottom: 7, marginBottom: open ? 11 : 0, cursor: 'pointer', userSelect: 'none'
        }}
      >
        <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 17 }} />
        <i className={`ti ${icon}`} />
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {open && children}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  const C = tokens()
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, letterSpacing: 1 }}>
      <span style={{ color: C.dim }}>{label}</span>
      <span style={{ color: color ?? C.green }}>{value}</span>
    </div>
  )
}

// ── Geomagnetic / solar ─────────────────────────────────────────────────────
function GeomagCard({ snap }: { snap: GeomagSnapshot }): JSX.Element {
  const C = tokens()
  const color = kpColor(snap.gScale, C)
  const pct = (snap.kp / 9) * 100
  const CIRC = 326.7
  const offset = CIRC * (1 - pct / 100)
  const summary = <span style={{ fontSize: 13, letterSpacing: 2, color }}>Kp {snap.kp} · {snap.gLabel}</span>
  const kh = snap.kpHistory.slice(-48)
  return (
    <CollapsibleCard title="Geomagnetic · Solar" icon="ti-aurora" right={summary}>
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 14, alignItems: 'center' }}>
        <svg viewBox="0 0 130 130" width="120" height="120">
          <circle cx="65" cy="65" r="52" fill="none" stroke={C.line} strokeWidth="9" />
          <circle cx="65" cy="65" r="52" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
            strokeDasharray={CIRC} strokeDashoffset={offset} transform="rotate(-90 65 65)"
            style={{ filter: `drop-shadow(0 0 5px ${color}aa)`, transition: 'stroke-dashoffset .6s ease' }} />
          <text x="65" y="60" textAnchor="middle" fill={color} fontFamily="Orbitron,sans-serif" fontSize="30">{snap.kp}</text>
          <text x="65" y="74" textAnchor="middle" fill={C.dim} fontSize="8" letterSpacing="2">Kp INDEX</text>
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ alignSelf: 'flex-start', fontSize: 16, letterSpacing: 2, color, border: `0.5px solid ${color}66`, padding: '3px 10px', textShadow: `0 0 8px ${color}55` }}>
            {snap.gLabel}
          </div>
          <Stat label="Storm level" value={snap.gScale === 0 ? 'NONE' : `G${snap.gScale}`} color={color} />
          <Stat label="Aurora cells" value={String(snap.aurora.length)} color={snap.aurora.length > 0 ? C.green : C.dim} />
          {kh.length >= 2 && (
            <svg viewBox="0 0 100 24" width="100%" height="34" preserveAspectRatio="none" style={{ marginTop: 2 }}>
              {(() => {
                const xs = (i: number): number => (i / (kh.length - 1)) * 100
                const ys = (v: number): number => 24 - (v / 9) * 24
                const line = kh.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)} ${ys(p.kp).toFixed(1)}`).join(' ')
                return <path d={line} fill="none" stroke={color} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              })()}
            </svg>
          )}
        </div>
      </div>
    </CollapsibleCard>
  )
}

// ── Seismic ─────────────────────────────────────────────────────────────────
function SeismicCard({ snap }: { snap: SeismicSnapshot }): JSX.Element {
  const C = tokens()
  const summary = snap.largest
    ? <span style={{ fontSize: 13, letterSpacing: 2, color: magColor(snap.largest.mag, C) }}>M{snap.largest.mag.toFixed(1)} · {snap.count} EVENTS</span>
    : <span style={{ fontSize: 13, letterSpacing: 2, color: C.dim }}>{snap.count} EVENTS</span>
  return (
    <CollapsibleCard title="Seismic Watch · USGS" icon="ti-activity" right={summary}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {snap.quakes.length === 0 && <div style={{ fontSize: 14, color: C.dim, textAlign: 'center', padding: 10 }}>NO M2.5+ EVENTS · 24H</div>}
        {snap.quakes.slice(0, 7).map((q) => {
          const color = magColor(q.mag, C)
          return (
            <div key={q.id} style={{ display: 'flex', alignItems: 'baseline', gap: 9, fontSize: 16, letterSpacing: 0.5 }}>
              <span style={{ fontFamily: 'var(--font-display)', color, minWidth: 34, textShadow: `0 0 6px ${color}66` }}>
                {q.mag.toFixed(1)}
              </span>
              <span style={{ color: C.soft, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {q.tsunami && <i className="ti ti-wave-saw-tool" style={{ color: C.crimson, marginRight: 4 }} />}
                {q.place}
              </span>
              <span style={{ color: C.dim, fontSize: 12 }}>{q.depthKm}km · {ago(q.time)}</span>
            </div>
          )
        })}
      </div>
    </CollapsibleCard>
  )
}

// ── Skywatch ────────────────────────────────────────────────────────────────
function SkywatchCard({ snap }: { snap: AircraftSnapshot }): JSX.Element {
  const C = tokens()
  const summary = (
    <span style={{ fontSize: 13, letterSpacing: 2, color: snap.emergencyCount > 0 ? C.crimson : C.amber }}>
      {snap.count} MIL{snap.emergencyCount > 0 ? ` · ${snap.emergencyCount}!` : ''}
    </span>
  )
  const sorted = snap.aircraft.slice().sort((a, b) => Number(b.emergency) - Number(a.emergency) || (b.altFt ?? 0) - (a.altFt ?? 0))
  return (
    <CollapsibleCard title="Skywatch · Mil ADS-B" icon="ti-plane" right={summary}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
        <Stat label="Airborne" value={String(snap.count)} color={C.amber} />
        <span style={{ flex: 1 }} />
        <Stat label="Plotted" value={String(snap.aircraft.length)} color={C.dim} />
        {snap.emergencyCount > 0 && <span style={{ color: C.crimson, fontSize: 16 }}>· {snap.emergencyCount} EMERG</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {sorted.slice(0, 8).map((a) => (
          <div key={a.hex} style={{ display: 'flex', alignItems: 'baseline', gap: 9, fontSize: 16, letterSpacing: 0.5 }}>
            <span style={{ color: a.emergency ? C.crimson : C.soft, minWidth: 60, fontFamily: 'var(--font-mono)' }}>
              {a.emergency && <i className="ti ti-alert-triangle" style={{ marginRight: 3 }} />}{a.callsign}
            </span>
            <span style={{ color: C.dim, flex: 1 }}>{a.type}</span>
            <span style={{ color: C.dim, fontSize: 12 }}>{a.altFt != null ? `${a.altFt.toLocaleString()}ft` : '—'}{a.groundSpeed != null ? ` · ${a.groundSpeed}kt` : ''}</span>
          </div>
        ))}
      </div>
    </CollapsibleCard>
  )
}

// ── Pizza (unchanged) ───────────────────────────────────────────────────────
function IndexGauge({ snap }: { snap: PizzaSnapshot }): JSX.Element {
  const C = tokens()
  const color = defconColor(snap.defcon, C)
  const pct = snap.indexScore
  const CIRC = 326.7
  const offset = CIRC * (1 - pct / 100)
  const headerSummary = (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, letterSpacing: 2 }}>
      <span style={{ color }}>{pct} · DEFCON {snap.defcon}</span>
      <span style={{ color, border: `0.5px solid ${color}66`, padding: '1px 6px' }}>{DEFCON_LABEL[snap.defcon]}</span>
    </span>
  )
  return (
    <CollapsibleCard title="Pentagon Pizza Index" icon="ti-pizza" right={headerSummary} defaultOpen={false}>
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 14, alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <svg viewBox="0 0 130 130" width="120" height="120">
            <circle cx="65" cy="65" r="52" fill="none" stroke={C.line} strokeWidth="9" />
            <circle cx="65" cy="65" r="52" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
              strokeDasharray={CIRC} strokeDashoffset={offset} transform="rotate(-90 65 65)"
              style={{ filter: `drop-shadow(0 0 5px ${color}aa)`, transition: 'stroke-dashoffset .6s ease' }} />
            <text x="65" y="58" textAnchor="middle" fill={color} fontFamily="Orbitron,sans-serif" fontSize="30">{pct}</text>
            <text x="65" y="72" textAnchor="middle" fill={C.dim} fontSize="8" letterSpacing="2">INDEX</text>
            <text x="65" y="90" textAnchor="middle" fill={color} fontSize="11" letterSpacing="1">DEFCON {snap.defcon}</text>
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Stat label="Anomalies" value={String(snap.anomalyCount)} color={snap.anomalyCount > 0 ? C.crimson : C.green} />
          <Stat label="Venues tracked" value={String(snap.locationCount)} />
          <Stat label="Avg over baseline" value={`${Math.round(snap.deviationAvg * 100)}%`} color={snap.deviationAvg > 0.15 ? C.amber : C.dim} />
          <Stat label="Window" value={snap.isLateNight ? 'LATE NIGHT' : 'DAYTIME'} color={snap.isLateNight ? C.amber : C.dim} />
        </div>
      </div>
    </CollapsibleCard>
  )
}

function VenueList({ readings }: { readings: PizzaReading[] }): JSX.Element {
  const C = tokens()
  const summary = <span style={{ fontSize: 13, letterSpacing: 2, color: C.dim }}>{readings.length} VENUES</span>
  return (
    <CollapsibleCard title="Pizza · Venue Activity" icon="ti-map-pin" right={summary} defaultOpen={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {readings.slice(0, 8).map((r) => {
          const color = busyColor(r, C)
          const over = Math.round(r.deviation * 100)
          return (
            <div key={r.locationId} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 16, letterSpacing: 0.5 }}>
                <span style={{ color: C.soft }}>
                  {r.isAnomaly && <i className="ti ti-alert-triangle" style={{ color: C.crimson, marginRight: 5, fontSize: 16 }} />}
                  {r.name}
                </span>
                <span style={{ color, fontFamily: 'var(--font-display)' }}>
                  {r.busyness}%{over > 0 && <span style={{ color: over >= 15 ? C.amber : C.dim, fontSize: 13, marginLeft: 5 }}>+{over}%</span>}
                </span>
              </div>
              <div style={{ height: 4, background: C.line, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${r.busyness}%`, height: '100%', background: color, transition: 'width .5s ease', boxShadow: `0 0 4px ${color}` }} />
              </div>
            </div>
          )
        })}
      </div>
    </CollapsibleCard>
  )
}

// ── Cyber threat ────────────────────────────────────────────────────────────
function CyberCard({ snap }: { snap: CyberSnapshot }): JSX.Element {
  const C = tokens()
  const summary = <span style={{ fontSize: 13, letterSpacing: 2, color: C.crimson }}>{snap.kevTotal} KEV · {snap.c2Count} C2</span>
  return (
    <CollapsibleCard title="Cyber Threat · KEV + C2" icon="ti-shield-bolt" right={summary}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <Stat label="KEV catalog" value={snap.kevTotal.toLocaleString()} color={C.amber} />
        <span style={{ flex: 1 }} />
        <Stat label="Active C2" value={String(snap.c2Count)} color={snap.c2Count > 0 ? C.crimson : C.dim} />
      </div>
      <div style={{ fontSize: 12, letterSpacing: 2, color: C.dim, marginBottom: 6 }}>RECENTLY EXPLOITED</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {snap.recentCves.slice(0, 5).map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, letterSpacing: 0.5 }}>
            <span style={{ color: c.ransomware ? C.crimson : C.amber, fontFamily: 'var(--font-mono)', minWidth: 96 }}>
              {c.ransomware && <i className="ti ti-lock-bolt" style={{ marginRight: 3 }} />}{c.id}
            </span>
            <span style={{ color: C.soft, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.vendor} {c.product}
            </span>
            <span style={{ color: C.dim, fontSize: 12 }}>{c.dateAdded}</span>
          </div>
        ))}
      </div>
      {snap.c2.length > 0 && (
        <>
          <div style={{ fontSize: 12, letterSpacing: 2, color: C.dim, marginBottom: 6 }}>ACTIVE C2 SERVERS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {snap.c2.slice(0, 6).map((c) => (
              <div key={`${c.ip}:${c.port}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14 }}>
                <span style={{ color: C.crimson, minWidth: 60 }}>{c.malware}</span>
                <span style={{ color: C.soft, flex: 1, fontFamily: 'var(--font-mono)' }}>{c.ip}:{c.port}</span>
                <span style={{ color: C.dim, fontSize: 12 }}>{c.country}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </CollapsibleCard>
  )
}

// ── Service outages (status pages) ───────────────────────────────────────────
function outageColor(level: OutageLevel, C: C): string {
  if (level === 'critical' || level === 'major') return C.crimson
  if (level === 'minor') return C.amber
  return C.green
}
function OutageCard({ snap }: { snap: OutageSnapshot }): JSX.Element {
  const C = tokens()
  const color = outageColor(snap.worst, C)
  const summary = (
    <span style={{ fontSize: 13, letterSpacing: 2, color: snap.degradedCount > 0 ? color : C.green }}>
      {snap.degradedCount > 0 ? `${snap.degradedCount} DEGRADED` : 'ALL OPERATIONAL'}
    </span>
  )
  return (
    <CollapsibleCard title="Service Outages · Status" icon="ti-cloud-bolt" right={summary}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <Stat label="Tracked" value={String(snap.services.length)} color={C.dim} />
        <span style={{ flex: 1 }} />
        <Stat label="Degraded" value={String(snap.degradedCount)} color={snap.degradedCount > 0 ? color : C.green} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {snap.services.map((s) => {
          const c = s.ok ? outageColor(s.indicator, C) : C.dim
          const detail = s.incidentTitle ?? s.description
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 16, letterSpacing: 0.5 }}>
              <span style={{ color: c, fontSize: 12 }}>{s.ok ? '●' : '○'}</span>
              <span style={{ color: C.soft, minWidth: 78 }}>
                {s.activeIncidents > 0 && <i className="ti ti-alert-triangle" style={{ color: c, marginRight: 4, fontSize: 14 }} />}
                {s.name}
              </span>
              <span style={{ color: s.indicator === 'none' ? C.dim : c, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                {s.ok ? detail : 'no data'}
              </span>
              {s.indicator !== 'none' && s.ok && (
                <span style={{ color: c, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>{s.indicator}</span>
              )}
            </div>
          )
        })}
      </div>
    </CollapsibleCard>
  )
}

// ── IP Watch (public WAN address) ────────────────────────────────────────────
function IpWatchCard({ snap }: { snap: IpWatchSnapshot }): JSX.Element {
  const C = tokens()
  const [copied, setCopied] = useState(false)
  const ok = snap.origin !== 'error'
  const color = ok ? C.green : C.crimson
  const copy = (): void => {
    if (!snap.ip) return
    navigator.clipboard?.writeText(snap.ip).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* ignore */ })
  }
  const summary = (
    <span style={{ fontSize: 13, letterSpacing: 2, color }}>
      {ok ? 'MONITORING' : 'UNREACHABLE'}
    </span>
  )
  return (
    <CollapsibleCard title="IP Watch · Public Address" icon="ti-router" right={summary}>
      {snap.ip ? (
        <>
          <div
            onClick={copy}
            title="Click to copy"
            style={{
              display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer',
              fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: 1, color, marginBottom: 8
            }}
          >
            {snap.ip}
            <i className={`ti ${copied ? 'ti-check' : 'ti-copy'}`} style={{ fontSize: 18, color: copied ? C.green : C.dim }} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Stat label="Stable for" value={snap.since ? duration(snap.since) : '—'} color={C.dim} />
            <span style={{ flex: 1 }} />
            <Stat label="Checked" value={ago(snap.lastChecked)} color={C.dim} />
          </div>
          {!ok && snap.error && (
            <div style={{ marginTop: 8, fontSize: 13, color: C.crimson, letterSpacing: 0.5 }}>{snap.error}</div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 14, color: C.dim, textAlign: 'center', padding: 10 }}>
          {snap.error ?? 'NO READING YET'}
        </div>
      )}
    </CollapsibleCard>
  )
}

// ── Geofence (home perimeter) ────────────────────────────────────────────────
function fmtCoord(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`
}
function GeofenceCard({ snap, home, radiusKm, onRadius }: {
  snap: GeofenceSnapshot | null; home: LatLng | null; radiusKm: number; onRadius: (km: number) => void
}): JSX.Element {
  const C = tokens()
  const armed = !!snap?.config.enabled && !!home
  const breaches = snap?.breaches ?? []
  const color = armed ? (breaches.length > 0 ? C.crimson : C.green) : C.dim
  const summary = (
    <span style={{ fontSize: 13, letterSpacing: 2, color }}>
      {!home ? 'NO HOME' : armed ? `ARMED · ${radiusKm}KM` : 'DISARMED'}
    </span>
  )
  const stepRadius = (dir: number): void => {
    const i = RADIUS_STEPS.indexOf(radiusKm)
    const base = i === -1 ? RADIUS_STEPS.findIndex((r) => r >= radiusKm) : i
    const next = Math.min(RADIUS_STEPS.length - 1, Math.max(0, (base === -1 ? RADIUS_STEPS.length - 1 : base) + dir))
    onRadius(RADIUS_STEPS[next])
  }
  return (
    <CollapsibleCard title="Geofence · Home Perimeter" icon="ti-current-location" right={summary}>
      {!home ? (
        <div style={{ fontSize: 14, color: C.dim, letterSpacing: 0.5, lineHeight: 1.6 }}>
          Use <span style={{ color: C.soft }}>SET HOME</span> in the masthead, then click the globe to pin home.
          Arm the perimeter to be alerted when a quake, aircraft, or vessel crosses inside it.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: breaches.length ? 11 : 0 }}>
            <Stat label="Centre" value={fmtCoord(home.lat, home.lng)} color={C.soft} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 16, letterSpacing: 1 }}>
              <span style={{ color: C.dim }}>Radius</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RadiusBtn icon="ti-minus" onClick={() => stepRadius(-1)} />
                <span style={{ color, fontFamily: 'var(--font-display)', minWidth: 58, textAlign: 'center' }}>{radiusKm} km</span>
                <RadiusBtn icon="ti-plus" onClick={() => stepRadius(1)} />
              </span>
            </div>
            <Stat label="Status" value={armed ? 'WATCHING' : 'STANDBY'} color={armed ? C.green : C.dim} />
          </div>
          {breaches.length > 0 && (
            <>
              <div style={{ fontSize: 12, letterSpacing: 2, color: C.dim, marginBottom: 6 }}>RECENT BREACHES</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {breaches.slice(0, 8).map((b) => (
                  <div key={`${b.id}:${b.ts}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, letterSpacing: 0.5 }}>
                    <i className={`ti ${BREACH_ICON[b.kind]}`} style={{ color: C.crimson, fontSize: 16 }} />
                    <span style={{ color: C.soft, minWidth: 64, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
                    <span style={{ color: C.dim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.detail}</span>
                    <span style={{ color: C.amber, fontSize: 12 }}>{b.distanceKm}km</span>
                    <span style={{ color: C.dim, fontSize: 12 }}>{ago(b.ts)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </CollapsibleCard>
  )
}
function RadiusBtn({ icon, onClick }: { icon: string; onClick: () => void }): JSX.Element {
  const C = tokens()
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: `0.5px solid ${C.green}55`, color: C.green,
      width: 20, height: 20, lineHeight: 1, cursor: 'pointer', borderRadius: 2, padding: 0
    }}>
      <i className={`ti ${icon}`} style={{ fontSize: 16 }} />
    </button>
  )
}

// ── Vessel AIS ──────────────────────────────────────────────────────────────
function VesselCard({ snap }: { snap: VesselSnapshot }): JSX.Element {
  const C = tokens()
  if (snap.origin === 'nokey') {
    return (
      <CollapsibleCard title="Vessel AIS · Maritime" icon="ti-anchor"
        right={<span style={{ fontSize: 13, letterSpacing: 2, color: C.dim }}>OFFLINE</span>} defaultOpen={false}>
        <div style={{ fontSize: 14, color: C.dim, letterSpacing: 0.5, lineHeight: 1.6 }}>
          Feed disabled. Get a free key at <span style={{ color: C.blue }}>aisstream.io</span> and set
          <span style={{ color: C.soft, fontFamily: 'var(--font-mono)' }}> OSINT_AISSTREAM_KEY</span> in <span style={{ color: C.soft, fontFamily: 'var(--font-mono)' }}>.env</span>.
        </div>
      </CollapsibleCard>
    )
  }
  const summary = <span style={{ fontSize: 13, letterSpacing: 2, color: C.blue }}>{snap.count.toLocaleString()} TRACKED</span>
  const moving = snap.vessels.filter((v) => (v.sog ?? 0) >= 0.5)
  return (
    <CollapsibleCard title="Vessel AIS · Maritime" icon="ti-anchor" right={summary}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 9 }}>
        <Stat label="In view" value={snap.count.toLocaleString()} color={C.blue} />
        <span style={{ flex: 1 }} />
        <Stat label="Under way" value={String(moving.length)} color={C.dim} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {snap.vessels.slice(0, 8).map((v) => (
          <div key={v.mmsi} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, letterSpacing: 0.5 }}>
            <span style={{ color: C.soft, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
            <span style={{ color: C.dim, fontSize: 12 }}>{v.sog != null ? `${v.sog} kn` : '—'}{v.cog != null ? ` · ${v.cog}°` : ''}</span>
          </div>
        ))}
        {snap.vessels.length === 0 && <div style={{ fontSize: 14, color: C.dim, textAlign: 'center', padding: 8 }}>AWAITING POSITION REPORTS…</div>}
      </div>
    </CollapsibleCard>
  )
}

// ── Globe layer toggle bar ──────────────────────────────────────────────────
function LayerToggles({ layers, setLayers, snap }: {
  layers: GlobeLayers; setLayers: (l: GlobeLayers) => void
  snap: {
    seismic: SeismicSnapshot | null; aircraft: AircraftSnapshot | null; geomag: GeomagSnapshot | null
    vessels: VesselSnapshot | null; cyber: CyberSnapshot | null
  }
}): JSX.Element {
  const C = tokens()
  const defs = [
    { k: 'seismic' as const, label: 'SEISMIC', icon: 'ti-activity', color: C.crimson, count: snap.seismic?.count ?? 0 },
    { k: 'aircraft' as const, label: 'SKYWATCH', icon: 'ti-plane', color: C.amber, count: snap.aircraft?.aircraft.length ?? 0 },
    { k: 'vessels' as const, label: 'VESSELS', icon: 'ti-anchor', color: C.blue, count: snap.vessels?.vessels.length ?? 0 },
    { k: 'cyber' as const, label: 'CYBER', icon: 'ti-shield-bolt', color: C.crimson, count: snap.cyber?.c2.filter((c) => c.lat != null).length ?? 0 },
    { k: 'geomag' as const, label: 'AURORA', icon: 'ti-aurora', color: C.green, count: snap.geomag?.aurora.length ?? 0 }
  ]
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 420 }}>
      {defs.map((d) => {
        const on = layers[d.k]
        return (
          <button
            key={d.k}
            onClick={() => setLayers({ ...layers, [d.k]: !on })}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 13,
              letterSpacing: 1, padding: '4px 9px', borderRadius: 3, cursor: 'pointer',
              background: 'rgba(0,0,0,0.5)', border: `0.5px solid ${d.color}${on ? '99' : '33'}`,
              color: d.color, opacity: on ? 1 : 0.4
            }}
          >
            <i className={`ti ${d.icon}`} style={{ fontSize: 17 }} />
            {d.label}
            <span style={{ color: C.dim, fontSize: 12 }}>{d.count}</span>
          </button>
        )
      })}
    </div>
  )
}

function MastheadBtn({ icon, label, onClick, active, color }: {
  icon: string; label: string; onClick: () => void; active?: boolean; color?: string
}): JSX.Element {
  const C = tokens()
  const c = color ?? (active ? C.green : C.green)
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--card-active-bg)' : 'transparent',
        border: `0.5px solid ${c}${active ? '99' : '44'}`, color: c,
        fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: 1, padding: '3px 10px',
        cursor: 'pointer', opacity: active ? 1 : 0.82
      }}
    >
      <i className={`ti ${icon}`} style={{ marginRight: 4 }} />{label}
    </button>
  )
}

function SourcePill({ label, snap }: { label: string; snap: { origin: 'live' | 'cache' | 'error' | 'nokey' } | null }): JSX.Element {
  const C = tokens()
  const o = snap?.origin ?? null
  const color = o === 'live' ? C.green : o === 'cache' ? C.amber : o === 'error' ? C.crimson : C.dim
  return <span style={{ color, fontSize: 12, letterSpacing: 1 }}>● {label}</span>
}

export function OsintDashboard(): JSX.Element {
  const C = tokens()
  const snap = useOsint()
  const pizza = snap?.pizza ?? null
  const seismic = snap?.seismic ?? null
  const aircraft = snap?.aircraft ?? null
  const geomag = snap?.geomag ?? null
  const cyber = snap?.cyber ?? null
  const vessels = snap?.vessels ?? null
  const outage = snap?.outage ?? null
  const ipwatch = snap?.ipwatch ?? null

  const [layers, setLayers] = useState<GlobeLayers>({
    seismic: true, aircraft: true, geomag: true, vessels: true, cyber: true
  })
  const [autoTrack, setAutoTrack] = useState(true)
  const [homeMode, setHomeMode] = useState(false)
  const [home, setHome] = useState<LatLng | null>(() => {
    try { const v = localStorage.getItem(HOME_KEY); return v ? (JSON.parse(v) as LatLng) : null } catch { return null }
  })
  const setHomeFromGlobe = (c: LatLng): void => {
    setHome(c)
    try { localStorage.setItem(HOME_KEY, JSON.stringify(c)) } catch { /* ignore */ }
    setHomeMode(false)
  }
  const clearHome = (): void => {
    setHome(null)
    try { localStorage.removeItem(HOME_KEY) } catch { /* ignore */ }
    setHomeMode(false)
  }

  // Geofence perimeter (home + radius). Persisted locally and pushed to the hub,
  // which enforces it server-side (alerts even with no UI client connected).
  const [radiusKm, setRadiusKm] = useState<number>(() => {
    try { const v = localStorage.getItem(GEOFENCE_KEY); return v ? (JSON.parse(v).radiusKm ?? DEFAULT_GEOFENCE.radiusKm) : DEFAULT_GEOFENCE.radiusKm } catch { return DEFAULT_GEOFENCE.radiusKm }
  })
  const [armed, setArmed] = useState<boolean>(() => {
    try { const v = localStorage.getItem(GEOFENCE_KEY); return v ? !!JSON.parse(v).enabled : false } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(GEOFENCE_KEY, JSON.stringify({ radiusKm, enabled: armed })) } catch { /* ignore */ }
    window.homunculus?.osintSetGeofence({ enabled: armed, lat: home?.lat ?? null, lng: home?.lng ?? null, radiusKm })
  }, [home, radiusKm, armed])
  const geofence = snap?.geofence ?? null
  const breached = !!geofence?.breaches.length

  return (
    <div style={{ height: '100%', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      {/* masthead */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-crimson)', paddingBottom: 9 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, letterSpacing: 4, color: C.green, textShadow: `0 0 10px ${C.green}55` }}>
          <i className="ti ti-satellite" style={{ marginRight: 8 }} />OSINT · GLOBAL SITUATION
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <SourcePill label="QUAKE" snap={seismic} />
            <SourcePill label="AIR" snap={aircraft} />
            <SourcePill label="SEA" snap={vessels} />
            <SourcePill label="CYBER" snap={cyber} />
            <SourcePill label="OUTAGE" snap={outage} />
            <SourcePill label="GEO" snap={geomag} />
            <SourcePill label="PIZZA" snap={pizza} />
          </div>
          <MastheadBtn icon="ti-focus-2" label="AUTO-TRACK" active={autoTrack} onClick={() => setAutoTrack((v) => !v)} />
          <MastheadBtn
            icon={home ? 'ti-home-check' : 'ti-home-plus'}
            label={homeMode ? 'PICK ON GLOBE' : home ? 'HOME SET' : 'SET HOME'}
            active={homeMode}
            color={home ? C.green : undefined}
            onClick={() => (home && !homeMode ? clearHome() : setHomeMode((v) => !v))}
          />
          <MastheadBtn
            icon={armed ? (breached ? 'ti-shield-bolt' : 'ti-shield-check') : 'ti-shield'}
            label={armed ? (breached ? 'BREACH' : 'ARMED') : 'ARM'}
            active={armed}
            color={armed ? (breached ? C.crimson : C.green) : undefined}
            onClick={() => setArmed((v) => !v)}
          />
          <MastheadBtn icon="ti-refresh" label="REFRESH" onClick={refresh} />
        </div>
      </div>

      {/* body: globe focal + right rail */}
      <SplitPane fill storageKey="osint-body" style={{ flex: 1, minHeight: 0, gap: 0 }} config={[
        { key: 'globe', min: 320 },
        { key: 'rail', fixed: true, size: 360, min: 240 },
      ]}>
        {/* globe */}
        <div className="card" style={{ position: 'relative', overflow: 'hidden', padding: 0, background: '#04080a' }}>
          <Suspense fallback={<div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 14, letterSpacing: 2 }}>INITIALISING ORTHO PROJECTION…</div>}>
            <OsintGlobe snap={snap} layers={layers} autoTrack={autoTrack} homeMode={homeMode} home={home} radiusKm={radiusKm} geofence={armed && !!home} onSetHome={setHomeFromGlobe} />
          </Suspense>
          <div style={{ position: 'absolute', top: 12, left: 12 }}>
            <LayerToggles layers={layers} setLayers={setLayers} snap={{ seismic, aircraft, geomag, vessels, cyber }} />
          </div>
          <div style={{ position: 'absolute', bottom: 10, left: 14, display: 'flex', gap: 14, fontSize: 12, letterSpacing: 1, color: C.dim }}>
            <span><span style={{ color: C.crimson }}>◉</span> quake</span>
            <span><span style={{ color: C.amber }}>▲</span> aircraft</span>
            <span><span style={{ color: C.blue }}>▲</span> vessel</span>
            <span><span style={{ color: C.crimson }}>▲</span> C2</span>
            <span><span style={{ color: C.green }}>░</span> aurora</span>
            <span style={{ color: C.dim }}>drag · scroll</span>
          </div>
        </div>

        {/* right rail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto', minHeight: 0 }}>
          <GeofenceCard snap={geofence} home={home} radiusKm={radiusKm} onRadius={setRadiusKm} />
          {geomag ? <GeomagCard snap={geomag} /> : <CardLoading label="Geomagnetic" />}
          {seismic ? <SeismicCard snap={seismic} /> : <CardLoading label="Seismic" />}
          {aircraft ? <SkywatchCard snap={aircraft} /> : <CardLoading label="Skywatch" />}
          {vessels ? <VesselCard snap={vessels} /> : <CardLoading label="Vessel AIS" />}
          {cyber ? <CyberCard snap={cyber} /> : <CardLoading label="Cyber" />}
          {outage ? <OutageCard snap={outage} /> : <CardLoading label="Service Outages" />}
          {ipwatch ? <IpWatchCard snap={ipwatch} /> : <CardLoading label="IP Watch" />}
          {pizza && pizza.readings.length > 0 && (
            <>
              <IndexGauge snap={pizza} />
              <VenueList readings={pizza.readings} />
            </>
          )}
        </div>
      </SplitPane>
    </div>
  )
}

function CardLoading({ label }: { label: string }): JSX.Element {
  const C = tokens()
  return (
    <div className="card" style={{ padding: '14px', fontSize: 14, color: C.dim, letterSpacing: 1, textAlign: 'center' }}>
      ESTABLISHING {label.toUpperCase()} UPLINK…
    </div>
  )
}