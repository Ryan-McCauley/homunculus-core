// Shared types for the Computer Core conversation bridge (main <-> renderer).
// Dependency-free so both sides can import it.

export type Role = 'user' | 'assistant'

export interface ChatMessage {
  role: Role
  text: string
}

/** Renderer -> main: send a new command to the Computer Core. */
export interface ChatSendPayload {
  /** Client-generated id used to correlate streamed deltas back to this turn. */
  id: string
  text: string
}

/** main -> renderer: one streamed token (or short run) of assistant text. */
export interface ChatDeltaPayload {
  id: string
  delta: string
}

/** main -> renderer: the turn finished. */
export interface ChatDonePayload {
  id: string
  stopReason: string | null
}

/** main -> renderer: the turn failed. */
export interface ChatErrorPayload {
  id: string
  message: string
}

export const CHAT = {
  send: 'chat:send',
  delta: 'chat:delta',
  done: 'chat:done',
  error: 'chat:error',
  /** Renderer asks whether an API key is configured. */
  status: 'chat:status'
} as const

export interface ChatStatus {
  /** True when an ANTHROPIC_API_KEY is present in the main process env. */
  configured: boolean
  model: string
}
