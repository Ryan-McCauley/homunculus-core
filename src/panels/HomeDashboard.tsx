// The full-width HOME tab.
//
// Four sub-views under one masthead. OVERVIEW is the original dashboard — the
// same thermostat, ambient, litter, laundry and colony tiles in the same
// SplitPane — with a scene strip, a sector strip, and a perimeter/power/media row
// added around it. SECTORS, REGISTRY and AUTOMATA are the rest of Home Assistant,
// and the ⌘K uplink compiles typed instructions into confirmable service calls.
//
// Which view is showing lives in the URL rather than in component state (see
// useHomeRoute), so every state of this tab is a link an operator can share and
// an address an agent can navigate to.

import { useEffect, useMemo } from 'react'
import { useHomeAssistant } from '../hooks/useHomeAssistant'
import { useHomeRoute } from '../hooks/useHomeRoute'
import { SplitPane } from '../components/SplitPane'
import { indexById } from '../lib/ha'
import { buildSectors, findSector } from '../../shared/haSectors'
import { LaundryTile, R2peepooTile, ColonyTile, ThermostatTile, AmbientTile } from './HoloTiles'
import { SubTabRail } from './home/SubTabRail'
import { SceneStrip, SectorStrip, PerimeterTile, PowerTile, MediaTile } from './home/OverviewExtras'
import { SectorsView } from './home/SectorsView'
import { DevicesView } from './home/DevicesView'
import { RegistryView } from './home/RegistryView'
import { AutomataView } from './home/AutomataView'
import { UplinkPalette } from './home/UplinkPalette'

function sendCmd(entityId: string, service: string, data: Record<string, unknown>): void {
  window.homunculus?.sendHaCommand(entityId, service, data)
}

export function HomeDashboard(): JSX.Element {
  const snap = useHomeAssistant()
  const [route, navigate] = useHomeRoute()

  const connected = snap?.connected ?? null
  const entities = useMemo(() => snap?.entities ?? [], [snap])
  const unit = snap?.tempUnit ?? '°F'
  const idx = indexById(entities)

  const sectors = useMemo(() => buildSectors(entities, snap?.areas ?? null), [entities, snap?.areas])
  const selectedSector = findSector(sectors, route.sector)

  // ⌘K from anywhere in the tab. The palette itself owns Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        navigate({ ...route, uplink: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [route, navigate])

  // Masthead alert tally — the waste drawer, plus anything a sector flagged.
  const alerts: string[] = []
  const waste = Number(idx.get('sensor.r2peepoo_waste_drawer')?.state)
  if (Number.isFinite(waste) && waste >= 80) alerts.push('WASTE DRAWER FULL')
  for (const sector of sectors) alerts.push(...sector.alerts)

  const automataCount = entities.filter(
    (e) => e.domain === 'scene' || e.domain === 'script' || e.domain === 'automation',
  ).length

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', position: 'relative' }}>
      {/* masthead */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-crimson)',
          paddingBottom: 9,
          marginBottom: 14
        }}
      >
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, letterSpacing: 4, color: 'var(--green)', textShadow: '0 0 10px #00ff6655' }}>
          <i className="ti ti-home-bolt" style={{ marginRight: 8 }} />DOMICILE OPERATIONS
        </div>
        <div style={{ fontSize: 13, letterSpacing: 2, color: 'var(--green-dim)' }}>
          {connected == null ? 'LINKING…' : connected ? <>{entities.length} SUBSYSTEMS · <span style={{ color: 'var(--green)' }}>ALL LINKED</span></> : <span style={{ color: 'var(--crimson)' }}>OFFLINE</span>}
          {alerts.length > 0 && <> · <span style={{ color: 'var(--crimson)' }}>{alerts.length} ALERT{alerts.length > 1 ? 'S' : ''}</span></>}
        </div>
      </div>

      <SubTabRail
        route={route}
        counts={{ sectors: sectors.length, registry: entities.length, automata: automataCount }}
        onNavigate={navigate}
        onOpenUplink={() => navigate({ ...route, uplink: true })}
      />

      {connected === false && entities.length === 0 && (
        <div className="card" style={{ fontSize: 14, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 24 }}>
          HOME ASSISTANT OFFLINE — CHECK HA_URL + HA_TOKEN IN .ENV
        </div>
      )}

      {route.view === 'overview' && (
        <>
          <SceneStrip entities={entities} send={sendCmd} />
          <SectorStrip sectors={sectors} unit={unit} onSelect={(sector) => navigate({ view: 'sectors', sector })} />

          {/* top row: thermostat + ambient + cats */}
          <SplitPane storageKey="home-top" config={[
            { key: 'thermostat' }, { key: 'ambient' }, { key: 'cats' },
          ]}>
            <ThermostatTile entities={entities} unit={unit} send={sendCmd} />
            <AmbientTile entities={entities} />
            <R2peepooTile entities={entities} send={sendCmd} />
          </SplitPane>

          {/* laundry bay — full width */}
          <div style={{ marginTop: 12 }}>
            <LaundryTile entities={entities} send={sendCmd} />
          </div>

          {/* perimeter + power + media */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, marginTop: 12 }}>
            <PerimeterTile entities={entities} send={sendCmd} />
            <PowerTile entities={entities} />
            <MediaTile entities={entities} send={sendCmd} />
          </div>

          {/* colony row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 12, marginTop: 12 }}>
            <ColonyTile entities={entities} />
          </div>
        </>
      )}

      {route.view === 'sectors' && (
        <SectorsView
          sectors={sectors}
          selected={selectedSector}
          entities={entities}
          unit={unit}
          send={sendCmd}
          onSelect={(sector) => navigate({ view: 'sectors', sector })}
        />
      )}

      {route.view === 'devices' && <DevicesView />}

      {route.view === 'registry' && (
        <RegistryView entities={entities} route={route} onNavigate={navigate} send={sendCmd} />
      )}

      {route.view === 'automata' && <AutomataView entities={entities} send={sendCmd} />}

      {route.uplink && <UplinkPalette onClose={() => navigate({ ...route, uplink: false })} />}
    </div>
  )
}
