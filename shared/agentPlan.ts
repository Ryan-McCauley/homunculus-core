// Plan types for the agent uplink.
//
// Split out of server/agentIntent.ts for the same reason shared/homeassistant.ts
// is split out of server/homeassistant.ts: the plan crosses the wire, so both the
// compiler that produces it and the panel that renders it need its shape, and the
// renderer must not import from server/ to get it.

import type { GuardrailTier } from './agentManifest'

export interface PlannedOp {
  /** 1-based position; how a human or agent confirms one specific op. */
  n: number
  actionId: string
  entityId: string
  service: string
  data: Record<string, unknown>
  summary: string
  tier: GuardrailTier
  /** Set when the compiler inferred this op rather than being told it outright. */
  note?: string
}

export interface IntentPlan {
  manifest: number
  text: string
  ops: PlannedOp[]
  /** Fragments the compiler could not turn into an op — shown, never silently dropped. */
  unmatched: string[]
}

/** An op submitted directly by a caller, rather than compiled from text. */
export interface RawOp {
  actionId: string
  data?: Record<string, unknown>
}

export type OpStatus = 'ok' | 'failed' | 'held' | 'dry_run' | 'refused'

export interface OpResult {
  n: number
  actionId: string
  entityId: string
  service: string
  status: OpStatus
  error?: string
}

export interface PlanResult {
  ok: boolean
  ops: OpResult[]
}
