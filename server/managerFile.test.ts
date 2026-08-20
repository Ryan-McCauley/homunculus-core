import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import type { BoardThread, PersonnelRecord } from '../shared/office'
import type { Blocker } from '../shared/blockers'

// `managerFile` is a module-level singleton constructed at import time from
// stateStore.readJson, so every test takes a fresh instance (vi.resetModules +
// dynamic import) over a controllable fake backing store — the freshModule()
// pattern blockers.test.ts and cryptoStrategySettings.test.ts already use.
//
// shared/managerFile is deliberately NOT mocked: it is pure, already covered by
// shared/managerFile.test.ts, and letting the real triage rules run is what makes
// these tests exercise the seam that was untested — persistence, the write-dedup,
// the closed-row cap, the manager cache, and the audit calls. Those live here and
// nowhere else, which is why this file reported 0% while a same-named test file
// sat in shared/ looking like coverage.

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

const desk = vi.hoisted(() => ({
  threads: [] as unknown[],
  personnel: [] as unknown[],
  blockers: [] as unknown[],
}))
vi.mock('./office', () => ({
  office: {
    listThreads: vi.fn(() => desk.threads),
    listPersonnel: vi.fn(() => desk.personnel),
  },
}))
vi.mock('./blockers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, blockerBoard: { open: vi.fn(() => desk.blockers) } }
})

const FILE = join(process.cwd(), 'data', 'crypto', 'office', 'managers-file.json')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  store.data.clear()
  desk.threads = []
  desk.personnel = []
  desk.blockers = []
})

async function freshFile() {
  const mod = await import('./managerFile')
  return mod.managerFile
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const employee = (over: Partial<PersonnelRecord> = {}): PersonnelRecord => ({
  agentId: 'chief', employeeId: 'EMP-001', title: 'Chief', department: 'executive',
  status: 'active', hiredAt: 0, reportsTo: null,
  resume: {} as PersonnelRecord['resume'],
  jobDescription: {} as PersonnelRecord['jobDescription'],
  sources: [], notes: '', updatedAt: 0,
  ...over,
})

const thread = (over: Partial<BoardThread> = {}): BoardThread => ({
  id: 'th1', title: 'Position cap', authorId: 'sniper', createdAt: 0, updatedAt: 0,
  tags: [], resolved: false,
  messages: [{ id: 'm1', authorId: 'sniper', at: 1_000, body: 'Should we raise the cap?', mentions: ['quant'] }],
  ...over,
})

const blocker = (over: Partial<Blocker> = {}): Blocker => ({
  id: 'b1', agentId: 'sniper', askedOf: 'operator', question: 'Raise the cap?',
  status: 'open', at: 1_000, threadId: null,
  ...over,
} as Blocker)

// ── Load ───────────────────────────────────────────────────────────────────

describe('construction', () => {
  it('starts empty when nothing is persisted', async () => {
    const file = await freshFile()
    expect(file.list()).toEqual([])
    expect(file.stats()).toEqual({ open: 0, needsTriage: 0, assigned: 0, answered: 0, closed: 0 })
  })

  it('tolerates a persisted file with no items array', async () => {
    store.data.set(FILE, {})
    const file = await freshFile()
    expect(file.list()).toEqual([])
  })

  it('loads persisted items from the state store', async () => {
    store.data.set(FILE, { items: [persistedItem({ id: 'seeded', status: 'new' })] })
    const file = await freshFile()
    expect(file.list()).toHaveLength(1)
    expect(file.get('seeded')?.id).toBe('seeded')
  })
})

/** A fully-shaped persisted row, so tests can seed state without a refresh. */
function persistedItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'x', kind: 'mention', fromId: 'sniper', namedIds: [], threadId: null, threadTitle: '',
    messageId: null, blockerId: null, at: 0, filedAt: 0, excerpt: '', status: 'new',
    assignedTo: null, assignedAt: null, instruction: '', deliveredAt: null, answeredBy: null,
    answeredAt: null, answer: '', closedAt: null, closedReason: null, note: '',
    ...over,
  }
}

// ── Refresh ────────────────────────────────────────────────────────────────

describe('refresh', () => {
  it('files an outstanding mention and persists it', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    const items = file.refresh(5_000)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'mention', fromId: 'sniper', status: 'new', threadId: 'th1' })
    expect(store.data.get(FILE)).toBeDefined()
  })

  it('files an open blocker', async () => {
    desk.personnel = [employee()]
    desk.blockers = [blocker()]
    const file = await freshFile()
    const items = file.refresh(5_000)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'blocker', fromId: 'sniper' })
  })

  it('is idempotent — re-scanning the same desk adds nothing', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    file.refresh(5_000)
    file.refresh(6_000)
    file.refresh(7_000)
    expect(file.list()).toHaveLength(1)
  })

  it('skips the manager own posts', async () => {
    desk.personnel = [employee({ agentId: 'chief' })]
    desk.threads = [thread({
      messages: [{ id: 'm1', authorId: 'chief', at: 1_000, body: 'ping @quant', mentions: ['quant'] }],
    })]
    const file = await freshFile()
    expect(file.refresh(5_000)).toHaveLength(0)
  })

  it('skips resolved threads', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread({ resolved: true })]
    const file = await freshFile()
    expect(file.refresh(5_000)).toHaveLength(0)
  })
})

// ── Write dedup ────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('does not touch disk when a refresh changed nothing', async () => {
    const { stateStore } = await import('./stateStore')
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    file.refresh(5_000)
    const writesAfterFirst = vi.mocked(stateStore.writeJson).mock.calls.length
    file.refresh(6_000)
    file.refresh(7_000)
    expect(vi.mocked(stateStore.writeJson).mock.calls.length).toBe(writesAfterFirst)
  })

  it('caps retained closed rows at 200, newest kept', async () => {
    const closed = Array.from({ length: 250 }, (_, i) =>
      persistedItem({ id: `c${i}`, at: i, filedAt: i, status: 'closed', closedAt: i, closedReason: 'manager' }))
    const open = persistedItem({ id: 'open1', status: 'new' })
    store.data.set(FILE, { items: [open, ...closed] })

    const file = await freshFile()
    file.note('open1', 'triage later')  // any mutation triggers save()

    const kept = file.list()
    expect(kept.filter((i) => i.status === 'closed')).toHaveLength(200)
    expect(kept.find((i) => i.id === 'open1')).toBeDefined()
    // Newest closed survive: c249 kept, c0 dropped.
    expect(kept.some((i) => i.id === 'c249')).toBe(true)
    expect(kept.some((i) => i.id === 'c0')).toBe(false)
  })
})

// ── Manager resolution ─────────────────────────────────────────────────────

describe('managerId', () => {
  it('resolves the top-level executive', async () => {
    desk.personnel = [
      employee({ agentId: 'chief' }),
      employee({ agentId: 'quant', employeeId: 'EMP-002', department: 'research', reportsTo: 'chief' }),
    ]
    const file = await freshFile()
    expect(file.managerId()).toBe('chief')
  })

  it('returns null when the roster names nobody', async () => {
    desk.personnel = []
    const file = await freshFile()
    expect(file.managerId()).toBeNull()
  })

  it('caches the roster lookup', async () => {
    const { office } = await import('./office')
    desk.personnel = [employee()]
    const file = await freshFile()
    file.managerId(); file.managerId(); file.managerId()
    expect(vi.mocked(office.listPersonnel).mock.calls.length).toBe(1)
  })

  it('invalidateManager forces a re-read', async () => {
    const { office } = await import('./office')
    desk.personnel = [employee({ agentId: 'chief' })]
    const file = await freshFile()
    expect(file.managerId()).toBe('chief')
    desk.personnel = [employee({ agentId: 'newboss' })]
    file.invalidateManager()
    expect(file.managerId()).toBe('newboss')
    expect(vi.mocked(office.listPersonnel).mock.calls.length).toBe(2)
  })
})

// ── Triage ─────────────────────────────────────────────────────────────────

describe('assign / answer / close', () => {
  async function withOneItem() {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    const id = file.refresh(5_000)[0]!.id
    return { file, id }
  }

  it('assign sets the assignee and records an audit note', async () => {
    const { file, id } = await withOneItem()
    const res = file.assign(id, 'quant', 'Model the cap change', 'chief')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item).toMatchObject({ status: 'assigned', assignedTo: 'quant', instruction: 'Model the cap change' })
    expect(audit.note).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'manager-file.assign', resource: 'agent:quant' }))
  })

  it('assign on an unknown id fails without auditing', async () => {
    const { file } = await withOneItem()
    const res = file.assign('nope', 'quant', 'do it', 'chief')
    expect(res.ok).toBe(false)
    expect(audit.note).not.toHaveBeenCalled()
  })

  it('answer records the reply and audits', async () => {
    const { file, id } = await withOneItem()
    file.assign(id, 'quant', 'Model it', 'chief')
    const res = file.answer(id, 'Cap can go to 3%', 'quant')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item).toMatchObject({ status: 'answered', answer: 'Cap can go to 3%' })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'manager-file.answer' }))
  })

  it('close marks the item closed and audits', async () => {
    const { file, id } = await withOneItem()
    const res = file.close(id, 'chief')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item.status).toBe('closed')
    expect(file.open()).toHaveLength(0)
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'manager-file.close' }))
  })

  it('note stores the trimmed text without changing status', async () => {
    const { file, id } = await withOneItem()
    const res = file.note(id, '  look at this after the close  ')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.item.note).toBe('look at this after the close')
    expect(res.item.status).toBe('new')
  })

  it('note on an unknown id reports the id back', async () => {
    const { file } = await withOneItem()
    const res = file.note('ghost', 'x')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('ghost')
  })
})

// ── Delivery + waking ──────────────────────────────────────────────────────

describe('assignment delivery', () => {
  async function assigned() {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    const id = file.refresh(5_000)[0]!.id
    file.assign(id, 'quant', 'Model it', 'chief')
    return { file, id }
  }

  it('pendingFor lists undelivered work for that agent only', async () => {
    const { file } = await assigned()
    expect(file.pendingFor('quant')).toHaveLength(1)
    expect(file.pendingFor('sniper')).toHaveLength(0)
  })

  it('markDelivered drains the pending list', async () => {
    const { file, id } = await assigned()
    file.markDelivered([id])
    expect(file.pendingFor('quant')).toHaveLength(0)
  })

  it('markDelivered on an empty list is a no-op', async () => {
    const { stateStore } = await import('./stateStore')
    const { file } = await assigned()
    const before = vi.mocked(stateStore.writeJson).mock.calls.length
    file.markDelivered([])
    expect(vi.mocked(stateStore.writeJson).mock.calls.length).toBe(before)
  })

  it('wakeDue is true for an item filed since the last wake, false before it', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    file.refresh(5_000)
    expect(file.wakeDue(4_000)).toBe(true)
    expect(file.wakeDue(6_000)).toBe(false)
  })
})

// ── Views ──────────────────────────────────────────────────────────────────

describe('views', () => {
  it('list returns a copy — mutating it does not corrupt the store', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    file.refresh(5_000)
    file.list().pop()
    expect(file.list()).toHaveLength(1)
  })

  it('get returns null for an unknown id', async () => {
    const file = await freshFile()
    expect(file.get('nope')).toBeNull()
  })

  it('stats counts each status', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread({
      messages: [
        { id: 'm1', authorId: 'sniper', at: 1_000, body: 'a @quant', mentions: ['quant'] },
        { id: 'm2', authorId: 'sniper', at: 2_000, body: 'b @quant', mentions: ['quant'] },
      ],
    })]
    const file = await freshFile()
    const items = file.refresh(5_000)
    file.assign(items[0]!.id, 'quant', 'Model it', 'chief')
    expect(file.stats()).toMatchObject({ open: 2, needsTriage: 1, assigned: 1, closed: 0 })
  })

  it('digest renders the open file as text', async () => {
    desk.personnel = [employee()]
    desk.threads = [thread()]
    const file = await freshFile()
    file.refresh(5_000)
    expect(file.digest(6_000)).toContain('Position cap')
  })
})
