// THE MANAGER'S FILE — every outstanding question on the desk, in one queue.
//
// An @mention used to wake whoever it named. Replies here routinely name five or six
// colleagues, so one message armed six agents, each of whom woke, replied, and named six
// more — and with a single run slot the desk spent its whole shift talking to itself.
//
// Mentions now land here instead, collapsed to one item per message however many people it
// tagged, and only the desk manager is woken to work the queue. This pane is the operator's
// window onto the same file: you can triage it yourself, or watch the manager do it.
//
// Assigning is the only thing that wakes a colleague, and the instruction is what they act
// on — so an assignment with no ask is refused server-side rather than becoming a mention
// with extra steps.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileItemStatus, ManagerFileItem } from '../../shared/managerFile'
import { MAX_ASSIGNED_PER_AGENT } from '../../shared/managerFile'
import { answerFileItem, assignFileItem, closeFileItem, fetchManagerFile } from '../lib/officeApi'
import type { ManagerFileView, RosterEntry } from '../lib/officeApi'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const GS = 'var(--green-soft)'
const AM = 'var(--amber)'
const CR = 'var(--crimson)'
const BL = 'var(--blue)'
const BORDER = '0.5px solid var(--border)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

function Lbl({ c = GD, size = 11, children }: { c?: string; size?: number; children: React.ReactNode }) {
  return <span style={{ ...MONO, fontSize: size, letterSpacing: 1, color: c }}>{children}</span>
}

function Btn({ children, onClick, color = GD, disabled, title }: {
  children: React.ReactNode; onClick: () => void; color?: string; disabled?: boolean; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      ...MONO, fontSize: 10, letterSpacing: 1, padding: '4px 10px', background: 'transparent',
      border: `0.5px solid ${disabled ? 'var(--border)' : color}`,
      color: disabled ? 'var(--border)' : color, cursor: disabled ? 'default' : 'pointer'
    }}>{children}</button>
  )
}

const STATUS_COLOR: Record<FileItemStatus, string> = {
  new: BL, assigned: AM, answered: G, closed: GD
}

const STATUS_TEXT: Record<FileItemStatus, string> = {
  new: 'NEEDS TRIAGE', assigned: 'OUT WITH', answered: 'ANSWERED', closed: 'CLOSED'
}

function waited(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

// ── One item ───────────────────────────────────────────────────────────────

function Item({ item, roster, held, onChanged }: {
  item: ManagerFileItem
  roster: RosterEntry[]
  /** Open assignments per agent, so the picker can say who is already full. */
  held: Map<string, number>
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'none' | 'assign' | 'answer'>('none')
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const col = STATUS_COLOR[item.status]

  // The names on the message are the manager's first clue at an owner, so the picker
  // offers them first rather than making you find them in an alphabetical list.
  const suggested = useMemo(
    () => roster.filter((r) => item.namedIds.includes(r.id)),
    [roster, item.namedIds]
  )
  const others = useMemo(
    () => roster.filter((r) => !item.namedIds.includes(r.id)),
    [roster, item.namedIds]
  )

  const submit = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    const r = mode === 'assign'
      ? await assignFileItem(item.id, to, body)
      : await answerFileItem(item.id, body)
    setBusy(false)
    if (!r.ok) { alert(r.error ?? 'unknown error'); return }
    setText(''); setTo(''); setMode('none')
    onChanged()
  }

  const close = async () => {
    setBusy(true)
    const r = await closeFileItem(item.id)
    setBusy(false)
    if (!r.ok) { alert(r.error ?? 'unknown error'); return }
    onChanged()
  }

  return (
    <div style={{ border: BORDER, borderLeft: `2px solid ${col}`, background: 'var(--bg-elev)', padding: '8px 10px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Lbl c={col} size={10}>{STATUS_TEXT[item.status]}{item.status === 'assigned' ? ` @${item.assignedTo}` : ''}</Lbl>
        <Lbl c={GD} size={10}>{item.kind === 'blocker' ? '⊘ BLOCKER' : '▤ MENTION'}</Lbl>
        <Lbl c={GS} size={10}>from @{item.fromId} · {waited(Date.now() - item.at)} ago</Lbl>
        {item.threadTitle && <Lbl c={GS} size={10}>“{item.threadTitle.slice(0, 46)}”</Lbl>}
      </div>

      {item.namedIds.length > 0 && (
        <div style={{ marginTop: 3 }}>
          <Lbl c={item.namedIds.length > 2 ? AM : GS} size={10}>
            tagged {item.namedIds.map((n) => `@${n}`).join(' ')}
            {item.namedIds.length > 2 ? `  ← ${item.namedIds.length} names, one decision` : ''}
          </Lbl>
        </div>
      )}

      <div style={{ ...MONO, fontSize: 11, color: 'var(--fg)', marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
        {item.excerpt}
      </div>

      {item.instruction && (
        <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: `1px solid ${AM}` }}>
          <Lbl c={AM} size={10}>→ @{item.assignedTo}: {item.instruction}</Lbl>
        </div>
      )}
      {item.answer && (
        <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: `1px solid ${G}` }}>
          <Lbl c={G} size={10}>← @{item.answeredBy}: {item.answer}</Lbl>
        </div>
      )}

      {item.status !== 'closed' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <Btn color={AM} onClick={() => setMode(mode === 'assign' ? 'none' : 'assign')}
            title="Wake a colleague with a concrete instruction">ASSIGN</Btn>
          <Btn color={G} onClick={() => setMode(mode === 'answer' ? 'none' : 'answer')}
            title="Answer it yourself — no session spent">ANSWER</Btn>
          <Btn color={GD} onClick={close} disabled={busy} title="Handled elsewhere, or not worth a session">CLOSE</Btn>
        </div>
      )}

      {mode !== 'none' && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {mode === 'assign' && (
            <select value={to} onChange={(e) => setTo(e.target.value)} style={{
              ...MONO, fontSize: 11, background: 'var(--bg-panel)', color: 'var(--fg)',
              border: BORDER, padding: '4px 6px'
            }}>
              <option value="">— pick one colleague —</option>
              {suggested.length > 0 && (
                <optgroup label="tagged on this message">
                  {suggested.map((r) => {
                    const n = held.get(r.id) ?? 0
                    return <option key={r.id} value={r.id} disabled={n >= MAX_ASSIGNED_PER_AGENT}>
                      {r.id} — {r.title}{n > 0 ? ` (holding ${n})` : ''}
                    </option>
                  })}
                </optgroup>
              )}
              <optgroup label="everyone else">
                {others.map((r) => {
                  const n = held.get(r.id) ?? 0
                  return <option key={r.id} value={r.id} disabled={n >= MAX_ASSIGNED_PER_AGENT}>
                    {r.id} — {r.title}{n > 0 ? ` (holding ${n})` : ''}
                  </option>
                })}
              </optgroup>
            </select>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={mode === 'assign'
              ? 'What do you want back, and in what form? This is what wakes them and what they act on.'
              : 'The decision, stated plainly.'}
            style={{
              ...MONO, fontSize: 11, background: 'var(--bg-panel)', color: 'var(--fg)',
              border: BORDER, padding: 6, resize: 'vertical', lineHeight: 1.5
            }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn color={mode === 'assign' ? AM : G} disabled={busy || !text.trim() || (mode === 'assign' && !to)}
              onClick={submit}>{busy ? 'SENDING…' : mode === 'assign' ? 'ASSIGN + WAKE' : 'FILE ANSWER'}</Btn>
            <Btn onClick={() => { setMode('none'); setText('') }}>CANCEL</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ── The room ───────────────────────────────────────────────────────────────

export function ManagerFileRoom({ roster }: { roster: RosterEntry[] }) {
  const [file, setFile] = useState<ManagerFileView>({
    items: [], stats: { open: 0, needsTriage: 0, assigned: 0, answered: 0, closed: 0 }, managerId: null
  })
  const [showClosed, setShowClosed] = useState(false)

  const load = useCallback(() => { void fetchManagerFile().then(setFile).catch(() => {}) }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  const held = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of file.items) {
      if (i.status !== 'assigned' || !i.assignedTo) continue
      m.set(i.assignedTo, (m.get(i.assignedTo) ?? 0) + 1)
    }
    return m
  }, [file.items])

  const shown = showClosed ? file.items : file.items.filter((i) => i.status !== 'closed')
  const manager = roster.find((r) => r.id === file.managerId)

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', borderBottom: BORDER, display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Lbl c={G} size={12}>THE MANAGER'S FILE</Lbl>
        {manager
          ? <Lbl c={GS}>worked by {manager.name} (@{manager.id})</Lbl>
          : <Lbl c={CR}>no desk manager on the roster — mentions are filed but nobody is woken to triage them</Lbl>}
        <div style={{ flex: 1 }} />
        <Lbl c={BL}>{file.stats.needsTriage} to triage</Lbl>
        <Lbl c={AM}>{file.stats.assigned} out</Lbl>
        <Lbl c={G}>{file.stats.answered} answered</Lbl>
        <Btn onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'HIDE CLOSED' : `SHOW CLOSED (${file.stats.closed})`}</Btn>
      </div>

      <div style={{ padding: '6px 12px', borderBottom: BORDER }}>
        <Lbl c={GS} size={10}>
          Every @mention on the desk lands here as one item, whoever it tagged. Assigning is the only thing
          that wakes a colleague — each may hold {MAX_ASSIGNED_PER_AGENT} at a time.
        </Lbl>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.length === 0 && <Lbl c={GS}>Nothing outstanding. The desk owes nobody an answer.</Lbl>}
        {shown.map((i) => (
          <Item key={i.id} item={i} roster={roster} held={held} onChanged={load} />
        ))}
      </div>
    </div>
  )
}
