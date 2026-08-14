import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ArchiveEvent, ProactiveMeta } from '../shared/archive'

// `archiveHub` is a module-level singleton. `start()` is what actually loads
// the persisted ring and wires up the proactive listener, so every test gets
// a fresh module (vi.resetModules + dynamic import) and calls start() itself,
// following cryptoStrategySettings.test.ts's freshModule() pattern.

const fsState = vi.hoisted(() => ({ exists: false }))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  mkdirSync: vi.fn(),
}))

// stateStore is the persistence abstraction archive.ts actually reads/writes
// through (raw `fs` above is only used for the STORE_PATH/DATA_DIR existence
// checks that gate it). A Map-backed fake is simpler than mocking fs for the
// JSON itself.
const store = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
}))
vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (store.data.has(file) ? store.data.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { store.data.set(file, value) }),
    deleteJson: vi.fn((file: string) => { store.data.delete(file) }),
  },
}))

const chat = vi.hoisted(() => ({
  listener: null as ((id: string, text: string, meta?: ProactiveMeta) => void) | null,
}))
vi.mock('./chat', () => ({
  addProactiveListener: vi.fn((fn: (id: string, text: string, meta?: ProactiveMeta) => void) => {
    chat.listener = fn
    return () => { chat.listener = null }
  }),
}))

const history = vi.hoisted(() => ({
  enabled: false,
  recordEvent: vi.fn(() => Promise.resolve()),
  recentEvents: vi.fn(() => Promise.resolve([] as ArchiveEvent[])),
}))
vi.mock('./history', () => ({
  historyHub: history,
}))

beforeEach(() => {
  // save() is debounced behind a real 1s setTimeout (scheduleSave); fake timers
  // let the one test that cares about persistence fire it deterministically
  // without a real wait. Date is left real so emitted events keep distinct ids.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists = false
  store.data.clear()
  chat.listener = null
  history.enabled = false
  history.recordEvent.mockClear().mockResolvedValue(undefined)
  history.recentEvents.mockClear().mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

async function freshHub() {
  const mod = await import('./archive')
  mod.archiveHub.start()
  return mod.archiveHub
}

function emit(text: string, meta?: ProactiveMeta): void {
  chat.listener?.(`pro_${Date.now()}`, text, meta)
}

describe('start()', () => {
  it('registers a proactive listener', async () => {
    await freshHub()
    expect(chat.listener).not.toBeNull()
  })

  it('restores previously persisted events from the store', async () => {
    // Write through a first hub instance, let its debounced save() land, then
    // load a second hub instance over the same fake backing store and confirm
    // the event survived the "restart".
    await freshHub()
    emit('captain — restored event test')
    vi.advanceTimersByTime(1000) // fires scheduleSave's pending save()

    vi.resetModules()
    fsState.exists = true // load() only reads when existsSync(STORE_PATH) is true
    const mod2 = await import('./archive')
    mod2.archiveHub.start()
    const recent = await mod2.archiveHub.recent()
    expect(recent.some((e) => e.body === 'captain — restored event test')).toBe(true)
  })
})

describe('record (via the proactive listener)', () => {
  it('derives a title by stripping the "captain — " prefix and trailing punctuation', async () => {
    await freshHub()
    emit('captain — PizzINT anomaly. 3 venues flagged.')
    const [event] = await (await import('./archive')).archiveHub.recent()
    expect(event!.title).toBe('PizzINT anomaly')
  })

  it('falls back to SYSTEM/notice with a derived title when no meta is given', async () => {
    await freshHub()
    emit('just some text with no meta')
    const [event] = await (await import('./archive')).archiveHub.recent()
    expect(event!.source).toBe('SYSTEM')
    expect(event!.severity).toBe('notice')
  })

  it('uses the supplied meta when provided', async () => {
    await freshHub()
    emit('a osint escalation', { source: 'OSINT', severity: 'critical', title: 'Perimeter breach' })
    const [event] = await (await import('./archive')).archiveHub.recent()
    expect(event).toMatchObject({ source: 'OSINT', severity: 'critical', title: 'Perimeter breach' })
  })

  it('write-throughs every recorded event to historyHub.recordEvent', async () => {
    await freshHub()
    emit('an event for history')
    expect(history.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'an event for history' })
    )
  })

  it('notifies subscribers of new events', async () => {
    const hub = await freshHub()
    const fn = vi.fn()
    hub.subscribe(fn)
    emit('subscriber test')
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ body: 'subscriber test' }))
  })

  it('unsubscribe stops further notifications', async () => {
    const hub = await freshHub()
    const fn = vi.fn()
    const unsub = hub.subscribe(fn)
    unsub()
    emit('should not be seen')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('bounded ring buffer', () => {
  it('keeps at most 1000 events, dropping the oldest first', async () => {
    await freshHub()
    for (let i = 0; i < 1005; i++) emit(`event ${i}`)
    const recent = await (await import('./archive')).archiveHub.recent(2000)
    expect(recent.length).toBe(1000)
    // newest-first: the very first emitted event (index 0) should have been evicted.
    expect(recent.some((e) => e.body === 'event 0')).toBe(false)
    expect(recent.some((e) => e.body === 'event 1004')).toBe(true)
  })
})

describe('recent()', () => {
  it('returns newest first from the in-memory ring when historyHub is disabled', async () => {
    await freshHub()
    emit('first')
    emit('second')
    const recent = await (await import('./archive')).archiveHub.recent()
    expect(recent[0]!.body).toBe('second')
    expect(recent[1]!.body).toBe('first')
  })

  it('prefers historyHub when enabled and it returns rows', async () => {
    history.enabled = true
    const fromDb: ArchiveEvent[] = [
      { id: 'db_1', ts: 1, source: 'SYSTEM', severity: 'info', title: 'from db', body: 'from db' },
    ]
    history.recentEvents.mockResolvedValue(fromDb)
    await freshHub()
    emit('in-memory only')
    const recent = await (await import('./archive')).archiveHub.recent()
    expect(recent).toEqual(fromDb)
  })

  it('falls back to the in-memory ring when historyHub is enabled but errors', async () => {
    history.enabled = true
    history.recentEvents.mockRejectedValue(new Error('db down'))
    await freshHub()
    emit('fallback event')
    const recent = await (await import('./archive')).archiveHub.recent()
    expect(recent.some((e) => e.body === 'fallback event')).toBe(true)
  })

  it('falls back to the in-memory ring when historyHub is enabled but returns nothing', async () => {
    history.enabled = true
    history.recentEvents.mockResolvedValue([])
    await freshHub()
    emit('empty-db fallback')
    const recent = await (await import('./archive')).archiveHub.recent()
    expect(recent.some((e) => e.body === 'empty-db fallback')).toBe(true)
  })
})
