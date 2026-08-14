import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cssVar, tokens } from './tokens'

/** vitest runs under `environment: 'node'`, which has neither `document` nor
 *  `getComputedStyle`. Stub both with a minimal CSS-variable lookup. */
function stubCssVars(vars: Record<string, string>) {
  vi.stubGlobal('document', { documentElement: {} })
  vi.stubGlobal('getComputedStyle', (_el: unknown) => ({
    getPropertyValue: (name: string) => vars[name] ?? '',
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cssVar', () => {
  it('reads and trims a CSS custom property off the document element', () => {
    stubCssVars({ '--green': '  #00ff88  ' })
    expect(cssVar('--green')).toBe('#00ff88')
  })
  it('returns an empty string for an unset property', () => {
    stubCssVars({})
    expect(cssVar('--nope')).toBe('')
  })
})

describe('tokens', () => {
  beforeEach(() => {
    stubCssVars({
      '--green': 'g', '--green-soft': 'gs', '--green-dim': 'gd', '--green-line': 'gl',
      '--amber': 'a', '--crimson': 'c', '--blue': 'b', '--holo': 'h', '--holo-dim': 'hd',
      '--svg-deep': 'sd', '--svg-panel': 'sp', '--chart-track': 'ct',
    })
  })

  it('maps every CSS variable to its named token', () => {
    expect(tokens()).toEqual({
      green: 'g', soft: 'gs', dim: 'gd', line: 'gl',
      amber: 'a', crimson: 'c', blue: 'b', holo: 'h', holoDim: 'hd',
      svgDeep: 'sd', svgPanel: 'sp', chartTrack: 'ct',
    })
  })
})
