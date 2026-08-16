// Client for Home Assistant's config-entries API — listing integrations, adding
// one, and removing one.
//
// A caution worth carrying: none of this is in HA's published REST docs. It is
// the surface the HA frontend itself uses, it is fully covered by HA's own tests,
// but it carries no stability guarantee, so every response here is parsed
// defensively and every failure degrades to a message the operator can act on
// rather than an exception.
//
// AUTHORIZATION. The flow endpoints are not merely token-gated like /api/states —
// they additionally require the token's user to be an ADMIN, and answer 401 when
// it is not. A long-lived token inherits the admin status of the account that
// created it, so a token minted from a non-admin user reads state perfectly and
// then fails only here. That is a confusing failure to debug from a bare 401,
// which is why it gets its own message.
//
// DISCOVERY IS WEBSOCKET-ONLY. GET /api/config/config_entries/flow used to list
// in-progress flows and now explicitly returns 405. Discovered-but-unconfigured
// devices are reachable only over the websocket API, so that is handled
// separately (fetchDiscoveredFlows) and the REST path stays complete without it.

import { WebSocket } from 'ws'
import { parseDiscoveredFlows as parseFlows } from '../shared/haConfigFlow'
import type {
  ConfigEntrySummary, DiscoveredFlow, FlowOutcome, FlowStepPayload,
} from '../shared/haConfigFlow'

export type {
  ConfigEntrySummary, DiscoveredFlow, FlowOutcome, FlowStepPayload,
} from '../shared/haConfigFlow'
export { parseDiscoveredFlows } from '../shared/haConfigFlow'

/** Read lazily rather than at import, so a test can stub the environment. */
function haConfig(): { url: string; token: string } {
  return {
    url: (process.env['HA_URL'] || '').replace(/\/$/, ''),
    token: process.env['HA_TOKEN'] || '',
  }
}

const TIMEOUT_MS = 15_000

/** HA ids appear in a URL path, so anything path-shaped is refused outright. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/

function requireConfigured(): { url: string; token: string } {
  const config = haConfig()
  if (!config.url || !config.token) {
    throw new Error('Home Assistant is not configured — set HA_URL and HA_TOKEN')
  }
  return config
}

async function request(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const { url, token } = requireConfigured()
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

  // Not every error body is JSON: a failed-dependency 400 comes back as plain
  // text, and calling .json() on it throws over the top of the real message.
  const contentType = res.headers.get('content-type') ?? ''
  const body = contentType.includes('application/json') ? await res.json() : await res.text()
  return { status: res.status, body }
}

/** Turns a non-2xx response into an operator-readable message. */
function describeFailure(status: number, body: unknown): string {
  if (status === 401 || status === 403) {
    return 'Home Assistant refused this as unauthorized — config flows require an ADMIN user, '
      + 'so HA_TOKEN must be a long-lived token created by an admin account'
  }
  if (typeof body === 'string' && body.trim()) return body.trim()
  const message = (body as { message?: unknown } | null)?.message
  if (typeof message === 'string') return message
  return `Home Assistant returned ${status}`
}

/** Every integration domain that can be set up from the UI, sorted. */
export async function listHandlers(): Promise<string[]> {
  const { status, body } = await request('/api/config/config_entries/flow_handlers?type=integration')
  if (status !== 200) throw new Error(describeFailure(status, body))
  // HA builds this from a Python set, so the order is genuinely arbitrary.
  return Array.isArray(body) ? [...body].map(String).sort() : []
}

/** Integrations already set up. */
export async function listEntries(): Promise<ConfigEntrySummary[]> {
  const { status, body } = await request('/api/config/config_entries/entry')
  if (status !== 200) throw new Error(describeFailure(status, body))
  return Array.isArray(body) ? (body as ConfigEntrySummary[]) : []
}

function asOutcome(status: number, body: unknown): FlowOutcome {
  if (status >= 200 && status < 300) return { ok: true, step: body as FlowStepPayload }

  // A 400 carrying `errors` is per-field schema validation. This is genuinely
  // distinct from a 200 form step that also has an `errors` key: same word,
  // different status, different meaning, and only one of them is a step.
  const errors = (body as { errors?: unknown } | null)?.errors
  if (status === 400 && errors && typeof errors === 'object') {
    return {
      ok: false,
      error: 'Home Assistant rejected those values',
      fieldErrors: errors as Record<string, string>,
    }
  }
  return { ok: false, error: describeFailure(status, body) }
}

/**
 * Begins a config flow for an integration domain.
 *
 * `show_advanced_options` is still sent: HA removed it in 2026.6 and the request
 * schema allows extra keys, so it is inert on new versions and still meaningful
 * on older ones.
 */
export async function startFlow(handler: string): Promise<FlowOutcome> {
  const { status, body } = await request('/api/config/config_entries/flow', {
    method: 'POST',
    body: { handler, show_advanced_options: true },
  })
  return asOutcome(status, body)
}

/** Re-reads the current step of a flow. */
export async function getFlow(flowId: string): Promise<FlowOutcome> {
  if (!SAFE_ID.test(flowId)) return { ok: false, error: 'invalid flow id' }
  const { status, body } = await request(`/api/config/config_entries/flow/${flowId}`)
  return asOutcome(status, body)
}

/** Submits one step's answers and returns whatever comes next. */
export async function submitStep(flowId: string, values: Record<string, unknown>): Promise<FlowOutcome> {
  if (!SAFE_ID.test(flowId)) return { ok: false, error: 'invalid flow id' }
  const { status, body } = await request(`/api/config/config_entries/flow/${flowId}`, {
    method: 'POST',
    body: values,
  })
  return asOutcome(status, body)
}

/** Cancels an in-progress flow. */
export async function abortFlow(flowId: string): Promise<{ ok: boolean; error?: string }> {
  if (!SAFE_ID.test(flowId)) return { ok: false, error: 'invalid flow id' }
  const { status, body } = await request(`/api/config/config_entries/flow/${flowId}`, { method: 'DELETE' })
  return status >= 200 && status < 300 ? { ok: true } : { ok: false, error: describeFailure(status, body) }
}

async function entryAction(
  entryId: string,
  suffix: string,
  method: string,
): Promise<{ ok: boolean; requireRestart?: boolean; error?: string }> {
  if (!SAFE_ID.test(entryId)) return { ok: false, error: 'invalid entry id' }
  const { status, body } = await request(`/api/config/config_entries/entry/${entryId}${suffix}`, { method })
  if (status < 200 || status >= 300) return { ok: false, error: describeFailure(status, body) }
  return { ok: true, requireRestart: (body as { require_restart?: boolean })?.require_restart === true }
}

/** Removes an integration and everything it provided. */
export const deleteEntry = (entryId: string) => entryAction(entryId, '', 'DELETE')

/** Reloads an integration in place. */
export const reloadEntry = (entryId: string) => entryAction(entryId, '/reload', 'POST')

// ── Discovery (websocket-only) ─────────────────────────────────────────────

/**
 * Asks over the websocket for flows awaiting setup — devices HA found on the
 * network by itself. Returns [] rather than throwing when unavailable, since a
 * missing discovery list must not break the rest of the DEVICES view.
 */
export function fetchDiscoveredFlows(timeoutMs = 10_000): Promise<DiscoveredFlow[]> {
  const { url, token } = haConfig()
  if (!url || !token) return Promise.resolve([])

  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(`${url.replace(/^http/, 'ws')}/api/websocket`)
    } catch {
      resolve([])
      return
    }

    let settled = false
    const finish = (value: DiscoveredFlow[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closing */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)

    socket.on('error', () => finish([]))
    socket.on('close', () => finish([]))
    socket.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      if (msg['type'] === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }))
      } else if (msg['type'] === 'auth_ok') {
        socket.send(JSON.stringify({ id: 1, type: 'config_entries/flow/progress' }))
      } else if (msg['type'] === 'auth_invalid') {
        finish([])
      } else if (msg['type'] === 'result' && msg['id'] === 1) {
        finish(msg['success'] ? parseFlows(msg['result']) : [])
      }
    })
  })
}
