// REGISTRY — every entity, raw.
//
// This is the escape hatch that makes "all of Home Assistant" true rather than
// aspirational: a domain rail, a search, a table of everything, and a service
// console that can call any domain.service with a JSON payload.
//
// The console is deliberately unrestricted, and that is a considered position
// rather than an oversight. It is the operator driving their own house from their
// own machine — the same authority the WS 'ha' channel already grants the tiles.
// The restricted path is the AGENT one (shared/agentManifest.ts), because that is
// where a command can originate from model-authored text rather than from someone
// typing it.

import { useState } from 'react'
import type { HaEntity } from '../../../shared/homeassistant'
import { domainCounts, filterEntities, sortEntities, type RegistrySort } from '../../../shared/haRegistry'
import { formatHomeRoute, type HomeRoute } from '../../../shared/homeRoute'
import { relTime } from '../../lib/ha'
import { navAttrs } from './agentAttrs'

type Send = (entityId: string, service: string, data: Record<string, unknown>) => void

interface Props {
  entities: HaEntity[]
  route: HomeRoute
  onNavigate: (next: HomeRoute) => void
  send: Send
}

export function RegistryView({ entities, route, onNavigate, send }: Props): JSX.Element {
  const [sort, setSort] = useState<RegistrySort>('changed')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [svcEntity, setSvcEntity] = useState('')
  const [svcName, setSvcName] = useState('')
  const [svcData, setSvcData] = useState('{}')
  const [svcResult, setSvcResult] = useState<string | null>(null)

  const counts = domainCounts(entities)
  const shown = sortEntities(filterEntities(entities, { domain: route.domain, q: route.q }), sort)

  const setFilter = (patch: Partial<HomeRoute>): void =>
    onNavigate({ ...route, view: 'registry', ...patch })

  const transmit = (): void => {
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(svcData || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload must be a JSON object')
      payload = parsed as Record<string, unknown>
    } catch (err) {
      setSvcResult(`PAYLOAD REJECTED — ${(err as Error).message}`)
      return
    }
    if (!svcEntity.trim() || !svcName.includes('.')) {
      setSvcResult('NEEDS AN ENTITY ID AND A domain.service')
      return
    }
    send(svcEntity.trim(), svcName.trim(), payload)
    setSvcResult(`SENT ${svcName.trim()} → ${svcEntity.trim()}`)
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px minmax(0,1fr)', gap: 12 }}>
      {/* domain rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }} role="navigation" aria-label="Domains">
        <div className="holo-l" style={{ marginBottom: 4 }}>DOMAINS</div>
        <RailChip
          label="ALL" count={entities.length} on={!route.domain}
          route={formatHomeRoute({ view: 'registry', q: route.q })}
          onClick={() => setFilter({ domain: undefined })}
        />
        {counts.map((c) => (
          <RailChip
            key={c.domain} label={c.domain} count={c.count} on={route.domain === c.domain}
            route={formatHomeRoute({ view: 'registry', domain: c.domain, q: route.q })}
            onClick={() => setFilter({ domain: c.domain })}
          />
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* search */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            value={route.q ?? ''}
            placeholder="▸ QUERY"
            onChange={(e) => setFilter({ q: e.target.value || undefined })}
            aria-label="Search entities by id or name"
            style={{
              flex: 1, minWidth: 200, padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 13,
              letterSpacing: 1, color: 'var(--holo)', background: '#2effb006',
              border: '1px solid var(--border-holo)', outline: 'none',
            }}
          />
          <label className="holo-l">
            SORT{' '}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as RegistrySort)}
              aria-label="Sort entities"
              style={{ background: 'transparent', color: 'var(--holo)', border: '1px solid var(--border-holo)', padding: '4px 8px', fontFamily: 'var(--font-mono)' }}
            >
              <option value="changed">CHANGED</option>
              <option value="name">NAME</option>
              <option value="id">ID</option>
              <option value="state">STATE</option>
            </select>
          </label>
        </div>

        {/* entity table */}
        <div className="holo" style={{ padding: '4px 6px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                {['ENTITY ID', 'NAME', 'STATE', 'CHANGED'].map((h) => (
                  <th key={h} style={{ fontSize: 10, letterSpacing: 2, color: 'var(--holo-dim)', textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border-holo)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 200).map((e) => (
                <tr
                  key={e.entityId}
                  onClick={() => setExpanded(expanded === e.entityId ? null : e.entityId)}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid #2effb00e', color: 'var(--green-soft)' }}>
                    {e.entityId}
                    {expanded === e.entityId && (
                      <pre style={{ marginTop: 6, fontSize: 11, color: '#8fd4ad', whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify(e.attributes, null, 2)}
                      </pre>
                    )}
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid #2effb00e', color: '#8fd4ad' }}>{e.name}</td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid #2effb00e', color: 'var(--holo)', fontVariantNumeric: 'tabular-nums' }}>
                    {e.state}{e.unit ? ` ${e.unit}` : ''}
                  </td>
                  <td style={{ padding: '6px 10px', borderBottom: '1px solid #2effb00e', color: '#8fd4ad' }}>{relTime(e.lastChanged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="holo-l" style={{ padding: '8px 10px' }}>
            {shown.length} OF {entities.length} MATCH{shown.length > 200 ? ' · SHOWING FIRST 200' : ''} · CLICK A ROW FOR ATTRIBUTES
          </div>
        </div>

        {/* service console */}
        <div className="holo" style={{ borderColor: 'var(--border-crimson)', boxShadow: 'inset 0 0 22px #e0245e08' }}>
          <div className="holo-h" style={{ fontSize: 13, color: 'var(--crimson)', textShadow: '0 0 9px #e0245e55' }}>
            <i className="ti ti-terminal-2" style={{ marginRight: 8 }} />SERVICE UPLINK
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px,1fr) minmax(140px,1fr) minmax(180px,2fr) auto', gap: 10, marginTop: 10, alignItems: 'center' }}>
            <input
              value={svcName} onChange={(e) => setSvcName(e.target.value)} placeholder="light.turn_on"
              aria-label="Service to call, in domain.service form" style={consoleField}
            />
            <input
              value={svcEntity} onChange={(e) => setSvcEntity(e.target.value)} placeholder="light.shelf_strip"
              aria-label="Target entity id" style={consoleField}
            />
            <input
              value={svcData} onChange={(e) => setSvcData(e.target.value)} placeholder='{"brightness_pct": 60}'
              aria-label="JSON payload" style={consoleField}
            />
            <button
              type="button" className="holo-btn"
              style={{ cursor: 'pointer', color: 'var(--crimson)', borderColor: 'var(--border-crimson)', background: '#e0245e0a' }}
              onClick={transmit}
              aria-label="Send this service call to Home Assistant"
            >TRANSMIT ▸</button>
          </div>
          {svcResult && <div className="holo-l" style={{ marginTop: 8 }}>{svcResult}</div>}
        </div>
      </div>
    </div>
  )
}

const consoleField: React.CSSProperties = {
  padding: '5px 10px', fontFamily: 'var(--font-mono)', fontSize: 12,
  color: '#8fd4ad', background: 'transparent', border: '1px solid #2effb022', outline: 'none',
}

function RailChip({
  label, count, on, route, onClick,
}: { label: string; count: number; on: boolean; route: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? 'true' : undefined}
      {...navAttrs(route, `Filter to ${label}, ${count} entities`)}
      style={{
        display: 'flex', justifyContent: 'space-between', gap: 8, cursor: 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1, padding: '3px 10px',
        color: on ? 'var(--holo)' : 'var(--green-dim)',
        border: `1px solid ${on ? '#2effb0aa' : '#2f6b4a55'}`,
        background: on ? '#2effb008' : 'transparent',
        boxShadow: on ? '0 0 8px #2effb022' : undefined,
      }}
    >
      <span>{label}</span><span>{count}</span>
    </button>
  )
}
