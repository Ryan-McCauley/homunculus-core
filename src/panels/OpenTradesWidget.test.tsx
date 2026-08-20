// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OpenTradesWidget } from './OpenTradesWidget'
import type { OpenPosition, CryptoPositions } from '../hooks/useCryptoPositions'
import type { GeminiOpenOrder, CryptoPositionsSnapshot } from '../../shared/crypto'

// The first UI test in the repo, and deliberately this component: it renders
// money. Every other panel was unmeasured because src/** sat outside the coverage
// include, but the gap that actually mattered was that nothing verified whether a
// P&L number comes out with the right sign, the right magnitude, or the right
// colour — a red loss rendered green is a wrong decision made confidently.
//
// OpenTradesWidget is entirely props-driven (no hooks, no fetching, no timers),
// so it needs no network stubbing. The environment is set per-file via the
// docblock above rather than globally: vitest 4 removed environmentMatchGlobs,
// and the 70-odd server suites must keep running under `node`.
//
// Colours are CSS custom properties (var(--green) / var(--crimson)), so the
// assertions check the inline style the component actually sets. That is the
// real contract here — the decision "which token" is the logic under test.

const G = 'var(--green)'
const CR = 'var(--crimson)'

afterEach(cleanup)

const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  key: 'BTCUSD-1', symbol: 'BTCUSD', base: 'BTC', phase: 'protected',
  entryPrice: 100, amount: 2, stopPrice: 95, last: 110, realizedUsd: 0, note: '',
  ...over,
})

const snapshot = (over: Partial<CryptoPositionsSnapshot> = {}): CryptoPositionsSnapshot => ({
  tickers: [], connected: true, lastRefresh: Date.now(),
  ...over,
} as CryptoPositionsSnapshot)

const props = (over: Partial<CryptoPositions> = {}): CryptoPositions => ({
  snap: snapshot(), error: null, positions: [], orders: [], totalUnrealUsd: 0, loaded: true,
  ...over,
})

/** The inline colour the component chose for the element containing `text`. */
function colorOf(text: string | RegExp): string | undefined {
  const el = screen.getByText(text)
  return (el as HTMLElement).style.color
}

// ── P&L sign, magnitude, and colour ────────────────────────────────────────

describe('position P&L', () => {
  it('renders a gain as green with an explicit + on both percent and USD', () => {
    // entry 100 → last 110 on 2 units: +10.00% and +$20.00. With one position the
    // header total equals the row, so the figure legitimately appears twice —
    // asserting the count is the stronger check anyway (header AND row agree).
    render(<OpenTradesWidget data={props({ positions: [position()], totalUnrealUsd: 20 })} />)

    expect(screen.getByText('+10.00%')).toBeInTheDocument()
    expect(colorOf('+10.00%')).toBe(G)
    expect(screen.getAllByText('+$20.00')).toHaveLength(2)
  })

  it('renders a loss as crimson with a real minus sign', () => {
    // entry 100 → last 90 on 2 units: −10.00% and −$20.00
    render(<OpenTradesWidget data={props({
      positions: [position({ last: 90 })], totalUnrealUsd: -20,
    })} />)

    expect(screen.getByText('-10.00%')).toBeInTheDocument()
    expect(colorOf('-10.00%')).toBe(CR)
    // Note the U+2212 MINUS SIGN, not a hyphen — fmtUsd uses it deliberately.
    expect(screen.getAllByText('−$20.00')).toHaveLength(2)
  })

  it('treats exactly flat as a gain, not a loss (>= 0 boundary)', () => {
    render(<OpenTradesWidget data={props({
      positions: [position({ last: 100 })], totalUnrealUsd: 0,
    })} />)

    expect(colorOf('+0.00%')).toBe(G)
  })

  it('omits row P&L entirely when there is no live price to compare against', () => {
    render(<OpenTradesWidget data={props({ positions: [position({ last: null })] })} />)

    // No percentage anywhere: the row cannot compute one without `last`.
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
    // The only USD figure left is the header total — the row contributes none.
    // Showing a fabricated $0.00 on a position with no price would read as
    // "flat" when the truth is "unknown".
    expect(screen.getAllByText(/^[+−]\$/)).toHaveLength(1)
  })

  it('shows banked P&L only once something has actually been realized', () => {
    const { rerender } = render(
      <OpenTradesWidget data={props({ positions: [position({ realizedUsd: 0 })] })} />)
    expect(screen.queryByText(/banked/)).not.toBeInTheDocument()

    rerender(<OpenTradesWidget data={props({ positions: [position({ realizedUsd: 12.5 })] })} />)
    expect(screen.getByText('banked +$12.50')).toBeInTheDocument()
  })
})

// ── Header total ───────────────────────────────────────────────────────────

describe('header total', () => {
  it('colours the aggregate by sign', () => {
    const { rerender } = render(
      <OpenTradesWidget data={props({ positions: [position()], totalUnrealUsd: 42.75 })} />)
    expect(colorOf('+$42.75')).toBe(G)

    rerender(<OpenTradesWidget data={props({ positions: [position()], totalUnrealUsd: -42.75 })} />)
    expect(colorOf('−$42.75')).toBe(CR)
  })

  it('hides the total when there are no positions to total', () => {
    render(<OpenTradesWidget data={props({ positions: [], totalUnrealUsd: 0 })} />)
    expect(screen.queryByText(/^[+−]\$/)).not.toBeInTheDocument()
  })

  it('counts positions, and orders only when some exist', () => {
    const { rerender } = render(
      <OpenTradesWidget data={props({ positions: [position()] })} />)
    expect(screen.getByText('1 pos')).toBeInTheDocument()

    rerender(<OpenTradesWidget data={props({
      positions: [position()],
      orders: [{ orderId: 'o1', symbol: 'ETHUSD', side: 'buy', type: 'exchange limit', price: '2000' } as GeminiOpenOrder],
    })} />)
    expect(screen.getByText('1 pos · 1 ord')).toBeInTheDocument()
  })
})

// ── Price formatting across magnitudes ─────────────────────────────────────

describe('price formatting', () => {
  it('uses thousands separators above 1000, 4dp below it, and precision for sub-dollar', () => {
    const { rerender } = render(
      <OpenTradesWidget data={props({ positions: [position({ entryPrice: 64321.5 })] })} />)
    expect(screen.getByText('entry 64,321.5')).toBeInTheDocument()

    rerender(<OpenTradesWidget data={props({ positions: [position({ entryPrice: 12.5 })] })} />)
    expect(screen.getByText('entry 12.5000')).toBeInTheDocument()

    rerender(<OpenTradesWidget data={props({ positions: [position({ entryPrice: 0.00012345 })] })} />)
    expect(screen.getByText('entry 0.0001234')).toBeInTheDocument()
  })
})

// ── Phase labels ───────────────────────────────────────────────────────────

describe('bracket phase', () => {
  it.each([
    ['entering', 'ENTRY RESTING'],
    ['protected', 'PROTECTED'],
    ['tp1_filled', 'TP1 · RUNNER'],
    ['exiting', 'EXITING'],
    ['flat', 'CLOSED'],
    ['aborted', 'ABORTED'],
  ] as const)('renders %s as "%s"', (phase, label) => {
    render(<OpenTradesWidget data={props({ positions: [position({ phase })] })} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

// ── Resting orders ─────────────────────────────────────────────────────────

describe('resting orders', () => {
  const order = (over: Partial<GeminiOpenOrder> = {}): GeminiOpenOrder => ({
    orderId: 'o1', symbol: 'ETHUSD', side: 'buy', type: 'exchange limit', price: '2000',
    ...over,
  } as GeminiOpenOrder)

  it('shows the section only when orders exist', () => {
    const { rerender } = render(<OpenTradesWidget data={props({ orders: [] })} />)
    expect(screen.queryByText('RESTING ON EXCHANGE')).not.toBeInTheDocument()

    rerender(<OpenTradesWidget data={props({ orders: [order()] })} />)
    expect(screen.getByText('RESTING ON EXCHANGE')).toBeInTheDocument()
  })

  it('colours buy green and sell crimson', () => {
    const { rerender } = render(<OpenTradesWidget data={props({ orders: [order({ side: 'buy' })] })} />)
    expect(colorOf('BUY')).toBe(G)

    rerender(<OpenTradesWidget data={props({ orders: [order({ side: 'sell' })] })} />)
    expect(colorOf('SELL')).toBe(CR)
  })

  it('computes distance from the live ticker price', () => {
    // limit 2000 against a last of 2500 is 20% below the market.
    render(<OpenTradesWidget data={props({
      snap: snapshot({ tickers: [{ symbol: 'ETHUSD', last: '2500' }] as CryptoPositionsSnapshot['tickers'] }),
      orders: [order()],
    })} />)
    expect(screen.getByText('-20.0%')).toBeInTheDocument()
  })

  it('omits the distance when no ticker is available for the symbol', () => {
    render(<OpenTradesWidget data={props({ orders: [order()] })} />)
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
  })

  it('strips the "exchange " prefix from the order type', () => {
    render(<OpenTradesWidget data={props({ orders: [order()] })} />)
    expect(screen.getByText('limit')).toBeInTheDocument()
  })
})

// ── Connection states ──────────────────────────────────────────────────────

describe('connection states', () => {
  it('shows LINKING… before the first poll resolves', () => {
    render(<OpenTradesWidget data={props({ snap: null, error: null })} />)
    expect(screen.getByText('LINKING…')).toBeInTheDocument()
  })

  it('surfaces a link error in crimson', () => {
    render(<OpenTradesWidget data={props({ snap: null, error: 'ECONNREFUSED' })} />)
    const el = screen.getByText(/link error · ECONNREFUSED/)
    expect(el).toBeInTheDocument()
    expect((el as HTMLElement).style.color).toBe(CR)
  })

  it('explains the empty state rather than showing a blank panel', () => {
    render(<OpenTradesWidget data={props()} />)
    expect(screen.getByText(/No open positions/)).toBeInTheDocument()
  })

  it('reports gemini offline when the snapshot says disconnected', () => {
    render(<OpenTradesWidget data={props({ snap: snapshot({ connected: false }) })} />)
    expect(screen.getByText('gemini offline')).toBeInTheDocument()
  })

  it('shows a relative sync time when connected', () => {
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z'))
    render(<OpenTradesWidget data={props({
      snap: snapshot({ connected: true, lastRefresh: Date.parse('2026-08-19T11:58:00Z') }),
    })} />)
    expect(screen.getByText('sync 2m ago')).toBeInTheDocument()
    vi.useRealTimers()
  })
})

// ── Multiple positions ─────────────────────────────────────────────────────

describe('multiple positions', () => {
  it('renders one row per position, each with its own P&L', () => {
    render(<OpenTradesWidget data={props({
      positions: [
        position({ key: 'a', base: 'BTC', last: 110 }),   // +10%
        position({ key: 'b', base: 'ETH', last: 90 }),    // −10%
      ],
      totalUnrealUsd: 0,
    })} />)

    expect(screen.getByText('BTC')).toBeInTheDocument()
    expect(screen.getByText('ETH')).toBeInTheDocument()
    expect(colorOf('+10.00%')).toBe(G)
    expect(colorOf('-10.00%')).toBe(CR)
  })
})
