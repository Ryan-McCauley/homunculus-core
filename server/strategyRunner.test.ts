import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'

// strategyRunner.ts drives the Agent SDK's query() to run a strategy skill headlessly,
// tracked through a small state machine (idle -> running -> done/error) on a
// module-level singleton, plus a persisted "enabled strategy" preference computed once
// at import time. None of the real SDK, disk, or audit chain should run here — query()
// is mocked to a controllable fake async generator so we can drive the state machine
// deterministically, per the task brief's instruction not to exercise real SDK behavior.
const fsState = vi.hoisted(() => ({ exists: false }))
const store = vi.hoisted(() => ({ map: new Map<string, unknown>(), saveRun: vi.fn(() => Promise.resolve()) }))
const audit = vi.hoisted(() => ({ note: vi.fn(), record: vi.fn() }))
const cpState = vi.hoisted(() => ({
  wasStopped: false,
  registered: [] as { component: string; label: string; kind: string }[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  mkdirSync: vi.fn(),
}))

vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (store.map.has(file) ? store.map.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { store.map.set(file, value); fsState.exists = true }),
    deleteJson: vi.fn((file: string) => { store.map.delete(file) }),
    saveRun: store.saveRun,
  },
}))

vi.mock('./auditLog', () => ({
  auditLog: audit,
  withActor: <T,>(_actor: string, fn: () => T) => fn(),
  currentActor: () => 'operator',
}))

vi.mock('./claudeProcesses', () => ({
  claudeProcesses: {
    register: vi.fn((input: { component: string; label: string; kind: string }) => {
      cpState.registered.push(input)
      const controller = new AbortController()
      return {
        id: 'cp_test',
        controller,
        done: vi.fn(),
        wasStopped: () => cpState.wasStopped,
      }
    }),
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists = false
  store.map.clear()
  store.saveRun.mockClear()
  cpState.wasStopped = false
  cpState.registered = []
})

afterEach(() => {
  vi.useRealTimers()
})

async function freshModule() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const mod = await import('./strategyRunner')
  return { mod, query: vi.mocked(sdk.query) }
}

/** A fake `query()` response: an async generator yielding the given messages in order,
 *  then completing. Mirrors the shape strategyRunner.ts reads: stream_event content
 *  blocks for activity text, and a terminal `result` message for success/failure. */
async function* fakeResponse(messages: unknown[]): AsyncGenerator<unknown> {
  for (const m of messages) yield m
}

/** A `query()` response that blocks until `release()` is called — for exercising the
 *  single-flight guard, where a run must still be "in flight" when start() is called again. */
function controlledResponse(): { iterable: AsyncIterable<unknown>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  async function* gen(): AsyncGenerator<unknown> {
    await gate
  }
  return { iterable: gen(), release }
}

const toolUseEvent = (name: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', content_block: { type: 'tool_use', name } },
})
const textDeltaEvent = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
const successResult = { type: 'result', subtype: 'success', is_error: false }
const failureResult = (result: string) => ({ type: 'result', subtype: 'error_max_turns', is_error: true, result })

describe('isStrategyId', () => {
  it('is true for every real strategy id and false otherwise', async () => {
    const { mod } = await freshModule()
    for (const id of Object.keys(mod.STRATEGIES)) expect(mod.isStrategyId(id)).toBe(true)
    expect(mod.isStrategyId('nope')).toBe(false)
    expect(mod.isStrategyId(42)).toBe(false)
    expect(mod.isStrategyId(undefined)).toBe(false)
  })
})

describe('STRATEGIES catalog', () => {
  it('maps every strategy id to a slash-command prompt and a label', async () => {
    const { mod } = await freshModule()
    expect(mod.STRATEGIES['crypto-strategy']).toEqual({ prompt: '/crypto-strategy', label: 'CRYPTO STRATEGY' })
    expect(mod.STRATEGIES['btc-ladder']).toEqual({ prompt: '/btc-ladder', label: 'BTC LADDER' })
    expect(Object.keys(mod.STRATEGIES)).toHaveLength(9)
  })
})

const ENABLED_STRATEGY_FILE = join(process.cwd(), 'data', 'crypto', 'enabled-strategy.json')

describe('getEnabledStrategy / setEnabledStrategy', () => {
  it('defaults to crypto-strategy when nothing is persisted', async () => {
    const { mod } = await freshModule()
    expect(mod.getEnabledStrategy()).toBe('crypto-strategy')
  })

  it('loads a persisted enabled strategy at import time', async () => {
    fsState.exists = true
    store.map.set(ENABLED_STRATEGY_FILE, { strategy: 'sniper' })
    const { mod } = await freshModule()
    expect(mod.getEnabledStrategy()).toBe('sniper')
  })

  it('ignores a persisted value that is not a real strategy id, falling back to default', async () => {
    fsState.exists = true
    store.map.set(ENABLED_STRATEGY_FILE, { strategy: 'not-real' })
    const { mod } = await freshModule()
    expect(mod.getEnabledStrategy()).toBe('crypto-strategy')
  })

  it('setEnabledStrategy updates the in-memory value, persists it, and audits the change', async () => {
    const { mod } = await freshModule()
    const result = mod.setEnabledStrategy('oversold')
    expect(result).toBe('oversold')
    expect(mod.getEnabledStrategy()).toBe('oversold')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'strategy.enabled',
      resource: 'strategy:oversold',
      before: { strategy: 'crypto-strategy' },
      after: { strategy: 'oversold' },
    }))
  })
})

describe('StrategyRunner — initial state', () => {
  it('starts idle with no strategy run yet', async () => {
    const { mod } = await freshModule()
    const status = mod.strategyRunner.getStatus()
    expect(status.state).toBe('idle')
    expect(status.startedAt).toBeNull()
    expect(status.endedAt).toBeNull()
    expect(status.error).toBeNull()
    expect(mod.strategyRunner.isRunning()).toBe(false)
    expect(mod.strategyRunner.getLastRunAt()).toBeNull()
  })
})

describe('StrategyRunner — run lifecycle: success', () => {
  it('transitions idle -> running -> done, tracking activity from the stream', async () => {
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([
      toolUseEvent('Read'),
      textDeltaEvent('line one\nfinal reasoning line'),
      successResult,
    ]) as never)

    const started = mod.strategyRunner.start('sniper')
    expect(started).toBe(true)
    expect(mod.strategyRunner.getStatus().state).toBe('running')
    expect(mod.strategyRunner.getStatus().strategy).toBe('sniper')

    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))

    const status = mod.strategyRunner.getStatus()
    expect(status.state).toBe('done')
    expect(status.activity).toBe('Strategy run complete.')
    expect(status.endedAt).not.toBeNull()
    expect(status.error).toBeNull()
  })

  it('calls query() with the strategy prompt and a sanitized env (no API key leakage)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'super-secret'
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([successResult]) as never)
    mod.strategyRunner.start('oversold')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '/oversold',
      options: expect.objectContaining({
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        env: expect.objectContaining({ HOMUNCULUS_SKILL: 'skill:oversold' }),
      }),
    }))
    const call = query.mock.calls[0]![0] as { options: { env: Record<string, string> } }
    expect(call.options.env['ANTHROPIC_API_KEY']).toBeUndefined()
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('registers with claudeProcesses and calls done() once the run finishes', async () => {
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([successResult]) as never)
    mod.strategyRunner.start('firecracker')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
    expect(cpState.registered).toHaveLength(1)
    expect(cpState.registered[0]!.component).toBe('skill:firecracker')
  })

  it('mirrors the run into the durable timeline via stateStore.saveRun on start and finish', async () => {
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([successResult]) as never)
    mod.strategyRunner.start('sniper')
    expect(store.saveRun).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', component: 'skill:sniper' }))
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
    expect(store.saveRun).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'done' }))
  })
})

describe('StrategyRunner — run lifecycle: error', () => {
  it('transitions to error when the result message reports failure', async () => {
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([failureResult('ran out of turns')]) as never)
    mod.strategyRunner.start('sniper')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
    const status = mod.strategyRunner.getStatus()
    expect(status.state).toBe('error')
    expect(status.error).toBe('ran out of turns')
    expect(status.activity).toBe('Strategy run failed.')
  })

  it('rewrites an authentication-shaped error into an actionable message', async () => {
    const { mod, query } = await freshModule()
    query.mockImplementation(() => { throw new Error('401 unauthorized') })
    mod.strategyRunner.start('sniper')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
    expect(mod.strategyRunner.getStatus().error).toMatch(/claude setup-token/)
  })

  it('treats an aborted (operator-stopped) run as "done", not "error"', async () => {
    const { mod, query } = await freshModule()
    query.mockImplementation(() => { throw new Error('aborted') })
    cpState.wasStopped = true
    mod.strategyRunner.start('sniper')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
    const status = mod.strategyRunner.getStatus()
    expect(status.state).toBe('done')
    expect(status.activity).toBe('Stopped before completion.')
    expect(status.error).toBeNull()
  })
})

describe('StrategyRunner — single-flight guard', () => {
  it('rejects a second start() while a run is already in flight', async () => {
    const { mod, query } = await freshModule()
    const { iterable, release } = controlledResponse()
    query.mockReturnValue(iterable as never)

    expect(mod.strategyRunner.start('sniper')).toBe(true)
    expect(mod.strategyRunner.getStatus().state).toBe('running')
    expect(mod.strategyRunner.start('oversold')).toBe(false)
    // The rejected start must not have clobbered which strategy is actually running.
    expect(mod.strategyRunner.getStatus().strategy).toBe('sniper')

    release()
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
  })

  it('allows a new start() once the previous run has finished', async () => {
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([successResult]) as never)
    mod.strategyRunner.start('sniper')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))

    query.mockReturnValue(fakeResponse([successResult]) as never)
    expect(mod.strategyRunner.start('oversold')).toBe(true)
    expect(mod.strategyRunner.getStatus().strategy).toBe('oversold')
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
  })

  it('records an audit entry for each accepted run start', async () => {
    const { mod, query } = await freshModule()
    query.mockReturnValue(fakeResponse([successResult]) as never)
    mod.strategyRunner.start('sniper')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'strategy.run.start',
      resource: 'strategy:sniper',
    }))
    await vi.waitFor(() => expect(mod.strategyRunner.getStatus().state).not.toBe('running'))
  })
})

describe('StrategyRunner — external (headless routine) heartbeats', () => {
  it('reports as running/routine while an external heartbeat is fresh', async () => {
    const { mod } = await freshModule()
    mod.strategyRunner.externalHeartbeat('begin', 'trapline')
    expect(mod.strategyRunner.isRunning()).toBe(true)
    const status = mod.strategyRunner.getStatus()
    expect(status.state).toBe('running')
    expect(status.source).toBe('routine')
    expect(status.strategy).toBe('trapline')
  })

  it('blocks a manual start() while an external routine is active', async () => {
    const { mod } = await freshModule()
    mod.strategyRunner.externalHeartbeat('begin', 'trapline')
    expect(mod.strategyRunner.start('sniper')).toBe(false)
  })

  it('clears on an explicit "end" heartbeat', async () => {
    const { mod } = await freshModule()
    mod.strategyRunner.externalHeartbeat('begin', 'trapline')
    mod.strategyRunner.externalHeartbeat('end')
    expect(mod.strategyRunner.isRunning()).toBe(false)
  })

  it('treats a heartbeat older than the TTL as a dead run', async () => {
    vi.useFakeTimers()
    const { mod } = await freshModule()
    mod.strategyRunner.externalHeartbeat('begin', 'trapline')
    expect(mod.strategyRunner.isRunning()).toBe(true)
    vi.advanceTimersByTime(7 * 60 * 1000) // past the 6-minute TTL
    expect(mod.strategyRunner.isRunning()).toBe(false)
  })

  it('a fresh "beat" refreshes the TTL instead of letting it expire', async () => {
    vi.useFakeTimers()
    const { mod } = await freshModule()
    mod.strategyRunner.externalHeartbeat('begin', 'trapline')
    vi.advanceTimersByTime(5 * 60 * 1000)
    mod.strategyRunner.externalHeartbeat('beat', 'trapline')
    vi.advanceTimersByTime(5 * 60 * 1000) // 10 min total, but only 5 since the last beat
    expect(mod.strategyRunner.isRunning()).toBe(true)
  })
})
