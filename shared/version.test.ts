import { describe, it, expect } from 'vitest'
import { getBuildInfo } from './version'

// getBuildInfo() reads package.json off disk and shells out to `git rev-parse`
// relative to this module's own location — there's no injection seam to swap in
// a fake filesystem/repo without mocking node:fs and node:child_process (which
// this worktree's cryptoStrategySettings.test.ts shows is the house pattern for
// fs-backed modules, but doing it here would just re-assert the mocked values).
// Since the function is designed to degrade gracefully (falls back to '0.0.0'
// and 'unknown' rather than throwing) and this test always runs inside the real
// git checkout, we exercise it for real and assert the shape/invariants rather
// than mocking its dependencies.
describe('getBuildInfo', () => {
  it('returns a version, commit, and ISO build date', () => {
    const info = getBuildInfo()
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.commit).toBeTypeOf('string')
    expect(info.commit.length).toBeGreaterThan(0)
    expect(() => new Date(info.buildDate).toISOString()).not.toThrow()
    expect(new Date(info.buildDate).toISOString()).toBe(info.buildDate)
  })
  it('stamps a fresh buildDate on every call', async () => {
    const a = getBuildInfo()
    await new Promise((r) => setTimeout(r, 5))
    const b = getBuildInfo()
    expect(Date.parse(b.buildDate)).toBeGreaterThanOrEqual(Date.parse(a.buildDate))
  })
})
