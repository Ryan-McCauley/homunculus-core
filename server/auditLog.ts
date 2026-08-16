// The audit log: an append-only, hash-chained record of every state mutation,
// kept in two places at once.
//
//   data/audit/audit-YYYY-MM.jsonl    write-ahead log, one line per entry
//   postgres: audit_log               queryable system of record
//
// Each entry carries the sha256 of the previous entry, so the whole history is a
// chain: editing or deleting any line breaks every hash after it, and verify()
// reports exactly where. The chain and the `seq` counter continue across file
// rotation — the month boundary is a filing convenience, not a chain boundary.
//
// WHY BOTH. Postgres is where the record belongs: indexed, queryable, and able to
// refuse an UPDATE or DELETE outright via trigger rather than merely noticing one
// afterwards. But DATABASE_URL is optional in this app and a database can be down,
// and an audit entry that was never written is worse than one that is slow to
// arrive. So the file is written first and synchronously — it is the write-ahead
// log, and it is what makes record() safe to call from ordinary synchronous code —
// while rows stream into Postgres behind it and backfill on reconnect.
//
// The redundancy is also the strongest part of the design. The two copies are
// independent, so tampering has to succeed in both to go unnoticed: verify()
// re-derives the chain from the file, then cross-checks every row in the database
// against it. Editing the table alone shows up as a divergence; editing the file
// alone shows up the same way from the other side.
//
// This file is NEVER rewritten or trimmed. That is the entire point, and it is a
// deliberate departure from server/office.ts, whose jsonl journals cap themselves
// with trimJsonl(). An audit log that forgets is not an audit log. There is no
// edit or delete API here and no admin endpoint that offers one: a correction is
// a new entry that references the old seq, never a rewrite. See server/index.ts
// for the admin-token gate on the few log-management routes that do exist.
//
// Writes are synchronous appendFileSync. The server is a single Node process, so
// appends are already serialized and no locking is needed; the cost is one small
// synchronous write per mutation, which is well below the noise floor next to the
// exchange round-trips these mutations usually involve.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import {
  GENESIS_HASH, canonicalJson,
  type AuditActor, type AuditDbStatus, type AuditEntry, type AuditFileInfo,
  type AuditFilter, type AuditInput, type AuditVerifyResult,
} from '../shared/audit'

const AUDIT_DIR = join(process.cwd(), 'data', 'audit')
const FILE_PATTERN = /^audit-\d{4}-\d{2}\.jsonl$/

/** Ceiling on entries held in memory awaiting the Postgres mirror. Generous enough
 *  to ride out a normal restart or a brief outage without dropping anything, small
 *  enough that a multi-day outage cannot grow the heap without bound. */
const MAX_DB_QUEUE = 10_000

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex')
}

// ── Actor context ─────────────────────────────────────────────────────────
//
// Mutations reach the hubs through ~100 HTTP routes, three timer-driven
// automatic paths, and the in-process agent fleet. Threading an `actor` argument
// through every hub method would mean touching dozens of signatures and would
// still miss the timers. AsyncLocalStorage carries it implicitly instead: the
// HTTP layer wraps each request, the fleet wraps each autonomous run, and any
// call site that isn't inside either is — correctly — the server itself.

const actorContext = new AsyncLocalStorage<{ actor: AuditActor }>()

/** Runs `fn` with every audit entry it records attributed to `actor`. */
export function withActor<T>(actor: AuditActor, fn: () => T): T {
  return actorContext.run({ actor }, fn)
}

/** The actor for the current async context; 'system' outside any request or run. */
export function currentActor(): AuditActor {
  return actorContext.getStore()?.actor ?? 'system'
}

class AuditLog {
  private lastHash = GENESIS_HASH
  private lastSeq = 0
  private loaded = false
  /** Set when the newest file ends in an unparseable line (killed mid-append). */
  private tornTail = false

  // ── Postgres ────────────────────────────────────────────────────────────
  private sql: ReturnType<typeof postgres> | null = null
  private dbError: string | null = null
  /** Entries written to the file but not yet accepted by Postgres. Bounded — see
   *  enqueueForDb; the file, not this, is what makes an entry durable. */
  private queue: AuditEntry[] = []
  private flushing = false
  /** Latched so an overflowing backlog logs once, not once per entry. */
  private queueOverflowed = false

  /**
   * Connects, applies the schema, and backfills anything the file has that the
   * table does not. Safe to call when DATABASE_URL is unset — the log simply
   * stays file-only, which is the documented behaviour of every other optional
   * Postgres feature in this app (see server/history.ts).
   */
  async start(): Promise<void> {
    const url = process.env['DATABASE_URL'] || ''
    if (!url) {
      console.log('[audit] DATABASE_URL not set — audit log is file-only')
      return
    }
    try {
      // onnotice is silenced because migrate() is idempotent by design: the
      // "already exists, skipping" notices from CREATE ... IF NOT EXISTS are
      // expected on every boot after the first and would only train the eye to
      // ignore startup output that sometimes matters.
      this.sql = postgres(url, { max: 2, idle_timeout: 30, onnotice: () => {} })
      await this.migrate()
      this.dbError = null
      const backfilled = await this.backfill()
      console.log(
        `[audit] Postgres connected — audit_log is append-only` +
        (backfilled ? ` (backfilled ${backfilled} entr${backfilled === 1 ? 'y' : 'ies'} from the file)` : '')
      )
    } catch (err) {
      this.dbError = (err as Error).message
      this.sql = null
      console.error('[audit] Postgres unavailable, continuing file-only:', this.dbError)
    }
  }

  async stop(): Promise<void> {
    await this.flush().catch(() => {})
    await this.sql?.end({ timeout: 5 })
    this.sql = null
  }

  /**
   * Creates the table and the guards that make it append-only.
   *
   * The triggers are the point. Grants would not help here: the app connects as
   * the database owner, and an owner can always re-grant itself whatever it
   * revoked. A BEFORE UPDATE OR DELETE trigger fires regardless of privilege, so
   * the row simply cannot be changed through SQL — not by the app, not by a
   * stray psql session, not by a future version of this file that forgets why.
   * (A superuser can still drop the trigger; that is what the hash chain and the
   * file cross-check are for. Prevention and detection, not prevention alone.)
   */
  private async migrate(): Promise<void> {
    if (!this.sql) return
    await this.sql`
      CREATE TABLE IF NOT EXISTS audit_log (
        seq          BIGINT PRIMARY KEY,
        ts           TEXT   NOT NULL,
        actor        TEXT   NOT NULL,
        origin       TEXT   NOT NULL,
        action       TEXT   NOT NULL,
        resource     TEXT   NOT NULL,
        summary      TEXT   NOT NULL,
        before_state JSONB,
        after_state  JSONB,
        meta         JSONB,
        prev_hash    TEXT   NOT NULL,
        hash         TEXT   NOT NULL UNIQUE,
        -- The exact line as written to the file. Everything above is for
        -- querying; this is what verify() re-hashes, so a row stays provably
        -- the original even if JSONB normalises a value on the way in.
        raw          TEXT   NOT NULL
      )
    `
    await this.sql`CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts)`
    await this.sql`CREATE INDEX IF NOT EXISTS audit_log_actor_seq ON audit_log(actor, seq DESC)`
    await this.sql`CREATE INDEX IF NOT EXISTS audit_log_resource_seq ON audit_log(resource, seq DESC)`
    await this.sql`CREATE INDEX IF NOT EXISTS audit_log_action_seq ON audit_log(action, seq DESC)`

    await this.sql.unsafe(`
      CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION
          'audit_log is append-only: % is not permitted. A correction is a new entry (see POST /api/audit/annotate).',
          TG_OP;
      END;
      $fn$ LANGUAGE plpgsql;
    `)
    await this.sql.unsafe(`DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log`)
    await this.sql.unsafe(`
      CREATE TRIGGER audit_log_no_change
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only()
    `)
    await this.sql.unsafe(`DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log`)
    await this.sql.unsafe(`
      CREATE TRIGGER audit_log_no_truncate
      BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only()
    `)
  }

  /** Copies any file entries the table is missing. Returns how many were sent. */
  private async backfill(): Promise<number> {
    if (!this.sql) return 0
    const [row] = await this.sql<{ max: string | null }[]>`SELECT MAX(seq)::text AS max FROM audit_log`
    const highest = Number(row?.max ?? 0)
    const missing: AuditEntry[] = []
    for (const file of this.files()) {
      for (const entry of this.readEntries(file).entries) {
        if (entry.seq > highest) missing.push(entry)
      }
    }
    if (!missing.length) return 0
    this.queue.unshift(...missing)
    await this.flush()
    return missing.length
  }

  /**
   * Drains queued entries into Postgres, oldest first. Anything that fails stays
   * queued for the next attempt — a database that is down must never cost an
   * entry, only delay one. ON CONFLICT DO NOTHING makes redelivery harmless.
   */
  private async flush(): Promise<void> {
    if (!this.sql || this.flushing || !this.queue.length) return
    this.flushing = true
    try {
      while (this.queue.length) {
        const entry = this.queue[0]!
        await this.sql`
          INSERT INTO audit_log (
            seq, ts, actor, origin, action, resource, summary,
            before_state, after_state, meta, prev_hash, hash, raw
          ) VALUES (
            ${entry.seq}, ${entry.ts}, ${entry.actor}, ${entry.origin}, ${entry.action},
            ${entry.resource}, ${entry.summary},
            ${entry.before === undefined ? null : this.sql.json(entry.before as never)},
            ${entry.after === undefined ? null : this.sql.json(entry.after as never)},
            ${entry.meta === undefined ? null : this.sql.json(entry.meta as never)},
            ${entry.prevHash}, ${entry.hash}, ${JSON.stringify(entry)}
          )
          ON CONFLICT (seq) DO NOTHING
        `
        this.queue.shift()
      }
      this.dbError = null
    } catch (err) {
      this.dbError = (err as Error).message
      console.error('[audit] Postgres write failed, entry stays queued:', this.dbError)
    } finally {
      this.flushing = false
    }
  }

  dbStatus(): AuditDbStatus {
    return {
      connected: this.sql !== null,
      queued: this.queue.length,
      ...(this.dbError ? { error: this.dbError } : {}),
    }
  }

  // ── Files ───────────────────────────────────────────────────────────────

  private fileFor(at: Date): string {
    return join(AUDIT_DIR, `audit-${monthKey(at)}.jsonl`)
  }

  /** Every audit file on disk, oldest first (names sort chronologically). */
  private files(): string[] {
    if (!existsSync(AUDIT_DIR)) return []
    return readdirSync(AUDIT_DIR)
      .filter((n) => FILE_PATTERN.test(n))
      .sort()
      .map((n) => join(AUDIT_DIR, n))
  }

  private readEntries(file: string): { entries: AuditEntry[]; torn: boolean } {
    if (!existsSync(file)) return { entries: [], torn: false }
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    const entries: AuditEntry[] = []
    let torn = false
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry)
      } catch {
        // A torn line is evidence, not garbage: leave it on disk and flag it.
        torn = true
      }
    }
    return { entries, torn }
  }

  // ── Startup recovery ────────────────────────────────────────────────────

  /**
   * Picks up the chain where the last run left it. Only the newest file is read:
   * a full verify over the whole history would grow the boot cost without bound,
   * and is available on demand at GET /api/audit/verify instead.
   */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const files = this.files()
    if (!files.length) return

    // Walk BACKWARDS to the newest file that yields a parseable entry.
    //
    // Reading only the newest file broke on one specific but entirely reachable
    // case: the process dies mid-append of the FIRST entry of a new month. That
    // file then holds nothing but a torn line, `last` is undefined, and the chain
    // silently restarts at seq 1 with a genesis prevHash — forking the chain. The
    // Postgres mirror makes it worse rather than catching it, because its insert is
    // ON CONFLICT (seq) DO NOTHING: every new entry collides with last year's seq
    // 1, 2, 3… and never lands, so the queryable record just stops growing.
    //
    // Still not a full-history verify (that is on-demand at /api/audit/verify, and
    // deliberately not on the boot path) — this reads at most a few files, and only
    // until one produces a usable chain head.
    let newest = ''
    let last: AuditEntry | undefined
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i] as string
      const { entries, torn } = this.readEntries(file)
      if (i === files.length - 1) {
        newest = file
        this.tornTail = torn
      }
      const candidate = entries[entries.length - 1]
      if (candidate) {
        last = candidate
        if (file !== newest) {
          console.warn(
            `[audit] ${newest} contained no parseable entry (killed mid-append at a month ` +
            `boundary?). Recovered the chain head from ${file} instead — seq ${candidate.seq}.`
          )
        }
        break
      }
    }

    if (last) {
      this.lastHash = last.hash
      this.lastSeq = last.seq
    }
    if (this.tornTail) {
      console.warn(
        `[audit] ${newest} ends in an unparseable line (process killed mid-append?). ` +
        `Chaining from seq ${this.lastSeq}; the torn line is left in place and verify() will report it.`
      )
    }
  }

  // ── Write ───────────────────────────────────────────────────────────────

  /**
   * Appends one entry and returns it. Never throws: an audit failure must not
   * take down the trade or settings change it was describing — it is logged
   * loudly to the console instead, where the operator will see it.
   */
  record(input: AuditInput): AuditEntry | undefined {
    try {
      this.load()
      const at = input.ts ? new Date(input.ts) : new Date()
      const unhashed: Omit<AuditEntry, 'hash'> = {
        seq: this.lastSeq + 1,
        ts: at.toISOString(),
        actor: input.actor,
        origin: input.origin,
        action: input.action,
        resource: input.resource,
        summary: input.summary,
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
        prevHash: this.lastHash,
      }
      const entry: AuditEntry = { ...unhashed, hash: hashEntry(unhashed) }
      // File first, synchronously: once this returns, the entry survives a crash.
      // The database write is deliberately not awaited — record() is called from
      // ordinary synchronous code (settings setters, alert mutators) and making
      // it async would push a Promise through every one of those signatures.
      mkdirSync(AUDIT_DIR, { recursive: true })
      appendFileSync(this.fileFor(at), JSON.stringify(entry) + '\n')
      this.lastHash = entry.hash
      this.lastSeq = entry.seq
      this.enqueueForDb(entry)
      void this.flush()
      return entry
    } catch (err) {
      console.error('[audit] failed to record entry', input.action, input.resource, err)
      return undefined
    }
  }

  /**
   * Queues an entry for the Postgres mirror — but only when there is a Postgres to
   * mirror to.
   *
   * Two bugs lived in the unconditional `queue.push` this replaces. First, in the
   * documented and supported file-only mode (DATABASE_URL unset) the queue was
   * pushed to on every record() and drained by nothing, so a long-running server
   * accumulated every audit entry it ever wrote in memory — and there is one per
   * mutating API request. Second, even with a database configured, a queue that
   * only ever grows during a long outage is a slow memory leak with no ceiling.
   *
   * Dropping the oldest when full is safe precisely because the FILE is the
   * write-ahead log and is already durable: backfill() re-reads it on connect and
   * fills whatever the table is missing. The queue is an optimization, never the
   * record.
   */
  private enqueueForDb(entry: AuditEntry): void {
    // No database configured or connected: the file is the whole story, and
    // backfill() will catch the table up if one ever appears.
    if (!this.sql) return
    this.queue.push(entry)
    if (this.queue.length > MAX_DB_QUEUE) {
      const dropped = this.queue.length - MAX_DB_QUEUE
      this.queue.splice(0, dropped)
      if (!this.queueOverflowed) {
        this.queueOverflowed = true
        console.warn(
          `[audit] Postgres backlog exceeded ${MAX_DB_QUEUE} entries — dropping the oldest from ` +
          `the send queue. Nothing is lost: the file is the write-ahead log and backfill() ` +
          `restores the table from it on the next successful connect.`
        )
      }
    }
  }

  /** Convenience: records with the actor of the current async context. */
  note(input: Omit<AuditInput, 'actor' | 'origin'> & { origin?: AuditInput['origin'] }): AuditEntry | undefined {
    return this.record({ ...input, actor: currentActor(), origin: input.origin ?? 'internal' })
  }

  // ── Read ────────────────────────────────────────────────────────────────

  /**
   * Filtered page of entries, newest first.
   *
   * Served from Postgres when it is connected — that is what the indexes are for,
   * and it stays fast as the history grows. Falls back to scanning the files when
   * the database is unavailable, so the AUDIT view keeps working during an outage.
   */
  async read(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000))
    if (this.sql) {
      try {
        const rows = await this.sql<{ raw: string }[]>`
          SELECT raw FROM audit_log
          WHERE TRUE
            ${filter.before !== undefined ? this.sql`AND seq < ${filter.before}` : this.sql``}
            ${filter.actor ? this.sql`AND actor = ${filter.actor}` : this.sql``}
            ${filter.resource ? this.sql`AND resource = ${filter.resource}` : this.sql``}
            ${filter.action ? this.sql`AND action LIKE ${filter.action + '%'}` : this.sql``}
            ${filter.since ? this.sql`AND ts >= ${filter.since}` : this.sql``}
            ${filter.until ? this.sql`AND ts <= ${filter.until}` : this.sql``}
          ORDER BY seq DESC LIMIT ${limit}
        `
        return rows.map((r) => JSON.parse(r.raw) as AuditEntry)
      } catch (err) {
        console.error('[audit] Postgres read failed, falling back to the file:', (err as Error).message)
      }
    }
    return this.readFromFiles(filter, limit)
  }

  private readFromFiles(filter: AuditFilter, limit: number): AuditEntry[] {
    this.load()
    const out: AuditEntry[] = []
    // Newest file first, and each file scanned backwards, so we can stop as soon
    // as the page is full instead of parsing the entire history every request.
    for (const file of this.files().reverse()) {
      const { entries } = this.readEntries(file)
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!
        if (filter.before !== undefined && e.seq >= filter.before) continue
        if (filter.actor && e.actor !== filter.actor) continue
        if (filter.resource && e.resource !== filter.resource) continue
        if (filter.action && !e.action.startsWith(filter.action)) continue
        if (filter.since && e.ts < filter.since) continue
        if (filter.until && e.ts > filter.until) continue
        out.push(e)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  // ── Integrity ───────────────────────────────────────────────────────────

  /**
   * Walks the entire chain oldest-first and re-derives every hash. Any edited
   * field, deleted line, reordering, or torn write shows up here as `brokenAt`.
   */
  async verify(): Promise<AuditVerifyResult> {
    const result = this.verifyFiles()
    const db = await this.verifyDb()
    return db ? { ...result, ok: result.ok && db.ok, db } : result
  }

  /**
   * Compares every row in Postgres against the file chain.
   *
   * Two independent copies means tampering has to succeed twice. A row whose
   * `raw` no longer matches the file's entry for that seq is reported as
   * divergent — that is someone having got past the triggers, and it is the
   * signal worth waking up for. Entries the file has and the table does not are
   * merely `missing`: normally a flush backlog, not an attack.
   *
   * Rows the TABLE has and the file does not are `extra`, and they are the third
   * thing worth waking up for. The append-only triggers block UPDATE and DELETE but
   * necessarily permit INSERT, and read() serves rows from Postgres verbatim — so an
   * inserted row displays in the AUDIT view as a genuine entry. Iterating file
   * entries alone could never see one, which meant "tampering has to succeed in both
   * copies" was untrue for the one operation the triggers allow.
   */
  private async verifyDb(): Promise<AuditVerifyResult['db']> {
    if (!this.sql) return undefined
    try {
      const rows = await this.sql<{ seq: string; raw: string }[]>`SELECT seq::text, raw FROM audit_log`
      const bySeq = new Map(rows.map((r) => [Number(r.seq), r.raw]))
      const divergent: number[] = []
      let missing = 0
      for (const file of this.files()) {
        for (const entry of this.readEntries(file).entries) {
          const stored = bySeq.get(entry.seq)
          if (stored === undefined) { missing++; continue }
          if (stored !== JSON.stringify(entry)) divergent.push(entry.seq)
          bySeq.delete(entry.seq)   // consumed — whatever is left is not in any file
        }
      }
      const extra = [...bySeq.keys()].sort((a, b) => a - b)
      const reasons: string[] = []
      if (divergent.length) {
        reasons.push(`${divergent.length} row(s) in Postgres no longer match the file: seq ${divergent.slice(0, 10).join(', ')}`)
      }
      if (extra.length) {
        reasons.push(`${extra.length} row(s) exist in Postgres with no entry in any file — inserted outside the log: seq ${extra.slice(0, 10).join(', ')}`)
      }
      return {
        ok: divergent.length === 0 && extra.length === 0,
        rows: rows.length,
        missing,
        divergent,
        extra,
        ...(reasons.length ? { reason: reasons.join('; ') } : {}),
      }
    } catch (err) {
      return { ok: false, rows: 0, missing: 0, divergent: [], extra: [], reason: (err as Error).message }
    }
  }

  private verifyFiles(): AuditVerifyResult {
    const files = this.files()
    let prevHash = GENESIS_HASH
    let expectedSeq = 1
    let count = 0
    for (const file of files) {
      const { entries, torn } = this.readEntries(file)
      if (torn) {
        return {
          ok: false, entries: count, files,
          brokenAt: expectedSeq,
          reason: `unparseable line in ${file} (torn write)`,
        }
      }
      for (const entry of entries) {
        if (entry.seq !== expectedSeq) {
          return {
            ok: false, entries: count, files,
            brokenAt: entry.seq,
            reason: `sequence gap: expected seq ${expectedSeq}, found ${entry.seq}`,
          }
        }
        if (entry.prevHash !== prevHash) {
          return {
            ok: false, entries: count, files,
            brokenAt: entry.seq,
            reason: `broken link at seq ${entry.seq}: prevHash does not match the preceding entry`,
          }
        }
        const { hash, ...rest } = entry
        if (hashEntry(rest) !== hash) {
          return {
            ok: false, entries: count, files,
            brokenAt: entry.seq,
            reason: `content at seq ${entry.seq} was altered after it was written`,
          }
        }
        prevHash = hash
        expectedSeq = entry.seq + 1
        count++
      }
    }
    return { ok: true, entries: count, files }
  }

  /** Inventory of audit files, for the admin view. */
  listFiles(): AuditFileInfo[] {
    return this.files().map((file) => {
      const { entries } = this.readEntries(file)
      return {
        file,
        entries: entries.length,
        firstSeq: entries[0]?.seq ?? 0,
        lastSeq: entries[entries.length - 1]?.seq ?? 0,
      }
    })
  }

  /** True when the newest file ends in a torn line. Surfaced at startup. */
  hasTornTail(): boolean {
    this.load()
    return this.tornTail
  }
}

export const auditLog = new AuditLog()
