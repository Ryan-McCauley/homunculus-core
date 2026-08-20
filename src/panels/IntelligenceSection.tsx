// The CRYPTO tab's INTELLIGENCE section: the agent fleet, rendered as a physical office
// floor. Each agent is a mandate the operator writes, run by Claude against live
// portfolio state — and each one gets a desk. The monitor glows when a run is live, the
// LED strip along the desk edge is the autonomy dial's colour, papers pile up in the
// inbox tray, and clicking a desk sits you down at it (the inspector on the right).
//
// The autonomy dial rendered here is a *view* of server state, not the enforcement point.
// Authority is checked in server/agents.ts propose(); this UI only sets the dial.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentAutonomy, AgentDecision, AgentEvent, AgentRun, AgentUsage, AgentView, NewAgentInput } from '../../shared/agents'
import {
  AGENT_AUTONOMY_LABELS, AGENT_EVENT_LABELS, AGENT_MAX_USD_CEILING, AGENT_MODELS,
  agentModelLabel, contextFill, fmtTokens, totalTokens
} from '../../shared/agents'
import { chatWithAgent, clearAgentChat, createAgent, deleteAgent, fetchAgents, runAgent, updateAgent } from '../lib/agentsApi'
import { fetchRunningClaude } from '../lib/cryptoApi'
import { Board, Cubicle, Directory, useRoster } from './Office'
import { LibraryShelf } from './Library'
import { AgentTimeline } from './AgentTimeline'
import { ClaudeRunning } from './ClaudeRunning'
import { Blockers } from './Blockers'
import { fetchBlockers } from '../lib/blockersApi'
import type { Blocker } from '../../shared/blockers'
import type { RosterEntry } from '../lib/officeApi'
import { fetchBoard, fetchManagerFile } from '../lib/officeApi'
import { ManagerFileRoom } from './ManagerFileRoom'
import type { BoardThread, Department } from '../../shared/office'
import {
  departmentLabel, groupDesks, loadDeskLayout, moveDesk, saveDeskLayout,
  type DeskLayout
} from '../lib/officeLayout'
import {
  MAX_FLOOR_CONVERSATIONS,
  arcPath, corkboardSlips, deskAnchor, deskPose, deskTopAnchor, floorConversations,
  floorWalkers, poseHint, walkerStop,
  type BoardSlip, type DeskPose, type FloorConversation, type FloorWalker, type Pt
} from '../lib/officeFloor'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const GS = 'var(--green-soft)'
const AM = 'var(--amber)'
const CR = 'var(--crimson)'
const BL = 'var(--blue)'
const BORDER = '0.5px solid var(--border)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

const AUTONOMY: AgentAutonomy[] = ['advisory', 'propose', 'auto']
const EVENTS: AgentEvent[] = ['signal', 'fill', 'drawdown', 'proposal', 'mention']

/** Label for an event id, tolerating ids this build has never heard of. */
function eventLabel(ev: AgentEvent | string): string {
  return AGENT_EVENT_LABELS[ev as AgentEvent] ?? String(ev).toUpperCase()
}

// The dial's colour is the whole point of the section: at a glance, which agents can
// spend money without asking.
const AUTONOMY_COLOR: Record<AgentAutonomy, string> = {
  advisory: GD,
  propose: G,
  auto: AM
}

const AUTONOMY_HELP: Record<AgentAutonomy, string> = {
  advisory: 'Analyzes and talks. Every trade it proposes is refused by the server.',
  propose: 'Stages trades into the confirm queue. Nothing reaches the exchange until you approve it.',
  auto: 'Executes trades up to its cap with real money, no confirmation. Anything larger falls back to the confirm queue.'
}

function ago(ts: number | null): string {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function until(ts: number | null): string {
  if (!ts) return ''
  const s = Math.floor((ts - Date.now()) / 1000)
  if (s <= 0) return 'due'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function Lbl({ c = GD, size = 11, children }: { c?: string; size?: number; children: React.ReactNode }) {
  return <span style={{ ...MONO, fontSize: size, letterSpacing: 1, color: c }}>{children}</span>
}

function Btn({ children, onClick, disabled, color = GD, title }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; color?: string; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      ...MONO, fontSize: 11, letterSpacing: 1, padding: '4px 10px',
      background: 'transparent', border: `0.5px solid ${disabled ? 'var(--border)' : color}`,
      color: disabled ? 'var(--border)' : color, cursor: disabled ? 'default' : 'pointer'
    }}>{children}</button>
  )
}

// ── Decision log ────────────────────────────────────────────────────────────────

function DecisionRows({ decisions }: { decisions: AgentDecision[] }) {
  if (decisions.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
      {decisions.map((d, i) => {
        const col = d.outcome === 'executed' ? AM : d.outcome === 'staged' ? G : CR
        return (
          <div key={i} style={{ ...MONO, fontSize: 11, color: col, display: 'flex', gap: 6 }} title={d.detail ?? d.reason}>
            <span style={{ fontWeight: 700 }}>{d.outcome.toUpperCase()}</span>
            <span>{d.side.toUpperCase()} {d.amount} {d.symbol}{d.price ? ` @ ${d.price}` : ''}</span>
            <span style={{ color: GD }}>${d.notionalUsd.toFixed(2)}</span>
            {d.detail && <span style={{ color: GD, opacity: 0.8, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {d.detail}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Chat ───────────────────────────────────────────────────────────────────

function AgentChat({ view, onChanged }: { view: AgentView; onChanged: () => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [transcript, setTranscript] = useState(view.transcript)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setTranscript(view.transcript) }, [view.transcript])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [transcript])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setBusy(true)
    setTranscript((t) => [...t, { role: 'user', text, at: Date.now() }])
    const r = await chatWithAgent(view.agent.id, text)
    if (r.transcript) setTranscript(r.transcript)
    else if (r.error) setTranscript((t) => [...t, { role: 'agent', text: `[error] ${r.error}`, at: Date.now() }])
    setBusy(false)
    onChanged()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lbl c={GS}>CONVERSATION</Lbl>
        {view.chatUsage && <ContextChip usage={view.chatUsage} />}
        <div style={{ flex: 1 }} />
        <Btn onClick={async () => { await clearAgentChat(view.agent.id); setTranscript([]); onChanged() }}
          title="Wipe the transcript and start a fresh session">CLEAR</Btn>
      </div>
      <div style={{ border: BORDER, background: 'var(--bg-panel)', padding: 8, flex: 1, minHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {transcript.length === 0 && <Lbl>Ask it what it sees, or tell it what you want. Its answer is bound by the same autonomy dial.</Lbl>}
        {transcript.map((m, i) => (
          <div key={i}>
            <div style={{ ...MONO, fontSize: 10, letterSpacing: 1, color: m.role === 'user' ? GD : G, marginBottom: 2 }}>
              {m.role === 'user' ? 'YOU' : view.agent.name.toUpperCase()} · {ago(m.at)}
            </div>
            <div style={{ ...MONO, fontSize: 13, color: m.role === 'user' ? GS : 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.text}</div>
          </div>
        ))}
        {busy && <Lbl c={AM}>◈ thinking…</Lbl>}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder={busy ? 'waiting…' : 'MESSAGE…'}
          disabled={busy}
          style={{ ...MONO, fontSize: 13, flex: 1, padding: '6px 8px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }}
        />
        <Btn onClick={() => void send()} disabled={busy || !draft.trim()} color={G}>SEND</Btn>
      </div>
    </div>
  )
}

// ── Token accounting ───────────────────────────────────────────────────────

/** Colour for a context fill. Nothing is wrong at 40%; at 85% the next turn is at risk of
 *  being compacted away, which is worth seeing before it happens. */
function fillColor(f: number): string {
  return f >= 0.85 ? CR : f >= 0.6 ? AM : GD
}

function usageTooltip(u: AgentUsage): string {
  const lines = [
    `in ${fmtTokens(u.inputTokens)} fresh · ${fmtTokens(u.cacheReadTokens)} from cache · ${fmtTokens(u.cacheCreationTokens)} written to cache`,
    `out ${fmtTokens(u.outputTokens)}`,
    `${fmtTokens(totalTokens(u))} tokens total across ${u.turns} turn${u.turns === 1 ? '' : 's'}`
  ]
  if (u.contextWindow) lines.push(`peak context ${fmtTokens(u.contextTokens)} of ${fmtTokens(u.contextWindow)}`)
  if (u.compactions) lines.push(`compacted ${u.compactions}× — earlier detail was summarized away`)
  if (u.costUsd) lines.push(`${u.costUsd.toFixed(4)} of allowance (not a bill — this runs on your subscription)`)
  return lines.join('\n')
}

/** The conversation's context fill. Chat resumes its session every turn, so this only
 *  grows — it is the number that says when to press CLEAR. */
function ContextChip({ usage }: { usage: AgentUsage }) {
  const f = contextFill(usage)
  if (f === null) return null
  return (
    <span title={usageTooltip(usage)}>
      <Lbl c={fillColor(f)}>
        chat ctx {Math.round(f * 100)}% · {fmtTokens(usage.contextTokens)}/{fmtTokens(usage.contextWindow)}
        {usage.compactions > 0 ? ` · compacted ${usage.compactions}×` : ''}
      </Lbl>
    </span>
  )
}

/** Per-run accounting, shown in the LOG tab. */
function UsageRow({ usage }: { usage: AgentUsage }) {
  const f = contextFill(usage)
  return (
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 3 }} title={usageTooltip(usage)}>
      <Lbl>{usage.turns} turn{usage.turns === 1 ? '' : 's'}</Lbl>
      <Lbl>in {fmtTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens)}</Lbl>
      <Lbl>out {fmtTokens(usage.outputTokens)}</Lbl>
      {f !== null && <Lbl c={fillColor(f)}>peak ctx {Math.round(f * 100)}% · {fmtTokens(usage.contextTokens)}/{fmtTokens(usage.contextWindow)}</Lbl>}
      {usage.durationMs > 0 && <Lbl>{(usage.durationMs / 1000).toFixed(0)}s</Lbl>}
      {usage.compactions > 0 && <Lbl c={AM}>⚠ compacted {usage.compactions}×</Lbl>}
    </div>
  )
}

// ── Model picker ───────────────────────────────────────────────────────────

/** Which Claude model this agent's sessions run on. The choice is a real trade-off for an
 *  agent that wakes on an interval, so each option carries its own guidance rather than
 *  being a bare id in a dropdown. */
function ModelPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const known = AGENT_MODELS.some((m) => m.id === value)
  const [custom, setCustom] = useState(known ? '' : value)
  const [customOpen, setCustomOpen] = useState(!known && value !== '')
  const chosen = AGENT_MODELS.find((m) => m.id === value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {AGENT_MODELS.map((m) => {
          const on = m.id === value
          return (
            <button key={m.id || 'default'} onClick={() => { setCustomOpen(false); onChange(m.id) }} title={m.note}
              style={{
                ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 8px', cursor: 'pointer',
                background: on ? 'color-mix(in srgb, var(--green) 14%, transparent)' : 'transparent',
                border: `0.5px solid ${on ? G : 'var(--border)'}`, color: on ? G : GD
              }}>
              {on ? '◉' : '○'} {m.label}
            </button>
          )
        })}
        <button onClick={() => setCustomOpen((v) => !v)} title="Pin a model id this build does not list yet"
          style={{
            ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 8px', cursor: 'pointer',
            background: !known && value ? 'color-mix(in srgb, var(--green) 14%, transparent)' : 'transparent',
            border: `0.5px solid ${!known && value ? G : 'var(--border)'}`, color: !known && value ? G : GD
          }}>
          {!known && value ? `◉ ${value}` : '○ OTHER…'}
        </button>
      </div>

      {customOpen && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="claude-…"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onChange(custom.trim()) } }}
            style={{ ...MONO, fontSize: 12, width: 260, padding: '4px 7px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
          <Btn color={G} disabled={!custom.trim()} onClick={() => onChange(custom.trim())}>PIN</Btn>
          <Lbl>a model released after this build</Lbl>
        </div>
      )}

      <Lbl>{chosen ? chosen.note : 'Unlisted model id — the run fails if the SDK does not recognise it.'}</Lbl>
    </div>
  )
}

// ── Settings editor ────────────────────────────────────────────────────────

function AgentSettings({ view, onSave }: { view: AgentView; onSave: (patch: Partial<NewAgentInput>) => void }) {
  const a = view.agent
  const [mandate, setMandate] = useState(a.mandate)
  const [maxUsd, setMaxUsd] = useState(String(a.maxUsd))
  const [interval, setIntervalMin] = useState(String(a.intervalMinutes))
  const [cooldown, setCooldown] = useState(String(a.cooldownMinutes))
  const [drawdown, setDrawdown] = useState(String(a.drawdownPct))
  const [standdown, setStanddown] = useState(String(a.idleStanddownMinutes))
  const dirty =
    mandate !== a.mandate || Number(maxUsd) !== a.maxUsd || Number(interval) !== a.intervalMinutes ||
    Number(cooldown) !== a.cooldownMinutes || Number(drawdown) !== a.drawdownPct ||
    Number(standdown) !== a.idleStanddownMinutes

  const num = (v: string, fallback: number) => (v.trim() === '' || isNaN(Number(v)) ? fallback : Number(v))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Lbl c={GS}>MANDATE</Lbl>
      <textarea
        value={mandate} onChange={(e) => setMandate(e.target.value)} rows={6}
        style={{ ...MONO, fontSize: 13, lineHeight: 1.5, padding: 8, background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none', resize: 'vertical' }}
      />

      <Lbl c={GS}>MODEL</Lbl>
      <ModelPicker value={a.model} onChange={(model) => onSave({ model })} />

      <Lbl c={GS}>TRIGGERS</Lbl>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {EVENTS.map((ev) => {
          const on = a.events.includes(ev)
          return (
            <button key={ev} onClick={() => onSave({ events: on ? a.events.filter((e) => e !== ev) : [...a.events, ev] })}
              title={`Wake this agent when: ${eventLabel(ev).toLowerCase()}`}
              style={{
                ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 8px', cursor: 'pointer',
                background: on ? 'color-mix(in srgb, var(--green) 14%, transparent)' : 'transparent',
                border: `0.5px solid ${on ? G : 'var(--border)'}`, color: on ? G : GD
              }}>
              {on ? '◉' : '○'} {eventLabel(ev)}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>INTERVAL (MIN · 0 = OFF)</Lbl>
          <input value={interval} onChange={(e) => setIntervalMin(e.target.value)}
            style={{ ...MONO, fontSize: 13, padding: '5px 7px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>COOLDOWN (MIN)</Lbl>
          <input value={cooldown} onChange={(e) => setCooldown(e.target.value)}
            style={{ ...MONO, fontSize: 13, padding: '5px 7px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>DRAWDOWN TRIGGER (%)</Lbl>
          <input value={drawdown} onChange={(e) => setDrawdown(e.target.value)}
            style={{ ...MONO, fontSize: 13, padding: '5px 7px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>PER-TRADE CAP ($ · MAX {AGENT_MAX_USD_CEILING})</Lbl>
          <input value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)}
            style={{ ...MONO, fontSize: 13, padding: '5px 7px', background: 'var(--bg-elev)', border: `0.5px solid ${a.autonomy === 'auto' ? AM : 'var(--border)'}`, color: GS, outline: 'none' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>STAND DOWN WHEN IDLE (MIN · 0 = NEVER)</Lbl>
          <input value={standdown} onChange={(e) => setStanddown(e.target.value)}
            title="After this long with no run and no chat, the agent writes a handoff note to its journal and its conversation is closed, freeing the context it was holding. It comes back cold but informed."
            style={{ ...MONO, fontSize: 13, padding: '5px 7px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
        </label>
      </div>
      <Lbl>
        {Number(standdown) > 0
          ? `Idle for ${standdown}m → files a handoff, then releases its conversation. Nothing is lost: the note is durable, the context is not.`
          : 'Never stands down — this agent keeps its conversation open indefinitely, context and all.'}
      </Lbl>

      <div style={{ display: 'flex', gap: 6 }}>
        <Btn color={dirty ? G : GD} disabled={!dirty} onClick={() => onSave({
          mandate,
          maxUsd: num(maxUsd, a.maxUsd),
          intervalMinutes: num(interval, a.intervalMinutes),
          cooldownMinutes: num(cooldown, a.cooldownMinutes),
          drawdownPct: num(drawdown, a.drawdownPct),
          idleStanddownMinutes: num(standdown, a.idleStanddownMinutes)
        })}>SAVE</Btn>
        {dirty && <Lbl c={AM}>unsaved changes</Lbl>}
      </div>
    </div>
  )
}

// ── Run log ────────────────────────────────────────────────────────────────

function RunLog({ runs }: { runs: AgentRun[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0 }}>
      {runs.length === 0 && <Lbl>No runs yet.</Lbl>}
      {runs.map((r) => (
        <div key={r.id} style={{ border: BORDER, padding: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* A skip is dimmed, not green: nothing ran, nothing was decided, nothing
                was spent — reading it as a completed run overstates the desk's coverage. */}
            <Lbl c={r.state === 'error' ? CR : r.state === 'running' ? AM : r.state === 'skipped' ? GD : G}>
              {r.state === 'error' && r.timedOut ? 'TIMEOUT' : r.state.toUpperCase()}
            </Lbl>
            <Lbl>{r.trigger} · {ago(r.startedAt)}</Lbl>
            {/* Collapsed skips stand for many wakes, so the count has to be visible or the
                entry reads as a single quiet hour rather than a quiet day. */}
            {r.state === 'skipped' && (r.skipCount ?? 1) > 1 && <Lbl c={GD}>×{r.skipCount}</Lbl>}
            {/* Which model produced this run — the setting can change between runs. */}
            {r.model && <Lbl c={GS}>{agentModelLabel(r.model).toLowerCase()}</Lbl>}
          </div>
          {r.usage && totalTokens(r.usage) > 0 && <UsageRow usage={r.usage} />}
          <DecisionRows decisions={r.decisions} />
          {r.summary && (
            <div style={{ ...MONO, fontSize: 12, color: GD, whiteSpace: 'pre-wrap', lineHeight: 1.5, marginTop: 5 }}>{r.summary}</div>
          )}
          {r.error && <div style={{ ...MONO, fontSize: 12, color: CR, marginTop: 5 }}>{r.error}</div>}
        </div>
      ))}
    </div>
  )
}

// ── The desk ───────────────────────────────────────────────────────────────
//
// One employee's workstation, drawn as furniture. Everything visible is a real signal:
//   monitor        lit amber while a run is live, phosphor-green idle, dark when disabled
//   LED strip      the autonomy dial's colour along the desk edge
//   inbox tray     paper stacks up per unanswered mention
//   decision slips pinned to the partition when recent runs staged/executed trades
//   coffee steam   rises only while the agent is actually working

const FLOOR_CSS = `
@keyframes deskScreenHum { 0%,100% { opacity: 0.92 } 50% { opacity: 1 } }
@keyframes deskRunFlicker { 0%,100% { opacity: 0.75 } 42% { opacity: 1 } 58% { opacity: 0.85 } }
@keyframes deskSteam { 0% { transform: translateY(0); opacity: 0 } 25% { opacity: 0.7 } 100% { transform: translateY(-9px); opacity: 0 } }
@keyframes deskLampPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
.hm-desk { transition: transform 120ms ease, box-shadow 120ms ease; }
.hm-desk:hover { transform: translateY(-2px); }

/* ── the little people ─────────────────────────────────────────────────────
   Every motion is small and slow on purpose: the floor should read as inhabited
   from the corner of your eye, not compete with the data on the rest of the tab. */
@keyframes hmType { from { transform: translateY(0) } to { transform: translateY(1.4px) } }
@keyframes hmBreathe { 0%,100% { transform: scaleY(1) } 50% { transform: scaleY(1.04) } }
@keyframes hmPageFlip { 0%,78%,100% { transform: rotate(0deg) } 84%,92% { transform: rotate(-13deg) } }
@keyframes hmScribble { from { stroke-dashoffset: 18 } to { stroke-dashoffset: 0 } }
@keyframes hmNod { 0%,100% { transform: translateY(0) } 50% { transform: translateY(0.9px) } }
@keyframes hmLookUp { 0%,70%,100% { transform: translateX(0) } 80%,90% { transform: translateX(2.5px) } }
.hm-type { animation: hmType 0.34s steps(2) infinite alternate; }
.hm-nod { animation: hmNod 2.2s ease-in-out infinite; }
.hm-breathe { animation: hmBreathe 3.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100%; }
.hm-page { animation: hmPageFlip 5.5s infinite; transform-box: fill-box; transform-origin: 20% 90%; }
.hm-pen { stroke-dasharray: 5 3; animation: hmScribble 1.2s linear infinite; }
.hm-wait { animation: hmLookUp 3.6s ease-in-out infinite; }

/* Speech and walkers live on the floor overlay, above the desks. */
@keyframes hmFlow { to { stroke-dashoffset: -28 } }
/* Visible for under one slot of the cycle: with each bubble delayed by a whole slot,
   only one desk is ever mid-sentence, and the floor reads as taking turns. */
@keyframes hmBubble {
  0% { opacity: 0; transform: scale(0.7) } 2% { opacity: 1; transform: scale(1) }
  20% { opacity: 1; transform: scale(1) } 24%,100% { opacity: 0; transform: scale(0.95) }
}
@keyframes hmTap { 0%,72%,100% { transform: translateY(0) } 82%,92% { transform: translateY(-1.8px) } }
.hm-flow { stroke-dasharray: 3 4; animation: hmFlow 1.8s linear infinite; }
.hm-bubble { animation: hmBubble 12s ease-out infinite; transform-box: fill-box; transform-origin: 20% 100%; }
/* Animated transforms replace the transform attribute, so anything carrying one of
   these classes must be positioned by a parent <g>, never by its own attribute. */
.hm-petitioner { animation: hmTap 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100%; }

@media (prefers-reduced-motion: reduce) {
  .hm-type, .hm-nod, .hm-breathe, .hm-page, .hm-pen, .hm-wait,
  .hm-flow, .hm-bubble, .hm-petitioner { animation: none; }
}
`

// ── The person at the desk ─────────────────────────────────────────────────
//
// Drawn from behind, head and shoulders over the desk edge — the desk surface is
// painted after them, so the body below y=88 is hidden by the furniture exactly as it
// would be if you were standing behind their chair. The pose comes from deskPose(),
// which reads the live run, the roster and the blocker queue; nothing here is decided
// by how it looks.

function Person({ pose }: { pose: DeskPose }) {
  if (pose === 'off' || pose === 'away') return null

  const lit = pose === 'type' || pose === 'read' || pose === 'write'
  const stroke = lit ? GS : GD
  const body = <path d="M110,93 q0,-12 10,-12 q10,0 10,12 Z" fill="var(--bg)" stroke={stroke} strokeWidth={1.3} />
  const head = (
    <g>
      <circle cx={120} cy={73.5} r={6.4} fill="var(--bg)" stroke={stroke} strokeWidth={1.3} />
      {/* A hint of a crown, so it reads as the back of a head rather than a ball. */}
      <path d="M114.6,70.5 q5.4,-4 10.8,0" fill="none" stroke={stroke} strokeWidth={1} opacity={0.7} />
    </g>
  )

  return (
    <g>
      {pose === 'idle' && <g className="hm-breathe">{body}{head}</g>}

      {pose === 'wait' && (
        <g className="hm-breathe">
          {body}
          <g className="hm-wait">{head}</g>
          <text x={132} y={66} fill={BL} fontSize={9} fontFamily="var(--font-mono)">?</text>
        </g>
      )}

      {pose === 'type' && (
        <g>
          {body}
          <g className="hm-type">
            <path d="M112,85 q-5,-1 -8,-4" fill="none" stroke={stroke} strokeWidth={1.4} />
            <path d="M128,85 q5,-1 8,-4" fill="none" stroke={stroke} strokeWidth={1.4} />
          </g>
          <g className="hm-nod">{head}</g>
        </g>
      )}

      {pose === 'read' && (
        <g className="hm-breathe">
          {body}
          <path d="M129,86 q7,-3 9,-11" fill="none" stroke={stroke} strokeWidth={1.4} />
          <g className="hm-page">
            <rect x={137} y={62} width={13} height={16} rx={1} fill="var(--bg-elev)" stroke={stroke} strokeWidth={0.8} />
            <g stroke={GD} strokeWidth={0.7}>
              <line x1={140} y1={67} x2={147} y2={67} /><line x1={140} y1={70} x2={147} y2={70} />
              <line x1={140} y1={73} x2={145} y2={73} />
            </g>
          </g>
          {head}
        </g>
      )}

      {pose === 'write' && (
        <g className="hm-breathe">
          {body}
          <path d="M111,86 q-8,-2 -13,-5" fill="none" stroke={stroke} strokeWidth={1.4} />
          <rect x={86} y={74} width={17} height={10} rx={1} fill="var(--bg-elev)" stroke={GD} strokeWidth={0.7} />
          <path d="M89,80 q3.5,-2 7,0 q3.5,2 6,0" fill="none" stroke={G} strokeWidth={0.9} className="hm-pen" />
          {head}
        </g>
      )}
    </g>
  )
}

function Desk({ view, hr, selected, floorIds, onSelect, drag }: {
  view: AgentView; hr?: RosterEntry; selected: boolean; floorIds: string[]; onSelect: () => void
  /** Seating rearrangement. Absent when the floor is not arrangeable. */
  drag?: {
    dragging: boolean
    /** True while this desk is the one a dragged desk would be inserted in front of. */
    dropBefore: boolean
    onDragStart: () => void
    onDragEnd: () => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}) {
  const a = view.agent
  const running = view.status?.state === 'running'
  const errored = view.status?.state === 'error'
  const led = AUTONOMY_COLOR[a.autonomy]
  const inbox = hr?.inbox ?? 0
  const slips = view.decisions.slice(0, 3)
  // A blocking question means this desk is deliberately quiet — waiting, not asleep.
  const blocking = (view.blockers ?? []).find((b) => b.severity === 'blocking') ?? null
  // Who is in the chair, and what are they doing. 'away' means they got up and walked
  // to a colleague's desk — the floor overlay draws them standing there.
  const pose = deskPose(view, { floorIds })

  // Screen: the strongest single signal on the floor.
  const screenFill = running ? 'color-mix(in srgb, var(--amber) 22%, var(--bg))'
    : a.enabled ? 'color-mix(in srgb, var(--green) 10%, var(--bg))'
      : 'var(--bg)'
  const screenGlow = running ? 'var(--amber)' : a.enabled ? G : 'transparent'

  const statusLine = running ? (view.status?.activity || 'running…')
    : view.status ? `last run ${ago(view.status.startedAt)}`
      : 'never run'

  return (
    <div className="hm-desk" data-desk={a.id} onClick={onSelect}
      title={`${a.name} — ${poseHint(pose)} · ${statusLine}${drag ? '\nDrag to move this desk' : ''}`}
      draggable={!!drag}
      onDragStart={drag ? (e) => { e.dataTransfer.effectAllowed = 'move'; drag.onDragStart() } : undefined}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      style={{
        cursor: 'pointer', background: 'var(--bg-panel)', position: 'relative',
        border: selected ? `1px solid ${G}` : a.autonomy === 'auto' ? `0.5px solid ${AM}` : BORDER,
        boxShadow: selected ? 'var(--glow-green)' : 'none',
        padding: '10px 10px 8px', display: 'flex', flexDirection: 'column', gap: 6,
        // While a desk is in flight: the one being carried fades, and the desk it would
        // land in front of grows an insertion edge.
        opacity: drag?.dragging ? 0.35 : 1,
        outline: drag?.dropBefore ? `2px solid ${BL}` : 'none',
        outlineOffset: -1
      }}>

      {/* Partition wall behind the desk — decision slips get pinned here. */}
      <div style={{
        position: 'absolute', inset: '0 0 auto 0', height: 30,
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--green) 4%, transparent), transparent)',
        borderBottom: '0.5px dashed var(--border)', pointerEvents: 'none'
      }} />
      {slips.length > 0 && (
        <div style={{ position: 'absolute', top: 4, right: 8, display: 'flex', gap: 3 }}>
          {slips.map((d, i) => (
            <span key={i} title={`${d.outcome.toUpperCase()} ${d.side.toUpperCase()} ${d.amount} ${d.symbol} · $${d.notionalUsd.toFixed(2)}${d.detail ? `\n${d.detail}` : ''}`}
              style={{
                width: 10, height: 13, display: 'inline-block', transform: `rotate(${(i - 1) * 6}deg)`,
                background: 'var(--bg-elev)',
                borderTop: `2px solid ${d.outcome === 'executed' ? AM : d.outcome === 'staged' ? G : CR}`,
                border: BORDER
              }} />
          ))}
        </div>
      )}

      <svg viewBox="0 0 240 132" style={{ width: '100%', display: 'block' }}>
        {/* Monitor */}
        <rect x={73} y={10} width={94} height={58} rx={3} fill="var(--svg-deep)" stroke="var(--border-strong)" strokeWidth={1} />
        <rect x={78} y={15} width={84} height={48} fill={screenFill}
          style={{ animation: running ? 'deskRunFlicker 1.1s infinite' : a.enabled ? 'deskScreenHum 3.4s infinite' : 'none' }} />
        {screenGlow !== 'transparent' && (
          <rect x={78} y={15} width={84} height={48} fill="none" stroke={screenGlow} strokeWidth={0.75} opacity={0.7} />
        )}
        {/* Screen content: activity bars when live, a prompt cursor when idle, dead when off */}
        {running ? (
          <>
            <rect x={84} y={22} width={54} height={3} fill={AM} opacity={0.8} />
            <rect x={84} y={30} width={70} height={3} fill={AM} opacity={0.5} />
            <rect x={84} y={38} width={40} height={3} fill={AM} opacity={0.65} />
            <rect x={84} y={46} width={62} height={3} fill={AM} opacity={0.4} />
            <rect x={84} y={54} width={26} height={3} fill={AM} opacity={0.75} />
          </>
        ) : a.enabled ? (
          <text x={84} y={30} fill={G} fontSize={11} fontFamily="var(--font-mono)"
            style={{ animation: 'deskLampPulse 1.6s step-end infinite' }}>▌</text>
        ) : (
          <text x={120} y={43} fill={GD} fontSize={8} fontFamily="var(--font-mono)" textAnchor="middle" opacity={0.6}>OFF</text>
        )}
        {/* Stand + base */}
        <rect x={115} y={68} width={10} height={7} fill="var(--svg-deep)" stroke="var(--border-strong)" strokeWidth={0.5} />
        <rect x={103} y={75} width={34} height={3} rx={1.5} fill="var(--svg-deep)" stroke="var(--border-strong)" strokeWidth={0.5} />

        {/* Coffee — steam only while working */}
        <rect x={188} y={68} width={11} height={10} rx={1} fill="var(--svg-panel)" stroke="var(--border-strong)" strokeWidth={0.75} />
        <path d="M199,71 q4,2 0,5" fill="none" stroke="var(--border-strong)" strokeWidth={1} />
        {running && (
          <>
            <path d="M191,64 q2,-3 0,-6" fill="none" stroke={GD} strokeWidth={1} style={{ animation: 'deskSteam 2s infinite' }} />
            <path d="M195,64 q-2,-3 0,-6" fill="none" stroke={GD} strokeWidth={1} style={{ animation: 'deskSteam 2s 0.7s infinite' }} />
          </>
        )}

        {/* Keyboard */}
        <rect x={92} y={81} width={56} height={5} rx={1} fill="var(--svg-panel)" stroke="var(--border-strong)" strokeWidth={0.5} />

        {/* Inbox tray — papers stack per unanswered mention */}
        <rect x={30} y={74} width={30} height={6} fill="none" stroke="var(--border-strong)" strokeWidth={0.75} />
        {Array.from({ length: Math.min(inbox, 4) }).map((_, i) => (
          <rect key={i} x={32 + (i % 2)} y={71 - i * 2.5} width={26} height={2} fill="color-mix(in srgb, var(--blue) 55%, var(--bg-elev))" stroke={BL} strokeWidth={0.3} />
        ))}
        {inbox > 0 && <text x={45} y={64 - Math.min(inbox, 4) * 2.5} fill={BL} fontSize={8} fontFamily="var(--font-mono)" textAnchor="middle">{inbox}</text>}

        {/* The employee. Drawn before the desk so the furniture occludes them at the
            waist — you are standing behind their chair, not looking through the desk. */}
        <Person pose={pose} />

        {/* Desk top + front */}
        <path d="M18,88 L222,88 L232,98 L8,98 Z" fill="var(--svg-panel)" stroke="var(--border-strong)" strokeWidth={0.75} />
        <rect x={8} y={98} width={224} height={24} fill="var(--svg-deep)" stroke="var(--border-strong)" strokeWidth={0.75} />
        {/* Drawers */}
        <rect x={168} y={102} width={56} height={7} fill="none" stroke="var(--border)" strokeWidth={0.75} />
        <rect x={168} y={112} width={56} height={7} fill="none" stroke="var(--border)" strokeWidth={0.75} />
        {/* Autonomy LED strip along the desk edge */}
        <rect x={8} y={96} width={224} height={2} fill={led}
          opacity={a.enabled ? 0.9 : 0.35}
          style={a.autonomy === 'auto' && a.enabled ? { animation: 'deskLampPulse 2.2s infinite' } : undefined} />

        {/* Status lamp on the desk corner */}
        <circle cx={22} cy={84} r={3} fill={running ? AM : errored ? CR : a.enabled ? led : 'var(--border)'}
          style={{ filter: running || a.enabled ? `drop-shadow(0 0 3px ${running ? AM : led})` : 'none', animation: running ? 'deskLampPulse 0.9s infinite' : 'none' } as React.CSSProperties} />

        {/* Chair — pulled in while somebody is sitting in it, pushed back when the desk
            is empty: off duty, or away asking a colleague something. */}
        <g transform={pose === 'off' || pose === 'away' ? 'translate(-26,6)' : 'translate(0,0)'}
          opacity={pose === 'off' ? 0.45 : 0.9}>
          <path d="M108,128 q12,-7 24,0" fill="none" stroke={GD} strokeWidth={2} />
          <rect x={112} y={112} width={16} height={4} rx={2} fill="var(--svg-panel)" stroke={GD} strokeWidth={0.75} />
          <line x1={120} y1={116} x2={120} y2={126} stroke={GD} strokeWidth={1.5} />
        </g>

        {/* Nameplate — parked left of centre so the employee's head never covers it. */}
        <rect x={14} y={101} width={92} height={13} fill="var(--bg-elev)" stroke="var(--border-strong)" strokeWidth={0.5} />
        <text x={60} y={110.5} fill={GS} fontSize={9} fontFamily="var(--font-mono)" textAnchor="middle" letterSpacing={1}>
          {a.name.toUpperCase().slice(0, 16)}
        </text>

        {/* An empty chair with a reason: they are at somebody else's desk. */}
        {pose === 'away' && (
          <>
            <rect x={112} y={101} width={50} height={13} fill="var(--bg)" stroke={BL} strokeWidth={0.6} />
            <text x={137} y={110.5} fill={BL} fontSize={8} fontFamily="var(--font-mono)" textAnchor="middle" letterSpacing={1}>
              ⊘ AWAY
            </text>
          </>
        )}
      </svg>

      {/* Placard line under the vignette */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{ ...MONO, fontSize: 10, letterSpacing: 1, color: led, flexShrink: 0 }}>
          {AGENT_AUTONOMY_LABELS[a.autonomy]}{a.autonomy === 'auto' ? ` ≤$${a.maxUsd}` : ''}
        </span>
        {hr && <span style={{ ...MONO, fontSize: 10, color: GD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hr.personnel.title}</span>}
        <div style={{ flex: 1 }} />
        <span style={{ ...MONO, fontSize: 10, color: running ? AM : errored ? CR : blocking ? BL : GD, flexShrink: 0 }}>
          {running ? '◈ LIVE'
            : errored ? '✗ ERROR'
              : blocking ? '⊘ WAITING'
                : a.enabled ? (view.nextRunAt && a.intervalMinutes > 0 ? `next ${until(view.nextRunAt)}` : 'on call') : 'off duty'}
        </span>
      </div>
      {running && (
        <div style={{ ...MONO, fontSize: 10, color: AM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {view.status?.activity || 'running…'}
        </div>
      )}
      {!running && blocking && (
        <div title={blocking.question} style={{ ...MONO, fontSize: 10, color: BL, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          waiting on @{blocking.askedOf} — triggers held
        </div>
      )}
    </div>
  )
}

// ── Department pods ────────────────────────────────────────────────────────
//
// The floor is laid out the way the company is: one cluster of desks per department,
// executive first. Dragging a desk moves where it *sits*, not what it is on the books
// for — personnel.department stays the record, this is furniture.

const DESK_GRID: React.CSSProperties = {
  display: 'grid', gap: 14,
  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', alignItems: 'start'
}

function Pod({ department, count, active, onDragOver, onDrop, children }: {
  department: Department; count: number; active: boolean
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  children: React.ReactNode
}) {
  return (
    <div onDragOver={onDragOver} onDrop={onDrop}
      style={{
        border: active ? `0.5px dashed ${BL}` : '0.5px solid transparent',
        background: active ? 'color-mix(in srgb, var(--blue) 4%, transparent)' : 'transparent',
        padding: 6, display: 'flex', flexDirection: 'column', gap: 8
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lbl c={active ? BL : GD}>{departmentLabel(department)}</Lbl>
        <div style={{ flex: 1, height: 0, borderTop: `0.5px solid ${active ? BL : 'var(--border)'}` }} />
        <Lbl c={GD}>{count === 0 ? 'empty' : `${count} desk${count === 1 ? '' : 's'}`}</Lbl>
      </div>
      {count === 0
        ? <div style={{ ...MONO, fontSize: 10, color: GD, padding: '10px 2px', opacity: 0.7 }}>
            drop a desk here to seat it in {departmentLabel(department).toLowerCase()}
          </div>
        : <div style={DESK_GRID}>{children}</div>}
    </div>
  )
}

// ── The floor overlay ──────────────────────────────────────────────────────
//
// Conversations and walkers cross desk boundaries, so they cannot live inside a desk
// tile. This is one SVG stretched over the whole grid: it measures where each desk
// landed and draws the people who are between desks — the ones talking to each other
// and the ones standing at somebody else's desk waiting for an answer.
//
// It is pointer-transparent throughout. Nothing here can intercept a click meant for
// a desk underneath it.

/** Seconds per speech-bubble cycle. Must match the hmBubble animation duration: the
 *  stagger between bubbles is derived from it. */
const BUBBLE_CYCLE_S = 12

/** A standing figure, feet at the origin. The mirrored variant faces the other way. */
function Stander({ color, facing }: { color: string; facing: 1 | -1 }) {
  return (
    <g transform={facing === -1 ? 'scale(-1,1)' : undefined}>
      <circle cx={0} cy={-25} r={4.6} fill="var(--bg)" stroke={color} strokeWidth={1.3} />
      <line x1={0} y1={-20.4} x2={0} y2={-9} stroke={color} strokeWidth={1.6} />
      <line x1={0} y1={-9} x2={-2.6} y2={0} stroke={color} strokeWidth={1.5} />
      <line x1={0} y1={-9} x2={2.6} y2={0} stroke={color} strokeWidth={1.5} />
      <line x1={0} y1={-17} x2={-4} y2={-12.5} stroke={color} strokeWidth={1.3} />
      {/* Front arm raised a little, as if mid-question. */}
      <path d="M0,-17 q5,1 4,-5" fill="none" stroke={color} strokeWidth={1.3} />
    </g>
  )
}

function SpeechBubble({ at, text, color, delay, tailLeft, lift }: {
  at: Pt; text: string; color: string; delay: number; tailLeft: boolean; lift: number
}) {
  const w = Math.max(34, text.length * 4.7 + 12)
  const x = tailLeft ? at.x - 10 : at.x - w + 10
  const y = at.y - lift
  return (
    <g className="hm-bubble" style={{ animationDelay: `${delay}s` }}>
      <rect x={x} y={y} width={w} height={15} rx={2} fill="var(--bg)" stroke={color} strokeWidth={0.8} />
      <rect x={x} y={y} width={w} height={15} rx={2} fill={color} opacity={0.07} />
      <path d={tailLeft ? `M${x + 8},${y + 15} l4,6 l2,-6 Z` : `M${x + w - 8},${y + 15} l-4,6 l-2,-6 Z`}
        fill="var(--bg)" stroke={color} strokeWidth={0.8} />
      <text x={x + 6} y={y + 10.5} fill={color} fontSize={8} fontFamily="var(--font-mono)" letterSpacing={0.4}>
        {text}
      </text>
    </g>
  )
}

interface FloorLayout {
  w: number; h: number
  /** Chair level, where people stand. */
  anchors: Record<string, Pt>
  /** Top edge of the tile, where speech leaves from. */
  heads: Record<string, Pt>
}

function FloorOverlay({ gridRef, conversations, walkers, nameOf, revision }: {
  gridRef: React.RefObject<HTMLDivElement | null>
  conversations: FloorConversation[]
  walkers: FloorWalker[]
  nameOf: (id: string) => string
  /** Changes whenever the desks or their seating change, forcing a re-measure. Desks
   *  moving between pods can leave every element the same size, so a ResizeObserver
   *  alone would never notice they had moved. */
  revision: string
}) {
  const [layout, setLayout] = useState<FloorLayout>({ w: 0, h: 0, anchors: {}, heads: {} })
  // Last measurement, serialized. A ResizeObserver can fire for reasons that move
  // nothing; re-rendering on those would be pure churn, so we compare before setting.
  const lastMeasure = useRef('')

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      const box = grid.getBoundingClientRect()
      const anchors: Record<string, Pt> = {}
      const heads: Record<string, Pt> = {}
      const desks = grid.querySelectorAll<HTMLElement>('[data-desk]')
      desks.forEach((el) => {
        const id = el.dataset.desk
        if (!id) return
        const r = el.getBoundingClientRect()
        anchors[id] = deskAnchor(r, box)
        heads[id] = deskTopAnchor(r, box)
      })
      const next: FloorLayout = { w: box.width, h: box.height, anchors, heads }
      const key = JSON.stringify(next)
      if (key === lastMeasure.current) return
      lastMeasure.current = key
      setLayout(next)
    }
    measure()
    // The grid reflows on window resize, on the inspector opening, and whenever a desk
    // is hired or fired. Watching each desk as well catches a tile growing on its own —
    // a run going live adds an activity line and shifts everything below it.
    const ro = new ResizeObserver(measure)
    ro.observe(grid)
    grid.querySelectorAll<HTMLElement>('[data-desk]').forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [gridRef, revision])

  const { w, h, anchors, heads } = layout
  if (!w || !h) return null

  // Speech leaves from the top of the tile so it never lands on the desk's own status
  // line; walkers stand at chair level.
  const drawnConversations = conversations
    .map((c) => ({ c, from: heads[c.fromId], to: heads[c.toId] }))
    .filter((x): x is { c: FloorConversation; from: Pt; to: Pt } => !!x.from && !!x.to)

  const drawnWalkers = walkers
    .map((w) => ({ w, home: anchors[w.fromId], desk: anchors[w.toId] }))
    .filter((x): x is { w: FloorWalker; home: Pt; desk: Pt } => !!x.home && !!x.desk)

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', overflow: 'visible'
      }}
      aria-hidden="true"
    >
      {/* Who is talking to whom, and roughly what about. */}
      {drawnConversations.map(({ c, from, to }, i) => {
        const color = c.kind === 'answer' ? G : BL
        return (
          <g key={c.id}>
            <path d={arcPath(from, to, 30)} fill="none" stroke={color} strokeWidth={1}
              opacity={0.5} className="hm-flow" />
            {/* Staggered by a full slot each, so two desks never talk over each other. */}
            <SpeechBubble at={from} text={c.text} color={color} lift={10}
              delay={i * (BUBBLE_CYCLE_S / MAX_FLOOR_CONVERSATIONS)} tailLeft={from.x <= to.x} />
          </g>
        )
      })}

      {/* Who left their desk to go and ask somebody something. */}
      {drawnWalkers.map(({ w, home, desk }) => {
        const stop = walkerStop(desk, w.queueIndex)
        const facing: 1 | -1 = stop.x <= desk.x ? 1 : -1
        return (
          <g key={w.blockerId}>
            {/* The route they took, so the empty chair and the standing figure connect. */}
            <path d={arcPath(home, stop, 10)} fill="none" stroke={BL} strokeWidth={0.75}
              strokeDasharray="2 5" opacity={0.35} />
            {/* Placement and animation must live on separate elements: a CSS animated
                transform replaces the transform attribute outright, which would drop
                every walker onto the origin. */}
            <g transform={`translate(${stop.x},${stop.y})`}>
              <g className="hm-petitioner">
                <Stander color={BL} facing={facing} />
              </g>
            </g>
            {w.queueIndex === 0 && (
              <SpeechBubble at={stop} text={`@${nameOf(w.toId).toLowerCase()} ${w.question}`.slice(0, 44)}
                color={BL} delay={0.4} lift={34} tailLeft />
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** The empty desk by the door. Clicking it starts the hiring paperwork. */
function VacantDesk({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <div className="hm-desk" onClick={onSelect} title="Hire a new employee"
      style={{
        cursor: 'pointer', background: 'transparent', position: 'relative',
        border: selected ? `1px solid ${G}` : '0.5px dashed var(--border-strong)',
        padding: '10px 10px 8px', display: 'flex', flexDirection: 'column', gap: 6, opacity: selected ? 1 : 0.7
      }}>
      <svg viewBox="0 0 240 132" style={{ width: '100%', display: 'block' }}>
        <rect x={73} y={10} width={94} height={58} rx={3} fill="var(--bg)" stroke="var(--border)" strokeWidth={1} strokeDasharray="4 3" />
        <text x={120} y={43} fill={GD} fontSize={22} fontFamily="var(--font-mono)" textAnchor="middle">+</text>
        <path d="M18,88 L222,88 L232,98 L8,98 Z" fill="none" stroke="var(--border)" strokeWidth={0.75} strokeDasharray="4 3" />
        <rect x={8} y={98} width={224} height={24} fill="none" stroke="var(--border)" strokeWidth={0.75} strokeDasharray="4 3" />
        <rect x={60} y={101} width={100} height={13} fill="none" stroke="var(--border)" strokeWidth={0.5} />
        <text x={110} y={110.5} fill={GD} fontSize={9} fontFamily="var(--font-mono)" textAnchor="middle" letterSpacing={1}>VACANT</text>
      </svg>
      <div style={{ ...MONO, fontSize: 10, letterSpacing: 1, color: GD, textAlign: 'center' }}>+ HIRE</div>
    </div>
  )
}

// ── Desk inspector ─────────────────────────────────────────────────────────
//
// Sitting down at someone's desk: controls at the top, then their work.

function DeskInspector({ view, hr, onChanged, onOpenCubicle, onClose }: {
  view: AgentView; hr?: RosterEntry; onChanged: () => void; onOpenCubicle: () => void; onClose: () => void
}) {
  const a = view.agent
  const [tab, setTab] = useState<'chat' | 'settings' | 'log'>('chat')
  const [busy, setBusy] = useState(false)
  const running = view.status?.state === 'running'

  const save = async (patch: Partial<NewAgentInput>) => {
    setBusy(true)
    const r = await updateAgent(a.id, patch)
    setBusy(false)
    // The server rejects a model id it does not recognise. Without this the setting would
    // appear to revert on the next poll with no explanation.
    if (!r.ok) alert(`Save failed: ${r.error ?? 'unknown error'}`)
    onChanged()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, minHeight: 0, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: BORDER, paddingBottom: 7 }}>
        <span style={{ ...MONO, fontSize: 15, letterSpacing: 1, color: GS, fontWeight: 700 }}>{a.name.toUpperCase()}</span>
        {hr && <Lbl>{hr.personnel.title}</Lbl>}
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Step away from this desk"
          style={{ ...MONO, fontSize: 13, background: 'transparent', border: 'none', color: GD, cursor: 'pointer' }}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Lbl>
          {running ? (view.status?.activity || 'running…')
            : view.status ? `last run ${ago(view.status.startedAt)} · ${view.decisions.length} decision${view.decisions.length === 1 ? '' : 's'} logged`
              : 'never run'}
        </Lbl>
        {view.totals && totalTokens(view.totals) > 0 && (
          <span title={`${fmtTokens(view.totals.inputTokens + view.totals.cacheReadTokens + view.totals.cacheCreationTokens)} in · ${fmtTokens(view.totals.outputTokens)} out\nacross ${view.totals.runs} run${view.totals.runs === 1 ? '' : 's'} and ${view.totals.chatTurns} chat turn${view.totals.chatTurns === 1 ? '' : 's'} since ${new Date(view.totals.since).toISOString().slice(0, 10)}${view.totals.compactions ? `\ncompacted ${view.totals.compactions}× in total` : ''}`}>
            <Lbl>{fmtTokens(totalTokens(view.totals))} tok lifetime</Lbl>
          </span>
        )}
      </div>

      {/* Controls: the dial, the switch, the buttons. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: BORDER }}>
          {AUTONOMY.map((lvl) => (
            <button key={lvl} onClick={() => void save({ autonomy: lvl })} disabled={busy} title={AUTONOMY_HELP[lvl]}
              style={{
                ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 8px', cursor: 'pointer', border: 'none',
                background: a.autonomy === lvl ? `color-mix(in srgb, ${AUTONOMY_COLOR[lvl]} 18%, transparent)` : 'transparent',
                color: a.autonomy === lvl ? AUTONOMY_COLOR[lvl] : GD,
                fontWeight: a.autonomy === lvl ? 700 : 400
              }}>
              {AGENT_AUTONOMY_LABELS[lvl]}{lvl === 'auto' && a.autonomy === 'auto' ? ` ≤$${a.maxUsd}` : ''}
            </button>
          ))}
        </div>

        {/* Enable switch — gates the automatic triggers only. */}
        <button onClick={() => void save({ enabled: !a.enabled })} disabled={busy}
          title={a.enabled
            ? 'Enabled — interval and event triggers can wake this agent'
            : 'Disabled — the agent only runs when you press RUN'}
          style={{
            ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 9px', cursor: 'pointer',
            background: a.enabled ? 'color-mix(in srgb, var(--green) 14%, transparent)' : 'transparent',
            border: `0.5px solid ${a.enabled ? G : 'var(--border)'}`, color: a.enabled ? G : GD
          }}>
          {a.enabled ? '◉ ENABLED' : '○ DISABLED'}
        </button>

        <Btn color={running ? AM : G} disabled={running || busy}
          title={running ? 'This agent is running' : 'Run once now'}
          onClick={async () => {
            setBusy(true)
            const r = await runAgent(a.id)
            setBusy(false)
            if (!r.ok) alert(`Run failed: ${r.error ?? 'unknown error'}`)
            onChanged()
          }}>{running ? '◈ LIVE' : '▶ RUN'}</Btn>

        <Btn onClick={onOpenCubicle} title="Open this employee's cubicle — personnel file, journal, mind, inbox">CUBICLE</Btn>
      </div>

      {/* Trigger summary strip */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Lbl>{a.autonomy === 'auto' ? `cap $${a.maxUsd}/trade` : a.autonomy === 'propose' ? 'confirm-first' : 'no trading authority'}</Lbl>
        {a.intervalMinutes > 0 && <Lbl c={a.enabled ? G : GD}>every {a.intervalMinutes}m{view.nextRunAt && a.enabled ? ` · next ${until(view.nextRunAt)}` : ''}</Lbl>}
        {a.events.length > 0 && <Lbl c={a.enabled ? G : GD}>on {a.events.map((e) => eventLabel(e).toLowerCase()).join(', ')}</Lbl>}
        {a.intervalMinutes === 0 && a.events.length === 0 && <Lbl>manual only</Lbl>}
        <span title={a.model ? `Pinned to ${a.model}` : 'Follows the server default model'}>
          <Lbl c={a.model ? GS : GD}>{a.model ? agentModelLabel(a.model).toLowerCase() : 'default model'}</Lbl>
        </span>
        {running && view.status?.usage && contextFill(view.status.usage) !== null && (
          <Lbl c={fillColor(contextFill(view.status.usage)!)}>
            run ctx {Math.round(contextFill(view.status.usage)! * 100)}%
          </Lbl>
        )}
      </div>

      {view.status?.state === 'error' && <Lbl c={CR}>✗ {view.status.error}</Lbl>}
      {/* The circuit breaker. A run that keeps dying at the deadline used to look like a
          single failed run each time, so a 14-hour outage was invisible on this card. */}
      {view.health.consecutiveTimeouts > 0 && (
        <Lbl c={view.health.tripped ? CR : AM}>
          {view.health.tripped ? '⚠ BREAKER TRIPPED' : '⏳ backing off'} — {view.health.consecutiveTimeouts} timeout
          {view.health.consecutiveTimeouts === 1 ? '' : 's'} in a row
          {view.health.suppressed && view.health.suppressedUntil
            ? `, auto wakes held ${Math.max(0, Math.round((view.health.suppressedUntil - Date.now()) / 60_000))}m`
            : ''}
          {view.health.tripped ? ' · this agent is not covering its mandate — press RUN to test it' : ''}
        </Lbl>
      )}
      {view.decisions.length > 0 && <DecisionRows decisions={view.decisions.slice(0, 4)} />}

      <div style={{ display: 'flex', gap: 4, borderTop: BORDER, paddingTop: 10 }}>
        {(['chat', 'settings', 'log'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 9px', cursor: 'pointer',
            background: tab === t ? 'var(--bg-elev)' : 'transparent',
            border: `0.5px solid ${tab === t ? G : 'var(--border)'}`, color: tab === t ? G : GD
          }}>{t.toUpperCase()}</button>
        ))}
        <div style={{ flex: 1 }} />
        <Btn color={CR} onClick={async () => {
          if (!confirm(`Delete agent "${a.name}"? Its run log and transcript go with it.`)) return
          await deleteAgent(a.id)
          onClose()
          onChanged()
        }}>DELETE</Btn>
      </div>

      {tab === 'chat' && <AgentChat view={view} onChanged={onChanged} />}
      {tab === 'settings' && <AgentSettings view={view} onSave={save} />}
      {tab === 'log' && <RunLog runs={view.recentRuns} />}
    </div>
  )
}

// ── New agent form ─────────────────────────────────────────────────────────

function NewAgentForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [mandate, setMandate] = useState('')
  const [autonomy, setAutonomy] = useState<AgentAutonomy>('advisory')
  const [model, setModel] = useState('')
  const [maxUsd, setMaxUsd] = useState('20')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: BORDER, paddingBottom: 7 }}>
        <Lbl c={GS} size={13}>HIRING PAPERWORK</Lbl>
        <div style={{ flex: 1 }} />
        <button onClick={onCancel} style={{ ...MONO, fontSize: 13, background: 'transparent', border: 'none', color: GD, cursor: 'pointer' }}>✕</button>
      </div>
      <Lbl>A hire opens a personnel file, a cubicle, a journal and a mind. Everyone starts on PROBATION at ADVISORY; promote them once you have read their work.</Lbl>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Lbl>NAME</Lbl>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Risk Officer"
          style={{ ...MONO, fontSize: 13, padding: '6px 8px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Lbl>MANDATE — what this agent is for, in your words</Lbl>
        <textarea value={mandate} onChange={(e) => setMandate(e.target.value)} rows={6}
          placeholder={'e.g. Watch open alt positions. If one breaks structure on the 1hr AND momentum is still falling, propose an exit resting at the next bounce. Hold anything falling with BTC. Never touch BTC.'}
          style={{ ...MONO, fontSize: 13, lineHeight: 1.5, padding: 8, background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none', resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Lbl>MODEL</Lbl>
        <ModelPicker value={model} onChange={setModel} />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>AUTONOMY</Lbl>
          <div style={{ display: 'flex', border: BORDER }}>
            {AUTONOMY.map((lvl) => (
              <button key={lvl} onClick={() => setAutonomy(lvl)} title={AUTONOMY_HELP[lvl]} style={{
                ...MONO, fontSize: 10, letterSpacing: 1, padding: '4px 9px', cursor: 'pointer', border: 'none',
                background: autonomy === lvl ? `color-mix(in srgb, ${AUTONOMY_COLOR[lvl]} 18%, transparent)` : 'transparent',
                color: autonomy === lvl ? AUTONOMY_COLOR[lvl] : GD
              }}>{AGENT_AUTONOMY_LABELS[lvl]}</button>
            ))}
          </div>
        </div>
        {autonomy === 'auto' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Lbl c={AM}>PER-TRADE CAP ($)</Lbl>
            <input value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} style={{ ...MONO, fontSize: 13, width: 90, padding: '5px 7px', background: 'var(--bg-elev)', border: `0.5px solid ${AM}`, color: GS, outline: 'none' }} />
          </label>
        )}
      </div>
      {autonomy === 'auto' && (
        <Lbl c={AM}>⚠ AUTO spends real money without asking. Trades over the cap fall back to the confirm queue.</Lbl>
      )}
      {err && <Lbl c={CR}>{err}</Lbl>}
      <div style={{ display: 'flex', gap: 6 }}>
        <Btn color={G} disabled={busy || !name.trim() || !mandate.trim()} onClick={async () => {
          setBusy(true); setErr(null)
          const r = await createAgent({
            name, mandate, autonomy, model,
            maxUsd: isNaN(Number(maxUsd)) ? 20 : Number(maxUsd)
          })
          setBusy(false)
          if (!r.ok) { setErr(r.error ?? 'create failed'); return }
          onCreated()
        }}>HIRE</Btn>
        <Btn onClick={onCancel}>CANCEL</Btn>
      </div>
    </div>
  )
}

// ── Wall fixtures ──────────────────────────────────────────────────────────

/** The message board on the back wall. A poster, not a tab — click it to walk over. */
// The corkboard by the door: every open thread is a real pinned slip, tilted a little,
// coloured by how long it has gone untouched. Clicking one walks you to that thread.
const SLIP_COLOR: Record<BoardSlip['tone'], string> = { fresh: BL, open: G, stale: GD }

function WallBoard({ unanswered, slips, onClick, onOpenThread }: {
  unanswered: number; slips: BoardSlip[]
  onClick: () => void; onOpenThread: (threadId: string) => void
}) {
  return (
    <div onClick={onClick} title="Walk over to the message board"
      style={{
        cursor: 'pointer', border: `0.5px solid ${unanswered > 0 ? BL : 'var(--border-strong)'}`,
        background: 'var(--bg-elev)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8
      }}>
      <span style={{ display: 'inline-flex', gap: 3, alignItems: 'flex-start' }}>
        {slips.length === 0
          ? [0, 1, 2].map((i) => (
            <span key={i} style={{ width: 7, height: 9, background: 'var(--bg-panel)', borderTop: `1.5px solid ${GD}`, border: BORDER }} />
          ))
          : slips.map((s, i) => (
            <span key={s.threadId}
              onClick={(e) => { e.stopPropagation(); onOpenThread(s.threadId) }}
              title={`${s.title} — @${s.authorId}${s.replies > 0 ? ` · ${s.replies} repl${s.replies === 1 ? 'y' : 'ies'}` : ''}`}
              style={{
                width: 8, height: 11, background: 'var(--bg-panel)', display: 'inline-block',
                borderTop: `2px solid ${SLIP_COLOR[s.tone]}`, border: BORDER,
                transform: `rotate(${((i % 3) - 1) * 5}deg)`, cursor: 'pointer'
              }} />
          ))}
      </span>
      <Lbl c={unanswered > 0 ? BL : GD}>MESSAGE BOARD{unanswered > 0 ? ` · ${unanswered} unanswered` : ''}</Lbl>
    </div>
  )
}

// ── Section ────────────────────────────────────────────────────────────────

export function IntelligenceSection() {
  const [agents, setAgents] = useState<AgentView[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      setAgents(await fetchAgents())
      setLoaded(true)
    } catch { /* keep last good state */ }
  }, [])

  useEffect(() => {
    void load()
    // Runs stream their activity line through the fleet payload, so poll while the tab
    // is mounted — same cadence as the TRADES tab's order polling.
    const t = setInterval(() => void load(), 8000)
    return () => clearInterval(t)
  }, [load])

  const [roster, reloadRoster] = useRoster()
  // The rail badge needs the count even when the BLOCKERS room is not open.
  const [blockers, setBlockers] = useState<Blocker[]>([])
  useEffect(() => {
    const pull = () => void fetchBlockers().then(setBlockers).catch(() => {})
    pull()
    const t = setInterval(pull, 10_000)
    return () => clearInterval(t)
  }, [])
  // The board is furniture on the floor now — the corkboard pins real open threads, and
  // fresh @mentions become the speech lines between desks.
  const [threads, setThreads] = useState<BoardThread[]>([])
  useEffect(() => {
    const pull = () => void fetchBoard().then(setThreads).catch(() => {})
    pull()
    const t = setInterval(pull, 10_000)
    return () => clearInterval(t)
  }, [])
  // Mentions no longer wake the colleague they name — they land on the Manager's File, and
  // this is the count still waiting for somebody to decide what to do with them.
  const [fileTriage, setFileTriage] = useState(0)
  useEffect(() => {
    const pull = () => void fetchManagerFile().then((f) => setFileTriage(f.stats.needsTriage)).catch(() => {})
    pull()
    const t = setInterval(pull, 10_000)
    return () => clearInterval(t)
  }, [])
  const [view, setView] = useState<'floor' | 'board' | 'file' | 'blockers' | 'directory' | 'timeline' | 'running'>('floor')
  const [cubicleId, setCubicleId] = useState<string | null>(null)
  const [focusThread, setFocusThread] = useState<string | null>(null)
  // The selected desk ('new' = the vacant one). The inspector is the right-hand pane.
  const [deskId, setDeskId] = useState<string | 'new' | null>(null)

  const live = agents.filter((a) => a.status?.state === 'running').length
  // Every Claude session, not just fleet runs — so the RUNNING badge also catches
  // strategy skills, chat turns, and the proactive monitor, which FLOOR never sees.
  const [liveClaude, setLiveClaude] = useState(0)
  useEffect(() => {
    const poll = () => void fetchRunningClaude().then((p) => setLiveClaude(p.length)).catch(() => {})
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [])
  const armed = agents.filter((a) => a.agent.enabled).length
  const autonomous = agents.filter((a) => a.agent.autonomy === 'auto')
  const totalInbox = roster.reduce((n, r) => n + r.inbox, 0)

  // Who is on the floor decides everything the overlay may draw: we only ever draw a
  // line, or walk somebody, between two desks that are actually rendered.
  const floorIds = agents.map((a) => a.agent.id)
  const gridRef = useRef<HTMLDivElement>(null)
  const conversations = floorConversations(threads, { floorIds })
  const walkers = floorWalkers(blockers, { floorIds })
  const slips = corkboardSlips(threads, { limit: 5 })
  const nameOf = useCallback(
    (id: string) => agents.find((a) => a.agent.id === id)?.agent.name ?? id,
    [agents])

  // Seating. Grouped by department out of the box; the operator can drag any desk to a
  // different pod or a different seat, and that arrangement is remembered locally.
  const [deskLayout, setDeskLayout] = useState<DeskLayout>(() => loadDeskLayout())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ department: Department; beforeId: string | null } | null>(null)
  const arranged = deskLayout.order.length > 0 || Object.keys(deskLayout.pod).length > 0

  const applyLayout = useCallback((next: DeskLayout) => {
    setDeskLayout(next)
    saveDeskLayout(next)
  }, [])

  const dropDesk = useCallback((department: Department, beforeId: string | null) => {
    setDropAt(null)
    setDragId(null)
    if (!dragId) return
    applyLayout(moveDesk(deskLayout, { id: dragId, department, beforeId, allIds: floorIds }))
  }, [applyLayout, deskLayout, dragId, floorIds])

  const seatingKey = `${floorIds.join(',')}|${JSON.stringify(deskLayout)}`
  const agentById = new Map(agents.map((v) => [v.agent.id, v]))
  const pods = groupDesks(
    agents.map((v) => {
      const dept = roster.find((r) => r.id === v.agent.id)?.personnel.department
      return dept ? { id: v.agent.id, department: dept } : { id: v.agent.id }
    }),
    deskLayout)
  const openBlockers = blockers.filter((b) => b.status === 'open').length
  const blockedOnMe = blockers.filter((b) => b.status === 'open' && b.askedOf === 'operator').length
  // What the fleet has consumed of the subscription since each agent's first session.
  const fleetTokens = agents.reduce((n, a) => n + (a.totals ? totalTokens(a.totals) : 0), 0)
  const fleetCompactions = agents.reduce((n, a) => n + (a.totals?.compactions ?? 0), 0)
  const openCubicle = (id: string) => { setCubicleId(id); reloadRoster() }

  const seated = deskId && deskId !== 'new' ? agents.find((a) => a.agent.id === deskId) ?? null : null

  const who = cubicleId ? agents.find((a) => a.agent.id === cubicleId) : null

  // The sub-nav rail: rooms in the office. Sits on the left edge so it reads as an
  // extension of the CRYPTO nav rail beside it.
  const TABS = [
    { key: 'floor' as const, icon: '◧', label: 'FLOOR', badge: live > 0 ? String(live) : '', badgeColor: AM, badgeTitle: `${live} agent${live === 1 ? '' : 's'} running right now` },
    { key: 'board' as const, icon: '▤', label: 'BOARD', badge: totalInbox > 0 ? String(totalInbox) : '', badgeColor: BL, badgeTitle: `${totalInbox} unanswered mention${totalInbox === 1 ? '' : 's'}` },
    { key: 'file' as const, icon: '🗄', label: "MGR FILE", badge: fileTriage > 0 ? String(fileTriage) : '', badgeColor: BL, badgeTitle: `${fileTriage} question${fileTriage === 1 ? '' : 's'} waiting on triage` },
    { key: 'blockers' as const, icon: '⊘', label: 'BLOCKERS', badge: openBlockers > 0 ? String(openBlockers) : '', badgeColor: blockedOnMe > 0 ? AM : BL, badgeTitle: blockedOnMe > 0 ? `${blockedOnMe} waiting on you` : `${openBlockers} open` },
    { key: 'directory' as const, icon: '◫', label: 'DIRECTORY', badge: roster.length ? String(roster.length) : '', badgeColor: GD, badgeTitle: `${roster.length} on the books` },
    { key: 'timeline' as const, icon: '≋', label: 'TIMELINE', badge: '', badgeColor: GD, badgeTitle: '' },
    { key: 'running' as const, icon: '◈', label: 'RUNNING', badge: liveClaude > 0 ? String(liveClaude) : '', badgeColor: AM, badgeTitle: `${liveClaude} live Claude session${liveClaude === 1 ? '' : 's'}` }
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '128px 1fr', height: '100%', overflow: 'hidden' }}>
      <style>{FLOOR_CSS}</style>

      {/* ── Sub-nav rail (vertical, left — continues the CRYPTO rail) ── */}
      <div style={{ borderRight: BORDER, background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', padding: '10px 6px', gap: 2, overflow: 'hidden' }}>
        <div style={{ padding: '0 8px 8px', borderBottom: BORDER, marginBottom: 6 }}>
          <Lbl c={G} size={12}>INTELLIGENCE</Lbl>
        </div>
        {TABS.map((t) => {
          const on = view === t.key && !cubicleId
          return (
            <button key={t.key} onClick={() => { setCubicleId(null); setView(t.key) }} style={{
              ...MONO, fontSize: 12, letterSpacing: 1, padding: '7px 8px', textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 7,
              background: on ? 'var(--bg-elev)' : 'transparent',
              border: 'none', boxShadow: on ? `inset 2px 0 0 ${G}` : 'none',
              color: on ? GS : GD, cursor: 'pointer'
            }}>
              <span style={{ fontSize: 11, opacity: 0.8 }}>{t.icon}</span>
              {t.label}
              {t.badge && (
                <span title={t.badgeTitle} style={{
                  marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: t.badgeColor,
                  border: `0.5px solid ${t.badgeColor}`, padding: '0 5px', borderRadius: 8
                }}>{t.badge}</span>
              )}
            </button>
          )
        })}
        {/* Inside a cubicle, the rail shows where you are. */}
        {cubicleId && (
          <div style={{
            ...MONO, fontSize: 11, letterSpacing: 1, padding: '7px 8px', color: GS,
            background: 'var(--bg-elev)', boxShadow: `inset 2px 0 0 ${G}`,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            ▸ {(who?.agent.name ?? cubicleId).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {/* Fleet vitals live at the foot of the rail, out of the content's way. */}
        <div style={{ borderTop: BORDER, paddingTop: 7, display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 8px 0' }}>
          <Lbl size={10}>{agents.length} employee{agents.length === 1 ? '' : 's'}</Lbl>
          <Lbl size={10} c={armed > 0 ? G : GD}>{armed} enabled</Lbl>
          {live > 0 && <Lbl size={10} c={AM}>◈ {live} running</Lbl>}
          {fleetTokens > 0 && <Lbl size={10}>{fmtTokens(fleetTokens)} tok</Lbl>}
          {fleetCompactions > 0 && (
            <span title="A compaction means a session outgrew its context window and was summarized — the agent kept working, but lost detail.">
              <Lbl size={10} c={AM}>{fleetCompactions} compaction{fleetCompactions === 1 ? '' : 's'}</Lbl>
            </span>
          )}
        </div>
      </div>

      {/* ── Content column ── */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      {cubicleId ? (
        <Cubicle
          agentId={cubicleId}
          agentName={who?.agent.name ?? cubicleId}
          roster={roster}
          onClose={() => { setCubicleId(null); reloadRoster() }}
          onOpenThread={(threadId) => { setCubicleId(null); setFocusThread(threadId); setView('board') }}
        />
      ) : (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {view === 'board' && (
        <Board roster={roster} focusThreadId={focusThread} onFocusHandled={() => setFocusThread(null)} />
      )}
      {view === 'file' && <ManagerFileRoom roster={roster} />}
      {view === 'blockers' && <Blockers roster={roster} />}
      {view === 'directory' && <Directory roster={roster} onOpen={openCubicle} />}
      {view === 'timeline' && <AgentTimeline />}
      {view === 'running' && <ClaudeRunning />}
      {view === 'floor' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

          {/* The floor itself */}
          <div style={{
            flex: 1, minWidth: 0, overflowY: 'auto', padding: 12,
            display: 'flex', flexDirection: 'column', gap: 12,
            // Floor tiles: a faint grid so the desks stand on something.
            backgroundImage:
              'linear-gradient(var(--scanline) 0.5px, transparent 0.5px), linear-gradient(90deg, var(--scanline) 0.5px, transparent 0.5px)',
            backgroundSize: '56px 56px'
          }}>

            {/* Back wall: the board hangs here; auto-agents get a warning sign next to it. */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap', borderBottom: '0.5px solid var(--border-strong)', paddingBottom: 10 }}>
              <WallBoard
                unanswered={totalInbox}
                slips={slips}
                onClick={() => setView('board')}
                onOpenThread={(id) => { setFocusThread(id); setView('board') }}
              />
              {/* The filing cabinet by the door: where every @mention on the desk ends up
                  now that a tag no longer wakes the person it names. */}
              <div onClick={() => setView('file')}
                title="The Manager's File — every outstanding question on the desk, in one queue"
                style={{
                  cursor: 'pointer', border: `0.5px solid ${fileTriage > 0 ? BL : 'var(--border-strong)'}`,
                  background: 'var(--bg-elev)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8
                }}>
                <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                  {[0, 1, 2].map((i) => (
                    <span key={i} style={{
                      width: 14, height: 4, background: 'var(--bg-panel)',
                      border: BORDER, borderLeft: `2px solid ${i === 0 && fileTriage > 0 ? BL : GD}`
                    }} />
                  ))}
                </span>
                <Lbl c={fileTriage > 0 ? BL : GD}>
                  MANAGER'S FILE{fileTriage > 0 ? ` · ${fileTriage} to triage` : ' · clear'}
                </Lbl>
              </div>
              {autonomous.length > 0 && (
                <div title={autonomous.map((a) => `${a.agent.name} ≤$${a.agent.maxUsd}${a.agent.enabled ? ' · self-triggering' : ' · manual RUN only'}`).join('\n')}
                  style={{ border: `0.5px solid ${AM}`, background: 'color-mix(in srgb, var(--amber) 6%, transparent)', padding: '6px 12px', display: 'flex', alignItems: 'center' }}>
                  <Lbl c={AM}>⚡ {autonomous.length} desk{autonomous.length === 1 ? '' : 's'} trading unsupervised</Lbl>
                </div>
              )}
              <div style={{ flex: 1 }} />
              {arranged && (
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <Btn title="Put every desk back in its department, in hiring order"
                    onClick={() => applyLayout({ pod: {}, order: [] })}>
                    ⟲ RESET SEATING
                  </Btn>
                </div>
              )}
            </div>

            {!loaded && <Lbl>Unlocking the office…</Lbl>}
            {loaded && agents.length === 0 && (
              <Lbl c={GS}>The floor is dark and every desk is empty. Click the vacant desk to hire your first employee.</Lbl>
            )}

            {/* The grid sizes itself; the overlay is layered over it as a sibling so it
                can never feed back into that sizing. */}
            <div style={{ position: 'relative' }}>
            <div ref={gridRef} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pods
                // Empty pods are hidden until there is a desk in flight — then they
                // appear, because an empty pod is somewhere you can drop one.
                .filter((pod) => pod.deskIds.length > 0 || dragId !== null)
                .map((pod) => (
                  <Pod
                    key={pod.department}
                    department={pod.department}
                    count={pod.deskIds.length}
                    active={dropAt?.department === pod.department}
                    onDragOver={(e) => {
                      if (!dragId) return
                      e.preventDefault()
                      // Landing on the pod itself, rather than on a desk, means the back
                      // of that pod.
                      setDropAt({ department: pod.department, beforeId: null })
                    }}
                    onDrop={(e) => { e.preventDefault(); dropDesk(pod.department, null) }}
                  >
                    {pod.deskIds.map((id) => {
                      const v = agentById.get(id)
                      if (!v) return null
                      const hr = roster.find((r) => r.id === id)
                      return (
                        <Desk
                          key={id}
                          view={v}
                          {...(hr ? { hr } : {})}
                          selected={deskId === id}
                          floorIds={floorIds}
                          onSelect={() => setDeskId(deskId === id ? null : id)}
                          drag={{
                            dragging: dragId === id,
                            dropBefore: dropAt?.beforeId === id,
                            onDragStart: () => setDragId(id),
                            onDragEnd: () => { setDragId(null); setDropAt(null) },
                            onDragOver: (e) => {
                              if (!dragId || dragId === id) return
                              e.preventDefault()
                              e.stopPropagation()
                              setDropAt({ department: pod.department, beforeId: id })
                            },
                            onDrop: (e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              dropDesk(pod.department, id)
                            }
                          }}
                        />
                      )
                    })}
                  </Pod>
                ))}

              {/* Hiring sits below the pods — a desk nobody is sitting at yet. */}
              <div style={DESK_GRID}>
                <VacantDesk selected={deskId === 'new'} onSelect={() => setDeskId(deskId === 'new' ? null : 'new')} />
              </div>
            </div>

            {/* The people between the desks: conversations and petitioners. */}
            <FloorOverlay
              gridRef={gridRef}
              conversations={conversations}
              walkers={walkers}
              nameOf={nameOf}
              revision={seatingKey}
            />
            </div>
          </div>

          {/* Sitting at a desk: the inspector pane. */}
          {deskId === 'new' && (
            <div style={{ width: 420, flexShrink: 0, borderLeft: '0.5px solid var(--border-strong)', background: 'var(--bg-panel)', minHeight: 0 }}>
              <NewAgentForm
                onCreated={() => { setDeskId(null); void load(); reloadRoster() }}
                onCancel={() => setDeskId(null)}
              />
            </div>
          )}
          {seated && (
            <div style={{ width: 480, flexShrink: 0, borderLeft: '0.5px solid var(--border-strong)', background: 'var(--bg-panel)', minHeight: 0 }}>
              <DeskInspector
                view={seated}
                {...(() => { const hr = roster.find((r) => r.id === seated.agent.id); return hr ? { hr } : {} })()}
                onChanged={load}
                onOpenCubicle={() => openCubicle(seated.agent.id)}
                onClose={() => setDeskId(null)}
              />
            </div>
          )}
        </div>
      )}
      </div>
      )}

      {/* The library sits under every view — what the floor produced, kept. */}
      <LibraryShelf />
      </div>
    </div>
  )
}
