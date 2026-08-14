// Osint — open-source intelligence watchers that monitor things happening on
// the internet and surface anomalies to the bridge. The first watcher is the
// Pentagon Pizza Index (PizzINT): activity at pizzerias near the Pentagon,
// derived from public Google "Popular Times"-style busyness data.

/** One pizzeria's current reading. */
export interface PizzaReading {
  locationId: string
  name: string
  address: string
  lat: number
  lng: number
  distanceMiles: number
  /** Current busyness 0–100. */
  busyness: number
  /** Typical busyness for this day/hour, 0–100. */
  typical: number
  /** Fractional deviation above typical (0.4 = 40% busier than normal). */
  deviation: number
  isAnomaly: boolean
}

/** A full poll of the Pentagon Pizza Index. */
export interface PizzaSnapshot {
  /** When this snapshot was captured locally (ms epoch). */
  ts: number
  /** Source-reported capture time (ISO). */
  sourceTime: string
  timezone: string
  isLateNight: boolean
  /** e.g. "pattern_model" or "live" — what the upstream used. */
  dataSource: string
  locationCount: number
  anomalyCount: number
  /** Overall index 0–100 (mean busyness across locations). */
  indexScore: number
  /** Mean fractional deviation above typical across locations. */
  deviationAvg: number
  /** Derived alert posture, 5 (all quiet) … 1 (major surge). */
  defcon: number
  readings: PizzaReading[]
  /** Where this snapshot came from for the current render. */
  origin: 'live' | 'cache' | 'error'
  error?: string
}

/** A single index point retained for the trend sparkline. */
export interface PizzaHistoryPoint {
  ts: number
  indexScore: number
  anomalyCount: number
  defcon: number
}

// ── Seismic watch (USGS) ───────────────────────────────────────────────────

export interface QuakeReading {
  id: string
  mag: number
  place: string
  lat: number
  lng: number
  depthKm: number
  time: number
  tsunami: boolean
}

export interface SeismicSnapshot {
  ts: number
  count: number
  largest: { mag: number; place: string } | null
  quakes: QuakeReading[]
  origin: 'live' | 'cache' | 'error'
  error?: string
}

// ── Skywatch (military ADS-B) ──────────────────────────────────────────────

export interface AircraftReading {
  hex: string
  callsign: string
  type: string
  lat: number
  lng: number
  altFt: number | null
  groundSpeed: number | null
  track: number | null
  /** True if squawking 7500/7600/7700 or flagged emergency. */
  emergency: boolean
}

export interface AircraftSnapshot {
  ts: number
  /** Total military aircraft seen (incl. those without a position fix). */
  count: number
  /** Aircraft with a usable lat/lng (what the globe plots). */
  aircraft: AircraftReading[]
  emergencyCount: number
  origin: 'live' | 'cache' | 'error'
  error?: string
}

// ── Geomagnetic / solar (NOAA SWPC) ────────────────────────────────────────

/** One downsampled OVATION aurora cell with non-trivial probability. */
export interface AuroraCell {
  lat: number
  lng: number
  prob: number
}

export interface GeomagSnapshot {
  ts: number
  /** Planetary K-index, 0–9. */
  kp: number
  /** NOAA G-scale storm level, 0 (none) … 5 (extreme). */
  gScale: number
  gLabel: string
  /** Downsampled aurora oval for the globe heatmap overlay. */
  aurora: AuroraCell[]
  kpHistory: { ts: number; kp: number }[]
  origin: 'live' | 'cache' | 'error'
  error?: string
}

// ── Cyber threat (CISA KEV + abuse.ch Feodo) ───────────────────────────────

export interface CveReading {
  id: string
  name: string
  vendor: string
  product: string
  dateAdded: string
  ransomware: boolean
}

export interface C2Reading {
  ip: string
  port: number
  country: string
  malware: string
  asName: string
  firstSeen: string
  /** Country-centroid position for the globe (null if country unknown). */
  lat: number | null
  lng: number | null
}

export interface CyberSnapshot {
  ts: number
  /** Total known-exploited vulnerabilities in the CISA catalog. */
  kevTotal: number
  /** Most recently added KEV entries. */
  recentCves: CveReading[]
  c2Count: number
  c2: C2Reading[]
  origin: 'live' | 'cache' | 'error'
  error?: string
}

// ── Vessel AIS (aisstream.io) ──────────────────────────────────────────────

export interface VesselReading {
  mmsi: number
  name: string
  lat: number
  lng: number
  /** Course over ground, degrees. */
  cog: number | null
  /** Speed over ground, knots. */
  sog: number | null
}

export interface VesselSnapshot {
  ts: number
  count: number
  vessels: VesselReading[]
  /** 'nokey' = no aisstream API key configured (feed disabled). */
  origin: 'live' | 'cache' | 'error' | 'nokey'
  error?: string
}

// ── Service outages (official status pages) ────────────────────────────────
// Downdetector-style "what's down right now" signal, sourced from the official
// Atlassian Statuspage feeds (`/api/v2/summary.json`) that power most service
// status pages — keyless and authoritative, rather than crowd reports.

/** Statuspage severity, in ascending order of badness. */
export type OutageLevel = 'none' | 'minor' | 'major' | 'critical'

/** One tracked service's current status. */
export interface OutageReading {
  /** Stable slug, e.g. 'discord'. */
  id: string
  name: string
  /** Public status-page URL. */
  url: string
  indicator: OutageLevel
  /** Source-reported summary, e.g. "All Systems Operational". */
  description: string
  /** Unresolved incidents currently posted on the status page. */
  activeIncidents: number
  /** Title of the most recent unresolved incident, if any. */
  incidentTitle: string | null
  /** Source's last-updated time (ms epoch). */
  updatedAt: number
  /** False when this service's feed failed this tick (shows as stale). */
  ok: boolean
}

export interface OutageSnapshot {
  ts: number
  /** Services currently degraded (indicator !== 'none'). */
  degradedCount: number
  /** Worst indicator across all tracked services. */
  worst: OutageLevel
  services: OutageReading[]
  origin: 'live' | 'cache' | 'error'
  error?: string
}

// ── Geofence (home perimeter watch) ────────────────────────────────────────
// A radius around a pinned home location. The hub checks every geo-bearing feed
// (quakes, aircraft, vessels) against it on each poll and fires a proactive
// alert when a fresh event crosses inside — so the perimeter is armed even with
// no UI client connected.

/** The armed perimeter. Pushed from the client; persisted + enforced hub-side. */
export interface GeofenceConfig {
  enabled: boolean
  lat: number | null
  lng: number | null
  /** Perimeter radius in kilometres. */
  radiusKm: number
}

/** Kinds of feed event a geofence can flag. */
export type BreachKind = 'quake' | 'aircraft' | 'vessel'

/** One event that crossed inside the perimeter. */
export interface GeofenceBreach {
  /** Stable dedupe key, `kind:eventId`. */
  id: string
  kind: BreachKind
  label: string
  detail: string
  lat: number
  lng: number
  /** Distance from home centre, km. */
  distanceKm: number
  ts: number
}

export interface GeofenceSnapshot {
  config: GeofenceConfig
  /** Recent breaches, newest first. */
  breaches: GeofenceBreach[]
}

/** Public WAN IP watcher — for keeping API allowlists in sync. */
export interface IpWatchSnapshot {
  ip: string | null
  /** When the current IP was first observed (ms epoch). */
  since: number | null
  lastChecked: number
  origin: 'live' | 'cache' | 'error'
  error?: string
}

export const DEFAULT_GEOFENCE: GeofenceConfig = { enabled: false, lat: null, lng: null, radiusKm: 150 }

export const BREACH_ICON: Record<BreachKind, string> = {
  quake: 'ti-activity', aircraft: 'ti-plane', vessel: 'ti-anchor'
}

/** What the UI subscribes to over the `osint` channel. */
export interface OsintSnapshot {
  pizza: PizzaSnapshot | null
  pizzaHistory: PizzaHistoryPoint[]
  seismic: SeismicSnapshot | null
  aircraft: AircraftSnapshot | null
  geomag: GeomagSnapshot | null
  cyber: CyberSnapshot | null
  vessels: VesselSnapshot | null
  outage: OutageSnapshot | null
  ipwatch: IpWatchSnapshot | null
  geofence: GeofenceSnapshot
}

/** Rank of an OutageLevel for sorting/comparison (higher = worse). */
export const OUTAGE_RANK: Record<OutageLevel, number> = {
  none: 0, minor: 1, major: 2, critical: 3
}

/** NOAA G-scale labels by level. */
export const GSCALE_LABEL: Record<number, string> = {
  0: 'QUIET',
  1: 'G1 MINOR',
  2: 'G2 MODERATE',
  3: 'G3 STRONG',
  4: 'G4 SEVERE',
  5: 'G5 EXTREME'
}

export const DEFCON_LABEL: Record<number, string> = {
  5: 'ALL QUIET',
  4: 'ELEVATED',
  3: 'ACTIVE',
  2: 'HIGH ALERT',
  1: 'SURGE'
}
