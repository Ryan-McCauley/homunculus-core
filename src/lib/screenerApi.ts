// REST client for saved screeners and screening runs.
//
// Every call resolves rather than throwing: a screen that fails is a message the
// tab shows in place of results, not an exception the panel has to catch. Callers
// branch on `ok`.

import type {
  PartialGates, ScreenerDef, ScreenerResult, ScreenerTimeframe,
} from '../../shared/screener'

function apiBase(): string {
  const explicit = (window as unknown as { __HOMUNCULUS_API__?: string }).__HOMUNCULUS_API__
  if (explicit) return explicit.replace(/\/$/, '')
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:8787`
  return location.origin
}

function withToken(path: string): string {
  const q = new URLSearchParams(location.search)
  const t = q.get('token') || (window as unknown as { __HOMUNCULUS_TOKEN__?: string }).__HOMUNCULUS_TOKEN__ || ''
  if (!t) return path
  return path + (path.includes('?') ? '&' : '?') + `token=${encodeURIComponent(t)}`
}

async function call<T extends { ok: boolean }>(
  path: string, method: string, body?: unknown,
): Promise<T | { ok: false; error: string }> {
  try {
    const res = await fetch(`${apiBase()}${withToken(path)}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    return await res.json() as T
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'request failed' }
  }
}

const ROOT = '/api/crypto/screeners'

export interface ScreenerListResponse {
  ok: true
  screeners: ScreenerDef[]
  strategies: Array<{ id: string; label: string }>
}

export function fetchScreeners() {
  return call<ScreenerListResponse>(ROOT, 'GET')
}

export interface NewScreenerBody {
  name: string
  timeframe?: ScreenerTimeframe
  universe?: 'ALL' | 'HELD'
  gates?: PartialGates
  copyFromId?: string
  importStrategy?: string
}

export function createScreener(body: NewScreenerBody) {
  return call<{ ok: true; screener: ScreenerDef }>(ROOT, 'POST', body)
}

export function saveScreener(id: string, patch: Partial<ScreenerDef>) {
  return call<{ ok: true; screener: ScreenerDef }>(`${ROOT}/${encodeURIComponent(id)}`, 'PATCH', patch)
}

export function deleteScreener(id: string) {
  return call<{ ok: true }>(`${ROOT}/${encodeURIComponent(id)}`, 'DELETE')
}

/** Run a screener. Pass `draft` to screen unsaved rail edits — the server keeps the
 *  saved id regardless, so a draft can never report itself as another screener. */
export function runScreener(id: string, draft?: ScreenerDef) {
  return call<{ ok: true; result: ScreenerResult }>(
    `${ROOT}/${encodeURIComponent(id)}/run`, 'POST',
    draft ? { screener: draft } : {},
  )
}
