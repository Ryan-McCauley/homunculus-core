import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GeofenceConfig } from '../shared/osint'

// osintHub is a module-level singleton whose constructor does no I/O (all of that is
// deferred to start()/poll*()), so a fresh module per test — same pattern as the other
// hub singletons in this suite — gives every test a clean instance.
//
// SCOPE NOTE: start() wires up setInterval polling loops and a persistent AIS websocket
// (see server/osint.ts lines ~374-563) with no corresponding stop()/teardown — calling
// it in a test would leak real timers and a real 'ws' connection attempt across tests.
// That orchestration is exercised nowhere here; instead every poller is invoked directly
// (via a private-method cast, exactly like the tick()/standdownSweep() casts used for
// agents.ts) so the normalization, alert-dedupe and geofence logic — the separable core —
// gets full coverage without ever starting a real timer or socket.

const fsState = vi.hoisted(() => ({ exists: false }))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  mkdirSync: vi.fn(),
}))

const storeState = vi.hoisted(() => ({ data: undefined as unknown }))
vi.mock('./stateStore', () => ({
  stateStore: {
    readJson: vi.fn((_file: string, fallback: unknown) => (storeState.data === undefined ? fallback : storeState.data)),
    writeJson: vi.fn((_file: string, value: unknown) => { storeState.data = value }),
  },
}))

const chatMock = vi.hoisted(() => ({ broadcastProactive: vi.fn() }))
vi.mock('./chat', () => chatMock)

const fetchState = vi.hoisted(() => ({ routes: [] as { match: string; get: () => unknown }[] }))
function route(match: string, data: unknown | (() => unknown)) {
  fetchState.routes.push({ match, get: typeof data === 'function' ? (data as () => unknown) : () => data })
}
function routeFail(match: string) {
  fetchState.routes.push({ match, get: () => { throw new Error(`simulated failure for ${match}`) } })
}
const fetchMock = vi.fn(async (url: string) => {
  for (const r of fetchState.routes) {
    if (url.includes(r.match)) {
      const data = r.get()
      return { ok: true, status: 200, json: async () => data }
    }
  }
  throw new Error(`no fetch route stubbed for ${url}`)
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fsState.exists = false
  storeState.data = undefined
  fetchState.routes = []
  vi.stubGlobal('fetch', fetchMock)
})

async function freshHub() {
  const mod = await import('./osint')
  return mod.osintHub as unknown as {
    getLatest: () => ReturnType<typeof mod.osintHub.getLatest>
    subscribe: typeof mod.osintHub.subscribe
    refreshNow: typeof mod.osintHub.refreshNow
    setGeofence: (c: GeofenceConfig) => void
    pollPizza: () => Promise<void>
    pollSeismic: () => Promise<void>
    pollAircraft: () => Promise<void>
    pollGeomag: () => Promise<void>
    pollCyber: () => Promise<void>
    pollOutage: () => Promise<void>
    pollIpWatch: () => Promise<void>
    onAisMessage: (raw: string) => void
    flushVessels: () => void
    loadFromDisk: () => void
    fail: (source: string, err: unknown) => void
  }
}

// ── Fixtures for each upstream feed's raw shape ─────────────────────────────

function pizzaPayload(readings: Partial<{ location_id: string; busyness_level: number; typical_level: number; is_anomaly: boolean; location: { name: string; lat: number; lng: number } }>[]) {
  return {
    timestamp: '2026-08-09T00:00:00Z', timezone: 'America/New_York', isLateNight: false,
    dataSource: 'test', anomalyCount: readings.filter((r) => r.is_anomaly).length,
    readings: readings.map((r) => ({
      location_id: r.location_id ?? 'loc', busyness_level: r.busyness_level ?? 0,
      typical_level: r.typical_level ?? 0, is_anomaly: !!r.is_anomaly, location: r.location ?? { name: 'Test' },
    })),
  }
}

function quakeFeature(id: string, mag: number, lng: number, lat: number, tsunami = 0) {
  return { id, properties: { mag, place: `near ${id}`, time: Date.now(), tsunami }, geometry: { coordinates: [lng, lat, 10] } }
}

function aircraftRaw(list: { hex: string; lat: number; lon: number; squawk?: string; emergency?: string; flight?: string }[]) {
  return { ac: list.map((a) => ({ hex: a.hex, flight: a.flight, lat: a.lat, lon: a.lon, squawk: a.squawk, emergency: a.emergency, t: 'F16' })) }
}

function kpRaw(kp: number, timeTag = new Date().toISOString()) {
  return [{ kp_index: kp, time_tag: timeTag }]
}

beforeEach(() => {
  // Default happy-path routes so any poller not under test still resolves.
  route('planetary_k_index', kpRaw(1))
  route('ovation_aurora', { coordinates: [] })
  route('known_exploited_vulnerabilities', { vulnerabilities: [] })
  route('ipblocklist', [])
  route('summary.json', { page: { name: 'x', url: 'https://x', updated_at: new Date().toISOString() }, status: { indicator: 'none' }, incidents: [] })
  route('ipify', { ip: '1.1.1.1' })
})

describe('pizza — normalization and escalation alerts', () => {
  it('computes defcon, index score and deviation from raw readings', async () => {
    const hub = await freshHub()
    route('fetch-busyness', pizzaPayload([
      { location_id: 'a', busyness_level: 80, typical_level: 40, is_anomaly: true },
      { location_id: 'b', busyness_level: 20, typical_level: 20, is_anomaly: false },
    ]))
    await hub.pollPizza()
    const pizza = hub.getLatest().pizza!
    expect(pizza.anomalyCount).toBe(1)
    expect(pizza.readings[0]!.locationId).toBe('a') // sorted by busyness desc
    expect(pizza.indexScore).toBe(50) // mean(80,20)
    expect(pizza.defcon).toBeLessThanOrEqual(4) // 1 anomaly, deviation 1.0 -> defcon 1 by the >=0.8 rule
  })

  it('appends one history point per distinct sourceTime, not per poll', async () => {
    const hub = await freshHub()
    route('fetch-busyness', pizzaPayload([{ location_id: 'a', busyness_level: 10, typical_level: 10 }]))
    await hub.pollPizza()
    await hub.pollPizza() // same raw timestamp both times
    expect(hub.getLatest().pizzaHistory).toHaveLength(1)
  })

  it('alerts on the first anomaly and suppresses a repeat within the cooldown window', async () => {
    vi.useFakeTimers()
    try {
      const hub = await freshHub()
      route('fetch-busyness', pizzaPayload([{ location_id: 'a', busyness_level: 90, typical_level: 10, is_anomaly: true }]))
      await hub.pollPizza()
      expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)

      await hub.pollPizza() // same anomaly count/defcon — not an escalation either way
      expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 31 * 60_000)
      fetchState.routes = fetchState.routes.filter((r) => r.match !== 'fetch-busyness')
      route('fetch-busyness', pizzaPayload([
        { location_id: 'a', busyness_level: 90, typical_level: 10, is_anomaly: true },
        { location_id: 'b', busyness_level: 90, typical_level: 10, is_anomaly: true },
      ]))
      await hub.pollPizza() // anomalyCount increased AND cooldown has elapsed
      expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the cached snapshot as stale (without discarding it) when the feed fails', async () => {
    const hub = await freshHub()
    route('fetch-busyness', pizzaPayload([{ location_id: 'a', busyness_level: 10, typical_level: 10 }]))
    await hub.pollPizza()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'fetch-busyness')
    routeFail('fetch-busyness')
    await hub.pollPizza()
    const pizza = hub.getLatest().pizza!
    expect(pizza.origin).toBe('cache')
    expect(pizza.error).toMatch(/simulated failure/)
    expect(pizza.readings).toHaveLength(1) // stale data preserved, not wiped
  })
})

describe('seismic — normalization and magnitude alerts', () => {
  it('sorts by magnitude and reports the largest quake', async () => {
    const hub = await freshHub()
    route('earthquake.usgs.gov', { features: [quakeFeature('q1', 3.2, -100, 30), quakeFeature('q2', 5.8, -101, 31)] })
    await hub.pollSeismic()
    const seismic = hub.getLatest().seismic!
    expect(seismic.quakes[0]!.id).toBe('q2')
    expect(seismic.largest).toEqual({ mag: 5.8, place: 'near q2' })
  })

  it('alerts once per >=6.0 quake and never re-alerts the same id', async () => {
    const hub = await freshHub()
    route('earthquake.usgs.gov', { features: [quakeFeature('big', 6.4, -100, 30, 1)] })
    await hub.pollSeismic()
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)
    expect(chatMock.broadcastProactive).toHaveBeenCalledWith(expect.stringMatching(/Tsunami flag raised/), expect.anything())
    await hub.pollSeismic() // identical feed, same id
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)
  })

  it('does not alert below the 6.0 threshold', async () => {
    const hub = await freshHub()
    route('earthquake.usgs.gov', { features: [quakeFeature('small', 4.1, -100, 30)] })
    await hub.pollSeismic()
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()
  })
})

describe('aircraft — emergency squawk detection', () => {
  it('drops entries with no fix and flags emergency by squawk code', async () => {
    const hub = await freshHub()
    route('adsb.fi', { ac: [
      { hex: 'noFix' }, // no lat/lon at all — must be dropped, unlike a source with the fix
      { hex: 'ok1', lat: 10, lon: 20, squawk: '7700', flight: 'RCH123', t: 'F16' },
    ] })
    await hub.pollAircraft()
    const snap = hub.getLatest().aircraft!
    expect(snap.aircraft).toHaveLength(1)
    expect(snap.aircraft[0]!.emergency).toBe(true)
    expect(snap.emergencyCount).toBe(1)
  })

  it('alerts once per emergency hex and re-arms once the hex is no longer airborne', async () => {
    const hub = await freshHub()
    route('adsb.fi', aircraftRaw([{ hex: 'e1', lat: 10, lon: 20, squawk: '7700' }]))
    await hub.pollAircraft()
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)
    await hub.pollAircraft() // still squawking, same poll
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'adsb.fi')
    route('adsb.fi', aircraftRaw([])) // e1 lands / drops off
    await hub.pollAircraft()

    route('adsb.fi', aircraftRaw([{ hex: 'e1', lat: 10, lon: 20, squawk: '7700' }]))
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'adsb.fi' || fetchState.routes.indexOf(r) === fetchState.routes.length - 1)
    await hub.pollAircraft()
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(2)
  })
})

describe('geomagnetic — Kp/G-scale bucketing and storm-onset alerts', () => {
  it('buckets Kp into the correct G-scale', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'planetary_k_index')
    route('planetary_k_index', kpRaw(7))
    await hub.pollGeomag()
    expect(hub.getLatest().geomag!.gScale).toBe(3)
  })

  it('alerts only on the transition into a storm, not on every subsequent poll', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'planetary_k_index')
    route('planetary_k_index', kpRaw(2, '2026-08-09T00:00:00Z'))
    await hub.pollGeomag() // quiet
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'planetary_k_index')
    route('planetary_k_index', kpRaw(6, '2026-08-09T00:01:00Z'))
    await hub.pollGeomag() // storm begins
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'planetary_k_index')
    route('planetary_k_index', kpRaw(7, '2026-08-09T00:02:00Z'))
    await hub.pollGeomag() // still storming
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)
  })

  it('deduplicates Kp history by time_tag but grows on a new tag', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'planetary_k_index')
    route('planetary_k_index', kpRaw(3, '2026-08-09T00:00:00Z'))
    await hub.pollGeomag()
    await hub.pollGeomag()
    expect(hub.getLatest().geomag!.kpHistory).toHaveLength(1)
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'planetary_k_index')
    route('planetary_k_index', kpRaw(3, '2026-08-09T00:01:00Z'))
    await hub.pollGeomag()
    expect(hub.getLatest().geomag!.kpHistory).toHaveLength(2)
  })
})

describe('cyber — new ransomware CVE alerts', () => {
  it('never alerts on the very first load', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'known_exploited_vulnerabilities')
    route('known_exploited_vulnerabilities', { vulnerabilities: [{ cveID: 'CVE-1', knownRansomwareCampaignUse: 'Known' }] })
    await hub.pollCyber()
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()
  })

  it('alerts on a fresh ransomware-linked CVE but not a fresh non-ransomware one', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'known_exploited_vulnerabilities')
    route('known_exploited_vulnerabilities', { vulnerabilities: [{ cveID: 'CVE-old', knownRansomwareCampaignUse: 'Known' }] })
    await hub.pollCyber()

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'known_exploited_vulnerabilities')
    route('known_exploited_vulnerabilities', {
      vulnerabilities: [
        { cveID: 'CVE-old', knownRansomwareCampaignUse: 'Known' },
        { cveID: 'CVE-new-ransom', knownRansomwareCampaignUse: 'Known', vendorProject: 'Acme', product: 'Widget' },
        { cveID: 'CVE-new-plain', knownRansomwareCampaignUse: 'Unknown' },
      ],
    })
    await hub.pollCyber()
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)
    expect(chatMock.broadcastProactive).toHaveBeenCalledWith(expect.stringMatching(/CVE-new-ransom/), expect.anything())
  })
})

describe('outages — Statuspage ranking and escalation alerts', () => {
  it('ranks the worst indicator across every configured service', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'summary.json')
    route('githubstatus.com', { status: { indicator: 'major' }, incidents: [{ name: 'API errors', status: 'investigating' }] })
    route('summary.json', { status: { indicator: 'none' }, incidents: [] }) // catch-all for the other 11 hosts
    await hub.pollOutage()
    const outage = hub.getLatest().outage!
    expect(outage.worst).toBe('major')
    expect(outage.services[0]!.id).toBe('github')
    expect(outage.services[0]!.incidentTitle).toBe('API errors')
  })

  it('treats "maintenance" as a minor degradation', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'summary.json')
    route('githubstatus.com', { status: { indicator: 'maintenance' }, incidents: [] })
    route('summary.json', { status: { indicator: 'none' }, incidents: [] })
    await hub.pollOutage()
    expect(hub.getLatest().outage!.services.find((s) => s.id === 'github')!.indicator).toBe('minor')
  })

  it('does not alert on the first poll, only on a later escalation into major/critical', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'summary.json')
    route('summary.json', { status: { indicator: 'none' }, incidents: [] })
    await hub.pollOutage()
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'summary.json' && r.match !== 'githubstatus.com')
    route('githubstatus.com', { status: { indicator: 'critical' }, incidents: [{ name: 'Full outage', status: 'investigating' }] })
    route('summary.json', { status: { indicator: 'none' }, incidents: [] })
    await hub.pollOutage()
    expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)
    expect(chatMock.broadcastProactive).toHaveBeenCalledWith(expect.stringMatching(/GitHub/), expect.anything())
  })

  it('treats an all-feeds failure as an error rather than a false "all clear"', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'summary.json')
    routeFail('summary.json') // every one of the 12 hosts fails the same way
    await hub.pollOutage()
    expect(hub.getLatest().outage).toBeNull()
  })
})

describe('ip watch — two-poll confirmation before treating a change as real', () => {
  it('commits the very first observed address immediately, with no alert', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'ipify')
    route('ipify', { ip: '1.1.1.1' })
    await hub.pollIpWatch()
    expect(hub.getLatest().ipwatch!.ip).toBe('1.1.1.1')
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()
  })

  it('requires the same new address on two consecutive polls before alerting', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'ipify')
    route('ipify', { ip: '1.1.1.1' })
    await hub.pollIpWatch() // confirmed baseline

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'ipify')
    route('ipify', { ip: '2.2.2.2' })
    await hub.pollIpWatch() // first sighting of the new address — not yet committed
    expect(hub.getLatest().ipwatch!.ip).toBe('1.1.1.1')
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()

    await hub.pollIpWatch() // seen again — now it commits
    expect(hub.getLatest().ipwatch!.ip).toBe('2.2.2.2')
    expect(chatMock.broadcastProactive).toHaveBeenCalledWith(expect.stringMatching(/1\.1\.1\.1.*2\.2\.2\.2|2\.2\.2\.2.*1\.1\.1\.1/), expect.anything())
  })

  it('falls back to the next IP source when the first is unreachable', async () => {
    const hub = await freshHub()
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'ipify')
    routeFail('ipify')
    route('ifconfig.co', { ip: '3.3.3.3' })
    await hub.pollIpWatch()
    expect(hub.getLatest().ipwatch!.ip).toBe('3.3.3.3')
  })
})

describe('geofence — perimeter breach detection', () => {
  const home: GeofenceConfig = { enabled: true, lat: 40.0, lng: -75.0, radiusKm: 100 }

  it('does nothing while disabled', async () => {
    const hub = await freshHub()
    route('earthquake.usgs.gov', { features: [quakeFeature('near', 4.0, -75.0, 40.05)] })
    await hub.pollSeismic()
    await hub.pollSeismic()
    expect(hub.getLatest().geofence.breaches).toHaveLength(0)
  })

  it('primes silently on the first check after arming — no breach for what is already inside', async () => {
    const hub = await freshHub()
    hub.setGeofence(home)
    route('earthquake.usgs.gov', { features: [quakeFeature('already-inside', 4.0, -75.0, 40.05)] })
    await hub.pollSeismic()
    expect(hub.getLatest().geofence.breaches).toHaveLength(0)
    expect(chatMock.broadcastProactive).not.toHaveBeenCalled()
  })

  it('records and alerts on a fresh entry after priming', async () => {
    const hub = await freshHub()
    hub.setGeofence(home)
    route('earthquake.usgs.gov', { features: [] })
    await hub.pollSeismic() // primes with nothing inside

    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
    route('earthquake.usgs.gov', { features: [quakeFeature('newcomer', 4.5, -75.0, 40.05) as never] })
    await hub.pollSeismic()
    const breaches = hub.getLatest().geofence.breaches
    expect(breaches).toHaveLength(1)
    expect(breaches[0]!.kind).toBe('quake')
    expect(chatMock.broadcastProactive).toHaveBeenCalledWith(expect.stringMatching(/perimeter breach/i), expect.anything())
  })

  it('ignores an event outside the configured radius', async () => {
    const hub = await freshHub()
    hub.setGeofence(home)
    await hub.pollSeismic() // prime on empty
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
    route('earthquake.usgs.gov', { features: [quakeFeature('far', 4.5, 0, 0) as never] }) // nowhere near home
    await hub.pollSeismic()
    expect(hub.getLatest().geofence.breaches).toHaveLength(0)
  })

  it('re-arms an id once it leaves the perimeter, so a later re-entry breaches again', async () => {
    const hub = await freshHub()
    hub.setGeofence(home)
    route('earthquake.usgs.gov', { features: [] })
    await hub.pollSeismic() // prime empty
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
    route('earthquake.usgs.gov', { features: [quakeFeature('cycler', 4.5, -75.0, 40.05) as never] })
    await hub.pollSeismic() // enters — 1 breach
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
    route('earthquake.usgs.gov', { features: [] })
    await hub.pollSeismic() // leaves
    fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
    route('earthquake.usgs.gov', { features: [quakeFeature('cycler', 4.5, -75.0, 40.05) as never] })
    await hub.pollSeismic() // re-enters
    expect(hub.getLatest().geofence.breaches).toHaveLength(2)
  })

  it('suppresses the voice alert inside its own cooldown but still logs the breach', async () => {
    vi.useFakeTimers()
    try {
      const hub = await freshHub()
      hub.setGeofence(home)
      route('earthquake.usgs.gov', { features: [] })
      await hub.pollSeismic() // prime empty
      fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
      route('earthquake.usgs.gov', { features: [quakeFeature('q1', 4.5, -75.0, 40.05) as never] })
      await hub.pollSeismic()
      expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 60_000) // well inside the 5-minute geofence cooldown
      fetchState.routes = fetchState.routes.filter((r) => r.match !== 'earthquake.usgs.gov')
      route('earthquake.usgs.gov', { features: [quakeFeature('q1', 4.5, -75.0, 40.05) as never, quakeFeature('q2', 4.5, -75.0, 40.06) as never] })
      await hub.pollSeismic()
      expect(hub.getLatest().geofence.breaches.length).toBeGreaterThanOrEqual(2) // q2 logged
      expect(chatMock.broadcastProactive).toHaveBeenCalledTimes(1) // but voice alert stayed suppressed
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a non-finite or non-positive radius and falls back to the default', async () => {
    const hub = await freshHub()
    hub.setGeofence({ enabled: true, lat: 1, lng: 2, radiusKm: -5 })
    expect(hub.getLatest().geofence.config.radiusKm).toBe(150)
  })

  it('also geofences vessel positions from the AIS stream', async () => {
    const hub = await freshHub()
    hub.setGeofence(home)
    // flushVessels() is a no-op unless something is dirty, so the "priming" flush needs
    // its own (out-of-range) message first, exactly like the first live poll for any
    // other feed primes checkGeofence() before a real breach can be recorded.
    hub.onAisMessage(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 999, latitude: 0, longitude: 0 } }))
    hub.flushVessels()
    hub.onAisMessage(JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 123, ShipName: 'Tester', latitude: 40.05, longitude: -75.0 },
      Message: { PositionReport: { Cog: 90, Sog: 12 } },
    }))
    hub.flushVessels()
    const breaches = hub.getLatest().geofence.breaches
    expect(breaches.some((b) => b.kind === 'vessel')).toBe(true)
  })
})

describe('AIS vessel ingestion (message handling only — no real socket)', () => {
  it('ignores non-position messages and malformed JSON', async () => {
    const hub = await freshHub()
    hub.onAisMessage('not json')
    hub.onAisMessage(JSON.stringify({ MessageType: 'ShipStaticData' }))
    hub.flushVessels()
    expect(hub.getLatest().vessels).toBeNull() // flushVessels no-ops when nothing was ever marked dirty
  })

  it('drops a position report missing MMSI or coordinates', async () => {
    const hub = await freshHub()
    hub.onAisMessage(JSON.stringify({ MessageType: 'PositionReport', MetaData: { latitude: 1, longitude: 2 } }))
    hub.flushVessels()
    expect(hub.getLatest().vessels).toBeNull()
  })

  it('ingests a valid report and surfaces it after a flush', async () => {
    const hub = await freshHub()
    hub.onAisMessage(JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 42, ShipName: ' Nautilus ', latitude: 10, longitude: 20 },
      Message: { PositionReport: { Cog: 88.6, Sog: 5.25 } },
    }))
    hub.flushVessels()
    const vessels = hub.getLatest().vessels!
    expect(vessels.count).toBe(1)
    expect(vessels.vessels[0]).toMatchObject({ mmsi: 42, name: 'Nautilus', lat: 10, lng: 20, cog: 89, sog: 5.3 })
  })

  it('prunes vessels that have gone stale by the next flush', async () => {
    vi.useFakeTimers()
    try {
      const hub = await freshHub()
      hub.onAisMessage(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 1, latitude: 1, longitude: 1 } }))
      hub.flushVessels()
      expect(hub.getLatest().vessels!.count).toBe(1)
      vi.setSystemTime(Date.now() + 11 * 60_000) // past VESSEL_STALE_MS (10 min)
      hub.onAisMessage(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 2, latitude: 2, longitude: 2 } }))
      hub.flushVessels()
      expect(hub.getLatest().vessels!.count).toBe(1) // MMSI 1 aged out, only 2 remains
      expect(hub.getLatest().vessels!.vessels[0]!.mmsi).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('subscribe / getLatest', () => {
  it('replays the current snapshot to a new subscriber immediately', async () => {
    const hub = await freshHub()
    const fn = vi.fn()
    hub.subscribe(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(hub.getLatest())
  })

  it('stops notifying once unsubscribed', async () => {
    const hub = await freshHub()
    const fn = vi.fn()
    const unsubscribe = hub.subscribe(fn)
    unsubscribe()
    route('earthquake.usgs.gov', { features: [] })
    await hub.pollSeismic()
    expect(fn).toHaveBeenCalledTimes(1) // only the initial replay
  })

  it('refreshNow polls every source and returns the merged snapshot', async () => {
    const hub = await freshHub()
    route('fetch-busyness', pizzaPayload([]))
    route('earthquake.usgs.gov', { features: [] })
    route('adsb.fi', { ac: [] })
    route('known_exploited_vulnerabilities', { vulnerabilities: [] })
    const snap = await hub.refreshNow()
    expect(snap.pizza).not.toBeNull()
    expect(snap.seismic).not.toBeNull()
    expect(snap.aircraft).not.toBeNull()
  })
})

describe('loadFromDisk', () => {
  it('restores a persisted geofence and marks cached data as such', async () => {
    fsState.exists = true
    storeState.data = {
      pizza: { ts: 1, sourceTime: '', timezone: '', isLateNight: false, dataSource: 'x', locationCount: 0, anomalyCount: 0, indexScore: 0, deviationAvg: 0, defcon: 5, readings: [], origin: 'live' },
      geofence: { enabled: true, lat: 40, lng: -75, radiusKm: 50 },
    }
    const hub = await freshHub()
    hub.loadFromDisk()
    expect(hub.getLatest().pizza!.origin).toBe('cache')
    expect(hub.getLatest().geofence.config).toEqual({ enabled: true, lat: 40, lng: -75, radiusKm: 50 })
  })

  it('does nothing when no store file exists yet', async () => {
    fsState.exists = false
    const hub = await freshHub()
    hub.loadFromDisk()
    expect(hub.getLatest().pizza).toBeNull()
    expect(hub.getLatest().geofence.config.enabled).toBe(false)
  })
})
