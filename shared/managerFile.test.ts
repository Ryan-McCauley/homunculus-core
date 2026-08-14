import { describe, it, expect } from 'vitest'
import type { BoardMessage, BoardThread, PersonnelRecord } from './office'
import type { Blocker } from './blockers'
import {
  MAX_ASSIGNED_PER_AGENT, answerItem, assignItem, assignmentBlock, blockerKey, closeItem,
  collectBlockerItems, collectMentionItems, deskManagerId, managerDigest, markAssignmentsDelivered,
  mentionKey, mentionWakeDue, mergeIntoFile, openItems, pendingAssignments,
  type ManagerFileItem
} from './managerFile'

// ── fixtures ───────────────────────────────────────────────────────────────

function msg(over: Partial<BoardMessage> = {}): BoardMessage {
  return { id: 'm1', authorId: 'gate', at: 1_000, body: 'hello', mentions: [], ...over }
}

function thread(over: Partial<BoardThread> = {}): BoardThread {
  return {
    id: 't1', title: 'Desk kickoff', authorId: 'operator', createdAt: 1_000, updatedAt: 1_000,
    tags: [], resolved: false, messages: [msg()], ...over
  }
}

function blocker(over: Partial<Blocker> = {}): Blocker {
  return {
    id: 'b1', agentId: 'keel', askedOf: 'manager', question: 'Close XRP or hold?', why: 'sizing',
    severity: 'blocking', threadId: null, createdAt: 2_000, status: 'open', suppressedRuns: 0,
    answeredAt: null, answeredBy: null, answer: '', deliveredAt: null, ...over
  }
}

function person(over: Partial<PersonnelRecord> = {}): PersonnelRecord {
  return {
    agentId: 'gate', employeeId: 'EMP-003', title: 'Gate', department: 'operations',
    status: 'active', hiredAt: 0, reportsTo: 'manager',
    resume: { summary: '', specialties: [], background: [], credentials: [] },
    jobDescription: { responsibilities: [], kpis: [] },
    sources: [], notes: '', updatedAt: 0, ...over
  }
}

function item(over: Partial<ManagerFileItem> = {}): ManagerFileItem {
  return {
    id: 'mention:t1:m1', kind: 'mention', fromId: 'gate', namedIds: ['keel'],
    threadId: 't1', threadTitle: 'Desk kickoff', messageId: 'm1', blockerId: null,
    at: 1_000, filedAt: 1_000, excerpt: 'hello', status: 'new',
    assignedTo: null, assignedAt: null, instruction: '', deliveredAt: null,
    answeredBy: null, answeredAt: null, answer: '', closedAt: null, closedReason: null,
    note: '', ...over
  }
}

const OPTS = { managerId: 'manager', knownIds: ['manager', 'gate', 'keel', 'oracle', 'warden'], now: 9_000 }

// ── deskManagerId ──────────────────────────────────────────────────────────

describe('deskManagerId', () => {
  it('picks the active executive who reports to nobody', () => {
    const roster = [
      person(),
      person({ agentId: 'manager', employeeId: 'EMP-001', department: 'executive', reportsTo: null })
    ]
    expect(deskManagerId(roster)).toBe('manager')
  })

  it('ignores a terminated executive', () => {
    const roster = [
      person({ agentId: 'old-boss', employeeId: 'EMP-000', department: 'executive', reportsTo: null, status: 'terminated' }),
      person({ agentId: 'manager', employeeId: 'EMP-001', department: 'executive', reportsTo: null })
    ]
    expect(deskManagerId(roster)).toBe('manager')
  })

  it('breaks a tie on the lowest employee id, so the answer never depends on read order', () => {
    const roster = [
      person({ agentId: 'second', employeeId: 'EMP-004', department: 'executive', reportsTo: null }),
      person({ agentId: 'first', employeeId: 'EMP-002', department: 'executive', reportsTo: null })
    ]
    expect(deskManagerId(roster)).toBe('first')
  })

  it('falls back to whoever the most people report to when there is no executive', () => {
    const roster = [
      person({ agentId: 'a', reportsTo: 'lead' }),
      person({ agentId: 'b', reportsTo: 'lead' }),
      person({ agentId: 'lead', employeeId: 'EMP-009', reportsTo: null })
    ]
    expect(deskManagerId(roster)).toBe('lead')
  })

  it('returns null for an empty roster rather than inventing a manager', () => {
    expect(deskManagerId([])).toBeNull()
  })

  it('never returns a manager who is not on the roster', () => {
    const roster = [person({ agentId: 'a', reportsTo: 'ghost' })]
    expect(deskManagerId(roster)).toBeNull()
  })
})

// ── collectMentionItems ────────────────────────────────────────────────────

describe('collectMentionItems', () => {
  it('files one item per message, however many colleagues it tags', () => {
    const t = thread({ messages: [msg({ mentions: ['keel', 'oracle', 'warden', 'manager'] })] })
    const out = collectMentionItems([t], OPTS)
    expect(out).toHaveLength(1)
    expect(out[0]?.namedIds).toEqual(['keel', 'oracle', 'warden', 'manager'])
  })

  it('uses a stable id derived from thread and message, so a re-scan does not duplicate', () => {
    const t = thread({ messages: [msg({ mentions: ['keel'] })] })
    expect(collectMentionItems([t], OPTS)[0]?.id).toBe(mentionKey('t1', 'm1'))
    expect(collectMentionItems([t], OPTS)[0]?.id).toBe(collectMentionItems([t], OPTS)[0]?.id)
  })

  it('skips resolved threads', () => {
    const t = thread({ resolved: true, messages: [msg({ mentions: ['keel'] })] })
    expect(collectMentionItems([t], OPTS)).toEqual([])
  })

  it('skips messages that tag nobody', () => {
    expect(collectMentionItems([thread()], OPTS)).toEqual([])
  })

  it('skips a message the manager wrote — that is a dispatch, not a question for the file', () => {
    const t = thread({ messages: [msg({ authorId: 'manager', mentions: ['keel', 'oracle'] })] })
    expect(collectMentionItems([t], OPTS)).toEqual([])
  })

  it('drops a self-mention so an agent tagging itself cannot file work against itself', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['gate', 'keel'] })] })
    expect(collectMentionItems([t], OPTS)[0]?.namedIds).toEqual(['keel'])
  })

  it('files nothing when the only tag is the author themselves', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['gate'] })] })
    expect(collectMentionItems([t], OPTS)).toEqual([])
  })

  it('drops a message every named colleague has already replied to', () => {
    const t = thread({
      messages: [
        msg({ id: 'm1', authorId: 'gate', at: 1_000, mentions: ['keel'] }),
        msg({ id: 'm2', authorId: 'keel', at: 2_000 })
      ]
    })
    expect(collectMentionItems([t], OPTS)).toEqual([])
  })

  it('keeps a message when only some of the named colleagues have replied', () => {
    const t = thread({
      messages: [
        msg({ id: 'm1', authorId: 'gate', at: 1_000, mentions: ['keel', 'oracle'] }),
        msg({ id: 'm2', authorId: 'keel', at: 2_000 })
      ]
    })
    expect(collectMentionItems([t], OPTS)).toHaveLength(1)
  })

  it('ignores a reply that predates the mention', () => {
    const t = thread({
      messages: [
        msg({ id: 'm0', authorId: 'keel', at: 500 }),
        msg({ id: 'm1', authorId: 'gate', at: 1_000, mentions: ['keel'] })
      ]
    })
    expect(collectMentionItems([t], OPTS)).toHaveLength(1)
  })

  it('keeps an operator tag outstanding — only the human can clear it', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['operator'] })] })
    const out = collectMentionItems([t], OPTS)
    expect(out).toHaveLength(1)
    expect(out[0]?.namedIds).toEqual(['operator'])
  })

  it('carries the thread title and a trimmed excerpt for triage', () => {
    const t = thread({ title: 'Fee floor', messages: [msg({ mentions: ['keel'], body: 'x'.repeat(500) })] })
    const out = collectMentionItems([t], OPTS)[0]
    expect(out?.threadTitle).toBe('Fee floor')
    expect(out?.excerpt.length).toBeLessThanOrEqual(240)
  })

  it('stamps filedAt from now but keeps at as the message time, so age and novelty differ', () => {
    const t = thread({ messages: [msg({ at: 1_000, mentions: ['keel'] })] })
    const out = collectMentionItems([t], OPTS)[0]
    expect(out?.at).toBe(1_000)
    expect(out?.filedAt).toBe(9_000)
  })
})

// ── collectBlockerItems ────────────────────────────────────────────────────

describe('collectBlockerItems', () => {
  it('files open blockers as questions owned by whoever was asked', () => {
    const out = collectBlockerItems([blocker()], OPTS)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'blocker', fromId: 'keel', namedIds: ['manager'], blockerId: 'b1' })
  })

  it('uses a stable id derived from the blocker id', () => {
    expect(collectBlockerItems([blocker()], OPTS)[0]?.id).toBe(blockerKey('b1'))
  })

  it('ignores blockers that are no longer open', () => {
    expect(collectBlockerItems([blocker({ status: 'answered' })], OPTS)).toEqual([])
    expect(collectBlockerItems([blocker({ status: 'expired' })], OPTS)).toEqual([])
  })

  it('keeps the question as the excerpt so the file reads as a list of decisions', () => {
    expect(collectBlockerItems([blocker()], OPTS)[0]?.excerpt).toContain('Close XRP or hold?')
  })
})

// ── mergeIntoFile ──────────────────────────────────────────────────────────

describe('mergeIntoFile', () => {
  it('adds items that are not on file yet', () => {
    const out = mergeIntoFile([], [item()], 9_000)
    expect(out).toHaveLength(1)
    expect(out[0]?.status).toBe('new')
  })

  it('never mutates the array it was given', () => {
    const existing = [item()]
    const frozen = JSON.stringify(existing)
    mergeIntoFile(existing, [item({ id: 'mention:t1:m2' })], 9_000)
    expect(JSON.stringify(existing)).toBe(frozen)
  })

  it('preserves triage state when the same item is seen again', () => {
    const existing = [item({ status: 'assigned', assignedTo: 'keel', instruction: 'answer this', assignedAt: 5_000 })]
    const out = mergeIntoFile(existing, [item()], 9_000)
    expect(out[0]).toMatchObject({ status: 'assigned', assignedTo: 'keel', instruction: 'answer this' })
  })

  it('keeps the original filedAt so a re-scan cannot make an old item look new', () => {
    const existing = [item({ filedAt: 1_000 })]
    const out = mergeIntoFile(existing, [item({ filedAt: 9_000 })], 9_000)
    expect(out[0]?.filedAt).toBe(1_000)
  })

  it('closes an item whose source has gone away — the colleague replied, so the ask is moot', () => {
    const existing = [item({ status: 'assigned', assignedTo: 'keel' })]
    const out = mergeIntoFile(existing, [], 9_000)
    expect(out[0]).toMatchObject({ status: 'closed', closedAt: 9_000, closedReason: 'resolved-at-source' })
  })

  it('leaves an already-closed item alone rather than restamping it', () => {
    const existing = [item({ status: 'closed', closedAt: 4_000, closedReason: 'manager' })]
    const out = mergeIntoFile(existing, [], 9_000)
    expect(out[0]).toMatchObject({ closedAt: 4_000, closedReason: 'manager' })
  })

  it('does not resurrect a closed item when its source reappears', () => {
    const existing = [item({ status: 'closed', closedAt: 4_000, closedReason: 'manager' })]
    const out = mergeIntoFile(existing, [item()], 9_000)
    expect(out[0]?.status).toBe('closed')
    expect(out).toHaveLength(1)
  })

  it('sorts open work ahead of closed, oldest first within each group', () => {
    const out = mergeIntoFile(
      [
        item({ id: 'c', status: 'closed', at: 1_000 }),
        item({ id: 'b', at: 3_000 }),
        item({ id: 'a', at: 2_000 })
      ],
      [item({ id: 'b', at: 3_000 }), item({ id: 'a', at: 2_000 })],
      9_000
    )
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

// ── assignItem ─────────────────────────────────────────────────────────────

describe('assignItem', () => {
  it('assigns an item and records the instruction', () => {
    const r = assignItem([item()], { id: 'mention:t1:m1', to: 'keel', instruction: 'Give the stop number', now: 9_000 })
    expect(r.ok).toBe(true)
    expect(r.ok && r.items[0]).toMatchObject({
      status: 'assigned', assignedTo: 'keel', assignedAt: 9_000, instruction: 'Give the stop number', deliveredAt: null
    })
  })

  it('refuses an unknown item', () => {
    const r = assignItem([item()], { id: 'nope', to: 'keel', instruction: 'x', now: 9_000 })
    expect(r).toMatchObject({ ok: false })
  })

  it('refuses to assign a closed item', () => {
    const r = assignItem([item({ status: 'closed' })], { id: 'mention:t1:m1', to: 'keel', instruction: 'x', now: 9_000 })
    expect(r).toMatchObject({ ok: false })
  })

  it('requires an assignee', () => {
    expect(assignItem([item()], { id: 'mention:t1:m1', to: '  ', instruction: 'x', now: 9_000 }).ok).toBe(false)
  })

  it('requires an instruction — an assignment with no ask is just another mention', () => {
    expect(assignItem([item()], { id: 'mention:t1:m1', to: 'keel', instruction: '   ', now: 9_000 }).ok).toBe(false)
  })

  it('reassigning to someone else re-arms delivery, so the new owner is actually told', () => {
    const start = [item({ status: 'assigned', assignedTo: 'oracle', deliveredAt: 6_000 })]
    const r = assignItem(start, { id: 'mention:t1:m1', to: 'keel', instruction: 'you take it', now: 9_000 })
    expect(r.ok && r.items[0]).toMatchObject({ assignedTo: 'keel', deliveredAt: null })
  })

  it('caps how much one agent can be holding at once', () => {
    const items = Array.from({ length: MAX_ASSIGNED_PER_AGENT }, (_, i) =>
      item({ id: `mention:t1:m${i}`, status: 'assigned', assignedTo: 'keel', deliveredAt: 1 })
    )
    items.push(item({ id: 'mention:t1:extra' }))
    const r = assignItem(items, { id: 'mention:t1:extra', to: 'keel', instruction: 'one more', now: 9_000 })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/already holding/i)
  })

  it('does not count answered or closed work against the cap', () => {
    const items = [
      item({ id: 'a', status: 'answered', assignedTo: 'keel' }),
      item({ id: 'b', status: 'closed', assignedTo: 'keel' }),
      item({ id: 'c' })
    ]
    expect(assignItem(items, { id: 'c', to: 'keel', instruction: 'go', now: 9_000 }).ok).toBe(true)
  })

  it('never mutates the array it was given', () => {
    const items = [item()]
    const frozen = JSON.stringify(items)
    assignItem(items, { id: 'mention:t1:m1', to: 'keel', instruction: 'x', now: 9_000 })
    expect(JSON.stringify(items)).toBe(frozen)
  })
})

// ── answerItem / closeItem ─────────────────────────────────────────────────

describe('answerItem', () => {
  it('records the answer and who gave it', () => {
    const r = answerItem([item({ status: 'assigned', assignedTo: 'keel' })],
      { id: 'mention:t1:m1', answer: 'Hold. Beta is 1.08.', by: 'keel', now: 9_000 })
    expect(r.ok && r.items[0]).toMatchObject({
      status: 'answered', answer: 'Hold. Beta is 1.08.', answeredBy: 'keel', answeredAt: 9_000
    })
  })

  it('lets the manager answer an item nobody was assigned', () => {
    const r = answerItem([item()], { id: 'mention:t1:m1', answer: 'no action', by: 'manager', now: 9_000 })
    expect(r.ok).toBe(true)
  })

  it('requires an answer', () => {
    expect(answerItem([item()], { id: 'mention:t1:m1', answer: ' ', by: 'keel', now: 9_000 }).ok).toBe(false)
  })

  it('refuses to answer a closed item', () => {
    expect(answerItem([item({ status: 'closed' })], { id: 'mention:t1:m1', answer: 'x', by: 'keel', now: 9_000 }).ok).toBe(false)
  })
})

describe('closeItem', () => {
  it('closes an item and says who did it', () => {
    const r = closeItem([item()], { id: 'mention:t1:m1', by: 'manager', now: 9_000 })
    expect(r.ok && r.items[0]).toMatchObject({ status: 'closed', closedAt: 9_000, closedReason: 'manager' })
  })

  it('is idempotent — closing twice is not an error', () => {
    const once = closeItem([item()], { id: 'mention:t1:m1', by: 'manager', now: 9_000 })
    expect(once.ok).toBe(true)
    const twice = closeItem(once.ok ? once.items : [], { id: 'mention:t1:m1', by: 'manager', now: 12_000 })
    expect(twice.ok).toBe(true)
    expect(twice.ok && twice.items[0]?.closedAt).toBe(9_000)
  })
})

// ── delivery ───────────────────────────────────────────────────────────────

describe('pendingAssignments', () => {
  it('returns work assigned to this agent that has not been handed over yet', () => {
    const items = [
      item({ id: 'a', status: 'assigned', assignedTo: 'keel', deliveredAt: null }),
      item({ id: 'b', status: 'assigned', assignedTo: 'keel', deliveredAt: 5_000 }),
      item({ id: 'c', status: 'assigned', assignedTo: 'oracle', deliveredAt: null }),
      item({ id: 'd', status: 'new' })
    ]
    expect(pendingAssignments(items, 'keel').map((i) => i.id)).toEqual(['a'])
  })

  it('is empty for an agent with nothing assigned', () => {
    expect(pendingAssignments([item()], 'keel')).toEqual([])
  })

  it('oldest first, so the longest wait is worked first', () => {
    const items = [
      item({ id: 'new', status: 'assigned', assignedTo: 'keel', assignedAt: 8_000 }),
      item({ id: 'old', status: 'assigned', assignedTo: 'keel', assignedAt: 2_000 })
    ]
    expect(pendingAssignments(items, 'keel').map((i) => i.id)).toEqual(['old', 'new'])
  })
})

describe('markAssignmentsDelivered', () => {
  it('stamps delivery so one assignment wakes an agent exactly once', () => {
    const items = [item({ id: 'a', status: 'assigned', assignedTo: 'keel' })]
    const out = markAssignmentsDelivered(items, ['a'], 9_000)
    expect(out[0]?.deliveredAt).toBe(9_000)
    expect(pendingAssignments(out, 'keel')).toEqual([])
  })

  it('leaves an already-delivered stamp alone', () => {
    const items = [item({ id: 'a', status: 'assigned', assignedTo: 'keel', deliveredAt: 3_000 })]
    expect(markAssignmentsDelivered(items, ['a'], 9_000)[0]?.deliveredAt).toBe(3_000)
  })

  it('never mutates the array it was given', () => {
    const items = [item({ id: 'a', status: 'assigned', assignedTo: 'keel' })]
    const frozen = JSON.stringify(items)
    markAssignmentsDelivered(items, ['a'], 9_000)
    expect(JSON.stringify(items)).toBe(frozen)
  })
})

// ── wake edge ──────────────────────────────────────────────────────────────

describe('mentionWakeDue', () => {
  it('is true when something was filed since the last wake', () => {
    expect(mentionWakeDue([item({ filedAt: 5_000 })], 4_000)).toBe(true)
  })

  it('is false when the untriaged work is all older than the last wake — this is the edge that stops the loop', () => {
    expect(mentionWakeDue([item({ filedAt: 3_000 })], 4_000)).toBe(false)
  })

  it('ignores work that has already been triaged', () => {
    expect(mentionWakeDue([item({ filedAt: 5_000, status: 'assigned' })], 4_000)).toBe(false)
    expect(mentionWakeDue([item({ filedAt: 5_000, status: 'closed' })], 4_000)).toBe(false)
  })

  it('wakes on anything untriaged when the manager has never run', () => {
    expect(mentionWakeDue([item({ filedAt: 1 })], 0)).toBe(true)
  })

  it('is false for an empty file', () => {
    expect(mentionWakeDue([], 0)).toBe(false)
  })
})

// ── rendering ──────────────────────────────────────────────────────────────

describe('openItems', () => {
  it('is everything not closed', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', status: 'assigned' }), item({ id: 'c', status: 'closed' })]
    expect(openItems(items).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('managerDigest', () => {
  it('says the file is empty rather than rendering a bare heading', () => {
    expect(managerDigest([], { now: 9_000 })).toMatch(/empty/i)
  })

  it('lists untriaged work with its id, so the manager can assign it without guessing', () => {
    const out = managerDigest([item({ id: 'mention:t1:m1', fromId: 'gate', namedIds: ['keel'] })], { now: 9_000 })
    expect(out).toContain('mention:t1:m1')
    expect(out).toContain('@gate')
    expect(out).toContain('@keel')
  })

  it('separates work already out with someone from work still needing triage', () => {
    const out = managerDigest([
      item({ id: 'a' }),
      item({ id: 'b', status: 'assigned', assignedTo: 'keel', instruction: 'get the number' })
    ], { now: 9_000 })
    expect(out).toMatch(/NEEDS TRIAGE/i)
    expect(out).toMatch(/OUT WITH/i)
    expect(out).toContain('get the number')
  })

  it('shows answers that came back, because those are what the manager synthesizes', () => {
    const out = managerDigest([
      item({ id: 'a', status: 'answered', answeredBy: 'keel', answer: 'Hold, beta 1.08' })
    ], { now: 9_000 })
    expect(out).toMatch(/ANSWERED/i)
    expect(out).toContain('Hold, beta 1.08')
  })

  it('leaves closed items out of the prompt', () => {
    const out = managerDigest([item({ id: 'gone', status: 'closed' })], { now: 9_000 })
    expect(out).not.toContain('gone')
  })
})

describe('assignmentBlock', () => {
  it('is empty when nothing is assigned, so the prompt gains no dead section', () => {
    expect(assignmentBlock([])).toBe('')
  })

  it('states the instruction, the origin and how to answer', () => {
    const out = assignmentBlock([item({
      id: 'mention:t1:m1', fromId: 'gate', instruction: 'Give the stop number', excerpt: 'what is the stop?'
    })])
    expect(out).toContain('Give the stop number')
    expect(out).toContain('@gate')
    expect(out).toContain('mention:t1:m1')
  })
})
