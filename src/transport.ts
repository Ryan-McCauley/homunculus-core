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

class Transport {
  private ws: WebSocket | null = null
  private queue: ClientMsg[] = []
  private telemetrySubscribed = false
  private haSubscribed = false
  private osintSubscribed = false
  private archiveSubscribed = false
  // Event listeners keyed by a "ch:type" string.
  private listeners = new Map<string, Set<Handler>>()
  private statusResolvers: ((s: any) => void)[] = []

  connect(): void {
    const url = resolveWsUrl()
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      if (this.telemetrySubscribed) this.raw({ ch: 'telemetry', type: 'subscribe' })
      if (this.haSubscribed) this.raw({ ch: 'ha', type: 'subscribe' })
      if (this.osintSubscribed) this.raw({ ch: 'osint', type: 'subscribe' })
      if (this.archiveSubscribed) this.raw({ ch: 'archive', type: 'subscribe' })
      for (const m of this.queue.splice(0)) this.raw(m)
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
      setTimeout(() => this.connect(), 1500) // simple reconnect
    }
    ws.onerror = () => ws.close()
  }

  private raw(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    else this.queue.push(msg)
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
    }
  }

  ;(window as any).homunculus = api
}
