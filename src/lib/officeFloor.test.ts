import { describe, it, expect } from 'vitest'
import {
  activityPose, deskPose, floorConversations, floorWalkers, corkboardSlips,
  arcPath, deskAnchor, deskTopAnchor, walkerStop, poseHint,
  CONVERSATION_WINDOW_MS, MAX_FLOOR_CONVERSATIONS,
} from './officeFloor'
import type { AgentView, CryptoAgent, AgentRun } from '../../shared/agents'
import type { Blocker } from '../../shared/blockers'
import { OPERATOR_ID } from '../../shared/blockers'
import type { BoardThread, BoardMessage } from '../../shared/office'

const NOW = 1_760_000_000_000

function agent(over: Partial<CryptoAgent> = {}): CryptoAgent {
  return {
    id: 'oracle', name: 'Oracle', mandate: '', model: '', autonomy: 'advisory',
    maxUsd: 20, enabled: true, intervalMinutes: 15, events: [], drawdownPct: 8,
    cooldownMinutes: 15, idleStanddownMinutes: 45, createdAt: 0, updatedAt: 0,
    ...over,
  }
}

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'r1', agentId: 'oracle', trigger: 'interval', startedAt: NOW - 5_000,
    endedAt: null, state: 'running', activity: '', summary: '', error: null,
    decisions: [], ...over,
  }
}

function view(over: Partial<AgentView> = {}): AgentView {
  return {
    agent: agent(), status: null, recentRuns: [], decisions: [], transcript: [],
    nextRunAt: null, chatUsage: null, totals: null, blockers: [], stoodDown: false,
    ...over,
  }
}

function blocker(over: Partial<Blocker> = {}): Blocker {
  return {
    id: 'b1', agentId: 'oracle', askedOf: 'keel', question: 'What is the fee floor?',
    why: 'cannot size the trade', severity: 'blocking', threadId: null,
    createdAt: NOW - 60_000, status: 'open', suppressedRuns: 0,
    answeredAt: null, answeredBy: null, answer: '', deliveredAt: null,
    ...over,
  }
}

function msg(over: Partial<BoardMessage> = {}): BoardMessage {
  return { id: 'm1', authorId: 'gate', at: NOW - 30_000, body: 'hello', mentions: [], ...over }
}

function thread(over: Partial<BoardThread> = {}): BoardThread {
  return {
    id: 't1', title: 'Fee floor', authorId: 'gate', createdAt: NOW - 120_000,
    updatedAt: NOW - 30_000, tags: [], resolved: false, messages: [], ...over,
  }
}

// ── A · the seated crew ─────────────────────────────────────────────────────

describe('activityPose', () => {
  it('reads a fetching/scanning activity as the reading pose', () => {
    expect(activityPose('reading the snapshot')).toBe('read')
    expect(activityPose('scanning open positions')).toBe('read')
    expect(activityPose('reviewing the closed-trade ledger')).toBe('read')
    expect(activityPose('fetching candles')).toBe('read')
  })

  it('reads a composing activity as the writing pose', () => {
    expect(activityPose('writing the report')).toBe('write')
    expect(activityPose('drafting a journal entry')).toBe('write')
    expect(activityPose('composing a board reply')).toBe('write')
    expect(activityPose('summarizing the run')).toBe('write')
  })

  it('prefers writing when an activity mentions both — writing a review is writing', () => {
    expect(activityPose('writing a review of the ledger')).toBe('write')
  })

  it('falls back to typing when the activity says nothing recognizable', () => {
    expect(activityPose('')).toBe('type')
    expect(activityPose('thinking')).toBe('type')
    expect(activityPose('running…')).toBe('type')
  })

  it('is case-insensitive, because activity strings are free text', () => {
    expect(activityPose('READING the tape')).toBe('read')
  })
})

describe('deskPose', () => {
  it('seats a live run at the keyboard, posed by what it is doing', () => {
    expect(deskPose(view({ status: run({ activity: 'writing the report' }) }))).toBe('write')
    expect(deskPose(view({ status: run({ activity: 'reading the snapshot' }) }))).toBe('read')
    expect(deskPose(view({ status: run({ activity: '' }) }))).toBe('type')
  })

  it('shows a live manual run even on a disabled agent — someone is at that desk', () => {
    const v = view({ agent: agent({ enabled: false }), status: run({ activity: 'reading' }) })
    expect(deskPose(v)).toBe('read')
  })

  it('empties the chair when the agent is off duty', () => {
    expect(deskPose(view({ agent: agent({ enabled: false }) }))).toBe('off')
  })

  it('ignores a finished run — a done run is not somebody sitting there', () => {
    const v = view({ status: run({ state: 'done', endedAt: NOW - 1_000, activity: 'writing' }) })
    expect(deskPose(v)).toBe('idle')
  })

  it('ignores an errored run the same way', () => {
    const v = view({ status: run({ state: 'error', endedAt: NOW, activity: 'writing' }) })
    expect(deskPose(v)).toBe('idle')
  })

  it('walks the agent away when it is blocked on a colleague', () => {
    const v = view({ blockers: [blocker({ askedOf: 'keel' })] })
    expect(deskPose(v, { floorIds: ['oracle', 'keel'] })).toBe('away')
  })

  it('keeps them seated and waiting when the question is for the operator', () => {
    const v = view({ blockers: [blocker({ askedOf: OPERATOR_ID })] })
    expect(deskPose(v, { floorIds: ['oracle'] })).toBe('wait')
  })

  it('keeps them seated when the colleague they asked has no desk on this floor', () => {
    const v = view({ blockers: [blocker({ askedOf: 'ghost' })] })
    expect(deskPose(v, { floorIds: ['oracle', 'keel'] })).toBe('wait')
  })

  it('does not walk off for a non-blocking question — that one keeps working', () => {
    const v = view({ blockers: [blocker({ severity: 'waiting' })] })
    expect(deskPose(v, { floorIds: ['oracle', 'keel'] })).toBe('idle')
  })

  it('does not walk off for an answered or withdrawn question', () => {
    expect(deskPose(view({ blockers: [blocker({ status: 'answered' })] }), { floorIds: ['oracle', 'keel'] })).toBe('idle')
    expect(deskPose(view({ blockers: [blocker({ status: 'withdrawn' })] }), { floorIds: ['oracle', 'keel'] })).toBe('idle')
    expect(deskPose(view({ blockers: [blocker({ status: 'expired' })] }), { floorIds: ['oracle', 'keel'] })).toBe('idle')
  })

  it('lets a live run outrank a blocker — if it is running it is at the desk, not in the corridor', () => {
    const v = view({ blockers: [blocker()], status: run({ activity: 'reading' }) })
    expect(deskPose(v, { floorIds: ['oracle', 'keel'] })).toBe('read')
  })

  it('sits an enabled idle agent quietly in the chair', () => {
    expect(deskPose(view())).toBe('idle')
  })

  it('gives every pose a human-readable hint for the tooltip', () => {
    for (const p of ['type', 'read', 'write', 'idle', 'wait', 'away', 'off'] as const) {
      expect(poseHint(p)).toMatch(/\S/)
    }
  })
})

// ── B · speech threads ──────────────────────────────────────────────────────

describe('floorConversations', () => {
  const floorIds = ['gate', 'keel', 'oracle']

  it('turns a fresh @mention into a line from author to mentioned', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['keel'], body: '@keel exposure check?' })] })
    const conv = floorConversations([t], { now: NOW, floorIds })
    expect(conv).toHaveLength(1)
    expect(conv[0]!.fromId).toBe('gate')
    expect(conv[0]!.toId).toBe('keel')
    expect(conv[0]!.threadId).toBe('t1')
  })

  it('draws one line per mentioned colleague when a message tags several', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['keel', 'oracle'] })] })
    expect(floorConversations([t], { now: NOW, floorIds }).map((c) => c.toId).sort()).toEqual(['keel', 'oracle'])
  })

  it('gives each of those lines its own id — they are separate elements on the floor', () => {
    // A message tagging four colleagues used to yield four conversations sharing one id,
    // which React rejects as a duplicate key and is free to drop.
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['keel', 'oracle', 'manager'] })] })
    const ids = floorConversations([t], { now: NOW, floorIds }).map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('drops mentions of colleagues with no desk on this floor — nothing to draw a line to', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['ghost'] })] })
    expect(floorConversations([t], { now: NOW, floorIds })).toEqual([])
  })

  it('drops a message whose author is not on the floor, like the operator', () => {
    const t = thread({ messages: [msg({ authorId: OPERATOR_ID, mentions: ['keel'] })] })
    expect(floorConversations([t], { now: NOW, floorIds })).toEqual([])
  })

  it('ignores a self-mention — nobody talks to their own desk', () => {
    const t = thread({ messages: [msg({ authorId: 'keel', mentions: ['keel'] })] })
    expect(floorConversations([t], { now: NOW, floorIds })).toEqual([])
  })

  it('forgets exchanges older than the conversation window', () => {
    const t = thread({
      messages: [msg({ at: NOW - CONVERSATION_WINDOW_MS - 1, authorId: 'gate', mentions: ['keel'] })],
    })
    expect(floorConversations([t], { now: NOW, floorIds })).toEqual([])
  })

  it('keeps an exchange right at the edge of the window', () => {
    const t = thread({ messages: [msg({ at: NOW - CONVERSATION_WINDOW_MS + 1, authorId: 'gate', mentions: ['keel'] })] })
    expect(floorConversations([t], { now: NOW, floorIds })).toHaveLength(1)
  })

  it('reads a reply back to someone who tagged you first as an answer, not a question', () => {
    const t = thread({
      messages: [
        msg({ id: 'm1', at: NOW - 60_000, authorId: 'gate', mentions: ['keel'], body: '@keel exposure check?' }),
        msg({ id: 'm2', at: NOW - 10_000, authorId: 'keel', mentions: ['gate'], body: '@gate 4.1% — fine' }),
      ],
    })
    const conv = floorConversations([t], { now: NOW, floorIds })
    const byId = Object.fromEntries(conv.map((c) => [c.id, c]))
    expect(byId['t1:m1:keel']!.kind).toBe('question')
    expect(byId['t1:m2:gate']!.kind).toBe('answer')
  })

  it('carries a trimmed excerpt so a bubble never renders a wall of text', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['keel'], body: '  ' + 'x'.repeat(200) + '  ' })] })
    const c = floorConversations([t], { now: NOW, floorIds })[0]!
    expect(c.text.length).toBeLessThanOrEqual(48)
    expect(c.text.endsWith('…')).toBe(true)
  })

  it('collapses newlines in the excerpt — bubbles are one line', () => {
    const t = thread({ messages: [msg({ authorId: 'gate', mentions: ['keel'], body: 'one\n\ntwo' })] })
    expect(floorConversations([t], { now: NOW, floorIds })[0]!.text).toBe('one two')
  })

  it('returns the newest exchanges first', () => {
    const t = thread({
      messages: [
        msg({ id: 'old', at: NOW - 120_000, authorId: 'gate', mentions: ['keel'] }),
        msg({ id: 'new', at: NOW - 5_000, authorId: 'oracle', mentions: ['keel'] }),
      ],
    })
    expect(floorConversations([t], { now: NOW, floorIds })[0]!.id).toBe('t1:new:keel')
  })

  it('caps how many lines cross the floor at once, so it never becomes spaghetti', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      thread({ id: `t${i}`, messages: [msg({ id: `m${i}`, at: NOW - i * 1_000, authorId: 'gate', mentions: ['keel'] })] }))
    expect(floorConversations(many, { now: NOW, floorIds })).toHaveLength(MAX_FLOOR_CONVERSATIONS)
  })

  it('skips resolved threads — a settled conversation is not still happening', () => {
    const t = thread({ resolved: true, messages: [msg({ authorId: 'gate', mentions: ['keel'] })] })
    expect(floorConversations([t], { now: NOW, floorIds })).toEqual([])
  })
})

// ── C · the walker ──────────────────────────────────────────────────────────

describe('floorWalkers', () => {
  const floorIds = ['oracle', 'keel', 'gate']

  it('sends the blocked agent to the desk of whoever owes the answer', () => {
    const w = floorWalkers([blocker({ agentId: 'oracle', askedOf: 'keel' })], { floorIds })
    expect(w).toHaveLength(1)
    expect(w[0]!.fromId).toBe('oracle')
    expect(w[0]!.toId).toBe('keel')
    expect(w[0]!.question).toBe('What is the fee floor?')
  })

  it('never sends a walker to the operator — you are not on the floor', () => {
    expect(floorWalkers([blocker({ askedOf: OPERATOR_ID })], { floorIds })).toEqual([])
  })

  it('never sends a walker to a colleague with no desk here', () => {
    expect(floorWalkers([blocker({ askedOf: 'ghost' })], { floorIds })).toEqual([])
  })

  it('only walks for a blocking question — a waiting one keeps working at its own desk', () => {
    expect(floorWalkers([blocker({ severity: 'waiting' })], { floorIds })).toEqual([])
  })

  it('only walks while the question is still open', () => {
    expect(floorWalkers([blocker({ status: 'answered' })], { floorIds })).toEqual([])
    expect(floorWalkers([blocker({ status: 'expired' })], { floorIds })).toEqual([])
  })

  it('sends one walker per agent — the oldest question is what they are actually stuck on', () => {
    const w = floorWalkers([
      blocker({ id: 'new', createdAt: NOW - 10_000, agentId: 'oracle', askedOf: 'gate' }),
      blocker({ id: 'old', createdAt: NOW - 900_000, agentId: 'oracle', askedOf: 'keel' }),
    ], { floorIds })
    expect(w).toHaveLength(1)
    expect(w[0]!.blockerId).toBe('old')
    expect(w[0]!.toId).toBe('keel')
  })

  it('queues several petitioners at one desk, longest-waiting at the front', () => {
    const w = floorWalkers([
      blocker({ id: 'b2', agentId: 'gate', askedOf: 'keel', createdAt: NOW - 20_000 }),
      blocker({ id: 'b1', agentId: 'oracle', askedOf: 'keel', createdAt: NOW - 600_000 }),
    ], { floorIds })
    expect(w.map((x) => x.fromId)).toEqual(['oracle', 'gate'])
    expect(w.map((x) => x.queueIndex)).toEqual([0, 1])
  })

  it('queues independently per target desk', () => {
    const w = floorWalkers([
      blocker({ id: 'b1', agentId: 'oracle', askedOf: 'keel' }),
      blocker({ id: 'b2', agentId: 'gate', askedOf: 'oracle' }),
    ], { floorIds })
    expect(w.every((x) => x.queueIndex === 0)).toBe(true)
  })

  it('ignores a blocker raised by an agent with no desk on the floor', () => {
    expect(floorWalkers([blocker({ agentId: 'ghost', askedOf: 'keel' })], { floorIds })).toEqual([])
  })
})

// ── D · the corkboard ───────────────────────────────────────────────────────

describe('corkboardSlips', () => {
  it('pins only unresolved threads — a resolved one comes off the board', () => {
    const slips = corkboardSlips([
      thread({ id: 'open', resolved: false }),
      thread({ id: 'done', resolved: true }),
    ], { now: NOW })
    expect(slips.map((s) => s.threadId)).toEqual(['open'])
  })

  it('marks a thread touched in the last hour as fresh', () => {
    expect(corkboardSlips([thread({ updatedAt: NOW - 60_000 })], { now: NOW })[0]!.tone).toBe('fresh')
  })

  it('marks a thread from earlier today as simply open', () => {
    expect(corkboardSlips([thread({ updatedAt: NOW - 5 * 3_600_000 })], { now: NOW })[0]!.tone).toBe('open')
  })

  it('marks a thread nobody has touched in a day as stale', () => {
    expect(corkboardSlips([thread({ updatedAt: NOW - 40 * 3_600_000 })], { now: NOW })[0]!.tone).toBe('stale')
  })

  it('pins the most recently updated thread first', () => {
    const slips = corkboardSlips([
      thread({ id: 'a', updatedAt: NOW - 500_000 }),
      thread({ id: 'b', updatedAt: NOW - 1_000 }),
    ], { now: NOW })
    expect(slips.map((s) => s.threadId)).toEqual(['b', 'a'])
  })

  it('caps the pins so the corkboard never overflows its frame', () => {
    const many = Array.from({ length: 20 }, (_, i) => thread({ id: `t${i}`, updatedAt: NOW - i }))
    expect(corkboardSlips(many, { now: NOW, limit: 5 })).toHaveLength(5)
  })

  it('carries the title and author so the slip is worth hovering', () => {
    const s = corkboardSlips([thread({ title: 'Fee floor', authorId: 'gate' })], { now: NOW })[0]!
    expect(s.title).toBe('Fee floor')
    expect(s.authorId).toBe('gate')
  })
})

// ── geometry ────────────────────────────────────────────────────────────────

describe('deskAnchor', () => {
  it('anchors at the chair — horizontal centre, floor level of the desk tile', () => {
    const rect = { left: 100, top: 50, width: 200, height: 120 }
    const container = { left: 20, top: 10 }
    expect(deskAnchor(rect, container)).toEqual({ x: 180, y: 160 })
  })

  it('is relative to the container, so scrolling the floor does not offset the lines', () => {
    const rect = { left: 100, top: 50, width: 100, height: 100 }
    expect(deskAnchor(rect, { left: 100, top: 50 })).toEqual({ x: 50, y: 100 })
  })
})

describe('deskTopAnchor', () => {
  it('anchors at the top edge, centred — where a speech bubble clears the desk tile', () => {
    const rect = { left: 100, top: 50, width: 200, height: 120 }
    expect(deskTopAnchor(rect, { left: 20, top: 10 })).toEqual({ x: 180, y: 40 })
  })

  it('sits above the floor anchor for the same desk, never below it', () => {
    const rect = { left: 0, top: 0, width: 100, height: 80 }
    const container = { left: 0, top: 0 }
    expect(deskTopAnchor(rect, container).y).toBeLessThan(deskAnchor(rect, container).y)
  })

  it('shares the floor anchor’s horizontal centre, so speech and walking line up', () => {
    const rect = { left: 40, top: 10, width: 60, height: 90 }
    const container = { left: 5, top: 5 }
    expect(deskTopAnchor(rect, container).x).toBe(deskAnchor(rect, container).x)
  })
})

describe('arcPath', () => {
  it('arcs above the two desks it connects', () => {
    expect(arcPath({ x: 0, y: 100 }, { x: 200, y: 100 }, 40)).toBe('M0,100 Q100,60 200,100')
  })

  it('lifts from the higher of the two endpoints so the arc never cuts through a desk', () => {
    expect(arcPath({ x: 0, y: 100 }, { x: 100, y: 20 }, 10)).toBe('M0,100 Q50,10 100,20')
  })

  it('rounds to whole pixels — sub-pixel path data helps nobody', () => {
    expect(arcPath({ x: 0.4, y: 100.6 }, { x: 99.5, y: 100.2 }, 10)).toBe('M0,101 Q50,90 100,100')
  })
})

describe('walkerStop', () => {
  it('stands the first petitioner just to the left of the desk they are visiting', () => {
    expect(walkerStop({ x: 200, y: 300 }, 0)).toEqual({ x: 156, y: 300 })
  })

  it('lines later petitioners up behind the first', () => {
    const a = walkerStop({ x: 200, y: 300 }, 0)
    const b = walkerStop({ x: 200, y: 300 }, 1)
    expect(b.x).toBeLessThan(a.x)
    expect(b.y).toBe(a.y)
  })
})
