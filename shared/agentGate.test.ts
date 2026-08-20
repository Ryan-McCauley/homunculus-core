import { describe, it, expect } from 'vitest'
import type { AgentRunTrigger } from './agents'
import {
  DEFAULT_MIN_PASSING,
  isAgentWakeGate,
  gateAppliesTo,
  gateVerdict,
  type AgentWakeGate
} from './agentGate'

const gate: AgentWakeGate = { kind: 'screener', screenerId: 'trapline' }

describe('isAgentWakeGate', () => {
  it('accepts a well-formed screener gate', () => {
    expect(isAgentWakeGate(gate)).toBe(true)
    expect(isAgentWakeGate({ kind: 'screener', screenerId: 'trapline', minPassing: 3 })).toBe(true)
  })

  it('rejects anything that is not a gate this build knows how to evaluate', () => {
    for (const v of [null, undefined, 'trapline', 42, {}, { kind: 'vibes', screenerId: 'x' },
      { kind: 'screener' }, { kind: 'screener', screenerId: '' },
      { kind: 'screener', screenerId: 'x', minPassing: -1 },
      { kind: 'screener', screenerId: 'x', minPassing: 'many' }]) {
      expect(isAgentWakeGate(v)).toBe(false)
    }
  })
})

describe('gateAppliesTo', () => {
  it('gates the routine interval wake — the one that burns a session on nothing', () => {
    expect(gateAppliesTo('interval')).toBe(true)
  })

  it('never gates the operator: manual RUN means run, gate or no gate', () => {
    expect(gateAppliesTo('manual')).toBe(false)
  })

  it('never gates a targeted wake — somebody or something is already waiting on it', () => {
    for (const t of ['answer', 'assignment', 'alert', 'mention'] as AgentRunTrigger[]) {
      expect(gateAppliesTo(t)).toBe(false)
    }
  })

  it('never gates a market event: the book moved, and the screener does not know that', () => {
    for (const t of ['signal', 'fill', 'drawdown', 'proposal'] as AgentRunTrigger[]) {
      expect(gateAppliesTo(t)).toBe(false)
    }
  })

  it('never gates housekeeping — a standdown is not work to be skipped', () => {
    expect(gateAppliesTo('standdown')).toBe(false)
  })
})

describe('gateVerdict', () => {
  it('lets the run proceed when the screener found something to work on', () => {
    const v = gateVerdict(gate, { passing: 2 })
    expect(v.allow).toBe(true)
  })

  it('skips the run when nothing passed — this is the zero-candidate grind, stopped', () => {
    const v = gateVerdict(gate, { passing: 0 })
    expect(v.allow).toBe(false)
    expect(v.reason).toMatch(/0/)
    expect(v.reason).toContain('trapline')
  })

  it('honours a higher bar when the agent asked for one', () => {
    const strict: AgentWakeGate = { kind: 'screener', screenerId: 'trapline', minPassing: 3 }
    expect(gateVerdict(strict, { passing: 2 }).allow).toBe(false)
    expect(gateVerdict(strict, { passing: 3 }).allow).toBe(true)
  })

  it('defaults the bar to one candidate', () => {
    expect(DEFAULT_MIN_PASSING).toBe(1)
    expect(gateVerdict(gate, { passing: DEFAULT_MIN_PASSING }).allow).toBe(true)
  })

  it('FAILS OPEN when the screener itself errored — a broken gate must never silence an agent', () => {
    const v = gateVerdict(gate, { error: 'python not found' })
    expect(v.allow).toBe(true)
    expect(v.reason).toContain('python not found')
  })

  it('fails open on a nonsense passing count rather than inventing a skip', () => {
    expect(gateVerdict(gate, { passing: Number.NaN }).allow).toBe(true)
  })
})
