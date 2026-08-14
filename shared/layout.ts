// ── Layout model ───────────────────────────────────────────────────────
// The tab bar and the contents of every tab are DATA, not code. App.tsx renders
// whatever this config says: which tabs exist, in what order, which are enabled,
// which one opens on launch, and which widgets sit where inside each one.
//
// A "widget" is any panel from src/panels/* registered in src/widgets/registry.tsx.
// Placement is on a 12-column grid; `y`/`h` are in ROW_H units (see WidgetGrid).
// The big legacy dashboards (CRYPTO, FINANCE, …) are widgets too — they just
// default to a full-width, full-height placement, which is why they look
// identical to how they did when they were hardcoded tab bodies.

export const GRID_COLS = 12

/** A widget instance placed on a tab. `instance` is unique; `widget` is a registry key. */
export interface WidgetPlacement {
  instance: string
  widget: string
  x: number
  y: number
  w: number
  h: number
}

export interface TabConfig {
  id: string
  label: string
  enabled: boolean
  /** true for the ten tabs that shipped hardcoded — they can be disabled and
   *  reordered but not deleted, so a bad edit can't strand a dashboard. */
  builtin: boolean
  widgets: WidgetPlacement[]
}

export interface LayoutConfig {
  /** Bumped when the shape changes so server/layout.ts can migrate. */
  version: number
  defaultTab: string
  /** Array order IS tab order. */
  tabs: TabConfig[]
}

export const LAYOUT_VERSION = 1

/** Full-bleed placement — what a legacy whole-tab dashboard gets. */
const full = (instance: string, widget: string): WidgetPlacement =>
  ({ instance, widget, x: 0, y: 0, w: GRID_COLS, h: 24 })

const dashTab = (id: string, widget: string): TabConfig =>
  ({ id, label: id, enabled: true, builtin: true, widgets: [full(id.toLowerCase(), widget)] })

/** The stock layout — byte-for-byte the arrangement that used to be hardcoded in App.tsx. */
export function defaultLayout(): LayoutConfig {
  return {
    version: LAYOUT_VERSION,
    defaultTab: 'BRIDGE',
    tabs: [
      {
        id: 'BRIDGE',
        label: 'BRIDGE',
        enabled: true,
        builtin: true,
        widgets: [
          // 2 / 7 / 3 columns. The rail needs 3: the HoloTiles (laundry, litter)
          // have their own intrinsic width and clip at 2/12 on a 1280px window.
          { instance: 'vitals', widget: 'system.vitals', x: 0, y: 0, w: 2, h: 24 },
          { instance: 'terminal', widget: 'core.terminal', x: 2, y: 0, w: 7, h: 12 },
          { instance: 'core', widget: 'core.computer', x: 2, y: 12, w: 7, h: 12 },
          { instance: 'ha', widget: 'home.assistant', x: 9, y: 0, w: 3, h: 6 },
          { instance: 'trades', widget: 'crypto.opentrades', x: 9, y: 6, w: 3, h: 6 },
          { instance: 'laundry', widget: 'home.laundry', x: 9, y: 12, w: 3, h: 6 },
          { instance: 'litter', widget: 'home.litter', x: 9, y: 18, w: 3, h: 6 },
        ],
      },
      dashTab('OSINT', 'dash.osint'),
      dashTab('HOME', 'dash.home'),
      dashTab('DATA', 'dash.data'),
      dashTab('ARCHIVE', 'dash.archive'),
      dashTab('CRYPTO', 'dash.crypto'),
    ],
  }
}

// ── Helpers shared by the server store and the settings UI ──────────────

export const enabledTabs = (l: LayoutConfig): TabConfig[] => l.tabs.filter((t) => t.enabled)

/** The tab that should open on launch: the configured default if it's still
 *  enabled, else the first enabled tab, else '' (every tab disabled). */
export function resolveDefaultTab(l: LayoutConfig): string {
  const on = enabledTabs(l)
  if (on.some((t) => t.id === l.defaultTab)) return l.defaultTab
  return on[0]?.id ?? ''
}

/** Normalise anything read off disk or POSTed by a client into a usable config.
 *  Deliberately total: unknown fields are dropped, bad numbers clamped, and a
 *  layout with zero tabs falls back to the stock one rather than blanking the app. */
export function sanitizeLayout(raw: unknown): LayoutConfig {
  const fallback = defaultLayout()
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Partial<LayoutConfig>
  if (!Array.isArray(r.tabs) || r.tabs.length === 0) return fallback

  const seenTabs = new Set<string>()
  const tabs: TabConfig[] = []
  for (const t of r.tabs) {
    if (!t || typeof t.id !== 'string' || !t.id.trim()) continue
    const id = t.id.trim().toUpperCase()
    if (seenTabs.has(id)) continue
    seenTabs.add(id)

    const seenInst = new Set<string>()
    const widgets: WidgetPlacement[] = []
    for (const w of Array.isArray(t.widgets) ? t.widgets : []) {
      if (!w || typeof w.widget !== 'string' || !w.widget) continue
      const instance = typeof w.instance === 'string' && w.instance ? w.instance : `${w.widget}-${widgets.length}`
      if (seenInst.has(instance)) continue
      seenInst.add(instance)
      const ww = clampInt(w.w, 1, GRID_COLS, 4)
      widgets.push({
        instance,
        widget: w.widget,
        x: clampInt(w.x, 0, GRID_COLS - ww, 0),
        y: clampInt(w.y, 0, 999, 0),
        w: ww,
        h: clampInt(w.h, 2, 999, 6),
      })
    }

    tabs.push({
      id,
      label: typeof t.label === 'string' && t.label.trim() ? t.label.trim() : id,
      enabled: t.enabled !== false,
      builtin: t.builtin === true,
      widgets,
    })
  }

  if (tabs.length === 0) return fallback
  const out: LayoutConfig = {
    version: LAYOUT_VERSION,
    defaultTab: typeof r.defaultTab === 'string' ? r.defaultTab.toUpperCase() : tabs[0].id,
    tabs,
  }
  out.defaultTab = resolveDefaultTab(out) || tabs[0].id
  return out
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt
  return Math.min(hi, Math.max(lo, n))
}
