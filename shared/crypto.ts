// Shared types for the CRYPTO tab.
//
// SECURITY: API keys (GEMINI_API_KEY / GEMINI_API_SECRET) live in .env only.
// No keys are ever sent to the client. Trade execution happens server-side only.
// All /api/crypto/* routes are token-gated for non-localhost callers.

import type { TrailArm } from './trailArm'

/** Trade data (Gemini fills + the app's own audit log) is only surfaced from this
 *  instant onward — older history is dropped so the CRYPTO tab shows the current
 *  year's activity only. Bump the year here to roll the window forward. */
export const TRADE_HISTORY_SINCE_MS = Date.UTC(2026, 0, 1)

/** Live price ticker for one symbol. */
export interface Ticker {
  symbol: string        // e.g. "BTCUSD"
  bid: string
  ask: string
  last: string          // last trade price
  volume: string        // 24h volume in base currency
  open: string          // 24h opening price
  high: string
  low: string
  change: number        // (last - open) / open * 100, computed server-side
  updatedAt: number     // epoch-ms
}

/** CoinMarketCap cross-exchange market data for one base symbol (e.g. "BTC"). Sourced
 *  from server/cmc.ts. Aggregated across all exchanges, so it reflects true market-wide
 *  liquidity/interest even when Gemini's own book for the coin is thin. Only present when
 *  CMC_API_KEY is configured and the symbol is listed on CMC. */
export interface CmcMarketData {
  base: string           // base ticker, e.g. "BTC"
  volume24h: number      // cross-exchange 24h USD volume
  volumeChange24h: number // percent vs prior 24h, e.g. 12.4 = +12.4%
  marketCap: number | null
}

/** One line in the user's Gemini portfolio. */
export interface Holding {
  currency: string      // e.g. "BTC", "ETH"
  amount: string        // total balance (including amounts locked in open orders)
  available?: string    // free-to-trade balance (excludes locked)
  amountNotional: string // USD value (if available)
  // FEES ARE IGNORED IN ALL P&L (operator rule): every figure below is built from the
  // raw traded totals — price × amount in vs. price × amount out — because Gemini's
  // fee is already accounted for in what the account settles at, so subtracting it
  // again skews the number.
  costBasis?: number    // weighted average cost per unit in USD (traded notional only)
  unrealizedPnl?: number // (currentPrice - costBasis) * amount
  unrealizedPnlPct?: number // unrealizedPnl / (costBasis * amount) * 100
  grossUnrealizedPnl?: number // same as unrealizedPnl — kept for wire compatibility
  grossUnrealizedPnlPct?: number // same as unrealizedPnlPct
  feeToClose?: number   // always 0 — retained so older clients keep parsing
}

/** Effective fee rates measured from the account's OWN recent fills (fee_amount ÷
 *  notional, notional-weighted so tiny-order minimums don't skew it), split by
 *  maker vs taker. Falls back to Gemini's ActiveTrader entry tier before any fills. */
export interface FeeRates {
  maker: number         // fraction, e.g. 0.0019 = 0.19%
  taker: number         // fraction, e.g. 0.006 = 0.60%
  blended: number       // notional-weighted across all fills
  samples: number       // number of USD-fee fills the rates were measured from
}

/** Per-timeframe indicator readings. */
export interface TimeframeSignal {
  tf: '1m' | '5m' | '15m' | '1hr' | '4hr' | '1day'
  direction: SignalDirection
  strength: number       // 0–100
  rsi14: number | null
  macd: MACDReading | null
  bb: BollingerReading | null
  ma50: number | null
  ma200: number | null
  adx: { adx: number; plusDI: number; minusDI: number } | null
  volRatio: number | null   // latest closed bar volume ÷ trailing 20-bar avg
  volTrend: 'rising' | 'falling' | 'flat' | null // volume SMA(3) vs SMA(8) — participation building or fading
  candleCount: number    // how many candles loaded
  reasons: string[]
}

export interface MACDReading {
  macd: number
  signal: number
  histogram: number
}

export interface BollingerReading {
  upper: number
  middle: number
  lower: number
  bandwidth: number      // (upper - lower) / middle — squeeze indicator
  percentB: number       // where price sits within bands (0=lower, 1=upper)
}

/** A rule-based signal for one symbol. */
export type SignalDirection = 'BUY' | 'SELL' | 'HOLD'
export type EntryQuality = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA'

export interface Signal {
  symbol: string
  direction: SignalDirection
  strength: number           // 0–100 weighted composite
  entryQuality: EntryQuality
  confluence: number         // 0–3 how many timeframes agree
  timeframes: TimeframeSignal[]
  reasons: string[]
  computedAt: number
  seeded: boolean            // true once candle history is loaded
}

export type GeminiOrderType = 'exchange limit' | 'exchange stop limit' | 'exchange market'
export type GeminiOrderOption = 'maker-or-cancel' | 'immediate-or-cancel' | 'fill-or-kill'

/** A pending trade awaiting user confirmation. */
export interface PendingTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop-limit'
  amount: string             // base currency amount
  price?: string             // limit price (limit and stop-limit orders)
  stopPrice?: string         // stop trigger price (stop-limit orders only)
  orderOptions?: GeminiOrderOption[]  // execution options (max one)
  createdAt: number
  reason: string
  /** Owning strategy — see AutoStep.strategy. Distinct from `tag` below, which is a
   *  leg-intent id ('jto-stop'), not strategy identity. */
  strategy?: string
  tag?: string               // optional intent id (e.g. "jto-stop", "jto-tp1"). Staging
                             // a trade supersedes only an existing pending with the SAME
                             // (symbol, tag) — so distinct legs (stop + TP1 + TP2) coexist,
                             // while a re-proposed setup replaces its stale predecessor.
                             // Absent → legacy dedup by (symbol, side).
}

/** A completed (executed or dismissed) trade in the audit log. */
export interface TradeRecord extends PendingTrade {
  status: 'executed' | 'dismissed' | 'failed'
  settledAt: number
  orderId?: string
  error?: string
}

/** Seeding progress reported to the UI. */
export interface SeedProgress {
  total: number
  seeded: number
  active: boolean
}

/** A self-managed bracket trade: confirm-first entry, then the engine autonomously
 *  runs the full lifecycle — protective stop + take-profit(s), OCO, trailing stop,
 *  break-even, and a position time-stop that auto-exits the remainder to USD. */
export interface BracketSpec {
  symbol: string                 // e.g. "JTOUSD"
  /** Owning strategy — copied onto the generated AutoStep. See AutoStep.strategy. */
  strategy?: string
  side: 'buy'                    // long bounce only for now
  entry: {
    limitPrice: string           // marketable limit at/just-above ask — leg 1 (primary) price
    amountSpec: string           // "USD:40" | "ALL_USD" | base amount — leg 1 (primary) size
    timeStopMin: number          // cancel + abandon if unfilled this long (FAST 90, SWING 240)
    /** Optional staged entry legs (2nd/3rd purchases), each resting at its own lower limit
     *  price with its own size — used to build the same position via 2-3 orders instead of
     *  one (e.g. leg 1 = half size at the normal entry price, legs[0] = remainder ≥1% lower).
     *  Same timeStopMin governs all legs. Position is considered "entered" once leg 1 fills
     *  and every leg has either filled or timed out — see runBracket/awaitEntryFill. */
    legs?: { limitPrice: string; amountSpec: string }[]
  }
  stopPct: number                // initial stop distance below entry, e.g. 0.015 / 0.04
  tp1: { pricePct: number; sizeFraction: number }  // e.g. +0.012, sell 0.6 of the fill
  tp2?: { pricePct: number }     // remainder sells here; omit to sell all at tp1
  trailPct?: number              // ratchet the stop up to (high − trailPct); never down
  /** Arms `trailPct` automatically once the high water mark reaches entry × (1 + atPct).
   *  Replaces the Trap Steward's manual /bracket/adjust call — a fixed threshold that was
   *  being evaluated by a Claude session on a 30-minute interval, and therefore missed
   *  every time that session timed out. Arming only ever tightens risk (the stop moves
   *  from −stopPct to just under the high water mark, which is above entry by then), so
   *  the engine does it without confirmation. Ignored once trailPct is set. */
  trailArm?: TrailArm
  breakEvenAfterTp1?: boolean    // move stop to entry once tp1 fills
  positionTimeStopMin: number    // FAST 90, SWING 1440 — auto-exit remainder to USD after this
  /** Stages the FULL/FINAL exit (final-target hit, position time-stop, or a tpFirst TP) as
   *  2-3 resting sell orders instead of one — a leg ladder mirroring the staged-entry legs.
   *  Each leg rests `sizeFraction` of the exit amount at `basePrice × (1 + pricePct)` (pricePct
   *  ≥ 0, offsets ABOVE the base sell price used for that exit — the final-target/ask/tpFirst
   *  price); the remaining fraction (1 − Σ sizeFraction) sells at the base price via the
   *  existing primary tp1Id order. Does NOT apply to the TP1 partial scale-out ahead of tp2 —
   *  that's already its own two-tranche mechanism. */
  exitLegs?: { pricePct: number; sizeFraction: number }[]
  tpFirst?: boolean              // "buy then immediately sell": the instant the entry fills,
                                 // rest the TP1 limit sell at target right away (a true bracket
                                 // order) instead of triggering it when price arrives. The −stopPct
                                 // stop + positionTimeStop become MONITORED triggers (cancel the
                                 // resting TP, then exit) since Gemini can't lock a full-size stop
                                 // AND a full-size sell at once. Full-exit only (ignored if tp2 set
                                 // or tp1.sizeFraction < 1). Used by fast-cash scalps.
}

export type BracketPhase =
  | 'entering'    // entry order resting, awaiting fill
  | 'protected'   // filled; stop + take-profit(s) live
  | 'tp1_filled'  // partial taken; runner protected (often at break-even)
  | 'exiting'     // time-stop / kill — flattening to USD
  | 'flat'        // closed; realized P&L recorded
  | 'aborted'     // entry never filled (time-stop) — no position opened

/** Live runtime state for a managed bracket (persisted to disk for restart-resume). */
export interface BracketState {
  phase: BracketPhase
  entryId: string | null
  // Deterministic client_order_id for the entry, assigned + persisted BEFORE the order is
  // sent to Gemini. Makes entry placement idempotent across restarts/re-runs: on re-entry we
  // reconcile against live orders by this id (and Gemini itself rejects a duplicate id), so a
  // crash between placeOrder and persist can't spawn duplicate resting entries. See runBracket.
  entryClientId?: string | null
  /** Runtime tracking for staged additional entry legs (spec.entry.legs) — leg 1 (the
   *  primary) stays on entryId/entryClientId/entryPrice/filledAmount above for backward
   *  compatibility with existing single-entry brackets; this array covers legs 2/3 only. */
  entryLegs?: {
    clientId: string
    orderId: string | null
    limitPrice: string
    amountSpec: string
    filled: boolean
    cancelled: boolean
    filledAmount: number | null
    filledPrice: number | null
    /** Independent take-profit sell for THIS leg's filled amount, placed the moment the leg
     *  fills and resting at the shared midband target. Each leg sells its own quantity — one
     *  filling never touches another's. Set to null once its fill has been credited. */
    tpId?: string | null
    tpDone?: boolean
  }[]
  /** Runtime tracking for staged additional exit legs (spec.exitLegs) — placed alongside the
   *  primary full/final exit order (still tracked as tp1Id) when that exit fires. Cleared
   *  once every leg has resolved and the bracket finalizes. */
  exitLegs?: {
    orderId: string | null
    price: number
    sizeFraction: number
    filled: boolean
    cancelled: boolean
    filledAmount: number | null
    filledPrice: number | null
  }[]
  /** Deadline (epoch ms) by which unresolved exitLegs are cancelled and the bracket
   *  finalizes regardless — set when the legs are placed. */
  exitLegsDeadline?: number | null
  stopId: string | null
  tp1Id: string | null
  tp2Id: string | null
  /** Absolute take-profit price (the midband / T1 target), fixed off the PRIMARY entry fill.
   *  For staged entries the resting TP is placed immediately on the primary fill and grown to
   *  cover each additional leg as it fills — all legs exit at this same target. */
  tpTargetPrice?: number | null
  entryPrice: number | null      // average fill price
  filledAmount: number | null    // base units originally bought
  positionAmount: number | null  // base units still held
  stopPrice: number | null       // live stop trigger (ratchets up via trailing)
  highWater: number | null       // highest price seen since fill (trailing reference)
  filledAt: number | null        // epoch-ms of entry fill (position time-stop clock)
  realizedUsd: number            // realized P&L so far, USD — fees NOT deducted (see feeUsd)
  feeUsd?: number                // total real USD fees paid (entry + exits) — reference only
  note: string                   // short human-readable status
  /** User-set lock: while true, monitorBracket's auto-management (TP1 scale-out, final-target
   *  exit, trailing-stop ratchet, position time-stop exit) is frozen — the trade holds exactly
   *  as-is. Fill detection and the initial protective-stop self-heal still run, so a locked
   *  position stays protected; only discretionary "moves" are suppressed. Toggled via
   *  AutoPlanner.lockBracket, independent of plan.active so it works on a live position. */
  locked?: boolean
}

/** A discretionary adjustment to a LIVE bracket's stop / take-profit levels, proposed by
 *  the strategy skill as the market moves. Confirm-first by default — staged as
 *  `pendingAdjust` on the bracket step until the user confirms; `auto` mode applies it
 *  immediately. Targets are given as absolute prices for clarity in the proposal and are
 *  converted to `pricePct` against the fill when applied. Only the fields being changed
 *  are set; the rest are left untouched. */
export interface BracketAdjust {
  stopPrice?: number     // new stop TRIGGER price (absolute)
  tp1Price?: number      // new TP1 target (absolute)
  tp2Price?: number      // new final target (absolute)
  trailPct?: number      // new trailing-stop distance (fraction, e.g. 0.04)
  /** true when the new stop sits FURTHER from current price than the old one — i.e. the
   *  move widens risk (more $ exposed). Always surfaced/flagged; never silently applied. */
  widensRisk: boolean
  note?: string          // human rationale, echoed into the proposal + engine log
  proposedAt: number
}

/** One step in the automated BTC accumulation plan. */
export interface AutoStep {
  id: string
  /** Which strategy opened this step, e.g. 'firecracker' | 'btc-ladder'. Drives per-strategy
   *  exposure accounting (see AutoPlanner.exposureByStrategy) so a strategy's caps count only
   *  what IT opened, rather than the raw holding — otherwise one strategy's stack silently
   *  consumes another's per-coin cap. Absent on pre-2026-07 plans and on manual trades; those
   *  are 'unattributed' and count against nobody's cap. */
  strategy?: string
  label: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop-limit'
  /** When 'bracket', this step is a self-managed bracket trade (see `bracket`); the
   *  engine runs the full enter→protect→manage→exit lifecycle instead of the
   *  sequential single-order path. */
  kind?: 'bracket'
  bracket?: BracketSpec
  bracketState?: BracketState
  /** A discretionary stop/TP adjustment staged (confirm-first) against this live bracket.
   *  Applied and cleared by confirmAdjust; null/absent when there's nothing pending. */
  pendingAdjust?: BracketAdjust | null
  /** Fixed amount string, or "USD:20" to spend $20, or "ALL_USD" to use full balance */
  amountSpec: string
  limitPrice?: string
  stopPrice?: string      // stop-limit orders: trigger price
  orderOptions?: GeminiOrderOption[]  // execution option (max one)
  /** Per-step time-stop in minutes. If an unfilled limit order is still resting
   *  after this long, it is cancelled (overrides the default 8h limit timeout).
   *  A timed-out BUY entry also halts the remaining bracket steps, since there is
   *  no position to protect/exit. Bounce entries should set this to 90. */
  timeStopMin?: number
  reason: string
  /** Per-trade approval, set by the user in the app while the plan is proposed.
   *  Defaults to true on propose; a trade toggled to `false` is DENIED and will be
   *  skipped (never sent to the exchange) when the plan is confirmed. */
  approved?: boolean
  status: 'pending' | 'executing' | 'monitoring' | 'filled' | 'failed' | 'skipped'
  geminiOrderId?: string
  executedAt?: number
  filledAt?: number
  filledAmount?: string
  error?: string
}

/** One CLOSED bracket round-trip, appended to closed-trades.json the moment a bracket
 *  finalizes (target hit, stopped out, timed out, or reaped). This is the durable realized
 *  P&L record the live bracket state used to throw away on close — the source of truth for
 *  per-strategy win rate. Fee-free realizedUsd mirrors the account convention (fees tracked
 *  for reference only, never netted into P&L). */
export interface ClosedTrade {
  id: string                 // originating bracket id (bracket_<ms>)
  /** 'real' = an actual banked bracket round-trip (realizedUsd from live fills).
   *  'paper' = a backfilled tuning outcome resolved on paper +T1/−stop geometry
   *  (from the strategy plan ledger / performance.json). The two are NEVER blended in a
   *  win-rate number without being labelled — a paper 78% is a backtest, not banked P&L. */
  source: 'real' | 'paper'
  strategy: string           // 'sniper' | 'firecracker' | ... | 'unattributed'
  symbol: string             // e.g. 'POLUSD'
  label: string              // the bracket's human label (pattern / rationale)
  side: 'buy' | 'sell'       // entry side (always 'buy' for the long-only brackets today)
  entryPrice: number | null  // average entry fill price
  exitReason: string         // why it closed: 'target hit', 'stopped out', 'timed out', ...
  amount: number             // base units originally filled
  realizedUsd: number        // realized P&L, USD, fees NOT deducted
  feeUsd: number             // total real fees paid (entry+exit), reference only
  returnPct: number | null   // realizedUsd / cost basis * 100 (null if basis unknown)
  outcome: 'win' | 'loss' | 'flat'
  entryAt: number | null     // epoch-ms of entry fill
  closedAt: number           // epoch-ms the bracket finalized
}

/** Aggregate win-rate summary over the closed-trade ledger, overall and per strategy. */
export interface ClosedTradeStats {
  overall: ClosedTradeBucket
  byStrategy: Record<string, ClosedTradeBucket>
}

/** Win-rate summary split by source, so real banked performance is never silently
 *  blended with paper/backtest outcomes. `all` is the combined view (use with care). */
export interface ClosedTradeReport {
  real: ClosedTradeStats
  paper: ClosedTradeStats
  all: ClosedTradeStats
}
export interface ClosedTradeBucket {
  trades: number
  wins: number
  losses: number
  flat: number
  winRate: number | null     // wins / (wins+losses) * 100, null when no decided trades
  netRealizedUsd: number
  feesUsd: number
}

export interface AutoPlanStatus {
  /** Plan identity — the primary symbol this plan trades (derived from steps[0].symbol).
   *  Multiple plans (different symbols) can be active/proposed concurrently; this id is
   *  how the API and UI address a specific one (confirm/stop/reset/patchStep). */
  id: string
  active: boolean
  isProposed: boolean       // true = steps are staged for review, not yet executing
  proposedAt: number | null // when the proposal was created
  proposedLabel: string     // human-readable plan name (e.g. "JTO T1 exit — 2026-06-29 14:32")
  startedAt: number | null
  currentStepIndex: number
  steps: AutoStep[]
  log: string[]
}

/** One BTC ladder round-trip: a sell slice and the buy-back that closes it. Persisted so
 *  the invariant "every BTC sell has a resting buy-back at a lower price" can be VERIFIED
 *  continuously — even across a restart that drops the in-flight plan. Created when a BTC
 *  sell fills; linked to its rebuy order when placed; closed when the rebuy fills. */
export interface BtcLadderCycle {
  id: string
  soldAt: number
  soldBtc: number
  soldUsd: number            // gross proceeds of the sell slice
  soldPrice: number
  /** Gemini order id of the SELL leg. Not required by the reconciler, but without it a cycle
   *  can only be identified by (time, size), which is what let two cycles claim the same
   *  rebuy fill in the 2026-07 ledger corruption — keep it populated for auditability. */
  sellOrderId?: string
  rebuyPrice: number | null  // intended buy-back limit (from the paired step, or derived)
  rebuyOrderId: string | null // Gemini order id once the buy-back is resting on the book
  /** open   = sold, no buy-back placed yet (UNHEDGED — the state we alert on)
   *  staged = a buy-back has been auto-staged into the confirm-first queue, awaiting confirm
   *  resting= buy-back order is live on the exchange below the sell price (invariant holds)
   *  closed = buy-back filled; round-trip complete */
  status: 'open' | 'staged' | 'resting' | 'closed'
  /** 'roundtrip' (default when absent — every legacy cycle) is the paired sell→rebuy engine the
   *  invariant governs: a naked 'open' one alerts and auto-stages a buy-back. 'scaleout' is the
   *  multi-timeframe RSI de-risk (added 2026-07-21): an INTENTIONAL naked sell to USD dry powder,
   *  redeployed later via the dip ladder on the daily-RSI mean-reversion. A scaleout cycle does
   *  NOT demand a paired rebuy — it is excluded from the unhedged alert, the auto-stage, and the
   *  BTCUSD slot reservation. It is a durable ledger record of banked USD, not a broken invariant. */
  kind?: 'roundtrip' | 'scaleout'
  boughtBtc?: number         // BTC reacquired when the buy-back filled
  closedAt?: number
  note?: string
}

/** A verifier finding: a BTC sell that currently has no resting buy-back below it. */
export interface BtcLadderAlert {
  cycleId: string
  soldBtc: number
  soldUsd: number
  soldPrice: number
  rebuyPrice: number | null
  status: BtcLadderCycle['status']
  message: string
}

/** Opt-in autonomy: when enabled, staged plans confirm themselves without manual approval,
 *  but ONLY when every trade in the plan is at or under `maxUsd`. Any trade above the cap
 *  stays staged for manual review. Off by default; the whole system is confirm-first. */
export interface AutoExecuteConfig {
  enabled: boolean
  btcLadderMaxUsd: number  // per-trade USD ceiling for BTC ladder trades (BTCUSD)
  altMaxUsd: number        // per-trade USD ceiling for all other (alt) trades
  /** Per-strategy opt-OUT, keyed by strategy id. `enabled` above stays the master switch:
   *  a strategy auto-executes only when `enabled` is true AND its own flag is not false.
   *  Absent key ⇒ true, so turning the master on keeps behaving exactly as it did before
   *  per-strategy toggles existed, and a strategy is silenced by explicitly setting false.
   *  Flipping a strategy on while the master is off does NOT execute anything — the master
   *  is the single kill switch for all autonomy. */
  perStrategy: Record<string, boolean>
}

/** The shared-assumptions pseudo-strategy. It is stored as an ordinary StrategyDefinition so
 *  it inherits persistence/API/RESET/UI, but it is NOT runnable and has no skill doc — the
 *  runnable registry is STRATEGIES in server/strategyRunner.ts, which is separate and explicit.
 *  Its values are underlaid beneath every strategy's own by getResolvedStrategySettings. */
export const GLOBAL_STRATEGY_ID = '_global'

/** UI metadata for one editable strategy-settings knob (server: cryptoStrategySettings.ts). */
export interface StrategySettingsField {
  key: string
  label: string
  min: number
  max: number
  step: number
  unit: string // '%' | '$' | 'min' | '' (raw score/count)
  /** 'toggle' renders ON/OFF and is stored as 0|1 — booleans share the numeric value map so
   *  persistence, clamping and the API stay uniform. Absent means 'number'. */
  type?: 'number' | 'toggle'
  /** Sub-heading to render under in the admin panel; absent means GENERAL. */
  group?: string
}

/** A full trading strategy's tunable settings (server: cryptoStrategySettings.ts).
 *  Strategies are stored as data, not a fixed TS union, so new ones can be created
 *  from the app's "+ NEW STRATEGY" form without a code change. The 5 hand-authored
 *  strategies (crypto-strategy, fast-cash, firecracker, sniper, oversold) are seeded
 *  in with `builtin: true`; anything created via the form has `builtin: false`. */
export interface StrategyDefinition {
  id: string
  label: string
  description: string
  fields: StrategySettingsField[]
  values: Record<string, number>
  defaults: Record<string, number>
  createdAt: number
  builtin: boolean
}

/** Growth of one asset's held quantity since a baseline was captured. */
export interface AssetGrowth {
  baseline: number         // quantity held when tracking started
  current: number          // quantity held now (total, incl. amounts locked in open orders)
  pctChange: number | null // % change vs baseline; null when baseline is 0 (no basis)
}

/** BTC-vs-USD portfolio comparison: how much of each is held and how much each has grown
 *  since the baseline. With no external deposits/withdrawals, the change is trading-driven;
 *  reset the baseline (e.g. after a transfer) to keep it a pure trading measure. */
export interface PortfolioGrowth {
  since: number            // baseline capture time (unix ms)
  btc: AssetGrowth
  usd: AssetGrowth
  /** Total account value in USD (all holdings — BTC, USD cash, and every alt — valued at
   *  current prices), vs. the same measure at baseline. Unlike btc/usd above, this reflects
   *  the overall account balance rather than just the BTC and USD legs. */
  total: AssetGrowth
  /** Change in total account value across rolling look-back windows (24h/7d/30d) plus the
   *  since-baseline window, each expressed in BOTH USD and BTC terms. The rolling windows are
   *  computed from a persisted value-history series and read `partial: true` until enough
   *  history has accrued to cover the full window. Absent on legacy snapshots. */
  periods?: PeriodChange[]
}

/** One look-back window's change in total account value, in both USD and BTC terms. The BTC
 *  figure is the account's total value converted to BTC at each end's own BTC price — so it
 *  isolates "did the stack grow in BTC terms", not just the BTC/USD exchange-rate drift. */
export interface PeriodChange {
  key: '24h' | '7d' | '30d' | 'baseline'
  label: string            // '  24H' / '7D' / '30D' / 'YTD'
  startedAt: number        // unix ms of the past reference point actually used
  usdChange: number | null // total-value change in USD over the window (null: no reference yet)
  usdPct: number | null
  btcChange: number | null // total-value change measured in BTC over the window
  btcPct: number | null
  /** True when the recorded history doesn't reach the full window (e.g. only 3 days of samples
   *  exist but the window is 30d) — the change is measured from the oldest sample available. */
  partial: boolean
}

/** A live open order on Gemini exchange (not staged through Homunculus). */
export interface GeminiOpenOrder {
  orderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: string           // "exchange limit", "exchange stop limit", etc.
  price: string          // limit price
  stopPrice?: string     // stop-limit trigger price
  originalAmount: string
  executedAmount: string
  remainingAmount: string
  avgExecutionPrice: string
  timestampMs: number    // when placed
  clientOrderId?: string
  costBasis?: number     // weighted avg cost per unit (from holdings enrichment)
}

/** A software-side (synthetic) stop-limit armed on a resting order. The server watches
 *  the live price every hot-refresh; when it falls to `triggerPrice` it cancels the
 *  resting order and places a fresh SELL limit just above market (`exitPct`). Deliberately
 *  does NOT use Gemini's native stop-limit. */
export interface SafeModeArm {
  orderId: string       // the resting order this guards (Gemini order id)
  symbol: string
  armPrice: number      // market price at arm time — the fixed basis for stopPct
  stopPct: number       // trigger = armPrice * (1 - stopPct/100)
  exitPct: number       // replacement sell limit = market * (1 + exitPct/100)
  triggerPrice: number  // precomputed from armPrice + stopPct (or set absolutely via adjust)
  armedAt: number       // unix ms — set at first arm, preserved across in-place adjusts
  adjustedAt?: number   // unix ms of the last in-place % / trigger adjust, if any
}

/** One filled trade from Gemini's /v1/mytrades endpoint. */
export interface GeminiTrade {
  tradeId: string        // Gemini's "tid"
  orderId: string        // Gemini's "order_id"
  symbol: string         // e.g. "JTOUSD"
  side: 'buy' | 'sell'
  price: string          // fill price
  amount: string         // base-currency amount filled
  feeCurrency: string    // e.g. "USD"
  feeAmount: string      // fee paid
  timestampMs: number
  isAggressor: boolean   // true = taker fill, false = maker fill
}

/** One archived full analysis report posted by a strategy skill. `kind` distinguishes
 *  which skill produced it so the UI can label/colour it; `title` is the display name. */
export interface PlanReportEntry {
  report: string   // full markdown
  at: number       // unix ms posted
  kind: 'strategy' | 'fast-cash' | 'candle' | 'oversold' | 'firecracker' | 'sniper' | 'btc-ladder' | 'trapline' | 'reaper'
  title: string    // e.g. "STRATEGY REPORT", "FAST-CASH REPORT", "CANDLE REPORT", "OVERSOLD REPORT", "FIRECRACKER REPORT"
}

/** The full crypto snapshot served to the client. */
export interface CryptoSnapshot {
  tickers: Ticker[]
  holdings: Holding[]
  signals: Signal[]
  pending: PendingTrade[]
  openOrders: GeminiOpenOrder[]
  tradeHistory: GeminiTrade[]   // recent fills pulled from Gemini /v1/mytrades
  intelReport: string   // markdown text Claude can read
  planReport: string    // live order-status block (latest post; overwritten each status ping)
  planReportAt: number | null  // unix ms when planReport was last set
  /** Last 10 full analysis reports (strategy / fast-cash / candle), newest first.
   *  Each skill's report is its own entry so a fast-cash or candle run never overwrites
   *  the strategy report — the TRADES tab renders them collapsed. */
  planReports: PlanReportEntry[]
  lastRefresh: number
  connected: boolean    // Gemini API reachable
  keysConfigured: boolean
  seedProgress: SeedProgress
  /** One entry per symbol currently tracked by the autoplanner/bracket engine (proposed,
   *  active, or just-finished). Multiple plans for different symbols can coexist — the
   *  engine only serializes plans that share a symbol. */
  autoPlans: AutoPlanStatus[]
  /** Per-strategy USD exposure: strategyExposure[strategyId][symbol] = resting entry notional
   *  + filled position notional, counting ONLY steps that strategy opened. This is what a
   *  strategy's per-coin / bankroll caps should read, instead of the raw holding — the raw
   *  holding includes other strategies' positions (and the BTC ladder's stack), which would
   *  max a $20 cap the moment any other track held that coin. Steps with no `strategy` are
   *  bucketed under 'unattributed' and count against nobody's cap. */
  strategyExposure: Record<string, Record<string, number>>
  /** BTC ladder invariant check: sells that currently lack a resting buy-back below them.
   *  Empty when every open round-trip is hedged. Recomputed each full refresh. */
  btcLadderAlerts: BtcLadderAlert[]
  /** Open/resting BTC ladder round-trips (sell slice → paired buy-back). Lets the UI show,
   *  on a resting buy-back order, the BTC P&L vs the price its slice was sold at. */
  btcLadderCycles: BtcLadderCycle[]
  /** Opt-in auto-execute state so the UI reflects the current toggle + cap. */
  autoExecute: AutoExecuteConfig
  /** BTC-vs-USD held + % growth since baseline. Null until first holdings load. */
  portfolioGrowth: PortfolioGrowth | null
  /** Resting orders currently guarded by a software-side stop (safe mode). */
  safeMode: SafeModeArm[]
  /** When on, the server auto-runs the enabled strategy ~10s after a position closes
   *  (throttled to once per 10 min). */
  loopMode: boolean
  /** User-set interval (minutes) at which the server auto-runs the enabled strategy.
   *  0 = off. Independent of loopMode. Goes inert (never fires) once any entry in
   *  strategyIntervals below is set — scheduling has moved to per-strategy control. */
  strategyIntervalMin: number
  /** Per-strategy auto-run intervals (minutes), keyed by strategy id. Lets each
   *  dispatchable strategy run on its own cadence instead of sharing the single
   *  strategyIntervalMin timer above; as soon as any entry here is set, the universal
   *  timer stops firing (see server/crypto.ts armIntervalTimer). */
  strategyIntervals: Record<string, number>
  /** Live effective fee rates measured from the account's own recent fills — used to
   *  net exit fees into unrealized P&L instead of a fixed assumption. */
  feeRates: FeeRates
  /** CoinMarketCap cross-exchange market data per base symbol, when CMC_API_KEY is set.
   *  Empty when unconfigured. Used as a market-wide liquidity signal (e.g. firecracker)
   *  independent of Gemini's own thin per-symbol volume. */
  cmcData: CmcMarketData[]
}

/** The slice of CryptoSnapshot the always-mounted position widgets actually read
 *  (BRIDGE OpenTradesWidget + the header P&L ticker). Served by
 *  GET /api/crypto/positions so those pollers don't drag the full ~750 KB snapshot —
 *  signals/tradeHistory/planReports/intelReport are ~97% of that payload and none of
 *  it is used here. `tickers` carries only the symbols referenced by an open plan or
 *  a resting order, which is what prices the P&L. */
export interface CryptoPositionsSnapshot {
  tickers: Ticker[]
  openOrders: GeminiOpenOrder[]
  autoPlans: AutoPlanStatus[]
  lastRefresh: number
  connected: boolean
}

export const EMPTY_SNAPSHOT: CryptoSnapshot = {
  tickers: [],
  holdings: [],
  signals: [],
  pending: [],
  openOrders: [],
  tradeHistory: [],
  intelReport: '',
  planReport: '',
  planReportAt: null,
  planReports: [],
  lastRefresh: 0,
  connected: false,
  keysConfigured: false,
  seedProgress: { total: 0, seeded: 0, active: false },
  autoPlans: [],
  strategyExposure: {},
  btcLadderAlerts: [],
  btcLadderCycles: [],
  autoExecute: { enabled: false, btcLadderMaxUsd: 100, altMaxUsd: 100, perStrategy: {} },
  portfolioGrowth: null,
  safeMode: [],
  loopMode: false,
  strategyIntervalMin: 0,
  strategyIntervals: {},
  feeRates: { maker: 0.002, taker: 0.004, blended: 0.003, samples: 0 },
  cmcData: [],
}
