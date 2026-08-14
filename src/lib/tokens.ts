export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function tokens() {
  return {
    green:   cssVar('--green'),
    soft:    cssVar('--green-soft'),
    dim:     cssVar('--green-dim'),
    line:    cssVar('--green-line'),
    amber:   cssVar('--amber'),
    crimson: cssVar('--crimson'),
    blue:    cssVar('--blue'),
    holo:    cssVar('--holo'),
    holoDim: cssVar('--holo-dim'),
    svgDeep: cssVar('--svg-deep'),
    svgPanel: cssVar('--svg-panel'),
    chartTrack: cssVar('--chart-track'),
  }
}
