// Per-connection terminal manager. Lean: one PTY per id, output coalesced into
// ~one WS message per frame to keep IPC/GC churn low (the eDEX RAM problem).
// node-pty is loaded lazily and guarded so a missing binary disables only the
// terminal, not the whole server.

import os from 'os'
import { createRequire } from 'module'
import type { IPty, IPtyForkOptions } from '@homebridge/node-pty-prebuilt-multiarch'
import type { Send } from '../shared/protocol'

const FLUSH_MS = 16
const FLUSH_BYTES = 64 * 1024

/**
 * Live PTYs one client connection may hold.
 *
 * Each is a real shell process with the backend user's permissions, and `start`
 * is driven entirely by a client-chosen id — so without a ceiling, one authorised
 * socket sending `start` in a loop forks shells until the host runs out of process
 * table or memory. Four is well past what the UI can show (the Terminal widget
 * opens one, and a grid of them is still single digits) and far below anything
 * that hurts. Closing the socket disposes them all, so this bounds the live count,
 * not the lifetime total.
 */
export const MAX_SESSIONS_PER_CONNECTION = 4

interface PtyModule {
  spawn(file: string, args: string[], opts: IPtyForkOptions): IPty
}
const require = createRequire(import.meta.url)
let ptyModule: PtyModule | null | undefined

function getPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('@homebridge/node-pty-prebuilt-multiarch') as PtyModule
    } catch (err) {
      console.error('[terminal] native PTY module unavailable:', err)
      ptyModule = null
    }
  }
  return ptyModule
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] || 'powershell.exe'
  return process.env['SHELL'] || '/bin/bash'
}

interface Session {
  proc: IPty
  buffer: string
  timer: NodeJS.Timeout | null
  disposed: boolean
}

export class TerminalManager {
  private sessions = new Map<string, Session>()
  constructor(private send: Send) {}

  start(id: string, cols: number, rows: number): void {
    if (this.sessions.has(id)) return

    if (this.sessions.size >= MAX_SESSIONS_PER_CONNECTION) {
      this.send({
        ch: 'term',
        type: 'data',
        id,
        data:
          `\x1b[31m[ Terminal limit ]\x1b[0m This connection already holds ` +
          `${MAX_SESSIONS_PER_CONNECTION} shells. Close one before opening another.\r\n`
      })
      this.send({ ch: 'term', type: 'exit', id, exitCode: 1 })
      return
    }

    const pty = getPty()
    if (!pty) {
      this.send({
        ch: 'term',
        type: 'data',
        id,
        data:
          '\x1b[31m[ Terminal offline ]\x1b[0m PTY native module is not built.\r\n' +
          'On the server host run \x1b[36mnpm run rebuild\x1b[0m (or rebuild the container).\r\n'
      })
      this.send({ ch: 'term', type: 'exit', id, exitCode: 1 })
      return
    }

    const proc = pty.spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
    const session: Session = { proc, buffer: '', timer: null, disposed: false }
    this.sessions.set(id, session)

    proc.onData((chunk) => {
      session.buffer += chunk
      if (session.buffer.length >= FLUSH_BYTES) this.flush(id)
      else if (!session.timer) session.timer = setTimeout(() => this.flush(id), FLUSH_MS)
    })
    proc.onExit(({ exitCode }) => {
      this.flush(id)
      this.send({ ch: 'term', type: 'exit', id, exitCode })
      this.kill(id)
    })
  }

  private flush(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    if (s.buffer.length === 0) return
    const data = s.buffer
    s.buffer = ''
    this.send({ ch: 'term', type: 'data', id, data })
  }

  input(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return
    try {
      s.proc.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      /* exited between frames */
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.disposed = true
    if (s.timer) clearTimeout(s.timer)
    this.sessions.delete(id)
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
  }

  /** Kill every PTY for this connection (on disconnect). */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
