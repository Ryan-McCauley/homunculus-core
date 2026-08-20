// A cheap, deterministic precondition checked BEFORE a Claude session is launched.
//
// The Trap Scout woke hourly for thirty consecutive cycles to call one screener endpoint,
// read "74 universe, 0 passing", and post an empty JSON block — roughly 200-290k tokens a
// time to discover that the market had not changed. The screener is the whole decision;
// the model was only reading its output aloud.
//
// A wake gate moves that check in front of the session. The scheduler runs the screener
// itself (a Python spawn, cents-free and seconds-fast), and only spends a session when
// there is something for the agent to actually reason about. A skipped run still advances
// the interval clock, so the agent is not left permanently eligible.
//
// The gate is a floor on ROUTINE wakes only. Anything targeted — the operator, an answer,
// an assignment, an alert, a market event — runs regardless: those already know something
// the screener does not.

import type { AgentRunTrigger } from './agents'

/** Candidates required before a session is worth launching, when the agent does not say. */
export const DEFAULT_MIN_PASSING = 1

/** The only gate kind this build evaluates. Kept as a tagged union so a later gate
 *  (a position check, a calendar window) slots in without changing the call sites. */
export interface AgentWakeGate {
  kind: 'screener'
  /** Saved screener id, e.g. 'trapline'. */
  screenerId: string
  /** Passing candidates needed to justify the run. Defaults to DEFAULT_MIN_PASSING. */
  minPassing?: number
}

export function isAgentWakeGate(v: unknown): v is AgentWakeGate {
  if (!v || typeof v !== 'object') return false
  const g = v as Record<string, unknown>
  if (g.kind !== 'screener') return false
  if (typeof g.screenerId !== 'string' || !g.screenerId.trim()) return false
  if (g.minPassing !== undefined) {
    if (typeof g.minPassing !== 'number' || !Number.isFinite(g.minPassing) || g.minPassing < 0) return false
  }
  return true
}

/** Whether a wake of this kind is subject to the gate at all. */
export function gateAppliesTo(trigger: AgentRunTrigger): boolean {
  return trigger === 'interval'
}

/** What the scheduler learned from running the gate's screener. */
export type GateProbe = { passing: number } | { error: string }

export interface GateVerdict {
  allow: boolean
  /** One line for the skipped run's summary, so a skip is legible in the run log. */
  reason: string
}

export function gateVerdict(gate: AgentWakeGate, probe: GateProbe): GateVerdict {
  // FAIL OPEN, always. A screener that will not run is a reason to look, not a reason to
  // go quiet — the failure mode of the alternative is an agent silenced by a broken
  // dependency it cannot see.
  if ('error' in probe) {
    return { allow: true, reason: `wake gate '${gate.screenerId}' could not be evaluated (${probe.error}) — running anyway` }
  }
  if (!Number.isFinite(probe.passing)) {
    return { allow: true, reason: `wake gate '${gate.screenerId}' returned no usable count — running anyway` }
  }
  const need = gate.minPassing ?? DEFAULT_MIN_PASSING
  if (probe.passing >= need) {
    return { allow: true, reason: `wake gate '${gate.screenerId}': ${probe.passing} passing` }
  }
  return {
    allow: false,
    reason: `wake gate '${gate.screenerId}': ${probe.passing} passing, needs ${need} — no session spent`
  }
}
