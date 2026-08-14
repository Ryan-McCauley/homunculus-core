// Three control UI variants for a selected climate entity.
// HomeAssistant.tsx imports whichever is active via CONTROL_VARIANT.

import { useState, useEffect } from 'react'
import type { HaClimateState } from '../../shared/homeassistant'

export interface ControlProps {
  entity: HaClimateState
  unit: string
  onClose: () => void
  onSetTemp: (temp: number) => void
  onSetMode: (mode: string) => void
  onSetRange?: (low: number, high: number) => void
}

export const HVAC_MODES = ['heat', 'cool', 'heat_cool', 'auto', 'off'] as const

export function modeColor(mode: string): string {
  if (mode === 'heat') return 'var(--crimson)'
  if (mode === 'cool') return 'var(--cool-color)'
  if (mode === 'off') return 'var(--green-dim)'
  return 'var(--green)'
}

function stepTemp(val: number | null, unit: string, dir: 1 | -1): number {
  const step = unit === '°C' ? 0.5 : 1
  return (val ?? (unit === '°C' ? 20 : 70)) + dir * step
}

// ── Variant A: Full-screen overlay ───────────────────────────────────────
export function ThermostatOverlay({ entity, unit, onClose, onSetTemp, onSetMode }: ControlProps): JSX.Element {
  const [pendingTemp, setPendingTemp] = useState<number>(
    entity.targetTemp ?? (unit === '°C' ? 20 : 70)
  )
  const [pendingMode, setPendingMode] = useState<string>(entity.state)

  const color = modeColor(pendingMode)
  const current = entity.currentTemp != null ? `${entity.currentTemp}${unit}` : '—'

  function commitTemp(): void {
    onSetTemp(pendingTemp)
  }

  function commitMode(mode: string): void {
    setPendingMode(mode)
    onSetMode(mode)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(2,6,10,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          border: `0.5px solid ${color}44`,
          background: 'var(--bg-elev)',
          padding: '24px 28px',
          display: 'flex', flexDirection: 'column', gap: 20
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 4 }}>
              CLIMATE CONTROL
            </div>
            <div style={{ fontSize: 16, letterSpacing: 1, color: 'var(--green)' }}>
              {entity.name.toUpperCase()}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--green-dim)', cursor: 'pointer', fontSize: 19, lineHeight: 1 }}>✕</button>
        </div>

        {/* Current temp display */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 6 }}>AMBIENT</div>
          <div style={{ fontSize: 48, color, letterSpacing: -2, fontFamily: 'var(--font-display)', lineHeight: 1 }}>
            {current}
          </div>
        </div>

        {/* Target temp control */}
        <div>
          <div style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 10, textAlign: 'center' }}>TARGET SETPOINT</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
            <TempButton onClick={() => setPendingTemp(t => stepTemp(t, unit, -1))}>▼</TempButton>
            <div style={{ minWidth: 80, textAlign: 'center' }}>
              <span style={{ fontSize: 32, color: 'var(--green)', fontFamily: 'var(--font-display)', letterSpacing: -1 }}>
                {pendingTemp}
              </span>
              <span style={{ fontSize: 19, color: 'var(--green-dim)', marginLeft: 2 }}>{unit}</span>
            </div>
            <TempButton onClick={() => setPendingTemp(t => stepTemp(t, unit, 1))}>▲</TempButton>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <ActionBtn color={color} onClick={commitTemp}>APPLY</ActionBtn>
          </div>
        </div>

        {/* HVAC mode selector */}
        <div>
          <div style={{ fontSize: 12, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 8 }}>HVAC MODE</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {HVAC_MODES.map((m) => {
              const active = pendingMode === m
              const c = modeColor(m)
              return (
                <button
                  key={m}
                  onClick={() => commitMode(m)}
                  style={{
                    flex: 1, minWidth: 48,
                    padding: '5px 4px',
                    fontSize: 12, letterSpacing: 1,
                    background: active ? c + '22' : 'transparent',
                    border: `0.5px solid ${active ? c : 'var(--border)'}`,
                    color: active ? c : 'var(--green-dim)',
                    cursor: 'pointer'
                  }}
                >
                  {m.toUpperCase().replace('_', '/')}
                </button>
              )
            })}
          </div>
        </div>

        {/* Humidity */}
        {entity.humidity != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '0.5px solid var(--border)', paddingTop: 12 }}>
            <span style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)' }}>RELATIVE HUMIDITY</span>
            <span style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green)' }}>{entity.humidity}%</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Variant B: Inline card expansion ─────────────────────────────────────
export function ThermostatInline({ entity, unit, onClose, onSetTemp, onSetMode }: ControlProps): JSX.Element {
  const [pendingTemp, setPendingTemp] = useState<number>(
    entity.targetTemp ?? (unit === '°C' ? 20 : 70)
  )

  const color = modeColor(entity.state)

  return (
    <div
      style={{
        border: `0.5px solid ${color}66`,
        background: 'var(--bg)',
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10
      }}
    >
      {/* Mini header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, letterSpacing: 1, color }}>
          {entity.state.toUpperCase()} · {entity.hvacAction?.toUpperCase() ?? '—'}
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--green-dim)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>✕</button>
      </div>

      {/* Temps side by side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green-dim)', marginBottom: 2 }}>NOW</div>
          <div style={{ fontSize: 26, color, fontFamily: 'var(--font-display)', letterSpacing: -1 }}>
            {entity.currentTemp != null ? `${entity.currentTemp}${unit}` : '—'}
          </div>
        </div>

        {/* Stepper */}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green-dim)', marginBottom: 4 }}>SET</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TempButton small onClick={() => setPendingTemp(t => stepTemp(t, unit, -1))}>−</TempButton>
            <span style={{ fontSize: 19, color: 'var(--green)', fontFamily: 'var(--font-display)', minWidth: 52, textAlign: 'center' }}>
              {pendingTemp}{unit}
            </span>
            <TempButton small onClick={() => setPendingTemp(t => stepTemp(t, unit, 1))}>+</TempButton>
            <ActionBtn color={color} small onClick={() => onSetTemp(pendingTemp)}>SET</ActionBtn>
          </div>
        </div>
      </div>

      {/* Mode pills */}
      <div style={{ display: 'flex', gap: 3 }}>
        {HVAC_MODES.map((m) => {
          const active = entity.state === m
          const c = modeColor(m)
          return (
            <button
              key={m}
              onClick={() => onSetMode(m)}
              style={{
                flex: 1,
                padding: '3px 2px',
                fontSize: 11, letterSpacing: 0.5,
                background: active ? c + '22' : 'transparent',
                border: `0.5px solid ${active ? c : 'var(--border)'}`,
                color: active ? c : 'var(--green-dim)',
                cursor: 'pointer'
              }}
            >
              {m === 'heat_cool' ? 'H/C' : m.toUpperCase()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Variant C: Bottom sheet ───────────────────────────────────────────────
export function ThermostatSheet({ entity, unit, onClose, onSetTemp, onSetMode }: ControlProps): JSX.Element {
  const [pendingTemp, setPendingTemp] = useState<number>(
    entity.targetTemp ?? (unit === '°C' ? 20 : 70)
  )
  const [visible, setVisible] = useState(false)

  // Animate in
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(id)
  }, [])

  function handleClose(): void {
    setVisible(false)
    setTimeout(onClose, 220)
  }

  const color = modeColor(entity.state)

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: visible ? 'rgba(2,6,10,0.75)' : 'rgba(2,6,10,0)',
        transition: 'background 220ms'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'var(--bg-elev)',
          borderTop: `1px solid ${color}55`,
          padding: '20px 24px 28px',
          transform: visible ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 220ms cubic-bezier(.25,.8,.25,1)',
          display: 'flex', flexDirection: 'column', gap: 18
        }}
      >
        {/* Drag handle + title */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 32, height: 2, background: 'var(--border)', borderRadius: 1 }} />
          <div style={{ fontSize: 13, letterSpacing: 2, color: 'var(--green-dim)' }}>
            {entity.name.toUpperCase()}
          </div>
        </div>

        {/* Big temp row */}
        <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 4 }}>AMBIENT</div>
            <div style={{ fontSize: 40, color, fontFamily: 'var(--font-display)', letterSpacing: -2, lineHeight: 1 }}>
              {entity.currentTemp != null ? `${entity.currentTemp}${unit}` : '—'}
            </div>
          </div>
          <div style={{ width: '0.5px', height: 60, background: 'var(--border)' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 4 }}>SETPOINT</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <TempButton onClick={() => setPendingTemp(t => stepTemp(t, unit, -1))}>▼</TempButton>
              <div style={{ fontSize: 32, color: 'var(--green)', fontFamily: 'var(--font-display)', letterSpacing: -1, minWidth: 70, textAlign: 'center' }}>
                {pendingTemp}{unit}
              </div>
              <TempButton onClick={() => setPendingTemp(t => stepTemp(t, unit, 1))}>▲</TempButton>
            </div>
          </div>
        </div>

        {/* Apply + modes */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ActionBtn color={color} onClick={() => onSetTemp(pendingTemp)} style={{ minWidth: 80 }}>APPLY</ActionBtn>
          <div style={{ flex: 1, display: 'flex', gap: 4 }}>
            {HVAC_MODES.map((m) => {
              const active = entity.state === m
              const c = modeColor(m)
              return (
                <button
                  key={m}
                  onClick={() => onSetMode(m)}
                  style={{
                    flex: 1,
                    padding: '6px 2px',
                    fontSize: 11, letterSpacing: 0.5,
                    background: active ? c + '22' : 'transparent',
                    border: `0.5px solid ${active ? c : 'var(--border)'}`,
                    color: active ? c : 'var(--green-dim)',
                    cursor: 'pointer'
                  }}
                >
                  {m === 'heat_cool' ? 'H/C' : m.toUpperCase()}
                </button>
              )
            })}
          </div>
        </div>

        {entity.humidity != null && (
          <div style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)', textAlign: 'center' }}>
            RELATIVE HUMIDITY <span style={{ color: 'var(--green)' }}>{entity.humidity}%</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────
function TempButton({ onClick, children, small }: { onClick: () => void; children: React.ReactNode; small?: boolean }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        width: small ? 22 : 32, height: small ? 22 : 32,
        background: 'transparent',
        border: '0.5px solid var(--border)',
        color: 'var(--green)',
        cursor: 'pointer',
        fontSize: small ? 12 : 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0
      }}
    >
      {children}
    </button>
  )
}

function ActionBtn({
  onClick, children, color, small, style: extraStyle
}: {
  onClick: () => void
  children: React.ReactNode
  color: string
  small?: boolean
  style?: React.CSSProperties
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: small ? '4px 10px' : '6px 16px',
        fontSize: 12, letterSpacing: 1,
        background: color + '22',
        border: `0.5px solid ${color}88`,
        color,
        cursor: 'pointer',
        ...extraStyle
      }}
    >
      {children}
    </button>
  )
}
