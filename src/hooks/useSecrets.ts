// Client side of the key vault.
//
// Two gates have to be open before a key can be entered:
//   1. The backend says the request is local (`capability.writable`).
//   2. `window.homunculusVault` exists — i.e. we're in the Electron shell, which
//      is the only thing with an OS keychain to encrypt into.
// A browser tab on the same machine passes (1) but fails (2), so it stays
// read-only. Both are honest constraints, not belt-and-braces of the same check.

import { useCallback, useEffect, useState } from 'react'
import { fetchSecrets, type SecretsView } from '../lib/layoutApi'
import type { VaultBridge } from '../../shared/secrets'

const vault = (): VaultBridge | null => (window as any).homunculusVault ?? null

export interface SecretsApi extends SecretsView {
  loading: boolean
  error: string
  /** True when this surface can actually store a key. */
  canEdit: boolean
  /** Why not, when canEdit is false. */
  readOnlyReason: string
  set: (key: string, value: string) => Promise<void>
  clear: (key: string) => Promise<void>
  refresh: () => void
}

const EMPTY: SecretsView = {
  specs: [], secrets: [], modules: {},
  capability: { writable: false, reason: 'not loaded' },
}

export function useSecrets(): SecretsApi {
  const [view, setView] = useState<SecretsView>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hasVault, setHasVault] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    fetchSecrets()
      .then((v) => { setView(v); setError('') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
    const v = vault()
    if (!v) { setHasVault(false); return }
    v.available().then(setHasVault).catch(() => setHasVault(false))
  }, [refresh])

  const canEdit = view.capability.writable && hasVault

  const readOnlyReason = canEdit ? ''
    : !view.capability.writable ? view.capability.reason
    : 'No OS keychain available on this surface. Open Homunculus in the desktop app on the machine running the backend, or set keys in .env.'

  const set = useCallback(async (key: string, value: string) => {
    const v = vault()
    if (!v) throw new Error('vault unavailable')
    const r = await v.set(key, value)
    if (!r.ok) throw new Error(r.error || 'vault write failed')
    // The Electron main process pushes the new value to the backend as part of
    // `set`; re-read so the panel shows the updated fingerprint.
    refresh()
  }, [refresh])

  const clear = useCallback(async (key: string) => {
    const v = vault()
    if (!v) throw new Error('vault unavailable')
    const r = await v.remove(key)
    if (!r.ok) throw new Error(r.error || 'vault delete failed')
    refresh()
  }, [refresh])

  return { ...view, loading, error, canEdit, readOnlyReason, set, clear, refresh }
}
