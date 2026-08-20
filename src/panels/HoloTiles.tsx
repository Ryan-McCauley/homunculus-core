// Holographic device tiles for the HOME tab: Appliance, Litter, Pets,
// Thermostat, Ambient. They share the `.holo` skin (aqua light field, sweeping
// scan line) from global.css and wire full control to Home Assistant services.
//
// EVERY TILE IS BOUND, NOT HARDCODED. A tile takes a HomeTileConfig and reads
// the house through a TileReader: `r.num('wasteDrawer')` rather than
// `numOf(idx, 'sensor.r2peepoo_waste_drawer')`. What sits behind each slot is
// whatever this install discovered or the operator picked, so the same code
// draws a Litter-Robot called R2PEEPOO and one called Katzenklo, and a house
// with three thermostats gets three tiles from one component.
//
// Thresholds and vocabulary are configuration too — the drawer-full percentage,
// the status codes that mean "a cat is inside", the names of the cycle phases.
// Those were the other half of the hardcoding, and they are the half that makes
// a tile render wrong rather than render empty when it is someone else's house.
//
// UNBOUND SLOTS ARE NORMAL. Read accessors return null and controls no-op, so a
// tile shows the rows it has and omits the rest. Only `renderRequires` decides
// whether a tile appears at all.

import type { HaEntity } from '../../shared/homeassistant'
import type { HomeTileConfig, TileSpec } from '../../shared/homeTiles'
import { getTileSpec, tileRenderable } from '../../shared/homeTileSpecs'
import { indexById, round, minutesUntil, clockTime, relTime } from '../lib/ha'
import { tileReader, type Send, type TileReader } from '../lib/tileReader'

export type { Send }

const HOLO = '#2effb0'
const HOLO_DIM = '#2f8b6a'
const AMBER = '#f5a623'
const BLUE = '#4aa8ff'
const CRIMSON = '#e0245e'

/** Props every tile takes. `unit` is HA's configured temperature unit. */
export interface TileProps {
  tile: HomeTileConfig
  entities: HaEntity[]
  send: Send
  unit?: string
}

/**
 * Resolve a tile's spec and reader, or null when it should not render.
 *
 * Centralised so no tile re-implements the "is this renderable?" question, and
 * so a config naming a tile type this build doesn't have degrades to a missing
 * tile rather than to a crash inside a component.
 */
function prepare(
  { tile, entities, send }: TileProps,
  expectedType: string,
): { r: TileReader; spec: TileSpec } | null {
  const spec = getTileSpec(tile.type)
  if (!spec || spec.type !== expectedType || !tileRenderable(tile, spec)) return null
  return { r: tileReader(tile, spec, indexById(entities), send), spec }
}

function HoloBtn({ icon, label, onClick }: { icon?: string; label: string; onClick: () => void }): JSX.Element {
  return (
    <button className="holo-btn" onClick={onClick} style={{ flex: 1 }}>
      {icon && <i className={`ti ${icon}`} style={{ marginRight: 4 }} />}{label}
    </button>
  )
}

// ── Appliance ────────────────────────────────────────────────────────────

function prettyStatus(s: string | null): string {
  if (!s || s === 'unknown') return 'Idle'
  if (s === 'power_off' || s === 'off') return 'Off'
  if (s === 'power_on' || s === 'on') return 'On'
  if (s === 'end') return 'Complete'
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function phaseIndex(raw: string | null, phases: string[]): number {
  if (!raw) return -1
  return phases.findIndex((p) => raw.includes(p))
}

const PHASE_COLORS: Record<string, string> = {
  detecting: HOLO_DIM, washing: BLUE, rinsing: HOLO, spinning: AMBER,
  drying: CRIMSON, cooling: BLUE,
}

/**
 * The run state of an appliance, derived once and shared by both card sizes.
 *
 * `running` deliberately requires BOTH a non-idle status AND time left on the
 * clock. A machine that reports `washing` with zero minutes remaining is a
 * machine whose cycle ended and whose status sensor hasn't caught up — treating
 * it as running leaves the drum spinning on screen forever.
 */
function applianceState(r: TileReader): {
  raw: string | null; running: boolean; complete: boolean; pct: number
  remaining: number | null; total: number | null; elapsed: number
  phases: string[]; activePhase: number; accent: string
  doneAt: string; doneAgo: string
} {
  const raw = r.state('status')
  const idle = r.listOpt('idleStates')
  const total = r.num('totalTime')
  const remaining = minutesUntil(r.state('remainingTime'))
  const running = !idle.has((raw ?? '').toLowerCase()) && remaining != null && remaining > 0
  const complete = raw === String(r.opt('completeState'))
  const elapsed = total != null ? total - (remaining ?? 0) : 0
  const pct = running && total ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : complete ? 100 : 0

  const phases = String(r.opt('phases')).split(',').map((p) => p.trim()).filter(Boolean)
  const notifIso = r.changed('notification') ?? r.state('notification')

  return {
    raw, running, complete, pct, remaining, total, elapsed, phases,
    activePhase: phaseIndex(raw, phases),
    accent: complete ? AMBER : running ? HOLO : HOLO_DIM,
    doneAt: clockTime(notifIso),
    doneAgo: relTime(notifIso),
  }
}

// Animated SVG drum. Visual differences (bubbles vs heat shimmer) come from the
// tile's `visual` option, not from a hardcoded washer/dryer identity.
function DrumVisual({
  pct, running, complete, accent, visual, phase,
}: {
  pct: number; running: boolean; complete: boolean; accent: string
  visual: string; phase: string | null
}): JSX.Element {
  const CIRC = 2 * Math.PI * 44
  const offset = CIRC * (1 - pct / 100)

  const isWashing = phase === 'washing'
  const isDrying = visual === 'dryer' && running
  const spinSpeed = phase === 'spinning' ? '0.6s' : running ? '2.8s' : '0s'

  return (
    <div style={{ position: 'relative', width: 110, height: 110, flexShrink: 0 }}>
      <svg viewBox="0 0 110 110" width="110" height="110" style={{ position: 'absolute', inset: 0 }}>
        {/* track ring */}
        <circle cx="55" cy="55" r="44" fill="none" stroke="#0a2a1f" strokeWidth="6" />
        {/* progress ring */}
        <circle
          cx="55" cy="55" r="44" fill="none" stroke={accent} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={String(CIRC)} strokeDashoffset={String(offset)}
          transform="rotate(-90 55 55)"
          style={{ filter: `drop-shadow(0 0 4px ${accent}99)`, transition: 'stroke-dashoffset 0.8s ease' }}
        />
        {/* drum housing */}
        <circle cx="55" cy="55" r="32" fill="#050e0a" stroke={accent + '55'} strokeWidth="1.5" />

        {/* spinning drum contents */}
        <g style={{
          transformOrigin: '55px 55px',
          animation: running ? `drum-spin ${spinSpeed} linear infinite` : undefined,
        }}>
          <circle cx="55" cy="38" r="4" fill="#0a1f14" stroke={accent + '77'} strokeWidth="1" />
          <circle cx="68" cy="62" r="4" fill="#0a1f14" stroke={accent + '77'} strokeWidth="1" />
          <circle cx="42" cy="62" r="4" fill="#0a1f14" stroke={accent + '77'} strokeWidth="1" />
          {running && <>
            <ellipse cx="61" cy="49" rx="5" ry="3" fill={accent + '55'} />
            <ellipse cx="47" cy="59" rx="4" ry="2.5" fill={HOLO_DIM + '88'} />
            <ellipse cx="58" cy="65" rx="3" ry="2" fill={accent + '33'} />
          </>}
        </g>

        {/* heat shimmer lines for a dryer */}
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

/** One appliance, full size. The HOME overview lays these out in a row. */
export function ApplianceTile(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'appliance')
  if (!prepared) return null
  const { r } = prepared
  const s = applianceState(r)

  const visual = String(r.opt('visual'))
  const powerOn = r.on('power')
  const childLock = r.on('childLock')
  const wrinkle = r.on('wrinklePrevent')
  const doorOpen = r.on('door')
  const cycles = r.num('cycles')
  const temp = r.state('temperature')
  const spin = r.state('spinSpeed')
  const soil = r.state('soilLevel')
  const dryLevel = r.state('dryLevel')

  const op = (option: string): void => r.send('operation', 'select.select_option', { option })

  return (
    <div
      className={s.complete ? 'holo laundry-complete' : 'holo'}
      style={{ flex: 1, minWidth: 0, borderColor: s.complete ? AMBER + '66' : s.running ? HOLO + '4d' : undefined }}
    >
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="holo-h" style={{ marginBottom: 0, color: s.accent, textShadow: `0 0 8px ${s.accent}55` }}>
          <i className={`ti ${visual === 'dryer' ? 'ti-wind' : 'ti-wash-machine'}`} />
          {r.title.toUpperCase()}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {doorOpen && <span style={{ fontSize: 11, letterSpacing: 1, color: AMBER, border: `0.5px solid ${AMBER}55`, padding: '1px 5px' }}>DOOR OPEN</span>}
          {s.complete && <span style={{ fontSize: 11, letterSpacing: 1, color: AMBER, border: `0.5px solid ${AMBER}66`, padding: '1px 5px', animation: 'phase-pulse 1.5s ease-in-out infinite' }}>● DONE</span>}
        </div>
      </div>

      {/* drum + stats */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <DrumVisual pct={s.pct} running={s.running} complete={s.complete} accent={s.accent} visual={visual} phase={s.raw} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 2 }}>
          <div>
            <div className="holo-l" style={{ marginBottom: 3 }}>Status</div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: s.running ? 22 : 14, color: s.accent, letterSpacing: -0.5 }}>
              {s.running
                ? <>{s.remaining}<span style={{ fontSize: 13, color: HOLO_DIM }}> min left</span></>
                : prettyStatus(s.raw)
              }
            </div>
            {s.running && s.total != null && (
              <div style={{ fontSize: 12, color: HOLO_DIM, letterSpacing: 1, marginTop: 1 }}>
                {Math.round(s.elapsed)} / {s.total} min
              </div>
            )}
            {!s.running && s.doneAt !== '—' && (
              <div style={{ fontSize: 12, color: HOLO_DIM, letterSpacing: 1, marginTop: 1 }}>
                finished {s.doneAgo} · {s.doneAt}
              </div>
            )}
          </div>

          {/* telemetry grid — each cell appears only when its slot is bound and
              reporting, so an appliance without a soil-level select simply has
              one fewer readout instead of a labelled blank. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px' }}>
            {temp && <div><div className="holo-l">Temp</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{temp}</div></div>}
            {spin && <div><div className="holo-l">Spin</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{spin}</div></div>}
            {soil && <div><div className="holo-l">Soil</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{soil}</div></div>}
            {dryLevel && <div><div className="holo-l">Dry lvl</div><div style={{ fontSize: 16, color: '#9dffc4' }}>{dryLevel}</div></div>}
            {cycles != null && (
              <div style={{ gridColumn: '1/-1' }}><div className="holo-l">Cycles</div><div style={{ fontSize: 16, color: HOLO_DIM }}>{Math.round(cycles).toLocaleString()}</div></div>
            )}
          </div>
        </div>
      </div>

      {/* progress bar */}
      <div className="holo-bar" style={{ marginTop: 10 }}>
        <i style={{ width: `${s.pct}%`, background: `linear-gradient(90deg, ${s.accent}88, ${s.accent})`, boxShadow: `0 0 8px ${s.accent}aa`, transition: 'width 0.8s ease' }} />
      </div>

      {/* cycle phase chips */}
      <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
        {s.phases.map((p, i) => {
          const isActive = i === s.activePhase
          const isDone = i < s.activePhase
          const c = PHASE_COLORS[p] ?? HOLO
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

      {/* controls — each is present only if something is bound behind it */}
      <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
        {r.id('operation') && (
          <button
            className="holo-btn"
            style={{ flex: 2, color: s.running ? CRIMSON : HOLO, borderColor: s.running ? CRIMSON + '55' : undefined }}
            onClick={() => op(s.running ? 'stop' : 'start')}
          >
            <i className={`ti ${s.running ? 'ti-square' : 'ti-player-play'}`} /> {s.running ? 'STOP' : 'START'}
          </button>
        )}
        {r.id('power') && (
          <button
            className="holo-btn"
            style={{ flex: 1, color: powerOn ? HOLO : HOLO_DIM }}
            onClick={() => r.send('power', powerOn ? 'switch.turn_off' : 'switch.turn_on')}
          >
            <i className="ti ti-power" /> PWR
          </button>
        )}
        {r.id('childLock') && (
          <button
            className="holo-btn"
            style={{ flex: 1, color: childLock ? AMBER : HOLO_DIM, borderColor: childLock ? AMBER + '55' : undefined }}
            onClick={() => r.send('childLock', childLock ? 'switch.turn_off' : 'switch.turn_on')}
          >
            <i className="ti ti-lock" /> LOCK
          </button>
        )}
        {r.id('wrinklePrevent') && (
          <button
            className="holo-btn"
            style={{ flex: 1, color: wrinkle ? HOLO : HOLO_DIM }}
            onClick={() => r.send('wrinklePrevent', wrinkle ? 'switch.turn_off' : 'switch.turn_on')}
          >
            <i className="ti ti-shirt" /> WRAP
          </button>
        )}
      </div>
    </div>
  )
}

/** One appliance, compact — the BRIDGE sidebar card. */
export function ApplianceStatus(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'appliance')
  if (!prepared) return null
  const { r } = prepared
  const s = applianceState(r)
  const powerOn = r.on('power')
  const op = (option: string): void => r.send('operation', 'select.select_option', { option })

  return (
    <div className={s.complete ? 'holo laundry-complete' : 'holo'} style={{ borderColor: s.complete ? AMBER + '66' : undefined }}>
      <div className="holo-h" style={{ marginBottom: 10 }}>
        <i className="ti ti-wash-machine" /> {r.title.toUpperCase()}
        {s.running && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: HOLO, animation: 'phase-pulse 2s ease-in-out infinite' }}>● ACTIVE</span>
        )}
        {s.complete && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: AMBER, animation: 'phase-pulse 1.5s ease-in-out infinite' }}>● DONE</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/* mini drum */}
        <svg viewBox="0 0 44 44" width="44" height="44" style={{ flexShrink: 0 }}>
          <circle cx="22" cy="22" r="18" fill="none" stroke="#0a2a1f" strokeWidth="4" />
          <circle
            cx="22" cy="22" r="18" fill="none" stroke={s.accent} strokeWidth="4" strokeLinecap="round"
            strokeDasharray={String(2 * Math.PI * 18)} strokeDashoffset={String(2 * Math.PI * 18 * (1 - s.pct / 100))}
            transform="rotate(-90 22 22)"
            style={{ filter: `drop-shadow(0 0 3px ${s.accent}88)`, transition: 'stroke-dashoffset 0.8s ease' }}
          />
          <circle cx="22" cy="22" r="12" fill="#050e0a" stroke={s.accent + '44'} strokeWidth="1" />
          <g style={{
            transformOrigin: '22px 22px',
            animation: s.running ? `drum-spin ${s.raw === 'spinning' ? '0.7s' : '2.8s'} linear infinite` : undefined,
          }}>
            <circle cx="22" cy="16" r="2" fill="#0a1f14" stroke={s.accent + '77'} strokeWidth="0.8" />
            <circle cx="27" cy="25" r="2" fill="#0a1f14" stroke={s.accent + '77'} strokeWidth="0.8" />
            <circle cx="17" cy="25" r="2" fill="#0a1f14" stroke={s.accent + '77'} strokeWidth="0.8" />
            {s.running && <ellipse cx="24" cy="20" rx="3" ry="1.5" fill={s.accent + '44'} />}
          </g>
          {s.complete && <text x="22" y="26" textAnchor="middle" fill={AMBER} fontFamily="Orbitron,sans-serif" fontSize="5" letterSpacing="0.5">DONE</text>}
        </svg>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <span style={{ fontSize: 12, letterSpacing: 2, color: s.accent, textTransform: 'uppercase', fontFamily: 'var(--font-display)' }}>
              {prettyStatus(s.raw)}
            </span>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: s.running ? 13 : 10, color: s.accent }}>
              {s.running ? `${s.remaining}m` : s.complete ? 'DONE' : powerOn ? 'READY' : 'OFF'}
            </span>
          </div>

          {!s.running && s.doneAt !== '—' && (
            <div style={{ fontSize: 11, color: HOLO_DIM, letterSpacing: 1, marginBottom: 4 }}>
              done {s.doneAgo} · {s.doneAt}
            </div>
          )}

          {/* phase strip */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 5 }}>
            {s.phases.map((p, i) => {
              const isActive = i === s.activePhase
              const isDone = i < s.activePhase
              const c = PHASE_COLORS[p] ?? HOLO
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

          <div className="holo-bar" style={{ height: 3 }}>
            <i style={{ width: `${s.pct}%`, background: s.accent, boxShadow: `0 0 4px ${s.accent}aa`, transition: 'width 0.8s ease' }} />
          </div>

          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            {r.id('operation') && (
              <button
                className="holo-btn"
                style={{ flex: 2, padding: '3px 0', fontSize: 12, color: s.running ? CRIMSON : HOLO, borderColor: s.running ? CRIMSON + '55' : undefined }}
                onClick={() => op(s.running ? 'stop' : 'start')}
              >
                {s.running ? 'STOP' : 'START'}
              </button>
            )}
            {r.id('power') && (
              <button
                className="holo-btn"
                style={{ flex: 1, padding: '3px 0', fontSize: 12, color: powerOn ? HOLO : HOLO_DIM }}
                onClick={() => r.send('power', powerOn ? 'switch.turn_off' : 'switch.turn_on')}
              >
                PWR
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Litter robot ─────────────────────────────────────────────────────────

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

/**
 * Shared litter-box derivation.
 *
 * The thresholds and the status-code vocabulary are per-tile options rather than
 * constants: `cst`/`csi`/`cd`/`pd` are Litter-Robot's codes for "a cat is in
 * there", and a different brand means different codes. Getting this wrong is the
 * failure mode worth designing against — a tile that says CLEANING while the cat
 * is inside is worse than one that says nothing.
 */
function litterState(r: TileReader): {
  litter: number; waste: number; code: string; dock: string
  occupied: boolean; cleaning: boolean; running: boolean
  wasteColor: string; litterColor: string; statusColor: string
  statusLabel: string; wasteFull: boolean
} {
  const litter = r.num('litterLevel') ?? 0
  const waste = r.num('wasteDrawer') ?? 0
  const code = (r.state('statusCode') || '').toLowerCase()
  const dock = (r.state('vacuum') || '').toLowerCase()
  const petWeight = r.num('petWeight')

  const occupied = r.listOpt('occupiedCodes').has(code)
  const cleaning = !occupied && (dock === 'cleaning' || r.listOpt('cleaningCodes').has(code))

  const wasteFullAt = r.numOpt('wasteFull')
  const wasteWarnAt = r.numOpt('wasteWarn')
  const litterCritAt = r.numOpt('litterCritical')
  const litterLowAt = r.numOpt('litterLow')
  const unit = String(r.opt('weightUnit'))

  return {
    litter, waste, code: code.toUpperCase(), dock: dock.toUpperCase(),
    occupied, cleaning, running: cleaning || occupied,
    wasteFull: waste >= wasteFullAt,
    wasteColor: waste >= wasteFullAt ? CRIMSON : waste >= wasteWarnAt ? AMBER : HOLO,
    litterColor: litter < litterCritAt ? CRIMSON : litter < litterLowAt ? AMBER : HOLO,
    statusColor: occupied ? AMBER : cleaning ? BLUE : HOLO,
    statusLabel: occupied
      ? `PET DETECTED${petWeight != null ? ` · ${petWeight.toFixed(1)} ${unit}` : ''}`
      : cleaning ? 'CLEANING'
      : dock === 'docked' || code === 'rdy' ? 'READY'
      : (dock || code || '—').toUpperCase(),
  }
}

/** Litter robot, compact — the HOME overview card. */
export function LitterTile(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'litter')
  if (!prepared) return null
  const { r } = prepared
  const s = litterState(r)
  const globe = (r.state('globeLight') || 'auto').toUpperCase()

  return (
    <div className="holo">
      <div className="holo-h"><i className="ti ti-robot" /> {r.title.toUpperCase()}</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Gauge pct={s.litter} label="LITTER" color={s.litterColor} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span className="holo-l">Waste drawer</span><span style={{ fontSize: 14, color: s.wasteColor }}>{round(s.waste)}%</span>
            </div>
            <div className="holo-bar"><i style={{ width: `${s.waste}%`, background: s.wasteColor, boxShadow: `0 0 6px ${s.wasteColor}aa` }} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="holo-l" style={{ lineHeight: 1.6 }}>Status</span>
            <span style={{ fontSize: 16, color: s.statusColor, letterSpacing: 1 }}>● {s.statusLabel}</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 11 }}>
        <HoloBtn icon="ti-refresh" label="CLEAN CYCLE" onClick={() => r.send('vacuum', 'vacuum.start')} />
        {/* The night-light control cycles the select; a box without one shows
            the reset button instead of a dead lamp icon. */}
        {r.id('globeLight')
          ? <HoloBtn icon="ti-bulb" label={`LIGHT: ${globe}`} onClick={() => cycleGlobe(r)} />
          : r.id('reset') && <HoloBtn icon="ti-rotate" label="RESET" onClick={() => r.send('reset', 'button.press')} />}
      </div>
    </div>
  )
}

/**
 * Advance the night-light select to its next option.
 *
 * The old tile wired this button to the RESET button entity, which reset the
 * gauges instead of touching the light — the label said GLOBE and the click did
 * something else entirely. Cycling `options` is what the control claims to do.
 */
function cycleGlobe(r: TileReader): void {
  const options = r.attr<string[]>('globeLight', 'options') ?? []
  const current = r.state('globeLight')
  if (options.length === 0) return
  const next = options[(options.indexOf(current ?? '') + 1) % options.length]
  if (next) r.send('globeLight', 'select.select_option', { option: next })
}

/** Litter robot, detailed — the BRIDGE sidebar card. */
export function LitterStatus(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'litter')
  if (!prepared) return null
  const { r } = prepared
  const s = litterState(r)
  const hopper = r.state('hopper')
  const lastVisitStr = relTime(r.changed('petWeight'))

  return (
    <div className="holo" style={{ borderColor: s.wasteFull ? CRIMSON + '55' : s.occupied ? AMBER + '55' : undefined }}>
      <div className="holo-h" style={{ marginBottom: 10 }}>
        <i className="ti ti-robot" /> {r.title.toUpperCase()}
        {s.running && (
          <span style={{
            marginLeft: 'auto', fontSize: 11, letterSpacing: 1,
            color: s.statusColor, animation: 'phase-pulse 1.6s ease-in-out infinite',
            border: `0.5px solid ${s.statusColor}55`, padding: '1px 5px',
          }}>
            ● {s.occupied ? 'OCCUPIED' : 'CLEANING'}
          </span>
        )}
        {s.wasteFull && !s.running && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: CRIMSON, animation: 'phase-pulse 1.5s ease-in-out infinite' }}>
            ⚠ DRAWER FULL
          </span>
        )}
      </div>

      {/* globe schematic + status */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <svg viewBox="0 0 72 72" width="72" height="72" style={{ flexShrink: 0 }}>
          <ellipse cx="36" cy="58" rx="22" ry="6" fill="#050e0a" stroke={HOLO + '33'} strokeWidth="1" />
          <ellipse cx="36" cy="34" rx="20" ry="26" fill="#050e0a" stroke={s.statusColor + '66'} strokeWidth="1.5"
            style={{ filter: `drop-shadow(0 0 ${s.running ? 6 : 3}px ${s.statusColor}44)` }} />
          <ellipse cx="36" cy="30" rx="11" ry="14" fill="#030a07" stroke={s.statusColor + '44'} strokeWidth="1" />
          {s.cleaning && (
            <line x1="36" y1="30" x2="36" y2="18" stroke={BLUE} strokeWidth="1.5" strokeLinecap="round"
              style={{ transformOrigin: '36px 30px', transformBox: 'fill-box', animation: 'drum-spin 1.8s linear infinite' }} />
          )}
          {s.occupied && (
            <text x="36" y="35" textAnchor="middle" fill={AMBER + 'cc'} fontSize="14">🐱</text>
          )}
          {!s.occupied && !s.cleaning && (
            <ellipse cx="36" cy={30 + 14 * (1 - s.litter / 100)} rx="10" ry="3"
              fill={s.litterColor + '33'} stroke={s.litterColor + '55'} strokeWidth="0.5" />
          )}
          <circle cx="36" cy="60" r="3" fill={s.statusColor}
            style={{ filter: `drop-shadow(0 0 4px ${s.statusColor})`, animation: s.running ? 'phase-pulse 1.6s ease-in-out infinite' : undefined }} />
        </svg>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>
            <div className="holo-l" style={{ marginBottom: 2 }}>Status</div>
            <div style={{ fontSize: 14, color: s.statusColor, letterSpacing: 1, fontFamily: 'var(--font-display)' }}>{s.statusLabel}</div>
          </div>
          {r.id('petWeight') && (
            <div>
              <div className="holo-l" style={{ marginBottom: 2 }}>Last visit</div>
              <div style={{ fontSize: 14, color: '#9dffc4', letterSpacing: 1 }}>{lastVisitStr}</div>
            </div>
          )}
          {hopper && (
            <div>
              <div className="holo-l" style={{ marginBottom: 2 }}>Hopper</div>
              <div style={{ fontSize: 14, color: HOLO_DIM, letterSpacing: 1, textTransform: 'capitalize' }}>{hopper}</div>
            </div>
          )}
        </div>
      </div>

      {r.id('litterLevel') && (
        <div style={{ marginBottom: 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span className="holo-l">Litter level</span>
            <span style={{ fontSize: 13, color: s.litterColor, fontFamily: 'var(--font-display)' }}>{round(s.litter)}%</span>
          </div>
          <div className="holo-bar">
            <i style={{ width: `${s.litter}%`, background: s.litterColor, boxShadow: `0 0 5px ${s.litterColor}99`, transition: 'width 0.6s ease' }} />
          </div>
        </div>
      )}

      {r.id('wasteDrawer') && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span className="holo-l">Waste drawer</span>
            <span style={{ fontSize: 13, color: s.wasteColor, fontFamily: 'var(--font-display)' }}>{round(s.waste)}%</span>
          </div>
          <div className="holo-bar">
            <i style={{ width: `${s.waste}%`, background: s.wasteColor, boxShadow: `0 0 5px ${s.wasteColor}99`, transition: 'width 0.6s ease' }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 5 }}>
        <button
          className="holo-btn"
          style={{ flex: 2, color: s.cleaning ? CRIMSON : HOLO, borderColor: s.cleaning ? CRIMSON + '55' : undefined }}
          onClick={() => r.send('vacuum', s.cleaning ? 'vacuum.stop' : 'vacuum.start')}
        >
          <i className={`ti ${s.cleaning ? 'ti-square' : 'ti-refresh'}`} /> {s.cleaning ? 'STOP' : 'CLEAN'}
        </button>
        {r.id('reset') && (
          <button className="holo-btn" style={{ flex: 1 }} onClick={() => r.send('reset', 'button.press')}>
            <i className="ti ti-rotate" /> RST
          </button>
        )}
      </div>
    </div>
  )
}

// ── Pets ─────────────────────────────────────────────────────────────────

/**
 * One row per pet, from the tile's configured rows.
 *
 * The names are the operator's, typed in the tile editor, rather than a `CATS`
 * array in this file. A row's label is the only place a pet's name exists, so
 * renaming one is an edit rather than a code change.
 */
export function PetsTile(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'pets')
  if (!prepared) return null
  const { r, spec } = prepared
  const idx = indexById(props.entities)
  const unit = String(r.opt('weightUnit'))

  const rows = (props.tile.rows ?? []).map((row) => {
    const visits = Number(idx.get(row.bindings['visits'] ?? '')?.state)
    const weight = Number(idx.get(row.bindings['weight'] ?? '')?.state)
    return {
      name: row.label,
      visits: Number.isFinite(visits) ? visits : 0,
      weight: Number.isFinite(weight) ? weight : null,
    }
  }).sort((a, b) => b.visits - a.visits)

  if (rows.length === 0) return null

  return (
    <div className="holo">
      <div className="holo-h">
        <i className={`ti ${spec.icon}`} /> {r.title.toUpperCase()} · VISITS TODAY
      </div>
      <table style={{ width: '100%', fontSize: 16, letterSpacing: 1, borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td style={{ padding: '3px 0', color: row.visits > 0 ? '#9dffc4' : HOLO_DIM }}>{row.name}</td>
              <td style={{ textAlign: 'right', color: HOLO_DIM }}>
                {row.weight != null ? `${round(row.weight, 1)} ${unit}` : ''}
              </td>
              <td style={{ textAlign: 'right', width: 34 }}>
                <span className="holo-v" style={{ fontSize: 17, color: row.visits > 0 ? HOLO : HOLO_DIM }}>{row.visits}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Thermostat ───────────────────────────────────────────────────────────

export function ThermostatTile(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'thermostat')
  if (!prepared) return null
  const { r } = prepared
  const unit = props.unit ?? '°F'

  const mode = r.state('climate') || 'off'
  const action = (r.attr<string>('climate', 'hvac_action') || mode).toLowerCase()
  // The dedicated sensor when there is one, else the climate entity's own
  // reading — a thermostat always knows its temperature even if nothing else does.
  const current = r.num('temperature') ?? r.attr<number>('climate', 'current_temperature')
  const target = r.attr<number>('climate', 'temperature')
  const humidity = r.num('humidity') ?? r.attr<number>('climate', 'current_humidity')
  const emergHeat = r.on('emergencyHeat')
  const step = r.numOpt('step')

  const accent = action === 'cooling' ? BLUE : action === 'heating' ? CRIMSON : HOLO
  const actionLabel = mode === 'off' ? 'OFF' : action.toUpperCase()
  const icon = action === 'cooling' ? 'ti-snowflake' : action === 'heating' ? 'ti-flame' : 'ti-temperature'

  const bump = (delta: number): void => {
    if (target == null) return
    // Rounded to the step, not to a whole degree: a 0.5° step on a °C
    // thermostat would otherwise round straight back to where it started.
    const next = Math.round((target + delta) / step) * step
    r.send('climate', 'climate.set_temperature', { temperature: next })
  }

  return (
    <div className="holo" style={{ borderColor: accent + '4d' }}>
      <div className="holo-h" style={{ color: accent, textShadow: `0 0 6px ${accent}66` }}>
        <i className="ti ti-temperature" /> {r.title.toUpperCase()}
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
        <button className="holo-btn" style={{ width: 34 }} onClick={() => bump(-step)} aria-label="Lower target"><i className="ti ti-minus" /></button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div className="holo-l">Target</div>
          <div className="holo-v" style={{ fontSize: 19, color: accent }}>{round(target)}{unit}</div>
        </div>
        <button className="holo-btn" style={{ width: 34 }} onClick={() => bump(step)} aria-label="Raise target"><i className="ti ti-plus" /></button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 14, letterSpacing: 1, color: HOLO_DIM }}>
        <span>{humidity != null ? <>RH <b style={{ color: '#9dffc4' }}>{round(humidity)}%</b></> : ''}</span>
        {r.id('emergencyHeat') && (
          <button className="holo-btn" onClick={() => r.send('emergencyHeat', emergHeat ? 'switch.turn_off' : 'switch.turn_on')}
            style={{ color: emergHeat ? CRIMSON : undefined, borderColor: emergHeat ? CRIMSON + '55' : undefined }}>
            E-HEAT {emergHeat ? 'ON' : 'OFF'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Ambient (weather / sun / backup) ─────────────────────────────────────

export function AmbientTile(props: TileProps): JSX.Element | null {
  const prepared = prepare(props, 'ambient')
  if (!prepared) return null
  const { r } = prepared

  const cond = r.state('weather') || '—'
  const temp = r.attr<number>('weather', 'temperature')
  const sunUp = r.state('sun') === 'above_horizon'
  const setRise = sunUp ? clockTime(r.state('nextSetting')) : clockTime(r.state('nextRising'))
  const backup = r.state('backup')
  const hasSunTimes = Boolean(r.id('nextRising') || r.id('nextSetting'))

  return (
    <div className="holo">
      <div className="holo-h"><i className={`ti ${sunUp ? 'ti-sun' : 'ti-moon'}`} /> {r.title.toUpperCase()}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: HOLO, textShadow: '0 0 6px #2effb055', textTransform: 'capitalize' }}>{cond}</span>
        {temp != null && <span className="holo-v" style={{ fontSize: 19, marginLeft: 'auto' }}>{round(temp)}°</span>}
      </div>
      {hasSunTimes && (
        <div style={{ marginTop: 10 }}>
          <div className="holo-l">{sunUp ? 'Sunset' : 'Sunrise'}</div>
          <div style={{ fontSize: 18, color: '#9dffc4' }}>{setRise}</div>
        </div>
      )}
      {backup && (
        <div className="holo-l" style={{ marginTop: 10, color: HOLO_DIM }}>
          <i className="ti ti-database" style={{ verticalAlign: -1 }} /> {(r.name('backup') ?? 'BACKUP').toUpperCase()} · {backup.toUpperCase()}
        </div>
      )}
    </div>
  )
}
