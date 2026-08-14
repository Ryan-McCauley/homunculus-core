// Node-to-node file sync — the rules.
//
// Every Homunculus install keeps its whole world in data/. Run the app on the
// desk PC and the laptop and the two drift apart: the ladder cycles advance on
// one, the office board on the other. This module decides what "sync" means so
// server/sync.ts can do it and Settings can show it.
//
// Three rules, and they are the whole design:
//
//   AREAS      Nothing syncs unless the operator ticked the area it belongs to.
//              A file that matches no area is not syncable at all — that is how
//              caches, backups and the sync config itself stay put.
//   NEWEST     When both sides have a file and the bytes differ, the newer mtime
//              wins. Same bytes, any mtime → already in agreement, no transfer.
//   NEVER DELETE
//              A file present on one side only is *copied*, never removed. A node
//              that has been offline for a month is behind, not authoritative, and
//              must not be able to reach across the tailnet and erase the desk.
//
// Deliberately missing: deletion propagation and three-way merge. Both need a
// history of what each node has seen, which is a sync engine, not a button. If a
// file should die it dies by hand on each node.

// ── Areas ──────────────────────────────────────────────────────────────────

/** One tickable group of files, matched by path relative to data/. */
export interface SyncAreaDef {
  id: string
  label: string
  hint: string
  /** Matched in order; the first area that claims a path owns it. */
  patterns: string[]
  /** Ticked for a fresh install. */
  defaultOn: boolean
}

/**
 * Order matters: OFFICE sits under data/crypto/ but is its own area, so it must
 * be offered a path before CRYPTO claims the whole subtree.
 */
export const SYNC_AREAS: SyncAreaDef[] = [
  {
    id: 'layout',
    label: 'LAYOUT',
    hint: 'Tab order, widget grids, first-run flag. Sync this and every node shows the same dashboard.',
    patterns: ['layout.json', 'setup.json'],
    defaultOn: true
  },
  {
    id: 'office',
    label: 'OFFICE',
    hint: 'HR records, cubicles, message board, blockers, the manager\'s file and the library.',
    patterns: ['crypto/office/**'],
    defaultOn: true
  },
  {
    id: 'crypto',
    label: 'CRYPTO',
    hint: 'Trades, closed trades, ladder cycles, cost basis, strategy settings, screeners, plan reports.',
    patterns: ['crypto/**'],
    defaultOn: true
  },
  {
    id: 'finance',
    label: 'FINANCE',
    hint: 'Budget and account files under data/finance.',
    patterns: ['finance/**'],
    defaultOn: true
  },
  {
    id: 'assets',
    label: 'ASSETS',
    hint: 'Asset register and its history.',
    patterns: ['assets/**'],
    defaultOn: true
  },
  {
    id: 'osint',
    label: 'OSINT',
    hint: 'Watch lists and the osint store.',
    patterns: ['osint-*.json'],
    defaultOn: true
  },
  {
    id: 'archive',
    label: 'ARCHIVE',
    hint: 'The archive event stream.',
    patterns: ['archive-events.json'],
    defaultOn: true
  },
  {
    id: 'reports',
    label: 'REPORTS',
    hint: 'Loose strategy and ladder reports written to the top of data/.',
    patterns: ['*.md'],
    defaultOn: true
  },
  {
    id: 'audit',
    label: 'AUDIT',
    hint: 'The audit log. Off by default: it is an append-only record of what happened '
      + 'on THIS node, and newest-wins would let one node\'s copy shadow the other\'s.',
    patterns: ['audit/**'],
    defaultOn: false
  }
]

/**
 * Never syncable, whatever the areas say.
 *
 * sync.json is first for a reason: it holds this node's peer list and peer
 * tokens. Syncing it would have every node overwrite its own identity with
 * whichever node wrote last, and would spray peer tokens across the tailnet.
 */
export const SYNC_EXCLUDES: string[] = [
  'sync.json',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.bak.json',
  '**/*.tmp',
  '**/candle-cache.json'
]

/** Glob support is deliberately tiny: `**` (any depth) and `*` (one segment). */
function globToRegExp(pattern: string): RegExp {
  let body = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      body += '(?:.*/)?'          // `**/x` matches a bare `x` too
      i += 3
    } else if (pattern.startsWith('**', i)) {
      body += '.*'
      i += 2
    } else if (pattern[i] === '*') {
      body += '[^/]*'
      i += 1
    } else {
      body += (pattern[i] as string).replace(/[.+^${}()|[\]\\?]/, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${body}$`)
}

function matchesAny(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(rel))
}

/** True for paths that are junk, volatile, or this node's own identity. */
export function isExcluded(rel: string): boolean {
  return matchesAny(rel, SYNC_EXCLUDES)
}

/** Which area owns this path, or null if nothing does (→ never synced). */
export function areaFor(rel: string): SyncAreaDef | null {
  if (isExcluded(rel)) return null
  return SYNC_AREAS.find((a) => matchesAny(rel, a.patterns)) ?? null
}

/** Whether a path is in scope for a given set of ticked areas. */
export function inSelectedAreas(rel: string, areas: readonly string[]): boolean {
  const area = areaFor(rel)
  return area !== null && areas.includes(area.id)
}

/**
 * Path safety for anything arriving over the wire. A peer names files by a path
 * relative to data/, and a hostile or buggy peer must not be able to name
 * `../../.ssh/id_rsa`. Windows nodes send `\` separators; those are normalised
 * before this check, so a `\` still here is a caller bug.
 */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.length > 1024) return false
  if (rel.includes('\0') || rel.includes('\\')) return false
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false
  return !rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
}

// ── Manifests and the diff ─────────────────────────────────────────────────

export interface SyncFileEntry {
  /** Relative to data/, always with `/` separators. */
  path: string
  size: number
  /** Epoch ms. */
  mtime: number
  /** sha256 hex of the contents. */
  hash: string
}

export interface SyncManifest {
  node: string
  at: number
  areas: string[]
  files: SyncFileEntry[]
}

export interface SyncPlan {
  /** On the peer and newer (or absent here) — fetch it. */
  pull: SyncFileEntry[]
  /** Here and newer (or absent there) — send it. */
  push: SyncFileEntry[]
  /** Same bytes on both sides. */
  identical: number
  /** Different bytes, mtimes too close to call. Left alone, reported up. */
  conflicts: SyncConflict[]
}

export interface SyncConflict {
  path: string
  localMtime: number
  remoteMtime: number
}

/**
 * mtimes come from two different machines with two different clocks and two
 * different filesystem granularities (exFAT rounds to 2s). Inside this window
 * "newer" is noise, so a genuine byte difference is reported instead of guessed.
 */
export const MTIME_TOLERANCE_MS = 2_000

/**
 * What this node should pull and push to agree with `remote`. Pure: it decides
 * from two manifests and touches nothing.
 *
 * Only files inside the ticked areas are considered, on BOTH sides — a peer that
 * offers a manifest wider than what we asked for gets the extra entries ignored
 * rather than trusted.
 */
export function diffManifests(
  local: SyncManifest,
  remote: SyncManifest,
  areas: readonly string[]
): SyncPlan {
  const eligible = (e: SyncFileEntry): boolean =>
    isSafeRelPath(e.path) && inSelectedAreas(e.path, areas)

  const localByPath = new Map(local.files.filter(eligible).map((f) => [f.path, f]))
  const remoteByPath = new Map(remote.files.filter(eligible).map((f) => [f.path, f]))

  const plan: SyncPlan = { pull: [], push: [], identical: 0, conflicts: [] }

  for (const [path, mine] of localByPath) {
    const theirs = remoteByPath.get(path)
    if (!theirs) { plan.push.push(mine); continue }          // never deleted, only copied
    if (theirs.hash === mine.hash) { plan.identical++; continue }
    const delta = mine.mtime - theirs.mtime
    if (Math.abs(delta) <= MTIME_TOLERANCE_MS) {
      plan.conflicts.push({ path, localMtime: mine.mtime, remoteMtime: theirs.mtime })
    } else if (delta > 0) plan.push.push(mine)
    else plan.pull.push(theirs)
  }

  for (const [path, theirs] of remoteByPath) {
    if (!localByPath.has(path)) plan.pull.push(theirs)
  }

  const byPath = (a: { path: string }, b: { path: string }): number => a.path.localeCompare(b.path)
  plan.pull.sort(byPath)
  plan.push.sort(byPath)
  plan.conflicts.sort(byPath)
  return plan
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface SyncPeer {
  id: string
  label: string
  /** Base URL of the peer's backend, e.g. http://desk-pc:8787 — no trailing slash. */
  url: string
  enabled: boolean
  /** Whether a token is stored for this peer. The token itself never leaves the server. */
  hasToken: boolean
}

export interface SyncConfig {
  peers: SyncPeer[]
  areas: string[]
  /** How this node names itself in a report. Cosmetic. */
  nodeName: string
  lastRunAt: number
}

export function defaultAreas(): string[] {
  return SYNC_AREAS.filter((a) => a.defaultOn).map((a) => a.id)
}

export function defaultSyncConfig(): SyncConfig {
  return { peers: [], areas: defaultAreas(), nodeName: '', lastRunAt: 0 }
}

/** The backend's default listen port, and so the default for a peer that was typed
 *  without one. Mirrors HOMUNCULUS_PORT in server/index.ts. */
export const DEFAULT_PEER_PORT = 8787

/** Trailing slashes and a missing scheme are the two things everyone types — and a
 *  missing port is the third. `macbook-pro-2` becomes `http://macbook-pro-2`, which
 *  is port 80, where nothing is listening; the sync then hangs until the request
 *  timeout and reports the bare word "fetch failed", pointing at the network rather
 *  than at the URL. Fill the port in instead.
 *
 *  Only for http:// — an https peer is behind a proxy or Tailscale Funnel that
 *  terminates TLS on 443, and forcing 8787 there would break a working URL. */
export function normalizePeerUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const clean = withScheme.replace(/\/+$/, '')
  if (!/^http:\/\//i.test(clean)) return clean

  // Read the port off the string rather than through URL: `new URL()` drops :80 as
  // the protocol default, so someone who deliberately typed it would get 8787 back.
  const start = clean.indexOf('://') + 3
  const authority = clean.slice(start).split(/[/?#]/)[0]
  if (/:\d+$/.test(authority)) return clean          // ends in :digits — a real port
  if (!authority) return clean                       // scheme with no host; not ours to fix

  const end = start + authority.length
  return `${clean.slice(0, end)}:${DEFAULT_PEER_PORT}${clean.slice(end)}`
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** A malformed POST degrades to something usable rather than persisting garbage. */
export function sanitizeSyncConfig(raw: unknown): SyncConfig {
  const src = (raw ?? {}) as Record<string, unknown>
  const rawPeers = Array.isArray(src['peers']) ? src['peers'] : []
  const seen = new Set<string>()
  const peers: SyncPeer[] = []

  for (const [i, entry] of rawPeers.entries()) {
    const p = (entry ?? {}) as Record<string, unknown>
    const url = normalizePeerUrl(str(p['url']))
    if (!url) continue
    const id = str(p['id']) || `peer-${i + 1}`
    if (seen.has(id)) continue
    seen.add(id)
    peers.push({
      id,
      label: str(p['label']) || url.replace(/^https?:\/\//, ''),
      url,
      enabled: p['enabled'] !== false,
      hasToken: p['hasToken'] === true
    })
  }

  const known = new Set(SYNC_AREAS.map((a) => a.id))
  const rawAreas = Array.isArray(src['areas']) ? src['areas'] : null
  const areas = rawAreas === null
    ? defaultAreas()
    : Array.from(new Set(rawAreas.filter((a): a is string => typeof a === 'string' && known.has(a))))

  const lastRunAt = typeof src['lastRunAt'] === 'number' && Number.isFinite(src['lastRunAt'])
    ? src['lastRunAt']
    : 0

  return { peers, areas, nodeName: str(src['nodeName']).slice(0, 60), lastRunAt }
}

// ── Reports ────────────────────────────────────────────────────────────────

export interface PeerSyncReport {
  peerId: string
  label: string
  url: string
  ok: boolean
  error: string
  pulled: number
  pushed: number
  identical: number
  failed: { path: string; error: string }[]
  conflicts: SyncConflict[]
  ms: number
}

export interface SyncRunReport {
  at: number
  areas: string[]
  peers: PeerSyncReport[]
}

/** One line per peer for the Settings panel. */
export function summarizePeer(r: PeerSyncReport): string {
  if (!r.ok) return `${r.label}: FAILED — ${r.error}`
  const bits = [`↓${r.pulled}`, `↑${r.pushed}`, `=${r.identical}`]
  if (r.conflicts.length) bits.push(`⚠${r.conflicts.length} too-close-to-call`)
  if (r.failed.length) bits.push(`✕${r.failed.length} failed`)
  return `${r.label}: ${bits.join('  ')}`
}
