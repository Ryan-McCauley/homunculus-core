import { describe, it, expect } from 'vitest'
import { isBackgroundKind, CLAUDE_KIND_LABELS, type ClaudeKind } from './claude'

const ALL_KINDS: ClaudeKind[] = ['agent', 'agent-chat', 'agent-handoff', 'skill', 'core-chat', 'proactive']

describe('CLAUDE_KIND_LABELS', () => {
  it('has a label for every ClaudeKind', () => {
    for (const k of ALL_KINDS) expect(CLAUDE_KIND_LABELS[k]).toBeTypeOf('string')
  })
})

describe('isBackgroundKind', () => {
  it('is true only for the proactive monitor', () => {
    expect(isBackgroundKind('proactive')).toBe(true)
  })
  it('is false for every other kind', () => {
    for (const k of ALL_KINDS) {
      if (k === 'proactive') continue
      expect(isBackgroundKind(k)).toBe(false)
    }
  })
})
