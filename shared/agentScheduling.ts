// Which agent runs next.
//
// There is one run slot on this desk, and until now it was handed out in creation order:
// agentFleet.tick() walked a Map and the first eligible agent won. That made the earliest
// hire permanently senior to every later one, whatever they were waking up to do — so the
// manager woke to read chatter while the only agent with trading authority, hired last,
// waited behind it.
//
// The order here is by what the wake is FOR, then by who has waited longest. Office
// chatter sorts below every other real trigger, because a conversation can wait a tick and
// a market cannot.

import type { AgentRunTrigger } from './agents'

/** Higher goes first. Gaps left between tiers so a new trigger can be slotted in. */
export const TRIGGER_PRIORITY: Record<string, number> = {
  // The operator is asking. Nothing outranks that.
  manual: 120,
  // A colleague is blocked on this agent and the answer is already in hand.
  answer: 100,
  // The manager dispatched work off the file. Somebody is waiting on the other end.
  assignment: 90,
  // A condition the desk armed deliberately has tripped.
  alert: 70,
  // The market moved.
  signal: 60,
  fill: 60,
  drawdown: 60,
  proposal: 60,
  // Routine.
  interval: 40,
  // Somebody said something. Real, but it can wait behind all of the above.
  mention: 20,
  // Housekeeping never takes the slot from work.
  standdown: 5
}

/** Unknown triggers sort to the floor: a trigger this build does not recognise must not
 *  be able to jump the queue by being unlisted. */
const UNKNOWN_PRIORITY = 0

export function triggerPriority(trigger: AgentRunTrigger): number {
  return TRIGGER_PRIORITY[trigger] ?? UNKNOWN_PRIORITY
}

export interface RunCandidate {
  agentId: string
  trigger: AgentRunTrigger
  /** Last automatic run. Undefined means it has never had one, which sorts stalest. */
  lastAutoRunAt?: number | undefined
}

/**
 * Orders the agents eligible this tick. The caller still starts only as many as the
 * concurrency cap allows; this decides who that is.
 *
 * Ties break on staleness and then on agent id, so the result never depends on map
 * iteration order — the property that made the old scheduler quietly unfair.
 */
export function pickRunOrder<T extends RunCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const byPriority = triggerPriority(b.trigger) - triggerPriority(a.trigger)
    if (byPriority !== 0) return byPriority
    const byStaleness = (a.lastAutoRunAt ?? -Infinity) - (b.lastAutoRunAt ?? -Infinity)
    if (byStaleness !== 0) return byStaleness
    return a.agentId.localeCompare(b.agentId)
  })
}
