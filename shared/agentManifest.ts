// The action manifest — the contract an AI operates the HOME tab through.
//
// The manifest answers three questions a model would otherwise have to guess at
// from pixels: what can be done, what payload each thing takes, and what it is
// allowed to do without asking. It is derived from the live entity list, so it
// describes THIS house rather than a generic Home Assistant.
//
// SECURITY. This file is the allowlist, and omission is the primary defence: a
// domain with no entry here has no actions, so there is nothing for an agent to
// call however it phrases the request. That mirrors ALLOWED_HA_EXEC_DOMAINS in
// server/routines.ts and exists for the same reason — the text an intent is
// compiled from is built partly out of HA friendly names, which a compromised
// integration can influence, so authority has to live in code rather than in
// what the model was told.
//
// Three tiers grade what is left:
//   read    — state only, no service call
//   write   — routine and reversible; an agent may do it alone, and it is logged
//   confirm — a human must approve this specific op before it executes
//
// Unlocking and moving physical barriers are `confirm` because getting them wrong
// has consequences you cannot undo from a dashboard: an unlocked door stays
// unlocked, and a garage door closes on whatever is under it.

import { HOME_VIEWS, type HomeView } from './homeRoute'
import type { HaEntity } from './homeassistant'

/** Bump when the shape or the action vocabulary changes; plans cite what they compiled against. */
export const MANIFEST_VERSION = 1

export type GuardrailTier = 'read' | 'write' | 'confirm'

/** One payload field: enough for an agent to fill in and for us to validate. */
export interface FieldSpec {
  type: 'number' | 'string' | 'rgb'
  /** Human/agent-readable summary, e.g. '0..100'. */
  doc: string
  required?: boolean
  min?: number
  max?: number
  values?: string[]
}

export interface AgentAction {
  /** Stable id: '<entityId>:<verb>'. Derived from identity, never from position. */
  id: string
  entityId: string
  service: string
  label: string
  tier: GuardrailTier
  schema: Record<string, FieldSpec>
}

export interface AgentManifest {
  manifest: number
  routes: string[]
  actions: AgentAction[]
}

interface VerbDef {
  verb: string
  service: string
  tier?: GuardrailTier
  schema?: Record<string, FieldSpec>
}

const PCT: FieldSpec = { type: 'number', doc: '0..100', required: true, min: 0, max: 100 }
const TRANSITION: FieldSpec = { type: 'number', doc: 'seconds, 0..300', min: 0, max: 300 }

/**
 * Every action this app is willing to expose, by entity domain.
 *
 * Domains absent from this table (sensor, binary_sensor, device_tracker, tts, …)
 * are read-only by construction — they produce no actions and therefore cannot be
 * commanded through the agent path at all.
 */
const DOMAIN_ACTIONS: Record<string, VerbDef[]> = {
  light: [
    { verb: 'turn_on', service: 'light.turn_on' },
    { verb: 'turn_off', service: 'light.turn_off' },
    { verb: 'set_brightness', service: 'light.turn_on', schema: { brightness_pct: PCT, transition: TRANSITION } },
    { verb: 'set_color', service: 'light.turn_on', schema: { rgb_color: { type: 'rgb', doc: '[r,g,b] each 0..255', required: true } } },
  ],
  switch: [
    { verb: 'turn_on', service: 'switch.turn_on' },
    { verb: 'turn_off', service: 'switch.turn_off' },
  ],
  fan: [
    { verb: 'turn_on', service: 'fan.turn_on' },
    { verb: 'turn_off', service: 'fan.turn_off' },
  ],
  climate: [
    // Bounded well inside any thermostat's own limits: an agent that misreads a
    // request should not be able to command a temperature that costs a fortune
    // or freezes pipes.
    { verb: 'set_target', service: 'climate.set_temperature', schema: { temperature: { type: 'number', doc: '50..90', required: true, min: 50, max: 90 } } },
    { verb: 'set_mode', service: 'climate.set_hvac_mode', schema: { hvac_mode: { type: 'string', doc: 'heat | cool | heat_cool | auto | off', required: true, values: ['heat', 'cool', 'heat_cool', 'auto', 'off'] } } },
  ],
  scene: [{ verb: 'activate', service: 'scene.turn_on' }],
  script: [{ verb: 'run', service: 'script.turn_on' }],
  automation: [
    { verb: 'enable', service: 'automation.turn_on' },
    { verb: 'disable', service: 'automation.turn_off' },
    { verb: 'trigger', service: 'automation.trigger' },
  ],
  vacuum: [
    { verb: 'start', service: 'vacuum.start' },
    { verb: 'stop', service: 'vacuum.stop' },
    { verb: 'return_home', service: 'vacuum.return_to_base' },
  ],
  button: [{ verb: 'press', service: 'button.press' }],
  media_player: [
    { verb: 'play', service: 'media_player.media_play' },
    { verb: 'pause', service: 'media_player.media_pause' },
    { verb: 'stop', service: 'media_player.media_stop' },
    { verb: 'set_volume', service: 'media_player.volume_set', schema: { volume_level: { type: 'number', doc: '0..1', required: true, min: 0, max: 1 } } },
  ],
  number: [{ verb: 'set_value', service: 'number.set_value', schema: { value: { type: 'number', doc: 'any number', required: true } } }],
  select: [{ verb: 'select_option', service: 'select.select_option', schema: { option: { type: 'string', doc: 'one of the entity options', required: true } } }],
  // Locking is routine; unlocking is not.
  lock: [
    { verb: 'lock', service: 'lock.lock' },
    { verb: 'unlock', service: 'lock.unlock', tier: 'confirm' },
  ],
  // Every cover action is confirm-tier: a moving barrier can trap or damage, and
  // that is true of stopping one halfway as much as opening or closing it.
  cover: [
    { verb: 'open', service: 'cover.open_cover', tier: 'confirm' },
    { verb: 'close', service: 'cover.close_cover', tier: 'confirm' },
    { verb: 'stop', service: 'cover.stop_cover', tier: 'confirm' },
  ],
}

/** The stable address of an action: identity plus verb, never position. */
export function actionId(entityId: string, verb: string): string {
  return `${entityId}:${verb}`
}

function humanVerb(verb: string): string {
  return verb.replace(/_/g, ' ')
}

/** Every route shape the tab can be in, for an agent to navigate by. */
function routesFor(views: readonly HomeView[]): string[] {
  return views.map((view) => {
    if (view === 'sectors') return '#/home/sectors/:sector'
    if (view === 'registry') return '#/home/registry?domain=:domain&q=:text'
    return `#/home/${view}`
  })
}

/** Builds the manifest for a live entity list. */
export function buildManifest(entities: HaEntity[]): AgentManifest {
  const actions: AgentAction[] = []
  for (const entity of entities) {
    const verbs = DOMAIN_ACTIONS[entity.domain]
    if (!verbs) continue
    for (const def of verbs) {
      actions.push({
        id: actionId(entity.entityId, def.verb),
        entityId: entity.entityId,
        service: def.service,
        label: `${entity.name}: ${humanVerb(def.verb)}`,
        tier: def.tier ?? 'write',
        schema: def.schema ?? {},
      })
    }
  }
  return { manifest: MANIFEST_VERSION, routes: routesFor(HOME_VIEWS), actions }
}

export function findAction(manifest: Pick<AgentManifest, 'actions'>, id: string): AgentAction | null {
  return manifest.actions.find((a) => a.id === id) ?? null
}

export type ValidationResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Checks a payload against an action's schema, returning only declared fields.
 *
 * Unknown keys are rejected rather than dropped. Silently ignoring them would
 * make a rejected instruction look like an accepted one, and the specific key
 * worth being loud about is `entity_id`: haHub.sendCommand spreads payload data
 * into the request body, so a payload carrying its own entity_id is an attempt to
 * point an approved service at a different device than the one authorised.
 */
export function validatePayload(action: AgentAction, data: Record<string, unknown>): ValidationResult {
  for (const key of Object.keys(data)) {
    if (key === 'entity_id') {
      return { ok: false, error: `payload may not carry entity_id — ${action.id} acts on ${action.entityId}` }
    }
    if (!(key in action.schema)) {
      return { ok: false, error: `${action.id} does not accept "${key}"` }
    }
  }

  const clean: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(action.schema)) {
    const value = data[key]
    if (value === undefined) {
      if (spec.required) return { ok: false, error: `${action.id} requires "${key}" (${spec.doc})` }
      continue
    }
    const problem = checkField(key, spec, value)
    if (problem) return { ok: false, error: `${action.id}: ${problem}` }
    clean[key] = value
  }
  return { ok: true, data: clean }
}

function checkField(key: string, spec: FieldSpec, value: unknown): string | null {
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `"${key}" must be a number (${spec.doc})`
    if (spec.min !== undefined && value < spec.min) return `"${key}" must be at least ${spec.min}`
    if (spec.max !== undefined && value > spec.max) return `"${key}" must be at most ${spec.max}`
    return null
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return `"${key}" must be a string (${spec.doc})`
    if (spec.values && !spec.values.includes(value)) return `"${key}" must be one of: ${spec.values.join(', ')}`
    return null
  }
  // rgb
  if (!Array.isArray(value) || value.length !== 3) return `"${key}" must be ${spec.doc}`
  for (const channel of value) {
    if (typeof channel !== 'number' || !Number.isFinite(channel) || channel < 0 || channel > 255) {
      return `"${key}" channels must be 0..255`
    }
  }
  return null
}
