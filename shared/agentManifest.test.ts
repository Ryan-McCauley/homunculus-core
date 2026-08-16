import { describe, it, expect } from 'vitest'
import {
  MANIFEST_VERSION, actionId, buildManifest, findAction, validatePayload,
} from './agentManifest'
import { HOME_VIEWS } from './homeRoute'
import type { HaEntity } from './homeassistant'

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

describe('actionId', () => {
  it('joins the entity id and verb with a colon', () => {
    expect(actionId('light.shelf_strip', 'set_brightness')).toBe('light.shelf_strip:set_brightness')
  })
})

describe('buildManifest', () => {
  it('stamps the manifest version', () => {
    expect(buildManifest([]).manifest).toBe(MANIFEST_VERSION)
  })

  it('advertises a route for every sub-view', () => {
    const { routes } = buildManifest([])
    for (const view of HOME_VIEWS) {
      expect(routes.some((r) => r.startsWith(`#/home/${view}`))).toBe(true)
    }
  })

  it('derives light actions with a brightness schema', () => {
    const { actions } = buildManifest([entity('light.shelf_strip')])
    const brightness = findAction({ actions } as never, 'light.shelf_strip:set_brightness')
    expect(brightness).toMatchObject({
      entityId: 'light.shelf_strip',
      service: 'light.turn_on',
      tier: 'write',
    })
    expect(brightness?.schema).toHaveProperty('brightness_pct')
  })

  it('derives a climate target action', () => {
    const { actions } = buildManifest([entity('climate.thermostat')])
    expect(actions.map((a) => a.id)).toContain('climate.thermostat:set_target')
  })

  it('gives read-only entities no actions at all', () => {
    const { actions } = buildManifest([
      entity('sensor.living_temp'),
      entity('binary_sensor.motion'),
    ])
    expect(actions).toEqual([])
  })

  it('omits domains that are not on the allowlist rather than exposing them', () => {
    const { actions } = buildManifest([entity('tts.google_translate'), entity('device_tracker.phone')])
    expect(actions).toEqual([])
  })

  it('puts lock.unlock behind the confirm tier but allows locking outright', () => {
    const { actions } = buildManifest([entity('lock.front_door')])
    const byId = new Map(actions.map((a) => [a.id, a]))
    expect(byId.get('lock.front_door:lock')?.tier).toBe('write')
    expect(byId.get('lock.front_door:unlock')?.tier).toBe('confirm')
  })

  it('puts moving a physical barrier behind the confirm tier in both directions', () => {
    const { actions } = buildManifest([entity('cover.garage_bay')])
    for (const a of actions) expect(a.tier, a.id).toBe('confirm')
  })

  it('gives every action a stable id, a domain.service, and a label', () => {
    const { actions } = buildManifest([
      entity('light.ceiling'), entity('switch.fan'), entity('scene.goodnight'),
      entity('lock.front_door'), entity('climate.thermostat'), entity('vacuum.r2peepoo'),
    ])
    expect(actions.length).toBeGreaterThan(0)
    for (const a of actions) {
      expect(a.id, a.id).toBe(`${a.entityId}:${a.id.split(':')[1]}`)
      expect(a.service, a.id).toMatch(/^[a-z_]+\.[a-z0-9_]+$/)
      expect(a.label, a.id).toBeTruthy()
    }
  })

  it('names actions after the entity friendly name where it has one', () => {
    const { actions } = buildManifest([entity('scene.goodnight', { name: 'Goodnight' })])
    expect(actions[0]?.label).toContain('Goodnight')
  })
})

describe('findAction', () => {
  const manifest = buildManifest([entity('light.ceiling')])

  it('finds an action by id', () => {
    expect(findAction(manifest, 'light.ceiling:turn_off')?.service).toBe('light.turn_off')
  })

  it('returns null for an unknown id', () => {
    expect(findAction(manifest, 'light.nope:turn_off')).toBeNull()
  })
})

describe('validatePayload', () => {
  const manifest = buildManifest([
    entity('light.ceiling'), entity('climate.thermostat'), entity('scene.goodnight'),
  ])
  const brightness = findAction(manifest, 'light.ceiling:set_brightness')!
  const target = findAction(manifest, 'climate.thermostat:set_target')!
  const activate = findAction(manifest, 'scene.goodnight:activate')!

  it('accepts an in-range numeric payload', () => {
    expect(validatePayload(brightness, { brightness_pct: 60 })).toEqual({ ok: true, data: { brightness_pct: 60 } })
  })

  it('accepts an empty payload for an action that takes none', () => {
    expect(validatePayload(activate, {})).toEqual({ ok: true, data: {} })
  })

  it('rejects a value below the allowed range', () => {
    const res = validatePayload(brightness, { brightness_pct: -5 })
    expect(res.ok).toBe(false)
  })

  it('rejects a value above the allowed range', () => {
    expect(validatePayload(target, { temperature: 400 }).ok).toBe(false)
  })

  it('rejects a non-numeric value for a numeric field', () => {
    expect(validatePayload(brightness, { brightness_pct: 'bright' }).ok).toBe(false)
  })

  it('rejects keys the action does not declare', () => {
    const res = validatePayload(brightness, { brightness_pct: 50, hs_color: [1, 2] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/hs_color/)
  })

  it('refuses an entity_id in the payload, which could redirect the call', () => {
    const res = validatePayload(activate, { entity_id: 'lock.front_door' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/entity_id/)
  })

  it('rejects a missing required field', () => {
    expect(validatePayload(target, {}).ok).toBe(false)
  })

  it('accepts an omitted optional field', () => {
    expect(validatePayload(brightness, { brightness_pct: 40 }).ok).toBe(true)
  })
})
