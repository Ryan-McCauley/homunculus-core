import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fmtPrice, fmtNum, fmtK, ago, changeColor, dirColor, qualColor, G, GD, CR } from './cryptoUi'

describe('fmtPrice', () => {
  it('renders zero and NaN as an em dash', () => {
    expect(fmtPrice(0)).toBe('—')
    expect(fmtPrice('nope')).toBe('—')
  })
  it('drops decimals above 10000', () => {
    expect(fmtPrice(123456.789)).toBe('$123,457')
  })
  it('uses 2 decimals between 1000 and 10000', () => {
    expect(fmtPrice(4321.005)).toBe('$4,321.01')
  })
  it('uses 4 decimals between 1 and 1000', () => {
    expect(fmtPrice(45.6)).toBe('$45.6000')
  })
  it('uses 4 significant digits below 1', () => {
    expect(fmtPrice(0.0012345)).toBe('$0.001234')
  })
  it('accepts a numeric string', () => {
    expect(fmtPrice('42')).toBe('$42.0000')
  })
})

describe('fmtNum', () => {
  it('formats with the requested decimal places', () => {
    expect(fmtNum(1234.5, 2)).toBe('1,234.50')
    expect(fmtNum(1, 0)).toBe('1')
  })
  it('defaults to 2 decimal places', () => {
    expect(fmtNum(1)).toBe('1.00')
  })
  it('renders NaN as an em dash', () => {
    expect(fmtNum('garbage')).toBe('—')
  })
})

describe('fmtK', () => {
  it('scales billions', () => {
    expect(fmtK(2_500_000_000)).toBe('2.50B')
  })
  it('scales millions', () => {
    expect(fmtK(3_400_000)).toBe('3.40M')
  })
  it('scales thousands with one decimal', () => {
    expect(fmtK(12_345)).toBe('12.3K')
  })
  it('leaves sub-thousand values as plain decimals', () => {
    expect(fmtK(42)).toBe('42.00')
  })
})

describe('ago', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('renders seconds under a minute', () => {
    expect(ago(Date.now() - 30_000)).toBe('30s ago')
  })
  it('renders minutes under an hour', () => {
    expect(ago(Date.now() - 5 * 60_000)).toBe('5m ago')
  })
  it('renders hours at an hour or more', () => {
    expect(ago(Date.now() - 3 * 3_600_000)).toBe('3h ago')
  })
})

describe('changeColor', () => {
  it('is green above zero, crimson below, dim at zero', () => {
    expect(changeColor(1)).toBe(G)
    expect(changeColor(-1)).toBe(CR)
    expect(changeColor(0)).toBe(GD)
  })
})

describe('dirColor', () => {
  it('maps BUY/SELL/HOLD to green/crimson/dim', () => {
    expect(dirColor('BUY')).toBe(G)
    expect(dirColor('SELL')).toBe(CR)
    expect(dirColor('HOLD')).toBe(GD)
  })
})

describe('qualColor', () => {
  it('maps HIGH/MEDIUM/other to green/amber/dim', () => {
    expect(qualColor('HIGH')).toBe(G)
    expect(qualColor('MEDIUM')).toBe('#c8a227')
    expect(qualColor('LOW')).toBe(GD)
  })
})
