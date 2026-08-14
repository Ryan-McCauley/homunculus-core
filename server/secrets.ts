// ── Secret store ───────────────────────────────────────────────────────
// Runtime home for user-entered API keys.
//
// THREAT MODEL / WHY IT LOOKS LIKE THIS
// The keys are *used* here, in the backend (crypto.ts, cmc.ts, homeassistant.ts
// all read process.env). But the backend is a plain Node process — it has no
// OS keychain and may be a headless container. So this module never persists
// anything: it holds values in memory only, injected at runtime by the Electron
// shell, which owns the encrypted-at-rest vault (electron/vault.ts, backed by
// Electron safeStorage → macOS Keychain / Windows DPAPI / libsecret).
//
// Consequences, all deliberate:
//   • Backend restart drops the vault. The Electron shell re-pushes on connect.
//   • A headless/Docker backend with no Electron client gets its config from
//     .env, exactly as before, and the KEYS panel is read-only there.
//   • Nothing unencrypted ever touches disk, and no value is ever sent to a
//     client — status() reports presence and a last-4 fingerprint only.
//
// The unlock endpoint is localhost-only (see server/index.ts). A key must never
// cross the Tailscale boundary, so the phone/browser view cannot write keys.

import { SECRET_SPECS, type SecretStatus } from '../shared/secrets'

/** Keys pushed by the Electron vault this process lifetime. Memory only. */
const vault = new Map<string, string>()

/** Values that were in process.env at boot, so clearing a vault key can restore
 *  the .env value instead of leaving the module dead until restart. */
const envBaseline = new Map<string, string>()
for (const spec of SECRET_SPECS) {
  const v = process.env[spec.key]
  if (v) envBaseline.set(spec.key, v)
}

const KNOWN = new Set(SECRET_SPECS.map((s) => s.key))

const last4 = (v: string): string => (v.length >= 4 ? v.slice(-4) : '')

/** Push the vault contents in. Replaces the whole set: a key the Electron vault
 *  no longer has is cleared here too, so "delete key" propagates. */
export function applyVault(entries: Record<string, unknown>): { applied: number; ignored: string[] } {
  const ignored: string[] = []
  const next = new Map<string, string>()
  for (const [k, v] of Object.entries(entries)) {
    if (!KNOWN.has(k)) { ignored.push(k); continue }
    if (typeof v !== 'string' || !v) continue
    next.set(k, v)
  }

  // Drop env vars for keys the vault dropped, restoring the .env baseline.
  for (const k of vault.keys()) {
    if (next.has(k)) continue
    const base = envBaseline.get(k)
    if (base) process.env[k] = base
    else delete process.env[k]
  }

  vault.clear()
  for (const [k, v] of next) {
    vault.set(k, v)
    process.env[k] = v
  }
  return { applied: vault.size, ignored }
}

/** Presence report for the UI. Contains no plaintext, by design. */
export function status(): SecretStatus[] {
  return SECRET_SPECS.map((spec) => {
    const fromVault = vault.get(spec.key)
    if (fromVault) return { key: spec.key, set: true, source: 'vault' as const, last4: last4(fromVault) }
    const fromEnv = process.env[spec.key]
    if (fromEnv) return { key: spec.key, set: true, source: 'env' as const, last4: last4(fromEnv) }
    return { key: spec.key, set: false, source: 'none' as const, last4: '' }
  })
}

/** Which catalogued modules are fully configured — drives the first-run wizard's
 *  "you still need a key for X" nagging and the tab-enable suggestions. */
export function moduleReadiness(): Record<string, boolean> {
  const st = new Map(status().map((s) => [s.key, s]))
  const out: Record<string, boolean> = {}
  for (const spec of SECRET_SPECS) {
    if (!spec.module || !spec.required) continue
    const ok = st.get(spec.key)?.set === true
    out[spec.module] = (out[spec.module] ?? true) && ok
  }
  return out
}
