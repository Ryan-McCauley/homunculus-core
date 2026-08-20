import { describe, it, expect } from 'vitest'
import {
  TIMEOUT_TRIP_THRESHOLD,
  TIMEOUT_BACKOFF_BASE_MS,
  TIMEOUT_BACKOFF_CAP_MS,
  consecutiveTimeouts,
  timeoutBackoffMs,
  agentHealth,
  type HealthRun
} from './agentHealth'

const MIN = 60_000

/** Newest-first, like AgentRecord.runs. */
function run(over: Partial<HealthRun> = {}): HealthRun {
  return { state: 'done', trigger: 'interval', startedAt: 0, endedAt: 1000, ...over }
}

function timeout(over: Partial<HealthRun> = {}): HealthRun {
  return run({ state: 'error', timedOut: true, ...over })
}

describe('consecutiveTimeouts', () => {
  it('is zero on a healthy desk', () => {
    expect(consecutiveTimeouts([run(), run(), run()])).toBe(0)
  })

  it('is zero when there is no history at all', () => {
    expect(consecutiveTimeouts([])).toBe(0)
  })

  it('counts the unbroken streak of timeouts from the newest run backwards', () => {
    expect(consecutiveTimeouts([timeout(), timeout(), timeout(), run()])).toBe(3)
  })

  it('stops counting at the first run that completed — a success clears the streak', () => {
    expect(consecutiveTimeouts([run(), timeout(), timeout()])).toBe(0)
  })

  it('stops at a non-timeout error too: a session that failed fast is a different fault', () => {
    expect(consecutiveTimeouts([timeout(), run({ state: 'error' }), timeout()])).toBe(1)
  })

  it('ignores a run still in flight — it has not returned a verdict yet', () => {
    expect(consecutiveTimeouts([run({ state: 'running', endedAt: null }), timeout(), timeout()])).toBe(2)
  })

  it('ignores gate skips — no session was ever launched, so they say nothing about health', () => {
    expect(consecutiveTimeouts([run({ state: 'skipped' }), timeout(), timeout()])).toBe(2)
  })

  it('counts a manual timeout: the operator hitting RUN and hanging is the same fault', () => {
    expect(consecutiveTimeouts([timeout({ trigger: 'manual' }), timeout()])).toBe(2)
  })
})

describe('timeoutBackoffMs', () => {
  it('imposes no delay while nothing has timed out', () => {
    expect(timeoutBackoffMs(0)).toBe(0)
    expect(timeoutBackoffMs(-1)).toBe(0)
  })

  it('starts at the base delay after the first timeout', () => {
    expect(timeoutBackoffMs(1)).toBe(TIMEOUT_BACKOFF_BASE_MS)
  })

  it('doubles with each further consecutive timeout', () => {
    expect(timeoutBackoffMs(2)).toBe(TIMEOUT_BACKOFF_BASE_MS * 2)
    expect(timeoutBackoffMs(3)).toBe(TIMEOUT_BACKOFF_BASE_MS * 4)
  })

  it('never exceeds the cap, however long the outage runs', () => {
    expect(timeoutBackoffMs(50)).toBe(TIMEOUT_BACKOFF_CAP_MS)
  })
})

describe('agentHealth', () => {
  const now = 10_000_000

  it('reports a healthy agent as unsuppressed with nothing to tell the operator', () => {
    const h = agentHealth([run({ endedAt: now - MIN })], now)
    expect(h.consecutiveTimeouts).toBe(0)
    expect(h.suppressed).toBe(false)
    expect(h.suppressedUntil).toBeNull()
    expect(h.tripped).toBe(false)
  })

  it('suppresses automatic runs for the backoff window after a timeout', () => {
    const endedAt = now - MIN
    const h = agentHealth([timeout({ endedAt })], now)
    expect(h.suppressedUntil).toBe(endedAt + TIMEOUT_BACKOFF_BASE_MS)
    expect(h.suppressed).toBe(true)
  })

  it('releases the agent once the backoff window has passed', () => {
    const endedAt = now - TIMEOUT_BACKOFF_BASE_MS - 1
    const h = agentHealth([timeout({ endedAt })], now)
    expect(h.suppressed).toBe(false)
    // The streak is still on the record — the next timeout backs off further, not from scratch.
    expect(h.consecutiveTimeouts).toBe(1)
  })

  it('backs off further each time, so a dead SDK is not hammered hourly', () => {
    const endedAt = now - MIN
    const one = agentHealth([timeout({ endedAt })], now)
    const three = agentHealth([timeout({ endedAt }), timeout(), timeout()], now)
    expect(three.suppressedUntil! - endedAt).toBeGreaterThan(one.suppressedUntil! - endedAt)
  })

  it('trips at the threshold, which is what the operator gets told about', () => {
    const runs = Array.from({ length: TIMEOUT_TRIP_THRESHOLD }, () => timeout({ endedAt: now - MIN }))
    expect(agentHealth(runs, now).tripped).toBe(true)
  })

  it('does not trip one short of the threshold', () => {
    const runs = Array.from({ length: TIMEOUT_TRIP_THRESHOLD - 1 }, () => timeout({ endedAt: now - MIN }))
    expect(agentHealth(runs, now).tripped).toBe(false)
  })

  it('resets completely once a run finally completes', () => {
    const runs = [run({ endedAt: now - MIN }), ...Array.from({ length: 9 }, () => timeout())]
    const h = agentHealth(runs, now)
    expect(h.tripped).toBe(false)
    expect(h.suppressed).toBe(false)
    expect(h.consecutiveTimeouts).toBe(0)
  })

  it('falls back to the run start when a timeout recorded no end time', () => {
    const h = agentHealth([timeout({ startedAt: now - MIN, endedAt: null })], now)
    expect(h.suppressedUntil).toBe(now - MIN + TIMEOUT_BACKOFF_BASE_MS)
  })
})
