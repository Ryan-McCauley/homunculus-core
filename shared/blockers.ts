// Blockers — what an employee is waiting on, and from whom.
//
// The problem this solves: an agent that needs an answer has no way to *wait*. Its
// interval fires again, it wakes with the same unanswered question, and it asks again —
// so a single open question turns into a stream of reminders nobody asked for. A human
// employee who asks their manager something does not re-ask every fifteen minutes; they
// get on with something else, or they stop.
//
// A blocker makes waiting a real state:
//   - raising one is idempotent, so asking twice does not produce two asks
//   - while an agent holds an open blocker its automatic triggers are suppressed
//   - an answer is what wakes it back up, and the answer is handed to it
//
// The suppression is enforced server-side in agentFleet.tick(), not by asking the agent
// nicely in its prompt. A confused agent cannot nag its way around it.

/** Who a question can be addressed to. Any agentId, or the human. */
export const OPERATOR_ID = 'operator'

export type BlockerStatus =
  | 'open'       // waiting; the asker's automatic triggers are suppressed
  | 'answered'   // answered, and the answer has been delivered to the asker
  | 'withdrawn'  // the asker or the operator cancelled it — no longer needed
  | 'expired'    // aged out without an answer; the asker was released to continue

export const BLOCKER_STATUS_LABELS: Record<BlockerStatus, string> = {
  open: 'WAITING',
  answered: 'ANSWERED',
  withdrawn: 'WITHDRAWN',
  expired: 'EXPIRED'
}

/** How hard the asker is stuck. Decides whether waiting means "pause everything". */
export type BlockerSeverity =
  | 'blocking'   // cannot do the job at all until answered — triggers suppressed
  | 'waiting'    // would like an answer, can keep working meanwhile

export const BLOCKER_SEVERITY_LABELS: Record<BlockerSeverity, string> = {
  blocking: 'BLOCKED',
  waiting: 'WAITING'
}

export interface Blocker {
  id: string
  /** The employee who is stuck. */
  agentId: string
  /** Who owes the answer: an agentId, or 'operator'. */
  askedOf: string
  /** The question itself, in the asker's words. */
  question: string
  /** What this unblocks — why the work cannot continue without it. Keeps the list
   *  readable as a queue of decisions rather than a pile of curiosity. */
  why: string
  severity: BlockerSeverity
  /** Board thread where it was raised, when there is one. */
  threadId: string | null
  createdAt: number
  status: BlockerStatus
  /** How many automatic wake-ups were suppressed while this stayed open — the count of
   *  reminders the desk did NOT receive. */
  suppressedRuns: number
  answeredAt: number | null
  answeredBy: string | null
  answer: string
  /** Set once the answer has actually been handed to the asker in a run, so an answer
   *  wakes it exactly once. */
  deliveredAt: number | null
}

export interface NewBlockerInput {
  agentId: string
  askedOf: string
  question: string
  why?: string
  severity?: BlockerSeverity
  threadId?: string | null
}

/** Open blockers one agent may hold at once. Past this it is not blocked, it is lost —
 *  and the answer is to escalate to the manager rather than open a fourth question. */
export const MAX_OPEN_PER_AGENT = 3

/** An unanswered question does not hold an employee hostage forever. At this age the
 *  blocker expires, the agent is released to continue, and the expiry is visible. */
export const BLOCKER_EXPIRY_MS = 48 * 60 * 60 * 1000

/** Normalizes a question for duplicate detection: case, punctuation and filler removed,
 *  so "Should I raise the cap?" and "should i raise the cap" are one question. */
export function questionKey(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

export function isBlockerSeverity(v: unknown): v is BlockerSeverity {
  return v === 'blocking' || v === 'waiting'
}

export function blockerAge(b: Blocker, now = Date.now()): number {
  return now - b.createdAt
}

/** True when this blocker should stop the asker's automatic triggers. */
export function suppresses(b: Blocker): boolean {
  return b.status === 'open' && b.severity === 'blocking'
}
