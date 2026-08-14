// Polls the open-position slice of the crypto snapshot and derives open
// managed-bracket positions + a portfolio-level unrealized P&L. Shared by the BRIDGE
// OpenTradesWidget and the header telemetry ticker so there's a single poll, not one
// per consumer.
//
// This hook is mounted at the App root, so it polls on every tab for as long as the app
// is open. It deliberately hits /api/crypto/positions, not /api/crypto/snapshot: the
// full snapshot is ~750 KB (signals + tradeHistory + planReports + intelReport) and none
// of that is read here, so polling it meant ~7 MB/min of parse-and-discard garbage.

import { useEffect, useState } from 'react'
import type { CryptoPositionsSnapshot, Ticker, AutoStep, BracketPhase, GeminiOpenOrder } from '../../shared/crypto'
import { fetchCryptoPositions } from '../lib/cryptoApi'

// Phases where a position actually exists (worth surfacing as an "open trade").
const OPEN_PHASES: BracketPhase[] = ['entering', 'protected', 'tp1_filled', 'exiting']

export interface OpenPosition {
  key: string
  symbol: string
  base: string
  phase: BracketPhase
  entryPrice: number | null
  amount: number | null
  stopPrice: number | null
  last: number | null
  realizedUsd: number
  note: string
}

export interface CryptoPositions {
  snap: CryptoPositionsSnapshot | null
  error: string | null
  positions: OpenPosition[]
  orders: GeminiOpenOrder[]
  /** Sum of live unrealized P&L across open positions, USD. */
  totalUnrealUsd: number
  /** True once at least one poll has resolved. */
  loaded: boolean
}

function derivePositions(snap: CryptoPositionsSnapshot): OpenPosition[] {
  const priceOf = (sym: string): number | null => {
    const t = snap.tickers.find((tk: Ticker) => tk.symbol === sym)
    return t ? Number(t.last) : null
  }
  const out: OpenPosition[] = []
  for (const plan of snap.autoPlans) {
    if (!plan.active) continue
    for (const step of plan.steps as AutoStep[]) {
      const st = step.bracketState
      if (step.kind !== 'bracket' || !st || !OPEN_PHASES.includes(st.phase)) continue
      out.push({
        key: `${plan.id}:${step.id}`,
        symbol: step.symbol,
        base: step.symbol.replace('USD', ''),
        phase: st.phase,
        entryPrice: st.entryPrice,
        amount: st.positionAmount ?? st.filledAmount,
        stopPrice: st.stopPrice,
        last: priceOf(step.symbol),
        realizedUsd: st.realizedUsd,
        note: st.note,
      })
    }
  }
  return out
}

export function unrealUsd(p: OpenPosition): number | null {
  return p.entryPrice && p.last && p.amount ? (p.last - p.entryPrice) * p.amount : null
}

export function useCryptoPositions(pollMs = 6_000): CryptoPositions {
  const [snap, setSnap] = useState<CryptoPositionsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const s = await fetchCryptoPositions()
        if (alive) { setSnap(s); setError(null) }
      } catch (e) {
        if (alive) setError((e as Error).message)
      }
    }
    void load()
    const id = setInterval(load, pollMs)
    return () => { alive = false; clearInterval(id) }
  }, [pollMs])

  const positions = snap ? derivePositions(snap) : []
  const totalUnrealUsd = positions.reduce((sum, p) => sum + (unrealUsd(p) ?? 0), 0)

  return {
    snap,
    error,
    positions,
    orders: snap?.openOrders ?? [],
    totalUnrealUsd,
    loaded: snap !== null,
  }
}
