import { describe, it, expect } from 'vitest'
import { ALERT_SOURCES, alertSource, alertCondition, describeAlert, type CryptoAlert } from './alerts'

describe('ALERT_SOURCES catalog', () => {
  it('has unique source ids', () => {
    const ids = ALERT_SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('has unique condition ids within each source', () => {
    for (const s of ALERT_SOURCES) {
      const ids = s.conditions.map((c) => c.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
  it('every condition needing a value declares a defaultValue or leaves the user to enter one', () => {
    // Not all needsValue conditions have a default (e.g. price above/below) — just assert
    // the shape is internally consistent: defaultValue is only set when needsValue is true.
    for (const s of ALERT_SOURCES) {
      for (const c of s.conditions) {
        if (c.defaultValue != null) expect(c.needsValue).toBe(true)
      }
    }
  })
})

describe('alertSource', () => {
  it('finds a known source', () => {
    expect(alertSource('rsi')?.label).toBe('RSI 14')
  })
  it('returns undefined for an unknown source', () => {
    expect(alertSource('nope' as any)).toBeUndefined()
  })
})

describe('alertCondition', () => {
  it('finds a known condition on a known source', () => {
    expect(alertCondition('rsi', 'above')?.label).toBe('CROSSES ABOVE')
  })
  it('returns undefined for an unknown condition on a known source', () => {
    expect(alertCondition('rsi', 'nope')).toBeUndefined()
  })
  it('returns undefined for an unknown source entirely', () => {
    expect(alertCondition('nope' as any, 'above')).toBeUndefined()
  })
})

function makeAlert(overrides: Partial<CryptoAlert> = {}): CryptoAlert {
  return {
    id: 'alert_1', symbol: 'BTCUSD', source: 'rsi', condition: 'above', value: 70,
    tf: '1hr', action: 'notify', stageUsd: 20, once: false, armed: true,
    createdAt: 0, lastFiredAt: null, fireCount: 0, lastNote: null,
    ...overrides,
  }
}

describe('describeAlert', () => {
  it('renders symbol, timeframe, source label, condition label, and value', () => {
    expect(describeAlert(makeAlert())).toBe('BTCUSD 1hr · RSI 14 CROSSES ABOVE 70')
  })
  it('omits the value when the condition does not carry one', () => {
    const a = makeAlert({ source: 'ema-cross', condition: 'bull', value: null })
    expect(describeAlert(a)).toBe('BTCUSD 1hr · EMA 9 × EMA 21 BULLISH CROSS')
  })
  it('falls back to the raw ids if the source/condition is somehow unknown', () => {
    const a = makeAlert({ source: 'made-up' as any, condition: 'also-made-up', value: null })
    expect(describeAlert(a)).toBe('BTCUSD 1hr · made-up also-made-up')
  })
})
