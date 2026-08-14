// The office: HR records, cubicles, journals, minds, and the message board.
//
// An agent (shared/agents.ts) is the *machine* — a mandate, an autonomy dial, a run loop.
// This module is the *employee*: who they are, what they were hired to do, what they are
// qualified to read, who they report to, and what they have said to their colleagues.
// Splitting them keeps the trade-authority gate small and auditable; nothing in here can
// widen what an agent is permitted to do.
//
// Everything is stored as inspectable files under data/crypto/office/<agentId>/ — the
// journal and the mind are markdown you can open and read without the app running.

// ── Personnel ──────────────────────────────────────────────────────────────

export type EmploymentStatus =
  | 'probation'   // hired, output is read-only advice until you promote them
  | 'active'
  | 'suspended'   // retained but barred from running
  | 'terminated'  // kept for the record; cannot run

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  probation: 'PROBATION',
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  terminated: 'TERMINATED'
}

export type Department =
  | 'trading'
  | 'research'
  | 'risk'
  | 'operations'
  | 'executive'

export const DEPARTMENTS: Department[] = ['trading', 'research', 'risk', 'operations', 'executive']

/** Something the employee is expected — and permitted — to consult. Injected into their
 *  system prompt, so this doubles as a reading list and a scope limit. */
export interface SourceRef {
  /** 'api' = a REST route on this server, 'file' = a path in the repo/data dir,
   *  'skill' = a slash-command strategy doc, 'doc' = an external reference. */
  kind: 'api' | 'file' | 'skill' | 'doc'
  ref: string
  /** Why this employee cares about it — one line, shown in their file. */
  note: string
}

export interface Resume {
  /** One-paragraph professional summary, written like a real résumé. */
  summary: string
  /** What they are good at — short noun phrases. */
  specialties: string[]
  /** Prior experience: for an agent, the bodies of work it was derived from
   *  (a backtest, a tuning ledger, a strategy that taught the lesson). */
  background: string[]
  /** Things they are certified to judge — used later by the review process. */
  credentials: string[]
}

export interface JobDescription {
  /** Bulleted duties. The mandate is the prompt; this is the contract. */
  responsibilities: string[]
  /** How this role will be scored once performance reviews exist. */
  kpis: string[]
}

export interface PersonnelRecord {
  agentId: string
  /** Stable payroll-style id, e.g. "EMP-001". Never reused. */
  employeeId: string
  title: string
  department: Department
  status: EmploymentStatus
  hiredAt: number
  /** agentId of this employee's manager, or null for a direct report to the operator. */
  reportsTo: string | null
  resume: Resume
  jobDescription: JobDescription
  sources: SourceRef[]
  /** Free-form HR notes — the operator's own commentary on the employee. */
  notes: string
  updatedAt: number
}

// ── Cubicle: journal + mind ────────────────────────────────────────────────

/** A note the employee chose to keep. Curated, written deliberately. */
export interface JournalEntry {
  id: string
  at: number
  /** Optional short heading so a journal reads like a notebook, not a log. */
  title: string
  body: string
  tags: string[]
  /** 'agent' when the employee wrote it, 'operator' when you did. */
  author: 'agent' | 'operator'
}

/** One documented thought. Unlike the journal these are captured automatically from the
 *  employee's reasoning stream — the raw record of how it got somewhere, not a summary. */
export interface Thought {
  at: number
  /** The run this thought belongs to, or null when thinking outside a run (chat). */
  runId: string | null
  kind: 'reasoning' | 'action' | 'observation' | 'decision'
  text: string
}

// ── Message board ──────────────────────────────────────────────────────────

export interface BoardMessage {
  id: string
  /** agentId, or 'operator' when you post. */
  authorId: string
  at: number
  body: string
  /** agentIds mentioned with @ in the body, resolved at post time. */
  mentions: string[]
}

/** A thread on the board. Business plans, questions, hand-offs — anything colleagues
 *  would put in a channel rather than say once and lose. */
export interface BoardThread {
  id: string
  title: string
  authorId: string
  createdAt: number
  updatedAt: number
  /** Free-tag, e.g. 'business-plan', 'review', 'incident'. */
  tags: string[]
  /** Open threads appear in inboxes; resolved ones drop out. */
  resolved: boolean
  messages: BoardMessage[]
}

/** An unanswered @mention — what an employee sees when they check their inbox. */
export interface InboxItem {
  threadId: string
  threadTitle: string
  messageId: string
  fromId: string
  at: number
  excerpt: string
}

/** Everything the cubicle view renders for one employee. */
export interface CubicleView {
  personnel: PersonnelRecord
  journal: JournalEntry[]
  mind: Thought[]
  inbox: InboxItem[]
  /** Threads this employee has posted in or been mentioned in, newest first. */
  threads: BoardThread[]
}

export interface NewPersonnelInput {
  title?: string
  department?: Department
  status?: EmploymentStatus
  reportsTo?: string | null
  resume?: Partial<Resume>
  jobDescription?: Partial<JobDescription>
  sources?: SourceRef[]
  notes?: string
}

/** Sources every employee gets on day one — the house data they all reason over. */
export const STANDARD_SOURCES: SourceRef[] = [
  { kind: 'api', ref: 'GET /api/crypto/snapshot', note: 'Live portfolio, tickers, signals, resting orders.' },
  { kind: 'api', ref: 'GET /api/crypto/closed-trades', note: 'Realized round-trip ledger with per-strategy win rate.' },
  { kind: 'api', ref: 'GET /api/crypto/candles/<SYMBOL>/<TF>', note: 'Candle history for any tracked pair.' }
]

export const DEFAULT_JOB_DESCRIPTION: JobDescription = {
  responsibilities: [],
  kpis: []
}

export const DEFAULT_RESUME: Resume = {
  summary: '',
  specialties: [],
  background: [],
  credentials: []
}

/** Extracts @mentions from a message body. Matches @some-agent-id, case-insensitive. */
export function parseMentions(body: string, knownIds: string[]): string[] {
  const found = new Set<string>()
  const re = /@([a-z0-9][a-z0-9-]*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const raw = (m[1] ?? '').toLowerCase()
    const hit = knownIds.find((id) => id.toLowerCase() === raw)
    if (hit) found.add(hit)
  }
  return [...found]
}
