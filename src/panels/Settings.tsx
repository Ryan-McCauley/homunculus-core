// ── SETTINGS ───────────────────────────────────────────────────────────
// Full-screen overlay with the four configuration surfaces:
//   TABS    — order, enable/disable, default tab, add/remove custom tabs
//   WIDGETS — which panels sit on which tab (drag placement happens on the
//             dashboard itself; this is the add/remove/inventory view)
//   KEYS    — API credentials, write-only, keychain-backed. See useSecrets.ts.
//   SYNC    — tailnet peers and the one button that reconciles data/ with them.
//             Rules in shared/sync.ts, machinery in server/sync.ts.

import { useEffect, useState } from 'react'
import type { LayoutApi } from '../hooks/useLayout'
import { useSecrets } from '../hooks/useSecrets'
import { CATEGORIES, WIDGETS, getWidget } from '../widgets/registry'
import { SECRET_SPECS } from '../../shared/secrets'
import { fetchSyncConfig, runSync, saveSyncConfig, type SyncPeerInput } from '../lib/layoutApi'
import { SYNC_AREAS, summarizePeer, type SyncAreaDef, type SyncRunReport } from '../../shared/sync'
import { DocsLink } from './FirstRun'

type Section = 'TABS' | 'WIDGETS' | 'KEYS' | 'SYNC'

const box: React.CSSProperties = {
  border: '0.5px solid var(--border)',
  background: 'var(--bg-elev)',
  padding: 10,
}

const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 10, padding: '4px 6px',
  background: 'var(--bg-elev)', border: '0.5px solid var(--border)', color: 'var(--green)',
}

const btn = (active = false): React.CSSProperties => ({
  fontSize: 9, letterSpacing: 1, padding: '4px 10px', cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  background: active ? 'var(--bg-elev)' : 'transparent',
  border: `0.5px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`,
  color: active ? 'var(--green)' : 'var(--green-dim)',
})

export function Settings({ layout, onClose }: { layout: LayoutApi; onClose: () => void }): JSX.Element {
  const [section, setSection] = useState<Section>('TABS')

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 400,
      background: 'var(--bg)', display: 'grid', gridTemplateRows: '40px 1fr',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px',
        borderBottom: '0.5px solid var(--border-crimson)',
      }}>
        <span style={{ fontSize: 11, letterSpacing: 2, color: 'var(--green)' }}>SETTINGS</span>
        <span style={{ flex: '0 0 12px' }} />
        {(['TABS', 'WIDGETS', 'KEYS', 'SYNC'] as Section[]).map((s) => (
          <button key={s} onClick={() => setSection(s)} style={btn(section === s)}>{s}</button>
        ))}
        <span style={{ flex: 1 }} />
        {layout.error && (
          <span style={{ fontSize: 9, color: 'var(--crimson)', letterSpacing: 1 }}>
            LAYOUT: {layout.error}
          </span>
        )}
        <button onClick={onClose} style={btn()}>✕ CLOSE</button>
      </header>

      <div style={{ overflow: 'auto', padding: 14 }}>
        {section === 'TABS' ? <TabsSection layout={layout} />
          : section === 'WIDGETS' ? <WidgetsSection layout={layout} />
          : section === 'KEYS' ? <KeysSection />
          : <SyncSection />}
      </div>
    </div>
  )
}

// ── TABS ────────────────────────────────────────────────────────────────

function TabsSection({ layout }: { layout: LayoutApi }): JSX.Element {
  const { layout: l, update, reset } = layout
  const [newTab, setNewTab] = useState('')

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= l.tabs.length) return
    update((cur) => {
      const tabs = [...cur.tabs]
      ;[tabs[i], tabs[j]] = [tabs[j], tabs[i]]
      return { ...cur, tabs }
    })
  }

  const toggle = (id: string): void =>
    update((cur) => ({ ...cur, tabs: cur.tabs.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)) }))

  const makeDefault = (id: string): void => update((cur) => ({ ...cur, defaultTab: id }))

  const addTab = (): void => {
    const id = newTab.trim().toUpperCase()
    if (!id || l.tabs.some((t) => t.id === id)) return
    update((cur) => ({ ...cur, tabs: [...cur.tabs, { id, label: id, enabled: true, builtin: false, widgets: [] }] }))
    setNewTab('')
  }

  const removeTab = (id: string): void =>
    update((cur) => ({ ...cur, tabs: cur.tabs.filter((t) => t.id !== id) }))

  const enabledCount = l.tabs.filter((t) => t.enabled).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
      <Note>
        Drag order with ▲▼. The ★ tab opens on launch. Disabling a tab hides it from the
        bar — its widgets are kept, not deleted.
      </Note>

      <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {l.tabs.map((t, i) => {
          const isDefault = l.defaultTab === t.id
          // Never let the user disable the last tab standing — the app would
          // have nothing to render.
          const lastEnabled = t.enabled && enabledCount === 1
          return (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px',
              borderBottom: '0.5px solid var(--border)',
              opacity: t.enabled ? 1 : 0.45,
            }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} style={btn()}>▲</button>
              <button onClick={() => move(i, 1)} disabled={i === l.tabs.length - 1} style={btn()}>▼</button>
              <span style={{ fontSize: 10, letterSpacing: 1, color: 'var(--green)', minWidth: 110 }}>
                {t.label}
              </span>
              <span style={{ fontSize: 9, color: 'var(--green-dim)', minWidth: 90 }}>
                {t.widgets.length} widget{t.widgets.length === 1 ? '' : 's'}
              </span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => makeDefault(t.id)}
                disabled={!t.enabled}
                title={t.enabled ? 'Open this tab on launch' : 'Enable the tab first'}
                style={{ ...btn(isDefault), color: isDefault ? 'var(--green)' : 'var(--green-dim)' }}
              >
                {isDefault ? '★ DEFAULT' : '☆ DEFAULT'}
              </button>
              <button
                onClick={() => toggle(t.id)}
                disabled={lastEnabled}
                title={lastEnabled ? 'At least one tab must stay enabled' : ''}
                style={btn(t.enabled)}
              >
                {t.enabled ? 'ON' : 'OFF'}
              </button>
              {!t.builtin && (
                <button onClick={() => removeTab(t.id)} style={{ ...btn(), color: 'var(--crimson)' }}>✕</button>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={newTab}
          onChange={(e) => setNewTab(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTab() }}
          placeholder="NEW TAB NAME"
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1, padding: '5px 8px',
            background: 'var(--bg-elev)', border: '0.5px solid var(--border)', color: 'var(--green)',
          }}
        />
        <button onClick={addTab} style={btn()}>+ ADD TAB</button>
        <span style={{ flex: 1 }} />
        <button onClick={reset} style={{ ...btn(), color: 'var(--crimson)' }}>RESET LAYOUT TO DEFAULTS</button>
      </div>
    </div>
  )
}

// ── WIDGETS ─────────────────────────────────────────────────────────────

function WidgetsSection({ layout }: { layout: LayoutApi }): JSX.Element {
  const { layout: l, addWidget, removeWidget, moveWidgetToTab } = layout
  const [target, setTarget] = useState(l.tabs[0]?.id ?? '')
  const tab = l.tabs.find((t) => t.id === target) ?? l.tabs[0]

  // Which widgets are already placed anywhere — used to grey out singletons.
  const placedIds = new Set(l.tabs.flatMap((t) => t.widgets.map((w) => w.widget)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Note>
        Position and size are set by dragging on the dashboard itself — hit <b>EDIT LAYOUT</b> in
        the header. This view is for adding, removing, and shifting a widget between tabs.
      </Note>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 9, letterSpacing: 1, color: 'var(--green-dim)' }}>TAB</span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1, padding: '4px 6px',
            background: 'var(--bg-elev)', border: '0.5px solid var(--border)', color: 'var(--green)',
          }}
        >
          {l.tabs.map((t) => (
            <option key={t.id} value={t.id}>{t.label}{t.enabled ? '' : ' (disabled)'}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
        <div style={box}>
          <Head>ON {tab?.label ?? '—'}</Head>
          {!tab || tab.widgets.length === 0
            ? <Dim>Nothing placed yet.</Dim>
            : tab.widgets.map((w) => {
              const def = getWidget(w.widget)
              return (
                <div key={w.instance} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0',
                  borderBottom: '0.5px solid var(--border)',
                }}>
                  <span style={{ fontSize: 10, color: 'var(--green)', flex: 1 }}>
                    {def?.label ?? w.widget}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--green-dim)' }}>{w.w}×{w.h}</span>
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) moveWidgetToTab(tab.id, w.instance, e.target.value) }}
                    title="Move to another tab"
                    style={{
                      fontFamily: 'var(--font-mono)', fontSize: 9, padding: '2px 4px',
                      background: 'transparent', border: '0.5px solid var(--border)', color: 'var(--green-dim)',
                    }}
                  >
                    <option value="">MOVE TO…</option>
                    {l.tabs.filter((t) => t.id !== tab.id).map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                  <button onClick={() => removeWidget(tab.id, w.instance)} style={{ ...btn(), color: 'var(--crimson)' }}>✕</button>
                </div>
              )
            })}
        </div>

        <div style={box}>
          <Head>AVAILABLE</Head>
          {CATEGORIES.map((cat) => {
            const inCat = WIDGETS.filter((w) => w.category === cat)
            if (inCat.length === 0) return null
            return (
              <div key={cat} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 8, letterSpacing: 2, color: 'var(--green-dim)', margin: '6px 0 3px' }}>{cat}</div>
                {inCat.map((w) => {
                  const blocked = w.singleton === true && placedIds.has(w.id)
                  return (
                    <div key={w.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0',
                      opacity: blocked ? 0.4 : 1,
                    }}>
                      <span style={{ fontSize: 10, color: 'var(--green)', flex: 1 }}>{w.label}</span>
                      <button
                        onClick={() => tab && addWidget(tab.id, w.id)}
                        disabled={blocked || !tab}
                        title={blocked ? 'Already placed — this panel can only exist once' : `Add to ${tab?.label}`}
                        style={btn()}
                      >
                        + ADD
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── KEYS ────────────────────────────────────────────────────────────────

function KeysSection(): JSX.Element {
  const s = useSecrets()
  const byKey = new Map(s.secrets.map((x) => [x.key, x]))
  const specs = s.specs.length > 0 ? s.specs : SECRET_SPECS

  const groups = Array.from(new Set(specs.map((sp) => sp.module)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}>
      <Note>
        Keys are encrypted with your operating system's keychain and are <b>never</b> displayed
        again after you save them — only the last four characters, so you can tell one key from
        another. They are sent to the local backend in memory only and never written to disk in
        the clear.
      </Note>

      {!s.canEdit && (
        <div style={{ ...box, borderColor: 'var(--border-crimson)', color: 'var(--crimson)', fontSize: 10, lineHeight: 1.6 }}>
          READ-ONLY HERE — {s.readOnlyReason}
        </div>
      )}
      {s.error && (
        <div style={{ ...box, borderColor: 'var(--border-crimson)', color: 'var(--crimson)', fontSize: 10 }}>
          {s.error}
        </div>
      )}

      {groups.map((mod) => (
        <div key={mod || 'CORE'} style={box}>
          <Head>{mod || 'CORE'}</Head>
          {specs.filter((sp) => sp.module === mod).map((sp) => (
            <KeyRow
              key={sp.key}
              spec={sp}
              status={byKey.get(sp.key)}
              canEdit={s.canEdit}
              onSet={s.set}
              onClear={s.clear}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function KeyRow({ spec, status, canEdit, onSet, onClear }: {
  spec: typeof SECRET_SPECS[number]
  status: { set: boolean; source: string; last4: string } | undefined
  canEdit: boolean
  onSet: (k: string, v: string) => Promise<void>
  onClear: (k: string) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const save = async (): Promise<void> => {
    if (!draft) return
    setBusy(true); setErr('')
    try {
      await onSet(spec.key, draft)
      setDraft('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const set = status?.set === true
  const fromEnv = status?.source === 'env'

  return (
    <div style={{ padding: '7px 0', borderBottom: '0.5px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--green)', minWidth: 180 }}>
          {spec.label}
          {spec.required && <span style={{ color: 'var(--crimson)' }}> *</span>}
        </span>
        <span style={{ fontSize: 9, color: set ? 'var(--green)' : 'var(--green-dim)', minWidth: 150 }}>
          {set ? `● SET ••••${status?.last4 || '??'}${fromEnv ? ' (.env)' : ''}` : '○ NOT SET'}
        </span>
        <input
          type={spec.kind === 'url' ? 'text' : 'password'}
          value={draft}
          disabled={!canEdit || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
          placeholder={canEdit ? (set ? 'enter a new value to replace' : 'paste value') : 'read-only'}
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1, fontFamily: 'var(--font-mono)', fontSize: 10, padding: '4px 6px',
            background: 'var(--bg-elev)', border: '0.5px solid var(--border)', color: 'var(--green)',
          }}
        />
        <button onClick={() => void save()} disabled={!canEdit || !draft || busy} style={btn()}>
          {busy ? '…' : 'SAVE'}
        </button>
        <button
          onClick={() => void onClear(spec.key)}
          disabled={!canEdit || !set || fromEnv}
          title={fromEnv ? 'Set in .env — remove it there' : 'Delete from the keychain'}
          style={{ ...btn(), color: 'var(--crimson)' }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 9, color: 'var(--green-dim)', lineHeight: 1.5, marginTop: 2 }}>
        <code style={{ color: 'var(--green-dim)' }}>{spec.key}</code> — {spec.hint}
        {spec.docsUrl && <> <DocsLink url={spec.docsUrl} label={spec.docsLabel || 'docs'} /></>}
        {spec.restartRequired && (
          <span style={{ color: 'var(--crimson)' }}> Takes effect after a backend restart.</span>
        )}
      </div>
      {err && <div style={{ fontSize: 9, color: 'var(--crimson)', marginTop: 2 }}>{err}</div>}
    </div>
  )
}

// ── SYNC ────────────────────────────────────────────────────────────────
// One button, two directions. Everything it will and will not do is decided in
// shared/sync.ts; this panel only chooses the peers and the areas, and shows
// what the run did. The peer token behaves like a key in KEYS: type it once,
// never see it again.

function SyncSection(): JSX.Element {
  const [areaDefs, setAreaDefs] = useState<SyncAreaDef[]>(SYNC_AREAS)
  const [areas, setAreas] = useState<string[]>([])
  const [peers, setPeers] = useState<SyncPeerInput[]>([])
  const [lastRunAt, setLastRunAt] = useState(0)
  const [nodeName, setNodeName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [report, setReport] = useState<SyncRunReport | null>(null)

  useEffect(() => {
    fetchSyncConfig()
      .then((v) => {
        setAreaDefs(v.areas?.length ? v.areas : SYNC_AREAS)
        setAreas(v.config.areas)
        setPeers(v.config.peers)
        setLastRunAt(v.config.lastRunAt)
        setNodeName(v.config.nodeName)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const save = async (): Promise<void> => {
    setBusy('SAVING'); setError('')
    try {
      const saved = await saveSyncConfig({ peers, areas })
      setPeers(saved.peers)            // tokens come back as hasToken only
      setDirty(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  // Saving first is not a nicety: the run uses the config on the SERVER, so an
  // unsaved peer or a just-ticked area would be silently left out.
  const sync = async (): Promise<void> => {
    setBusy('SYNCING'); setError(''); setReport(null)
    try {
      if (dirty) {
        const saved = await saveSyncConfig({ peers, areas })
        setPeers(saved.peers)
        setDirty(false)
      }
      const r = await runSync()
      setReport(r)
      setLastRunAt(r.at)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const editPeer = (i: number, patch: Partial<SyncPeerInput>): void => {
    setPeers((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)))
    setDirty(true)
  }

  const addPeer = (): void => {
    setPeers((cur) => [...cur, { id: `peer-${Date.now().toString(36)}`, label: '', url: '', enabled: true }])
    setDirty(true)
  }

  const removePeer = (i: number): void => {
    setPeers((cur) => cur.filter((_, j) => j !== i))
    setDirty(true)
  }

  const toggleArea = (id: string): void => {
    setAreas((cur) => (cur.includes(id) ? cur.filter((a) => a !== id) : [...cur, id]))
    setDirty(true)
  }

  const enabledPeers = peers.filter((p) => p.enabled && p.url.trim()).length
  const canSync = enabledPeers > 0 && areas.length > 0 && busy === ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
      <Note>
        Syncs <b>data/</b> with the other Homunculus nodes on your tailnet — both directions in one
        pass, newest edit wins per file. Nothing is ever deleted: a file only one node has is
        copied to the others, so a node that has been off for a week comes back up to date instead
        of dragging everyone back. Each node keeps its own peer list and its own area choices, and
        will refuse a file for an area it has switched off. API keys are not files and do not
        travel — set those in <b>KEYS</b> on each node.
      </Note>

      {error && (
        <div style={{ ...box, borderColor: 'var(--border-crimson)', color: 'var(--crimson)', fontSize: 10 }}>
          {error}
        </div>
      )}

      {/* ── peers ── */}
      <div style={box}>
        <Head>NODES {nodeName && <span style={{ color: 'var(--green-dim)' }}>— this one is {nodeName}</span>}</Head>
        {peers.length === 0 && <Dim>No peers yet. Add the Tailscale name or IP of another node below.</Dim>}
        {peers.map((p, i) => (
          <div key={p.id} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0',
            borderBottom: '0.5px solid var(--border)', opacity: p.enabled ? 1 : 0.45,
          }}>
            <input
              value={p.label}
              onChange={(e) => editPeer(i, { label: e.target.value })}
              placeholder="LABEL"
              style={{ ...inputStyle, width: 130 }}
            />
            <input
              value={p.url}
              onChange={(e) => editPeer(i, { url: e.target.value })}
              placeholder="desk-pc:8787"
              spellCheck={false}
              style={{ ...inputStyle, flex: 1 }}
            />
            <span style={{ fontSize: 9, color: p.hasToken ? 'var(--green)' : 'var(--green-dim)', minWidth: 74 }}>
              {p.hasToken ? '● TOKEN SET' : '○ NO TOKEN'}
            </span>
            <input
              type="password"
              value={p.token ?? ''}
              onChange={(e) => editPeer(i, { token: e.target.value })}
              placeholder={p.hasToken ? 'replace token' : 'peer HOMUNCULUS_TOKEN'}
              autoComplete="off"
              style={{ ...inputStyle, width: 160 }}
            />
            <button onClick={() => editPeer(i, { enabled: !p.enabled })} style={btn(p.enabled)}>
              {p.enabled ? 'ON' : 'OFF'}
            </button>
            <button onClick={() => removePeer(i)} style={{ ...btn(), color: 'var(--crimson)' }}>✕</button>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <button onClick={addPeer} style={btn()}>+ ADD NODE</button>
        </div>
      </div>

      {/* ── areas ── */}
      <div style={box}>
        <Head>WHAT TO SYNC</Head>
        {areaDefs.map((a) => {
          const on = areas.includes(a.id)
          return (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0',
              borderBottom: '0.5px solid var(--border)',
            }}>
              <button onClick={() => toggleArea(a.id)} style={{ ...btn(on), minWidth: 96, textAlign: 'left' }}>
                {on ? '◼' : '◻'} {a.label}
              </button>
              <span style={{ fontSize: 9, color: 'var(--green-dim)', lineHeight: 1.5, flex: 1, paddingTop: 3 }}>
                {a.hint}
              </span>
            </div>
          )
        })}
      </div>

      {/* ── the button ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => void sync()}
          disabled={!canSync}
          title={enabledPeers === 0 ? 'Add and enable at least one node'
            : areas.length === 0 ? 'Tick at least one area' : 'Reconcile every enabled node now'}
          style={{
            ...btn(true), fontSize: 11, padding: '8px 18px',
            borderColor: canSync ? 'var(--border-strong)' : 'var(--border)',
            color: canSync ? 'var(--green)' : 'var(--green-dim)',
          }}
        >
          {busy === 'SYNCING' ? '⟳ SYNCING…' : `⇄ SYNC ALL NODES${enabledPeers ? ` (${enabledPeers})` : ''}`}
        </button>
        <button onClick={() => void save()} disabled={!dirty || busy !== ''} style={btn()}>
          {busy === 'SAVING' ? '…' : dirty ? 'SAVE CHANGES' : 'SAVED'}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: 'var(--green-dim)' }}>
          {lastRunAt ? `LAST RUN ${new Date(lastRunAt).toLocaleString()}` : 'NEVER RUN'}
        </span>
      </div>

      {/* ── report ── */}
      {report && (
        <div style={box}>
          <Head>RESULT</Head>
          {report.peers.length === 0 && <Dim>No enabled nodes to sync.</Dim>}
          {report.peers.map((p) => (
            <div key={p.peerId} style={{ padding: '4px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: 10, color: p.ok ? 'var(--green)' : 'var(--crimson)' }}>
                {summarizePeer(p)} <span style={{ color: 'var(--green-dim)' }}>· {p.ms}ms</span>
              </div>
              {p.conflicts.map((c) => (
                <div key={c.path} style={{ fontSize: 9, color: 'var(--green-dim)', paddingLeft: 10 }}>
                  ⚠ {c.path} — edited on both nodes within seconds of each other, left alone on both
                </div>
              ))}
              {p.failed.map((f) => (
                <div key={f.path} style={{ fontSize: 9, color: 'var(--crimson)', paddingLeft: 10 }}>
                  ✕ {f.path} — {f.error}
                </div>
              ))}
            </div>
          ))}
          <div style={{ fontSize: 9, color: 'var(--green-dim)', marginTop: 6 }}>
            Panels already open keep their old data until they refetch — reload the window to see
            pulled files everywhere.
          </div>
        </div>
      )}
    </div>
  )
}

// ── bits ────────────────────────────────────────────────────────────────

const Head = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div style={{ fontSize: 9, letterSpacing: 2, color: 'var(--green)', marginBottom: 6 }}>{children}</div>
)

const Dim = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div style={{ fontSize: 10, color: 'var(--green-dim)' }}>{children}</div>
)

const Note = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div style={{ fontSize: 10, color: 'var(--green-dim)', lineHeight: 1.6, maxWidth: 700 }}>{children}</div>
)
