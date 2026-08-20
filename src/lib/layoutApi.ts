// REST helpers for the layout + secrets + setup endpoints. Mirrors the
// base/token resolution in lib/api.ts and transport.ts.

import type { LayoutConfig } from '../../shared/layout'
import type { HomeTilesConfig } from '../../shared/homeTiles'
import type { SecretSpec, SecretStatus, SecretsCapability } from '../../shared/secrets'
import type { SyncAreaDef, SyncConfig, SyncPeer, SyncRunReport } from '../../shared/sync'

function apiBase(): string {
  const explicit = (window as any).__HOMUNCULUS_API__ as string | undefined
  if (explicit) return explicit.replace(/\/$/, '')
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:8787`
  return location.origin
}

/** The layout and secrets routes are token-gated for remote callers, the same
 *  way finance/crypto are. Reuse the token already in the page URL. */
function withToken(path: string): string {
  const token = new URLSearchParams(location.search).get('token')
    || (window as any).__HOMUNCULUS_TOKEN__ || ''
  if (!token) return `${apiBase()}${path}`
  return `${apiBase()}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(withToken(path))
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(withToken(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const fetchLayout = async (): Promise<LayoutConfig> =>
  (await get<{ layout: LayoutConfig }>('/api/layout')).layout

export const saveLayout = async (layout: LayoutConfig): Promise<LayoutConfig> =>
  (await post<{ layout: LayoutConfig }>('/api/layout', { layout })).layout

export const resetLayout = async (): Promise<LayoutConfig> =>
  (await post<{ layout: LayoutConfig }>('/api/layout/reset')).layout

export interface SecretsView {
  specs: SecretSpec[]
  secrets: SecretStatus[]
  modules: Record<string, boolean>
  capability: SecretsCapability
}

export const fetchSecrets = (): Promise<SecretsView> => get<SecretsView>('/api/secrets')

export const fetchSetupComplete = async (): Promise<boolean> =>
  (await get<{ complete: boolean }>('/api/setup')).complete

export const setSetupComplete = (complete: boolean): Promise<{ complete: boolean }> =>
  post('/api/setup', { complete })

// ── Node sync ──────────────────────────────────────────────────────────────

/** What a peer save may carry beyond the stored shape: `token` sets one,
 *  `clearToken` drops one. Neither ever comes back down. */
export interface SyncPeerInput extends Omit<SyncPeer, 'hasToken'> {
  /** Server-derived, and absent on a peer the operator has only just added. */
  hasToken?: boolean
  token?: string
  clearToken?: boolean
}

export interface SyncConfigView {
  config: SyncConfig
  areas: SyncAreaDef[]
}

export const fetchSyncConfig = (): Promise<SyncConfigView> =>
  get<{ config: SyncConfig; areas: SyncAreaDef[] }>('/api/sync/config')

export const saveSyncConfig = async (
  config: { peers: SyncPeerInput[]; areas: string[] }
): Promise<SyncConfig> =>
  (await post<{ config: SyncConfig }>('/api/sync/config', { config })).config

export const runSync = async (): Promise<SyncRunReport> =>
  (await post<{ report: SyncRunReport }>('/api/sync/run')).report

// ── Home tiles ─────────────────────────────────────────────────────────────

export const fetchHomeTiles = async (): Promise<HomeTilesConfig> =>
  (await get<{ config: HomeTilesConfig }>('/api/home-tiles')).config

export const saveHomeTiles = async (config: HomeTilesConfig): Promise<HomeTilesConfig> =>
  (await post<{ config: HomeTilesConfig }>('/api/home-tiles', { config })).config

/** Add tiles for devices that appeared since setup, keeping the rest untouched. */
export const rescanHomeTiles = async (): Promise<HomeTilesConfig> =>
  (await post<{ config: HomeTilesConfig }>('/api/home-tiles/rescan')).config

/** Discard the configuration and rebuild it from the house as it is now. */
export const resetHomeTiles = async (): Promise<HomeTilesConfig> =>
  (await post<{ config: HomeTilesConfig }>('/api/home-tiles/reset')).config
