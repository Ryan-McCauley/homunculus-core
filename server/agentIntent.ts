// The uplink's intent compiler and executor.
//
// One grammar serves both operators. A human types "movie mode, but keep the
// reading lamp on and lock up"; an agent POSTs either the same sentence or a list
// of structured ops. Both land here, both compile to the same explicit plan of
// numbered service calls, and both execute through the same validator and the
// same audit trail.
//
// Nothing fires directly from text. Compiling to a plan first is what makes the
// uplink safe to point an LLM at: the plan is inspectable before it runs, a dry
// run costs nothing, an inference the compiler made (closing the garage because
// you said "lock up") is visible as an op rather than a surprise, and anything on
// the confirm tier stops and waits for a human regardless of who asked.
//
// The compiler here is deliberately deterministic keyword matching, not an LLM.
// It is small, it is testable, and it never invents an entity. When an LLM is
// eventually put in front of this, it should emit structured ops into compileOps
// rather than replace the validation — the guardrails are the part that has to
// hold no matter how the request was phrased.

import { haHub } from './homeassistant'
import { auditLog } from './auditLog'
import {
  actionId, findAction, validatePayload,
  type AgentAction, type AgentManifest,
} from '../shared/agentManifest'
import type {
  IntentPlan, OpResult, PlanResult, PlannedOp, RawOp,
} from '../shared/agentPlan'
import type { HaEntity } from '../shared/homeassistant'

export type { IntentPlan, OpResult, OpStatus, PlanResult, PlannedOp, RawOp } from '../shared/agentPlan'

type Draft = Omit<PlannedOp, 'n'>

/** Assigns op numbers last, so every rule can append without tracking position. */
function numbered(drafts: Draft[]): PlannedOp[] {
  return drafts.map((op, i) => ({ ...op, n: i + 1 }))
}

function draft(action: AgentAction, data: Record<string, unknown>, note?: string): Draft {
  return {
    actionId: action.id,
    entityId: action.entityId,
    service: action.service,
    data,
    summary: action.label,
    tier: action.tier,
    ...(note ? { note } : {}),
  }
}

/** Compiles free text into a plan against the manifest and current entity states. */
export function compileIntent(text: string, manifest: AgentManifest, entities: HaEntity[]): IntentPlan {
  const lower = text.toLowerCase()
  const drafts: Draft[] = []
  const claimed = new Set<string>()

  const add = (id: string, data: Record<string, unknown> = {}, note?: string): void => {
    const action = findAction(manifest, id)
    if (!action) return
    // One op per entity: a sentence that matches two rules for the same device
    // ("reading lamp to 40%" is both a named light and a brightness) must not
    // produce two conflicting calls.
    if (claimed.has(action.entityId)) return
    const validated = validatePayload(action, data)
    if (!validated.ok) return
    claimed.add(action.entityId)
    drafts.push(draft(action, validated.data, note))
  }

  const byDomain = (domain: string): HaEntity[] => entities.filter((e) => e.domain === domain)
  const mentions = (entity: HaEntity): boolean => {
    const name = entity.name.toLowerCase()
    return name.length >= 3 && lower.includes(name)
  }

  // 1. A scene named outright.
  for (const scene of byDomain('scene')) {
    if (mentions(scene)) add(actionId(scene.entityId, 'activate'))
  }

  // 2. The thermostat, when a temperature is in the text.
  if (/\b(thermostat|temperature|degrees)\b/.test(lower)) {
    const degrees = lower.match(/\b(\d{2,3})\b/)
    if (degrees) {
      for (const climate of byDomain('climate')) {
        add(actionId(climate.entityId, 'set_target'), { temperature: Number(degrees[1]) })
      }
    }
  }

  // 3. A named light, set to a percentage or simply on/off.
  const pct = lower.match(/(\d{1,3})\s*%/)
  for (const light of byDomain('light')) {
    if (!mentions(light)) continue
    if (pct) add(actionId(light.entityId, 'set_brightness'), { brightness_pct: Number(pct[1]) })
    else if (/\boff\b/.test(lower)) add(actionId(light.entityId, 'turn_off'))
    else if (/\bon\b/.test(lower)) add(actionId(light.entityId, 'turn_on'))
  }

  // 4. Everything dark.
  if (/\blights?\s+(off|out)\b/.test(lower)) {
    for (const light of byDomain('light')) add(actionId(light.entityId, 'turn_off'))
  }

  // 5. Locking up — and the inference that goes with it.
  if (/\block\s+(up|the\s+\w+|everything|all)\b/.test(lower) || /\block\s*up\b/.test(lower)) {
    for (const lock of byDomain('lock')) add(actionId(lock.entityId, 'lock'))
    // "Lock up" means the house is being shut, so an open door that is not a
    // lock still matters. This is an inference, so it is flagged as one and lands
    // on the confirm tier where a human decides.
    for (const cover of byDomain('cover')) {
      if (cover.state !== 'open') continue
      add(actionId(cover.entityId, 'close'), {}, 'inferred from "lock up" — currently open')
    }
  }

  return {
    manifest: manifest.manifest,
    text,
    ops: numbered(drafts),
    unmatched: drafts.length ? [] : [text.trim()],
  }
}

/**
 * Compiles caller-supplied structured ops — the path an LLM or a script uses.
 *
 * Every op is checked against the manifest here, and anything that fails is
 * reported in `unmatched` rather than passed along in a weaker form.
 */
export function compileOps(raw: RawOp[], manifest: AgentManifest): IntentPlan {
  const drafts: Draft[] = []
  const unmatched: string[] = []
  for (const op of raw) {
    const action = findAction(manifest, op.actionId)
    if (!action) {
      unmatched.push(`unknown action: ${op.actionId}`)
      continue
    }
    const validated = validatePayload(action, op.data ?? {})
    if (!validated.ok) {
      unmatched.push(validated.error)
      continue
    }
    drafts.push(draft(action, validated.data))
  }
  return { manifest: manifest.manifest, text: '', ops: numbered(drafts), unmatched }
}

export interface ExecuteOptions {
  /** Op numbers a human has explicitly approved. Only these release confirm-tier ops. */
  confirmed?: number[]
  dryRun?: boolean
  /** Who asked, for the audit entry. */
  actor?: string
}

/**
 * Executes a plan, one op at a time, in order.
 *
 * The plan is re-validated against the manifest here rather than trusted. A plan
 * makes a round trip through the client between compilation and execution — it is
 * rendered, a human confirms part of it, and it comes back — so by the time it
 * arrives its `service` and `entityId` fields are caller-supplied strings. The
 * manifest, not the plan, decides what actually runs.
 *
 * A failing op does not abort the rest: "lock the front and back doors" should
 * still lock the back door when the front one errors, and the result reports
 * exactly which ops did what.
 */
export async function executePlan(
  plan: IntentPlan,
  manifest: AgentManifest,
  options: ExecuteOptions,
): Promise<PlanResult> {
  const confirmed = new Set(options.confirmed ?? [])
  const results: OpResult[] = []

  for (const op of plan.ops) {
    const base = { n: op.n, actionId: op.actionId, entityId: op.entityId, service: op.service }
    const action = findAction(manifest, op.actionId)

    // Re-validation: the action must exist, and the plan's own claims about what
    // it targets must match what the manifest says that action does.
    if (!action) {
      results.push({ ...base, status: 'refused', error: `unknown action: ${op.actionId}` })
      continue
    }
    if (action.entityId !== op.entityId || action.service !== op.service) {
      results.push({
        ...base, status: 'refused',
        error: `plan does not match the manifest: ${op.actionId} is ${action.service} on ${action.entityId}`,
      })
      continue
    }
    const validated = validatePayload(action, op.data ?? {})
    if (!validated.ok) {
      results.push({ ...base, status: 'refused', error: validated.error })
      continue
    }

    if (options.dryRun) {
      results.push({ ...base, status: 'dry_run' })
      continue
    }
    // Confirmation is per-op by number, never per-plan: approving the garage door
    // must not also release an unlock that happened to be in the same request.
    if (action.tier === 'confirm' && !confirmed.has(op.n)) {
      results.push({ ...base, status: 'held', error: 'awaiting confirmation' })
      continue
    }

    try {
      await haHub.sendCommand(action.entityId, action.service, validated.data)
      results.push({ ...base, status: 'ok' })
      auditLog.note({
        action: 'ha.agent.execute',
        resource: action.entityId,
        summary: `${action.service} → ${action.entityId}${op.note ? ` (${op.note})` : ''}`,
        meta: {
          actionId: action.id,
          tier: action.tier,
          data: validated.data,
          requestedBy: options.actor ?? 'operator',
          ...(plan.text ? { intent: plan.text } : {}),
        },
      })
    } catch (err) {
      results.push({ ...base, status: 'failed', error: (err as Error).message })
    }
  }

  return { ok: results.every((r) => r.status !== 'failed' && r.status !== 'refused'), ops: results }
}
