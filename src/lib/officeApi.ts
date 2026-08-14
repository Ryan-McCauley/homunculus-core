// REST client for the office — HR records, cubicles and the message board.

import type { BoardThread, CubicleView, JournalEntry, NewPersonnelInput, PersonnelRecord, Thought } from '../../shared/office'
import type { ManagerFileItem } from '../../shared/managerFile'

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

export interface RosterEntry {
  id: string
  name: string
  title: string
  personnel: PersonnelRecord
  inbox: number
}

export async function fetchRoster(): Promise<RosterEntry[]> {
  const d = await call<{ ok: boolean; roster: RosterEntry[] }>('/api/crypto/office', 'GET')
  return d.roster ?? []
}

export async function fetchCubicle(agentId: string): Promise<CubicleView | null> {
  const d = await call<{ ok: boolean; cubicle?: CubicleView }>(`/api/crypto/office/${encodeURIComponent(agentId)}`, 'GET')
  return d.cubicle ?? null
}

export function updatePersonnel(agentId: string, patch: NewPersonnelInput): Promise<{ ok: boolean; error?: string; personnel?: PersonnelRecord }> {
  return call(`/api/crypto/office/${encodeURIComponent(agentId)}`, 'PATCH', patch)
}

export function addJournalEntry(agentId: string, entry: { title?: string; body: string; tags?: string[]; author?: 'agent' | 'operator' }): Promise<{ ok: boolean; entry?: JournalEntry }> {
  return call(`/api/crypto/office/${encodeURIComponent(agentId)}/journal`, 'POST', entry)
}

export function recordThought(agentId: string, thought: { kind?: Thought['kind']; text: string }): Promise<{ ok: boolean; thought?: Thought }> {
  return call(`/api/crypto/office/${encodeURIComponent(agentId)}/mind`, 'POST', thought)
}

export async function fetchBoard(): Promise<BoardThread[]> {
  const d = await call<{ ok: boolean; threads: BoardThread[] }>('/api/crypto/office/board', 'GET')
  return d.threads ?? []
}

export function postThread(input: { authorId: string; title: string; body: string; tags?: string[] }): Promise<{ ok: boolean; error?: string; thread?: BoardThread }> {
  return call('/api/crypto/office/board', 'POST', input)
}

export function replyToThread(threadId: string, input: { authorId: string; body: string }): Promise<{ ok: boolean; error?: string; thread?: BoardThread }> {
  return call(`/api/crypto/office/board/${encodeURIComponent(threadId)}/reply`, 'POST', input)
}

export function resolveThread(threadId: string, resolved: boolean): Promise<{ ok: boolean; thread?: BoardThread }> {
  return call(`/api/crypto/office/board/${encodeURIComponent(threadId)}/resolve`, 'POST', { resolved })
}

// ── The Manager's File ─────────────────────────────────────────────────────
// Every outstanding question on the desk, in one queue. Item ids contain colons and are
// not path-safe on their own, so every call encodes the id.

export interface ManagerFileView {
  items: ManagerFileItem[]
  stats: { open: number; needsTriage: number; assigned: number; answered: number; closed: number }
  managerId: string | null
}

export async function fetchManagerFile(): Promise<ManagerFileView> {
  const d = await call<{ ok: boolean } & Partial<ManagerFileView>>('/api/crypto/office/manager-file', 'GET')
  return {
    items: d.items ?? [],
    stats: d.stats ?? { open: 0, needsTriage: 0, assigned: 0, answered: 0, closed: 0 },
    managerId: d.managerId ?? null
  }
}

function itemPath(id: string, action: string): string {
  return `/api/crypto/office/manager-file/${encodeURIComponent(id)}/${action}`
}

export function assignFileItem(id: string, to: string, instruction: string): Promise<{ ok: boolean; error?: string; item?: ManagerFileItem }> {
  return call(itemPath(id, 'assign'), 'POST', { to, instruction })
}

export function answerFileItem(id: string, answer: string): Promise<{ ok: boolean; error?: string; item?: ManagerFileItem }> {
  return call(itemPath(id, 'answer'), 'POST', { answer })
}

export function closeFileItem(id: string): Promise<{ ok: boolean; error?: string; item?: ManagerFileItem }> {
  return call(itemPath(id, 'close'), 'POST', {})
}
