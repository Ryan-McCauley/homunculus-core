// Postgres-backed persistence for the app's JSON state.
//
//   postgres: app_state(key, value)   durable system of record
//   data/**/*.json                    local replica, written synchronously
//
// Every hub in this server persists the same way: read a JSON file at import
// time, rewrite the whole file on every change. That pattern is load-bearing and
// deeply synchronous — `cryptoHub` reads `trades.json` while constructing its
// snapshot, `agentFleet` reads `agents.json` at module scope — so moving it to a
// database cannot mean making those call sites async without rewriting the
// trading engine around a Promise. This module changes where the data lives, not
// how the code reads it: `readJson`/`writeJson` are drop-in replacements for the
// readFileSync/writeFileSync pair, keyed by the same file path.
//
// WHAT IS AUTHORITATIVE. Postgres is: it is durable, queryable, backed up as one
// unit, and survives the loss of the working directory. The files remain as a
// synchronously-written local replica, which is what lets a hub boot before any
// connection exists and what keeps the app fully functional with DATABASE_URL
// unset. Both copies are written on every change, so neither drifts; `reconcile()`
// reports it at startup if they ever do.
//
// This is the same shape as server/auditLog.ts, for the same reason: a write that
// only reaches a database that happens to be down is a write that did not happen.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import postgres from 'postgres'
import { canonicalJson } from '../shared/audit'

const DATA_ROOT = join(process.cwd(), 'data')

/**
 * Stable key for a file path: its location under data/, POSIX-separated.
 * `data/crypto/trades.json` → `crypto/trades.json`. Deriving the key from the
 * path the hubs already use means no hub has to invent or remember a name.
 */
export function stateKey(file: string): string {
  return relative(DATA_ROOT, file).split(sep).join('/')
}

class StateStore {
  private sql: ReturnType<typeof postgres> | null = null
  private dbError: string | null = null
  /** key -> latest value awaiting an upsert. Coalesced: only the newest matters. */
  private queue = new Map<string, unknown>()
  private flushing = false
  /** Keys deleted locally whose Postgres DELETE has not yet been accepted. Retried
   *  until it is — otherwise reconcile() restores the row on the next boot. */
  private tombstones = new Set<string>()
  private divergent: string[] = []

  async start(): Promise<void> {
    const url = process.env['DATABASE_URL'] || ''
    if (!url) {
      console.log('[state] DATABASE_URL not set — JSON state is file-only')
      return
    }
    try {
      this.sql = postgres(url, { max: 3, idle_timeout: 30, onnotice: () => {} })
      await this.migrate()
      await this.migrateLedgers()
      await this.migrateRuns()
      const stale = await this.reapStaleRuns()
      this.dbError = null
      // Register every JSON file on disk BEFORE reconciling, so a file whose
      // module has not read it yet is still imported — and, more importantly, so
      // a stale row is corrected on every boot rather than only on first import.
      this.registerAllJson()
      const { imported, restored } = await this.reconcile()
      const ledger = await this.importLedgers()
      const history = await this.importPortfolioHistory()
      const reports = await this.importPlanReports()
      const runs = await this.importRuns()
      console.log(
        `[state] Postgres connected — app_state is the system of record` +
        (imported ? ` (imported ${imported} file(s))` : '') +
        (restored ? ` (restored ${restored} file(s) from the database — RESTART to load them)` : '') +
        (ledger ? ` (imported ${ledger} closed trade(s))` : '') +
        (history ? ` (${history} portfolio sample(s))` : '') +
        (reports ? ` (${reports} plan report(s))` : '') +
        (runs ? ` (${runs} historical run(s))` : '') +
        (stale ? ` (closed ${stale} run(s) interrupted by a restart)` : '')
      )
    } catch (err) {
      this.dbError = (err as Error).message
      this.sql = null
      console.error('[state] Postgres unavailable, continuing file-only:', this.dbError)
    }
  }

  async stop(): Promise<void> {
    await this.flush().catch(() => {})
    // Last chance for any delete that never landed — after this the process is gone
    // and the next boot's reconcile would restore the row.
    await this.flushTombstones().catch(() => {})
    await this.sql?.end({ timeout: 5 })
    this.sql = null
  }

  private async migrate(): Promise<void> {
    if (!this.sql) return
    await this.sql`
      CREATE TABLE IF NOT EXISTS app_state (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `
  }

  /**
   * Brings the two copies into agreement at startup.
   *
   * A file with no row is imported — that is the one-time migration of existing
   * state, and it is why no separate migration script is needed. A row with no
   * file is written back out, which is what makes the database a real backup:
   * delete data/ and the app rebuilds it on the next boot. A file and row that
   * disagree is reported and the FILE wins, because the file is what every hub
   * already read into memory microseconds ago; overwriting it here would mean
   * silently reverting live state behind the running code.
   */
  private async reconcile(): Promise<{ imported: number; restored: number }> {
    if (!this.sql) return { imported: 0, restored: 0 }
    const rows = await this.sql<{ key: string; value: unknown }[]>`SELECT key, value FROM app_state`
    const stored = new Map(rows.map((r) => [r.key, r.value]))
    let imported = 0
    let restored = 0

    for (const [key, value] of stored) {
      const file = join(DATA_ROOT, ...key.split('/'))
      if (!existsSync(file)) {
        this.writeFile(file, value)
        restored++
        continue
      }
      // Present but unreadable: a torn write from a crash, or a hand-edit that broke
      // the JSON. Treating this as "the file exists, nothing to do" was how a
      // truncated file survived boot and then got persisted back over the good
      // database row. The file has no usable content, so the row is strictly better
      // — keep the corrupt bytes aside for forensics and restore from Postgres.
      if (this.readFile(file) === undefined) {
        const quarantine = `${file}.corrupt-${Date.now()}`
        try { renameSync(file, quarantine) } catch { /* fall through and overwrite */ }
        this.writeFile(file, value)
        restored++
        console.error(
          `[state] ${key} was present but unparseable — restored from the database. ` +
          `The unreadable file was kept at ${quarantine}. RESTART so hubs reload it.`
        )
      }
    }
    for (const key of this.known) {
      const file = join(DATA_ROOT, ...key.split('/'))
      if (!existsSync(file)) continue
      const onDisk = this.readFile(file)
      if (onDisk === undefined) continue
      if (!stored.has(key)) {
        this.queue.set(key, onDisk)
        imported++
      // Compared canonically: Postgres stores JSONB, which sorts object keys on
      // the way in. A plain JSON.stringify comparison would therefore call almost
      // every key divergent on every boot — a false alarm loud enough to drown
      // out a real one, plus a pointless rewrite of the whole state each start.
      } else if (canonicalJson(stored.get(key)) !== canonicalJson(onDisk)) {
        this.divergent.push(key)
        this.queue.set(key, onDisk)   // file wins; push it up
      }
    }
    await this.flush()
    if (this.divergent.length) {
      console.warn(
        `[state] file and database disagreed on ${this.divergent.length} key(s); ` +
        `the file won and the database was updated: ${this.divergent.slice(0, 8).join(', ')}`
      )
    }
    return { imported, restored }
  }

  /** Keys this process has read or written — the set worth reconciling. */
  private known = new Set<string>()

  private readFile(file: string): unknown {
    try {
      if (!existsSync(file)) return undefined
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch { return undefined }
  }

  /**
   * Writes atomically: temp file, then rename.
   *
   * A bare writeFileSync truncates the target before it writes, so a crash or power
   * loss mid-write leaves a TRUNCATED file. That is not merely a lost write here —
   * it is a path to losing both copies. readJson would parse-fail and hand its hub
   * the empty fallback; reconcile() would see a file present and skip restoring from
   * Postgres; and the hub's next mutation would persist that empty state over BOTH
   * the file and the database row. rename() within a filesystem is atomic, so a
   * reader sees either the whole old file or the whole new one, never a torn one.
   * server/sync.ts already wrote this way — the house store did not.
   */
  private writeFile(file: string, value: unknown): void {
    const tmp = `${file}.tmp-${process.pid}`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(value, null, 2))
      renameSync(tmp, file)
    } catch (e) {
      console.warn('[state] file write failed:', file, (e as Error).message)
      try { if (existsSync(tmp)) rmSync(tmp, { force: true }) } catch { /* best effort */ }
    }
  }

  /**
   * Reads persisted JSON, or `fallback` when nothing is stored yet.
   *
   * Synchronous and file-backed by design: hubs call this while initialising, at
   * which point no connection exists. The file is never stale — writeJson keeps
   * it current — so this is a cache hit, not a fallback.
   */
  readJson<T>(file: string, fallback: T): T {
    this.known.add(stateKey(file))
    const value = this.readFile(file)
    return value === undefined ? fallback : (value as T)
  }

  /** Persists JSON to both copies. Synchronous for the file; queued for Postgres. */
  writeJson(file: string, value: unknown): void {
    const key = stateKey(file)
    this.known.add(key)
    this.writeFile(file, value)
    this.queue.set(key, value)
    void this.flush()
  }

  /**
   * Deletes both copies.
   *
   * This has to exist. Without it a module that removes a file — the library
   * retiring an artifact, the trade engine clearing active brackets when the last
   * one closes — leaves the row behind, and reconcile() then treats the missing
   * file as "the database has something the disk lost" and writes it back. The
   * failure mode is silent and bad: closed brackets reappearing on restart as if
   * still live. Deleting is a state change like any other and needs its own verb.
   */
  deleteJson(file: string): void {
    const key = stateKey(file)
    this.known.delete(key)
    this.queue.delete(key)
    try { if (existsSync(file)) rmSync(file, { force: true }) } catch { /* already gone */ }
    // Remembered until Postgres confirms it. A fire-and-forget DELETE that fails —
    // database down, connection dropped — used to leave the row behind, and the next
    // boot's reconcile would then see "row, no file" and WRITE THE FILE BACK. That is
    // the exact resurrection this method exists to prevent, reintroduced by an
    // unreliable delete: closed brackets reappearing on restart as if still live.
    this.tombstones.add(key)
    void this.flushTombstones()
  }

  /** Retries pending deletes until the database accepts them. Called on delete, on
   *  every flush, and at shutdown, so a delete issued during an outage still lands. */
  private async flushTombstones(): Promise<void> {
    if (!this.sql || !this.tombstones.size) return
    for (const key of [...this.tombstones]) {
      try {
        await this.sql`DELETE FROM app_state WHERE key = ${key}`
        this.tombstones.delete(key)
      } catch (err) {
        // Keep it queued; the next flush or shutdown will try again.
        console.error('[state] delete failed (will retry):', key, (err as Error).message)
        return
      }
    }
  }

  private async flush(): Promise<void> {
    if (!this.sql) return
    // Pending deletes ride along with every flush, so a delete that failed during an
    // outage retries as soon as anything else writes.
    void this.flushTombstones()
    if (this.flushing || !this.queue.size) return
    this.flushing = true
    try {
      while (this.queue.size) {
        const [key, value] = this.queue.entries().next().value as [string, unknown]
        await this.sql`
          INSERT INTO app_state (key, value, updated_at)
          VALUES (${key}, ${this.sql.json(value as never)}, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `
        // Deleted only after the upsert lands, and only if no newer value arrived
        // meanwhile — otherwise a write during the await would be dropped.
        if (this.queue.get(key) === value) this.queue.delete(key)
      }
      this.dbError = null
    } catch (err) {
      this.dbError = (err as Error).message
      console.error('[state] Postgres write failed, state stays queued:', this.dbError)
    } finally {
      this.flushing = false
    }
  }

  status(): { connected: boolean; queued: number; keys: number; divergent: string[]; error?: string } {
    return {
      connected: this.sql !== null,
      queued: this.queue.size,
      keys: this.known.size,
      divergent: this.divergent,
      ...(this.dbError ? { error: this.dbError } : {}),
    }
  }

  /** The live connection, for the modules that own real relational tables. */
  get db(): ReturnType<typeof postgres> | null {
    return this.sql
  }

  // ── Ledgers ─────────────────────────────────────────────────────────────
  //
  // Two datasets get real tables rather than a JSONB blob, because they grow
  // without bound and are appended to constantly. closed-trades.json is already
  // 3MB and was rewritten in full on every single closed trade; as one JSONB
  // value that would be a 3MB upsert per trade. As rows it is an INSERT, and the
  // win-rate queries the strategies run become SQL instead of loading the whole
  // ledger into memory.

  async migrateLedgers(): Promise<void> {
    if (!this.sql) return
    await this.sql`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id           TEXT PRIMARY KEY,
        source       TEXT   NOT NULL,
        strategy     TEXT   NOT NULL,
        symbol       TEXT   NOT NULL,
        side         TEXT   NOT NULL,
        outcome      TEXT   NOT NULL,
        realized_usd REAL   NOT NULL,
        fee_usd      REAL   NOT NULL,
        return_pct   REAL,
        entry_at     BIGINT,
        closed_at    BIGINT NOT NULL,
        raw          JSONB  NOT NULL
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS closed_trades_closed_at ON closed_trades(closed_at DESC)`
    await this.sql`CREATE INDEX IF NOT EXISTS closed_trades_strategy ON closed_trades(strategy, source)`
    await this.sql`CREATE INDEX IF NOT EXISTS closed_trades_symbol ON closed_trades(symbol)`
    await this.sql`
      CREATE TABLE IF NOT EXISTS plan_reports (
        at     BIGINT PRIMARY KEY,
        kind   TEXT NOT NULL,
        title  TEXT NOT NULL,
        report TEXT NOT NULL
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS plan_reports_kind_at ON plan_reports(kind, at DESC)`
    await this.sql`
      CREATE TABLE IF NOT EXISTS portfolio_history (
        at        BIGINT PRIMARY KEY,
        btc       REAL NOT NULL,
        usd       REAL NOT NULL,
        total_usd REAL NOT NULL,
        btc_price REAL NOT NULL
      )
    `
  }

  /**
   * One-time (idempotent) lift of the existing on-disk ledgers into their tables.
   * Runs on every boot and is a no-op once the rows are there, which is what makes
   * this a migration nobody has to remember to run.
   */
  private async importLedgers(): Promise<number> {
    if (!this.sql) return 0
    try {
      const file = join(DATA_ROOT, 'crypto', 'closed-trades.json')
      const rows = this.readFile(file)
      if (!Array.isArray(rows) || !rows.length) return 0
      const [{ n }] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM closed_trades`
      if (n >= rows.length) return 0
      return await this.saveClosedTrades(rows as Record<string, unknown>[])
    } catch (err) {
      console.error('[state] closed-trade import failed:', (err as Error).message)
      return 0
    }
  }

  /** Lifts the on-disk portfolio series in. Idempotent on `at`. */
  private async importPortfolioHistory(): Promise<number> {
    if (!this.sql) return 0
    try {
      const series = this.readFile(join(DATA_ROOT, 'crypto', 'portfolio-history.json'))
      if (!Array.isArray(series) || !series.length) return 0
      const [{ n }] = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM portfolio_history`
      if (n >= series.length) return 0
      await this.savePortfolioHistory(series as never)
      return series.length
    } catch (err) {
      console.error('[state] portfolio-history import failed:', (err as Error).message)
      return 0
    }
  }

  /**
   * Lifts the archived strategy reports in. These are one file per run and there
   * are hundreds of them, so they get a table of their own rather than hundreds
   * of app_state rows — `kind` is what the TRADES tab filters on.
   */
  private async importPlanReports(): Promise<number> {
    if (!this.sql) return 0
    const dir = join(DATA_ROOT, 'crypto', 'plan-reports')
    if (!existsSync(dir)) return 0
    try {
      let written = 0
      for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const e = this.readFile(join(dir, name)) as
          { report?: unknown; at?: unknown; kind?: unknown; title?: unknown } | undefined
        if (!e || typeof e.report !== 'string' || typeof e.at !== 'number') continue
        const res = await this.sql`
          INSERT INTO plan_reports (at, kind, title, report)
          VALUES (${e.at}, ${String(e.kind ?? 'strategy')}, ${String(e.title ?? 'STRATEGY REPORT')}, ${e.report})
          ON CONFLICT (at) DO NOTHING
        `
        written += res.count
      }
      return written
    } catch (err) {
      console.error('[state] plan-report import failed:', (err as Error).message)
      return 0
    }
  }

  /**
   * Sweeps data/ for any JSON the hubs have not touched this session and stores
   * it. Without this, a file whose module has not read it yet would never reach
   * the database — reconcile() only knows the keys this process has used.
   *
   * candle-cache.json is deliberately excluded: it is a regenerable price cache,
   * megabytes wide and rewritten on every refresh, so mirroring it would be
   * constant churn to protect data that is one API call away. Same for .bak
   * files, which are snapshots someone took precisely to keep them out of the way.
   *
   * sync.json is excluded for a different and stronger reason: it holds this node's
   * PEER TOKENS. shared/sync.ts states the invariant ("the token itself never
   * leaves the server") and enforces it on the wire by excluding sync.json from
   * peer sync — but mirroring it here would carry every peer's token into the
   * app_state table, and from there into database backups and anyone with read
   * access to the database, which is a strictly larger audience than "this server".
   * server/sync.ts writes that file directly for the same reason.
   */
  private registerAllJson(): void {
    const skipDirs = new Set(['plan-reports', 'audit'])
    const skipFiles = new Set([
      'candle-cache.json', 'closed-trades.json', 'portfolio-history.json',
      'sync.json',   // peer tokens — see the note above
    ])
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (!skipDirs.has(name)) walk(full)
        } else if (name.endsWith('.json') && !skipFiles.has(name) && !name.includes('.bak')) {
          this.known.add(stateKey(full))
        }
      }
    }
    try { walk(DATA_ROOT) } catch { /* no data dir yet */ }
  }

  /**
   * Durable run history for the activity timeline.
   *
   * The fleet keeps only the last 25 runs per agent in agents.json and the
   * strategy runner keeps none at all — both fine for "what is happening now",
   * useless for "what ran last Tuesday". This table is where a rolling calendar
   * gets its past from, so it accumulates rather than rolling off.
   */
  async migrateRuns(): Promise<void> {
    if (!this.sql) return
    await this.sql`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id         TEXT PRIMARY KEY,
        component  TEXT   NOT NULL,
        label      TEXT   NOT NULL,
        trigger    TEXT   NOT NULL,
        started_at BIGINT NOT NULL,
        ended_at   BIGINT,
        state      TEXT   NOT NULL,
        summary    TEXT   NOT NULL DEFAULT ''
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at DESC)`
    await this.sql`CREATE INDEX IF NOT EXISTS agent_runs_component ON agent_runs(component, started_at DESC)`
  }

  /**
   * Marks runs left mid-flight by a previous process as interrupted.
   *
   * This server is single-process, so a row still marked `running` at boot has no
   * owner — its process died (restart, crash, kill) without reaching the finally
   * that would have closed it. Left alone the row claims to be running forever:
   * the timeline draws a bar that never ends, and it disagrees with the live
   * session registry, which correctly reports nothing running.
   */
  private async reapStaleRuns(): Promise<number> {
    if (!this.sql) return 0
    try {
      const rows = await this.sql`
        UPDATE agent_runs
        SET state = 'error',
            ended_at = coalesce(ended_at, started_at),
            summary = CASE WHEN summary = '' THEN 'Interrupted — the server restarted while this run was in flight.'
                           ELSE summary END
        WHERE state = 'running'
        RETURNING id
      `
      return rows.count
    } catch (err) {
      console.error('[state] stale-run reap failed:', (err as Error).message)
      return 0
    }
  }

  /**
   * Records a run start, or updates one in flight. Called on both edges of a run,
   * so `ended_at`/`state`/`summary` fill in when it finishes — which is the one
   * place this table is deliberately NOT append-only: a run is a single fact that
   * completes, not two events.
   */
  async saveRun(run: {
    id: string; component: string; label: string; trigger: string
    startedAt: number; endedAt: number | null; state: string; summary: string
  }): Promise<void> {
    if (!this.sql) return
    try {
      await this.sql`
        INSERT INTO agent_runs (id, component, label, trigger, started_at, ended_at, state, summary)
        VALUES (${run.id}, ${run.component}, ${run.label}, ${run.trigger},
                ${run.startedAt}, ${run.endedAt}, ${run.state}, ${run.summary})
        ON CONFLICT (id) DO UPDATE SET
          ended_at = EXCLUDED.ended_at, state = EXCLUDED.state, summary = EXCLUDED.summary
      `
    } catch (err) {
      console.error('[state] run write failed:', (err as Error).message)
    }
  }

  /** Runs overlapping a window, for the timeline. */
  async readRuns(since: number, until: number): Promise<Record<string, unknown>[]> {
    if (!this.sql) return []
    try {
      return await this.sql<Record<string, unknown>[]>`
        SELECT id, component, label, trigger, started_at, ended_at, state, summary
        FROM agent_runs
        WHERE started_at <= ${until} AND coalesce(ended_at, ${Date.now()}) >= ${since}
        ORDER BY started_at
      `
    } catch (err) {
      console.error('[state] run read failed:', (err as Error).message)
      return []
    }
  }

  /** Audit entries in a window, for deriving call edges and point events. */
  async readAuditWindow(since: number, until: number): Promise<Record<string, unknown>[]> {
    if (!this.sql) return []
    try {
      return await this.sql<Record<string, unknown>[]>`
        SELECT ts, actor, origin, action, resource, summary, meta
        FROM audit_log
        WHERE ts >= ${new Date(since).toISOString()} AND ts <= ${new Date(until).toISOString()}
        ORDER BY seq
      `
    } catch (err) {
      console.error('[state] audit window read failed:', (err as Error).message)
      return []
    }
  }

  /** One-time lift of the run history the fleet still has in agents.json. */
  private async importRuns(): Promise<number> {
    if (!this.sql) return 0
    try {
      const data = this.readFile(join(DATA_ROOT, 'crypto', 'agents.json')) as
        { agents?: { agent?: { id?: string; name?: string }; runs?: Record<string, unknown>[] }[] } | undefined
      const records = data?.agents
      if (!Array.isArray(records)) return 0
      let n = 0
      for (const rec of records) {
        const id = rec?.agent?.id
        if (!id) continue
        for (const r of rec.runs ?? []) {
          if (typeof r['id'] !== 'string' || typeof r['startedAt'] !== 'number') continue
          const res = await this.sql`
            INSERT INTO agent_runs (id, component, label, trigger, started_at, ended_at, state, summary)
            VALUES (${r['id'] as string}, ${'agent:' + id}, ${rec.agent?.name ?? id},
                    ${String(r['trigger'] ?? 'manual')}, ${r['startedAt'] as number},
                    ${(r['endedAt'] as number | null) ?? null}, ${String(r['state'] ?? 'done')},
                    ${String(r['summary'] ?? '')})
            ON CONFLICT (id) DO NOTHING
          `
          n += res.count
        }
      }
      return n
    } catch (err) {
      console.error('[state] run import failed:', (err as Error).message)
      return 0
    }
  }

  /** Upserts closed trades. Idempotent on id, so re-sending the ledger is free. */
  async saveClosedTrades(rows: Record<string, unknown>[]): Promise<number> {
    if (!this.sql || !rows.length) return 0
    let written = 0
    for (const t of rows) {
      try {
        await this.sql`
          INSERT INTO closed_trades (
            id, source, strategy, symbol, side, outcome,
            realized_usd, fee_usd, return_pct, entry_at, closed_at, raw
          ) VALUES (
            ${String(t['id'])}, ${String(t['source'] ?? 'real')}, ${String(t['strategy'] ?? 'unattributed')},
            ${String(t['symbol'] ?? '')}, ${String(t['side'] ?? 'buy')}, ${String(t['outcome'] ?? 'flat')},
            ${Number(t['realizedUsd'] ?? 0)}, ${Number(t['feeUsd'] ?? 0)},
            ${t['returnPct'] === null || t['returnPct'] === undefined ? null : Number(t['returnPct'])},
            ${t['entryAt'] === null || t['entryAt'] === undefined ? null : Number(t['entryAt'])},
            ${Number(t['closedAt'] ?? 0)}, ${this.sql.json(t as never)}
          )
          ON CONFLICT (id) DO NOTHING
        `
        written++
      } catch (err) {
        console.error('[state] closed_trades write failed:', (err as Error).message)
        break
      }
    }
    return written
  }

  /** Replaces the portfolio series. Small and trimmed by retention, so a rewrite is fine. */
  async savePortfolioHistory(series: { at: number; btc: number; usd: number; totalUsd: number; btcPrice: number }[]): Promise<void> {
    if (!this.sql || !series.length) return
    try {
      for (const s of series) {
        await this.sql`
          INSERT INTO portfolio_history (at, btc, usd, total_usd, btc_price)
          VALUES (${s.at}, ${s.btc}, ${s.usd}, ${s.totalUsd}, ${s.btcPrice})
          ON CONFLICT (at) DO NOTHING
        `
      }
    } catch (err) {
      console.error('[state] portfolio_history write failed:', (err as Error).message)
    }
  }
}

export const stateStore = new StateStore()
