// Persisted HOME tile configuration — which device tiles this install shows and
// which entities each one is bound to.
//
// Same file-backed pattern as layout.ts: read once at startup, write through on
// every mutation, sanitize everything that comes back from disk or a client.
//
// WHY THE SERVER DISCOVERS RATHER THAN THE UI. The first render of a new install
// is the one moment there is no config to render from, and it is also the moment
// the user is least equipped to build one. Running discovery here — once, the
// first time a connected snapshot arrives — means the HOME tab is already
// populated before anyone opens it, on every surface at once, whether the first
// thing launched is Electron or a phone over Tailscale. The UI keeps the ability
// to re-scan and to correct, which is where the user's judgement actually helps.
//
// Discovery runs ONCE, not on every poll. A binding the user changed is a
// decision, and a background pass that re-derived bindings would quietly undo
// it the next time HA restarted with a renamed entity.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateStore } from './stateStore'
import type { HaEntity } from '../shared/homeassistant'
import { emptyHomeTiles, HOME_TILES_VERSION, type HomeTilesConfig } from '../shared/homeTiles'
import { discoverHomeTiles, mergeDiscovered, sanitizeHomeTiles } from '../shared/homeTileSpecs'

const DATA_DIR = process.env['HOMUNCULUS_DATA_DIR'] || join(process.cwd(), 'data')
const FILE = join(DATA_DIR, 'home-tiles.json')

let cache: HomeTilesConfig | null = null

function load(): HomeTilesConfig {
  if (cache) return cache
  try {
    if (existsSync(FILE)) {
      cache = sanitizeHomeTiles(stateStore.readJson<unknown>(FILE, {}))
      return cache
    }
  } catch (err) {
    // A corrupt tile config must not brick the HOME tab. Falling back to empty
    // (rather than to a stock arrangement) also re-arms discovery, so the next
    // snapshot rebuilds it from the house itself.
    console.warn('[homeTiles] unreadable home-tiles.json, rediscovering:', (err as Error).message)
  }
  cache = emptyHomeTiles()
  return cache
}

function persist(next: HomeTilesConfig): void {
  cache = next
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    stateStore.writeJson(FILE, next)
  } catch (err) {
    console.warn('[homeTiles] write failed:', (err as Error).message)
  }
}

export function getHomeTiles(): HomeTilesConfig {
  return load()
}

/** Replace the whole configuration. Sanitised, so a malformed POST degrades to
 *  a smaller valid config rather than persisting garbage. */
export function setHomeTiles(raw: unknown): HomeTilesConfig {
  const next = sanitizeHomeTiles(raw)
  // A client save is authoritative about what the user wants, and always counts
  // as "discovery has happened" — otherwise deleting every tile would re-arm the
  // first-run pass and resurrect them all on the next poll.
  persist({ ...next, discovered: true })
  return load()
}

/**
 * First-run discovery, called on each snapshot and doing nothing after the
 * first success.
 *
 * Guarded on a non-empty entity list as well as the flag: a snapshot that
 * arrives while HA is unreachable carries no entities, and writing "discovered:
 * true, tiles: []" from it would leave the install permanently blank.
 */
export function ensureDiscovered(entities: HaEntity[]): HomeTilesConfig {
  const current = load()
  if (current.discovered || entities.length === 0) return current
  const tiles = discoverHomeTiles(entities)
  const next: HomeTilesConfig = { version: HOME_TILES_VERSION, tiles, discovered: true }
  persist(next)
  console.log(`[homeTiles] discovered ${tiles.length} tile(s) from ${entities.length} entities`)
  return next
}

/** Re-scan for devices added since setup, keeping everything already configured. */
export function rediscoverHomeTiles(entities: HaEntity[]): HomeTilesConfig {
  const current = load()
  const next: HomeTilesConfig = {
    version: HOME_TILES_VERSION,
    // Deep-copied first: mergeDiscovered appends rows onto an existing tile in
    // place, and the cache must not be mutated ahead of a successful write.
    tiles: mergeDiscovered(structuredClone(current.tiles), discoverHomeTiles(entities)),
    discovered: true,
  }
  persist(sanitizeHomeTiles(next))
  return load()
}

/** Throw the configuration away and rebuild it from the house as it is now. */
export function resetHomeTiles(entities: HaEntity[]): HomeTilesConfig {
  persist({ version: HOME_TILES_VERSION, tiles: discoverHomeTiles(entities), discovered: true })
  return load()
}
