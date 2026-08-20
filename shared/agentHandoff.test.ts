import { describe, it, expect } from 'vitest'
import type { BoardThread } from './office'
import { parseStagePost, newestStageThread, newestStagePost, handoffDue } from './agentHandoff'

const HOUR = 3_600_000

function scanBody(candidates: unknown[], note = ''): string {
  return '```json\n' + JSON.stringify({ stage: 'scan', at: '2026-08-19T21:02:00Z', candidates, note }) + '\n```'
}

function thread(over: Partial<BoardThread> = {}): BoardThread {
  const createdAt = over.createdAt ?? 1000
  return {
    id: 't1',
    title: 'TRAPLINE CYCLE 2026-08-19 21:02',
    authorId: 'trap-scout',
    createdAt,
    updatedAt: over.updatedAt ?? createdAt,
    tags: ['trapline-run'],
    resolved: false,
    messages: [{ id: 'm1', authorId: over.authorId ?? 'trap-scout', at: createdAt, body: scanBody([]), mentions: [] }],
    ...over
  }
}

describe('parseStagePost', () => {
  it('reads the fenced json block the pipeline posts', () => {
    const p = parseStagePost(scanBody([{ symbol: 'INJUSD' }, { symbol: 'ARBUSD' }]))
    expect(p).not.toBeNull()
    expect(p!.stage).toBe('scan')
    expect(p!.work).toBe(2)
  })

  it('reads an empty candidate list as no work — the correct, common outcome', () => {
    expect(parseStagePost(scanBody([])!)!.work).toBe(0)
  })

  it('honours an explicit work count over any array it might guess from', () => {
    const body = '```json\n' + JSON.stringify({ stage: 'tend', work: 3, candidates: [] }) + '\n```'
    expect(parseStagePost(body)!.work).toBe(3)
  })

  it('reports unknown work rather than zero when the post declares neither', () => {
    const body = '```json\n' + JSON.stringify({ stage: 'tend', trailArms: [] }) + '\n```'
    expect(parseStagePost(body)!.work).toBeNull()
  })

  it('finds the block even when the agent wrapped it in prose it was told not to write', () => {
    const body = `Here is my cycle report.\n\n${scanBody([{ symbol: 'INJUSD' }])}\n\nThanks!`
    expect(parseStagePost(body)!.work).toBe(1)
  })

  it('accepts a bare fence with no language tag', () => {
    const body = '```\n{"stage":"scan","candidates":[{"symbol":"X"}]}\n```'
    expect(parseStagePost(body)!.work).toBe(1)
  })

  it('returns null on a post with no json block at all', () => {
    expect(parseStagePost('stood down: no fresh scan')).toBeNull()
  })

  it('returns null on a fenced block that is not valid json', () => {
    expect(parseStagePost('```json\n{not json,,}\n```')).toBeNull()
  })

  it('returns null on json that is not an object', () => {
    expect(parseStagePost('```json\n[1,2,3]\n```')).toBeNull()
  })
})

describe('newestStageThread', () => {
  const scout = thread({ id: 'scout-new', authorId: 'trap-scout', createdAt: 5 * HOUR })
  const older = thread({ id: 'scout-old', authorId: 'trap-scout', createdAt: 1 * HOUR })
  const steward = thread({
    id: 'steward', authorId: 'trap-steward', createdAt: 4 * HOUR, updatedAt: 9 * HOUR,
    title: 'TEND cycle — trapline flat'
  })

  it('picks the newest thread from the author it was told to read', () => {
    expect(newestStageThread([older, scout], { authorId: 'trap-scout', tag: 'trapline-run' })?.id).toBe('scout-new')
  })

  it('IGNORES a downstream stage that opened a thread under the same tag', () => {
    // The bug: the board sorts by updatedAt, so a Steward post shadowed the Scout's scan
    // and the Setter stood down reporting "no fresh scan" while a scan sat right there.
    expect(newestStageThread([scout, steward], { authorId: 'trap-scout', tag: 'trapline-run' })?.id).toBe('scout-new')
  })

  it('orders by when the thread was created, never by when it was last touched', () => {
    const touched = thread({ id: 'touched', authorId: 'trap-scout', createdAt: 1 * HOUR, updatedAt: 99 * HOUR })
    expect(newestStageThread([touched, scout], { authorId: 'trap-scout', tag: 'trapline-run' })?.id).toBe('scout-new')
  })

  it('requires the tag as well as the author', () => {
    const untagged = thread({ id: 'chat', authorId: 'trap-scout', createdAt: 9 * HOUR, tags: ['banter'] })
    expect(newestStageThread([scout, untagged], { authorId: 'trap-scout', tag: 'trapline-run' })?.id).toBe('scout-new')
  })

  it('returns null when the author has posted nothing under that tag', () => {
    expect(newestStageThread([steward], { authorId: 'trap-scout', tag: 'trapline-run' })).toBeNull()
  })
})

describe('handoffDue', () => {
  const opts = { authorId: 'trap-scout', tag: 'trapline-run', maxAgeMs: 90 * 60_000 }
  const now = 10 * HOUR

  function scan(candidates: unknown[], createdAt: number, id = 'scan'): BoardThread {
    const t = thread({ id, authorId: 'trap-scout', createdAt })
    t.messages = [{ id: 'm', authorId: 'trap-scout', at: createdAt, body: scanBody(candidates), mentions: [] }]
    return t
  }

  it('wakes the downstream stage when fresh work is published', () => {
    const due = handoffDue([scan([{ symbol: 'INJUSD' }], now - 10 * 60_000)], { ...opts, since: 0, now })
    expect(due).not.toBeNull()
    expect(due!.work).toBe(1)
  })

  it('does NOT wake it for a zero-candidate cycle — the whole point of the change', () => {
    expect(handoffDue([scan([], now - 10 * 60_000)], { ...opts, since: 0, now })).toBeNull()
  })

  it('does not wake it twice for the same post', () => {
    const t = scan([{ symbol: 'INJUSD' }], now - 10 * 60_000)
    const first = handoffDue([t], { ...opts, since: 0, now })!
    expect(handoffDue([t], { ...opts, since: first.at, now })).toBeNull()
  })

  it('ignores a scan that has gone stale — the Setter must not act on old prices', () => {
    expect(handoffDue([scan([{ symbol: 'INJUSD' }], now - 3 * HOUR)], { ...opts, since: 0, now })).toBeNull()
  })

  it('wakes on an unparseable post so a garbled scan gets human-grade eyes, not silence', () => {
    const t = thread({ id: 'garbled', authorId: 'trap-scout', createdAt: now - 10 * 60_000 })
    t.messages = [{ id: 'm', authorId: 'trap-scout', at: now - 10 * 60_000, body: 'the screener exploded', mentions: [] }]
    const due = handoffDue([t], { ...opts, since: 0, now })
    expect(due).not.toBeNull()
    expect(due!.work).toBeNull()
  })

  it('returns null when the upstream has published nothing at all', () => {
    expect(handoffDue([], { ...opts, since: 0, now })).toBeNull()
  })
})

describe('newestStagePost — the handoff, now that the whole desk shares one board', () => {
  const now = 10 * HOUR

  function board(messages: { authorId: string; at: number; body: string }[]): BoardThread {
    return {
      id: 'board-1', title: 'DESK BOARD — 2026-08-19', authorId: 'manager',
      createdAt: 0, updatedAt: now, tags: ['desk-board'], resolved: false,
      messages: messages.map((m, i) => ({ id: `m${i}`, mentions: [], ...m }))
    }
  }

  it('finds the newest scan the named upstream stage posted', () => {
    const t = board([
      { authorId: 'trap-scout', at: 1 * HOUR, body: scanBody([{ symbol: 'OLD' }]) },
      { authorId: 'trap-scout', at: 5 * HOUR, body: scanBody([{ symbol: 'NEW' }]) }
    ])
    const found = newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })
    expect(found).toBeNull() // 5h old, past the freshness window
    expect(newestStagePost(t, { authorId: 'trap-scout', now: 5 * HOUR + 60_000, maxAgeMs: 90 * 60_000 })?.work).toBe(1)
  })

  it('IGNORES a downstream stage posting on the same board — the shadowing bug, on one thread', () => {
    // Same defect as before, new shape: everyone now replies to one board, so "the newest
    // post" is a Steward tend report far more often than it is a Scout scan.
    const t = board([
      { authorId: 'trap-scout', at: now - 10 * 60_000, body: scanBody([{ symbol: 'INJUSD' }]) },
      { authorId: 'trap-steward', at: now - 60_000, body: '```json\n{"stage":"tend","positions":[]}\n```' }
    ])
    const found = newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })
    expect(found).not.toBeNull()
    expect(found!.work).toBe(1)
  })

  it('ignores the manager\'s run announcements, which carry no stage payload', () => {
    const t = board([
      { authorId: 'trap-scout', at: now - 10 * 60_000, body: scanBody([{ symbol: 'INJUSD' }]) },
      { authorId: 'manager', at: now - 60_000, body: '▶ Trap Setter started an interval run' }
    ])
    expect(newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })?.work).toBe(1)
  })

  it('refuses a scan that has gone stale rather than staging on old prices', () => {
    const t = board([{ authorId: 'trap-scout', at: now - 3 * HOUR, body: scanBody([{ symbol: 'INJUSD' }]) }])
    expect(newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })).toBeNull()
  })

  it('reports a zero-candidate scan as present but empty — that is not the same as missing', () => {
    const t = board([{ authorId: 'trap-scout', at: now - 10 * 60_000, body: scanBody([]) }])
    const found = newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })
    expect(found).not.toBeNull()
    expect(found!.work).toBe(0)
  })

  it('returns null when the upstream stage has not posted at all', () => {
    const t = board([{ authorId: 'manager', at: now, body: 'nothing to see' }])
    expect(newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })).toBeNull()
  })

  it('uses the board-recorded time, never a timestamp written inside the body', () => {
    const lying = '```json\n' + JSON.stringify({ stage: 'scan', at: '1999-01-01T00:00:00Z', candidates: [{ symbol: 'X' }] }) + '\n```'
    const t = board([{ authorId: 'trap-scout', at: now - 60_000, body: lying }])
    expect(newestStagePost(t, { authorId: 'trap-scout', now, maxAgeMs: 90 * 60_000 })?.work).toBe(1)
  })
})
