// Persisted UI layout — tab order, default tab, per-tab enable flags, and the
// widget grid for each tab. Lives on the server (not localStorage) so the
// Electron shell and the browser/Tailscale view show the same dashboard.
//
// Same file-backed pattern as cryptoStrategySettings.ts: read once at startup,
// write through on every mutation.

import { existsSync, mkdirSync } from 'node:fs'
import { stateStore } from './stateStore'
import { join } from 'node:path'
import { defaultLayout, sanitizeLayout, type LayoutConfig } from '../shared/layout'

const DATA_DIR = process.env['HOMUNCULUS_DATA_DIR'] || join(process.cwd(), 'data')
const FILE = join(DATA_DIR, 'layout.json')

let cache: LayoutConfig | null = null

function load(): LayoutConfig {
  if (cache) return cache
  try {
    if (existsSync(FILE)) {
      cache = sanitizeLayout(stateStore.readJson<unknown>(FILE, {}))
      return cache
    }
  } catch (err) {
    // A corrupt layout must not brick the UI — fall back to stock and say so.
    console.warn('[layout] unreadable layout.json, using defaults:', (err as Error).message)
  }
  cache = defaultLayout()
  return cache
}

function persist(next: LayoutConfig): void {
  cache = next
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    stateStore.writeJson(FILE, next)
  } catch (err) {
    console.warn('[layout] write failed:', (err as Error).message)
  }
}

export function getLayout(): LayoutConfig {
  return load()
}

/** Replace the whole layout. Input is sanitised, so a malformed client POST
 *  degrades to the stock layout rather than persisting garbage. */
export function setLayout(raw: unknown): LayoutConfig {
  const next = sanitizeLayout(raw)
  persist(next)
  return next
}

/** Drop back to the shipped arrangement. */
export function resetLayout(): LayoutConfig {
  const next = defaultLayout()
  persist(next)
  return next
}

/** True until the user has completed (or skipped) the first-run wizard.
 *  Stored alongside the layout so a fresh data dir means a fresh setup. */
const SETUP_FILE = join(DATA_DIR, 'setup.json')

export function isSetupComplete(): boolean {
  try {
    if (!existsSync(SETUP_FILE)) return false
    return stateStore.readJson<{ complete?: boolean }>(SETUP_FILE, {}).complete === true
  } catch {
    return false
  }
}

export function markSetupComplete(complete: boolean): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    stateStore.writeJson(SETUP_FILE, { complete, at: Date.now() })
  } catch (err) {
    console.warn('[layout] setup flag write failed:', (err as Error).message)
  }
}
