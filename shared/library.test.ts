import { describe, it, expect } from 'vitest'
import {
  ARTIFACT_KINDS,
  ARTIFACT_FORMATS,
  isArtifactKind,
  isArtifactFormat,
  isArtifactOutcome,
} from './library'

describe('isArtifactKind', () => {
  it('accepts every catalogued kind', () => {
    for (const k of ARTIFACT_KINDS) expect(isArtifactKind(k)).toBe(true)
  })
  it('rejects an unknown string, non-string, or empty value', () => {
    expect(isArtifactKind('memo')).toBe(false)
    expect(isArtifactKind('')).toBe(false)
    expect(isArtifactKind(null)).toBe(false)
    expect(isArtifactKind(undefined)).toBe(false)
    expect(isArtifactKind(1)).toBe(false)
  })
})

describe('isArtifactFormat', () => {
  it('accepts every catalogued format', () => {
    for (const f of ARTIFACT_FORMATS) expect(isArtifactFormat(f)).toBe(true)
  })
  it('rejects an unknown string, non-string, or empty value', () => {
    expect(isArtifactFormat('html')).toBe(false)
    expect(isArtifactFormat('')).toBe(false)
    expect(isArtifactFormat(null)).toBe(false)
    expect(isArtifactFormat(undefined)).toBe(false)
  })
})

describe('isArtifactOutcome', () => {
  it('accepts every valid outcome', () => {
    for (const o of ['none', 'pending', 'correct', 'wrong', 'void']) {
      expect(isArtifactOutcome(o)).toBe(true)
    }
  })
  it('rejects an unknown string, non-string, or undefined', () => {
    expect(isArtifactOutcome('resolved')).toBe(false)
    expect(isArtifactOutcome('')).toBe(false)
    expect(isArtifactOutcome(null)).toBe(false)
    expect(isArtifactOutcome(undefined)).toBe(false)
    expect(isArtifactOutcome(1)).toBe(false)
  })
})
