import { describe, it, expect, beforeEach, vi } from 'vitest'

// The module captures an `envBaseline` snapshot of process.env at import time
// (for SECRET_SPECS keys) and keeps its vault as a module-level singleton, so
// every test needs a fresh module instance over a controlled env.
async function freshModule() {
  vi.resetModules()
  return import('./secrets')
}

const ALL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'HOMUNCULUS_TOKEN', 'GEMINI_API_KEY', 'GEMINI_API_SECRET',
  'CMC_API_KEY', 'HA_URL', 'HA_TOKEN', 'OSINT_AISSTREAM_KEY', 'OSINT_PIZZA_KEY', 'DATABASE_URL',
]

beforeEach(() => {
  for (const k of ALL_KEYS) vi.stubEnv(k, '')
})

describe('status()', () => {
  it('reports every catalogued secret as unset when nothing is configured', async () => {
    const m = await freshModule()
    const st = m.status()
    expect(st).toHaveLength(ALL_KEYS.length)
    for (const s of st) {
      expect(s.set).toBe(false)
      expect(s.source).toBe('none')
      expect(s.last4).toBe('')
    }
  })

  it('reports env-sourced secrets present at boot, with a last-4 fingerprint', async () => {
    vi.stubEnv('CMC_API_KEY', 'abcd1234wxyz')
    const m = await freshModule()
    const cmc = m.status().find((s) => s.key === 'CMC_API_KEY')!
    expect(cmc.set).toBe(true)
    expect(cmc.source).toBe('env')
    expect(cmc.last4).toBe('wxyz')
  })

  it('does not fingerprint a value shorter than 4 characters', async () => {
    vi.stubEnv('CMC_API_KEY', 'abc')
    const m = await freshModule()
    const cmc = m.status().find((s) => s.key === 'CMC_API_KEY')!
    expect(cmc.set).toBe(true)
    expect(cmc.last4).toBe('')
  })

  it('prefers the vault over env once a value has been applied', async () => {
    vi.stubEnv('CMC_API_KEY', 'env-value-1234')
    const m = await freshModule()
    m.applyVault({ CMC_API_KEY: 'vault-value-5678' })
    const cmc = m.status().find((s) => s.key === 'CMC_API_KEY')!
    expect(cmc.source).toBe('vault')
    expect(cmc.last4).toBe('5678')
  })
})

describe('applyVault()', () => {
  it('accepts known keys and reports the count applied', async () => {
    const m = await freshModule()
    const res = m.applyVault({ CMC_API_KEY: 'value-1', GEMINI_API_KEY: 'value-2' })
    expect(res.applied).toBe(2)
    expect(res.ignored).toEqual([])
  })

  it('ignores keys outside the secret catalogue and reports them', async () => {
    const m = await freshModule()
    const res = m.applyVault({ NOT_A_REAL_SECRET: 'x' })
    expect(res.applied).toBe(0)
    expect(res.ignored).toEqual(['NOT_A_REAL_SECRET'])
  })

  it('drops non-string and empty-string values silently (not counted, not ignored)', async () => {
    const m = await freshModule()
    const res = m.applyVault({ CMC_API_KEY: '', GEMINI_API_KEY: 42 as unknown as string })
    expect(res.applied).toBe(0)
    expect(res.ignored).toEqual([])
  })

  it('pushes accepted values into process.env so consuming modules see them', async () => {
    const m = await freshModule()
    m.applyVault({ CMC_API_KEY: 'pushed-value' })
    expect(process.env['CMC_API_KEY']).toBe('pushed-value')
  })

  it('replaces the whole vault: a key dropped from a later call clears process.env', async () => {
    const m = await freshModule()
    m.applyVault({ CMC_API_KEY: 'first' })
    expect(process.env['CMC_API_KEY']).toBe('first')
    m.applyVault({ GEMINI_API_KEY: 'other' })
    expect(process.env['CMC_API_KEY']).toBeUndefined()
    expect(m.status().find((s) => s.key === 'CMC_API_KEY')!.set).toBe(false)
  })

  it('restores the .env baseline for a key the vault drops, instead of leaving it unset', async () => {
    vi.stubEnv('CMC_API_KEY', 'dotenv-baseline')
    const m = await freshModule()
    m.applyVault({ CMC_API_KEY: 'vault-override' })
    expect(process.env['CMC_API_KEY']).toBe('vault-override')
    // Vault call that no longer includes CMC_API_KEY should fall back to .env, not vanish.
    m.applyVault({ GEMINI_API_KEY: 'other' })
    expect(process.env['CMC_API_KEY']).toBe('dotenv-baseline')
    expect(m.status().find((s) => s.key === 'CMC_API_KEY')!.source).toBe('env')
  })
})

describe('moduleReadiness()', () => {
  it('is true for a module whose only required key is set', async () => {
    vi.stubEnv('HA_URL', 'http://homeassistant.local:8123')
    vi.stubEnv('HA_TOKEN', 'token-value')
    const m = await freshModule()
    expect(m.moduleReadiness()['HOME']).toBe(true)
  })

  it('is false when any required key for the module is missing', async () => {
    vi.stubEnv('HA_URL', 'http://homeassistant.local:8123')
    // HA_TOKEN intentionally left unset.
    const m = await freshModule()
    expect(m.moduleReadiness()['HOME']).toBe(false)
  })

  it('does not gate a module on keys that are optional (not required)', async () => {
    // CRYPTO's only required-ness comes from keys marked required:true; none of
    // its keys are required, so the module should read as ready with nothing set.
    const m = await freshModule()
    const readiness = m.moduleReadiness()
    expect(readiness['CRYPTO']).toBeUndefined()
  })
})
