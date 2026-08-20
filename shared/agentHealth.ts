// A circuit breaker for agent runs that never settle.
//
// Runs are force-failed at RUN_TIMEOUT_MS, and the scheduler then fires the next interval
// straight into whatever caused the hang. On 2026-08-18 that produced an unbroken
// ~14-hour streak of timed-out Trap Steward runs: 17 of its 25 retained runs died at the
// deadline, overnight, while the book held an open position with no resting stop. Nothing
// told the operator, because each individual run merely "errored" and the next one was
// already scheduled.
//
// Two behaviours, both derived from the run log rather than stored separately (so a
// restart cannot lose them, and the UI reads the same numbers the scheduler does):
//
//   1. BACK OFF — after each consecutive timeout, hold automatic wakes for exponentially
//      longer. A dead SDK session is not worth ten minutes of concurrency slot every hour.
//   2. TRIP — at TIMEOUT_TRIP_THRESHOLD, say so out loud. A risk control that fails
//      silently is worse than no risk control, because the desk believes it is covered.
//
// Manual RUN is never suppressed: the operator asking is how you test whether the fault
// has cleared, and a successful run of any kind clears the streak.

import type { AgentRunTrigger } from './agents'

/** Consecutive timeouts at which the breaker trips and the operator is told. */
export const TIMEOUT_TRIP_THRESHOLD = 4

/** Hold-off after the first timeout. Doubles with each one after that. */
export const TIMEOUT_BACKOFF_BASE_MS = 15 * 60_000

/** Ceiling on the hold-off, so a tripped agent still retries a few times a day and can
 *  recover on its own once the underlying fault clears. */
export const TIMEOUT_BACKOFF_CAP_MS = 6 * 60 * 60_000

/** The slice of AgentRun the breaker reads. Keeps this module free of the full type so it
 *  can be unit-tested and reused against the persisted log. */
export interface HealthRun {
  state: 'running' | 'done' | 'error' | 'skipped'
  trigger: AgentRunTrigger
  startedAt: number
  endedAt?: number | null
  /** Set by the fleet when the run was killed at the deadline rather than failing on its
   *  own. Matched on the flag, not on the error string, so rewording the message cannot
   *  quietly disable the breaker. */
  timedOut?: boolean
}

function isVerdict(r: HealthRun): boolean {
  // 'running' has not returned one yet; 'skipped' never launched a session and so says
  // nothing at all about whether sessions are working.
  return r.state !== 'running' && r.state !== 'skipped'
}

function isTimeout(r: HealthRun): boolean {
  return r.state === 'error' && r.timedOut === true
}

/** Length of the unbroken run of timeouts ending at the newest verdict. Runs are
 *  newest-first, as AgentRecord.runs stores them. */
export function consecutiveTimeouts(runs: readonly HealthRun[]): number {
  let n = 0
  for (const r of runs) {
    if (!isVerdict(r)) continue
    if (!isTimeout(r)) break
    n++
  }
  return n
}

/** How long to hold automatic wakes after `consecutive` timeouts in a row. */
export function timeoutBackoffMs(consecutive: number): number {
  if (consecutive <= 0) return 0
  const grown = TIMEOUT_BACKOFF_BASE_MS * 2 ** (consecutive - 1)
  return Math.min(grown, TIMEOUT_BACKOFF_CAP_MS)
}

export interface AgentHealth {
  consecutiveTimeouts: number
  /** Epoch ms before which automatic triggers are held, or null when nothing is held. */
  suppressedUntil: number | null
  /** True while `now` is inside that window. */
  suppressed: boolean
  /** The streak reached the threshold — worth an operator's attention. */
  tripped: boolean
}

export function agentHealth(runs: readonly HealthRun[], now: number): AgentHealth {
  const n = consecutiveTimeouts(runs)
  if (n === 0) {
    return { consecutiveTimeouts: 0, suppressedUntil: null, suppressed: false, tripped: false }
  }
  const newest = runs.find((r) => isVerdict(r))!
  // A killed run should always have an end time; fall back to its start so a missing one
  // shortens the hold-off rather than removing it.
  const anchor = newest.endedAt ?? newest.startedAt
  const suppressedUntil = anchor + timeoutBackoffMs(n)
  return {
    consecutiveTimeouts: n,
    suppressedUntil,
    suppressed: now < suppressedUntil,
    tripped: n >= TIMEOUT_TRIP_THRESHOLD
  }
}
