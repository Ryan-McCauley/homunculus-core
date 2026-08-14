// Subscribes to the ARCHIVE event log: hydrates from the snapshot, then prepends
// live events as they arrive. Returns the merged list (newest first) + a
// connection flag. Deduped by id and capped so the console stays light.

import { useEffect, useState } from 'react'
import type { ArchiveEvent } from '../../shared/archive'

const CAP = 1000

export function useArchive(): { events: ArchiveEvent[]; ready: boolean } {
  const [events, setEvents] = useState<ArchiveEvent[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!window.homunculus) return
    const off = window.homunculus.onArchive({
      snapshot: (snap) => {
        setEvents(snap.events)
        setReady(true)
      },
      event: (e) => {
        setEvents((prev) => {
          if (prev.some((x) => x.id === e.id)) return prev
          return [e, ...prev].slice(0, CAP)
        })
      }
    })
    return off
  }, [])

  return { events, ready }
}
