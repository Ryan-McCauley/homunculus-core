import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join, sep } from 'node:path'

// office.ts keeps one file-per-employee (personnel.json, journal.jsonl, mind.jsonl,
// mind.md) plus a single board.json, split across stateStore (JSON files) and raw
// node:fs (jsonl append/read + the write-only markdown mirror). The `Office` class is
// a module-level singleton (`office`) built once at import time (loadBoard() runs in
// the constructor), so every test needs a fresh module instance over controllable
// virtual fs/store state — same shape as the other hubs in this batch.
//
// The tricky part: listPersonnel() walks OFFICE_DIR with node:fs's readdirSync to find
// each employee's subdirectory, but personnel.json itself is written through
// stateStore, not raw fs. A real filesystem would show that subdirectory the moment
// mkdirSync(agentDir) ran. So existsSync/readdirSync here are derived from the UNION
// of both virtual stores (jsonl files + stateStore keys), keyed by path structure —
// that keeps the two mocks from silently disagreeing about what's "on disk".
const OFFICE_DIR = join(process.cwd(), 'data', 'crypto', 'office')

const fsState = vi.hoisted(() => ({
  // jsonl/markdown files: path -> raw file content (what appendFileSync/readFileSync see)
  jsonl: new Map<string, string>(),
}))
const store = vi.hoisted(() => ({ map: new Map<string, unknown>() }))
const audit = vi.hoisted(() => ({ note: vi.fn(), record: vi.fn() }))

function allKnownPaths(): string[] {
  return [...fsState.jsonl.keys(), ...store.map.keys()]
}

/** Direct child basenames of `dir` across both virtual stores — one level down only,
 *  which is what readdirSync would return for a real directory. Paths in both virtual
 *  stores come from join(), so on Windows they're backslash-separated — this must
 *  split on the SAME separator (`sep`), not a hardcoded '/', or every directory looks
 *  empty and listPersonnel() silently returns nothing. */
function childrenOf(dir: string): string[] {
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  const seen = new Set<string>()
  for (const p of allKnownPaths()) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const seg = rest.split(sep)[0]
    if (seg) seen.add(seg)
  }
  return [...seen]
}

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => fsState.jsonl.has(p) || store.map.has(p) || childrenOf(p).length > 0),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn((p: string, data: string) => {
    fsState.jsonl.set(p, (fsState.jsonl.get(p) ?? '') + data)
  }),
  readFileSync: vi.fn((p: string) => {
    if (!fsState.jsonl.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return fsState.jsonl.get(p)!
  }),
  writeFileSync: vi.fn((p: string, data: string) => { fsState.jsonl.set(p, data) }),
  readdirSync: vi.fn((p: string, opts?: { withFileTypes?: boolean }) => {
    const names = childrenOf(p)
    if (opts?.withFileTypes) return names.map((name) => ({ name, isDirectory: () => true }))
    return names
  }),
}))

vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (store.map.has(file) ? store.map.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { store.map.set(file, value) }),
    deleteJson: vi.fn((file: string) => { store.map.delete(file) }),
  },
}))

vi.mock('./auditLog', () => ({ auditLog: audit }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.jsonl.clear()
  store.map.clear()
  // Several assertions below depend on strict ordering by Date.now() (updatedAt
  // bumps, "answered after" comparisons) — fake timers with explicit advances keep
  // those deterministic instead of racing real-clock millisecond resolution.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

async function freshOffice() {
  const mod = await import('./office')
  return mod.office
}

function agentDir(agentId: string): string {
  return join(OFFICE_DIR, agentId)
}

describe('personnel: ensurePersonnel / getPersonnel', () => {
  it('opens a new personnel file with EMP-001 for the first hire', async () => {
    const office = await freshOffice()
    const rec = office.ensurePersonnel('agent-a', 'Analyst')
    expect(rec.employeeId).toBe('EMP-001')
    expect(rec.title).toBe('Analyst')
    expect(rec.department).toBe('operations')
    expect(rec.status).toBe('probation')
    expect(rec.reportsTo).toBeNull()
  })

  it('is idempotent — a second call returns the existing record unchanged', async () => {
    const office = await freshOffice()
    const first = office.ensurePersonnel('agent-a', 'Analyst')
    const second = office.ensurePersonnel('agent-a', 'Some Other Title')
    expect(second).toEqual(first)
    expect(second.title).toBe('Analyst')
  })

  it('assigns increasing employee ids across hires, never reusing one', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst')
    const second = office.ensurePersonnel('agent-b', 'Trader')
    expect(second.employeeId).toBe('EMP-002')
  })

  it('honors explicit title/department/status/resume/jobDescription overrides', async () => {
    const office = await freshOffice()
    const rec = office.ensurePersonnel('agent-a', 'Fallback', {
      title: 'Senior Trader',
      department: 'trading',
      status: 'active',
      reportsTo: 'agent-manager',
      resume: { summary: 'Ten years of paper losses.' },
    })
    expect(rec.title).toBe('Senior Trader')
    expect(rec.department).toBe('trading')
    expect(rec.status).toBe('active')
    expect(rec.reportsTo).toBe('agent-manager')
    expect(rec.resume.summary).toBe('Ten years of paper losses.')
    // Unset resume fields still fall back to the shared defaults.
    expect(rec.resume.specialties).toEqual([])
  })

  it('returns null from getPersonnel for an agent that was never hired', async () => {
    const office = await freshOffice()
    expect(office.getPersonnel('ghost')).toBeNull()
  })
})

describe('listPersonnel', () => {
  it('returns an empty list when the office directory does not exist', async () => {
    const office = await freshOffice()
    expect(office.listPersonnel()).toEqual([])
  })

  it('lists every hired employee sorted by employeeId', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-b', 'Trader') // EMP-001
    office.ensurePersonnel('agent-a', 'Analyst') // EMP-002
    const ids = office.listPersonnel().map((p) => p.employeeId)
    expect(ids).toEqual(['EMP-001', 'EMP-002'])
  })
})

describe('updatePersonnel', () => {
  it('returns null for an unknown agent', async () => {
    const office = await freshOffice()
    expect(office.updatePersonnel('ghost', { title: 'x' })).toBeNull()
  })

  it('applies a partial patch, merging resume/jobDescription rather than replacing', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst', { resume: { summary: 'old summary', specialties: ['macro'] } })
    const updated = office.updatePersonnel('agent-a', { resume: { summary: 'new summary' } })
    expect(updated!.resume.summary).toBe('new summary')
    expect(updated!.resume.specialties).toEqual(['macro'])
  })

  it('records an audit note, calling out a status transition specially', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst')
    audit.note.mockClear()
    office.updatePersonnel('agent-a', { status: 'active' })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'office.personnel.update',
      summary: expect.stringMatching(/probation.*active/),
    }))
  })

  it('records a generic summary when no status change occurred', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst')
    audit.note.mockClear()
    office.updatePersonnel('agent-a', { notes: 'just a note' })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringMatching(/personnel record updated/),
    }))
  })
})

describe('isBenched', () => {
  it('is false for an unknown agent', async () => {
    const office = await freshOffice()
    expect(office.isBenched('ghost')).toEqual({ benched: false, status: null })
  })

  it('is false for probation and active employees', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst', { status: 'active' })
    expect(office.isBenched('agent-a').benched).toBe(false)
  })

  it('is true for suspended and terminated employees', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst', { status: 'suspended' })
    expect(office.isBenched('agent-a')).toEqual({ benched: true, status: 'suspended' })
    office.updatePersonnel('agent-a', { status: 'terminated' })
    expect(office.isBenched('agent-a')).toEqual({ benched: true, status: 'terminated' })
  })
})

describe('offboard', () => {
  it('marks the personnel record terminated but is a no-op for an unknown agent', async () => {
    const office = await freshOffice()
    office.offboard('ghost') // must not throw
    office.ensurePersonnel('agent-a', 'Analyst', { status: 'active' })
    office.offboard('agent-a')
    expect(office.getPersonnel('agent-a')!.status).toBe('terminated')
  })

  it('records an audit note on offboarding', async () => {
    const office = await freshOffice()
    office.ensurePersonnel('agent-a', 'Analyst')
    audit.note.mockClear()
    office.offboard('agent-a')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'office.personnel.offboard',
      resource: 'agent:agent-a',
    }))
  })
})

describe('journal: readJournal / appendJournal', () => {
  it('returns an empty journal for an agent with no entries', async () => {
    const office = await freshOffice()
    expect(office.readJournal('agent-a')).toEqual([])
  })

  it('appends an entry with generated id/at and the given fields', async () => {
    const office = await freshOffice()
    const row = office.appendJournal('agent-a', { title: 'Morning notes', body: 'the market feels heavy', tags: ['macro'] })
    expect(row.id).toBeTruthy()
    expect(row.title).toBe('Morning notes')
    expect(row.body).toBe('the market feels heavy')
    expect(row.tags).toEqual(['macro'])
    expect(row.author).toBe('agent')
  })

  it('defaults title to empty string and author to agent when omitted', async () => {
    const office = await freshOffice()
    const row = office.appendJournal('agent-a', { body: 'quick thought' })
    expect(row.title).toBe('')
    expect(row.author).toBe('agent')
  })

  it('reads back newest-first', async () => {
    const office = await freshOffice()
    office.appendJournal('agent-a', { body: 'first' })
    office.appendJournal('agent-a', { body: 'second' })
    const entries = office.readJournal('agent-a')
    expect(entries.map((e) => e.body)).toEqual(['second', 'first'])
  })

  it('caps the journal at MAX_JOURNAL_KEPT (200), dropping the oldest', async () => {
    const office = await freshOffice()
    for (let i = 0; i < 205; i++) office.appendJournal('agent-a', { body: `entry ${i}` })
    const entries = office.readJournal('agent-a')
    expect(entries).toHaveLength(200)
    // Newest-first, and the oldest 5 (0..4) must have rolled off.
    expect(entries[0]!.body).toBe('entry 204')
    expect(entries[entries.length - 1]!.body).toBe('entry 5')
  })

  it('skips a torn (unparseable) jsonl line instead of failing the whole read', async () => {
    const office = await freshOffice()
    office.appendJournal('agent-a', { body: 'good entry' })
    const file = join(agentDir('agent-a'), 'journal.jsonl')
    fsState.jsonl.set(file, fsState.jsonl.get(file) + 'not json at all\n')
    const entries = office.readJournal('agent-a')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.body).toBe('good entry')
  })
})

describe('mind: readMind / think', () => {
  it('returns an empty mind for an agent with no thoughts', async () => {
    const office = await freshOffice()
    expect(office.readMind('agent-a')).toEqual([])
  })

  it('records a thought and mirrors it to the markdown file', async () => {
    const office = await freshOffice()
    const thought = office.think('agent-a', { kind: 'decision', text: 'go long', runId: 'run-1' })
    expect(thought.kind).toBe('decision')
    expect(thought.text).toBe('go long')
    expect(thought.runId).toBe('run-1')
    const md = fsState.jsonl.get(join(agentDir('agent-a'), 'mind.md'))
    expect(md).toContain('go long')
    expect(md).toContain('run-1'.slice(0, 8))
  })

  it('defaults kind to reasoning and runId to null', async () => {
    const office = await freshOffice()
    const thought = office.think('agent-a', { text: 'hmm' })
    expect(thought.kind).toBe('reasoning')
    expect(thought.runId).toBeNull()
  })

  it('does not persist a thought whose text trims to empty', async () => {
    const office = await freshOffice()
    office.think('agent-a', { text: '   ' })
    expect(office.readMind('agent-a')).toEqual([])
  })

  it('reads back newest-first, limited', async () => {
    const office = await freshOffice()
    office.think('agent-a', { text: 'one' })
    office.think('agent-a', { text: 'two' })
    office.think('agent-a', { text: 'three' })
    expect(office.readMind('agent-a', 2).map((t) => t.text)).toEqual(['three', 'two'])
  })

  it('keeps the mind log bounded near MAX_MIND_KEPT (400)', async () => {
    // The cap is deliberately SOFT. trimJsonl rewrites the whole file, and think()
    // runs on the streaming path (once per content block of every run), so trimming
    // on every write meant a full read + full rewrite per thought once the file
    // passed 400. It now trims every MIND_TRIM_EVERY (50) writes, so the file sits
    // between the cap and cap+50 rather than exactly at it — bounded, which is the
    // property that matters, without the per-thought I/O.
    const office = await freshOffice()
    for (let i = 0; i < 600; i++) office.think('agent-a', { text: `t${i}` })
    const jsonlFile = join(agentDir('agent-a'), 'mind.jsonl')
    const lines = fsState.jsonl.get(jsonlFile)!.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(400)
    expect(lines.length).toBeLessThanOrEqual(450)
    // Whatever survives is the NEWEST slice — the oldest thoughts are the ones cut.
    expect(lines[lines.length - 1]).toContain('t599')
  })

  it('caps the board so it cannot grow without bound', async () => {
    // Agents are instructed to post every run and the whole file is rewritten on
    // every reply, so an uncapped board is both a disk leak and a growing cost per
    // post. (listThreads sorts by updatedAt, and these are all created within the
    // same millisecond, so this asserts the cap — not a specific survivor.)
    const office = await freshOffice()
    for (let i = 0; i < 560; i++) office.postThread({ title: `t${i}`, body: `b${i}`, authorId: 'operator' }, [])
    expect(office.listThreads().length).toBe(500)
    // The most recently posted thread is never the one dropped.
    expect(office.listThreads().some((t) => t.title === 't559')).toBe(true)
  })
})

describe('board: postThread / reply / setResolved / listThreads / getThread', () => {
  it('starts with no threads', async () => {
    const office = await freshOffice()
    expect(office.listThreads()).toEqual([])
  })

  it('posts a thread with the first message and persists it', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 'Q3 plan', body: 'thoughts?', authorId: 'operator' }, [])
    expect(thread.title).toBe('Q3 plan')
    expect(thread.resolved).toBe(false)
    expect(thread.messages).toHaveLength(1)
    expect(store.map.get(join(OFFICE_DIR, 'board.json'))).toEqual([thread])
  })

  it('defaults an empty title to (untitled)', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: '   ', body: 'x', authorId: 'operator' }, [])
    expect(thread.title).toBe('(untitled)')
  })

  it('resolves @mentions against the known-id list on post', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'hey @agent-a and @ghost', authorId: 'operator' }, ['agent-a'])
    expect(thread.messages[0]!.mentions).toEqual(['agent-a'])
  })

  it('lists threads newest-updated-first', async () => {
    const office = await freshOffice()
    const t1 = office.postThread({ title: 'first', body: 'x', authorId: 'operator' }, [])
    vi.advanceTimersByTime(1000)
    const t2 = office.postThread({ title: 'second', body: 'x', authorId: 'operator' }, [])
    vi.advanceTimersByTime(1000)
    office.reply(t1.id, { body: 'bump', authorId: 'operator' }, [])
    const ids = office.listThreads().map((t) => t.id)
    expect(ids[0]).toBe(t1.id) // bumped by the reply
    expect(ids[1]).toBe(t2.id)
  })

  it('reply appends a message, resolves mentions, and bumps updatedAt', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'x', authorId: 'operator' }, [])
    const before = thread.updatedAt
    vi.advanceTimersByTime(1000)
    const replied = office.reply(thread.id, { body: 'ack @agent-a', authorId: 'agent-a' }, ['agent-a'])
    expect(replied!.messages).toHaveLength(2)
    expect(replied!.messages[1]!.mentions).toEqual(['agent-a'])
    expect(replied!.updatedAt).toBeGreaterThan(before)
  })

  it('reply returns null for an unknown thread', async () => {
    const office = await freshOffice()
    expect(office.reply('nope', { body: 'x', authorId: 'operator' }, [])).toBeNull()
  })

  it('setResolved toggles resolved and returns null for an unknown thread', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'x', authorId: 'operator' }, [])
    const resolved = office.setResolved(thread.id, true)
    expect(resolved!.resolved).toBe(true)
    expect(office.setResolved('nope', true)).toBeNull()
  })

  it('getThread finds by id or returns null', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'x', authorId: 'operator' }, [])
    expect(office.getThread(thread.id)).toEqual(thread)
    expect(office.getThread('nope')).toBeNull()
  })
})

describe('inbox', () => {
  it('is empty when nothing mentions the agent', async () => {
    const office = await freshOffice()
    office.postThread({ title: 't', body: 'no mentions here', authorId: 'operator' }, [])
    expect(office.inbox('agent-a')).toEqual([])
  })

  it('surfaces an open @mention the agent has not answered', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'hey @agent-a', authorId: 'operator' }, ['agent-a'])
    const inbox = office.inbox('agent-a')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.threadId).toBe(thread.id)
    expect(inbox[0]!.fromId).toBe('operator')
  })

  it('clears once the agent has replied after being mentioned', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'hey @agent-a', authorId: 'operator' }, ['agent-a'])
    vi.advanceTimersByTime(1000)
    office.reply(thread.id, { body: 'on it', authorId: 'agent-a' }, ['agent-a'])
    expect(office.inbox('agent-a')).toEqual([])
  })

  it('a mention made AFTER the agent last replied still shows as unanswered', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'hey @agent-a', authorId: 'operator' }, ['agent-a'])
    vi.advanceTimersByTime(1000)
    office.reply(thread.id, { body: 'on it', authorId: 'agent-a' }, ['agent-a'])
    vi.advanceTimersByTime(1000)
    office.reply(thread.id, { body: 'following up @agent-a', authorId: 'operator' }, ['agent-a'])
    expect(office.inbox('agent-a')).toHaveLength(1)
  })

  it('ignores mentions in resolved threads', async () => {
    const office = await freshOffice()
    const thread = office.postThread({ title: 't', body: 'hey @agent-a', authorId: 'operator' }, ['agent-a'])
    office.setResolved(thread.id, true)
    expect(office.inbox('agent-a')).toEqual([])
  })
})

describe('threadsFor', () => {
  it('includes threads the agent authored or was mentioned in, excludes unrelated ones', async () => {
    const office = await freshOffice()
    const mine = office.postThread({ title: 'mine', body: 'x', authorId: 'agent-a' }, [])
    const mentioned = office.postThread({ title: 'tagged', body: '@agent-a look', authorId: 'operator' }, ['agent-a'])
    office.postThread({ title: 'unrelated', body: 'x', authorId: 'operator' }, [])
    const ids = office.threadsFor('agent-a').map((t) => t.id)
    expect(ids).toContain(mine.id)
    expect(ids).toContain(mentioned.id)
    expect(ids).toHaveLength(2)
  })
})

describe('cubicle', () => {
  it('assembles personnel (hiring if needed), journal, mind, inbox, and threads', async () => {
    const office = await freshOffice()
    office.appendJournal('agent-a', { body: 'a journal entry' })
    office.think('agent-a', { text: 'a thought' })
    office.postThread({ title: 't', body: 'hey @agent-a', authorId: 'operator' }, ['agent-a'])
    const view = office.cubicle('agent-a', 'Fallback Title')
    expect(view.personnel.title).toBe('Fallback Title')
    expect(view.journal).toHaveLength(1)
    expect(view.mind).toHaveLength(1)
    expect(view.inbox).toHaveLength(1)
    expect(view.threads).toHaveLength(1)
  })

  it('caps the returned threads at 20', async () => {
    const office = await freshOffice()
    for (let i = 0; i < 25; i++) office.postThread({ title: `t${i}`, body: 'x', authorId: 'agent-a' }, [])
    const view = office.cubicle('agent-a', 'Fallback')
    expect(view.threads).toHaveLength(20)
  })
})

describe('type guards', () => {
  it('isDepartment / isEmploymentStatus / isSourceRef', async () => {
    const mod = await import('./office')
    expect(mod.isDepartment('trading')).toBe(true)
    expect(mod.isDepartment('nope')).toBe(false)
    expect(mod.isEmploymentStatus('active')).toBe(true)
    expect(mod.isEmploymentStatus('nope')).toBe(false)
    expect(mod.isSourceRef({ kind: 'api', ref: 'GET /x' })).toBe(true)
    expect(mod.isSourceRef({ kind: 'bogus', ref: 'x' })).toBe(false)
    expect(mod.isSourceRef(null)).toBe(false)
  })
})
