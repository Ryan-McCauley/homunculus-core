// Fetches Home Assistant's area registry.
//
// The rest of this app talks to HA over REST, but areas are not reachable that
// way: /api/states returns entity states and attributes, while area membership
// lives in the area/device/entity registries, which HA exposes only over the
// websocket API. So the SECTORS view needs exactly one websocket conversation —
// authenticate, ask for three lists, disconnect — and everything else stays on
// the existing poll.
//
// Registries change when someone reorganizes their house, which is to say almost
// never, so this is fetched at startup and refreshed on a long timer rather than
// polled. A failure is not fatal and is not retried aggressively: areas simply
// stay unknown, and every entity shows up under UNASSIGNED, which is honest about
// what we know rather than guessing at rooms from entity names.

import { WebSocket } from 'ws'
import type { HaAreaRegistry } from '../shared/homeassistant'

/** The three registry payloads, in the shape HA sends them. */
export interface RegistryPayloads {
  areas: Array<{ area_id?: string; name?: string }>
  devices: Array<{ id?: string; area_id?: string | null }>
  entities: Array<{ entity_id?: string; area_id?: string | null; device_id?: string | null }>
}

/**
 * Resolves each entity to an area.
 *
 * HA's rule, which this mirrors: an entity belongs to the area set on the entity
 * itself, and otherwise inherits the area of the device it belongs to. Most
 * entities carry no area of their own and inherit — skipping the device hop would
 * leave a typical house with almost everything unassigned.
 *
 * Anything that does not resolve to a listed area is simply left out of the map,
 * which the sector builder reads as "unfiled".
 */
export function buildAreaRegistry(payloads: RegistryPayloads): HaAreaRegistry {
  const areas = payloads.areas
    .filter((a) => a.area_id && a.name)
    .map((a) => ({ id: a.area_id as string, name: a.name as string }))
  const known = new Set(areas.map((a) => a.id))

  const deviceAreas = new Map<string, string>()
  for (const device of payloads.devices) {
    if (device.id && device.area_id) deviceAreas.set(device.id, device.area_id)
  }

  const entityAreas: Record<string, string> = {}
  for (const entity of payloads.entities) {
    if (!entity.entity_id) continue
    const areaId = entity.area_id ?? (entity.device_id ? deviceAreas.get(entity.device_id) : undefined)
    if (areaId && known.has(areaId)) entityAreas[entity.entity_id] = areaId
  }

  return { areas, entityAreas }
}

/** Turns an HA base URL into its websocket endpoint. */
export function websocketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/api/websocket`
}

/**
 * Runs the one websocket conversation and returns the registry, or null if
 * anything goes wrong (unreachable, bad token, timeout, unexpected reply).
 */
export function fetchAreaRegistry(
  baseUrl: string,
  token: string,
  timeoutMs = 10_000,
): Promise<HaAreaRegistry | null> {
  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(websocketUrl(baseUrl))
    } catch {
      resolve(null)
      return
    }

    // Exactly one resolve, exactly one close, however this ends.
    let settled = false
    const finish = (value: HaAreaRegistry | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closing */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    const REQUESTS = [
      { id: 1, type: 'config/area_registry/list', key: 'areas' as const },
      { id: 2, type: 'config/device_registry/list', key: 'devices' as const },
      { id: 3, type: 'config/entity_registry/list', key: 'entities' as const },
    ]
    const collected: RegistryPayloads = { areas: [], devices: [], entities: [] }
    let outstanding = REQUESTS.length

    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))

    socket.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }

      if (msg['type'] === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }))
        return
      }
      if (msg['type'] === 'auth_invalid') {
        console.error('[ha] area registry: websocket auth rejected — check HA_TOKEN')
        finish(null)
        return
      }
      if (msg['type'] === 'auth_ok') {
        for (const req of REQUESTS) socket.send(JSON.stringify({ id: req.id, type: req.type }))
        return
      }
      if (msg['type'] === 'result') {
        const req = REQUESTS.find((r) => r.id === msg['id'])
        if (!req) return
        if (msg['success'] && Array.isArray(msg['result'])) {
          collected[req.key] = msg['result'] as never
        }
        if (--outstanding === 0) finish(buildAreaRegistry(collected))
      }
    })
  })
}
