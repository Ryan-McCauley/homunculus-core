// Helpers for pulling values out of the generic HA entity list in the UI.

import type { HaEntity } from '../../shared/homeassistant'

/** Index a flat entity list by id for O(1) lookups. */
export function indexById(entities: HaEntity[]): Map<string, HaEntity> {
  const m = new Map<string, HaEntity>()
  for (const e of entities) m.set(e.entityId, e)
  return m
}

/** Raw state string for an entity id, or null if absent. */
export function stateOf(idx: Map<string, HaEntity>, id: string): string | null {
  return idx.get(id)?.state ?? null
}

/** Numeric state for an entity id (e.g. a sensor or number), or null. */
export function numOf(idx: Map<string, HaEntity>, id: string): number | null {
  const s = idx.get(id)?.state
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** An attribute value off an entity. */
export function attrOf<T = unknown>(idx: Map<string, HaEntity>, id: string, key: string): T | null {
  const e = idx.get(id)
  if (!e) return null
  return (e.attributes[key] as T) ?? null
}

/** True if a switch/lock/binary_sensor-ish entity is in an "on/active" state. */
export function isOn(idx: Map<string, HaEntity>, id: string): boolean {
  const s = idx.get(id)?.state
  return s === 'on' || s === 'open' || s === 'unlocked' || s === 'home'
}

/** Round a number for display; passthrough for null. */
export function round(n: number | null, digits = 0): string {
  if (n == null) return '—'
  const f = Math.pow(10, digits)
  return String(Math.round(n * f) / f)
}

/**
 * Minutes remaining until an ISO timestamp state (HA "timestamp" sensors carry
 * the finish time as their state). Returns null if not a valid future time.
 */
export function minutesUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const mins = Math.round((t - Date.now()) / 60000)
  return mins
}

/** Human-readable elapsed time since an ISO timestamp ("3m ago", "2h ago"). */
export function relTime(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Format a local clock time (e.g. "8:30 PM") from an ISO string. */
export function clockTime(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
