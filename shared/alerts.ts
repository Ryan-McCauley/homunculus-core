// Indicator-driven price alerts for the CRYPTO → MARKET tab.
//
// The catalog below is the single source of truth for what an alert can watch:
// the builder UI renders its dropdowns from it and the server evaluator switches
// on the same ids. Adding a condition in one place without the other is the bug
// this shape is meant to make impossible — the evaluator's switch is exhaustive
// over ALERT_SOURCES, so an unhandled condition fails typecheck rather than
// silently never firing.

export type AlertTimeframe = '1m' | '5m' | '15m' | '1hr' | '4hr' | '1day'

/** The same set as a value, so the catalog route and the UI can enumerate it. */
export const ALERT_TIMEFRAMES: AlertTimeframe[] = ['1m', '5m', '15m', '1hr', '4hr', '1day']

export type AlertSourceId =
  | 'price' | 'rsi' | 'ema-cross' | 'sma-cross' | 'macd' | 'bollinger'
  | 'stoch' | 'volume' | 'atr' | 'adx' | 'vwap' | 'supertrend' | 'signal'

/** What happens when an alert fires. Staging actions land in the confirm-first
 *  queue exactly like a manual stage — an alert can never send an order. */
export type AlertAction = 'notify' | 'stage-buy' | 'stage-sell'

export interface AlertCondition {
  id: string
  label: string
  /** Condition needs a numeric threshold (a cross of a level, not of a line). */
  needsValue: boolean
  /** Placeholder/default shown in the builder when the condition is picked. */
  defaultValue?: number
  /** Unit hint rendered next to the input. */
  unit?: string
}

export interface AlertSource {
  id: AlertSourceId
  label: string
  conditions: AlertCondition[]
}

export const ALERT_SOURCES: AlertSource[] = [
  {
    id: 'price', label: 'PRICE',
    conditions: [
      { id: 'above', label: 'CROSSES ABOVE', needsValue: true, unit: '$' },
      { id: 'below', label: 'CROSSES BELOW', needsValue: true, unit: '$' },
      { id: 'pct-move', label: 'MOVES MORE THAN', needsValue: true, defaultValue: 2, unit: '% / bar' },
    ],
  },
  {
    id: 'rsi', label: 'RSI 14',
    conditions: [
      { id: 'above', label: 'CROSSES ABOVE', needsValue: true, defaultValue: 70 },
      { id: 'below', label: 'CROSSES BELOW', needsValue: true, defaultValue: 30 },
      { id: 'exits-band', label: 'LEAVES THE 30–70 BAND', needsValue: false },
    ],
  },
  {
    id: 'ema-cross', label: 'EMA 9 × EMA 21',
    conditions: [
      { id: 'bull', label: 'BULLISH CROSS', needsValue: false },
      { id: 'bear', label: 'BEARISH CROSS', needsValue: false },
      { id: 'close-above', label: 'PRICE CLOSES ABOVE EMA 21', needsValue: false },
      { id: 'close-below', label: 'PRICE CLOSES BELOW EMA 21', needsValue: false },
    ],
  },
  {
    id: 'sma-cross', label: 'SMA 50 × SMA 200',
    conditions: [
      { id: 'golden', label: 'GOLDEN CROSS', needsValue: false },
      { id: 'death', label: 'DEATH CROSS', needsValue: false },
    ],
  },
  {
    id: 'macd', label: 'MACD 12·26·9',
    conditions: [
      { id: 'bull', label: 'BULLISH CROSS', needsValue: false },
      { id: 'bear', label: 'BEARISH CROSS', needsValue: false },
      { id: 'hist-flip', label: 'HISTOGRAM FLIPS SIGN', needsValue: false },
    ],
  },
  {
    id: 'bollinger', label: 'BOLLINGER 20·2σ',
    conditions: [
      { id: 'close-above-upper', label: 'CLOSE ABOVE UPPER BAND', needsValue: false },
      { id: 'close-below-lower', label: 'CLOSE BELOW LOWER BAND', needsValue: false },
      { id: 'squeeze', label: 'SQUEEZE — BANDS INSIDE KELTNER', needsValue: false },
    ],
  },
  {
    id: 'stoch', label: 'STOCHASTIC %K/%D',
    conditions: [
      { id: 'bull-oversold', label: 'BULLISH CROSS BELOW 20', needsValue: false },
      { id: 'bear-overbought', label: 'BEARISH CROSS ABOVE 80', needsValue: false },
    ],
  },
  {
    id: 'volume', label: 'VOLUME',
    conditions: [
      { id: 'spike', label: 'SPIKE OVER 20-BAR AVG ×', needsValue: true, defaultValue: 3, unit: '×' },
      { id: 'dries-up', label: 'DROPS BELOW 20-BAR AVG ×', needsValue: true, defaultValue: 0.3, unit: '×' },
    ],
  },
  {
    id: 'atr', label: 'ATR 14',
    conditions: [
      { id: 'above', label: 'RISES ABOVE', needsValue: true, unit: '$' },
      { id: 'below', label: 'FALLS BELOW', needsValue: true, unit: '$' },
    ],
  },
  {
    id: 'adx', label: 'ADX / DMI',
    conditions: [
      { id: 'trend-starts', label: 'TREND STARTS ( ADX > 25 )', needsValue: false },
      { id: 'trend-fades', label: 'TREND FADES ( ADX < 20 )', needsValue: false },
      { id: 'di-bull', label: '+DI CROSSES ABOVE −DI', needsValue: false },
      { id: 'di-bear', label: '−DI CROSSES ABOVE +DI', needsValue: false },
    ],
  },
  {
    id: 'vwap', label: 'VWAP',
    conditions: [
      { id: 'above', label: 'PRICE CROSSES ABOVE', needsValue: false },
      { id: 'below', label: 'PRICE CROSSES BELOW', needsValue: false },
    ],
  },
  {
    id: 'supertrend', label: 'SUPERTREND 10·3',
    conditions: [
      { id: 'flip-long', label: 'FLIPS LONG', needsValue: false },
      { id: 'flip-short', label: 'FLIPS SHORT', needsValue: false },
    ],
  },
  {
    id: 'signal', label: 'SIGNAL ENGINE',
    conditions: [
      { id: 'direction-flips', label: 'DIRECTION FLIPS', needsValue: false },
      { id: 'quality-good', label: 'QUALITY REACHES MEDIUM+', needsValue: false },
      { id: 'confluence', label: 'CONFLUENCE REACHES', needsValue: true, defaultValue: 2, unit: 'timeframes' },
    ],
  },
]

export function alertSource(id: AlertSourceId): AlertSource | undefined {
  return ALERT_SOURCES.find((s) => s.id === id)
}

export function alertCondition(sourceId: AlertSourceId, conditionId: string): AlertCondition | undefined {
  return alertSource(sourceId)?.conditions.find((c) => c.id === conditionId)
}

export interface CryptoAlert {
  id: string
  symbol: string
  source: AlertSourceId
  condition: string
  /** Threshold for conditions with needsValue; null otherwise. */
  value: number | null
  tf: AlertTimeframe
  action: AlertAction
  /** USD size staged when action is stage-buy/stage-sell. */
  stageUsd: number
  /** Disarm after the first fire instead of re-arming. */
  once: boolean
  /** false once a `once` alert has fired, or when the user pauses it. */
  armed: boolean
  createdAt: number
  lastFiredAt: number | null
  fireCount: number
  /** Human-readable record of the most recent fire, shown in the alert list. */
  lastNote: string | null
  /**
   * Agent to wake when this fires, if any. Independent of `action`: an alert can
   * notify, stage, and wake, or do nothing but wake. Waking grants no authority —
   * the woken agent's own autonomy dial still decides what it may do once awake.
   */
  wakeAgentId?: string | null
  /**
   * Who armed this alert: 'operator', 'agent:<id>' or 'skill:<name>'. Agents can
   * set their own alerts, so the list has to say whose idea each one was.
   */
  createdBy?: string
}

/**
 * The catalog as compact text, for an agent's system prompt.
 *
 * Generated from ALERT_SOURCES rather than written out, so it cannot drift from
 * what the evaluator actually implements. Without this an agent has to guess ids,
 * and every near-miss ("RSI", "crosses-below", "oversold") is rejected — the
 * capability exists but is unreachable, which is the same as not having it.
 */
export function alertCatalogText(): string {
  const lines = ALERT_SOURCES.map((s) => {
    const conds = s.conditions.map((c) => c.id + (c.needsValue ? '*' : '')).join(', ')
    return `  ${s.id.padEnd(11)} ${conds}`
  })
  return lines.join('\n') + '\n  (* needs a numeric "value"; timeframes: 1m 5m 15m 1hr 4hr 1day)'
}

/** Alerts one creator may hold at once, so a looping agent cannot fill the store. */
export const ALERT_MAX_PER_CREATOR = 40

/** One-line English rendering of an alert, used in the list, toasts and the
 *  staged trade's reason so a confirmed order says which alert produced it. */
export function describeAlert(a: CryptoAlert): string {
  const src = alertSource(a.source)
  const cond = alertCondition(a.source, a.condition)
  const value = a.value != null ? ` ${a.value}` : ''
  const base = `${src?.label ?? a.source} ${cond?.label ?? a.condition}${value}`
  return `${a.symbol} ${a.tf} · ${base}`
}
