// Variant F: a horizontal dual-handle range control inside the overlay shell.
// Single-setpoint modes (heat/cool/auto) show one handle; heat_cool shows a
// low/high band with two handles. Dragging commits to HA on release.

import { useEffect, useRef, useState } from 'react'
import { cssVar } from '../lib/tokens'
import { HVAC_MODES, modeColor, type ControlProps } from './ThermostatControl'

function bounds(unit: string): { min: number; max: number; step: number } {
  return unit === '°C' ? { min: 10, max: 32, step: 0.5 } : { min: 50, max: 90, step: 1 }
}

export function ThermostatRange({
  entity,
  unit,
  onClose,
  onSetTemp,
  onSetMode,
  onSetRange
}: ControlProps): JSX.Element {
  const { min, max, step } = bounds(unit)
  const def = unit === '°C' ? 20 : 70

  const [pendingMode, setPendingMode] = useState<string>(entity.state)
  const [pendingTemp, setPendingTemp] = useState<number>(entity.targetTemp ?? def)
  const [pendingLow, setPendingLow] = useState<number>(entity.targetTempLow ?? def - 2)
  const [pendingHigh, setPendingHigh] = useState<number>(entity.targetTempHigh ?? def + 2)
  const [dragging, setDragging] = useState<null | 'single' | 'low' | 'high'>(null)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const tempRef = useRef(pendingTemp)
  const lowRef = useRef(pendingLow)
  const highRef = useRef(pendingHigh)
  tempRef.current = pendingTemp
  lowRef.current = pendingLow
  highRef.current = pendingHigh

  const isRange = pendingMode === 'heat_cool'
  const color = modeColor(pendingMode)

  // Sync from incoming snapshots when not actively dragging.
  useEffect(() => {
    if (dragging) return
    setPendingMode(entity.state)
    setPendingTemp(entity.targetTemp ?? def)
    if (entity.targetTempLow != null) setPendingLow(entity.targetTempLow)
    if (entity.targetTempHigh != null) setPendingHigh(entity.targetTempHigh)
  }, [entity.state, entity.targetTemp, entity.targetTempLow, entity.targetTempHigh])

  function snap(v: number): number {
    return Math.round(v / step) * step
  }

  function pct(t: number): number {
    return ((t - min) / (max - min)) * 100
  }

  function eventToTemp(clientX: number): number {
    const track = trackRef.current
    if (!track) return def
    const rect = track.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return snap(min + frac * (max - min))
  }

  useEffect(() => {
    if (!dragging) return
    function move(e: PointerEvent): void {
      const t = eventToTemp(e.clientX)
      if (dragging === 'single') {
        tempRef.current = t
        setPendingTemp(t)
      } else if (dragging === 'low') {
        const v = Math.min(t, highRef.current - step)
        lowRef.current = v
        setPendingLow(v)
      } else if (dragging === 'high') {
        const v = Math.max(t, lowRef.current + step)
        highRef.current = v
        setPendingHigh(v)
      }
    }
    function up(): void {
      if (dragging === 'single') onSetTemp(tempRef.current)
      else onSetRange?.(lowRef.current, highRef.current)
      setDragging(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging]) // eslint-disable-line react-hooks/exhaustive-deps

  function pickMode(m: string): void {
    setPendingMode(m)
    onSetMode(m)
    if (m === 'heat_cool') {
      if (entity.targetTempLow == null) setPendingLow(snap((pendingTemp ?? def) - 2))
      if (entity.targetTempHigh == null) setPendingHigh(snap((pendingTemp ?? def) + 2))
    }
  }

  const ambient = entity.currentTemp != null ? `${entity.currentTemp}${unit}` : '—'

  const handleStyle = (left: number, stroke: string): React.CSSProperties => ({
    position: 'absolute',
    left: `${left}%`,
    top: '50%',
    width: 16,
    height: 24,
    transform: 'translate(-50%, -50%)',
    background: 'var(--bg-elev)',
    border: `0.5px solid ${stroke}`,
    cursor: 'grab',
    touchAction: 'none'
  })

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(2,6,10,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          border: `0.5px solid ${color}44`,
          background: 'var(--bg-elev)',
          padding: '20px 24px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18
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
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--green-dim)', cursor: 'pointer', fontSize: 19, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {/* Ambient */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 4 }}>AMBIENT</div>
          <div style={{ fontSize: 40, color, letterSpacing: -2, fontFamily: 'var(--font-display)', lineHeight: 1 }}>
            {ambient}
          </div>
        </div>

        {/* Setpoint readout */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 28 }}>
          {isRange ? (
            <>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 2 }}>COOL TO</div>
                <div style={{ fontSize: 24, color: 'var(--cool-color)', fontFamily: 'var(--font-display)', letterSpacing: -1 }}>
                  {pendingLow}{unit}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 2 }}>HEAT TO</div>
                <div style={{ fontSize: 24, color: 'var(--crimson)', fontFamily: 'var(--font-display)', letterSpacing: -1 }}>
                  {pendingHigh}{unit}
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green-dim)', marginBottom: 2 }}>TARGET</div>
              <div style={{ fontSize: 28, color: 'var(--green)', fontFamily: 'var(--font-display)', letterSpacing: -1 }}>
                {pendingTemp}{unit}
              </div>
            </div>
          )}
        </div>

        {/* Slider track */}
        <div style={{ padding: '4px 8px 0' }}>
          <div
            ref={trackRef}
            style={{ position: 'relative', height: 24 }}
          >
            {/* Base line */}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 4, transform: 'translateY(-50%)', background: 'var(--range-track)' }} />
            {isRange ? (
              <>
                {/* Band */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${pct(pendingLow)}%`,
                    right: `${100 - pct(pendingHigh)}%`,
                    top: '50%',
                    height: 4,
                    transform: 'translateY(-50%)',
                    background: color + '66'
                  }}
                />
                <div
                  style={handleStyle(pct(pendingLow), cssVar('--cool-color'))}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setDragging('low')
                  }}
                />
                <div
                  style={handleStyle(pct(pendingHigh), 'var(--crimson)')}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setDragging('high')
                  }}
                />
              </>
            ) : (
              <>
                {/* Fill */}
                <div style={{ position: 'absolute', left: 0, width: `${pct(pendingTemp)}%`, top: '50%', height: 4, transform: 'translateY(-50%)', background: color }} />
                <div
                  style={handleStyle(pct(pendingTemp), color)}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setDragging('single')
                  }}
                />
              </>
            )}
          </div>
          {/* Scale labels */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--green-dim)' }}>
            <span>{min}{unit}</span>
            <span>{Math.round((min + max) / 2)}{unit}</span>
            <span>{max}{unit}</span>
          </div>
        </div>

        {/* Action label */}
        {entity.hvacAction && (
          <div style={{ textAlign: 'center', fontSize: 12, letterSpacing: 1, color }}>
            {entity.hvacAction.toUpperCase()}
          </div>
        )}

        {/* HVAC mode selector */}
        <div style={{ display: 'flex', gap: 4 }}>
          {HVAC_MODES.map((m) => {
            const active = pendingMode === m
            const c = modeColor(m)
            return (
              <button
                key={m}
                onClick={() => pickMode(m)}
                style={{
                  flex: 1,
                  padding: '5px 2px',
                  fontSize: 12,
                  letterSpacing: 0.5,
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

        {/* Humidity */}
        {entity.humidity != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '0.5px solid var(--border)', paddingTop: 10 }}>
            <span style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)' }}>RELATIVE HUMIDITY</span>
            <span style={{ fontSize: 12, letterSpacing: 1, color: 'var(--green)' }}>{entity.humidity}%</span>
          </div>
        )}
      </div>
    </div>
  )
}
