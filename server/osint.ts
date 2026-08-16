// Osint hub — backend cron that polls internet OSINT sources, computes
// per-source snapshots, persists state to disk (so the UI has data instantly on
// reconnect and across restarts), fans out a combined snapshot to connected
// clients, and fires proactive alerts when something notable escalates.
//
// Watchers:
//   • Pentagon Pizza Index  — PizzINT busyness edge function
//   • Seismic Watch         — USGS earthquake GeoJSON
//   • Skywatch              — military ADS-B (adsb.fi)
//   • Geomagnetic / Solar   — NOAA SWPC Kp + OVATION aurora

import { existsSync, mkdirSync } from 'fs'
import { stateStore } from './stateStore'
import { join } from 'path'
import { WebSocket } from 'ws'
import type {
  PizzaReading, PizzaSnapshot, PizzaHistoryPoint,
  QuakeReading, SeismicSnapshot,
  AircraftReading, AircraftSnapshot,
  AuroraCell, GeomagSnapshot,
  CveReading, C2Reading, CyberSnapshot,
  VesselReading, VesselSnapshot,
  OutageLevel, OutageReading, OutageSnapshot,
  GeofenceConfig, GeofenceBreach, BreachKind,
  IpWatchSnapshot,
  OsintSnapshot
} from '../shared/osint'
import { DEFCON_LABEL, GSCALE_LABEL, OUTAGE_RANK, DEFAULT_GEOFENCE } from '../shared/osint'
import { COUNTRY_CENTROIDS } from './country-centroids'
import { broadcastProactive } from './chat'

// ── Sources (override via env if any rotate) ───────────────────────────────
const PIZZA_URL = process.env['OSINT_PIZZA_URL'] ||
  'https://fuqhimaxvqijvgzrfvyv.supabase.co/functions/v1/fetch-busyness'
const PIZZA_KEY = process.env['OSINT_PIZZA_KEY'] ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cWhpbWF4dnFpanZnenJmdnl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNjQwODAsImV4cCI6MjA4Mjk0MDA4MH0.cB6s4HLhr1lPmAhCZ8KI-C8-VvDUp5uPqGTTVVx6DeQ'
const SEISMIC_URL = process.env['OSINT_SEISMIC_URL'] ||
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'
const AIRCRAFT_URL = process.env['OSINT_AIRCRAFT_URL'] || 'https://opendata.adsb.fi/api/v2/mil'
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'
const AURORA_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'
const KEV_URL = process.env['OSINT_KEV_URL'] ||
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
const FEODO_URL = process.env['OSINT_FEODO_URL'] ||
  'https://feodotracker.abuse.ch/downloads/ipblocklist.json'

// Vessel AIS (aisstream.io). Feed stays dormant until a key is configured.
const AIS_KEY = process.env['OSINT_AISSTREAM_KEY'] || ''
const AIS_URL = process.env['OSINT_AIS_URL'] || 'wss://stream.aisstream.io/v0/stream'

// Service outages — official Atlassian Statuspage feeds (Downdetector-style
// signal, keyless). Each entry's `host` exposes `/api/v2/summary.json`. Override
// the watched set with OSINT_OUTAGE_SERVICES="slug|Name|host,…".
interface OutageSource { id: string; name: string; host: string }
const DEFAULT_OUTAGE_SERVICES: OutageSource[] = [
  { id: 'discord', name: 'Discord', host: 'discordstatus.com' },
  { id: 'github', name: 'GitHub', host: 'www.githubstatus.com' },
  { id: 'cloudflare', name: 'Cloudflare', host: 'www.cloudflarestatus.com' },
  { id: 'openai', name: 'OpenAI', host: 'status.openai.com' },
  { id: 'anthropic', name: 'Anthropic', host: 'status.anthropic.com' },
  { id: 'digitalocean', name: 'DigitalOcean', host: 'status.digitalocean.com' },
  { id: 'reddit', name: 'Reddit', host: 'www.redditstatus.com' },
  { id: 'zoom', name: 'Zoom', host: 'status.zoom.us' },
  { id: 'twilio', name: 'Twilio', host: 'status.twilio.com' },
  { id: 'datadog', name: 'Datadog', host: 'status.datadoghq.com' },
  { id: 'atlassian', name: 'Atlassian', host: 'status.atlassian.com' },
  { id: 'coinbase', name: 'Coinbase', host: 'status.coinbase.com' }
]
function parseOutageServices(): OutageSource[] {
  const raw = process.env['OSINT_OUTAGE_SERVICES']
  if (!raw) return DEFAULT_OUTAGE_SERVICES
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [id, name, host] = entry.split('|').map((p) => p.trim())
    return id && host ? { id, name: name || id, host } : null
  }).filter((s): s is OutageSource => s !== null)
  return parsed.length ? parsed : DEFAULT_OUTAGE_SERVICES
}
const OUTAGE_SERVICES = parseOutageServices()

// ── Poll cadences (ms) ─────────────────────────────────────────────────────
const PIZZA_MS = Number(process.env['OSINT_POLL_MS'] || 5 * 60_000)
const SEISMIC_MS = Number(process.env['OSINT_SEISMIC_MS'] || 3 * 60_000)
const AIRCRAFT_MS = Number(process.env['OSINT_AIRCRAFT_MS'] || 60_000)
const GEOMAG_MS = Number(process.env['OSINT_GEOMAG_MS'] || 5 * 60_000)
const CYBER_MS = Number(process.env['OSINT_CYBER_MS'] || 60 * 60_000)
const OUTAGE_MS = Number(process.env['OSINT_OUTAGE_MS'] || 2 * 60_000)
const IPWATCH_MS = Number(process.env['OSINT_IPWATCH_MS'] || 5 * 60_000)
// Plain IP-echo endpoints, no keys. Tried in order; a single dead provider
// shouldn't be mistaken for an actual address change.
const IP_SOURCES = [
  'https://api.ipify.org?format=json',
  'https://ifconfig.co/json',
  'https://ipinfo.io/json'
]
// How often the AIS firehose flushes a coalesced vessel snapshot to clients.
const VESSEL_FLUSH_MS = Number(process.env['OSINT_VESSEL_FLUSH_MS'] || 5_000)
const VESSEL_STALE_MS = 10 * 60_000
const VESSEL_MAX = 800
const RECENT_CVE_MAX = 8

const DATA_DIR = process.env['HOMUNCULUS_DATA_DIR'] || join(process.cwd(), 'data')
const STORE_PATH = join(DATA_DIR, 'osint-store.json')
const PIZZA_HISTORY_MAX = 288
const KP_HISTORY_MAX = 96
const ALERT_COOLDOWN_MS = 30 * 60_000
// Geofence: how long to suppress repeat voice alerts, and how many breaches to retain.
const GEOFENCE_ALERT_COOLDOWN_MS = 5 * 60_000
const GEOFENCE_BREACH_MAX = 40
// Cap how many aircraft / aurora cells we ship to the client per tick.
const AIRCRAFT_MAX = 300
const AURORA_MIN_PROB = 25
const AURORA_MAX_CELLS = 700

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
}
/** Great-circle distance between two lat/lng points, in kilometres. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ═══ Pizza ═══════════════════════════════════════════════════════════════
interface RawPizza {
  timestamp?: string; timezone?: string; isLateNight?: boolean; dataSource?: string
  anomalyCount?: number
  readings?: { location_id: string; busyness_level: number; typical_level: number
    is_anomaly: boolean; location?: { name?: string; address?: string; lat?: number
      lng?: number; distance_miles?: number } }[]
}
function deriveDefcon(anomalies: number, deviationAvg: number): number {
  if (anomalies >= 6 || deviationAvg >= 0.8) return 1
  if (anomalies >= 4 || deviationAvg >= 0.5) return 2
  if (anomalies >= 2 || deviationAvg >= 0.3) return 3
  if (anomalies >= 1 || deviationAvg >= 0.15) return 4
  return 5
}
function normalizePizza(raw: RawPizza): PizzaSnapshot {
  const readings: PizzaReading[] = (raw.readings ?? []).map((r) => {
    const busyness = Math.round(r.busyness_level ?? 0)
    const typical = Math.round(r.typical_level ?? 0)
    return {
      locationId: r.location_id, name: r.location?.name ?? 'Unknown',
      address: r.location?.address ?? '', lat: r.location?.lat ?? 0, lng: r.location?.lng ?? 0,
      distanceMiles: r.location?.distance_miles ?? 0, busyness, typical,
      deviation: typical > 0 ? Math.max(0, (busyness - typical) / typical) : 0,
      isAnomaly: !!r.is_anomaly
    }
  })
  readings.sort((a, b) => b.busyness - a.busyness)
  const anomalyCount = raw.anomalyCount ?? readings.filter((r) => r.isAnomaly).length
  const deviationAvg = mean(readings.map((r) => r.deviation))
  return {
    ts: Date.now(), sourceTime: raw.timestamp ?? new Date().toISOString(),
    timezone: raw.timezone ?? 'America/New_York', isLateNight: !!raw.isLateNight,
    dataSource: raw.dataSource ?? 'unknown', locationCount: readings.length, anomalyCount,
    indexScore: Math.round(mean(readings.map((r) => r.busyness))), deviationAvg,
    defcon: deriveDefcon(anomalyCount, deviationAvg), readings, origin: 'live'
  }
}

// ═══ Seismic (USGS GeoJSON) ══════════════════════════════════════════════
interface RawQuakeFeature {
  id: string
  properties: { mag: number | null; place: string | null; time: number; tsunami: number }
  geometry: { coordinates: [number, number, number] }
}
function normalizeSeismic(raw: { features?: RawQuakeFeature[] }): SeismicSnapshot {
  const quakes: QuakeReading[] = (raw.features ?? [])
    .filter((f) => f.geometry?.coordinates && f.properties?.mag != null)
    .map((f) => ({
      id: f.id, mag: Math.round((f.properties.mag ?? 0) * 10) / 10,
      place: f.properties.place ?? 'Unknown', lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1], depthKm: Math.round(f.geometry.coordinates[2] ?? 0),
      time: f.properties.time, tsunami: f.properties.tsunami === 1
    }))
  quakes.sort((a, b) => b.mag - a.mag)
  const largest = quakes[0] ? { mag: quakes[0].mag, place: quakes[0].place } : null
  return { ts: Date.now(), count: quakes.length, largest, quakes, origin: 'live' }
}

// ═══ Skywatch (adsb.fi military) ═════════════════════════════════════════
interface RawAircraft {
  hex?: string; flight?: string; t?: string; lat?: number; lon?: number
  alt_baro?: number | string; gs?: number; track?: number; squawk?: string; emergency?: string
}
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700'])
function normalizeAircraft(raw: { ac?: RawAircraft[] }): AircraftSnapshot {
  const all = raw.ac ?? []
  const positioned = all.filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number')
  const aircraft: AircraftReading[] = positioned.slice(0, AIRCRAFT_MAX).map((a) => {
    const emergency = (!!a.emergency && a.emergency !== 'none') ||
      (typeof a.squawk === 'string' && EMERGENCY_SQUAWKS.has(a.squawk))
    const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : null
    return {
      hex: a.hex ?? '', callsign: (a.flight ?? '').trim() || '——', type: a.t ?? '?',
      lat: a.lat as number, lng: a.lon as number, altFt,
      groundSpeed: typeof a.gs === 'number' ? Math.round(a.gs) : null,
      track: typeof a.track === 'number' ? Math.round(a.track) : null, emergency
    }
  })
  const emergencyCount = aircraft.filter((a) => a.emergency).length
  return { ts: Date.now(), count: all.length, aircraft, emergencyCount, origin: 'live' }
}

// ═══ Geomagnetic / solar (NOAA) ══════════════════════════════════════════
function kpToG(kp: number): number {
  if (kp >= 9) return 5
  if (kp >= 8) return 4
  if (kp >= 7) return 3
  if (kp >= 6) return 2
  if (kp >= 5) return 1
  return 0
}
function downsampleAurora(raw: { coordinates?: [number, number, number][] }): AuroraCell[] {
  const cells = (raw.coordinates ?? [])
    .filter((c) => c[2] >= AURORA_MIN_PROB)
    .map((c) => ({ lat: c[1], lng: c[0] > 180 ? c[0] - 360 : c[0], prob: c[2] }))
  if (cells.length <= AURORA_MAX_CELLS) return cells
  // Keep the highest-probability cells when over budget.
  return cells.sort((a, b) => b.prob - a.prob).slice(0, AURORA_MAX_CELLS)
}

// ═══ Cyber threat (CISA KEV + abuse.ch Feodo) ════════════════════════════
interface RawKev {
  vulnerabilities?: {
    cveID: string; vulnerabilityName?: string; vendorProject?: string
    product?: string; dateAdded?: string; knownRansomwareCampaignUse?: string
  }[]
}
interface RawC2 {
  ip_address?: string; port?: number; country?: string; malware?: string
  as_name?: string; first_seen?: string
}
function normalizeCyber(kev: RawKev, c2raw: RawC2[]): CyberSnapshot {
  const all = kev.vulnerabilities ?? []
  const recentCves: CveReading[] = all
    .slice()
    .sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''))
    .slice(0, RECENT_CVE_MAX)
    .map((v) => ({
      id: v.cveID, name: v.vulnerabilityName ?? v.cveID, vendor: v.vendorProject ?? '',
      product: v.product ?? '', dateAdded: v.dateAdded ?? '',
      ransomware: (v.knownRansomwareCampaignUse ?? '').toLowerCase() === 'known'
    }))
  const c2: C2Reading[] = (c2raw ?? []).map((c) => {
    const centroid = c.country ? COUNTRY_CENTROIDS[c.country] : undefined
    return {
      ip: c.ip_address ?? '', port: c.port ?? 0, country: c.country ?? '??',
      malware: c.malware ?? 'unknown', asName: c.as_name ?? '', firstSeen: c.first_seen ?? '',
      lat: centroid?.[0] ?? null, lng: centroid?.[1] ?? null
    }
  })
  return { ts: Date.now(), kevTotal: all.length, recentCves, c2Count: c2.length, c2, origin: 'live' }
}

// ═══ Service outages (Atlassian Statuspage summary feeds) ═════════════════
interface RawStatuspage {
  page?: { name?: string; url?: string; updated_at?: string }
  status?: { indicator?: string; description?: string }
  incidents?: { name?: string; status?: string }[]
}
const OUTAGE_LEVELS = new Set<OutageLevel>(['none', 'minor', 'major', 'critical'])
function normalizeIndicator(raw: string | undefined): OutageLevel {
  const v = (raw ?? 'none').toLowerCase() as OutageLevel
  // Statuspage occasionally reports 'maintenance' — treat as minor degradation.
  if (v === ('maintenance' as OutageLevel)) return 'minor'
  return OUTAGE_LEVELS.has(v) ? v : 'none'
}
async function fetchOutage(src: OutageSource): Promise<OutageReading> {
  const url = `https://${src.host}/api/v2/summary.json`
  try {
    const raw = (await fetchJson(url, { headers: { Accept: 'application/json' } })) as RawStatuspage
    const indicator = normalizeIndicator(raw.status?.indicator)
    const unresolved = (raw.incidents ?? []).filter((i) => (i.status ?? '').toLowerCase() !== 'resolved')
    const updated = raw.page?.updated_at ? Date.parse(raw.page.updated_at) : Date.now()
    return {
      id: src.id, name: src.name, url: raw.page?.url || `https://${src.host}`,
      indicator, description: raw.status?.description ?? 'Unknown',
      activeIncidents: unresolved.length, incidentTitle: unresolved[0]?.name ?? null,
      updatedAt: Number.isNaN(updated) ? Date.now() : updated, ok: true
    }
  } catch {
    // Keep the service in the list but flag it as not-OK rather than dropping it.
    return {
      id: src.id, name: src.name, url: `https://${src.host}`, indicator: 'none',
      description: 'No data', activeIncidents: 0, incidentTitle: null, updatedAt: Date.now(), ok: false
    }
  }
}
function normalizeOutage(readings: OutageReading[]): OutageSnapshot {
  const services = readings.slice().sort((a, b) =>
    OUTAGE_RANK[b.indicator] - OUTAGE_RANK[a.indicator] ||
    b.activeIncidents - a.activeIncidents ||
    a.name.localeCompare(b.name))
  const degradedCount = services.filter((s) => s.indicator !== 'none').length
  const worst = services.reduce<OutageLevel>((w, s) =>
    OUTAGE_RANK[s.indicator] > OUTAGE_RANK[w] ? s.indicator : w, 'none')
  return { ts: Date.now(), degradedCount, worst, services, origin: 'live' }
}

// ═══ IP Watch (public WAN address) ═══════════════════════════════════════
/** Try each source in order; return the first valid IP. */
async function fetchPublicIp(): Promise<string> {
  let lastErr: unknown
  for (const url of IP_SOURCES) {
    try {
      const raw = (await fetchJson(url)) as { ip?: string }
      if (raw.ip) return raw.ip
      throw new Error('no ip field in response')
    } catch (err) { lastErr = err }
  }
  throw lastErr instanceof Error ? lastErr : new Error('all IP sources unreachable')
}

// ═══════════════════════════════════════════════════════════════════════════

type Listener = (snap: OsintSnapshot) => void

interface VesselState extends VesselReading { lastSeen: number }

/** A geo-located feed event normalized for the geofence distance check. */
interface GeoEvent { id: string; lat: number; lng: number; label: string; detail: string }

class OsintHub {
  private listeners = new Set<Listener>()
  private pizza: PizzaSnapshot | null = null
  private pizzaHistory: PizzaHistoryPoint[] = []
  private seismic: SeismicSnapshot | null = null
  private aircraft: AircraftSnapshot | null = null
  private geomag: GeomagSnapshot | null = null
  private cyber: CyberSnapshot | null = null
  private vessels: VesselSnapshot | null = null
  private outage: OutageSnapshot | null = null
  private ipwatch: IpWatchSnapshot | null = null
  private ipCandidate: string | null = null
  private kpHistory: { ts: number; kp: number }[] = []

  // Geofence (home perimeter watch).
  private geofence: GeofenceConfig = { ...DEFAULT_GEOFENCE }
  private breaches: GeofenceBreach[] = []
  // Keys currently inside the perimeter (`kind:id`); used to dedupe and to
  // re-arm an event once it leaves and re-enters.
  private breachActive = new Set<string>()
  // Kinds whose inside-set has been seeded since the last (re)arm. The first
  // check per kind primes silently — so neither arming nor a server restart
  // (which reloads an armed fence from disk) alerts on what is already inside.
  private geofencePrimed = new Set<BreachKind>()
  private lastGeofenceAlert = 0
  private timers: NodeJS.Timeout[] = []
  private started = false

  // AIS websocket state.
  private vesselMap = new Map<number, VesselState>()
  private vesselsDirty = false

  // Alert dedupe state.
  private lastPizzaAlert = 0
  private alertedQuakeIds = new Set<string>()
  private prevStorm = false
  private alertedEmergency = new Set<string>()
  private prevOutageLevel = new Map<string, OutageLevel>()

  start(): void {
    if (this.started) return
    this.started = true
    this.loadFromDisk()
    this.schedule(() => this.pollPizza(), PIZZA_MS)
    this.schedule(() => this.pollSeismic(), SEISMIC_MS)
    this.schedule(() => this.pollAircraft(), AIRCRAFT_MS)
    this.schedule(() => this.pollGeomag(), GEOMAG_MS)
    this.schedule(() => this.pollCyber(), CYBER_MS)
    this.schedule(() => this.pollOutage(), OUTAGE_MS)
    this.schedule(() => this.pollIpWatch(), IPWATCH_MS)
    this.startAis()
    console.log('[osint] started — pizza/seismic/aircraft/geomag/cyber/outage/ipwatch/vessel watchers online')
  }

  private schedule(fn: () => Promise<void>, ms: number): void {
    void fn()
    this.timers.push(setInterval(() => void fn(), ms))
  }

  getLatest(): OsintSnapshot {
    return {
      pizza: this.pizza, pizzaHistory: this.pizzaHistory,
      seismic: this.seismic, aircraft: this.aircraft, geomag: this.geomag,
      cyber: this.cyber, vessels: this.vessels, outage: this.outage,
      ipwatch: this.ipwatch,
      geofence: { config: this.geofence, breaches: this.breaches }
    }
  }
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.getLatest())
    return () => this.listeners.delete(fn)
  }
  /** Force a refresh of every polled source (manual REFRESH button). */
  async refreshNow(): Promise<OsintSnapshot> {
    await Promise.allSettled([
      this.pollPizza(), this.pollSeismic(), this.pollAircraft(), this.pollGeomag(),
      this.pollCyber(), this.pollOutage(), this.pollIpWatch()
    ])
    return this.getLatest()
  }
  private emit(): void {
    const snap = this.getLatest()
    for (const fn of this.listeners) fn(snap)
  }

  // ── Pollers ──────────────────────────────────────────────────────────────
  private async pollPizza(): Promise<void> {
    try {
      const raw = (await fetchJson(PIZZA_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${PIZZA_KEY}`, 'Content-Type': 'application/json' }
      })) as RawPizza
      const prev = this.pizza
      const snap = normalizePizza(raw)
      this.pizza = snap
      // Dedup on the UPSTREAM timestamp, not snap.ts — snap.ts is Date.now() at
      // poll time, so it differs on every poll and the guard never fired: the
      // history filled with duplicate points whenever the feed had not moved.
      const last = this.pizzaHistory[this.pizzaHistory.length - 1]
      if (!last || !prev || prev.sourceTime !== snap.sourceTime) {
        this.pizzaHistory.push({ ts: snap.ts, indexScore: snap.indexScore, anomalyCount: snap.anomalyCount, defcon: snap.defcon })
        if (this.pizzaHistory.length > PIZZA_HISTORY_MAX) this.pizzaHistory.shift()
      }
      this.saveToDisk(); this.emit(); this.alertPizza(prev, snap)
    } catch (err) { this.fail('pizza', err) }
  }

  private async pollSeismic(): Promise<void> {
    try {
      const raw = (await fetchJson(SEISMIC_URL)) as { features?: RawQuakeFeature[] }
      const snap = normalizeSeismic(raw)
      this.seismic = snap
      this.checkGeofence('quake', this.quakeEvents())
      this.emit(); this.alertSeismic(snap)
    } catch (err) { this.fail('seismic', err) }
  }

  private async pollAircraft(): Promise<void> {
    try {
      const raw = (await fetchJson(AIRCRAFT_URL, { headers: { Accept: 'application/json' } })) as { ac?: RawAircraft[] }
      const snap = normalizeAircraft(raw)
      this.aircraft = snap
      this.checkGeofence('aircraft', this.aircraftEvents())
      this.emit(); this.alertAircraft(snap)
    } catch (err) { this.fail('aircraft', err) }
  }

  private async pollGeomag(): Promise<void> {
    try {
      const [kpRaw, auroraRaw] = await Promise.all([
        fetchJson(KP_URL) as Promise<{ kp_index?: number; estimated_kp?: number; time_tag?: string }[]>,
        fetchJson(AURORA_URL).catch(() => ({ coordinates: [] })) as Promise<{ coordinates?: [number, number, number][] }>
      ])
      const latest = kpRaw[kpRaw.length - 1]
      const kp = Math.round((latest?.estimated_kp ?? latest?.kp_index ?? 0) * 10) / 10
      const gScale = kpToG(kp)
      const last = this.kpHistory[this.kpHistory.length - 1]
      const tag = latest?.time_tag ? Date.parse(latest.time_tag) : Date.now()
      if (!last || last.ts !== tag) {
        this.kpHistory.push({ ts: tag, kp })
        if (this.kpHistory.length > KP_HISTORY_MAX) this.kpHistory.shift()
      }
      const snap: GeomagSnapshot = {
        ts: Date.now(), kp, gScale, gLabel: GSCALE_LABEL[gScale],
        aurora: downsampleAurora(auroraRaw), kpHistory: this.kpHistory.slice(), origin: 'live'
      }
      this.geomag = snap
      this.saveToDisk(); this.emit(); this.alertGeomag(snap)
    } catch (err) { this.fail('geomag', err) }
  }

  private async pollCyber(): Promise<void> {
    try {
      const [kev, c2] = await Promise.all([
        fetchJson(KEV_URL) as Promise<RawKev>,
        fetchJson(FEODO_URL).catch(() => []) as Promise<RawC2[]>
      ])
      const prev = this.cyber
      const snap = normalizeCyber(kev, Array.isArray(c2) ? c2 : [])
      this.cyber = snap
      this.emit(); this.alertCyber(prev, snap)
    } catch (err) { this.fail('cyber', err) }
  }

  private async pollOutage(): Promise<void> {
    try {
      const readings = await Promise.all(OUTAGE_SERVICES.map((s) => fetchOutage(s)))
      const snap = normalizeOutage(readings)
      // If every feed failed, treat the tick as an error rather than "all clear".
      if (readings.every((r) => !r.ok)) throw new Error('all status feeds unreachable')
      this.outage = snap
      this.emit(); this.alertOutage(snap)
    } catch (err) { this.fail('outage', err) }
  }

  private async pollIpWatch(): Promise<void> {
    try {
      const ip = await fetchPublicIp()
      const prev = this.ipwatch
      if (prev?.ip === ip) {
        // Unchanged — clear any pending unconfirmed candidate and refresh the tick.
        this.ipCandidate = null
        this.ipwatch = { ...prev, lastChecked: Date.now(), origin: 'live', error: undefined }
        this.emit(); this.saveToDisk()
        return
      }
      // Require the new address on two consecutive polls before treating it as
      // a real change — guards against a flaky/CDN'd source returning a fluke IP.
      if (this.ipCandidate !== ip) {
        this.ipCandidate = ip
        if (prev?.ip) { this.emit(); return }
      }
      this.ipCandidate = null
      const from = prev?.ip ?? null
      this.ipwatch = { ip, since: Date.now(), lastChecked: Date.now(), origin: 'live' }
      this.emit(); this.saveToDisk()
      if (from) this.alertIpWatch(from, ip)
    } catch (err) { this.fail('ipwatch', err) }
  }

  // ── Vessel AIS (persistent websocket) ──────────────────────────────────────
  private startAis(): void {
    if (!AIS_KEY) {
      this.vessels = { ts: Date.now(), count: 0, vessels: [], origin: 'nokey' }
      console.log('[osint] AIS disabled — set OSINT_AISSTREAM_KEY to enable vessel tracking')
      return
    }
    this.connectAis()
    // Coalesced flush so the AIS firehose never broadcasts per-message.
    this.timers.push(setInterval(() => this.flushVessels(), VESSEL_FLUSH_MS))
  }

  private connectAis(): void {
    let bbox: number[][][]
    try {
      bbox = process.env['OSINT_AIS_BBOX']
        ? JSON.parse(process.env['OSINT_AIS_BBOX'])
        : [[[-90, -180], [90, 180]]]
    } catch { bbox = [[[-90, -180], [90, 180]]] }

    const ws = new WebSocket(AIS_URL)
    ws.on('open', () => {
      ws.send(JSON.stringify({ APIKey: AIS_KEY, BoundingBoxes: bbox, FilterMessageTypes: ['PositionReport'] }))
      console.log('[osint] AIS websocket connected')
    })
    ws.on('message', (raw) => this.onAisMessage(raw.toString()))
    ws.on('error', (err) => console.error('[osint] AIS error:', (err as Error).message))
    ws.on('close', () => {
      if (this.vessels) this.vessels = { ...this.vessels, origin: 'cache' }
      setTimeout(() => { if (AIS_KEY) this.connectAis() }, 5_000)
    })
  }

  private onAisMessage(text: string): void {
    let msg: {
      MessageType?: string
      MetaData?: { MMSI?: number; ShipName?: string; latitude?: number; longitude?: number }
      Message?: { PositionReport?: { Cog?: number; Sog?: number } }
    }
    try { msg = JSON.parse(text) } catch { return }
    if (msg.MessageType !== 'PositionReport') return
    const md = msg.MetaData
    const pr = msg.Message?.PositionReport
    if (!md?.MMSI || typeof md.latitude !== 'number' || typeof md.longitude !== 'number') return
    this.vesselMap.set(md.MMSI, {
      mmsi: md.MMSI, name: (md.ShipName ?? '').trim() || `MMSI ${md.MMSI}`,
      lat: md.latitude, lng: md.longitude,
      cog: typeof pr?.Cog === 'number' ? Math.round(pr.Cog) : null,
      sog: typeof pr?.Sog === 'number' ? Math.round(pr.Sog * 10) / 10 : null,
      lastSeen: Date.now()
    })
    this.vesselsDirty = true
    // Bound memory between flushes.
    if (this.vesselMap.size > 6000) {
      const oldest = [...this.vesselMap.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (oldest) this.vesselMap.delete(oldest.mmsi)
    }
  }

  private flushVessels(): void {
    if (!this.vesselsDirty) return
    this.vesselsDirty = false
    const cutoff = Date.now() - VESSEL_STALE_MS
    for (const [mmsi, v] of this.vesselMap) if (v.lastSeen < cutoff) this.vesselMap.delete(mmsi)
    const sorted = [...this.vesselMap.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, VESSEL_MAX)
    const vessels: VesselReading[] = sorted.map(({ mmsi, name, lat, lng, cog, sog }) => ({ mmsi, name, lat, lng, cog, sog }))
    this.vessels = { ts: Date.now(), count: this.vesselMap.size, vessels, origin: 'live' }
    this.checkGeofence('vessel', this.vesselEvents())
    this.emit()
  }

  private fail(source: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[osint] ${source} poll failed:`, message)
    // Flag the affected source as cache/error but keep serving the rest.
    if (source === 'pizza' && this.pizza) this.pizza = { ...this.pizza, origin: 'cache', error: message }
    if (source === 'seismic' && this.seismic) this.seismic = { ...this.seismic, origin: 'cache', error: message }
    if (source === 'aircraft' && this.aircraft) this.aircraft = { ...this.aircraft, origin: 'cache', error: message }
    if (source === 'geomag' && this.geomag) this.geomag = { ...this.geomag, origin: 'cache', error: message }
    if (source === 'cyber' && this.cyber) this.cyber = { ...this.cyber, origin: 'cache', error: message }
    if (source === 'outage' && this.outage) this.outage = { ...this.outage, origin: 'cache', error: message }
    if (source === 'ipwatch') {
      this.ipwatch = this.ipwatch
        ? { ...this.ipwatch, origin: 'error', error: message }
        : { ip: null, since: null, lastChecked: Date.now(), origin: 'error', error: message }
    }
    this.emit()
  }

  // ── Alerts ─────────────────────────────────────────────────────────────
  private alertPizza(prev: PizzaSnapshot | null, cur: PizzaSnapshot): void {
    const escalated = cur.anomalyCount > 0 && (!prev || cur.defcon < prev.defcon || cur.anomalyCount > prev.anomalyCount)
    if (!escalated) return
    const now = Date.now()
    if (now - this.lastPizzaAlert < ALERT_COOLDOWN_MS) return
    this.lastPizzaAlert = now
    const top = cur.readings.find((r) => r.isAnomaly) ?? cur.readings[0]
    broadcastProactive(`Captain — PizzINT anomaly. ${cur.anomalyCount} venue(s) above baseline (${DEFCON_LABEL[cur.defcon]}).` +
      (top ? ` ${top.name} running ${Math.round(top.deviation * 100)}% over typical.` : ''),
      { source: 'OSINT', severity: cur.defcon <= 2 ? 'critical' : 'warn', title: 'PizzINT anomaly' })
  }

  private alertSeismic(snap: SeismicSnapshot): void {
    for (const q of snap.quakes) {
      if (q.mag >= 6.0 && !this.alertedQuakeIds.has(q.id)) {
        this.alertedQuakeIds.add(q.id)
        broadcastProactive(`Captain — significant seismic event. Magnitude ${q.mag} ${q.place}.` +
          (q.tsunami ? ' Tsunami flag raised.' : ''),
          { source: 'OSINT', severity: 'critical', title: 'Seismic event' })
      }
    }
    // Bound the dedupe set.
    if (this.alertedQuakeIds.size > 500) this.alertedQuakeIds = new Set(snap.quakes.map((q) => q.id))
  }

  private alertAircraft(snap: AircraftSnapshot): void {
    for (const a of snap.aircraft) {
      if (a.emergency && !this.alertedEmergency.has(a.hex)) {
        this.alertedEmergency.add(a.hex)
        broadcastProactive(`Captain — aircraft squawking emergency. ${a.callsign} (${a.type}).`,
          { source: 'OSINT', severity: 'critical', title: 'Emergency squawk' })
      }
    }
    // Drop hexes no longer airborne so a later re-squawk re-alerts.
    const live = new Set(snap.aircraft.map((a) => a.hex))
    for (const hex of this.alertedEmergency) if (!live.has(hex)) this.alertedEmergency.delete(hex)
  }

  private alertGeomag(snap: GeomagSnapshot): void {
    const storm = snap.gScale >= 1
    if (storm && !this.prevStorm) {
      broadcastProactive(`Captain — geomagnetic storm in progress. Kp ${snap.kp}, ${snap.gLabel}. Aurora activity elevated.`,
        { source: 'OSINT', severity: 'warn', title: 'Geomagnetic storm' })
    }
    this.prevStorm = storm
  }

  private alertCyber(prev: CyberSnapshot | null, cur: CyberSnapshot): void {
    if (!prev) return // don't alert on first load
    const known = new Set(prev.recentCves.map((c) => c.id))
    const fresh = cur.recentCves.filter((c) => !known.has(c.id) && c.ransomware)
    for (const c of fresh) {
      broadcastProactive(`Captain — new ransomware-linked vulnerability added to the CISA catalog. ${c.id}: ${c.vendor} ${c.product}.`,
        { source: 'OSINT', severity: 'warn', title: 'Exploited CVE' })
    }
  }

  private alertOutage(snap: OutageSnapshot): void {
    const first = this.prevOutageLevel.size === 0
    for (const s of snap.services) {
      if (!s.ok) continue
      const prev = this.prevOutageLevel.get(s.id) ?? 'none'
      this.prevOutageLevel.set(s.id, s.indicator)
      // Alert on a fresh escalation into major/critical (not on first prime).
      const escalated = OUTAGE_RANK[s.indicator] >= OUTAGE_RANK.major && OUTAGE_RANK[s.indicator] > OUTAGE_RANK[prev]
      if (escalated && !first) {
        broadcastProactive(`Captain — ${s.name} is reporting a ${s.indicator} outage. ${s.incidentTitle ?? s.description}.`,
          { source: 'OSINT', severity: s.indicator === 'critical' ? 'critical' : 'warn', title: `${s.name} outage` })
      }
    }
  }

  private alertIpWatch(from: string, to: string): void {
    broadcastProactive(`Captain — WAN address changed. New public IP ${to} (was ${from}). Whitelist it for any locked-down APIs.`,
      { source: 'OSINT', severity: 'warn', title: 'Public IP changed' })
  }

  // ── Geofence (home perimeter watch) ────────────────────────────────────────
  /** Replace the armed perimeter (pushed from a client) and re-prime it. */
  setGeofence(config: GeofenceConfig): void {
    this.geofence = {
      enabled: !!config.enabled,
      lat: typeof config.lat === 'number' ? config.lat : null,
      lng: typeof config.lng === 'number' ? config.lng : null,
      radiusKm: Number.isFinite(config.radiusKm) && config.radiusKm > 0 ? config.radiusKm : DEFAULT_GEOFENCE.radiusKm
    }
    // Forget the inside-set so arming (or moving / resizing) the fence re-primes
    // on the next check of each feed, rather than alerting on what's already in.
    this.breachActive.clear()
    this.geofencePrimed.clear()
    this.saveToDisk(); this.emit()
  }

  private quakeEvents(): GeoEvent[] {
    return (this.seismic?.quakes ?? []).map((q) => ({
      id: q.id, lat: q.lat, lng: q.lng, label: `M${q.mag.toFixed(1)} quake`, detail: q.place
    }))
  }
  private aircraftEvents(): GeoEvent[] {
    return (this.aircraft?.aircraft ?? []).map((a) => ({
      id: a.hex, lat: a.lat, lng: a.lng, label: a.callsign,
      detail: `${a.type}${a.altFt != null ? ` · ${a.altFt.toLocaleString()} ft` : ''}${a.emergency ? ' · EMERGENCY' : ''}`
    }))
  }
  private vesselEvents(): GeoEvent[] {
    return (this.vessels?.vessels ?? []).map((v) => ({
      id: String(v.mmsi), lat: v.lat, lng: v.lng, label: v.name,
      detail: `${v.sog != null ? `${v.sog} kn` : '—'}${v.cog != null ? ` · ${v.cog}°` : ''}`
    }))
  }

  /**
   * Test one feed's events against the armed perimeter, record fresh crossings
   * and fire a proactive alert. The first call per kind after a (re)arm — or
   * after a restart that reloaded an armed fence — seeds the inside-set silently
   * so we never alert on what was already within the perimeter.
   */
  private checkGeofence(kind: BreachKind, events: GeoEvent[]): void {
    const g = this.geofence
    if (!g.enabled || g.lat == null || g.lng == null) return
    const prime = !this.geofencePrimed.has(kind)
    this.geofencePrimed.add(kind)
    const prefix = `${kind}:`
    const inside = new Set<string>()
    const fresh: GeofenceBreach[] = []
    for (const e of events) {
      const distanceKm = haversineKm(g.lat, g.lng, e.lat, e.lng)
      if (distanceKm > g.radiusKm) continue
      const key = prefix + e.id
      inside.add(key)
      if (!this.breachActive.has(key)) {
        fresh.push({ id: key, kind, label: e.label, detail: e.detail, lat: e.lat, lng: e.lng,
          distanceKm: Math.round(distanceKm * 10) / 10, ts: Date.now() })
      }
    }
    // Re-arm anything of this kind that has left the perimeter.
    for (const key of this.breachActive) if (key.startsWith(prefix) && !inside.has(key)) this.breachActive.delete(key)
    for (const key of inside) this.breachActive.add(key)
    if (prime || fresh.length === 0) return

    fresh.sort((a, b) => a.distanceKm - b.distanceKm)
    this.breaches = [...fresh, ...this.breaches].slice(0, GEOFENCE_BREACH_MAX)

    const now = Date.now()
    if (now - this.lastGeofenceAlert < GEOFENCE_ALERT_COOLDOWN_MS) return
    this.lastGeofenceAlert = now
    const lead = fresh[0]
    const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''
    broadcastProactive(`Captain — perimeter breach. ${lead.label} ${lead.distanceKm} km from home: ${lead.detail}.${more}`,
      { source: 'OSINT', severity: 'critical', title: 'Perimeter breach' })
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  private loadFromDisk(): void {
    try {
      if (!existsSync(STORE_PATH)) return
      const p = stateStore.readJson<{
        pizza?: PizzaSnapshot; pizzaHistory?: PizzaHistoryPoint[]; kpHistory?: { ts: number; kp: number }[]
        geofence?: GeofenceConfig; ipwatch?: IpWatchSnapshot
      }>(STORE_PATH, {})
      if (p.pizza) this.pizza = { ...p.pizza, origin: 'cache' }
      if (Array.isArray(p.pizzaHistory)) this.pizzaHistory = p.pizzaHistory.slice(-PIZZA_HISTORY_MAX)
      if (Array.isArray(p.kpHistory)) this.kpHistory = p.kpHistory.slice(-KP_HISTORY_MAX)
      if (p.geofence) this.geofence = { ...DEFAULT_GEOFENCE, ...p.geofence }
      if (p.ipwatch) this.ipwatch = { ...p.ipwatch, origin: 'cache' }
      console.log(`[osint] restored ${this.pizzaHistory.length} pizza / ${this.kpHistory.length} kp history points` +
        (this.geofence.enabled ? ` · geofence armed (${this.geofence.radiusKm}km)` : '') +
        (this.ipwatch?.ip ? ` · last known IP ${this.ipwatch.ip}` : ''))
    } catch (err) { console.error('[osint] load store failed:', (err as Error).message) }
  }
  private saveToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
      stateStore.writeJson(STORE_PATH, {
        pizza: this.pizza, pizzaHistory: this.pizzaHistory, kpHistory: this.kpHistory,
        geofence: this.geofence, ipwatch: this.ipwatch
      })
    } catch (err) { console.error('[osint] save store failed:', (err as Error).message) }
  }
}

export const osintHub = new OsintHub()
