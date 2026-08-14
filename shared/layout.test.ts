import { describe, it, expect } from 'vitest'
import {
  GRID_COLS,
  LAYOUT_VERSION,
  defaultLayout,
  resolveDefaultTab,
  sanitizeLayout,
  enabledTabs,
  type LayoutConfig,
  type TabConfig,
} from './layout'

function tab(overrides: Partial<TabConfig> = {}): TabConfig {
  return { id: 'A', label: 'A', enabled: true, builtin: false, widgets: [], ...overrides }
}

describe('defaultLayout', () => {
  it('is versioned and defaults to BRIDGE', () => {
    const l = defaultLayout()
    expect(l.version).toBe(LAYOUT_VERSION)
    expect(l.defaultTab).toBe('BRIDGE')
  })
  it('includes all six stock tabs, all enabled and builtin', () => {
    const l = defaultLayout()
    expect(l.tabs.map((t) => t.id)).toEqual([
      'BRIDGE', 'OSINT', 'HOME', 'DATA', 'ARCHIVE', 'CRYPTO',
    ])
    expect(l.tabs.every((t) => t.enabled)).toBe(true)
    expect(l.tabs.every((t) => t.builtin)).toBe(true)
  })
  it('gives every dashboard tab a single full-bleed widget', () => {
    const l = defaultLayout()
    for (const t of l.tabs) {
      if (t.id === 'BRIDGE') continue
      expect(t.widgets).toHaveLength(1)
      expect(t.widgets[0]).toMatchObject({ x: 0, y: 0, w: GRID_COLS, h: 24 })
    }
  })
  it('returns a fresh object each call (callers can mutate safely)', () => {
    expect(defaultLayout()).not.toBe(defaultLayout())
    expect(defaultLayout().tabs).not.toBe(defaultLayout().tabs)
  })
})

describe('resolveDefaultTab', () => {
  it('keeps the configured default when it is enabled', () => {
    const l: LayoutConfig = { version: 1, defaultTab: 'B', tabs: [tab({ id: 'A' }), tab({ id: 'B' })] }
    expect(resolveDefaultTab(l)).toBe('B')
  })
  it('falls back to the first enabled tab when the configured default is disabled', () => {
    const l: LayoutConfig = {
      version: 1, defaultTab: 'A',
      tabs: [tab({ id: 'A', enabled: false }), tab({ id: 'B', enabled: true })],
    }
    expect(resolveDefaultTab(l)).toBe('B')
  })
  it('falls back to the first enabled tab when the configured default does not exist', () => {
    const l: LayoutConfig = { version: 1, defaultTab: 'NOPE', tabs: [tab({ id: 'A' })] }
    expect(resolveDefaultTab(l)).toBe('A')
  })
  it('returns empty string when every tab is disabled', () => {
    const l: LayoutConfig = {
      version: 1, defaultTab: 'A',
      tabs: [tab({ id: 'A', enabled: false }), tab({ id: 'B', enabled: false })],
    }
    expect(resolveDefaultTab(l)).toBe('')
  })
})

describe('enabledTabs', () => {
  it('filters out disabled tabs, preserving order', () => {
    const l: LayoutConfig = {
      version: 1, defaultTab: 'A',
      tabs: [tab({ id: 'A' }), tab({ id: 'B', enabled: false }), tab({ id: 'C' })],
    }
    expect(enabledTabs(l).map((t) => t.id)).toEqual(['A', 'C'])
  })
})

describe('sanitizeLayout — graceful fallback on corrupt input', () => {
  it('falls back to the stock layout for null, undefined, or a non-object', () => {
    expect(sanitizeLayout(null)).toEqual(defaultLayout())
    expect(sanitizeLayout(undefined)).toEqual(defaultLayout())
    expect(sanitizeLayout('not an object')).toEqual(defaultLayout())
    expect(sanitizeLayout(42)).toEqual(defaultLayout())
  })
  it('falls back to the stock layout when tabs is missing, not an array, or empty', () => {
    expect(sanitizeLayout({})).toEqual(defaultLayout())
    expect(sanitizeLayout({ tabs: 'nope' })).toEqual(defaultLayout())
    expect(sanitizeLayout({ tabs: [] })).toEqual(defaultLayout())
  })
  it('falls back to the stock layout when every tab entry is unusable', () => {
    expect(sanitizeLayout({ tabs: [null, { id: 42 }, { id: '   ' }] })).toEqual(defaultLayout())
  })
  it('drops a tab entry missing a usable string id', () => {
    const out = sanitizeLayout({ tabs: [{ id: 123 }, { id: 'ok' }] })
    expect(out.tabs.map((t) => t.id)).toEqual(['OK'])
  })
  it('upper-cases and trims tab ids', () => {
    const out = sanitizeLayout({ tabs: [{ id: '  bridge  ' }] })
    expect(out.tabs[0].id).toBe('BRIDGE')
  })
  it('drops a duplicate tab id (case-insensitive), keeping the first occurrence', () => {
    const out = sanitizeLayout({ tabs: [{ id: 'foo', label: 'first' }, { id: 'FOO', label: 'second' }] })
    expect(out.tabs).toHaveLength(1)
    expect(out.tabs[0].label).toBe('first')
  })
  it('falls back to the tab id as the label when label is missing or not a string', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'foo' }] }).tabs[0].label).toBe('FOO')
    expect(sanitizeLayout({ tabs: [{ id: 'foo', label: 42 }] }).tabs[0].label).toBe('FOO')
    expect(sanitizeLayout({ tabs: [{ id: 'foo', label: '   ' }] }).tabs[0].label).toBe('FOO')
  })
  it('trims a valid string label', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'foo', label: '  My Tab  ' }] }).tabs[0].label).toBe('My Tab')
  })
  it('treats enabled as true unless explicitly false', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'foo' }] }).tabs[0].enabled).toBe(true)
    expect(sanitizeLayout({ tabs: [{ id: 'foo', enabled: 'truthy-but-not-boolean' }] }).tabs[0].enabled).toBe(true)
    expect(sanitizeLayout({ tabs: [{ id: 'foo', enabled: false }] }).tabs[0].enabled).toBe(false)
  })
  it('treats builtin as false unless explicitly true', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'foo' }] }).tabs[0].builtin).toBe(false)
    expect(sanitizeLayout({ tabs: [{ id: 'foo', builtin: 'yes' }] }).tabs[0].builtin).toBe(false)
    expect(sanitizeLayout({ tabs: [{ id: 'foo', builtin: true }] }).tabs[0].builtin).toBe(true)
  })
  it('defaults widgets to an empty array when missing or not an array', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'foo' }] }).tabs[0].widgets).toEqual([])
    expect(sanitizeLayout({ tabs: [{ id: 'foo', widgets: 'nope' }] }).tabs[0].widgets).toEqual([])
  })
  it('drops a widget with no usable `widget` registry key', () => {
    const out = sanitizeLayout({ tabs: [{ id: 'foo', widgets: [{ widget: '' }, { x: 0 }, null] }] })
    expect(out.tabs[0].widgets).toEqual([])
  })
  it('generates an instance id from the widget key + index when instance is missing', () => {
    const out = sanitizeLayout({ tabs: [{ id: 'foo', widgets: [{ widget: 'w.one' }] }] })
    expect(out.tabs[0].widgets[0].instance).toBe('w.one-0')
  })
  it('drops a widget whose instance collides with one already kept, preserving the first', () => {
    const out = sanitizeLayout({
      tabs: [{ id: 'foo', widgets: [
        { widget: 'w.one', instance: 'same' },
        { widget: 'w.two', instance: 'same' },
      ] }],
    })
    expect(out.tabs[0].widgets).toHaveLength(1)
    expect(out.tabs[0].widgets[0].widget).toBe('w.one')
  })
  it('clamps w to [1, GRID_COLS], defaulting to 4', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', w: 999 }] }] }).tabs[0].widgets[0].w).toBe(GRID_COLS)
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', w: 0 }] }] }).tabs[0].widgets[0].w).toBe(1)
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w' }] }] }).tabs[0].widgets[0].w).toBe(4)
  })
  it('clamps x so the widget cannot run off the right edge given its (clamped) width', () => {
    // w defaults to 4, so max x is GRID_COLS - 4 = 8
    const out = sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', x: 999 }] }] })
    expect(out.tabs[0].widgets[0].x).toBe(GRID_COLS - 4)
  })
  it('clamps a negative x to 0', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', x: -5 }] }] }).tabs[0].widgets[0].x).toBe(0)
  })
  it('clamps h to [2, 999], defaulting to 6', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', h: 0 }] }] }).tabs[0].widgets[0].h).toBe(2)
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w' }] }] }).tabs[0].widgets[0].h).toBe(6)
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', h: 5000 }] }] }).tabs[0].widgets[0].h).toBe(999)
  })
  it('rounds a fractional numeric dimension rather than truncating', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', h: 6.6 }] }] }).tabs[0].widgets[0].h).toBe(7)
  })
  it('uses the default when a dimension is not a finite number (NaN, Infinity, string)', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', h: NaN }] }] }).tabs[0].widgets[0].h).toBe(6)
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', h: Infinity }] }] }).tabs[0].widgets[0].h).toBe(6)
    expect(sanitizeLayout({ tabs: [{ id: 'a', widgets: [{ widget: 'w', h: '10' as any }] }] }).tabs[0].widgets[0].h).toBe(6)
  })
  it('always stamps the current LAYOUT_VERSION regardless of what was read', () => {
    expect(sanitizeLayout({ version: 999, tabs: [{ id: 'a' }] }).version).toBe(LAYOUT_VERSION)
  })
  it('upper-cases a string defaultTab', () => {
    expect(sanitizeLayout({ defaultTab: 'foo', tabs: [{ id: 'foo' }] }).defaultTab).toBe('FOO')
  })
  it('falls back to the first surviving tab when defaultTab is missing or not a string', () => {
    expect(sanitizeLayout({ tabs: [{ id: 'foo' }] }).defaultTab).toBe('FOO')
    expect(sanitizeLayout({ defaultTab: 42, tabs: [{ id: 'foo' }] }).defaultTab).toBe('FOO')
  })
  it('falls back to the first surviving tab when defaultTab names a tab that got dropped', () => {
    expect(sanitizeLayout({ defaultTab: 'GHOST', tabs: [{ id: 'foo' }] }).defaultTab).toBe('FOO')
  })
  it('falls back to the first surviving tab when defaultTab names a disabled tab', () => {
    const out = sanitizeLayout({
      defaultTab: 'foo',
      tabs: [{ id: 'foo', enabled: false }, { id: 'bar', enabled: true }],
    })
    expect(out.defaultTab).toBe('BAR')
  })
  it('round-trips a fully well-formed layout unchanged in shape', () => {
    const good = defaultLayout()
    expect(sanitizeLayout(good)).toEqual(good)
  })
})
