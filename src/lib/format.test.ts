import { describe, it, expect } from 'vitest'
import { bytes, uptime, sparkline, loadColor } from './format'

describe('bytes', () => {
  it('renders zero and negative as "0 B"', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(-5)).toBe('0 B')
  })
  it('renders plain bytes with no decimals', () => {
    expect(bytes(512)).toBe('512 B')
  })
  it('scales to KB/MB/GB with the requested digits', () => {
    expect(bytes(2048)).toBe('2.0 KB')
    expect(bytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(bytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
  it('honors a custom digits count', () => {
    expect(bytes(1536, 2)).toBe('1.50 KB')
  })
  it('caps scaling at PB', () => {
    const huge = Math.pow(1024, 6) // one exabyte-equivalent, past PB
    expect(bytes(huge)).toContain('PB')
  })
})

describe('uptime', () => {
  it('formats sub-day durations as HH:MM', () => {
    expect(uptime(0)).toBe('00:00')
    expect(uptime(3661)).toBe('01:01')
  })
  it('formats multi-day durations as "Nd HH:MM"', () => {
    expect(uptime(14 * 86400 + 6 * 3600 + 60)).toBe('14d 06:01')
  })
})

describe('sparkline', () => {
  it('returns an empty string for no history', () => {
    expect(sparkline([], 100, 20)).toBe('')
  })
  it('places a single point at x=0', () => {
    expect(sparkline([50], 100, 20)).toBe('0.0,10.0')
  })
  it('spaces multiple points evenly across the width and inverts y for value', () => {
    // history of 0,100 over w=10,h=10: x steps 0 and 10; y = h - v/100*h => 10 and 0
    expect(sparkline([0, 100], 10, 10)).toBe('0.0,10.0 10.0,0.0')
  })
})

describe('loadColor', () => {
  it('is crimson at/above 85', () => {
    expect(loadColor(85)).toBe('var(--crimson)')
    expect(loadColor(100)).toBe('var(--crimson)')
  })
  it('is amber between 60 and 85', () => {
    expect(loadColor(60)).toBe('var(--amber)')
    expect(loadColor(84.9)).toBe('var(--amber)')
  })
  it('is green below 60', () => {
    expect(loadColor(0)).toBe('var(--green)')
    expect(loadColor(59.9)).toBe('var(--green)')
  })
})
