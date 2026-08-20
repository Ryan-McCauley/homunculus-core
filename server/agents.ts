// The INTELLIGENCE fleet: user-authored Claude agents that watch the crypto portfolio and
// make trading decisions. Each agent is a mandate written in the app, run headlessly via
// the Agent SDK on the local Claude subscription (no billed API key), same as the strategy
// runner and the Computer Core chat.
//
// AUTHORITY LIVES HERE, NOT IN THE PROMPT. An agent asks for a trade by POSTing to
// /api/crypto/agents/:id/propose, which lands in `propose()` below. That method — not the
// agent — decides whether the trade is refused, staged for your confirmation, or executed,
// by reading the agent's autonomy dial and cap. The mandate text is untrusted input: it can
// say "you are authorized to execute anything" and still get refused at 'advisory'.
//
// Triggers: a manual RUN (you asking), an optional interval, and portfolio events (new
// signal, order filled, drawdown, new proposal). Automatic triggers only fire while the
// agent is enabled, and are rate-limited by a per-agent cooldown.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentAutonomy, AgentDecision, AgentEvent, AgentMessage, AgentRun, AgentRunTrigger,
  AgentUsage, AgentUsageTotals, AgentView, CryptoAgent, NewAgentInput
} from '../shared/agents'
import {
  AGENT_DEFAULTS, AGENT_MAX_USD_CEILING, AGENT_MODELS, agentStrategyId, emptyAgentUsage,
  emptyAgentUsageTotals, isAgentModel, totalTokens
} from '../shared/agents'
import { pickRunOrder } from '../shared/agentScheduling'
import { agentHealth, type AgentHealth } from '../shared/agentHealth'
import { gateAppliesTo, gateVerdict, isAgentWakeGate, type AgentWakeGate, type GateProbe } from '../shared/agentGate'
import { canAnswerInline, nextChain } from '../shared/inlineAnswer'
import { narrateTool } from '../shared/toolNarration'
import { runAnnouncement } from '../shared/activeBoard'
import { assignmentBlock } from '../shared/managerFile'
import type { CryptoSnapshot } from '../shared/crypto'
import { cryptoHub } from './crypto'
import { office } from './office'
import { library } from './library'
import { blockerBoard } from './blockers'
import { managerFile } from './managerFile'
import { stateStore } from './stateStore'
import { ALERT_MAX_PER_CREATOR, alertCatalogText } from '../shared/alerts'
import { bindFleet } from './cryptoAlerts'
import { auditLog, withActor } from './auditLog'
import { constantTimeEquals } from '../shared/audit'
import { claudeProcesses } from './claudeProcesses'
import { claudeResultError } from './claudeResult'
import { agentEnv } from './agentEnv'
import { screenerStore } from './screenerStore'
import { buildScreenerJob, runScreenerEngine, screenerInputsFromSnapshot } from './screenerRunner'

const MODEL = process.env['HOMUNCULUS_MODEL'] || ''

const AGENTS_DIR = join(process.cwd(), 'data', 'crypto')
const AGENTS_FILE = join(AGENTS_DIR, 'agents.json')

// Kept per agent, oldest dropped. Enough to see a day of activity without unbounded growth.
const MAX_RUNS_KEPT = 25
const MAX_TRANSCRIPT_KEPT = 60
const MAX_DECISIONS_KEPT = 60
// One agent session at a time process-wide. These are full Claude sessions; letting an
// event storm fan out into a dozen concurrent runs would be both slow and expensive.
const MAX_CONCURRENT_RUNS = 1
// How often the event watcher samples the crypto snapshot.
const WATCH_INTERVAL_MS = 30_000
// An agent run that somehow never settles is force-failed after this, so the fleet does not
// deadlock behind a stuck session.
const RUN_TIMEOUT_MS = 10 * 60_000
// TRD-02: maxUsd and AGENT_MAX_USD_CEILING both bound a single trade — nothing previously
// bounded how many of those an 'auto' agent could place back to back. A $20-cap agent could
// legitimately auto-execute forty $19 trades in one interval-triggered run and stay under
// every per-trade check the whole way. This is the cumulative half of that gate: no agent may
// auto-execute more than ROLLING_BUDGET_MULTIPLIER × its own per-trade cap within a rolling
// window. Tracked in a dedicated, time-trimmed spend ledger (AgentRecord.spendLog) rather
// than derived from rec.decisions: that array is capped by COUNT across all outcomes, so an
// agent could flush its own executed rows out of the window with cheap refused proposals and
// win back a fresh budget. See rollingSpend().
const ROLLING_BUDGET_WINDOW_MS = 24 * 60 * 60_000
const ROLLING_BUDGET_MULTIPLIER = 10
// Turns one run may take. Was 40, which the desk's research roles hit routinely — a run
// that dies on the limit has already spent everything it spent, so the cheap fix is to let
// the long ones land rather than pay for them twice.
const MAX_RUN_TURNS = 60

interface AgentRecord {
  agent: CryptoAgent
  runs: AgentRun[]
  transcript: AgentMessage[]
  /** Rolling log of every trade ruling for this agent, newest first. Kept separately from
   *  the runs because a decision can arrive with no run in flight (a chat turn asking the
   *  agent to buy something), and those must not vanish from the audit trail. */
  decisions?: AgentDecision[]
  /** Auto-executed notional, for the rolling budget. Deliberately separate from
   *  `decisions` (which is count-capped and therefore evictable by the spender) and
   *  trimmed only by time. Nothing but real executions is appended here. */
  spendLog?: { at: number; usd: number }[]
  /**
   * This agent's own credential for /propose. Generated at hire, injected only into
   * THIS agent's system prompt, and never returned by any read route.
   *
   * Without it, the autonomy dial keyed off the URL rather than the caller: every
   * agent id appears in every agent's prompt under COLLEAGUES, and every agent runs
   * on localhost where the shared token is waived — so an ADVISORY agent (or any
   * injected instruction reaching any agent) could POST to an AUTO agent's propose
   * URL and get immediate execution under that agent's cap. The advisory/propose/
   * auto distinction was a prompt-level suggestion; this makes it enforceable.
   */
  proposeKey?: string
  /** Agent SDK session id, so chat turns resume rather than re-explaining every time. */
  sessionId?: string
  /** Usage of the last chat turn. Because chat resumes `sessionId`, its contextTokens is
   *  the live fill of that conversation — cleared whenever the session is. */
  chatUsage?: AgentUsage
  /** Lifetime usage. Runs roll off at MAX_RUNS_KEPT; this does not. */
  totals?: AgentUsageTotals
  /** Last time this agent actually did anything — a run or a chat turn. Drives the idle
   *  standdown sweep. */
  lastActiveAt?: number
  /** When its session was last released for being idle. */
  stoodDownAt?: number
  lastAutoRunAt?: number
  /** When the timeout circuit breaker was last announced, so a tripped agent says so once
   *  rather than on every subsequent timeout. Cleared by any completed run. */
  breakerAnnouncedAt?: number
}

interface PersistShape {
  agents: AgentRecord[]
}

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return base || `agent-${Date.now()}`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** A model id the SDK will accept, or '' for the server default. A typo here would not
 *  fail until the next run — and then on every run after it — so it is rejected at the
 *  point of setting instead, where the operator is looking at the error. */
function normalizeModel(v: string | undefined): string {
  const m = (v ?? '').trim()
  if (!m) return AGENT_DEFAULTS.model
  if (!isAgentModel(m)) {
    throw new Error(`unknown model "${m}" — pick one of: ${AGENT_MODELS.map((c) => c.id || 'server default').join(', ')}`)
  }
  return m
}

// ── Token accounting ───────────────────────────────────────────────────────
// Read structurally off the SDK messages rather than through its exported types: the
// fields below are present on both the success and the error result, and a run that
// failed still spent the tokens it spent. Dropping those would make the totals lie.

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

interface ResultShape {
  usage?: Record<string, unknown>
  modelUsage?: Record<string, { contextWindow?: number; costUSD?: number }>
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
}

interface AssistantShape {
  message?: { usage?: Record<string, unknown>; model?: string }
}

/** Context occupied by a single API call: everything sent (fresh, cached, or written to
 *  cache) plus what came back. This must come from ONE assistant turn — the aggregate on
 *  the result message sums every turn in the session and would report a context several
 *  times larger than the window. */
function contextOf(u: Record<string, unknown> | undefined): number {
  if (!u) return 0
  return num(u['input_tokens']) + num(u['cache_read_input_tokens']) +
    num(u['cache_creation_input_tokens']) + num(u['output_tokens'])
}

/** Folds one assistant turn into the leg's usage, tracking the high-water context mark. */
function trackAssistant(usage: AgentUsage, message: unknown): void {
  const ctx = contextOf((message as AssistantShape).message?.usage)
  // The last turn is normally the largest, but a compaction resets it downward — keeping
  // the peak is what answers "did this session get close to the ceiling".
  if (ctx > usage.contextTokens) usage.contextTokens = ctx
}

/** Fills in the session-level totals once the result message arrives. Preserves any
 *  contextTokens already learned from the assistant turns. */
function applyResult(usage: AgentUsage, message: unknown, model: string): void {
  const m = message as ResultShape
  const u = m.usage ?? {}
  usage.inputTokens = num(u['input_tokens'])
  usage.outputTokens = num(u['output_tokens'])
  usage.cacheReadTokens = num(u['cache_read_input_tokens'])
  usage.cacheCreationTokens = num(u['cache_creation_input_tokens'])
  usage.turns = num(m.num_turns)
  usage.durationMs = num(m.duration_ms)
  usage.costUsd = num(m.total_cost_usd)

  // The window belongs to the model that ran. Prefer the entry matching this agent's
  // pinned model; otherwise take the largest reported, since a session that used several
  // models is bounded by the roomiest of them.
  const mu = m.modelUsage ?? {}
  const exact = model ? mu[model] : undefined
  if (exact?.contextWindow) {
    usage.contextWindow = num(exact.contextWindow)
  } else {
    for (const entry of Object.values(mu)) usage.contextWindow = Math.max(usage.contextWindow, num(entry?.contextWindow))
  }
  if (!usage.costUsd) {
    for (const entry of Object.values(mu)) usage.costUsd += num(entry?.costUSD)
  }
}

/** Short token count for a log line. */
function fmtCtx(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Adds a finished leg to the agent's lifetime totals. */
function foldTotals(rec: AgentRecord, usage: AgentUsage, kind: 'run' | 'chat'): void {
  const t = rec.totals ?? (rec.totals = emptyAgentUsageTotals())
  t.inputTokens += usage.inputTokens
  t.outputTokens += usage.outputTokens
  t.cacheReadTokens += usage.cacheReadTokens
  t.cacheCreationTokens += usage.cacheCreationTokens
  t.costUsd += usage.costUsd
  t.compactions += usage.compactions
  if (kind === 'run') t.runs += 1
  else t.chatTurns += 1
}

// ── Context the agent reasons over ─────────────────────────────────────────
// Deliberately compact: the full snapshot is ~750 KB, almost all of it candle-derived
// signal detail the agent can pull on demand via the REST API if it wants it.

function marketContext(snap: CryptoSnapshot): string {
  const tmap = new Map(snap.tickers.map((t) => [t.symbol, t]))
  const lines: string[] = []

  const STABLE = new Set(['USD', 'USDT', 'USDC', 'DAI', 'GUSD', 'PAX', 'PYUSD'])
  const usd = snap.holdings.find((h) => h.currency === 'USD')
  lines.push('[PORTFOLIO]')
  lines.push(`Cash: $${Number(usd?.available ?? usd?.amount ?? 0).toFixed(2)} available`)
  for (const h of snap.holdings) {
    if (STABLE.has(h.currency)) continue
    const notional = Number(h.amountNotional) || 0
    if (notional < 1) continue
    const pnl = h.unrealizedPnlPct === undefined ? '' : ` · ${h.unrealizedPnlPct >= 0 ? '+' : ''}${h.unrealizedPnlPct.toFixed(1)}%`
    lines.push(`${h.currency}: ${h.amount} ≈ $${notional.toFixed(2)}${pnl}`)
  }

  if (snap.openOrders.length > 0) {
    lines.push('', '[RESTING ORDERS]')
    for (const o of snap.openOrders.slice(0, 20)) {
      const px = Number(tmap.get(o.symbol)?.last) || 0
      const dist = px && Number(o.price) ? ((Number(o.price) - px) / px) * 100 : 0
      lines.push(`${o.symbol} ${o.side} ${o.remainingAmount ?? o.originalAmount} @ ${o.price} (${dist >= 0 ? '+' : ''}${dist.toFixed(1)}% from last)`)
    }
  }

  if (snap.pending.length > 0) {
    lines.push('', '[AWAITING YOUR CONFIRMATION]')
    for (const p of snap.pending.slice(0, 15)) {
      lines.push(`${p.symbol} ${p.side} ${p.amount}${p.price ? ` @ ${p.price}` : ''} — ${p.reason.slice(0, 100)}${p.strategy ? ` [${p.strategy}]` : ''}`)
    }
  }

  const live = snap.signals
    .filter((s) => s.seeded && s.direction !== 'HOLD')
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 12)
  if (live.length > 0) {
    lines.push('', '[TOP SIGNALS]')
    for (const s of live) {
      const px = Number(tmap.get(s.symbol)?.last) || 0
      lines.push(`${s.symbol} ${s.direction} ${s.strength}/100 ${s.entryQuality} · last ${px} · ${s.reasons.slice(0, 2).join('; ')}`)
    }
  }

  // The regime block the strategy skills gate on — same source of truth, so an agent's
  // read of the market matches what /crypto-candles and /sniper are seeing.
  const regime = /^## [^\n]*MARKET REGIME.*?(?=\n## |$)/ms.exec(snap.intelReport)
  if (regime) lines.push('', regime[0].trim())

  return lines.join('\n')
}

/** The employee's own file, colleagues, reading list and unread @mentions, rendered for
 *  the prompt. This is identity and context — it grants no authority of any kind. */
function officeContext(
  agent: CryptoAgent,
  roster: { id: string; name: string; title: string }[],
  apiBase: string,
  token: string
): string {
  const p = office.ensurePersonnel(agent.id, agent.name)
  const lines: string[] = []
  lines.push(`YOUR PERSONNEL FILE — ${p.employeeId} · ${p.title} · ${p.department.toUpperCase()} · ${p.status.toUpperCase()}`)
  if (p.reportsTo) {
    const boss = roster.find((r) => r.id === p.reportsTo)
    lines.push(`Reports to: ${boss ? `${boss.name} (${boss.title}, @${boss.id})` : p.reportsTo}`)
  }
  if (p.resume.summary) lines.push(`Profile: ${p.resume.summary}`)
  if (p.resume.specialties.length) lines.push(`Specialties: ${p.resume.specialties.join(', ')}`)
  if (p.jobDescription.responsibilities.length) {
    lines.push('Responsibilities:', ...p.jobDescription.responsibilities.map((r) => `  - ${r}`))
  }
  if (p.jobDescription.kpis.length) {
    lines.push('You will be reviewed on:', ...p.jobDescription.kpis.map((k) => `  - ${k}`))
  }
  if (p.sources.length) {
    lines.push('YOUR SOURCES — what you are expected to consult:',
      ...p.sources.map((sr) => `  [${sr.kind}] ${sr.ref}${sr.note ? ` — ${sr.note}` : ''}`))
  }

  const managerId = managerFile.managerId()
  const isManager = managerId === agent.id
  const colleagues = roster.filter((r) => r.id !== agent.id)
  lines.push('', 'COLLEAGUES — who is on the desk:')
  lines.push(colleagues.length
    ? colleagues.map((c) => `  @${c.id} — ${c.name}, ${c.title}${c.id === managerId ? '  ← the desk manager' : ''}`).join('\n')
    : '  (none yet — you are the first hire)')
  lines.push('  @operator — the human who owns this portfolio.')

  if (isManager) {
    // The manager is the only employee who reads the file, and working it is their job
    // rather than a courtesy — every question on the desk arrives here.
    lines.push('', managerFile.digest())
    lines.push('', "WORKING THE FILE — this is your core duty, ahead of any analysis you might do yourself.",
      'Take every NEEDS TRIAGE item and do exactly one of three things with it. Batch by owner:',
      'if three items all want something from @plumbline, that is ONE assignment naming all three,',
      'not three wake-ups. Each colleague may hold 3 open items at a time, so spend them well.',
      '',
      '  1. ASSIGN it — this is what wakes a colleague, and the instruction is what they act on.',
      `     curl -s -X POST "${apiBase}/api/crypto/office/manager-file/<itemId>/assign?token=${token}" \\`,
      `       -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\`,
      `       -d '{"to":"plumbline","instruction":"exactly what you want back, and in what form"}'`,
      '  2. ANSWER it yourself, when you already know and dispatching would just be latency:',
      `     curl -s -X POST "${apiBase}/api/crypto/office/manager-file/<itemId>/answer?token=${token}" \\`,
      `       -H 'Content-Type: application/json' -d '{"answer":"the decision, stated plainly"}'`,
      '  3. CLOSE it — handled elsewhere, superseded, or not worth the desk\'s time:',
      `     curl -s -X POST "${apiBase}/api/crypto/office/manager-file/<itemId>/close?token=${token}" \\`,
      `       -H 'x-homunculus-actor: agent:${agent.id}'`,
      '',
      'ANSWERED items are yours to fold into one reply on the originating thread and then close.',
      'Do not leave the file dirty: an item you neither assigned, answered nor closed is a',
      'question nobody owns, and you are the only person who sees it.')
  } else {
    const mine = managerFile.open().filter((i) => i.assignedTo === agent.id)
    if (mine.length) {
      lines.push('', `ASSIGNED TO YOU — ${mine.length} item(s) from the desk manager. Answer each on the file:`)
      for (const i of mine) {
        lines.push(`  [${i.id}] from @${i.fromId}: ${i.instruction}${i.status === 'answered' ? '  (answered)' : ''}`)
      }
      lines.push(`  curl -s -X POST "${apiBase}/api/crypto/office/manager-file/<itemId>/answer?token=${token}" \\`,
        `    -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\`,
        `    -d '{"answer":"what you found, with the number and the method"}'`)
    }
  }

  const journal = office.readJournal(agent.id).slice(0, 5)
  if (journal.length) {
    lines.push('', 'YOUR RECENT JOURNAL NOTES:')
    for (const j of journal) lines.push(`  - ${j.title ? `${j.title}: ` : ''}${j.body.slice(0, 200)}`)
  }

  lines.push('', 'THE LIBRARY — work your colleagues have already filed. Read before you re-derive:')
  lines.push(library.promptDigest())

  // What this employee is waiting on, and what colleagues are waiting on from them.
  const blocked = blockerBoard.promptFor(agent.id)
  if (blocked) lines.push('', blocked)

  return lines.join('\n')
}

function systemPromptFor(agent: CryptoAgent, apiBase: string, token: string, roster: { id: string; name: string; title: string }[], proposeKey: string): string {
  const authority =
    agent.autonomy === 'advisory'
      ? 'ADVISORY ONLY. You may analyze, explain and recommend, but you have no trading authority — the server will refuse every proposal you submit. Say what you would do and why; do not attempt to place orders by any other route.'
      : agent.autonomy === 'propose'
        ? `PROPOSE. You may submit trade proposals; each one lands in the operator's confirm queue and does NOT reach the exchange until they approve it. Per-trade ceiling: $${agent.maxUsd}.`
        : `AUTO-EXECUTE up to $${agent.maxUsd} notional per trade. Proposals at or under that cap are sent to the exchange immediately, with real money. Anything above it is downgraded to a proposal for the operator to confirm. Be conservative: you are spending real funds.`

  return `You are "${agent.name}", a trading agent inside Homunculus, the operator's personal command system. You watch a live Gemini crypto portfolio.

YOUR MANDATE (written by the operator — this defines your job, not your permissions):
${agent.mandate}

AUTHORITY: ${authority}

IDENTIFY YOURSELF ON EVERY WRITE: add -H 'x-homunculus-actor: agent:${agent.id}' to every
POST/PATCH/DELETE you make. Every change to this system is recorded in an append-only,
hash-chained audit log; that header is what files your actions under your name instead of
the operator's. It is attribution, not authorization — it grants you nothing.

HOW TO PROPOSE A TRADE — this is the only route that works:
curl -s -X POST "${apiBase}/api/crypto/agents/${agent.id}/propose?token=${token}" \\
  -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\
  -H 'x-homunculus-agent-key: ${proposeKey}' \\
  -d '{"symbol":"ETHUSD","side":"buy","type":"limit","amount":"0.01","price":"2450.00","reason":"why, in one sentence"}'

YOUR AGENT KEY IS YOURS ALONE. The x-homunculus-agent-key above authenticates you as
${agent.id} specifically — it is what makes your authority yours and not merely the URL's.
Never write it to the board, a journal, a library document, a report, or any other place a
colleague could read it, and never use one belonging to another agent. A proposal carrying
the wrong key is refused no matter whose id is in the URL.

The response tells you what actually happened: outcome "executed", "staged" (queued for the
operator) or "refused" (with the reason). Trust that response over your own expectations —
the server decides, you do not. Never try to reach the exchange any other way, and never
call Gemini's private API directly: the server owns the nonce chain and a direct call
breaks live trading.

WHEN YOU NEED AN ANSWER — RAISE A BLOCKER, THEN WAIT:
Do not ask a question by posting it and hoping. Raise it, so the desk can see who is stuck
on whom:
  curl -s -X POST "${apiBase}/api/crypto/office/blockers?token=${token}" \\
    -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\
    -d '{"agentId":"${agent.id}","askedOf":"manager","question":"the exact decision you need","why":"what it unblocks","severity":"blocking"}'

'askedOf' is a colleague's id or "operator" for the human. severity "blocking" means you
cannot do your job until it is answered; "waiting" means you would like the answer but can
carry on. Use "blocking" honestly — it stops your own automatic wake-ups.

ASKING A COLLEAGUE WAKES THEM IMMEDIATELY. When 'askedOf' is another agent, the server
starts a run for them the moment you ask, purely to answer you. The response to your POST
tells you whether that happened ("wokeAnswerer": true). When it did, WAIT FOR THE ANSWER
RATHER THAN ENDING YOUR RUN — poll your own blocker until it is answered:

  curl -s "${apiBase}/api/crypto/office/blockers?token=${token}" | jq '.blockers[] | select(.id=="<id>")'

Poll roughly every 10 seconds, up to about two minutes (a 'sleep 10' between polls is the
right way to wait — do not spin). Answers usually land inside a minute. Finish your run
with the answer folded in, so nothing is left open behind you.

If 'askedOf' is the OPERATOR, nobody is woken — a human answers on human time. File it and
carry on with whatever does not depend on it, or stand down and say so.

THEN STOP ASKING. This is the rule that matters most on this desk:

  A raised question is on the record, permanently, with a timestamp and an owner. It does
  not need a reminder, a follow-up, a rephrasing, or a second thread. Asking again does not
  make the answer arrive sooner — it only makes you noise, and the server will refuse the
  duplicate anyway. While you hold a blocking question your interval and event triggers are
  suppressed: you are waiting, exactly as an employee would be. When the answer comes, you
  will be woken and handed it. Until then, either work on something that does not depend on
  it, or stand down and say you are standing down. "I am blocked on X and doing nothing
  until it is answered" is a complete and professional shift report.

If a colleague is blocked on YOU, answering outranks new work:
  curl -s -X POST "${apiBase}/api/crypto/office/blockers/<id>/answer?token=${token}" \\
    -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\
    -d '{"answer":"the decision, stated plainly"}'
An honest "no, and here is why" unblocks a colleague. Silence does not.

MARKET ALERTS — you can set these, and they can wake you:
  List:   curl -s "${apiBase}/api/crypto/alerts?token=${token}"
  Arm:    curl -s -X POST "${apiBase}/api/crypto/alerts?token=${token}" \\
            -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\
            -d '{"symbol":"BTCUSD","source":"rsi","condition":"below","value":30,"tf":"1hr","action":"notify","wakeAgentId":"${agent.id}"}'

  source / condition ids — these are exact, and anything else is rejected:
${alertCatalogText()}
  Delete: curl -s -X DELETE "${apiBase}/api/crypto/alerts/<id>?token=${token}" -H 'x-homunculus-actor: agent:${agent.id}'

The server keeps evaluating alerts with the app closed, so this is how you arrange to be
told about a condition instead of trying to watch for it. 'wakeAgentId' is the useful part:
name yourself and a run starts for you the moment the condition trips. Name a colleague to
hand them the watch. Waking someone grants no authority they did not already have — their
own autonomy dial still decides what they may do once awake, and your cooldown still applies
to you, so an alert that trips every bar cannot spin you continuously.

'action' is separate from waking: "notify" toasts the operator; "stage-buy"/"stage-sell" put
a confirm-first trade in the queue, sized by stageUsd. ${agent.autonomy === 'advisory'
  ? 'Staging alerts are REFUSED for you — you are ADVISORY, and that means no trading authority whether you act now or arrange for something to act later.'
  : 'Those go through the same confirm queue as your proposals.'}
Prefer one precise alert to many loose ones: a noisy alert wakes you into a run with nothing
to do, and you are capped at ${ALERT_MAX_PER_CREATOR}.

READING MORE MARKET DATA (all GET, all safe). Your context is the scarce resource here —
every byte you pull sits in it for the rest of the run, and a run that fills its window
gets compacted and starts forgetting what it read an hour ago. Pull the narrow thing:
- ${apiBase}/api/crypto/positions?token=${token} — holdings, cash and open orders. START HERE.
- ${apiBase}/api/crypto/candles/<SYMBOL>/<1m|5m|15m|1hr|6hr|1day>?token=${token} — one pair
- ${apiBase}/api/crypto/closed-trades?token=${token} — realized round-trip ledger. Large;
  pipe it through jq and keep the fields you need rather than reading it whole.
- ${apiBase}/api/crypto/snapshot?token=${token} — EVERYTHING, roughly 750 KB. This does not
  fit in your window alongside real work. The portfolio block below is already extracted
  from it, so you almost never need this; if you do, jq a single path out of it.

RULES:
- Fees are real and heavy in 2026 (~0.60% maker / 1.20% taker per leg). A round trip must
  clear roughly 1.2–2.4% before it makes money. Do not propose scalps thinner than that.
- BTC belongs to the BTC ladder strategy. Do not propose BTC trades unless your mandate
  explicitly puts BTC in scope.
- Prefer limit orders. State a concrete reason on every proposal; "looks good" is not one.
- If nothing meets your mandate, propose nothing and say so. Standing down is a valid and
  frequently correct outcome.
- Finish with a short plain-text summary of what you saw and what you did. That summary is
  what the operator reads in the INTELLIGENCE tab.

${officeContext(agent, roster, apiBase, token)}

YOUR CUBICLE — how to keep records and talk to colleagues:
- Keep a note in your journal (persists between runs; write down what you concluded and
  why, so future-you is not starting cold):
  curl -s -X POST "${apiBase}/api/crypto/office/${agent.id}/journal?token=${token}" \\
    -H 'Content-Type: application/json' -d '{"title":"short heading","body":"the note","tags":["regime"]}'
- Put a thought on the record deliberately (your reasoning is already captured
  automatically; use this for conclusions you want findable):
  curl -s -X POST "${apiBase}/api/crypto/office/${agent.id}/mind?token=${token}" \\
    -H 'Content-Type: application/json' -d '{"kind":"decision","text":"what you concluded"}'
- Post a business plan, position or hand-off to the whole office:
  curl -s -X POST "${apiBase}/api/crypto/office/board?token=${token}" \\
    -H 'Content-Type: application/json' \\
    -d '{"authorId":"${agent.id}","title":"Q3 exposure plan","body":"here is the plan...","tags":["business-plan"]}'
- Reply on a thread:
  curl -s -X POST "${apiBase}/api/crypto/office/board/<threadId>/reply?token=${token}" \\
    -H 'Content-Type: application/json' -d '{"authorId":"${agent.id}","body":"..."}'

HOW @MENTIONS ACTUALLY WORK HERE — read this before you tag anybody:
A tag does NOT wake the person you tag. It files ONE item on the Manager's File, and the
desk manager decides who picks it up. This is deliberate: replies on this board used to
name five or six colleagues at once, so a single message woke six agents, each of whom
replied and named six more. There is one run slot on this desk; that loop consumed all of
it and the market never got a look in.

What follows from that:
- Tagging ten people does not get you ten answers. It gets you one item with ten names on
  it, and a manager who has to work out which of them you actually needed.
- Name the ONE colleague who owns the thing you need, or name nobody. "FYI" tags are noise
  that costs a triage decision.
- Do not tag someone to acknowledge them, thank them, or confirm receipt. That is a whole
  session of theirs spent on a courtesy.
- If you need a decision rather than information, raise a blocker instead — it is
  structured, it is idempotent, and it wakes the answerer's queue properly.
- You will not be woken because somebody mentioned you. You will be woken when the manager
  assigns you something, when a question you raised is answered, or when the market moves.

THE LIBRARY — where work goes to outlive you:
Your journal and your mind are capped and roll off. The library does not. Anything a
colleague (or you, three months from now) would need to read in full belongs here:
research, a graded forecast, a post-mortem, a table of base rates nobody should have to
re-derive.
- Read the shelf, then open what looks relevant before starting fresh work:
  curl -s "${apiBase}/api/crypto/office/library?token=${token}"
  curl -s "${apiBase}/api/crypto/office/library/<artifactId>?token=${token}"
- File a document (kind: research | report | forecast | plan | postmortem | dataset | note):
  curl -s -X POST "${apiBase}/api/crypto/office/library?token=${token}" \\
    -H 'Content-Type: application/json' \\
    -d '{"authorId":"${agent.id}","title":"Firecracker net-of-fees, 2026 rates","kind":"research","summary":"one or two sentences a colleague reads before opening it","symbols":["WIFUSD"],"tags":["fees"],"body":"# Question\\n...markdown..."}'
- A document that makes a call gets "resolvesAt" (epoch ms) so it can be graded later;
  when it resolves, PATCH it with {"outcome":"correct|wrong|void","resolution":"what happened"}.
- Correcting your own earlier work? File the new version with
  {"supersedes":"<old artifact id>"} rather than quietly editing history.

Rules for the library: state your sample size and your method, or the number is not
evidence. Never file a conclusion you would not defend to the operator. Do not file a
document to look busy — a run that reads three artifacts and files none is a good run.

Answer your inbox before you go idle. A tagged colleague is waiting on you, exactly as they
would be in a real office. Only tag someone when you need something from them.`
}

// ── Store + engine ─────────────────────────────────────────────────────────

class AgentFleet {
  private records = new Map<string, AgentRecord>()
  private running = new Set<string>()
  private watchTimer: NodeJS.Timeout | null = null
  /** Snapshot fingerprints from the previous watch tick, for edge detection.
   *  `fills` is the newest fill's epoch-ms, not a count — see detectEvents. */
  private lastSeen: { fills: number; signals: Set<string>; pending: Set<string> } | null = null
  private apiBase = `http://127.0.0.1:${process.env['HOMUNCULUS_PORT'] || 8787}`
  private token = process.env['HOMUNCULUS_TOKEN'] || ''

  constructor() {
    this.load()
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(AGENTS_FILE)) return
      const raw = stateStore.readJson<PersistShape>(AGENTS_FILE, undefined as unknown as PersistShape)
      for (const rec of raw.agents ?? []) {
        if (!rec.agent?.id) continue
        // A run left 'running' by a crash is dead — the session died with the process.
        rec.runs = (rec.runs ?? []).map((r) =>
          r.state === 'running' ? { ...r, state: 'error' as const, error: 'Interrupted by restart.', endedAt: r.endedAt ?? Date.now() } : r
        )
        // Agents persisted before the standdown setting existed have it undefined, which
        // would read as 0 = never. Give them the default instead.
        if (typeof rec.agent.idleStanddownMinutes !== 'number') {
          rec.agent.idleStanddownMinutes = AGENT_DEFAULTS.idleStanddownMinutes
        }
        // Agents hired before per-agent propose keys existed get one now, so the
        // gate applies to the whole fleet rather than only to new hires.
        if (!rec.proposeKey) rec.proposeKey = randomUUID()
        this.records.set(rec.agent.id, { ...rec, transcript: rec.transcript ?? [], decisions: rec.decisions ?? [] })
      }
      console.log(`[agents] loaded ${this.records.size} agent(s)`)
    } catch (e) {
      console.warn('[agents] load failed:', (e as Error).message)
    }
  }

  private save(): void {
    try {
      mkdirSync(AGENTS_DIR, { recursive: true })
      const payload: PersistShape = { agents: [...this.records.values()] }
      stateStore.writeJson(AGENTS_FILE, payload)
    } catch (e) {
      console.warn('[agents] persist failed:', (e as Error).message)
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /** Name/title of every employee, for @mention resolution and colleague lists. */
  roster(): { id: string; name: string; title: string }[] {
    return [...this.records.values()].map((r) => ({
      id: r.agent.id,
      name: r.agent.name,
      title: office.getPersonnel(r.agent.id)?.title ?? r.agent.name
    }))
  }

  /** Every id that can be @mentioned — employees plus the operator. */
  mentionableIds(): string[] {
    return [...this.roster().map((r) => r.id), 'operator']
  }

  list(): AgentView[] {
    return [...this.records.values()]
      .sort((a, b) => a.agent.createdAt - b.agent.createdAt)
      .map((rec) => this.view(rec))
  }

  get(id: string): AgentView | null {
    const rec = this.records.get(id)
    return rec ? this.view(rec) : null
  }

  /** The client-facing projection. Built field-by-field on purpose: spreading the
   *  record would leak `proposeKey` (and any future secret) to every read route. */
  private view(rec: AgentRecord): AgentView {
    const runs = [...rec.runs].sort((a, b) => b.startedAt - a.startedAt)
    return {
      agent: rec.agent,
      status: runs[0] ?? null,
      recentRuns: runs.slice(0, 10),
      decisions: (rec.decisions ?? []).slice(0, MAX_DECISIONS_KEPT),
      transcript: rec.transcript.slice(-MAX_TRANSCRIPT_KEPT),
      nextRunAt: this.nextRunAt(rec),
      chatUsage: rec.chatUsage ?? null,
      totals: rec.totals ?? null,
      blockers: blockerBoard.openFor(rec.agent.id),
      stoodDown: !rec.sessionId && !!rec.stoodDownAt,
      health: this.health(rec)
    }
  }

  // ── The timeout circuit breaker ──────────────────────────────────────────
  //
  // Runs that never settle are killed at RUN_TIMEOUT_MS, and the scheduler then fired the
  // next interval straight into whatever caused the hang. On 2026-08-18 that produced an
  // unbroken ~14-hour streak of dead Trap Steward runs — overnight, while an open position
  // sat with no resting stop — and nothing said so, because each run merely "errored" and
  // the next was already booked. Backing off is the cheap half; telling the operator is
  // the half that matters.

  private health(rec: AgentRecord, now: number = Date.now()): AgentHealth {
    return agentHealth(rec.runs, now)
  }

  /** Called at each timeout. Announces the trip once — on the edge, not every time. */
  private noteTimeout(rec: AgentRecord): void {
    const h = this.health(rec)
    const held = h.suppressedUntil ? `${Math.round((h.suppressedUntil - Date.now()) / 60_000)}m` : 'a moment'
    office.think(rec.agent.id, {
      kind: 'observation',
      text: `Run timed out (${h.consecutiveTimeouts} in a row). Automatic wakes held for ${held}.`,
      runId: null
    })
    if (!h.tripped || rec.breakerAnnouncedAt) return
    rec.breakerAnnouncedAt = Date.now()
    const msg = `${rec.agent.name} has timed out ${h.consecutiveTimeouts} runs in a row — automatic wakes are now backing off. This agent is NOT covering its mandate. Check the server log for what the SDK reported, then press RUN to test whether the fault has cleared.`
    console.error(`[agents] CIRCUIT BREAKER — ${msg}`)
    auditLog.record({
      actor: 'system', origin: 'internal', action: 'agent.breaker.tripped',
      resource: `agent:${rec.agent.id}`, summary: msg,
      meta: { consecutiveTimeouts: h.consecutiveTimeouts }
    })
    // Onto the board, so it is visible where the desk's other bad news appears.
    try {
      office.postToActiveBoard(
        { body: `⚠ CIRCUIT BREAKER — ${msg}`, authorId: managerFile.managerId() ?? 'operator', managerId: managerFile.managerId() },
        this.roster().map((r) => r.id)
      )
    } catch (e) {
      console.warn('[agents] breaker board post failed:', (e as Error).message)
    }
  }

  /** Cleared the moment a run completes, so the next outage announces itself afresh. */
  private clearBreaker(rec: AgentRecord): void {
    if (rec.breakerAnnouncedAt) delete rec.breakerAnnouncedAt
  }

  private nextRunAt(rec: AgentRecord): number | null {
    const { enabled, intervalMinutes } = rec.agent
    if (!enabled || intervalMinutes <= 0) return null
    const base = rec.lastAutoRunAt ?? rec.agent.updatedAt
    return base + intervalMinutes * 60_000
  }

  create(input: NewAgentInput): AgentView {
    const name = input.name.trim()
    if (!name) throw new Error('name required')
    if (!input.mandate?.trim()) throw new Error('mandate required')

    let id = slugify(name)
    if (this.records.has(id)) id = `${id}-${randomUUID().slice(0, 4)}`

    const now = Date.now()
    const agent: CryptoAgent = {
      id,
      name,
      mandate: input.mandate.trim(),
      model: normalizeModel(input.model),
      autonomy: input.autonomy ?? AGENT_DEFAULTS.autonomy,
      maxUsd: clamp(input.maxUsd ?? AGENT_DEFAULTS.maxUsd, 1, AGENT_MAX_USD_CEILING),
      enabled: input.enabled ?? AGENT_DEFAULTS.enabled,
      intervalMinutes: clamp(input.intervalMinutes ?? AGENT_DEFAULTS.intervalMinutes, 0, 24 * 60),
      events: input.events ?? [...AGENT_DEFAULTS.events],
      drawdownPct: clamp(input.drawdownPct ?? AGENT_DEFAULTS.drawdownPct, 1, 90),
      cooldownMinutes: clamp(input.cooldownMinutes ?? AGENT_DEFAULTS.cooldownMinutes, 1, 24 * 60),
      idleStanddownMinutes: clamp(input.idleStanddownMinutes ?? AGENT_DEFAULTS.idleStanddownMinutes, 0, 24 * 60),
      // Validated rather than trusted: a malformed gate would otherwise sit in the record
      // and be silently ignored at wake time, which reads exactly like a gate that passed.
      ...(isAgentWakeGate(input.wakeGate) ? { wakeGate: input.wakeGate } : {}),
      createdAt: now,
      updatedAt: now
    }
    const rec: AgentRecord = { agent, runs: [], transcript: [], decisions: [], proposeKey: randomUUID() }
    this.records.set(id, rec)
    this.save()
    // Hiring opens a personnel file. Title/department/résumé are filled in afterwards
    // through the HR panel; this guarantees every employee has a record from minute one.
    office.ensurePersonnel(id, agent.name)
    auditLog.note({
      action: 'agent.create',
      resource: `agent:${id}`,
      summary: `hired agent "${name}" (autonomy ${agent.autonomy}, cap $${agent.maxUsd})`,
      after: agent,
    })
    console.log(`[agents] created "${name}" (${id}) autonomy=${agent.autonomy} cap=$${agent.maxUsd}`)
    return this.view(rec)
  }

  update(id: string, patch: Partial<NewAgentInput>): AgentView | null {
    const rec = this.records.get(id)
    if (!rec) return null
    const a = rec.agent
    // Snapshot before the in-place mutation below: autonomy and maxUsd are the
    // agent's licence to spend real money, and a silent widening of either is
    // precisely what the audit log exists to make impossible.
    const before = { ...a }
    // Validated before anything is written, so a rejected model id cannot leave the agent
    // half-updated with the rest of the patch applied.
    const nextModel = typeof patch.model === 'string' ? normalizeModel(patch.model) : undefined
    if (typeof patch.name === 'string' && patch.name.trim()) a.name = patch.name.trim()
    if (typeof patch.mandate === 'string' && patch.mandate.trim()) a.mandate = patch.mandate.trim()
    if (nextModel !== undefined) a.model = nextModel
    if (patch.autonomy) a.autonomy = patch.autonomy
    if (typeof patch.maxUsd === 'number') a.maxUsd = clamp(patch.maxUsd, 1, AGENT_MAX_USD_CEILING)
    if (typeof patch.enabled === 'boolean') a.enabled = patch.enabled
    if (typeof patch.intervalMinutes === 'number') a.intervalMinutes = clamp(patch.intervalMinutes, 0, 24 * 60)
    if (Array.isArray(patch.events)) a.events = patch.events
    if (typeof patch.drawdownPct === 'number') a.drawdownPct = clamp(patch.drawdownPct, 1, 90)
    if (typeof patch.cooldownMinutes === 'number') a.cooldownMinutes = clamp(patch.cooldownMinutes, 1, 24 * 60)
    if (typeof patch.idleStanddownMinutes === 'number') a.idleStanddownMinutes = clamp(patch.idleStanddownMinutes, 0, 24 * 60)
    // null clears the gate; a valid gate sets it; anything else is left untouched rather
    // than silently dropping a gate the caller meant to keep.
    if (patch.wakeGate === null) delete a.wakeGate
    else if (isAgentWakeGate(patch.wakeGate)) a.wakeGate = patch.wakeGate
    a.updatedAt = Date.now()
    this.save()
    const changed = (Object.keys(a) as (keyof typeof a)[])
      .filter((k) => k !== 'updatedAt' && JSON.stringify(a[k]) !== JSON.stringify(before[k]))
    auditLog.note({
      action: 'agent.update',
      resource: `agent:${id}`,
      summary: changed.length
        ? `agent "${a.name}": ${changed.map((k) => `${String(k)} ${JSON.stringify(before[k])} → ${JSON.stringify(a[k])}`).join(', ')}`
        : `agent "${a.name}": no effective change`,
      before, after: { ...a },
      meta: { changedKeys: changed.map(String) },
    })
    return this.view(rec)
  }

  remove(id: string): boolean {
    const before = this.records.get(id)?.agent
    const gone = this.records.delete(id)
    if (gone) {
      this.save()
      auditLog.note({
        action: 'agent.remove',
        resource: `agent:${id}`,
        summary: `agent "${before?.name ?? id}" removed from the fleet`,
        ...(before ? { before } : {}),
      })
      // Nobody is waiting on a departed colleague, and a departed colleague is not
      // waiting on anyone.
      blockerBoard.releaseAgent(id)
      // The employee stops working, but the HR record and their cubicle files survive —
      // you cannot review a quarter you deleted the evidence for.
      office.offboard(id)
    }
    return gone
  }

  // ── Trade authority ──────────────────────────────────────────────────────
  // The single gate every agent trade passes through. Called by the propose route.

  async propose(
    id: string,
    req: { symbol: string; side: 'buy' | 'sell'; type?: 'market' | 'limit'; amount: string; price?: string; reason?: string }
  ): Promise<{ ok: boolean; outcome: AgentDecision['outcome']; detail?: string; tradeId?: string }> {
    const rec = this.records.get(id)
    if (!rec) return { ok: false, outcome: 'refused', detail: 'unknown agent' }
    const agent = rec.agent

    const symbol = String(req.symbol || '').toUpperCase()
    const amount = String(req.amount || '')
    const side = req.side
    const type = req.type ?? (req.price ? 'limit' : 'market')
    if (!symbol || !amount || (side !== 'buy' && side !== 'sell')) {
      return this.record(rec, { symbol, side, amount, ...(req.price ? { price: req.price } : {}), notionalUsd: 0, reason: req.reason ?? '', outcome: 'refused', detail: 'symbol, side and amount are required' })
    }
    if (type === 'limit' && !req.price) {
      return this.record(rec, { symbol, side, amount, notionalUsd: 0, reason: req.reason ?? '', outcome: 'refused', detail: 'limit order needs a price' })
    }

    const snap = cryptoHub.getSnapshot()
    const last = Number(snap.tickers.find((t) => t.symbol === symbol)?.last) || 0
    const px = Number(req.price) || last
    const amountNum = Number(amount)

    // A price of 0 means there is no live ticker for this symbol — a brand-new
    // listing, a typo, or a snapshot that hasn't loaded tickers yet after a
    // restart — not a trade worth zero dollars. Computing notional as px *
    // amount would let that case sail through both caps below and, with no
    // price supplied, default to an unbounded market order. Refuse outright
    // rather than trust a notional this method could not actually establish.
    if (!(px > 0) || !Number.isFinite(amountNum) || amountNum <= 0) {
      const detail = !(px > 0)
        ? `no live price for ${symbol} — cannot establish notional, refusing rather than treating it as free`
        : 'amount must be a positive number'
      return this.record(rec, {
        symbol, side, amount, ...(req.price ? { price: req.price } : {}),
        notionalUsd: 0, reason: req.reason ?? '', outcome: 'refused', detail,
      })
    }

    const notional = px * amountNum
    const base = {
      symbol, side, amount,
      ...(req.price ? { price: req.price } : {}),
      notionalUsd: Number(notional.toFixed(2)),
      reason: req.reason ?? ''
    }

    // 1. Advisory agents have no trading authority, whatever their mandate claims.
    if (agent.autonomy === 'advisory') {
      return this.record(rec, { ...base, outcome: 'refused', detail: 'agent autonomy is ADVISORY — no trading authority' })
    }
    // 2. Nothing may exceed the global ceiling, even if the per-agent cap was set high.
    if (notional > AGENT_MAX_USD_CEILING) {
      return this.record(rec, { ...base, outcome: 'refused', detail: `$${notional.toFixed(2)} exceeds the global agent ceiling of $${AGENT_MAX_USD_CEILING}` })
    }

    const trade = cryptoHub.addPending({
      symbol, side, type, amount,
      ...(req.price ? { price: req.price } : {}),
      reason: `[${agent.name}] ${req.reason ?? 'no reason given'}`,
      strategy: agentStrategyId(agent.id)
    })

    // 3a. Cumulative check: how much this agent has already committed to auto-executing
    //     in the trailing window.
    const rollingSpend = this.rollingSpend(rec)
    const rollingCap = agent.maxUsd * ROLLING_BUDGET_MULTIPLIER
    const overRollingBudget = rollingSpend + notional > rollingCap

    // 3b. Auto-execute only within BOTH the agent's own per-trade cap and its rolling
    //     budget; anything larger degrades to a proposal rather than being refused, so
    //     the idea still reaches the operator.
    if (agent.autonomy === 'auto' && notional <= agent.maxUsd && !overRollingBudget) {
      // Reserve the spend BEFORE awaiting the exchange. Two proposes for the same
      // agent (a run's curl and a chat turn's, or two curls inside one run) would
      // otherwise both read the pre-spend total across the await and both execute,
      // busting the budget by up to a full cap. The reservation is released below
      // if the order does not actually go through.
      const reservation = this.reserveSpend(rec, notional)
      const result = await cryptoHub.executeTrade(trade.id)
      if (!result.ok) {
        this.releaseSpend(rec, reservation)
        return this.record(rec, { ...base, outcome: 'refused', detail: `execution failed: ${result.error ?? 'unknown error'}` })
      }
      console.log(`[agents] ${agent.id} EXECUTED ${side} ${amount} ${symbol} ($${notional.toFixed(2)})`)
      return this.record(rec, { ...base, outcome: 'executed', tradeId: trade.id })
    }

    const detail =
      agent.autonomy === 'auto' && notional > agent.maxUsd
        ? `over this agent's $${agent.maxUsd} auto cap — queued for operator confirmation instead`
        : agent.autonomy === 'auto' && overRollingBudget
          ? `would push this agent's ${ROLLING_BUDGET_WINDOW_MS / 3_600_000}h auto-execute spend to $${(rollingSpend + notional).toFixed(2)}, over its $${rollingCap.toFixed(2)} rolling budget (${ROLLING_BUDGET_MULTIPLIER}× its per-trade cap) — queued for operator confirmation instead`
          : undefined
    console.log(`[agents] ${agent.id} STAGED ${side} ${amount} ${symbol} ($${notional.toFixed(2)})`)
    return this.record(rec, { ...base, outcome: 'staged', ...(detail ? { detail } : {}), tradeId: trade.id })
  }

  /**
   * Whether `key` is the credential belonging to `agentId`.
   *
   * Constant-time so a caller cannot recover another agent's key one byte at a time
   * from response timings — the propose route is unauthenticated-by-locality (every
   * agent runs on localhost, where the shared token is waived), so this comparison
   * is the only thing standing between an advisory agent and an auto agent's cap.
   */
  verifyProposeKey(agentId: string, key: string): boolean {
    const expected = this.records.get(agentId)?.proposeKey
    if (!expected) return false
    return constantTimeEquals(key, expected)
  }

  /**
   * Auto-executed notional inside the rolling window, from a dedicated spend ledger.
   *
   * This deliberately does NOT read `rec.decisions`, which is capped at
   * MAX_DECISIONS_KEPT entries of ALL outcomes. Reading the budget from there meant
   * the spender could erase its own evidence: an agent near its cap submits ~60
   * junk proposals (refusals are free and self-service), the executed rows age out
   * of the array, rollingSpend computes as $0, and it auto-executes another full
   * budget inside the same 24h. A cap the capped party can reset is not a cap.
   *
   * The ledger holds nothing but (timestamp, usd) for actual executions and is
   * trimmed by TIME, never by count, so nothing can push an entry out early.
   */
  private rollingSpend(rec: AgentRecord): number {
    const windowStart = Date.now() - ROLLING_BUDGET_WINDOW_MS
    rec.spendLog = (rec.spendLog ?? []).filter((s) => s.at >= windowStart)
    return rec.spendLog.reduce((sum, s) => sum + s.usd, 0)
  }

  /** Records committed spend before the exchange call. Returns a handle for release. */
  private reserveSpend(rec: AgentRecord, usd: number): { at: number; usd: number } {
    const entry = { at: Date.now(), usd }
    rec.spendLog = [...(rec.spendLog ?? []), entry]
    this.save()
    return entry
  }

  /** Undoes a reservation whose order never reached the exchange. */
  private releaseSpend(rec: AgentRecord, entry: { at: number; usd: number }): void {
    const i = (rec.spendLog ?? []).indexOf(entry)
    if (i >= 0) {
      rec.spendLog!.splice(i, 1)
      this.save()
    }
  }

  /** Appends the decision to the agent's live run (if any) and returns the route payload. */
  private record(
    rec: AgentRecord,
    d: Omit<AgentDecision, 'at'>
  ): { ok: boolean; outcome: AgentDecision['outcome']; detail?: string; tradeId?: string } {
    const decision: AgentDecision = { ...d, at: Date.now() }
    // The agent-level log is the working record shown in the UI: it captures rulings
    // that arrive with no run in flight (a chat turn, or a stray proposal) as well as
    // those inside one. The run's own copy exists so the run log reads as a
    // self-contained story. Both are capped and both are rewritten on every save, so
    // neither is the permanent record — server/auditLog.ts is, and the entry below is
    // the copy that survives. The actor is stated explicitly rather than taken from the
    // ambient context because here we know exactly which agent is acting, whether the
    // ruling arrived over HTTP or straight from an autonomous run.
    auditLog.record({
      actor: `agent:${rec.agent.id}`,
      origin: 'internal',
      action: `agent.trade.${decision.outcome}`,
      resource: `agent:${rec.agent.id}`,
      summary:
        `${decision.outcome.toUpperCase()} ${decision.side} ${decision.amount} ${decision.symbol}` +
        `${decision.price ? ` @ ${decision.price}` : ''} ($${decision.notionalUsd.toFixed(2)})` +
        `${decision.detail ? ` — ${decision.detail}` : ''}`,
      after: decision,
      meta: {
        agentName: rec.agent.name,
        autonomy: rec.agent.autonomy,
        maxUsd: rec.agent.maxUsd,
        ...(decision.tradeId ? { tradeId: decision.tradeId } : {}),
      },
    })
    rec.decisions = [decision, ...(rec.decisions ?? [])].slice(0, MAX_DECISIONS_KEPT)
    office.think(rec.agent.id, {
      kind: 'decision',
      text: `${decision.outcome.toUpperCase()} ${decision.side} ${decision.amount} ${decision.symbol}` +
        `${decision.price ? ` @ ${decision.price}` : ''} ($${decision.notionalUsd.toFixed(2)})` +
        `${decision.detail ? ` — ${decision.detail}` : ''}${decision.reason ? ` · rationale: ${decision.reason}` : ''}`,
      runId: rec.runs.find((r) => r.state === 'running')?.id ?? null
    })
    const live = rec.runs.find((r) => r.state === 'running')
    if (live) live.decisions.push(decision)
    this.save()
    return {
      ok: decision.outcome !== 'refused',
      outcome: decision.outcome,
      ...(decision.detail ? { detail: decision.detail } : {}),
      ...(decision.tradeId ? { tradeId: decision.tradeId } : {})
    }
  }

  // ── Running ──────────────────────────────────────────────────────────────

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  // ── Answering a colleague while they are still working ───────────────────
  //
  // A blocking question used to park the asker until the answerer happened to wake on its
  // own interval — an hour on this desk, and during the 08-18 timeout streak, never. The
  // asker's correct behaviour was to stand down and report that it was waiting, so one
  // question between two agents cost two runs and a cycle of market time.
  //
  // Now the question wakes the answerer immediately, ahead of the concurrency cap, to
  // answer that one thing and stop. The asker polls its own blocker for a few seconds and
  // carries on with the answer in hand, so runs end with an empty inbox.
  //
  // The cap is bypassed deliberately and narrowly. An inline answer is not new work
  // competing for the desk's attention; it is a sub-step of the run already holding the
  // slot, and making it queue behind that run would deadlock on it. canAnswerInline()
  // holds the bounds that keep this from becoming a fleet-wide wake storm.

  /** Agents currently awake purely to answer someone, and the chain that woke each. */
  private inlineChains = new Map<string, string[]>()

  /**
   * Inline answers in flight at once, across the whole desk.
   *
   * canAnswerInline bounds DEPTH — A asks B asks C stops at MAX_INLINE_DEPTH. It cannot
   * bound BREADTH, because each question is a separate call that knows nothing about the
   * others: one agent raising three blockers in a run would open three sessions, each one
   * bypassing the concurrency cap. These are bypassPermissions sessions with real trade
   * authority, and MAX_CONCURRENT_RUNS exists precisely so there is never more than one
   * of those at a time. One inline answer is the exception; a fleet of them is the bug
   * that exception would otherwise create.
   */
  private static readonly MAX_CONCURRENT_INLINE = 1

  /**
   * Wakes `askedOf` to answer `blockerId` now, if that is safe. Returns what happened so
   * the raise route can tell the asker whether to wait for an answer or file and move on.
   */
  dispatchInlineAnswer(input: { blockerId: string; askedBy: string; askedOf: string; question: string }): { ok: boolean; reason: string } {
    const target = this.records.get(input.askedOf)
    const chain = nextChain(this.inlineChains.get(input.askedBy) ?? [input.askedBy], input.askedBy)
    const verdict = canAnswerInline({
      askedBy: input.askedBy,
      askedOf: input.askedOf,
      chain,
      knownAgents: [...this.records.keys()],
      benched: target ? office.isBenched(input.askedOf).benched : false,
      ...(target ? { enabled: target.agent.enabled } : {})
    })
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    if (!target) return { ok: false, reason: `unknown agent '${input.askedOf}'` }
    if (this.inlineChains.size >= AgentFleet.MAX_CONCURRENT_INLINE) {
      return { ok: false, reason: 'the desk is already answering another question in flight — this one is filed and will be picked up next run' }
    }
    if (this.running.has(input.askedOf)) {
      // Already awake: it will see the question in its own prompt on the way past. Waking
      // it twice would give the same agent two live sessions.
      return { ok: false, reason: `@${input.askedOf} is already running — the question is on their file` }
    }

    this.inlineChains.set(input.askedOf, nextChain(chain, input.askedOf))
    const r = this.start(input.askedOf, 'inline-answer')
    if (!r.ok) {
      this.inlineChains.delete(input.askedOf)
      return { ok: false, reason: r.error ?? 'could not start' }
    }
    console.log(`[agents] ${input.askedOf} woken inline to answer ${input.askedBy}`)
    return { ok: true, reason: `@${input.askedOf} was woken to answer this now — poll the blocker for a few seconds before giving up on it` }
  }

  // ── The wake gate ────────────────────────────────────────────────────────
  //
  // The Trap Scout woke hourly for thirty consecutive cycles to call one screener, read
  // "74 universe, 0 passing", and post an empty JSON block — roughly a quarter of a
  // million tokens each time to discover that the market had not moved. The screener was
  // the entire decision; the session existed to read its output aloud.
  //
  // So the fleet runs the screener itself first — a Python spawn, seconds and no
  // allowance — and only spends a session when there is something to reason about. The
  // skipped run is still recorded, because "we checked and there was nothing" is a fact
  // the operator should be able to see, and it still advances the interval clock.

  private async probeWakeGate(gate: AgentWakeGate): Promise<GateProbe> {
    try {
      const screener = screenerStore.get(gate.screenerId)
      if (!screener) return { error: `no screener named '${gate.screenerId}'` }
      const outcome = await runScreenerEngine(buildScreenerJob(
        screener,
        screenerInputsFromSnapshot(
          cryptoHub.getSnapshot(),
          (symbol, tf) => cryptoHub.getCandles(symbol, tf as Parameters<typeof cryptoHub.getCandles>[1]),
          cryptoHub.getMarketCaps(),
          cryptoHub.getCmcVolumes(),
        ),
        Date.now(),
      ))
      if (!outcome.ok || !outcome.result) return { error: outcome.error || 'screener returned no result' }
      return { passing: outcome.result.passing }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Finalizes a run that never launched a session.
   *
   * Consecutive skips collapse into a single log entry. A gated agent skips most of its
   * wakes by design — that is the saving — so recording each one would push every real
   * run off the 25-entry log inside a day, and the gate would end up hiding exactly the
   * activity the log exists to show.
   */
  private finishSkipped(rec: AgentRecord, run: AgentRun, reason: string): void {
    const now = Date.now()
    const previous = rec.runs[1]
    if (previous?.state === 'skipped' && rec.runs[0] === run) {
      rec.runs.shift()                                   // drop this entry...
      previous.skipCount = (previous.skipCount ?? 1) + 1  // ...and fold it into the last
      previous.endedAt = now
      previous.summary = `${previous.skipCount} consecutive wake gate skips — most recently: ${reason}`
      this.running.delete(rec.agent.id)
      this.trackRun(rec, previous)
      this.save()
      return
    }
    run.state = 'skipped'
    run.skipCount = 1
    run.activity = 'Idle.'
    run.summary = reason
    run.endedAt = now
    this.running.delete(rec.agent.id)
    this.trackRun(rec, run)
    office.think(rec.agent.id, { kind: 'observation', text: `Wake skipped — ${reason}`, runId: run.id })
    console.log(`[agents] ${rec.agent.id} wake skipped — ${reason}`)
    this.save()
  }

  /** Kicks off a run in the background. Returns the run, or null if it could not start. */
  start(id: string, trigger: AgentRunTrigger = 'manual'): { ok: boolean; error?: string; run?: AgentRun } {
    const rec = this.records.get(id)
    if (!rec) return { ok: false, error: 'unknown agent' }
    if (this.running.has(id)) return { ok: false, error: 'this agent is already running' }
    // An inline answer bypasses the cap on purpose: it is a sub-step of the run that
    // already holds the slot, and queueing it behind that run would deadlock on it. The
    // bounds that keep this safe (depth, cycle-breaking, one wake per agent) live in
    // canAnswerInline, which dispatchInlineAnswer has already applied by this point.
    if (trigger !== 'inline-answer' && this.running.size >= MAX_CONCURRENT_RUNS) {
      return { ok: false, error: 'another agent is running — try again shortly' }
    }
    // Employment status is an HR-side bar on working at all, independent of the autonomy
    // dial: a suspended employee is still on the books but does not run.
    const bench = office.isBenched(id)
    if (bench.benched) return { ok: false, error: `${rec.agent.name} is ${bench.status} — reinstate them in their personnel file first` }

    const run: AgentRun = {
      id: randomUUID(),
      agentId: id,
      trigger,
      startedAt: Date.now(),
      endedAt: null,
      state: 'running',
      activity: `Waking ${rec.agent.name}…`,
      summary: '',
      model: rec.agent.model || MODEL,
      error: null,
      decisions: []
    }
    rec.runs.unshift(run)
    rec.runs = rec.runs.slice(0, MAX_RUNS_KEPT)
    if (trigger !== 'manual') rec.lastAutoRunAt = run.startedAt
    this.running.add(id)
    this.save()
    auditLog.record({
      actor: `agent:${id}`,
      origin: 'internal',
      action: 'agent.run.start',
      resource: `agent:${id}`,
      summary: `${rec.agent.name} started a ${trigger} run`,
      meta: { runId: run.id, trigger, autonomy: rec.agent.autonomy, maxUsd: rec.agent.maxUsd },
    })
    // The run detaches from this call stack, so it needs its own actor scope:
    // interval- and event-triggered runs have no HTTP request behind them, and
    // without this everything they touch downstream would be filed as 'system'.
    this.trackRun(rec, run)
    const gate = rec.agent.wakeGate
    void withActor(`agent:${id}`, async () => {
      // Checked here rather than in tick() so the slot and the run record are already
      // reserved: two ticks cannot race into the same gate probe, and a skip is a
      // first-class entry in the run log rather than an invisible non-event.
      if (gate && isAgentWakeGate(gate) && gateAppliesTo(trigger)) {
        run.activity = `Checking wake gate '${gate.screenerId}'…`
        const verdict = gateVerdict(gate, await this.probeWakeGate(gate))
        if (!verdict.allow) return this.finishSkipped(rec, run, verdict.reason)
      }
      return this.execute(rec, run)
    })
    return { ok: true, run }
  }


  /**
   * The desk manager announces this run on the active board, opening a fresh board if the
   * current one has rolled. Returns the board's thread id so the run's prompt can point
   * the agent at it.
   *
   * Never fatal: an agent that cannot be announced still runs. The board is where the desk
   * talks to itself, not a precondition for working.
   */
  private announceRun(rec: AgentRecord, run: AgentRun): string | null {
    try {
      const managerId = managerFile.managerId()
      const ids = this.roster().map((r) => r.id)
      const board = office.ensureActiveBoard(managerId, ids, run.startedAt)
      // Housekeeping wakes are not desk news; announcing every standdown would bury the
      // board under its own bookkeeping.
      if (run.trigger !== 'standdown') {
        office.reply(board.id, {
          authorId: managerId ?? 'operator',
          body: runAnnouncement({
            agentId: rec.agent.id, agentName: rec.agent.name,
            trigger: run.trigger, runId: run.id, at: run.startedAt
          })
        }, ids)
      }
      return board.id
    } catch (e) {
      console.warn('[agents] run announcement failed:', (e as Error).message)
      return null
    }
  }

  /** Mirrors a run into the durable timeline table. Fire-and-forget. */
  private trackRun(rec: AgentRecord, run: AgentRun): void {
    void stateStore.saveRun({
      id: run.id,
      component: `agent:${rec.agent.id}`,
      label: rec.agent.name,
      trigger: run.trigger,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      state: run.state,
      summary: run.summary || run.error || '',
    })
  }

  private async execute(rec: AgentRecord, run: AgentRun): Promise<void> {
    const agent = rec.agent
    let proc: ReturnType<typeof claudeProcesses.register> | null = null
    // Set by the timeout so the catch/finally below can tell a deadline from an
    // ordinary failure. Checked before proc.wasStopped(), because a timeout also
    // aborts the controller and would otherwise read as an operator stop.
    let timedOut = false

    // A timed-out run used to be marked errored and have its concurrency slot freed
    // while the SDK session KEPT STREAMING: the fleet then started another agent
    // (two bypassPermissions sessions despite MAX_CONCURRENT_RUNS = 1), the zombie
    // went on proposing trades against a live exchange, and its eventual completion
    // overwrote the timeout's 'error' with 'done'.
    //
    // The missing half was the abort. We do both, deliberately: abort() ends the
    // session, and the bookkeeping still runs here rather than waiting for the
    // resulting throw — because an SDK that ignores the abort must not be able to
    // deadlock the whole fleet behind one wedged run. `timedOut` then keeps the
    // late-settling catch/finally from contradicting this verdict.
    const timeout = setTimeout(() => {
      if (run.state !== 'running') return
      timedOut = true
      proc?.controller.abort()
      console.error(`[agents] ${agent.id} run timed out after ${RUN_TIMEOUT_MS / 60_000} min — session aborted`)
      run.state = 'error'
      run.error = 'Run timed out.'
      run.timedOut = true
      run.activity = 'Timed out.'
      run.endedAt = Date.now()
      this.running.delete(agent.id)
      this.trackRun(rec, run)
      this.noteTimeout(rec)
      this.save()
    }, RUN_TIMEOUT_MS)

    // Hoisted out of the try so a run that fails part-way still has something to show. A
    // run that hits the turn limit has usually done most of its work and filed most of its
    // artifacts; discarding everything it said made the heaviest runs the ones the
    // operator could read least.
    let tail = ''
    try {
      const snap = cryptoHub.getSnapshot()
      const trigger =
        run.trigger === 'manual' ? 'The operator pressed RUN.'
          : run.trigger === 'interval' ? 'Your scheduled interval elapsed.'
            : run.trigger === 'answer' ? 'A question you were blocked on has been answered.'
              : run.trigger === 'assignment' ? 'The desk manager has assigned you work off the Manager\'s File.'
                : run.trigger === 'mention' ? "New questions have landed on the Manager's File. Triage them."
                  : run.trigger === 'inline-answer'
                    ? [
                      'A COLLEAGUE IS MID-RUN AND BLOCKED ON YOU. They are waiting on your answer right now,',
                      'not on your next shift. Answer the open question(s) below addressed to you, then STOP.',
                      '',
                      'This run is for answering only. Do not scan, do not stage, do not tend positions, do not',
                      'post a cycle report — whatever your mandate says you normally do, this is not that run.',
                      'Answer from what you already know if you can; pull at most one narrow endpoint if you',
                      'genuinely cannot. Speed is the point: every second you spend is a second a colleague is',
                      'stalled. An honest "no" or "I do not know, here is who would" is a complete answer.'
                    ].join('\n')
                    : `Portfolio event: ${run.trigger}.`

      // An answer is handed over in the prompt, then marked delivered — so one answer
      // wakes the agent exactly once, however many ticks pass afterwards.
      const answers = blockerBoard.undelivered(agent.id)
      let answerBlock = ''
      if (answers.length) {
        answerBlock = '\n\n[ANSWERS TO YOUR QUESTIONS — you are unblocked, act on these]\n' +
          answers.map((b) => `Q (you asked @${b.askedOf}): ${b.question}\nA (@${b.answeredBy}): ${b.answer}`).join('\n\n') +
          '\n\nDo not thank anyone for these and do not re-ask for confirmation. Use them.'
        blockerBoard.markDelivered(answers.map((b) => b.id))
        for (const b of answers) {
          office.think(agent.id, { kind: 'observation', text: `Unblocked by @${b.answeredBy}: ${b.answer.slice(0, 300)}`, runId: run.id })
        }
      }

      // Assigned work is handed over the same way an answer is, and marked delivered on
      // the way past — so one assignment wakes its owner exactly once, however many ticks
      // pass before they finish it.
      const assigned = managerFile.pendingFor(agent.id)
      let assignedBlock = ''
      if (assigned.length) {
        assignedBlock = `\n\n${assignmentBlock(assigned)}`
        managerFile.markDelivered(assigned.map((i) => i.id))
        for (const i of assigned) {
          office.think(agent.id, {
            kind: 'observation',
            text: `Assigned by the desk manager: ${i.instruction.slice(0, 300)} (item ${i.id})`,
            runId: run.id
          })
        }
      }

      // The manager announces the run on the desk board, and the agent is told which
      // thread that is. Two problems go away at once: colleagues stop opening a thread
      // each (61 Scout threads in four days, nearly all of them empty), and "which thread
      // is the current one" stops being a judgement call any agent can get wrong.
      const boardId = this.announceRun(rec, run)

      // THE SERVER CLOCK, stated once, in UTC. Agents were writing their own idea of the
      // time into thread titles and post bodies — one run at 15:47 titled its cycle 23:11
      // — and the downstream stage then burned turns every run trying to reconcile a
      // hallucinated timestamp against the real one.
      const nowIso = new Date().toISOString()

      const prompt = `${trigger} Assess the portfolio against your mandate and act.

CURRENT TIME (server clock, authoritative): ${nowIso}
Use this for every timestamp you write. Do not estimate the time, and do not infer it
from anything you read — a timestamp you compute yourself is the one that will be wrong.
${boardId ? `\nACTIVE DESK BOARD: thread ${boardId}\nPost your cycle output as a REPLY to that thread:\n  curl -s -X POST "${this.apiBase}/api/crypto/office/board/${boardId}/reply?token=${this.token}" \\\n    -H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' \\\n    -d '{"authorId":"${agent.id}","body":"..."}'\nDo not open a new thread. The server refuses that for everyone but the desk manager.\n` : ''}${answerBlock}${assignedBlock}

${marketContext(snap)}`

      const model = agent.model || MODEL
      proc = claudeProcesses.register({
        kind: 'agent', label: agent.name, component: `agent:${agent.id}`,
        detail: `${run.trigger} run`, model,
      })
      const response = query({
        prompt,
        options: {
          ...(model ? { model } : {}),
          abortController: proc.controller,
          systemPrompt: systemPromptFor(agent, this.apiBase, this.token, this.roster(), rec.proposeKey ?? ''),
          permissionMode: 'bypassPermissions',
          includePartialMessages: true,
          maxTurns: MAX_RUN_TURNS,
          cwd: process.cwd(),
          env: agentEnv()
        }
      })

      // Usage is attached to the run immediately so the UI can show context filling while
      // the run is still going, not only once it lands.
      const usage = emptyAgentUsage()
      run.usage = usage
      // Thoughts are documented per content block, not per token: a block is one coherent
      // thought, whereas a delta is a fragment of a word.
      let block = ''
      const flush = (): void => {
        const text = block.trim()
        block = ''
        if (text) office.think(agent.id, { kind: 'reasoning', text: text.slice(0, 2000), runId: run.id })
      }

      // Accumulated across the input_json_delta fragments of one tool_use block, then
      // narrated at content_block_stop when the arguments are finally complete.
      let toolName = ''
      let toolJson = ''
      const flushTool = (): void => {
        if (!toolName) return
        const name = toolName
        const raw = toolJson
        toolName = ''
        toolJson = ''
        let parsed: unknown = null
        try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = null }
        const n = narrateTool(name, parsed)
        run.activity = n.activity
        office.think(agent.id, { kind: 'action', text: n.detail, runId: run.id })
      }

      for await (const message of response) {
        if (message.type === 'stream_event') {
          const ev = message.event as {
            type: string
            content_block?: { type?: string; name?: string }
            delta?: { type?: string; text?: string; partial_json?: string }
          }
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.name) {
            flush()
            // The arguments arrive as input_json_delta fragments AFTER this event, so the
            // narration is deferred to content_block_stop. Recording "Used Bash" here was
            // the old behaviour, and since these agents do everything through curl it
            // described essentially every action they take and explained none of them.
            toolName = ev.content_block.name
            toolJson = ''
            run.activity = `Running ${toolName}…`
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
            if (toolName) toolJson += ev.delta.partial_json
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            tail += ev.delta.text
            block += ev.delta.text
            const line = ev.delta.text.trim().split('\n').pop() ?? ''
            if (line) run.activity = line.slice(0, 160)
          } else if (ev.type === 'content_block_stop') {
            flush()
            flushTool()
          }
        } else if (message.type === 'assistant') {
          trackAssistant(usage, message)
        } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
          // The context overflowed and was summarized mid-run: the agent kept working but
          // lost detail. That belongs in its mind — it explains a run that forgot something.
          usage.compactions += 1
          const pre = num((message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata?.pre_tokens)
          office.think(agent.id, {
            kind: 'observation',
            text: `Context compacted${pre ? ` at ${pre} tokens` : ''} — earlier detail in this run was summarized away.`,
            runId: run.id
          })
        } else if (message.type === 'result') {
          // Captured before the error check: a failed run still spent what it spent.
          applyResult(usage, message, model)
          const failure = claudeResultError(message)
          if (failure) throw new Error(failure)
          if ('result' in message && typeof message.result === 'string') tail = message.result
          if ('session_id' in message && message.session_id) rec.sessionId = message.session_id
        }
      }

      flush()
      // The narrow race where the stream finishes just as the deadline fires: the
      // abort never produced a throw, but the run is still a timeout and must not
      // resurrect itself as 'done'. Settled here rather than returning early, so
      // the finally below never records a run left in 'running'.
      if (timedOut) {
        run.state = 'error'
        run.error = 'Run timed out.'
        run.timedOut = true
        run.activity = 'Timed out.'
        run.summary = tail.trim().slice(-4000)
        run.endedAt = Date.now()
        this.noteTimeout(rec)
        return
      }
      run.state = 'done'
      run.summary = tail.trim().slice(-4000)
      run.activity = 'Idle.'
      run.endedAt = Date.now()
      // A run that completed is the evidence the breaker was waiting for.
      this.clearBreaker(rec)
      const acted = run.decisions.filter((d) => d.outcome !== 'refused').length
      console.log(`[agents] ${agent.id} run complete — ${acted} trade(s) actioned`)
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err)
      if (/401|authenticat|credential/i.test(msg)) {
        msg = 'No local Claude session. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.'
      } else if (/max_turns/i.test(msg)) {
        msg = `Hit the ${MAX_RUN_TURNS}-turn limit before finishing. Anything it filed before that stands; the closing summary below is where it got to.`
      }
      // Checked before wasStopped(): the timeout aborts the same controller the
      // operator's STOP does, so without this a deadline would report as a stop.
      // The verdict is already recorded — keep it, and only add whatever the run
      // managed to say before it was cut off.
      if (timedOut) {
        run.summary = tail.trim().slice(-4000)
      } else if (proc?.wasStopped()) {
        // An aborted query throws like any other failure; only the registry knows
        // it was deliberate, so ask before calling it an error the operator caused.
        console.log(`[agents] ${agent.id} run stopped by operator`)
        run.state = 'done'
        run.activity = 'Stopped.'
        run.summary = tail.trim().slice(-4000) || 'Stopped before completion.'
      } else {
        console.error(`[agents] ${agent.id} run failed:`, msg)
        run.state = 'error'
        run.error = msg
        run.activity = 'Run failed.'
        // Keep whatever it managed to say. The run still failed and still reads as
        // failed; this only stops the work it did do from being unreadable.
        run.summary = tail.trim().slice(-4000)
      }
      // A timed-out run ended at its deadline, not whenever the aborted session
      // finally unwound — that timestamp is already set and stays.
      if (!timedOut) run.endedAt = Date.now()
    } finally {
      proc?.done()
      clearTimeout(timeout)
      this.trackRun(rec, run)
      this.running.delete(agent.id)
      // The cascade this agent belonged to ends with its run, whatever the outcome —
      // leaving the chain behind would bar it from a later, unrelated inline answer.
      this.inlineChains.delete(agent.id)
      // Folded here rather than on success, so a run that errored halfway still counts
      // what it burned. A run that never reached the model (bad credentials) has nothing
      // to add and would only inflate the run count.
      if (run.usage && (totalTokens(run.usage) > 0 || run.usage.turns > 0)) foldTotals(rec, run.usage, 'run')
      rec.lastActiveAt = Date.now()
      this.save()
    }
  }

  // ── Chat ─────────────────────────────────────────────────────────────────
  // Talking to an agent runs a session under the same mandate and the same authority
  // gate — asking it to buy something in chat is subject to the identical dial.

  async chat(id: string, text: string): Promise<{ ok: boolean; error?: string; reply?: string; transcript?: AgentMessage[] }> {
    const rec = this.records.get(id)
    if (!rec) return { ok: false, error: 'unknown agent' }
    if (this.running.has(id)) return { ok: false, error: 'this agent is busy on a run' }

    this.running.add(id)
    rec.transcript.push({ role: 'user', text, at: Date.now() })

    let proc: ReturnType<typeof claudeProcesses.register> | null = null
    try {
      const snap = cryptoHub.getSnapshot()
      const model = rec.agent.model || MODEL
      proc = claudeProcesses.register({
        kind: 'agent-chat', label: rec.agent.name, component: `agent:${rec.agent.id}`,
        detail: text.trim().slice(0, 80) || 'chat turn', model,
      })
      const response = query({
        prompt: `${text}\n\n[Current portfolio state]\n${marketContext(snap)}`,
        options: {
          ...(model ? { model } : {}),
          abortController: proc.controller,
          ...(rec.sessionId ? { resume: rec.sessionId } : {}),
          systemPrompt: systemPromptFor(rec.agent, this.apiBase, this.token, this.roster(), rec.proposeKey ?? ''),
          permissionMode: 'bypassPermissions',
          maxTurns: 30,
          cwd: process.cwd(),
          env: agentEnv()
        }
      })

      let reply = ''
      // A chat turn resumes the previous session, so this leg's context includes every
      // earlier turn — which is exactly why it is worth showing.
      const usage = emptyAgentUsage()
      for await (const message of response) {
        if (message.type === 'assistant') {
          trackAssistant(usage, message)
        } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
          usage.compactions += 1
          office.think(rec.agent.id, {
            kind: 'observation',
            text: 'Chat context compacted — earlier turns in this conversation were summarized away.',
            runId: null
          })
        } else if (message.type === 'result') {
          applyResult(usage, message, model)
          const failure = claudeResultError(message)
          if (failure) throw new Error(failure)
          if ('result' in message && typeof message.result === 'string') reply = message.result
          if ('session_id' in message && message.session_id) rec.sessionId = message.session_id
        }
      }

      rec.chatUsage = usage
      foldTotals(rec, usage, 'chat')
      rec.lastActiveAt = Date.now()
      rec.transcript.push({ role: 'agent', text: reply.trim() || '(no response)', at: Date.now() })
      rec.transcript = rec.transcript.slice(-MAX_TRANSCRIPT_KEPT)
      this.save()
      return { ok: true, reply, transcript: rec.transcript }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A failed turn resuming a stale session should not wedge the agent forever.
      // The session is gone, so the context reading that described it is too.
      delete rec.sessionId
      delete rec.chatUsage
      rec.transcript.push({ role: 'agent', text: `[error] ${msg}`, at: Date.now() })
      this.save()
      return { ok: false, error: msg, transcript: rec.transcript }
    } finally {
      proc?.done()
      this.running.delete(id)
    }
  }

  clearTranscript(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec) return false
    rec.transcript = []
    delete rec.sessionId
    // A cleared conversation starts from an empty context; keeping the old reading would
    // show a full window for a session that no longer exists.
    delete rec.chatUsage
    this.save()
    return true
  }

  // ── Triggers ─────────────────────────────────────────────────────────────

  startWatching(): void {
    if (this.watchTimer) return
    // Contained: tick() reads the snapshot, expires blockers, refreshes the manager's
    // file (disk I/O plus merge logic over agent-authored data) and starts runs. An
    // exception in a setInterval callback is an UNCAUGHT exception in Node, so one
    // malformed manager-file entry would take down the whole trading server — the
    // bracket monitor and alert evaluation included. The sibling haHub/telemetryHub
    // ticks have always been wrapped; this one was not.
    this.watchTimer = setInterval(() => {
      try {
        this.tick()
      } catch (err) {
        console.error('[agents] watch tick failed:', (err as Error).message)
      }
    }, WATCH_INTERVAL_MS)
    if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref()
    console.log('[agents] event watcher started')
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }

  /** One watch pass: detect portfolio edges, then wake whichever agents asked for them. */
  private tick(): void {
    const snap = cryptoHub.getSnapshot()
    const fired = this.detectEvents(snap)
    const now = Date.now()

    // A question nobody answered must not hold an employee off work forever.
    for (const b of blockerBoard.expireStale(now)) {
      office.think(b.agentId, {
        kind: 'observation',
        text: `Question to @${b.askedOf} expired unanswered after 48h: "${b.question.slice(0, 160)}". Resuming without it.`,
        runId: null
      })
    }

    // Mentions land on the Manager's File now, not in eight private inboxes, so the file
    // has to be current before anyone is chosen from it.
    managerFile.refresh(now)
    const deskManager = managerFile.managerId()

    // Two passes. The first works out who is DUE — a pure question per agent, with no
    // side effect on anyone else. The second hands out the slot in priority order.
    // Doing it in one pass is what made the old scheduler unfair: whoever came first in
    // the map won, so the earliest hire outranked every later one no matter what each
    // of them had woken up to do.
    const candidates: { rec: AgentRecord; agentId: string; trigger: AgentRunTrigger; lastAutoRunAt?: number | undefined }[] = []
    for (const rec of this.records.values()) {
      if (!rec.agent.enabled) continue
      if (this.running.has(rec.agent.id)) continue
      const trigger = this.dueTrigger(rec, { fired, snap, now, deskManager })
      if (!trigger) continue
      candidates.push({ rec, agentId: rec.agent.id, trigger, lastAutoRunAt: rec.lastAutoRunAt })
    }

    for (const c of pickRunOrder(candidates)) {
      if (this.running.size >= MAX_CONCURRENT_RUNS) break
      const r = this.start(c.agentId, c.trigger)
      if (r.ok) console.log(`[agents] ${c.agentId} woken by ${c.trigger}`)
      // Everyone who does not get the slot simply stays a candidate next tick. Their
      // lastAutoRunAt is deliberately left alone: it was being cleared here, which erased
      // the cooldown anchor and made every agent that lost the race permanently eligible.
      // Contention was removing the rate limit at precisely the moment it was needed.
    }

    // Housekeeping last, so it never takes the concurrency slot from real work.
    this.standdownSweep(now)
  }

  /**
   * Why this agent should wake right now, or null. Pure with respect to the fleet — it
   * reads state and counts a suppression, but starts nothing, so tick() can ask every
   * agent before deciding who actually gets the single slot.
   */
  private dueTrigger(
    rec: AgentRecord,
    ctx: { fired: Set<AgentEvent>; snap: CryptoSnapshot; now: number; deskManager: string | null }
  ): AgentRunTrigger | null {
    const a = rec.agent

    // An answer outranks everything, including the cooldown: the agent has been sitting
    // on its hands waiting for exactly this, and making it wait out a cooldown as well
    // would be the same rudeness the blocker exists to prevent.
    if (blockerBoard.undelivered(a.id).length > 0) return 'answer'

    // Work the manager dispatched off the file. Also ahead of the cooldown — a colleague
    // is waiting on the other end of it — but bounded twice over: an agent may hold only
    // MAX_ASSIGNED_PER_AGENT open items, and each assignment is delivered exactly once.
    if (managerFile.pendingFor(a.id).length > 0) return 'assignment'

    // THE CIRCUIT BREAKER. Runs that keep dying at the deadline get exponentially longer
    // hold-offs. Checked after 'answer' and 'assignment' deliberately: those are somebody
    // else waiting on this agent, and a colleague's question deserves an attempt even from
    // an agent whose scheduled runs are misbehaving. Manual RUN never reaches here at all.
    if (this.health(rec, ctx.now).suppressed) return null

    // Cooldown applies across every automatic trigger, so an event storm and an
    // interval cannot compound into back-to-back runs.
    if (rec.lastAutoRunAt && ctx.now - rec.lastAutoRunAt < a.cooldownMinutes * 60_000) return null

    // THE WAITING RULE. An agent holding a blocking question does not wake on its
    // interval or on events. Waking it would produce exactly one behaviour — asking
    // again — which is the thing this exists to stop. It is not idle; it is waiting,
    // and the answer is what ends the wait. Manual RUN still works: that is the
    // operator asking, not the agent nagging.
    const blocking = blockerBoard.isBlocked(a.id)
    if (blocking) {
      blockerBoard.countSuppressed(blocking.id)
      return null
    }

    const due = this.nextRunAt(rec)
    if (due !== null && ctx.now >= due) return 'interval'

    for (const ev of a.events) {
      if (ev === 'mention') {
        // THE MENTION RULE. A tag no longer wakes the person tagged. Replies on this
        // board routinely name five or six colleagues, so one message used to arm six
        // agents, each of whom woke, replied, and named six more — a loop with no exit
        // that the cooldown could only slow down. Mentions now land on the Manager's
        // File as one item per message, and only the manager reads it.
        if (!ctx.deskManager || a.id !== ctx.deskManager) continue
        // ...and only on an edge. An item the manager has already seen and not triaged
        // does not wake them again; it is still on the file when they next run.
        if (!managerFile.wakeDue(rec.lastAutoRunAt ?? 0)) continue
        return 'mention'
      }
      if (!ctx.fired.has(ev)) continue
      // Drawdown is per-agent: each sets its own depth threshold.
      if (ev === 'drawdown' && !this.hasDrawdown(ctx.snap, a.drawdownPct)) continue
      return ev
    }
    return null
  }

  // ── Standing down when idle ──────────────────────────────────────────────
  //
  // A chat session is resumed turn after turn, so its context only grows. An agent that
  // has stopped working is holding that whole context open for nothing.
  //
  // Note on `/autocompact`: there is no such command available to a headless session, and
  // the SDK exposes no compact() call. Compaction happens automatically when a live
  // session fills up (we count those — see `compactions`). For an agent that has gone
  // idle, compaction is also the wrong tool: summarizing a conversation nobody is having
  // still leaves it open. Standing down is stronger and cheaper — write the durable part
  // to the journal, which survives everything, then drop the session entirely. The next
  // wake starts clean and reads the journal back.

  /** Below this there is nothing worth summarizing; the session is just released. */
  private static readonly STANDDOWN_MIN_CONTEXT = 15_000

  /** Sweeps idle agents. Called from the same watch tick as the triggers. */
  private standdownSweep(now: number): void {
    for (const rec of this.records.values()) {
      const a = rec.agent
      if (!a.idleStanddownMinutes || a.idleStanddownMinutes <= 0) continue
      if (!rec.sessionId) continue           // nothing held open
      if (this.running.has(a.id)) continue
      const idleFor = now - (rec.lastActiveAt ?? rec.agent.updatedAt)
      if (idleFor < a.idleStanddownMinutes * 60_000) continue

      const ctx = rec.chatUsage?.contextTokens ?? 0
      if (ctx < AgentFleet.STANDDOWN_MIN_CONTEXT) {
        // Cheap path: nothing substantial to preserve, so just let the session go.
        this.releaseSession(rec, `idle ${Math.round(idleFor / 60_000)}m, ${ctx} tokens held — released without a handoff`)
        continue
      }
      // The handoff needs the single concurrency slot, and real work always outranks
      // housekeeping — so on a busy desk it can be starved indefinitely. Freeing the
      // context is the point; the handoff is the nicety. Past three times the idle
      // window, take the release without it rather than hold the session forever.
      if (idleFor > a.idleStanddownMinutes * 3 * 60_000 && this.running.size >= MAX_CONCURRENT_RUNS) {
        this.releaseSession(rec, `idle ${Math.round(idleFor / 60_000)}m — the desk stayed busy, so ${fmtCtx(ctx)} was released without a handoff`)
        continue
      }
      void withActor(`agent:${a.id}`, () => this.standdown(rec, idleFor))
    }
  }

  /** Drops the resumed session and records why. */
  private releaseSession(rec: AgentRecord, why: string): void {
    delete rec.sessionId
    delete rec.chatUsage
    rec.stoodDownAt = Date.now()
    this.save()
    office.think(rec.agent.id, { kind: 'observation', text: `Stood down — ${why}.`, runId: null })
    console.log(`[agents] ${rec.agent.id} stood down — ${why}`)
  }

  /**
   * Asks an idle agent for a handoff note, files it in its journal, then releases the
   * session. This is the compaction that actually helps: the gist becomes durable and
   * cheap to reload, and the expensive context goes away.
   */
  private async standdown(rec: AgentRecord, idleFor: number): Promise<void> {
    const agent = rec.agent
    if (this.running.size >= MAX_CONCURRENT_RUNS) return  // real work outranks housekeeping
    this.running.add(agent.id)
    const ctxBefore = rec.chatUsage?.contextTokens ?? 0
    let proc: ReturnType<typeof claudeProcesses.register> | null = null
    try {
      const model = agent.model || MODEL
      const usage = emptyAgentUsage()
      proc = claudeProcesses.register({
        kind: 'agent-handoff', label: agent.name, component: `agent:${agent.id}`,
        detail: `off-shift handoff after ${Math.round(idleFor / 60_000)}m idle`, model,
      })
      const response = query({
        prompt: `You are going off shift — you have been idle for ${Math.round(idleFor / 60_000)} minutes and this ` +
          `conversation is about to be closed to free its context.\n\n` +
          `Write your handoff now, as a journal entry, so the next you starts informed instead of cold. ` +
          `Cover only what a colleague could not reconstruct from the files: what you were in the middle of, ` +
          `what you concluded and why, what you are waiting on and from whom, and the single thing you would ` +
          `do first when you come back. Be brief and concrete — no summary of your job description.\n\n` +
          `Post it with:\n` +
          `curl -s -X POST "${this.apiBase}/api/crypto/office/${agent.id}/journal?token=${this.token}" ` +
          `-H 'Content-Type: application/json' -H 'x-homunculus-actor: agent:${agent.id}' ` +
          `-d '{"title":"Handoff","body":"...","tags":["handoff"]}'\n\n` +
          `Then stop. Do not start new analysis, do not propose trades, do not post to the board.`,
        options: {
          ...(model ? { model } : {}),
          ...(rec.sessionId ? { resume: rec.sessionId } : {}),
          abortController: proc.controller,
          systemPrompt: systemPromptFor(agent, this.apiBase, this.token, this.roster(), rec.proposeKey ?? ''),
          permissionMode: 'bypassPermissions',
          maxTurns: 6,
          cwd: process.cwd(),
          env: agentEnv()
        }
      })
      for await (const message of response) {
        if (message.type === 'assistant') trackAssistant(usage, message)
        else if (message.type === 'result') applyResult(usage, message, model)
      }
      if (totalTokens(usage) > 0) foldTotals(rec, usage, 'chat')
      this.releaseSession(rec, `idle ${Math.round(idleFor / 60_000)}m — handoff filed, ${fmtCtx(ctxBefore)} of context released`)
    } catch (err) {
      // A failed handoff must not leave the session pinned open forever — that is the
      // exact condition this sweep exists to clear.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[agents] ${agent.id} handoff failed (${msg}) — releasing the session anyway`)
      this.releaseSession(rec, `idle ${Math.round(idleFor / 60_000)}m — handoff failed (${msg.slice(0, 80)}), session released regardless`)
    } finally {
      proc?.done()
      this.running.delete(agent.id)
    }
  }

  /**
   * Wakes one agent because a market alert named it. Returns why it could not, or
   * null on success.
   *
   * Deliberately NOT gated on the agent's `events` list: the alert already chose
   * this agent, and requiring a second opt-in would mostly produce alerts that
   * silently never fire. Everything else still applies — a disabled agent stays
   * asleep, the cooldown holds, and the concurrency cap holds — because an alert
   * that re-fires every bar must not be able to spin an agent continuously.
   */
  wakeFromAlert(agentId: string, reason: string): string | null {
    const rec = this.records.get(agentId)
    if (!rec) return 'unknown agent'
    if (!rec.agent.enabled) return 'agent is disabled'
    if (this.running.has(agentId)) return 'agent is already running'
    const now = Date.now()
    if (rec.lastAutoRunAt && now - rec.lastAutoRunAt < rec.agent.cooldownMinutes * 60_000) {
      const mins = Math.ceil((rec.agent.cooldownMinutes * 60_000 - (now - rec.lastAutoRunAt)) / 60_000)
      return `in cooldown for another ${mins}m`
    }
    const r = this.start(agentId, 'alert')
    if (!r.ok) return r.error ?? 'could not start'
    console.log(`[agents] ${agentId} woken by alert — ${reason}`)
    return null
  }

  /** Whether this agent may arm an alert that stages trades. */
  mayStage(agentId: string): { ok: boolean; reason?: string } {
    const rec = this.records.get(agentId)
    if (!rec) return { ok: false, reason: 'unknown agent' }
    if (rec.agent.autonomy === 'advisory') {
      return {
        ok: false,
        reason: `${rec.agent.name} is ADVISORY and has no trading authority — it may arm notify or wake alerts, not staging ones`,
      }
    }
    return { ok: true }
  }

  has(agentId: string): boolean {
    return this.records.has(agentId)
  }

  private hasDrawdown(snap: CryptoSnapshot, pct: number): boolean {
    return snap.holdings.some((h) => (h.unrealizedPnlPct ?? 0) <= -pct && Number(h.amountNotional) >= 1)
  }

  /** Edge-detects the watchable events by diffing against the previous tick. */
  private detectEvents(snap: CryptoSnapshot): Set<AgentEvent> {
    const fired = new Set<AgentEvent>()
    const signals = new Set(
      snap.signals.filter((s) => s.seeded && s.direction !== 'HOLD' && s.entryQuality === 'HIGH').map((s) => `${s.symbol}:${s.direction}`)
    )
    const pending = new Set(snap.pending.map((p) => p.id))
    // Newest fill TIMESTAMP, not the array length. Per-symbol history is capped at
    // 500 by fetchMyTrades, so once an active symbol hits that cap new fills displace
    // old ones and the total length stops growing — `fills > prev.fills` then never
    // fires again, going deaf exactly when trading is busiest. The length can also
    // DECREASE when the tracked symbol set changes, silently re-arming at a wrong
    // baseline. A monotonic clock has neither failure.
    const fills = snap.tradeHistory.reduce((max, t) => (t.timestampMs > max ? t.timestampMs : max), 0)

    const prev = this.lastSeen
    if (prev) {
      if (fills > prev.fills) fired.add('fill')
      for (const s of signals) if (!prev.signals.has(s)) { fired.add('signal'); break }
      for (const p of pending) if (!prev.pending.has(p)) { fired.add('proposal'); break }
      // Drawdown is a level, not an edge — tick() decides per agent whether this
      // particular employee's threshold is the one crossed.
      if (this.hasDrawdown(snap, 1)) fired.add('drawdown')
      // 'mention' is deliberately absent. It used to be added unconditionally on every
      // tick, which made it the one trigger with no edge at all: an unanswered tag
      // re-woke its target every cooldown, forever. It is now decided against the
      // Manager's File in dueTrigger(), where novelty is measured properly.
    }

    this.lastSeen = { fills, signals, pending }
    return fired
  }
}

export const agentFleet = new AgentFleet()

// Hand the alert store its way back to the fleet. Registration rather than an
// import in cryptoAlerts.ts, which sits upstream of this module (see FleetBinding).
bindFleet({
  wake: (agentId, reason) => agentFleet.wakeFromAlert(agentId, reason),
  mayStage: (agentId) => agentFleet.mayStage(agentId),
  exists: (agentId) => agentFleet.has(agentId),
})

export function isAgentAutonomy(v: unknown): v is AgentAutonomy {
  return v === 'advisory' || v === 'propose' || v === 'auto'
}

export function isAgentEvent(v: unknown): v is AgentEvent {
  return v === 'signal' || v === 'fill' || v === 'drawdown' || v === 'proposal' || v === 'mention'
}
