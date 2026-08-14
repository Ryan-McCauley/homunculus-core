import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_OPEN_PER_AGENT, BLOCKER_EXPIRY_MS } from '../shared/blockers'
import type { NewBlockerInput } from '../shared/blockers'

// `blockerBoard` is a module-level singleton constructed at import time from
// stateStore.readJson. Every test gets a fresh instance (vi.resetModules +
// dynamic import) over a controllable fake backing store, following
// cryptoStrategySettings.test.ts's freshModule() pattern.

const store = vi.hoisted(() => ({ data: new Map<string, unknown>() }))
vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (store.data.has(file) ? store.data.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { store.data.set(file, value) }),
    deleteJson: vi.fn((file: string) => { store.data.delete(file) }),
  },
}))

const audit = vi.hoisted(() => ({ note: vi.fn(), record: vi.fn() }))
vi.mock('./auditLog', () => ({ auditLog: audit }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  store.data.clear()
})

async function freshBoard() {
  const mod = await import('./blockers')
  return mod.blockerBoard
}

const ask = (over: Partial<NewBlockerInput> = {}): NewBlockerInput => ({
  agentId: 'sniper',
  askedOf: 'operator',
  question: 'Should I raise the position cap?',
  ...over,
})

describe('raise — idempotency', () => {
  it('creates a new open blocker on first ask', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.duplicate).toBe(false)
    expect(res.blocker.status).toBe('open')
    expect(board.open()).toHaveLength(1)
  })

  it('returns the SAME blocker (marked duplicate) for the same agent asking the same person the same question again', async () => {
    const board = await freshBoard()
    const first = board.raise(ask())
    const second = board.raise(ask())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.duplicate).toBe(true)
    expect(second.blocker.id).toBe(first.blocker.id)
    expect(board.open()).toHaveLength(1) // no second copy filed
  })

  it('treats questions as duplicates after normalizing case/punctuation (questionKey)', async () => {
    const board = await freshBoard()
    board.raise(ask({ question: 'Should I raise the cap?' }))
    const second = board.raise(ask({ question: '  should i raise the cap  ' }))
    expect(second.ok && second.duplicate).toBe(true)
    expect(board.open()).toHaveLength(1)
  })

  it('does not touch createdAt on a duplicate ask — age keeps counting from the first ask', async () => {
    const board = await freshBoard()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const first = board.raise(ask())
    vi.setSystemTime(2_000_000)
    const second = board.raise(ask())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.blocker.createdAt).toBe(first.blocker.createdAt)
    vi.useRealTimers()
  })

  it('a different askedOf is a distinct blocker, not a duplicate', async () => {
    const board = await freshBoard()
    board.raise(ask({ askedOf: 'operator' }))
    const second = board.raise(ask({ askedOf: 'manager' }))
    expect(second.ok && second.duplicate).toBe(false)
    expect(board.open()).toHaveLength(2)
  })

  it('a different agentId asking the same question is a distinct blocker', async () => {
    const board = await freshBoard()
    board.raise(ask({ agentId: 'sniper' }))
    const second = board.raise(ask({ agentId: 'oracle' }))
    expect(second.ok && second.duplicate).toBe(false)
    expect(board.open()).toHaveLength(2)
  })

  it('a re-ask after the first was answered is NOT a duplicate (only open blockers dedupe)', async () => {
    const board = await freshBoard()
    const first = board.raise(ask())
    if (!first.ok) throw new Error('unreachable')
    board.answer(first.blocker.id, 'yes, go ahead', 'operator')
    const second = board.raise(ask())
    expect(second.ok && second.duplicate).toBe(false)
  })
})

describe('raise — validation', () => {
  it('rejects an empty question', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ question: '   ' }))
    expect(res.ok).toBe(false)
  })

  it('rejects a missing agentId', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ agentId: '' }))
    expect(res.ok).toBe(false)
  })

  it('rejects a missing askedOf', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ askedOf: '' }))
    expect(res.ok).toBe(false)
  })

  it('rejects an agent blocking on itself', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ agentId: 'sniper', askedOf: 'sniper' }))
    expect(res.ok).toBe(false)
  })

  it('rejects a new question once an agent already holds MAX_OPEN_PER_AGENT open blockers', async () => {
    const board = await freshBoard()
    for (let i = 0; i < MAX_OPEN_PER_AGENT; i++) {
      const res = board.raise(ask({ question: `question number ${i}` }))
      expect(res.ok).toBe(true)
    }
    const overflow = board.raise(ask({ question: 'one too many' }))
    expect(overflow.ok).toBe(false)
    expect(board.openFor('sniper')).toHaveLength(MAX_OPEN_PER_AGENT)
  })
})

describe('an open blocker suppresses the asker', () => {
  it('isBlocked returns the blocker when severity is "blocking" and it is open', async () => {
    const board = await freshBoard()
    board.raise(ask({ severity: 'blocking' }))
    expect(board.isBlocked('sniper')).not.toBeNull()
  })

  it('isBlocked returns null for a "waiting" (non-blocking) severity', async () => {
    const board = await freshBoard()
    board.raise(ask({ severity: 'waiting' }))
    expect(board.isBlocked('sniper')).toBeNull()
  })

  it('isBlocked returns null once the blocker is answered', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ severity: 'blocking' }))
    if (!res.ok) throw new Error('unreachable')
    board.answer(res.blocker.id, 'answered', 'operator')
    expect(board.isBlocked('sniper')).toBeNull()
  })

  it('isBlocked returns null for an agent with no blockers at all', async () => {
    const board = await freshBoard()
    expect(board.isBlocked('nobody')).toBeNull()
  })
})

describe('answer', () => {
  it('marks the blocker answered and clears deliveredAt for a fresh wake', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    const answered = board.answer(res.blocker.id, 'yes', 'operator')
    expect(answered.ok).toBe(true)
    if (!answered.ok) return
    expect(answered.blocker.status).toBe('answered')
    expect(answered.blocker.answer).toBe('yes')
    expect(answered.blocker.answeredBy).toBe('operator')
    expect(answered.blocker.deliveredAt).toBeNull()
  })

  it('rejects answering an unknown blocker', async () => {
    const board = await freshBoard()
    expect(board.answer('nope', 'yes', 'operator').ok).toBe(false)
  })

  it('rejects answering an already-answered blocker', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    board.answer(res.blocker.id, 'yes', 'operator')
    const again = board.answer(res.blocker.id, 'no really', 'operator')
    expect(again.ok).toBe(false)
  })

  it('rejects an empty answer', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    expect(board.answer(res.blocker.id, '   ', 'operator').ok).toBe(false)
  })

  it('appears in undelivered() until markDelivered is called', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    board.answer(res.blocker.id, 'yes', 'operator')
    expect(board.undelivered('sniper')).toHaveLength(1)
    board.markDelivered([res.blocker.id])
    expect(board.undelivered('sniper')).toHaveLength(0)
  })
})

describe('withdraw', () => {
  it('withdraws an open blocker', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    const w = board.withdraw(res.blocker.id, 'operator')
    expect(w.ok).toBe(true)
    expect(board.open()).toHaveLength(0)
  })

  it('rejects withdrawing an unknown blocker', async () => {
    const board = await freshBoard()
    expect(board.withdraw('nope', 'operator').ok).toBe(false)
  })

  it('rejects withdrawing an already-closed blocker', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    board.withdraw(res.blocker.id, 'operator')
    expect(board.withdraw(res.blocker.id, 'operator').ok).toBe(false)
  })

  it('a withdrawn blocker no longer suppresses its asker', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ severity: 'blocking' }))
    if (!res.ok) throw new Error('unreachable')
    board.withdraw(res.blocker.id, 'operator')
    expect(board.isBlocked('sniper')).toBeNull()
  })
})

describe('expireStale', () => {
  it('leaves a fresh blocker untouched', async () => {
    const board = await freshBoard()
    board.raise(ask())
    expect(board.expireStale(Date.now())).toHaveLength(0)
    expect(board.open()).toHaveLength(1)
  })

  it('expires a blocker older than BLOCKER_EXPIRY_MS and releases the asker', async () => {
    const board = await freshBoard()
    const res = board.raise(ask({ severity: 'blocking' }))
    if (!res.ok) throw new Error('unreachable')
    const expired = board.expireStale(res.blocker.createdAt + BLOCKER_EXPIRY_MS + 1)
    expect(expired).toHaveLength(1)
    expect(expired[0]!.status).toBe('expired')
    expect(board.isBlocked('sniper')).toBeNull()
    expect(board.open()).toHaveLength(0)
  })

  it('does not expire a blocker one millisecond short of the boundary', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    expect(board.expireStale(res.blocker.createdAt + BLOCKER_EXPIRY_MS - 1)).toHaveLength(0)
  })

  it('expires exactly at the boundary — the check is age >= EXPIRY, not strictly greater', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    expect(board.expireStale(res.blocker.createdAt + BLOCKER_EXPIRY_MS)).toHaveLength(1)
  })
})

describe('releaseAgent', () => {
  it('withdraws every open blocker where the agent is either asker or askedOf', async () => {
    const board = await freshBoard()
    board.raise({ agentId: 'sniper', askedOf: 'oracle', question: 'q1' })
    board.raise({ agentId: 'trapline', askedOf: 'sniper', question: 'q2' })
    board.releaseAgent('sniper')
    expect(board.open()).toHaveLength(0)
  })

  it('leaves blockers involving other agents untouched', async () => {
    const board = await freshBoard()
    board.raise({ agentId: 'trapline', askedOf: 'oracle', question: 'unrelated' })
    board.releaseAgent('sniper')
    expect(board.open()).toHaveLength(1)
  })
})

describe('list ordering', () => {
  it('sorts open blockers first, oldest-open at the top', async () => {
    vi.useFakeTimers()
    const board = await freshBoard()
    vi.setSystemTime(1000)
    board.raise({ agentId: 'a', askedOf: 'operator', question: 'first' })
    vi.setSystemTime(2000)
    board.raise({ agentId: 'b', askedOf: 'operator', question: 'second' })
    const list = board.list()
    expect(list[0]!.question).toBe('first')
    expect(list[1]!.question).toBe('second')
    vi.useRealTimers()
  })
})

describe('persistence', () => {
  it('persists raise/answer/withdraw so a fresh module load sees the change', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    if (!res.ok) throw new Error('unreachable')
    board.answer(res.blocker.id, 'ok', 'operator')
    vi.resetModules()
    const reloaded = (await import('./blockers')).blockerBoard
    const b = reloaded.get(res.blocker.id)
    expect(b?.status).toBe('answered')
    expect(b?.answer).toBe('ok')
  })

  it('trims closed rows beyond MAX_CLOSED_KEPT but never drops open ones', async () => {
    const board = await freshBoard()
    // 105 answered (closed) blockers, distinct questions so none dedupe.
    for (let i = 0; i < 105; i++) {
      const r = board.raise({ agentId: `agent-${i}`, askedOf: 'operator', question: `q-${i}` })
      if (r.ok) board.answer(r.blocker.id, 'ans', 'operator')
    }
    const openRes = board.raise({ agentId: 'still-open', askedOf: 'operator', question: 'still open' })
    expect(openRes.ok).toBe(true)
    vi.resetModules()
    const reloaded = (await import('./blockers')).blockerBoard
    expect(reloaded.open()).toHaveLength(1)
    expect(reloaded.list().length).toBeLessThanOrEqual(101) // 100 closed kept + 1 open
  })
})

describe('audit trail', () => {
  it('records raise, answer, and withdraw', async () => {
    const board = await freshBoard()
    const res = board.raise(ask())
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'blocker.raise' }))
    if (!res.ok) throw new Error('unreachable')
    board.answer(res.blocker.id, 'ok', 'operator')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'blocker.answer' }))

    const res2 = board.raise({ agentId: 'x', askedOf: 'operator', question: 'another' })
    if (!res2.ok) throw new Error('unreachable')
    board.withdraw(res2.blocker.id, 'operator')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'blocker.withdraw' }))
  })

  it('does not audit a duplicate ask (no new blocker was created)', async () => {
    const board = await freshBoard()
    board.raise(ask())
    audit.note.mockClear()
    board.raise(ask())
    expect(audit.note).not.toHaveBeenCalled()
  })
})

describe('promptFor', () => {
  it('renders open questions the agent is waiting on', async () => {
    const board = await freshBoard()
    board.raise(ask({ agentId: 'sniper', askedOf: 'operator', question: 'Raise the cap?' }))
    const prompt = board.promptFor('sniper')
    expect(prompt).toMatch(/WAITING ON AN ANSWER/)
    expect(prompt).toMatch(/Raise the cap\?/)
  })

  it('renders questions owed by this agent to colleagues', async () => {
    const board = await freshBoard()
    board.raise({ agentId: 'sniper', askedOf: 'manager', question: 'Can I size up?', why: 'need more capital' })
    const prompt = board.promptFor('manager')
    expect(prompt).toMatch(/BLOCKED WAITING ON YOU/)
    expect(prompt).toMatch(/need more capital/)
  })

  it('is empty for an agent with no involvement', async () => {
    const board = await freshBoard()
    board.raise(ask())
    expect(board.promptFor('uninvolved')).toBe('')
  })
})
