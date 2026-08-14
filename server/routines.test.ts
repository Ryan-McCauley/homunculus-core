import { describe, it, expect, beforeEach, vi } from 'vitest'

const ha = vi.hoisted(() => ({ sendCommand: vi.fn(async () => {}) }))
vi.mock('./homeassistant', () => ({ haHub: ha }))

import { ROUTINES, executeRoutine, executeHaCommand, routinesSummary } from './routines'

beforeEach(() => {
  ha.sendCommand.mockClear()
  ha.sendCommand.mockImplementation(async () => {})
})

describe('ROUTINES catalog', () => {
  it('gives every routine a label, description, and at least one step', () => {
    for (const [key, routine] of Object.entries(ROUTINES)) {
      expect(routine.label, `${key}.label`).toBeTruthy()
      expect(routine.description, `${key}.description`).toBeTruthy()
      expect(routine.steps.length, `${key}.steps`).toBeGreaterThan(0)
    }
  })

  it('gives every step an entityId and a service in domain.service form', () => {
    for (const [key, routine] of Object.entries(ROUTINES)) {
      for (const step of routine.steps) {
        expect(step.entityId, key).toMatch(/^[a-z_]+\.[a-z0-9_]+$/)
        expect(step.service, key).toMatch(/^[a-z_]+\.[a-z0-9_]+$/)
      }
    }
  })
})

describe('executeRoutine', () => {
  it('runs every step in order against haHub.sendCommand', async () => {
    const res = await executeRoutine('goodnight')
    expect(res).toEqual({ ok: true, label: 'Goodnight' })
    expect(ha.sendCommand).toHaveBeenNthCalledWith(1, 'climate.main_thermostat', 'climate.set_temperature', { temperature: 68 })
    expect(ha.sendCommand).toHaveBeenNthCalledWith(2, 'vacuum.r2peepoo_litter_box', 'vacuum.start', {})
    expect(ha.sendCommand).toHaveBeenCalledTimes(2)
  })

  it('returns an error for an unknown routine name without calling haHub', async () => {
    const res = await executeRoutine('not-a-routine')
    expect(res).toEqual({ ok: false, label: 'not-a-routine', error: 'Unknown routine: not-a-routine' })
    expect(ha.sendCommand).not.toHaveBeenCalled()
  })

  it('stops after the failing step and surfaces the error, still reporting the routine label', async () => {
    ha.sendCommand
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('HA unreachable') })
    const res = await executeRoutine('goodnight')
    expect(res).toEqual({ ok: false, label: 'Goodnight', error: 'HA unreachable' })
    expect(ha.sendCommand).toHaveBeenCalledTimes(2)
  })

  it('runs single-step routines correctly (away/home/charge_voltaire/stop_charging/clean_litter)', async () => {
    await executeRoutine('away')
    expect(ha.sendCommand).toHaveBeenCalledWith('climate.main_thermostat', 'climate.set_temperature', { temperature: 78 })
  })
})

describe('executeHaCommand', () => {
  it('forwards an arbitrary domain.service call to haHub', async () => {
    const res = await executeHaCommand('light.kitchen', 'light.turn_on', { brightness: 200 })
    expect(res).toEqual({ ok: true, label: 'light.turn_on → light.kitchen' })
    expect(ha.sendCommand).toHaveBeenCalledWith('light.kitchen', 'light.turn_on', { brightness: 200 })
  })

  it('reports the error message when the command fails', async () => {
    ha.sendCommand.mockImplementationOnce(async () => { throw new Error('boom') })
    const res = await executeHaCommand('light.kitchen', 'light.turn_on', {})
    expect(res).toEqual({ ok: false, label: 'light.turn_on → light.kitchen', error: 'boom' })
  })
})

describe('routinesSummary', () => {
  it('lists every routine key with its description, one per line', () => {
    const summary = routinesSummary()
    const lines = summary.split('\n')
    expect(lines).toHaveLength(Object.keys(ROUTINES).length)
    for (const [key, routine] of Object.entries(ROUTINES)) {
      expect(summary).toContain(`  • ${key}: ${routine.description}`)
    }
  })
})
