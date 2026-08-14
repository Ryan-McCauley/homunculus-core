// The WebSocket message protocol between the backend server and any client
// (browser or the Electron shell). One socket multiplexes telemetry, the
// Computer Core chat, and the terminal, keyed by `ch`.

import type { TelemetrySnapshot } from './telemetry'
import type { ChatStatus } from './chat'
import type { HaSnapshot } from './homeassistant'
import type { OsintSnapshot, GeofenceConfig } from './osint'
import type { ArchiveSnapshot, ArchiveEvent, ProactiveMeta } from './archive'

/** Client -> server. */
export type ClientMsg =
  | { ch: 'telemetry'; type: 'subscribe' }
  | { ch: 'chat'; type: 'status' }
  | { ch: 'chat'; type: 'send'; id: string; text: string }
  | { ch: 'term'; type: 'start'; id: string; cols: number; rows: number }
  | { ch: 'term'; type: 'input'; id: string; data: string }
  | { ch: 'term'; type: 'resize'; id: string; cols: number; rows: number }
  | { ch: 'term'; type: 'kill'; id: string }
  | { ch: 'ha'; type: 'subscribe' }
  | { ch: 'ha'; type: 'command'; entityId: string; service: string; data: Record<string, unknown> }
  | { ch: 'osint'; type: 'subscribe' }
  | { ch: 'osint'; type: 'refresh' }
  | { ch: 'osint'; type: 'geofence'; config: GeofenceConfig }
  | { ch: 'archive'; type: 'subscribe' }

/** Server -> client. */
export type ServerMsg =
  | { ch: 'telemetry'; type: 'update'; snapshot: TelemetrySnapshot }
  | { ch: 'chat'; type: 'status'; status: ChatStatus }
  | { ch: 'chat'; type: 'delta'; id: string; delta: string }
  | { ch: 'chat'; type: 'done'; id: string; stopReason: string | null }
  | { ch: 'chat'; type: 'error'; id: string; message: string }
  | { ch: 'chat'; type: 'proactive'; id: string; text: string; meta?: ProactiveMeta }
  | { ch: 'term'; type: 'data'; id: string; data: string }
  | { ch: 'term'; type: 'exit'; id: string; exitCode: number }
  | { ch: 'ha'; type: 'update'; snapshot: HaSnapshot }
  | { ch: 'ha'; type: 'command_ack'; ok: boolean; error?: string }
  | { ch: 'osint'; type: 'update'; snapshot: OsintSnapshot }
  | { ch: 'archive'; type: 'snapshot'; snapshot: ArchiveSnapshot }
  | { ch: 'archive'; type: 'event'; event: ArchiveEvent }

export type Send = (msg: ServerMsg) => void
