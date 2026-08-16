import { describe, it, expect, beforeEach, vi } from 'vitest'

const ha = vi.hoisted(() => ({
  sendCommand: vi.fn(async (_entityId: string, _service: string, _data: Record<string, unknown>) => {}),
}))
vi.mock('./homeassistant', () => ({ haHub: ha }))

const audit = vi.hoisted(() => ({ note: vi.fn((_input: Record<string, unknown>) => undefined) }))
vi.mock('./auditLog', () => ({ auditLog: audit }))

import { compileIntent, compileOps, executePlan } from './agentIntent'
import { buildManifest } from '../shared/agentManifest'
import type { HaEntity } from '../shared/homeassistant'

function entity(id: string, overrides: Partial<HaEntity> = {}): HaEntity {
  return {
    entityId: id,
    domain: id.split('.')[0] as string,
    name: id,
    state: 'off',
    unit: null,
    deviceClass: null,
    attributes: {},
    lastChanged: null,
    ...overrides,
  }
}

const entities = [
  entity('scene.movie_mode', { name: 'Movie Mode' }),
  entity('scene.goodnight', { name: 'Goodnight' }),
  entity('light.ceiling', { name: 'Ceiling Main', state: 'on' }),
  entity('light.reading_lamp', { name: 'Reading Lamp', state: 'on' }),
  entity('lock.front_door', { name: 'Front Door', state: 'locked' }),
  entity('lock.back_door', { name: 'Back Door', state: 'locked' }),
  entity('cover.garage_bay', { name: 'Garage Bay', state: 'open', deviceClass: 'garage' }),
  entity('climate.thermostat', { name: 'Thermostat', state: 'cool' }),
  entity('sensor.living_temp', { name: 'Living Temp', state: '71.4' }),
]
const manifest = buildManifest(entities)

beforeEach(() => {
  ha.sendCommand.mockClear()
  ha.sendCommand.mockImplementation(async () => {})
  audit.note.mockClear()
})

describe('compileIntent', () => {
  it('compiles a scene named in the text', () => {
    const plan = compileIntent('movie mode', manifest, entities)
    expect(plan.ops).toHaveLength(1)
    expect(plan.ops[0]).toMatchObject({
      n: 1, service: 'scene.turn_on', entityId: 'scene.movie_mode', tier: 'write',
    })
  })

  it('stamps the manifest version it compiled against', () => {
    expect(compileIntent('movie mode', manifest, entities).manifest).toBe(manifest.manifest)
  })

  it('turns "all lights off" into one op per light', () => {
    const plan = compileIntent('all lights off', manifest, entities)
    expect(plan.ops.map((o) => o.entityId).sort()).toEqual(['light.ceiling', 'light.reading_lamp'])
    for (const op of plan.ops) expect(op.service).toBe('light.turn_off')
  })

  it('sets a named light to an explicit brightness', () => {
    const plan = compileIntent('reading lamp to 40%', manifest, entities)
    expect(plan.ops[0]).toMatchObject({
      entityId: 'light.reading_lamp',
      service: 'light.turn_on',
      data: { brightness_pct: 40 },
    })
  })

  it('sets the thermostat from a temperature in the text', () => {
    const plan = compileIntent('set the thermostat to 68', manifest, entities)
    expect(plan.ops[0]).toMatchObject({
      entityId: 'climate.thermostat',
      service: 'climate.set_temperature',
      data: { temperature: 68 },
    })
  })

  it('locks every lock for "lock up"', () => {
    const plan = compileIntent('lock up', manifest, entities)
    const locks = plan.ops.filter((o) => o.service === 'lock.lock')
    expect(locks.map((o) => o.entityId).sort()).toEqual(['lock.back_door', 'lock.front_door'])
  })

  it('infers closing an open cover for "lock up", flagged as an inference', () => {
    const plan = compileIntent('lock up', manifest, entities)
    const close = plan.ops.find((o) => o.service === 'cover.close_cover')
    expect(close).toMatchObject({ entityId: 'cover.garage_bay', tier: 'confirm' })
    expect(close?.note).toBeTruthy()
  })

  it('does not infer closing a cover that is already closed', () => {
    const closed = entities.map((e) => (e.entityId === 'cover.garage_bay' ? { ...e, state: 'closed' } : e))
    const plan = compileIntent('lock up', buildManifest(closed), closed)
    expect(plan.ops.some((o) => o.service === 'cover.close_cover')).toBe(false)
  })

  it('combines a scene with an explicit exception', () => {
    const plan = compileIntent('movie mode but keep the reading lamp on', manifest, entities)
    expect(plan.ops.map((o) => o.service)).toContain('scene.turn_on')
    expect(plan.ops.map((o) => o.entityId)).toContain('light.reading_lamp')
  })

  it('numbers ops sequentially from one', () => {
    const plan = compileIntent('lock up', manifest, entities)
    expect(plan.ops.map((o) => o.n)).toEqual(plan.ops.map((_, i) => i + 1))
  })

  it('produces no ops and reports the text as unmatched when nothing is recognized', () => {
    const plan = compileIntent('make me a sandwich', manifest, entities)
    expect(plan.ops).toEqual([])
    expect(plan.unmatched).toContain('make me a sandwich')
  })

  it('never emits an op for a read-only entity', () => {
    const plan = compileIntent('living temp', manifest, entities)
    expect(plan.ops).toEqual([])
  })

  it('gives every op a human-readable summary', () => {
    for (const op of compileIntent('lock up', manifest, entities).ops) {
      expect(op.summary, op.actionId).toBeTruthy()
    }
  })
})

describe('compileOps', () => {
  it('accepts structured ops that match the manifest', () => {
    const plan = compileOps([{ actionId: 'light.ceiling:set_brightness', data: { brightness_pct: 20 } }], manifest)
    expect(plan.ops).toHaveLength(1)
    expect(plan.ops[0]).toMatchObject({ service: 'light.turn_on', data: { brightness_pct: 20 } })
  })

  it('rejects an action id that is not in the manifest', () => {
    const plan = compileOps([{ actionId: 'lock.front_door:detonate', data: {} }], manifest)
    expect(plan.ops).toEqual([])
    expect(plan.unmatched[0]).toMatch(/detonate/)
  })

  it('rejects an op whose payload fails validation', () => {
    const plan = compileOps([{ actionId: 'light.ceiling:set_brightness', data: { brightness_pct: 900 } }], manifest)
    expect(plan.ops).toEqual([])
    expect(plan.unmatched).toHaveLength(1)
  })

  it('refuses a payload carrying its own entity_id', () => {
    const plan = compileOps([{ actionId: 'scene.goodnight:activate', data: { entity_id: 'lock.front_door' } }], manifest)
    expect(plan.ops).toEqual([])
  })
})

describe('executePlan', () => {
  it('sends every write-tier op to Home Assistant', async () => {
    const plan = compileIntent('movie mode', manifest, entities)
    const result = await executePlan(plan, manifest, {})
    expect(ha.sendCommand).toHaveBeenCalledWith('scene.movie_mode', 'scene.turn_on', {})
    expect(result.ops[0]).toMatchObject({ n: 1, status: 'ok' })
    expect(result.ok).toBe(true)
  })

  it('holds a confirm-tier op instead of executing it', async () => {
    const plan = compileIntent('lock up', manifest, entities)
    const result = await executePlan(plan, manifest, {})
    const close = result.ops.find((o) => o.service === 'cover.close_cover')
    expect(close?.status).toBe('held')
    expect(ha.sendCommand).not.toHaveBeenCalledWith('cover.garage_bay', 'cover.close_cover', expect.anything())
  })

  it('executes a confirm-tier op only when its number is explicitly confirmed', async () => {
    const plan = compileIntent('lock up', manifest, entities)
    const close = plan.ops.find((o) => o.service === 'cover.close_cover')!
    const result = await executePlan(plan, manifest, { confirmed: [close.n] })
    expect(ha.sendCommand).toHaveBeenCalledWith('cover.garage_bay', 'cover.close_cover', {})
    expect(result.ops.find((o) => o.n === close.n)?.status).toBe('ok')
  })

  it('does not let confirming one op release another', async () => {
    const plan = compileOps([
      { actionId: 'lock.front_door:unlock', data: {} },
      { actionId: 'cover.garage_bay:open', data: {} },
    ], manifest)
    const result = await executePlan(plan, manifest, { confirmed: [1] })
    expect(result.ops[0]?.status).toBe('ok')
    expect(result.ops[1]?.status).toBe('held')
  })

  it('calls nothing at all on a dry run', async () => {
    const plan = compileIntent('movie mode', manifest, entities)
    const result = await executePlan(plan, manifest, { dryRun: true })
    expect(ha.sendCommand).not.toHaveBeenCalled()
    expect(result.ops[0]?.status).toBe('dry_run')
  })

  it('re-validates against the manifest and refuses a forged op', async () => {
    // A plan is client-supplied on the way back in, so trusting its service
    // string would let a caller execute anything it cared to write down.
    const forged = {
      manifest: manifest.manifest,
      text: 'forged',
      unmatched: [],
      ops: [{
        n: 1, actionId: 'light.ceiling:set_brightness', entityId: 'lock.front_door',
        service: 'lock.unlock', data: {}, summary: 'forged', tier: 'write' as const,
      }],
    }
    const result = await executePlan(forged, manifest, {})
    expect(ha.sendCommand).not.toHaveBeenCalled()
    expect(result.ops[0]?.status).toBe('refused')
    expect(result.ok).toBe(false)
  })

  it('records an audit entry for each executed op', async () => {
    const plan = compileIntent('movie mode', manifest, entities)
    await executePlan(plan, manifest, { actor: 'agent' })
    expect(audit.note).toHaveBeenCalledTimes(1)
    expect(audit.note.mock.calls[0]?.[0]).toMatchObject({ action: 'ha.agent.execute' })
  })

  it('does not audit a held or dry-run op as though it happened', async () => {
    const plan = compileIntent('movie mode', manifest, entities)
    await executePlan(plan, manifest, { dryRun: true })
    expect(audit.note).not.toHaveBeenCalled()
  })

  it('continues past a failing op and reports it', async () => {
    ha.sendCommand.mockImplementation(async (entityId: string) => {
      if (entityId === 'lock.front_door') throw new Error('HA service call failed: 500')
    })
    const plan = compileIntent('lock up', manifest, entities)
    const result = await executePlan(plan, manifest, {})
    const front = result.ops.find((o) => o.entityId === 'lock.front_door')
    const back = result.ops.find((o) => o.entityId === 'lock.back_door')
    expect(front).toMatchObject({ status: 'failed' })
    expect(front?.error).toMatch(/500/)
    expect(back?.status).toBe('ok')
    expect(result.ok).toBe(false)
  })

  it('reports an empty plan as ok with no calls', async () => {
    const result = await executePlan(compileIntent('nonsense here', manifest, entities), manifest, {})
    expect(result.ops).toEqual([])
    expect(result.ok).toBe(true)
    expect(ha.sendCommand).not.toHaveBeenCalled()
  })
})
