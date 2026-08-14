// The ARCHIVE event log — a durable, queryable record of every notable event
// the bridge emits (proactive alerts, OSINT escalations, geofence breaches,
// system messages). Shared shapes used by the backend ArchiveHub
// (`server/archive.ts`), the WS protocol, and the ARCHIVE tab UI.

/** Which subsystem an event came from (drives the console's source filter). */
export type EventSource = 'OSINT' | 'HOME' | 'COMPUTER' | 'CRYPTO' | 'FINANCE' | 'SYSTEM'

/** Event severity, low → high. Drives colour + the severity filter. */
export type EventSeverity = 'info' | 'notice' | 'warn' | 'critical'

export const SEVERITY_RANK: Record<EventSeverity, number> = {
  info: 0,
  notice: 1,
  warn: 2,
  critical: 3
}

export const EVENT_SOURCES: EventSource[] = ['OSINT', 'HOME', 'COMPUTER', 'CRYPTO', 'FINANCE', 'SYSTEM']
export const EVENT_SEVERITIES: EventSeverity[] = ['info', 'notice', 'warn', 'critical']

export interface ArchiveEvent {
  id: string
  ts: number
  source: EventSource
  severity: EventSeverity
  title: string
  body: string
}

/** Metadata a `broadcastProactive` caller can attach so the archive can classify
 *  the event. When omitted the hub falls back to SYSTEM / notice + a derived
 *  title. */
export interface ProactiveMeta {
  source: EventSource
  severity: EventSeverity
  title?: string
  /** Tabler icon name (e.g. `ti-wash`) the client attaches to the toast. */
  icon?: string
  /** Optional toast subtitle (second line). Not stored in the archive body. */
  sub?: string
  /** When false, the event toasts + archives but is NOT injected into the
   *  ComputerCore conversation. Defaults to true (keeps OSINT / AI alerts in
   *  the ship's-computer log). Device + crypto events set this false to avoid
   *  spamming the chat. */
  chatLog?: boolean
}

/** Sent to a client when it subscribes — the most recent slice, newest first. */
export interface ArchiveSnapshot {
  events: ArchiveEvent[]
}
