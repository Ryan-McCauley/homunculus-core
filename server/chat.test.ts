import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HaSnapshot, HaEntity } from '../shared/homeassistant'
import type { ExecResult } from './routines'

// chat.ts reads HOMUNCULUS_MODEL into a module-level constant at import time, and its
// exports (chatStatus, ChatSession, ProactiveMonitor) are otherwise stateless/singleton —
// so every test gets a fresh module instance, matching the pattern used elsewhere for
// modules with import-time or module-scope state.

const haMock = vi.hoisted(() => ({
  getLatest: vi.fn<() => HaSnapshot | null>(() => null),
  subscribe: vi.fn(),
}))
vi.mock('./homeassistant', () => ({ haHub: haMock }))

const claudeProcState = vi.hoisted(() => ({ wasStopped: false }))
vi.mock('./claudeProcesses', () => ({
  claudeProcesses: {
    register: vi.fn(() => ({
      controller: new AbortController(),
      done: vi.fn(),
      wasStopped: () => claudeProcState.wasStopped,
    })),
  },
}))

const routinesMock = vi.hoisted(() => ({
  executeRoutine: vi.fn<(name: string) => Promise<ExecResult>>(async (name) => ({ ok: true, label: `routine:${name}` })),
  executeHaCommand: vi.fn<(entityId: string, service: string, data: Record<string, unknown>) => Promise<ExecResult>>(
    async (entityId) => ({ ok: true, label: `ha:${entityId}` })
  ),
  routinesSummary: vi.fn(() => '- goodnight: turns things off'),
  ROUTINES: {},
}))
vi.mock('./routines', () => routinesMock)

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  claudeProcState.wasStopped = false
  haMock.getLatest.mockReturnValue(null)
  routinesMock.executeRoutine.mockImplementation(async (name: string) => ({ ok: true, label: `routine:${name}` }))
  routinesMock.executeHaCommand.mockImplementation(async (entityId: string) => ({ ok: true, label: `ha:${entityId}` }))
  routinesMock.routinesSummary.mockReturnValue('- goodnight: turns things off')
})

async function freshChat() {
  return import('./chat')
}

function fakeQuery(messages: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const m of messages) yield m
  })()
}

function textDelta(text: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }
}

function resultOk(overrides: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', ...overrides }
}

function haSnapshot(entities: Partial<HaEntity>[], connected = true): HaSnapshot {
  return {
    ts: Date.now(),
    connected,
    url: null,
    tempUnit: '°F',
    climate: [],
    entities: entities.map((e) => ({
      entityId: e.entityId ?? '', domain: 'sensor', name: '', state: e.state ?? '',
      unit: null, deviceClass: null, attributes: {}, lastChanged: null,
    })),
    devices: [],
  } as HaSnapshot
}

describe('chatStatus', () => {
  it('reports "local session" when no model override is set', async () => {
    delete process.env['HOMUNCULUS_MODEL']
    const { chatStatus } = await freshChat()
    expect(chatStatus()).toEqual({ configured: true, model: 'local session' })
  })

  it('reports the configured model', async () => {
    process.env['HOMUNCULUS_MODEL'] = 'claude-opus-5'
    const { chatStatus } = await freshChat()
    expect(chatStatus()).toEqual({ configured: true, model: 'claude-opus-5' })
    delete process.env['HOMUNCULUS_MODEL']
  })
})

describe('proactive listener registry', () => {
  it('fans a broadcast out to every registered listener', async () => {
    const { addProactiveListener, broadcastProactive } = await freshChat()
    const a = vi.fn()
    const b = vi.fn()
    addProactiveListener(a)
    addProactiveListener(b)
    broadcastProactive('washer done', { source: 'HOME', severity: 'notice' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    const [id, text, meta] = a.mock.calls[0]!
    expect(text).toBe('washer done')
    expect(meta).toEqual({ source: 'HOME', severity: 'notice' })
    expect(id).toMatch(/^pro_\d+_\d+$/)
  })

  it('gives every broadcast a distinct id even within the same millisecond', async () => {
    // The id keys the client's React list; homewatch fires several events per
    // snapshot, so a bare Date.now() collided and toasts were silently dropped.
    const { addProactiveListener, broadcastProactive } = await freshChat()
    const seen = vi.fn()
    addProactiveListener(seen)
    for (let i = 0; i < 5; i++) broadcastProactive(`event ${i}`)
    const ids = seen.mock.calls.map((c) => c[0] as string)
    expect(new Set(ids).size).toBe(5)
  })

  it('keeps notifying the remaining listeners when one throws', async () => {
    // A listener that throws must not abort the fan-out, and must not escape into
    // the caller — several callers are timer-driven, where that kills the process.
    const { addProactiveListener, broadcastProactive } = await freshChat()
    const boom = vi.fn(() => { throw new Error('listener exploded') })
    const after = vi.fn()
    addProactiveListener(boom)
    addProactiveListener(after)
    expect(() => broadcastProactive('still fine')).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('stops notifying a listener once unregistered', async () => {
    const { addProactiveListener, broadcastProactive } = await freshChat()
    const fn = vi.fn()
    const unregister = addProactiveListener(fn)
    unregister()
    broadcastProactive('hello')
    expect(fn).not.toHaveBeenCalled()
  })

  it('gives every broadcast within the same call a unique-enough id and passes meta through as optional', async () => {
    const { addProactiveListener, broadcastProactive } = await freshChat()
    const fn = vi.fn()
    addProactiveListener(fn)
    broadcastProactive('no meta here')
    expect(fn).toHaveBeenCalledWith(expect.stringMatching(/^pro_/), 'no meta here', undefined)
  })
})

describe('ChatSession.streamTurn', () => {
  it('streams text deltas, then sends a done message', async () => {
    const { ChatSession } = await freshChat()
    sdk.query.mockImplementation(() => fakeQuery([textDelta('Ack'), textDelta('nowledged.'), resultOk()]))
    const send = vi.fn()
    const session = new ChatSession(send)
    await session.streamTurn('turn-1', 'lights off', null)
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'delta', id: 'turn-1', delta: 'Acknowledged.' })
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'done', id: 'turn-1', stopReason: 'end_turn' })
  })

  it('resumes the session id from a prior turn on the next call', async () => {
    const { ChatSession } = await freshChat()
    sdk.query.mockImplementation(() => fakeQuery([resultOk({ session_id: 'sess-42' })]))
    const session = new ChatSession(vi.fn())
    await session.streamTurn('t1', 'hi', null)
    await session.streamTurn('t2', 'hi again', null)
    const secondCallOpts = sdk.query.mock.calls[1]![0] as { options: { resume?: string } }
    expect(secondCallOpts.options.resume).toBe('sess-42')
  })

  it('executes a routine exec block and appends the result line', async () => {
    const { ChatSession } = await freshChat()
    const body = 'Acknowledged.<exec>{"type":"routine","name":"goodnight"}</exec>'
    sdk.query.mockImplementation(() => fakeQuery([textDelta(body), resultOk()]))
    const send = vi.fn()
    await new ChatSession(send).streamTurn('t1', 'goodnight', null)
    expect(routinesMock.executeRoutine).toHaveBeenCalledWith('goodnight')
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'delta', id: 't1', delta: 'Acknowledged.' })
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'delta', id: 't1', delta: '\n\n[✓ routine:goodnight]' })
  })

  it('executes an HA exec block and reports a failure result', async () => {
    routinesMock.executeHaCommand.mockResolvedValue({ ok: false, label: 'charger', error: 'entity not found' })
    const { ChatSession } = await freshChat()
    const body = 'Working.<exec>{"type":"ha","entityId":"switch.x","service":"switch.turn_on"}</exec>'
    sdk.query.mockImplementation(() => fakeQuery([textDelta(body), resultOk()]))
    const send = vi.fn()
    await new ChatSession(send).streamTurn('t1', 'turn on x', null)
    expect(routinesMock.executeHaCommand).toHaveBeenCalledWith('switch.x', 'switch.turn_on', {})
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'delta', id: 't1', delta: '\n\n[✗ charger: entity not found]' })
  })

  it('drops a malformed exec block instead of throwing', async () => {
    const { ChatSession } = await freshChat()
    const body = 'Acknowledged.<exec>{not json</exec>'
    sdk.query.mockImplementation(() => fakeQuery([textDelta(body), resultOk()]))
    const send = vi.fn()
    await new ChatSession(send).streamTurn('t1', 'do a thing', null)
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'done', id: 't1', stopReason: 'end_turn' })
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })

  it('reports a friendlier message for an authentication failure', async () => {
    const { ChatSession } = await freshChat()
    sdk.query.mockImplementation(() => fakeQuery([resultOk({ subtype: 'error', is_error: true, result: '401 unauthorized' })]))
    const send = vi.fn()
    await new ChatSession(send).streamTurn('t1', 'hi', null)
    expect(send).toHaveBeenCalledWith({
      ch: 'chat', type: 'error', id: 't1',
      message: expect.stringMatching(/claude setup-token/),
    })
  })

  it('surfaces a non-auth failure message verbatim', async () => {
    const { ChatSession } = await freshChat()
    sdk.query.mockImplementation(() => fakeQuery([resultOk({ subtype: 'error', is_error: true, result: 'model overloaded' })]))
    const send = vi.fn()
    await new ChatSession(send).streamTurn('t1', 'hi', null)
    expect(send).toHaveBeenCalledWith({ ch: 'chat', type: 'error', id: 't1', message: 'model overloaded' })
  })

  it('reads live HA state into the prompt when available', async () => {
    haMock.getLatest.mockReturnValue(haSnapshot([{ entityId: 'sensor.voltaire_battery_level', state: '80' }]))
    const { ChatSession } = await freshChat()
    sdk.query.mockImplementation(() => fakeQuery([resultOk()]))
    await new ChatSession(vi.fn()).streamTurn('t1', 'battery?', null)
    const promptArg = sdk.query.mock.calls[0]![0] as { prompt: string }
    expect(promptArg.prompt).toMatch(/Voltaire: 80%/)
  })
})

describe('ProactiveMonitor', () => {
  it('does not start its HA subscription twice', async () => {
    const { proactiveMonitor } = await freshChat()
    proactiveMonitor.start()
    proactiveMonitor.start()
    expect(haMock.subscribe).toHaveBeenCalledTimes(1)
  })

  it('debounces and fires a check when the washer transitions from running to end', async () => {
    vi.useFakeTimers()
    try {
      const { proactiveMonitor } = await freshChat()
      sdk.query.mockImplementation(() => fakeQuery([{ type: 'result', result: 'Washer cycle complete, Captain.' }]))
      proactiveMonitor.start()
      const onUpdate = haMock.subscribe.mock.calls[0]![0] as (s: HaSnapshot) => void

      onUpdate(haSnapshot([{ entityId: 'sensor.washer_current_status', state: 'run' }]))
      onUpdate(haSnapshot([{ entityId: 'sensor.washer_current_status', state: 'end' }]))

      expect(sdk.query).not.toHaveBeenCalled() // still inside the debounce window
      await vi.advanceTimersByTimeAsync(45_000)
      expect(sdk.query).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire for a washer that was already idle', async () => {
    vi.useFakeTimers()
    try {
      const { proactiveMonitor } = await freshChat()
      sdk.query.mockImplementation(() => fakeQuery([{ type: 'result', result: 'SILENT' }]))
      proactiveMonitor.start()
      const onUpdate = haMock.subscribe.mock.calls[0]![0] as (s: HaSnapshot) => void
      onUpdate(haSnapshot([{ entityId: 'sensor.washer_current_status', state: 'off' }]))
      onUpdate(haSnapshot([{ entityId: 'sensor.washer_current_status', state: 'end' }]))
      await vi.advanceTimersByTimeAsync(45_000)
      expect(sdk.query).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not broadcast when the model responds SILENT', async () => {
    vi.useFakeTimers()
    try {
      const { proactiveMonitor, addProactiveListener } = await freshChat()
      sdk.query.mockImplementation(() => fakeQuery([{ type: 'result', result: 'SILENT' }]))
      const listener = vi.fn()
      addProactiveListener(listener)
      proactiveMonitor.start()
      const onUpdate = haMock.subscribe.mock.calls[0]![0] as (s: HaSnapshot) => void
      onUpdate(haSnapshot([{ entityId: 'sensor.voltaire_charging', state: 'charging' }]))
      onUpdate(haSnapshot([{ entityId: 'sensor.voltaire_charging', state: 'not_charging' }]))
      await vi.advanceTimersByTimeAsync(45_000)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('broadcasts a genuine alert and enforces the cooldown against a second one', async () => {
    vi.useFakeTimers()
    try {
      const { proactiveMonitor, addProactiveListener } = await freshChat()
      sdk.query.mockImplementation(() => fakeQuery([{ type: 'result', result: 'Charging complete, Captain.' }]))
      const listener = vi.fn()
      addProactiveListener(listener)
      proactiveMonitor.start()
      const onUpdate = haMock.subscribe.mock.calls[0]![0] as (s: HaSnapshot) => void

      onUpdate(haSnapshot([{ entityId: 'sensor.voltaire_charging', state: 'charging' }]))
      onUpdate(haSnapshot([{ entityId: 'sensor.voltaire_charging', state: 'not_charging' }]))
      await vi.advanceTimersByTimeAsync(45_000)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0]![1]).toBe('Charging complete, Captain.')

      // A second significant change immediately after should still be suppressed by
      // the 5-minute cooldown between broadcasts.
      onUpdate(haSnapshot([{ entityId: 'sensor.voltaire_charging', state: 'charging' }]))
      onUpdate(haSnapshot([{ entityId: 'sensor.voltaire_charging', state: 'not_charging' }]))
      await vi.advanceTimersByTimeAsync(45_000)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fires immediately via triggerNow, bypassing the debounce', async () => {
    const { proactiveMonitor } = await freshChat()
    sdk.query.mockImplementation(() => fakeQuery([{ type: 'result', result: 'SILENT' }]))
    proactiveMonitor.triggerNow(haSnapshot([]))
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(1))
  })

  it('ignores updates while HA reports disconnected', async () => {
    const { proactiveMonitor } = await freshChat()
    proactiveMonitor.start()
    const onUpdate = haMock.subscribe.mock.calls[0]![0] as (s: HaSnapshot) => void
    onUpdate(haSnapshot([{ entityId: 'sensor.washer_current_status', state: 'run' }], false))
    onUpdate(haSnapshot([{ entityId: 'sensor.washer_current_status', state: 'end' }], false))
    expect(sdk.query).not.toHaveBeenCalled()
  })
})
