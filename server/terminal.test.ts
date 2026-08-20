import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerMsg } from '../shared/protocol'

// TerminalManager loads node-pty lazily through createRequire, so the module is
// swapped here rather than mocked as an ESM import: that is the seam the real
// code actually goes through, and it means these tests never fork a shell.
const pty = vi.hoisted(() => ({
  spawned: 0,
  killed: 0,
  spawn(_file: string, _args: string[]) {
    pty.spawned++
    return {
      onData: (_fn: (chunk: string) => void) => {},
      onExit: (_fn: (e: { exitCode: number }) => void) => {},
      resize: () => {},
      kill: () => { pty.killed++ },
      write: () => {},
    }
  },
}))

vi.mock('module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('module')>()),
  createRequire: () => () => pty,
}))

const { TerminalManager, MAX_SESSIONS_PER_CONNECTION } = await import('./terminal')

describe('TerminalManager', () => {
  let sent: ServerMsg[]
  let term: InstanceType<typeof TerminalManager>

  beforeEach(() => {
    pty.spawned = 0
    pty.killed = 0
    sent = []
    term = new TerminalManager((msg) => { sent.push(msg) })
  })

  const dataFor = (id: string): string =>
    sent.filter((m) => m.ch === 'term' && m.type === 'data' && m.id === id)
      .map((m) => (m as { data: string }).data).join('')

  it('opens a PTY per distinct id', () => {
    term.start('a', 80, 24)
    term.start('b', 80, 24)
    expect(pty.spawned).toBe(2)
  })

  it('ignores a repeat start for an id it already holds', () => {
    term.start('a', 80, 24)
    term.start('a', 80, 24)
    expect(pty.spawned).toBe(1)
  })

  it('refuses to fork past the per-connection ceiling', () => {
    // The control this guards: `term:start` is driven by a client-chosen id, so
    // without a cap one authorised socket can fork shells until the host runs out
    // of process table.
    for (let i = 0; i < MAX_SESSIONS_PER_CONNECTION + 5; i++) term.start(`s${i}`, 80, 24)
    expect(pty.spawned).toBe(MAX_SESSIONS_PER_CONNECTION)
  })

  it('tells the client why, and closes the tab it refused', () => {
    for (let i = 0; i < MAX_SESSIONS_PER_CONNECTION; i++) term.start(`s${i}`, 80, 24)
    term.start('over', 80, 24)

    expect(dataFor('over')).toContain('Terminal limit')
    expect(sent).toContainEqual({ ch: 'term', type: 'exit', id: 'over', exitCode: 1 })
  })

  it('frees a slot when a session is killed', () => {
    for (let i = 0; i < MAX_SESSIONS_PER_CONNECTION; i++) term.start(`s${i}`, 80, 24)
    term.kill('s0')
    term.start('replacement', 80, 24)
    expect(pty.spawned).toBe(MAX_SESSIONS_PER_CONNECTION + 1)
  })

  it('kills every PTY when the connection goes away', () => {
    term.start('a', 80, 24)
    term.start('b', 80, 24)
    term.disposeAll()
    expect(pty.killed).toBe(2)
    // And the slots are free again for the next connection's manager.
    term.start('c', 80, 24)
    expect(pty.spawned).toBe(3)
  })
})
