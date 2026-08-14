// Persisted, editable tuning knobs for the crypto strategy skills. The skills
// themselves are prompt docs run headlessly via the Agent SDK (see strategyRunner.ts)
// — they read these values over HTTP at the start of each run instead of using
// hardcoded constants, so the CRYPTO tab's admin panel can retune a strategy without
// editing prompt text.
//
// Strategies are stored as data (StrategyDefinition[]), not a fixed TS union, so new
// ones can be created from the app (the "+ NEW STRATEGY" form in CryptoDashboard.tsx)
// without a code change. The 5 built-ins are seeded on first run with the schemas/
// defaults that used to be hardcoded here; a legacy flat-shape settings file (one
// object keyed by the old fixed strategy ids) is migrated in place using those same
// seed schemas as the field metadata source.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { GLOBAL_STRATEGY_ID } from '../shared/crypto'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'

export interface StrategySettingsField {
  key: string
  label: string
  min: number
  max: number
  step: number
  unit: string // '%' | '$' | 'min' | '' (raw score/count)
  /** 'toggle' renders an ON/OFF button and is stored as 0|1 — booleans deliberately live in
   *  the same Record<string, number> as everything else so persistence, clamping, migration
   *  and the API stay untouched. Defaults to 'number' when absent. */
  type?: 'number' | 'toggle'
  /** Sub-heading this field renders under in the admin panel (see GROUP_ORDER in
   *  CryptoDashboard.tsx). Ungrouped fields fall into GENERAL. */
  group?: string
}

export interface StrategyDefinition {
  id: string                        // slug, e.g. "vwap-reversion"
  label: string                     // display name, e.g. "VWAP REVERSION"
  description: string               // thesis/notes — shown in the admin panel and read
                                     // by the /new-strategy skill when authoring the doc
  fields: StrategySettingsField[]
  values: Record<string, number>
  defaults: Record<string, number>  // captured at creation time, for RESET
  createdAt: number
  builtin: boolean                  // true for the 5 original hand-authored strategies
}

// ── Seed data — the 5 original strategies, schemas/defaults unchanged from before
// this store went dynamic (2026-07-18). ─────────────────────────────────────────────
// GLOBAL_STRATEGY_ID lives in shared/ so the client can reference it too (the admin panel
// suppresses the run-interval control for it, since it isn't a runnable strategy).
export { GLOBAL_STRATEGY_ID } from '../shared/crypto'

const SEED: { id: string; label: string; description: string; fields: StrategySettingsField[]; defaults: Record<string, number> }[] = [
  {
    id: GLOBAL_STRATEGY_ID, label: '⚙ GLOBAL — SHARED ASSUMPTIONS',
    description: 'Cross-cutting values every strategy inherits. A strategy overrides one simply by '
      + 'declaring a field with the same key — e.g. sniper carries its own roundTripFeePct.',
    fields: [
      { key: 'roundTripFeePct', label: 'Round-trip fee assumption', min: 0, max: 2, step: 0.01, unit: '%' },
      { key: 'dustFloorUsd', label: 'Dust floor — ignore below', min: 0.5, max: 20, step: 0.5, unit: '$' },
      { key: 'exchangeMinOrderUsd', label: 'Exchange order minimum', min: 1, max: 50, step: 1, unit: '$' },
      { key: 'liquidityVol24hUsd', label: 'Liquidity floor — 24h volume', min: 0, max: 20000000, step: 100000, unit: '$' },
      { key: 'liquidityMarketCapUsd', label: 'Liquidity floor — market cap', min: 0, max: 500000000, step: 5000000, unit: '$' },
      { key: 'liquidityGeminiFallbackUsd', label: 'Liquidity fallback (unlisted on CMC)', min: 0, max: 500000, step: 5000, unit: '$' },
      { key: 'confirmFirst', label: 'Confirm-first (never auto-send)', min: 0, max: 1, step: 1, unit: '', type: 'toggle' }
    ],
    defaults: {
      roundTripFeePct: 0.7, dustFloorUsd: 1, exchangeMinOrderUsd: 5,
      liquidityVol24hUsd: 2000000, liquidityMarketCapUsd: 50000000,
      liquidityGeminiFallbackUsd: 25000, confirmFirst: 1
    }
  },
  {
    id: 'btc-ladder', label: 'BTC LADDER',
    description: 'BTC accumulation ladder v2 (2026-08-08) — trend-gated swing harvest: sell big slices '
      + 'into 5-day-high strength when NOT in a confirmed 1day uptrend, rebuy split across −5/−9/−13% '
      + 'levels, no clock timeout (runaway restore at +15%). Measured in BTC, never USD. '
      + 'v2 backtest: +34.4% BTC / 2y walk-forward at measured 2026 fees.',
    fields: [
      // ── V2 engine (2026-08-08, btc-ladder-fee-tier-research-2026-08-08.md) ──
      // 2y walk-forward on Coinbase tape at measured 0.60%/leg fees: +34.4% BTC (bull half +10.7%,
      // bear half +25.9%, 84% leg win rate). v2 ON replaces the v1 branches (tiers/scale-out/dynamic
      // bands) entirely; they stay declared below for fallback when it is off.
      { key: 'ladderV2On', label: 'V2 engine (supersedes v1 branches)', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'V2' },
      { key: 'v2HighLookbackDays', label: 'V2 sell — price at N-day high', min: 2, max: 20, step: 1, unit: 'd', group: 'V2' },
      { key: 'v2SlicePct', label: 'V2 slice — % of stack per sell', min: 10, max: 50, step: 5, unit: '%', group: 'V2' },
      { key: 'v2SellSpacingPct', label: 'V2 spacing — min above last sell', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'V2' },
      { key: 'v2RebuyL1Pct', label: 'V2 rebuy leg 1 — below sell', min: 1, max: 10, step: 0.5, unit: '%', group: 'V2' },
      { key: 'v2RebuyL2Pct', label: 'V2 rebuy leg 2 — below sell', min: 2, max: 15, step: 0.5, unit: '%', group: 'V2' },
      { key: 'v2RebuyL3Pct', label: 'V2 rebuy leg 3 — below sell', min: 3, max: 25, step: 0.5, unit: '%', group: 'V2' },
      { key: 'v2RunawayRestorePct', label: 'V2 runaway restore — above sell', min: 5, max: 30, step: 1, unit: '%', group: 'V2' },
      { key: 'sellPctB4hrMin', label: 'Sell trigger — 4hr %B ≥', min: 50, max: 100, step: 1, unit: '', group: 'GATES' },
      { key: 'sellRsi1dMin', label: 'Sell trigger — 1day RSI ≥', min: 50, max: 90, step: 1, unit: '', group: 'GATES' },
      // Trend-aware sell gate (added 2026-07-21 from the 7-cycle ledger: the round-trip engine netted
      // +$4.57 while one slice sold into a sustained uptrend stranded 16x that in an unfillable rebuy).
      // ON = in a confirmed 1day uptrend (price above a rising 1day MA20) shrink to sliceMin + min
      // discount, and skip outright if the sell signal is marginal. The engine stops fighting the drift.
      { key: 'sellTrendGateOn', label: 'Sell gate — respect 1day uptrend', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      // Multi-timeframe RSI scale-out (added 2026-07-21). Sell BTC into overbought-AND-RISING RSI
      // to bank USD dry powder, redeploy lower for more BTC. Sell size scales with how HIGH a
      // timeframe is overbought: daily (strategic, naked USD) sells harder than hourly (tactical,
      // paired-rebuy). Weekly is deliberately NOT here yet — Gemini's ~1yr feed had zero weekly-
      // overbought events to validate it (backtest 2026-07-21); add it once a bull-phase sample exists.
      // Daily engine backtested +7.4% BTC over the 2026 bear year (obRsi1day~65, dryPowderRebuyRsi 42).
      { key: 'scaleOutOn', label: 'RSI scale-out engine', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'SCALE-OUT' },
      { key: 'scaleRequireRising', label: 'Only sell when RSI rising', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'SCALE-OUT' },
      { key: 'obRsi1hr', label: 'Overbought — 1hr RSI ≥ (tactical)', min: 60, max: 90, step: 1, unit: '', group: 'SCALE-OUT' },
      { key: 'obRsi1day', label: 'Overbought — 1day RSI ≥ (strategic)', min: 55, max: 85, step: 1, unit: '', group: 'SCALE-OUT' },
      { key: 'scaleWeight1hr', label: 'Sell weight — 1hr (paired-rebuy)', min: 0, max: 5, step: 0.5, unit: 'x', group: 'SCALE-OUT' },
      { key: 'scaleWeight1day', label: 'Sell weight — 1day (naked USD)', min: 0, max: 8, step: 0.5, unit: 'x', group: 'SCALE-OUT' },
      { key: 'scaleMaxPerEventPct', label: 'Max stack sold per scale-out', min: 2, max: 40, step: 1, unit: '%', group: 'SCALE-OUT' },
      { key: 'dryPowderRebuyRsi', label: 'Redeploy USD when 1day RSI <', min: 30, max: 55, step: 1, unit: '', group: 'SCALE-OUT' },
      // Per-timeframe slice sizes for the tiered paired-rebuy ladder (operator directive 2026-07-21): the deeper
      // the timeframe that prints overbought+rising, the bigger the round-trip slice. Every tier
      // auto-pairs a USD-sized rebuy (Branch A). The fast tiers (5m/1hr/4hr) can't be backtested over
      // a long horizon — Gemini serves ~7d of 5m, ~61d of 1hr/4hr — so treat them as live-only; the
      // 1day tier is the validated one. Total across all tiers still obeys maxTotalOutPct (25%).
      { key: 'tierPct5m', label: 'Tier slice — 5m overbought', min: 0, max: 10, step: 0.5, unit: '%', group: 'TIERS' },
      { key: 'tierPct1hr', label: 'Tier slice — 1hr overbought', min: 0, max: 15, step: 0.5, unit: '%', group: 'TIERS' },
      { key: 'tierPct4hr', label: 'Tier slice — 4hr overbought', min: 0, max: 25, step: 1, unit: '%', group: 'TIERS' },
      { key: 'tierPct1day', label: 'Tier slice — 1day overbought', min: 0, max: 40, step: 1, unit: '%', group: 'TIERS' },
      // Per-tier rebuy discount ("profit band") — how far below the sell each tier's USD-sized
      // rebuy rests, i.e. the round-trip's BTC gain if it fills. Tuned per timeframe from the
      // 2026-07-21 backtest: fast tiers need a TIGHT band or the rebuy never fills (1hr at 1%
      // filled 92% and netted +0.99% vs 3% filling 73% at +0.29%). These override the generic
      // rebuyMin/MaxDiscountPct band for tiered trades.
      { key: 'tierDisc5m', label: 'Profit band — 5m rebuy below', min: 0.3, max: 5, step: 0.1, unit: '%', group: 'TIERS' },
      { key: 'tierDisc1hr', label: 'Profit band — 1hr rebuy below', min: 0.3, max: 5, step: 0.1, unit: '%', group: 'TIERS' },
      { key: 'tierDisc4hr', label: 'Profit band — 4hr rebuy below', min: 0.5, max: 8, step: 0.1, unit: '%', group: 'TIERS' },
      { key: 'tierDisc1day', label: 'Profit band — 1day rebuy below', min: 1, max: 10, step: 0.5, unit: '%', group: 'TIERS' },
      // 5m tier is PAPER-ONLY until it earns live status: it was the one tier that lost BTC in the
      // backtest (fee floor). When on, a 5m trigger is logged via btc-ladder.py `paper`, never staged.
      { key: 'tier5mPaperOnly', label: '5m tier — paper-trade only', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'TIERS' },
      // Adaptive RSI reversal bands (operator directive 2026-07-21): "overbought/oversold" = where RSI HISTORICALLY
      // reverses in the CURRENT regime, not a fixed number. Per timeframe, over a trailing window,
      // sell when RSI >= its Pth percentile and rebuy when RSI <= its (100-P)th percentile — both bands
      // slide down in a downtrend so the ladder captures the volatility instead of waiting for RSI 70
      // that never prints. Backtest 2026-07-21: dynamic (lookback 60 / P90) netted +3.83% BTC vs the
      // fixed-70 gate's +0.68% on the bear year, and FIRED (8 sells vs 2) where fixed sat dormant.
      // When on, these bands OVERRIDE the fixed obRsi… gates and the tierDisc rebuy discounts.
      { key: 'dynamicRsiBands', label: 'Adaptive RSI reversal bands', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'DYNAMIC' },
      { key: 'rsiBandLookback', label: 'Band lookback (bars)', min: 20, max: 200, step: 5, unit: 'bar', group: 'DYNAMIC' },
      { key: 'rsiSellPctile', label: 'Sell when RSI ≥ percentile', min: 70, max: 97, step: 1, unit: 'pct', group: 'DYNAMIC' },
      { key: 'rsiBuyPctile', label: 'Buy when RSI ≤ percentile', min: 3, max: 30, step: 1, unit: 'pct', group: 'DYNAMIC' },
      // Bollinger Bands set the ORDER PRICES per timeframe (operator directive 2026-07-21). RSI triggers WHEN;
      // BB sets WHERE: sell at the timeframe's BB upper band (or at/above ask if price is already
      // past it), rebuy at the band it reverts to. rebuyAtLowerBand off = rebuy at the MIDDLE band
      // (the mean — fast, frequent fills, best for scalping); on = the LOWER band (deeper, rarer).
      // Either way the rebuy depth is still capped at rebuyMaxDiscountPct so it stays reachable.
      { key: 'bbPriceLevels', label: 'Bollinger Bands set order prices', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'DYNAMIC' },
      { key: 'rebuyAtLowerBand', label: 'Rebuy at BB lower (else middle)', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'DYNAMIC' },
      { key: 'sliceMinPct', label: 'Slice — min % of stack', min: 1, max: 30, step: 1, unit: '%', group: 'SIZING' },
      { key: 'sliceMaxPct', label: 'Slice — max % of stack', min: 1, max: 50, step: 1, unit: '%', group: 'SIZING' },
      // Ceiling raised 40 -> 90 on 2026-08-08 (the operator): the v2 backtest's edge scales with exposure
      // (cap 25% -> +6.7%, 40% -> +12.8%, 90% -> +34.4% BTC/2y) and the trend gate + runaway restore
      // now bound the stranded-slice risk that motivated the old 40% hard cap.
      { key: 'maxTotalOutPct', label: 'Max total stack out (all cycles)', min: 5, max: 90, step: 5, unit: '%', group: 'SIZING' },
      // Fee-aware slice floor (added 2026-07-21): a slice only stages if its expected BTC gain net of
      // the round-trip fee clears this multiple of that fee. Kills the marginal +0.01%/-0.04% cycles.
      { key: 'minNetGainFeeMult', label: 'Min net gain — × round-trip fee', min: 1, max: 5, step: 0.5, unit: 'x', group: 'SIZING' },
      { key: 'minSliceNotionalUsd', label: 'Min slice notional', min: 10, max: 500, step: 5, unit: '$', group: 'SIZING' },
      { key: 'cashBufferPct', label: 'Cash buffer held back', min: 0, max: 40, step: 1, unit: '%', group: 'SIZING' },
      // Raised 1.5 -> 2.0 on 2026-07-18 from the 8-cycle ledger: every rebuy staged at 1.47-1.84%
      // captured <=1.05% BTC, every one at 2.07-2.73% captured its full discount, and the deeper
      // ones filled just as reliably. Depth was never what stranded a cycle.
      { key: 'rebuyMinDiscountPct', label: 'Rebuy — min below sell', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'ENTRY' },
      { key: 'rebuyMaxDiscountPct', label: 'Rebuy — max below sell', min: 0.5, max: 20, step: 0.5, unit: '%', group: 'ENTRY' },
      // No rebuy that ever filled took longer than 64h (10/12/21/35/52/61/64). Past this, a resting
      // rebuy is not "being patient", it is stack sitting in USD while BTC walks away from it.
      { key: 'rebuyStaleHours', label: 'Rebuy — review if unfilled after', min: 12, max: 336, step: 12, unit: 'h', group: 'ENTRY' },
      // Hard age ceiling (added 2026-07-21). rebuyStaleHours triggers a re-decision; this forces
      // resolution — restore-at-market and close the cycle, never another roll-up. cyc-1 (360h+ of
      // roll-up churn realizing losses a basis point at a time) is exactly what this stops.
      { key: 'maxCycleAgeHours', label: 'Cycle — force-resolve after', min: 24, max: 336, step: 12, unit: 'h', group: 'ENTRY' },
      { key: 'dipLadderOn', label: 'Branch B — USD dip-buy ladder', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'ENTRY' },
      { key: 'dipLadderStep1Pct', label: 'Dip ladder — leg 1 below', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'ENTRY' },
      { key: 'dipLadderStep2Pct', label: 'Dip ladder — leg 2 below', min: 0.5, max: 15, step: 0.5, unit: '%', group: 'ENTRY' },
      { key: 'dipLadderStep3Pct', label: 'Dip ladder — leg 3 below', min: 0.5, max: 25, step: 0.5, unit: '%', group: 'ENTRY' },
      // 4th deeper leg (added 2026-07-21): Branch B out-accumulated the entire round-trip engine 6:1 in
      // the ledger, so the accumulation branch was widened. Deep leg parks at a 1day support for real washouts.
      { key: 'dipLadderStep4Pct', label: 'Dip ladder — leg 4 below', min: 0.5, max: 30, step: 0.5, unit: '%', group: 'ENTRY' },
      { key: 'requireLedger', label: 'Require ledger reconcile each run', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'LEDGER' }
    ],
    defaults: {
      // V2 engine (2026-08-08): slice 40% at 5-day-high while gate open, rebuys split 1/3 each at
      // -5/-9/-13%, >=2% spacing between sells, no clock forcing — runaway restore at +15% only.
      ladderV2On: 1, v2HighLookbackDays: 5, v2SlicePct: 40, v2SellSpacingPct: 2,
      v2RebuyL1Pct: 5, v2RebuyL2Pct: 9, v2RebuyL3Pct: 13, v2RunawayRestorePct: 15,
      sellPctB4hrMin: 90, sellRsi1dMin: 68, sellTrendGateOn: 1,
      // Scale-out and fast tiers retired 2026-08-08 (fee floor: 1hr/4hr profit bands sit under the
      // 1.2% round-trip fee at the measured base tier — see gemini fee research). v1 fallback only.
      scaleOutOn: 0, scaleRequireRising: 1, obRsi1hr: 75, obRsi1day: 70,
      scaleWeight1hr: 1, scaleWeight1day: 3, scaleMaxPerEventPct: 20, dryPowderRebuyRsi: 42,
      tierPct5m: 0, tierPct1hr: 0, tierPct4hr: 0, tierPct1day: 10,
      // tierDisc… is the fallback/cap rebuy depth when BB pricing is off; BB middle/lower band is primary.
      tierDisc5m: 1, tierDisc1hr: 1, tierDisc4hr: 1.5, tierDisc1day: 2, tier5mPaperOnly: 1,
      dynamicRsiBands: 1, rsiBandLookback: 60, rsiSellPctile: 90, rsiBuyPctile: 10,
      bbPriceLevels: 1, rebuyAtLowerBand: 0,
      // minNetGainFeeMult 1: ANY net BTC gain after fees is a win (the operator) — no 2x margin required.
      sliceMinPct: 5, sliceMaxPct: 15, maxTotalOutPct: 90, minNetGainFeeMult: 1,
      minSliceNotionalUsd: 50, cashBufferPct: 8, rebuyMinDiscountPct: 2, rebuyMaxDiscountPct: 5,
      // v2: stale hours is a REVIEW checkpoint only (report age, re-verify structure); the clock
      // never forces a restore — v2 deep legs fill at 10-60 day medians by design. maxCycleAgeHours
      // only applies when ladderV2On is off (v1 fallback).
      rebuyStaleHours: 168, maxCycleAgeHours: 336,
      dipLadderOn: 0, dipLadderStep1Pct: 1, dipLadderStep2Pct: 3, dipLadderStep3Pct: 6, dipLadderStep4Pct: 9,
      requireLedger: 1
    }
  },
  {
    id: 'crypto-strategy', label: 'CRYPTO STRATEGY',
    description: '4hr Bollinger Band swing system — BTC accumulation ladder + BB+volume alt swings on the 4hr chart.',
    fields: [
      { key: 'baseSizeUsdLowRisk', label: 'Base size — LOW/MEDIUM risk', min: 5, max: 200, step: 5, unit: '$', group: 'SIZING' },
      { key: 'baseSizeUsdHighRisk', label: 'Base size — HIGH/EXTREME risk', min: 5, max: 200, step: 5, unit: '$', group: 'SIZING' },
      { key: 'scoreLiveFloor', label: 'Score floor — LIVE', min: 0, max: 10, step: 1, unit: '', group: 'SCORING' },
      { key: 'scorePaperFloor', label: 'Score floor — paper-only', min: 0, max: 10, step: 1, unit: '', group: 'SCORING' },
      { key: 'safeModeStopPctMin', label: 'Safe-mode trigger — min', min: 1, max: 15, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'safeModeStopPctMax', label: 'Safe-mode trigger — max', min: 1, max: 15, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'positionTimeStopMin', label: 'Position time-stop', min: 60, max: 20160, step: 60, unit: 'min', group: 'EXITS' },
      { key: 'entryPctBMax', label: 'BB gate — 4hr %B ≤', min: 0, max: 60, step: 1, unit: '', group: 'GATES' },
      { key: 'volumeGateOn', label: 'Volume gate (4hr trend rising)', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'regimeGateOn', label: 'Regime gate blocks entries', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'spreadCapPct', label: 'Spread cap — skip above', min: 0.1, max: 5, step: 0.1, unit: '%', group: 'GATES' },
      { key: 'minViableT1Pct', label: 'Minimum viable T1 (gross)', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'GATES' },
      { key: 'bandwidthMinPct', label: 'Band width — skip below', min: 0, max: 10, step: 0.5, unit: '%', group: 'GATES' },
      { key: 'bandwidthMaxPct', label: 'Band width — size down above', min: 1, max: 40, step: 1, unit: '%', group: 'GATES' },
      { key: 'entryTolerancePct', label: 'Leg 1 — above the lower band', min: 0, max: 2, step: 0.05, unit: '%', group: 'ENTRY' },
      { key: 'entryLegDepthPct', label: 'Legs 2/3 — minimum extra depth', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'ENTRY' },
      { key: 'entryTimeStopMin', label: 'Entry time-stop (per leg)', min: 30, max: 2880, step: 30, unit: 'min', group: 'ENTRY' },
      { key: 'multiLegLadderOn', label: 'Multi-leg entry ladder', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'ENTRY' },
      { key: 'scaleInStepUsd', label: 'Scale-in increment', min: 1, max: 100, step: 1, unit: '$', group: 'SIZING' },
      { key: 'cashBufferPct', label: 'Soft cash buffer', min: 0, max: 40, step: 1, unit: '%', group: 'SIZING' },
      { key: 'maxConcurrent', label: 'Max concurrent positions', min: 1, max: 10, step: 1, unit: '', group: 'SIZING' },
      { key: 'perCoinCapUsd', label: 'Per-coin exposure cap (own tag)', min: 5, max: 500, step: 5, unit: '$', group: 'SIZING' },
      { key: 't1SellFraction', label: 'T1 — fraction sold at midband', min: 0.25, max: 1, step: 0.05, unit: '', group: 'EXITS' },
      { key: 'fullExitBelowUsd', label: 'Full exit if position below', min: 5, max: 100, step: 1, unit: '$', group: 'EXITS' },
      { key: 'runnerPctB1dMax', label: 'T2 runner only if 1day %B <', min: 50, max: 100, step: 1, unit: '', group: 'EXITS' },
      { key: 'exitLegSpacingPct', label: 'Exit ladder — leg spacing', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'bankGreenPct', label: 'BANK GREEN — act above', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'reentryCooldownHours', label: 'Re-entry cooldown after banking', min: 0, max: 48, step: 1, unit: 'h', group: 'EXITS' },
      { key: 'exitPctBTake', label: 'Take the money at 4hr %B ≥', min: 50, max: 100, step: 1, unit: '', group: 'EXITS' }
    ],
    defaults: {
      baseSizeUsdLowRisk: 10, baseSizeUsdHighRisk: 5, scoreLiveFloor: 5, scorePaperFloor: 3,
      safeModeStopPctMin: 3, safeModeStopPctMax: 5, positionTimeStopMin: 4320,
      entryPctBMax: 10, volumeGateOn: 1, regimeGateOn: 0, spreadCapPct: 3, minViableT1Pct: 1.5,
      bandwidthMinPct: 1.5, bandwidthMaxPct: 12,
      entryTolerancePct: 0.4, entryLegDepthPct: 1, entryTimeStopMin: 480, multiLegLadderOn: 1,
      scaleInStepUsd: 5, cashBufferPct: 10, maxConcurrent: 2, perCoinCapUsd: 50,
      t1SellFraction: 0.7, fullExitBelowUsd: 15, runnerPctB1dMax: 80, exitLegSpacingPct: 1,
      bankGreenPct: 1.5, reentryCooldownHours: 4, exitPctBTake: 90
    }
  },
  {
    id: 'fast-cash', label: 'FAST CASH',
    description: 'Aggressive candle-pattern scalp off the /crypto-candles 5m pattern scan — small fixed size, +2-4% then out.',
    fields: [
      { key: 'sizePctOfCash', label: 'Size — % of available cash', min: 1, max: 25, step: 1, unit: '%', group: 'SIZING' },
      { key: 'tpMinPct', label: 'Take-profit — min', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'tpMaxPct', label: 'Take-profit — max', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'candleScoreFloor', label: 'CANDLE score floor', min: 0, max: 7, step: 1, unit: '', group: 'SCORING' },
      { key: 'spreadGuardPct', label: 'Spread guard (market-entry cutoff)', min: 0.1, max: 3, step: 0.1, unit: '%', group: 'GATES' },
      { key: 'positionTimeStopMin', label: 'Position time-stop', min: 5, max: 480, step: 5, unit: 'min', group: 'EXITS' },
      { key: 'perCoinCapUsd', label: 'Per-coin exposure cap (own tag)', min: 5, max: 200, step: 5, unit: '$', group: 'SIZING' },
      { key: 'maxNewSymbolsPerRun', label: 'Max new symbols per run', min: 1, max: 20, step: 1, unit: '', group: 'SIZING' },
      { key: 'maxConcurrent', label: 'Max concurrent positions', min: 1, max: 10, step: 1, unit: '', group: 'SIZING' },
      // ON by design — fast-cash.md calls the volume gate "non-negotiable"; it is the lie
      // detector against textbook patterns printed on dust volume. Regime is the one gate
      // fast-cash deliberately ignores, and the only thing its "aggression" refers to.
      { key: 'volumeGateOn', label: 'Volume gate', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'volRatioMin', label: 'Volume gate — signal bar ≥ × avg', min: 0.5, max: 5, step: 0.1, unit: '×', group: 'GATES' },
      { key: 'regimeGateOn', label: 'Market-regime gate', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'maxAgeBars', label: 'Pattern freshness — max age', min: 1, max: 10, step: 1, unit: 'bars', group: 'GATES' },
      { key: 'spreadSkipPct', label: 'Spread — skip symbol entirely above', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'GATES' },
      { key: 'entryTimeStopMinMarket', label: 'Entry expiry — market branch', min: 1, max: 120, step: 1, unit: 'min', group: 'ENTRY' },
      { key: 'entryTimeStopMinSupport', label: 'Entry expiry — support branch', min: 1, max: 240, step: 1, unit: 'min', group: 'ENTRY' },
      { key: 'marketCrossPct', label: 'Marketable limit — cross above ask', min: 0, max: 1, step: 0.05, unit: '%', group: 'ENTRY' },
      { key: 'tpFirstOn', label: 'tpFirst — rest TP on fill', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'ENTRY' },
      { key: 'safeModeArmOn', label: 'Arm safe mode on fill', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'EXITS' },
      // Anchor/slope of the RSI-scaled take-profit: clamp(tpMin + (anchor − rsi) × slope, tpMin, tpMax).
      { key: 'rsiTpAnchor', label: 'RSI-scaled TP — anchor RSI', min: 20, max: 70, step: 1, unit: '', group: 'EXITS' },
      { key: 'rsiTpSlope', label: 'RSI-scaled TP — slope per RSI pt', min: 0, max: 0.5, step: 0.01, unit: '', group: 'EXITS' },
      { key: 'bankGreenPct', label: 'BANK GREEN — act above', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'reentryCooldownHours', label: 'Re-entry cooldown after banking', min: 0, max: 48, step: 1, unit: 'h', group: 'EXITS' }
    ],
    defaults: {
      sizePctOfCash: 5, tpMinPct: 2, tpMaxPct: 4, candleScoreFloor: 4, spreadGuardPct: 0.4, positionTimeStopMin: 60,
      perCoinCapUsd: 20, maxNewSymbolsPerRun: 5, maxConcurrent: 4,
      volumeGateOn: 1, volRatioMin: 1.3, regimeGateOn: 0,
      maxAgeBars: 2, spreadSkipPct: 3, entryTimeStopMinMarket: 5, entryTimeStopMinSupport: 15,
      marketCrossPct: 0.1, tpFirstOn: 1, safeModeArmOn: 0, rsiTpAnchor: 45, rsiTpSlope: 0.08,
      bankGreenPct: 1.5, reentryCooldownHours: 4
    }
  },
  {
    id: 'crypto-candles', label: 'CANDLES (SCANNER)',
    description: 'The 5m candlestick-pattern scanner that feeds /fast-cash. It stages nothing itself, '
      + 'but its scan scope and score weights decide what fast-cash is ever allowed to see.',
    fields: [
      { key: 'lookbackBars', label: 'Scan lookback', min: 1, max: 48, step: 1, unit: 'bars', group: 'GATES' },
      { key: 'minScoreScan', label: 'Scanner --min-score', min: 0, max: 8, step: 1, unit: '', group: 'GATES' },
      { key: 'maxSymbols', label: 'Scan breadth cap', min: 10, max: 500, step: 10, unit: '', group: 'GATES' },
      { key: 'maxAgeBars', label: 'Max pattern age for candidates', min: 1, max: 10, step: 1, unit: 'bars', group: 'GATES' },
      { key: 'candidateStaleMin', label: 'Candidate cache staleness', min: 1, max: 120, step: 1, unit: 'min', group: 'GATES' },
      { key: 'candKeepMin', label: 'Freshness guard — keep cache under', min: 0, max: 120, step: 1, unit: 'min', group: 'GATES' },
      { key: 'volRatioMin', label: 'Volume gate — signal bar ≥ × avg', min: 0.5, max: 5, step: 0.1, unit: '×', group: 'GATES' },
      { key: 'proposeFloorScore', label: 'CANDLE score floor to propose', min: 0, max: 7, step: 1, unit: '', group: 'SCORING' },
      { key: 'highConfidenceScore', label: 'HIGH-confidence score at/above', min: 0, max: 7, step: 1, unit: '', group: 'SCORING' },
      // Every weight is capped at 3 while the propose floor defaults to 4. That is deliberate and
      // load-bearing: no single component can clear the floor on its own, so "at least two things
      // must agree" stays structurally true no matter how these are retuned.
      { key: 'wReliability', label: 'Weight — empirical reliability', min: 0, max: 3, step: 1, unit: '', group: 'SCORING' },
      { key: 'wAtStructure', label: 'Weight — completes at structure', min: 0, max: 3, step: 1, unit: '', group: 'SCORING' },
      { key: 'wDivergence', label: 'Weight — RSI divergence agrees', min: 0, max: 3, step: 1, unit: '', group: 'SCORING' },
      { key: 'wHigherTfAgree', label: 'Weight — higher-TF agreement', min: 0, max: 3, step: 1, unit: '', group: 'SCORING' },
      { key: 'reliabilityHighPct', label: 'Reliability — HIGH at/above', min: 50, max: 95, step: 1, unit: '%', group: 'SCORING' },
      { key: 'reliabilityLowPct', label: 'Reliability — LOW at/below', min: 20, max: 70, step: 1, unit: '%', group: 'SCORING' },
      { key: 'structureAtrMult', label: 'At-structure — within × ATR', min: 0.1, max: 3, step: 0.1, unit: '×', group: 'SCORING' }
    ],
    defaults: {
      lookbackBars: 4, minScoreScan: 3, maxSymbols: 60, maxAgeBars: 2, candidateStaleMin: 10,
      candKeepMin: 10, volRatioMin: 1.3, proposeFloorScore: 4, highConfidenceScore: 6,
      wReliability: 1, wAtStructure: 1, wDivergence: 2, wHigherTfAgree: 1,
      reliabilityHighPct: 70, reliabilityLowPct: 50, structureAtrMult: 0.5
    }
  },
  {
    id: 'firecracker', label: 'FIRECRACKER',
    description: 'Whole-market RSI/candle scalp — scans every USD pair on Gemini, score-triggered ladder, tiny fixed size.',
    fields: [
      { key: 'perBidUsd', label: 'Per-bid size', min: 1, max: 50, step: 1, unit: '$', group: 'SIZING' },
      { key: 'perCoinCapUsd', label: 'Per-coin exposure cap', min: 5, max: 200, step: 5, unit: '$', group: 'SIZING' },
      { key: 'stageFloorScore', label: 'Real-capital stage floor (score)', min: 0, max: 8, step: 1, unit: '', group: 'SCORING' },
      { key: 'paperFloorScore', label: 'Paper-record floor (score)', min: 0, max: 8, step: 1, unit: '', group: 'SCORING' },
      { key: 'maxNewSymbolsPerRun', label: 'Max new symbols per run', min: 1, max: 20, step: 1, unit: '', group: 'SIZING' },
      { key: 'spreadCapPct', label: 'Spread cap', min: 0.1, max: 5, step: 0.1, unit: '%', group: 'GATES' },
      { key: 'safeModeStopPct', label: 'Safe-mode trigger (default arm)', min: 1, max: 20, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'entryTimeStopMinBase', label: 'Entry time-stop — base (score 5)', min: 5, max: 240, step: 5, unit: 'min', group: 'ENTRY' },
      { key: 'entryTimeStopMinMid', label: 'Entry time-stop — score 6', min: 5, max: 240, step: 5, unit: 'min', group: 'ENTRY' },
      { key: 'entryTimeStopMinTop', label: 'Entry time-stop — score 7+', min: 5, max: 240, step: 5, unit: 'min', group: 'ENTRY' },
      { key: 'maxAgeBars', label: 'Pattern freshness — max age', min: 1, max: 10, step: 1, unit: 'bars', group: 'GATES' },
      { key: 'volRatioBlowOff', label: 'Volume blow-off — modifier at ≥', min: 2, max: 30, step: 1, unit: '×', group: 'GATES' },
      { key: 'volumeGateOn', label: 'Volume gate', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'regimeGateOn', label: 'Market-regime gate', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      // Firecracker uses the SAME RSI-scaled take-profit formula as fast-cash but had none of
      // its bounds exposed — the whole clamp was hardcoded prose.
      { key: 'tpMinPct', label: 'Take-profit — min', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'tpMaxPct', label: 'Take-profit — max', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'rsiTpAnchor', label: 'RSI-scaled TP — anchor RSI', min: 20, max: 70, step: 1, unit: '', group: 'EXITS' },
      { key: 'rsiTpSlope', label: 'RSI-scaled TP — slope per RSI pt', min: 0, max: 0.5, step: 0.01, unit: '', group: 'EXITS' },
      { key: 'safeModeExitPct', label: 'Safe-mode exit offset', min: 0, max: 1, step: 0.05, unit: '', group: 'EXITS' },
      { key: 'rsiExitOverride', label: 'Move sell to ask when RSI ≥', min: 40, max: 90, step: 1, unit: '', group: 'EXITS' },
      { key: 'maxLegsPerCoin', label: 'Max entry legs per coin', min: 1, max: 5, step: 1, unit: '', group: 'ENTRY' },
      { key: 'multiLegLadderOn', label: 'Multi-leg entry ladder', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'ENTRY' },
      { key: 'tpFirstOn', label: 'tpFirst — rest TP on fill', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'ENTRY' },
      { key: 'safeModeArmOn', label: 'Arm safe mode on fill', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'EXITS' }
    ],
    defaults: {
      perBidUsd: 5, perCoinCapUsd: 20, stageFloorScore: 5, paperFloorScore: 4,
      maxNewSymbolsPerRun: 5, spreadCapPct: 1.5, safeModeStopPct: 5, entryTimeStopMinBase: 45,
      entryTimeStopMinMid: 75, entryTimeStopMinTop: 90, maxAgeBars: 3, volRatioBlowOff: 10,
      volumeGateOn: 0, regimeGateOn: 0,
      tpMinPct: 2, tpMaxPct: 4, rsiTpAnchor: 45, rsiTpSlope: 0.08,
      safeModeExitPct: 0.1, rsiExitOverride: 65, maxLegsPerCoin: 3,
      // Multi-leg staging is the 2026-07-10 testing override: one $5 leg per symbol, legs 2-3
      // suspended. Kept OFF so the override is a setting rather than a banner in the prose.
      multiLegLadderOn: 0, tpFirstOn: 1, safeModeArmOn: 1
    }
  },
  {
    id: 'sniper', label: 'SNIPER',
    description: 'Precision candle SWING trade — trades only the historically-proven composite from the firecracker tuning ledger.',
    fields: [
      { key: 'bankrollCapUsd', label: 'Test bankroll cap', min: 20, max: 2000, step: 10, unit: '$', group: 'SIZING' },
      { key: 'perBidUsd', label: 'Per-bid size', min: 1, max: 100, step: 1, unit: '$', group: 'SIZING' },
      { key: 'maxConcurrent', label: 'Max concurrent positions', min: 1, max: 10, step: 1, unit: '', group: 'SIZING' },
      { key: 'perCoinCapUsd', label: 'Per-coin exposure cap', min: 5, max: 200, step: 5, unit: '$', group: 'SIZING' },
      { key: 'rsiMin', label: '1hr RSI band — min', min: 0, max: 100, step: 1, unit: '', group: 'GATES' },
      { key: 'rsiMax', label: '1hr RSI band — max', min: 0, max: 100, step: 1, unit: '', group: 'GATES' },
      { key: 'tp1Pct', label: 'TP1 — scale-out target', min: 0.5, max: 20, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'tp2CapPct', label: 'TP2 — runner cap', min: 1, max: 50, step: 1, unit: '%', group: 'EXITS' },
      { key: 'trailPct', label: 'Trail — below high-water', min: 0.5, max: 20, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'spreadCapPct', label: 'Spread cap', min: 0.1, max: 5, step: 0.1, unit: '%', group: 'GATES' },
      { key: 'circuitBreakerWinFloorPct', label: 'Circuit breaker — trip below', min: 0, max: 100, step: 5, unit: '%', group: 'LEDGER' },
      { key: 'circuitBreakerResumePct', label: 'Circuit breaker — resume at', min: 0, max: 100, step: 5, unit: '%', group: 'LEDGER' },
      { key: 'circuitBreakerWindow', label: 'Circuit breaker — rolling window', min: 5, max: 100, step: 1, unit: '', group: 'LEDGER' },
      { key: 'circuitBreakerMinDecided', label: 'Circuit breaker — min decided', min: 1, max: 50, step: 1, unit: '', group: 'LEDGER' },
      { key: 'volRatioBlowOff', label: 'Volume blow-off — reject at ≥', min: 2, max: 30, step: 1, unit: '×', group: 'GATES' },
      { key: 'maxAgeBars', label: 'Pattern freshness — max age', min: 1, max: 5, step: 1, unit: 'bars', group: 'GATES' },
      { key: 'minRoomToResistancePct', label: 'Room to resistance ≥', min: 1, max: 20, step: 0.5, unit: '%', group: 'GATES' },
      { key: 'momentumGateOn', label: 'Require RSI direction flat/up', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'entryTimeStopMin', label: 'Entry expiry', min: 15, max: 480, step: 15, unit: 'min', group: 'ENTRY' },
      { key: 'tp1SizeFraction', label: 'TP1 — fraction sold', min: 0.1, max: 1, step: 0.05, unit: '', group: 'EXITS' },
      { key: 'breakEvenAfterTp1On', label: 'Break-even stop after TP1', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'EXITS' },
      { key: 'maxHoldDays', label: 'Bank the remainder at day', min: 1, max: 30, step: 1, unit: 'd', group: 'EXITS' },
      { key: 'safeModeStopPct', label: 'Safe-mode trigger (mandatory arm)', min: 1, max: 20, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'safeModeExitPct', label: 'Safe-mode exit offset', min: 0, max: 1, step: 0.05, unit: '', group: 'EXITS' },
      { key: 'rsiExitOverride', label: 'Move sell to ask when RSI ≥', min: 40, max: 90, step: 1, unit: '', group: 'EXITS' },
      { key: 'rotationMinHoldHours', label: 'Rotation — min hold before out', min: 0, max: 72, step: 1, unit: 'h', group: 'LEDGER' },
      { key: 'rotationDeadMoneyHours', label: 'Rotation — dead money after', min: 1, max: 168, step: 1, unit: 'h', group: 'LEDGER' },
      { key: 'rotationsPerRun', label: 'Rotation — max per run', min: 0, max: 5, step: 1, unit: '', group: 'LEDGER' },
      // Sniper's fee is genuinely different: it reads the live blended feeRates (~0.31%) rather
      // than the 0.7% assumption the other tracks carry. Declaring it here overrides _global.
      { key: 'roundTripFeePct', label: 'Round-trip fee (overrides global)', min: 0, max: 2, step: 0.01, unit: '%', group: 'GENERAL' }
    ],
    defaults: {
      // 2026-07-18 retune from sniper's own paper ledger (86 independent symbol-bar events):
      // the original backtest-derived band was inverted. RSI 45-70 scored 22% vs 27% for 30-45
      // (35-45 best at 39%); vol >=5x scored 7% so the blow-off cliff sits near 2x, not 10x;
      // age 0-1 scored 38% vs 15% for age 2+. See the evidence table in .claude/commands/sniper.md.
      bankrollCapUsd: 100, perBidUsd: 10, maxConcurrent: 3, perCoinCapUsd: 20, rsiMin: 35, rsiMax: 55,
      tp1Pct: 3, tp2CapPct: 10, trailPct: 3, spreadCapPct: 1.0,
      circuitBreakerWinFloorPct: 50, circuitBreakerResumePct: 60,
      circuitBreakerWindow: 10, circuitBreakerMinDecided: 6,
      volRatioBlowOff: 2, maxAgeBars: 1, minRoomToResistancePct: 4, momentumGateOn: 1,
      entryTimeStopMin: 60, tp1SizeFraction: 0.5, breakEvenAfterTp1On: 1, maxHoldDays: 7,
      safeModeStopPct: 5, safeModeExitPct: 0.1, rsiExitOverride: 65,
      rotationMinHoldHours: 4, rotationDeadMoneyHours: 24, rotationsPerRun: 1,
      roundTripFeePct: 0.31
    }
  },
  {
    id: 'oversold', label: 'OVERSOLD',
    description: 'Mean-reversion screen — 1hr Wilder RSI-14 < 30 on the SIGNALS-tab universe, patient limit entry, +3% target.',
    fields: [
      { key: 'sizePctOfCash', label: 'Size — % of available cash', min: 1, max: 25, step: 1, unit: '%', group: 'SIZING' },
      { key: 'rsiMaxEntry', label: '1hr RSI entry ceiling', min: 5, max: 50, step: 1, unit: '', group: 'GATES' },
      { key: 'tpPct', label: 'Take-profit target', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' },
      { key: 'positionTimeStopMin', label: 'Position time-stop', min: 5, max: 480, step: 5, unit: 'min', group: 'EXITS' },
      { key: 'spreadCapPct', label: 'Spread cap — skip symbol above', min: 0.1, max: 5, step: 0.1, unit: '%', group: 'GATES' },
      { key: 'spreadGuardPct', label: 'Spread guard (market-entry cutoff)', min: 0.1, max: 3, step: 0.1, unit: '%', group: 'GATES' },
      // Below this RSI the candidate is already washed out, so the predicted-bottom entry stops
      // making sense and the defended swing low is used instead. See the Entry row.
      { key: 'rsiWashoutMax', label: 'RSI — below this, use swing low', min: 5, max: 40, step: 1, unit: '', group: 'GATES' },
      { key: 'volumeGateOn', label: 'Volume gate', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'regimeGateOn', label: 'Market-regime gate', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'GATES' },
      { key: 'perCoinCapUsd', label: 'Per-coin exposure cap (own tag)', min: 5, max: 200, step: 5, unit: '$', group: 'SIZING' },
      { key: 'maxConcurrent', label: 'Max concurrent positions', min: 1, max: 10, step: 1, unit: '', group: 'SIZING' },
      { key: 'maxNewSymbolsPerRun', label: 'Max new symbols per run', min: 1, max: 20, step: 1, unit: '', group: 'SIZING' },
      { key: 'entryTimeStopMinMarket', label: 'Entry expiry — market branch', min: 1, max: 120, step: 1, unit: 'min', group: 'ENTRY' },
      { key: 'entryTimeStopMinSupport', label: 'Entry expiry — support branch', min: 1, max: 240, step: 1, unit: 'min', group: 'ENTRY' },
      { key: 'marketCrossPct', label: 'Marketable limit — cross above ask', min: 0, max: 1, step: 0.05, unit: '%', group: 'ENTRY' },
      { key: 'tpFirstOn', label: 'tpFirst — rest TP on fill', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'ENTRY' },
      { key: 'safeModeArmOn', label: 'Arm safe mode on fill', min: 0, max: 1, step: 1, unit: '', type: 'toggle', group: 'EXITS' },
      { key: 'bankGreenPct', label: 'BANK GREEN — act above', min: 0.5, max: 10, step: 0.5, unit: '%', group: 'EXITS' }
    ],
    defaults: {
      sizePctOfCash: 3, rsiMaxEntry: 30, tpPct: 3, positionTimeStopMin: 90, spreadCapPct: 3.0,
      spreadGuardPct: 0.4, rsiWashoutMax: 26, volumeGateOn: 0, regimeGateOn: 0,
      perCoinCapUsd: 20, maxConcurrent: 3, maxNewSymbolsPerRun: 5,
      // 45, not 20: a 1hr-RSI dip needs bar-scale time to travel, and the old 20 expired
      // before the next hourly close. The doc previously said both.
      entryTimeStopMinMarket: 5, entryTimeStopMinSupport: 45,
      marketCrossPct: 0.1, tpFirstOn: 1, safeModeArmOn: 0, bankGreenPct: 2
    }
  }
]

const SETTINGS_FILE = join(process.cwd(), 'data', 'crypto', 'strategy-settings.json')

function seedDefinitions(): StrategyDefinition[] {
  const now = Date.now()
  return SEED.map((s) => ({
    id: s.id, label: s.label, description: s.description, fields: s.fields,
    values: { ...s.defaults }, defaults: { ...s.defaults }, createdAt: now, builtin: true
  }))
}

// Migrates the pre-2026-07-18 flat shape ({ [strategyId]: { [fieldKey]: number } })
// into the current StrategyDefinition[] shape, using the seed schemas as field metadata.
function migrateLegacyShape(raw: Record<string, Record<string, number>>): StrategyDefinition[] {
  const definitions = seedDefinitions()
  for (const def of definitions) {
    const saved = raw[def.id]
    if (!saved) continue
    for (const field of def.fields) {
      const v = saved[field.key]
      if (typeof v === 'number' && Number.isFinite(v)) def.values[field.key] = v
    }
  }
  return definitions
}

/** Reconciles a saved built-in against its seed. For built-ins SEED is the authority on the
 *  SCHEMA (which fields exist, their labels, bounds, type, group) and the file is the authority
 *  on the VALUES — so adding a field to SEED, retitling one, or widening a range reaches an
 *  existing install, while the user's tuning survives.
 *
 *  This previously only checked whether a whole strategy was missing, which meant a field added
 *  to SEED after the file was first written was invisible forever — the settings file is written
 *  on the very first POST, so that window was "the first time anyone touched any setting". */
function reconcileWithSeed(saved: StrategyDefinition, seed: StrategyDefinition): StrategyDefinition {
  const values: Record<string, number> = {}
  for (const field of seed.fields) {
    const v = saved.values?.[field.key]
    values[field.key] = typeof v === 'number' && Number.isFinite(v)
      ? Math.min(field.max, Math.max(field.min, v))   // re-clamp: seed bounds may have tightened
      : seed.defaults[field.key]                      // field is new to this install
  }
  return {
    ...seed,
    values,
    createdAt: saved.createdAt ?? seed.createdAt,
  }
}

function loadDefinitions(): StrategyDefinition[] {
  if (!existsSync(SETTINGS_FILE)) return seedDefinitions()
  try {
    const raw = stateStore.readJson<unknown>(SETTINGS_FILE, undefined)
    if (Array.isArray(raw)) {
      const savedById = new Map<string, StrategyDefinition>(
        raw.filter((d: StrategyDefinition) => d && typeof d.id === 'string').map((d: StrategyDefinition) => [d.id, d]),
      )
      const seeds = seedDefinitions()
      const seedIds = new Set(seeds.map((s) => s.id))
      // Built-ins: seed schema + saved values. Missing ones are added outright.
      const merged = seeds.map((seed) => {
        const saved = savedById.get(seed.id)
        return saved ? reconcileWithSeed(saved, seed) : seed
      })
      // User-created strategies have no seed to reconcile against — keep them verbatim.
      for (const [id, def] of savedById) {
        if (!seedIds.has(id)) merged.push(def)
      }
      return merged
    }
    // Legacy flat shape.
    return migrateLegacyShape(raw as Record<string, Record<string, number>>)
  } catch (e) {
    console.warn('[crypto-strategy-settings] load failed, using seed defaults:', (e as Error).message)
    return seedDefinitions()
  }
}

function persist() {
  try {
    mkdirSync(join(process.cwd(), 'data', 'crypto'), { recursive: true })
    stateStore.writeJson(SETTINGS_FILE, current)
  } catch (e) {
    console.warn('[crypto-strategy-settings] persist failed:', (e as Error).message)
  }
}

let current: StrategyDefinition[] = loadDefinitions()

export function getAllStrategyDefinitions(): StrategyDefinition[] {
  return current
}

export function getStrategyDefinition(id: string): StrategyDefinition | undefined {
  return current.find((d) => d.id === id)
}

export function getStrategySettings(id: string): Record<string, number> | undefined {
  return getStrategyDefinition(id)?.values
}

/** A strategy's settings with the shared _global values underlaid — what the skill docs should
 *  read (`?resolved=1`), so no doc has to implement fallback logic and get it wrong.
 *
 *  The strategy's own values win on key collision, and that IS the override mechanism: sniper
 *  declaring roundTripFeePct beats the global one purely by existing. Resolving here rather than
 *  in prose is deliberate — a convention that "check the strategy first, else global" would drift
 *  the same way the hardcoded literals this whole change is fixing did. */
export function getResolvedStrategySettings(id: string): Record<string, number> | undefined {
  const def = getStrategyDefinition(id)
  if (!def) return undefined
  if (id === GLOBAL_STRATEGY_ID) return def.values
  return { ...(getStrategyDefinition(GLOBAL_STRATEGY_ID)?.values ?? {}), ...def.values }
}

export function setStrategySettings(id: string, patch: Record<string, unknown>): Record<string, number> | undefined {
  const def = getStrategyDefinition(id)
  if (!def) return undefined
  const next = { ...def.values }
  for (const field of def.fields) {
    const v = patch[field.key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      next[field.key] = Math.min(field.max, Math.max(field.min, v))
    }
  }
  const before = { ...def.values }
  current = current.map((d) => (d.id === id ? { ...d, values: next } : d))
  persist()
  // Strategy tuning is the change most worth attributing: the skills retune their
  // own gates as they run, so "who moved rsiMax to 35, me or sniper?" is a
  // question the ledger has to be able to answer months later.
  const changed = Object.keys(next).filter((k) => next[k] !== before[k])
  auditLog.note({
    action: 'strategy.settings.set',
    resource: `strategy:${id}`,
    summary: changed.length
      ? `${def.label}: ${changed.map((k) => `${k} ${before[k]} → ${next[k]}`).join(', ')}`
      : `${def.label}: no effective change`,
    before, after: next,
    meta: { strategyId: id, changedKeys: changed },
  })
  return next
}

export function resetStrategySettings(id: string): Record<string, number> | undefined {
  const def = getStrategyDefinition(id)
  if (!def) return undefined
  const before = { ...def.values }
  const reset = { ...def.defaults }
  current = current.map((d) => (d.id === id ? { ...d, values: reset } : d))
  persist()
  auditLog.note({
    action: 'strategy.settings.reset',
    resource: `strategy:${id}`,
    summary: `${def.label}: settings reset to defaults`,
    before, after: reset,
    meta: { strategyId: id },
  })
  return reset
}

function slugify(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `strategy-${Date.now()}`
}

export interface CreateStrategyInput {
  label: string
  description?: string
  fields: {
    key: string; label: string; min: number; max: number; step: number; unit: string; default: number
    type?: 'number' | 'toggle'; group?: string
  }[]
}

// Creates a new user-defined strategy from the "+ NEW STRATEGY" form. Field keys are
// sanitized to safe identifiers; the slug id is de-duplicated if it collides.
export function createStrategyDefinition(input: CreateStrategyInput): StrategyDefinition {
  const label = input.label.trim()
  if (!label) throw new Error('label required')
  let id = slugify(label)
  if (getStrategyDefinition(id)) {
    let n = 2
    while (getStrategyDefinition(`${id}-${n}`)) n++
    id = `${id}-${n}`
  }
  const fields: StrategySettingsField[] = (input.fields || [])
    .filter((f) => f && typeof f.key === 'string' && f.key.trim())
    .map((f) => ({
      key: f.key.trim().replace(/[^a-zA-Z0-9_]/g, ''),
      label: (f.label || f.key).trim(),
      min: Number.isFinite(f.min) ? f.min : 0,
      max: Number.isFinite(f.max) ? f.max : 100,
      step: Number.isFinite(f.step) && f.step > 0 ? f.step : 1,
      unit: typeof f.unit === 'string' ? f.unit : '',
      ...(f.type === 'toggle' ? { type: 'toggle' as const, min: 0, max: 1, step: 1, unit: '' } : {}),
      ...(typeof f.group === 'string' && f.group.trim() ? { group: f.group.trim().toUpperCase() } : {})
    }))
  const defaults: Record<string, number> = {}
  for (const f of input.fields || []) {
    if (!f?.key) continue
    const key = f.key.trim().replace(/[^a-zA-Z0-9_]/g, '')
    if (!key) continue
    // Toggles are 0|1 regardless of what bounds the form sent, matching the field rewrite above.
    const lo = f.type === 'toggle' ? 0 : f.min
    const hi = f.type === 'toggle' ? 1 : f.max
    defaults[key] = Math.min(hi, Math.max(lo, Number.isFinite(f.default) ? f.default : lo))
  }
  const def: StrategyDefinition = {
    id, label, description: (input.description || '').trim(), fields,
    values: { ...defaults }, defaults, createdAt: Date.now(), builtin: false
  }
  current = [...current, def]
  persist()
  auditLog.note({
    action: 'strategy.create',
    resource: `strategy:${id}`,
    summary: `new strategy "${label}" created with ${fields.length} field(s)`,
    after: def,
    meta: { strategyId: id },
  })
  return def
}

export function isKnownStrategyForSettings(id: unknown): id is string {
  return typeof id === 'string' && !!getStrategyDefinition(id)
}
