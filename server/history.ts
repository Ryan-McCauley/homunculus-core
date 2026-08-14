// Persistent time-series history for telemetry and Home Assistant numerics.
// Tees from telemetryHub and haHub into Postgres. Disabled gracefully if
// DATABASE_URL is not set. All writes are fire-and-forget (errors logged, not
// thrown) so a DB hiccup never affects the live UI.

import postgres from 'postgres'
import type { TelemetrySnapshot } from '../shared/telemetry'
import type { HaSnapshot } from '../shared/homeassistant'
import type { ArchiveEvent, EventSource, EventSeverity } from '../shared/archive'

const DATABASE_URL = process.env['DATABASE_URL'] || ''

// Column names for the telemetry table — whitelisted to prevent SQL injection
// in queryTelemetry's dynamic column selection.
const TELEMETRY_METRICS = [
  'cpu_load', 'cpu_temp_c', 'mem_pct', 'swap_pct',
  'rx_mbps', 'tx_mbps', 'storage_pct'
] as const
export type TelemetryMetric = typeof TELEMETRY_METRICS[number]

class HistoryHub {
  private sql: ReturnType<typeof postgres> | null = null

  /** True only once a connection actually succeeded and migrated. This used to report
   *  `!!DATABASE_URL`, which stayed true even when start() failed (bad URL, missing
   *  database, server down) — so index.ts installed a permanent telemetryHub subscriber
   *  that fed a dead sink, and because TelemetryHub only stops once its listener count
   *  hits zero, that pinned the 2s collect() loop (which shells out to `ps` via
   *  si.processes()) on forever, with or without a UI client attached. */
  get enabled(): boolean {
    return this.sql !== null
  }

  async start(): Promise<void> {
    if (!DATABASE_URL) {
      console.log('[history] DATABASE_URL not set — history capture disabled')
      return
    }
    try {
      this.sql = postgres(DATABASE_URL, { max: 3, idle_timeout: 30 })
      await this.migrate()
      console.log('[history] Postgres connected — history capture enabled')
    } catch (err) {
      console.error('[history] failed to connect to Postgres:', (err as Error).message)
      this.sql = null
    }
  }

  async stop(): Promise<void> {
    await this.sql?.end({ timeout: 5 })
    this.sql = null
  }

  private async migrate(): Promise<void> {
    if (!this.sql) return
    // telemetry: one row per 2s collect() tick, fixed numeric columns
    await this.sql`
      CREATE TABLE IF NOT EXISTS telemetry (
        ts          BIGINT   NOT NULL,
        cpu_load    SMALLINT,
        cpu_temp_c  REAL,
        mem_pct     SMALLINT,
        swap_pct    SMALLINT,
        rx_mbps     REAL,
        tx_mbps     REAL,
        storage_pct SMALLINT
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS telemetry_ts ON telemetry(ts)`

    // ha_numeric: one row per entity per HA poll tick (10s), for any entity
    // whose state parses as a finite number (sensors, battery %, temps, etc.)
    await this.sql`
      CREATE TABLE IF NOT EXISTS ha_numeric (
        ts        BIGINT NOT NULL,
        entity_id TEXT   NOT NULL,
        value     REAL   NOT NULL
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS ha_numeric_entity_ts ON ha_numeric(entity_id, ts)`

    // events: the ARCHIVE log — one row per proactive/notable event. Durable,
    // unbounded backing for the in-memory ring the ArchiveHub keeps.
    await this.sql`
      CREATE TABLE IF NOT EXISTS events (
        id       TEXT PRIMARY KEY,
        ts       BIGINT NOT NULL,
        source   TEXT   NOT NULL,
        severity TEXT   NOT NULL,
        title    TEXT   NOT NULL,
        body     TEXT   NOT NULL
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS events_ts ON events(ts)`
  }

  // ── Archive events ────────────────────────────────────────────────────────
  async recordEvent(e: ArchiveEvent): Promise<void> {
    if (!this.sql) return
    try {
      await this.sql`
        INSERT INTO events (id, ts, source, severity, title, body)
        VALUES (${e.id}, ${e.ts}, ${e.source}, ${e.severity}, ${e.title}, ${e.body})
        ON CONFLICT (id) DO NOTHING
      `
    } catch (err) {
      console.error('[history] event write failed:', (err as Error).message)
    }
  }

  // Most recent events, newest first (used to hydrate the ARCHIVE console).
  async recentEvents(limit = 200): Promise<ArchiveEvent[]> {
    if (!this.sql) return []
    const rows = await this.sql`
      SELECT id, ts, source, severity, title, body
      FROM events ORDER BY ts DESC LIMIT ${limit}
    `
    return rows.map((r) => ({
      id: r['id'] as string,
      ts: Number(r['ts']),
      source: r['source'] as EventSource,
      severity: r['severity'] as EventSeverity,
      title: r['title'] as string,
      body: r['body'] as string
    }))
  }

  async recordTelemetry(snap: TelemetrySnapshot): Promise<void> {
    if (!this.sql) return
    try {
      await this.sql`
        INSERT INTO telemetry
          (ts, cpu_load, cpu_temp_c, mem_pct, swap_pct, rx_mbps, tx_mbps, storage_pct)
        VALUES (
          ${snap.ts},
          ${snap.cpu.load},
          ${snap.cpu.tempC},
          ${snap.memory.percent},
          ${snap.memory.swapPercent},
          ${snap.network.rxMbps},
          ${snap.network.txMbps},
          ${snap.storage.percent}
        )
      `
    } catch (err) {
      console.error('[history] telemetry write failed:', (err as Error).message)
    }
  }

  async recordHa(snap: HaSnapshot): Promise<void> {
    if (!this.sql || !snap.connected) return
    try {
      const rows = snap.entities
        .map((e) => ({ ts: snap.ts, entity_id: e.entityId, value: Number(e.state) }))
        .filter((r) => Number.isFinite(r.value))
      if (rows.length === 0) return
      await this.sql`INSERT INTO ha_numeric ${this.sql(rows)}`
    } catch (err) {
      console.error('[history] HA write failed:', (err as Error).message)
    }
  }

  async queryTelemetry(
    metric: TelemetryMetric,
    fromMs: number,
    toMs: number,
    limit = 500
  ): Promise<Array<{ ts: number; value: number | null }>> {
    if (!this.sql) return []
    if (!(TELEMETRY_METRICS as readonly string[]).includes(metric)) return []
    const rows = await this.sql`
      SELECT ts, ${this.sql(metric)} AS value
      FROM telemetry
      WHERE ts >= ${fromMs} AND ts <= ${toMs}
      ORDER BY ts DESC
      LIMIT ${limit}
    `
    return rows
      .map((r) => ({ ts: Number(r['ts']), value: r['value'] != null ? Number(r['value']) : null }))
      .reverse()
  }

  async queryHa(
    entityId: string,
    fromMs: number,
    toMs: number,
    limit = 500
  ): Promise<Array<{ ts: number; value: number }>> {
    if (!this.sql) return []
    const rows = await this.sql`
      SELECT ts, value
      FROM ha_numeric
      WHERE entity_id = ${entityId} AND ts >= ${fromMs} AND ts <= ${toMs}
      ORDER BY ts DESC
      LIMIT ${limit}
    `
    return rows.map((r) => ({ ts: Number(r['ts']), value: Number(r['value']) })).reverse()
  }

  // List all distinct HA entity IDs that have history data.
  async listHaEntities(): Promise<string[]> {
    if (!this.sql) return []
    const rows = await this.sql`
      SELECT DISTINCT entity_id FROM ha_numeric ORDER BY entity_id
    `
    return rows.map((r) => r['entity_id'] as string)
  }
}

export const historyHub = new HistoryHub()
