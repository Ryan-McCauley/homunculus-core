// The full-width ARCHIVE tab — the bridge's "ship's log". A persisted,
// reverse-chronological, colour-coded console of every notable event the system
// emits (proactive alerts, OSINT escalations, geofence breaches, system
// messages), backed by the ArchiveHub (server/archive.ts) over the `archive` WS
// channel. Filter by source + minimum severity + free-text search.
//
// Plan: docs/data-archive-plan.md (Part A-A: AA1 persist · AA2 console · AA3 search).

import { useMemo, useState } from 'react'
import { useArchive } from '../hooks/useArchive'
import {
  EVENT_SOURCES, EVENT_SEVERITIES, SEVERITY_RANK,
  type EventSource, type EventSeverity, type ArchiveEvent
} from '../../shared/archive'

// Severity → phosphor colour token.
const SEV_COLOR: Record<EventSeverity, string> = {
  info: 'var(--green-dim)',
  notice: 'var(--green)',
  warn: 'var(--amber)',
  critical: 'var(--crimson)'
}
const SOURCE_COLOR: Record<EventSource, string> = {
  OSINT: 'var(--blue)',
  HOME: 'var(--green)',
  COMPUTER: 'var(--holo)',
  CRYPTO: 'var(--amber)',
  FINANCE: 'var(--holo)',
  SYSTEM: 'var(--green-dim)'
}

function fmtTime(ts: number): { date: string; time: string } {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return {
    date: `${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
}

// ── Filter pill ───────────────────────────────────────────────────────────────
function Pill({ active, color, onClick, children }: {
  active: boolean; color?: string; onClick: () => void; children: React.ReactNode
}): JSX.Element {
  const c = color ?? 'var(--green)'
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: 1, padding: '5px 11px', cursor: 'pointer',
        color: active ? 'var(--bg)' : 'var(--green-dim)',
        background: active ? c : 'transparent',
        border: `0.5px solid ${active ? c : 'var(--border)'}`, whiteSpace: 'nowrap'
      }}
    >
      {children}
    </button>
  )
}

// ── Log row ───────────────────────────────────────────────────────────────────
function LogRow({ e }: { e: ArchiveEvent }): JSX.Element {
  const sev = SEV_COLOR[e.severity]
  const t = fmtTime(e.ts)
  // Strip the redundant leading title from the body for the secondary line.
  const body = e.body.replace(/^captain\s*[—–-]\s*/i, '')
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '92px 78px 1fr', gap: 12, alignItems: 'baseline',
      padding: '7px 10px', borderBottom: '0.5px solid var(--border)',
      borderLeft: `2px solid ${sev}`, background: 'var(--bg-panel)'
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--green-dim)', whiteSpace: 'nowrap' }}>
        <span style={{ color: 'var(--green-soft)' }}>{t.time}</span><br />
        <span style={{ fontSize: 12 }}>{t.date}</span>
      </div>
      <div style={{ fontSize: 12, letterSpacing: 1, color: SOURCE_COLOR[e.source], alignSelf: 'center' }}>
        <i className="ti ti-point-filled" style={{ fontSize: 13, color: sev, marginRight: 3 }} />{e.source}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, letterSpacing: 0.5, color: sev, fontFamily: 'var(--font-display)' }}>{e.title}</div>
        <div style={{ fontSize: 14, color: 'var(--green-soft)', marginTop: 1, lineHeight: 1.35 }}>{body}</div>
      </div>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export function ArchiveDashboard(): JSX.Element {
  const { events, ready } = useArchive()
  const [source, setSource] = useState<EventSource | 'ALL'>('ALL')
  const [minSev, setMinSev] = useState<EventSeverity>('info')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const floor = SEVERITY_RANK[minSev]
    return events.filter((e) =>
      (source === 'ALL' || e.source === source) &&
      SEVERITY_RANK[e.severity] >= floor &&
      (!q || e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q))
    )
  }, [events, source, minSev, search])

  // Per-source counts for the masthead.
  const critical = events.filter((e) => e.severity === 'critical').length

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* masthead */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid var(--border-crimson)', paddingBottom: 9, marginBottom: 12
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, letterSpacing: 4, color: 'var(--green)', textShadow: 'var(--glow-green)' }}>
          <i className="ti ti-history" style={{ marginRight: 8 }} />SHIP'S LOG · ARCHIVE
        </div>
        <div style={{ fontSize: 13, letterSpacing: 2, color: 'var(--green-dim)' }}>
          {!ready ? 'LINKING…' : <>{events.length} LOGGED{critical > 0 && <> · <span style={{ color: 'var(--crimson)' }}>{critical} CRITICAL</span></>}</>}
        </div>
      </div>

      {/* filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginRight: 2 }}>SOURCE</span>
        <Pill active={source === 'ALL'} onClick={() => setSource('ALL')}>ALL</Pill>
        {EVENT_SOURCES.map((s) => (
          <Pill key={s} active={source === s} color={SOURCE_COLOR[s]} onClick={() => setSource(s)}>{s}</Pill>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginRight: 2 }}>MIN SEV</span>
        {EVENT_SEVERITIES.map((s) => (
          <Pill key={s} active={minSev === s} color={SEV_COLOR[s]} onClick={() => setMinSev(s)}>{s.toUpperCase()}</Pill>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search log…"
          style={{
            marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 14, padding: '5px 9px',
            background: 'var(--bg-panel)', border: '0.5px solid var(--border)', color: 'var(--green-soft)', width: 220
          }}
        />
      </div>

      {/* log console */}
      <div style={{ flex: 1, overflow: 'auto', border: '0.5px solid var(--border)', background: 'var(--svg-deep)' }}>
        {!ready ? (
          <Empty text="ESTABLISHING LINK TO ARCHIVE…" />
        ) : events.length === 0 ? (
          <Empty text="NO EVENTS LOGGED YET — ALERTS & ESCALATIONS WILL APPEAR HERE" />
        ) : filtered.length === 0 ? (
          <Empty text="NO EVENTS MATCH THE CURRENT FILTERS" />
        ) : (
          filtered.map((e) => <LogRow key={e.id} e={e} />)
        )}
      </div>
      <div style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)', marginTop: 6, textAlign: 'right' }}>
        SHOWING {filtered.length} / {events.length} · LIVE
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div style={{
      height: '100%', minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, letterSpacing: 2, color: 'var(--green-dim)', textAlign: 'center', padding: 24
    }}>
      {text}
    </div>
  )
}
