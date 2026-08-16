// Client for the device-onboarding routes. Mirrors the base/token resolution in
// lib/layoutApi.ts and transport.ts.
//
// Everything here is operator-only: these routes drive Home Assistant's config
// flows, which is where credentials get typed and where a new integration gains
// access to the house. There is deliberately no agent equivalent.

import type {
  ConfigEntrySummary, DiscoveredFlow, FlowOutcome,
} from '../../shared/haConfigFlow'

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

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/**
 * Flow calls answer with a FlowOutcome even when the transport fails.
 *
 * The whole UI is a state machine over outcomes, and a thrown exception at one
 * call site would leave a half-finished flow with nothing rendered to explain
 * why. A dead server is just another thing the step area can say out loud.
 */
async function flowCall(path: string, method: string, body?: unknown): Promise<FlowOutcome> {
  try {
    return await call<FlowOutcome>(path, method, body)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Integration domains that can be set up. */
export async function fetchIntegrations(): Promise<string[]> {
  const data = await call<{ handlers?: string[] }>('/api/ha/integrations', 'GET')
  return data.handlers ?? []
}

/** Integrations already configured. */
export async function fetchEntries(): Promise<ConfigEntrySummary[]> {
  const data = await call<{ entries?: ConfigEntrySummary[] }>('/api/ha/entries', 'GET')
  return data.entries ?? []
}

/** Devices HA discovered but nobody has set up. Empty when unavailable. */
export async function fetchDiscovered(): Promise<DiscoveredFlow[]> {
  const data = await call<{ flows?: DiscoveredFlow[] }>('/api/ha/discovered', 'GET')
  return data.flows ?? []
}

/** Start adding an integration. */
export const beginFlow = (handler: string): Promise<FlowOutcome> =>
  flowCall('/api/ha/flow', 'POST', { handler })

/** Resume a flow HA started itself, from a discovery. */
export const resumeFlow = (flowId: string): Promise<FlowOutcome> =>
  flowCall(`/api/ha/flow/${encodeURIComponent(flowId)}`, 'GET')

/** Submit one step's answers. */
export const advanceFlow = (flowId: string, values: Record<string, unknown>): Promise<FlowOutcome> =>
  flowCall(`/api/ha/flow/${encodeURIComponent(flowId)}`, 'POST', { values })

/** Cancel an in-progress flow. */
export const cancelFlow = (flowId: string): Promise<{ ok: boolean; error?: string }> =>
  call(`/api/ha/flow/${encodeURIComponent(flowId)}`, 'DELETE')

/** Remove an integration entirely. */
export const removeEntry = (entryId: string): Promise<{ ok: boolean; requireRestart?: boolean; error?: string }> =>
  call(`/api/ha/entries/${encodeURIComponent(entryId)}`, 'DELETE')

/** Reload an integration in place. */
export const reloadIntegration = (entryId: string): Promise<{ ok: boolean; requireRestart?: boolean }> =>
  call(`/api/ha/entries/${encodeURIComponent(entryId)}/reload`, 'POST', {})
