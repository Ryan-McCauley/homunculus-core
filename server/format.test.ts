import { describe, it, expect } from 'vitest'
import { bytesShort, uptimeShort } from './format'

describe('bytesShort', () => {
  it('reports 0 B for zero, negative, or falsy input', () => {
    expect(bytesShort(0)).toBe('0 B')
    expect(bytesShort(-5)).toBe('0 B')
    expect(bytesShort(NaN)).toBe('0 B')
  })

  it('formats bytes with no decimal place', () => {
    expect(bytesShort(500)).toBe('500 B')
  })

  it('formats kilobytes, megabytes, gigabytes, and terabytes with one decimal place', () => {
    expect(bytesShort(1024)).toBe('1.0 KB')
    expect(bytesShort(1536)).toBe('1.5 KB')
    expect(bytesShort(1024 * 1024)).toBe('1.0 MB')
    expect(bytesShort(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(bytesShort(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB')
  })

  it('caps at TB rather than overflowing the units table', () => {
    expect(bytesShort(1024 * 1024 * 1024 * 1024 * 1024 * 1024)).toBe('1048576.0 TB')
  })
})

describe('uptimeShort', () => {
  it('formats seconds as minutes only when under an hour', () => {
    expect(uptimeShort(0)).toBe('0m')
    expect(uptimeShort(59)).toBe('0m')
    expect(uptimeShort(120)).toBe('2m')
  })

  it('formats hours and minutes when under a day', () => {
    expect(uptimeShort(3600)).toBe('1h 0m')
    expect(uptimeShort(3660)).toBe('1h 1m')
    expect(uptimeShort(86399)).toBe('23h 59m')
  })

  it('formats days and hours once a day has passed, dropping minutes', () => {
    expect(uptimeShort(86400)).toBe('1d 0h')
    expect(uptimeShort(90000)).toBe('1d 1h')
    expect(uptimeShort(2 * 86400 + 5 * 3600 + 45 * 60)).toBe('2d 5h')
  })
})
