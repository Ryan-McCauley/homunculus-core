// Node-to-node file sync — the moving parts.
//
// shared/sync.ts holds the rules (what is in scope, who wins); this holds the
// disk and the wire. One button in Settings → SYNC calls runSync(), which for
// each enabled peer:
//
//   1. GET  <peer>/api/sync/manifest   — path, size, mtime, sha256 for every
//                                        in-scope file the peer holds
//   2. diff against our own manifest   — shared/sync.ts, newest-mtime-wins
//   3. GET  <peer>/api/sync/file       — for each file they hold newer
//   4. POST <peer>/api/sync/file       — for each file we hold newer
//
// The peer is another Homunculus backend on the tailnet, so the transport is the
// REST API that is already there and already token-gated. Nothing new is exposed
// to the internet: reaching these routes means being on the tailnet AND holding
// HOMUNCULUS_TOKEN, same as the finance routes.
//
// Two things this module is careful about, both learned from the shape of the
// data rather than from paranoia:
//
//   PATHS  Every path that arrives over the wire is checked with isSafeRelPath
//          and re-resolved under DATA_DIR before it is opened. A peer names
//          files; it never names locations.
//   MTIMES A pulled file is stamped with the SOURCE mtime, not now(). Stamping
//          it now() would make this node look authoritative on the next run and
//          push the same bytes back — the classic sync ping-pong.

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { stateStore } from './stateStore'
import { auditLog } from './auditLog'
import {
  areaFor, defaultSyncConfig, diffManifests, isSafeRelPath, sanitizeSyncConfig,
  type PeerSyncReport, type SyncConfig, type SyncFileEntry, type SyncManifest, type SyncPeer,
  type SyncRunReport
} from '../shared/sync'

const DATA_DIR = process.env['HOMUNCULUS_DATA_DIR'] || join(process.cwd(), 'data')
const CONFIG_FILE = join(DATA_DIR, 'sync.json')

/** A single file bigger than this is skipped rather than buffered into memory.
 *  Nothing in data/ is close; a file that is, is a mistake worth reporting. */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/** Per-request ceiling. A sleeping tailnet node should fail the run, not hang it. */
const REQUEST_TIMEOUT_MS = 20_000

/** Peer tokens live beside the config but never leave the server. */
interface PersistShape extends Omit<SyncConfig, 'peers'> {
  peers: (SyncPeer & { hasToken?: boolean })[]
  tokens: Record<string, string>
}

// ── config ─────────────────────────────────────────────────────────────────

let cache: PersistShape | null = null

function load(): PersistShape {
  if (cache) return cache
  let raw: unknown = {}
  try {
    if (existsSync(CONFIG_FILE)) raw = stateStore.readJson<unknown>(CONFIG_FILE, {})
  } catch (err) {
    console.warn('[sync] unreadable sync.json, starting fresh:', (err as Error).message)
  }
  const tokens = (raw as { tokens?: unknown })?.tokens
  const base = sanitizeSyncConfig(raw)
  cache = {
    ...base,
    nodeName: base.nodeName || hostname(),
    tokens: typeof tokens === 'object' && tokens !== null ? { ...(tokens as Record<string, string>) } : {}
  }
  // hasToken is derived, never trusted from disk.
  cache.peers = cache.peers.map((p) => ({ ...p, hasToken: Boolean(cache?.tokens[p.id]) }))
  return cache
}

function persist(next: PersistShape): void {
  cache = next
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    stateStore.writeJson(CONFIG_FILE, next)
  } catch (err) {
    console.warn('[sync] write failed:', (err as Error).message)
  }
}

/** The config as the UI may see it — peer tokens replaced by a boolean. */
export function getSyncConfig(): SyncConfig {
  const c = load()
  return {
    peers: c.peers.map((p) => ({
      id: p.id, label: p.label, url: p.url, enabled: p.enabled, hasToken: Boolean(c.tokens[p.id])
    })),
    areas: [...c.areas],
    nodeName: c.nodeName,
    lastRunAt: c.lastRunAt
  }
}

/**
 * Replace the config. Peer tokens are write-only, exactly like the key vault:
 * a peer entry may carry `token` to set one and `clearToken: true` to drop one,
 * and anything else leaves the stored token alone. Tokens for peers that have
 * been removed are dropped with them.
 */
export function setSyncConfig(raw: unknown): SyncConfig {
  const current = load()
  const next = sanitizeSyncConfig(raw)
  const incoming = Array.isArray((raw as { peers?: unknown })?.peers)
    ? ((raw as { peers: Record<string, unknown>[] }).peers)
    : []

  const tokens: Record<string, string> = {}
  for (const peer of next.peers) {
    const sent = incoming.find((p) => String(p['id'] ?? '') === peer.id)
    const supplied = typeof sent?.['token'] === 'string' ? (sent['token'] as string).trim() : ''
    if (sent?.['clearToken'] === true) continue
    if (supplied) tokens[peer.id] = supplied
    else if (current.tokens[peer.id]) tokens[peer.id] = current.tokens[peer.id] as string
  }

  persist({
    ...next,
    nodeName: next.nodeName || current.nodeName || hostname(),
    lastRunAt: current.lastRunAt,
    tokens,
    peers: next.peers.map((p) => ({ ...p, hasToken: Boolean(tokens[p.id]) }))
  })
  return getSyncConfig()
}

// ── local manifest ─────────────────────────────────────────────────────────

/** Absolute path for a peer-supplied relative path, or null if it is not ours to touch. */
export function resolveSyncPath(rel: string): string | null {
  if (!isSafeRelPath(rel)) return null
  const root = resolve(DATA_DIR)
  const abs = resolve(root, rel)
  // Belt and braces: isSafeRelPath already rejects traversal, but the only check
  // that survives a symlinked or oddly-cased data dir is the resolved prefix.
  if (abs === root || !abs.startsWith(root + sep)) return null
  return abs
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs, out)
    else if (e.isFile()) out.push(abs)
  }
  return out
}

function toRel(abs: string): string {
  return relative(DATA_DIR, abs).split(sep).join('/')
}

/** Every in-scope file on this node, hashed. Areas default to the configured set. */
export function buildManifest(areas?: readonly string[]): SyncManifest {
  const cfg = load()
  const selected = areas ? areas.filter((a) => cfg.areas.includes(a)) : cfg.areas
  const files: SyncFileEntry[] = []

  for (const abs of walk(DATA_DIR)) {
    const rel = toRel(abs)
    const area = areaFor(rel)
    if (!area || !selected.includes(area.id)) continue
    try {
      const st = statSync(abs)
      if (st.size > MAX_FILE_BYTES) {
        console.warn(`[sync] skipping ${rel} — ${Math.round(st.size / 1e6)}MB over the transfer cap`)
        continue
      }
      files.push({
        path: rel,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        hash: createHash('sha256').update(readFileSync(abs)).digest('hex')
      })
    } catch (err) {
      console.warn(`[sync] cannot read ${rel}:`, (err as Error).message)
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { node: cfg.nodeName, at: Date.now(), areas: [...selected], files }
}

/** Serve one file to a peer. Refuses anything outside the enabled areas. */
export function readSyncFile(rel: string): { ok: true; content: string; mtime: number } | { ok: false; error: string } {
  const abs = resolveSyncPath(rel)
  if (!abs) return { ok: false, error: 'unsafe path' }
  const area = areaFor(rel)
  if (!area) return { ok: false, error: 'path is not in any sync area' }
  if (!load().areas.includes(area.id)) return { ok: false, error: `area ${area.id} is not enabled on this node` }
  if (!existsSync(abs)) return { ok: false, error: 'not found' }
  try {
    const st = statSync(abs)
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'over the transfer cap' }
    return { ok: true, content: readFileSync(abs).toString('base64'), mtime: Math.round(st.mtimeMs) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Accept one file from a peer. Same area gate as the read side: each node
 * decides what it will hold, so a peer cannot push an area this node has
 * switched off.
 *
 * Written to a sibling temp file and renamed, so a dropped connection leaves the
 * old file intact rather than a half-written one.
 */
export function writeSyncFile(rel: string, contentBase64: string, mtime: number): { ok: true } | { ok: false; error: string } {
  const abs = resolveSyncPath(rel)
  if (!abs) return { ok: false, error: 'unsafe path' }
  const area = areaFor(rel)
  if (!area) return { ok: false, error: 'path is not in any sync area' }
  if (!load().areas.includes(area.id)) return { ok: false, error: `area ${area.id} is not enabled on this node` }

  let buf: Buffer
  try {
    buf = Buffer.from(String(contentBase64 ?? ''), 'base64')
  } catch {
    return { ok: false, error: 'bad payload' }
  }
  if (buf.byteLength > MAX_FILE_BYTES) return { ok: false, error: 'over the transfer cap' }

  const tmp = `${abs}.sync-${process.pid}.tmp`
  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(tmp, buf)
    renameSync(tmp, abs)
    // Carry the source mtime across, or the next run pushes these bytes back.
    if (Number.isFinite(mtime) && mtime > 0) {
      const secs = mtime / 1000
      utimesSync(abs, secs, secs)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── talking to a peer ──────────────────────────────────────────────────────

async function peerFetch(
  peer: SyncPeer, token: string, path: string, init: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`${peer.url}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-homunculus-token': token } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!res.ok) {
    const hint = res.status === 401 ? ' (peer needs its HOMUNCULUS_TOKEN set here)' : ''
    throw new Error(`HTTP ${res.status}${hint}`)
  }
  return await res.json()
}

async function syncPeer(peer: SyncPeer, token: string, areas: string[]): Promise<PeerSyncReport> {
  const started = Date.now()
  const report: PeerSyncReport = {
    peerId: peer.id, label: peer.label, url: peer.url, ok: false, error: '',
    pulled: 0, pushed: 0, identical: 0, failed: [], conflicts: [], ms: 0
  }

  try {
    const query = `?areas=${encodeURIComponent(areas.join(','))}`
    const remote = await peerFetch(peer, token, `/api/sync/manifest${query}`) as { ok?: boolean; manifest?: SyncManifest; error?: string }
    if (!remote?.ok || !remote.manifest) throw new Error(remote?.error || 'peer returned no manifest')

    const plan = diffManifests(buildManifest(areas), remote.manifest, areas)
    report.identical = plan.identical
    report.conflicts = plan.conflicts

    for (const file of plan.pull) {
      try {
        const got = await peerFetch(peer, token, `/api/sync/file?path=${encodeURIComponent(file.path)}`) as
          { ok?: boolean; content?: string; mtime?: number; error?: string }
        if (!got?.ok || typeof got.content !== 'string') throw new Error(got?.error || 'peer refused the file')
        const written = writeSyncFile(file.path, got.content, got.mtime ?? file.mtime)
        if (!written.ok) throw new Error(written.error)
        report.pulled++
      } catch (err) {
        report.failed.push({ path: file.path, error: (err as Error).message })
      }
    }

    for (const file of plan.push) {
      try {
        const local = readSyncFile(file.path)
        if (!local.ok) throw new Error(local.error)
        const sent = await peerFetch(peer, token, '/api/sync/file', {
          method: 'POST',
          body: JSON.stringify({ path: file.path, content: local.content, mtime: local.mtime })
        }) as { ok?: boolean; error?: string }
        if (!sent?.ok) throw new Error(sent?.error || 'peer refused the write')
        report.pushed++
      } catch (err) {
        report.failed.push({ path: file.path, error: (err as Error).message })
      }
    }

    report.ok = true
  } catch (err) {
    report.error = (err as Error).message
  }

  report.ms = Date.now() - started
  return report
}

/**
 * The button. Syncs every enabled peer, in order, and reports per peer.
 *
 * Peers are done one at a time on purpose: two peers pulling the same file
 * concurrently would race on the rename, and a run over a handful of nodes on a
 * LAN-speed tailnet is seconds either way.
 */
export async function runSync(): Promise<SyncRunReport> {
  const cfg = load()
  const areas = [...cfg.areas]
  const enabled = cfg.peers.filter((p) => p.enabled)
  const at = Date.now()

  console.log(`[sync] run: ${enabled.length} peer(s), areas: ${areas.join(', ') || 'none'}`)

  const peers: PeerSyncReport[] = []
  for (const peer of enabled) {
    const r = await syncPeer(peer, cfg.tokens[peer.id] ?? '', areas)
    peers.push(r)
    console.log(`[sync] ${r.label}: ${r.ok ? `↓${r.pulled} ↑${r.pushed} =${r.identical}` : `FAILED ${r.error}`} in ${r.ms}ms`)
  }

  persist({ ...cfg, lastRunAt: at })

  auditLog.note({
    action: 'sync.run',
    resource: 'data',
    summary: `synced ${peers.length} peer(s): ${peers.map((p) => `${p.label} ↓${p.pulled} ↑${p.pushed}`).join('; ') || 'none configured'}`,
    after: { areas, peers: peers.map((p) => ({ label: p.label, ok: p.ok, pulled: p.pulled, pushed: p.pushed, error: p.error })) }
  })

  return { at, areas, peers }
}

/** Test seam — the config is read once and cached, same as layout.ts. */
export function __resetSyncCacheForTests(): void {
  cache = null
}

export { defaultSyncConfig }
