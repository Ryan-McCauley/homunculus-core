// The library — the shelf at the bottom of the INTELLIGENCE section.
//
// The board is where employees talk; the library is what they leave behind. Journals and
// minds roll off (server/office.ts caps them); artifacts filed here do not. This panel is
// the reading room: a shelf you can filter, and a reader for one document at a time.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Artifact, ArtifactKind, ArtifactSummary } from '../../shared/library'
import { ARTIFACT_KINDS, ARTIFACT_KIND_LABELS } from '../../shared/library'
import { deleteArtifact, fetchArtifact, fetchLibrary, updateArtifact } from '../lib/libraryApi'

const G = 'var(--green)'
const GD = 'var(--green-dim)'
const GS = 'var(--green-soft)'
const AM = 'var(--amber)'
const CR = 'var(--crimson)'
const BORDER = '0.5px solid var(--border)'
const MONO = { fontFamily: 'var(--font-mono)' } as const

const KIND_COLOR: Record<ArtifactKind, string> = {
  research: G,
  report: GS,
  forecast: 'var(--blue)',
  plan: GS,
  postmortem: CR,
  dataset: GD,
  note: GD
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function when(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function Lbl({ c = GD, size = 11, children }: { c?: string; size?: number; children: React.ReactNode }) {
  return <span style={{ ...MONO, fontSize: size, letterSpacing: 1, color: c }}>{children}</span>
}

function Btn({ children, onClick, color = GD, disabled, title }: {
  children: React.ReactNode; onClick: () => void; color?: string; disabled?: boolean; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 9px', background: 'transparent',
      border: `0.5px solid ${disabled ? 'var(--border)' : color}`,
      color: disabled ? 'var(--border)' : color, cursor: disabled ? 'default' : 'pointer'
    }}>{children}</button>
  )
}

// ── Reader ─────────────────────────────────────────────────────────────────

/** Enough markdown to render a research write-up honestly: headings, bullets, rules,
 *  fenced code and inline emphasis. Anything unrecognised renders as its own literal
 *  text — a document is never reinterpreted into something it does not say. */
function Markdown({ src }: { src: string }) {
  const blocks: React.ReactNode[] = []
  const lines = src.split('\n')
  let list: string[] = []
  let code: string[] | null = null

  const flushList = () => {
    if (!list.length) return
    const items = list
    list = []
    blocks.push(
      <ul key={`u${blocks.length}`} style={{ margin: '4px 0 4px 16px', padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map((t, i) => <li key={i} style={{ ...MONO, fontSize: 13, lineHeight: 1.55, color: GS }}>{inline(t)}</li>)}
      </ul>
    )
  }

  const flushCode = () => {
    if (!code) return
    const body = code.join('\n')
    code = null
    blocks.push(
      <pre key={`c${blocks.length}`} style={{
        ...MONO, fontSize: 12, lineHeight: 1.5, color: GD, background: 'var(--bg-elev)',
        border: BORDER, padding: 8, margin: '6px 0', overflowX: 'auto'
      }}>{body}</pre>
    )
  }

  for (const raw of lines) {
    if (raw.trimStart().startsWith('```')) {
      if (code) flushCode()
      else { flushList(); code = [] }
      continue
    }
    if (code) { code.push(raw); continue }

    const line = raw.trimEnd()
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushList()
      const level = h[1]!.length
      blocks.push(
        <div key={`h${blocks.length}`} style={{
          ...MONO, fontSize: level === 1 ? 15 : level === 2 ? 13 : 12, letterSpacing: 1,
          color: level <= 2 ? G : GS, fontWeight: 700, marginTop: blocks.length ? 12 : 0, marginBottom: 3
        }}>{h[2]}</div>
      )
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) { list.push(line.replace(/^\s*[-*]\s+/, '')); continue }
    if (/^\s*(---|===)\s*$/.test(line)) {
      flushList()
      blocks.push(<div key={`r${blocks.length}`} style={{ borderTop: BORDER, margin: '10px 0' }} />)
      continue
    }
    flushList()
    if (!line.trim()) { blocks.push(<div key={`s${blocks.length}`} style={{ height: 6 }} />); continue }
    blocks.push(
      <div key={`p${blocks.length}`} style={{ ...MONO, fontSize: 13, lineHeight: 1.6, color: GS, whiteSpace: 'pre-wrap' }}>{inline(line)}</div>
    )
  }
  flushList()
  flushCode()
  return <div>{blocks}</div>
}

/** **bold** and `code` only. Deliberately narrow — see Markdown above. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i} style={{ color: G }}>{p.slice(2, -2)}</b>
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) {
      return <code key={i} style={{ background: 'var(--bg-elev)', padding: '0 3px', color: G }}>{p.slice(1, -1)}</code>
    }
    return <span key={i}>{p}</span>
  })
}

function Reader({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [doc, setDoc] = useState<Artifact | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchArtifact(id).then((a) => { if (alive) { setDoc(a); setMissing(!a) } })
    return () => { alive = false }
  }, [id])

  if (missing) {
    return (
      <div style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn onClick={onClose}>← SHELF</Btn><Lbl c={CR}>That artifact is no longer in the library.</Lbl>
      </div>
    )
  }
  if (!doc) return <div style={{ padding: 12 }}><Lbl>Opening…</Lbl></div>

  const kindCol = KIND_COLOR[doc.kind]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: BORDER, flexWrap: 'wrap' }}>
        <Btn onClick={onClose}>← SHELF</Btn>
        <Lbl c={kindCol}>{ARTIFACT_KIND_LABELS[doc.kind]}</Lbl>
        <span style={{ ...MONO, fontSize: 13, letterSpacing: 1, color: GS, fontWeight: 700 }}>{doc.title}</span>
        <Lbl>by @{doc.authorId} · filed {when(doc.createdAt)}{doc.revision > 1 ? ` · rev ${doc.revision}` : ''}</Lbl>
        <div style={{ flex: 1 }} />
        <Btn color={doc.pinned ? AM : GD} title={doc.pinned ? 'Unpin from the top of the shelf' : 'Pin to the top of the shelf'}
          onClick={async () => { await updateArtifact(doc.id, { pinned: !doc.pinned }); setDoc({ ...doc, pinned: !doc.pinned }); onChanged() }}>
          {doc.pinned ? '★ PINNED' : '☆ PIN'}
        </Btn>
        <Btn color={CR} onClick={async () => {
          if (!confirm(`Remove "${doc.title}" from the library? The file is deleted from disk.`)) return
          await deleteArtifact(doc.id)
          onChanged(); onClose()
        }}>REMOVE</Btn>
      </div>

      <div style={{ padding: 12, overflowY: 'auto', minHeight: 0 }}>
        {doc.summary && (
          <div style={{ ...MONO, fontSize: 13, lineHeight: 1.6, color: GD, borderLeft: `2px solid ${kindCol}`, paddingLeft: 9, marginBottom: 12 }}>
            {doc.summary}
          </div>
        )}
        {(doc.symbols.length > 0 || doc.tags.length > 0 || doc.resolvesAt) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {doc.symbols.map((s) => <Lbl key={s} c={GS}>{s}</Lbl>)}
            {doc.tags.map((t) => <Lbl key={t}>#{t}</Lbl>)}
            {doc.resolvesAt && <Lbl c={doc.outcome === 'pending' ? AM : GD}>resolves {when(doc.resolvesAt)} · {doc.outcome}</Lbl>}
          </div>
        )}
        {doc.resolution && (
          <div style={{ border: BORDER, padding: 8, marginBottom: 12 }}>
            <Lbl c={doc.outcome === 'correct' ? G : doc.outcome === 'wrong' ? CR : GD}>OUTCOME · {doc.outcome.toUpperCase()}</Lbl>
            <div style={{ ...MONO, fontSize: 13, color: GS, lineHeight: 1.6, marginTop: 3 }}>{doc.resolution}</div>
          </div>
        )}
        {doc.format === 'markdown'
          ? <Markdown src={doc.body} />
          : <pre style={{ ...MONO, fontSize: 12, lineHeight: 1.55, color: GS, whiteSpace: 'pre-wrap', margin: 0 }}>{doc.body}</pre>}
      </div>
    </div>
  )
}

// ── Shelf ──────────────────────────────────────────────────────────────────

function Row({ a, onOpen }: { a: ArtifactSummary; onOpen: () => void }) {
  const col = KIND_COLOR[a.kind]
  return (
    <div onClick={onOpen} title={a.summary || a.title} style={{
      display: 'flex', alignItems: 'baseline', gap: 9, padding: '6px 9px', cursor: 'pointer',
      border: BORDER, borderLeft: `2px solid ${col}`, background: 'var(--bg-panel)',
      opacity: a.supersededBy ? 0.55 : 1
    }}>
      {a.pinned && <span style={{ ...MONO, fontSize: 11, color: AM }}>★</span>}
      <Lbl c={col} size={10}>{ARTIFACT_KIND_LABELS[a.kind]}</Lbl>
      <span style={{ ...MONO, fontSize: 13, color: GS, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0, maxWidth: '38%' }}>
        {a.title}
      </span>
      <span style={{ ...MONO, fontSize: 11, color: GD, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {a.supersededBy ? 'superseded — ' : ''}{a.summary}
      </span>
      {a.symbols.slice(0, 3).map((s) => <Lbl key={s} c={GS} size={10}>{s}</Lbl>)}
      {a.outcome === 'pending' && <Lbl c={AM} size={10}>PENDING</Lbl>}
      {a.outcome === 'correct' && <Lbl c={G} size={10}>CORRECT</Lbl>}
      {a.outcome === 'wrong' && <Lbl c={CR} size={10}>WRONG</Lbl>}
      <Lbl size={10}>@{a.authorId}</Lbl>
      <Lbl size={10}>{ago(a.updatedAt)}</Lbl>
    </div>
  )
}

/** The shelf. Collapsed it is one strip; open it fills the bottom of the section. */
export function LibraryShelf() {
  const [items, setItems] = useState<ArtifactSummary[]>([])
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState<string | null>(null)
  const [kind, setKind] = useState<ArtifactKind | 'all'>('all')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    try { setItems(await fetchLibrary()) } catch { /* keep last good shelf */ }
  }, [])

  useEffect(() => {
    void load()
    // Agents file documents mid-run, so the shelf refreshes on the section's cadence.
    const t = setInterval(() => void load(), 15000)
    return () => clearInterval(t)
  }, [load])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((a) => {
      if (kind !== 'all' && a.kind !== kind) return false
      if (!needle) return true
      return [a.title, a.summary, a.authorId, ...a.tags, ...a.symbols]
        .join(' ').toLowerCase().includes(needle)
    })
  }, [items, kind, q])

  const pending = items.filter((a) => a.outcome === 'pending').length
  const kindsPresent = ARTIFACT_KINDS.filter((k) => items.some((a) => a.kind === k))

  return (
    <div style={{ borderTop: BORDER, background: 'var(--bg)', display: 'flex', flexDirection: 'column', minHeight: 0, ...(open ? { flex: '0 0 46%' } : {}) }}>
      <div onClick={() => { if (open && reading) setReading(null); else setOpen((v) => !v) }}
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', cursor: 'pointer' }}>
        <span style={{ ...MONO, fontSize: 12, color: GD }}>{open ? '▾' : '▴'}</span>
        <span style={{ ...MONO, fontSize: 13, letterSpacing: 2, color: G }}>LIBRARY</span>
        <Lbl>{items.length} artifact{items.length === 1 ? '' : 's'}</Lbl>
        {pending > 0 && <Lbl c={AM}>{pending} call{pending === 1 ? '' : 's'} awaiting resolution</Lbl>}
        <div style={{ flex: 1 }} />
        {!open && items.length === 0 && <Lbl>Nothing filed yet — employees put research, forecasts and post-mortems here.</Lbl>}
        {!open && items.length > 0 && <Lbl>latest: {items[0]!.title}</Lbl>}
      </div>

      {open && reading && (
        <div style={{ borderTop: BORDER, minHeight: 0, flex: 1 }}>
          <Reader id={reading} onClose={() => setReading(null)} onChanged={load} />
        </div>
      )}

      {open && !reading && (
        <div style={{ borderTop: BORDER, display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 6, padding: '7px 12px', flexWrap: 'wrap', alignItems: 'center' }}>
            {(['all', ...kindsPresent] as const).map((k) => (
              <button key={k} onClick={() => setKind(k as ArtifactKind | 'all')} style={{
                ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 8px', cursor: 'pointer',
                background: kind === k ? 'var(--bg-elev)' : 'transparent',
                border: `0.5px solid ${kind === k ? G : 'var(--border)'}`, color: kind === k ? G : GD
              }}>{k === 'all' ? `ALL · ${items.length}` : `${ARTIFACT_KIND_LABELS[k as ArtifactKind]} · ${items.filter((a) => a.kind === k).length}`}</button>
            ))}
            <div style={{ flex: 1 }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SEARCH TITLE, TAG, SYMBOL…"
              style={{ ...MONO, fontSize: 12, width: 240, padding: '4px 7px', background: 'var(--bg-elev)', border: BORDER, color: GS, outline: 'none' }} />
          </div>

          <div style={{ padding: '0 12px 12px', overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {items.length === 0 && (
              <div style={{ border: BORDER, padding: 12 }}>
                <Lbl>
                  The library is empty. Journals and minds are capped and roll off — this room is not, so it is where an
                  employee files anything meant to be read later: a study with its sample size, a forecast with a
                  resolution date, a post-mortem, a table of base rates nobody should have to re-derive. Agents file
                  here themselves during a run.
                </Lbl>
              </div>
            )}
            {items.length > 0 && shown.length === 0 && <Lbl>No artifact matches that filter.</Lbl>}
            {shown.map((a) => <Row key={a.id} a={a} onOpen={() => setReading(a.id)} />)}
          </div>
        </div>
      )}
    </div>
  )
}
