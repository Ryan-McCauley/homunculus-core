// The blocker board — what each employee is waiting on, and from whom.
//
// This module exists to make "waiting" a state the desk can see and the server can
// enforce. Two behaviours matter, and both live here rather than in a prompt:
//
//   1. RAISING IS IDEMPOTENT. The same agent asking the same person the same question
//      returns the blocker it already has. An agent cannot turn one open question into a
//      stream of reminders, however many times it wakes up and however its prompt reads.
//
//   2. AN OPEN BLOCKER SUPPRESSES THE ASKER. agentFleet.tick() refuses to fire interval
//      and event triggers for an agent holding a 'blocking' question. It waits, as an
//      employee would. The answer is what wakes it, and the answer travels with the wake.
//
// Nothing here grants trading authority. It stores questions and answers.

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Blocker, BlockerSeverity, NewBlockerInput } from '../shared/blockers'
import { BLOCKER_EXPIRY_MS, MAX_OPEN_PER_AGENT, questionKey, suppresses } from '../shared/blockers'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'

const BLOCKERS_FILE = join(process.cwd(), 'data', 'crypto', 'office', 'blockers.json')

// Answered and withdrawn rows are kept so the tab can show recent history, but not
// forever — the open set is the working list.
const MAX_CLOSED_KEPT = 100

interface PersistShape {
  blockers: Blocker[]
}

class BlockerBoard {
  private items: Blocker[] = []

  constructor() {
    this.items = stateStore.readJson<PersistShape>(BLOCKERS_FILE, { blockers: [] }).blockers ?? []
    if (this.items.length) console.log(`[blockers] loaded ${this.open().length} open of ${this.items.length}`)
  }

  private save(): void {
    // Trim closed rows oldest-first; open ones are never dropped.
    const open = this.items.filter((b) => b.status === 'open')
    const closed = this.items.filter((b) => b.status !== 'open')
      .sort((a, b) => (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt))
      .slice(0, MAX_CLOSED_KEPT)
    this.items = [...open, ...closed]
    stateStore.writeJson(BLOCKERS_FILE, { blockers: this.items } satisfies PersistShape)
  }

  list(): Blocker[] {
    // Open first, oldest open at the top — the thing waiting longest is the thing to answer.
    return [...this.items].sort((a, b) => {
      const ao = a.status === 'open' ? 0 : 1
      const bo = b.status === 'open' ? 0 : 1
      if (ao !== bo) return ao - bo
      return ao === 0 ? a.createdAt - b.createdAt : (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt)
    })
  }

  open(): Blocker[] {
    return this.items.filter((b) => b.status === 'open')
  }

  openFor(agentId: string): Blocker[] {
    return this.items.filter((b) => b.status === 'open' && b.agentId === agentId)
  }

  /** Open questions addressed TO someone — their queue of things to answer. */
  openAskedOf(who: string): Blocker[] {
    return this.items.filter((b) => b.status === 'open' && b.askedOf === who)
  }

  get(id: string): Blocker | null {
    return this.items.find((b) => b.id === id) ?? null
  }

  /** True when this agent's automatic triggers should be held. */
  isBlocked(agentId: string): Blocker | null {
    return this.items.find((b) => b.agentId === agentId && suppresses(b)) ?? null
  }

  /** Answers waiting to be handed to this agent — the reason to wake it. */
  undelivered(agentId: string): Blocker[] {
    return this.items.filter((b) => b.agentId === agentId && b.status === 'answered' && b.deliveredAt === null)
  }

  markDelivered(ids: string[]): void {
    const now = Date.now()
    let touched = false
    for (const b of this.items) {
      if (ids.includes(b.id) && b.deliveredAt === null) { b.deliveredAt = now; touched = true }
    }
    if (touched) this.save()
  }

  /**
   * Raises a blocker, or returns the existing one if this agent has already asked this
   * person this question. The duplicate check is the whole point: it is what stops an
   * agent re-asking every time its interval fires.
   */
  raise(input: NewBlockerInput): { ok: true; blocker: Blocker; duplicate: boolean } | { ok: false; error: string } {
    const question = input.question.trim()
    if (!question) return { ok: false, error: 'question required' }
    if (!input.agentId.trim()) return { ok: false, error: 'agentId required' }
    const askedOf = input.askedOf.trim()
    if (!askedOf) return { ok: false, error: 'askedOf required — name who owes you the answer' }
    if (askedOf === input.agentId) return { ok: false, error: 'an employee cannot be blocked on itself' }

    const key = questionKey(question)
    const existing = this.items.find(
      (b) => b.status === 'open' && b.agentId === input.agentId && b.askedOf === askedOf && questionKey(b.question) === key
    )
    if (existing) {
      // Already asked. Say so rather than filing a second copy — and do not touch
      // createdAt, so the age keeps counting from the first ask.
      return { ok: true, blocker: existing, duplicate: true }
    }

    const openCount = this.openFor(input.agentId).length
    if (openCount >= MAX_OPEN_PER_AGENT) {
      return {
        ok: false,
        error: `${input.agentId} already has ${openCount} open questions (max ${MAX_OPEN_PER_AGENT}). ` +
          'Answer or withdraw one before asking another — past this point the problem is scope, not information.'
      }
    }

    const severity: BlockerSeverity = input.severity ?? 'blocking'
    const b: Blocker = {
      id: randomUUID(),
      agentId: input.agentId,
      askedOf,
      question,
      why: (input.why ?? '').trim(),
      severity,
      threadId: input.threadId ?? null,
      createdAt: Date.now(),
      status: 'open',
      suppressedRuns: 0,
      answeredAt: null,
      answeredBy: null,
      answer: '',
      deliveredAt: null
    }
    this.items.unshift(b)
    this.save()
    auditLog.note({
      action: 'blocker.raise',
      resource: `agent:${b.agentId}`,
      summary: `${b.agentId} is ${severity === 'blocking' ? 'blocked' : 'waiting'} on ${askedOf}: ${question.slice(0, 120)}`,
      after: b
    })
    console.log(`[blockers] ${b.agentId} → @${askedOf}: ${question.slice(0, 90)}`)
    return { ok: true, blocker: b, duplicate: false }
  }

  /** Records that an automatic wake-up was withheld because of this blocker. */
  countSuppressed(id: string): void {
    const b = this.get(id)
    if (!b) return
    b.suppressedRuns += 1
    // Not saved on every tick — the counter rides along with the next real write. It is
    // a diagnostic, not a ledger, and a disk write every 30s per blocked agent is worse.
  }

  answer(id: string, answer: string, answeredBy: string): { ok: true; blocker: Blocker } | { ok: false; error: string } {
    const b = this.get(id)
    if (!b) return { ok: false, error: 'unknown blocker' }
    if (b.status !== 'open') return { ok: false, error: `that question is already ${b.status}` }
    if (!answer.trim()) return { ok: false, error: 'an answer is required' }
    b.status = 'answered'
    b.answer = answer.trim()
    b.answeredBy = answeredBy
    b.answeredAt = Date.now()
    b.deliveredAt = null
    this.save()
    auditLog.note({
      action: 'blocker.answer',
      resource: `agent:${b.agentId}`,
      summary: `${answeredBy} answered ${b.agentId}: ${answer.slice(0, 120)}`,
      after: b
    })
    console.log(`[blockers] ${answeredBy} answered ${b.agentId} — ${b.question.slice(0, 60)}`)
    return { ok: true, blocker: b }
  }

  withdraw(id: string, by: string): { ok: true; blocker: Blocker } | { ok: false; error: string } {
    const b = this.get(id)
    if (!b) return { ok: false, error: 'unknown blocker' }
    if (b.status !== 'open') return { ok: false, error: `that question is already ${b.status}` }
    b.status = 'withdrawn'
    b.answeredBy = by
    b.answeredAt = Date.now()
    this.save()
    auditLog.note({
      action: 'blocker.withdraw',
      resource: `agent:${b.agentId}`,
      summary: `${by} withdrew ${b.agentId}'s question: ${b.question.slice(0, 120)}`,
      after: b
    })
    return { ok: true, blocker: b }
  }

  /**
   * Expires anything that has waited too long. An unanswered question must not hold an
   * employee off work forever — after this the agent resumes, and the expiry is on the
   * record so the desk can see the question was never answered.
   */
  expireStale(now = Date.now()): Blocker[] {
    const expired: Blocker[] = []
    for (const b of this.items) {
      if (b.status !== 'open') continue
      if (now - b.createdAt < BLOCKER_EXPIRY_MS) continue
      b.status = 'expired'
      b.answeredAt = now
      expired.push(b)
      console.log(`[blockers] expired unanswered after 48h — ${b.agentId} → @${b.askedOf}: ${b.question.slice(0, 60)}`)
    }
    if (expired.length) this.save()
    return expired
  }

  /** Closes out an employee's questions when they leave. */
  releaseAgent(agentId: string): void {
    let touched = false
    for (const b of this.items) {
      if (b.status !== 'open') continue
      if (b.agentId !== agentId && b.askedOf !== agentId) continue
      b.status = 'withdrawn'
      b.answeredBy = 'system'
      b.answeredAt = Date.now()
      touched = true
    }
    if (touched) this.save()
  }

  /** Compact rendering for an agent's system prompt. */
  promptFor(agentId: string): string {
    const lines: string[] = []
    const mine = this.openFor(agentId)
    if (mine.length) {
      lines.push('YOU ARE WAITING ON AN ANSWER. Do NOT ask these again, do not post a reminder,')
      lines.push('and do not rephrase them as a new question. They are already on the record:')
      for (const b of mine) {
        const hrs = Math.floor((Date.now() - b.createdAt) / 3_600_000)
        lines.push(`  [${b.severity}] asked @${b.askedOf} ${hrs}h ago: ${b.question}`)
      }
    }
    const owed = this.openAskedOf(agentId)
    if (owed.length) {
      lines.push('', 'COLLEAGUES ARE BLOCKED WAITING ON YOU. Answering these outranks new work:')
      for (const b of owed) {
        const hrs = Math.floor((Date.now() - b.createdAt) / 3_600_000)
        lines.push(`  [${b.id}] @${b.agentId} asked ${hrs}h ago: ${b.question}${b.why ? ` (needs it to: ${b.why})` : ''}`)
      }
    }
    return lines.join('\n')
  }
}

export const blockerBoard = new BlockerBoard()
