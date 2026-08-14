// ── Widget registry ────────────────────────────────────────────────────
// Every panel that can be placed on a dashboard, described as data. This is the
// only file that needs touching to make a new panel placeable: add an entry and
// it shows up in SETTINGS → WIDGETS, draggable onto any tab.
//
// Panels differ in what they need (telemetry snapshot, HA entities, crypto
// positions, nothing). Rather than plumb props through the grid, each entry
// renders from `useWidgetContext()` — so from the grid's point of view every
// widget is a zero-prop component and placement stays generic.

import { createContext, useContext } from 'react'
import type { TelemetrySnapshot } from '../../shared/telemetry'
import type { HaEntity } from '../../shared/homeassistant'
import type { useCryptoPositions } from '../hooks/useCryptoPositions'

import { SystemVitals } from '../panels/SystemVitals'
import { ComputerCore } from '../panels/ComputerCore'
import { Terminal } from '../panels/Terminal'
import { HomeAssistant } from '../panels/HomeAssistant'
import { HomeDashboard } from '../panels/HomeDashboard'
import { OsintDashboard } from '../panels/OsintDashboard'
import { DataDashboard } from '../panels/DataDashboard'
import { ArchiveDashboard } from '../panels/ArchiveDashboard'
import { CryptoDashboard } from '../panels/CryptoDashboard'
import { OpenTradesWidget } from '../panels/OpenTradesWidget'
import { LaundryStatus, LitterRobotStatus, ColonyTile, AmbientTile } from '../panels/HoloTiles'
import { Placeholder } from '../components/Placeholder'

// ── Shared context ──────────────────────────────────────────────────────

export interface WidgetContextValue {
  telemetry: TelemetrySnapshot | null
  haEntities: HaEntity[]
  sendHaCmd: (entityId: string, service: string, data: Record<string, unknown>) => void
  crypto: ReturnType<typeof useCryptoPositions>
}

const Ctx = createContext<WidgetContextValue | null>(null)

export const WidgetContextProvider = Ctx.Provider

export function useWidgetContext(): WidgetContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWidgetContext outside <WidgetContextProvider>')
  return v
}

// ── Registry ────────────────────────────────────────────────────────────

export interface WidgetDef {
  id: string
  label: string
  /** Grouping in the widget picker. */
  category: 'CORE' | 'HOME' | 'CRYPTO' | 'DASHBOARD' | 'MISC'
  /** Default grid footprint when dropped fresh (12-col grid, ROW_H units). */
  defaultW: number
  defaultH: number
  minW: number
  minH: number
  /** Some panels are singletons — a second Terminal instance would fight the
   *  first over its PTY session id. */
  singleton?: boolean
  render: () => JSX.Element | null
}

const def = (d: WidgetDef): WidgetDef => d

export const WIDGETS: WidgetDef[] = [
  def({
    id: 'system.vitals', label: 'System Vitals', category: 'CORE',
    defaultW: 2, defaultH: 24, minW: 2, minH: 8,
    render: () => <SystemVitals data={useWidgetContext().telemetry} />,
  }),
  def({
    id: 'core.terminal', label: 'Terminal', category: 'CORE', singleton: true,
    defaultW: 6, defaultH: 12, minW: 3, minH: 6,
    render: () => <Terminal />,
  }),
  def({
    id: 'core.computer', label: 'Computer Core', category: 'CORE', singleton: true,
    defaultW: 6, defaultH: 12, minW: 3, minH: 6,
    render: () => <ComputerCore />,
  }),

  def({
    id: 'home.assistant', label: 'Home Assistant', category: 'HOME',
    defaultW: 2, defaultH: 6, minW: 2, minH: 4,
    render: () => <HomeAssistant />,
  }),
  def({
    id: 'home.laundry', label: 'Laundry', category: 'HOME',
    defaultW: 2, defaultH: 4, minW: 2, minH: 3,
    render: () => {
      const { haEntities, sendHaCmd } = useWidgetContext()
      return <LaundryStatus entities={haEntities} send={sendHaCmd} />
    },
  }),
  def({
    id: 'home.litter', label: 'Litter Robot', category: 'HOME',
    defaultW: 2, defaultH: 4, minW: 2, minH: 3,
    render: () => {
      const { haEntities, sendHaCmd } = useWidgetContext()
      return <LitterRobotStatus entities={haEntities} send={sendHaCmd} />
    },
  }),
  def({
    id: 'home.colony', label: 'Colony', category: 'HOME',
    defaultW: 2, defaultH: 4, minW: 2, minH: 3,
    render: () => <ColonyTile entities={useWidgetContext().haEntities} />,
  }),
  def({
    id: 'home.ambient', label: 'Ambient', category: 'HOME',
    defaultW: 2, defaultH: 4, minW: 2, minH: 3,
    render: () => <AmbientTile entities={useWidgetContext().haEntities} />,
  }),

  def({
    id: 'crypto.opentrades', label: 'Open Trades', category: 'CRYPTO',
    defaultW: 2, defaultH: 6, minW: 2, minH: 4,
    render: () => <OpenTradesWidget data={useWidgetContext().crypto} />,
  }),

  // The whole-tab dashboards. They were hardcoded tab bodies before; as widgets
  // they can be moved, resized, or stacked next to anything else.
  def({ id: 'dash.home', label: 'HOME dashboard', category: 'DASHBOARD', defaultW: 12, defaultH: 24, minW: 4, minH: 8, singleton: true, render: () => <HomeDashboard /> }),
  def({ id: 'dash.osint', label: 'OSINT dashboard', category: 'DASHBOARD', defaultW: 12, defaultH: 24, minW: 4, minH: 8, singleton: true, render: () => <OsintDashboard /> }),
  def({ id: 'dash.data', label: 'DATA dashboard', category: 'DASHBOARD', defaultW: 12, defaultH: 24, minW: 4, minH: 8, singleton: true, render: () => <DataDashboard /> }),
  def({ id: 'dash.archive', label: 'ARCHIVE dashboard', category: 'DASHBOARD', defaultW: 12, defaultH: 24, minW: 4, minH: 8, singleton: true, render: () => <ArchiveDashboard /> }),
  def({ id: 'dash.crypto', label: 'CRYPTO dashboard', category: 'DASHBOARD', defaultW: 12, defaultH: 24, minW: 4, minH: 8, singleton: true, render: () => <CryptoDashboard /> }),

  def({
    id: 'misc.network', label: 'Network Status', category: 'MISC',
    defaultW: 2, defaultH: 4, minW: 2, minH: 3,
    render: () => <Placeholder label="Network Status" note="uplink module pending" />,
  }),
  def({
    id: 'misc.traffic', label: 'Network Traffic', category: 'MISC',
    defaultW: 2, defaultH: 5, minW: 2, minH: 3,
    render: () => <Placeholder label="Network Traffic" note="graph pending" flex={1} />,
  }),
]

const BY_ID = new Map(WIDGETS.map((w) => [w.id, w]))

export const getWidget = (id: string): WidgetDef | undefined => BY_ID.get(id)

export const CATEGORIES: WidgetDef['category'][] = ['CORE', 'DASHBOARD', 'HOME', 'CRYPTO', 'MISC']
