// Arming the trailing stop, in the engine rather than in a language model.
//
// The Trap Steward's "signature move" was a fixed threshold: once the high water mark
// reaches entry +1.5%, set a 0.75% trail. That is arithmetic, and it was being run by a
// Claude session on a 30-minute interval that timed out 17 times in its last 25 runs —
// so the one time-sensitive risk action on the desk was also the least reliable thing on
// it. The ratchet that follows arming was always engine-side (a 20s tick); only the
// decision to start it was not.
//
// Arming strictly TIGHTENS risk: the stop moves from -stopPct below entry up to just
// under the high water mark, which by definition is above entry once the threshold is
// met. That is why it is safe to do without confirmation, and why the operator lock is
// still honoured — a deliberately frozen trade stays exactly as it is.

/** Arm a trail of `trailPct` once the high water mark reaches entry × (1 + atPct). */
export interface TrailArm {
  atPct: number
  trailPct: number
}

export function isTrailArm(v: unknown): v is TrailArm {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  if (typeof a.atPct !== 'number' || !Number.isFinite(a.atPct) || a.atPct <= 0) return false
  if (typeof a.trailPct !== 'number' || !Number.isFinite(a.trailPct)) return false
  // A zero trail is a stop sitting on the high water mark; a trail of 1 is a stop at zero.
  return a.trailPct > 0 && a.trailPct < 1
}

/** The slice of BracketSpec this decision reads. */
export interface TrailArmSpec {
  trailArm?: TrailArm
  trailPct?: number
}

/** The slice of BracketState this decision reads. */
export interface TrailArmState {
  phase: 'entering' | 'protected' | 'tp1_filled' | 'exiting' | 'flat' | 'aborted'
  entryPrice: number | null
  highWater: number | null
  locked?: boolean
}

/**
 * The trail percentage to arm now, or null to leave the bracket alone.
 *
 * Deliberately confined to the 'protected' phase — the one the Steward's mandate names.
 * A partially exited runner ('tp1_filled') is already covered by breakEvenAfterTp1, and
 * layering a second stop-moving rule on top of that is how duplicate stops get stacked.
 */
export function shouldArmTrail(spec: TrailArmSpec, st: TrailArmState): number | null {
  if (!isTrailArm(spec.trailArm)) return null
  if (spec.trailPct != null) return null          // already trailing — the ratchet owns it
  if (st.locked) return null                       // operator froze this trade
  if (st.phase !== 'protected') return null
  const entry = st.entryPrice
  const hwm = st.highWater
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return null
  if (hwm == null || !Number.isFinite(hwm) || hwm <= 0) return null
  if (hwm < entry * (1 + spec.trailArm.atPct)) return null
  return spec.trailArm.trailPct
}
