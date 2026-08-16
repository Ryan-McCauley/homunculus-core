// Additions that sit around the existing HOME tiles: the scene strip, the sector
// strip, and the perimeter / power / media row.
//
// Every tile here follows the convention the original tiles already established —
// render nothing when the entities it needs do not exist — so a house without
// locks or media players simply never sees those tiles rather than seeing empty
// ones.

import type { HaEntity } from '../../../shared/homeassistant'
import type { SectorSummary } from '../../../shared/haSectors'
import { actionId } from '../../../shared/agentManifest'
import { formatHomeRoute } from '../../../shared/homeRoute'
import { agentAttrs, navAttrs } from './agentAttrs'

type Send = (entityId: string, service: string, data: Record<string, unknown>) => void

const OPENING_CLASSES = new Set(['door', 'window', 'garage_door', 'opening'])

// ── Scene strip ────────────────────────────────────────────────────────────

export function SceneStrip({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const scenes = entities.filter((e) => e.domain === 'scene')
  const lights = entities.filter((e) => e.domain === 'light')
  if (!scenes.length && !lights.length) return null

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
      <span className="holo-l" style={{ marginRight: 4 }}>SCENES ▸</span>
      {scenes.map((scene) => (
        <button
          key={scene.entityId}
          type="button"
          className="holo-btn"
          style={{ cursor: 'pointer' }}
          onClick={() => send(scene.entityId, 'scene.turn_on', {})}
          {...agentAttrs(actionId(scene.entityId, 'activate'), `Activate scene ${scene.name}`, 'write')}
        >
          ◈ {scene.name.toUpperCase()}
        </button>
      ))}
      {lights.length > 0 && (
        <button
          type="button"
          className="holo-btn"
          style={{ cursor: 'pointer', color: 'var(--crimson)', borderColor: 'var(--border-crimson)', background: '#e0245e0a' }}
          onClick={() => { for (const l of lights) send(l.entityId, 'light.turn_off', {}) }}
          aria-label={`Turn off all ${lights.length} lights`}
          data-agent-id="light.*:turn_off"
        >
          ⏻ ALL LIGHTS OFF
        </button>
      )}
    </div>
  )
}

// ── Sector strip ───────────────────────────────────────────────────────────

export function SectorStrip({
  sectors, unit, onSelect,
}: { sectors: SectorSummary[]; unit: string; onSelect: (slug: string) => void }): JSX.Element | null {
  if (!sectors.length) return null

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
      <span className="holo-l" style={{ marginRight: 4 }}>SECTORS ▸</span>
      {sectors.map((sector) => {
        const alert = sector.alerts.length > 0
        const lit = sector.lightsOn > 0
        // State is spelled out, not merely coloured: a model reading the DOM (and
        // a person reading at a glance) gets the same facts the styling conveys.
        const parts = [sector.label.toUpperCase()]
        if (sector.lightsTotal) parts.push(lit ? `${sector.lightsOn}/${sector.lightsTotal} LIT` : 'DARK')
        if (sector.temp != null) parts.push(`${Math.round(sector.temp)}${unit}`)
        if (alert) parts.push(sector.alerts[0] as string)

        return (
          <button
            key={sector.id}
            type="button"
            onClick={() => onSelect(sector.id)}
            {...navAttrs(formatHomeRoute({ view: 'sectors', sector: sector.id }), `${sector.label}: ${parts.slice(1).join(', ') || 'no summary'}`)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontSize: 11, letterSpacing: 1, padding: '3px 10px',
              fontFamily: 'var(--font-mono)',
              border: `1px solid ${alert ? '#f5a62355' : lit ? 'var(--border-holo)' : '#2f6b4a55'}`,
              color: alert ? 'var(--amber)' : lit ? 'var(--holo)' : 'var(--green-dim)',
              background: alert ? '#f5a6230a' : lit ? '#2effb008' : 'transparent',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: alert ? 'var(--amber)' : lit ? 'var(--holo)' : 'var(--green-dim)',
                boxShadow: alert || lit ? '0 0 6px currentColor' : 'none',
              }}
            />
            {parts.join(' · ')}
          </button>
        )
      })}
    </div>
  )
}

// ── Perimeter ──────────────────────────────────────────────────────────────

export function PerimeterTile({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const locks = entities.filter((e) => e.domain === 'lock')
  const openings = entities.filter(
    (e) => (e.domain === 'cover' && e.deviceClass !== 'shade')
      || (e.domain === 'binary_sensor' && e.deviceClass && OPENING_CLASSES.has(e.deviceClass)),
  )
  if (!locks.length && !openings.length) return null

  const row = (label: string, stateText: string, tone: string): JSX.Element => (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span className="holo-l" style={{ color: 'var(--green-soft)' }}>{label}</span>
      <span style={{ color: tone, fontSize: 12.5 }}>{stateText}</span>
    </div>
  )

  return (
    <div className="holo">
      <div className="holo-h"><i className="ti ti-shield-lock" style={{ marginRight: 8 }} />PERIMETER</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 9 }}>
        {locks.map((lock) => row(
          lock.name.toUpperCase(),
          lock.state === 'locked' ? 'LOCKED' : lock.state.toUpperCase(),
          lock.state === 'locked' ? 'var(--holo)' : 'var(--crimson)',
        ))}
        {openings.map((o) => row(
          o.name.toUpperCase(),
          o.state === 'open' || o.state === 'on' ? 'OPEN' : 'CLOSED',
          o.state === 'open' || o.state === 'on' ? 'var(--amber)' : 'var(--green-dim)',
        ))}
      </div>
      {locks.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="holo-btn"
            style={{ cursor: 'pointer' }}
            onClick={() => { for (const l of locks) send(l.entityId, 'lock.lock', {}) }}
            aria-label={`Lock all ${locks.length} locks`}
            data-agent-id="lock.*:lock"
          >
            LOCK ALL
          </button>
        </div>
      )}
    </div>
  )
}

// ── Power ──────────────────────────────────────────────────────────────────

export function PowerTile({ entities }: { entities: HaEntity[] }): JSX.Element | null {
  const power = entities.filter((e) => e.deviceClass === 'power' && Number.isFinite(Number(e.state)))
  if (!power.length) return null

  const watts = power.reduce((sum, e) => sum + Number(e.state), 0)
  const energy = entities.find((e) => e.deviceClass === 'energy' && Number.isFinite(Number(e.state)))

  return (
    <div className="holo">
      <div className="holo-h"><i className="ti ti-bolt" style={{ marginRight: 8 }} />POWER DRAW</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
        <span className="holo-v" style={{ fontSize: 26 }}>{(watts / 1000).toFixed(2)}</span>
        <span className="holo-l">KW NOW</span>
      </div>
      <div className="holo-l" style={{ marginTop: 8 }}>
        {power.length} METER{power.length > 1 ? 'S' : ''}
        {energy ? ` · TODAY ${Number(energy.state).toFixed(1)} ${energy.unit ?? 'KWH'}` : ''}
      </div>
    </div>
  )
}

// ── Media ──────────────────────────────────────────────────────────────────

export function MediaTile({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const players = entities.filter((e) => e.domain === 'media_player')
  if (!players.length) return null
  // Prefer whatever is actually playing; fall back to the first so the tile still
  // says which player is idle rather than vanishing.
  const player = players.find((p) => p.state === 'playing') ?? players[0] as HaEntity
  const title = (player.attributes['media_title'] as string) || null
  const volume = player.attributes['volume_level'] as number | undefined

  return (
    <div className="holo">
      <div className="holo-h"><i className="ti ti-music" style={{ marginRight: 8 }} />MEDIA</div>
      <div className="holo-v" style={{ marginTop: 8, fontSize: 15 }}>{player.name.toUpperCase()}</div>
      <div className="holo-l" style={{ marginTop: 4 }}>
        {player.state.toUpperCase()}{title ? ` · ${title}` : ''}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button" className="holo-btn" style={{ cursor: 'pointer' }}
          onClick={() => send(player.entityId, player.state === 'playing' ? 'media_player.media_pause' : 'media_player.media_play', {})}
          {...agentAttrs(actionId(player.entityId, player.state === 'playing' ? 'pause' : 'play'),
            `${player.state === 'playing' ? 'Pause' : 'Play'} ${player.name}`, 'write')}
        >
          {player.state === 'playing' ? '⏸ PAUSE' : '▶ PLAY'}
        </button>
        {volume != null && <span className="holo-l">VOL {Math.round(volume * 100)}%</span>}
      </div>
    </div>
  )
}
