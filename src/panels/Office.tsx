// The office floor: the employee directory, individual cubicles (personnel file, journal,
// mind, inbox) and the shared message board.
//
// This is the HR and communication layer. Nothing here changes what an employee is allowed
// to trade — that is the autonomy dial in IntelligenceSection, enforced server-side.

import { useCallback, useEffect, useState } from 'react'
import type {
  BoardThread, CubicleView, Department, EmploymentStatus, PersonnelRecord, SourceRef, Thought
} from '../../shared/office'
import { DEPARTMENTS, EMPLOYMENT_STATUS_LABELS } from '../../shared/office'
import {
  addJournalEntry, fetchBoard, fetchCubicle, fetchRoster, postThread, replyToThread,
  resolveThread, updatePersonnel
} from '../lib/officeApi'
import type { RosterEntry } from '../lib/officeApi'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const GS = 'var(--green-soft)'
const AM = 'var(--amber)'
const CR = 'var(--crimson)'
const BL = 'var(--blue)'
const BORDER = '0.5px solid var(--border)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

const STATUS_COLOR: Record<EmploymentStatus, string> = {
  probation: AM,
  active: G,
  suspended: CR,
  terminated: GD
}

const THOUGHT_COLOR: Record<Thought['kind'], string> = {
  reasoning: GD,
  action: BL,
  observation: GS,
  decision: AM
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
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

const inputStyle = {
  ...MONO, fontSize: 13, padding: '5px 7px', background: 'var(--bg-elev)',
  border: BORDER, color: GS, outline: 'none', width: '100%'
} as const

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <Lbl>{label}</Lbl>
      {children}
    </label>
  )
}

/** Multi-line list editor — one item per line. Résumés and duty lists are lists, and a
 *  line-per-item textarea beats a row-of-inputs widget for something edited this rarely. */
function ListField({ label, value, onChange, rows = 4, placeholder }: {
  label: string; value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string
}) {
  return (
    <Field label={label}>
      <textarea
        rows={rows} placeholder={placeholder} value={value.join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))}
        style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }}
      />
    </Field>
  )
}

/** Renders @mentions as highlighted tokens so a board post reads like a chat message. */
function WithMentions({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9][a-z0-9-]*)/gi)
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      {parts.map((p, i) =>
        p.startsWith('@')
          ? <span key={i} style={{ color: BL, fontWeight: 700 }}>{p}</span>
          : <span key={i}>{p}</span>
      )}
    </span>
  )
}

// ── Personnel file ─────────────────────────────────────────────────────────

function PersonnelFile({ record, roster, onSaved }: {
  record: PersonnelRecord; roster: RosterEntry[]; onSaved: () => void
}) {
  const [p, setP] = useState<PersonnelRecord>(record)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setP(record) }, [record])

  const dirty = JSON.stringify(p) !== JSON.stringify(record)
  const set = <K extends keyof PersonnelRecord>(k: K, v: PersonnelRecord[K]) => setP((prev) => ({ ...prev, [k]: v }))

  const save = async () => {
    setBusy(true)
    await updatePersonnel(p.agentId, {
      title: p.title, department: p.department, status: p.status, reportsTo: p.reportsTo,
      resume: p.resume, jobDescription: p.jobDescription, sources: p.sources, notes: p.notes
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <Field label="TITLE">
          <input value={p.title} onChange={(e) => set('title', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="DEPARTMENT">
          <select value={p.department} onChange={(e) => set('department', e.target.value as Department)} style={inputStyle}>
            {DEPARTMENTS.map((d) => <option key={d} value={d}>{d.toUpperCase()}</option>)}
          </select>
        </Field>
        <Field label="STATUS">
          <select value={p.status} onChange={(e) => set('status', e.target.value as EmploymentStatus)} style={{ ...inputStyle, color: STATUS_COLOR[p.status] }}>
            {(Object.keys(EMPLOYMENT_STATUS_LABELS) as EmploymentStatus[]).map((st) => (
              <option key={st} value={st}>{EMPLOYMENT_STATUS_LABELS[st]}</option>
            ))}
          </select>
        </Field>
        <Field label="REPORTS TO">
          <select value={p.reportsTo ?? ''} onChange={(e) => set('reportsTo', e.target.value || null)} style={inputStyle}>
            <option value="">— the operator —</option>
            {roster.filter((r) => r.id !== p.agentId).map((r) => (
              <option key={r.id} value={r.id}>{r.name} · {r.title}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="PROFILE — the résumé summary">
        <textarea rows={3} value={p.resume.summary}
          onChange={(e) => set('resume', { ...p.resume, summary: e.target.value })}
          style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <ListField label="SPECIALTIES" value={p.resume.specialties}
          onChange={(v) => set('resume', { ...p.resume, specialties: v })} placeholder={'fee-accurate P&L\nledger reconciliation'} />
        <ListField label="BACKGROUND" value={p.resume.background}
          onChange={(v) => set('resume', { ...p.resume, background: v })} placeholder={'61-day honest candle replay\n4,698 decided ledger outcomes'} />
        <ListField label="CREDENTIALS" value={p.resume.credentials}
          onChange={(v) => set('resume', { ...p.resume, credentials: v })} placeholder={'may declare a strategy unprofitable'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <ListField label="RESPONSIBILITIES" value={p.jobDescription.responsibilities} rows={5}
          onChange={(v) => set('jobDescription', { ...p.jobDescription, responsibilities: v })} />
        <ListField label="REVIEWED ON (KPIs)" value={p.jobDescription.kpis} rows={5}
          onChange={(v) => set('jobDescription', { ...p.jobDescription, kpis: v })} />
      </div>

      <Field label="SOURCES — what this employee consults (kind | ref | note)">
        <textarea rows={5}
          value={p.sources.map((s) => `${s.kind} | ${s.ref} | ${s.note}`).join('\n')}
          onChange={(e) => set('sources', e.target.value.split('\n').map((line) => {
            const [kind, ref, ...note] = line.split('|').map((x) => x.trim())
            if (!ref) return null
            const k = (['api', 'file', 'skill', 'doc'] as const).find((x) => x === kind) ?? 'doc'
            return { kind: k, ref, note: note.join(' | ') } as SourceRef
          }).filter((x): x is SourceRef => x !== null))}
          style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }} />
      </Field>

      <Field label="HR NOTES — your own commentary">
        <textarea rows={3} value={p.notes} onChange={(e) => set('notes', e.target.value)}
          style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn color={dirty ? G : GD} disabled={!dirty || busy} onClick={() => void save()}>SAVE FILE</Btn>
        {dirty && <Lbl c={AM}>unsaved changes</Lbl>}
        <div style={{ flex: 1 }} />
        <Lbl>hired {new Date(p.hiredAt).toLocaleDateString()} · updated {ago(p.updatedAt)}</Lbl>
      </div>
    </div>
  )
}

// ── Cubicle ────────────────────────────────────────────────────────────────

export function Cubicle({ agentId, agentName, roster, onClose, onOpenThread }: {
  agentId: string; agentName: string; roster: RosterEntry[]; onClose: () => void
  onOpenThread: (threadId: string) => void
}) {
  const [cub, setCub] = useState<CubicleView | null>(null)
  const [tab, setTab] = useState<'file' | 'journal' | 'mind' | 'inbox'>('file')
  const [note, setNote] = useState('')

  const load = useCallback(async () => { setCub(await fetchCubicle(agentId)) }, [agentId])
  useEffect(() => { void load() }, [load])

  if (!cub) return <div style={{ padding: 12 }}><Lbl>Opening cubicle…</Lbl></div>

  const p = cub.personnel

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: BORDER, paddingBottom: 7 }}>
        <Btn onClick={onClose}>◂ FLOOR</Btn>
        <span style={{ ...MONO, fontSize: 16, letterSpacing: 2, color: G }}>{agentName.toUpperCase()}</span>
        <Lbl c={GS}>{p.employeeId} · {p.title}</Lbl>
        <Lbl>{p.department.toUpperCase()}</Lbl>
        <span style={{ ...MONO, fontSize: 11, letterSpacing: 1, color: STATUS_COLOR[p.status], border: `0.5px solid ${STATUS_COLOR[p.status]}`, padding: '1px 6px' }}>
          {EMPLOYMENT_STATUS_LABELS[p.status]}
        </span>
        <div style={{ flex: 1 }} />
        {cub.inbox.length > 0 && <Lbl c={BL}>◉ {cub.inbox.length} unanswered</Lbl>}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {(['file', 'journal', 'mind', 'inbox'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...MONO, fontSize: 10, letterSpacing: 1, padding: '4px 10px', cursor: 'pointer',
            background: tab === t ? 'var(--bg-elev)' : 'transparent',
            border: `0.5px solid ${tab === t ? G : 'var(--border)'}`, color: tab === t ? G : GD
          }}>
            {t === 'file' ? 'PERSONNEL FILE' : t.toUpperCase()}
            {t === 'inbox' && cub.inbox.length > 0 ? ` ${cub.inbox.length}` : ''}
            {t === 'mind' ? ` ${cub.mind.length}` : ''}
          </button>
        ))}
      </div>

      {tab === 'file' && <PersonnelFile record={p} roster={roster} onSaved={load} />}

      {tab === 'journal' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ADD A NOTE TO THIS EMPLOYEE'S JOURNAL…"
              onKeyDown={async (e) => {
                if (e.key !== 'Enter' || !note.trim()) return
                await addJournalEntry(agentId, { body: note, author: 'operator' })
                setNote(''); void load()
              }}
              style={inputStyle} />
            <Btn color={G} disabled={!note.trim()} onClick={async () => {
              await addJournalEntry(agentId, { body: note, author: 'operator' }); setNote(''); void load()
            }}>ADD</Btn>
          </div>
          {cub.journal.length === 0 && <Lbl>Journal is empty. The employee writes here between runs; you can leave notes too.</Lbl>}
          {cub.journal.map((j) => (
            <div key={j.id} style={{ border: BORDER, padding: 8, background: 'var(--bg-panel)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                {j.title && <Lbl c={GS} size={12}>{j.title}</Lbl>}
                <Lbl c={j.author === 'operator' ? AM : GD}>{j.author === 'operator' ? 'OPERATOR' : 'EMPLOYEE'}</Lbl>
                <Lbl>{ago(j.at)}</Lbl>
                {j.tags.map((t) => <Lbl key={t} c={BL}>#{t}</Lbl>)}
              </div>
              <div style={{ ...MONO, fontSize: 13, color: 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.5, marginTop: 4 }}>{j.body}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'mind' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Lbl>Every thought this employee has had, newest first — captured automatically as they work. Mirrored to <span style={{ color: GS }}>data/crypto/office/{agentId}/mind.md</span>.</Lbl>
          {cub.mind.length === 0 && <Lbl>No thoughts recorded yet.</Lbl>}
          {cub.mind.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: BORDER }}>
              <span style={{ ...MONO, fontSize: 10, color: GD, flexShrink: 0, width: 62 }}>{ago(t.at)}</span>
              <span style={{ ...MONO, fontSize: 10, color: THOUGHT_COLOR[t.kind], flexShrink: 0, width: 78, letterSpacing: 1 }}>{t.kind.toUpperCase()}</span>
              <span style={{ ...MONO, fontSize: 12, color: 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.5, minWidth: 0 }}>{t.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'inbox' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cub.inbox.length === 0 && <Lbl>Inbox clear — no unanswered mentions.</Lbl>}
          {cub.inbox.map((i) => (
            <div key={i.messageId} onClick={() => onOpenThread(i.threadId)}
              style={{ border: `0.5px solid ${BL}`, padding: 8, cursor: 'pointer', background: 'var(--bg-panel)' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <Lbl c={BL}>@{i.fromId}</Lbl>
                <Lbl c={GS}>{i.threadTitle}</Lbl>
                <Lbl>{ago(i.at)}</Lbl>
              </div>
              <div style={{ ...MONO, fontSize: 12, color: GD, marginTop: 3 }}><WithMentions text={i.excerpt} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Directory ──────────────────────────────────────────────────────────────

export function Directory({ roster, onOpen }: { roster: RosterEntry[]; onOpen: (agentId: string) => void }) {
  if (roster.length === 0) {
    return <div style={{ padding: 12 }}><Lbl>No employees on the books yet. Hire one from the FLOOR.</Lbl></div>
  }
  const byDept = new Map<Department, RosterEntry[]>()
  for (const r of roster) {
    const list = byDept.get(r.personnel.department) ?? []
    list.push(r)
    byDept.set(r.personnel.department, list)
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      {[...byDept.entries()].map(([dept, people]) => (
        <div key={dept}>
          <div style={{ borderBottom: BORDER, paddingBottom: 4, marginBottom: 6 }}>
            <Lbl c={GS} size={12}>{dept.toUpperCase()} · {people.length}</Lbl>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {people.map((r) => {
              const p = r.personnel
              const boss = roster.find((x) => x.id === p.reportsTo)
              return (
                <div key={r.id} onClick={() => onOpen(r.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 9px', border: BORDER, background: 'var(--bg-panel)', cursor: 'pointer' }}>
                  <Lbl c={GD} size={11}>{p.employeeId}</Lbl>
                  <div style={{ minWidth: 140 }}>
                    <div style={{ ...MONO, fontSize: 13, color: GS, letterSpacing: 1 }}>{r.name.toUpperCase()}</div>
                    <div style={{ ...MONO, fontSize: 11, color: GD }}>@{r.id}</div>
                  </div>
                  <Lbl c={GS}>{p.title}</Lbl>
                  <span style={{ ...MONO, fontSize: 10, letterSpacing: 1, color: STATUS_COLOR[p.status], border: `0.5px solid ${STATUS_COLOR[p.status]}`, padding: '1px 5px' }}>
                    {EMPLOYMENT_STATUS_LABELS[p.status]}
                  </span>
                  <Lbl>reports to {boss ? boss.name : 'the operator'}</Lbl>
                  <div style={{ flex: 1 }} />
                  {r.inbox > 0 && <Lbl c={BL}>◉ {r.inbox}</Lbl>}
                  <Lbl>{p.sources.length} source{p.sources.length === 1 ? '' : 's'}</Lbl>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Message board ──────────────────────────────────────────────────────────

export function Board({ roster, focusThreadId, onFocusHandled }: {
  roster: RosterEntry[]; focusThreadId?: string | null; onFocusHandled?: () => void
}) {
  const [threads, setThreads] = useState<BoardThread[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reply, setReply] = useState('')

  const load = useCallback(async () => { setThreads(await fetchBoard()) }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!focusThreadId) return
    setOpen(focusThreadId)
    onFocusHandled?.()
  }, [focusThreadId, onFocusHandled])

  const nameOf = (id: string): string => id === 'operator' ? 'OPERATOR' : (roster.find((r) => r.id === id)?.name.toUpperCase() ?? id)
  const thread = threads.find((t) => t.id === open) ?? null

  if (thread) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: BORDER, paddingBottom: 7 }}>
          <Btn onClick={() => setOpen(null)}>◂ BOARD</Btn>
          <span style={{ ...MONO, fontSize: 15, letterSpacing: 1, color: G }}>{thread.title}</span>
          {thread.tags.map((t) => <Lbl key={t} c={BL}>#{t}</Lbl>)}
          <div style={{ flex: 1 }} />
          <Btn color={thread.resolved ? GD : AM} onClick={async () => { await resolveThread(thread.id, !thread.resolved); void load() }}>
            {thread.resolved ? 'REOPEN' : 'RESOLVE'}
          </Btn>
        </div>

        {thread.messages.map((m) => (
          <div key={m.id} style={{ border: BORDER, padding: 9, background: 'var(--bg-panel)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <Lbl c={m.authorId === 'operator' ? AM : G} size={12}>{nameOf(m.authorId)}</Lbl>
              <Lbl>@{m.authorId} · {ago(m.at)}</Lbl>
            </div>
            <div style={{ ...MONO, fontSize: 13, color: 'var(--fg)', lineHeight: 1.55, marginTop: 4 }}>
              <WithMentions text={m.body} />
            </div>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 6 }}>
          <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="REPLY AS OPERATOR — tag with @id…"
            onKeyDown={async (e) => {
              if (e.key !== 'Enter' || !reply.trim()) return
              await replyToThread(thread.id, { authorId: 'operator', body: reply })
              setReply(''); void load()
            }}
            style={inputStyle} />
          <Btn color={G} disabled={!reply.trim()} onClick={async () => {
            await replyToThread(thread.id, { authorId: 'operator', body: reply }); setReply(''); void load()
          }}>POST</Btn>
        </div>
        <Lbl>Tagging an employee puts this in their inbox, and wakes them if they have the @MENTION trigger on.</Lbl>
      </div>
    )
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: BORDER, paddingBottom: 7 }}>
        <span style={{ ...MONO, fontSize: 15, letterSpacing: 2, color: G }}>MESSAGE BOARD</span>
        <Lbl>{threads.filter((t) => !t.resolved).length} open · {threads.length} total</Lbl>
        <div style={{ flex: 1 }} />
        <Btn color={G} onClick={() => setComposing((v) => !v)}>{composing ? 'CANCEL' : '+ NEW THREAD'}</Btn>
      </div>

      {composing && (
        <div style={{ border: `0.5px solid ${G}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-panel)' }}>
          <Field label="SUBJECT">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Q3 capital allocation" style={inputStyle} />
          </Field>
          <Field label="MESSAGE — tag colleagues with @id">
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }} />
          </Field>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Lbl>tag:</Lbl>
            {roster.map((r) => (
              <button key={r.id} onClick={() => setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${r.id} `)}
                style={{ ...MONO, fontSize: 10, padding: '2px 7px', background: 'transparent', border: `0.5px solid ${BL}`, color: BL, cursor: 'pointer' }}>
                @{r.id}
              </button>
            ))}
          </div>
          <div>
            <Btn color={G} disabled={!body.trim()} onClick={async () => {
              await postThread({ authorId: 'operator', title, body })
              setTitle(''); setBody(''); setComposing(false); void load()
            }}>POST AS OPERATOR</Btn>
          </div>
        </div>
      )}

      {threads.length === 0 && !composing && (
        <Lbl>The board is empty. This is where employees post business plans, hand off work, and tag each other.</Lbl>
      )}

      {threads.map((t) => {
        const last = t.messages[t.messages.length - 1]
        const mentioned = [...new Set(t.messages.flatMap((m) => m.mentions))]
        return (
          <div key={t.id} onClick={() => setOpen(t.id)}
            style={{ border: BORDER, padding: 9, cursor: 'pointer', background: 'var(--bg-panel)', opacity: t.resolved ? 0.55 : 1 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Lbl c={t.resolved ? GD : GS} size={13}>{t.title}</Lbl>
              {t.resolved && <Lbl>RESOLVED</Lbl>}
              {t.tags.map((tag) => <Lbl key={tag} c={BL}>#{tag}</Lbl>)}
              <div style={{ flex: 1 }} />
              <Lbl>{t.messages.length} message{t.messages.length === 1 ? '' : 's'} · {ago(t.updatedAt)}</Lbl>
            </div>
            <div style={{ ...MONO, fontSize: 12, color: GD, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ color: GS }}>{nameOf(t.authorId)}:</span> {last ? last.body.slice(0, 160) : ''}
            </div>
            {mentioned.length > 0 && (
              <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                {mentioned.map((id) => <Lbl key={id} c={BL}>@{id}</Lbl>)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function useRoster(): [RosterEntry[], () => void] {
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const load = useCallback(() => { void fetchRoster().then(setRoster).catch(() => {}) }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])
  return [roster, load]
}
