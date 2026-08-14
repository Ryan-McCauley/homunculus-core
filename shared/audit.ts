// Audit log types, shared by the server (which writes the chain) and the renderer
// (which reads it). See server/auditLog.ts for the storage contract.

/**
 * Who caused a change.
 *
 *   operator      a human acting through the UI (or an unattributed local call)
 *   system        the server itself — timers, interval runners, automatic paths
 *   agent:<id>    an in-process fleet agent (server/agents.ts)
 *   skill:<name>  a strategy skill calling the HTTP API from the shell
 *
 * `system` is deliberately NOT accepted from an HTTP header: an external caller
 * must never be able to dress its writes up as the server's own automation.
 */
export type AuditActor = 'operator' | 'system' | `agent:${string}` | `skill:${string}`

/** How the mutation reached us. */
export type AuditOrigin = 'http' | 'internal'

export interface AuditEntry {
  /** Global monotonic counter. Continues across monthly file rotation. */
  seq: number
  /** ISO 8601 timestamp. */
  ts: string
  actor: AuditActor
  origin: AuditOrigin
  /** Dotted verb: 'strategy.settings.set', 'agent.update', 'trade.autoexecute'. */
  action: string
  /** What was touched: 'strategy:sniper', 'agent:ag_1', 'alert:al_9', or a route path. */
  resource: string
  /** One-line human description, shown in the UI. */
  summary: string
  /** Prior state — only on richly instrumented call sites. */
  before?: unknown
  /** Resulting state — only on richly instrumented call sites. */
  after?: unknown
  /** Route-layer detail (method, path, status) or call-site extras. */
  meta?: Record<string, unknown>
  /** sha256 of the previous entry's `hash`. Genesis uses GENESIS_HASH. */
  prevHash: string
  /** sha256 of the canonical JSON of this entry with `hash` omitted. */
  hash: string
}

/** What a caller supplies; the log assigns seq/ts/prevHash/hash. */
export type AuditInput = Omit<AuditEntry, 'seq' | 'ts' | 'prevHash' | 'hash'> & { ts?: string }

export interface AuditFilter {
  actor?: string
  resource?: string
  action?: string
  /** ISO timestamp lower bound (inclusive). */
  since?: string
  /** ISO timestamp upper bound (inclusive). */
  until?: string
  /** Page size. Defaults to 100. */
  limit?: number
  /** Cursor: return only entries with seq strictly below this. */
  before?: number
}

export interface AuditVerifyResult {
  ok: boolean
  /** How many well-formed entries were checked. */
  entries: number
  files: string[]
  /** The seq at which the chain first failed, when ok is false. */
  brokenAt?: number
  reason?: string
  /**
   * Cross-check of the Postgres copy against the file chain. Absent when the
   * database is not connected. `ok` here is a separate question from the chain's
   * own integrity: the chain can be sound while the table has been edited
   * underneath it, and that divergence is exactly what this reports.
   */
  db?: AuditDbCheck
}

export interface AuditDbCheck {
  ok: boolean
  /** Rows present in Postgres. */
  rows: number
  /** Entries in the file that never made it to Postgres (usually just a backlog). */
  missing: number
  /** Seqs whose stored row no longer matches the file's entry — real tampering. */
  divergent: number[]
  reason?: string
}

export interface AuditDbStatus {
  /** True once a connection succeeded and the schema was applied. */
  connected: boolean
  /** Entries written to the file but not yet accepted by Postgres. */
  queued: number
  /** Why the database is unavailable, when it is. */
  error?: string
}

export interface AuditFileInfo {
  file: string
  entries: number
  firstSeq: number
  lastSeq: number
}

/** prevHash of the very first entry in the chain. */
export const GENESIS_HASH = '0'.repeat(64)

/** Header an HTTP caller sets to identify itself. */
export const ACTOR_HEADER = 'x-homunculus-actor'

/** Header carrying HOMUNCULUS_ADMIN_TOKEN. Never accepted as a query param. */
export const ADMIN_TOKEN_HEADER = 'x-homunculus-admin-token'

const ACTOR_PATTERN = /^(agent|skill):[a-zA-Z0-9_.-]{1,64}$/

/**
 * Validates an actor string supplied over HTTP.
 *
 * Returns the actor when it is a well-formed `agent:`/`skill:` value or the
 * literal `operator`. Anything else — including `system`, an attempt to pose as
 * the server's own automation — falls back to 'operator', which is the honest
 * label for "some caller on this machine, unverified".
 */
export function deriveActor(raw: string | string[] | undefined): AuditActor {
  const value = (Array.isArray(raw) ? raw[0] : raw || '').trim()
  if (!value) return 'operator'
  if (value === 'operator') return 'operator'
  if (ACTOR_PATTERN.test(value)) return value as AuditActor
  return 'operator'
}

/**
 * Whether a presented admin token matches the configured one.
 *
 * Split out from the route so it can be tested without standing up a server.
 * Two rules, both load-bearing: an unconfigured token ('') never matches, so a
 * missing env var closes the gate rather than opening it; and the comparison is
 * constant-time in the equal-length case, so a caller cannot learn the secret
 * one byte at a time from response timings.
 */
export function adminTokenMatches(provided: string, configured: string): boolean {
  if (!configured) return false
  if (provided.length !== configured.length) return false
  let diff = 0
  for (let i = 0; i < configured.length; i++) diff |= provided.charCodeAt(i) ^ configured.charCodeAt(i)
  return diff === 0
}

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * The hash must not depend on key insertion order: `before`/`after` payloads
 * come from many different call sites and round-trip through JSON.parse on
 * verify, so two structurally equal entries have to serialize identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}
