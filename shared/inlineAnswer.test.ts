import { describe, it, expect } from 'vitest'
import {
  MAX_INLINE_DEPTH,
  canAnswerInline,
  nextChain,
  type InlineAskContext
} from './inlineAnswer'

function ctx(over: Partial<InlineAskContext> = {}): InlineAskContext {
  return { askedBy: 'trap-setter', askedOf: 'trap-scout', chain: ['trap-setter'], knownAgents: ['manager', 'trap-scout', 'trap-setter', 'trap-steward'], ...over }
}

describe('canAnswerInline', () => {
  it('wakes a colleague to answer straight away — the point of the change', () => {
    const v = canAnswerInline(ctx())
    expect(v.ok).toBe(true)
  })

  it('will not wake the operator: a human answers on human time', () => {
    const v = canAnswerInline(ctx({ askedOf: 'operator' }))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/operator/i)
  })

  it('refuses an agent asking itself', () => {
    expect(canAnswerInline(ctx({ askedBy: 'trap-scout', askedOf: 'trap-scout' })).ok).toBe(false)
  })

  it('refuses an unknown answerer rather than spawning a run for a typo', () => {
    const v = canAnswerInline(ctx({ askedOf: 'trap-scoot' }))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/unknown/i)
  })

  it('BREAKS THE CYCLE: an agent already in the chain is never re-entered', () => {
    // A asks B, B asks A. Without this the desk deadlocks on itself, one run deep each time.
    const v = canAnswerInline(ctx({ askedBy: 'trap-scout', askedOf: 'trap-setter', chain: ['trap-setter', 'trap-scout'] }))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/circular|cycle|already/i)
  })

  it('stops at the depth limit so one question cannot cascade into a fleet-wide wake', () => {
    const deep = Array.from({ length: MAX_INLINE_DEPTH + 1 }, (_, i) => `a${i}`)
    const v = canAnswerInline(ctx({ askedBy: deep[deep.length - 1], chain: deep, knownAgents: [...deep, 'trap-scout'] }))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/depth/i)
  })

  it('allows the last hop that is still inside the limit', () => {
    const chain = Array.from({ length: MAX_INLINE_DEPTH - 1 }, (_, i) => `a${i}`)
    const v = canAnswerInline(ctx({ askedBy: chain[chain.length - 1], chain, knownAgents: [...chain, 'trap-scout'] }))
    expect(v.ok).toBe(true)
  })

  it('refuses when the answerer is benched — a suspended employee does not get woken', () => {
    const v = canAnswerInline(ctx({ benched: true }))
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/benched|suspend/i)
  })

  it('still answers inline when the answerer is merely disabled: enabled governs its OWN triggers, not a colleague\'s direct question', () => {
    expect(canAnswerInline(ctx({ enabled: false })).ok).toBe(true)
  })
})

describe('nextChain', () => {
  it('appends the answerer, which is what the next hop checks against', () => {
    expect(nextChain(['trap-setter'], 'trap-scout')).toEqual(['trap-setter', 'trap-scout'])
  })

  it('does not mutate the chain it was handed', () => {
    const chain = ['trap-setter']
    nextChain(chain, 'trap-scout')
    expect(chain).toEqual(['trap-setter'])
  })

  it('never records the same agent twice', () => {
    expect(nextChain(['a', 'b'], 'b')).toEqual(['a', 'b'])
  })
})
