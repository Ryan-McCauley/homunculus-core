// Watches Home Assistant entity-state transitions and emits archived toast
// events for the "connected things" in the home — washer/dryer start + finish,
// the litter robot's waste drawer + faults, and Voltaire (Tesla) charging.
//
// This is the server-side source of truth: every transition goes through
// `broadcastProactive`, which (1) fires a toast on every client, (2) writes a
// durable ARCHIVE record, and (3) — because these carry `chatLog: false` — is
// kept out of the ComputerCore conversation so device chatter never spams it.
// Mirrors the old client-side useHaWatcher, which this replaces.

import type { HaEntity, HaSnapshot } from '../shared/homeassistant'
import type { ProactiveMeta } from '../shared/archive'
import { haHub } from './homeassistant'
import { broadcastProactive } from './chat'

// Appliance states that mean "not running" — a transition OUT of these into a
// running state is a "started"; a transition INTO 'end' from running is "done".
const IDLE_STATES = new Set([
  'power_off', 'off', 'on', 'power_on', 'unknown', 'end', 'initial',
  'detecting', 'pause', 'unavailable', 'none', ''
])

function indexById(entities: HaEntity[]): Map<string, HaEntity> {
  const m = new Map<string, HaEntity>()
  for (const e of entities) m.set(e.entityId, e)
  return m
}

function emit(text: string, meta: Omit<ProactiveMeta, 'chatLog'>): void {
  broadcastProactive(text, { ...meta, chatLog: false })
}

/** [headline, subtitle, tabler-icon] for a device toast. */
type Msg = [head: string, sub: string, icon: string]

const M = (head: string, sub: string, icon: string): Msg => [head, sub, icon]

class HomeWatcher {
  private prev: Record<string, string> = {}
  private started = false
  private off: (() => void) | null = null

  start(): void {
    if (this.started) return
    this.started = true
    this.off = haHub.subscribe((snap) => this.onSnapshot(snap))
    console.log('[homewatch] ready — watching connected devices for toast events')
  }

  stop(): void {
    if (this.off) this.off()
    this.off = null
    this.started = false
  }

  private onSnapshot(snap: HaSnapshot): void {
    if (!snap.connected || snap.entities.length === 0) return
    const idx = indexById(snap.entities)
    const cur = this.prev
    const first = Object.keys(cur).length === 0

    const get = (id: string): string => idx.get(id)?.state ?? ''
    const num = (id: string): number => {
      const n = Number(idx.get(id)?.state)
      return Number.isFinite(n) ? n : 0
    }

    // ── Washer: started + done ───────────────────────────────────────────
    this.appliance(
      'sensor.washer_current_status', get('sensor.washer_current_status'), first,
      { start: M('Washer cycle started', 'Load running', 'ti-wash'),
        done: M('Washer cycle complete', 'Load ready to transfer', 'ti-wash') }
    )

    // ── Dryer: started + done ────────────────────────────────────────────
    this.appliance(
      'sensor.dryer_current_status', get('sensor.dryer_current_status'), first,
      { start: M('Dryer cycle started', 'Load drying', 'ti-wind'),
        done: M('Dryer cycle complete', 'Load ready to fold', 'ti-wind') }
    )

    // ── Waste drawer thresholds ──────────────────────────────────────────
    const waste = num('sensor.r2peepoo_waste_drawer')
    const prevWaste = Number(cur['sensor.r2peepoo_waste_drawer'] ?? waste)
    if (!first && prevWaste < 80 && waste >= 80) {
      emit('R2PEEPOO waste drawer full', { source: 'HOME', severity: 'warn', title: 'Waste drawer full', icon: 'ti-trash' })
    }
    if (!first && prevWaste < 95 && waste >= 95) {
      emit('R2PEEPOO waste drawer critical — will stop cleaning until emptied', { source: 'HOME', severity: 'critical', title: 'Waste drawer critical', icon: 'ti-alert-triangle' })
    }
    cur['sensor.r2peepoo_waste_drawer'] = String(waste)

    // ── Tesla (Voltaire) charge complete ─────────────────────────────────
    const charging = get('sensor.voltaire_charging')
    const batt = num('sensor.voltaire_battery_level')
    const limit = num('number.voltaire_charge_limit') || 100
    if (!first && cur['sensor.voltaire_charging'] === 'charging' && charging !== 'charging') {
      emit(`Voltaire charging complete — ${batt}% (limit ${limit}%)`, { source: 'HOME', severity: 'notice', title: 'Voltaire charged', icon: 'ti-car' })
    }
    if (!first && cur['sensor.voltaire_charging'] !== 'charging' && charging === 'charging') {
      emit(`Voltaire charging started — ${batt}% → ${limit}%`, { source: 'HOME', severity: 'info', title: 'Voltaire charging', icon: 'ti-bolt' })
    }
    cur['sensor.voltaire_charging'] = charging

    // ── Litter robot fault ───────────────────────────────────────────────
    const lrCode = get('sensor.r2peepoo_status_code').toLowerCase()
    const prevLr = (cur['sensor.r2peepoo_status_code'] ?? lrCode).toLowerCase()
    const faults = new Set(['df1', 'df2', 'dfs', 'sdf', 'br', 'offline'])
    if (!first && !faults.has(prevLr) && faults.has(lrCode)) {
      emit(`R2PEEPOO needs attention — status ${lrCode.toUpperCase()}`, { source: 'HOME', severity: 'critical', title: 'R2PEEPOO fault', icon: 'ti-paw' })
    }
    cur['sensor.r2peepoo_status_code'] = lrCode
  }

  /** Handles a washer/dryer-style appliance: fires "started" when it leaves an
   *  idle state into a running one, and "done" when it reaches `end` while it
   *  had been running. */
  private appliance(
    id: string, state: string, first: boolean,
    msgs: { start: Msg; done: Msg }
  ): void {
    const prevState = this.prev[id]
    this.prev[id] = state
    if (first || prevState === undefined) return
    const wasRunning = !IDLE_STATES.has(prevState)
    const isRunning = !IDLE_STATES.has(state)
    if (!wasRunning && isRunning) {
      const [head, sub, icon] = msgs.start
      emit(head, { source: 'HOME', severity: 'info', title: head, sub, icon })
    } else if (wasRunning && state === 'end') {
      const [head, sub, icon] = msgs.done
      emit(head, { source: 'HOME', severity: 'notice', title: head, sub, icon })
    }
  }
}

export const homeWatcher = new HomeWatcher()
