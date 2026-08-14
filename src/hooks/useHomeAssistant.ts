import { useEffect, useState } from 'react'
import type { HaSnapshot } from '../../shared/homeassistant'

export function useHomeAssistant(): HaSnapshot | null {
  const [snapshot, setSnapshot] = useState<HaSnapshot | null>(null)

  useEffect(() => {
    if (!window.homunculus) return
    const unsubscribe = window.homunculus.onHa(setSnapshot)
    return unsubscribe
  }, [])

  return snapshot
}
