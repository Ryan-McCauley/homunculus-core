// REST helpers for the history ("Worldline") database. The backend serves the
// /api/history/* endpoints (server/index.ts) over plain HTTP on the same origin
// as the WS — :8787 in dev (vite is on 5173), same host otherwise. Mirrors the
// base-resolution logic in transport.ts.

export type HistoryPoint = { ts: number; value: number | null }

function apiBase(): string {
  const explicit = (window as any).__HOMUNCULUS_API__ as string | undefined
  if (explicit) return explicit.replace(/\/$/, '')
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:8787`
  return location.origin
}

// The /api/history/* routes are token-gated for non-localhost callers (same as
// the finance/crypto routes), so a remote surface — the tailnet phone/browser
// view — must present the token or the DATA dashboard 401s. Sent as a header
// rather than a query param: the value never lands in a URL, server log, or the
// browser history the way ?token= does. Mirrors the token resolution the other
// lib/*Api.ts helpers use; localhost (no token configured) sends nothing and is
// waived server-side.
function token(): string {
  const q = new URLSearchParams(location.search)
  return q.get('token') || (window as any).__HOMUNCULUS_TOKEN__ || ''
}

async function getJson<T>(path: string): Promise<T> {
  const t = token()
  const res = await fetch(`${apiBase()}${path}`, t ? { headers: { 'x-homunculus-token': t } } : undefined)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/** Fetch a telemetry metric time-series between two epoch-ms bounds. */
export async function fetchTelemetryHistory(
  metric: string,
  fromMs: number,
  toMs: number,
  limit = 1000
): Promise<HistoryPoint[]> {
  const q = `metric=${encodeURIComponent(metric)}&from=${fromMs}&to=${toMs}&limit=${limit}`
  const data = await getJson<{ metric: string; points: HistoryPoint[] }>(`/api/history/telemetry?${q}`)
  return data.points ?? []
}

/** Fetch a Home-Assistant entity's numeric history between two epoch-ms bounds. */
export async function fetchHaHistory(
  entityId: string,
  fromMs: number,
  toMs: number,
  limit = 1000
): Promise<HistoryPoint[]> {
  const q = `entity_id=${encodeURIComponent(entityId)}&from=${fromMs}&to=${toMs}&limit=${limit}`
  const data = await getJson<{ entity_id: string; points: HistoryPoint[] }>(`/api/history/ha?${q}`)
  return data.points ?? []
}

/** List all HA entity IDs that have any history captured. */
export async function fetchHaEntities(): Promise<string[]> {
  const data = await getJson<{ entities: string[] }>(`/api/history/entities`)
  return data.entities ?? []
}
