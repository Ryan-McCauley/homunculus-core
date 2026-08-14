// REST client for the blocker board — what each employee is waiting on.

import type { Blocker, NewBlockerInput } from '../../shared/blockers'

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

const ROOT = '/api/crypto/office/blockers'

export async function fetchBlockers(): Promise<Blocker[]> {
  const d = await call<{ ok: boolean; blockers: Blocker[] }>(ROOT, 'GET')
  return d.blockers ?? []
}

export function raiseBlocker(input: NewBlockerInput): Promise<{ ok: boolean; error?: string; blocker?: Blocker; duplicate?: boolean }> {
  return call(ROOT, 'POST', input)
}

/** Answering unblocks the asker and wakes it on the next watch tick with the answer. */
export function answerBlocker(id: string, answer: string): Promise<{ ok: boolean; error?: string; blocker?: Blocker }> {
  return call(`${ROOT}/${encodeURIComponent(id)}/answer`, 'POST', { answer })
}

export function withdrawBlocker(id: string): Promise<{ ok: boolean; error?: string; blocker?: Blocker }> {
  return call(`${ROOT}/${encodeURIComponent(id)}/withdraw`, 'POST', {})
}
