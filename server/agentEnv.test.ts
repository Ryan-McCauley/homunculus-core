import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { agentEnv, NEVER_FORWARDED } from './agentEnv'

// agentEnv reads process.env directly, so each test stubs the vars it cares about
// and unstubs afterwards. vi.stubEnv handles both set and delete.

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agentEnv — what a bypassPermissions child may see', () => {
  beforeEach(() => {
    // A representative slice of what the real process holds at runtime.
    vi.stubEnv('PATH', '/usr/bin')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-real')
    vi.stubEnv('HOMUNCULUS_MODEL', 'opus')
    vi.stubEnv('GEMINI_API_KEY', 'gem-key')
    vi.stubEnv('GEMINI_API_SECRET', 'gem-secret')
    vi.stubEnv('HA_TOKEN', 'ha-token')
    vi.stubEnv('DATABASE_URL', 'postgres://user:pw@host/db')
    vi.stubEnv('HOMUNCULUS_TOKEN', 'api-token')
    vi.stubEnv('HOMUNCULUS_ADMIN_TOKEN', 'admin-token')
    vi.stubEnv('CMC_API_KEY', 'cmc-key')
    vi.stubEnv('OSINT_AISSTREAM_KEY', 'ais-key')
  })

  it('forwards the Claude session token so the child can authenticate', () => {
    expect(agentEnv()['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-real')
  })

  it('forwards system vars a child needs to spawn anything', () => {
    expect(agentEnv()['PATH']).toBe('/usr/bin')
  })

  it('forwards non-secret app config', () => {
    expect(agentEnv()['HOMUNCULUS_MODEL']).toBe('opus')
  })

  it('forwards NO credential, checked one by one', () => {
    const env = agentEnv()
    for (const key of NEVER_FORWARDED) {
      expect(env[key], `${key} must never reach an agent session`).toBeUndefined()
    }
  })

  it('never leaks a secret VALUE under any key', () => {
    // Stronger than checking key names: catches a future bug that copies a secret
    // into a differently-named variable.
    const values = Object.values(agentEnv())
    for (const secret of ['gem-key', 'gem-secret', 'ha-token', 'admin-token', 'cmc-key', 'ais-key']) {
      expect(values).not.toContain(secret)
    }
    expect(values.some((v) => v.includes('postgres://'))).toBe(false)
  })

  it('is an allowlist — an unknown variable is dropped, not inherited', () => {
    vi.stubEnv('SOME_FUTURE_CREDENTIAL', 'oops')
    expect(agentEnv()['SOME_FUTURE_CREDENTIAL']).toBeUndefined()
  })

  it('forces the local subscription path by withholding billed API keys', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-billed')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'billed-token')
    const env = agentEnv()
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined()
  })

  it('accepts caller-supplied extras (the skill actor stamp)', () => {
    expect(agentEnv({ HOMUNCULUS_SKILL: 'skill:sniper' })['HOMUNCULUS_SKILL']).toBe('skill:sniper')
  })

  it('refuses to let a caller reintroduce a credential through extras', () => {
    const env = agentEnv({ GEMINI_API_SECRET: 'smuggled', HOMUNCULUS_ADMIN_TOKEN: 'smuggled' })
    expect(env['GEMINI_API_SECRET']).toBeUndefined()
    expect(env['HOMUNCULUS_ADMIN_TOKEN']).toBeUndefined()
  })
})
