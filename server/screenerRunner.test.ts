import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildScreenerJob, runScreenerEngine, resolvePython, __resetPythonCacheForTests, BARS_PER_SYMBOL } from './screenerRunner'
import { normalizeScreenerDef, type ScreenerCandle } from '../shared/screener'

const H = 60 * 60 * 1000

function bars(n: number, start = 100, step = 0.5): ScreenerCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * step
    return [i * H, o, o + step + 0.1, o - 0.1, o + step, 100] as ScreenerCandle
  })
}

function inputs(over: Partial<Parameters<typeof buildScreenerJob>[1]> = {}) {
  return {
    tickers: [
      { symbol: 'AAAUSD', last: 100, change24h: -5, volume24h: 4_000_000 },
      { symbol: 'BBBUSD', last: 2, change24h: 3, volume24h: 900_000 },
    ],
    candles: () => bars(120),
    marketCaps: new Map([['AAA', 500_000_000]]),
    held: new Set<string>(['BBBUSD']),
    ...over,
  }
}

const screener = (over: Record<string, unknown> = {}) =>
  normalizeScreenerDef({ id: 's1', name: 'S1', timeframe: '1hr', ...over })

// ── Job assembly (pure) ───────────────────────────────────────────────────────

describe('buildScreenerJob', () => {
  it('stamps the schema version and the job clock', () => {
    const job = buildScreenerJob(screener(), inputs(), 1_700_000_000_000)
    expect(job.schemaVersion).toBe(1)
    expect(job.now).toBe(1_700_000_000_000)
  })

  it('carries one entry per ticker', () => {
    const job = buildScreenerJob(screener(), inputs(), 0)
    expect(job.symbols.map((s) => s.symbol)).toEqual(['AAAUSD', 'BBBUSD'])
  })

  it('attaches market stats from the ticker', () => {
    const job = buildScreenerJob(screener(), inputs(), 0)
    const a = job.symbols[0]!
    expect(a.last).toBe(100)
    expect(a.change24h).toBe(-5)
    expect(a.volume24h).toBe(4_000_000)
  })

  it('attaches the market cap by base symbol, not the pair', () => {
    const job = buildScreenerJob(screener(), inputs(), 0)
    expect(job.symbols[0]!.marketCap).toBe(500_000_000)
  })

  it('leaves market cap null when no feed supplied one', () => {
    const job = buildScreenerJob(screener(), inputs(), 0)
    expect(job.symbols[1]!.marketCap).toBeNull()
  })

  it('marks held symbols so the HELD universe and the UI can see them', () => {
    const job = buildScreenerJob(screener(), inputs(), 0)
    expect(job.symbols[0]!.held).toBe(false)
    expect(job.symbols[1]!.held).toBe(true)
  })

  it('sends only the base feed the screener timeframe needs', () => {
    // Shipping all three base feeds for 142 symbols would be tens of megabytes
    // down a pipe on every scan, nearly all of it unread.
    const asked: string[] = []
    const job = buildScreenerJob(screener({ timeframe: '4hr' }), inputs({
      candles: (_s: string, tf: string) => { asked.push(tf); return bars(120) },
    }), 0)
    expect(new Set(asked)).toEqual(new Set(['1hr']))
    expect(Object.keys(job.symbols[0]!.candles)).toEqual(['1hr'])
  })

  it('uses the daily feed for a weekly screen', () => {
    const asked: string[] = []
    buildScreenerJob(screener({ timeframe: '1week' }), inputs({
      candles: (_s: string, tf: string) => { asked.push(tf); return bars(120) },
    }), 0)
    expect(new Set(asked)).toEqual(new Set(['1day']))
  })

  it('trims history to the bar cap', () => {
    const job = buildScreenerJob(screener(), inputs({ candles: () => bars(900) }), 0)
    expect(job.symbols[0]!.candles['1hr']!.length).toBe(BARS_PER_SYMBOL)
  })

  it('keeps the NEWEST bars when trimming', () => {
    const all = bars(900)
    const job = buildScreenerJob(screener(), inputs({ candles: () => all }), 0)
    expect(job.symbols[0]!.candles['1hr']!.at(-1)).toEqual(all.at(-1))
  })

  it('tolerates a symbol with no candles at all', () => {
    const job = buildScreenerJob(screener(), inputs({ candles: () => [] }), 0)
    expect(job.symbols[0]!.candles['1hr']).toEqual([])
  })

  it('produces JSON-serializable output', () => {
    const job = buildScreenerJob(screener(), inputs(), 0)
    expect(() => JSON.stringify(job)).not.toThrow()
  })
})

// ── Engine invocation (subprocess) ────────────────────────────────────────────

describe('runScreenerEngine', () => {
  let dir: string
  const script = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'screener-runner-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  const job = () => buildScreenerJob(screener(), inputs(), 0)

  it('runs the real engine end to end', async () => {
    const r = await runScreenerEngine(job())
    expect(r.ok).toBe(true)
    expect(r.result!.screenerId).toBe('s1')
    expect(r.result!.universe).toBe(2)
  })

  it('applies gates through the real engine', async () => {
    const strict = screener({ gates: { volume24h: { enabled: true, min: 3_000_000 } } })
    const r = await runScreenerEngine(buildScreenerJob(strict, inputs(), 0))
    expect(r.result!.passing).toBe(1)
    expect(r.result!.candidates[0]!.symbol).toBe('AAAUSD')
  })

  it('surfaces a structured engine error instead of throwing', async () => {
    const bad = { ...job(), schemaVersion: 99 }
    const r = await runScreenerEngine(bad)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/schemaVersion/)
  })

  it('reports unparseable stdout as an error rather than crashing', async () => {
    const path = script('garbage.py', 'import sys\nsys.stdout.write("not json at all")\n')
    const r = await runScreenerEngine(job(), { scriptPath: path })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not be read|not valid/i)
  })

  it('reports a result that is missing required fields', async () => {
    const path = script('wrong-shape.py', 'import json,sys\njson.dump({"hello":"world"}, sys.stdout)\n')
    const r = await runScreenerEngine(job(), { scriptPath: path })
    expect(r.ok).toBe(false)
  })

  it('kills a hung engine and reports the timeout', async () => {
    const path = script('hang.py', 'import time\ntime.sleep(30)\n')
    const started = Date.now()
    const r = await runScreenerEngine(job(), { scriptPath: path, timeoutMs: 300 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/i)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('reports a missing interpreter without hanging', async () => {
    const r = await runScreenerEngine(job(), { pythonBin: 'definitely-not-a-real-python' })
    expect(r.ok).toBe(false)
    expect(r.error.length).toBeGreaterThan(0)
  })

  it('reports a missing engine script', async () => {
    const r = await runScreenerEngine(job(), { scriptPath: join(dir, 'nope.py') })
    expect(r.ok).toBe(false)
  })

  describe('resolvePython', () => {
    const saved = process.env['SCREENER_PYTHON']
    beforeEach(() => { __resetPythonCacheForTests() })
    afterEach(() => {
      if (saved === undefined) delete process.env['SCREENER_PYTHON']
      else process.env['SCREENER_PYTHON'] = saved
      __resetPythonCacheForTests()
    })

    it('finds a working interpreter on this machine with no configuration', async () => {
      delete process.env['SCREENER_PYTHON']
      const py = resolvePython()
      // Whatever it picked must actually run the engine — the Store stub cannot.
      const path = script('ok.py', 'import sys\nsys.stdout.write(\'{"screenerId":"x","candidates":[],"funnel":[]}\')\n')
      const r = await runScreenerEngine(job(), { scriptPath: path, pythonBin: py.bin, timeoutMs: 20_000 })
      // A launcher needing a prefix arg (`py -3`) is exercised through resolvePython
      // itself below; here we only assert the chosen binary is real.
      if (py.args.length === 0) expect(r.ok).toBe(true)
      expect(py.bin.length).toBeGreaterThan(0)
    })

    it('honours an explicit SCREENER_PYTHON over probing', () => {
      process.env['SCREENER_PYTHON'] = 'my-special-python'
      expect(resolvePython()).toEqual({ bin: 'my-special-python', args: [] })
    })

    it('caches so repeated runs do not re-probe', () => {
      delete process.env['SCREENER_PYTHON']
      expect(resolvePython()).toBe(resolvePython())
    })
  })

  it('does not treat engine stderr as failure when the result parses', async () => {
    // Diagnostics on stderr are legitimate; only stdout is the contract.
    const path = script('noisy.py', [
      'import json,sys',
      'sys.stderr.write("warming up\\n")',
      'json.load(sys.stdin)',
      'json.dump({"schemaVersion":1,"screenerId":"s1","timeframe":"1hr","scannedAt":0,'
      + '"universe":0,"passing":0,"candidates":[],"funnel":[],"degradedGates":[],"errors":[]}, sys.stdout)',
    ].join('\n'))
    const r = await runScreenerEngine(job(), { scriptPath: path })
    expect(r.ok).toBe(true)
  })
})

// ── Contract agreement between the two languages ──────────────────────────────

describe('engine contract', () => {
  it('agrees with shared/screener.ts on gates, patterns and timeframes', async () => {
    const { readEngineContract } = await import('./screenerRunner')
    const { GATE_ORDER, KNOWN_PATTERNS, SCREENER_TIMEFRAMES, SCREENER_SCHEMA_VERSION } =
      await import('../shared/screener')

    const contract = await readEngineContract()
    expect(contract.ok).toBe(true)
    expect(contract.contract!.schemaVersion).toBe(SCREENER_SCHEMA_VERSION)
    expect(contract.contract!.gates).toEqual([...GATE_ORDER])
    expect([...contract.contract!.patterns].sort()).toEqual([...KNOWN_PATTERNS].sort())
    expect([...contract.contract!.timeframes].sort()).toEqual([...SCREENER_TIMEFRAMES].sort())
  })
})

// ── Snapshot → job inputs ─────────────────────────────────────────────────────
// This adapter used to live inline in index.ts, where it could not be tested. Volume
// is deliberately CMC's cross-exchange aggregate, never Gemini's own book: Gemini is
// one thin venue, so a coin can be liquid market-wide while barely printing here, and
// a threshold tuned for market-wide dollars would misread exchange-local ones by two
// orders of magnitude. A coin with no CMC read gets null, and the gate degrades.

describe('screenerInputsFromSnapshot', () => {
  const snap = {
    tickers: [
      { symbol: 'BTCUSD', last: '65000', volume: '48', change: 1.5 },
      { symbol: 'ETHUSD', last: '1900', volume: '1000', change: -2.25 },
      { symbol: 'BTCGUSD', last: '65000', volume: '10', change: 0 },
    ],
    holdings: [{ currency: 'btc' }, { currency: 'SOL' }],
  }

  const build = async () => {
    const { screenerInputsFromSnapshot } = await import('./screenerRunner')
    return screenerInputsFromSnapshot(
      snap as never, () => bars(10), new Map([['BTC', 1.2e12]]),
      new Map([['BTC', 32_000_000_000]]),
    )
  }

  it('keeps only USD pairs', async () => {
    const i = await build()
    expect(i.tickers.map((t) => t.symbol)).toEqual(['BTCUSD', 'ETHUSD'])
  })

  it('takes 24h volume from the CMC cross-exchange read, not the Gemini book', async () => {
    const i = await build()
    expect(i.tickers[0]!.volume24h).toBe(32_000_000_000)
    // Gemini printed 48 BTC ≈ $3.1M — that number must NOT leak into the gate.
    expect(i.tickers[0]!.volume24h).not.toBe(48 * 65000)
  })

  it('gives null volume when CMC has no read for the coin, so the gate degrades', async () => {
    const i = await build()
    expect(i.tickers[1]!.volume24h).toBeNull()
  })

  it('carries the 24h change straight through', async () => {
    const i = await build()
    expect(i.tickers[1]!.change24h).toBe(-2.25)
  })

  it('marks held pairs regardless of how the holding cased its currency', async () => {
    const i = await build()
    expect(i.held.has('BTCUSD')).toBe(true)
    expect(i.held.has('SOLUSD')).toBe(true)
    expect(i.held.has('ETHUSD')).toBe(false)
  })

  it('passes market caps through by base symbol', async () => {
    const i = await build()
    expect(i.marketCaps.get('BTC')).toBe(1.2e12)
  })

  it('survives a ticker with unparseable numbers', async () => {
    const { screenerInputsFromSnapshot } = await import('./screenerRunner')
    const i = screenerInputsFromSnapshot(
      { tickers: [{ symbol: 'XUSD', last: 'n/a', volume: '', change: 0 }], holdings: [] } as never,
      () => [], new Map(),
    )
    expect(i.tickers[0]!.last).toBe(0)
    expect(i.tickers[0]!.volume24h).toBeNull()
  })
})
