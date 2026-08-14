// The client-facing API contract. The web transport (WebSocket) and the
// Electron preload both expose an object of this shape as `window.homunculus`,
// so the React panels are transport-agnostic.

import type { TelemetrySnapshot } from './telemetry'
import type {
  ChatDeltaPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatStatus
} from './chat'

export interface ChatProactivePayload {
  id: string
  text: string
  meta?: ProactiveMeta
}
import type { TermDataPayload, TermExitPayload } from './terminal'
import type { HaSnapshot } from './homeassistant'
import type { OsintSnapshot, GeofenceConfig } from './osint'
import type { ArchiveSnapshot, ArchiveEvent, ProactiveMeta } from './archive'

export interface HomunculusApi {
  onTelemetry(handler: (snapshot: TelemetrySnapshot) => void): () => void
  onHa(handler: (snapshot: HaSnapshot) => void): () => void
  sendHaCommand(entityId: string, service: string, data: Record<string, unknown>): void

  onOsint(handler: (snapshot: OsintSnapshot) => void): () => void
  osintRefresh(): void
  /** Push the armed home perimeter to the hub (it enforces it server-side). */
  osintSetGeofence(config: GeofenceConfig): void

  /** Subscribe to the ARCHIVE event log: a recent snapshot then live events. */
  onArchive(handlers: {
    snapshot: (snapshot: ArchiveSnapshot) => void
    event: (event: ArchiveEvent) => void
  }): () => void

  chatStatus(): Promise<ChatStatus>
  sendChat(id: string, text: string): void
  onChatDelta(handler: (p: ChatDeltaPayload) => void): () => void
  onChatDone(handler: (p: ChatDonePayload) => void): () => void
  onChatError(handler: (p: ChatErrorPayload) => void): () => void
  onChatProactive(handler: (p: ChatProactivePayload) => void): () => void

  termStart(id: string, cols: number, rows: number): void
  termInput(id: string, data: string): void
  termResize(id: string, cols: number, rows: number): void
  termKill(id: string): void
  onTermData(handler: (p: TermDataPayload) => void): () => void
  onTermExit(handler: (p: TermExitPayload) => void): () => void
}
