// The full-width HOME tab — climate, appliances, and ambient sensors.

import { useHomeAssistant } from '../hooks/useHomeAssistant'
import { SplitPane } from '../components/SplitPane'
import { indexById } from '../lib/ha'
import { LaundryTile, R2peepooTile, ColonyTile, ThermostatTile, AmbientTile } from './HoloTiles'

function sendCmd(entityId: string, service: string, data: Record<string, unknown>): void {
  window.homunculus?.sendHaCommand(entityId, service, data)
}

export function HomeDashboard(): JSX.Element {
  const snap = useHomeAssistant()
  const connected = snap?.connected ?? null
  const entities = snap?.entities ?? []
  const unit = snap?.tempUnit ?? '°F'
  const idx = indexById(entities)

  // Surface-level alert tally for the masthead.
  const alerts: string[] = []
  const waste = Number(idx.get('sensor.r2peepoo_waste_drawer')?.state)
  if (Number.isFinite(waste) && waste >= 80) alerts.push('WASTE DRAWER FULL')

  const deviceCount = snap?.devices.length ?? 0

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
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
          {connected == null ? 'LINKING…' : connected ? <>{deviceCount} SUBSYSTEMS · <span style={{ color: 'var(--green)' }}>ALL LINKED</span></> : <span style={{ color: 'var(--crimson)' }}>OFFLINE</span>}
          {alerts.length > 0 && <> · <span style={{ color: 'var(--crimson)' }}>{alerts.length} ALERT{alerts.length > 1 ? 'S' : ''}</span></>}
        </div>
      </div>

      {connected === false && entities.length === 0 && (
        <div className="card" style={{ fontSize: 14, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 24 }}>
          HOME ASSISTANT OFFLINE — CHECK HA_URL + HA_TOKEN IN .ENV
        </div>
      )}

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

      {/* colony row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 12, marginTop: 12 }}>
        <ColonyTile entities={entities} />
      </div>
    </div>
  )
}
