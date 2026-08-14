// The BLOCKERS room — every question an employee is waiting on, and who owes the answer.
//
// This is a queue of decisions, not a feed. It is sorted by how long someone has been
// stuck, because that is the order the answers are worth giving in. An agent holding a
// BLOCKED question has had its automatic wake-ups suppressed server-side, so a row here
// is a genuinely stalled employee, not one that is merely curious.
//
// Answering from this pane unblocks the asker and wakes it with the answer attached.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Blocker } from '../../shared/blockers'
import { BLOCKER_EXPIRY_MS, BLOCKER_STATUS_LABELS, OPERATOR_ID } from '../../shared/blockers'
import { answerBlocker, fetchBlockers, withdrawBlocker } from '../lib/blockersApi'
import type { RosterEntry } from '../lib/officeApi'

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

function waited(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** How loud a row should be. A question waiting a whole shift is a different thing from
 *  one raised five minutes ago, and the list should say so without being read closely. */
function urgency(b: Blocker): string {
  if (b.status !== 'open') return GD
  const age = Date.now() - b.createdAt
  if (age > BLOCKER_EXPIRY_MS * 0.5) return CR
  if (age > 4 * 3_600_000) return AM
  return b.severity === 'blocking' ? BL : GD
}

// ── One row ────────────────────────────────────────────────────────────────

function Row({ b, nameOf, onChanged }: { b: Blocker; nameOf: (id: string) => string; onChanged: () => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const col = urgency(b)
  const isOpen = b.status === 'open'
  // Only the operator can answer from this pane — an agent answers through the API, under
  // its own name, so the record says who actually decided.
  const mine = b.askedOf === OPERATOR_ID

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    const r = await answerBlocker(b.id, text)
    setBusy(false)
    if (!r.ok) { alert(`Could not answer: ${r.error ?? 'unknown error'}`); return }
    setDraft(''); setOpen(false)
    onChanged()
  }

  return (
    <div style={{
      border: BORDER, borderLeft: `2px solid ${col}`, background: 'var(--bg-panel)',
      padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
      opacity: isOpen ? 1 : 0.6
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <Lbl c={col} size={10}>{isOpen ? (b.severity === 'blocking' ? 'BLOCKED' : 'WAITING') : BLOCKER_STATUS_LABELS[b.status]}</Lbl>
        <span style={{ ...MONO, fontSize: 13, color: GS, fontWeight: 700 }}>{nameOf(b.agentId)}</span>
        <Lbl>is waiting on</Lbl>
        <span style={{ ...MONO, fontSize: 13, color: mine ? AM : GS, fontWeight: 700 }}>
          {b.askedOf === OPERATOR_ID ? 'YOU' : nameOf(b.askedOf)}
        </span>
        <div style={{ flex: 1 }} />
        <Lbl c={col}>{waited(Date.now() - b.createdAt)}</Lbl>
        {b.suppressedRuns > 0 && (
          <span title={`${b.suppressedRuns} automatic wake-up${b.suppressedRuns === 1 ? '' : 's'} were suppressed while this stayed open — reminders you did not receive.`}>
            <Lbl size={10}>{b.suppressedRuns} runs held</Lbl>
          </span>
        )}
      </div>

      <div style={{ ...MONO, fontSize: 13, color: GS, lineHeight: 1.55 }}>{b.question}</div>
      {b.why && <div style={{ ...MONO, fontSize: 11, color: GD, lineHeight: 1.5 }}>needs it to: {b.why}</div>}

      {b.status === 'answered' && (
        <div style={{ borderLeft: `2px solid ${G}`, paddingLeft: 8 }}>
          <Lbl c={G} size={10}>@{b.answeredBy} ANSWERED</Lbl>
          <div style={{ ...MONO, fontSize: 12, color: GS, lineHeight: 1.55, marginTop: 2 }}>{b.answer}</div>
          {b.deliveredAt === null && <Lbl c={AM} size={10}>delivering on the next watch tick…</Lbl>}
        </div>
      )}
      {b.status === 'expired' && <Lbl c={CR} size={10}>Never answered — the agent was released to continue after 48h.</Lbl>}

      {isOpen && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {mine && !open && <Btn color={G} onClick={() => setOpen(true)}>ANSWER</Btn>}
          {!mine && <Lbl size={10}>waiting on @{b.askedOf} — answered from their own session</Lbl>}
          <Btn color={CR} onClick={async () => {
            if (!confirm('Withdraw this question? The agent resumes its normal schedule unanswered.')) return
            await withdrawBlocker(b.id)
            onChanged()
          }}>WITHDRAW</Btn>
        </div>
      )}

      {isOpen && open && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <textarea
            value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} autoFocus
            placeholder="Your decision, stated plainly. A clear no unblocks them as well as a yes."
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }}
            style={{
              ...MONO, fontSize: 13, flex: 1, padding: '6px 8px', background: 'var(--bg-elev)',
              border: BORDER, color: GS, outline: 'none', resize: 'vertical', lineHeight: 1.5
            }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Btn color={G} disabled={busy || !draft.trim()} onClick={() => void send()}>SEND</Btn>
            <Btn onClick={() => { setOpen(false); setDraft('') }}>CANCEL</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ── The room ───────────────────────────────────────────────────────────────

export function Blockers({ roster }: { roster: RosterEntry[] }) {
  const [items, setItems] = useState<Blocker[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

  const load = useCallback(async () => {
    try { setItems(await fetchBlockers()); setLoaded(true) } catch { /* keep last good list */ }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [load])

  const nameOf = useCallback(
    (id: string) => (id === OPERATOR_ID ? 'Operator' : roster.find((r) => r.id === id)?.name ?? id),
    [roster]
  )

  const open = useMemo(() => items.filter((b) => b.status === 'open'), [items])
  const closed = useMemo(() => items.filter((b) => b.status !== 'open'), [items])
  const forMe = open.filter((b) => b.askedOf === OPERATOR_ID)
  const between = open.filter((b) => b.askedOf !== OPERATOR_ID)
  const shown = showClosed ? closed : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: BORDER, padding: '10px 12px 8px', flexWrap: 'wrap' }}>
        <span style={{ ...MONO, fontSize: 15, letterSpacing: 2, color: G }}>BLOCKERS</span>
        <Lbl>{open.length} open</Lbl>
        {forMe.length > 0 && <Lbl c={AM}>{forMe.length} waiting on you</Lbl>}
        <div style={{ flex: 1 }} />
        <Btn color={showClosed ? G : GD} onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? '◉' : '○'} RESOLVED ({closed.length})
        </Btn>
      </div>

      <div style={{ padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
        {!loaded && <Lbl>Loading…</Lbl>}

        {loaded && open.length === 0 && !showClosed && (
          <div style={{ border: BORDER, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Lbl c={GS} size={12}>NOBODY IS BLOCKED</Lbl>
            <Lbl>
              When an employee needs a decision it cannot make itself, it raises a question here naming who owes the
              answer — and then it waits. While a question is open its interval and event triggers are suppressed
              server-side, so a stuck agent goes quiet instead of asking again every time it wakes. Answering a row
              releases it and hands it the answer on its next wake.
            </Lbl>
          </div>
        )}

        {forMe.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Lbl c={AM} size={12}>WAITING ON YOU · {forMe.length}</Lbl>
            {forMe.map((b) => <Row key={b.id} b={b} nameOf={nameOf} onChanged={load} />)}
          </div>
        )}

        {between.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Lbl size={12}>BETWEEN EMPLOYEES · {between.length}</Lbl>
            {between.map((b) => <Row key={b.id} b={b} nameOf={nameOf} onChanged={load} />)}
          </div>
        )}

        {showClosed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Lbl size={12}>RESOLVED · {closed.length}</Lbl>
            {closed.length === 0 && <Lbl>Nothing has been answered yet.</Lbl>}
            {shown.map((b) => <Row key={b.id} b={b} nameOf={nameOf} onChanged={load} />)}
          </div>
        )}
      </div>
    </div>
  )
}
