// WebSocket transport. Connects to the backend and installs a
// `window.homunculus` object of the shared HomunculusApi shape, so every panel
// is transport-agnostic (same code in the browser and the Electron shell).

import type { HomunculusApi } from '../shared/api'
import type { ClientMsg, ServerMsg } from '../shared/protocol'

type Handler = (payload: any) => void

function resolveWsUrl(): string {
  const q = new URLSearchParams(location.search)
  const token = q.get('token') || (window as any).__HOMUNCULUS_TOKEN__ || ''
  const explicit = (window as any).__HOMUNCULUS_WS__ as string | undefined

  let base: string
  if (explicit) base = explicit
  // Vite dev server runs on 5173; the backend is on 8787.
  else if (location.port === '5173') base = `ws://${location.hostname}:8787`
  else base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

  const url = new URL(base)
  url.pathname = '/ws'
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

/** Queued messages are dropped past this. A backlog only builds while the socket
 *  is down, and replaying an unbounded one on reconnect is worse than losing it. */
const MAX_QUEUED = 50
/** Queued messages older than this are discarded rather than replayed. A chat turn
 *  the user typed during an outage should not start a Claude session — one that can
 *  stage trades — half an hour later, unprompted. */
const QUEUE_TTL_MS = 30_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

class Transport {
  private ws: WebSocket | null = null
  private queue: { msg: ClientMsg; at: number }[] = []
  private telemetrySubscribed = false
  private haSubscribed = false
  private osintSubscribed = false
  private archiveSubscribed = false
  // Event listeners keyed by a "ch:type" string.
  private listeners = new Map<string, Set<Handler>>()
  private statusResolvers: ((s: any) => void)[] = []
  private reconnectDelay = RECONNECT_MIN_MS
  private connected = false

  connect(): void {
    const url = resolveWsUrl()
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.connected = true
      this.reconnectDelay = RECONNECT_MIN_MS // a good connection resets the backoff
      this.emitLocal('connection', 'open', {})
      if (this.telemetrySubscribed) this.raw({ ch: 'telemetry', type: 'subscribe' })
      if (this.haSubscribed) this.raw({ ch: 'ha', type: 'subscribe' })
      if (this.osintSubscribed) this.raw({ ch: 'osint', type: 'subscribe' })
      if (this.archiveSubscribed) this.raw({ ch: 'archive', type: 'subscribe' })
      // Replay only what is still fresh — see QUEUE_TTL_MS.
      const now = Date.now()
      const fresh = this.queue.splice(0).filter((q) => now - q.at < QUEUE_TTL_MS)
      for (const q of fresh) this.raw(q.msg)
    }
    ws.onmessage = (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.ch === 'chat' && msg.type === 'status') {
        this.statusResolvers.splice(0).forEach((r) => r(msg.status))
        return
      }
      const key = `${msg.ch}:${msg.type}`
      this.listeners.get(key)?.forEach((h) => h(msg))
    }
    ws.onclose = () => {
      this.ws = null
      const wasConnected = this.connected
      this.connected = false
      // Tell the app the socket died. Without this a turn that was mid-stream never
      // receives its 'done'/'error', so useChat's `busy` latch stays set and the
      // Computer Core is dead until a page reload — on an app designed to run for
      // days, any transient blip bricked the chat.
      if (wasConnected) {
        this.emitLocal('connection', 'closed', {})
        // Anything awaiting a status reply will never get one now.
        this.statusResolvers.splice(0).forEach((r) => r(null))
      }
      // Capped exponential backoff with jitter. The old fixed 1.5s loop hammered a
      // down remote node forever; jitter keeps several open tabs from retrying in
      // lockstep.
      const delay = Math.min(this.reconnectDelay, RECONNECT_MAX_MS)
      this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS)
      setTimeout(() => this.connect(), delay + Math.random() * 250)
    }
    ws.onerror = () => ws.close()
  }

  /** Dispatches a synthetic, client-side event to the same listener registry the
   *  server's messages use, so hooks can subscribe to transport state uniformly. */
  private emitLocal(ch: string, type: string, payload: Record<string, unknown>): void {
    this.listeners.get(`${ch}:${type}`)?.forEach((h) => h({ ch, type, ...payload }))
  }

  isConnected(): boolean {
    return this.connected
  }

  private raw(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(msg)); return }
    // Terminal keystrokes are worthless once the PTY behind them is gone — replaying
    // them into a session id that no longer exists is noise at best.
    if (msg.ch === 'term') return
    this.queue.push({ msg, at: Date.now() })
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED)
  }

  send(msg: ClientMsg): void {
    this.raw(msg)
  }

  on(ch: string, type: string, handler: Handler): () => void {
    const key = `${ch}:${type}`
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, (set = new Set()))
    set.add(handler)
    return () => set!.delete(handler)
  }

  requestStatus(): Promise<any> {
    return new Promise((resolve) => {
      this.statusResolvers.push(resolve)
      this.raw({ ch: 'chat', type: 'status' })
    })
  }

  markTelemetrySubscribed(): void {
    this.telemetrySubscribed = true
  }

  markHaSubscribed(): void {
    this.haSubscribed = true
  }

  markOsintSubscribed(): void {
    this.osintSubscribed = true
  }

  markArchiveSubscribed(): void {
    this.archiveSubscribed = true
  }
}

export function installTransport(): void {
  const t = new Transport()
  t.connect()

  const api: HomunculusApi = {
    onTelemetry(handler) {
      const off = t.on('telemetry', 'update', (m) => handler(m.snapshot))
      t.markTelemetrySubscribed()
      t.send({ ch: 'telemetry', type: 'subscribe' })
      return off
    },
    chatStatus: () => t.requestStatus(),
    sendChat(id, text) {
      t.send({ ch: 'chat', type: 'send', id, text })
    },
    onChatDelta: (h) => t.on('chat', 'delta', h),
    onChatDone: (h) => t.on('chat', 'done', h),
    onChatError: (h) => t.on('chat', 'error', h),
    onChatProactive: (h) => t.on('chat', 'proactive', h),
    termStart(id, cols, rows) {
      t.send({ ch: 'term', type: 'start', id, cols, rows })
    },
    termInput(id, data) {
      t.send({ ch: 'term', type: 'input', id, data })
    },
    termResize(id, cols, rows) {
      t.send({ ch: 'term', type: 'resize', id, cols, rows })
    },
    termKill(id) {
      t.send({ ch: 'term', type: 'kill', id })
    },
    onTermData: (h) => t.on('term', 'data', h),
    onTermExit: (h) => t.on('term', 'exit', h),
    onHa(handler) {
      const off = t.on('ha', 'update', (m) => handler(m.snapshot))
      t.markHaSubscribed()
      t.send({ ch: 'ha', type: 'subscribe' })
      return off
    },
    sendHaCommand(entityId, service, data) {
      t.send({ ch: 'ha', type: 'command', entityId, service, data })
    },
    onOsint(handler) {
      const off = t.on('osint', 'update', (m) => handler(m.snapshot))
      t.markOsintSubscribed()
      t.send({ ch: 'osint', type: 'subscribe' })
      return off
    },
    osintRefresh() {
      t.send({ ch: 'osint', type: 'refresh' })
    },
    osintSetGeofence(config) {
      t.send({ ch: 'osint', type: 'geofence', config })
    },
    onArchive(handlers) {
      const offSnap = t.on('archive', 'snapshot', (m) => handlers.snapshot(m.snapshot))
      const offEvent = t.on('archive', 'event', (m) => handlers.event(m.event))
      t.markArchiveSubscribed()
      t.send({ ch: 'archive', type: 'subscribe' })
      return () => { offSnap(); offEvent() }
    },
    onDisconnect: (h) => t.on('connection', 'closed', () => h()),
    onReconnect: (h) => t.on('connection', 'open', () => h()),
    isConnected: () => t.isConnected(),
  }

  ;(window as any).homunculus = api
}
