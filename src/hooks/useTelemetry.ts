import { useEffect, useState } from 'react'
import type { TelemetrySnapshot } from '../../shared/telemetry'

/**
 * Subscribes to the live telemetry stream coming from the Electron main
 * process. Returns the latest snapshot, or null until the first arrives.
 */
export function useTelemetry(): TelemetrySnapshot | null {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null)

  useEffect(() => {
    // Guard for running the renderer outside Electron (e.g. plain browser).
    if (!window.homunculus) return
    const unsubscribe = window.homunculus.onTelemetry(setSnapshot)
    return unsubscribe
  }, [])

  return snapshot
}
