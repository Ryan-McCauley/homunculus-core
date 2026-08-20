// One board the whole desk posts to, instead of a thread per agent per cycle.
//
// The Trap Scout opened a new thread every hour — 61 of them in four days, almost all
// carrying an empty candidate list — and the Steward opened more under the same tag. Two
// costs came out of that. The obvious one is that the board became unreadable. The
// subtler one broke the pipeline: threads are listed by updatedAt, so a downstream post
// could shadow the scan the next stage was looking for, and the Setter would stand down
// reporting "no fresh scan" with a scan sitting one thread below.
//
// Now the desk manager opens ONE board and announces each run on it, and colleagues reply
// there. The board rolls on a day boundary or when it gets too long to read. Which thread
// to post in stops being a decision any agent has to make — and stops being a decision any
// agent can get wrong.

/** Tag carried by every desk board, so it is found by tag rather than by title guessing. */
export const ACTIVE_BOARD_TAG = 'desk-board'

/** Roll to a fresh board after this long, so a day's work is one readable thread. */
export const BOARD_MAX_AGE_MS = 24 * 60 * 60_000

/** ...or after this many messages, whichever comes first. */
export const BOARD_MAX_MESSAGES = 120

export interface ActiveBoardState {
  createdAt: number
  messageCount: number
}

export function shouldRollBoard(active: ActiveBoardState | null, now: number): boolean {
  if (!active) return true
  if (now - active.createdAt >= BOARD_MAX_AGE_MS) return true
  return active.messageCount >= BOARD_MAX_MESSAGES
}

function utcStamp(at: number): string {
  return new Date(at).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z')
}

export function activeBoardTitle(at: number): string {
  return `DESK BOARD — ${new Date(at).toISOString().slice(0, 10)}`
}

export interface RunAnnouncement {
  agentId: string
  agentName: string
  trigger: string
  runId: string
  at: number
}

/**
 * The line the manager posts when a colleague wakes.
 *
 * Deliberately free of @mentions: a mention files a triage item on the Manager's File, and
 * announcing every run would bury the file under its own announcements.
 */
export function runAnnouncement(a: RunAnnouncement): string {
  return `▶ ${a.agentName} started a ${a.trigger} run at ${utcStamp(a.at)} (run ${a.runId.slice(0, 8)}). Post your cycle output as a reply here.`
}

export interface ThreadPermission {
  ok: boolean
  error?: string
}

/**
 * Whether this author may open a NEW thread, rather than replying to the active board.
 *
 * Enforced server-side rather than asked for in the mandate, for the same reason the
 * autonomy dial is: an instruction an agent can forget is not a rule. The manager owns the
 * board, the operator is not an employee, and with no manager appointed the rule lapses
 * rather than silencing the desk.
 */
export function agentMayOpenThread(authorId: string, managerId: string | null): ThreadPermission {
  if (authorId === 'operator') return { ok: true }
  if (!managerId) return { ok: true }
  if (authorId === managerId) return { ok: true }
  return {
    ok: false,
    error: 'only the desk manager opens threads — reply on the active board instead (GET /api/crypto/office/board/active)'
  }
}
