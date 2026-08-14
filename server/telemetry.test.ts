import { describe, it, expect, vi } from 'vitest'

// `telemetryHub` is a module-level singleton driving a 2s setInterval collector
// built on top of `systeminformation`. `collect()` and `pushHistory()` are both
// unexported internals, so — as directed for the integration-heavy files in
// this batch — we mock `systeminformation` entirely and drive the hub through
// its one public surface (subscribe/getLatest), which exercises the real
// data-shaping logic (rounding, sorting, history trimming) without ever
// touching the real OS.
//
// IMPORTANT: every test that subscribes must call the returned unsubscribe
// function. telemetryHub only clears its interval once listener count hits
// zero, and a forgotten unsub leaves a real setInterval running for the rest
// of the file (see the near-identical bug caught in homeassistant.test.ts).
//
// OUT OF SCOPE: the setInterval wiring itself (ensureRunning/stop) is only
// exercised incidentally through subscribe/unsubscribe below, same as the HA
// hub. The real `si.*` calls (shelling out to the OS / `ps`) are never
// exercised — that is the integration seam this test suite intentionally
// does not cross.

const si = vi.hoisted(() => ({
  currentLoad: vi.fn(),
  mem: vi.fn(),
  fsSize: vi.fn(),
  networkStats: vi.fn(),
  cpu: vi.fn(),
  cpuTemperature: vi.fn(),
  processes: vi.fn(),
  time: vi.fn(),
}))

vi.mock('systeminformation', () => ({ default: si }))

async function freshModule() {
  vi.resetModules()
  return import('./telemetry')
}

function primeSi(overrides: Partial<typeof si> = {}) {
  si.currentLoad.mockResolvedValue({
    currentLoad: 42.4,
    cpus: [{ load: 10.4 }, { load: 90.6 }],
  })
  si.mem.mockResolvedValue({ active: 4_000_000, total: 8_000_000, swaptotal: 1_000_000, swapused: 250_000 })
  si.fsSize.mockResolvedValue([
    { size: 100, used: 50, use: 50 },
    { size: 1000, used: 400, use: 40 }, // largest by size — should be picked as "primary"
  ])
  si.networkStats.mockResolvedValue([
    { rx_sec: 1_000_000, tx_sec: 500_000, rx_bytes: 10, tx_bytes: 20 },
    { rx_sec: 2_000_000, tx_sec: 500_000, rx_bytes: 30, tx_bytes: 40 },
  ])
  si.cpu.mockResolvedValue({ speed: 3.2 })
  si.cpuTemperature.mockResolvedValue({ main: 55, max: 80 })
  si.processes.mockResolvedValue({
    all: 250,
    list: [
      { pid: 1, name: 'low', cpu: 1.1 },
      { pid: 2, name: 'high', cpu: 99.9 },
      { pid: 3, name: 'mid', cpu: 50.2 },
      { pid: 4, name: 'd', cpu: 4 },
      { pid: 5, name: 'e', cpu: 5 },
      { pid: 6, name: 'f', cpu: 6 },
      { pid: 7, name: 'g', cpu: 7 }, // 7th process — should be dropped by top-6
    ],
  })
  si.time.mockReturnValue({ uptime: 12345 })
  Object.assign(si, overrides)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('telemetryHub.subscribe', () => {
  it('primes a new listener immediately with a fully-shaped snapshot', async () => {
    primeSi()
    const m = await freshModule()
    const listener = vi.fn()
    const unsub = m.telemetryHub.subscribe(listener)
    await wait(10)
    expect(listener).toHaveBeenCalledTimes(1)
    const snap = listener.mock.calls[0]![0]

    expect(snap.cpu.load).toBe(42) // rounded
    expect(snap.cpu.speedGHz).toBe(3.2)
    expect(snap.cpu.tempC).toBe(55)
    expect(snap.cpu.tempMaxC).toBe(80)
    expect(snap.cpu.cores).toEqual([
      { id: 1, load: 10, history: [10] },
      { id: 2, load: 91, history: [91] },
    ])

    expect(snap.memory.percent).toBe(50) // 4M/8M
    expect(snap.memory.swapPercent).toBe(25) // 250k/1M

    // The largest filesystem (by size) is picked as "primary" storage.
    expect(snap.storage).toEqual({ usedBytes: 400, totalBytes: 1000, percent: 40 })

    expect(snap.network.rxMbps).toBeCloseTo((3_000_000 * 8) / 1e6, 5)
    expect(snap.network.txMbps).toBeCloseTo((1_000_000 * 8) / 1e6, 5)
    expect(snap.network.totalBytes).toBe(100)

    expect(snap.tasks).toBe(250)
    expect(snap.uptimeSec).toBe(12345)

    // Top 6 processes by cpu, descending, capped at 6.
    expect(snap.topProcesses).toEqual([
      { pid: 2, name: 'high', cpu: 100 },
      { pid: 3, name: 'mid', cpu: 50 },
      { pid: 7, name: 'g', cpu: 7 },
      { pid: 6, name: 'f', cpu: 6 },
      { pid: 5, name: 'e', cpu: 5 },
      { pid: 4, name: 'd', cpu: 4 },
    ])
    expect(snap.topProcesses).toHaveLength(6)
    unsub()
  })

  it('falls back to 0 swapPercent when swaptotal is 0 (avoids divide-by-zero)', async () => {
    primeSi()
    si.mem.mockResolvedValue({ active: 1, total: 2, swaptotal: 0, swapused: 0 })
    const m = await freshModule()
    const listener = vi.fn()
    const unsub = m.telemetryHub.subscribe(listener)
    await wait(10)
    expect(listener.mock.calls[0]![0].memory.swapPercent).toBe(0)
    unsub()
  })

  it('falls back to null cpu temperature when the sensor read fails', async () => {
    primeSi()
    si.cpuTemperature.mockRejectedValue(new Error('no sensor'))
    const m = await freshModule()
    const listener = vi.fn()
    const unsub = m.telemetryHub.subscribe(listener)
    await wait(10)
    const snap = listener.mock.calls[0]![0]
    expect(snap.cpu.tempC).toBeNull()
    expect(snap.cpu.tempMaxC).toBeNull()
    unsub()
  })

  it('reports zeroed storage when fsSize returns no filesystems', async () => {
    primeSi()
    si.fsSize.mockResolvedValue([])
    const m = await freshModule()
    const listener = vi.fn()
    const unsub = m.telemetryHub.subscribe(listener)
    await wait(10)
    expect(listener.mock.calls[0]![0].storage).toEqual({ usedBytes: 0, totalBytes: 0, percent: 0 })
    unsub()
  })

  it('caps each core history buffer at 24 samples and drops the oldest first', async () => {
    primeSi()
    // Drive the real 2s collector loop with fake timers (25+ ticks over real
    // time would be far too slow) and vary the load per tick so the oldest
    // sample dropping off the front is observable, not just the buffer length.
    let tick = 0
    si.currentLoad.mockImplementation(async () => ({ currentLoad: 0, cpus: [{ load: ++tick }] }))
    vi.useFakeTimers()
    try {
      const m = await freshModule()
      const listener = vi.fn()
      const unsub = m.telemetryHub.subscribe(listener)
      await vi.advanceTimersByTimeAsync(0) // flush the immediate first tick
      for (let i = 0; i < 26; i++) await vi.advanceTimersByTimeAsync(2000)

      const snap = listener.mock.calls[listener.mock.calls.length - 1]![0]
      const history = snap.cpu.cores[0].history
      expect(history).toHaveLength(24)
      // 27 ticks total (1 immediate + 26 interval) → history holds loads 4..27.
      expect(history[0]).toBe(4)
      expect(history[history.length - 1]).toBe(27)
      unsub()
    } finally {
      vi.useRealTimers()
    }
  })

  it('primes a newly-subscribed listener from the cached latest snapshot without a new collection', async () => {
    primeSi()
    const m = await freshModule()
    const first = vi.fn()
    const unsub1 = m.telemetryHub.subscribe(first)
    await wait(10)
    const callsAfterFirst = si.currentLoad.mock.calls.length

    const second = vi.fn()
    const unsub2 = m.telemetryHub.subscribe(second)
    expect(second).toHaveBeenCalledTimes(1)
    expect(si.currentLoad.mock.calls.length).toBe(callsAfterFirst)
    unsub1()
    unsub2()
  })

  it('logs and does not crash the hub when a collection cycle throws', async () => {
    si.currentLoad.mockRejectedValue(new Error('si exploded'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = await freshModule()
    const listener = vi.fn()
    const unsub = m.telemetryHub.subscribe(listener)
    await wait(10)
    expect(listener).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    expect(m.telemetryHub.getLatest()).toBeNull()
    unsub()
  })
})

describe('telemetryHub.getLatest', () => {
  it('is null before anything has ever subscribed', async () => {
    const m = await freshModule()
    expect(m.telemetryHub.getLatest()).toBeNull()
  })

  it('reflects the most recent snapshot after a collection', async () => {
    primeSi()
    const m = await freshModule()
    const unsub = m.telemetryHub.subscribe(() => {})
    await wait(10)
    expect(m.telemetryHub.getLatest()).not.toBeNull()
    unsub()
  })
})
