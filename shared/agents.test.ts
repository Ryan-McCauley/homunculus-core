import { describe, it, expect } from 'vitest'
import {
  AGENT_MODELS,
  isAgentModel,
  agentModelLabel,
  emptyAgentUsage,
  emptyAgentUsageTotals,
  totalTokens,
  fmtTokens,
  contextFill,
  agentStrategyId,
  isAgentStrategyId,
  AGENT_STRATEGY_PREFIX,
  type AgentUsage,
} from './agents'

describe('AGENT_MODELS catalog', () => {
  it('has unique ids', () => {
    const ids = AGENT_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('includes the server-default empty-id entry', () => {
    expect(AGENT_MODELS.some((m) => m.id === '')).toBe(true)
  })
})

describe('isAgentModel', () => {
  it('accepts every id already in the catalog, including the empty server-default id', () => {
    for (const m of AGENT_MODELS) expect(isAgentModel(m.id)).toBe(true)
  })
  it('accepts a well-formed claude-* id not in the catalog (future model)', () => {
    expect(isAgentModel('claude-xyz')).toBe(true)
    expect(isAgentModel('claude-opus-6-20261231')).toBe(true)
  })
  it('rejects an id whose suffix is too short', () => {
    expect(isAgentModel('claude-x')).toBe(false)
    expect(isAgentModel('claude-xy')).toBe(false)
    expect(isAgentModel('claude-')).toBe(false)
  })
  it('rejects a non-claude model id', () => {
    expect(isAgentModel('gpt-4')).toBe(false)
  })
  it('rejects uppercase (the regex is lowercase-only)', () => {
    expect(isAgentModel('claude-A-bad-CASE')).toBe(false)
  })
  it('rejects non-string values', () => {
    expect(isAgentModel(123)).toBe(false)
    expect(isAgentModel(null)).toBe(false)
    expect(isAgentModel(undefined)).toBe(false)
  })
})

describe('agentModelLabel', () => {
  it('returns the catalog label for a known id', () => {
    expect(agentModelLabel('claude-opus-5')).toBe('OPUS 5')
    expect(agentModelLabel('')).toBe('SERVER DEFAULT')
  })
  it('falls back to the raw id for an unknown model', () => {
    expect(agentModelLabel('claude-mystery-9')).toBe('claude-mystery-9')
  })
})

describe('emptyAgentUsage', () => {
  it('is all zeroes', () => {
    expect(emptyAgentUsage()).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextTokens: 0, contextWindow: 0, costUsd: 0, turns: 0, durationMs: 0, compactions: 0,
    })
  })
  it('returns a fresh object each call', () => {
    expect(emptyAgentUsage()).not.toBe(emptyAgentUsage())
  })
})

describe('emptyAgentUsageTotals', () => {
  it('is all zeroes with since set to roughly now', () => {
    const before = Date.now()
    const t = emptyAgentUsageTotals()
    const after = Date.now()
    expect(t.inputTokens).toBe(0)
    expect(t.outputTokens).toBe(0)
    expect(t.cacheReadTokens).toBe(0)
    expect(t.cacheCreationTokens).toBe(0)
    expect(t.costUsd).toBe(0)
    expect(t.runs).toBe(0)
    expect(t.chatTurns).toBe(0)
    expect(t.compactions).toBe(0)
    expect(t.since).toBeGreaterThanOrEqual(before)
    expect(t.since).toBeLessThanOrEqual(after)
  })
})

describe('totalTokens', () => {
  it('sums all four token fields', () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })).toBe(10)
  })
  it('is zero for an empty usage', () => {
    expect(totalTokens(emptyAgentUsage())).toBe(0)
  })
})

describe('fmtTokens', () => {
  it('floors non-finite or non-positive input to "0"', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(-5)).toBe('0')
    expect(fmtTokens(NaN)).toBe('0')
    expect(fmtTokens(Infinity)).toBe('0')
  })
  it('renders sub-1000 counts as a plain rounded integer', () => {
    expect(fmtTokens(812)).toBe('812')
    expect(fmtTokens(999)).toBe('999')
  })
  it('renders 1000-9999 with one decimal of k', () => {
    expect(fmtTokens(1000)).toBe('1.0k')
    expect(fmtTokens(9999)).toBe('10.0k') // rounds up to the next k at the top of the band
  })
  it('renders 10000-999999 with no decimal of k', () => {
    expect(fmtTokens(10000)).toBe('10k')
    expect(fmtTokens(12400)).toBe('12k')
    expect(fmtTokens(999999)).toBe('1000k') // rounds up to the top of the band, still short of 1M
  })
  it('renders 1,000,000+ with two decimals of M', () => {
    expect(fmtTokens(1_000_000)).toBe('1.00M')
    expect(fmtTokens(1_240_000)).toBe('1.24M')
  })
})

describe('contextFill', () => {
  function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
    return { ...emptyAgentUsage(), ...overrides }
  }
  it('is null for null/undefined usage', () => {
    expect(contextFill(null)).toBeNull()
    expect(contextFill(undefined)).toBeNull()
  })
  it('is null when contextWindow is unknown (0)', () => {
    expect(contextFill(usage({ contextTokens: 500, contextWindow: 0 }))).toBeNull()
  })
  it('is null when contextTokens is 0, even with a known window', () => {
    // Note: this also swallows a genuinely-empty (0%) context — the falsy check
    // can't distinguish "unknown" from "zero". See report for detail.
    expect(contextFill(usage({ contextTokens: 0, contextWindow: 1000 }))).toBeNull()
  })
  it('computes the fraction when both are known', () => {
    expect(contextFill(usage({ contextTokens: 500, contextWindow: 1000 }))).toBeCloseTo(0.5)
  })
  it('clamps to 1 when tokens exceed the window', () => {
    expect(contextFill(usage({ contextTokens: 2000, contextWindow: 1000 }))).toBe(1)
  })
})

describe('agentStrategyId / isAgentStrategyId', () => {
  it('prefixes the agent id', () => {
    expect(agentStrategyId('manager')).toBe(`${AGENT_STRATEGY_PREFIX}manager`)
    expect(agentStrategyId('manager')).toBe('agent:manager')
  })
  it('recognizes an agent-prefixed strategy id', () => {
    expect(isAgentStrategyId('agent:manager')).toBe(true)
    expect(isAgentStrategyId(agentStrategyId('anything'))).toBe(true)
  })
  it('rejects a non-agent strategy id or undefined', () => {
    expect(isAgentStrategyId('sniper')).toBe(false)
    expect(isAgentStrategyId('')).toBe(false)
    expect(isAgentStrategyId(undefined)).toBe(false)
  })
})
