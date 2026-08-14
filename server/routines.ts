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

export async function executeHaCommand(
  entityId: string,
  service: string,
  data: Record<string, unknown>
): Promise<ExecResult> {
  try {
    await haHub.sendCommand(entityId, service, data)
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
