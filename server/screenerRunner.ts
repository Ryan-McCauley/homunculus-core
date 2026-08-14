// Bridge from the Node server to the Python screening engine.
//
//   buildScreenerJob()   assembles a job — pure, synchronous, testable
//   runScreenerEngine()  pipes it to engine/screener_engine.py and reads the result
//
// WHY THE SPLIT. Everything that needs judgement (which candles, which market caps,
// which symbols are held) happens in buildScreenerJob and is a pure function of its
// inputs. Everything that can fail in boring operational ways (no interpreter, a
// hung process, a corrupt pipe) happens in runScreenerEngine. That line is what
// makes the interesting half unit-testable without a subprocess, and the subprocess
// half testable with a three-line fake engine.
//
// WHY A SEPARATE PROCESS AT ALL. The screening itself is deterministic arithmetic
// over candles — no model, no network, no judgement. Python already hosts the
// repo's quantitative work (.claude/scripts), and a process boundary means a
// screener that runs long or crashes outright cannot take the trading server with
// it. The cost is a serialization round-trip, which is why the payload is trimmed
// down to exactly one base feed per scan (see BARS_PER_SYMBOL below).
//
// NOTHING HERE CAN TRADE. The engine receives prices and returns opinions. It has
// no keys, no network, and no path back into the order code.

import { execFile, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  SCREENER_SCHEMA_VERSION, TIMEFRAME_SOURCE,
  type ScreenerCandle, type ScreenerDef, type ScreenerJob, type ScreenerResult,
} from '../shared/screener'

/** Bars sent per symbol. 400 covers an EMA-200 on the native timeframe with room to
 *  spare, while keeping a 142-symbol payload to a few megabytes. A derived
 *  timeframe (4hr from 1hr) sees fewer bars than that and its longest averages may
 *  legitimately report "not enough data" — which the engine says out loud rather
 *  than quietly approximating. */
export const BARS_PER_SYMBOL = 400

/** How long the engine gets before it is killed. A full-universe scan measures in
 *  low single-digit seconds; anything past this is stuck, not slow. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Node's default is 1MB, which a 142-symbol result overruns immediately. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const ENGINE_SCRIPT = join(process.cwd(), 'engine', 'screener_engine.py')

export interface ScreenerTickerInput {
  symbol: string
  last: number
  change24h?: number | null
  volume24h?: number | null
}

export interface ScreenerJobInputs {
  tickers: ScreenerTickerInput[]
  /** Candle lookup for a (symbol, base timeframe) pair, oldest-first. */
  candles: (symbol: string, timeframe: string) => ScreenerCandle[]
  /** Market cap by BASE symbol ("BTC", not "BTCUSD") — absent when CMC is unconfigured. */
  marketCaps: Map<string, number>
  /** Pair symbols currently held, for the HELD universe and the results table. */
  held: Set<string>
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Base currency of a pair — "BTCUSD" → "BTC". Market caps are keyed by coin. */
function baseOf(symbol: string): string {
  return symbol.toUpperCase().replace(/USD$/, '')
}

export function buildScreenerJob(
  screener: ScreenerDef,
  inputs: ScreenerJobInputs,
  now: number,
): ScreenerJob {
  // One screener runs on one timeframe, so exactly one base feed is worth sending.
  const base = TIMEFRAME_SOURCE[screener.timeframe]?.base ?? '1hr'

  const symbols = inputs.tickers.map((t) => {
    const all = inputs.candles(t.symbol, base) ?? []
    // Keep the NEWEST bars: a screener reads the right-hand edge of the chart.
    const trimmed = all.length > BARS_PER_SYMBOL ? all.slice(-BARS_PER_SYMBOL) : all
    return {
      symbol: t.symbol,
      last: num(t.last) ?? 0,
      change24h: num(t.change24h),
      volume24h: num(t.volume24h),
      marketCap: num(inputs.marketCaps.get(baseOf(t.symbol))),
      held: inputs.held.has(t.symbol.toUpperCase()),
      candles: { [base]: trimmed },
    }
  })

  return { schemaVersion: SCREENER_SCHEMA_VERSION, screener, symbols, now }
}

export interface RunOptions {
  pythonBin?: string
  scriptPath?: string
  timeoutMs?: number
}

export interface RunOutcome {
  ok: boolean
  result?: ScreenerResult
  error: string
}

/** An interpreter and any launcher arguments that must precede the script. */
interface PythonCmd { bin: string; args: string[] }

/** Probe order. SCREENER_PYTHON always wins — an explicit path is someone telling
 *  us they know better. Otherwise Windows leads with the `py` launcher, which is
 *  the only name that reliably finds a real install: the bare name `python3` there
 *  resolves to the Microsoft Store *app execution alias*, a stub that installs
 *  nothing, prints "Python was not found…" and exits 9009. That stub was the whole
 *  reason this needed per-machine configuration. */
function pythonCandidates(): PythonCmd[] {
  const explicit = process.env['SCREENER_PYTHON']
  if (explicit) return [{ bin: explicit, args: [] }]
  return process.platform === 'win32'
    ? [{ bin: 'py', args: ['-3'] }, { bin: 'python', args: [] }, { bin: 'python3', args: [] }]
    : [{ bin: 'python3', args: [] }, { bin: 'python', args: [] }]
}

/** Ask a candidate to name its own executable. Real interpreters exit 0 and print a
 *  path; the Store stub exits non-zero with nothing on stdout. Testing behaviour
 *  rather than the path keeps a genuine Store-installed Python working — it lives
 *  under WindowsApps too, so no path heuristic could tell the two apart. */
function pythonWorks(cmd: PythonCmd): boolean {
  try {
    const out = execFileSync(
      cmd.bin,
      [...cmd.args, '-c', 'import sys; sys.stdout.write(sys.executable or "python")'],
      { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    ).toString().trim()
    return out.length > 0
  } catch {
    return false
  }
}

/** Resolved once per process — probing spawns subprocesses, and the answer cannot
 *  change while we run. Falls back to the first candidate so a machine with no
 *  interpreter still produces the engine's own "could not be started" message
 *  rather than a different error from here. */
let resolvedPython: PythonCmd | null = null

export function resolvePython(): PythonCmd {
  if (resolvedPython) return resolvedPython
  const candidates = pythonCandidates()
  resolvedPython = candidates.find(pythonWorks) ?? candidates[0]
  return resolvedPython
}

/** Tests set SCREENER_PYTHON per case; without this the first probe would stick. */
export function __resetPythonCacheForTests(): void {
  resolvedPython = null
}

/** True when a parsed document really is a result and not an error or a stub. */
function isResult(value: unknown): value is ScreenerResult {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['screenerId'] === 'string'
    && Array.isArray(v['candidates'])
    && Array.isArray(v['funnel'])
}

/** Run one screening job. Resolves with an outcome; never rejects — a failed scan
 *  is a message for the user, not an exception for the request handler to catch. */
export function runScreenerEngine(job: ScreenerJob, opts: RunOptions = {}): Promise<RunOutcome> {
  const script = opts.scriptPath ?? ENGINE_SCRIPT
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RunOutcome>((resolve) => {
    const py = opts.pythonBin ? { bin: opts.pythonBin, args: [] } : resolvePython()
    const child = execFile(
      py.bin,
      [...py.args, script],
      { timeout, maxBuffer: MAX_OUTPUT_BYTES, cwd: process.cwd() },
      (err, stdout, stderr) => {
        const trimmed = (stdout || '').trim()

        // A timeout kill leaves no usable stdout; say so plainly rather than
        // reporting the empty-output parse failure that follows from it.
        if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          return resolve({ ok: false, error: `screener engine timed out after ${timeout}ms` })
        }

        if (!trimmed) {
          const detail = (stderr || '').trim() || (err ? err.message : 'no output')
          return resolve({ ok: false, error: `screener engine produced no result: ${detail}` })
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          return resolve({ ok: false, error: `screener engine output could not be read as JSON: ${trimmed.slice(0, 200)}` })
        }

        // The engine reports its own refusals as {error}, with a non-zero exit.
        if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
          const e = parsed as { error: string; detail?: string }
          return resolve({ ok: false, error: e.detail ? `${e.error} (${e.detail})` : e.error })
        }

        if (!isResult(parsed)) {
          return resolve({ ok: false, error: 'screener engine returned a document that is not a result' })
        }

        resolve({ ok: true, result: parsed, error: '' })
      },
    )

    child.on('error', (err) => {
      resolve({ ok: false, error: `screener engine could not be started: ${err.message}` })
    })

    // The job can be several megabytes; a broken pipe here (interpreter missing,
    // process already dead) must not raise an unhandled error on the server.
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(job))
  })
}

export interface EngineContract {
  schemaVersion: number
  gates: string[]
  patterns: string[]
  timeframes: string[]
}

/** Ask the engine what wire contract it implements.
 *
 *  Used by the tests to hold both languages to one definition of the gate list,
 *  the pattern vocabulary and the timeframes — asserting against the engine that
 *  will actually run, rather than against a fixture that can rot. */
export function readEngineContract(
  opts: RunOptions = {},
): Promise<{ ok: boolean; contract?: EngineContract; error: string }> {
  const script = opts.scriptPath ?? ENGINE_SCRIPT
  return new Promise((resolve) => {
    const py = opts.pythonBin ? { bin: opts.pythonBin, args: [] } : resolvePython()
    execFile(
      py.bin,
      [...py.args, script, '--contract'],
      { timeout: opts.timeoutMs ?? 15_000, cwd: process.cwd() },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: err.message })
        try {
          return resolve({ ok: true, contract: JSON.parse(stdout) as EngineContract, error: '' })
        } catch {
          return resolve({ ok: false, error: 'engine contract could not be read' })
        }
      },
    )
  })
}

/** Snapshot fields this adapter reads. Deliberately structural rather than
 *  importing CryptoSnapshot: this module must stay free of server/crypto.ts, which
 *  opens Gemini connections at import time. */
export interface SnapshotLike {
  tickers: Array<{ symbol: string; last: string; volume: string; change: number }>
  holdings: Array<{ currency: string }>
}

/** Turn a crypto snapshot into screener job inputs.
 *
 *  VOLUME IS CONVERTED HERE. Gemini denominates a ticker's 24h volume in the BASE
 *  currency, while the VOL 24H gate screens dollars — so a $3M BTC pair arrives as
 *  "48" and would fail a $1M floor without this multiplication. The conversion
 *  belongs on this side of the wire: the engine has no business knowing how one
 *  exchange denominates a field.
 */
export function screenerInputsFromSnapshot(
  snap: SnapshotLike,
  candles: (symbol: string, timeframe: string) => ScreenerCandle[],
  marketCaps: Map<string, number>,
  /** Cross-exchange 24h USD volume by BASE symbol, from CMC. */
  cmcVolumes: Map<string, number> = new Map(),
): ScreenerJobInputs {
  const tickers = snap.tickers
    // GUSD-quoted pairs (BTCGUSD, ETHGUSD) end in "USD" too, so the plain suffix
    // test the other tabs use lets them through. For a screener they are noise: a
    // far thinner duplicate listing of the same coin, which would rank beside the
    // real USD pair and invite a trade into the worse book.
    .filter((t) => t.symbol.endsWith('USD') && !t.symbol.endsWith('GUSD'))
    .map((t) => {
      const last = Number(t.last)
      const price = Number.isFinite(last) ? last : 0
      // Volume is CMC's market-wide aggregate, never Gemini's own book: one thin venue
      // does not represent the market, and a threshold tuned for market-wide dollars
      // would misread exchange-local ones by two orders of magnitude. No CMC read for
      // the coin means no volume — the gate degrades to ANY rather than judging the
      // market by Gemini's slice of it.
      return {
        symbol: t.symbol,
        last: price,
        change24h: num(t.change),
        volume24h: num(cmcVolumes.get(t.symbol.toUpperCase().replace(/USD$/, ''))),
      }
    })

  return {
    tickers,
    candles,
    marketCaps,
    held: new Set(snap.holdings.map((h) => `${h.currency.toUpperCase()}USD`)),
  }
}
