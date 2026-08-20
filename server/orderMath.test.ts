import { describe, it, expect } from 'vitest'
import { decimalsForIncrement, decimalsOf, floorToDecimals, roundToDecimals } from './orderMath'

describe('decimalsForIncrement', () => {
  it('reads the place count off an exchange increment', () => {
    expect(decimalsForIncrement(1e-8)).toBe(8)
    expect(decimalsForIncrement(0.01)).toBe(2)
    expect(decimalsForIncrement(1)).toBe(0)
  })

  it('clamps a coarser-than-whole increment to 0 rather than a negative width', () => {
    // toFixed(-1) is a RangeError, i.e. a throw from the order path.
    expect(decimalsForIncrement(10)).toBe(0)
    expect(() => floorToDecimals(5, decimalsForIncrement(10))).not.toThrow()
  })

  it('falls back to full precision for a missing or nonsense increment', () => {
    expect(decimalsForIncrement(0)).toBe(8)
    expect(decimalsForIncrement(NaN)).toBe(8)
    expect(decimalsForIncrement(-1)).toBe(8)
  })
})

describe('floorToDecimals', () => {
  it('never rounds an amount up', () => {
    // The defect this exists to prevent: (0.96).toFixed(0) is "1" — an order for
    // more than is held, past a cap that was checked against 0.96.
    expect(floorToDecimals(0.96, 0)).toBe('0')
    expect(floorToDecimals(1.999999, 2)).toBe('1.99')
    expect(floorToDecimals(9.5, 0)).toBe('9')
  })

  it('does not lose a tick to binary floating point', () => {
    // Math.floor(1.15 * 100) / 100 is 1.14 — the naive form gives up a tick.
    expect(floorToDecimals(1.15, 2)).toBe('1.15')
    expect(floorToDecimals(0.29, 2)).toBe('0.29')
    expect(floorToDecimals(0.07, 2)).toBe('0.07')
    expect(floorToDecimals(8.115, 3)).toBe('8.115')
  })

  it('formats at exactly the requested width', () => {
    expect(floorToDecimals(2, 4)).toBe('2.0000')
    expect(floorToDecimals(0.5, 8)).toBe('0.50000000')
  })

  it('handles the magnitudes a large-supply token reaches', () => {
    expect(floorToDecimals(12_345_678.987654321, 6)).toBe('12345678.987654')
    expect(floorToDecimals(1e-8, 8)).toBe('0.00000001')
    expect(floorToDecimals(1e-9, 8)).toBe('0.00000000')
  })

  it('returns a zero of the right shape rather than NaN', () => {
    expect(floorToDecimals(NaN, 2)).toBe('0.00')
    expect(floorToDecimals(Infinity, 2)).toBe('0.00')
    expect(floorToDecimals(-1, 2)).toBe('0.00')
    expect(floorToDecimals(0, 2)).toBe('0.00')
  })
})

describe('roundToDecimals', () => {
  it('rounds a price to the nearest increment in both directions', () => {
    expect(roundToDecimals(1.006, 2)).toBe('1.01')
    expect(roundToDecimals(1.004, 2)).toBe('1.00')
    expect(roundToDecimals(1.005, 2)).toBe('1.01')
  })

  it('is idempotent on an already-conforming price', () => {
    expect(roundToDecimals(Number(roundToDecimals(1.005, 2)), 2)).toBe('1.01')
    expect(roundToDecimals(1.15, 2)).toBe('1.15')
  })

  it('returns a zero of the right shape rather than NaN', () => {
    expect(roundToDecimals(NaN, 2)).toBe('0.00')
    expect(roundToDecimals(0, 4)).toBe('0.0000')
  })
})

describe('decimalsOf', () => {
  it('counts the places a formatted amount carries', () => {
    expect(decimalsOf('0.9600')).toBe(4)
    expect(decimalsOf('12')).toBe(0)
    expect(decimalsOf('')).toBe(0)
  })
})
