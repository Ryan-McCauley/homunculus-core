import { describe, it, expect, beforeEach, vi } from 'vitest'

// `claudeProcesses` is a plain module-level singleton with no reset API, so
// each test gets a fresh module instance rather than trying to drain the
// previous test's entries by hand.
const audit = vi.hoisted(() => ({ record: vi.fn(), actor: 'operator' }))
vi.mock('./auditLog', () => ({
  auditLog: { record: audit.record },
  currentActor: () => audit.actor,
}))

let claudeProcesses: (typeof import('./claudeProcesses'))['claudeProcesses']

async function freshModule() {
  vi.resetModules()
  const m = await import('./claudeProcesses')
  claudeProcesses = m.claudeProcesses
  return m
}

function registerOne(over: Partial<{ kind: string; label: string; detail: string; component: string; model: string }> = {}) {
  return claudeProcesses.register({
    kind: (over.kind ?? 'agent') as never,
    label: over.label ?? 'Desk Manager',
    detail: over.detail ?? 'running a scheduled shift',
    component: over.component ?? 'agent:manager',
    ...(over.model ? { model: over.model } : {}),
  })
}

beforeEach(async () => {
  audit.record.mockClear()
  audit.actor = 'operator'
  await freshModule()
})

describe('register', () => {
  it('assigns an id, a fresh AbortController, and defaults model to "default"', () => {
    const h = registerOne()
    expect(h.id).toMatch(/^cp_/)
    expect(h.controller).toBeInstanceOf(AbortController)
    expect(h.wasStopped()).toBe(false)
    const listed = claudeProcesses.list().find((p) => p.id === h.id)!
    expect(listed.model).toBe('default')
    expect(listed.kind).toBe('agent')
    expect(listed.label).toBe('Desk Manager')
    expect('stoppedBy' in listed).toBe(false)
    h.done()
  })

  it('keeps an explicit model instead of the default', () => {
    const h = registerOne({ model: 'claude-opus-4' })
    expect(claudeProcesses.list().find((p) => p.id === h.id)!.model).toBe('claude-opus-4')
    h.done()
  })

  it('done() removes the entry from the registry', () => {
    const h = registerOne()
    expect(claudeProcesses.count()).toBeGreaterThan(0)
    h.done()
    expect(claudeProcesses.list().find((p) => p.id === h.id)).toBeUndefined()
  })
})

describe('list', () => {
  it('sorts newest first by startedAt', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1000)
    const older = registerOne({ label: 'Older' })
    nowSpy.mockReturnValue(2000)
    const newer = registerOne({ label: 'Newer' })
    nowSpy.mockRestore()

    const ids = claudeProcesses.list().map((p) => p.id)
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id))
    older.done()
    newer.done()
  })

  it('never exposes the internal AbortController', () => {
    const h = registerOne()
    const listed = claudeProcesses.list().find((p) => p.id === h.id)!
    expect('controller' in listed).toBe(false)
    h.done()
  })
})

describe('stop', () => {
  it('returns not-running for an unknown id', () => {
    expect(claudeProcesses.stop('nope')).toEqual({ ok: false, error: 'not running (it may have just finished)' })
  })

  it('aborts the controller, records an audit entry, and returns the process view', () => {
    const h = registerOne({ label: 'SNIPER', component: 'skill:sniper' })
    audit.actor = 'agent:manager'
    const res = claudeProcesses.stop(h.id)
    expect(res.ok).toBe(true)
    expect(res.process!.id).toBe(h.id)
    expect('controller' in (res.process as object)).toBe(false)
    expect(h.controller.signal.aborted).toBe(true)
    expect(h.wasStopped()).toBe(true)

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'agent:manager',
      origin: 'http',
      action: 'claude.stop',
      resource: 'skill:sniper',
      meta: expect.objectContaining({ processId: h.id, kind: 'agent', label: 'SNIPER' }),
    }))
    h.done()
  })

  it('marks the entry with stoppedBy so it still shows up in list() until done()', () => {
    const h = registerOne()
    claudeProcesses.stop(h.id)
    const listed = claudeProcesses.list().find((p) => p.id === h.id)!
    expect(listed.stoppedBy).toBe('operator')
    h.done()
  })

  it('refuses a second stop on an already-stopping entry', () => {
    const h = registerOne()
    claudeProcesses.stop(h.id)
    audit.record.mockClear()
    const res = claudeProcesses.stop(h.id)
    expect(res).toEqual({ ok: false, error: 'already stopping' })
    expect(audit.record).not.toHaveBeenCalled()
    h.done()
  })
})

describe('stopAll', () => {
  it('stops every live entry and returns how many were signalled', () => {
    const a = registerOne({ label: 'A' })
    const b = registerOne({ label: 'B' })
    const n = claudeProcesses.stopAll()
    expect(n).toBe(2)
    expect(a.wasStopped()).toBe(true)
    expect(b.wasStopped()).toBe(true)
    a.done()
    b.done()
  })

  it('returns 0 when nothing is running', () => {
    expect(claudeProcesses.stopAll()).toBe(0)
  })
})

describe('count', () => {
  it('reflects the number of live (not-yet-done) entries', () => {
    expect(claudeProcesses.count()).toBe(0)
    const h1 = registerOne()
    expect(claudeProcesses.count()).toBe(1)
    const h2 = registerOne()
    expect(claudeProcesses.count()).toBe(2)
    h1.done()
    expect(claudeProcesses.count()).toBe(1)
    h2.done()
    expect(claudeProcesses.count()).toBe(0)
  })
})
