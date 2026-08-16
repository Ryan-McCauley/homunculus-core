import { describe, it, expect, vi } from 'vitest'

// HA_URL/HA_TOKEN/HA_POLL_MS are read from process.env at module import time,
// and `haHub` is a module-level singleton that owns a setInterval poll loop —
// so every test gets a fresh module instance over stubbed env, and the actual
// poll loop is exercised with real (short) timers and a mocked global fetch
// rather than trying to fake-timer-step through several chained awaits.
//
// IMPORTANT: every test that subscribes MUST call the returned unsubscribe
// function before it ends. haHub's poll loop only stops once its listener
// count hits zero, so a forgotten unsub leaves a real setInterval running in
// the background for the rest of the file, silently piggy-backing on
// whichever `fetch` mock a later test happens to install and corrupting that
// later test's call counts. (Caught this the hard way while writing these
// tests — see the "stops polling" test below, which is exactly what would
// have caught the leak if an earlier test had one.)
//
// OUT OF SCOPE (documented per the task brief): the poll loop's own timer
// bookkeeping (ensureRunning/stop, listener ref-counting) is only exercised
// indirectly through subscribe()/unsubscribe below — it is wiring, not logic.
// What IS covered in depth is the classification/shaping logic that would
// otherwise be untestable because it is private: RELEVANT_DOMAINS filtering,
// parseClimate/parseEntity field mapping, and groupDevices' regex matching —
// all exercised through the public snapshot the hub emits.

async function freshModule(env: { url?: string; token?: string; pollMs?: string } = {}) {
  vi.resetModules()
  vi.stubEnv('HA_URL', env.url ?? 'http://ha.local:8123')
  vi.stubEnv('HA_TOKEN', env.token ?? 'secret-token')
  vi.stubEnv('HA_POLL_MS', env.pollMs ?? '20')
  return import('./homeassistant')
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

const STATES_FIXTURE = [
  {
    entity_id: 'climate.main_thermostat', state: 'heat',
    attributes: { friendly_name: 'Thermostat', current_temperature: 70, temperature: 72, current_humidity: 40, hvac_action: 'heating' },
    last_changed: '2026-01-01T00:00:00Z',
  },
  {
    entity_id: 'sensor.washer_current_status', state: 'run',
    attributes: { friendly_name: 'Washer Status' }, last_changed: '2026-01-01T00:00:01Z',
  },
  {
    entity_id: 'vacuum.r2peepoo_litter_box', state: 'docked',
    attributes: { friendly_name: 'R2PEEPOO' }, last_changed: '2026-01-01T00:00:02Z',
  },
  {
    entity_id: 'cover.voltaire_charge_port_door', state: 'closed',
    attributes: { friendly_name: 'Voltaire Charge Port' }, last_changed: '2026-01-01T00:00:03Z',
  },
  {
    // Irrelevant domain — must be filtered out of `entities`.
    entity_id: 'tts.google_say', state: 'idle', attributes: {}, last_changed: '2026-01-01T00:00:04Z',
  },
]

function mockFetchHappy(states: unknown[] = STATES_FIXTURE, tempUnit = '°C') {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/config')) return okJson({ unit_system: { temperature: tempUnit } })
    if (url.endsWith('/api/states')) return okJson(states)
    throw new Error(`unexpected fetch: ${url}`)
  })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('configured', () => {
  it('is false when HA_URL or HA_TOKEN is missing', async () => {
    const m = await freshModule({ url: '' })
    expect(m.haHub.configured).toBe(false)
  })

  it('is true when both are set', async () => {
    const m = await freshModule()
    expect(m.haHub.configured).toBe(true)
  })
})

describe('subscribe — snapshot shaping', () => {
  it('emits an empty disconnected snapshot immediately when not configured', async () => {
    const m = await freshModule({ url: '' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ connected: false, climate: [], entities: [], devices: [] }))
    unsub()
  })

  it('parses climate entities into the typed climate shape', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', mockFetchHappy())
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(snap.connected).toBe(true)
    expect(snap.tempUnit).toBe('°C')
    expect(snap.climate).toEqual([{
      entityId: 'climate.main_thermostat', name: 'Thermostat', state: 'heat',
      currentTemp: 70, targetTemp: 72, targetTempLow: null, targetTempHigh: null,
      humidity: 40, hvacAction: 'heating',
    }])
    unsub()
  })

  it('filters `entities` down to RELEVANT_DOMAINS, dropping unlisted domains like tts', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', mockFetchHappy())
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
    const ids = snap.entities.map((e: { entityId: string }) => e.entityId)
    expect(ids).toEqual(expect.arrayContaining([
      'climate.main_thermostat', 'sensor.washer_current_status',
      'vacuum.r2peepoo_litter_box', 'cover.voltaire_charge_port_door',
    ]))
    expect(ids).not.toContain('tts.google_say')
    unsub()
  })

  it('groups entities into logical devices by regex, dropping empty groups', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', mockFetchHappy())
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
    const byKey: Record<string, string[]> = {}
    for (const d of snap.devices) byKey[d.key] = d.entities.map((e: { entityId: string }) => e.entityId)
    expect(byKey['voltaire']).toEqual(['cover.voltaire_charge_port_door'])
    expect(byKey['r2peepoo']).toEqual(['vacuum.r2peepoo_litter_box'])
    expect(byKey['washer']).toEqual(['sensor.washer_current_status'])
    expect(byKey['thermostat']).toEqual(['climate.main_thermostat'])
    // Devices with no matching entities (dryer, colony, backup) must not appear.
    expect(snap.devices.map((d: { key: string }) => d.key)).not.toContain('dryer')
    unsub()
  })

  it('falls back to °F when HA reports an unrecognized unit system', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', mockFetchHappy(STATES_FIXTURE, 'kelvin' as never))
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(snap.tempUnit).toBe('°F')
    unsub()
  })

  it('emits a disconnected empty snapshot and logs when the poll fails', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(snap.connected).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    unsub()
  })

  it('throws (surfaced as a failed poll) when /api/states responds non-ok', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/config')) return okJson({ unit_system: { temperature: '°F' } })
      return { ok: false, status: 500, json: async () => ({}) }
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(snap.connected).toBe(false)
    unsub()
  })

  it('primes a newly-subscribed listener with the latest snapshot without a new fetch', async () => {
    const m = await freshModule()
    const fetchMock = mockFetchHappy()
    vi.stubGlobal('fetch', fetchMock)
    const first = vi.fn()
    const unsub1 = m.haHub.subscribe(first)
    await wait(10)
    const callsAfterFirst = fetchMock.mock.calls.length

    const second = vi.fn()
    const unsub2 = m.haHub.subscribe(second)
    expect(second).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst) // no extra poll just from subscribing
    unsub1()
    unsub2()
  })

  it('stops polling once the last listener unsubscribes', async () => {
    const m = await freshModule({ pollMs: '15' })
    const fetchMock = mockFetchHappy()
    vi.stubGlobal('fetch', fetchMock)
    const listener = vi.fn()
    const unsub = m.haHub.subscribe(listener)
    await wait(20)
    unsub()
    const countAtUnsub = fetchMock.mock.calls.length
    await wait(60)
    expect(fetchMock.mock.calls.length).toBe(countAtUnsub)
  })
})

describe('sendCommand', () => {
  it('throws immediately when not configured, without calling fetch', async () => {
    const m = await freshModule({ url: '' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(m.haHub.sendCommand('light.kitchen', 'light.turn_on', {})).rejects.toThrow('HA not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to /api/services/<domain>/<service> with the entity id merged into the body', async () => {
    const m = await freshModule()
    const fetchMock = vi.fn((_url: string, _init: { body: string }) => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    await m.haHub.sendCommand('climate.main_thermostat', 'climate.set_temperature', { temperature: 68 })
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe('http://ha.local:8123/api/services/climate/set_temperature')
    expect(call[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
    })
    // Assert the body by value, not by serialized key order (entity_id is now
    // spread last so a data.entity_id can't override it).
    expect(JSON.parse(call[1].body)).toEqual({
      entity_id: 'climate.main_thermostat', temperature: 68,
    })
  })

  it('entity_id cannot be overridden by a data.entity_id key', async () => {
    const m = await freshModule()
    const fetchMock = vi.fn((_url: string, _init: { body: string }) => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    await m.haHub.sendCommand('switch.lamp', 'switch.turn_on', { entity_id: 'lock.front_door' })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.entity_id).toBe('switch.lamp')
  })

  it('throws with the HTTP status when the service call fails', async () => {
    const m = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    await expect(m.haHub.sendCommand('light.kitchen', 'light.turn_on', {})).rejects.toThrow('404')
  })
})
