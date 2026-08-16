// Named routines Claude can invoke. Each routine is a sequence of HA service
// calls executed in order. Add or edit routines here — Claude will describe
// what's available and execute them on request.

import { haHub } from './homeassistant'

export interface RoutineStep {
  entityId: string
  service: string
  data?: Record<string, unknown>
}

export interface Routine {
  label: string
  description: string
  steps: RoutineStep[]
}

// ── Routine definitions ────────────────────────────────────────────────────
// Verify entity IDs match your HA instance. The entity IDs here are best-guess
// defaults; edit as needed after checking HA → Developer Tools → States.

export const ROUTINES: Record<string, Routine> = {
  goodnight: {
    label: 'Goodnight',
    description: 'Sets thermostat to sleep temperature (68°F) and triggers a litter box cleaning cycle',
    steps: [
      { entityId: 'climate.main_thermostat', service: 'climate.set_temperature', data: { temperature: 68 } },
      { entityId: 'vacuum.r2peepoo_litter_box', service: 'vacuum.start', data: {} }
    ]
  },
  away: {
    label: 'Away Mode',
    description: 'Sets thermostat to energy-saving temperature (78°F)',
    steps: [
      { entityId: 'climate.main_thermostat', service: 'climate.set_temperature', data: { temperature: 78 } }
    ]
  },
  home: {
    label: 'Arriving Home',
    description: 'Sets thermostat to comfortable temperature (72°F)',
    steps: [
      { entityId: 'climate.main_thermostat', service: 'climate.set_temperature', data: { temperature: 72 } }
    ]
  },
  charge_voltaire: {
    label: 'Charge Voltaire',
    description: 'Opens the charge port door and starts charging',
    steps: [
      { entityId: 'cover.voltaire_charge_port_door', service: 'cover.open_cover', data: {} },
      { entityId: 'switch.voltaire_charger_switch', service: 'switch.turn_on', data: {} }
    ]
  },
  stop_charging: {
    label: 'Stop Charging',
    description: 'Stops charging Voltaire',
    steps: [
      { entityId: 'switch.voltaire_charger_switch', service: 'switch.turn_off', data: {} }
    ]
  },
  clean_litter: {
    label: 'Clean Litter Box',
    description: 'Triggers an immediate R2PEEPOO cleaning cycle',
    steps: [
      { entityId: 'vacuum.r2peepoo_litter_box', service: 'vacuum.start', data: {} }
    ]
  }
}

// ── Routine executor ───────────────────────────────────────────────────────

export interface ExecResult {
  ok: boolean
  label: string
  error?: string
}

export async function executeRoutine(name: string): Promise<ExecResult> {
  const routine = ROUTINES[name]
  if (!routine) return { ok: false, label: name, error: `Unknown routine: ${name}` }
  try {
    for (const step of routine.steps) {
      await haHub.sendCommand(step.entityId, step.service, step.data ?? {})
    }
    return { ok: true, label: routine.label }
  } catch (err) {
    return { ok: false, label: routine.label, error: (err as Error).message }
  }
}

// Domains the Computer Core's chat exec blocks may act on. This is the sole
// caller of executeHaCommand (see server/chat.ts) — the OPERATOR's own HOME tab
// controls entities through a separate WS path (server/index.ts's ws 'ha'
// channel) and is not restricted here, because the operator is entitled to
// control anything in their own house. What reaches THIS function is instead a
// command the model itself decided to issue from free-form text, and that text
// is built partly from live HA entity names and state — attacker-influenceable
// in principle if a compromised integration puts something adversarial in a
// friendly_name. Authority belongs in code, not in what the model was told or
// decided to say: physical-convenience domains only, security-relevant ones
// (locks, alarm panels) and anything not on the list are refused outright.
//
// CRITICAL: the allowlist is checked against the SERVICE domain, not the
// entityId domain. haHub.sendCommand builds the HA endpoint from the service
// string ("lock.unlock" → POST /api/services/lock/unlock) and ignores the
// entityId's own domain entirely — so gating on entityId let a caller pass
// `{ entityId: "switch.x", service: "lock.unlock" }` straight through to the
// lock. The service is what actually executes; the service is what we gate.
const ALLOWED_HA_EXEC_DOMAINS = new Set([
  'climate', 'switch', 'vacuum', 'cover', 'fan', 'light', 'media_player', 'number', 'select', 'button'
])

export async function executeHaCommand(
  entityId: string,
  service: string,
  data: Record<string, unknown>
): Promise<ExecResult> {
  // The service domain is the one that decides which HA service actually runs.
  const serviceDomain = service.split('.')[0] ?? ''
  const entityDomain = entityId.split('.')[0] ?? ''
  if (!ALLOWED_HA_EXEC_DOMAINS.has(serviceDomain)) {
    return {
      ok: false, label: `${service} → ${entityId}`,
      error: `the Computer Core cannot call "${serviceDomain}" services — allowed: ${[...ALLOWED_HA_EXEC_DOMAINS].join(', ')}`
    }
  }
  // Belt and braces: the entity the service acts on must be in an allowed domain
  // too, so an allowed service (switch.turn_on) can't be pointed at a lock via a
  // cross-domain entity_id that some integrations honour.
  if (!ALLOWED_HA_EXEC_DOMAINS.has(entityDomain)) {
    return {
      ok: false, label: `${service} → ${entityId}`,
      error: `the Computer Core cannot target "${entityDomain}" entities — allowed: ${[...ALLOWED_HA_EXEC_DOMAINS].join(', ')}`
    }
  }
  // `data` is model-supplied too, and sendCommand spreads it into the request
  // body. Strip any entity_id it carries so it cannot redirect the call away
  // from the entityId we just validated (sendCommand also re-asserts entity_id
  // last, but defense in depth: never forward an override this far).
  const { entity_id: _ignoredEntityOverride, ...safeData } = data
  try {
    await haHub.sendCommand(entityId, service, safeData)
    return { ok: true, label: `${service} → ${entityId}` }
  } catch (err) {
    return { ok: false, label: `${service} → ${entityId}`, error: (err as Error).message }
  }
}

export function routinesSummary(): string {
  return Object.entries(ROUTINES)
    .map(([key, r]) => `  • ${key}: ${r.description}`)
    .join('\n')
}
