// A tile's view of Home Assistant.
//
// Every device tile used to read the house by literal entity id —
// `stateOf(idx, 'sensor.r2peepoo_waste_drawer')`. A tile now reads it by SLOT
// instead — `r.num('wasteDrawer')` — and the binding underneath is whatever this
// install configured. The call sites stay the same shape, which is what made the
// generalization a mechanical change to the tiles rather than a rewrite of them.
//
// Every accessor tolerates an unbound slot, because unbound is normal: a house
// without a humidity sensor has no humidity slot bound, and the tile is expected
// to render its remaining rows rather than to guard every read. `send` on an
// unbound slot is a no-op for the same reason — a control with nothing behind it
// must do nothing, not throw into a click handler.

import type { HaEntity } from '../../shared/homeassistant'
import type { HomeTileConfig, TileSpec } from '../../shared/homeTiles'
import { numberOption, optionOf } from '../../shared/homeTiles'

export type Send = (entityId: string, service: string, data: Record<string, unknown>) => void

export interface TileReader {
  /** Entity id bound to a slot, or null. */
  id: (slot: string) => string | null
  /** True when the slot is bound AND that entity currently exists. */
  has: (slot: string) => boolean
  entity: (slot: string) => HaEntity | null
  state: (slot: string) => string | null
  num: (slot: string) => number | null
  attr: <T = unknown>(slot: string, key: string) => T | null
  /** True for an on/open/unlocked/home state. */
  on: (slot: string) => boolean
  /** ISO last_changed for the bound entity, or null. */
  changed: (slot: string) => string | null
  /** Friendly name of the bound entity, or null. */
  name: (slot: string) => string | null
  /** Call a service against a slot's entity. No-op when the slot is unbound. */
  send: (slot: string, service: string, data?: Record<string, unknown>) => void
  /** An option's value, falling back to the spec default. */
  opt: (key: string) => string | number | boolean
  numOpt: (key: string) => number
  /** A comma-separated text option as a lowercased set. */
  listOpt: (key: string) => Set<string>
  /** The tile's header text. */
  title: string
}

const ON_STATES = new Set(['on', 'open', 'unlocked', 'home'])

export function tileReader(
  tile: HomeTileConfig,
  spec: TileSpec,
  idx: Map<string, HaEntity>,
  send: Send,
): TileReader {
  const id = (slot: string): string | null => tile.bindings[slot] || null
  const entity = (slot: string): HaEntity | null => {
    const eid = id(slot)
    return eid ? idx.get(eid) ?? null : null
  }
  const state = (slot: string): string | null => entity(slot)?.state ?? null

  return {
    id,
    entity,
    state,
    has: (slot) => entity(slot) !== null,
    num: (slot) => {
      const s = state(slot)
      if (s == null) return null
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    },
    attr: <T,>(slot: string, key: string): T | null => (entity(slot)?.attributes[key] as T) ?? null,
    on: (slot) => ON_STATES.has(state(slot) ?? ''),
    changed: (slot) => entity(slot)?.lastChanged ?? null,
    name: (slot) => entity(slot)?.name ?? null,
    send: (slot, service, data = {}) => {
      const eid = id(slot)
      if (eid) send(eid, service, data)
    },
    opt: (key) => optionOf(tile, spec, key),
    numOpt: (key) => numberOption(tile, spec, key),
    listOpt: (key) => {
      const v = optionOf(tile, spec, key)
      return new Set(String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    },
    title: tile.title || spec.defaultTitle,
  }
}
