// Shared Home Assistant types. The snapshot carries:
//   - `climate`  — typed climate states for the thermostat panels (unchanged).
//   - `entities` — a flat, generic view of every relevant entity, so new
//                  device panels can pull exactly the entity ids they need.
//   - `devices`  — those same entities grouped by logical device (Voltaire,
//                  R2PEEPOO, washer, …) for generic listing / fallbacks.

export interface HaClimateState {
  entityId: string
  name: string
  state: string // 'heat' | 'cool' | 'heat_cool' | 'auto' | 'off' | 'unavailable' | ...
  currentTemp: number | null
  targetTemp: number | null
  targetTempLow: number | null
  targetTempHigh: number | null
  humidity: number | null
  hvacAction: string | null // 'heating' | 'cooling' | 'idle' | 'off' | null
}

/** A generic entity — enough for any panel to render or command it. */
export interface HaEntity {
  entityId: string
  domain: string // 'sensor' | 'switch' | 'lock' | 'cover' | 'select' | ...
  name: string // friendly_name
  state: string
  unit: string | null // unit_of_measurement
  deviceClass: string | null
  attributes: Record<string, unknown>
  lastChanged: string | null // ISO timestamp from HA's top-level last_changed field
}

/** Entities grouped under a logical device. */
export interface HaDevice {
  key: string // 'voltaire' | 'r2peepoo' | 'washer' | ...
  label: string // 'Voltaire'
  entities: HaEntity[]
}

export interface HaSnapshot {
  ts: number
  connected: boolean
  url: string | null    // HA base URL (from HA_URL) — lets the UI link to the HA web panel
  tempUnit: '°F' | '°C' // system temperature unit from HA config
  climate: HaClimateState[]
  entities: HaEntity[]
  devices: HaDevice[]
  /** True when this is the last good reading being held through a transient poll
   *  failure rather than a fresh one. `connected` stays true — the house has not
   *  gone away because one request timed out — but consumers that care about
   *  freshness (and the UI) can tell the difference. */
  stale?: boolean
}
