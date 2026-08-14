// Shared types for the embedded terminal bridge (main <-> renderer).
// Dependency-free so both sides can import it.

export interface TermStartPayload {
  id: string
  cols: number
  rows: number
}

export interface TermInputPayload {
  id: string
  data: string
}

export interface TermResizePayload {
  id: string
  cols: number
  rows: number
}

/** main -> renderer: a (coalesced) chunk of shell output. */
export interface TermDataPayload {
  id: string
  data: string
}

/** main -> renderer: the shell process exited. */
export interface TermExitPayload {
  id: string
  exitCode: number
}

export const TERM = {
  start: 'terminal:start',
  input: 'terminal:input',
  resize: 'terminal:resize',
  kill: 'terminal:kill',
  data: 'terminal:data',
  exit: 'terminal:exit'
} as const
