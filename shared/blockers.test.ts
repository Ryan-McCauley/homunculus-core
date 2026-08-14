import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OPERATOR_ID,
  BLOCKER_STATUS_LABELS,
  BLOCKER_SEVERITY_LABELS,
  MAX_OPEN_PER_AGENT,
  BLOCKER_EXPIRY_MS,
  questionKey,
  isBlockerSeverity,
  blockerAge,
  suppresses,
  type Blocker,
} from './blockers'

function makeBlocker(overrides: Partial<Blocker> = {}): Blocker {
  return {
    id: 'blk_1',
    agentId: 'sniper',
    askedOf: OPERATOR_ID,
    question: 'Should I raise the cap?',
    why: 'Position sizing is capped below the opportunity.',
    severity: 'blocking',
    threadId: null,
    createdAt: 0,
    status: 'open',
    suppressedRuns: 0,
    answeredAt: null,
    answeredBy: null,
    answer: '',
    deliveredAt: null,
    ...overrides,
  }
}

describe('constants', () => {
  it('caps open blockers per agent at 3', () => {
    expect(MAX_OPEN_PER_AGENT).toBe(3)
  })
  it('expires a blocker after 48 hours', () => {
    expect(BLOCKER_EXPIRY_MS).toBe(48 * 60 * 60 * 1000)
  })
  it('has a label for every status and severity', () => {
    expect(Object.keys(BLOCKER_STATUS_LABELS).sort()).toEqual(['answered', 'expired', 'open', 'withdrawn'].sort())
    expect(Object.keys(BLOCKER_SEVERITY_LABELS).sort()).toEqual(['blocking', 'waiting'].sort())
  })
})

describe('questionKey', () => {
  it('lowercases and strips punctuation so equivalent questions collide', () => {
    expect(questionKey('Should I raise the cap?')).toBe(questionKey('should i raise the cap'))
  })
  it('collapses internal whitespace', () => {
    expect(questionKey('a   b\t\tc')).toBe('a b c')
  })
  it('trims leading/trailing whitespace', () => {
    expect(questionKey('  hello  ')).toBe('hello')
  })
  it('strips non-alphanumeric characters entirely', () => {
    expect(questionKey('50% -> $100?!')).toBe('50 100')
  })
  it('truncates to 160 characters', () => {
    const long = 'a'.repeat(300)
    expect(questionKey(long)).toHaveLength(160)
  })
})

describe('isBlockerSeverity', () => {
  it('accepts the two valid severities', () => {
    expect(isBlockerSeverity('blocking')).toBe(true)
    expect(isBlockerSeverity('waiting')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isBlockerSeverity('open')).toBe(false)
    expect(isBlockerSeverity('')).toBe(false)
    expect(isBlockerSeverity(null)).toBe(false)
    expect(isBlockerSeverity(undefined)).toBe(false)
    expect(isBlockerSeverity(1)).toBe(false)
  })
})

describe('blockerAge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('defaults `now` to Date.now()', () => {
    const b = makeBlocker({ createdAt: Date.now() - 60_000 })
    expect(blockerAge(b)).toBe(60_000)
  })
  it('accepts an explicit `now` for deterministic testing', () => {
    const b = makeBlocker({ createdAt: 1000 })
    expect(blockerAge(b, 5000)).toBe(4000)
  })
  it('is zero when created right now', () => {
    const b = makeBlocker({ createdAt: Date.now() })
    expect(blockerAge(b)).toBe(0)
  })
})

describe('suppresses', () => {
  it('suppresses only when open AND blocking', () => {
    expect(suppresses(makeBlocker({ status: 'open', severity: 'blocking' }))).toBe(true)
  })
  it('does not suppress a waiting (non-blocking) severity, even if open', () => {
    expect(suppresses(makeBlocker({ status: 'open', severity: 'waiting' }))).toBe(false)
  })
  it('does not suppress once answered', () => {
    expect(suppresses(makeBlocker({ status: 'answered', severity: 'blocking' }))).toBe(false)
  })
  it('does not suppress once withdrawn or expired', () => {
    expect(suppresses(makeBlocker({ status: 'withdrawn', severity: 'blocking' }))).toBe(false)
    expect(suppresses(makeBlocker({ status: 'expired', severity: 'blocking' }))).toBe(false)
  })
})
