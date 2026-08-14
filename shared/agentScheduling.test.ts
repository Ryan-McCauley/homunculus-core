import { describe, it, expect } from 'vitest'
import type { AgentRunTrigger } from './agents'
import { TRIGGER_PRIORITY, pickRunOrder, triggerPriority, type RunCandidate } from './agentScheduling'

function cand(over: Partial<RunCandidate> = {}): RunCandidate {
  return { agentId: 'gate', trigger: 'interval', ...over }
}

describe('triggerPriority', () => {
  it('puts the operator asking above everything the desk decides for itself', () => {
    expect(triggerPriority('manual')).toBeGreaterThan(triggerPriority('answer'))
  })

  it('ranks an answer above assigned work — somebody is already blocked on it', () => {
    expect(triggerPriority('answer')).toBeGreaterThan(triggerPriority('assignment'))
  })

  it('ranks assigned work above a market event', () => {
    expect(triggerPriority('assignment')).toBeGreaterThan(triggerPriority('signal'))
  })

  it('ranks every market event above the interval', () => {
    for (const t of ['signal', 'fill', 'drawdown', 'proposal'] as AgentRunTrigger[]) {
      expect(triggerPriority(t)).toBeGreaterThan(triggerPriority('interval'))
    }
  })

  it('ranks a targeted alert with the market events it is standing in for', () => {
    expect(triggerPriority('alert')).toBeGreaterThanOrEqual(triggerPriority('signal'))
  })

  it('puts office chatter last of the real triggers — this is the whole point', () => {
    for (const t of ['answer', 'assignment', 'alert', 'signal', 'fill', 'drawdown', 'proposal', 'interval'] as AgentRunTrigger[]) {
      expect(triggerPriority(t)).toBeGreaterThan(triggerPriority('mention'))
    }
  })

  it('puts housekeeping below all of it', () => {
    expect(triggerPriority('standdown')).toBeLessThan(triggerPriority('mention'))
  })

  it('gives an unknown trigger the floor rather than the top', () => {
    expect(triggerPriority('nonsense' as AgentRunTrigger)).toBeLessThanOrEqual(triggerPriority('standdown'))
  })

  it('has an entry for every trigger the catalog declares', () => {
    for (const [t, p] of Object.entries(TRIGGER_PRIORITY)) {
      expect(typeof p).toBe('number')
      expect(triggerPriority(t as AgentRunTrigger)).toBe(p)
    }
  })
})

describe('pickRunOrder', () => {
  it('returns an empty list unchanged', () => {
    expect(pickRunOrder([])).toEqual([])
  })

  it('never mutates the array it was given', () => {
    const list = [cand({ agentId: 'b', trigger: 'mention' }), cand({ agentId: 'a', trigger: 'answer' })]
    const frozen = JSON.stringify(list)
    pickRunOrder(list)
    expect(JSON.stringify(list)).toBe(frozen)
  })

  it('orders by trigger priority, not by creation order', () => {
    const out = pickRunOrder([
      cand({ agentId: 'manager', trigger: 'mention' }),
      cand({ agentId: 'trapper', trigger: 'signal' })
    ])
    expect(out.map((c) => c.agentId)).toEqual(['trapper', 'manager'])
  })

  it('breaks a tie on staleness — the agent that has waited longest goes first', () => {
    const out = pickRunOrder([
      cand({ agentId: 'recent', trigger: 'interval', lastAutoRunAt: 9_000 }),
      cand({ agentId: 'stale', trigger: 'interval', lastAutoRunAt: 1_000 })
    ])
    expect(out.map((c) => c.agentId)).toEqual(['stale', 'recent'])
  })

  it('treats an agent that has never run automatically as the stalest', () => {
    const out = pickRunOrder([
      cand({ agentId: 'ran', trigger: 'interval', lastAutoRunAt: 1 }),
      cand({ agentId: 'never', trigger: 'interval' })
    ])
    expect(out.map((c) => c.agentId)).toEqual(['never', 'ran'])
  })

  it('falls back to the agent id so the order is deterministic, never read order', () => {
    const forwards = pickRunOrder([
      cand({ agentId: 'b', trigger: 'interval', lastAutoRunAt: 5 }),
      cand({ agentId: 'a', trigger: 'interval', lastAutoRunAt: 5 })
    ])
    const backwards = pickRunOrder([
      cand({ agentId: 'a', trigger: 'interval', lastAutoRunAt: 5 }),
      cand({ agentId: 'b', trigger: 'interval', lastAutoRunAt: 5 })
    ])
    expect(forwards.map((c) => c.agentId)).toEqual(['a', 'b'])
    expect(backwards.map((c) => c.agentId)).toEqual(['a', 'b'])
  })

  it('stops the last-hired trader being starved by the first-hired talker', () => {
    // The shape of the real desk: manager was hired first and always has chatter waiting;
    // trapper was hired last and is the only agent that can actually trade.
    const out = pickRunOrder([
      cand({ agentId: 'manager', trigger: 'mention', lastAutoRunAt: 8_000 }),
      cand({ agentId: 'oracle', trigger: 'mention', lastAutoRunAt: 7_000 }),
      cand({ agentId: 'trapper', trigger: 'signal', lastAutoRunAt: 1_000 })
    ])
    expect(out[0]?.agentId).toBe('trapper')
  })
})
