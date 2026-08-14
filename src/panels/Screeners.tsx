// SCREENERS — prescreening the market for trade candidates.
//
// Layout follows the approved mockup: a chip row of the user's SAVED SCREENERS, a
// filter rail holding the active screener's definition (MARKET / TECHNICAL /
// PATTERN), and a results pane that toggles between the ranked table and the
// elimination funnel.
//
// Screening happens in engine/screener_engine.py — deterministic Python, no model.
// This file renders what comes back and edits what goes in; it computes no
// indicators of its own, so the numbers on screen are the numbers that filtered.
//
// SCREENERS ARE NOT STRATEGIES. The chips are the user's own saved questions.
// Strategies appear in exactly one place — as an optional starting point in the
// NEW SCREENER overlay — and importing one copies its gates. Nothing here can
// place an order.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GATE_META, KNOWN_PATTERNS, SCREENER_TIMEFRAMES, normalizeScreenerDef,
  type ScreenerCandidate, type ScreenerDef, type ScreenerGateId,
  type ScreenerResult, type ScreenerTimeframe,
} from '../../shared/screener'
import {
  createScreener, deleteScreener, fetchScreeners, runScreener, saveScreener,
} from '../lib/screenerApi'
import {
  blockedText, boundLabel, degradedNote, fitBarWidth, formatGateValue, gateStrip,
  isDirty, patternLabel, railGroups, timeframeLabel,
} from '../lib/screenerUi'
import { AMBER, BORDER, CR, G, GD, MONO, Lbl } from '../lib/cryptoUi'

const HOLO = 'var(--holo)'
const PANEL = 'var(--bg-panel)'
const ELEV = 'var(--bg-elev)'

// ── Small primitives ──────────────────────────────────────────────────────────

function Chip({ active, tone = 'green', title, onClick, children }: {
  active?: boolean; tone?: 'green' | 'amber' | 'holo'; title?: string
  onClick?: () => void; children: React.ReactNode
}) {
  const color = tone === 'amber' ? AMBER : tone === 'holo' ? HOLO : G
  return (
    <button type="button" title={title} onClick={onClick} style={{
      ...MONO, fontSize: 11, letterSpacing: 1, padding: '3px 11px', whiteSpace: 'nowrap',
      display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
      background: active ? '#0a1a12' : 'transparent',
      border: `1px solid ${active ? color : 'var(--border-strong)'}`,
      color: active ? color : tone === 'green' ? GD : color,
      boxShadow: active ? `0 0 10px ${color}33, inset 0 0 8px ${color}18` : 'none',
    }}>{children}</button>
  )
}

function Btn({ tone = 'plain', disabled, onClick, title, children }: {
  tone?: 'plain' | 'go' | 'warn' | 'danger'; disabled?: boolean
  onClick?: () => void; title?: string; children: React.ReactNode
}) {
  const go = tone === 'go'
  const color = tone === 'warn' ? AMBER : tone === 'danger' ? CR : 'var(--green-soft)'
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} style={{
      ...MONO, fontSize: 11, letterSpacing: 1.5, padding: '4px 12px', borderRadius: 2,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
      background: go ? G : 'transparent',
      border: `1px solid ${go ? G : tone === 'warn' ? '#f5a62355' : tone === 'danger' ? '#e0245e55' : 'var(--border-strong)'}`,
      color: go ? '#000' : color, fontWeight: go ? 700 : 400,
      boxShadow: go && !disabled ? `0 0 10px ${G}55` : 'none',
    }}>{children}</button>
  )
}

/** Numeric field that keeps the user's raw keystrokes while they type — binding an
 *  input straight to a number turns "-" and "0." into instant NaN and fights back. */
function NumField({ value, placeholder, onCommit }: {
  value: number | null; placeholder: string; onCommit: (v: number | null) => void
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value == null ? '' : String(value))
  }, [value])
  return (
    <input
      value={text} placeholder={placeholder} inputMode="decimal"
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false }}
      onChange={(e) => {
        setText(e.target.value)
        const raw = e.target.value.trim()
        if (raw === '' || raw === '-') return onCommit(null)
        const n = Number(raw)
        if (Number.isFinite(n)) onCommit(n)
      }}
      style={{
        ...MONO, fontSize: 11, width: 68, padding: '1px 6px', borderRadius: 2,
        background: '#0a1a12', border: '1px solid var(--border-strong)',
        color: 'var(--green-soft)', textAlign: 'right',
      }}
    />
  )
}

function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title: string }) {
  return (
    <button type="button" title={title} onClick={onClick} style={{
      ...MONO, fontSize: 9, letterSpacing: 1, width: 26, padding: '1px 0', borderRadius: 2,
      cursor: 'pointer', background: on ? '#0a1a12' : 'transparent',
      border: `1px solid ${on ? G : 'var(--border-strong)'}`, color: on ? G : GD,
      boxShadow: on ? `0 0 6px ${G}44` : 'none',
    }}>{on ? 'ON' : 'OFF'}</button>
  )
}

function Segmented<T extends string>({ options, value, onChange }: {
  options: readonly T[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 2, overflow: 'hidden' }}>
      {options.map((o, i) => (
        <button key={o} type="button" onClick={() => onChange(o)} style={{
          ...MONO, flex: 1, fontSize: 10.5, padding: '3px 0', cursor: 'pointer',
          background: value === o ? '#0a1a12' : 'transparent',
          color: value === o ? G : GD, border: 'none',
          borderRight: i < options.length - 1 ? BORDER : 'none',
          boxShadow: value === o ? `inset 0 0 8px ${G}22` : 'none',
        }}>{timeframeLabel(o as ScreenerTimeframe) || o}</button>
      ))}
    </div>
  )
}

// ── Filter rail ───────────────────────────────────────────────────────────────

function GateRow({ id, draft, onChange }: {
  id: ScreenerGateId; draft: ScreenerDef; onChange: (next: ScreenerDef) => void
}) {
  const meta = GATE_META[id]
  const gate = draft.gates[id] as unknown as Record<string, unknown>
  const patch = (changes: Record<string, unknown>) =>
    onChange({ ...draft, gates: { ...draft.gates, [id]: { ...gate, ...changes } } })

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
        <span style={{ color: GD, letterSpacing: 0.5, flex: 1 }}>{meta.label}</span>
        <span title={`${meta.label} — current setting`} style={{
          ...MONO, fontSize: 10.5, padding: '1px 8px', borderRadius: 2,
          color: gate['enabled'] ? 'var(--green-soft)' : GD,
          background: gate['enabled'] ? '#0a1a12' : 'transparent',
          border: `1px solid ${gate['enabled'] ? 'var(--border-strong)' : 'transparent'}`,
        }}>{boundLabel(id, gate as never)}</span>
        <Toggle
          on={!!gate['enabled']}
          title={gate['enabled'] ? `Turn the ${meta.label} filter off` : `Filter on ${meta.label}`}
          onClick={() => patch({ enabled: !gate['enabled'] })}
        />
      </div>

      {!!gate['enabled'] && meta.kind === 'range' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'flex-end' }}>
          <NumField value={gate['min'] as number | null} placeholder="min" onCommit={(v) => patch({ min: v })} />
          <NumField value={gate['max'] as number | null} placeholder="max" onCommit={(v) => patch({ max: v })} />
        </div>
      )}

      {!!gate['enabled'] && meta.kind === 'trend' && (
        <div style={{ marginTop: 4 }}>
          <Segmented options={['ANY', 'ABOVE', 'BELOW'] as const}
            value={(gate['trend'] as 'ANY') ?? 'ANY'} onChange={(v) => patch({ trend: v })} />
        </div>
      )}

      {!!gate['enabled'] && meta.kind === 'cross' && (
        <div style={{ marginTop: 4 }}>
          <Segmented options={['ANY', 'BULLISH', 'BEARISH'] as const}
            value={(gate['cross'] as 'ANY') ?? 'ANY'} onChange={(v) => patch({ cross: v })} />
        </div>
      )}

      {!!gate['enabled'] && meta.kind === 'pattern' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
          {KNOWN_PATTERNS.map((p) => {
            const names = (gate['names'] as string[]) ?? []
            const on = names.includes(p)
            return (
              <button key={p} type="button" title={patternLabel(p)} onClick={() =>
                patch({ names: on ? names.filter((n) => n !== p) : [...names, p] })
              } style={{
                ...MONO, fontSize: 9, padding: '1px 5px', borderRadius: 2, cursor: 'pointer',
                background: on ? '#0a1a12' : 'transparent',
                border: `1px solid ${on ? G : 'var(--border)'}`, color: on ? G : GD,
              }}>{p.replace(/_/g, ' ')}</button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FilterRail({ draft, dirty, busy, onChange, onSave, onSaveAs, onDelete, onRun }: {
  draft: ScreenerDef; dirty: boolean; busy: boolean
  onChange: (next: ScreenerDef) => void
  onSave: () => void; onSaveAs: () => void; onDelete: () => void; onRun: () => void
}) {
  return (
    <div style={{
      borderRight: BORDER, background: ELEV, padding: '12px 12px 14px',
      display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto',
    }}>
      <div>
        <div style={{
          fontSize: 10, letterSpacing: 2, color: HOLO, borderBottom: '1px solid #2effb022',
          paddingBottom: 4, marginBottom: 8, textShadow: `0 0 8px ${HOLO}44`,
        }}>◢ TIMEFRAME</div>
        <Segmented options={SCREENER_TIMEFRAMES} value={draft.timeframe}
          onChange={(tf) => onChange({ ...draft, timeframe: tf })} />
        <div style={{ marginTop: 8 }}>
          <Segmented options={['ALL', 'HELD'] as const} value={draft.universe}
            onChange={(u) => onChange({ ...draft, universe: u })} />
        </div>
      </div>

      {railGroups().map((group) => (
        <div key={group.group}>
          <div style={{
            fontSize: 10, letterSpacing: 2, color: HOLO, borderBottom: '1px solid #2effb022',
            paddingBottom: 4, marginBottom: 8, textShadow: `0 0 8px ${HOLO}44`,
          }}>◢ {group.group}</div>
          {group.gates.map((id) => <GateRow key={id} id={id} draft={draft} onChange={onChange} />)}
        </div>
      ))}

      <div style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 8 }}>
        <Btn tone={dirty ? 'warn' : 'plain'} disabled={!dirty} onClick={onSave}
          title={dirty ? 'Save these edits to this screener' : 'No unsaved edits'}>
          SAVE{dirty ? ' ●' : ''}
        </Btn>
        <Btn onClick={onSaveAs} title="Save these settings as a new screener">SAVE AS…</Btn>
        <Btn tone="danger" onClick={onDelete} title="Delete this screener">DELETE</Btn>
        <Btn tone="go" disabled={busy} onClick={onRun} title="Screen the market with these filters">
          {busy ? 'SCANNING…' : 'RUN ▸'}
        </Btn>
      </div>
    </div>
  )
}

// ── Results ───────────────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  color: GD, fontWeight: 400, fontSize: 10, letterSpacing: 1.6, textAlign: 'left',
  padding: '7px 12px', borderBottom: '1px solid var(--border-strong)',
  position: 'sticky', top: 0, background: PANEL, zIndex: 1,
}
const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: BORDER, fontSize: 12.5 }
const NUM: React.CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function GateStrip({ candidate, def }: { candidate: ScreenerCandidate; def: ScreenerDef }) {
  const cells = gateStrip(candidate, def)
  if (!cells.length) return <span style={{ color: GD, fontSize: 11 }}>—</span>
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {cells.map((cell) => {
        const pass = cell.state === 'pass'
        const degraded = cell.state === 'degraded'
        return (
          <span key={cell.gate} title={cell.title} style={{
            ...MONO, minWidth: 17, height: 17, padding: '0 3px', borderRadius: 2,
            display: 'grid', placeItems: 'center', fontSize: 9, letterSpacing: 0.5,
            fontWeight: pass ? 700 : 400,
            color: pass ? '#000' : degraded ? AMBER : CR,
            background: pass ? G : degraded ? '#f5a6230d' : '#e0245e0d',
            border: `1px solid ${pass ? G : degraded ? '#f5a62355' : '#e0245e55'}`,
            boxShadow: pass ? `0 0 6px ${G}66` : 'none',
          }}>{cell.letter}</span>
        )
      })}
    </div>
  )
}

function ResultsTable({ result, def, selected, onSelect }: {
  result: ScreenerResult; def: ScreenerDef
  selected: string | null; onSelect: (symbol: string) => void
}) {
  if (!result.candidates.length) {
    return <div style={{ padding: 16 }}><Lbl>No symbols in the scanned universe.</Lbl></div>
  }
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr>
          <th style={TH}>#</th>
          <th style={TH}>SYMBOL</th>
          <th style={{ ...TH, textAlign: 'right' }}>LAST</th>
          <th style={{ ...TH, textAlign: 'right' }}>Δ24H</th>
          <th style={{ ...TH, textAlign: 'right' }}>VOL 24H</th>
          <th style={TH}>FIT</th>
          <th style={TH}>GATES</th>
          <th style={{ ...TH, textAlign: 'right' }}>RSI</th>
          <th style={TH}>SETUP</th>
        </tr>
      </thead>
      <tbody>
        {result.candidates.map((c, i) => {
          const blocked = blockedText(c)
          return (
            <tr key={c.symbol} onClick={() => onSelect(c.symbol)} style={{
              cursor: 'pointer', opacity: c.passes ? 1 : 0.55,
              background: selected === c.symbol ? 'linear-gradient(90deg,#0a1a12,#0a1a1200)' : 'transparent',
            }}>
              <td style={{ ...TD, color: c.passes ? AMBER : GD }}>{i + 1}</td>
              <td style={{ ...TD, color: G, letterSpacing: 1, fontSize: 13 }}>{c.symbol}</td>
              <td style={NUM}>{c.last}</td>
              <td style={{ ...NUM, color: (c.change24h ?? 0) >= 0 ? G : CR }}>
                {formatGateValue('change24h', c.change24h)}
              </td>
              <td style={NUM}>{formatGateValue('volume24h', c.volume24h)}</td>
              <td style={TD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 26, textAlign: 'right', color: G, fontSize: 13 }}>{c.fit}</span>
                  <div style={{
                    width: 74, height: 5, borderRadius: 2, position: 'relative',
                    background: 'var(--bg-meter)', overflow: 'hidden',
                  }}>
                    <i style={{
                      position: 'absolute', inset: '0 auto 0 0', width: fitBarWidth(c.fit),
                      background: `linear-gradient(90deg,#0f3d28,${G})`,
                      boxShadow: `0 0 8px ${G}88`,
                    }} />
                  </div>
                </div>
              </td>
              <td style={TD}><GateStrip candidate={c} def={def} /></td>
              <td style={NUM}>{formatGateValue('rsi', c.rsi)}</td>
              <td style={{ ...TD, color: blocked ? CR : 'var(--green-soft)' }}>
                {blocked || (
                  <>
                    {patternLabel(c.pattern)}
                    {c.patternAgeBars != null && (
                      <span style={{ color: GD }}> · {formatGateValue('freshness', c.patternAgeBars)}</span>
                    )}
                    {c.held && <span style={{ color: AMBER }}> · held</span>}
                  </>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function FunnelView({ result }: { result: ScreenerResult }) {
  const top = result.funnel[0]?.survivors || 1
  return (
    <div>
      {result.funnel.map((step) => (
        <div key={step.gate} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: BORDER,
        }}>
          <span style={{ width: 250, fontSize: 12, color: 'var(--green-soft)' }}>{step.label}</span>
          <div style={{ flex: 1, height: 13, background: 'var(--bg-meter)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
            <i style={{
              position: 'absolute', inset: '0 auto 0 0',
              width: `${Math.max(0, Math.min(100, (step.survivors / top) * 100))}%`,
              background: `linear-gradient(90deg,#0f3d28,${G})`, opacity: 0.9,
              boxShadow: `0 0 10px ${G}44`,
            }} />
          </div>
          <span style={{ width: 64, textAlign: 'right', color: G, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
            {step.survivors}
          </span>
          <span style={{ width: 80, textAlign: 'right', color: CR, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {step.killed ? `−${step.killed}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function Drawer({ candidate, def }: { candidate: ScreenerCandidate; def: ScreenerDef }) {
  const failing = candidate.gates.filter((v) => !v.pass)
  const kv = (k: string, v: React.ReactNode, color = 'var(--green-soft)') => (
    <div key={k}>
      <div style={{ fontSize: 9.5, color: GD, letterSpacing: 1.6 }}>{k}</div>
      <div style={{ fontSize: 13, color }}>{v}</div>
    </div>
  )
  return (
    <div style={{
      borderTop: '1px solid var(--border-strong)', background: ELEV,
      padding: '11px 14px', display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center',
    }}>
      {kv('SELECTED', candidate.symbol, G)}
      {kv('TIMEFRAME', timeframeLabel(def.timeframe))}
      {kv('FIT', `${candidate.fit} / 100`)}
      {kv('RSI', formatGateValue('rsi', candidate.rsi))}
      {kv('PATTERN', patternLabel(candidate.pattern))}
      {kv('MKT CAP', formatGateValue('marketCap', candidate.marketCap))}
      {failing.length > 0 && kv(
        'FAILING GATES',
        failing.map((v) => GATE_META[v.gate].label).join(' · '),
        CR,
      )}
    </div>
  )
}

// ── New-screener overlay ──────────────────────────────────────────────────────

type StartFrom = 'blank' | 'copy' | 'strategy'

function NewScreenerOverlay({ screeners, strategies, initialName, onCancel, onCreate }: {
  screeners: ScreenerDef[]
  strategies: Array<{ id: string; label: string }>
  initialName: string
  onCancel: () => void
  onCreate: (body: { name: string; copyFromId?: string; importStrategy?: string }) => void
}) {
  const [name, setName] = useState(initialName)
  const [from, setFrom] = useState<StartFrom>(initialName ? 'copy' : 'blank')
  const [copyId, setCopyId] = useState(screeners[0]?.id ?? '')
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? '')

  const option = (kind: StartFrom, label: string, hint: string, extra?: React.ReactNode) => (
    <div onClick={() => setFrom(kind)} style={{
      border: `1px solid ${from === kind ? G : 'var(--border-strong)'}`,
      background: from === kind ? '#0a1a12' : 'transparent',
      padding: '7px 10px', cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <span style={{ color: from === kind ? G : GD }}>{from === kind ? '●' : '○'}</span>
        <span style={{ color: kind === 'strategy' ? HOLO : 'var(--green-soft)' }}>{label}</span>
        <span style={{ color: GD, fontSize: 11 }}>{hint}</span>
      </div>
      {from === kind && extra}
    </div>
  )

  const picker = (value: string, onChange: (v: string) => void, options: Array<{ id: string; label: string }>) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} onClick={(e) => e.stopPropagation()} style={{
      ...MONO, fontSize: 11, marginTop: 6, width: '100%', padding: '3px 6px',
      background: '#0a1a12', border: '1px solid var(--border-strong)', color: 'var(--green-soft)',
    }}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 10,
      background: 'radial-gradient(ellipse at center,#060d10ee,#03060af5)',
    }}>
      <div style={{
        width: 480, border: '1px solid var(--border-strong)', background: PANEL,
        boxShadow: `0 0 40px ${G}14`, padding: '18px 20px',
      }}>
        <div style={{ letterSpacing: 3, color: G, fontSize: 13, marginBottom: 14, textShadow: `0 0 10px ${G}55` }}>
          ◢ NEW SCREENER
        </div>
        <div style={{ fontSize: 11, color: GD, letterSpacing: 0.5, marginBottom: 6 }}>NAME</div>
        <input
          autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="MOMENTUM BREAKOUTS"
          style={{
            ...MONO, width: '100%', fontSize: 13, letterSpacing: 1, padding: '6px 10px', marginBottom: 16,
            background: '#0a1a12', border: `1px solid ${G}`, color: 'var(--green-soft)',
            boxShadow: `inset 0 0 8px ${G}18`,
          }}
        />
        <div style={{ fontSize: 11, color: GD, letterSpacing: 0.5, marginBottom: 8 }}>START FROM</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {option('blank', 'BLANK', 'all filters off — build from scratch')}
          {option('copy', 'COPY EXISTING', 'start from one of your screeners',
            picker(copyId, setCopyId, screeners.map((s) => ({ id: s.id, label: s.name }))))}
          {option('strategy', 'IMPORT STRATEGY GATES', 'a snapshot copy — never linked back',
            picker(strategyId, setStrategyId, strategies))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn onClick={onCancel}>CANCEL</Btn>
          <Btn tone="go" disabled={!name.trim()} onClick={() => onCreate({
            name: name.trim(),
            ...(from === 'copy' ? { copyFromId: copyId } : {}),
            ...(from === 'strategy' ? { importStrategy: strategyId } : {}),
          })}>CREATE ▸</Btn>
        </div>
      </div>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function ScreenersSection() {
  const [screeners, setScreeners] = useState<ScreenerDef[]>([])
  const [strategies, setStrategies] = useState<Array<{ id: string; label: string }>>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ScreenerDef | null>(null)
  const [result, setResult] = useState<ScreenerResult | null>(null)
  const [view, setView] = useState<'RESULTS' | 'FUNNEL'>('RESULTS')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState<{ open: boolean; seedName: string }>({ open: false, seedName: '' })

  const saved = useMemo(() => screeners.find((s) => s.id === activeId), [screeners, activeId])
  const dirty = !!draft && isDirty(saved, draft)

  const load = useCallback(async (preferId?: string) => {
    const r = await fetchScreeners()
    if (!r.ok) return setError(r.error)
    setScreeners(r.screeners)
    setStrategies(r.strategies)
    const pick = r.screeners.find((s) => s.id === preferId) ?? r.screeners[0]
    if (pick) {
      setActiveId(pick.id)
      setDraft(normalizeScreenerDef(JSON.parse(JSON.stringify(pick))))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (def: ScreenerDef) => {
    setBusy(true)
    setError('')
    const r = await runScreener(def.id, def)
    setBusy(false)
    if (!r.ok) { setResult(null); return setError(r.error) }
    setResult(r.result)
    setSelected(r.result.candidates[0]?.symbol ?? null)
  }, [])

  // Screen once whenever the active screener changes, so switching a chip shows
  // results rather than an empty pane waiting for a click.
  const ranFor = useRef<string | null>(null)
  useEffect(() => {
    if (!draft || ranFor.current === draft.id) return
    ranFor.current = draft.id
    void run(draft)
  }, [draft, run])

  const onSelectChip = (id: string) => {
    const next = screeners.find((s) => s.id === id)
    if (!next) return
    setActiveId(id)
    setDraft(normalizeScreenerDef(JSON.parse(JSON.stringify(next))))
    setResult(null)
  }

  const onSave = async () => {
    if (!draft) return
    const r = await saveScreener(draft.id, {
      name: draft.name, timeframe: draft.timeframe, universe: draft.universe, gates: draft.gates,
    })
    if (!r.ok) return setError(r.error)
    setScreeners((prev) => prev.map((s) => (s.id === r.screener.id ? r.screener : s)))
    setDraft(normalizeScreenerDef(JSON.parse(JSON.stringify(r.screener))))
  }

  const onCreate = async (body: { name: string; copyFromId?: string; importStrategy?: string }) => {
    setCreating({ open: false, seedName: '' })
    const r = await createScreener(body)
    if (!r.ok) return setError(r.error)
    await load(r.screener.id)
  }

  const onSaveAs = async () => {
    if (!draft) return
    // Save-as carries the CURRENT rail, not the last saved state — otherwise the
    // edits that prompted the copy would be the one thing it lost.
    const r = await createScreener({
      name: `${draft.name} COPY`,
      timeframe: draft.timeframe, universe: draft.universe, gates: draft.gates,
    })
    if (!r.ok) return setError(r.error)
    await load(r.screener.id)
  }

  const onDelete = async () => {
    if (!draft) return
    const r = await deleteScreener(draft.id)
    if (!r.ok) return setError(r.error)
    ranFor.current = null
    setResult(null)
    await load()
  }

  if (!draft) {
    return (
      <div style={{ padding: 16 }}>
        <Lbl>{error || 'Loading screeners…'}</Lbl>
      </div>
    )
  }

  const degraded = degradedNote(result?.degradedGates ?? [])
  const selectedCandidate = result?.candidates.find((c) => c.symbol === selected)

  return (
    <div style={{ position: 'relative', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', overflow: 'hidden' }}>
      {/* Saved screener library */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: BORDER, flexWrap: 'wrap' }}>
        <span style={{ color: G, letterSpacing: 4, fontSize: 14, textShadow: `0 0 10px ${G}55` }}>SCREENERS</span>
        <span style={{ color: GD, fontSize: 12 }}>
          {result ? `${result.universe} pairs · ${result.passing} pass` : busy ? 'scanning…' : '—'}
        </span>
        <div style={{ flex: 1 }} />
        {screeners.map((s) => (
          <Chip key={s.id} active={s.id === activeId}
            tone={s.origin.kind === 'strategy' ? 'holo' : 'green'}
            title={s.origin.kind === 'strategy' ? `Started from the ${s.origin.from} strategy's gates` : s.name}
            onClick={() => onSelectChip(s.id)}>
            {s.id === activeId ? '◈ ' : ''}{s.name}
            {s.id === activeId && dirty && <span style={{ color: AMBER }} title="Unsaved edits">●</span>}
          </Chip>
        ))}
        <Chip tone="amber" title="Create a new screener" onClick={() => setCreating({ open: true, seedName: '' })}>
          + NEW
        </Chip>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '236px minmax(0,1fr)', overflow: 'hidden' }}>
        <FilterRail
          draft={draft} dirty={dirty} busy={busy}
          onChange={setDraft}
          onSave={() => { void onSave() }}
          onSaveAs={() => { void onSaveAs() }}
          onDelete={() => { void onDelete() }}
          onRun={() => { void run(draft) }}
        />

        <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0,1fr) auto', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: BORDER }}>
            <span style={{ color: GD, fontSize: 12 }}>
              {result
                ? <><span style={{ color: G }}>{result.passing}</span> pass all gates · sorted by FIT</>
                : error ? <span style={{ color: CR }}>{error}</span> : 'no scan yet'}
            </span>
            {degraded && (
              <span title="A filter had no data for some symbols and was skipped for them"
                style={{ color: AMBER, fontSize: 11, border: '1px solid #f5a62355', padding: '1px 6px' }}>
                ⚠ {degraded}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <Chip active={view === 'RESULTS'} onClick={() => setView('RESULTS')}>RESULTS</Chip>
            <Chip active={view === 'FUNNEL'} onClick={() => setView('FUNNEL')}>FUNNEL</Chip>
          </div>

          <div style={{ overflowY: 'auto' }}>
            {!result
              ? <div style={{ padding: 16 }}><Lbl>{busy ? 'Screening the market…' : error || 'Press RUN to screen.'}</Lbl></div>
              : view === 'RESULTS'
                ? <ResultsTable result={result} def={draft} selected={selected} onSelect={setSelected} />
                : <FunnelView result={result} />}
          </div>

          {selectedCandidate && <Drawer candidate={selectedCandidate} def={draft} />}
        </div>
      </div>

      {creating.open && (
        <NewScreenerOverlay
          screeners={screeners} strategies={strategies} initialName={creating.seedName}
          onCancel={() => setCreating({ open: false, seedName: '' })}
          onCreate={(body) => { void onCreate(body) }}
        />
      )}
    </div>
  )
}
