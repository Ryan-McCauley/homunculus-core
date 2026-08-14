// REST client for the CRYPTO tab's INTELLIGENCE section. Mirrors cryptoApi.ts conventions.

import type { AgentMessage, AgentView, NewAgentInput } from '../../shared/agents'

function apiBase(): string {
  const explicit = (window as any).__HOMUNCULUS_API__ as string | undefined
  if (explicit) return explicit.replace(/\/$/, '')
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:8787`
  return location.origin
}

function token(): string {
  const q = new URLSearchParams(location.search)
  return q.get('token') || (window as any).__HOMUNCULUS_TOKEN__ || ''
}

function withToken(path: string): string {
  const t = token()
  if (!t) return path
  return path + (path.includes('?') ? '&' : '?') + `token=${encodeURIComponent(t)}`
}

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${withToken(path)}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  return res.json() as Promise<T>
}

export async function fetchAgents(): Promise<AgentView[]> {
  const data = await call<{ ok: boolean; agents: AgentView[] }>('/api/crypto/agents', 'GET')
  return data.agents ?? []
}

export function createAgent(input: NewAgentInput): Promise<{ ok: boolean; error?: string; agent?: AgentView }> {
  return call('/api/crypto/agents', 'POST', input)
}

export function updateAgent(id: string, patch: Partial<NewAgentInput>): Promise<{ ok: boolean; error?: string; agent?: AgentView }> {
  return call(`/api/crypto/agents/${encodeURIComponent(id)}`, 'PATCH', patch)
}

export function deleteAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return call(`/api/crypto/agents/${encodeURIComponent(id)}`, 'DELETE')
}

export function runAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return call(`/api/crypto/agents/${encodeURIComponent(id)}/run`, 'POST', {})
}

export function chatWithAgent(id: string, message: string): Promise<{ ok: boolean; error?: string; reply?: string; transcript?: AgentMessage[] }> {
  return call(`/api/crypto/agents/${encodeURIComponent(id)}/chat`, 'POST', { message })
}

export function clearAgentChat(id: string): Promise<{ ok: boolean }> {
  return call(`/api/crypto/agents/${encodeURIComponent(id)}/chat`, 'DELETE')
}
