import { describe, it, expect } from 'vitest'
import {
  HOME_VIEWS, parseHomeRoute, formatHomeRoute, slugify, isHomeView, type HomeRoute,
} from './homeRoute'

describe('slugify', () => {
  it('lowercases and hyphenates an area name', () => {
    expect(slugify('Living Room')).toBe('living-room')
  })

  it('strips punctuation and collapses separators', () => {
    expect(slugify("Ryan's  Office!")).toBe('ryans-office')
  })

  it('returns an empty string for input with nothing slug-worthy', () => {
    expect(slugify('---')).toBe('')
    expect(slugify('')).toBe('')
  })
})

describe('isHomeView', () => {
  it('accepts the four known views', () => {
    for (const v of HOME_VIEWS) expect(isHomeView(v)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isHomeView('bridge')).toBe(false)
    expect(isHomeView('')).toBe(false)
  })
})

describe('parseHomeRoute', () => {
  it('defaults to the overview for empty or non-home hashes', () => {
    expect(parseHomeRoute('')).toEqual({ view: 'overview' })
    expect(parseHomeRoute('#/')).toEqual({ view: 'overview' })
    expect(parseHomeRoute('#/crypto')).toEqual({ view: 'overview' })
  })

  it('parses a bare view', () => {
    expect(parseHomeRoute('#/home/sectors')).toEqual({ view: 'sectors' })
  })

  it('parses a sector selection', () => {
    expect(parseHomeRoute('#/home/sectors/living-room')).toEqual({ view: 'sectors', sector: 'living-room' })
  })

  it('parses registry filters from the query string', () => {
    expect(parseHomeRoute('#/home/registry?domain=sensor&q=temp')).toEqual({
      view: 'registry', domain: 'sensor', q: 'temp',
    })
  })

  it('decodes percent-encoded query values', () => {
    expect(parseHomeRoute('#/home/registry?q=living%20room')).toEqual({ view: 'registry', q: 'living room' })
  })

  it('treats uplink=open as the palette being open', () => {
    expect(parseHomeRoute('#/home/overview?uplink=open')).toEqual({ view: 'overview', uplink: true })
  })

  it('falls back to the overview for an unknown view', () => {
    expect(parseHomeRoute('#/home/warp-core')).toEqual({ view: 'overview' })
  })

  it('tolerates a missing leading hash and a trailing slash', () => {
    expect(parseHomeRoute('/home/registry/')).toEqual({ view: 'registry' })
  })

  it('normalizes a sector selection to a slug', () => {
    expect(parseHomeRoute('#/home/sectors/Living%20Room')).toEqual({ view: 'sectors', sector: 'living-room' })
  })

  it('ignores empty query values rather than carrying blank filters', () => {
    expect(parseHomeRoute('#/home/registry?domain=&q=')).toEqual({ view: 'registry' })
  })
})

describe('formatHomeRoute', () => {
  it('formats a bare view', () => {
    expect(formatHomeRoute({ view: 'overview' })).toBe('#/home/overview')
  })

  it('formats a sector selection', () => {
    expect(formatHomeRoute({ view: 'sectors', sector: 'living-room' })).toBe('#/home/sectors/living-room')
  })

  it('formats registry filters in a stable key order', () => {
    expect(formatHomeRoute({ view: 'registry', q: 'temp', domain: 'sensor' }))
      .toBe('#/home/registry?domain=sensor&q=temp')
  })

  it('percent-encodes query values', () => {
    expect(formatHomeRoute({ view: 'registry', q: 'living room' })).toBe('#/home/registry?q=living%20room')
  })

  it('emits uplink=open only when the palette is open', () => {
    expect(formatHomeRoute({ view: 'overview', uplink: true })).toBe('#/home/overview?uplink=open')
    expect(formatHomeRoute({ view: 'overview', uplink: false })).toBe('#/home/overview')
  })

  it('drops a sector on views that do not take one', () => {
    expect(formatHomeRoute({ view: 'registry', sector: 'living-room' } as HomeRoute)).toBe('#/home/registry')
  })

  it('round-trips every route it produces', () => {
    const routes: HomeRoute[] = [
      { view: 'overview' },
      { view: 'sectors', sector: 'living-room' },
      { view: 'registry', domain: 'light', q: 'shelf strip' },
      { view: 'automata' },
      { view: 'overview', uplink: true },
    ]
    for (const r of routes) expect(parseHomeRoute(formatHomeRoute(r))).toEqual(r)
  })
})
