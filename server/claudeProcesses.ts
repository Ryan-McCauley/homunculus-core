// Every live Claude session this server owns, in one place.
//
// Six call sites invoke the Agent SDK's query(): agent runs, agent chat turns,
// agent off-shift handoffs, strategy skill runs, the Computer Core chat, and the
// proactive monitor. Each burns subscription tokens and can run for minutes, and
// until now nothing could enumerate them, let alone stop one — a wedged agent had
// to be waited out or the server restarted.
//
// HOW STOPPING WORKS. The SDK cancels through `Options.abortController`, not
// through query.interrupt(): interrupt() is only supported in streaming-input
// mode, and every call site here passes a plain string prompt. Aborting the
// controller runs the SDK's graceful close — stdin EOF, then a ~2s grace window
// before the child is killed — so a stop is a clean shutdown rather than a
// SIGKILL, and the run's own finally block still executes.
//
// Registration is the call site's job and its `done()` must be in a finally, or
// a crashed run would sit in this list forever claiming to be alive.

import { randomUUID } from 'node:crypto'
import { auditLog, currentActor } from './auditLog'
import type { ClaudeKind, ClaudeProcess } from '../shared/claude'

// `stoppedBy` is optional on the wire but always present internally, so the
// internal shape overrides it rather than widening the public one.
interface Entry extends Omit<ClaudeProcess, 'stoppedBy'> {
  controller: AbortController
  /** Set when a stop was requested, so the call site can tell abort from crash. */
  stoppedBy: string | null
}

class ClaudeProcessRegistry {
  private live = new Map<string, Entry>()

  /**
   * Registers a session about to start. Returns the controller to hand to
   * `query({ options: { abortController } })`, plus `done()` for the finally.
   */
  register(input: {
    kind: ClaudeKind
    label: string
    detail: string
    component: string
    model?: string
  }): { id: string; controller: AbortController; done: () => void; wasStopped: () => boolean } {
    const id = `cp_${Date.now()}_${randomUUID().slice(0, 6)}`
    const entry: Entry = {
      id,
      kind: input.kind,
      label: input.label,
      detail: input.detail,
      component: input.component,
      model: input.model || 'default',
      startedAt: Date.now(),
      stoppedBy: null,
      controller: new AbortController(),
    }
    this.live.set(id, entry)
    return {
      id,
      controller: entry.controller,
      done: () => { this.live.delete(id) },
      wasStopped: () => entry.stoppedBy !== null,
    }
  }

  /** Everything running right now, newest first. */
  list(): ClaudeProcess[] {
    return [...this.live.values()]
      .map(({ controller: _c, stoppedBy, ...p }) => ({ ...p, ...(stoppedBy ? { stoppedBy } : {}) }))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Aborts one session. Returns false if the id is unknown — which usually means
   * it finished between the operator seeing the list and pressing the button, so
   * callers should treat that as "already gone", not as an error.
   */
  stop(id: string): { ok: boolean; error?: string; process?: ClaudeProcess } {
    const entry = this.live.get(id)
    if (!entry) return { ok: false, error: 'not running (it may have just finished)' }
    if (entry.stoppedBy) return { ok: false, error: 'already stopping' }

    const by = currentActor()
    entry.stoppedBy = by
    const ranFor = Date.now() - entry.startedAt
    auditLog.record({
      actor: by,
      origin: 'http',
      action: 'claude.stop',
      resource: entry.component,
      summary: `stopped ${entry.kind} "${entry.label}" after ${Math.round(ranFor / 1000)}s — ${entry.detail}`,
      meta: { processId: id, kind: entry.kind, label: entry.label, ranForMs: ranFor, model: entry.model },
    })
    // The SDK closes stdin and waits out its grace window before killing the
    // child, so the run's own finally block still gets to record its outcome.
    entry.controller.abort()
    console.log(`[claude] ${by} stopped ${entry.kind} "${entry.label}" after ${Math.round(ranFor / 1000)}s`)

    const { controller: _c, stoppedBy: _s, ...view } = entry
    return { ok: true, process: view }
  }

  /** Stops everything. Returns how many were signalled. */
  stopAll(): number {
    let n = 0
    for (const id of [...this.live.keys()]) if (this.stop(id).ok) n++
    return n
  }

  count(): number {
    return this.live.size
  }
}

export const claudeProcesses = new ClaudeProcessRegistry()
