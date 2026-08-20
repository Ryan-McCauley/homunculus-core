import { describe, it, expect } from 'vitest'
import { isTrailArm, shouldArmTrail, type TrailArm, type TrailArmSpec, type TrailArmState } from './trailArm'

const arm: TrailArm = { atPct: 0.015, trailPct: 0.0075 }

function spec(over: Partial<TrailArmSpec> = {}): TrailArmSpec {
  return { trailArm: arm, ...over }
}

/** A filled trapline bracket sitting at +2% — past the arming threshold. */
function state(over: Partial<TrailArmState> = {}): TrailArmState {
  return { phase: 'protected', entryPrice: 100, highWater: 102, locked: false, ...over }
}

describe('isTrailArm', () => {
  it('accepts a sane arming rule', () => {
    expect(isTrailArm(arm)).toBe(true)
  })

  it('rejects malformed rules rather than arming on a guess', () => {
    for (const v of [null, undefined, {}, 'trail', { atPct: 0.015 }, { trailPct: 0.0075 },
      { atPct: -0.01, trailPct: 0.0075 },   // arming below entry is not protection
      { atPct: 0.015, trailPct: 0 },        // a zero trail is a stop at the high water mark
      { atPct: 0.015, trailPct: 1 },        // a 100% trail is a stop at zero
      { atPct: 0.015, trailPct: -0.5 }]) {
      expect(isTrailArm(v)).toBe(false)
    }
  })
})

describe('shouldArmTrail', () => {
  it('arms once the high water mark clears the threshold — the Steward move, in the engine', () => {
    expect(shouldArmTrail(spec(), state())).toBe(0.0075)
  })

  it('arms exactly at the threshold, not a tick above it', () => {
    expect(shouldArmTrail(spec(), state({ highWater: 101.5 }))).toBe(0.0075)
  })

  it('holds off while the position has not run far enough', () => {
    expect(shouldArmTrail(spec(), state({ highWater: 101.4 }))).toBeNull()
  })

  it('does nothing on a bracket that never asked to be armed', () => {
    expect(shouldArmTrail({}, state())).toBeNull()
  })

  it('does nothing on a malformed arming rule', () => {
    expect(shouldArmTrail({ trailArm: { atPct: 0.015, trailPct: 5 } as TrailArm }, state())).toBeNull()
  })

  it('never re-arms a bracket that already trails — the ratchet owns it from then on', () => {
    expect(shouldArmTrail(spec({ trailPct: 0.0075 }), state())).toBeNull()
  })

  it('waits for the entry to actually fill', () => {
    expect(shouldArmTrail(spec(), state({ phase: 'entering', entryPrice: null, highWater: null }))).toBeNull()
  })

  it('leaves a partially-exited runner alone — break-even-after-TP1 protects that one', () => {
    expect(shouldArmTrail(spec(), state({ phase: 'tp1_filled' }))).toBeNull()
  })

  it('leaves a bracket that is already on its way out alone', () => {
    for (const phase of ['exiting', 'flat', 'aborted'] as const) {
      expect(shouldArmTrail(spec(), state({ phase }))).toBeNull()
    }
  })

  it('respects the operator lock — a frozen trade does not get quietly re-risked', () => {
    expect(shouldArmTrail(spec(), state({ locked: true }))).toBeNull()
  })

  it('does nothing without a high water mark to measure against', () => {
    expect(shouldArmTrail(spec(), state({ highWater: null }))).toBeNull()
  })

  it('refuses to divide by a missing or nonsensical entry price', () => {
    expect(shouldArmTrail(spec(), state({ entryPrice: null }))).toBeNull()
    expect(shouldArmTrail(spec(), state({ entryPrice: 0 }))).toBeNull()
    expect(shouldArmTrail(spec(), state({ entryPrice: Number.NaN }))).toBeNull()
  })

  it('arms strictly tighter than the disaster stop it replaces — the reason auto is safe', () => {
    // The whole justification for arming without confirmation: the stop can only move up.
    const armed = shouldArmTrail(spec(), state())!
    const newStop = 102 * (1 - armed)
    const disasterStop = 100 * (1 - 0.08)
    expect(newStop).toBeGreaterThan(disasterStop)
    expect(newStop).toBeGreaterThan(100) // and above entry, so the trade is now green-locked
  })
})
