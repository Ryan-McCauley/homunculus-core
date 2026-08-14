// Alert builder for the focused symbol. WHEN <indicator> <condition> [value]
// THEN <action>. The dropdowns are rendered from shared/alerts.ts — the same
// catalog the server evaluator switches on — so the UI cannot offer a condition
// the engine doesn't implement.

import { useState, useEffect } from 'react'
import { ALERT_SOURCES, ALERT_TIMEFRAMES, alertSource, alertCondition, describeAlert } from '../../../shared/alerts'
import type { CryptoAlert, AlertSourceId, AlertAction, AlertTimeframe } from '../../../shared/alerts'
import { createAlert, deleteAlert, setAlertArmed } from '../../lib/cryptoApi'
import { fetchAgents } from '../../lib/agentsApi'
import { G, GD, CR, AMBER, BORDER, MONO, ago, Lbl } from '../../lib/cryptoUi'

const TFS = ALERT_TIMEFRAMES

const ACTIONS: { id: AlertAction; label: string }[] = [
  { id: 'notify', label: 'NOTIFY' },
  { id: 'stage-buy', label: 'NOTIFY + STAGE BUY' },
  { id: 'stage-sell', label: 'NOTIFY + STAGE SELL' },
]

const selectStyle = {
  ...MONO, fontSize: 11, padding: '4px 6px', background: 'var(--bg-elev)',
  border: BORDER, color: 'var(--green-soft)', outline: 'none',
} as const

export function AlertModal({ symbol, tf, alerts, seedPrice, onChanged, onClose }: {
  symbol: string
  tf: AlertTimeframe
  alerts: CryptoAlert[]
  /** Pre-fills the threshold for price alerts — usually the last price. */
  seedPrice: number
  onChanged: () => void
  onClose: () => void
}) {
  const [source, setSource] = useState<AlertSourceId>('rsi')
  const [condition, setCondition] = useState('below')
  const [value, setValue] = useState('30')
  const [alertTf, setAlertTf] = useState<AlertTimeframe>(tf)
  const [action, setAction] = useState<AlertAction>('notify')
  const [usd, setUsd] = useState('20')
  const [once, setOnce] = useState(false)
  /** Optional agent to start when this fires — orthogonal to `action`. */
  const [wakeAgentId, setWakeAgentId] = useState('')
  const [fleet, setFleet] = useState<{ id: string; name: string; enabled: boolean }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The picker lists real agents; arming with an unknown id is refused server-side.
  useEffect(() => {
    void fetchAgents()
      .then((views) => setFleet(views.map((v) => ({ id: v.agent.id, name: v.agent.name, enabled: v.agent.enabled }))))
      .catch(() => setFleet([]))
  }, [])

  const src = alertSource(source)
  const cond = alertCondition(source, condition)

  // Switching source resets the condition to that source's first, and seeds the
  // threshold — otherwise "RSI crosses above 64,500" survives a switch to PRICE.
  useEffect(() => {
    const first = alertSource(source)?.conditions[0]
    if (!first) return
    setCondition(first.id)
    setValue(String(first.defaultValue ?? (source === 'price' ? Math.round(seedPrice) : 0)))
  }, [source, seedPrice])

  const pickCondition = (id: string) => {
    setCondition(id)
    const c = alertCondition(source, id)
    if (c?.needsValue) setValue(String(c.defaultValue ?? (source === 'price' ? Math.round(seedPrice) : 0)))
  }

  const arm = async () => {
    setBusy(true); setError(null)
    const numeric = Number(value)
    const result = await createAlert({
      symbol, source, condition,
      value: cond?.needsValue ? numeric : null,
      tf: alertTf, action,
      stageUsd: Number(usd) || 20,
      once,
      wakeAgentId: wakeAgentId || null,
    })
    setBusy(false)
    if (!result.ok) { setError(result.error ?? 'could not arm alert'); return }
    onChanged()
  }

  const mine = alerts.filter((a) => a.symbol === symbol)

  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 40, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: 'color-mix(in srgb, var(--bg) 72%, transparent)',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 660, maxHeight: '86%', overflowY: 'auto', background: 'var(--bg-panel)',
        border: `1px solid ${AMBER}`, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: BORDER }}>
          <span style={{ ...MONO, fontSize: 13, color: AMBER, letterSpacing: 2 }}>ALERTS · {symbol.replace(/USD$/, '')}</span>
          <Lbl>{mine.filter((a) => a.armed).length} ARMED</Lbl>
          <div style={{ flex: 1 }} />
          <span onClick={onClose} style={{ ...MONO, fontSize: 14, color: GD, cursor: 'pointer' }}>✕</span>
        </div>

        {/* builder */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px', borderBottom: BORDER }}>
          <Lbl size={10}>WHEN</Lbl>
          <select value={source} onChange={(e) => setSource(e.target.value as AlertSourceId)} style={selectStyle}>
            {ALERT_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={condition} onChange={(e) => pickCondition(e.target.value)} style={selectStyle}>
            {(src?.conditions ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {cond?.needsValue && (
            <>
              <input value={value} onChange={(e) => setValue(e.target.value)} style={{
                ...MONO, fontSize: 12, padding: '4px 7px', width: 92, background: 'var(--bg-elev)',
                border: BORDER, color: 'var(--green-soft)', outline: 'none',
              }} />
              {cond.unit && <Lbl size={10}>{cond.unit}</Lbl>}
            </>
          )}
          <Lbl size={10}>ON</Lbl>
          <select value={alertTf} onChange={(e) => setAlertTf(e.target.value as AlertTimeframe)} style={selectStyle}>
            {TFS.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
          </select>
          <Lbl size={10}>THEN</Lbl>
          <select value={action} onChange={(e) => setAction(e.target.value as AlertAction)} style={selectStyle}>
            {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {action !== 'notify' && (
            <input value={usd} onChange={(e) => setUsd(e.target.value)} title="USD size to stage"
              style={{ ...MONO, fontSize: 12, padding: '4px 7px', width: 58, background: 'var(--bg-elev)', border: BORDER, color: 'var(--green-soft)', outline: 'none' }} />
          )}
          <Lbl size={10}>WAKE</Lbl>
          <select
            value={wakeAgentId}
            onChange={(e) => setWakeAgentId(e.target.value)}
            title="Start this agent when the alert fires. Waking grants no authority — the agent's own autonomy dial still applies."
            style={selectStyle}
          >
            <option value="">NOBODY</option>
            {fleet.map((f) => (
              <option key={f.id} value={f.id}>{f.name.toUpperCase()}{f.enabled ? '' : ' (DISABLED)'}</option>
            ))}
          </select>
          <span onClick={() => setOnce((v) => !v)} style={{ ...MONO, fontSize: 10, color: once ? G : GD, cursor: 'pointer', letterSpacing: 1 }}>
            {once ? '▣' : '☐'} ONCE
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => void arm()} disabled={busy} style={{
            ...MONO, fontSize: 11, letterSpacing: 2, padding: '5px 16px',
            background: AMBER, border: 'none', color: 'var(--bg)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>+ ARM</button>
        </div>

        {error && <div style={{ padding: '6px 14px', ...MONO, fontSize: 11, color: CR }}>{error}</div>}

        {/* armed list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 14px' }}>
          {mine.length === 0 && <Lbl>No alerts on this symbol yet.</Lbl>}
          {mine.map((a) => {
            const fired = a.lastFiredAt != null
            return (
              <div key={a.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', padding: '5px 8px',
                // Longhands only — `border` + a `borderLeft` override trips React's
                // shorthand/longhand conflict warning.
                borderTop: BORDER, borderRight: BORDER, borderBottom: BORDER,
                borderLeft: `2px solid ${a.armed ? AMBER : GD}`,
                ...MONO, fontSize: 11,
              }}>
                <span style={{ color: a.armed ? AMBER : GD }}>⚑</span>
                <span style={{ color: 'var(--green-soft)' }}>{describeAlert(a)}</span>
                <Lbl size={10}>→ {ACTIONS.find((x) => x.id === a.action)?.label}{a.action !== 'notify' ? ` $${a.stageUsd}` : ''}</Lbl>
                {a.wakeAgentId && (
                  <span title={`Wakes ${a.wakeAgentId} when this fires`}
                    style={{ fontSize: 10, letterSpacing: 1, color: G }}>
                    ⏻ WAKES {a.wakeAgentId.toUpperCase()}
                  </span>
                )}
                {a.createdBy && a.createdBy !== 'operator' && (
                  <span title={`Armed by ${a.createdBy}`}
                    style={{ fontSize: 10, letterSpacing: 1, color: '#4aa3df' }}>
                    ◂ {a.createdBy.toUpperCase()}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {fired && <span title={a.lastNote ?? ''} style={{ color: AMBER, fontSize: 10, letterSpacing: 1 }}>
                  ◈ FIRED {ago(a.lastFiredAt!)}{a.fireCount > 1 ? ` ×${a.fireCount}` : ''}
                </span>}
                <span onClick={() => void setAlertArmed(a.id, !a.armed).then(onChanged)}
                  title={a.armed ? 'Pause this alert' : 'Re-arm this alert'}
                  style={{ fontSize: 10, letterSpacing: 1, color: a.armed ? G : GD, cursor: 'pointer' }}>
                  {a.armed ? 'ARMED' : 'PAUSED'}
                </span>
                <span onClick={() => void deleteAlert(a.id).then(onChanged)}
                  style={{ color: GD, cursor: 'pointer' }}>✕</span>
              </div>
            )
          })}
        </div>

        <div style={{ padding: '9px 14px', borderTop: BORDER }}>
          <Lbl size={10}>
            ALERTS ARE EVALUATED BY THE SERVER LOOP — THEY KEEP FIRING WITH THE APP CLOSED.
            A STAGING ALERT PROPOSES INTO THE CONFIRM QUEUE; IT NEVER SENDS AN ORDER.
          </Lbl>
        </div>
      </div>
    </div>
  )
}
