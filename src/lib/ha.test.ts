import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  indexById, stateOf, numOf, attrOf, isOn, round, minutesUntil, relTime, clockTime,
} from './ha'
import type { HaEntity } from '../../shared/homeassistant'

function entity(overrides: Partial<HaEntity> = {}): HaEntity {
  return { entityId: 'sensor.x', state: '1', attributes: {}, ...overrides } as HaEntity
}

describe('indexById / stateOf / numOf / attrOf', () => {
  it('indexes entities by id for lookup', () => {
    const idx = indexById([entity({ entityId: 'a' }), entity({ entityId: 'b', state: '2' })])
    expect(stateOf(idx, 'a')).toBe('1')
    expect(stateOf(idx, 'b')).toBe('2')
  })

  it('stateOf returns null for a missing id', () => {
    const idx = indexById([])
    expect(stateOf(idx, 'missing')).toBeNull()
  })

  it('numOf parses a numeric state', () => {
    const idx = indexById([entity({ entityId: 'temp', state: '72.5' })])
    expect(numOf(idx, 'temp')).toBe(72.5)
  })

  it('numOf returns null for a non-numeric or missing state', () => {
    const idx = indexById([entity({ entityId: 'text', state: 'unavailable' })])
    expect(numOf(idx, 'text')).toBeNull()
    expect(numOf(idx, 'missing')).toBeNull()
  })

  it('attrOf reads an attribute value, or null when absent', () => {
    const idx = indexById([entity({ entityId: 'a', attributes: { brightness: 200 } })])
    expect(attrOf<number>(idx, 'a', 'brightness')).toBe(200)
    expect(attrOf(idx, 'a', 'missing-attr')).toBeNull()
    expect(attrOf(idx, 'missing-entity', 'brightness')).toBeNull()
  })
})

describe('isOn', () => {
  it('treats on/open/unlocked/home as active', () => {
    const idx = indexById([
      entity({ entityId: 'a', state: 'on' }),
      entity({ entityId: 'b', state: 'open' }),
      entity({ entityId: 'c', state: 'unlocked' }),
      entity({ entityId: 'd', state: 'home' }),
    ])
    expect(isOn(idx, 'a')).toBe(true)
    expect(isOn(idx, 'b')).toBe(true)
    expect(isOn(idx, 'c')).toBe(true)
    expect(isOn(idx, 'd')).toBe(true)
  })

  it('treats off/closed/locked/away/missing as inactive', () => {
    const idx = indexById([entity({ entityId: 'a', state: 'off' })])
    expect(isOn(idx, 'a')).toBe(false)
    expect(isOn(idx, 'missing')).toBe(false)
  })
})

describe('round', () => {
  it('returns an em dash for null', () => {
    expect(round(null)).toBe('—')
  })
  it('rounds to 0 digits by default', () => {
    expect(round(3.6)).toBe('4')
  })
  it('rounds to the requested digit count', () => {
    expect(round(3.14159, 2)).toBe('3.14')
  })
})

describe('minutesUntil', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
  afterEach(() => vi.useRealTimers())

  it('returns null for a null/invalid input', () => {
    expect(minutesUntil(null)).toBeNull()
    expect(minutesUntil('not a date')).toBeNull()
  })

  it('computes minutes remaining to a future ISO timestamp', () => {
    expect(minutesUntil('2026-01-01T00:10:00Z')).toBe(10)
  })

  it('returns a negative number for a past timestamp', () => {
    expect(minutesUntil('2025-12-31T23:50:00Z')).toBe(-10)
  })
})

describe('relTime', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-02T00:00:00Z')) })
  afterEach(() => vi.useRealTimers())

  it('returns an em dash for null/invalid input', () => {
    expect(relTime(null)).toBe('—')
    expect(relTime('garbage')).toBe('—')
  })

  it('renders "just now" under a minute', () => {
    // mins = Math.round(ms/60000); 30s rounds up to 1, so use a smaller offset
    expect(relTime(new Date(Date.now() - 10_000).toISOString())).toBe('just now')
  })

  it('renders minutes under an hour', () => {
    expect(relTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago')
  })

  it('renders hours under a day', () => {
    expect(relTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago')
  })

  it('renders days at 24h or more', () => {
    expect(relTime(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d ago')
  })
})

describe('clockTime', () => {
  it('returns an em dash for null/invalid input', () => {
    expect(clockTime(null)).toBe('—')
    expect(clockTime('garbage')).toBe('—')
  })

  it('formats a valid ISO timestamp as a local clock time', () => {
    const iso = '2026-01-01T20:30:00Z'
    expect(clockTime(iso)).toBe(new Date(Date.parse(iso)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  })
})
