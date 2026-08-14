// Holographic device tiles for the HOME tab: Laundry, R2PEEPOO, Colony,
// Thermostat, Ambient. They share the `.holo` skin (aqua light field, sweeping
// scan line) from global.css and wire full control to Home Assistant services.

import type { HaEntity } from '../../shared/homeassistant'
import { indexById, numOf, stateOf, attrOf, isOn, round, minutesUntil, clockTime, relTime } from '../lib/ha'

type Send = (entityId: string, service: string, data: Record<string, unknown>) => void

const HOLO = '#2effb0'
const HOLO_DIM = '#2f8b6a'
const AMBER = '#f5a623'
const BLUE = '#4aa8ff'

function HoloBtn({ icon, label, onClick }: { icon?: string; label: string; onClick: () => void }): JSX.Element {
  return (
    <button className="holo-btn" onClick={onClick} style={{ flex: 1 }}>
      {icon && <i className={`ti ${icon}`} style={{ marginRight: 4 }} />}{label}
    </button>
  )
}

// ── Laundry ──────────────────────────────────────────────────────────────

function prettyStatus(s: string | null): string {
  if (!s || s === 'unknown') return 'Idle'
  if (s === 'power_off' || s === 'off') return 'Off'
  if (s === 'power_on' || s === 'on') return 'On'
  if (s === 'end') return 'Complete'
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const IDLE_STATES = new Set(['power_off', 'off', 'on', 'power_on', 'unknown', 'end', 'initial', 'detecting', 'pause', ''])

const WASHER_PHASES = ['detecting', 'washing', 'rinsing', 'spinning']
const DRYER_PHASES = ['drying', 'cooling']

function phaseIndex(raw: string | null, phases: string[]): number {
  if (!raw) return -1
  return phases.findIndex((p) => raw.includes(p))
}

// Animated SVG drum — shared by washer and dryer, visual differences via props.
function DrumVisual({
  pct, running, complete, accent, kind, phase
}: {
  pct: number; running: boolean; complete: boolean; accent: string
  kind: 'washer' | 'dryer'; phase: string | null
}): JSX.Element {
  const CIRC = 2 * Math.PI * 44
  const offset = CIRC * (1 - pct / 100)

  const isWashing = phase === 'washing'
  const isDrying = kind === 'dryer' && running
  const spinSpeed = phase === 'spinning' ? '0.6s' : running ? '2.8s' : '0s'

  return (
    <div style={{ position: 'relative', width: 110, height: 110, flexShrink: 0 }}>
      <svg viewBox="0 0 110 110" width="110" height="110" style={{ position: 'absolute', inset: 0 }}>
        {/* track ring */}
        <circle cx="55" cy="55" r="44" fill="none" stroke="#0a2a1f" strokeWidth="6" />
        {/* progress arc */}
        <circle
          cx="55" cy="55" r="44" fill="none" stroke={complete ? AMBER : accent} strokeWidth="6"
          strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={offset}
          transform="rotate(-90 55 55)"
          style={{ filter: `drop-shadow(0 0 5px ${accent}99)`, transition: 'stroke-dashoffset 0.8s ease' }}
        />
        {/* machine body */}
        <circle cx="55" cy="55" r="36" fill="#050e0a" stroke={accent + '44'} strokeWidth="1" />
        {/* porthole glass */}
        <circle cx="55" cy="55" r="26" fill="#030b07" stroke={accent + '55'} strokeWidth="1.2" />

        {/* water fill during wash */}
        {isWashing && (
          <clipPath id={`drum-clip-${kind}`}>
            <circle cx="55" cy="55" r="25" />
          </clipPath>
        )}
        {isWashing && (
          <rect
            x="30" y="65" width="50" height="18" fill="#0066aa44"
            clipPath={`url(#drum-clip-${kind})`}
            style={{ animation: 'water-ripple 1.6s ease-in-out infinite' }}
          />
        )}

        {/* drum interior — rotates when running */}
        <g
          style={{
            transformOrigin: '55px 55px',
            animation: running ? `drum-spin ${spinSpeed} linear infinite` : undefined
          }}
        >
          {/* drum holes */}
          <circle cx="55" cy="41" r="4" fill="#0a1f14" stroke={accent + '66'} strokeWidth="1" />
          <circle cx="67" cy="62" r="4" fill="#0a1f14" stroke={accent + '66'} strokeWidth="1" />
          <circle cx="43" cy="62" r="4" fill="#0a1f14" stroke={accent + '66'} strokeWidth="1" />
          {/* laundry items tumbling */}
          {running && <>
            <ellipse cx="61" cy="49" rx="5" ry="3" fill={accent + '55'} />
            <ellipse cx="47" cy="59" rx="4" ry="2.5" fill={HOLO_DIM + '88'} />
            <ellipse cx="58" cy="65" rx="3" ry="2" fill={accent + '33'} />
          </>}
        </g>

        {/* heat shimmer lines for dryer */}
        {isDrying && [0, 1, 2].map((i) => (
          <line key={i}
            x1={44 + i * 8} y1="75" x2={44 + i * 8} y2="42"
            stroke="#f5a62344" strokeWidth="1.5" strokeLinecap="round"
            style={{ animation: `heat-pulse ${1.2 + i * 0.3}s ease-in-out infinite`, animationDelay: `${i * 0.2}s` }}
          />
        ))}

        {/* bubbles during wash */}
        {isWashing && [0, 1, 2, 3].map((i) => (
          <circle key={i}
            cx={42 + i * 7} cy={70} r={1.5 + (i % 2)}
            fill={HOLO + '99'}
            style={{ animation: `bubble-pop ${0.9 + i * 0.25}s ease-out infinite`, animationDelay: `${i * 0.3}s` }}
          />
        ))}

        {/* status text overlay */}
        {complete
          ? <text x="55" y="59" textAnchor="middle" fill={AMBER} fontFamily="Orbitron,sans-serif" fontSize="9" letterSpacing="1">DONE</text>
          : !running && <text x="55" y="59" textAnchor="middle" fill={accent + '77'} fontFamily="Orbitron,sans-serif" fontSize="7" letterSpacing="1">IDLE</text>
        }
      </svg>
    </div>
  )
}

function ApplianceCard({ idx, kind, send }: { idx: Map<string, HaEntity>; kind: 'washer' | 'dryer'; send: Send }): JSX.Element {
  const raw = stateOf(idx, `sensor.${kind}_current_status`)
  const powerOn = isOn(idx, `switch.${kind}_power`)
  const total = numOf(idx, `sensor.${kind}_total_time`)
  const remaining = minutesUntil(stateOf(idx, `sensor.${kind}_remaining_time`))
  const running = !IDLE_STATES.has(raw ?? '') && remaining != null && remaining > 0
  const complete = raw === 'end'
  const remoteStart = isOn(idx, `binary_sensor.${kind}_remote_start`)
  const childLock = isOn(idx, `switch.${kind}_child_lock`)
  const wrinkle = isOn(idx, `switch.${kind}_wrinkle_prevent`)
  const cycles = numOf(idx, 'sensor.washer_cycles')
  const notifIso = idx.get(`event.${kind}_notification`)?.lastChanged ?? stateOf(idx, `event.${kind}_notification`)
  const doneAt = clockTime(notifIso)
  const doneAgo = relTime(notifIso)

  // Extra telemetry
  const washTemp = stateOf(idx, `sensor.${kind}_temperature`) ?? stateOf(idx, `select.${kind}_wash_temperature`)
  const spinSpeed = stateOf(idx, `sensor.${kind}_spin_speed`) ?? stateOf(idx, `select.${kind}_spin_speed`)
  const soilLevel = stateOf(idx, `select.${kind}_soil_level`)
  const dryLevel = stateOf(idx, `select.${kind}_dry_level`)
  const dryTemp = stateOf(idx, `sensor.${kind}_dryer_temperature`) ?? stateOf(idx, `select.${kind}_dryer_temperature`)
  const doorOpen = isOn(idx, `binary_sensor.${kind}_door`)

  const elapsed = total != null ? total - (remaining ?? 0) : 0
  const pct = running && total ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : complete ? 100 : 0
  const accent = complete ? AMBER : running ? HOLO : HOLO_DIM

  const phases = kind === 'washer' ? WASHER_PHASES : DRYER_PHASES
  const activePhase = phaseIndex(raw, phases)

  const op = (option: string): void => send(`select.${kind}_operation`, 'select.select_option', { option })

  const phaseColors: Record<string, string> = {
    detecting: HOLO_DIM, washing: '#4aa8ff', rinsing: HOLO, spinning: AMBER,
    drying: '#e0245e', cooling: BLUE
  }

  return (
    <div
      className={complete ? 'holo laundry-complete' : 'holo'}
      style={{ flex: 1, minWidth: 0, borderColor: complete ? AMBER + '66' : running ? HOLO + '4d' : undefined }}
    >
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="holo-h" style={{ marginBottom: 0, color: accent, textShadow: `0 0 8px ${accent}55` }}>
          <i className={`ti ${kind === 'washer' ? 'ti-wash-machine' : 'ti-wind'}`} />
          {kind.toUpperCase()}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {remoteStart && <span style={{ fontSize: 11, letterSpacing: 1, color: HOLO, border: `0.5px solid ${HOLO}44`, padding: '1px 5px' }}>REMOTE ✓</span>}
          {doorOpen && <span style={{ fontSize: 11, letterSpacing: 1, color: AMBER, border: `0.5px solid ${AMBER}55`, padding: '1px 5px' }}>DOOR OPEN</span>}
          {complete && <span style={{ fontSize: 11, letterSpacing: 1, color: AMBER, border: `0.5px solid ${AMBER}66`, padding: '1px 5px', animation: 'phase-pulse 1.5s ease-in-out infinite' }}>● DONE</span>}
        </div>
      </div>

      {/* drum + stats */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <DrumVisual pct={pct} running={running} complete={complete} accent={accent} kind={kind} phase={raw} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 2 }}>
          {/* remaining time / status */}
          <div>
            <div className="holo-l" style={{ marginBottom: 3 }}>Status</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: running ? 22 : 14, color: accent, letterSpacing: -0.5 }}>
              {running
                ? <>{remaining}<span style={{ fontSize: 13, color: HOLO_DIM }}> min left</span></>
                : prettyStatus(raw)
              }
            </div>
            {running && total && (
              <div style={{ fontSize: 12, color: HOLO_DIM, letterSpacing: 1, marginTop: 1 }}>
                {Math.round(elapsed)} / {total} min
              </div>
            )}
            {!running && doneAt !== '—' && (
              <div style={{ fontSize: 12, color: HOLO_DIM, letterSpacing: 1, marginTop: 1 }}>
                finished {doneAgo} · {doneAt}
              </div>
            )}
          </div>

          {/* telemetry grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px' }}>
            {kind === 'washer' && washTemp && (
              <div><div className="holo-l">Temp</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{washTemp}</div></div>
            )}
            {kind === 'washer' && spinSpeed && (
              <div><div className="holo-l">Spin</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{spinSpeed}</div></div>
            )}
            {kind === 'washer' && soilLevel && (
              <div><div className="holo-l">Soil</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{soilLevel}</div></div>
            )}
            {kind === 'dryer' && dryLevel && (
              <div><div className="holo-l">Dry lvl</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{dryLevel}</div></div>
            )}
            {kind === 'dryer' && dryTemp && (
              <div><div className="holo-l">Heat</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{dryTemp}</div></div>
            )}
            {kind === 'washer' && cycles != null && (
              <div style={{ gridColumn: '1/-1' }}><div className="holo-l">Cycles</div><div style={{ fontSize: 16, color: HOLO_DIM }}>{Math.round(cycles).toLocaleString()}</div></div>
            )}
          </div>
        </div>
      </div>

      {/* progress bar */}
      <div className="holo-bar" style={{ marginTop: 10 }}>
        <i style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${accent}88, ${accent})`, boxShadow: `0 0 8px ${accent}aa`, transition: 'width 0.8s ease' }} />
      </div>

      {/* cycle phase chips */}
      <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
        {phases.map((p, i) => {
          const isActive = i === activePhase
          const isDone = i < activePhase
          const c = phaseColors[p] ?? HOLO
          return (
            <div key={p} style={{
              flex: 1, textAlign: 'center', fontSize: 11, letterSpacing: 1, padding: '3px 0',
              border: `0.5px solid ${isActive ? c : isDone ? c + '44' : HOLO_DIM + '33'}`,
              color: isActive ? c : isDone ? c + 'aa' : HOLO_DIM + '66',
              borderRadius: 2,
              background: isActive ? c + '11' : isDone ? c + '0a' : undefined,
              textTransform: 'uppercase',
              animation: isActive ? 'phase-pulse 1.8s ease-in-out infinite' : undefined,
            }}>
              {isDone ? '✓' : isActive ? '●' : '○'} {p}
            </div>
          )
        })}
      </div>

      {/* controls */}
      <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
        <button
          className="holo-btn"
          style={{ flex: 2, color: running ? '#e0245e' : HOLO, borderColor: running ? '#e0245e55' : undefined }}
          onClick={() => op(running ? 'stop' : 'start')}
        >
          <i className={`ti ${running ? 'ti-square' : 'ti-player-play'}`} /> {running ? 'STOP' : 'START'}
        </button>
        <button
          className="holo-btn"
          style={{ flex: 1, color: powerOn ? HOLO : HOLO_DIM }}
          onClick={() => send(`switch.${kind}_power`, powerOn ? 'switch.turn_off' : 'switch.turn_on', {})}
        >
          <i className="ti ti-power" /> PWR
        </button>
        {kind === 'washer' && (
          <button
            className="holo-btn"
            style={{ flex: 1, color: childLock ? AMBER : HOLO_DIM, borderColor: childLock ? AMBER + '55' : undefined }}
            onClick={() => send(`switch.${kind}_child_lock`, childLock ? 'switch.turn_off' : 'switch.turn_on', {})}
          >
            <i className="ti ti-lock" /> LOCK
          </button>
        )}
        {kind === 'dryer' && (
          <button
            className="holo-btn"
            style={{ flex: 1, color: wrinkle ? HOLO : HOLO_DIM }}
            onClick={() => send(`switch.${kind}_wrinkle_prevent`, wrinkle ? 'switch.turn_off' : 'switch.turn_on', {})}
          >
            <i className="ti ti-shirt" /> WRAP
          </button>
        )}
      </div>
    </div>
  )
}

export function LaundryTile({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('sensor.washer_current_status') && !idx.has('sensor.dryer_current_status')) return null

  const washerRunning = !IDLE_STATES.has(stateOf(idx, 'sensor.washer_current_status') ?? '')
  const dryerRunning = !IDLE_STATES.has(stateOf(idx, 'sensor.dryer_current_status') ?? '')
  const anyRunning = washerRunning || dryerRunning

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 12, letterSpacing: 2, color: HOLO_DIM, textTransform: 'uppercase',
        marginBottom: 8
      }}>
        <span style={{ fontFamily: 'var(--font-display)', color: HOLO, textShadow: '0 0 6px #2effb055' }}>
          <i className="ti ti-wash-machine" style={{ marginRight: 6 }} />LAUNDRY BAY
        </span>
        {anyRunning && (
          <span style={{ color: HOLO, animation: 'phase-pulse 2s ease-in-out infinite' }}>● ACTIVE</span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <ApplianceCard idx={idx} kind="washer" send={send} />
        <ApplianceCard idx={idx} kind="dryer" send={send} />
      </div>
    </div>
  )
}

// ── Laundry status card (compact, for BRIDGE sidebar) ────────────────────
export function LaundryStatus({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('sensor.washer_current_status') && !idx.has('sensor.dryer_current_status')) return null

  function MiniAppliance({ kind }: { kind: 'washer' | 'dryer' }): JSX.Element {
    const raw = stateOf(idx, `sensor.${kind}_current_status`)
    const powerOn = isOn(idx, `switch.${kind}_power`)
    const total = numOf(idx, `sensor.${kind}_total_time`)
    const remaining = minutesUntil(stateOf(idx, `sensor.${kind}_remaining_time`))
    const running = !IDLE_STATES.has(raw ?? '') && remaining != null && remaining > 0
    const complete = raw === 'end'
    const notifIso = idx.get(`event.${kind}_notification`)?.lastChanged ?? stateOf(idx, `event.${kind}_notification`)
    const doneAgo = relTime(notifIso)
    const doneAt = clockTime(notifIso)
    const elapsed = total != null ? total - (remaining ?? 0) : 0
    const pct = running && total ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : complete ? 100 : 0
    const accent = complete ? AMBER : running ? HOLO : HOLO_DIM

    const phases = kind === 'washer' ? WASHER_PHASES : DRYER_PHASES
    const activePhase = phaseIndex(raw, phases)
    const phaseColors: Record<string, string> = {
      detecting: HOLO_DIM, washing: '#4aa8ff', rinsing: HOLO, spinning: AMBER,
      drying: '#e0245e', cooling: BLUE
    }

    const op = (option: string): void => send(`select.${kind}_operation`, 'select.select_option', { option })

    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/* mini drum */}
        <svg viewBox="0 0 44 44" width="44" height="44" style={{ flexShrink: 0 }}>
          <circle cx="22" cy="22" r="18" fill="none" stroke="#0a2a1f" strokeWidth="4" />
          <circle
            cx="22" cy="22" r="18" fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round"
            strokeDasharray={String(2 * Math.PI * 18)} strokeDashoffset={String(2 * Math.PI * 18 * (1 - pct / 100))}
            transform="rotate(-90 22 22)"
            style={{ filter: `drop-shadow(0 0 3px ${accent}88)`, transition: 'stroke-dashoffset 0.8s ease' }}
          />
          <circle cx="22" cy="22" r="12" fill="#050e0a" stroke={accent + '44'} strokeWidth="1" />
          <g
            style={{
              transformOrigin: '22px 22px',
              animation: running ? `drum-spin ${raw === 'spinning' ? '0.7s' : '2.8s'} linear infinite` : undefined
            }}
          >
            <circle cx="22" cy="16" r="2" fill="#0a1f14" stroke={accent + '77'} strokeWidth="0.8" />
            <circle cx="27" cy="25" r="2" fill="#0a1f14" stroke={accent + '77'} strokeWidth="0.8" />
            <circle cx="17" cy="25" r="2" fill="#0a1f14" stroke={accent + '77'} strokeWidth="0.8" />
            {running && <ellipse cx="24" cy="20" rx="3" ry="1.5" fill={accent + '44'} />}
          </g>
          {complete && <text x="22" y="26" textAnchor="middle" fill={AMBER} fontFamily="Orbitron,sans-serif" fontSize="5" letterSpacing="0.5">DONE</text>}
        </svg>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <span style={{ fontSize: 12, letterSpacing: 2, color: accent, textTransform: 'uppercase', fontFamily: 'var(--font-display)' }}>
              {kind}
            </span>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: running ? 13 : 10, color: accent }}>
              {running ? `${remaining}m` : complete ? 'DONE' : powerOn ? 'READY' : 'OFF'}
            </span>
          </div>

          {/* last finished */}
          {!running && doneAt !== '—' && (
            <div style={{ fontSize: 11, color: HOLO_DIM, letterSpacing: 1, marginBottom: 4 }}>
              done {doneAgo} · {doneAt}
            </div>
          )}

          {/* phase strip */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 5 }}>
            {phases.map((p, i) => {
              const isActive = i === activePhase
              const isDone = i < activePhase
              const c = phaseColors[p] ?? HOLO
              return (
                <div key={p} style={{
                  flex: 1, height: 3, borderRadius: 2,
                  background: isActive ? c : isDone ? c + '66' : '#0a2a1f',
                  boxShadow: isActive ? `0 0 5px ${c}` : undefined,
                  animation: isActive ? 'phase-pulse 1.8s ease-in-out infinite' : undefined,
                }} />
              )
            })}
          </div>

          {/* progress bar */}
          <div className="holo-bar" style={{ height: 3 }}>
            <i style={{ width: `${pct}%`, background: accent, boxShadow: `0 0 4px ${accent}aa`, transition: 'width 0.8s ease' }} />
          </div>

          {/* controls */}
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <button
              className="holo-btn"
              style={{ flex: 2, padding: '3px 0', fontSize: 12, color: running ? '#e0245e' : HOLO, borderColor: running ? '#e0245e55' : undefined }}
              onClick={() => op(running ? 'stop' : 'start')}
            >
              {running ? 'STOP' : 'START'}
            </button>
            <button
              className="holo-btn"
              style={{ flex: 1, padding: '3px 0', fontSize: 12, color: powerOn ? HOLO : HOLO_DIM }}
              onClick={() => send(`switch.${kind}_power`, powerOn ? 'switch.turn_off' : 'switch.turn_on', {})}
            >
              PWR
            </button>
          </div>
        </div>
      </div>
    )
  }

  const washerRunning = !IDLE_STATES.has(stateOf(idx, 'sensor.washer_current_status') ?? '')
  const dryerRunning = !IDLE_STATES.has(stateOf(idx, 'sensor.dryer_current_status') ?? '')
  const washerDone = stateOf(idx, 'sensor.washer_current_status') === 'end'
  const dryerDone = stateOf(idx, 'sensor.dryer_current_status') === 'end'
  const anyAlert = washerDone || dryerDone

  return (
    <div className={anyAlert ? 'holo laundry-complete' : 'holo'} style={{ borderColor: anyAlert ? AMBER + '66' : undefined }}>
      <div className="holo-h" style={{ marginBottom: 10 }}>
        <i className="ti ti-wash-machine" /> LAUNDRY BAY
        {(washerRunning || dryerRunning) && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: HOLO, animation: 'phase-pulse 2s ease-in-out infinite' }}>● ACTIVE</span>
        )}
        {anyAlert && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: AMBER, animation: 'phase-pulse 1.5s ease-in-out infinite' }}>● DONE</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <MiniAppliance kind="washer" />
        <div style={{ height: '0.5px', background: HOLO + '22' }} />
        <MiniAppliance kind="dryer" />
      </div>
    </div>
  )
}

// ── R2PEEPOO (litter box) ──────────────────────────────────────────────────
function Gauge({ pct, label, color }: { pct: number; label: string; color: string }): JSX.Element {
  const CIRC = 201
  return (
    <svg viewBox="0 0 80 80" width="72" height="72">
      <circle cx="40" cy="40" r="32" fill="none" stroke="#0f3d28" strokeWidth="7" />
      <circle cx="40" cy="40" r="32" fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
        strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - pct / 100)} transform="rotate(-90 40 40)"
        style={{ filter: `drop-shadow(0 0 3px ${color})`, transition: 'stroke-dashoffset .6s ease' }} />
      <text x="40" y="38" textAnchor="middle" fill={color} fontFamily="Orbitron,sans-serif" fontSize="16">{round(pct)}%</text>
      <text x="40" y="50" textAnchor="middle" fill={HOLO_DIM} fontSize="6.5" letterSpacing="1">{label}</text>
    </svg>
  )
}

export function R2peepooTile({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('vacuum.r2peepoo_litter_box')) return null
  const litter = numOf(idx, 'sensor.r2peepoo_litter_level') ?? 0
  const waste = numOf(idx, 'sensor.r2peepoo_waste_drawer') ?? 0
  const code = (stateOf(idx, 'sensor.r2peepoo_status_code') || '—').toUpperCase()
  const dock = (stateOf(idx, 'vacuum.r2peepoo_litter_box') || '—').toUpperCase()
  const globe = (stateOf(idx, 'select.r2peepoo_globe_light') || 'auto').toUpperCase()
  const wasteColor = waste >= 80 ? '#e0245e' : waste >= 50 ? AMBER : HOLO

  return (
    <div className="holo">
      <div className="holo-h"><i className="ti ti-robot" /> R2PEEPOO</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Gauge pct={litter} label="LITTER" color={HOLO} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span className="holo-l">Waste drawer</span><span style={{ fontSize: 14, color: wasteColor }}>{round(waste)}%</span>
            </div>
            <div className="holo-bar"><i style={{ width: `${waste}%`, background: wasteColor, boxShadow: `0 0 6px ${wasteColor}aa` }} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="holo-l" style={{ lineHeight: 1.6 }}>Status</span>
            <span style={{ fontSize: 16, color: HOLO, letterSpacing: 1 }}>● {code} · {dock}</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 11 }}>
        <HoloBtn icon="ti-refresh" label="CLEAN CYCLE" onClick={() => send('vacuum.r2peepoo_litter_box', 'vacuum.start', {})} />
        <HoloBtn icon="ti-bulb" label={`GLOBE: ${globe}`} onClick={() => send('button.r2peepoo_reset', 'button.press', {})} />
      </div>
    </div>
  )
}

// ── Litter Robot bridge card ───────────────────────────────────────────────
export function LitterRobotStatus({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('vacuum.r2peepoo_litter_box')) return null

  const litter = numOf(idx, 'sensor.r2peepoo_litter_level') ?? 0
  const waste = numOf(idx, 'sensor.r2peepoo_waste_drawer') ?? 0
  const code = (stateOf(idx, 'sensor.r2peepoo_status_code') || '').toLowerCase()
  const dock = (stateOf(idx, 'vacuum.r2peepoo_litter_box') || '').toLowerCase()
  const petWeight = numOf(idx, 'sensor.r2peepoo_pet_weight')
  const lastChanged = idx.get('sensor.r2peepoo_pet_weight')?.lastChanged ?? null
  const hopper = stateOf(idx, 'sensor.r2peepoo_hopper_status')

  // Status codes where a cat/pet is actively inside the globe
  const CAT_CODES = new Set(['cst', 'csi', 'cd', 'pd'])
  const occupied = CAT_CODES.has(code)
  const cleaning = !occupied && (dock === 'cleaning' || ['ccp', 'ec'].includes(code))
  const running = cleaning || occupied

  const wasteColor = waste >= 80 ? '#e0245e' : waste >= 50 ? AMBER : HOLO
  const litterColor = litter < 20 ? '#e0245e' : litter < 40 ? AMBER : HOLO
  const statusColor = occupied ? AMBER : cleaning ? BLUE : HOLO

  const statusLabel = occupied
    ? `CAT DETECTED · ${petWeight != null ? `${petWeight.toFixed(1)} lb` : ''}`
    : cleaning ? 'CLEANING' : dock === 'docked' || code === 'rdy' ? 'READY' : (dock || code || '—').toUpperCase()

  const lastVisitStr = lastChanged ? relTime(lastChanged) : '—'

  // Globe SVG: simplified top-down litter robot dome with animated sweep when cleaning
  return (
    <div className="holo" style={{ borderColor: waste >= 80 ? '#e0245e55' : occupied ? AMBER + '55' : undefined }}>
      <div className="holo-h" style={{ marginBottom: 10 }}>
        <i className="ti ti-robot" /> R2PEEPOO
        {running && (
          <span style={{
            marginLeft: 'auto', fontSize: 11, letterSpacing: 1,
            color: statusColor, animation: 'phase-pulse 1.6s ease-in-out infinite',
            border: `0.5px solid ${statusColor}55`, padding: '1px 5px'
          }}>
            ● {occupied ? 'OCCUPIED' : 'CLEANING'}
          </span>
        )}
        {waste >= 80 && !running && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#e0245e', animation: 'phase-pulse 1.5s ease-in-out infinite' }}>
            ⚠ DRAWER FULL
          </span>
        )}
      </div>

      {/* globe schematic + status */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <svg viewBox="0 0 72 72" width="72" height="72" style={{ flexShrink: 0 }}>
          {/* base */}
          <ellipse cx="36" cy="58" rx="22" ry="6" fill="#050e0a" stroke={HOLO + '33'} strokeWidth="1" />
          {/* globe body */}
          <ellipse cx="36" cy="34" rx="20" ry="26" fill="#050e0a" stroke={statusColor + '66'} strokeWidth="1.5"
            style={{ filter: `drop-shadow(0 0 ${running ? 6 : 3}px ${statusColor}44)` }} />
          {/* globe window */}
          <ellipse cx="36" cy="30" rx="11" ry="14" fill="#030a07" stroke={statusColor + '44'} strokeWidth="1" />
          {/* rotating sweep arm when cleaning */}
          {cleaning && (
            <line x1="36" y1="30" x2="36" y2="18" stroke={BLUE} strokeWidth="1.5" strokeLinecap="round"
              style={{ transformOrigin: '36px 30px', transformBox: 'fill-box', animation: 'drum-spin 1.8s linear infinite' }} />
          )}
          {/* cat silhouette when occupied */}
          {occupied && (
            <text x="36" y="35" textAnchor="middle" fill={AMBER + 'cc'} fontSize="14">🐱</text>
          )}
          {/* litter level fill in globe */}
          {!occupied && !cleaning && (
            <ellipse cx="36" cy={30 + 14 * (1 - litter / 100)} rx="10" ry="3"
              fill={litterColor + '33'} stroke={litterColor + '55'} strokeWidth="0.5" />
          )}
          {/* status dot */}
          <circle cx="36" cy="60" r="3" fill={statusColor}
            style={{ filter: `drop-shadow(0 0 4px ${statusColor})`, animation: running ? 'phase-pulse 1.6s ease-in-out infinite' : undefined }} />
        </svg>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>
            <div className="holo-l" style={{ marginBottom: 2 }}>Status</div>
            <div style={{ fontSize: 14, color: statusColor, letterSpacing: 1, fontFamily: 'var(--font-display)' }}>{statusLabel}</div>
          </div>
          <div>
            <div className="holo-l" style={{ marginBottom: 2 }}>Last visit</div>
            <div style={{ fontSize: 14, color: '#9dffc4', letterSpacing: 1 }}>{lastVisitStr}</div>
          </div>
          {hopper && (
            <div>
              <div className="holo-l" style={{ marginBottom: 2 }}>Hopper</div>
              <div style={{ fontSize: 14, color: HOLO_DIM, letterSpacing: 1, textTransform: 'capitalize' }}>{hopper}</div>
            </div>
          )}
        </div>
      </div>

      {/* litter level bar */}
      <div style={{ marginBottom: 7 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span className="holo-l">Litter level</span>
          <span style={{ fontSize: 13, color: litterColor, fontFamily: 'var(--font-display)' }}>{round(litter)}%</span>
        </div>
        <div className="holo-bar">
          <i style={{ width: `${litter}%`, background: litterColor, boxShadow: `0 0 5px ${litterColor}99`, transition: 'width 0.6s ease' }} />
        </div>
      </div>

      {/* waste drawer bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span className="holo-l">Waste drawer</span>
          <span style={{ fontSize: 13, color: wasteColor, fontFamily: 'var(--font-display)' }}>{round(waste)}%</span>
        </div>
        <div className="holo-bar">
          <i style={{ width: `${waste}%`, background: wasteColor, boxShadow: `0 0 5px ${wasteColor}99`, transition: 'width 0.6s ease' }} />
        </div>
      </div>

      {/* controls */}
      <div style={{ display: 'flex', gap: 5 }}>
        <button
          className="holo-btn"
          style={{ flex: 2, color: cleaning ? '#e0245e' : HOLO, borderColor: cleaning ? '#e0245e55' : undefined }}
          onClick={() => send('vacuum.r2peepoo_litter_box', cleaning ? 'vacuum.stop' : 'vacuum.start', {})}
        >
          <i className={`ti ${cleaning ? 'ti-square' : 'ti-refresh'}`} /> {cleaning ? 'STOP' : 'CLEAN'}
        </button>
        <button className="holo-btn" style={{ flex: 1 }}
          onClick={() => send('button.r2peepoo_reset', 'button.press', {})}>
          <i className="ti ti-rotate" /> RST
        </button>
      </div>
    </div>
  )
}

// ── Colony (cats) ───────────────────────────────────────────────────────────
const CATS = ['smithers', 'willow', 'zelda', 'pazoozoo', 'piggy']

export function ColonyTile({ entities }: { entities: HaEntity[] }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('sensor.willow_visits_today')) return null
  const rows = CATS.map((name) => ({
    name,
    visits: numOf(idx, `sensor.${name}_visits_today`) ?? 0,
    weight: numOf(idx, `sensor.${name}_weight`)
  })).sort((a, b) => b.visits - a.visits)

  return (
    <div className="holo">
      <div className="holo-h"><i className="ti ti-cat" /> COLONY · VISITS TODAY</div>
      <table style={{ width: '100%', fontSize: 16, letterSpacing: 1, borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={{ padding: '3px 0', color: r.visits > 0 ? '#9dffc4' : HOLO_DIM, textTransform: 'capitalize' }}>{r.name}</td>
              <td style={{ textAlign: 'right', color: HOLO_DIM }}>{round(r.weight, 1)} lb</td>
              <td style={{ textAlign: 'right', width: 34 }}>
                <span className="holo-v" style={{ fontSize: 17, color: r.visits > 0 ? HOLO : HOLO_DIM }}>{r.visits}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Thermostat ───────────────────────────────────────────────────────────────
export function ThermostatTile({ entities, unit, send }: { entities: HaEntity[]; unit: string; send: Send }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('climate.thermostat')) return null
  const mode = stateOf(idx, 'climate.thermostat') || 'off'
  const action = (attrOf<string>(idx, 'climate.thermostat', 'hvac_action') || mode).toLowerCase()
  const current = numOf(idx, 'sensor.thermostat_temperature') ?? attrOf<number>(idx, 'climate.thermostat', 'current_temperature')
  const target = attrOf<number>(idx, 'climate.thermostat', 'temperature')
  const humidity = numOf(idx, 'sensor.thermostat_humidity')
  const emergHeat = isOn(idx, 'switch.thermostat_emergency_heat')

  const accent = action === 'cooling' ? BLUE : action === 'heating' ? '#e0245e' : HOLO
  const actionLabel = mode === 'off' ? 'OFF' : action.toUpperCase()
  const icon = action === 'cooling' ? 'ti-snowflake' : action === 'heating' ? 'ti-flame' : 'ti-temperature'

  const step = (delta: number): void => {
    if (target == null) return
    send('climate.thermostat', 'climate.set_temperature', { temperature: Math.round(target + delta) })
  }

  return (
    <div className="holo" style={{ borderColor: accent + '4d' }}>
      <div className="holo-h" style={{ color: accent, textShadow: `0 0 6px ${accent}66` }}>
        <i className="ti ti-temperature" /> THERMOSTAT
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 36, color: accent, textShadow: `0 0 10px ${accent}44`, letterSpacing: -1 }}>
          {round(current)}°
        </span>
        <span style={{ fontSize: 13, letterSpacing: 1, color: accent, border: `0.5px solid ${accent}55`, padding: '2px 6px', marginLeft: 'auto' }}>
          <i className={`ti ${icon}`} style={{ verticalAlign: -1 }} /> {actionLabel}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <button className="holo-btn" style={{ width: 34 }} onClick={() => step(-1)} aria-label="Lower target"><i className="ti ti-minus" /></button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div className="holo-l">Target</div>
          <div className="holo-v" style={{ fontSize: 19, color: accent }}>{round(target)}{unit}</div>
        </div>
        <button className="holo-btn" style={{ width: 34 }} onClick={() => step(1)} aria-label="Raise target"><i className="ti ti-plus" /></button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 14, letterSpacing: 1, color: HOLO_DIM }}>
        <span>RH <b style={{ color: '#9dffc4' }}>{round(humidity)}%</b></span>
        <button className="holo-btn" onClick={() => send('switch.thermostat_emergency_heat', emergHeat ? 'switch.turn_off' : 'switch.turn_on', {})}
          style={{ color: emergHeat ? '#e0245e' : undefined, borderColor: emergHeat ? '#e0245e55' : undefined }}>
          E-HEAT {emergHeat ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  )
}

// ── Ambient (weather / sun / backup) ──────────────────────────────────────────
export function AmbientTile({ entities }: { entities: HaEntity[] }): JSX.Element | null {
  const idx = indexById(entities)
  if (!idx.has('weather.forecast_home') && !idx.has('sun.sun')) return null
  const cond = stateOf(idx, 'weather.forecast_home') || '—'
  const temp = attrOf<number>(idx, 'weather.forecast_home', 'temperature')
  const sunUp = stateOf(idx, 'sun.sun') === 'above_horizon'
  const setRise = sunUp ? clockTime(stateOf(idx, 'sensor.sun_next_setting')) : clockTime(stateOf(idx, 'sensor.sun_next_rising'))
  const backup = (stateOf(idx, 'sensor.backup_backup_manager_state') || 'idle').toUpperCase()

  return (
    <div className="holo">
      <div className="holo-h"><i className={`ti ${sunUp ? 'ti-sun' : 'ti-moon'}`} /> AMBIENT</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: HOLO, textShadow: '0 0 6px #2effb055', textTransform: 'capitalize' }}>{cond}</span>
        {temp != null && <span className="holo-v" style={{ fontSize: 19, marginLeft: 'auto' }}>{round(temp)}°</span>}
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="holo-l">{sunUp ? 'Sunset' : 'Sunrise'}</div>
        <div style={{ fontSize: 18, color: '#9dffc4' }}>{setRise}</div>
      </div>
      <div className="holo-l" style={{ marginTop: 10, color: HOLO_DIM }}>
        <i className="ti ti-database" style={{ verticalAlign: -1 }} /> BACKUP · {backup}
      </div>
    </div>
  )
}
