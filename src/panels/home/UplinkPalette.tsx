// The uplink — ⌘K over any sub-view.
//
// Type an instruction, get back a numbered plan of the actual service calls it
// compiled to, and see what ran. Nothing fires from text directly: the plan is
// the intermediate representation, and confirm-tier ops come back HELD with a
// button rather than executing on the strength of a sentence.
//
// The same endpoint serves an autonomous agent, which is the point — this panel
// is a window onto the exact interface the agent uses, so what an agent can do is
// what the operator can see it doing.

import { useEffect, useRef, useState } from 'react'
import { confirmOps, dryRunIntent, submitIntent, type IntentResponse } from '../../lib/agentApi'
import type { OpResult } from '../../../shared/agentPlan'

const TIER_TONE: Record<string, string> = {
  write: 'var(--holo-dim)',
  confirm: 'var(--amber)',
  read: 'var(--green-dim)',
}

const STATUS_TONE: Record<OpResult['status'], string> = {
  ok: 'var(--holo)',
  failed: 'var(--crimson)',
  refused: 'var(--crimson)',
  held: 'var(--amber)',
  dry_run: 'var(--green-dim)',
}

export function UplinkPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [response, setResponse] = useState<IntentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastText, setLastText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (fn: () => Promise<IntentResponse>, submitted: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResponse(await fn())
      setLastText(submitted)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const statusOf = (n: number): OpResult | undefined => response?.result.ops.find((o) => o.n === n)
  const held = (response?.result.ops ?? []).filter((o) => o.status === 'held')

  return (
    <div
      role="dialog"
      aria-label="Command uplink"
      style={{
        position: 'absolute', inset: 0, zIndex: 40, padding: 16,
        background: '#03060af2', overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, letterSpacing: 2, color: 'var(--holo)' }}>⌁ ▸</span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) void run(() => submitIntent(text), text) }}
          placeholder="movie mode, but keep the reading lamp on and lock up"
          aria-label="Describe what you want the house to do"
          style={{
            flex: 1, padding: '9px 14px', fontFamily: 'var(--font-mono)', fontSize: 13.5,
            letterSpacing: 0.5, color: 'var(--green-soft)', background: '#2effb00a',
            border: '1px solid var(--border-holo)', outline: 'none',
            boxShadow: '0 0 14px #2effb01a, inset 0 0 18px #2effb008',
          }}
        />
        <button
          type="button" className="holo-btn" style={{ cursor: 'pointer' }}
          disabled={busy || !text.trim()}
          onClick={() => void run(() => dryRunIntent(text), text)}
          aria-label="Compile the plan without executing it"
        >DRY RUN</button>
        <button
          type="button" className="holo-btn" style={{ cursor: 'pointer' }}
          onClick={onClose}
          aria-label="Close the uplink"
        >ESC</button>
      </div>

      {busy && <div className="holo-l">COMPILING…</div>}
      {error && <div className="holo-l" style={{ color: 'var(--crimson)' }}>UPLINK FAILED — {error}</div>}

      {response && (
        <div className="holo">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
            <div className="holo-h" style={{ fontSize: 13 }}>◈ OPERATION PLAN</div>
            <span className="holo-l">
              {response.plan.ops.length} OP{response.plan.ops.length === 1 ? '' : 'S'} · COMPILED AGAINST MANIFEST V{response.plan.manifest}
            </span>
          </div>

          {response.plan.ops.length === 0 && (
            <div className="holo-l" style={{ marginTop: 10, color: 'var(--amber)' }}>
              NOTHING MATCHED{response.plan.unmatched.length ? ` — ${response.plan.unmatched.join(' · ')}` : ''}
            </div>
          )}

          <div style={{ marginTop: 8 }}>
            {response.plan.ops.map((op) => {
              const result = statusOf(op.n)
              return (
                <div
                  key={op.n}
                  style={{
                    display: 'grid', gridTemplateColumns: '26px minmax(140px,190px) 1fr auto',
                    gap: 10, alignItems: 'center', fontSize: 12.5,
                    padding: '7px 0', borderBottom: '1px solid #2effb00e',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--holo-dim)' }}>
                    {String(op.n).padStart(2, '0')}
                  </span>
                  <span style={{ color: 'var(--holo)' }}>{op.service}</span>
                  <span style={{ color: '#8fd4ad' }}>
                    {op.entityId}
                    {Object.keys(op.data).length > 0 && ` · ${JSON.stringify(op.data)}`}
                    {op.note && <span style={{ color: 'var(--amber)' }}> — {op.note}</span>}
                  </span>
                  <span style={{ color: result ? STATUS_TONE[result.status] : TIER_TONE[op.tier], letterSpacing: 1 }}>
                    {result ? result.status.toUpperCase().replace('_', ' ') : op.tier.toUpperCase()}
                  </span>
                </div>
              )
            })}
          </div>

          {held.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="holo-l" style={{ color: 'var(--amber)' }}>
                {held.length} OP{held.length === 1 ? '' : 'S'} AWAITING CONFIRMATION
              </span>
              {held.map((op) => (
                <button
                  key={op.n}
                  type="button" className="holo-btn"
                  style={{ cursor: 'pointer', color: 'var(--crimson)', borderColor: 'var(--border-crimson)', background: '#e0245e0a' }}
                  onClick={() => void run(() => confirmOps(lastText, [op.n]), lastText)}
                  aria-label={`Confirm and run operation ${op.n}: ${op.service} on ${op.entityId}`}
                >
                  CONFIRM {String(op.n).padStart(2, '0')}: {op.service.split('.')[1]?.toUpperCase()}
                </button>
              ))}
            </div>
          )}

          {response.result.ops.some((o) => o.error && o.status !== 'held') && (
            <div className="holo-l" style={{ marginTop: 10, color: 'var(--crimson)' }}>
              {response.result.ops.filter((o) => o.error && o.status !== 'held').map((o) => `${o.n}: ${o.error}`).join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
