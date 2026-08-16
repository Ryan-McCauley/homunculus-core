// DEVICES — what is connected, what is waiting to be connected, and how to add
// something new.
//
// Three bands: devices Home Assistant discovered on the network by itself (the
// fastest path — HA already knows what it found, so setup is usually two clicks),
// the integrations already configured, and a picker for adding one by name.
//
// Adding a device is operator-only. There is no agent path to any of this, and
// that is structural rather than a policy note: the agent uplink executes HA
// *service* calls from its manifest, and a config flow is not a service.

import { useCallback, useEffect, useState } from 'react'
import {
  advanceFlow, beginFlow, cancelFlow, fetchDiscovered, fetchEntries,
  fetchIntegrations, reloadIntegration, removeEntry, resumeFlow,
} from '../../lib/devicesApi'
import { flowStepKind, isTerminalStep } from '../../../shared/haConfigFlow'
import type { ConfigEntrySummary, DiscoveredFlow, FlowOutcome, FlowStepPayload } from '../../../shared/haConfigFlow'
import { FlowForm } from './FlowForm'

const STATE_TONE: Record<string, string> = {
  loaded: 'var(--holo)',
  setup_error: 'var(--crimson)',
  migration_error: 'var(--crimson)',
  failed_unload: 'var(--crimson)',
  setup_retry: 'var(--amber)',
  setup_in_progress: 'var(--amber)',
  not_loaded: 'var(--green-dim)',
}

export function DevicesView(): JSX.Element {
  const [entries, setEntries] = useState<ConfigEntrySummary[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredFlow[]>([])
  const [handlers, setHandlers] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [step, setStep] = useState<FlowStepPayload | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | undefined>()
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [entryList, handlerList] = await Promise.all([fetchEntries(), fetchIntegrations()])
      setEntries(entryList)
      setHandlers(handlerList)
      setLoadError(null)
    } catch (err) {
      setLoadError((err as Error).message)
    }
    // Discovery is websocket-only upstream and may simply be unavailable; it must
    // never take the rest of the view down with it.
    try {
      setDiscovered(await fetchDiscovered())
    } catch {
      setDiscovered([])
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /** Applies a flow outcome, closing the flow out when it reaches a terminal step. */
  const apply = (outcome: FlowOutcome): void => {
    if (!outcome.ok) {
      setFlowError(outcome.error)
      setFieldErrors(outcome.fieldErrors)
      return
    }
    setFlowError(null)
    setFieldErrors(undefined)

    if (isTerminalStep(outcome.step)) {
      const kind = flowStepKind(outcome.step)
      setNotice(kind === 'create_entry'
        ? `ADDED ${String(outcome.step.title ?? outcome.step.handler ?? 'INTEGRATION').toUpperCase()}`
        : `SETUP STOPPED — ${String(outcome.step.reason ?? 'aborted').replace(/_/g, ' ').toUpperCase()}`)
      setStep(null)
      void refresh()
      return
    }
    setStep(outcome.step)
  }

  const run = async (fn: () => Promise<FlowOutcome>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      apply(await fn())
    } finally {
      setBusy(false)
    }
  }

  const close = async (): Promise<void> => {
    const flowId = step?.flow_id
    setStep(null)
    setFlowError(null)
    setFieldErrors(undefined)
    if (flowId) await cancelFlow(flowId).catch(() => undefined)
  }

  const act = async (label: string, fn: () => Promise<{ ok: boolean; requireRestart?: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    try {
      const res = await fn()
      setNotice(res.ok
        ? `${label}${res.requireRestart ? ' — HOME ASSISTANT NEEDS A RESTART' : ''}`
        : `FAILED — ${res.error ?? 'unknown error'}`)
      await refresh()
    } catch (err) {
      setNotice(`FAILED — ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // An in-progress flow takes over the view: a half-finished setup with the rest
  // of the page still clickable is how people end up with two of everything.
  if (step) {
    return (
      <div className="holo" style={{ maxWidth: 720 }}>
        {flowError && <div className="holo-l" style={{ color: 'var(--crimson)', marginBottom: 10 }}>{flowError}</div>}
        <FlowForm
          step={step}
          fieldErrors={fieldErrors}
          busy={busy}
          onSubmit={(values) => void run(() => advanceFlow(step.flow_id ?? '', values))}
          onCancel={() => void close()}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notice && <div className="holo-l" style={{ color: 'var(--holo)' }}>{notice}</div>}
      {loadError && (
        <div className="holo-l" style={{ color: 'var(--crimson)' }}>
          COULD NOT REACH HOME ASSISTANT — {loadError}
        </div>
      )}
      {flowError && !step && <div className="holo-l" style={{ color: 'var(--crimson)' }}>{flowError}</div>}

      {/* add a device */}
      <div className="holo">
        <div className="holo-h" style={{ fontSize: 13 }}>
          <i className="ti ti-plug-connected" style={{ marginRight: 8 }} />ADD A DEVICE
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="integration-pick" className="holo-l">INTEGRATION</label>
          <input
            id="integration-pick"
            list="integration-options"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            placeholder="hue, sonos, esphome…"
            aria-label="Integration to add"
            style={{
              flex: 1, minWidth: 200, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
              color: 'var(--green-soft)', background: '#2effb006',
              border: '1px solid var(--border-holo)', outline: 'none',
            }}
          />
          <datalist id="integration-options">
            {handlers.map((h) => <option key={h} value={h} />)}
          </datalist>
          <button
            type="button" className="holo-btn" style={{ cursor: 'pointer' }}
            disabled={busy || !handlers.includes(pick)}
            onClick={() => void run(() => beginFlow(pick))}
            aria-label={`Begin setup for ${pick || 'the selected integration'}`}
          >BEGIN SETUP ▸</button>
        </div>
        <div className="holo-l" style={{ marginTop: 8 }}>
          {handlers.length} INTEGRATIONS AVAILABLE · CREDENTIALS YOU TYPE HERE GO STRAIGHT TO HOME ASSISTANT AND ARE NEVER LOGGED
        </div>
      </div>

      {/* discovered */}
      {discovered.length > 0 && (
        <div className="holo">
          <div className="holo-h" style={{ fontSize: 13 }}>
            <i className="ti ti-radar" style={{ marginRight: 8 }} />DISCOVERED · {discovered.length}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {discovered.map((flow) => (
              <div key={flow.flowId} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span className="holo-l" style={{ color: 'var(--green-soft)', minWidth: 200 }}>
                  {flow.title.toUpperCase()}
                </span>
                <span className="holo-l">{flow.handler} · FOUND BY {flow.source.toUpperCase()}</span>
                <button
                  type="button" className="holo-btn" style={{ cursor: 'pointer', marginLeft: 'auto' }}
                  disabled={busy}
                  onClick={() => void run(() => resumeFlow(flow.flowId))}
                  aria-label={`Set up the discovered device ${flow.title}`}
                >SET UP ▸</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* configured */}
      <div className="holo">
        <div className="holo-h" style={{ fontSize: 13 }}>
          <i className="ti ti-affiliate" style={{ marginRight: 8 }} />CONFIGURED · {entries.length}
        </div>
        {entries.length === 0 && <div className="holo-l" style={{ marginTop: 10 }}>NOTHING CONFIGURED YET</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {entries.map((entry) => (
            <div key={entry.entry_id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="holo-l" style={{ color: 'var(--green-soft)', minWidth: 200 }}>
                {entry.title.toUpperCase()}
              </span>
              <span className="holo-l">{entry.domain}</span>
              <span style={{ fontSize: 12, letterSpacing: 1, color: STATE_TONE[entry.state] ?? 'var(--green-dim)' }}>
                {entry.state.replace(/_/g, ' ').toUpperCase()}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  type="button" className="holo-btn" style={{ cursor: 'pointer' }} disabled={busy}
                  onClick={() => void act(`RELOADED ${entry.title.toUpperCase()}`, () => reloadIntegration(entry.entry_id))}
                  aria-label={`Reload ${entry.title}`}
                >RELOAD</button>
                <button
                  type="button" className="holo-btn"
                  style={{ cursor: 'pointer', color: 'var(--crimson)', borderColor: 'var(--border-crimson)' }}
                  disabled={busy}
                  onClick={() => {
                    // Removing an integration takes its devices, entities and
                    // history with it, and nothing here can put them back.
                    if (!window.confirm(`Remove ${entry.title}? This deletes its devices and entities from Home Assistant.`)) return
                    void act(`REMOVED ${entry.title.toUpperCase()}`, () => removeEntry(entry.entry_id))
                  }}
                  aria-label={`Remove ${entry.title} from Home Assistant`}
                >REMOVE</button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
