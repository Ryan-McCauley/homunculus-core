// REST client for the library — documents employees file to outlive their runs.

import type { Artifact, ArtifactPatch, ArtifactSummary, NewArtifactInput } from '../../shared/library'

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

const ROOT = '/api/crypto/office/library'

export async function fetchLibrary(): Promise<ArtifactSummary[]> {
  const d = await call<{ ok: boolean; artifacts: ArtifactSummary[] }>(ROOT, 'GET')
  return d.artifacts ?? []
}

export async function fetchArtifact(id: string): Promise<Artifact | null> {
  const d = await call<{ ok: boolean; artifact?: Artifact }>(`${ROOT}/${encodeURIComponent(id)}`, 'GET')
  return d.artifact ?? null
}

export function fileArtifact(input: NewArtifactInput): Promise<{ ok: boolean; error?: string; artifact?: Artifact }> {
  return call(ROOT, 'POST', input)
}

export function updateArtifact(id: string, patch: ArtifactPatch): Promise<{ ok: boolean; error?: string; artifact?: Artifact }> {
  return call(`${ROOT}/${encodeURIComponent(id)}`, 'PATCH', patch)
}

export function deleteArtifact(id: string): Promise<{ ok: boolean }> {
  return call(`${ROOT}/${encodeURIComponent(id)}`, 'DELETE')
}
