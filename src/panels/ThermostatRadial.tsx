// Combined control: a full-screen overlay (variant A) housing a draggable
// radial dial (variant D). In heat_cool mode the dial carries two handles for
// the low/high setpoint band (variant F). Dragging a handle commits on release.

import { useEffect, useRef, useState } from 'react'
import { HVAC_MODES, modeColor, type ControlProps } from './ThermostatControl'

const CX = 100
const CY = 100
const R = 78
const ARC = 135 // dial spans -135°..+135° (90° dead zone at the bottom)

function bounds(unit: string): { min: number; max: number; step: number } {
  return unit === '°C' ? { min: 10, max: 32, step: 0.5 } : { min: 50, max: 90, step: 1 }
}

function tempToAngle(t: number, min: number, max: number): number {
  const frac = Math.max(0, Math.min(1, (t - min) / (max - min)))
  return -ARC + frac * (ARC * 2)
}

// Angle measured clockwise from 12 o'clock → SVG point on the dial.
function polar(angleDeg: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180
  return { x: CX + R * Math.sin(a), y: CY - R * Math.cos(a) }
}

function describeArc(t0: number, t1: number, min: number, max: number): string {
  const a0 = tempToAngle(t0, min, max)
  const a1 = tempToAngle(t1, min, max)
  const p0 = polar(a0)
  const p1 = polar(a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  return `M ${p0.x} ${p0.y} A ${R} ${R} 0 ${large} 1 ${p1.x} ${p1.y}`
}

export function ThermostatRadial({
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

  const svgRef = useRef<SVGSVGElement | null>(null)
  // Refs mirror state so the pointer handlers always read fresh values.
  const tempRef = useRef(pendingTemp)
  const lowRef = useRef(pendingLow)
  const highRef = useRef(pendingHigh)
  tempRef.current = pendingTemp
  lowRef.current = pendingLow
  highRef.current = pendingHigh

  const isRange = pendingMode === 'heat_cool'
  const color = modeColor(pendingMode)

  // Sync from incoming snapshots when the user isn't actively dragging.
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

  function eventToTemp(clientX: number, clientY: number): number {
    const svg = svgRef.current
    if (!svg) return def
    const rect = svg.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * 200
    const y = ((clientY - rect.top) / rect.height) * 200
    let a = (Math.atan2(x - CX, -(y - CY)) * 180) / Math.PI
    if (a > ARC) a = ARC
    if (a < -ARC) a = -ARC
    const frac = (a + ARC) / (ARC * 2)
    return snap(min + frac * (max - min))
  }

  useEffect(() => {
    if (!dragging) return
    function move(e: PointerEvent): void {
      const t = eventToTemp(e.clientX, e.clientY)
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
      // Seed a sensible band if HA hasn't reported one yet.
      if (entity.targetTempLow == null) setPendingLow(snap((pendingTemp ?? def) - 2))
      if (entity.targetTempHigh == null) setPendingHigh(snap((pendingTemp ?? def) + 2))
    }
  }

  const lowPt = polar(tempToAngle(pendingLow, min, max))
  const highPt = polar(tempToAngle(pendingHigh, min, max))
  const singlePt = polar(tempToAngle(pendingTemp, min, max))
  const ambient = entity.currentTemp != null ? `${entity.currentTemp}${unit}` : '—'

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
          background: '#050c12',
          padding: '20px 24px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14
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

        {/* Radial dial */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <svg
            ref={svgRef}
            viewBox="0 0 200 200"
            width={220}
            height={220}
            style={{ touchAction: 'none', userSelect: 'none' }}
          >
            {/* Track */}
            <path d={describeArc(min, max, min, max)} fill="none" stroke="#0c3a26" strokeWidth={6} strokeLinecap="round" />

            {isRange ? (
              <>
                {/* Band between low and high */}
                <path d={describeArc(pendingLow, pendingHigh, min, max)} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" />
                {/* Low (cool) handle */}
                <circle
                  cx={lowPt.x}
                  cy={lowPt.y}
                  r={9}
                  fill="#050c12"
                  stroke="#4aa8ff"
                  strokeWidth={2}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setDragging('low')
                  }}
                />
                {/* High (heat) handle */}
                <circle
                  cx={highPt.x}
                  cy={highPt.y}
                  r={9}
                  fill="#050c12"
                  stroke="var(--crimson)"
                  strokeWidth={2}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setDragging('high')
                  }}
                />
                {/* Center readout */}
                <text x={CX} y={CY - 6} textAnchor="middle" fill="#4aa8ff" fontFamily="var(--font-display)" fontSize={22}>
                  {pendingLow}°
                </text>
                <text x={CX} y={CY + 20} textAnchor="middle" fill="var(--crimson)" fontFamily="var(--font-display)" fontSize={22}>
                  {pendingHigh}°
                </text>
                <text x={CX} y={CY + 38} textAnchor="middle" fill="var(--green-dim)" fontSize={7} letterSpacing={2}>
                  COOL · HEAT
                </text>
              </>
            ) : (
              <>
                {/* Fill from min to setpoint */}
                <path d={describeArc(min, pendingTemp, min, max)} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" />
                {/* Setpoint handle */}
                <circle
                  cx={singlePt.x}
                  cy={singlePt.y}
                  r={9}
                  fill="#050c12"
                  stroke={color}
                  strokeWidth={2}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setDragging('single')
                  }}
                />
                {/* Center readout */}
                <text x={CX} y={CY + 4} textAnchor="middle" fill="var(--green)" fontFamily="var(--font-display)" fontSize={40} letterSpacing={-2}>
                  {pendingTemp}°
                </text>
                <text x={CX} y={CY + 24} textAnchor="middle" fill="var(--green-dim)" fontSize={7} letterSpacing={2}>
                  SET {unit.replace('°', '')}
                </text>
              </>
            )}
          </svg>
        </div>

        {/* Ambient + action */}
        <div style={{ textAlign: 'center', fontSize: 12, letterSpacing: 1, color: 'var(--green-dim)', marginTop: -8 }}>
          AMBIENT <span style={{ color }}>{ambient}</span>
          {entity.hvacAction && (
            <>
              {' · '}
              <span style={{ color }}>{entity.hvacAction.toUpperCase()}</span>
            </>
          )}
        </div>

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
