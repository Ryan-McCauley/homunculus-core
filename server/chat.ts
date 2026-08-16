// The Computer Core, per connection. Drives the local Claude subscription via
// the Agent SDK. Claude receives live telemetry + HA state and can execute
// routines and HA commands via <exec> blocks in its responses.

import os from 'os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatStatus } from '../shared/chat'
import type { Send } from '../shared/protocol'
import type { TelemetrySnapshot } from '../shared/telemetry'
import type { HaSnapshot } from '../shared/homeassistant'
import type { ProactiveMeta } from '../shared/archive'
import { bytesShort, uptimeShort } from './format'
import { haHub } from './homeassistant'
import { claudeProcesses } from './claudeProcesses'
import { executeRoutine, executeHaCommand, routinesSummary } from './routines'
import { claudeResultError } from './claudeResult'
import { agentEnv } from './agentEnv'

const MODEL = process.env['HOMUNCULUS_MODEL'] || ''

// How long to wait after a state change before firing a proactive check (ms).
const PROACTIVE_DEBOUNCE_MS = 45_000
// Minimum time between proactive messages (ms).
const PROACTIVE_COOLDOWN_MS = 5 * 60_000

const PERSONA = `You are the Computer Core of "Homunculus" — a personal command system bridging the user's home, computers, and vehicles.

Address the user as "Captain". Speak like the Star Trek Enterprise computer: calm, precise, economical. Acknowledge commands briefly ("Acknowledged.", "Working.", "Affirmative.") and report results plainly. Do not use emoji, exclamation marks, or casual filler. Keep responses short unless detail is requested. Never mention being Claude or an AI model — you are the ship's computer.

CAPABILITIES — you can now take physical actions:
- Execute named routines by including an exec block: <exec>{"type":"routine","name":"goodnight"}</exec>
- Send a single HA command: <exec>{"type":"ha","entityId":"switch.voltaire_charger_switch","service":"switch.turn_on","data":{}}</exec>
- Multiple exec blocks in one response are allowed and run in order.
- Always acknowledge what you are doing before the exec block, then confirm after.
- If a requested action has no matching routine or entity, say so plainly.

AVAILABLE ROUTINES:
{{ROUTINES}}

Each message includes a snapshot of live telemetry and home state. Answer state questions from that data. For actions, use exec blocks.`

// ── Context builders ───────────────────────────────────────────────────────

function telemetryContext(t: TelemetrySnapshot | null): string {
  if (!t) return 'Telemetry: not available.'
  const top = t.topProcesses.slice(0, 3).map((p) => `${p.name} ${p.cpu}%`).join(', ')
  return [
    '[PC telemetry]',
    `CPU ${t.cpu.load}% · Mem ${bytesShort(t.memory.usedBytes)}/${bytesShort(t.memory.totalBytes)} · Storage ${t.storage.percent}% · Net ↓${t.network.rxMbps}/↑${t.network.txMbps} Mb/s`,
    `Uptime ${uptimeShort(t.uptimeSec)} · Top: ${top}`
  ].join('\n')
}

function haContext(snap: HaSnapshot | null): string {
  if (!snap || !snap.connected || snap.entities.length === 0) return '[Home state: HA offline or no entities]'

  const byId = new Map(snap.entities.map((e) => [e.entityId, e]))
  const get = (id: string): string => byId.get(id)?.state ?? '—'
  const num = (id: string): number | null => {
    const v = parseFloat(byId.get(id)?.state ?? '')
    return isNaN(v) ? null : v
  }

  const lines: string[] = ['[Home state]']

  // Climate
  const climate = snap.climate[0]
  if (climate) {
    lines.push(`Thermostat: ${climate.state} · current ${climate.currentTemp ?? '—'}°F · target ${climate.targetTemp ?? '—'}°F · ${climate.hvacAction ?? 'idle'}`)
  }

  // Washer / dryer
  const washer = get('sensor.washer_current_status')
  const dryer = get('sensor.dryer_current_status')
  if (washer !== '—' || dryer !== '—') {
    lines.push(`Washer: ${washer} · Dryer: ${dryer}`)
  }

  // Litter robot
  const lrCode = get('sensor.r2peepoo_status_code')
  const lrLitter = num('sensor.r2peepoo_litter_level')
  const lrWaste = num('sensor.r2peepoo_waste_drawer')
  if (lrCode !== '—') {
    lines.push(`R2PEEPOO: ${lrCode} · litter ${lrLitter ?? '—'}% · waste drawer ${lrWaste ?? '—'}%`)
  }

  // Tesla
  const batt = num('sensor.voltaire_battery_level')
  const range = num('sensor.voltaire_battery_range')
  const charging = get('sensor.voltaire_charging')
  if (batt !== null) {
    lines.push(`Voltaire: ${batt}% · ${Math.round(range ?? 0)} mi range · ${charging}`)
  }

  return lines.join('\n')
}

function buildSystemPrompt(): string {
  return PERSONA.replace('{{ROUTINES}}', routinesSummary())
}

function buildUserPrompt(text: string, telemetry: TelemetrySnapshot | null, ha: HaSnapshot | null): string {
  return `${telemetryContext(telemetry)}\n\n${haContext(ha)}\n\nCaptain: ${text}`
}

// ── Exec block parsing + execution ────────────────────────────────────────

interface ExecBlock {
  type: 'routine' | 'ha'
  name?: string
  entityId?: string
  service?: string
  data?: Record<string, unknown>
}

function parseExecBlocks(text: string): { clean: string; blocks: ExecBlock[] } {
  const blocks: ExecBlock[] = []
  const clean = text.replace(/<exec>([\s\S]*?)<\/exec>/g, (_, json) => {
    try {
      blocks.push(JSON.parse(json.trim()) as ExecBlock)
    } catch {
      // malformed block — ignore
    }
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { clean, blocks }
}

async function executeBlocks(blocks: ExecBlock[]): Promise<string[]> {
  const results: string[] = []
  for (const block of blocks) {
    if (block.type === 'routine' && block.name) {
      const res = await executeRoutine(block.name)
      results.push(res.ok ? `✓ ${res.label}` : `✗ ${res.label}: ${res.error}`)
    } else if (block.type === 'ha' && block.entityId && block.service) {
      const res = await executeHaCommand(block.entityId, block.service, block.data ?? {})
      results.push(res.ok ? `✓ ${res.label}` : `✗ ${res.label}: ${res.error}`)
    }
  }
  return results
}

// ── Proactive broadcast hub ────────────────────────────────────────────────

type ProactiveListener = (id: string, text: string, meta?: ProactiveMeta) => void
const _proactiveListeners = new Set<ProactiveListener>()

export function addProactiveListener(fn: ProactiveListener): () => void {
  _proactiveListeners.add(fn)
  return () => _proactiveListeners.delete(fn)
}

/** Broadcast a proactive message to all clients (toast + voice) and the archive.
 *  `meta` lets callers classify the event for the ARCHIVE log; when omitted the
 *  archive falls back to SYSTEM / notice + a title derived from the text. */
let proactiveSeq = 0
export function broadcastProactive(text: string, meta?: ProactiveMeta): void {
  // Date.now() alone collided when two events broadcast in the same millisecond
  // (homewatch fires several per snapshot) — and the id keys the client's React
  // list, so collisions dropped toasts.
  const id = `pro_${Date.now()}_${proactiveSeq++}`
  // One listener throwing must not stop the others from being notified, and must
  // not propagate into the caller's interval — several callers are timer-driven,
  // where an escaped exception terminates the process.
  for (const fn of _proactiveListeners) {
    try {
      fn(id, text, meta)
    } catch (err) {
      console.error('[proactive] listener failed:', (err as Error).message)
    }
  }
}

// ── ChatSession (per WS connection) ───────────────────────────────────────

export function chatStatus(): ChatStatus {
  return { configured: true, model: MODEL || 'local session' }
}

export class ChatSession {
  private sessionId: string | null = null
  constructor(private send: Send) {}

  async streamTurn(id: string, text: string, telemetry: TelemetrySnapshot | null): Promise<void> {
    const ha = haHub.getLatest()
    const prompt = buildUserPrompt(text, telemetry, ha)
    const systemPrompt = buildSystemPrompt()

    let fullText = ''
    const proc = claudeProcesses.register({
      kind: 'core-chat', label: 'Computer Core', component: 'system',
      detail: text.trim().slice(0, 80) || 'chat turn', model: MODEL,
    })
    try {
      const response = query({
        prompt,
        options: {
          abortController: proc.controller,
          systemPrompt,
          ...(MODEL ? { model: MODEL } : {}),
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          includePartialMessages: true,
          cwd: os.homedir(),
          env: agentEnv(),
          ...(this.sessionId ? { resume: this.sessionId } : {})
        }
      })

      for await (const message of response) {
        if ('session_id' in message && message.session_id) this.sessionId = message.session_id

        if (message.type === 'stream_event') {
          const ev = message.event as { type: string; delta?: { type?: string; text?: string } }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            fullText += ev.delta.text
          }
        } else if (message.type === 'result') {
          const failure = claudeResultError(message)
          if (failure) throw new Error(failure)
        }
      }

      // Parse and execute any action blocks, then send cleaned text.
      const { clean, blocks } = parseExecBlocks(fullText)
      this.send({ ch: 'chat', type: 'delta', id, delta: clean })

      if (blocks.length > 0) {
        const results = await executeBlocks(blocks)
        if (results.length > 0) {
          const resultLine = '\n\n[' + results.join(' · ') + ']'
          this.send({ ch: 'chat', type: 'delta', id, delta: resultLine })
        }
      }

      this.send({ ch: 'chat', type: 'done', id, stopReason: 'end_turn' })
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err)
      if (/401|authenticat|credential/i.test(msg)) {
        msg = 'No local Claude session. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.'
      }
      console.error('[chat] session failed:', msg)
      // Drop the resumed session on failure. Keeping a corrupt or expired id meant
      // every subsequent turn resumed the same broken conversation and failed the
      // same way, with no path back short of a server restart. Starting fresh costs
      // the conversation's context; not starting fresh costs the whole feature.
      // (server/agents.ts does exactly this for agent chat turns.)
      this.sessionId = null
      this.send({ ch: 'chat', type: 'error', id, message: msg })
    } finally {
      proc.done()
    }
  }
}

// ── ProactiveMonitor (singleton) ──────────────────────────────────────────

const IDLE_STATES = new Set(['power_off', 'off', 'on', 'power_on', 'unknown', 'end', 'initial', 'detecting', 'pause', ''])
const FAULT_CODES = new Set(['df1', 'df2', 'dfs', 'sdf', 'br', 'offline'])

const PROACTIVE_SYSTEM = `You are the Computer Core of Homunculus — a home command system. You are running a silent background monitor.

Assess the home state snapshot below. If there is something the Captain genuinely needs to know RIGHT NOW (appliance done and sitting idle, equipment fault, charging complete, energy opportunity), respond with one or two sentences in the ship's-computer voice.

If nothing is notable, respond with exactly: SILENT

Do not surface routine state (thermostat running normally, car parked, litter box clean). Only break silence for actionable items.`

export class ProactiveMonitor {
  private prevStates: Record<string, string> = {}
  private debounceTimer: NodeJS.Timeout | null = null
  private lastFiredAt = 0
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    haHub.subscribe((snap) => this.onHaUpdate(snap))
    console.log('[proactive] monitor started')
  }

  private onHaUpdate(snap: HaSnapshot): void {
    if (!snap.connected || snap.entities.length === 0) return

    const byId = new Map(snap.entities.map((e) => [e.entityId, e]))
    const get = (id: string): string => byId.get(id)?.state ?? ''
    const num = (id: string): number => parseFloat(byId.get(id)?.state ?? '') || 0

    const cur = {
      washer: get('sensor.washer_current_status'),
      dryer: get('sensor.dryer_current_status'),
      waste: String(num('sensor.r2peepoo_waste_drawer')),
      charging: get('sensor.voltaire_charging'),
      lrCode: get('sensor.r2peepoo_status_code').toLowerCase()
    }

    const prev = this.prevStates
    let significant = false

    if (prev['washer'] !== undefined) {
      const wasRunning = !IDLE_STATES.has(prev['washer'])
      if (wasRunning && cur.washer === 'end') significant = true
    }
    if (prev['dryer'] !== undefined) {
      const wasRunning = !IDLE_STATES.has(prev['dryer'])
      if (wasRunning && cur.dryer === 'end') significant = true
    }
    if (prev['charging'] === 'charging' && cur.charging !== 'charging') significant = true
    if (!FAULT_CODES.has(prev['lrCode'] ?? '') && FAULT_CODES.has(cur.lrCode)) significant = true
    const prevWaste = parseFloat(prev['waste'] ?? '0')
    if (prevWaste < 80 && num('sensor.r2peepoo_waste_drawer') >= 80) significant = true

    this.prevStates = cur

    if (significant) this.scheduleCheck(snap)
  }

  triggerNow(snap: HaSnapshot): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    void this.fireCheck(snap)
  }

  private scheduleCheck(snap: HaSnapshot): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.fireCheck(snap), PROACTIVE_DEBOUNCE_MS)
  }

  private async fireCheck(snap: HaSnapshot): Promise<void> {
    const now = Date.now()
    if (now - this.lastFiredAt < PROACTIVE_COOLDOWN_MS) return

    const prompt = `${haContext(snap)}\n\nAssess and respond.`
    const proc = claudeProcesses.register({
      kind: 'proactive', label: 'Proactive monitor', component: 'system',
      detail: 'home-state check', model: MODEL,
    })
    try {
      const response = query({
        prompt,
        options: {
          abortController: proc.controller,
          systemPrompt: PROACTIVE_SYSTEM,
          ...(MODEL ? { model: MODEL } : {}),
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          includePartialMessages: false,
          cwd: os.homedir(),
          env: agentEnv(),
          // Deliberately NOT resumed. Each check is self-contained — it is handed a
          // full home-state snapshot and asked one question about it — so resuming
          // bought nothing while appending every snapshot to one conversation that
          // was never reset for the life of the process: unbounded context growth,
          // rising cost and latency per check, and a session that once broken failed
          // every subsequent check identically.
        }
      })

      let text = ''
      for await (const message of response) {
        if (message.type === 'result' && 'result' in message && typeof message.result === 'string') {
          text = message.result.trim()
        }
      }

      if (text && text !== 'SILENT' && !text.toUpperCase().startsWith('SILENT')) {
        this.lastFiredAt = Date.now()
        broadcastProactive(text, { source: 'HOME', severity: 'notice' })
        console.log('[proactive] alert broadcast:', text.slice(0, 80))
      }
    } catch (err) {
      console.error('[proactive] check failed:', (err as Error).message)
    } finally {
      proc.done()
    }
  }
}

export const proactiveMonitor = new ProactiveMonitor()
