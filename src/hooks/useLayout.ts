// Loads the dashboard layout from the backend and writes edits back, debounced.
//
// The layout is server-side so every surface (Electron, browser, phone over
// Tailscale) agrees. Edits apply to local state immediately and flush after a
// short idle — dragging a widget shouldn't fire a POST per animation frame.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultLayout, resolveDefaultTab, type LayoutConfig, type TabConfig, type WidgetPlacement,
} from '../../shared/layout'
import { fetchLayout, saveLayout, resetLayout as resetRemote } from '../lib/layoutApi'
import { getWidget } from '../widgets/registry'

const SAVE_DEBOUNCE_MS = 400

export interface LayoutApi {
  layout: LayoutConfig
  /** false until the server's copy has arrived; App holds off picking a tab. */
  loaded: boolean
  error: string
  update: (fn: (draft: LayoutConfig) => LayoutConfig) => void
  setTabWidgets: (tabId: string, widgets: WidgetPlacement[]) => void
  moveWidgetToTab: (fromTab: string, instance: string, toTab: string) => void
  addWidget: (tabId: string, widgetId: string) => void
  removeWidget: (tabId: string, instance: string) => void
  reset: () => void
}

export function useLayout(): LayoutApi {
  const [layout, setLayout] = useState<LayoutConfig>(() => defaultLayout())
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    fetchLayout()
      .then((l) => { if (alive) { setLayout(l); setLoaded(true) } })
      .catch((e: Error) => {
        // Server unreachable or token missing — run on the stock layout rather
        // than showing an empty shell, but say so.
        if (!alive) return
        setError(e.message)
        setLoaded(true)
      })
    return () => { alive = false }
  }, [])

  const flush = useCallback((next: LayoutConfig) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      saveLayout(next).catch((e: Error) => setError(e.message))
    }, SAVE_DEBOUNCE_MS)
  }, [])

  const update = useCallback((fn: (draft: LayoutConfig) => LayoutConfig) => {
    setLayout((prev) => {
      const next = fn(prev)
      next.defaultTab = resolveDefaultTab(next) || next.defaultTab
      flush(next)
      return next
    })
  }, [flush])

  const mapTab = useCallback((tabId: string, fn: (t: TabConfig) => TabConfig) => {
    update((l) => ({ ...l, tabs: l.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }))
  }, [update])

  const setTabWidgets = useCallback((tabId: string, widgets: WidgetPlacement[]) => {
    mapTab(tabId, (t) => ({ ...t, widgets }))
  }, [mapTab])

  const removeWidget = useCallback((tabId: string, instance: string) => {
    mapTab(tabId, (t) => ({ ...t, widgets: t.widgets.filter((w) => w.instance !== instance) }))
  }, [mapTab])

  const addWidget = useCallback((tabId: string, widgetId: string) => {
    update((l) => ({
      ...l,
      tabs: l.tabs.map((t) => {
        if (t.id !== tabId) return t
        return { ...t, widgets: [...t.widgets, freshPlacement(widgetId, t.widgets)] }
      }),
    }))
  }, [update])

  const moveWidgetToTab = useCallback((fromTab: string, instance: string, toTab: string) => {
    if (fromTab === toTab) return
    update((l) => {
      const src = l.tabs.find((t) => t.id === fromTab)
      const placement = src?.widgets.find((w) => w.instance === instance)
      if (!placement) return l
      return {
        ...l,
        tabs: l.tabs.map((t) => {
          if (t.id === fromTab) return { ...t, widgets: t.widgets.filter((w) => w.instance !== instance) }
          if (t.id === toTab) {
            // Land it below whatever is already there, keeping its size.
            const y = t.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0)
            return { ...t, widgets: [...t.widgets, { ...placement, x: 0, y }] }
          }
          return t
        }),
      }
    })
  }, [update])

  const reset = useCallback(() => {
    resetRemote()
      .then(setLayout)
      .catch((e: Error) => setError(e.message))
  }, [])

  return { layout, loaded, error, update, setTabWidgets, moveWidgetToTab, addWidget, removeWidget, reset }
}

/** A new instance id + a landing spot below the existing content. */
function freshPlacement(widgetId: string, existing: WidgetPlacement[]): WidgetPlacement {
  const def = getWidget(widgetId)
  const y = existing.reduce((m, w) => Math.max(m, w.y + w.h), 0)
  return {
    instance: `${widgetId}-${Math.random().toString(36).slice(2, 8)}`,
    widget: widgetId,
    x: 0,
    y,
    w: def?.defaultW ?? 4,
    h: def?.defaultH ?? 6,
  }
}
