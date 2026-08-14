// The ARCHIVE event log hub. A single process-wide store that captures every
// proactive event the bridge emits (via `addProactiveListener`), keeps a bounded
// in-memory ring persisted to disk (survives restarts without a DB), writes
// through to Postgres for durable/unbounded history, and fans new events out to
// subscribed WS clients for a live console.
//
// Mirrors the OsintHub pattern (server/osint.ts). Plan: docs/data-archive-plan.md
// (Part A-A: AA1 persist events · AA2 log console).

import { existsSync, mkdirSync } from 'fs'
import { stateStore } from './stateStore'
import { join } from 'path'
import { addProactiveListener } from './chat'
import { historyHub } from './history'
import type { ArchiveEvent, ProactiveMeta } from '../shared/archive'

const DATA_DIR = process.env['HOMUNCULUS_DATA_DIR'] || join(process.cwd(), 'data')
const STORE_PATH = join(DATA_DIR, 'archive-events.json')
const RING = 1000 // events retained in memory + on disk
const SNAPSHOT = 300 // events sent to a client on subscribe

type Listener = (event: ArchiveEvent) => void

/** "Captain — PizzINT anomaly. 3 venues…" → "PizzINT anomaly". */
function deriveTitle(text: string): string {
  let s = text.replace(/^captain\s*[—–-]\s*/i, '').trim()
  const stop = s.search(/[.!?]/)
  if (stop > 0) s = s.slice(0, stop)
  return (s.slice(0, 80) || 'Event').trim()
}

class ArchiveHub {
  private events: ArchiveEvent[] = [] // newest last
  private listeners = new Set<Listener>()
  private saveTimer: NodeJS.Timeout | null = null

  start(): void {
    this.load()
    // Capture every proactive broadcast as an archived event.
    addProactiveListener((id, text, meta) => this.record(id, text, meta))
    console.log(`[archive] ready — ${this.events.length} events restored`)
  }

  private record(id: string, text: string, meta?: ProactiveMeta): void {
    const ts = Number(id.split('_')[1]) || Date.now()
    const event: ArchiveEvent = {
      id,
      ts,
      source: meta?.source ?? 'SYSTEM',
      severity: meta?.severity ?? 'notice',
      title: meta?.title ?? deriveTitle(text),
      body: text
    }
    this.events.push(event)
    if (this.events.length > RING) this.events.splice(0, this.events.length - RING)
    void historyHub.recordEvent(event) // durable write-through (fire-and-forget)
    for (const fn of this.listeners) fn(event)
    this.scheduleSave()
  }

  /** Most recent events, newest first. Prefers Postgres (full history) when
   *  available, falling back to the in-memory ring. */
  async recent(limit = SNAPSHOT): Promise<ArchiveEvent[]> {
    if (historyHub.enabled) {
      const rows = await historyHub.recentEvents(limit).catch(() => [])
      if (rows.length > 0) return rows
    }
    return this.events.slice(-limit).reverse()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ── Persistence (the in-memory ring → data/archive-events.json) ───────────
  private load(): void {
    try {
      if (!existsSync(STORE_PATH)) return
      const parsed = stateStore.readJson<{ events?: ArchiveEvent[] }>(STORE_PATH, {})
      if (Array.isArray(parsed.events)) this.events = parsed.events.slice(-RING)
    } catch (err) {
      console.error('[archive] failed to load store:', (err as Error).message)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 1000)
  }

  private save(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
      stateStore.writeJson(STORE_PATH, { events: this.events })
    } catch (err) {
      console.error('[archive] failed to save store:', (err as Error).message)
    }
  }
}

export const archiveHub = new ArchiveHub()
