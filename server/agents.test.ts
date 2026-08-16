import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CryptoSnapshot } from '../shared/crypto'
import type { NewAgentInput } from '../shared/agents'

// `agentFleet` is a module-level singleton built at import time from load(), which reads
// AGENTS_FILE via node:fs + stateStore. Every test needs a fresh instance over a
// controllable virtual store, exactly like cryptoAlerts.test.ts's alertStore pattern.

const fsState = vi.hoisted(() => ({ exists: false }))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  mkdirSync: vi.fn(),
}))

// In-memory replica of stateStore's file, keyed by path — survives vi.resetModules()
// (module-scope object, only cleared in beforeEach) so "persists across reload" tests work.
const storeState = vi.hoisted(() => ({ data: new Map<string, unknown>() }))
vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((file: string, fallback: unknown) => (storeState.data.has(file) ? storeState.data.get(file) : fallback)),
    writeJson: vi.fn((file: string, value: unknown) => { storeState.data.set(file, value) }),
    saveRun: vi.fn(async () => {}),
  },
}))

const audit = vi.hoisted(() => ({ record: vi.fn(), note: vi.fn() }))
vi.mock('./auditLog', () => ({
  auditLog: audit,
  withActor: <T,>(_actor: string, fn: () => T) => fn(),
  currentActor: () => 'operator',
}))

const cryptoMock = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  addPending: vi.fn(),
  executeTrade: vi.fn(),
}))
vi.mock('./crypto', () => ({ cryptoHub: cryptoMock }))

const officeMock = vi.hoisted(() => ({
  ensurePersonnel: vi.fn((id: string, name: string) => ({
    employeeId: id, title: name, department: 'ops', status: 'active',
    reportsTo: null, resume: { summary: '', specialties: [] as string[] },
    jobDescription: { responsibilities: [] as string[], kpis: [] as string[] }, sources: [] as unknown[],
  })),
  getPersonnel: vi.fn(() => null as { title: string } | null),
  inbox: vi.fn(() => [] as unknown[]),
  readJournal: vi.fn(() => [] as unknown[]),
  think: vi.fn(),
  isBenched: vi.fn(() => ({ benched: false, status: null as string | null })),
  offboard: vi.fn(),
}))
vi.mock('./office', () => ({ office: officeMock }))

const libraryMock = vi.hoisted(() => ({ promptDigest: vi.fn(() => '') }))
vi.mock('./library', () => ({ library: libraryMock }))

const blockersMock = vi.hoisted(() => ({
  promptFor: vi.fn(() => ''),
  openFor: vi.fn(() => [] as unknown[]),
  releaseAgent: vi.fn(),
  undelivered: vi.fn(() => [] as { id: string; askedOf: string; question: string; answeredBy: string; answer: string }[]),
  markDelivered: vi.fn(),
  isBlocked: vi.fn(() => null as { id: string } | null),
  countSuppressed: vi.fn(),
  expireStale: vi.fn(() => [] as { agentId: string; askedOf: string; question: string }[]),
}))
vi.mock('./blockers', () => ({ blockerBoard: blockersMock }))

// The fleet reads the Manager's File on every tick and every prompt build. The real
// store scans the board and writes JSON at import time, so it is stubbed here the same
// way the blocker board is — these tests are about who runs, not about triage.
const managerFileMock = vi.hoisted(() => ({
  managerId: vi.fn(() => 'manager'),
  digest: vi.fn(() => ''),
  open: vi.fn(() => [] as { assignedTo: string | null }[]),
  pendingFor: vi.fn(() => [] as { id: string }[]),
  markDelivered: vi.fn(),
  refresh: vi.fn(),
  wakeDue: vi.fn(() => false),
}))
vi.mock('./managerFile', () => ({ managerFile: managerFileMock }))

vi.mock('./cryptoAlerts', () => ({ bindFleet: vi.fn() }))

const claudeProcState = vi.hoisted(() => ({ wasStopped: false }))
// Hoisted so tests can reach the exact controller handed to a given run — the
// timeout-abort test asserts on its signal.
const claudeProcMock = vi.hoisted(() => ({
  register: vi.fn(() => ({
    controller: new AbortController(),
    done: vi.fn(),
    wasStopped: () => claudeProcState.wasStopped,
  })),
}))
vi.mock('./claudeProcesses', () => ({ claudeProcesses: claudeProcMock }))

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists = false
  storeState.data.clear()
  claudeProcState.wasStopped = false
  officeMock.ensurePersonnel.mockImplementation((id: string, name: string) => ({
    employeeId: id, title: name, department: 'ops', status: 'active',
    reportsTo: null, resume: { summary: '', specialties: [] as string[] },
    jobDescription: { responsibilities: [] as string[], kpis: [] as string[] }, sources: [] as unknown[],
  }))
  officeMock.getPersonnel.mockReturnValue(null)
  officeMock.inbox.mockReturnValue([])
  officeMock.readJournal.mockReturnValue([])
  officeMock.isBenched.mockReturnValue({ benched: false, status: null })
  blockersMock.openFor.mockReturnValue([])
  blockersMock.undelivered.mockReturnValue([])
  blockersMock.isBlocked.mockReturnValue(null)
  blockersMock.expireStale.mockReturnValue([])
  cryptoMock.getSnapshot.mockReturnValue(emptySnapshot())
  // Default query mock: a run that immediately succeeds with no decisions, so any test
  // that doesn't care about the SDK exchange still resolves promptly.
  sdk.query.mockImplementation(() => fakeQuery([successResult()]))
})

async function freshFleet() {
  const mod = await import('./agents')
  return mod
}

function emptySnapshot(overrides: Partial<CryptoSnapshot> = {}): CryptoSnapshot {
  return {
    tickers: [], holdings: [], signals: [], pending: [], openOrders: [], tradeHistory: [],
    intelReport: '', planReport: '', planReportAt: null, planReports: [],
    lastRefresh: Date.now(), connected: true, keysConfigured: true,
    seedProgress: {} as never, autoPlans: [], strategyExposure: {},
    btcLadderAlerts: [], btcLadderCycles: [], autoExecute: {} as never,
    portfolioGrowth: null, safeMode: [], loopMode: false, strategyIntervalMin: 0,
    strategyIntervals: {}, feeRates: {} as never, cmcData: [],
    ...overrides,
  } as CryptoSnapshot
}

function fakeQuery(messages: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const m of messages) yield m
  })()
}

/** An async generator that yields once, then never settles again — used to hold a run
 *  "in flight" indefinitely (an empty fakeQuery() actually completes on the very next
 *  microtask, which is too fast to exercise anything that needs a run mid-flight). */
function hangingQuery(): AsyncGenerator<unknown> {
  return (async function* () {
    yield assistantMsg()
    await new Promise(() => {})
  })()
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result', subtype: 'success', is_error: false,
    usage: { input_tokens: 100, output_tokens: 50 },
    num_turns: 1, duration_ms: 250, total_cost_usd: 0.01,
    modelUsage: { 'claude-sonnet-5': { contextWindow: 200_000, costUSD: 0.01 } },
    result: 'Stood down — nothing met the mandate.',
    session_id: 'sess-1',
    ...overrides,
  }
}

function assistantMsg(usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 }) {
  return { type: 'assistant', message: { usage, model: 'claude-sonnet-5' } }
}

const newAgent = (over: Partial<NewAgentInput> = {}): NewAgentInput => ({
  name: 'Watcher', mandate: 'Watch ETH and flag anything interesting.', ...over,
})

describe('CRUD', () => {
  it('requires a name and a mandate', async () => {
    const { agentFleet } = await freshFleet()
    expect(() => agentFleet.create({ name: '', mandate: 'x' })).toThrow(/name/)
    expect(() => agentFleet.create({ name: 'x', mandate: '  ' })).toThrow(/mandate/)
  })

  it('slugifies the name into the id and applies defaults', async () => {
    const { agentFleet } = await freshFleet()
    const view = agentFleet.create(newAgent({ name: 'My Cool Agent!!' }))
    expect(view.agent.id).toBe('my-cool-agent')
    expect(view.agent.autonomy).toBe('advisory')
    expect(view.agent.enabled).toBe(false)
    expect(view.agent.maxUsd).toBe(20)
  })

  it('clamps numeric fields into their allowed ranges', async () => {
    const { agentFleet } = await freshFleet()
    const view = agentFleet.create(newAgent({
      maxUsd: 999_999, intervalMinutes: -5, drawdownPct: 0, cooldownMinutes: 99999, idleStanddownMinutes: -1,
    }))
    expect(view.agent.maxUsd).toBe(250) // AGENT_MAX_USD_CEILING
    expect(view.agent.intervalMinutes).toBe(0)
    expect(view.agent.drawdownPct).toBe(1)
    expect(view.agent.cooldownMinutes).toBe(24 * 60)
    expect(view.agent.idleStanddownMinutes).toBe(0)
  })

  it('rejects an unknown model id', async () => {
    const { agentFleet } = await freshFleet()
    expect(() => agentFleet.create(newAgent({ model: 'gpt-5' }))).toThrow(/unknown model/)
  })

  it('opens a personnel file and records the hire in the audit log', async () => {
    const { agentFleet } = await freshFleet()
    const view = agentFleet.create(newAgent({ name: 'Oracle' }))
    expect(officeMock.ensurePersonnel).toHaveBeenCalledWith('oracle', 'Oracle')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.create', resource: 'agent:oracle',
    }))
    expect(view.status).toBeNull()
    expect(view.stoodDown).toBe(false)
  })

  it('persists so a fresh module load sees the same fleet', async () => {
    const mod1 = await freshFleet()
    mod1.agentFleet.create(newAgent({ name: 'Persisted' }))
    expect(fsState.exists).toBe(false) // agents.ts never sets this itself — mkdirSync/writeJson only
    fsState.exists = true // simulate the file existing for the reload, as the real fs would
    vi.resetModules()
    const mod2 = await freshFleet()
    expect(mod2.agentFleet.get('persisted')).not.toBeNull()
  })

  it('update validates the model before applying any part of the patch', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    expect(() => agentFleet.update('sentry', { model: 'nope', name: 'Renamed' })).toThrow(/unknown model/)
    expect(agentFleet.get('sentry')!.agent.name).toBe('Sentry')
  })

  it('update clamps and records changed keys in the audit trail', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    audit.note.mockClear()
    const view = agentFleet.update('sentry', { maxUsd: 999_999, autonomy: 'auto' })!
    expect(view.agent.maxUsd).toBe(250)
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.update',
      meta: expect.objectContaining({ changedKeys: expect.arrayContaining(['maxUsd', 'autonomy']) }),
    }))
  })

  it('update reports no effective change when the patch matches current values', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', maxUsd: 20 }))
    audit.note.mockClear()
    agentFleet.update('sentry', { maxUsd: 20 })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringMatching(/no effective change/),
    }))
  })

  it('returns null from update/get for an unknown id', async () => {
    const { agentFleet } = await freshFleet()
    expect(agentFleet.update('nope', { maxUsd: 5 })).toBeNull()
    expect(agentFleet.get('nope')).toBeNull()
  })

  it('remove releases blockers, offboards HR, and records the removal', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Departing' }))
    expect(agentFleet.remove('departing')).toBe(true)
    expect(blockersMock.releaseAgent).toHaveBeenCalledWith('departing')
    expect(officeMock.offboard).toHaveBeenCalledWith('departing')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.remove', resource: 'agent:departing' }))
    expect(agentFleet.get('departing')).toBeNull()
  })

  it('remove returns false and does not audit for an unknown id', async () => {
    const { agentFleet } = await freshFleet()
    audit.note.mockClear()
    expect(agentFleet.remove('ghost')).toBe(false)
    expect(audit.note).not.toHaveBeenCalled()
  })

  it('list sorts by creation order', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'First' }))
    agentFleet.create(newAgent({ name: 'Second' }))
    const ids = agentFleet.list().map((v) => v.agent.id)
    expect(ids).toEqual(['first', 'second'])
  })
})

describe('roster / mentionableIds', () => {
  it('lists every hired agent plus the operator', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Manager' }))
    agentFleet.create(newAgent({ name: 'Oracle' }))
    expect(agentFleet.mentionableIds().sort()).toEqual(['manager', 'operator', 'oracle'])
  })
})

describe('propose — trade authority gate', () => {
  const req = (over: Partial<{ symbol: string; side: 'buy' | 'sell'; amount: string; price: string; reason: string }> = {}) =>
    ({ symbol: 'ETHUSD', side: 'buy' as const, amount: '0.01', ...over })

  it('refuses an unknown agent', async () => {
    const { agentFleet } = await freshFleet()
    const res = await agentFleet.propose('ghost', req())
    expect(res).toEqual({ ok: false, outcome: 'refused', detail: 'unknown agent' })
  })

  describe('per-agent propose key (AGT-02)', () => {
    it('accepts an agent its own key and rejects another agent’s', async () => {
      const { agentFleet } = await freshFleet()
      agentFleet.create(newAgent({ name: 'Advisor', autonomy: 'advisory' }))
      agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
      // Keys are not exposed through any view, so read them off the persisted record
      // the same way the prompt builder does.
      const persisted = storeState.data.get([...storeState.data.keys()][0]!) as {
        agents: { agent: { id: string }; proposeKey: string }[]
      }
      const keyOf = (id: string) => persisted.agents.find((a) => a.agent.id === id)!.proposeKey

      expect(agentFleet.verifyProposeKey('trader', keyOf('trader'))).toBe(true)
      // The whole point: an advisory agent holding its own key cannot use the
      // auto agent's URL to borrow its authority.
      expect(agentFleet.verifyProposeKey('trader', keyOf('advisor'))).toBe(false)
      expect(agentFleet.verifyProposeKey('trader', '')).toBe(false)
      expect(agentFleet.verifyProposeKey('trader', 'guessed')).toBe(false)
      expect(agentFleet.verifyProposeKey('nobody', keyOf('trader'))).toBe(false)
    })

    it('never exposes the key through a read route', async () => {
      const { agentFleet } = await freshFleet()
      agentFleet.create(newAgent({ name: 'Trader' }))
      const persisted = storeState.data.get([...storeState.data.keys()][0]!) as {
        agents: { proposeKey: string }[]
      }
      const key = persisted.agents[0]!.proposeKey
      expect(key).toBeTruthy()
      expect(JSON.stringify(agentFleet.list())).not.toContain(key)
      expect(JSON.stringify(agentFleet.get('trader'))).not.toContain(key)
      expect(JSON.stringify(agentFleet.roster())).not.toContain(key)
    })
  })

  it('refuses a malformed request without touching the exchange', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', autonomy: 'auto' }))
    const res = await agentFleet.propose('sentry', req({ amount: '' }))
    expect(res.ok).toBe(false)
    expect(res.detail).toMatch(/required/)
    expect(cryptoMock.addPending).not.toHaveBeenCalled()
  })

  it('refuses a limit order with no price', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', autonomy: 'auto' }))
    const res = await agentFleet.propose('sentry', { symbol: 'ETHUSD', side: 'buy', amount: '1', type: 'limit' })
    expect(res.detail).toMatch(/limit order needs a price/)
  })

  it('refuses a market order on a symbol with no live ticker instead of treating it as free', async () => {
    // TRD-01 regression: an unknown/unseeded symbol used to fall back to a `last`
    // of 0, so notional (px * amount) computed to 0 and sailed through both caps
    // below — for an auto agent that meant an unbounded market order actually
    // reaching the exchange. It must be refused before any cap check runs.
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [] })) // no ticker for ETHUSD
    const res = await agentFleet.propose('trader', req({ amount: '1000' }))
    expect(res).toMatchObject({ ok: false, outcome: 'refused', detail: expect.stringMatching(/no live price/) })
    expect(cryptoMock.addPending).not.toHaveBeenCalled()
    expect(cryptoMock.executeTrade).not.toHaveBeenCalled()
  })

  it('refuses a non-positive or non-numeric amount even with a live price', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    const res = await agentFleet.propose('trader', req({ amount: '0' }))
    expect(res).toMatchObject({ ok: false, outcome: 'refused', detail: expect.stringMatching(/positive number/) })
    expect(cryptoMock.addPending).not.toHaveBeenCalled()
  })

  it('refuses every proposal from an advisory agent regardless of mandate', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Analyst', autonomy: 'advisory' }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    const res = await agentFleet.propose('analyst', req())
    expect(res).toMatchObject({ ok: false, outcome: 'refused', detail: expect.stringMatching(/ADVISORY/) })
    expect(cryptoMock.addPending).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.trade.refused' }))
  })

  it('refuses a notional above the global ceiling even for an auto agent', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Whale', autonomy: 'auto', maxUsd: 250 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 100_000 } as never] }))
    const res = await agentFleet.propose('whale', req({ amount: '10' }))
    expect(res.detail).toMatch(/exceeds the global agent ceiling/)
    expect(cryptoMock.addPending).not.toHaveBeenCalled()
  })

  it('auto agent executes immediately within its own cap', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    cryptoMock.addPending.mockReturnValue({ id: 'trade-1' })
    cryptoMock.executeTrade.mockResolvedValue({ ok: true })
    const res = await agentFleet.propose('trader', req({ amount: '0.01' })) // $20 notional
    expect(res).toEqual({ ok: true, outcome: 'executed', tradeId: 'trade-1' })
    expect(cryptoMock.executeTrade).toHaveBeenCalledWith('trade-1')
    const view = agentFleet.get('trader')!
    expect(view.decisions[0]).toMatchObject({ outcome: 'executed', symbol: 'ETHUSD' })
  })

  it('degrades to staged once an auto agent hits its rolling budget, even under its per-trade cap', async () => {
    // TRD-02: maxUsd only ever bounded a SINGLE trade — an auto agent could otherwise
    // auto-execute an unlimited number of under-cap trades back to back. The rolling
    // budget is 10x the per-trade cap over 24h, computed from the agent's own decision
    // history, so $100 maxUsd allows $1000 of auto-execution before the 11th $100
    // trade — still comfortably under the per-trade cap — has to stage instead.
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    cryptoMock.executeTrade.mockResolvedValue({ ok: true })
    let n = 0
    cryptoMock.addPending.mockImplementation(() => ({ id: `trade-${++n}` }))

    // amount 0.05 @ 2000 = $100 notional, exactly at the per-trade cap.
    for (let i = 0; i < 10; i++) {
      const res = await agentFleet.propose('trader', req({ amount: '0.05' }))
      expect(res.outcome).toBe('executed')
    }
    expect(cryptoMock.executeTrade).toHaveBeenCalledTimes(10)

    const res = await agentFleet.propose('trader', req({ amount: '0.05' }))
    expect(res.outcome).toBe('staged')
    expect(res.detail).toMatch(/rolling budget/)
    expect(cryptoMock.executeTrade).toHaveBeenCalledTimes(10) // the 11th did not execute
  })

  it('rolling budget survives the agent flushing its own decision log with junk proposals', async () => {
    // AGT-04 regression. The budget used to be summed from rec.decisions, which is
    // capped at 60 entries across ALL outcomes — so an agent near its cap could
    // submit ~60 refused proposals (free, self-service), age its own executed rows
    // out of the array, and win back a full budget. The spend ledger is trimmed by
    // time only, so nothing the agent does can evict it.
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    cryptoMock.executeTrade.mockResolvedValue({ ok: true })
    let n = 0
    cryptoMock.addPending.mockImplementation(() => ({ id: `trade-${++n}` }))

    // Spend the whole $1000 rolling budget (10 × $100 cap).
    for (let i = 0; i < 10; i++) {
      expect((await agentFleet.propose('trader', req({ amount: '0.05' }))).outcome).toBe('executed')
    }
    // Now flood the decision log with refusals — each is a real, cheap proposal.
    for (let i = 0; i < 70; i++) {
      await agentFleet.propose('trader', { symbol: 'NOPEUSD', side: 'buy', amount: '1' })
    }
    // The executed rows are long gone from `decisions`…
    const decisions = agentFleet.get('trader')!.decisions
    expect(decisions.some((d) => d.outcome === 'executed')).toBe(false)
    // …but the budget still knows what was spent.
    const after = await agentFleet.propose('trader', req({ amount: '0.05' }))
    expect(after.outcome).toBe('staged')
    expect(after.detail).toMatch(/rolling budget/)
    expect(cryptoMock.executeTrade).toHaveBeenCalledTimes(10)
  })

  it('releases the budget reservation when the exchange rejects the order', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    cryptoMock.addPending.mockReturnValue({ id: 'trade-x' })
    cryptoMock.executeTrade.mockResolvedValue({ ok: false, error: 'insufficient funds' })
    // Ten failed $100 attempts must not consume the $1000 budget.
    for (let i = 0; i < 10; i++) {
      expect((await agentFleet.propose('trader', req({ amount: '0.05' }))).outcome).toBe('refused')
    }
    cryptoMock.executeTrade.mockResolvedValue({ ok: true })
    expect((await agentFleet.propose('trader', req({ amount: '0.05' }))).outcome).toBe('executed')
  })

  it('degrades an over-cap auto proposal to a staged confirmation instead of refusing it', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 10 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    cryptoMock.addPending.mockReturnValue({ id: 'trade-2' })
    const res = await agentFleet.propose('trader', req({ amount: '0.01' })) // $20 > $10 cap
    expect(res.outcome).toBe('staged')
    expect(res.detail).toMatch(/over this agent's \$10 auto cap/)
    expect(cryptoMock.executeTrade).not.toHaveBeenCalled()
  })

  it('reports a refused outcome when execution itself fails', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto', maxUsd: 100 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 2000 } as never] }))
    cryptoMock.addPending.mockReturnValue({ id: 'trade-3' })
    cryptoMock.executeTrade.mockResolvedValue({ ok: false, error: 'insufficient funds' })
    const res = await agentFleet.propose('trader', req({ amount: '0.01' }))
    expect(res).toMatchObject({ ok: false, outcome: 'refused', detail: expect.stringMatching(/insufficient funds/) })
  })

  it('propose-autonomy agents always stage, never auto-execute', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Proposer', autonomy: 'propose', maxUsd: 250 }))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({ tickers: [{ symbol: 'ETHUSD', last: 100 } as never] }))
    cryptoMock.addPending.mockReturnValue({ id: 'trade-4' })
    const res = await agentFleet.propose('proposer', req({ amount: '1' }))
    expect(res.outcome).toBe('staged')
    expect(cryptoMock.executeTrade).not.toHaveBeenCalled()
  })

  it('logs every ruling to the office thought stream', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Analyst', autonomy: 'advisory' }))
    await agentFleet.propose('analyst', req())
    expect(officeMock.think).toHaveBeenCalledWith('analyst', expect.objectContaining({
      kind: 'decision', text: expect.stringMatching(/REFUSED/),
    }))
  })
})

describe('start — preconditions', () => {
  it('refuses an unknown agent', async () => {
    const { agentFleet } = await freshFleet()
    expect(agentFleet.start('ghost')).toEqual({ ok: false, error: 'unknown agent' })
  })

  it('refuses a benched (HR-suspended) agent', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Benched' }))
    officeMock.isBenched.mockReturnValue({ benched: true, status: 'suspended' })
    const res = agentFleet.start('benched')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/suspended/)
  })

  it('refuses to start an agent that is already running', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Busy' }))
    sdk.query.mockImplementation(() => fakeQuery([])) // never resolves meaningfully mid-test
    agentFleet.start('busy')
    expect(agentFleet.isRunning('busy')).toBe(true)
    expect(agentFleet.start('busy')).toEqual({ ok: false, error: 'this agent is already running' })
  })

  it('enforces the single-concurrent-run cap across different agents', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'One' }))
    agentFleet.create(newAgent({ name: 'Two' }))
    sdk.query.mockImplementation(() => fakeQuery([])) // keep the first run "in flight" from start()'s POV
    agentFleet.start('one')
    const res = agentFleet.start('two')
    expect(res).toEqual({ ok: false, error: 'another agent is running — try again shortly' })
  })
})

describe('start — execute() lifecycle', () => {
  it('runs to completion, records usage totals, and mirrors the run via stateStore', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementation(() => fakeQuery([assistantMsg(), successResult({ result: 'Nothing to do.' })]))
    agentFleet.start('sentry')
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    const view = agentFleet.get('sentry')!
    expect(view.status?.state).toBe('done')
    expect(view.status?.summary).toBe('Nothing to do.')
    expect(view.totals?.runs).toBe(1)
    const stateStoreMod = await import('./stateStore')
    expect(stateStoreMod.stateStore.saveRun).toHaveBeenCalled()
  })

  it('marks a run as errored when the SDK result reports failure', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementation(() => fakeQuery([successResult({ subtype: 'error_max_turns', is_error: true, result: 'ran out of turns' })]))
    agentFleet.start('sentry')
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    const view = agentFleet.get('sentry')!
    expect(view.status?.state).toBe('error')
    expect(view.status?.error).toMatch(/ran out of turns/)
  })

  it('treats an operator-initiated abort as a clean stop, not an error', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementation(() => {
      claudeProcState.wasStopped = true
      throw new Error('aborted')
    })
    agentFleet.start('sentry')
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    const view = agentFleet.get('sentry')!
    expect(view.status?.state).toBe('done')
    expect(view.status?.summary).toBe('Stopped before completion.')
  })

  it('counts a mid-run compaction and journals it as an observation', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementation(() => fakeQuery([
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 150_000 } },
      successResult(),
    ]))
    agentFleet.start('sentry')
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    expect(officeMock.think).toHaveBeenCalledWith('sentry', expect.objectContaining({
      kind: 'observation', text: expect.stringMatching(/Context compacted at 150000 tokens/),
    }))
  })

  it('hands undelivered blocker answers to the prompt and marks them delivered', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    blockersMock.undelivered.mockReturnValue([
      { id: 'b1', askedOf: 'manager', question: 'Buy or hold?', answeredBy: 'manager', answer: 'Hold.' },
    ])
    agentFleet.start('sentry')
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    expect(blockersMock.markDelivered).toHaveBeenCalledWith(['b1'])
    const promptArg = sdk.query.mock.calls[0]![0] as { prompt: string }
    expect(promptArg.prompt).toMatch(/Hold\./)
  })

  it('force-fails a run that exceeds the run timeout', async () => {
    vi.useFakeTimers()
    try {
      const { agentFleet } = await freshFleet()
      agentFleet.create(newAgent({ name: 'Stuck' }))
      sdk.query.mockImplementation(() => hangingQuery()) // never settles
      agentFleet.start('stuck')
      expect(agentFleet.isRunning('stuck')).toBe(true)
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      expect(agentFleet.isRunning('stuck')).toBe(false)
      expect(agentFleet.get('stuck')!.status?.state).toBe('error')
      expect(agentFleet.get('stuck')!.status?.error).toBe('Run timed out.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ABORTS the SDK session on timeout instead of leaving it streaming', async () => {
    // AGT-03 regression. The timeout used to free the concurrency slot without
    // aborting, so the session kept running with full trade authority while the
    // fleet started another agent — two bypassPermissions sessions at once, and
    // the zombie's eventual completion overwrote the timeout's 'error'.
    vi.useFakeTimers()
    try {
      const { agentFleet } = await freshFleet()
      agentFleet.create(newAgent({ name: 'Stuck' }))
      sdk.query.mockImplementation(() => hangingQuery())
      agentFleet.start('stuck')
      // The controller handed to the SDK for this run.
      const controller = (claudeProcMock.register.mock.results[0]!.value as { controller: AbortController }).controller
      expect(controller.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      expect(controller.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('chat', () => {
  it('resumes the prior session id on the next turn', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementation(() => fakeQuery([successResult({ result: 'Hi there.', session_id: 'sess-abc' })]))
    const res = await agentFleet.chat('sentry', 'Hello')
    expect(res.ok).toBe(true)
    expect(res.reply).toBe('Hi there.')

    await agentFleet.chat('sentry', 'Follow up')
    const secondCallOptions = sdk.query.mock.calls[1]![0] as { options: { resume?: string } }
    expect(secondCallOptions.options.resume).toBe('sess-abc')
  })

  it('clears the session and reports an error when a turn fails', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementationOnce(() => fakeQuery([successResult({ session_id: 'sess-abc' })]))
    await agentFleet.chat('sentry', 'Hello')
    sdk.query.mockImplementationOnce(() => fakeQuery([successResult({ subtype: 'error', is_error: true, result: 'boom' })]))
    const res = await agentFleet.chat('sentry', 'again')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/boom/)
    const third = agentFleet.get('sentry')
    // chatUsage/sessionId are cleared on failure — verified indirectly via the next call
    // not resuming a stale session.
    sdk.query.mockImplementationOnce(() => fakeQuery([successResult({ session_id: 'sess-new' })]))
    await agentFleet.chat('sentry', 'once more')
    const thirdCallOptions = sdk.query.mock.calls[2]![0] as { options: { resume?: string } }
    expect(thirdCallOptions.options.resume).toBeUndefined()
    expect(third).toBeTruthy()
  })

  it('refuses to chat with a busy agent', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    sdk.query.mockImplementation(() => fakeQuery([])) // run stays in flight
    agentFleet.start('sentry')
    const res = await agentFleet.chat('sentry', 'hi')
    expect(res).toEqual({ ok: false, error: 'this agent is busy on a run' })
  })

  it('clearTranscript drops the session and usage', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    await agentFleet.chat('sentry', 'hi')
    expect(agentFleet.clearTranscript('sentry')).toBe(true)
    expect(agentFleet.get('sentry')!.transcript).toEqual([])
    expect(agentFleet.clearTranscript('ghost')).toBe(false)
  })
})

describe('tick — scheduling (private, exercised via cast)', () => {
  function tick(fleet: unknown) {
    ;(fleet as { tick: () => void }).tick()
  }

  it('does not wake a disabled agent', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: false, intervalMinutes: 1 }))
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(false)
  })

  it('an undelivered answer wakes the agent even inside its cooldown', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, cooldownMinutes: 60 }))
    blockersMock.undelivered.mockReturnValue([{ id: 'b1', askedOf: 'manager', question: 'q', answeredBy: 'm', answer: 'a' }])
    sdk.query.mockImplementation(() => fakeQuery([])) // leave it running so we can observe the trigger fired
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(true)
    expect(agentFleet.get('sentry')!.status?.trigger).toBe('answer')
  })

  it('suppresses triggers while the agent holds a blocking question', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, intervalMinutes: 1 }))
    blockersMock.isBlocked.mockReturnValue({ id: 'blk-1' })
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(false)
    expect(blockersMock.countSuppressed).toHaveBeenCalledWith('blk-1')
  })

  it('fires the interval trigger once it comes due', async () => {
    const { agentFleet } = await freshFleet()
    const view = agentFleet.create(newAgent({ name: 'Sentry', enabled: true, intervalMinutes: 1 }))
    sdk.query.mockImplementation(() => fakeQuery([]))
    const due = view.nextRunAt!
    vi.spyOn(Date, 'now').mockReturnValue(due + 1)
    tick(agentFleet)
    expect(agentFleet.get('sentry')!.status?.trigger).toBe('interval')
    vi.restoreAllMocks()
  })

  it('honors the per-agent cooldown across automatic triggers', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, intervalMinutes: 1, cooldownMinutes: 30 }))
    sdk.query.mockImplementation(() => fakeQuery([successResult()]))
    const now0 = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now0 + 2 * 60_000)
    tick(agentFleet) // first interval fire
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    vi.spyOn(Date, 'now').mockReturnValue(now0 + 3 * 60_000) // well within the 30m cooldown
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(false)
    vi.restoreAllMocks()
  })

  it('fires the drawdown event only once the agent-specific threshold is breached', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, events: ['drawdown'], drawdownPct: 20 }))
    sdk.query.mockImplementation(() => fakeQuery([]))
    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({
      holdings: [{ currency: 'ETH', amountNotional: 100, unrealizedPnlPct: -10 } as never],
    }))
    tick(agentFleet) // first tick only seeds lastSeen — edge detection needs a second tick
    tick(agentFleet) // -10% does not clear the 20% bar
    expect(agentFleet.isRunning('sentry')).toBe(false)

    cryptoMock.getSnapshot.mockReturnValue(emptySnapshot({
      holdings: [{ currency: 'ETH', amountNotional: 100, unrealizedPnlPct: -25 } as never],
    }))
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(true)
    expect(agentFleet.get('sentry')!.status?.trigger).toBe('drawdown')
  })

  // A mention no longer wakes the colleague it names — it lands on the Manager's File
  // and only the desk manager is woken to triage it. One board message naming six
  // people used to arm six agents, each of whom woke, replied and named six more.
  it('does not fire the mention event for a colleague who was merely named', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, events: ['mention'] }))
    sdk.query.mockImplementation(() => fakeQuery([]))
    managerFileMock.managerId.mockReturnValue('manager')  // sentry is not the manager
    managerFileMock.wakeDue.mockReturnValue(true)
    tick(agentFleet) // seed lastSeen

    officeMock.inbox.mockReturnValue([{ threadId: 't1' }])
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(false)
  })

  it('wakes the desk manager for a mention, and only on an untriaged edge', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, events: ['mention'] }))
    sdk.query.mockImplementation(() => fakeQuery([]))
    managerFileMock.managerId.mockReturnValue('sentry')   // now they hold the file
    // Nothing new filed since their last automatic wake — the file can wait. Set
    // before the seeding tick, or the seed itself wakes them.
    managerFileMock.wakeDue.mockReturnValue(false)
    tick(agentFleet) // seed lastSeen

    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(false)

    managerFileMock.wakeDue.mockReturnValue(true)
    tick(agentFleet)
    expect(agentFleet.isRunning('sentry')).toBe(true)
    expect(agentFleet.get('sentry')!.status?.trigger).toBe('mention')
  })

  it('reports expired blockers to the asker’s journal', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: false }))
    blockersMock.expireStale.mockReturnValue([{ agentId: 'sentry', askedOf: 'manager', question: 'still waiting?' }])
    tick(agentFleet)
    expect(officeMock.think).toHaveBeenCalledWith('sentry', expect.objectContaining({
      text: expect.stringMatching(/expired unanswered/),
    }))
  })
})

describe('standdownSweep — idle session release (private, exercised via cast)', () => {
  function sweep(fleet: unknown, now: number) {
    ;(fleet as { standdownSweep: (n: number) => void }).standdownSweep(now)
  }

  it('does nothing for an agent with no resumed session', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', idleStanddownMinutes: 10 }))
    sweep(agentFleet, Date.now() + 999_999_999)
    expect(officeMock.think).not.toHaveBeenCalled()
  })

  it('releases a lightly-loaded session without a handoff', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', idleStanddownMinutes: 10 }))
    await agentFleet.chat('sentry', 'hi') // gives it a sessionId; default usage has 0 contextTokens
    const idleAt = Date.now() + 11 * 60_000
    sweep(agentFleet, idleAt)
    expect(officeMock.think).toHaveBeenCalledWith('sentry', expect.objectContaining({
      text: expect.stringMatching(/released without a handoff/),
    }))
    // sdk.query was not called a second time for a handoff conversation
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('writes a handoff journal entry before releasing a session with substantial context', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', idleStanddownMinutes: 10 }))
    sdk.query.mockImplementationOnce(() => fakeQuery([assistantMsg({ input_tokens: 20_000, output_tokens: 100 }), successResult()]))
    await agentFleet.chat('sentry', 'hi') // contextTokens now > STANDDOWN_MIN_CONTEXT (15,000)
    sdk.query.mockImplementationOnce(() => fakeQuery([successResult({ result: 'handoff filed' })]))
    const idleAt = Date.now() + 11 * 60_000
    sweep(agentFleet, idleAt)
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(agentFleet.get('sentry')!.stoodDown).toBe(true))
  })
})

describe('wakeFromAlert', () => {
  it('refuses an unknown agent', async () => {
    const { agentFleet } = await freshFleet()
    expect(agentFleet.wakeFromAlert('ghost', 'test')).toBe('unknown agent')
  })

  it('refuses a disabled agent', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: false }))
    expect(agentFleet.wakeFromAlert('sentry', 'test')).toBe('agent is disabled')
  })

  it('refuses while the agent is already running', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true }))
    sdk.query.mockImplementation(() => fakeQuery([]))
    agentFleet.start('sentry')
    expect(agentFleet.wakeFromAlert('sentry', 'test')).toBe('agent is already running')
  })

  it('reports remaining cooldown instead of starting a run', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true, cooldownMinutes: 30 }))
    sdk.query.mockImplementation(() => fakeQuery([successResult()]))
    agentFleet.start('sentry', 'interval')
    await vi.waitFor(() => expect(agentFleet.isRunning('sentry')).toBe(false))
    const reason = agentFleet.wakeFromAlert('sentry', 'rsi dipped')
    expect(reason).toMatch(/in cooldown for another \d+m/)
  })

  it('starts an alert-triggered run when nothing blocks it', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry', enabled: true }))
    sdk.query.mockImplementation(() => fakeQuery([]))
    expect(agentFleet.wakeFromAlert('sentry', 'rsi dipped')).toBeNull()
    expect(agentFleet.get('sentry')!.status?.trigger).toBe('alert')
  })
})

describe('mayStage', () => {
  it('refuses an unknown agent', async () => {
    const { agentFleet } = await freshFleet()
    expect(agentFleet.mayStage('ghost')).toEqual({ ok: false, reason: 'unknown agent' })
  })

  it('refuses an advisory agent with a reason naming it', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Analyst', autonomy: 'advisory' }))
    const res = agentFleet.mayStage('analyst')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/ADVISORY/)
  })

  it('allows a propose/auto agent', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Trader', autonomy: 'auto' }))
    expect(agentFleet.mayStage('trader')).toEqual({ ok: true })
  })
})

describe('has', () => {
  it('reflects fleet membership', async () => {
    const { agentFleet } = await freshFleet()
    agentFleet.create(newAgent({ name: 'Sentry' }))
    expect(agentFleet.has('sentry')).toBe(true)
    expect(agentFleet.has('ghost')).toBe(false)
  })
})

describe('pure type guards', () => {
  it('isAgentAutonomy accepts only the three known values', async () => {
    const { isAgentAutonomy } = await freshFleet()
    expect(isAgentAutonomy('advisory')).toBe(true)
    expect(isAgentAutonomy('propose')).toBe(true)
    expect(isAgentAutonomy('auto')).toBe(true)
    expect(isAgentAutonomy('yolo')).toBe(false)
  })

  it('isAgentEvent accepts only the five known values', async () => {
    const { isAgentEvent } = await freshFleet()
    for (const v of ['signal', 'fill', 'drawdown', 'proposal', 'mention']) expect(isAgentEvent(v)).toBe(true)
    expect(isAgentEvent('nope')).toBe(false)
  })
})
