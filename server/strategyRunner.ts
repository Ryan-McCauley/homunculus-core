// Runs the `/crypto-strategy` slash command headlessly via the Agent SDK, so the
// CRYPTO tab can trigger a strategy run with a button. Uses the local Claude
// subscription (no billed API key), same as the Computer Core chat. One run at a
// time; the skill posts its report back to /api/crypto/plan-report when it finishes.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { auditLog, withActor } from './auditLog'
import { claudeProcesses } from './claudeProcesses'
import { stateStore } from './stateStore'

const MODEL = process.env['HOMUNCULUS_MODEL'] || ''

export type StrategyRunState = 'idle' | 'running' | 'done' | 'error'

// Selectable strategies the CRYPTO tab can trigger headlessly. Each maps to the
// slash command handed to the Agent SDK. Keep this the single source of truth —
// the API validates against it and the UI renders a switch from it.
export const STRATEGIES = {
  'crypto-strategy': { prompt: '/crypto-strategy', label: 'CRYPTO STRATEGY' },
  'btc-ladder': { prompt: '/btc-ladder', label: 'BTC LADDER' },
  'fast-cash': { prompt: '/fast-cash', label: 'FAST CASH' },
  oversold: { prompt: '/oversold', label: 'OVERSOLD' },
  'crypto-candles': { prompt: '/crypto-candles', label: 'CANDLES' },
  firecracker: { prompt: '/firecracker', label: 'FIRECRACKER' },
  sniper: { prompt: '/sniper', label: 'SNIPER' },
  reaper: { prompt: '/reaper', label: 'REAPER' },
  trapline: { prompt: '/trapline', label: 'TRAPLINE' }
} as const

export type StrategyId = keyof typeof STRATEGIES

export function isStrategyId(v: unknown): v is StrategyId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STRATEGIES, v)
}

// ── Enabled strategy (persisted preference) ─────────────────────────────────
// The single source of truth for "which strategy is enabled in the app". The UI
// segmented control writes it; a headless routine (`/crypto-strategy`) reads it to
// decide which strategy to actually run. Persisted to disk so it survives restarts.
const ENABLED_STRATEGY_FILE = join(process.cwd(), 'data', 'crypto', 'enabled-strategy.json')
const DEFAULT_ENABLED_STRATEGY: StrategyId = 'crypto-strategy'
let enabledStrategy: StrategyId = loadEnabledStrategy()

function loadEnabledStrategy(): StrategyId {
  try {
    if (existsSync(ENABLED_STRATEGY_FILE)) {
      const raw = stateStore.readJson<{ strategy?: unknown }>(ENABLED_STRATEGY_FILE, {})
      if (isStrategyId(raw.strategy)) return raw.strategy
    }
  } catch { /* ignore — fall back to default */ }
  return DEFAULT_ENABLED_STRATEGY
}

export function getEnabledStrategy(): StrategyId {
  return enabledStrategy
}

export function setEnabledStrategy(id: StrategyId): StrategyId {
  const previous = enabledStrategy
  enabledStrategy = id
  try {
    mkdirSync(join(process.cwd(), 'data', 'crypto'), { recursive: true })
    stateStore.writeJson(ENABLED_STRATEGY_FILE, { strategy: id })
  } catch (e) {
    console.warn('[strategy] enabled-strategy persist failed:', (e as Error).message)
  }
  auditLog.note({
    action: 'strategy.enabled',
    resource: `strategy:${id}`,
    summary: `enabled strategy set to ${id}`,
    before: { strategy: previous }, after: { strategy: id },
  })
  console.log('[strategy] enabled strategy set:', id)
  return enabledStrategy
}

// Where a run originated: 'app' = launched by the RUN button (this process drives
// it via the Agent SDK); 'routine' = a headless/scheduled run of the skill in its
// own Claude Code session that only signals us via heartbeat pings.
export type StrategyRunSource = 'app' | 'routine'

export interface StrategyRunStatus {
  state: StrategyRunState
  strategy: StrategyId // which strategy this run is/was for
  source: StrategyRunSource // who launched this run
  startedAt: number | null
  endedAt: number | null
  activity: string // short human-readable line: what the run is doing right now
  error: string | null
}

// A heartbeat older than this with no explicit 'end' is treated as a dead run, so a
// scheduled routine that crashes mid-way doesn't pin the "running" badge forever. The
// hourly routine spans ~1–3 min between its first and last script, well under this.
const EXTERNAL_RUN_TTL_MS = 6 * 60 * 1000

function localEnv(strategy?: StrategyId): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ANTHROPIC_API_KEY']
  delete env['ANTHROPIC_AUTH_TOKEN']
  // The helper scripts under .claude/scripts read this to stamp their writes with
  // an actor, so the audit log attributes them to the skill rather than to the operator.
  if (strategy) env['HOMUNCULUS_SKILL'] = `skill:${strategy}`
  return env
}

class StrategyRunner {
  private state: StrategyRunState = 'idle'
  private strategy: StrategyId = 'crypto-strategy'
  private startedAt: number | null = null
  private endedAt: number | null = null
  private activity = ''
  private error: string | null = null
  // When any run (app RUN button or headless routine) most recently STARTED. Drives the
  // "not run in the last N minutes" guard for loop mode.
  private lastRunAt: number | null = null
  /** Identity of the in-flight run, so its start and end land on the same row. */
  private runId: string | null = null

  // Tracks a headless/scheduled run happening outside this process (e.g. the hourly
  // routine). It can't stream progress to us, so it just pings a heartbeat; we infer
  // "running" from a fresh beat and clear on an explicit 'end' or once the TTL lapses.
  private external: { strategy: StrategyId; startedAt: number; lastBeatAt: number; activity: string } | null = null

  // True when a headless routine has pinged recently and not signaled completion.
  private externalRunning(): boolean {
    return this.external !== null && Date.now() - this.external.lastBeatAt < EXTERNAL_RUN_TTL_MS
  }

  getStatus(): StrategyRunStatus {
    // An in-process (RUN-button) run owns the status while active. Otherwise a live
    // external routine surfaces as a running/'routine' status so the UI can alert.
    if (this.state !== 'running' && this.externalRunning() && this.external) {
      return {
        state: 'running',
        strategy: this.external.strategy,
        source: 'routine',
        startedAt: this.external.startedAt,
        endedAt: null,
        activity: this.external.activity,
        error: null
      }
    }
    return {
      state: this.state,
      strategy: this.strategy,
      source: 'app',
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      activity: this.activity,
      error: this.error
    }
  }

  isRunning(): boolean {
    return this.state === 'running' || this.externalRunning()
  }

  // Epoch-ms when a run (app or routine) most recently started, or null if never.
  getLastRunAt(): number | null {
    return this.lastRunAt
  }

  // Records a heartbeat from a headless/scheduled routine. 'begin' starts (or refreshes)
  // it, 'beat' keeps it alive, 'end' clears it. Best-effort — driven by the skill's own
  // bookend scripts (crypto-session.py at the start, crypto-report-post.py at the finish).
  externalHeartbeat(phase: 'begin' | 'beat' | 'end', strategy: StrategyId = 'crypto-strategy', activity?: string): void {
    if (phase === 'end') {
      if (this.external) console.log('[strategy] external routine finished:', this.external.strategy)
      this.external = null
      return
    }
    const now = Date.now()
    if (!this.external || phase === 'begin') {
      this.external = { strategy, startedAt: now, lastBeatAt: now, activity: activity ?? 'Scheduled routine running…' }
      if (phase === 'begin') { this.lastRunAt = now; console.log('[strategy] external routine started:', strategy) }
    } else {
      this.external.lastBeatAt = now
      if (activity) this.external.activity = activity
    }
  }

  // Kicks off a run in the background. Returns false if one is already in flight —
  // including a headless routine, so a manual RUN can't collide with the hourly job.
  start(strategy: StrategyId = 'crypto-strategy'): boolean {
    if (this.state === 'running' || this.externalRunning()) return false
    this.strategy = strategy
    this.state = 'running'
    this.startedAt = Date.now()
    this.lastRunAt = this.startedAt
    this.endedAt = null
    this.error = null
    this.activity = `Starting ${STRATEGIES[strategy].label} run…`
    this.runId = `srun_${this.startedAt}_${strategy}`
    this.trackRun()
    auditLog.note({
      action: 'strategy.run.start',
      resource: `strategy:${strategy}`,
      summary: `${STRATEGIES[strategy].label} run started`,
      meta: { strategy },
    })
    // The run outlives this call, and interval-driven runs have no request behind
    // them; scoping it names the skill on everything it goes on to change.
    void withActor(`skill:${strategy}`, () => this.run())
    return true
  }


  /** Mirrors the current run into the durable timeline table. Fire-and-forget. */
  private trackRun(): void {
    if (!this.runId || this.startedAt === null) return
    void stateStore.saveRun({
      id: this.runId,
      component: `skill:${this.strategy}`,
      label: STRATEGIES[this.strategy].label,
      trigger: 'app',
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      state: this.state === 'running' ? 'running' : this.state === 'error' ? 'error' : 'done',
      summary: this.error ?? this.activity,
    })
  }

  private async run(): Promise<void> {
    const proc = claudeProcesses.register({
      kind: 'skill', label: STRATEGIES[this.strategy].label, component: `skill:${this.strategy}`,
      detail: 'strategy run', model: MODEL,
    })
    try {
      const response = query({
        prompt: STRATEGIES[this.strategy].prompt,
        options: {
          ...(MODEL ? { model: MODEL } : {}),
          abortController: proc.controller,
          permissionMode: 'bypassPermissions',
          includePartialMessages: true,
          cwd: process.cwd(),
          env: localEnv(this.strategy)
        }
      })

      for await (const message of response) {
        if (message.type === 'stream_event') {
          const ev = message.event as {
            type: string
            content_block?: { type?: string; name?: string }
            delta?: { type?: string; text?: string }
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.name) {
            this.activity = `Running ${ev.content_block.name}…`
          } else if (
            ev.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            ev.delta.text?.trim()
          ) {
            // Keep the tail of the latest reasoning/output line as the activity.
            const line = ev.delta.text.trim().split('\n').pop() ?? ''
            if (line) this.activity = line.slice(0, 160)
          }
        } else if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) {
            const detail = 'result' in message && message.result ? message.result : message.subtype
            throw new Error(String(detail))
          }
        }
      }

      this.state = 'done'
      this.activity = 'Strategy run complete.'
      this.endedAt = Date.now()
      this.trackRun()
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err)
      if (/401|authenticat|credential/i.test(msg)) {
        msg = 'No local Claude session. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.'
      }
      if (proc.wasStopped()) {
        console.log('[strategy] run stopped by operator')
        this.state = 'done'
        this.activity = 'Stopped before completion.'
      } else {
        console.error('[strategy] run failed:', msg)
        this.state = 'error'
        this.error = msg
        this.activity = 'Strategy run failed.'
      }
      this.endedAt = Date.now()
      this.trackRun()
    } finally {
      proc.done()
    }
  }
}

export const strategyRunner = new StrategyRunner()
