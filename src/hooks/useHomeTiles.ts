// Loads the HOME tile configuration from the backend and writes edits back,
// debounced — the same contract as useLayout, for the same reason: the config
// belongs to the house, not to the browser, so Electron and a phone over
// Tailscale must see one answer.
//
// Edits apply locally first and flush after a short idle. Dragging a threshold
// slider should not fire a POST per pixel.

import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyHomeTiles, type HomeTileConfig, type HomeTilesConfig } from '../../shared/homeTiles'
import {
  fetchHomeTiles, saveHomeTiles, rescanHomeTiles, resetHomeTiles as resetRemote,
} from '../lib/layoutApi'

const SAVE_DEBOUNCE_MS = 400

export interface HomeTilesApi {
  config: HomeTilesConfig
  /** false until the server's copy has arrived. */
  loaded: boolean
  error: string
  /** True while a rescan/reset round-trip is in flight. */
  busy: boolean
  update: (fn: (draft: HomeTilesConfig) => HomeTilesConfig) => void
  updateTile: (id: string, fn: (tile: HomeTileConfig) => HomeTileConfig) => void
  removeTile: (id: string) => void
  moveTile: (id: string, delta: number) => void
  addTile: (type: string) => void
  rescan: () => void
  reset: () => void
}

export function useHomeTiles(): HomeTilesApi {
  const [config, setConfig] = useState<HomeTilesConfig>(emptyHomeTiles)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    fetchHomeTiles()
      .then((c) => { if (alive) { setConfig(c); setLoaded(true) } })
      .catch((e: Error) => {
        // Server unreachable — render no tiles rather than an error page. The
        // rest of the HOME tab (sectors, registry) does not depend on this.
        if (!alive) return
        setError(e.message)
        setLoaded(true)
      })
    return () => { alive = false }
  }, [])

  const flush = useCallback((next: HomeTilesConfig) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      saveHomeTiles(next).catch((e: Error) => setError(e.message))
    }, SAVE_DEBOUNCE_MS)
  }, [])

  const update = useCallback((fn: (draft: HomeTilesConfig) => HomeTilesConfig) => {
    setConfig((prev) => {
      const next = fn(prev)
      flush(next)
      return next
    })
  }, [flush])

  const updateTile = useCallback((id: string, fn: (tile: HomeTileConfig) => HomeTileConfig) => {
    update((c) => ({ ...c, tiles: c.tiles.map((t) => (t.id === id ? fn(t) : t)) }))
  }, [update])

  const removeTile = useCallback((id: string) => {
    update((c) => ({ ...c, tiles: c.tiles.filter((t) => t.id !== id) }))
  }, [update])

  const moveTile = useCallback((id: string, delta: number) => {
    update((c) => {
      const from = c.tiles.findIndex((t) => t.id === id)
      const to = from + delta
      if (from === -1 || to < 0 || to >= c.tiles.length) return c
      const tiles = [...c.tiles]
      const [moved] = tiles.splice(from, 1)
      if (moved) tiles.splice(to, 0, moved)
      return { ...c, tiles }
    })
  }, [update])

  const addTile = useCallback((type: string) => {
    update((c) => {
      // Ids only have to be unique, and a monotonically rising suffix stays
      // unique even after tiles in the middle are deleted.
      let n = c.tiles.length + 1
      while (c.tiles.some((t) => t.id === `${type}-${n}`)) n++
      const tile: HomeTileConfig = {
        id: `${type}-${n}`, type, title: '', enabled: true, bindings: {}, options: {},
      }
      return { ...c, tiles: [...c.tiles, tile] }
    })
  }, [update])

  // Rescan and reset are server-side (they need the live entity list), so they
  // replace local state with the server's answer rather than flushing to it.
  const remote = useCallback((run: () => Promise<HomeTilesConfig>) => {
    if (timer.current) clearTimeout(timer.current)
    setBusy(true)
    setError('')
    run()
      .then(setConfig)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [])

  const rescan = useCallback(() => remote(rescanHomeTiles), [remote])
  const reset = useCallback(() => remote(resetRemote), [remote])

  return { config, loaded, error, busy, update, updateTile, removeTile, moveTile, addTile, rescan, reset }
}
