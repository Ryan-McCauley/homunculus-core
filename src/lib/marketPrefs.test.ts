import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadPrefs, savePrefs, isAutoList, indicatorsFor, DEFAULT_INDICATORS, type MarketPrefs } from './marketPrefs'

/** Minimal in-memory localStorage — this suite runs under vitest's node
 *  environment, which has no DOM/localStorage global of its own. */
function makeMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMemoryStorage())
})

describe('loadPrefs', () => {
  it('returns defaults when nothing is stored', () => {
    const prefs = loadPrefs()
    expect(prefs.activeListId).toBe('core')
    expect(prefs.tabs).toEqual(['BTCUSD'])
    expect(prefs.layout).toBe('single')
    expect(prefs.lists).toEqual([{ id: 'core', name: 'CORE', symbols: ['BTCUSD', 'ETHUSD', 'SOLUSD'] }])
  })
  it('returns defaults when the stored JSON is corrupt', () => {
    localStorage.setItem('homunculus.crypto.market', '{not json')
    const prefs = loadPrefs()
    expect(prefs.activeListId).toBe('core')
  })
  it('round-trips a saved value through save/load', () => {
    const custom: MarketPrefs = {
      lists: [{ id: 'watch', name: 'WATCH', symbols: ['ETHUSD'] }],
      activeListId: 'watch',
      tabs: ['ETHUSD'],
      layout: 'quad',
      indicators: { ETHUSD: ['rsi'] },
    }
    savePrefs(custom)
    expect(loadPrefs()).toEqual(custom)
  })
  it('falls back to defaults for an empty lists/tabs array rather than keeping it empty', () => {
    localStorage.setItem('homunculus.crypto.market', JSON.stringify({ lists: [], tabs: [] }))
    const prefs = loadPrefs()
    expect(prefs.lists.length).toBeGreaterThan(0)
    expect(prefs.tabs.length).toBeGreaterThan(0)
  })
  it('defaults indicators to an empty map when absent', () => {
    localStorage.setItem('homunculus.crypto.market', JSON.stringify({}))
    expect(loadPrefs().indicators).toEqual({})
  })
})

describe('savePrefs', () => {
  it('swallows a storage error instead of throwing (e.g. quota exceeded)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded') },
    })
    expect(() => savePrefs(loadPrefs())).not.toThrow()
  })
})

describe('isAutoList', () => {
  it('flags auto: prefixed ids', () => {
    expect(isAutoList('auto:movers')).toBe(true)
    expect(isAutoList('auto:holdings')).toBe(true)
  })
  it('does not flag a normal list id', () => {
    expect(isAutoList('core')).toBe(false)
  })
})

describe('indicatorsFor', () => {
  it('returns the per-symbol selection when set', () => {
    const prefs = { ...loadPrefs(), indicators: { BTCUSD: ['macd', 'atr'] as any } }
    expect(indicatorsFor(prefs, 'BTCUSD')).toEqual(['macd', 'atr'])
  })
  it('falls back to DEFAULT_INDICATORS for an unconfigured symbol', () => {
    const prefs = loadPrefs()
    expect(indicatorsFor(prefs, 'SOLUSD')).toBe(DEFAULT_INDICATORS)
  })
})
