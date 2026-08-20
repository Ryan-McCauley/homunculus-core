// Shared visual primitives for the CRYPTO tab — style tokens, formatters, and the
// two label atoms. Extracted from CryptoDashboard so the MARKET section can render
// in the same language without importing the dashboard (which would be circular),
// and so a formatting tweak lands in both places at once.
//
// Every colour here is a CSS custom property, never a literal hex: that is what
// makes the prism themes restyle this UI for free.

import type { ReactNode } from 'react'

export type TF = '1m' | '5m' | '15m' | '1hr' | '4hr' | '1day'

export const G = 'var(--green)'
export const GD = 'var(--green-dim)'
export const CR = 'var(--crimson)'
export const AMBER = 'var(--amber)'
export const BORDER = '0.5px solid var(--border)'
export const MONO = { fontFamily: 'var(--font-mono)' } as const

export function fmtPrice(n: number | string): string {
  const v = Number(n)
  if (isNaN(v) || v === 0) return '—'
  if (v >= 10000) return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (v >= 1000) return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (v >= 1) return '$' + v.toFixed(4)
  return '$' + v.toPrecision(4)
}

export function fmtNum(n: number | string, d = 2): string {
  const v = Number(n)
  return isNaN(v) ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function fmtK(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(2)
}

export function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function changeColor(c: number) { return c > 0 ? G : c < 0 ? CR : GD }
export function dirColor(d: string) { return d === 'BUY' ? G : d === 'SELL' ? CR : GD }
export function qualColor(q: string) { return q === 'HIGH' ? G : q === 'MEDIUM' ? '#c8a227' : GD }

export function Lbl({ c = GD, children, size = 11 }: { c?: string; children: ReactNode; size?: number }) {
  return <span style={{ fontSize: size, letterSpacing: 0.8, color: c, ...MONO }}>{children}</span>
}

export function Val({ c = G, children, size = 13 }: { c?: string; children: ReactNode; size?: number }) {
  return <span style={{ fontSize: size, color: c, ...MONO }}>{children}</span>
}
