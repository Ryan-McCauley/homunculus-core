import { useEffect, useState } from 'react'
import type { OsintSnapshot } from '../../shared/osint'

/**
 * Subscribes to the Osint stream (OSINT watchers). Returns the latest
 * snapshot, or null until the first arrives. The backend primes immediately
 * with cached data on subscribe, so this fills in fast even before a live poll.
 */
export function useOsint(): OsintSnapshot | null {
  const [snapshot, setSnapshot] = useState<OsintSnapshot | null>(null)

  useEffect(() => {
    if (!window.homunculus) return
    return window.homunculus.onOsint(setSnapshot)
  }, [])

  return snapshot
}
