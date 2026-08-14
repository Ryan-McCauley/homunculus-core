import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TelemetrySnapshot } from '../shared/telemetry'
import type { HaSnapshot } from '../shared/homeassistant'
import type { ArchiveEvent } from '../shared/archive'

// `historyHub` is a module-level singleton built around a lazily-created
// `postgres` client. We fake the `postgres` factory entirely: calling it
// returns a callable that behaves like the real tagged-template client just
// enough to record what it was asked to do and hand back queued results.
// Every real tagged-template call (has `.raw` on its first argument) consumes
// one entry from `pg.state.results`; every "dynamic value" helper call (e.g.
// `sql(rows)`, `sql(columnName)`) returns synchronously and is not queued
// against, mirroring how the real driver treats those helpers.
const pg = vi.hoisted(() => {
  const calls: unknown[][] = []
  const state: { results: unknown[]; throwOnConnect: string | null } = { results: [], throwOnConnect: null }
  return { calls, state }
})

vi.mock('postgres', () => ({
  default: vi.fn((_url: string, _opts: unknown) => {
    if (pg.state.throwOnConnect) throw new Error(pg.state.throwOnConnect)
    const sqlFn = (...args: unknown[]) => {
      pg.calls.push(args)
      const first = args[0] as { raw?: unknown } | undefined
      const isTagged = Array.isArray(first) && (first as unknown as { raw?: unknown }).raw !== undefined
      if (!isTagged) return { __dynamic: args }
      const next = pg.state.results.shift()
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(next ?? [])
    }
    ;(sqlFn as unknown as { json: unknown }).json = (v: unknown) => ({ __json: v })
    ;(sqlFn as unknown as { end: unknown }).end = vi.fn(() => Promise.resolve())
    return sqlFn
  }),
}))

async function freshModule(databaseUrl: string) {
  vi.resetModules()
  pg.calls.length = 0
  pg.state.results = []
  vi.stubEnv('DATABASE_URL', databaseUrl)
  return import('./history')
}

beforeEach(() => {
  pg.state.throwOnConnect = null
})

function taggedCalls() {
  return pg.calls.filter((args) => {
    const first = args[0] as { raw?: unknown } | undefined
    return Array.isArray(first) && (first as unknown as { raw?: unknown }).raw !== undefined
  })
}

function sqlText(args: unknown[]): string {
  return (args[0] as string[]).join('?')
}

const snap = (over: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot => ({
  ts: 1000,
  cpu: { load: 10, cores: [], speedGHz: null, tempC: 40, tempMaxC: null },
  memory: { usedBytes: 1, totalBytes: 2, percent: 50, swapPercent: 0 },
  storage: { usedBytes: 1, totalBytes: 2, percent: 50 },
  network: { rxMbps: 1, txMbps: 1, totalBytes: 2 },
  tasks: 10,
  uptimeSec: 100,
  topProcesses: [],
  ...over,
})

describe('start() / enabled', () => {
  it('stays disabled and never calls postgres when DATABASE_URL is unset', async () => {
    const m = await freshModule('')
    await m.historyHub.start()
    expect(m.historyHub.enabled).toBe(false)
    expect(pg.calls).toHaveLength(0)
  })

  it('connects and runs the migration when DATABASE_URL is set', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    expect(m.historyHub.enabled).toBe(true)
    const migrationSql = taggedCalls().map(sqlText).join('\n')
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS telemetry')
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS ha_numeric')
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS events')
  })

  it('falls back to disabled (without throwing) when the connection fails', async () => {
    pg.state.throwOnConnect = 'connection refused'
    const m = await freshModule('postgres://test')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(m.historyHub.start()).resolves.toBeUndefined()
    expect(m.historyHub.enabled).toBe(false)
    expect(errSpy).toHaveBeenCalled()
  })

  it('stop() clears the client so enabled goes back to false', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    expect(m.historyHub.enabled).toBe(true)
    await m.historyHub.stop()
    expect(m.historyHub.enabled).toBe(false)
  })
})

describe('queryTelemetry — column whitelist', () => {
  it('rejects a metric outside the whitelist without querying the database', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    const before = pg.calls.length
    const res = await m.historyHub.queryTelemetry('cpu_load; DROP TABLE telemetry;--' as never, 0, 1)
    expect(res).toEqual([])
    expect(pg.calls.length).toBe(before) // no new call was issued
  })

  it('accepts every whitelisted metric and forwards it as a dynamic column value', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    for (const metric of ['cpu_load', 'cpu_temp_c', 'mem_pct', 'swap_pct', 'rx_mbps', 'tx_mbps', 'storage_pct'] as const) {
      pg.state.results.push([])
      const res = await m.historyHub.queryTelemetry(metric, 0, 100)
      expect(res).toEqual([])
    }
    // One dynamic-column helper call per accepted metric.
    const dynamicCalls = pg.calls.filter((args) => typeof args[0] === 'string')
    expect(dynamicCalls.map((a) => a[0])).toEqual([
      'cpu_load', 'cpu_temp_c', 'mem_pct', 'swap_pct', 'rx_mbps', 'tx_mbps', 'storage_pct',
    ])
  })

  it('returns [] without querying when the database is not connected', async () => {
    const m = await freshModule('')
    const res = await m.historyHub.queryTelemetry('cpu_load', 0, 1)
    expect(res).toEqual([])
    expect(pg.calls).toHaveLength(0)
  })

  it('maps and reverses rows into chronological order', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push([
      { ts: '200', value: '5' },
      { ts: '100', value: '3' },
    ])
    const res = await m.historyHub.queryTelemetry('cpu_load', 0, 1000)
    expect(res).toEqual([{ ts: 100, value: 3 }, { ts: 200, value: 5 }])
  })

  it('passes through a null value rather than coercing it to a number', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push([{ ts: '100', value: null }])
    const res = await m.historyHub.queryTelemetry('cpu_load', 0, 1000)
    expect(res).toEqual([{ ts: 100, value: null }])
  })
})

describe('recordEvent / recentEvents', () => {
  const event: ArchiveEvent = { id: 'e1', ts: 1, source: 'HOME', severity: 'info', title: 'T', body: 'B' }

  it('no-ops when disabled', async () => {
    const m = await freshModule('')
    await expect(m.historyHub.recordEvent(event)).resolves.toBeUndefined()
    expect(pg.calls).toHaveLength(0)
  })

  it('inserts the event when connected', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push([])
    await m.historyHub.recordEvent(event)
    const insert = taggedCalls().find((a) => sqlText(a).includes('INSERT INTO events'))
    expect(insert).toBeDefined()
  })

  it('swallows a write failure instead of throwing', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push(new Error('write failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(m.historyHub.recordEvent(event)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
  })

  it('returns [] for recentEvents when disabled', async () => {
    const m = await freshModule('')
    expect(await m.historyHub.recentEvents()).toEqual([])
  })
})

describe('recordTelemetry', () => {
  it('no-ops when disabled', async () => {
    const m = await freshModule('')
    await m.historyHub.recordTelemetry(snap())
    expect(pg.calls).toHaveLength(0)
  })

  it('inserts a row shaped from the snapshot when connected', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push([])
    await m.historyHub.recordTelemetry(snap({ ts: 555 }))
    const insert = taggedCalls().find((a) => sqlText(a).includes('INSERT INTO telemetry'))!
    expect(insert[1]).toBe(555)
  })
})

describe('recordHa', () => {
  const haSnap = (entities: HaSnapshot['entities'], connected = true): HaSnapshot => ({
    ts: 42, connected, url: null, tempUnit: '°F', climate: [], entities, devices: [],
  })

  it('no-ops when disabled', async () => {
    const m = await freshModule('')
    await m.historyHub.recordHa(haSnap([]))
    expect(pg.calls).toHaveLength(0)
  })

  it('no-ops when the snapshot is not connected, even if enabled', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    const before = pg.calls.length
    await m.historyHub.recordHa(haSnap([], false))
    expect(pg.calls.length).toBe(before)
  })

  it('filters to entities whose state parses as a finite number', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push([])
    const entities = [
      { entityId: 'sensor.temp', domain: 'sensor', name: 'Temp', state: '72.5', unit: null, deviceClass: null, attributes: {}, lastChanged: null },
      { entityId: 'sensor.mode', domain: 'sensor', name: 'Mode', state: 'idle', unit: null, deviceClass: null, attributes: {}, lastChanged: null },
    ] as HaSnapshot['entities']
    await m.historyHub.recordHa(haSnap(entities))
    const dynamicRowsCall = pg.calls.find((a) => Array.isArray(a[0]) && (a[0] as unknown[])[0] && (a[0] as { entity_id?: string }[])[0]!.entity_id === 'sensor.temp')
    expect(dynamicRowsCall).toBeDefined()
    expect((dynamicRowsCall![0] as unknown[])).toHaveLength(1)
  })

  it('skips the insert entirely when no entity has a finite numeric state', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    const before = pg.calls.length
    const entities = [
      { entityId: 'sensor.mode', domain: 'sensor', name: 'Mode', state: 'idle', unit: null, deviceClass: null, attributes: {}, lastChanged: null },
    ] as HaSnapshot['entities']
    await m.historyHub.recordHa(haSnap(entities))
    expect(pg.calls.length).toBe(before)
  })
})

describe('listHaEntities', () => {
  it('returns [] when disabled', async () => {
    const m = await freshModule('')
    expect(await m.historyHub.listHaEntities()).toEqual([])
  })

  it('returns the distinct entity ids when connected', async () => {
    const m = await freshModule('postgres://test')
    await m.historyHub.start()
    pg.state.results.push([{ entity_id: 'sensor.a' }, { entity_id: 'sensor.b' }])
    expect(await m.historyHub.listHaEntities()).toEqual(['sensor.a', 'sensor.b'])
  })
})
