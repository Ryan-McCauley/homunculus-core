import { describe, it, expect } from 'vitest'
import {
  MTIME_TOLERANCE_MS, SYNC_AREAS, areaFor, defaultAreas, defaultSyncConfig, diffManifests,
  inSelectedAreas, isExcluded, isSafeRelPath, normalizePeerUrl, sanitizeSyncConfig, summarizePeer,
  type PeerSyncReport, type SyncFileEntry, type SyncManifest
} from './sync'

// ── fixtures ───────────────────────────────────────────────────────────────

function entry(over: Partial<SyncFileEntry> & { path: string }): SyncFileEntry {
  return { size: 10, mtime: 1_000_000, hash: 'aaa', ...over }
}

function manifest(files: SyncFileEntry[], over: Partial<SyncManifest> = {}): SyncManifest {
  return { node: 'node', at: 0, areas: ALL, files, ...over }
}

const ALL = SYNC_AREAS.map((a) => a.id)

// ── areas ──────────────────────────────────────────────────────────────────

describe('areaFor', () => {
  it('puts the office subtree in OFFICE, not CRYPTO', () => {
    expect(areaFor('crypto/office/managers-file.json')?.id).toBe('office')
    expect(areaFor('crypto/office/library/note.md')?.id).toBe('office')
  })

  it('claims the rest of the crypto tree for CRYPTO', () => {
    expect(areaFor('crypto/closed-trades.json')?.id).toBe('crypto')
    expect(areaFor('crypto/plan-reports/2026-08-01.json')?.id).toBe('crypto')
  })

  it('matches the top-level singles', () => {
    expect(areaFor('layout.json')?.id).toBe('layout')
    expect(areaFor('setup.json')?.id).toBe('layout')
    expect(areaFor('archive-events.json')?.id).toBe('archive')
    expect(areaFor('osint-pizza.json')?.id).toBe('osint')
    expect(areaFor('btc-ladder-report-2026-07-28.md')?.id).toBe('reports')
  })

  it('keeps *.md at the top level out of the nested trees', () => {
    // A report inside data/crypto belongs to CRYPTO, not REPORTS.
    expect(areaFor('crypto/btc-ladder-report-2026-08-03.md')?.id).toBe('crypto')
  })

  it('returns null for anything no area claims', () => {
    expect(areaFor('mystery.txt')).toBeNull()
    expect(areaFor('nested/unknown/file.json')).toBeNull()
  })

  it('returns null for excluded paths even inside a ticked area', () => {
    expect(areaFor('crypto/.DS_Store')).toBeNull()
    expect(areaFor('crypto/candle-cache.json')).toBeNull()
    expect(areaFor('crypto/btc-ladder-cycles.20260721T173821Z.bak.json')).toBeNull()
  })
})

describe('isExcluded', () => {
  it('never syncs the sync config itself — it holds this node peer list and tokens', () => {
    expect(isExcluded('sync.json')).toBe(true)
  })

  it('catches junk at any depth', () => {
    expect(isExcluded('.DS_Store')).toBe(true)
    expect(isExcluded('crypto/office/.DS_Store')).toBe(true)
    expect(isExcluded('crypto/x.tmp')).toBe(true)
  })

  it('leaves real files alone', () => {
    expect(isExcluded('crypto/trades.json')).toBe(false)
    expect(isExcluded('layout.json')).toBe(false)
  })
})

describe('inSelectedAreas', () => {
  it('is false when the owning area is not ticked', () => {
    expect(inSelectedAreas('crypto/trades.json', ['layout'])).toBe(false)
    expect(inSelectedAreas('crypto/trades.json', ['crypto'])).toBe(true)
  })

  it('ticking CRYPTO does not drag the office along', () => {
    expect(inSelectedAreas('crypto/office/blockers.json', ['crypto'])).toBe(false)
  })
})

describe('defaultAreas', () => {
  it('ships everything on except the audit log', () => {
    expect(defaultAreas()).not.toContain('audit')
    expect(defaultAreas()).toContain('crypto')
    expect(defaultSyncConfig().peers).toEqual([])
  })
})

// ── path safety ────────────────────────────────────────────────────────────

describe('isSafeRelPath', () => {
  it('accepts ordinary relative paths', () => {
    expect(isSafeRelPath('crypto/office/library/a.md')).toBe(true)
  })

  it('rejects traversal, absolutes, drive letters, backslashes and NUL', () => {
    for (const bad of [
      '../secrets.json', 'crypto/../../etc/passwd', '/etc/passwd', 'C:/Windows/x',
      'crypto\\trades.json', 'a\0b', '', 'crypto//trades.json', './x.json'
    ]) {
      expect(isSafeRelPath(bad), bad).toBe(false)
    }
  })
})

// ── diff ───────────────────────────────────────────────────────────────────

describe('diffManifests', () => {
  it('pulls what only the peer has and pushes what only we have', () => {
    const plan = diffManifests(
      manifest([entry({ path: 'crypto/trades.json' })]),
      manifest([entry({ path: 'layout.json' })]),
      ALL
    )
    expect(plan.push.map((f) => f.path)).toEqual(['crypto/trades.json'])
    expect(plan.pull.map((f) => f.path)).toEqual(['layout.json'])
  })

  it('never proposes a delete — an absent file is a copy, in either direction', () => {
    const plan = diffManifests(
      manifest([entry({ path: 'crypto/trades.json' })]),
      manifest([]),
      ALL
    )
    expect(plan.pull).toEqual([])
    expect(plan.push).toHaveLength(1)
    expect(plan.conflicts).toEqual([])
  })

  it('counts equal hashes as identical whatever the mtimes say', () => {
    const plan = diffManifests(
      manifest([entry({ path: 'layout.json', hash: 'same', mtime: 5_000_000 })]),
      manifest([entry({ path: 'layout.json', hash: 'same', mtime: 1_000 })]),
      ALL
    )
    expect(plan.identical).toBe(1)
    expect(plan.pull).toEqual([])
    expect(plan.push).toEqual([])
  })

  it('newest mtime wins when the bytes differ', () => {
    const older = manifest([entry({ path: 'layout.json', hash: 'old', mtime: 1_000_000 })])
    const newer = manifest([entry({ path: 'layout.json', hash: 'new', mtime: 9_000_000 })])
    expect(diffManifests(older, newer, ALL).pull.map((f) => f.hash)).toEqual(['new'])
    expect(diffManifests(newer, older, ALL).push.map((f) => f.hash)).toEqual(['new'])
  })

  it('reports a conflict instead of guessing when mtimes are within tolerance', () => {
    const plan = diffManifests(
      manifest([entry({ path: 'layout.json', hash: 'a', mtime: 1_000_000 })]),
      manifest([entry({ path: 'layout.json', hash: 'b', mtime: 1_000_000 + MTIME_TOLERANCE_MS })]),
      ALL
    )
    expect(plan.pull).toEqual([])
    expect(plan.push).toEqual([])
    expect(plan.conflicts).toEqual([
      { path: 'layout.json', localMtime: 1_000_000, remoteMtime: 1_000_000 + MTIME_TOLERANCE_MS }
    ])
  })

  it('ignores files outside the ticked areas on both sides', () => {
    const plan = diffManifests(
      manifest([entry({ path: 'crypto/trades.json' }), entry({ path: 'layout.json' })]),
      manifest([entry({ path: 'finance/budget.json' })]),
      ['layout']
    )
    expect(plan.push.map((f) => f.path)).toEqual(['layout.json'])
    expect(plan.pull).toEqual([])
  })

  it('ignores unsafe paths a peer offers, however tempting the area', () => {
    const plan = diffManifests(
      manifest([]),
      manifest([entry({ path: '../../.ssh/id_rsa' }), entry({ path: 'crypto/../sync.json' })]),
      ALL
    )
    expect(plan.pull).toEqual([])
  })

  it('ignores the peer sync.json even when it offers one', () => {
    const plan = diffManifests(manifest([]), manifest([entry({ path: 'sync.json' })]), ALL)
    expect(plan.pull).toEqual([])
  })

  it('sorts each list by path so a run reads the same twice', () => {
    const plan = diffManifests(
      manifest([entry({ path: 'crypto/z.json' }), entry({ path: 'crypto/a.json' })]),
      manifest([]),
      ALL
    )
    expect(plan.push.map((f) => f.path)).toEqual(['crypto/a.json', 'crypto/z.json'])
  })
})

// ── config ─────────────────────────────────────────────────────────────────

describe('normalizePeerUrl', () => {
  it('adds the scheme and drops trailing slashes', () => {
    expect(normalizePeerUrl('desk-pc:8787')).toBe('http://desk-pc:8787')
    expect(normalizePeerUrl('http://desk-pc:8787/')).toBe('http://desk-pc:8787')
    expect(normalizePeerUrl('https://laptop.tail1234.ts.net//')).toBe('https://laptop.tail1234.ts.net')
    expect(normalizePeerUrl('  ')).toBe('')
  })

  it('fills in the backend port when http and none was typed', () => {
    // The bare hostname is what everyone types, and port 80 is where nothing listens.
    expect(normalizePeerUrl('macbook-pro-2')).toBe('http://macbook-pro-2:8787')
    expect(normalizePeerUrl('http://macbook-pro-2/')).toBe('http://macbook-pro-2:8787')
    expect(normalizePeerUrl('mothership.tail8a742d.ts.net')).toBe('http://mothership.tail8a742d.ts.net:8787')
    expect(normalizePeerUrl('100.120.142.60')).toBe('http://100.120.142.60:8787')
  })

  it('never overrides a port that was given', () => {
    expect(normalizePeerUrl('desk-pc:9000')).toBe('http://desk-pc:9000')
    // :80 is the http default, so URL parsing hides it — the port must be read
    // off the string or a deliberately typed :80 silently becomes :8787.
    expect(normalizePeerUrl('http://desk-pc:80')).toBe('http://desk-pc:80')
    expect(normalizePeerUrl('http://[::1]:8787')).toBe('http://[::1]:8787')
  })

  it('leaves https alone — TLS terminates on 443, not on the backend port', () => {
    expect(normalizePeerUrl('https://laptop.tail1234.ts.net')).toBe('https://laptop.tail1234.ts.net')
    expect(normalizePeerUrl('https://laptop.tail1234.ts.net:8787')).toBe('https://laptop.tail1234.ts.net:8787')
  })
})

describe('sanitizeSyncConfig', () => {
  it('fills defaults from nothing', () => {
    const c = sanitizeSyncConfig(undefined)
    expect(c.peers).toEqual([])
    expect(c.areas).toEqual(defaultAreas())
  })

  it('drops peers with no usable url and de-dupes ids', () => {
    const c = sanitizeSyncConfig({
      peers: [
        { id: 'a', url: 'desk-pc:8787' },
        { id: 'a', url: 'other:8787' },
        { id: 'b', url: '   ' }
      ]
    })
    expect(c.peers.map((p) => p.id)).toEqual(['a'])
    expect(c.peers[0]?.url).toBe('http://desk-pc:8787')
  })

  it('labels a peer by host when none is given, and defaults enabled to true', () => {
    const c = sanitizeSyncConfig({ peers: [{ id: 'a', url: 'http://laptop:8787' }] })
    expect(c.peers[0]?.label).toBe('laptop:8787')
    expect(c.peers[0]?.enabled).toBe(true)
  })

  it('keeps an explicit empty area list — that means "sync nothing"', () => {
    expect(sanitizeSyncConfig({ areas: [] }).areas).toEqual([])
  })

  it('discards unknown area ids', () => {
    expect(sanitizeSyncConfig({ areas: ['crypto', 'nonsense'] }).areas).toEqual(['crypto'])
  })
})

// ── report ─────────────────────────────────────────────────────────────────

describe('summarizePeer', () => {
  const base: PeerSyncReport = {
    peerId: 'a', label: 'desk-pc', url: 'http://desk-pc:8787', ok: true, error: '',
    pulled: 2, pushed: 3, identical: 40, failed: [], conflicts: [], ms: 12
  }

  it('leads with the error when the peer failed', () => {
    expect(summarizePeer({ ...base, ok: false, error: 'unreachable' }))
      .toBe('desk-pc: FAILED — unreachable')
  })

  it('counts both directions and flags anything left unresolved', () => {
    expect(summarizePeer(base)).toBe('desk-pc: ↓2  ↑3  =40')
    const messy = summarizePeer({
      ...base,
      conflicts: [{ path: 'layout.json', localMtime: 1, remoteMtime: 1 }],
      failed: [{ path: 'crypto/trades.json', error: 'EACCES' }]
    })
    expect(messy).toContain('⚠1 too-close-to-call')
    expect(messy).toContain('✕1 failed')
  })
})
