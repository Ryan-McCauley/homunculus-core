// Shared types for the telemetry stream that flows main -> renderer.
// Keep this file dependency-free so both the Electron main process and the
// React renderer can import it.

export interface CoreLoad {
  /** Core index, 1-based for display. */
  id: number
  /** Current load percentage, 0-100. */
  load: number
  /** Recent load history for sparklines, oldest -> newest. */
  history: number[]
}

export interface ProcessInfo {
  pid: number
  name: string
  cpu: number
}

export interface TelemetrySnapshot {
  /** Epoch millis the snapshot was taken. */
  ts: number
  cpu: {
    /** Aggregate load, 0-100. */
    load: number
    cores: CoreLoad[]
    speedGHz: number | null
    tempC: number | null
    tempMaxC: number | null
  }
  memory: {
    usedBytes: number
    totalBytes: number
    /** 0-100 */
    percent: number
    swapPercent: number
  }
  storage: {
    usedBytes: number
    totalBytes: number
    /** 0-100 */
    percent: number
  }
  network: {
    rxMbps: number
    txMbps: number
    totalBytes: number
  }
  tasks: number
  uptimeSec: number
  topProcesses: ProcessInfo[]
}

/** Channel names for the IPC bridge. Centralized to avoid typos. */
export const IPC = {
  /** Renderer asks main to start streaming telemetry. */
  telemetrySubscribe: 'telemetry:subscribe',
  /** Main pushes a new snapshot to the renderer. */
  telemetryUpdate: 'telemetry:update'
} as const
