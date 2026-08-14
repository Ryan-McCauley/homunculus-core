import { describe, it, expect } from 'vitest'
import { parseMentions } from './office'

const KNOWN = ['alice', 'bob', 'carol', '1bot']

describe('parseMentions', () => {
  it('returns an empty array when there are no mentions', () => {
    expect(parseMentions('no mentions in this message', KNOWN)).toEqual([])
  })
  it('extracts multiple distinct mentions in order of first appearance', () => {
    expect(parseMentions('hey @alice and @bob, take a look', KNOWN)).toEqual(['alice', 'bob'])
  })
  it('matches case-insensitively but resolves to the canonical known id', () => {
    expect(parseMentions('@BOB please review', KNOWN)).toEqual(['bob'])
  })
  it('ignores a mention of an id that is not in the known list', () => {
    expect(parseMentions('hey @dave, any thoughts?', KNOWN)).toEqual([])
  })
  it('deduplicates repeated mentions of the same id regardless of case', () => {
    expect(parseMentions('@alice @alice @ALICE', KNOWN)).toEqual(['alice'])
  })
  it('allows a leading digit in the id (matches the regex character class)', () => {
    expect(parseMentions('@1bot can you check this', KNOWN)).toEqual(['1bot'])
  })
  it('stops the match at punctuation, so trailing commas/periods are not part of the id', () => {
    expect(parseMentions('cc @alice, and @bob.', KNOWN)).toEqual(['alice', 'bob'])
  })
  it('does not treat a bare "@" with no following id as a mention', () => {
    expect(parseMentions('this email is not a mention: user @ example', KNOWN)).toEqual([])
  })
  it('picks up the local part of an email-shaped string, but only if it happens to be a known id', () => {
    // The regex has no notion of email syntax — it just matches @ followed by
    // [a-z0-9-]+ and stops at the '.', so "foo@bar.com" reads as a mention of "bar".
    expect(parseMentions('email me at foo@bar.com', ['bar'])).toEqual(['bar'])
    expect(parseMentions('email me at foo@bar.com', ['com'])).toEqual([])
  })
  it('returns an empty array when the known-id list is empty', () => {
    expect(parseMentions('@alice @bob', [])).toEqual([])
  })
  it('returns an empty array for an empty body', () => {
    expect(parseMentions('', KNOWN)).toEqual([])
  })
})
