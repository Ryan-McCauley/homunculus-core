// Indicator alert engine for the CRYPTO → MARKET tab.
//
// Alerts are evaluated HERE, in the server's refresh loop — not in the browser —
// so they keep firing with the app closed, which is the whole point of an alert.
// Every condition reads from shared/indicators.ts, the same math the chart draws
// with, so an alert can't disagree with the line the user set it against.
//
// Firing rule: conditions are evaluated against the last two bars of the chosen
// timeframe, and a fired alert is stamped with that bar's timestamp. The loop runs
// far more often than a bar closes, so without that stamp a single RSI cross would
// re-fire every 30 seconds until the bar rolled. One fire per bar, per alert.

import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import * as ind from '../shared/indicators'
import { auditLog, currentActor } from './auditLog'
import { stateStore } from './stateStore'
import type { Candle } from '../shared/indicators'
import {
  type CryptoAlert, type AlertTimeframe, type AlertAction, type AlertSourceId,
  ALERT_MAX_PER_CREATOR, alertCondition, describeAlert,
} from '../shared/alerts'

const DATA_DIR = join(process.cwd(), 'data', 'crypto')
const ALERTS_FILE = join(DATA_DIR, 'alerts.json')

/** Persisted alert = the shared shape plus the bar-dedup stamp, which is an
 *  engine detail the UI has no use for. */
type StoredAlert = CryptoAlert & { lastFiredBarTs: number | null }

function load(): StoredAlert[] {
  try {
    if (!existsSync(ALERTS_FILE)) return []
    const raw = stateStore.readJson<StoredAlert[]>(ALERTS_FILE, undefined as unknown as StoredAlert[])
    return Array.isArray(raw) ? raw : []
  } catch (e) {
    console.warn('[alerts] load failed:', (e as Error).message)
    return []
  }
}

function save(alerts: StoredAlert[]): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    stateStore.writeJson(ALERTS_FILE, alerts)
  } catch (e) {
    console.warn('[alerts] save failed:', (e as Error).message)
  }
}

/** Everything the evaluator needs from the crypto hub, passed in rather than
 *  imported so this module stays free of a cycle with server/crypto.ts. */
export interface AlertContext {
  candles(symbol: string, tf: AlertTimeframe): Candle[]
  lastPrice(symbol: string): number | null
  signal(symbol: string): { direction: string; entryQuality: string; confluence: number } | null
  /** Stage a proposed trade — confirm-first, exactly like a manual stage. */
  stage(input: { symbol: string; side: 'buy' | 'sell'; usd: number; reason: string; tag: string }): void
  notify(head: string, sub: string): void
}

export interface NewAlertInput {
  symbol: string
  source: AlertSourceId
  condition: string
  value: number | null
  tf: AlertTimeframe
  action: AlertAction
  stageUsd?: number
  once?: boolean
  /** Agent to wake when this fires. Optional and independent of `action`. */
  wakeAgentId?: string | null
}

/**
 * How the alert store reaches the agent fleet.
 *
 * Registered by server/agents.ts at startup rather than imported, because
 * agents.ts already sits downstream of this module through crypto.ts — importing
 * back the other way would close a cycle. The store only ever asks two questions:
 * may this creator arm an alert that trades, and please wake this agent.
 */
export interface FleetBinding {
  /** Wakes an agent. Returns why it could not, or null on success. */
  wake(agentId: string, reason: string): string | null
  /** Whether an agent exists and is allowed to arm a trade-staging alert. */
  mayStage(agentId: string): { ok: boolean; reason?: string }
  /** Whether an agent id is known at all. */
  exists(agentId: string): boolean
}

let fleet: FleetBinding | null = null

export function bindFleet(binding: FleetBinding): void {
  fleet = binding
}

/** Result of testing one alert against current data. */
interface Verdict { fired: boolean; note: string }

const NOT_FIRED: Verdict = { fired: false, note: '' }

/** Signal direction as a comparable token — the engine's own strings. */
function dirToken(d: string): string { return d === 'BUY' ? 'BUY' : d === 'SELL' ? 'SELL' : 'HOLD' }

class AlertStore {
  private alerts: StoredAlert[] = load()
  /** Previous signal-engine reading per symbol, for the flip/quality conditions —
   *  the signal snapshot has no history of its own to diff against. */
  private prevSignal = new Map<string, { direction: string; quality: string; confluence: number }>()
  /** Readings observed during the pass currently running, merged into prevSignal
   *  only once every alert has been tested against the same baseline. */
  private pendingSignal = new Map<string, { direction: string; quality: string; confluence: number }>()

  list(): CryptoAlert[] {
    // Strip the engine-internal dedup stamp before it reaches the client.
    return this.alerts.map(({ lastFiredBarTs: _drop, ...a }) => a)
  }

  listFor(symbol: string): CryptoAlert[] {
    return this.list().filter((a) => a.symbol === symbol.toUpperCase())
  }

  create(input: NewAlertInput): CryptoAlert | { error: string } {
    const cond = alertCondition(input.source, input.condition)
    if (!cond) return { error: `unknown condition ${input.source}/${input.condition}` }
    if (cond.needsValue && (input.value == null || !Number.isFinite(input.value))) {
      return { error: `${cond.label} needs a numeric threshold` }
    }

    const createdBy = currentActor()
    const stages = input.action === 'stage-buy' || input.action === 'stage-sell'

    // AUTHORITY. An alert that stages a trade is trading authority with a delay on
    // it. Without this check an ADVISORY agent — one explicitly denied the right to
    // trade — could arm a stage-buy alert and have the server place the order for it
    // an hour later. The autonomy dial has to mean the same thing whether the agent
    // acts now or arranges for something to act later.
    if (stages && createdBy.startsWith('agent:')) {
      const agentId = createdBy.slice(6)
      const verdict = fleet?.mayStage(agentId) ?? { ok: false, reason: 'agent fleet unavailable' }
      if (!verdict.ok) return { error: verdict.reason ?? 'this agent may not arm a trading alert' }
    }

    // A wake target must exist, or the alert is armed to do nothing.
    const wakeAgentId = typeof input.wakeAgentId === 'string' && input.wakeAgentId ? input.wakeAgentId : null
    if (wakeAgentId && fleet && !fleet.exists(wakeAgentId)) {
      return { error: `unknown agent "${wakeAgentId}"` }
    }

    const mine = this.alerts.filter((a) => (a.createdBy ?? 'operator') === createdBy).length
    if (mine >= ALERT_MAX_PER_CREATOR) {
      return { error: `${createdBy} already holds ${mine} alerts (max ${ALERT_MAX_PER_CREATOR}) — delete some first` }
    }
    const alert: StoredAlert = {
      id: `alert_${Date.now()}_${randomUUID().slice(0, 6)}`,
      symbol: input.symbol.toUpperCase(),
      source: input.source,
      condition: input.condition,
      value: cond.needsValue ? input.value : null,
      tf: input.tf,
      action: input.action,
      stageUsd: input.stageUsd && input.stageUsd > 0 ? input.stageUsd : 20,
      once: input.once ?? false,
      armed: true,
      createdAt: Date.now(),
      lastFiredAt: null,
      fireCount: 0,
      lastNote: null,
      lastFiredBarTs: null,
      wakeAgentId,
      createdBy,
    }
    this.alerts = [...this.alerts, alert]
    save(this.alerts)
    const { lastFiredBarTs: _drop, ...clean } = alert
    auditLog.note({
      action: 'alert.create',
      resource: `alert:${alert.id}`,
      summary: `alert created: ${describeAlert(alert)} → ${alert.action}`,
      after: clean,
    })
    return clean
  }

  remove(id: string): boolean {
    const next = this.alerts.filter((a) => a.id !== id)
    if (next.length === this.alerts.length) return false
    const before = this.alerts.find((a) => a.id === id)
    this.alerts = next
    save(this.alerts)
    auditLog.note({
      action: 'alert.remove',
      resource: `alert:${id}`,
      summary: `alert removed: ${before ? describeAlert(before) : id}`,
      ...(before ? { before } : {}),
    })
    return true
  }

  setArmed(id: string, armed: boolean): boolean {
    const a = this.alerts.find((x) => x.id === id)
    if (!a) return false
    a.armed = armed
    // Re-arming clears the bar stamp so a still-true condition fires again rather
    // than staying silent because the same bar already fired once.
    if (armed) a.lastFiredBarTs = null
    save(this.alerts)
    auditLog.note({
      action: 'alert.arm',
      resource: `alert:${id}`,
      summary: `alert ${armed ? 'armed' : 'disarmed'}: ${describeAlert(a)}`,
      after: { armed },
    })
    return true
  }

  /** Evaluate every armed alert. Called from the hub's 30s refresh loop. */
  evaluate(ctx: AlertContext): void {
    if (!this.alerts.length) return
    let dirty = false

    // Signal readings are diffed against the PREVIOUS pass, so the baseline has to
    // stay fixed for the whole of this one. testSignal used to write straight into
    // prevSignal as it went, which meant the first alert on a symbol consumed the
    // transition and every later alert on that same symbol compared cur against cur
    // — two alerts on BTCUSD and only the first could ever fire, even when they
    // watched different fields. Updates are staged here and merged after the loop.
    this.pendingSignal = new Map()

    for (const alert of this.alerts) {
      if (!alert.armed) continue
      let verdict: Verdict
      try {
        verdict = this.test(alert, ctx)
      } catch (e) {
        console.warn(`[alerts] ${alert.id} eval failed:`, (e as Error).message)
        continue
      }
      if (!verdict.fired) continue

      // One fire per bar: the loop revisits the same in-progress bar many times.
      const bars = ctx.candles(alert.symbol, alert.tf)
      const barTs = bars.length ? bars[bars.length - 1]![0] : Date.now()
      if (alert.lastFiredBarTs === barTs) continue

      alert.lastFiredBarTs = barTs
      alert.lastFiredAt = Date.now()
      alert.fireCount += 1
      alert.lastNote = verdict.note
      if (alert.once) alert.armed = false
      dirty = true

      this.fire(alert, verdict, ctx)
    }

    // Now that every alert has been tested against the same baseline, this pass's
    // readings become the next pass's baseline.
    for (const [sym, reading] of this.pendingSignal) this.prevSignal.set(sym, reading)
    this.pendingSignal = new Map()

    if (dirty) save(this.alerts)
  }

  /** Deliver a fired alert: always a toast, plus a staged proposal when asked. */
  private fire(alert: StoredAlert, verdict: Verdict, ctx: AlertContext): void {
    const label = describeAlert(alert)
    ctx.notify(`ALERT · ${alert.symbol}`, `${label} — ${verdict.note}`)

    // The wake runs before any staging, and independently of the action: an alert
    // whose whole job is "get someone to look at this" has action 'notify'.
    if (alert.wakeAgentId) {
      const why = `${alert.symbol}: ${label} — ${verdict.note}`
      const refused = fleet
        ? fleet.wake(alert.wakeAgentId, why)
        : 'agent fleet unavailable'
      auditLog.record({
        actor: 'system',
        origin: 'internal',
        action: refused ? 'alert.wake.refused' : 'alert.wake',
        resource: `agent:${alert.wakeAgentId}`,
        summary: refused
          ? `alert could not wake ${alert.wakeAgentId}: ${refused} (${why})`
          : `alert woke ${alert.wakeAgentId} — ${why}`,
        meta: { alertId: alert.id, agentId: alert.wakeAgentId, symbol: alert.symbol, note: verdict.note },
      })
      if (refused) console.warn(`[alerts] ${alert.id} could not wake ${alert.wakeAgentId}: ${refused}`)
    }

    if (alert.action === 'notify') return
    const side = alert.action === 'stage-buy' ? 'buy' : 'sell'
    // An alert staging a trade is one of the three paths that reach the confirm
    // queue with no human in the loop, so it is recorded as its own entry rather
    // than being left to whatever route-layer trace the refresh loop leaves.
    auditLog.record({
      actor: 'system',
      origin: 'internal',
      action: 'alert.fired.autostage',
      resource: `alert:${alert.id}`,
      summary: `alert fired and staged ${side} $${alert.stageUsd} ${alert.symbol}: ${verdict.note}`,
      meta: { alertId: alert.id, symbol: alert.symbol, side, usd: alert.stageUsd, note: verdict.note },
    })
    ctx.stage({
      symbol: alert.symbol,
      side,
      usd: alert.stageUsd,
      reason: `Alert: ${label} (${verdict.note})`,
      // Tagged per-alert so a repeat fire supersedes its own stale proposal
      // instead of piling duplicates into the confirm queue.
      tag: `alert:${alert.id}`,
    })
  }

  /** Test one alert. Returns whether it fired plus the reading that fired it. */
  private test(alert: StoredAlert, ctx: AlertContext): Verdict {
    // The signal engine is snapshot-based, not candle-based — handled separately.
    if (alert.source === 'signal') return this.testSignal(alert, ctx)

    const candles = ctx.candles(alert.symbol, alert.tf)
    if (candles.length < 30) return NOT_FIRED   // not enough history to trust any reading
    const closes = ind.closesOf(candles)
    const v = alert.value ?? 0
    const px = (n: number) => n.toFixed(n < 10 ? 4 : 2)

    switch (alert.source) {
      case 'price': {
        const pair = ind.lastPair(closes.map((c) => c as number | null))
        if (!pair) return NOT_FIRED
        if (alert.condition === 'above') {
          return pair[0] <= v && pair[1] > v
            ? { fired: true, note: `price ${px(pair[1])} crossed above ${px(v)}` } : NOT_FIRED
        }
        if (alert.condition === 'below') {
          return pair[0] >= v && pair[1] < v
            ? { fired: true, note: `price ${px(pair[1])} crossed below ${px(v)}` } : NOT_FIRED
        }
        // pct-move: current bar's open→close swing
        const bar = candles[candles.length - 1]!
        const pct = bar[1] === 0 ? 0 : ((bar[4] - bar[1]) / bar[1]) * 100
        return Math.abs(pct) >= v
          ? { fired: true, note: `bar moved ${pct.toFixed(2)}% (limit ${v}%)` } : NOT_FIRED
      }

      case 'rsi': {
        const series = ind.rsi(closes, 14)
        const pair = ind.lastPair(series)
        if (!pair) return NOT_FIRED
        if (alert.condition === 'above') {
          return pair[0] <= v && pair[1] > v
            ? { fired: true, note: `RSI ${pair[1].toFixed(1)} crossed above ${v}` } : NOT_FIRED
        }
        if (alert.condition === 'below') {
          return pair[0] >= v && pair[1] < v
            ? { fired: true, note: `RSI ${pair[1].toFixed(1)} crossed below ${v}` } : NOT_FIRED
        }
        // exits-band: was inside 30–70, now outside
        const inside = (x: number) => x >= 30 && x <= 70
        return inside(pair[0]) && !inside(pair[1])
          ? { fired: true, note: `RSI left the band at ${pair[1].toFixed(1)}` } : NOT_FIRED
      }

      case 'ema-cross': {
        const fast = ind.ema(closes, 9)
        const slow = ind.ema(closes, 21)
        const fp = ind.lastPair(fast), sp = ind.lastPair(slow)
        if (!fp || !sp) return NOT_FIRED
        if (alert.condition === 'bull') {
          return ind.crossedAbove(fp, sp)
            ? { fired: true, note: `EMA 9 crossed above EMA 21 at ${px(fp[1])}` } : NOT_FIRED
        }
        if (alert.condition === 'bear') {
          return ind.crossedBelow(fp, sp)
            ? { fired: true, note: `EMA 9 crossed below EMA 21 at ${px(fp[1])}` } : NOT_FIRED
        }
        const cp = ind.lastPair(closes.map((c) => c as number | null))
        if (!cp) return NOT_FIRED
        if (alert.condition === 'close-above') {
          return ind.crossedAbove(cp, sp)
            ? { fired: true, note: `close ${px(cp[1])} crossed above EMA 21 ${px(sp[1])}` } : NOT_FIRED
        }
        return ind.crossedBelow(cp, sp)
          ? { fired: true, note: `close ${px(cp[1])} crossed below EMA 21 ${px(sp[1])}` } : NOT_FIRED
      }

      case 'sma-cross': {
        const fast = ind.sma(closes, 50)
        const slow = ind.sma(closes, 200)
        const fp = ind.lastPair(fast), sp = ind.lastPair(slow)
        if (!fp || !sp) return NOT_FIRED
        return alert.condition === 'golden'
          ? (ind.crossedAbove(fp, sp) ? { fired: true, note: `SMA 50 crossed above SMA 200 at ${px(fp[1])}` } : NOT_FIRED)
          : (ind.crossedBelow(fp, sp) ? { fired: true, note: `SMA 50 crossed below SMA 200 at ${px(fp[1])}` } : NOT_FIRED)
      }

      case 'macd': {
        const m = ind.macd(closes)
        if (alert.condition === 'hist-flip') {
          const hp = ind.lastPair(m.histogram)
          if (!hp) return NOT_FIRED
          const flipped = (hp[0] < 0 && hp[1] >= 0) || (hp[0] > 0 && hp[1] <= 0)
          return flipped
            ? { fired: true, note: `histogram flipped to ${hp[1] >= 0 ? 'positive' : 'negative'}` } : NOT_FIRED
        }
        const lp = ind.lastPair(m.macd), sp = ind.lastPair(m.signal)
        if (!lp || !sp) return NOT_FIRED
        return alert.condition === 'bull'
          ? (ind.crossedAbove(lp, sp) ? { fired: true, note: 'MACD crossed above its signal' } : NOT_FIRED)
          : (ind.crossedBelow(lp, sp) ? { fired: true, note: 'MACD crossed below its signal' } : NOT_FIRED)
      }

      case 'bollinger': {
        if (alert.condition === 'squeeze') {
          const sq = ind.lastPair(ind.squeezeOn(candles))
          if (!sq) return NOT_FIRED
          return sq[0] === 0 && sq[1] === 1
            ? { fired: true, note: 'Bollinger bands squeezed inside Keltner' } : NOT_FIRED
        }
        const bb = ind.bollinger(closes, 20, 2)
        const cp = ind.lastPair(closes.map((c) => c as number | null))
        const up = ind.lastPair(bb.upper), lo = ind.lastPair(bb.lower)
        if (!cp || !up || !lo) return NOT_FIRED
        return alert.condition === 'close-above-upper'
          ? (ind.crossedAbove(cp, up) ? { fired: true, note: `close ${px(cp[1])} broke the upper band` } : NOT_FIRED)
          : (ind.crossedBelow(cp, lo) ? { fired: true, note: `close ${px(cp[1])} broke the lower band` } : NOT_FIRED)
      }

      case 'stoch': {
        const s = ind.stochastic(candles)
        const kp = ind.lastPair(s.k), dp = ind.lastPair(s.d)
        if (!kp || !dp) return NOT_FIRED
        if (alert.condition === 'bull-oversold') {
          return ind.crossedAbove(kp, dp) && kp[1] < 20
            ? { fired: true, note: `%K crossed %D at ${kp[1].toFixed(1)} (oversold)` } : NOT_FIRED
        }
        return ind.crossedBelow(kp, dp) && kp[1] > 80
          ? { fired: true, note: `%K crossed below %D at ${kp[1].toFixed(1)} (overbought)` } : NOT_FIRED
      }

      case 'volume': {
        const ratio = ind.last(ind.volumeRatio(candles, 20))
        if (ratio == null) return NOT_FIRED
        return alert.condition === 'spike'
          ? (ratio >= v ? { fired: true, note: `volume ${ratio.toFixed(1)}× its 20-bar average` } : NOT_FIRED)
          : (ratio <= v ? { fired: true, note: `volume fell to ${ratio.toFixed(2)}× its average` } : NOT_FIRED)
      }

      case 'atr': {
        const pair = ind.lastPair(ind.atr(candles, 14))
        if (!pair) return NOT_FIRED
        return alert.condition === 'above'
          ? (pair[0] <= v && pair[1] > v ? { fired: true, note: `ATR rose to ${px(pair[1])}` } : NOT_FIRED)
          : (pair[0] >= v && pair[1] < v ? { fired: true, note: `ATR fell to ${px(pair[1])}` } : NOT_FIRED)
      }

      case 'adx': {
        const a = ind.adx(candles, 14)
        if (alert.condition === 'trend-starts' || alert.condition === 'trend-fades') {
          const pair = ind.lastPair(a.adx)
          if (!pair) return NOT_FIRED
          return alert.condition === 'trend-starts'
            ? (pair[0] <= 25 && pair[1] > 25 ? { fired: true, note: `ADX ${pair[1].toFixed(1)} — trend starting` } : NOT_FIRED)
            : (pair[0] >= 20 && pair[1] < 20 ? { fired: true, note: `ADX ${pair[1].toFixed(1)} — trend fading` } : NOT_FIRED)
        }
        const pp = ind.lastPair(a.plusDi), mp = ind.lastPair(a.minusDi)
        if (!pp || !mp) return NOT_FIRED
        return alert.condition === 'di-bull'
          ? (ind.crossedAbove(pp, mp) ? { fired: true, note: '+DI crossed above −DI' } : NOT_FIRED)
          : (ind.crossedAbove(mp, pp) ? { fired: true, note: '−DI crossed above +DI' } : NOT_FIRED)
      }

      case 'vwap': {
        const vw = ind.lastPair(ind.vwap(candles))
        const cp = ind.lastPair(closes.map((c) => c as number | null))
        if (!vw || !cp) return NOT_FIRED
        return alert.condition === 'above'
          ? (ind.crossedAbove(cp, vw) ? { fired: true, note: `price crossed above VWAP ${px(vw[1])}` } : NOT_FIRED)
          : (ind.crossedBelow(cp, vw) ? { fired: true, note: `price crossed below VWAP ${px(vw[1])}` } : NOT_FIRED)
      }

      case 'supertrend': {
        const st = ind.supertrend(candles, 10, 3)
        const dp = ind.lastPair(st.dir)
        if (!dp) return NOT_FIRED
        return alert.condition === 'flip-long'
          ? (dp[0] === -1 && dp[1] === 1 ? { fired: true, note: 'Supertrend flipped long' } : NOT_FIRED)
          : (dp[0] === 1 && dp[1] === -1 ? { fired: true, note: 'Supertrend flipped short' } : NOT_FIRED)
      }
    }
    return NOT_FIRED
  }

  /** Signal-engine conditions diff against the previous loop's reading, since the
   *  signal snapshot carries no history. */
  private testSignal(alert: StoredAlert, ctx: AlertContext): Verdict {
    const sig = ctx.signal(alert.symbol)
    if (!sig) return NOT_FIRED
    const key = alert.symbol
    const prev = this.prevSignal.get(key)
    const cur = { direction: dirToken(sig.direction), quality: sig.entryQuality, confluence: sig.confluence }
    // Staged, not applied: prevSignal must stay put until every alert in this pass
    // has been compared against it. See evaluate().
    this.pendingSignal.set(key, cur)
    if (!prev) return NOT_FIRED   // first observation has nothing to compare against

    if (alert.condition === 'direction-flips') {
      return prev.direction !== cur.direction
        ? { fired: true, note: `signal ${prev.direction} → ${cur.direction}` } : NOT_FIRED
    }
    if (alert.condition === 'quality-good') {
      const good = (q: string) => q === 'HIGH' || q === 'MEDIUM'
      return !good(prev.quality) && good(cur.quality)
        ? { fired: true, note: `entry quality reached ${cur.quality}` } : NOT_FIRED
    }
    const target = alert.value ?? 2
    return prev.confluence < target && cur.confluence >= target
      ? { fired: true, note: `confluence reached ${cur.confluence}` } : NOT_FIRED
  }
}

export const alertStore = new AlertStore()
