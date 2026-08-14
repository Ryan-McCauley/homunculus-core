import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as ind from '../shared/indicators'
import type { Candle } from '../shared/indicators'
import type { AlertContext, NewAlertInput } from './cryptoAlerts'

// `alertStore` is a module-level singleton constructed at import time from load(),
// which reads the alerts file via `fs`. Each test gets a clean singleton by
// resetting the module registry and re-importing over a controllable virtual file.
const fsState = vi.hoisted(() => ({ exists: false, content: '' }))

// The audit log is a real append-only file writer; these tests must not touch it.
// Mocking it also lets each test assert what the store told the permanent record,
// which is the point of instrumenting the mutators in the first place.
const audit = vi.hoisted(() => ({ record: vi.fn(), note: vi.fn(), actor: 'operator' }))
vi.mock('./auditLog', () => ({
  auditLog: audit,
  withActor: <T,>(_actor: string, fn: () => T) => fn(),
  // Mutable so a test can arm an alert *as* an agent and exercise the authority gate.
  currentActor: () => audit.actor,
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  readFileSync: vi.fn(() => fsState.content),
  writeFileSync: vi.fn((_path: string, data: string) => { fsState.content = data; fsState.exists = true }),
  mkdirSync: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  audit.actor = 'operator'
  fsState.exists = false
  fsState.content = ''
})

async function freshStore() {
  const mod = await import('./cryptoAlerts')
  return mod.alertStore
}

function candle(ts: number, o: number, h: number, l: number, c: number, v: number): Candle {
  return [ts, o, h, l, c, v]
}

/** 32 monotonically rising closes — long enough to clear the 30-bar floor, and
 *  strictly increasing so a "crosses above" threshold set to the previous
 *  reading is guaranteed to fire on the latest bar. */
function risingCandles(n = 32): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i
    return candle(i * 3_600_000, close - 0.5, close + 1, close - 1, close, 100)
  })
}

/** Wilder RSI textbook seed followed by a steady climb — long enough that RSI is
 *  still rising (not yet saturated at 100) on the final bar. See probe in dev notes:
 *  last two RSI readings are strictly increasing at ~90.2 → ~90.9. */
function rsiRisingCandles(): Candle[] {
  const seed = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]
  const closes = [...seed]
  let last = seed[seed.length - 1]!
  for (let i = 0; i < 17; i++) { last += 0.3; closes.push(last) }
  return closes.map((c, i) => candle(i * 3_600_000, c - 0.1, c + 0.2, c - 0.2, c, 100))
}

/** Volume spike on the final bar relative to a flat 20-bar average. 32 bars total
 *  to clear the evaluator's 30-bar history floor. */
function volumeSpikeCandles(n = 32): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i * 3_600_000, 100, 101, 99, 100, i === n - 1 ? 500 : 50))
}

function makeCtx(overrides: Partial<{
  candles: Candle[]
  signal: { direction: string; entryQuality: string; confluence: number } | null
}> = {}) {
  const notify = vi.fn()
  const stage = vi.fn()
  const ctx: AlertContext = {
    candles: () => overrides.candles ?? risingCandles(),
    lastPrice: () => 100,
    signal: () => overrides.signal ?? null,
    stage,
    notify,
  }
  return { ctx, notify, stage }
}

const priceAboveInput = (value: number): NewAlertInput =>
  ({ symbol: 'btcusd', source: 'price', condition: 'above', value, tf: '1hr', action: 'notify' })

describe('create', () => {
  it('uppercases the symbol and fills in defaults', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100))
    expect('error' in a).toBe(false)
    const alert = a as any
    expect(alert.symbol).toBe('BTCUSD')
    expect(alert.stageUsd).toBe(20)
    expect(alert.once).toBe(false)
    expect(alert.armed).toBe(true)
    expect(alert.fireCount).toBe(0)
    expect(alert.lastFiredAt).toBeNull()
  })

  it('does not leak the internal bar-dedup stamp to the caller', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100)) as any
    expect('lastFiredBarTs' in a).toBe(false)
  })

  it('keeps an explicit positive stageUsd instead of the 20 default', async () => {
    const store = await freshStore()
    const a = store.create({ ...priceAboveInput(100), stageUsd: 50 }) as any
    expect(a.stageUsd).toBe(50)
  })

  it('rejects an unknown source/condition pair', async () => {
    const store = await freshStore()
    const result = store.create({ ...priceAboveInput(100), source: 'price', condition: 'not-a-real-condition' })
    expect(result).toHaveProperty('error')
  })

  it('rejects a value-needing condition with no numeric value', async () => {
    const store = await freshStore()
    const result = store.create({ ...priceAboveInput(100), value: null })
    expect(result).toHaveProperty('error')
  })

  it('persists the new alert to disk', async () => {
    const store = await freshStore()
    store.create(priceAboveInput(100))
    expect(fsState.exists).toBe(true)
    expect(JSON.parse(fsState.content)).toHaveLength(1)
  })
})

describe('list / listFor', () => {
  it('strips the bar-dedup stamp from every listed alert', async () => {
    const store = await freshStore()
    store.create(priceAboveInput(100))
    for (const a of store.list()) expect('lastFiredBarTs' in a).toBe(false)
  })

  it('filters by symbol, uppercasing the query', async () => {
    const store = await freshStore()
    store.create(priceAboveInput(100))
    store.create({ ...priceAboveInput(100), symbol: 'ethusd' })
    expect(store.listFor('btcusd')).toHaveLength(1)
    expect(store.listFor('BTCUSD')[0]!.symbol).toBe('BTCUSD')
  })
})

describe('remove', () => {
  it('removes a known alert and persists', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100)) as any
    expect(store.remove(a.id)).toBe(true)
    expect(store.list()).toHaveLength(0)
  })

  it('returns false for an unknown id', async () => {
    const store = await freshStore()
    expect(store.remove('nope')).toBe(false)
  })
})

describe('setArmed', () => {
  it('toggles armed and returns false for an unknown id', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100)) as any
    expect(store.setArmed(a.id, false)).toBe(true)
    expect(store.listFor('BTCUSD')[0]!.armed).toBe(false)
    expect(store.setArmed('nope', true)).toBe(false)
  })
})

describe('evaluate — dedup, dispatch, and arming', () => {
  it('fires notify exactly once per bar even across repeated evaluate() calls', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    const a = store.create({ ...priceAboveInput(pair[0]), action: 'notify' }) as any
    const { ctx, notify, stage } = makeCtx({ candles })

    store.evaluate(ctx)
    store.evaluate(ctx)
    store.evaluate(ctx)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(stage).not.toHaveBeenCalled()
    const after = store.listFor('BTCUSD')[0]!
    expect(after.fireCount).toBe(1)
    expect(after.lastFiredAt).not.toBeNull()
    expect(after.lastNote).toMatch(/crossed above/)
    expect(a.id).toBe(after.id)
  })

  it('fires again once the underlying bar advances', async () => {
    // Uses volume/spike rather than a price cross: a cross-above condition only
    // fires at the moment of crossing, so a monotonically rising series never
    // re-triggers it on a later bar — that would be testing the wrong thing.
    // A level check like volume/spike re-fires on any bar that still clears it,
    // which is what exercises the per-bar dedup stamp instead of the cross logic.
    const store = await freshStore()
    const candles = volumeSpikeCandles()
    store.create({ symbol: 'SOLUSD', source: 'volume', condition: 'spike', value: 3, tf: '1hr', action: 'notify' })
    const { ctx, notify } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)

    // Identical last bar → same bar timestamp → must not re-fire.
    store.evaluate(makeCtx({ candles }).ctx)
    expect(notify).toHaveBeenCalledTimes(1)

    // A new bar with its own spike → new bar timestamp → fires again.
    const n = candles.length
    const extended = [...candles, candle(n * 3_600_000, 100, 101, 99, 100, 500)]
    const { ctx: ctx2, notify: notify2 } = makeCtx({ candles: extended })
    store.evaluate(ctx2)
    expect(notify2).toHaveBeenCalledTimes(1)
  })

  it('stages a trade for stage-buy/stage-sell actions, never for notify', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    const a = store.create({ ...priceAboveInput(pair[0]), action: 'stage-buy', stageUsd: 33 }) as any
    const { ctx, stage } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(stage).toHaveBeenCalledTimes(1)
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTCUSD', side: 'buy', usd: 33, tag: `alert:${a.id}`,
    }))
  })

  it('disarms a once-alert after it fires, and never fires a disarmed alert', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create({ ...priceAboveInput(pair[0]), action: 'notify', once: true })
    const { ctx, notify } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(store.listFor('BTCUSD')[0]!.armed).toBe(false)

    // Still-true condition, but the alert is now disarmed — must not fire again.
    const { ctx: ctx2, notify: notify2 } = makeCtx({ candles })
    store.evaluate(ctx2)
    expect(notify2).not.toHaveBeenCalled()
  })

  it('re-arming clears the bar stamp, allowing an immediate re-fire on the same bar', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    const a = store.create({ ...priceAboveInput(pair[0]), action: 'notify' }) as any
    const { ctx, notify } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)

    store.setArmed(a.id, false)
    store.setArmed(a.id, true)
    const { ctx: ctx2, notify: notify2 } = makeCtx({ candles })
    store.evaluate(ctx2)
    expect(notify2).toHaveBeenCalledTimes(1)
  })

  it('never evaluates a manually disarmed alert', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    const a = store.create({ ...priceAboveInput(pair[0]), action: 'notify' }) as any
    store.setArmed(a.id, false)
    const { ctx, notify } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not fire on fewer than 30 bars of history', async () => {
    const store = await freshStore()
    const shortCandles = risingCandles(10)
    const pair = ind.lastPair(ind.closesOf(shortCandles))
    store.create({ ...priceAboveInput(pair ? pair[0] : 100), action: 'notify' })
    const { ctx, notify } = makeCtx({ candles: shortCandles })
    store.evaluate(ctx)
    expect(notify).not.toHaveBeenCalled()
  })

  it('evaluates real RSI math end-to-end for the rsi/above condition', async () => {
    const store = await freshStore()
    const candles = rsiRisingCandles()
    const rsiSeries = ind.rsi(ind.closesOf(candles), 14)
    const pair = ind.lastPair(rsiSeries)!
    store.create({ symbol: 'ETHUSD', source: 'rsi', condition: 'above', value: pair[0], tf: '1hr', action: 'notify' })
    const { ctx, notify } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(store.listFor('ETHUSD')[0]!.lastNote).toMatch(/RSI/)
  })

  it('evaluates real volume-ratio math end-to-end for the volume/spike condition', async () => {
    const store = await freshStore()
    const candles = volumeSpikeCandles()
    store.create({ symbol: 'SOLUSD', source: 'volume', condition: 'spike', value: 3, tf: '1hr', action: 'notify' })
    const { ctx, notify } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('swallows a thrown evaluation error for one alert without breaking the rest', async () => {
    const store = await freshStore()
    const pair = ind.lastPair(ind.closesOf(risingCandles()))!
    store.create({ ...priceAboveInput(pair[0]), action: 'notify' })
    const badCtx: AlertContext = {
      candles: () => { throw new Error('boom') },
      lastPrice: () => null,
      signal: () => null,
      stage: vi.fn(),
      notify: vi.fn(),
    }
    expect(() => store.evaluate(badCtx)).not.toThrow()
  })
})

describe('evaluate — signal-engine conditions', () => {
  const signalInput = (condition: string, value: number | null = null): NewAlertInput =>
    ({ symbol: 'BTCUSD', source: 'signal', condition, value, tf: '1hr', action: 'notify' })

  it('never fires on the first observation (nothing to diff against)', async () => {
    const store = await freshStore()
    store.create(signalInput('direction-flips'))
    const { ctx, notify } = makeCtx({ signal: { direction: 'BUY', entryQuality: 'HIGH', confluence: 3 } })
    store.evaluate(ctx)
    expect(notify).not.toHaveBeenCalled()
  })

  it('fires direction-flips when the direction changes between observations', async () => {
    const store = await freshStore()
    store.create(signalInput('direction-flips'))
    store.evaluate(makeCtx({ signal: { direction: 'BUY', entryQuality: 'HIGH', confluence: 3 } }).ctx)
    const { ctx, notify } = makeCtx({ signal: { direction: 'SELL', entryQuality: 'HIGH', confluence: 3 } })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(store.listFor('BTCUSD')[0]!.lastNote).toBe('signal BUY → SELL')
  })

  it('fires quality-good only when quality crosses from not-good into HIGH/MEDIUM', async () => {
    const store = await freshStore()
    store.create(signalInput('quality-good'))
    store.evaluate(makeCtx({ signal: { direction: 'BUY', entryQuality: 'LOW', confluence: 1 } }).ctx)
    const { ctx, notify } = makeCtx({ signal: { direction: 'BUY', entryQuality: 'MEDIUM', confluence: 1 } })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('fires confluence when it reaches the configured target', async () => {
    const store = await freshStore()
    store.create(signalInput('confluence', 3))
    store.evaluate(makeCtx({ signal: { direction: 'BUY', entryQuality: 'LOW', confluence: 1 } }).ctx)
    const { ctx, notify } = makeCtx({ signal: { direction: 'BUY', entryQuality: 'LOW', confluence: 3 } })
    store.evaluate(ctx)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not fire when the signal engine has no reading for the symbol', async () => {
    const store = await freshStore()
    store.create(signalInput('direction-flips'))
    const { ctx, notify } = makeCtx({ signal: null })
    store.evaluate(ctx)
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('audit trail', () => {
  it('records alert creation with the stored alert as the after-state', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100)) as any
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'alert.create',
      resource: `alert:${a.id}`,
      after: expect.objectContaining({ symbol: 'BTCUSD' }),
    }))
  })

  it('records arming and disarming', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100)) as any
    audit.note.mockClear()
    store.setArmed(a.id, false)
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'alert.arm', resource: `alert:${a.id}`, after: { armed: false },
    }))
  })

  it('records removal with the removed alert preserved as the before-state', async () => {
    const store = await freshStore()
    const a = store.create(priceAboveInput(100)) as any
    audit.note.mockClear()
    store.remove(a.id)
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'alert.remove',
      resource: `alert:${a.id}`,
      before: expect.objectContaining({ id: a.id }),
    }))
  })

  it('records an auto-staged trade as a system action, since no human triggered it', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    const a = store.create({ ...priceAboveInput(pair[0]), action: 'stage-buy', stageUsd: 33 }) as any
    store.evaluate(makeCtx({ candles }).ctx)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'system',
      origin: 'internal',
      action: 'alert.fired.autostage',
      resource: `alert:${a.id}`,
      meta: expect.objectContaining({ symbol: 'BTCUSD', side: 'buy', usd: 33 }),
    }))
  })

  it('does not record a fire for a notify-only alert', async () => {
    const store = await freshStore()
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create({ ...priceAboveInput(pair[0]), action: 'notify' })
    audit.record.mockClear()
    store.evaluate(makeCtx({ candles }).ctx)
    expect(audit.record).not.toHaveBeenCalled()
  })
})

describe('agent-owned alerts and agent wake-ups', () => {
  /** A stand-in fleet: records wakes, and answers the two authority questions. */
  function fakeFleet(over: Partial<{ advisory: string[]; known: string[] }> = {}) {
    const advisory = new Set(over.advisory ?? [])
    const known = new Set(over.known ?? ['manager', 'oracle'])
    const wakes: { agentId: string; reason: string }[] = []
    let refuse: string | null = null
    return {
      wakes,
      refuseWith: (why: string | null) => { refuse = why },
      binding: {
        wake: (agentId: string, reason: string) => { wakes.push({ agentId, reason }); return refuse },
        mayStage: (agentId: string) =>
          advisory.has(agentId)
            ? { ok: false, reason: `${agentId} is ADVISORY and has no trading authority` }
            : { ok: true },
        exists: (agentId: string) => known.has(agentId),
      },
    }
  }

  async function storeWith(fleet: ReturnType<typeof fakeFleet>) {
    const mod = await import('./cryptoAlerts')
    mod.bindFleet(fleet.binding)
    return mod.alertStore
  }

  it('stamps the creating actor onto the alert', async () => {
    const fleet = fakeFleet()
    const store = await storeWith(fleet)
    audit.actor = 'agent:manager'
    const a = store.create(priceAboveInput(100)) as any
    expect(a.createdBy).toBe('agent:manager')
  })

  it('records the operator as creator for UI-armed alerts', async () => {
    const store = await storeWith(fakeFleet())
    expect((store.create(priceAboveInput(100)) as any).createdBy).toBe('operator')
  })

  // The authority hole this closes: an ADVISORY agent has no trading authority, but
  // without the gate it could arm a stage-buy alert and have the server trade for it
  // later. Deferred authority is still authority.
  it('refuses a staging alert armed by an ADVISORY agent', async () => {
    const fleet = fakeFleet({ advisory: ['manager'] })
    const store = await storeWith(fleet)
    audit.actor = 'agent:manager'
    const res = store.create({ ...priceAboveInput(100), action: 'stage-buy', stageUsd: 50 })
    expect(res).toHaveProperty('error')
    expect((res as { error: string }).error).toMatch(/ADVISORY/)
    expect(store.list()).toHaveLength(0)
  })

  it('allows an ADVISORY agent to arm notify and wake alerts', async () => {
    const fleet = fakeFleet({ advisory: ['manager'] })
    const store = await storeWith(fleet)
    audit.actor = 'agent:manager'
    const a = store.create({ ...priceAboveInput(100), action: 'notify', wakeAgentId: 'manager' })
    expect(a).not.toHaveProperty('error')
    expect((a as any).wakeAgentId).toBe('manager')
  })

  it('allows a staging alert from an agent that does have trading authority', async () => {
    const fleet = fakeFleet({ advisory: [] })
    const store = await storeWith(fleet)
    audit.actor = 'agent:oracle'
    expect(store.create({ ...priceAboveInput(100), action: 'stage-buy' })).not.toHaveProperty('error')
  })

  it('never gates the operator, who is not an agent', async () => {
    const store = await storeWith(fakeFleet({ advisory: ['manager'] }))
    expect(store.create({ ...priceAboveInput(100), action: 'stage-buy' })).not.toHaveProperty('error')
  })

  it('rejects a wake target that is not a real agent', async () => {
    const store = await storeWith(fakeFleet({ known: ['manager'] }))
    const res = store.create({ ...priceAboveInput(100), wakeAgentId: 'ghost' })
    expect((res as { error: string }).error).toMatch(/unknown agent/)
  })

  it('caps how many alerts one creator may hold', async () => {
    const store = await storeWith(fakeFleet())
    audit.actor = 'agent:manager'
    const { ALERT_MAX_PER_CREATOR } = await import('../shared/alerts')
    for (let i = 0; i < ALERT_MAX_PER_CREATOR; i++) {
      expect(store.create(priceAboveInput(100 + i))).not.toHaveProperty('error')
    }
    expect(store.create(priceAboveInput(999))).toHaveProperty('error')
    // The cap is per creator, so the operator is unaffected by a hoarding agent.
    audit.actor = 'operator'
    expect(store.create(priceAboveInput(1000))).not.toHaveProperty('error')
  })

  it('wakes the named agent when the alert fires', async () => {
    const fleet = fakeFleet()
    const store = await storeWith(fleet)
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create({ ...priceAboveInput(pair[0]), action: 'notify', wakeAgentId: 'manager' })
    store.evaluate(makeCtx({ candles }).ctx)
    expect(fleet.wakes).toHaveLength(1)
    expect(fleet.wakes[0]!.agentId).toBe('manager')
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'alert.wake', resource: 'agent:manager',
    }))
  })

  it('wakes without staging when the action is notify', async () => {
    const fleet = fakeFleet()
    const store = await storeWith(fleet)
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create({ ...priceAboveInput(pair[0]), action: 'notify', wakeAgentId: 'manager' })
    const { ctx, stage } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(fleet.wakes).toHaveLength(1)
    expect(stage).not.toHaveBeenCalled()
  })

  it('both wakes and stages when the action asks for a trade', async () => {
    const fleet = fakeFleet()
    const store = await storeWith(fleet)
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create({ ...priceAboveInput(pair[0]), action: 'stage-buy', stageUsd: 25, wakeAgentId: 'oracle' })
    const { ctx, stage } = makeCtx({ candles })
    store.evaluate(ctx)
    expect(fleet.wakes[0]!.agentId).toBe('oracle')
    expect(stage).toHaveBeenCalledTimes(1)
  })

  it('records a refused wake instead of failing silently', async () => {
    const fleet = fakeFleet()
    fleet.refuseWith('in cooldown for another 12m')
    const store = await storeWith(fleet)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create({ ...priceAboveInput(pair[0]), wakeAgentId: 'manager' })
    store.evaluate(makeCtx({ candles }).ctx)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'alert.wake.refused',
      summary: expect.stringMatching(/cooldown/),
    }))
    expect(warn).toHaveBeenCalled()
  })

  it('does not wake anyone when no target is set', async () => {
    const fleet = fakeFleet()
    const store = await storeWith(fleet)
    const candles = risingCandles()
    const pair = ind.lastPair(ind.closesOf(candles))!
    store.create(priceAboveInput(pair[0]))
    store.evaluate(makeCtx({ candles }).ctx)
    expect(fleet.wakes).toHaveLength(0)
  })
})
