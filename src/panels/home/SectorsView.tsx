// SECTORS — the room drill-down.
//
// An area rail on the left, and the selected room's entities grouped by what you
// do with them: luminaires get brightness, relays get toggles, everything else
// reads out as telemetry. This is where "control any light in any room" lives,
// which is what keeps the OVERVIEW free to stay a summary.

import type { HaEntity } from '../../../shared/homeassistant'
import type { SectorSummary } from '../../../shared/haSectors'
import { actionId } from '../../../shared/agentManifest'
import { formatHomeRoute } from '../../../shared/homeRoute'
import { agentAttrs, navAttrs } from './agentAttrs'

type Send = (entityId: string, service: string, data: Record<string, unknown>) => void

interface Props {
  sectors: SectorSummary[]
  selected: SectorSummary | null
  entities: HaEntity[]
  unit: string
  send: Send
  onSelect: (slug: string) => void
}

/** HA carries brightness as 0..255; the UI and the manifest both speak percent. */
function brightnessPct(entity: HaEntity): number {
  const raw = entity.attributes['brightness']
  if (typeof raw !== 'number') return entity.state === 'on' ? 100 : 0
  return Math.round((raw / 255) * 100)
}

export function SectorsView({ sectors, selected, entities, unit, send, onSelect }: Props): JSX.Element {
  if (!sectors.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--green-dim)', letterSpacing: 1 }}>
        NO SECTORS — HOME ASSISTANT AREAS UNAVAILABLE
      </div>
    )
  }

  const byId = new Map(entities.map((e) => [e.entityId, e]))
  const members = (selected?.entityIds ?? [])
    .map((id) => byId.get(id))
    .filter((e): e is HaEntity => e !== undefined)

  const lights = members.filter((e) => e.domain === 'light')
  const relays = members.filter((e) => e.domain === 'switch' || e.domain === 'fan')
  const readings = members.filter((e) => e.domain === 'sensor' && Number.isFinite(Number(e.state)))

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '210px minmax(0,1fr)', gap: 12 }}>
      {/* area rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} role="navigation" aria-label="Sectors">
        {sectors.map((sector) => {
          const on = sector.id === selected?.id
          const alert = sector.alerts.length > 0
          return (
            <button
              key={sector.id}
              type="button"
              className="holo"
              onClick={() => onSelect(sector.id)}
              aria-current={on ? 'true' : undefined}
              {...navAttrs(formatHomeRoute({ view: 'sectors', sector: sector.id }), `Sector ${sector.label}`)}
              style={{
                padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                opacity: on ? 1 : 0.65,
                borderColor: alert ? '#f5a62366' : on ? '#2effb0aa' : undefined,
                boxShadow: on ? '0 0 14px #2effb022' : undefined,
              }}
            >
              <div className="holo-h" style={{ fontSize: 12, color: alert ? 'var(--amber)' : on ? 'var(--holo)' : 'var(--holo-dim)' }}>
                {sector.label.toUpperCase()}{alert ? ' ⚠' : ''}
              </div>
              <div className="holo-l" style={{ marginTop: 3 }}>
                {sector.entityIds.length} ENTITIES
                {sector.lightsTotal > 0 && ` · ${sector.lightsOn > 0 ? `${sector.lightsOn}/${sector.lightsTotal} LIT` : 'DARK'}`}
              </div>
            </button>
          )
        })}
      </div>

      {/* selected sector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <span className="holo-h" style={{ fontSize: 17 }}>SECTOR: {(selected?.label ?? '—').toUpperCase()}</span>
          <span className="holo-l">
            {selected?.temp != null && `${selected.temp}${unit} · `}
            {selected?.humidity != null && `RH ${selected.humidity}% · `}
            {selected ? `${selected.lightsOn}/${selected.lightsTotal} LIT` : ''}
            {selected?.power != null && ` · ${Math.round(selected.power)} W`}
          </span>
          {lights.length > 0 && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button
                type="button" className="holo-btn" style={{ cursor: 'pointer' }}
                onClick={() => { for (const l of lights) send(l.entityId, 'light.turn_on', {}) }}
                aria-label={`Turn on every light in ${selected?.label ?? 'this sector'}`}
              >ALL ON</button>
              <button
                type="button" className="holo-btn"
                style={{ cursor: 'pointer', color: 'var(--crimson)', borderColor: 'var(--border-crimson)' }}
                onClick={() => { for (const l of lights) send(l.entityId, 'light.turn_off', {}) }}
                aria-label={`Turn off every light in ${selected?.label ?? 'this sector'}`}
              >ALL OFF</button>
            </span>
          )}
        </div>

        {selected && selected.alerts.length > 0 && (
          <div className="holo" style={{ borderColor: '#f5a62366' }}>
            <div className="holo-h" style={{ fontSize: 13, color: 'var(--amber)' }}>ATTENTION</div>
            <div className="holo-l" style={{ marginTop: 6, color: 'var(--amber)' }}>{selected.alerts.join(' · ')}</div>
          </div>
        )}

        {lights.length > 0 && (
          <div className="holo">
            <div className="holo-h" style={{ fontSize: 13 }}><i className="ti ti-bulb" style={{ marginRight: 8 }} />LUMINAIRES</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
              {lights.map((light) => {
                const pct = brightnessPct(light)
                const on = light.state === 'on'
                return (
                  <div key={light.entityId} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: on ? 1 : 0.55 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto',
                        background: on ? 'var(--holo)' : 'var(--green-dim)',
                        boxShadow: on ? '0 0 6px var(--holo)' : 'none',
                      }}
                    />
                    <span className="holo-l" style={{ width: 150, color: on ? 'var(--green-soft)' : undefined }}>
                      {light.name.toUpperCase()}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={pct}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        if (next === 0) send(light.entityId, 'light.turn_off', {})
                        else send(light.entityId, 'light.turn_on', { brightness_pct: next })
                      }}
                      {...agentAttrs(actionId(light.entityId, 'set_brightness'),
                        `${light.name} brightness, currently ${on ? `${pct} percent` : 'off'}`, 'write')}
                      style={{ flex: 1, accentColor: 'var(--holo)' }}
                    />
                    <span className="holo-v" style={{ width: 46, textAlign: 'right', fontSize: 13, color: on ? undefined : 'var(--green-dim)' }}>
                      {on ? `${pct}%` : 'OFF'}
                    </span>
                    <button
                      type="button" className="holo-btn" style={{ cursor: 'pointer' }}
                      onClick={() => send(light.entityId, on ? 'light.turn_off' : 'light.turn_on', {})}
                      {...agentAttrs(actionId(light.entityId, on ? 'turn_off' : 'turn_on'),
                        `Turn ${on ? 'off' : 'on'} ${light.name}`, 'write')}
                    >⏻</button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
          {relays.length > 0 && (
            <div className="holo">
              <div className="holo-h" style={{ fontSize: 13 }}><i className="ti ti-power" style={{ marginRight: 8 }} />RELAYS</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {relays.map((relay) => {
                  const on = relay.state === 'on'
                  return (
                    <div key={relay.entityId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <span className="holo-l" style={{ color: 'var(--green-soft)' }}>{relay.name.toUpperCase()}</span>
                      <button
                        type="button" className="holo-btn"
                        style={{
                          cursor: 'pointer', padding: '2px 10px',
                          ...(on ? { color: '#03130d', background: 'var(--holo)', boxShadow: '0 0 12px #2effb055' } : {}),
                        }}
                        onClick={() => send(relay.entityId, `${relay.domain}.turn_${on ? 'off' : 'on'}`, {})}
                        {...agentAttrs(actionId(relay.entityId, on ? 'turn_off' : 'turn_on'),
                          `${relay.name} is ${on ? 'on' : 'off'}; turn it ${on ? 'off' : 'on'}`, 'write')}
                      >
                        {on ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {readings.length > 0 && (
            <div className="holo">
              <div className="holo-h" style={{ fontSize: 13 }}><i className="ti ti-gauge" style={{ marginRight: 8 }} />TELEMETRY</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                {readings.slice(0, 8).map((sensor) => (
                  <div key={sensor.entityId}>
                    <div className="holo-l">{sensor.name.toUpperCase()}</div>
                    <div className="holo-v">{sensor.state}{sensor.unit ? ` ${sensor.unit}` : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
