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

import { useEffect, useMemo, useState } from 'react'
import { useHomeAssistant } from '../hooks/useHomeAssistant'
import { useHomeRoute } from '../hooks/useHomeRoute'
import { useHomeTiles } from '../hooks/useHomeTiles'
import { indexById } from '../lib/ha'
import { buildSectors, findSector } from '../../shared/haSectors'
import { getTileSpec, tileRenderable } from '../../shared/homeTileSpecs'
import type { HomeTileConfig } from '../../shared/homeTiles'
import {
  ApplianceTile, LitterTile, PetsTile, ThermostatTile, AmbientTile, type TileProps,
} from './HoloTiles'
import { TileConfigPanel } from './home/TileConfigPanel'
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

/**
 * The component that draws a tile type.
 *
 * One place maps type to component, so adding a tile type is a spec entry plus a
 * component plus a line here — never a change to the layout code below, which
 * only knows that a tile is something with an id that renders.
 */
const TILE_COMPONENTS: Record<string, (props: TileProps) => JSX.Element | null> = {
  thermostat: ThermostatTile,
  ambient: AmbientTile,
  appliance: ApplianceTile,
  litter: LitterTile,
  pets: PetsTile,
}

/** Render one configured tile, or nothing when this build has no such type. */
function Tile({ tile, entities, send, unit }: TileProps): JSX.Element | null {
  const Component = TILE_COMPONENTS[tile.type]
  if (!Component) return null
  return <Component tile={tile} entities={entities} send={send} unit={unit} />
}

/** Tiles of the given types, in configured order, that can actually draw. */
function pickTiles(tiles: HomeTileConfig[], types: string[]): HomeTileConfig[] {
  return tiles.filter((t) => {
    if (!types.includes(t.type)) return false
    const spec = getTileSpec(t.type)
    return spec ? tileRenderable(t, spec) : false
  })
}

export function HomeDashboard(): JSX.Element {
  const snap = useHomeAssistant()
  const [route, navigate] = useHomeRoute()
  const tilesApi = useHomeTiles()
  const [configuring, setConfiguring] = useState(false)

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

  // Masthead alert tally. The waste-drawer warning is derived from the
  // configured litter tiles and each tile's own threshold rather than from one
  // hardcoded sensor id — a house with two boxes gets two alerts, and a house
  // with none gets no phantom row.
  const alerts: string[] = []
  for (const tile of pickTiles(tilesApi.config.tiles, ['litter'])) {
    const spec = getTileSpec('litter')
    if (!spec) continue
    const drawer = tile.bindings['wasteDrawer']
    const pct = Number(drawer ? idx.get(drawer)?.state : NaN)
    const full = typeof tile.options['wasteFull'] === 'number'
      ? tile.options['wasteFull']
      : (spec.options.find((o) => o.key === 'wasteFull')?.default as number)
    if (Number.isFinite(pct) && pct >= full) {
      alerts.push(`${(tile.title || spec.defaultTitle).toUpperCase()} DRAWER FULL`)
    }
  }
  for (const sector of sectors) alerts.push(...sector.alerts)

  const automataCount = entities.filter(
    (e) => e.domain === 'scene' || e.domain === 'script' || e.domain === 'automation',
  ).length

  const climateTiles = pickTiles(tilesApi.config.tiles, ['thermostat', 'ambient'])
  const applianceTiles = pickTiles(tilesApi.config.tiles, ['appliance', 'litter'])
  const petTiles = pickTiles(tilesApi.config.tiles, ['pets'])
  const visibleTiles = climateTiles.length + applianceTiles.length + petTiles.length

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
        onConfigure={() => setConfiguring((v) => !v)}
        configuring={configuring}
      />

      {connected === false && entities.length === 0 && (
        <div className="card" style={{ fontSize: 14, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 24 }}>
          HOME ASSISTANT OFFLINE — CHECK HA_URL + HA_TOKEN IN .ENV
        </div>
      )}

      {route.view === 'overview' && (
        <>
          {configuring && (
            <TileConfigPanel api={tilesApi} entities={entities} onClose={() => setConfiguring(false)} />
          )}

          <SceneStrip entities={entities} send={sendCmd} />
          <SectorStrip sectors={sectors} unit={unit} onSelect={(sector) => navigate({ view: 'sectors', sector })} />

          {/* Device tiles, in the order the configuration lists them. The old
              fixed SplitPane is gone: a house with four thermostats and no
              litter box has a different shape from this one, so the grid
              reflows rather than reserving slots for devices nobody has. */}
          {climateTiles.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
              {climateTiles.map((t) => (
                <Tile key={t.id} tile={t} entities={entities} send={sendCmd} unit={unit} />
              ))}
            </div>
          )}

          {applianceTiles.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 12, marginTop: 12 }}>
              {applianceTiles.map((t) => (
                <Tile key={t.id} tile={t} entities={entities} send={sendCmd} unit={unit} />
              ))}
            </div>
          )}

          {/* perimeter + power + media — generic, nothing to bind */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, marginTop: 12 }}>
            <PerimeterTile entities={entities} send={sendCmd} />
            <PowerTile entities={entities} />
            <MediaTile entities={entities} send={sendCmd} />
          </div>

          {petTiles.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, marginTop: 12 }}>
              {petTiles.map((t) => (
                <Tile key={t.id} tile={t} entities={entities} send={sendCmd} unit={unit} />
              ))}
            </div>
          )}

          {/* The one thing a fresh install must not do is look broken. If HA is
              connected but nothing is configured yet, say what to press. */}
          {!configuring && tilesApi.loaded && connected && visibleTiles === 0 && (
            <div className="card" style={{ fontSize: 13, color: 'var(--green-dim)', letterSpacing: 1, textAlign: 'center', padding: 20, marginTop: 12, lineHeight: 1.7 }}>
              NO DEVICE TILES CONFIGURED YET<br />
              <button
                type="button"
                onClick={() => setConfiguring(true)}
                style={{
                  marginTop: 8, background: 'transparent', border: '0.5px solid var(--border)',
                  color: 'var(--green)', fontFamily: 'var(--font-mono)', fontSize: 11,
                  letterSpacing: 1.5, padding: '6px 12px', cursor: 'pointer',
                }}
              >
                SET UP DEVICE TILES
              </button>
            </div>
          )}
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
