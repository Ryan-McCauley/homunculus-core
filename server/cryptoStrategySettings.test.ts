import { describe, it, expect, beforeEach, vi } from 'vitest'

// `current` in the module under test is computed once at import time from
// loadDefinitions(), which reads node:fs. Every test needs a fresh module
// instance (vi.resetModules + dynamic import) over a controllable virtual
// file so we can exercise "no file", "legacy file", "existing file" states.
const fsState = vi.hoisted(() => ({ exists: false, content: '' }))

// Keep the real append-only audit writer out of the test run, and capture what
// each mutator reports so the "who changed this setting" trail can be asserted.
const audit = vi.hoisted(() => ({ record: vi.fn(), note: vi.fn() }))
vi.mock('./auditLog', () => ({
  auditLog: audit,
  withActor: <T,>(_actor: string, fn: () => T) => fn(),
  currentActor: () => 'operator',
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  readFileSync: vi.fn(() => fsState.content),
  writeFileSync: vi.fn((_path: string, data: string) => { fsState.content = data; fsState.exists = true }),
  mkdirSync: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  audit.record.mockClear()
  audit.note.mockClear()
  fsState.exists = false
  fsState.content = ''
})

async function freshModule() {
  return import('./cryptoStrategySettings')
}

describe('seeding (no settings file on disk)', () => {
  it('seeds all 8 built-in strategies with values equal to their defaults', async () => {
    const m = await freshModule()
    const all = m.getAllStrategyDefinitions()
    expect(all).toHaveLength(8)
    expect(all.every((d) => d.builtin)).toBe(true)
    for (const d of all) expect(d.values).toEqual(d.defaults)
  })

  it('includes the global strategy under GLOBAL_STRATEGY_ID', async () => {
    const m = await freshModule()
    expect(m.getStrategyDefinition(m.GLOBAL_STRATEGY_ID)).toBeDefined()
  })
})

describe('getStrategySettings / getResolvedStrategySettings', () => {
  it('returns undefined for an unknown strategy', async () => {
    const m = await freshModule()
    expect(m.getStrategySettings('nope')).toBeUndefined()
    expect(m.getResolvedStrategySettings('nope')).toBeUndefined()
  })

  it('resolves the global strategy to its own values (no merge)', async () => {
    const m = await freshModule()
    expect(m.getResolvedStrategySettings(m.GLOBAL_STRATEGY_ID)).toEqual(
      m.getStrategyDefinition(m.GLOBAL_STRATEGY_ID)!.values,
    )
  })

  it('merges global values under a strategy, with the strategy winning on collision', async () => {
    const m = await freshModule()
    const resolved = m.getResolvedStrategySettings('sniper')!
    const global = m.getStrategyDefinition(m.GLOBAL_STRATEGY_ID)!.values
    // sniper declares its own roundTripFeePct (0.31), which must beat global's (0.7).
    expect(resolved.roundTripFeePct).toBe(0.31)
    expect(resolved.roundTripFeePct).not.toBe(global.roundTripFeePct)
    // A key sniper does NOT declare (dustFloorUsd) should fall through from global.
    expect(resolved.dustFloorUsd).toBe(global.dustFloorUsd)
  })
})

describe('setStrategySettings', () => {
  it('updates known numeric fields and clamps out-of-range values to [min, max]', async () => {
    const m = await freshModule()
    const def = m.getStrategyDefinition('sniper')!
    const rsiMinField = def.fields.find((f) => f.key === 'rsiMin')!
    const next = m.setStrategySettings('sniper', { rsiMin: rsiMinField.max + 1000, tp1Pct: 5 })!
    expect(next.rsiMin).toBe(rsiMinField.max)
    expect(next.tp1Pct).toBe(5)
  })

  it('ignores patch keys that are not real fields or not numeric', async () => {
    const m = await freshModule()
    const before = { ...m.getStrategySettings('sniper')! }
    const next = m.setStrategySettings('sniper', { notAField: 5, tp1Pct: 'nope' as any })!
    expect(next).toEqual(before)
  })

  it('returns undefined for an unknown strategy and does not persist', async () => {
    const m = await freshModule()
    expect(m.setStrategySettings('nope', { x: 1 })).toBeUndefined()
    expect(fsState.exists).toBe(false)
  })

  it('persists to disk so a fresh module load sees the change', async () => {
    const m = await freshModule()
    m.setStrategySettings('sniper', { tp1Pct: 8 })
    expect(fsState.exists).toBe(true)
    vi.resetModules()
    const reloaded = await freshModule()
    expect(reloaded.getStrategySettings('sniper')!.tp1Pct).toBe(8)
  })
})

describe('resetStrategySettings', () => {
  it('restores a strategy to its captured defaults after it has been changed', async () => {
    const m = await freshModule()
    const defaults = { ...m.getStrategyDefinition('sniper')!.defaults }
    m.setStrategySettings('sniper', { tp1Pct: 8 })
    const reset = m.resetStrategySettings('sniper')!
    expect(reset).toEqual(defaults)
  })

  it('returns undefined for an unknown strategy', async () => {
    const m = await freshModule()
    expect(m.resetStrategySettings('nope')).toBeUndefined()
  })
})

describe('createStrategyDefinition', () => {
  it('slugifies the label into the id', async () => {
    const m = await freshModule()
    const def = m.createStrategyDefinition({ label: 'My Cool Strategy!!', fields: [] })
    expect(def.id).toBe('my-cool-strategy')
    expect(def.builtin).toBe(false)
  })

  it('de-duplicates a slug collision by appending -2, -3, ...', async () => {
    const m = await freshModule()
    m.createStrategyDefinition({ label: 'Dupe', fields: [] })
    const second = m.createStrategyDefinition({ label: 'Dupe', fields: [] })
    expect(second.id).toBe('dupe-2')
  })

  it('throws on an empty label', async () => {
    const m = await freshModule()
    expect(() => m.createStrategyDefinition({ label: '   ', fields: [] })).toThrow()
  })

  it('sanitizes field keys and clamps the default into [min, max]', async () => {
    const m = await freshModule()
    const def = m.createStrategyDefinition({
      label: 'Weird Fields',
      fields: [{ key: 'bad key!!', label: 'Bad', min: 0, max: 10, step: 1, unit: '', default: 999 }],
    })
    expect(def.fields[0]!.key).toBe('badkey')
    expect(def.defaults.badkey).toBe(10)
    expect(def.values.badkey).toBe(10)
  })

  it('forces toggle fields to a 0-1 numeric range regardless of submitted bounds', async () => {
    const m = await freshModule()
    const def = m.createStrategyDefinition({
      label: 'Toggle Strategy',
      fields: [{ key: 'on', label: 'On', min: -5, max: 500, step: 1, unit: 'weird', type: 'toggle', default: 1 }],
    })
    const field = def.fields[0]!
    expect(field.min).toBe(0)
    expect(field.max).toBe(1)
    expect(field.unit).toBe('')
    expect(def.defaults.on).toBe(1)
  })

  it('persists the new strategy so it is visible after reload', async () => {
    const m = await freshModule()
    m.createStrategyDefinition({ label: 'Persisted', fields: [] })
    vi.resetModules()
    const reloaded = await freshModule()
    expect(reloaded.getStrategyDefinition('persisted')).toBeDefined()
  })
})

describe('isKnownStrategyForSettings', () => {
  it('is true for a real strategy id and false otherwise', async () => {
    const m = await freshModule()
    expect(m.isKnownStrategyForSettings('sniper')).toBe(true)
    expect(m.isKnownStrategyForSettings('nope')).toBe(false)
    expect(m.isKnownStrategyForSettings(42)).toBe(false)
  })
})

describe('reconciliation against a saved file', () => {
  it('re-clamps a saved value that now falls outside a tightened seed range', async () => {
    fsState.exists = true
    const saved = [{
      id: 'sniper',
      values: { rsiMin: -999 },
      createdAt: 111,
    }]
    fsState.content = JSON.stringify(saved)
    const m = await freshModule()
    const def = m.getStrategyDefinition('sniper')!
    const rsiMinField = def.fields.find((f) => f.key === 'rsiMin')!
    expect(def.values.rsiMin).toBe(rsiMinField.min)
  })

  it('fills in a field missing from the saved file with the seed default', async () => {
    fsState.exists = true
    fsState.content = JSON.stringify([{ id: 'sniper', values: {}, createdAt: 111 }])
    const m = await freshModule()
    const def = m.getStrategyDefinition('sniper')!
    expect(def.values.tp1Pct).toBe(def.defaults.tp1Pct)
  })

  it('keeps a user-created strategy verbatim (no seed to reconcile against)', async () => {
    fsState.exists = true
    const custom = {
      id: 'my-custom', label: 'MY CUSTOM', description: '', fields: [],
      values: { x: 1 }, defaults: { x: 1 }, createdAt: 1, builtin: false,
    }
    fsState.content = JSON.stringify([custom])
    const m = await freshModule()
    expect(m.getStrategyDefinition('my-custom')).toEqual(custom)
  })

  it('migrates the legacy flat shape ({id: {key: value}}) into StrategyDefinition[]', async () => {
    fsState.exists = true
    fsState.content = JSON.stringify({ sniper: { tp1Pct: 9 } })
    const m = await freshModule()
    expect(m.getStrategySettings('sniper')!.tp1Pct).toBe(9)
    // Untouched fields still carry the seed default.
    expect(m.getStrategySettings('sniper')!.trailPct).toBe(m.getStrategyDefinition('sniper')!.defaults.trailPct)
  })

  it('falls back to seed defaults when the file contains invalid JSON', async () => {
    fsState.exists = true
    fsState.content = '{not valid json'
    const m = await freshModule()
    expect(m.getAllStrategyDefinitions()).toHaveLength(8)
  })
})

describe('audit trail', () => {
  it('records a settings change with before/after and the keys that moved', async () => {
    const m = await freshModule()
    const before = m.getStrategySettings('sniper')!
    m.setStrategySettings('sniper', { tp1Pct: before.tp1Pct + 1 })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'strategy.settings.set',
      resource: 'strategy:sniper',
      meta: expect.objectContaining({ strategyId: 'sniper', changedKeys: ['tp1Pct'] }),
      before: expect.objectContaining({ tp1Pct: before.tp1Pct }),
      after: expect.objectContaining({ tp1Pct: before.tp1Pct + 1 }),
    }))
  })

  it('reports no effective change when the patch moves nothing', async () => {
    const m = await freshModule()
    m.setStrategySettings('sniper', { notAField: 12 })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringMatching(/no effective change/),
      meta: expect.objectContaining({ changedKeys: [] }),
    }))
  })

  it('records a reset to defaults', async () => {
    const m = await freshModule()
    m.setStrategySettings('sniper', { tp1Pct: 9 })
    audit.note.mockClear()
    m.resetStrategySettings('sniper')
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'strategy.settings.reset',
      resource: 'strategy:sniper',
      before: expect.objectContaining({ tp1Pct: 9 }),
    }))
  })

  it('records creation of a new strategy', async () => {
    const m = await freshModule()
    m.createStrategyDefinition({ label: 'Audit Probe', fields: [
      { key: 'x', label: 'X', min: 0, max: 10, step: 1, unit: '', default: 5 },
    ] })
    expect(audit.note).toHaveBeenCalledWith(expect.objectContaining({
      action: 'strategy.create',
      resource: 'strategy:audit-probe',
    }))
  })

  it('does not record anything for an unknown strategy', async () => {
    const m = await freshModule()
    audit.note.mockClear()
    m.setStrategySettings('nope', { x: 1 })
    m.resetStrategySettings('nope')
    expect(audit.note).not.toHaveBeenCalled()
  })
})
