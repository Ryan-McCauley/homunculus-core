// INTELLIGENCE → RUNNING: every live Claude session, with a kill switch.
//
// Six things in this server can be talking to Claude at once — agent runs, agent
// chat turns, off-shift handoffs, strategy skills, the Computer Core chat, and the
// proactive monitor. They all spend the same subscription and can run for minutes,
// so this is the one place that answers "what is burning tokens right now" and
// lets you end it without restarting the server.
//
// Stopping is graceful: the server aborts the SDK's controller, which closes stdin
// and gives the session ~2s to exit cleanly, so the run still records its outcome
// (as "stopped", not "failed").

import { useCallback, useEffect, useState } from 'react'
import { CLAUDE_KIND_LABELS, isBackgroundKind } from '../../shared/claude'
import type { ClaudeProcess } from '../../shared/claude'
import { fetchRunningClaude, stopClaudeProcess } from '../lib/cryptoApi'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const AM = 'var(--amber)'
const CR = 'var(--crimson)'
const BORDER = '0.5px solid var(--border)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

const KIND_COLOR: Record<string, string> = {
  'agent': G, 'agent-chat': '#4aa3df', 'agent-handoff': '#b06fd0',
  'skill': '#4aa3df', 'core-chat': AM, 'proactive': GD,
}

function elapsed(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function ClaudeRunning() {
  const [procs, setProcs] = useState<ClaudeProcess[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Ticks once a second so the elapsed column counts up between polls. */
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    try {
      setProcs(await fetchRunningClaude())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    // Faster than the fleet poll: this view is what you watch while deciding
    // whether to kill something, so it should feel live.
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const stop = async (p: ClaudeProcess) => {
    setBusy(p.id); setNote(null)
    try {
      const r = await stopClaudeProcess(p.id)
      // A 409 here is the ordinary race — it finished while you were reading.
      setNote(r.ok ? `Stopping ${p.label}…` : `${p.label}: ${r.error ?? 'could not stop'}`)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(null)
      void load()
    }
  }

  if (error) {
    return <div style={{ padding: 14 }}><span style={{ ...MONO, fontSize: 13, color: CR }}>unavailable — {error}</span></div>
  }
  if (!procs) {
    return <div style={{ padding: 14 }}><span style={{ ...MONO, fontSize: 13, color: GD }}>checking…</span></div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: BORDER }}>
        <span style={{ ...MONO, fontSize: 13, color: procs.length ? G : GD, letterSpacing: 1 }}>
          {procs.length === 0 ? '○ NOTHING RUNNING' : `● ${procs.length} LIVE SESSION${procs.length > 1 ? 'S' : ''}`}
        </span>
        <div style={{ flex: 1 }} />
        {note && <span style={{ ...MONO, fontSize: 12, color: GD }}>{note}</span>}
      </div>

      {procs.length === 0 ? (
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...MONO, fontSize: 13, color: GD }}>No agent, strategy, or chat is talking to Claude right now.</span>
          <span style={{ ...MONO, fontSize: 12, color: GD, opacity: 0.75 }}>
            Anything this server starts appears here within a few seconds.
          </span>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {procs.map((p) => {
            const stopping = !!p.stoppedBy
            return (
              <div key={p.id} style={{
                borderTop: BORDER, borderRight: BORDER, borderBottom: BORDER,
                borderLeft: `2px solid ${KIND_COLOR[p.kind] ?? GD}`,
                padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 12,
                opacity: stopping ? 0.6 : 1,
              }}>
                <span style={{ ...MONO, fontSize: 10, letterSpacing: 1, color: KIND_COLOR[p.kind] ?? GD, width: 76, flexShrink: 0 }}>
                  {CLAUDE_KIND_LABELS[p.kind] ?? p.kind.toUpperCase()}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ ...MONO, fontSize: 13, color: 'var(--green-soft)' }}>
                    {p.label}
                    {isBackgroundKind(p.kind) && (
                      <span style={{ fontSize: 10, color: GD, letterSpacing: 1 }}> · BACKGROUND</span>
                    )}
                  </div>
                  <div style={{
                    ...MONO, fontSize: 11, color: GD,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }} title={p.detail}>{p.detail}</div>
                </div>
                <span style={{ ...MONO, fontSize: 11, color: GD, width: 62, textAlign: 'right', flexShrink: 0 }}>
                  {p.model === 'default' ? 'default' : p.model}
                </span>
                <span style={{ ...MONO, fontSize: 12, color: AM, width: 66, textAlign: 'right', flexShrink: 0 }}>
                  {elapsed(p.startedAt)}
                </span>
                <button
                  onClick={() => void stop(p)}
                  disabled={busy === p.id || stopping}
                  title={stopping ? `stopping — requested by ${p.stoppedBy}` : `Stop this ${p.kind} session`}
                  style={{
                    ...MONO, fontSize: 11, letterSpacing: 1, padding: '3px 12px', flexShrink: 0,
                    background: 'transparent', border: `0.5px solid ${stopping ? GD : CR}`,
                    color: stopping ? GD : CR, cursor: stopping || busy === p.id ? 'default' : 'pointer',
                  }}
                >{stopping ? 'STOPPING' : busy === p.id ? '…' : '■ STOP'}</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
