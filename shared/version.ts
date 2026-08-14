// Single source of truth for the app's build identity: semver (from
// package.json) + the short git commit + an ISO build timestamp. Used two ways:
//   • Vite/electron-vite configs call getBuildInfo() at build time and inject the
//     values as compile-time globals (__APP_VERSION__ etc.) for the UI.
//   • The backend calls it at startup to serve GET /api/version.
// Everything degrades gracefully outside a git checkout (commit → 'unknown').

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export interface BuildInfo {
  version: string
  commit: string
  buildDate: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function getBuildInfo(): BuildInfo {
  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version ?? version
  } catch {
    /* not readable — keep fallback */
  }

  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    /* not a git checkout — keep fallback */
  }

  return { version, commit, buildDate: new Date().toISOString() }
}
