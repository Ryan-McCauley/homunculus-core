// The office: personnel files, cubicles (journal + mind), and the message board.
//
// Storage is deliberately file-per-employee and inspectable:
//
//   data/crypto/office/
//     board.json                  every thread and reply
//     <agentId>/personnel.json    the HR record
//     <agentId>/journal.jsonl     curated notes the employee kept
//     <agentId>/mind.jsonl        every documented thought (machine record)
//     <agentId>/mind.md           the same thoughts, human-readable
//
// The .jsonl files are authoritative — the app only ever reads those. mind.md is a
// write-only mirror so you can open a cubicle's thinking in any editor without the app
// running; nothing parses it back, so it cannot drift into being wrong.
//
// This module holds no trading authority. It records who an employee is and what they
// said; server/agents.ts decides what they are allowed to do.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BoardMessage, BoardThread, CubicleView, Department, EmploymentStatus, InboxItem,
  JournalEntry, NewPersonnelInput, PersonnelRecord, SourceRef, Thought
} from '../shared/office'
import { DEFAULT_JOB_DESCRIPTION, DEFAULT_RESUME, STANDARD_SOURCES, parseMentions } from '../shared/office'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'

const OFFICE_DIR = join(process.cwd(), 'data', 'crypto', 'office')
const BOARD_FILE = join(OFFICE_DIR, 'board.json')

// Cubicle files grow without bound otherwise; a mind that logs every thought of every run
// would be megabytes in a week. The .md mirror keeps the full history regardless.
const MAX_MIND_KEPT = 400
const MAX_JOURNAL_KEPT = 200

function agentDir(agentId: string): string {
  return join(OFFICE_DIR, agentId)
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return []
  const out: T[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as T) } catch { /* skip a torn line rather than lose the file */ }
  }
  return out
}

/** Rewrites a jsonl file capped to its most recent `keep` entries. */
function trimJsonl<T>(file: string, rows: T[], keep: number): T[] {
  const kept = rows.slice(-keep)
  if (kept.length !== rows.length) {
    writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''))
  }
  return kept
}

function ts(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19)
}

class Office {
  private board: BoardThread[] = []

  constructor() {
    this.loadBoard()
  }

  // ── Personnel ────────────────────────────────────────────────────────────

  private personnelFile(agentId: string): string {
    return join(agentDir(agentId), 'personnel.json')
  }

  getPersonnel(agentId: string): PersonnelRecord | null {
    const f = this.personnelFile(agentId)
    if (!existsSync(f)) return null
    return stateStore.readJson<PersonnelRecord | null>(f, null)
  }

  listPersonnel(): PersonnelRecord[] {
    if (!existsSync(OFFICE_DIR)) return []
    const out: PersonnelRecord[] = []
    for (const entry of readdirSync(OFFICE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rec = this.getPersonnel(entry.name)
      if (rec) out.push(rec)
    }
    return out.sort((a, b) => a.employeeId.localeCompare(b.employeeId))
  }

  /** Next payroll id. Never reuses one, even after a termination. */
  private nextEmployeeId(): string {
    const used = this.listPersonnel()
      .map((p) => Number(/(\d+)$/.exec(p.employeeId)?.[1] ?? 0))
      .filter((n) => n > 0)
    const next = (used.length ? Math.max(...used) : 0) + 1
    return `EMP-${String(next).padStart(3, '0')}`
  }

  /** Opens a personnel file on hire. Idempotent — returns the existing record if there
   *  already is one, so an agent created before the office existed is filed on first read. */
  ensurePersonnel(agentId: string, fallbackTitle: string, input: NewPersonnelInput = {}): PersonnelRecord {
    const existing = this.getPersonnel(agentId)
    if (existing) return existing

    const now = Date.now()
    const rec: PersonnelRecord = {
      agentId,
      employeeId: this.nextEmployeeId(),
      title: input.title?.trim() || fallbackTitle,
      department: input.department ?? 'operations',
      // Everyone starts on probation. Promotion is an explicit act by the operator.
      status: input.status ?? 'probation',
      hiredAt: now,
      reportsTo: input.reportsTo ?? null,
      resume: { ...DEFAULT_RESUME, ...(input.resume ?? {}) },
      jobDescription: { ...DEFAULT_JOB_DESCRIPTION, ...(input.jobDescription ?? {}) },
      sources: input.sources ?? [...STANDARD_SOURCES],
      notes: input.notes ?? '',
      updatedAt: now
    }
    ensureDir(agentDir(agentId))
    stateStore.writeJson(this.personnelFile(agentId), rec)
    console.log(`[office] opened personnel file ${rec.employeeId} for ${agentId} — ${rec.title}`)
    return rec
  }

  updatePersonnel(agentId: string, patch: NewPersonnelInput): PersonnelRecord | null {
    const rec = this.getPersonnel(agentId)
    if (!rec) return null
    const before = JSON.parse(JSON.stringify(rec)) as PersonnelRecord
    if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim()
    if (patch.department) rec.department = patch.department
    if (patch.status) rec.status = patch.status
    if (patch.reportsTo !== undefined) rec.reportsTo = patch.reportsTo
    if (patch.resume) rec.resume = { ...rec.resume, ...patch.resume }
    if (patch.jobDescription) rec.jobDescription = { ...rec.jobDescription, ...patch.jobDescription }
    if (Array.isArray(patch.sources)) rec.sources = patch.sources
    if (typeof patch.notes === 'string') rec.notes = patch.notes
    rec.updatedAt = Date.now()
    ensureDir(agentDir(agentId))
    stateStore.writeJson(this.personnelFile(agentId), rec)
    // Employment status is a hard bar on whether an agent runs at all, so a
    // personnel edit is a change to what the fleet is allowed to do, not just HR.
    auditLog.note({
      action: 'office.personnel.update',
      resource: `agent:${agentId}`,
      summary: before.status !== rec.status
        ? `${rec.employeeId} status ${before.status} → ${rec.status}`
        : `${rec.employeeId} personnel record updated`,
      before, after: rec,
    })
    return rec
  }

  /** True when this employee's status bars them from working. */
  isBenched(agentId: string): { benched: boolean; status: EmploymentStatus | null } {
    const rec = this.getPersonnel(agentId)
    if (!rec) return { benched: false, status: null }
    return { benched: rec.status === 'suspended' || rec.status === 'terminated', status: rec.status }
  }

  // ── Journal ──────────────────────────────────────────────────────────────

  private journalFile(agentId: string): string {
    return join(agentDir(agentId), 'journal.jsonl')
  }

  readJournal(agentId: string): JournalEntry[] {
    return readJsonl<JournalEntry>(this.journalFile(agentId)).slice(-MAX_JOURNAL_KEPT).reverse()
  }

  appendJournal(agentId: string, entry: { title?: string; body: string; tags?: string[]; author?: 'agent' | 'operator' }): JournalEntry {
    const row: JournalEntry = {
      id: randomUUID(),
      at: Date.now(),
      title: entry.title?.trim() || '',
      body: entry.body,
      tags: entry.tags ?? [],
      author: entry.author ?? 'agent'
    }
    const f = this.journalFile(agentId)
    ensureDir(agentDir(agentId))
    appendFileSync(f, JSON.stringify(row) + '\n')
    trimJsonl(f, readJsonl<JournalEntry>(f), MAX_JOURNAL_KEPT)
    return row
  }

  // ── Mind ─────────────────────────────────────────────────────────────────

  private mindFile(agentId: string): string {
    return join(agentDir(agentId), 'mind.jsonl')
  }

  private mindMarkdown(agentId: string): string {
    return join(agentDir(agentId), 'mind.md')
  }

  readMind(agentId: string, limit = 120): Thought[] {
    return readJsonl<Thought>(this.mindFile(agentId)).slice(-limit).reverse()
  }

  /** Documents one thought. Called automatically from the run loop, and by the employee
   *  itself when it wants to put something on the record deliberately. */
  think(agentId: string, thought: { kind?: Thought['kind']; text: string; runId?: string | null }): Thought {
    const row: Thought = {
      at: Date.now(),
      runId: thought.runId ?? null,
      kind: thought.kind ?? 'reasoning',
      text: thought.text.trim()
    }
    if (!row.text) return row
    const dir = agentDir(agentId)
    ensureDir(dir)
    const f = this.mindFile(agentId)
    appendFileSync(f, JSON.stringify(row) + '\n')
    // Human-readable mirror. Never read back — see the file header.
    appendFileSync(this.mindMarkdown(agentId), `- \`${ts(row.at)}\` **${row.kind}**${row.runId ? ` _(run ${row.runId.slice(0, 8)})_` : ''} — ${row.text}\n`)
    trimJsonl(f, readJsonl<Thought>(f), MAX_MIND_KEPT)
    return row
  }

  // ── Message board ────────────────────────────────────────────────────────

  private loadBoard(): void {
    try {
      this.board = stateStore.readJson<BoardThread[]>(BOARD_FILE, [])
    } catch (e) {
      console.warn('[office] board load failed:', (e as Error).message)
    }
  }

  private saveBoard(): void {
    try {
      ensureDir(OFFICE_DIR)
      stateStore.writeJson(BOARD_FILE, this.board)
    } catch (e) {
      console.warn('[office] board persist failed:', (e as Error).message)
    }
  }

  listThreads(): BoardThread[] {
    return [...this.board].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getThread(id: string): BoardThread | null {
    return this.board.find((t) => t.id === id) ?? null
  }

  postThread(input: { title: string; body: string; authorId: string; tags?: string[] }, knownIds: string[]): BoardThread {
    const now = Date.now()
    const msg: BoardMessage = {
      id: randomUUID(),
      authorId: input.authorId,
      at: now,
      body: input.body,
      mentions: parseMentions(input.body, knownIds)
    }
    const thread: BoardThread = {
      id: randomUUID(),
      title: input.title.trim() || '(untitled)',
      authorId: input.authorId,
      createdAt: now,
      updatedAt: now,
      tags: input.tags ?? [],
      resolved: false,
      messages: [msg]
    }
    this.board.unshift(thread)
    this.saveBoard()
    console.log(`[office] ${input.authorId} posted "${thread.title}"${msg.mentions.length ? ` @${msg.mentions.join(' @')}` : ''}`)
    return thread
  }

  reply(threadId: string, input: { body: string; authorId: string }, knownIds: string[]): BoardThread | null {
    const thread = this.getThread(threadId)
    if (!thread) return null
    const msg: BoardMessage = {
      id: randomUUID(),
      authorId: input.authorId,
      at: Date.now(),
      body: input.body,
      mentions: parseMentions(input.body, knownIds)
    }
    thread.messages.push(msg)
    thread.updatedAt = msg.at
    this.saveBoard()
    return thread
  }

  setResolved(threadId: string, resolved: boolean): BoardThread | null {
    const thread = this.getThread(threadId)
    if (!thread) return null
    thread.resolved = resolved
    thread.updatedAt = Date.now()
    this.saveBoard()
    return thread
  }

  /** Open @mentions of this employee that they have not replied to since. An employee is
   *  "caught up" on a thread once they post in it after being tagged. */
  inbox(agentId: string): InboxItem[] {
    const items: InboxItem[] = []
    for (const thread of this.board) {
      if (thread.resolved) continue
      for (const msg of thread.messages) {
        if (!msg.mentions.includes(agentId)) continue
        const answered = thread.messages.some((m) => m.authorId === agentId && m.at > msg.at)
        if (answered) continue
        items.push({
          threadId: thread.id,
          threadTitle: thread.title,
          messageId: msg.id,
          fromId: msg.authorId,
          at: msg.at,
          excerpt: msg.body.slice(0, 240)
        })
      }
    }
    return items.sort((a, b) => b.at - a.at)
  }

  /** Threads this employee wrote in or was tagged in. */
  threadsFor(agentId: string): BoardThread[] {
    return this.listThreads().filter((t) =>
      t.messages.some((m) => m.authorId === agentId || m.mentions.includes(agentId))
    )
  }

  cubicle(agentId: string, fallbackTitle: string): CubicleView {
    return {
      personnel: this.ensurePersonnel(agentId, fallbackTitle),
      journal: this.readJournal(agentId),
      mind: this.readMind(agentId),
      inbox: this.inbox(agentId),
      threads: this.threadsFor(agentId).slice(0, 20)
    }
  }

  /** Removes an employee's cubicle contents from the board's perspective. The personnel
   *  file and cubicle files are left on disk — an HR record outlives the employee. */
  offboard(agentId: string): void {
    const rec = this.getPersonnel(agentId)
    if (!rec) return
    rec.status = 'terminated'
    rec.updatedAt = Date.now()
    stateStore.writeJson(this.personnelFile(agentId), rec)
    auditLog.note({
      action: 'office.personnel.offboard',
      resource: `agent:${agentId}`,
      summary: `${rec.employeeId} terminated — record retained`,
      after: { status: rec.status },
    })
    console.log(`[office] ${rec.employeeId} (${agentId}) terminated — record retained`)
  }
}

export const office = new Office()

export function isDepartment(v: unknown): v is Department {
  return v === 'trading' || v === 'research' || v === 'risk' || v === 'operations' || v === 'executive'
}

export function isEmploymentStatus(v: unknown): v is EmploymentStatus {
  return v === 'probation' || v === 'active' || v === 'suspended' || v === 'terminated'
}

export function isSourceRef(v: unknown): v is SourceRef {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (o.kind === 'api' || o.kind === 'file' || o.kind === 'skill' || o.kind === 'doc') && typeof o.ref === 'string'
}
