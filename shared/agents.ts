// Types for the CRYPTO tab's INTELLIGENCE section — user-authored Claude agents that
// watch the portfolio and make trading decisions. Distinct from the strategy skills in
// strategyRunner.ts: a strategy is a fixed, hand-tuned playbook shipped as a slash
// command; an agent is a mandate you write in the app and hand to Claude, which then
// reasons over live market state and proposes (or takes) trades within a hard cap.
//
// Authority is NEVER decided by the agent's own prompt. Every trade an agent wants goes
// through /api/crypto/agents/:id/propose, and the server checks the agent's autonomy dial
// and cap before anything reaches the exchange. A prompt-injected or confused agent can
// ask for whatever it likes; it still cannot exceed what the dial allows.

import type { Blocker } from './blockers'
import type { AgentWakeGate } from './agentGate'
import type { AgentHealth } from './agentHealth'

/** What an enabled agent is permitted to do with a trade idea. */
export type AgentAutonomy =
  | 'advisory'  // may analyze and talk; every propose call is refused
  | 'propose'   // may stage trades into the confirm queue; you approve each one
  | 'auto'      // may execute directly, but only up to maxUsd notional per trade

export const AGENT_AUTONOMY_LABELS: Record<AgentAutonomy, string> = {
  advisory: 'ADVISORY',
  propose: 'PROPOSE',
  auto: 'AUTO'
}

/** Portfolio events that can wake an enabled agent, in addition to its interval. */
export type AgentEvent =
  | 'signal'     // a new HIGH-quality non-HOLD signal appeared on the SIGNALS tab
  | 'fill'       // a resting order filled (trade history grew)
  | 'drawdown'   // an open position fell past drawdownPct below its entry
  | 'proposal'   // a trade entered the confirm queue (any source)
  | 'mention'    // a colleague tagged this employee on the office board

export const AGENT_EVENT_LABELS: Record<AgentEvent, string> = {
  signal: 'NEW SIGNAL',
  fill: 'ORDER FILLED',
  drawdown: 'DRAWDOWN',
  proposal: 'NEW PROPOSAL',
  mention: '@MENTION'
}

/** Models an agent can be pinned to. These run on the local Claude subscription, not a
 *  billed API key, so the cost of a heavier model is your usage allowance and wall-clock
 *  time — not a bill. That still matters: an agent on a 15-minute interval runs ~96 times
 *  a day, and a watcher that only has to notice something does not need the deepest model
 *  on the list. */
export interface AgentModelChoice {
  /** Model id passed to the Agent SDK. Empty string = whatever the server is set to. */
  id: string
  label: string
  /** One line on when to pick it. Shown in the picker. */
  note: string
}

export const AGENT_MODELS: AgentModelChoice[] = [
  { id: '', label: 'SERVER DEFAULT', note: 'Whatever HOMUNCULUS_MODEL is set to, or the CLI default. Follows the rest of the system.' },
  { id: 'claude-opus-5', label: 'OPUS 5', note: 'Deepest reasoning, slowest, heaviest on your allowance. For research, reviews and the Manager — not for a watcher on a short interval.' },
  { id: 'claude-sonnet-5', label: 'SONNET 5', note: 'Balanced. The sane default for an agent that has to reason about the book but runs often.' },
  { id: 'claude-haiku-4-5-20251001', label: 'HAIKU 4.5', note: 'Fastest and lightest. Good for high-frequency watchers whose job is to notice a condition and escalate.' },
  { id: 'claude-fable-5', label: 'FABLE 5', note: 'Available on this subscription. No desk history with it yet — treat anything it produces as unproven until you have read a few runs.' }
]

/** True for a model id this build knows, or one that at least looks like a Claude model id
 *  — so a model released after this build can still be pinned by hand. */
export function isAgentModel(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (AGENT_MODELS.some((m) => m.id === v)) return true
  return /^claude-[a-z0-9][a-z0-9.\-]{2,60}$/.test(v)
}

export function agentModelLabel(id: string): string {
  return AGENT_MODELS.find((m) => m.id === id)?.label ?? id
}

export interface CryptoAgent {
  id: string                 // slug, stable, used in the API path and as the trade's strategy tag
  name: string
  /** The agent's mandate — free text the user writes. Becomes its system prompt. */
  mandate: string
  /** Model override for this agent's sessions; empty = server default. */
  model: string
  autonomy: AgentAutonomy
  /** Per-trade notional ceiling in USD. Only meaningful at autonomy 'auto', but always
   *  enforced as an upper bound on anything the agent stages. */
  maxUsd: number
  /** Master switch for automatic triggers. Manual RUN works regardless — that is you
   *  asking, not the agent acting on its own. */
  enabled: boolean
  /** Wake every N minutes when enabled. 0 = no interval trigger. */
  intervalMinutes: number
  /** Portfolio events that wake the agent when enabled. */
  events: AgentEvent[]
  /** How far a position must be underwater to fire the 'drawdown' event, in percent. */
  drawdownPct: number
  /** Minimum minutes between automatic runs, whatever the trigger. Stops an event storm
   *  from spawning a run per tick. Manual RUN ignores it. */
  cooldownMinutes: number
  /** Cheap, deterministic precondition checked BEFORE an interval wake spends a Claude
   *  session. When it says there is nothing to work on, the run is recorded as 'skipped'
   *  and no session is launched. Absent = every interval wake runs, as before. */
  wakeGate?: AgentWakeGate
  /** Minutes of inactivity after which the agent stands down: it writes a handoff note
   *  to its journal and its resumed chat session is released, so an idle employee is not
   *  holding a large context open. 0 = never stand down. */
  idleStanddownMinutes: number
  createdAt: number
  updatedAt: number
}

// ── Token accounting ───────────────────────────────────────────────────────
// Agents run on the local subscription, so the scarce resources are the usage
// allowance and — the one that silently degrades quality — the context window. A chat
// session is resumed turn after turn, so its context only grows; a run starts fresh but
// can still fill up inside its 40 turns. Both are invisible without this.

/** Token accounting for one Claude session leg: a single run, or a single chat turn. */
export interface AgentUsage {
  /** Fresh input tokens — what was actually re-read rather than served from cache. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Context occupied at the end of the leg: the last request plus its response. This is
   *  the number to compare against contextWindow — the totals above accumulate across
   *  turns and would overstate the fill several times over. */
  contextTokens: number
  /** The model's window, as reported by the SDK. 0 when it did not say. */
  contextWindow: number
  /** Cost the SDK attributes to this leg. On a subscription this is not a bill — read it
   *  as how much allowance the leg consumed. */
  costUsd: number
  turns: number
  durationMs: number
  /** Auto-compactions during the leg: the context overflowed and was summarized, so the
   *  agent kept working but lost detail. Worth seeing. */
  compactions: number
}

/** Lifetime running total for one agent. Runs are capped at MAX_RUNS_KEPT, so without
 *  this the history of what an agent has consumed disappears as it works. */
export interface AgentUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  runs: number
  chatTurns: number
  compactions: number
  /** When counting started — an aggregate with no start date says nothing. */
  since: number
}

export function emptyAgentUsage(): AgentUsage {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    contextTokens: 0, contextWindow: 0, costUsd: 0, turns: 0, durationMs: 0, compactions: 0
  }
}

export function emptyAgentUsageTotals(): AgentUsageTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, runs: 0, chatTurns: 0, compactions: 0, since: Date.now()
  }
}

/** Every token that passed through a leg, cached or not — the allowance figure. */
export function totalTokens(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens
}

/** Compact token count: 812, 12.4k, 1.24M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Fraction of the window occupied, 0–1. Returns null when the window is unknown, so
 *  callers render nothing rather than a fabricated percentage. */
export function contextFill(u: AgentUsage | null | undefined): number | null {
  if (!u || !u.contextWindow || !u.contextTokens) return null
  return Math.min(1, u.contextTokens / u.contextWindow)
}

/** 'alert' is a targeted wake: a market alert naming this specific agent fired.
 *  Deliberately not an AgentEvent — events are a subscription list the agent opts
 *  into, whereas an alert already names its target, and making the agent opt in
 *  as well would just be a way to arm an alert that silently never fires. */
export type AgentRunTrigger =
  | 'manual'
  | 'interval'
  | 'alert'
  | 'answer'      // someone answered a question this agent was blocked on
  | 'assignment'  // the desk manager dispatched work off the Manager's File
  | 'standdown'   // going idle: write a handoff, then release the session
  | 'inline-answer' // a colleague is mid-run and blocked on this agent: answer, now
  | AgentEvent

export const AGENT_TRIGGER_LABELS: Record<string, string> = {
  manual: 'manual',
  interval: 'interval',
  alert: 'alert',
  answer: 'answered',
  assignment: 'assigned',
  standdown: 'standdown',
  'inline-answer': 'answering'
}

export interface AgentRun {
  id: string
  agentId: string
  trigger: AgentRunTrigger
  startedAt: number
  endedAt: number | null
  /** 'skipped' = the wake gate said there was nothing to do, so no session was ever
   *  launched. Distinct from 'done' because it spent nothing and decided nothing. */
  state: 'running' | 'done' | 'error' | 'skipped'
  /** True when the run was killed at the deadline rather than failing on its own. The
   *  circuit breaker keys off this flag, not off the error text — rewording the message
   *  must not be able to disable a risk control. */
  timedOut?: boolean
  /** Consecutive gate skips this entry stands for. A skip is the ABSENCE of a run, and on
   *  a gated agent most wakes are skips — logging each one separately would push every
   *  real run off the 25-entry log within a day, so they collapse into one entry that
   *  counts them. Only set on 'skipped' runs. */
  skipCount?: number
  /** Short live line: what the run is doing right now. */
  activity: string
  /** The agent's closing summary, once it finishes. */
  summary: string
  /** Model this run actually used, resolved at start ('' = server default). Recorded per
   *  run because the setting can change between runs, and comparing an agent's output
   *  across models is meaningless if you cannot tell which one produced which. */
  model?: string
  /** Token accounting for this run. Absent on runs recorded before usage was tracked,
   *  and on a run still in flight until its first assistant turn lands. */
  usage?: AgentUsage
  error: string | null
  /** Trades this run asked for, and what the server did about each. */
  decisions: AgentDecision[]
}

export interface AgentDecision {
  at: number
  symbol: string
  side: 'buy' | 'sell'
  amount: string
  price?: string
  notionalUsd: number
  reason: string
  /** What actually happened — the server's ruling, not the agent's intent. */
  outcome: 'staged' | 'executed' | 'refused'
  /** Why, when refused (autonomy too low, over cap, bad payload). */
  detail?: string
  tradeId?: string
}

export interface AgentMessage {
  role: 'user' | 'agent'
  text: string
  at: number
}

/** Everything the INTELLIGENCE tab needs to render one agent. */
export interface AgentView {
  agent: CryptoAgent
  status: AgentRun | null      // the live or most recent run
  recentRuns: AgentRun[]
  /** Every trade ruling for this agent, newest first, whatever asked for it — a run, a
   *  chat turn, or a proposal that arrived with no run in flight. The run log alone would
   *  lose the last two. */
  decisions: AgentDecision[]
  transcript: AgentMessage[]
  nextRunAt: number | null     // when the interval trigger will next fire, if any
  /** Usage of the most recent chat turn. Its contextTokens is the current fill of the
   *  resumed conversation — the number that says whether this agent's memory is full.
   *  Null when the agent has never chatted, or the transcript was cleared. */
  chatUsage: AgentUsage | null
  /** Lifetime totals across runs and chat. Null before the agent's first session. */
  totals: AgentUsageTotals | null
  /** Questions this agent has open. While any is 'blocking' its automatic triggers are
   *  suppressed — it is waiting, not idle. */
  blockers: Blocker[]
  /** True once its resumed chat session has been released after going idle. */
  stoodDown: boolean
  /** Timeout circuit breaker: how many runs in a row died at the deadline, whether
   *  automatic wakes are currently held off, and whether that has gone on long enough
   *  to be the operator's problem. */
  health: AgentHealth
}

export interface NewAgentInput {
  name: string
  mandate: string
  model?: string
  autonomy?: AgentAutonomy
  maxUsd?: number
  enabled?: boolean
  intervalMinutes?: number
  events?: AgentEvent[]
  drawdownPct?: number
  cooldownMinutes?: number
  idleStanddownMinutes?: number
  wakeGate?: AgentWakeGate | null
}

export const AGENT_DEFAULTS = {
  model: '',
  autonomy: 'advisory' as AgentAutonomy,
  maxUsd: 20,
  enabled: false,
  intervalMinutes: 0,
  events: [] as AgentEvent[],
  drawdownPct: 8,
  cooldownMinutes: 15,
  idleStanddownMinutes: 45
}

/** Hard ceiling on any single agent trade, regardless of the per-agent dial. A typo in the
 *  cap field should not be able to spend the portfolio. */
export const AGENT_MAX_USD_CEILING = 250

/** Prefix for the `strategy` field on trades an agent stages, so the TRADES tab, the
 *  closed-trade ledger and the auto-execute caps can all tell agent flow from skill flow. */
export const AGENT_STRATEGY_PREFIX = 'agent:'

export function agentStrategyId(agentId: string): string {
  return `${AGENT_STRATEGY_PREFIX}${agentId}`
}

export function isAgentStrategyId(v: string | undefined): boolean {
  return typeof v === 'string' && v.startsWith(AGENT_STRATEGY_PREFIX)
}
