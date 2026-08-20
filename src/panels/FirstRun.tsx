// ── First-run wizard ───────────────────────────────────────────────────
// Shown once, on a data dir with no setup.json. Four steps: pick the modules you
// want, supply their keys, confirm the devices found in your house, choose what
// opens on launch. Everything here is reachable later from SETTINGS or from the
// HOME tab's TILES editor — the wizard just walks a new user through it instead
// of dropping them into a dashboard full of dead panels.
//
// Nothing is mandatory. Skipping leaves every tab enabled, no keys set, and
// whatever device tiles discovery found on its own.

import { useMemo, useState } from 'react'
import type { LayoutApi } from '../hooks/useLayout'
import { useSecrets } from '../hooks/useSecrets'
import { useHomeAssistant } from '../hooks/useHomeAssistant'
import { useHomeTiles } from '../hooks/useHomeTiles'
import { setSetupComplete } from '../lib/layoutApi'
import { SECRET_SPECS } from '../../shared/secrets'
import { getTileSpec } from '../../shared/homeTileSpecs'
import { TileConfigPanel } from './home/TileConfigPanel'

const btn = (primary = false): React.CSSProperties => ({
  fontSize: 10, letterSpacing: 1, padding: '6px 14px', cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  background: primary ? 'var(--bg-elev)' : 'transparent',
  border: `0.5px solid ${primary ? 'var(--border-strong)' : 'var(--border)'}`,
  color: primary ? 'var(--green)' : 'var(--green-dim)',
})

export function FirstRun({ layout, onDone }: { layout: LayoutApi; onDone: () => void }): JSX.Element {
  const [step, setStep] = useState(0)
  const { layout: l, update } = layout
  const secrets = useSecrets()
  const haSnap = useHomeAssistant()
  const tilesApi = useHomeTiles()
  const [editingTiles, setEditingTiles] = useState(false)
  const haEntities = haSnap?.entities ?? []

  // Modules the user has switched on. Seeded from the layout's enabled tabs so
  // re-running the wizard reflects reality.
  const enabled = useMemo(
    () => new Set(l.tabs.filter((t) => t.enabled).map((t) => t.id)),
    [l.tabs]
  )

  const toggle = (id: string): void =>
    update((cur) => ({ ...cur, tabs: cur.tabs.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)) }))

  // Only ask for keys the user's chosen modules actually need, plus the core ones.
  const relevantSpecs = SECRET_SPECS.filter((s) => !s.module || enabled.has(s.module))
  const statusByKey = new Map(secrets.secrets.map((s) => [s.key, s]))

  const finish = (): void => {
    setSetupComplete(true).catch(() => { /* the wizard is cosmetic; don't block on it */ })
    onDone()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 500, background: 'var(--bg)',
      display: 'grid', gridTemplateRows: '52px 1fr 52px', fontFamily: 'var(--font-mono)',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 18px',
        borderBottom: '0.5px solid var(--border-crimson)',
      }}>
        <span style={{ fontSize: 12, letterSpacing: 3, color: 'var(--green)' }}>HOMUNCULUS · SETUP</span>
        <span style={{ flex: 1 }} />
        {['MODULES', 'KEYS', 'DEVICES', 'LAUNCH'].map((label, i) => (
          <span key={label} style={{
            fontSize: 9, letterSpacing: 2,
            color: i === step ? 'var(--green)' : 'var(--green-dim)',
            textShadow: i === step ? 'var(--glow-green)' : 'none',
          }}>
            {i + 1}. {label}
          </span>
        ))}
      </header>

      <div style={{ overflow: 'auto', padding: 22 }}>
        {step === 0 && (
          <Step
            title="Which modules do you want?"
            note="Turn off anything you don't use — those tabs disappear from the bar. You can change this any time in SETTINGS ▸ TABS, and nothing is deleted when a tab is off."
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
              {l.tabs.map((t) => {
                const on = t.enabled
                const needs = SECRET_SPECS.filter((s) => s.module === t.id && s.required)
                return (
                  <button
                    key={t.id}
                    onClick={() => toggle(t.id)}
                    style={{
                      textAlign: 'left', cursor: 'pointer', padding: 10,
                      background: on ? 'var(--bg-elev)' : 'transparent',
                      border: `0.5px solid ${on ? 'var(--border-strong)' : 'var(--border)'}`,
                      color: on ? 'var(--green)' : 'var(--green-dim)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <div style={{ fontSize: 11, letterSpacing: 2 }}>{on ? '◉' : '○'} {t.label}</div>
                    <div style={{ fontSize: 9, color: 'var(--green-dim)', marginTop: 3 }}>
                      {needs.length > 0 ? `needs ${needs.length} key${needs.length > 1 ? 's' : ''}` : 'no keys required'}
                    </div>
                  </button>
                )
              })}
            </div>
          </Step>
        )}

        {step === 1 && (
          <Step
            title="Keys for the modules you enabled"
            note={secrets.canEdit
              ? 'Stored in your OS keychain, encrypted. Homunculus never shows a key again after you save it, and never writes one to disk unencrypted. Leave any of these blank to skip — the module just runs in its reduced mode.'
              : `Keys can't be entered from here — ${secrets.readOnlyReason}`}
          >
            {relevantSpecs.length === 0
              ? <div style={{ fontSize: 10, color: 'var(--green-dim)' }}>Nothing to configure for the modules you picked.</div>
              : relevantSpecs.map((sp) => (
                <WizardKey
                  key={sp.key}
                  spec={sp}
                  set={statusByKey.get(sp.key)?.set === true}
                  last4={statusByKey.get(sp.key)?.last4 ?? ''}
                  canEdit={secrets.canEdit}
                  onSet={secrets.set}
                />
              ))}
          </Step>
        )}

        {step === 2 && (
          <Step
            title="Devices found in your house"
            note={
              haEntities.length === 0
                ? 'Home Assistant is not reporting anything yet. Set HA_URL and HA_TOKEN on the previous step (or in .env) and Homunculus will scan for devices the moment it connects — you do not have to come back here.'
                : 'Homunculus scanned your Home Assistant and built a tile for each device it recognised. Check the names look right. Anything it guessed wrong — or missed — is fixable here and later, from the TILES button on the HOME tab.'
            }
          >
            {editingTiles ? (
              <TileConfigPanel
                api={tilesApi}
                entities={haEntities}
                onClose={() => setEditingTiles(false)}
              />
            ) : (
              <DiscoverySummary
                tiles={tilesApi.config.tiles}
                entityCount={haEntities.length}
                busy={tilesApi.busy}
                onEdit={() => setEditingTiles(true)}
                onRescan={tilesApi.rescan}
              />
            )}
          </Step>
        )}

        {step === 3 && (
          <Step
            title="Which tab opens on launch?"
            note="You can reorder the tab bar and change this later in SETTINGS ▸ TABS."
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {l.tabs.filter((t) => t.enabled).map((t) => (
                <button
                  key={t.id}
                  onClick={() => update((cur) => ({ ...cur, defaultTab: t.id }))}
                  style={btn(l.defaultTab === t.id)}
                >
                  {l.defaultTab === t.id ? '★' : '☆'} {t.label}
                </button>
              ))}
            </div>
          </Step>
        )}
      </div>

      <footer style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px',
        borderTop: '0.5px solid var(--border-crimson)',
      }}>
        <button onClick={finish} style={btn()}>SKIP SETUP</button>
        <span style={{ flex: 1 }} />
        {step > 0 && <button onClick={() => setStep(step - 1)} style={btn()}>◂ BACK</button>}
        {step < 3
          ? <button onClick={() => setStep(step + 1)} style={btn(true)}>NEXT ▸</button>
          : <button onClick={finish} style={btn(true)}>ENTER HOMUNCULUS</button>}
      </footer>
    </div>
  )
}

function WizardKey({ spec, set, last4, canEdit, onSet }: {
  spec: typeof SECRET_SPECS[number]
  set: boolean
  last4: string
  canEdit: boolean
  onSet: (k: string, v: string) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const commit = async (): Promise<void> => {
    if (!draft) return
    try {
      await onSet(spec.key, draft)
      setDraft('')
      setSaved(true)
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)', maxWidth: 780 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--green)', minWidth: 200 }}>
          {spec.label}{spec.required && <span style={{ color: 'var(--crimson)' }}> *</span>}
        </span>
        <input
          type={spec.kind === 'url' ? 'text' : 'password'}
          value={draft}
          disabled={!canEdit}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
          placeholder={
            set || saved
              ? `saved ••••${last4 || '????'}${canEdit ? ' — type to replace' : ''}`
              : canEdit ? 'paste value, or leave blank' : 'read-only'
          }
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1, fontFamily: 'var(--font-mono)', fontSize: 10, padding: '5px 7px',
            background: 'var(--bg-elev)', border: '0.5px solid var(--border)', color: 'var(--green)',
          }}
        />
        <span style={{ fontSize: 9, color: set || saved ? 'var(--green)' : 'var(--green-dim)', minWidth: 20 }}>
          {set || saved ? '●' : '○'}
        </span>
      </div>
      <div style={{ fontSize: 9, color: 'var(--green-dim)', marginTop: 3, lineHeight: 1.5 }}>
        {spec.hint}
        {spec.docsUrl && <> <DocsLink url={spec.docsUrl} label={spec.docsLabel || 'docs'} /></>}
      </div>
      {err && <div style={{ fontSize: 9, color: 'var(--crimson)', marginTop: 2 }}>{err}</div>}
    </div>
  )
}

/** Link to wherever a credential is issued. Opens in the system browser on both
 *  surfaces — the Electron shell routes window-opens through shell.openExternal. */
export function DocsLink({ url, label }: { url: string; label: string }): JSX.Element {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{ color: 'var(--amber)', textDecoration: 'underline', textUnderlineOffset: 2 }}
    >
      {label} ↗
    </a>
  )
}

/**
 * What discovery found, in one glance.
 *
 * A list, not a wall of dropdowns. The wizard's job at this step is to let a new
 * user confirm that "Washer", "Upstairs" and "Katzenklo" are the things they
 * actually own — the full binding editor is one button away for the cases where
 * they aren't, and unreachable clutter for the majority where they are.
 */
function DiscoverySummary({ tiles, entityCount, busy, onEdit, onRescan }: {
  tiles: ReturnType<typeof useHomeTiles>['config']['tiles']
  entityCount: number
  busy: boolean
  onEdit: () => void
  onRescan: () => void
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 780 }}>
      {tiles.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--green-dim)', lineHeight: 1.6 }}>
          {entityCount === 0
            ? 'Nothing to show yet — no entities have arrived from Home Assistant.'
            : `No devices recognised among ${entityCount} entities. Your integrations may name things unusually; you can bind tiles by hand, and every entity is still listed on the HOME tab under SECTORS and REGISTRY.`}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {tiles.map((tile) => {
            const spec = getTileSpec(tile.type)
            const bound = Object.keys(tile.bindings).length + (tile.rows?.length ?? 0)
            return (
              <div key={tile.id} style={{
                padding: 10, background: 'var(--bg-elev)', border: '0.5px solid var(--border)',
              }}>
                <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green)' }}>
                  <i className={`ti ${spec?.icon ?? 'ti-square'}`} style={{ marginRight: 6 }} />
                  {tile.title || spec?.defaultTitle}
                </div>
                <div style={{ fontSize: 9, color: 'var(--green-dim)', marginTop: 3 }}>
                  {spec?.label} · {bound} {tile.rows ? 'row' : 'entit'}{bound === 1 ? (tile.rows ? '' : 'y') : (tile.rows ? 's' : 'ies')} bound
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onEdit} style={btn(true)}>ADJUST TILES</button>
        <button onClick={onRescan} disabled={busy || entityCount === 0} style={btn()}>
          {busy ? '…' : '⟳ SCAN AGAIN'}
        </button>
      </div>
    </div>
  )
}

function Step({ title, note, children }: {
  title: string; note: string; children: React.ReactNode
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, letterSpacing: 1, color: 'var(--green)' }}>{title}</div>
      <div style={{ fontSize: 10, color: 'var(--green-dim)', lineHeight: 1.6, maxWidth: 760 }}>{note}</div>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  )
}
