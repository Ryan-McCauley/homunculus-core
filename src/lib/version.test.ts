import { describe, it, expect } from 'vitest'
import { VERSION, COMMIT, BUILD_DATE } from './version'

// version.ts reads Vite compile-time `define` globals (__APP_VERSION__ etc).
// Under plain vitest (no vite define pass) those identifiers are undefined,
// so the `typeof` guards should fall back to the documented dev placeholders.
describe('version', () => {
  it('falls back to dev placeholders when the Vite define globals are absent', () => {
    expect(VERSION).toBe('0.0.0')
    expect(COMMIT).toBe('dev')
    expect(BUILD_DATE).toBe('')
  })
})
