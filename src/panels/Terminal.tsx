import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cssVar } from '../lib/tokens'

let termCounter = 0

function termTheme() {
  const bg = cssVar('--term-bg')
  return {
    background: bg,
    foreground: cssVar('--term-fg'),
    cursor: cssVar('--term-cursor'),
    cursorAccent: bg,
    selectionBackground: cssVar('--term-selection'),
    black: cssVar('--term-black'),
    green: cssVar('--term-green'),
    brightGreen: cssVar('--term-white'),
    red: cssVar('--term-red'),
    brightRed: cssVar('--term-red'),
    white: cssVar('--term-white'),
    brightWhite: cssVar('--term-bright-white'),
  }
}

export function Terminal(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !window.homunculus) return

    const id = `term-${termCounter++}`
    const term = new XTerm({
      fontFamily: "'Share Tech Mono', ui-monospace, monospace",
      fontSize: 17,
      lineHeight: 1.1,
      scrollback: 1000,
      cursorBlink: true,
      allowTransparency: true,
      theme: termTheme()
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    let dataSub: ReturnType<XTerm['onData']> | undefined
    let offData: (() => void) | undefined
    let offExited: (() => void) | undefined
    let started = false

    // The host is inside a flex SplitPane that may still be laying out on
    // first paint (BRIDGE is the default tab), so its box can have zero
    // dimensions at this instant. fit.fit() reads renderer.dimensions, which
    // throws if the container hasn't been measured yet — wait a couple of
    // frames for layout to settle before fitting/starting the session.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return
        try {
          fit.fit()
        } catch { /* layout not ready */ }

        started = true
        window.homunculus.termStart(id, term.cols, term.rows)

        dataSub = term.onData((data) => window.homunculus.termInput(id, data))
        offData = window.homunculus.onTermData((p) => {
          if (p.id === id) term.write(p.data)
        })
        offExited = window.homunculus.onTermExit((p) => {
          if (p.id === id) term.write('\r\n\x1b[2m[ session ended ]\x1b[0m\r\n')
        })
      })
      cleanupRaf2 = () => cancelAnimationFrame(raf2)
    })
    let cleanupRaf2: () => void = () => {}

    let resizeTimer: number | undefined
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit()
          window.homunculus.termResize(id, term.cols, term.rows)
        } catch { /* host detached mid-resize */ }
      }, 80)
    })
    ro.observe(host)

    // Watch for data-theme attribute changes and re-apply terminal theme.
    const mo = new MutationObserver(() => {
      term.options.theme = termTheme()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      cancelAnimationFrame(raf1)
      cleanupRaf2()
      window.clearTimeout(resizeTimer)
      ro.disconnect()
      mo.disconnect()
      dataSub?.dispose()
      offData?.()
      offExited?.()
      if (started) window.homunculus.termKill(id)
      term.dispose()
      termRef.current = null
    }
  }, [])

  return (
    <section style={{ flex: 1.3, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-label">
        <span>Terminal — bash</span>
        <span className="muted">~/</span>
      </div>
      <div
        className="card"
        style={{ flex: 1, minHeight: 0, padding: 6, overflow: 'hidden', background: 'var(--term-bg)' }}
      >
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </section>
  )
}
