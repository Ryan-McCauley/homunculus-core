// The Manager's File — one queue for every outstanding question on the desk.
//
// The problem this solves: an @mention used to wake whoever was tagged, and replies on
// this board routinely tag five or six colleagues at once. One reply therefore armed six
// agents, each of whom woke, replied, and tagged six more. With a single run slot the
// queue never drained, because draining it generated more of it. Cooldowns did not help —
// they only spaced out a loop that had no exit.
//
// So mentions no longer wake anybody except the desk manager, and they arrive as a FILE
// rather than as eight private inboxes:
//
//   1. ONE ITEM PER MESSAGE, not per tag. A reply tagging six colleagues is one question
//      on the file, carrying the six names. The broadcast is collapsed at the door.
//   2. ONLY THE MANAGER READS IT, and only on an edge — something filed since their last
//      wake. An untriaged item that has already been seen does not wake anyone again.
//   3. THE MANAGER DISPATCHES. Assigning an item is what wakes a colleague, it carries a
//      concrete instruction, and each agent may hold only MAX_ASSIGNED_PER_AGENT at once.
//      An answer comes back to the file, where the manager synthesizes it.
//
// Everything here is pure: no clock, no disk, no ids from randomness. server/managerFile.ts
// owns persistence and server/agents.ts owns the waking. Nothing in this module grants an
// agent any authority it did not already have — it routes questions, not permissions.

import type { BoardThread, PersonnelRecord } from './office'
import type { Blocker } from './blockers'
import { OPERATOR_ID } from './blockers'

/** Where an item came from. A mention is unstructured; a blocker was already a question. */
export type FileItemKind = 'mention' | 'blocker'

export type FileItemStatus =
  | 'new'       // on the file, not yet triaged — this is what wakes the manager
  | 'assigned'  // out with a colleague, with an instruction
  | 'answered'  // the colleague replied; the manager still has to fold it in
  | 'closed'    // done, or moot

export const FILE_ITEM_STATUS_LABELS: Record<FileItemStatus, string> = {
  new: 'NEEDS TRIAGE',
  assigned: 'OUT WITH',
  answered: 'ANSWERED',
  closed: 'CLOSED'
}

/** Why an item closed. 'resolved-at-source' means the desk sorted it out without the
 *  manager — the colleague simply replied on the thread, or the blocker was answered. */
export type FileCloseReason = 'manager' | 'resolved-at-source'

export interface ManagerFileItem {
  /** Derived from the source, never random: re-scanning the same board is idempotent. */
  id: string
  kind: FileItemKind
  /** Who raised it. */
  fromId: string
  /** Everyone the message named, minus the author. The manager's first clue at an owner. */
  namedIds: string[]
  threadId: string | null
  threadTitle: string
  messageId: string | null
  blockerId: string | null
  /** When the question was asked — what its age is measured from. */
  at: number
  /** When it landed on the file. Novelty is measured from this, not from `at`, so an old
   *  message discovered late still reaches the manager exactly once. */
  filedAt: number
  excerpt: string
  status: FileItemStatus
  assignedTo: string | null
  assignedAt: number | null
  /** What the manager actually wants from the assignee. An assignment without one is just
   *  a mention with extra steps, so it is required. */
  instruction: string
  /** Set once handed to the assignee in a run, so one assignment wakes them once. */
  deliveredAt: number | null
  answeredBy: string | null
  answeredAt: number | null
  answer: string
  closedAt: number | null
  closedReason: FileCloseReason | null
  /** The manager's own working note. */
  note: string
}

/**
 * How much unanswered work one colleague may be holding from the file at a time. Past
 * this the manager is not delegating, they are queueing — and a queued agent burns a full
 * session re-reading a backlog it cannot finish. Matches MAX_OPEN_PER_AGENT in spirit.
 */
export const MAX_ASSIGNED_PER_AGENT = 3

/** Excerpt length on the file. Long enough to triage from, short enough to scan. */
const EXCERPT_CHARS = 240

export function mentionKey(threadId: string, messageId: string): string {
  return `mention:${threadId}:${messageId}`
}

export function blockerKey(blockerId: string): string {
  return `blocker:${blockerId}`
}

export interface CollectOpts {
  /** The desk manager's agent id. Their own posts are dispatches, not questions. */
  managerId: string
  knownIds?: string[]
  now: number
}

// ── Who is the manager ─────────────────────────────────────────────────────

/**
 * The desk manager: the active executive who reports to nobody. Falls back to whoever the
 * most people report to, so a desk that never filled in a department still has a routing
 * target. Returns null rather than guessing when the roster cannot answer — the caller
 * then leaves mention waking off entirely, which is the safe direction.
 */
export function deskManagerId(personnel: PersonnelRecord[]): string | null {
  const active = personnel.filter((p) => p.status === 'active' || p.status === 'probation')
  const execs = active
    .filter((p) => p.department === 'executive' && p.reportsTo === null)
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
  if (execs.length) return execs[0]?.agentId ?? null

  const counts = new Map<string, number>()
  for (const p of active) {
    if (!p.reportsTo) continue
    counts.set(p.reportsTo, (counts.get(p.reportsTo) ?? 0) + 1)
  }
  const onRoster = new Set(active.map((p) => p.agentId))
  const ranked = [...counts.entries()]
    .filter(([id]) => onRoster.has(id))
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
  return ranked[0]?.[0] ?? null
}

// ── Collecting ─────────────────────────────────────────────────────────────

function blankItem(): Omit<ManagerFileItem, 'id' | 'kind' | 'fromId' | 'namedIds' | 'at' | 'filedAt' | 'excerpt'> {
  return {
    threadId: null, threadTitle: '', messageId: null, blockerId: null,
    status: 'new', assignedTo: null, assignedAt: null, instruction: '', deliveredAt: null,
    answeredBy: null, answeredAt: null, answer: '', closedAt: null, closedReason: null, note: ''
  }
}

/**
 * Every board message that still owes somebody an answer, as one item apiece.
 *
 * A message is outstanding while at least one colleague it named — excluding the author,
 * who does not owe themselves anything — has not posted in the thread since. An operator
 * tag always stays outstanding: only the human can clear it, and they do not post to
 * close a loop.
 */
export function collectMentionItems(threads: BoardThread[], opts: CollectOpts): ManagerFileItem[] {
  const out: ManagerFileItem[] = []
  for (const thread of threads) {
    if (thread.resolved) continue
    for (const message of thread.messages) {
      // The manager's own posts are how they dispatch. Filing them back would put the
      // manager in a loop with itself, which is the exact shape this module removes.
      if (message.authorId === opts.managerId) continue
      const named = (message.mentions ?? []).filter((id) => id !== message.authorId)
      if (!named.length) continue

      const outstanding = named.some((id) => {
        if (id === OPERATOR_ID) return true
        return !thread.messages.some((m) => m.authorId === id && m.at > message.at)
      })
      if (!outstanding) continue

      out.push({
        ...blankItem(),
        id: mentionKey(thread.id, message.id),
        kind: 'mention',
        fromId: message.authorId,
        namedIds: named,
        threadId: thread.id,
        threadTitle: thread.title,
        messageId: message.id,
        at: message.at,
        filedAt: opts.now,
        excerpt: message.body.slice(0, EXCERPT_CHARS)
      })
    }
  }
  return out
}

/** Open blockers, which are already questions with an owner — they just were not in one
 *  place with everything else. */
export function collectBlockerItems(blockers: Blocker[], opts: CollectOpts): ManagerFileItem[] {
  return blockers
    .filter((b) => b.status === 'open')
    .map((b) => ({
      ...blankItem(),
      id: blockerKey(b.id),
      kind: 'blocker' as const,
      fromId: b.agentId,
      namedIds: [b.askedOf],
      threadId: b.threadId,
      threadTitle: '',
      messageId: null,
      blockerId: b.id,
      at: b.createdAt,
      filedAt: opts.now,
      excerpt: `${b.question}${b.why ? ` (needs it to: ${b.why})` : ''}`.slice(0, EXCERPT_CHARS)
    }))
}

// ── Merging ────────────────────────────────────────────────────────────────

const STATUS_RANK: Record<FileItemStatus, number> = { new: 0, assigned: 1, answered: 2, closed: 3 }

function sortFile(items: ManagerFileItem[]): ManagerFileItem[] {
  return [...items].sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (a.at - b.at))
}

/**
 * Folds a fresh scan into the file kept on disk.
 *
 * Triage state always wins over the scan: an item the manager assigned stays assigned
 * even though the scan only knows it as 'new'. An item whose source has gone away closes
 * itself — the colleague replied, or the blocker was answered, and chasing it further
 * would be the desk talking to itself again. A closed item never comes back.
 */
export function mergeIntoFile(existing: ManagerFileItem[], incoming: ManagerFileItem[], now: number): ManagerFileItem[] {
  const byId = new Map(existing.map((i) => [i.id, i]))
  const seen = new Set(incoming.map((i) => i.id))
  const out: ManagerFileItem[] = []

  for (const item of existing) {
    if (item.status === 'closed' || seen.has(item.id)) {
      out.push({ ...item })
      continue
    }
    out.push({ ...item, status: 'closed', closedAt: now, closedReason: 'resolved-at-source' })
  }
  for (const item of incoming) {
    if (byId.has(item.id)) continue
    out.push({ ...item })
  }
  return sortFile(out)
}

// ── Triage ─────────────────────────────────────────────────────────────────

export type FileResult =
  | { ok: true; items: ManagerFileItem[]; item: ManagerFileItem }
  | { ok: false; error: string }

function replace(items: ManagerFileItem[], next: ManagerFileItem): ManagerFileItem[] {
  return sortFile(items.map((i) => (i.id === next.id ? next : { ...i })))
}

/** Open assignments a colleague is holding — what the cap counts. */
function heldBy(items: ManagerFileItem[], agentId: string): ManagerFileItem[] {
  return items.filter((i) => i.status === 'assigned' && i.assignedTo === agentId)
}

export function assignItem(
  items: ManagerFileItem[],
  input: { id: string; to: string; instruction: string; now: number }
): FileResult {
  const found = items.find((i) => i.id === input.id)
  if (!found) return { ok: false, error: `no item ${input.id} on the file` }
  if (found.status === 'closed') return { ok: false, error: 'that item is closed' }

  const to = input.to.trim()
  if (!to) return { ok: false, error: 'assign it to somebody — an unassigned question is not delegated' }
  const instruction = input.instruction.trim()
  if (!instruction) {
    return { ok: false, error: 'an instruction is required — say what you want back, or this is just another mention' }
  }

  const held = heldBy(items, to).filter((i) => i.id !== found.id)
  if (held.length >= MAX_ASSIGNED_PER_AGENT) {
    return {
      ok: false,
      error: `@${to} is already holding ${held.length} open item(s) (max ${MAX_ASSIGNED_PER_AGENT}). ` +
        'Wait for one to come back, or give this to someone else.'
    }
  }

  // Re-arm delivery whenever the owner changes: the new owner has not been told yet, and
  // an inherited deliveredAt would mean they never are.
  const reassigned = found.assignedTo !== to
  const next: ManagerFileItem = {
    ...found,
    status: 'assigned',
    assignedTo: to,
    assignedAt: input.now,
    instruction,
    deliveredAt: reassigned ? null : found.deliveredAt
  }
  return { ok: true, items: replace(items, next), item: next }
}

export function answerItem(
  items: ManagerFileItem[],
  input: { id: string; answer: string; by: string; now: number }
): FileResult {
  const found = items.find((i) => i.id === input.id)
  if (!found) return { ok: false, error: `no item ${input.id} on the file` }
  if (found.status === 'closed') return { ok: false, error: 'that item is closed' }
  const answer = input.answer.trim()
  if (!answer) return { ok: false, error: 'an answer is required' }

  const next: ManagerFileItem = {
    ...found,
    status: 'answered',
    answer,
    answeredBy: input.by,
    answeredAt: input.now
  }
  return { ok: true, items: replace(items, next), item: next }
}

export function closeItem(
  items: ManagerFileItem[],
  input: { id: string; by: string; now: number }
): FileResult {
  const found = items.find((i) => i.id === input.id)
  if (!found) return { ok: false, error: `no item ${input.id} on the file` }
  // Idempotent: closing something already closed is the desired end state, not an error.
  if (found.status === 'closed') return { ok: true, items: [...items], item: found }

  const next: ManagerFileItem = {
    ...found,
    status: 'closed',
    closedAt: input.now,
    closedReason: 'manager',
    note: found.note || (input.by ? `closed by ${input.by}` : '')
  }
  return { ok: true, items: replace(items, next), item: next }
}

// ── Delivery ───────────────────────────────────────────────────────────────

export function pendingAssignments(items: ManagerFileItem[], agentId: string): ManagerFileItem[] {
  return items
    .filter((i) => i.status === 'assigned' && i.assignedTo === agentId && i.deliveredAt === null)
    .sort((a, b) => (a.assignedAt ?? a.at) - (b.assignedAt ?? b.at))
}

export function markAssignmentsDelivered(items: ManagerFileItem[], ids: string[], now: number): ManagerFileItem[] {
  const set = new Set(ids)
  return items.map((i) => (set.has(i.id) && i.deliveredAt === null ? { ...i, deliveredAt: now } : { ...i }))
}

export function openItems(items: ManagerFileItem[]): ManagerFileItem[] {
  return items.filter((i) => i.status !== 'closed')
}

/**
 * Whether the manager should be woken. True only when something UNTRIAGED landed since
 * their last automatic wake — the edge that replaces the old level check. An item the
 * manager has already seen and not yet assigned does not wake them a second time; it is
 * still on the file, and they will see it on their next run whatever the reason for it.
 */
export function mentionWakeDue(items: ManagerFileItem[], since: number): boolean {
  return items.some((i) => i.status === 'new' && i.filedAt > since)
}

// ── Rendering ──────────────────────────────────────────────────────────────

function age(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60_000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 48 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`
}

/** The file as the manager sees it in their prompt. Closed items are left out — the file
 *  is a working queue, not an archive. */
export function managerDigest(items: ManagerFileItem[], opts: { now: number }): string {
  const open = openItems(items)
  if (!open.length) return "THE MANAGER'S FILE is empty — nothing on the desk is waiting on an answer."

  const lines: string[] = ["THE MANAGER'S FILE — every outstanding question on the desk, in one place."]
  const groups: [FileItemStatus, string][] = [
    ['new', 'NEEDS TRIAGE — decide each one: assign it, answer it yourself, or close it'],
    ['assigned', 'OUT WITH A COLLEAGUE — do not re-ask; they are woken with the instruction'],
    ['answered', 'ANSWERED — fold these into your synthesis, then close them']
  ]

  for (const [status, heading] of groups) {
    const rows = open.filter((i) => i.status === status)
    if (!rows.length) continue
    lines.push('', heading + ':')
    for (const i of rows) {
      const named = i.namedIds.length ? ` → ${i.namedIds.map((n) => `@${n}`).join(' ')}` : ''
      const where = i.threadTitle ? ` · thread "${i.threadTitle}"` : ''
      lines.push(`  [${i.id}] from @${i.fromId}${named} · ${age(i.at, opts.now)} old${where}`)
      lines.push(`      ${i.excerpt.replace(/\s+/g, ' ').slice(0, 200)}`)
      if (status === 'assigned') lines.push(`      → @${i.assignedTo} asked to: ${i.instruction}`)
      if (status === 'answered') lines.push(`      ← @${i.answeredBy}: ${i.answer.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
  return lines.join('\n')
}

/** What an assignee is handed when the manager sends them work. Empty when there is
 *  none, so the prompt does not carry a dead heading. */
export function assignmentBlock(items: ManagerFileItem[]): string {
  if (!items.length) return ''
  const lines: string[] = [
    'THE MANAGER HAS ASSIGNED YOU WORK. This is why you are awake. Do these, then answer',
    'each one on the file — do not reply by tagging the desk, and do not open a new thread:'
  ]
  for (const i of items) {
    lines.push('', `  [${i.id}] raised by @${i.fromId}${i.threadTitle ? ` in "${i.threadTitle}"` : ''}`)
    lines.push(`      THEY ASKED: ${i.excerpt.replace(/\s+/g, ' ').slice(0, 240)}`)
    lines.push(`      THE MANAGER WANTS: ${i.instruction}`)
  }
  return lines.join('\n')
}
