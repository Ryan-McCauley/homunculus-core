import { describe, it, expect } from 'vitest'
import { claudeResultError } from './claudeResult'

describe('claudeResultError', () => {
  it('passes a real run', () => {
    expect(claudeResultError({ subtype: 'success', is_error: false, num_turns: 7, result: 'Placed 2 brackets.' }))
      .toBeNull()
  })

  it('fails an explicit error result', () => {
    expect(claudeResultError({ subtype: 'success', is_error: true, num_turns: 1, result: 'Not logged in · Please run /login' }))
      .toBe('Not logged in · Please run /login')
  })

  it('fails a non-success subtype', () => {
    expect(claudeResultError({ subtype: 'error_max_turns', num_turns: 40 })).toBe('error_max_turns')
  })

  // The regression this module exists for: the SDK reports an unresolvable slash
  // command as a zero-turn SUCCESS, which every call site used to believe.
  it('fails an unknown slash command that claims success', () => {
    const err = claudeResultError({ subtype: 'success', is_error: false, num_turns: 0, result: 'Unknown command: /sniper' })
    expect(err).toMatch(/Unknown command: \/sniper/)
    expect(err).toMatch(/\.claude\//)
  })

  it('fails any zero-turn run', () => {
    expect(claudeResultError({ subtype: 'success', is_error: false, num_turns: 0, result: 'nothing to do' }))
      .toMatch(/without taking a turn/)
  })
})
