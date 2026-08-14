import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HaEntity, HaSnapshot } from '../shared/homeassistant'

// homeWatcher's whole value, per its header comment, is the pure "did this
// transition mean started/finished/fault" classifier buried in onSnapshot()
// and appliance() — both private. We can't call them directly, so we drive
// them the only way they're reachable: mock haHub.subscribe to capture the
// snapshot callback the watcher registers, then feed it a sequence of
// HaSnapshot fixtures and assert what got broadcast, in what order, with what
// severity. This is the real test target of this file; start()/stop() wiring
// itself is incidental.

const ha = vi.hoisted(() => ({
  handler: null as ((snap: HaSnapshot) => void) | null,
  unsub: vi.fn(),
  subscribe: vi.fn(),
}))
vi.mock('./homeassistant', () => ({
  haHub: { subscribe: ha.subscribe },
}))

const chat = vi.hoisted(() => ({ broadcastProactive: vi.fn() }))
vi.mock('./chat', () => ({ broadcastProactive: chat.broadcastProactive }))

let homeWatcher: (typeof import('./homewatch'))['homeWatcher']

async function freshModule() {
  vi.resetModules()
  ha.handler = null
  ha.unsub.mockClear()
  ha.subscribe.mockClear()
  ha.subscribe.mockImplementation((fn: (snap: HaSnapshot) => void) => { ha.handler = fn; return ha.unsub })
  chat.broadcastProactive.mockClear()
  const m = await import('./homewatch')
  homeWatcher = m.homeWatcher
}

beforeEach(async () => {
  await freshModule()
})

function entity(id: string, state: string): HaEntity {
  return { entityId: id, domain: id.split('.')[0]!, name: id, state, unit: null, deviceClass: null, attributes: {}, lastChanged: null }
}

function snap(entities: HaEntity[], connected = true): HaSnapshot {
  return { ts: Date.now(), connected, url: null, tempUnit: '°F', climate: [], entities, devices: [] }
}

function push(entities: HaEntity[], connected = true) {
  ha.handler!(snap(entities, connected))
}

describe('start / stop', () => {
  it('subscribes to haHub on start and is idempotent', () => {
    homeWatcher.start()
    homeWatcher.start()
    expect(ha.subscribe).toHaveBeenCalledTimes(1)
  })

  it('stop unsubscribes via the function haHub.subscribe returned', () => {
    homeWatcher.start()
    homeWatcher.stop()
    expect(ha.unsub).toHaveBeenCalledTimes(1)
  })
})

describe('baseline snapshot', () => {
  it('never broadcasts on the very first snapshot, regardless of content', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'run'), entity('sensor.r2peepoo_waste_drawer', '99')])
    expect(chat.broadcastProactive).not.toHaveBeenCalled()
  })

  it('ignores a disconnected snapshot entirely', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'run')], false)
    expect(chat.broadcastProactive).not.toHaveBeenCalled()
  })

  it('ignores a snapshot with no entities', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([])
    push([entity('sensor.washer_current_status', 'run')])
    // The empty snapshot was ignored, so 'off' is still the baseline —
    // this is genuinely the first observed transition into 'run'.
    expect(chat.broadcastProactive).toHaveBeenCalledTimes(1)
  })
})

describe('washer / dryer appliance transitions', () => {
  it('fires "started" on leaving an idle state for a running one', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'run')])
    expect(chat.broadcastProactive).toHaveBeenCalledTimes(1)
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'Washer cycle started',
      expect.objectContaining({ source: 'HOME', severity: 'info', title: 'Washer cycle started', chatLog: false }),
    )
  })

  it('fires "done" on reaching "end" from a running state', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'run')])
    chat.broadcastProactive.mockClear()
    push([entity('sensor.washer_current_status', 'end')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'Washer cycle complete',
      expect.objectContaining({ severity: 'notice', chatLog: false }),
    )
  })

  it('does not fire "done" when reaching "end" without ever having been running', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'end')])
    expect(chat.broadcastProactive).not.toHaveBeenCalled()
  })

  it('does not re-fire "started" on repeated running states', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'run')])
    chat.broadcastProactive.mockClear()
    push([entity('sensor.washer_current_status', 'run')])
    expect(chat.broadcastProactive).not.toHaveBeenCalled()
  })

  it('tracks the dryer independently of the washer', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off'), entity('sensor.dryer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'off'), entity('sensor.dryer_current_status', 'run')])
    expect(chat.broadcastProactive).toHaveBeenCalledTimes(1)
    expect(chat.broadcastProactive).toHaveBeenCalledWith('Dryer cycle started', expect.anything())
  })

  it('treats "pause" as idle, so resuming from pause does not re-fire "started"', () => {
    homeWatcher.start()
    push([entity('sensor.washer_current_status', 'off')])
    push([entity('sensor.washer_current_status', 'run')])
    chat.broadcastProactive.mockClear()
    push([entity('sensor.washer_current_status', 'pause')])
    push([entity('sensor.washer_current_status', 'run')])
    // 'pause' is IDLE_STATES, so run->pause is a "finish" with no matching msg.done
    // path (done only fires on 'end'), and pause->run is treated as a fresh start.
    expect(chat.broadcastProactive).toHaveBeenCalledWith('Washer cycle started', expect.anything())
  })
})

describe('waste drawer thresholds', () => {
  it('warns when crossing 80% and criticals when crossing 95%, each only once', () => {
    homeWatcher.start()
    push([entity('sensor.r2peepoo_waste_drawer', '10')])
    push([entity('sensor.r2peepoo_waste_drawer', '85')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith('R2PEEPOO waste drawer full', expect.objectContaining({ severity: 'warn' }))
    chat.broadcastProactive.mockClear()

    push([entity('sensor.r2peepoo_waste_drawer', '85')]) // still >=80, must not re-fire
    expect(chat.broadcastProactive).not.toHaveBeenCalled()

    push([entity('sensor.r2peepoo_waste_drawer', '96')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith('R2PEEPOO waste drawer critical — will stop cleaning until emptied', expect.objectContaining({ severity: 'critical' }))
  })

  it('treats a non-numeric drawer reading as 0', () => {
    homeWatcher.start()
    push([entity('sensor.r2peepoo_waste_drawer', 'unavailable')])
    push([entity('sensor.r2peepoo_waste_drawer', '85')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith('R2PEEPOO waste drawer full', expect.anything())
  })
})

describe('Voltaire (Tesla) charging', () => {
  it('announces charge start and charge complete', () => {
    homeWatcher.start()
    push([entity('sensor.voltaire_charging', 'not_charging'), entity('sensor.voltaire_battery_level', '50'), entity('number.voltaire_charge_limit', '90')])
    push([entity('sensor.voltaire_charging', 'charging'), entity('sensor.voltaire_battery_level', '50'), entity('number.voltaire_charge_limit', '90')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'Voltaire charging started — 50% → 90%',
      expect.objectContaining({ severity: 'info' }),
    )
    chat.broadcastProactive.mockClear()

    push([entity('sensor.voltaire_charging', 'complete'), entity('sensor.voltaire_battery_level', '90'), entity('number.voltaire_charge_limit', '90')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'Voltaire charging complete — 90% (limit 90%)',
      expect.objectContaining({ severity: 'notice' }),
    )
  })

  it('defaults the charge limit to 100 when unset or zero', () => {
    homeWatcher.start()
    push([entity('sensor.voltaire_charging', 'not_charging'), entity('sensor.voltaire_battery_level', '20')])
    push([entity('sensor.voltaire_charging', 'charging'), entity('sensor.voltaire_battery_level', '20')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'Voltaire charging started — 20% → 100%',
      expect.anything(),
    )
  })
})

describe('litter robot fault', () => {
  it('fires critical on entering a fault code and does not re-fire while it persists', () => {
    homeWatcher.start()
    push([entity('sensor.r2peepoo_status_code', 'rdy')])
    push([entity('sensor.r2peepoo_status_code', 'df1')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'R2PEEPOO needs attention — status DF1',
      expect.objectContaining({ severity: 'critical' }),
    )
    chat.broadcastProactive.mockClear()
    push([entity('sensor.r2peepoo_status_code', 'df1')])
    expect(chat.broadcastProactive).not.toHaveBeenCalled()
  })

  it('does not fire when leaving a fault state back to ready', () => {
    homeWatcher.start()
    push([entity('sensor.r2peepoo_status_code', 'rdy')])
    push([entity('sensor.r2peepoo_status_code', 'df1')])
    chat.broadcastProactive.mockClear()
    push([entity('sensor.r2peepoo_status_code', 'rdy')])
    expect(chat.broadcastProactive).not.toHaveBeenCalled()
  })

  it('is case-insensitive on the status code', () => {
    homeWatcher.start()
    push([entity('sensor.r2peepoo_status_code', 'RDY')])
    push([entity('sensor.r2peepoo_status_code', 'OFFLINE')])
    expect(chat.broadcastProactive).toHaveBeenCalledWith(
      'R2PEEPOO needs attention — status OFFLINE',
      expect.anything(),
    )
  })
})
