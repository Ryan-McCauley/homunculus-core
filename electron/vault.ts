// ── Encrypted key vault (Electron main process) ────────────────────────
// The only place a user-entered API key is stored on disk, and it is stored
// encrypted by the OS: Electron's safeStorage binds the ciphertext to the login
// keychain (macOS Keychain / Windows DPAPI / libsecret on Linux). Another user
// account on the same machine cannot read it; a stolen copy of the file alone
// is useless.
//
// Read the security notes at the top of server/secrets.ts for how values get
// from here to the backend that actually uses them.

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

const file = (): string => join(app.getPath('userData'), 'vault.bin')

/** False when the OS keychain isn't available (fresh Linux box with no keyring,
 *  some CI/headless setups). We refuse to store keys rather than silently
 *  writing plaintext — the UI reports this and points at .env instead. */
export function isAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function readAll(): Record<string, string> {
  if (!isAvailable()) return {}
  const path = file()
  if (!existsSync(path)) return {}
  try {
    const plain = safeStorage.decryptString(readFileSync(path))
    const parsed = JSON.parse(plain)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch (err) {
    // Wrong keychain (restored from another machine's backup) or truncated file.
    // Don't throw — the app must still boot; the user can re-enter keys.
    console.warn('[vault] could not decrypt vault, treating as empty:', (err as Error).message)
    return {}
  }
}

function writeAll(entries: Record<string, string>): void {
  if (!isAvailable()) throw new Error('OS keychain unavailable — refusing to store keys unencrypted')
  const path = file()
  mkdirSync(dirname(path), { recursive: true })
  if (Object.keys(entries).length === 0) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  writeFileSync(path, safeStorage.encryptString(JSON.stringify(entries)))
  // Belt and braces on top of the encryption: owner-only on POSIX.
  try { chmodSync(path, 0o600) } catch { /* windows */ }
}

/** Decrypted key/value map. Main-process only — never send this to a renderer. */
export function secrets(): Record<string, string> {
  return readAll()
}

/** Presence + fingerprint, safe to hand to the renderer. */
export function summary(): { key: string; last4: string }[] {
  return Object.entries(readAll()).map(([key, value]) => ({
    key,
    last4: value.length >= 4 ? value.slice(-4) : '',
  }))
}

export function setSecret(key: string, value: string): void {
  const all = readAll()
  if (value) all[key] = value
  else delete all[key]
  writeAll(all)
}

export function removeSecret(key: string): void {
  const all = readAll()
  delete all[key]
  writeAll(all)
}

export function clearAll(): void {
  writeAll({})
}
