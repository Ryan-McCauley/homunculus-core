import { useState } from 'react'
import { useHomeAssistant } from '../hooks/useHomeAssistant'
import type { HaClimateState } from '../../shared/homeassistant'
import { ThermostatOverlay, ThermostatInline, ThermostatSheet } from './ThermostatControl'
import { ThermostatRadial } from './ThermostatRadial'
import { ThermostatRange } from './ThermostatRange'

// Switch between variants to preview each. 'range' is the dual-handle
// horizontal slider (single handle for heat/cool/auto, two for heat_cool).
const CONTROL_VARIANT: 'range' | 'radial' | 'overlay' | 'inline' | 'sheet' = 'range'

// Map HVAC action to a status color token.
function actionColor(action: string | null, state: string): string {
  if (state === 'unavailable' || state === 'off') return 'var(--green-dim)'
  switch (action) {
    case 'heating': return 'var(--crimson)'
    case 'cooling': return '#4aa8ff'
    case 'idle': return 'var(--green-dim)'
    default: return 'var(--green)'
  }
}

function actionLabel(action: string | null, state: string): string {
  if (state === 'unavailable') return 'UNAVAIL'
  if (state === 'off') return 'OFF'
  if (!action) return state.toUpperCase()
  return action.toUpperCase()
}

function fmtTemp(val: number | null, unit: string): string {
  if (val == null) return '—'
  return `${val}${unit}`
}

function ClimateCard({ entity, unit, onClick }: { entity: HaClimateState; unit: string; onClick: () => void }): JSX.Element {
  const color = actionColor(entity.hvacAction, entity.state)
  const label = actionLabel(entity.hvacAction, entity.state)
  const current = fmtTemp(entity.currentTemp, unit)
  const target =
    entity.targetTempLow != null && entity.targetTempHigh != null
      ? `${fmtTemp(entity.targetTempLow, unit)} – ${fmtTemp(entity.targetTempHigh, unit)}`
      : fmtTemp(entity.targetTemp, unit)

  return (
    <div
      className="card"
      onClick={onClick}
      style={{ borderColor: color === 'var(--green-dim)' ? undefined : color + '55', cursor: 'pointer' }}
    >
      {/* Entity name + status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span
          style={{
            fontSize: 13,
            letterSpacing: 1,
            color: 'var(--green-soft)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '65%'
          }}
        >
          {entity.name}
        </span>
        <span
          style={{
            fontSize: 12,
            letterSpacing: 1,
            color,
            border: `0.5px solid ${color}55`,
            padding: '2px 5px'
          }}
        >
          {label}
        </span>
      </div>

      {/* Temperature row */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green-dim)', marginBottom: 2 }}>
            CURRENT
          </div>
          <div style={{ fontSize: 22, color, letterSpacing: -0.5, fontFamily: 'var(--font-display)' }}>
            {current}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green-dim)', marginBottom: 2 }}>
            TARGET
          </div>
          <div style={{ fontSize: 18, color: 'var(--green-soft)', letterSpacing: -0.5 }}>
            {target}
          </div>
        </div>
        {entity.humidity != null && (
          <div style={{ marginLeft: 'auto' }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green-dim)', marginBottom: 2 }}>
              RH
            </div>
            <div style={{ fontSize: 17, color: 'var(--green-dim)' }}>
              {entity.humidity}%
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function HomeAssistant(): JSX.Element {
  const snap = useHomeAssistant()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const connected = snap?.connected ?? null
  const climate = snap?.climate ?? []
  const unit = snap?.tempUnit ?? '°F'
  const selected = climate.find((e) => e.entityId === selectedId) ?? null

  // Link to the HA web panel. HA_URL is the SERVER's view of HA (usually
  // localhost:8123, same host) — when this UI is loaded remotely (Tailscale
  // phone/browser), swap the localhost hostname for the page's host so the
  // link points at the machine actually running HA.
  const haUrl = (() => {
    const raw = snap?.url
    if (!raw) return null
    try {
      const u = new URL(raw)
      const pageHost = window.location.hostname
      if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1')
        && pageHost && pageHost !== 'localhost' && pageHost !== '127.0.0.1') {
        u.hostname = pageHost
      }
      return u.toString()
    } catch {
      return raw
    }
  })()

  function sendCmd(entityId: string, service: string, data: Record<string, unknown>): void {
    window.homunculus?.sendHaCommand(entityId, service, data)
  }

  const controlProps = selected
    ? {
        entity: selected,
        unit,
        onClose: () => setSelectedId(null),
        onSetTemp: (temp: number) => sendCmd(selected.entityId, 'climate.set_temperature', { temperature: temp }),
        onSetMode: (mode: string) => sendCmd(selected.entityId, 'climate.set_hvac_mode', { hvac_mode: mode }),
        onSetRange: (low: number, high: number) =>
          sendCmd(selected.entityId, 'climate.set_temperature', { target_temp_low: low, target_temp_high: high })
      }
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Panel header */}
      <div className="panel-label">
        <span>
          Home Assistant
          {haUrl && (
            <a
              href={haUrl}
              target="_blank"
              rel="noreferrer"
              title={`Open Home Assistant (${haUrl})`}
              style={{ color: 'var(--green-dim)', textDecoration: 'none', marginLeft: 8 }}
            >
              OPEN ↗
            </a>
          )}
        </span>
        <span
          className={connected == null ? 'muted' : connected ? undefined : 'alert'}
        >
          {connected == null ? 'CONNECTING' : connected ? 'LINKED' : 'OFFLINE'}
        </span>
      </div>

      {/* Not configured */}
      {connected === false && climate.length === 0 && (
        <div
          className="card"
          style={{ fontSize: 13, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 16 }}
        >
          SET HA_URL + HA_TOKEN IN .ENV
        </div>
      )}

      {/* No climate entities */}
      {connected === true && climate.length === 0 && (
        <div
          className="card"
          style={{ fontSize: 13, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 16 }}
        >
          NO CLIMATE ENTITIES FOUND
        </div>
      )}

      {/* Climate cards */}
      {climate.map((e) =>
        CONTROL_VARIANT === 'inline' && selectedId === e.entityId && controlProps ? (
          <ThermostatInline key={e.entityId} {...controlProps} />
        ) : (
          <ClimateCard key={e.entityId} entity={e} unit={unit} onClick={() => setSelectedId(e.entityId)} />
        )
      )}

      {/* Overlay / sheet / radial / range variants rendered outside the card list */}
      {controlProps && CONTROL_VARIANT === 'range' && <ThermostatRange {...controlProps} />}
      {controlProps && CONTROL_VARIANT === 'radial' && <ThermostatRadial {...controlProps} />}
      {controlProps && CONTROL_VARIANT === 'overlay' && <ThermostatOverlay {...controlProps} />}
      {controlProps && CONTROL_VARIANT === 'sheet' && <ThermostatSheet {...controlProps} />}
    </div>
  )
}
