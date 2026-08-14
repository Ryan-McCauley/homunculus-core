import { useCallback, useEffect, useState } from 'react'
import { useTelemetry } from './hooks/useTelemetry'
import { useTheme, THEMES } from './hooks/useTheme'
import { useLayout } from './hooks/useLayout'
import { Clock, stardate } from './components/Clock'
import { WidgetGrid } from './components/WidgetGrid'
import { WidgetContextProvider } from './widgets/registry'
import { Settings } from './panels/Settings'
import { FirstRun } from './panels/FirstRun'
import { useHomeAssistant } from './hooks/useHomeAssistant'
import { useProactiveToasts } from './hooks/useProactiveToasts'
import { useCryptoPositions } from './hooks/useCryptoPositions'
import { ToastOverlay } from './components/ToastOverlay'
import { fetchSetupComplete } from './lib/layoutApi'
import { resolveDefaultTab } from '../shared/layout'
import { uptime } from './lib/format'
import { VERSION, COMMIT, BUILD_DATE } from './lib/version'

function sendHaCmd(entityId: string, service: string, data: Record<string, unknown>): void {
  window.homunculus?.sendHaCommand(entityId, service, data)
}

export default function App(): JSX.Element {
  const data = useTelemetry()
  const haSnap = useHomeAssistant()
  const haEntities = haSnap?.entities ?? []
  const [theme, setTheme] = useTheme()
  // Server-driven: every connected-thing event arrives on the proactive channel
  // (already archived) and is surfaced here as a toast. See server/homewatch.ts.
  useProactiveToasts()
  // Single poll of open crypto positions — feeds both the header ticker and the
  // OpenTradesWidget wherever the user has placed it.
  const crypto = useCryptoPositions()

  // ── Layout-driven shell ────────────────────────────────────────────────
  // Which tabs exist, their order, which are on, which opens first, and what
  // sits inside each one all come from the server (see shared/layout.ts).
  const layout = useLayout()
  const { layout: cfg, loaded } = layout
  const tabs = cfg.tabs.filter((t) => t.enabled)

  const [tab, setTab] = useState('')
  const [editing, setEditing] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [dropTarget, setDropTarget] = useState('')
  const [showWizard, setShowWizard] = useState(false)

  // Pick the launch tab once the real layout lands, and keep the selection
  // valid if the active tab is later disabled or deleted from SETTINGS.
  useEffect(() => {
    if (!loaded) return
    if (tab && tabs.some((t) => t.id === tab)) return
    setTab(resolveDefaultTab(cfg))
  }, [loaded, cfg, tab, tabs])

  useEffect(() => {
    fetchSetupComplete()
      .then((complete) => setShowWizard(!complete))
      .catch(() => setShowWizard(false)) // no backend answer → don't block the UI
  }, [])

  const active = cfg.tabs.find((t) => t.id === tab)

  // ── Cross-tab widget drag ──────────────────────────────────────────────
  // The grid reports pointer position while dragging; if the cursor is over a
  // different tab's chip on drop, the widget moves to that tab instead of being
  // repositioned on this one. Tab chips carry data-tab for the hit test.
  const tabUnderCursor = (x: number, y: number): string => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    return el?.closest<HTMLElement>('[data-tab]')?.dataset['tab'] ?? ''
  }

  const onDragOver = useCallback((x: number, y: number) => {
    const over = tabUnderCursor(x, y)
    setDropTarget(over && over !== tab ? over : '')
  }, [tab])

  const onDropOutside = useCallback((instance: string, x: number, y: number): boolean => {
    setDropTarget('')
    const over = tabUnderCursor(x, y)
    if (!over || over === tab) return false
    layout.moveWidgetToTab(tab, instance, over)
    return true
  }, [layout, tab])

  return (
    <WidgetContextProvider value={{ telemetry: data, haEntities, sendHaCmd, crypto }}>
      <div
        className="crt-scan"
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateRows: '70px 22px 1fr 30px',
          background: 'var(--bg)'
        }}
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 16px',
            borderBottom: '0.5px solid var(--border-crimson)',
            background: 'linear-gradient(180deg, var(--header-top), var(--header-bot))'
          }}
        >
          <Clock />
          <div style={{ fontSize: 9, lineHeight: 1.5, color: 'var(--green-dim)', letterSpacing: 1 }}>
            STARDATE <b style={{ color: 'var(--green)' }}>{stardate()}</b>
            <br />
            UPTIME <b style={{ color: 'var(--green)' }}>{data ? uptime(data.uptimeSec) : '—'}</b> · WIRED
            <br />
            <span>HOMUNCULUS // CORE LINK</span>
          </div>
          <nav style={{ display: 'flex', gap: 2, flex: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
            {tabs.map((t) => {
              const isActive = t.id === tab
              const isDrop = dropTarget === t.id
              return (
                <span
                  key={t.id}
                  data-tab={t.id}
                  onClick={() => setTab(t.id)}
                  title={editing ? 'Drop a widget here to move it to this tab' : undefined}
                  style={{
                    fontSize: 10,
                    letterSpacing: 1,
                    padding: '5px 11px',
                    color: isActive || isDrop ? 'var(--green)' : 'var(--green-dim)',
                    background: isDrop ? 'var(--bg-elev)' : isActive ? 'var(--tab-active-bg)' : 'var(--tab-inactive-bg)',
                    borderTop: `0.5px solid ${isActive || isDrop ? 'var(--border-strong)' : 'var(--border)'}`,
                    borderRight: `0.5px solid ${isActive || isDrop ? 'var(--border-strong)' : 'var(--border)'}`,
                    borderLeft: `0.5px solid ${isActive || isDrop ? 'var(--border-strong)' : 'var(--border)'}`,
                    borderBottom: 'none',
                    outline: isDrop ? '1px dashed var(--green)' : 'none',
                    textShadow: isActive ? `0 0 8px var(--tab-glow)` : 'none',
                    cursor: 'pointer'
                  }}
                >
                  {t.label}
                </span>
              )
            })}
          </nav>
          <div style={{ display: 'flex', gap: 2 }}>
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                style={{
                  fontSize: 9,
                  letterSpacing: 1,
                  padding: '4px 8px',
                  background: theme === t.id ? 'var(--bg-elev)' : 'transparent',
                  border: `0.5px solid ${theme === t.id ? 'var(--border-strong)' : 'var(--border)'}`,
                  color: theme === t.id ? 'var(--green)' : 'var(--green-dim)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textShadow: theme === t.id ? 'var(--glow-green)' : 'none',
                }}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setEditing((v) => !v)}
            title="Drag widgets to move and resize them; drop one on a tab to send it there"
            style={{
              fontSize: 9, letterSpacing: 1, padding: '4px 8px', cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              background: editing ? 'var(--bg-elev)' : 'transparent',
              border: `0.5px solid ${editing ? 'var(--border-strong)' : 'var(--border)'}`,
              color: editing ? 'var(--green)' : 'var(--green-dim)',
            }}
          >
            {editing ? '✓ DONE' : '⠿ EDIT LAYOUT'}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{
              fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontFamily: 'var(--font-mono)',
              background: 'transparent', border: '0.5px solid var(--border)', color: 'var(--green-dim)',
            }}
          >
            ⚙
          </button>
          <span
            style={{
              fontSize: 9,
              letterSpacing: 2,
              color: 'var(--crimson)',
              border: '0.5px solid var(--border-crimson)',
              padding: '3px 8px'
            }}
          >
            CLEARANCE: PRIME
          </span>
        </header>

        {/* ── Telemetry ticker ────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            padding: '0 16px',
            background: 'var(--ticker-bg)',
            borderBottom: '0.5px solid var(--border)',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            fontSize: 9,
            letterSpacing: 1,
            color: 'var(--green-dim)'
          }}
        >
          <Tick k="CORE LOAD" v={data ? `${data.cpu.load}%` : '—'} />
          <Tick k="MEM" v={data ? `${data.memory.percent}%` : '—'} />
          <Tick k="NET" v={data ? `↓${data.network.rxMbps} ↑${data.network.txMbps} Mb/s` : '—'} />
          <Tick k="STORAGE" v={data ? `${data.storage.percent}%` : '—'} />
          <Tick k="TASKS" v={data ? String(data.tasks) : '—'} />
          <CryptoTick crypto={crypto} />
          <Tick k="THREATS" v="0" alert />
          <Tick k="MESH" v="3 NODES" />
          {editing && (
            <span style={{ marginLeft: 'auto', color: 'var(--green)' }}>
              LAYOUT EDIT — drag headers to move, corner to resize, drop on a tab to relocate
            </span>
          )}
        </div>

        {/* ── Body: the active tab's widget grid ──────────────── */}
        <div style={{ background: 'var(--bg)', overflow: 'hidden', position: 'relative' }}>
          {active ? (
            <WidgetGrid
              key={active.id}
              widgets={active.widgets}
              editing={editing}
              onChange={(next) => layout.setTabWidgets(active.id, next)}
              onRemove={(instance) => layout.removeWidget(active.id, instance)}
              onDragOver={onDragOver}
              onDropOutside={onDropOutside}
            />
          ) : (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--green-dim)', fontSize: 10, letterSpacing: 2,
            }}>
              {loaded ? 'NO TABS ENABLED — OPEN ⚙ SETTINGS' : 'LOADING LAYOUT…'}
            </div>
          )}
        </div>

        <ToastOverlay />

        {/* ── Footer ──────────────────────────────────────────── */}
        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '0 16px',
            background: 'linear-gradient(0deg, var(--header-top), var(--header-bot))',
            borderTop: '0.5px solid var(--border-crimson)',
            fontSize: 8,
            letterSpacing: 2,
            color: 'var(--green-dim)'
          }}
        >
          <span style={{ color: 'var(--crimson)' }}>● SECURE CHANNEL</span>
          <span>AES-256</span>
          <span>TAILSCALE MESH</span>
          <span>CLAUDE CORE</span>
          <span
            title={`Homunculus v${VERSION} · ${COMMIT}${BUILD_DATE ? ` · built ${BUILD_DATE}` : ''}`}
          >
            BUILD <b style={{ color: 'var(--green)' }}>v{VERSION}</b>
            <span style={{ color: 'var(--green-dim)' }}> · {COMMIT}</span>
          </span>
          <span style={{ flex: 1 }} />
          <span>STARDATE {stardate()}</span>
        </footer>
      </div>

      {showSettings && <Settings layout={layout} onClose={() => setShowSettings(false)} />}
      {showWizard && loaded && <FirstRun layout={layout} onDone={() => setShowWizard(false)} />}
    </WidgetContextProvider>
  )
}

function Tick({ k, v, alert }: { k: string; v: string; alert?: boolean }): JSX.Element {
  return (
    <span>
      {k} <b style={{ color: alert ? 'var(--crimson)' : 'var(--green)' }}>{v}</b>
    </span>
  )
}

// Compact crypto open-P&L readout for the header ticker. Colour tracks sign;
// dims to neutral when there are no open positions or the feed isn't up yet.
function CryptoTick({ crypto }: { crypto: ReturnType<typeof useCryptoPositions> }): JSX.Element {
  const { positions, totalUnrealUsd, loaded } = crypto
  const has = positions.length > 0
  const color = !loaded || !has
    ? 'var(--green-dim)'
    : totalUnrealUsd >= 0 ? 'var(--green)' : 'var(--crimson)'
  const v = !loaded ? '—' : !has ? 'FLAT' : `${totalUnrealUsd >= 0 ? '+' : '−'}$${Math.abs(totalUnrealUsd).toFixed(2)}`
  return (
    <span>
      CRYPTO P&L <b style={{ color }}>{v}</b>
      {has && <b style={{ color: 'var(--green-dim)', marginLeft: 4 }}>({positions.length})</b>}
    </span>
  )
}
