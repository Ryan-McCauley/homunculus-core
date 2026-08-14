import { describe, it, expect } from 'vitest'
import { SECRET_SPECS, secretsForModule, findSecretSpec } from './secrets'

describe('SECRET_SPECS catalog', () => {
  it('has unique keys', () => {
    const keys = SECRET_SPECS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('only sets restartRequired/kind when meaningful (no empty-string keys or labels)', () => {
    for (const s of SECRET_SPECS) {
      expect(s.key.length).toBeGreaterThan(0)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('secretsForModule', () => {
  it('returns every spec belonging to a known module', () => {
    const cryptoSpecs = secretsForModule('CRYPTO')
    expect(cryptoSpecs.length).toBeGreaterThan(0)
    expect(cryptoSpecs.every((s) => s.module === 'CRYPTO')).toBe(true)
    expect(cryptoSpecs.map((s) => s.key)).toContain('GEMINI_API_KEY')
  })
  it('returns the global (module: "") specs', () => {
    const globalSpecs = secretsForModule('')
    expect(globalSpecs.map((s) => s.key)).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })
  it('returns an empty array for a module with no secrets', () => {
    expect(secretsForModule('NOPE')).toEqual([])
  })
})

describe('findSecretSpec', () => {
  it('finds a known key', () => {
    expect(findSecretSpec('GEMINI_API_KEY')?.label).toBe('Gemini API key')
  })
  it('returns undefined for an unknown key', () => {
    expect(findSecretSpec('NOT_A_REAL_KEY')).toBeUndefined()
  })
})
