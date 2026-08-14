// ── WidgetGrid ─────────────────────────────────────────────────────────
// A 12-column dashboard grid with drag-to-move, drag-to-resize, and
// vertical compaction. No third-party grid dependency — same house style as
// SplitPane, which this replaces for tab bodies.
//
// SIZING. Rows are elastic while the layout still fits the viewport: if the
// tallest widget's bottom edge is <= FIT_ROWS, row height stretches so the
// content fills the pane exactly. That is what makes a single full-width
// dashboard widget (the CRYPTO tab, say) look identical to the hardcoded
// full-bleed body it replaced, and what keeps BRIDGE's three columns
// full-height. Past FIT_ROWS the grid falls back to a fixed row height and
// scrolls, so a genuinely tall dashboard isn't squashed.
//
// EDITING. Nothing is draggable until `editing` is true — a stray mousedown on
// a live trading panel must never reflow the dashboard.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GRID_COLS, type WidgetPlacement } from '../../shared/layout'
import { getWidget } from '../widgets/registry'

const FIT_ROWS = 24
const MIN_ROW_H = 30
const GAP = 8

// ── Layout math ─────────────────────────────────────────────────────────

const overlaps = (a: WidgetPlacement, b: WidgetPlacement): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Pull everything as far up as it will go, preserving left-to-right order. */
export function compact(items: WidgetPlacement[]): WidgetPlacement[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: WidgetPlacement[] = []
  for (const it of sorted) {
    let y = 0
    for (const p of placed) if (p.x < it.x + it.w && it.x < p.x + p.w) y = Math.max(y, p.y + p.h)
    placed.push({ ...it, y })
  }
  return placed
}

/** Re-flow around a widget the user is actively dragging: the dragged item keeps
 *  the position under the cursor, everything else gets pushed out of its way and
 *  then compacted back up. Order is preserved by sorting on current y first, so
 *  neighbours don't shuffle arbitrarily mid-drag. */
function resolve(items: WidgetPlacement[], pinnedId: string): WidgetPlacement[] {
  const pinned = items.find((i) => i.instance === pinnedId)
  if (!pinned) return compact(items)
  const others = items.filter((i) => i.instance !== pinnedId).sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: WidgetPlacement[] = [pinned]
  for (const it of others) {
    let cur = { ...it, y: 0 }
    // Drop it to the first vertical slot that clears everything already placed.
    for (let guard = 0; guard < 200; guard++) {
      const hit = placed.find((p) => overlaps(p, cur))
      if (!hit) break
      cur = { ...cur, y: hit.y + hit.h }
    }
    placed.push(cur)
  }
  return placed
}

const bottomRow = (items: WidgetPlacement[]): number =>
  items.reduce((m, i) => Math.max(m, i.y + i.h), 0)

// ── Component ───────────────────────────────────────────────────────────

type DragState = {
  kind: 'move' | 'resize'
  instance: string
  startX: number
  startY: number
  origin: WidgetPlacement
}

export function WidgetGrid({
  widgets,
  editing,
  onChange,
  onRemove,
  onDragOver,
  onDropOutside,
}: {
  widgets: WidgetPlacement[]
  editing: boolean
  onChange: (next: WidgetPlacement[]) => void
  onRemove: (instance: string) => void
  /** Fired while dragging so the host can highlight a tab chip under the cursor. */
  onDragOver?: (clientX: number, clientY: number) => void
  /** Fired on drop. Return true if the host consumed it (e.g. moved the widget to
   *  another tab), in which case the in-grid placement is discarded. */
  onDropOutside?: (instance: string, clientX: number, clientY: number) => boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<DragState | null>(null)
  // Live placement during a drag; committed to `onChange` on mouseup.
  const [preview, setPreview] = useState<WidgetPlacement[] | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      setBox({ w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const items = preview ?? widgets
  const rows = Math.max(bottomRow(items), 1)
  const colW = box.w > 0 ? (box.w - GAP * (GRID_COLS - 1)) / GRID_COLS : 0
  // Elastic while it fits, fixed-and-scrolling once it doesn't. See header note.
  // Deliberately NOT clamped to MIN_ROW_H in the fitting case: clamping would
  // make a 24-row layout demand 900px in a 600px pane and clip it, which is the
  // opposite of "fits the viewport exactly".
  const rowH = rows <= FIT_ROWS && box.h > 0
    ? Math.max(4, (box.h - GAP * (rows - 1)) / rows)
    : MIN_ROW_H

  const px = (x: number, w: number) => ({ left: x * (colW + GAP), width: w * colW + (w - 1) * GAP })
  const py = (y: number, h: number) => ({ top: y * (rowH + GAP), height: h * rowH + (h - 1) * GAP })

  // Mirror into refs so the window-level pointer handlers see fresh values
  // without re-subscribing on every move (same trick as SplitPane).
  const stateRef = useRef({ items, colW, rowH, drag })
  stateRef.current = { items, colW, rowH, drag }

  const onPointerDown = useCallback(
    (e: React.PointerEvent, instance: string, kind: 'move' | 'resize') => {
      if (!editing) return
      const origin = stateRef.current.items.find((i) => i.instance === instance)
      if (!origin) return
      e.preventDefault()
      e.stopPropagation()
      setDrag({ kind, instance, startX: e.clientX, startY: e.clientY, origin: { ...origin } })
    },
    [editing]
  )

  useEffect(() => {
    if (!drag) return

    const move = (e: PointerEvent): void => {
      const s = stateRef.current
      if (s.colW <= 0) return
      const dx = Math.round((e.clientX - drag.startX) / (s.colW + GAP))
      const dy = Math.round((e.clientY - drag.startY) / (s.rowH + GAP))
      const def = getWidget(drag.origin.widget)
      const minW = def?.minW ?? 1
      const minH = def?.minH ?? 2

      let next: WidgetPlacement
      if (drag.kind === 'move') {
        next = {
          ...drag.origin,
          x: Math.min(GRID_COLS - drag.origin.w, Math.max(0, drag.origin.x + dx)),
          y: Math.max(0, drag.origin.y + dy),
        }
      } else {
        const w = Math.min(GRID_COLS - drag.origin.x, Math.max(minW, drag.origin.w + dx))
        const h = Math.max(minH, drag.origin.h + dy)
        next = { ...drag.origin, w, h }
      }

      const merged = s.items.map((i) => (i.instance === drag.instance ? next : i))
      setPreview(resolve(merged, drag.instance))
      onDragOver?.(e.clientX, e.clientY)
    }

    const up = (e: PointerEvent): void => {
      const consumed = drag.kind === 'move'
        ? onDropOutside?.(drag.instance, e.clientX, e.clientY) === true
        : false
      const settled = stateRef.current.items
      setDrag(null)
      setPreview(null)
      // When the host moved the widget to another tab it already owns the new
      // truth; committing our preview here would resurrect it on this tab.
      if (!consumed) onChange(compact(settled))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = drag.kind === 'move' ? 'grabbing' : 'nwse-resize'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [drag, onChange, onDragOver, onDropOutside])

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        overflowY: rows > FIT_ROWS ? 'auto' : 'hidden',
        overflowX: 'hidden',
        background: 'var(--bg)',
      }}
    >
      {editing && <GridGuides cols={GRID_COLS} colW={colW} gap={GAP} />}

      {/* Nothing is placed until the container has been measured. Rendering at
          colW=0 first would make every widget animate open from zero width on
          each mount and tab switch. */}
      {colW > 0 && items.map((it) => {
        const def = getWidget(it.widget)
        const dragging = drag?.instance === it.instance
        return (
          <div
            key={it.instance}
            style={{
              position: 'absolute',
              ...px(it.x, it.w),
              ...py(it.y, it.h),
              transition: dragging ? 'none' : 'top 120ms ease, left 120ms ease, width 120ms ease, height 120ms ease',
              zIndex: dragging ? 20 : 1,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              outline: editing ? '0.5px solid var(--border)' : 'none',
              boxShadow: dragging ? '0 0 0 1px var(--border-strong), 0 8px 24px rgba(0,0,0,0.5)' : 'none',
              opacity: dragging ? 0.85 : 1,
            }}
          >
            {editing && (
              <div
                onPointerDown={(e) => onPointerDown(e, it.instance, 'move')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px 6px', fontSize: 8, letterSpacing: 1,
                  color: 'var(--green-dim)', background: 'var(--bg-elev)',
                  borderBottom: '0.5px solid var(--border)',
                  cursor: 'grab', flex: '0 0 auto',
                }}
              >
                <span>⠿</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {def?.label ?? it.widget}
                </span>
                <span style={{ color: 'var(--green-dim)' }}>{it.w}×{it.h}</span>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemove(it.instance)}
                  title="Remove from this tab"
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--crimson)', fontSize: 10, padding: '0 2px', lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: def?.category === 'DASHBOARD' ? 0 : 4 }}>
              {def
                ? <WidgetHost render={def.render} />
                : <MissingWidget id={it.widget} />}
            </div>

            {editing && (
              <div
                onPointerDown={(e) => onPointerDown(e, it.instance, 'resize')}
                title="Resize"
                style={{
                  position: 'absolute', right: 0, bottom: 0, width: 14, height: 14,
                  cursor: 'nwse-resize',
                  background: 'linear-gradient(135deg, transparent 50%, var(--border-strong) 50%)',
                }}
              />
            )}
          </div>
        )
      })}

      {colW > 0 && items.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--green-dim)', fontSize: 10, letterSpacing: 1,
        }}>
          NO WIDGETS ON THIS TAB — OPEN SETTINGS ▸ WIDGETS TO ADD ONE
        </div>
      )}
    </div>
  )
}

/** Renders one registry entry. It exists so the entry's `render()` runs as the
 *  body of a real component: registry entries call hooks (useWidgetContext and
 *  whatever the panel itself uses), and those hooks need a stable owner. */
function WidgetHost({ render }: { render: () => JSX.Element | null }): JSX.Element | null {
  return render()
}

function MissingWidget({ id }: { id: string }): JSX.Element {
  return (
    <div style={{ padding: 8, fontSize: 9, color: 'var(--crimson)', letterSpacing: 1 }}>
      UNKNOWN WIDGET “{id}” — it may have been removed from the registry.
    </div>
  )
}

/** Faint column rulers, edit mode only, so drops land where you expect. */
function GridGuides({ cols, colW, gap }: { cols: number; colW: number; gap: number }): JSX.Element {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
      {Array.from({ length: cols }, (_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute', top: 0, bottom: 0,
            left: i * (colW + gap), width: colW,
            background: 'var(--bg-elev)', opacity: 0.35,
          }}
        />
      ))}
    </div>
  )
}
