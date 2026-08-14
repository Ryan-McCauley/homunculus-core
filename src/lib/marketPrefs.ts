// Persistence for the MARKET workspace: watchlists, open symbol tabs, chart
// layout, and the per-symbol indicator selection.
//
// These are view preferences, not trading state, so they live in localStorage
// rather than on the server — losing them costs a re-tick of some checkboxes, and
// keeping them client-side means no round-trip when switching lists or layouts.
// (Alerts are the deliberate exception: they must fire with the app closed, so
// they are server state. See server/cryptoAlerts.ts.)

const KEY = 'homunculus.crypto.market'

export type ChartLayout = 'single' | 'split' | 'quad' | 'compare' | 'matrix'

/** Ids of indicators the chart can draw. Overlays sit on the price pane; the
 *  rest each get their own stacked pane below it. */
export type IndicatorId =
  | 'ema' | 'sma' | 'bb' | 'keltner' | 'vwap' | 'psar' | 'supertrend' | 'pivots' | 'position'
  | 'volume' | 'rsi' | 'macd' | 'stoch' | 'atr' | 'adx' | 'obv' | 'mfi' | 'cci'

export interface IndicatorMeta {
  id: IndicatorId
  label: string
  hint: string
  /** Overlay = drawn on the price pane; pane = its own strip underneath. */
  kind: 'overlay' | 'pane'
}

export const INDICATORS: IndicatorMeta[] = [
  { id: 'ema', label: 'EMA 9 / 21', hint: 'fast trend pair', kind: 'overlay' },
  { id: 'sma', label: 'SMA 50 / 200', hint: 'golden / death cross', kind: 'overlay' },
  { id: 'bb', label: 'BOLLINGER 20·2σ', hint: 'volatility envelope', kind: 'overlay' },
  { id: 'keltner', label: 'KELTNER 20·1.5', hint: 'ATR envelope · squeeze vs BB', kind: 'overlay' },
  { id: 'vwap', label: 'VWAP', hint: 'volume-weighted fair value', kind: 'overlay' },
  { id: 'psar', label: 'PARABOLIC SAR', hint: 'trailing stop dots', kind: 'overlay' },
  { id: 'supertrend', label: 'SUPERTREND 10·3', hint: 'flip-line stop / entry', kind: 'overlay' },
  { id: 'pivots', label: 'PIVOT POINTS', hint: 'classic S/R from last bar', kind: 'overlay' },
  { id: 'position', label: 'COST BASIS + ORDERS', hint: 'your fills · resting lines', kind: 'overlay' },
  { id: 'volume', label: 'VOLUME', hint: 'with 20-bar average', kind: 'pane' },
  { id: 'rsi', label: 'RSI 14', hint: 'overbought / oversold', kind: 'pane' },
  { id: 'macd', label: 'MACD 12·26·9', hint: 'momentum crossover', kind: 'pane' },
  { id: 'stoch', label: 'STOCHASTIC %K/%D', hint: 'faster OB/OS than RSI', kind: 'pane' },
  { id: 'atr', label: 'ATR 14', hint: 'stop sizing · volatility', kind: 'pane' },
  { id: 'adx', label: 'ADX / DMI', hint: 'trending or chopping?', kind: 'pane' },
  { id: 'obv', label: 'OBV', hint: 'volume confirms price', kind: 'pane' },
  { id: 'mfi', label: 'MFI 14', hint: 'volume-weighted RSI', kind: 'pane' },
  { id: 'cci', label: 'CCI 20', hint: 'cycle extremes', kind: 'pane' },
]

export const INDICATOR_PRESETS: { id: string; label: string; ids: IndicatorId[] }[] = [
  { id: 'scalp', label: 'SCALP', ids: ['ema', 'vwap', 'position', 'volume', 'stoch', 'atr'] },
  { id: 'swing', label: 'SWING', ids: ['ema', 'sma', 'bb', 'position', 'volume', 'rsi', 'macd', 'adx'] },
  { id: 'meanrev', label: 'MEAN-REVERT', ids: ['bb', 'keltner', 'position', 'volume', 'rsi', 'mfi'] },
  { id: 'clear', label: 'CLEAR', ids: [] },
]

export const DEFAULT_INDICATORS: IndicatorId[] = ['ema', 'bb', 'position', 'volume', 'rsi']

export interface Watchlist {
  id: string
  name: string
  symbols: string[]
}

interface MarketPrefs {
  lists: Watchlist[]
  activeListId: string
  tabs: string[]
  layout: ChartLayout
  /** Indicator selection per symbol — BTC can run SWING while SOL runs SCALP. */
  indicators: Record<string, IndicatorId[]>
}

const DEFAULT_PREFS: MarketPrefs = {
  lists: [{ id: 'core', name: 'CORE', symbols: ['BTCUSD', 'ETHUSD', 'SOLUSD'] }],
  activeListId: 'core',
  tabs: ['BTCUSD'],
  layout: 'single',
  indicators: {},
}

export function loadPrefs(): MarketPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<MarketPrefs>
    return {
      lists: Array.isArray(parsed.lists) && parsed.lists.length ? parsed.lists : DEFAULT_PREFS.lists,
      activeListId: parsed.activeListId ?? DEFAULT_PREFS.activeListId,
      tabs: Array.isArray(parsed.tabs) && parsed.tabs.length ? parsed.tabs : DEFAULT_PREFS.tabs,
      layout: parsed.layout ?? DEFAULT_PREFS.layout,
      indicators: parsed.indicators ?? {},
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: MarketPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* quota / private mode — prefs are disposable */ }
}

export type { MarketPrefs }

/** Auto-list ids are reserved: they are computed from live data every render
 *  (MOVERS = biggest 24h movers, HOLDINGS = what you actually own) so they never
 *  need maintaining, and they can't be edited like a user list. */
export const AUTO_LISTS = [
  { id: 'auto:movers', name: 'MOVERS' },
  { id: 'auto:holdings', name: 'HOLDINGS' },
] as const

export function isAutoList(id: string): boolean { return id.startsWith('auto:') }

export function indicatorsFor(prefs: MarketPrefs, symbol: string): IndicatorId[] {
  return prefs.indicators[symbol] ?? DEFAULT_INDICATORS
}
