// ── SplitPane ──────────────────────────────────────────────────────────
// A horizontal, drag-resizable row of panes. Dividers between the panes can be
// dragged to reallocate width; sizes persist to localStorage per `storageKey`
// and survive reloads. Double-click a divider to reset the two adjacent panes.
//
// Pass the panes as direct children and describe each one, by index, in the
// `config` array. Each child is wrapped in a sizing div; with `fill` the
// wrapper is a grid cell so the child stretches to the pane's full width and
// height (dashboard region splits), otherwise it keeps its natural height
// (card grids).
//
// Two pane kinds, mixable in one row:
//   • fixed → explicit pixel width (`size` is a px basis)
//   • flex  → grows to fill leftover space (`size` is a grow *weight*, so
//             `{}` + `{}` splits 50/50 and `{size:1.7}` + `{}` mirrors
//             the old `1.7fr 1fr`)
//
// Divider behaviour, natural for every fixed/flex combination:
//   fixed│flex  → resize the fixed pane   (flex absorbs the slack)
//   flex│fixed  → resize the fixed pane
//   fixed│fixed → trade width between the two neighbours
//   flex│flex   → shift grow-weight across the boundary, proportional to px
import { Children, Fragment, useCallback, useEffect, useRef, useState } from 'react'

const DIVIDER_W = 8
const DEFAULT_MIN = 60

export type PaneConfig = {
  key: string
  size?: number   // fixed → px width; flex → grow weight (default 1)
  fixed?: boolean
  min?: number
}

const isFixed = (c: PaneConfig) => !!c.fixed
const defaultSize = (c: PaneConfig) => c.size ?? 1
const minOf = (c: PaneConfig) => c.min ?? DEFAULT_MIN

export function SplitPane({ storageKey, config, style, children, fill = false }: {
  storageKey: string
  config: PaneConfig[]
  style?: React.CSSProperties
  /** true → panes stretch to fill the container's full height (dashboard region
   *  splits); false → panes keep their natural height, top-aligned (card grids). */
  fill?: boolean
  children: React.ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  const [sizes, setSizes] = useState<Record<string, number>>(() => {
    const base: Record<string, number> = {}
    for (const c of config) base[c.key] = defaultSize(c)
    try {
      const saved = JSON.parse(localStorage.getItem('splitpane:' + storageKey) || '{}')
      for (const c of config) if (typeof saved[c.key] === 'number') base[c.key] = saved[c.key]
    } catch { /* ignore malformed cache */ }
    return base
  })

  // Mirror sizes into a ref so the window-level drag handler reads fresh values
  // without re-subscribing on every mousemove.
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  useEffect(() => {
    try { localStorage.setItem('splitpane:' + storageKey, JSON.stringify(sizes)) } catch { /* quota */ }
  }, [sizes, storageKey])

  const drag = useRef<null | { i: number; startX: number; a: number; b: number }>(null)
  const [dragging, setDragging] = useState<number | null>(null)

  const onDown = useCallback((e: React.MouseEvent, i: number) => {
    // divider i sits between config[i] and config[i+1]
    drag.current = {
      i, startX: e.clientX,
      a: sizesRef.current[config[i].key],
      b: sizesRef.current[config[i + 1].key],
    }
    setDragging(i)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, [config])

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const L = config[d.i], R = config[d.i + 1]
      const dx = e.clientX - d.startX
      const next = { ...sizesRef.current }

      if (isFixed(L) && isFixed(R)) {
        // Trade px between the two neighbours, keeping their sum constant.
        const sum = d.a + d.b
        const a = Math.max(minOf(L), Math.min(d.a + dx, sum - minOf(R)))
        next[L.key] = a
        next[R.key] = sum - a
      } else if (isFixed(L)) {
        next[L.key] = clampFixed(d.a + dx, L, config, next, containerRef.current)
      } else if (isFixed(R)) {
        next[R.key] = clampFixed(d.b - dx, R, config, next, containerRef.current)
      } else {
        // flex│flex — convert px delta into a weight shift across the boundary.
        const avail = flexAvail(config, next, containerRef.current)
        const perW = avail / totalFlexWeight(config, next) // px per weight-unit
        if (perW > 0) {
          const dW = dx / perW
          const sum = d.a + d.b
          const minAw = minOf(L) / perW, minBw = minOf(R) / perW
          const a = Math.max(minAw, Math.min(d.a + dW, sum - minBw))
          next[L.key] = a
          next[R.key] = sum - a
        }
      }
      setSizes(next)
    }
    const up = () => {
      if (!drag.current) return
      drag.current = null
      setDragging(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [config])

  const reset = useCallback((i: number) => {
    setSizes((s) => ({ ...s, [config[i].key]: defaultSize(config[i]), [config[i + 1].key]: defaultSize(config[i + 1]) }))
  }, [config])

  const kids = Children.toArray(children)

  return (
    <div ref={containerRef} style={{
      display: 'flex', width: '100%', overflow: 'hidden',
      ...(fill ? { height: '100%', alignItems: 'stretch' } : { alignItems: 'flex-start' }),
      ...style,
    }}>
      {kids.map((child, i) => {
        const c = config[i]
        if (!c) return child
        const sizeStyle: React.CSSProperties = isFixed(c)
          ? { flex: '0 0 auto', width: sizes[c.key], minWidth: minOf(c) }
          : { flex: `${sizes[c.key]} 1 0`, minWidth: minOf(c) }
        // fill panes use a grid wrapper so the child stretches to the pane's full
        // width AND height; card panes use a block wrapper (natural height).
        const wrapped = (
          <div style={{ ...sizeStyle, overflow: 'hidden', ...(fill ? { display: 'grid' } : null) }}>
            {child}
          </div>
        )
        return (
          <Fragment key={c.key}>
            {i > 0 && (
              <div
                onMouseDown={(e) => onDown(e, i - 1)}
                onDoubleClick={() => reset(i - 1)}
                title="Drag to resize · double-click to reset"
                style={{
                  flex: '0 0 auto', width: DIVIDER_W, alignSelf: 'stretch',
                  cursor: 'col-resize', display: 'flex', justifyContent: 'center', zIndex: 2,
                }}
              >
                <div style={{
                  width: 2, alignSelf: 'stretch',
                  background: dragging === i - 1 ? 'var(--green)' : 'var(--border)',
                  transition: 'background 120ms',
                }} />
              </div>
            )}
            {wrapped}
          </Fragment>
        )
      })}
    </div>
  )
}

// Available px for flex panes = container − fixed widths − dividers.
function flexAvail(config: PaneConfig[], sizes: Record<string, number>, el: HTMLElement | null) {
  if (!el) return 0
  const fixedTotal = config.reduce((s, c) => (isFixed(c) ? s + sizes[c.key] : s), 0)
  return el.clientWidth - fixedTotal - (config.length - 1) * DIVIDER_W
}

function totalFlexWeight(config: PaneConfig[], sizes: Record<string, number>) {
  return config.reduce((s, c) => (isFixed(c) ? s : s + sizes[c.key]), 0) || 1
}

// Clamp a fixed pane's proposed width so it stays ≥ its own min and leaves the
// flex panes at least their combined min.
function clampFixed(w: number, self: PaneConfig, config: PaneConfig[], sizes: Record<string, number>, el: HTMLElement | null) {
  let max = Infinity
  if (el) {
    const otherFixed = config.reduce((s, c) => (isFixed(c) && c.key !== self.key ? s + sizes[c.key] : s), 0)
    const flexMin = config.reduce((s, c) => (isFixed(c) ? s : s + minOf(c)), 0)
    max = el.clientWidth - otherFixed - flexMin - (config.length - 1) * DIVIDER_W
  }
  return Math.max(minOf(self), Math.min(w, Math.max(minOf(self), max)))
}
