// Polls the Home Assistant REST API for entity states and fans out updates to
// subscribed clients. Mirrors the telemetry hub pattern. Climate entities get a
// typed shape for the thermostat panels; everything relevant is also exposed as
// generic entities (flat + grouped by device) so new panels can pull what they
// need. Commands are generic: any domain.service with arbitrary data.

import type { HaClimateState, HaEntity, HaDevice, HaSnapshot } from '../shared/homeassistant'

const HA_URL = (process.env['HA_URL'] || '').replace(/\/$/, '')
const HA_TOKEN = process.env['HA_TOKEN'] || ''
const POLL_MS = Number(process.env['HA_POLL_MS'] || 10_000)

const HEADERS = { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }

// Domains worth shipping to the UI. Skips chatty/irrelevant ones (tts,
// conversation, zone, persistent_notification, …) to keep the snapshot lean.
const RELEVANT_DOMAINS = new Set([
  'climate', 'sensor', 'binary_sensor', 'switch', 'lock', 'cover', 'select',
  'number', 'button', 'vacuum', 'media_player', 'weather', 'device_tracker',
  'update', 'person', 'sun', 'todo'
])

// Logical device grouping by id/name substring. Order matters — first match wins.
const DEVICE_DEFS: Array<{ key: string; label: string; match: RegExp }> = [
  { key: 'voltaire', label: 'Voltaire', match: /voltaire/i },
  { key: 'r2peepoo', label: 'R2PEEPOO', match: /r2peepoo/i },
  { key: 'washer', label: 'Washer', match: /(^|\.)washer|washer/i },
  { key: 'dryer', label: 'Dryer', match: /(^|\.)dryer|dryer/i },
  { key: 'thermostat', label: 'Thermostat', match: /thermostat/i },
  { key: 'colony', label: 'Colony', match: /(pazoozoo|piggy|smithers|willow|zelda)/i },
  { key: 'backup', label: 'Backup', match: /(^|\.)backup/i }
]

async function fetchTempUnit(): Promise<'°F' | '°C'> {
  const res = await fetch(`${HA_URL}/api/config`, { headers: HEADERS })
  if (!res.ok) return '°F'
  const cfg = (await res.json()) as Record<string, unknown>
  const unit = (cfg['unit_system'] as Record<string, string> | undefined)?.['temperature']
  return unit === '°C' ? '°C' : '°F'
}

function parseClimate(entity: Record<string, unknown>): HaClimateState {
  const attrs = (entity['attributes'] as Record<string, unknown>) || {}
  return {
    entityId: entity['entity_id'] as string,
    name: (attrs['friendly_name'] as string) || (entity['entity_id'] as string),
    state: (entity['state'] as string) || 'unavailable',
    currentTemp: (attrs['current_temperature'] as number) ?? null,
    targetTemp: (attrs['temperature'] as number) ?? null,
    targetTempLow: (attrs['target_temp_low'] as number) ?? null,
    targetTempHigh: (attrs['target_temp_high'] as number) ?? null,
    humidity: (attrs['current_humidity'] as number) ?? null,
    hvacAction: (attrs['hvac_action'] as string) ?? null
  }
}

function parseEntity(entity: Record<string, unknown>): HaEntity {
  const id = entity['entity_id'] as string
  const attrs = (entity['attributes'] as Record<string, unknown>) || {}
  return {
    entityId: id,
    domain: id.split('.')[0],
    name: (attrs['friendly_name'] as string) || id,
    state: (entity['state'] as string) ?? 'unknown',
    unit: (attrs['unit_of_measurement'] as string) ?? null,
    deviceClass: (attrs['device_class'] as string) ?? null,
    attributes: attrs,
    lastChanged: (entity['last_changed'] as string) ?? null
  }
}

function groupDevices(entities: HaEntity[]): HaDevice[] {
  const byKey = new Map<string, HaDevice>()
  for (const def of DEVICE_DEFS) byKey.set(def.key, { key: def.key, label: def.label, entities: [] })
  for (const e of entities) {
    const def = DEVICE_DEFS.find((d) => d.match.test(e.entityId) || d.match.test(e.name))
    if (def) byKey.get(def.key)!.entities.push(e)
  }
  return [...byKey.values()].filter((d) => d.entities.length > 0)
}

async function fetchSnapshot(): Promise<Omit<HaSnapshot, 'ts' | 'connected'>> {
  const [statesRes, tempUnit] = await Promise.all([
    fetch(`${HA_URL}/api/states`, { headers: HEADERS }),
    fetchTempUnit()
  ])
  if (!statesRes.ok) throw new Error(`HA API ${statesRes.status}`)
  const states = (await statesRes.json()) as Array<Record<string, unknown>>

  const climate = states
    .filter((e) => (e['entity_id'] as string).startsWith('climate.'))
    .map(parseClimate)

  const entities = states
    .filter((e) => RELEVANT_DOMAINS.has((e['entity_id'] as string).split('.')[0]))
    .map(parseEntity)

  return { url: HA_URL || null, tempUnit, climate, entities, devices: groupDevices(entities) }
}

type Listener = (snapshot: HaSnapshot) => void

const EMPTY = (): HaSnapshot => ({
  ts: Date.now(),
  connected: false,
  url: HA_URL || null,
  tempUnit: '°F',
  climate: [],
  entities: [],
  devices: []
})

class HomeAssistantHub {
  private listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | null = null
  private latest: HaSnapshot | null = null

  get configured(): boolean {
    return !!(HA_URL && HA_TOKEN)
  }

  getLatest(): HaSnapshot | null {
    return this.latest
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    if (this.latest) fn(this.latest)
    this.ensureRunning()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private emit(snap: HaSnapshot): void {
    this.latest = snap
    for (const fn of this.listeners) fn(snap)
  }

  private ensureRunning(): void {
    if (this.timer) return
    const tick = async (): Promise<void> => {
      if (!this.configured) {
        this.emit(EMPTY())
        return
      }
      try {
        const data = await fetchSnapshot()
        this.emit({ ts: Date.now(), connected: true, ...data })
      } catch (err) {
        console.error('[ha] poll failed:', (err as Error).message)
        this.emit(EMPTY())
      }
    }
    void tick()
    this.timer = setInterval(tick, POLL_MS)
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async sendCommand(entityId: string, service: string, data: Record<string, unknown>): Promise<void> {
    if (!this.configured) throw new Error('HA not configured')
    const [domain] = service.split('.')
    const svc = service.includes('.') ? service.split('.').slice(1).join('.') : service
    const url = `${HA_URL}/api/services/${domain}/${svc}`
    const res = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ entity_id: entityId, ...data })
    })
    if (!res.ok) throw new Error(`HA service call failed: ${res.status}`)
  }
}

export const haHub = new HomeAssistantHub()
