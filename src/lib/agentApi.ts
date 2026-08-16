// Client for the agent uplink. Mirrors the base/token resolution in
// lib/layoutApi.ts and transport.ts.
//
// The ⌘K palette in the HOME tab and an autonomous agent hit the exact same two
// endpoints. That is the point: one grammar and one validator, so a plan the
// operator sees in the palette is the same object an agent would have received,
// and neither path has a route to Home Assistant that the other lacks.

import type { AgentManifest } from '../../shared/agentManifest'
import type { IntentPlan, PlanResult, RawOp } from '../../shared/agentPlan'

export interface IntentResponse {
  ok: boolean
  plan: IntentPlan
  result: PlanResult
}

function apiBase(): string {
  const explicit = (window as any).__HOMUNCULUS_API__ as string | undefined
  if (explicit) return explicit.replace(/\/$/, '')
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:8787`
  return location.origin
}

function withToken(path: string): string {
  const token = new URLSearchParams(location.search).get('token')
    || (window as any).__HOMUNCULUS_TOKEN__ || ''
  if (!token) return `${apiBase()}${path}`
  return `${apiBase()}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(withToken(path))
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/** The action contract for the current entity list. */
export const fetchAgentManifest = (): Promise<AgentManifest> =>
  get<AgentManifest>('/api/agent/manifest')

/** Compile and run an intent. Confirm-tier ops come back `held`, not executed. */
export const submitIntent = (text: string): Promise<IntentResponse> =>
  post<IntentResponse>('/api/agent/intent', { text })

/** Compile without executing — the plan preview behind the DRY RUN control. */
export const dryRunIntent = (text: string): Promise<IntentResponse> =>
  post<IntentResponse>('/api/agent/intent', { text, dry_run: true })

/**
 * Re-submit an intent, releasing specific confirm-tier ops by number.
 *
 * The request is re-compiled server-side rather than the client posting back the
 * plan it was shown — see executePlan, which re-validates against the manifest
 * for the same reason. `confirm` names op numbers, so approving the garage door
 * cannot also release an unlock that shared the plan.
 */
export const confirmOps = (
  intent: string | RawOp[],
  confirm: number[],
): Promise<IntentResponse> =>
  post<IntentResponse>('/api/agent/intent',
    typeof intent === 'string' ? { text: intent, confirm } : { ops: intent, confirm })
