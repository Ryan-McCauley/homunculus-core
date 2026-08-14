import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchCryptoSnapshot, fetchCryptoPositions, fetchCryptoTrades, executeTrade, dismissTrade,
  refreshCrypto, resetPortfolioBaseline, reconstructPortfolioBaseline, setPortfolioBaseline,
  fetchAutoExecute, setAutoExecute, runCryptoStrategy, fetchLoopMode, setLoopMode,
  fetchStrategyInterval, setStrategyInterval, fetchStrategyIntervals, setStrategyIntervalFor,
  fetchStrategyDefinitions, setStrategySettings, resetStrategySettings, createStrategy,
  fetchStrategyStatus, fetchEnabledStrategy, setEnabledStrategy, startAutoPlan, stopAutoPlan,
  resetAutoPlan, confirmAutoPlan, patchAutoPlanStep, setBracketLock, stageTrade, cancelOpenOrder,
  closePosition, closeSymbolPosition, modifyOpenOrder, setSafeMode, adjustSafeMode, postPlanReport,
  fetchCandles, fetchAlerts, createAlert, deleteAlert, setAlertArmed, fetchAuditEntries,
  verifyAuditChain, fetchTimeline, fetchRunningClaude, stopClaudeProcess,
} from './cryptoApi'

function stubEnv(opts: { apiOverride?: string; port?: string; origin?: string; search?: string; tokenGlobal?: string } = {}) {
  vi.stubGlobal('window', { __HOMUNCULUS_API__: opts.apiOverride, __HOMUNCULUS_TOKEN__: opts.tokenGlobal })
  vi.stubGlobal('location', {
    port: opts.port ?? '5173',
    protocol: 'http:',
    hostname: 'localhost',
    origin: opts.origin ?? 'http://localhost:5173',
    search: opts.search ?? '',
  })
}

function mockFetch(ok: boolean, body: unknown, status = 200, statusText = 'err') {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, statusText, json: async () => body })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const BASE = 'http://localhost:8787'

beforeEach(() => stubEnv())
afterEach(() => vi.unstubAllGlobals())

describe('token handling', () => {
  it('appends the URL token to a request', async () => {
    stubEnv({ search: '?token=abc' })
    const fetchMock = mockFetch(true, { ok: true, snapshot: {} })
    await fetchCryptoSnapshot()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/snapshot?token=abc`)
  })
})

describe('fetchCryptoSnapshot', () => {
  it('returns the snapshot on success', async () => {
    const snapshot = { positions: [] }
    const fetchMock = mockFetch(true, { ok: true, snapshot })
    const result = await fetchCryptoSnapshot()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/snapshot`)
    expect(result).toEqual(snapshot)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchCryptoSnapshot()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('fetchCryptoPositions', () => {
  it('returns the positions snapshot on success', async () => {
    const snapshot = { open: [] }
    const fetchMock = mockFetch(true, { ok: true, snapshot })
    const result = await fetchCryptoPositions()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/positions`)
    expect(result).toEqual(snapshot)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 404, 'Not Found')
    await expect(fetchCryptoPositions()).rejects.toThrow('404 Not Found')
  })
})

describe('fetchCryptoTrades', () => {
  it('returns the trades on success', async () => {
    const trades = [{ id: 't1' }]
    const fetchMock = mockFetch(true, { ok: true, trades })
    const result = await fetchCryptoTrades()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/trades`)
    expect(result).toEqual(trades)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchCryptoTrades()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('executeTrade', () => {
  it('POSTs to the /execute sub-path and returns the response', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    const result = await executeTrade('t1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/trade/t1/execute`)
    expect(init.method).toBe('POST')
    expect(result).toEqual({ ok: true })
  })
  it('resolves with the error body rather than throwing on failure', async () => {
    mockFetch(true, { ok: false, error: 'insufficient funds' })
    expect(await executeTrade('t1')).toEqual({ ok: false, error: 'insufficient funds' })
  })
})

describe('dismissTrade', () => {
  it('POSTs to the /dismiss sub-path', async () => {
    const fetchMock = mockFetch(true, {})
    await dismissTrade('t1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/trade/t1/dismiss`)
    expect(init.method).toBe('POST')
  })
})

describe('refreshCrypto', () => {
  it('POSTs to /refresh', async () => {
    const fetchMock = mockFetch(true, {})
    await refreshCrypto()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/refresh`)
    expect(init.method).toBe('POST')
  })
})

describe('resetPortfolioBaseline', () => {
  it('POSTs to the reset path', async () => {
    const fetchMock = mockFetch(true, {})
    await resetPortfolioBaseline()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/portfolio-baseline/reset`)
    expect(init.method).toBe('POST')
  })
})

describe('reconstructPortfolioBaseline', () => {
  it('POSTs the reconstructFrom timestamp and returns truncated flag', async () => {
    const fetchMock = mockFetch(true, { truncated: true })
    const result = await reconstructPortfolioBaseline(12345)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/portfolio-baseline`)
    expect(JSON.parse(init.body)).toEqual({ reconstructFrom: 12345 })
    expect(result).toEqual({ truncated: true })
  })
  it('coerces a missing truncated flag to false', async () => {
    mockFetch(true, {})
    expect(await reconstructPortfolioBaseline(1)).toEqual({ truncated: false })
  })
})

describe('setPortfolioBaseline', () => {
  it('POSTs btc/usd/at', async () => {
    const fetchMock = mockFetch(true, {})
    await setPortfolioBaseline(0.5, 100, 999)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ btc: 0.5, usd: 100, at: 999 })
  })
})

describe('fetchAutoExecute / setAutoExecute', () => {
  it('fetches the auto-execute config', async () => {
    const config = { enabled: true, btcLadderMaxUsd: 1, altMaxUsd: 2, perStrategy: {} }
    mockFetch(true, { config })
    expect(await fetchAutoExecute()).toEqual(config)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchAutoExecute()).rejects.toThrow('500 Internal Server Error')
  })
  it('POSTs a patch and returns the updated config', async () => {
    const config = { enabled: false, btcLadderMaxUsd: 1, altMaxUsd: 2, perStrategy: {} }
    const fetchMock = mockFetch(true, { config })
    const result = await setAutoExecute({ enabled: false })
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ enabled: false })
    expect(result).toEqual(config)
  })
})

describe('runCryptoStrategy', () => {
  it('defaults to crypto-strategy and returns the run status', async () => {
    const fetchMock = mockFetch(true, { ok: true, status: { state: 'running' } })
    const result = await runCryptoStrategy()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/strategy/run`)
    expect(JSON.parse(init.body)).toEqual({ strategy: 'crypto-strategy' })
    expect(result).toEqual({ ok: true, status: { state: 'running' } })
  })
  it('passes through a specific strategy id', async () => {
    const fetchMock = mockFetch(true, { ok: true, status: {} })
    await runCryptoStrategy('sniper')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ strategy: 'sniper' })
  })
})

describe('loop mode', () => {
  it('fetchLoopMode returns the enabled flag', async () => {
    mockFetch(true, { enabled: true })
    expect(await fetchLoopMode()).toBe(true)
  })
  it('fetchLoopMode throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchLoopMode()).rejects.toThrow('500 Internal Server Error')
  })
  it('setLoopMode POSTs the flag and returns it', async () => {
    const fetchMock = mockFetch(true, { enabled: false })
    const result = await setLoopMode(false)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: false })
    expect(result).toBe(false)
  })
})

describe('strategy interval (universal)', () => {
  it('fetchStrategyInterval returns minutes', async () => {
    mockFetch(true, { minutes: 15 })
    expect(await fetchStrategyInterval()).toBe(15)
  })
  it('fetchStrategyInterval throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchStrategyInterval()).rejects.toThrow('500 Internal Server Error')
  })
  it('setStrategyInterval POSTs minutes and returns it', async () => {
    const fetchMock = mockFetch(true, { minutes: 30 })
    const result = await setStrategyInterval(30)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ minutes: 30 })
    expect(result).toBe(30)
  })
})

describe('strategy intervals (per-strategy)', () => {
  it('fetchStrategyIntervals returns the map', async () => {
    const intervals = { sniper: 10 }
    mockFetch(true, { intervals })
    expect(await fetchStrategyIntervals()).toEqual(intervals)
  })
  it('fetchStrategyIntervals throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchStrategyIntervals()).rejects.toThrow('500 Internal Server Error')
  })
  it('setStrategyIntervalFor targets the strategy query param and posts minutes', async () => {
    const intervals = { sniper: 20 }
    const fetchMock = mockFetch(true, { intervals })
    const result = await setStrategyIntervalFor('sniper', 20)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/strategy/intervals?strategy=sniper`)
    expect(JSON.parse(init.body)).toEqual({ minutes: 20 })
    expect(result).toEqual(intervals)
  })
})

describe('strategy settings/definitions', () => {
  it('fetchStrategyDefinitions returns the definitions', async () => {
    const definitions = [{ id: 'sniper' }]
    mockFetch(true, { definitions })
    expect(await fetchStrategyDefinitions()).toEqual(definitions)
  })
  it('fetchStrategyDefinitions throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchStrategyDefinitions()).rejects.toThrow('500 Internal Server Error')
  })
  it('setStrategySettings targets the strategy query param and posts the patch', async () => {
    const settings = { bidUsd: 20 }
    const fetchMock = mockFetch(true, { settings })
    const result = await setStrategySettings('sniper', { bidUsd: 20 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/strategy/settings?strategy=sniper`)
    expect(JSON.parse(init.body)).toEqual({ bidUsd: 20 })
    expect(result).toEqual(settings)
  })
  it('resetStrategySettings targets reset=1 and posts an empty object', async () => {
    const settings = { bidUsd: 10 }
    const fetchMock = mockFetch(true, { settings })
    const result = await resetStrategySettings('sniper')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/strategy/settings?strategy=sniper&reset=1`)
    expect(init.body).toBe('{}')
    expect(result).toEqual(settings)
  })
})

describe('createStrategy', () => {
  it('POSTs the new strategy input and returns the definition', async () => {
    const definition = { id: 'new-strat' }
    const fetchMock = mockFetch(true, { ok: true, definition })
    const input = { label: 'New', fields: [] }
    const result = await createStrategy(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/strategy/create`)
    expect(JSON.parse(init.body)).toEqual(input)
    expect(result).toEqual(definition)
  })
  it('throws using the server error message when ok:false', async () => {
    mockFetch(true, { ok: false, error: 'duplicate label' })
    await expect(createStrategy({ label: 'x', fields: [] })).rejects.toThrow('duplicate label')
  })
  it('throws a generic message when ok:false with no error given', async () => {
    mockFetch(true, { ok: false })
    await expect(createStrategy({ label: 'x', fields: [] })).rejects.toThrow('create failed')
  })
})

describe('fetchStrategyStatus', () => {
  it('returns the status on success', async () => {
    const status = { state: 'idle' }
    mockFetch(true, { status })
    expect(await fetchStrategyStatus()).toEqual(status)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchStrategyStatus()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('enabled strategy', () => {
  it('fetchEnabledStrategy returns the strategy id', async () => {
    mockFetch(true, { strategy: 'sniper' })
    expect(await fetchEnabledStrategy()).toBe('sniper')
  })
  it('fetchEnabledStrategy throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchEnabledStrategy()).rejects.toThrow('500 Internal Server Error')
  })
  it('setEnabledStrategy POSTs the strategy and returns it', async () => {
    const fetchMock = mockFetch(true, { strategy: 'trapline' })
    const result = await setEnabledStrategy('trapline')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ strategy: 'trapline' })
    expect(result).toBe('trapline')
  })
  it('setEnabledStrategy throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(setEnabledStrategy('trapline')).rejects.toThrow('500 Internal Server Error')
  })
})

describe('autoplan lifecycle', () => {
  it('startAutoPlan POSTs to /start', async () => {
    const fetchMock = mockFetch(true, {})
    await startAutoPlan()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/autoplan/start`)
    expect(init.method).toBe('POST')
  })
  it('stopAutoPlan omits the symbol query param when not given', async () => {
    const fetchMock = mockFetch(true, {})
    await stopAutoPlan()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/autoplan/stop`)
  })
  it('stopAutoPlan includes the symbol query param when given', async () => {
    const fetchMock = mockFetch(true, {})
    await stopAutoPlan('BTCUSD')
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/autoplan/stop?symbol=BTCUSD`)
  })
  it('resetAutoPlan includes the symbol query param when given', async () => {
    const fetchMock = mockFetch(true, {})
    await resetAutoPlan('ETHUSD')
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/autoplan/reset?symbol=ETHUSD`)
  })
  it('confirmAutoPlan omits the symbol query param when not given', async () => {
    const fetchMock = mockFetch(true, {})
    await confirmAutoPlan()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/autoplan/confirm`)
  })
})

describe('patchAutoPlanStep', () => {
  it('PATCHes the step id path with the patch', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    const result = await patchAutoPlanStep('step1', { approved: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/autoplan/step/step1`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ approved: true })
    expect(result).toEqual({ ok: true })
  })
  it('folds the symbol into the body when given', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    await patchAutoPlanStep('step1', { approved: true }, 'BTCUSD')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ approved: true, symbol: 'BTCUSD' })
  })
})

describe('setBracketLock', () => {
  it('POSTs symbol + locked', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    const result = await setBracketLock('BTCUSD', true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/bracket/lock`)
    expect(JSON.parse(init.body)).toEqual({ symbol: 'BTCUSD', locked: true })
    expect(result).toEqual({ ok: true })
  })
})

describe('stageTrade', () => {
  it('POSTs the full trade payload', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    const trade = { symbol: 'BTCUSD', side: 'buy' as const, type: 'limit' as const, amount: '0.01', price: '50000', reason: 'test' }
    const result = await stageTrade(trade)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/stage`)
    expect(JSON.parse(init.body)).toEqual(trade)
    expect(result).toEqual({ ok: true })
  })
  it('resolves with the error body on failure rather than throwing', async () => {
    mockFetch(true, { ok: false, error: 'spread too wide' })
    const result = await stageTrade({ symbol: 'BTCUSD', side: 'buy', type: 'market', amount: '1', reason: 'x' })
    expect(result).toEqual({ ok: false, error: 'spread too wide' })
  })
})

describe('cancelOpenOrder', () => {
  it('POSTs to the /cancel sub-path', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    await cancelOpenOrder('o1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/order/o1/cancel`)
    expect(init.method).toBe('POST')
  })
})

describe('closePosition', () => {
  it('POSTs to the /close sub-path and returns the new order id', async () => {
    mockFetch(true, { ok: true, newOrderId: 'o2' })
    const result = await closePosition('o1')
    expect(result).toEqual({ ok: true, newOrderId: 'o2' })
  })
})

describe('closeSymbolPosition', () => {
  it('POSTs to the symbol-scoped /close path', async () => {
    const fetchMock = mockFetch(true, { ok: true, newOrderId: 'o2', cancelledOrderIds: ['o0'] })
    const result = await closeSymbolPosition('BTCUSD')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/position/BTCUSD/close`)
    expect(result).toEqual({ ok: true, newOrderId: 'o2', cancelledOrderIds: ['o0'] })
  })
})

describe('modifyOpenOrder', () => {
  it('POSTs the patch to the /modify sub-path', async () => {
    const fetchMock = mockFetch(true, { ok: true, newOrderId: 'o2' })
    const result = await modifyOpenOrder('o1', { price: '51000' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/order/o1/modify`)
    expect(JSON.parse(init.body)).toEqual({ price: '51000' })
    expect(result).toEqual({ ok: true, newOrderId: 'o2' })
  })
})

describe('setSafeMode / adjustSafeMode', () => {
  it('setSafeMode POSTs the opts to /safe-mode', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    await setSafeMode('o1', { enabled: true, stopPct: 5, exitPct: 2 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/order/o1/safe-mode`)
    expect(JSON.parse(init.body)).toEqual({ enabled: true, stopPct: 5, exitPct: 2 })
  })
  it('adjustSafeMode folds in adjust:true', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    await adjustSafeMode('o1', { stopPct: 3 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ adjust: true, stopPct: 3 })
  })
})

describe('postPlanReport', () => {
  it('POSTs the report text', async () => {
    const fetchMock = mockFetch(true, {})
    await postPlanReport('report text')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/plan-report`)
    expect(JSON.parse(init.body)).toEqual({ report: 'report text' })
  })
})

describe('fetchCandles', () => {
  it('returns candle tuples on success', async () => {
    const candles = [[1, 2, 3, 4, 5, 6]] as any
    const fetchMock = mockFetch(true, { candles })
    const result = await fetchCandles('BTCUSD', '1h')
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/candles/BTCUSD/1h`)
    expect(result).toEqual(candles)
  })
  it('throws (with just the status) on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchCandles('BTCUSD', '1h')).rejects.toThrow('500')
  })
})

describe('alerts', () => {
  it('fetchAlerts omits the symbol query param when not given', async () => {
    const alerts = [{ id: 'a1' }]
    const fetchMock = mockFetch(true, { ok: true, alerts })
    const result = await fetchAlerts()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/alerts`)
    expect(result).toEqual(alerts)
  })
  it('fetchAlerts includes the symbol query param when given', async () => {
    const fetchMock = mockFetch(true, { ok: true, alerts: [] })
    await fetchAlerts('BTCUSD')
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/alerts?symbol=BTCUSD`)
  })
  it('fetchAlerts returns an empty array when alerts is absent', async () => {
    mockFetch(true, { ok: true })
    expect(await fetchAlerts()).toEqual([])
  })
  it('fetchAlerts does not throw on a non-ok HTTP response', async () => {
    mockFetch(false, { ok: false }, 500, 'Internal Server Error')
    expect(await fetchAlerts()).toEqual([])
  })

  it('createAlert POSTs the full input', async () => {
    const fetchMock = mockFetch(true, { ok: true, alert: { id: 'a1' } })
    const input = {
      symbol: 'BTCUSD', source: 'rsi' as any, condition: 'below', value: 30,
      tf: '1h' as any, action: 'notify' as any,
    }
    const result = await createAlert(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/alerts`)
    expect(JSON.parse(init.body)).toEqual(input)
    expect(result).toEqual({ ok: true, alert: { id: 'a1' } })
  })

  it('deleteAlert DELETEs the id-scoped path', async () => {
    const fetchMock = mockFetch(true, {})
    await deleteAlert('a1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/alerts/a1`)
    expect(init.method).toBe('DELETE')
  })

  it('setAlertArmed POSTs the armed flag to /arm', async () => {
    const fetchMock = mockFetch(true, {})
    await setAlertArmed('a1', false)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/crypto/alerts/a1/arm`)
    expect(JSON.parse(init.body)).toEqual({ armed: false })
  })
})

describe('fetchAuditEntries', () => {
  it('builds no query string when the filter is empty', async () => {
    const fetchMock = mockFetch(true, { entries: [], nextCursor: null })
    await fetchAuditEntries()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/audit`)
  })
  it('includes only defined, non-empty-string filter fields', async () => {
    const fetchMock = mockFetch(true, { entries: [], nextCursor: null })
    await fetchAuditEntries({ actor: 'e1', action: undefined, resource: '', limit: 10 })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('actor=e1')
    expect(url).toContain('limit=10')
    expect(url).not.toContain('action=')
    expect(url).not.toContain('resource=')
  })
  it('returns entries and nextCursor on success', async () => {
    const entries = [{ id: 'e1' }] as any
    mockFetch(true, { entries, nextCursor: 42 })
    expect(await fetchAuditEntries()).toEqual({ entries, nextCursor: 42 })
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchAuditEntries()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('verifyAuditChain', () => {
  it('returns the verify result on success', async () => {
    const result = { valid: true }
    mockFetch(true, { result })
    expect(await verifyAuditChain()).toEqual(result)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(verifyAuditChain()).rejects.toThrow('500 Internal Server Error')
  })
})

describe('fetchTimeline', () => {
  it('builds the since/until query and returns the timeline', async () => {
    const timeline = { events: [] }
    const fetchMock = mockFetch(true, { timeline })
    const result = await fetchTimeline(100, 200)
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/crypto/timeline?since=100&until=200`)
    expect(result).toEqual(timeline)
  })
  it('throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchTimeline(0, 1)).rejects.toThrow('500 Internal Server Error')
  })
})

describe('fetchRunningClaude / stopClaudeProcess', () => {
  it('fetchRunningClaude returns the process list', async () => {
    const processes = [{ id: 'p1' }]
    mockFetch(true, { processes })
    expect(await fetchRunningClaude()).toEqual(processes)
  })
  it('fetchRunningClaude throws on a non-ok response', async () => {
    mockFetch(false, {}, 500, 'Internal Server Error')
    await expect(fetchRunningClaude()).rejects.toThrow('500 Internal Server Error')
  })
  it('stopClaudeProcess POSTs to the /stop sub-path', async () => {
    const fetchMock = mockFetch(true, { ok: true })
    const result = await stopClaudeProcess('p1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/claude/p1/stop`)
    expect(init.method).toBe('POST')
    expect(result).toEqual({ ok: true })
  })
  it('stopClaudeProcess resolves ok:false without throwing when the session already finished', async () => {
    mockFetch(true, { ok: false, error: 'not running' })
    expect(await stopClaudeProcess('p1')).toEqual({ ok: false, error: 'not running' })
  })
})
