// Live system telemetry, collected once and fanned out to every connected
// client. A single 2s interval runs while at least one subscriber is present.

import si from 'systeminformation'
import type { CoreLoad, TelemetrySnapshot } from '../shared/telemetry'

const HISTORY = 24
const coreHistories: number[][] = []

function pushHistory(buf: number[], value: number): number[] {
  buf.push(Math.round(value))
  if (buf.length > HISTORY) buf.shift()
  return buf.slice()
}

async function collect(): Promise<TelemetrySnapshot> {
  const [load, mem, fsSize, net, cpu, temp, procs, time] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    si.cpu(),
    si.cpuTemperature().catch(() => ({ main: null, max: null })),
    si.processes(),
    Promise.resolve(si.time())
  ])

  const cores: CoreLoad[] = load.cpus.map((c, i) => {
    if (!coreHistories[i]) coreHistories[i] = []
    const history = pushHistory(coreHistories[i], c.load)
    return { id: i + 1, load: Math.round(c.load), history }
  })

  const primary = fsSize.slice().sort((a, b) => b.size - a.size)[0]
  const rxBytesSec = net.reduce((s, n) => s + (n.rx_sec || 0), 0)
  const txBytesSec = net.reduce((s, n) => s + (n.tx_sec || 0), 0)
  const totalBytes = net.reduce((s, n) => s + (n.rx_bytes || 0) + (n.tx_bytes || 0), 0)

  const topProcesses = procs.list
    .slice()
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 6)
    .map((p) => ({ pid: p.pid, name: p.name, cpu: Math.round(p.cpu) }))

  return {
    ts: Date.now(),
    cpu: {
      load: Math.round(load.currentLoad),
      cores,
      speedGHz: cpu.speed ?? null,
      tempC: temp.main ?? null,
      tempMaxC: temp.max ?? null
    },
    memory: {
      usedBytes: mem.active,
      totalBytes: mem.total,
      percent: Math.round((mem.active / mem.total) * 100),
      swapPercent: mem.swaptotal ? Math.round((mem.swapused / mem.swaptotal) * 100) : 0
    },
    storage: {
      usedBytes: primary?.used ?? 0,
      totalBytes: primary?.size ?? 0,
      percent: Math.round(primary?.use ?? 0)
    },
    network: {
      rxMbps: +((rxBytesSec * 8) / 1e6).toFixed(1),
      txMbps: +((txBytesSec * 8) / 1e6).toFixed(1),
      totalBytes
    },
    tasks: procs.all,
    uptimeSec: time.uptime ?? 0,
    topProcesses
  }
}

type Listener = (snapshot: TelemetrySnapshot) => void

class TelemetryHub {
  private listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | null = null
  private latest: TelemetrySnapshot | null = null

  getLatest(): TelemetrySnapshot | null {
    return this.latest
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    if (this.latest) fn(this.latest) // prime the new client immediately
    this.ensureRunning()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private ensureRunning(): void {
    if (this.timer) return
    const tick = async (): Promise<void> => {
      try {
        this.latest = await collect()
        for (const fn of this.listeners) fn(this.latest)
      } catch (err) {
        console.error('[telemetry] collection failed:', err)
      }
    }
    void tick()
    this.timer = setInterval(tick, 2000)
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export const telemetryHub = new TelemetryHub()
