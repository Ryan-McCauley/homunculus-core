// How the desks are arranged on the floor.
//
// By default the floor is laid out the way the company is: desks cluster into department
// pods, executive first, so the shape of the org is the shape of the room. The operator
// can then drag a desk anywhere — into another pod, or to a different seat within one —
// and that arrangement sticks.
//
// A dragged desk does NOT change the employee's HR record. Where somebody sits and what
// department they are on the books for are different facts, and personnel.department
// stays the single source of truth for the latter; this module only remembers seating.
// That is why the arrangement lives in localStorage: it is a view preference, and losing
// it costs a re-drag, not a payroll error.

import { DEPARTMENTS, type Department } from '../../shared/office'

const KEY = 'homunculus.crypto.office.layout'

/** Pods run top-down like an org chart rather than alphabetically. */
export const DEPARTMENT_ORDER: Department[] = ['executive', 'trading', 'research', 'risk', 'operations']

const DEPARTMENT_LABELS: Record<Department, string> = {
  executive: 'EXECUTIVE',
  trading: 'TRADING FLOOR',
  research: 'RESEARCH',
  risk: 'RISK',
  operations: 'OPERATIONS',
}

export function departmentLabel(d: Department): string {
  return DEPARTMENT_LABELS[d] ?? String(d).toUpperCase()
}

/** Where a desk with no department on file ends up. Somebody has to own the floor. */
const FALLBACK_DEPARTMENT: Department = 'operations'

function isDepartment(v: unknown): v is Department {
  return typeof v === 'string' && (DEPARTMENTS as string[]).includes(v)
}

export interface DeskLayout {
  /** agentId → the pod the operator dragged it into. Overrides the HR record. */
  pod: Record<string, Department>
  /** Seating order. Desks absent from this list keep their natural order behind it. */
  order: string[]
}

export const EMPTY_DESK_LAYOUT: DeskLayout = { pod: {}, order: [] }

/** Which pod a desk sits in: where the operator put it, else where HR says it belongs,
 *  else operations. An override naming a department this build has never heard of is
 *  ignored rather than honoured — a stale localStorage entry should not hide a desk. */
export function deskDepartment(
  id: string,
  hrDepartment: Department | undefined,
  layout: DeskLayout
): Department {
  const override = layout.pod[id]
  if (isDepartment(override)) return override
  if (isDepartment(hrDepartment)) return hrDepartment
  return FALLBACK_DEPARTMENT
}

export interface DeskInput { id: string; department?: Department }

export interface DeskPod { department: Department; deskIds: string[] }

/** The arranged order for a set of desks: the operator's sequence first, then anyone
 *  they have never dragged, in the order they arrived. */
function arrange(ids: string[], order: string[]): string[] {
  const present = new Set(ids)
  const arranged = order.filter((id) => present.has(id))
  const seen = new Set(arranged)
  return [...arranged, ...ids.filter((id) => !seen.has(id))]
}

/** The floor, pod by pod. Every department is returned even when empty: an empty pod is
 *  still a place you can drop a desk, and the UI needs somewhere to put it. */
export function groupDesks(desks: DeskInput[], layout: DeskLayout): DeskPod[] {
  const buckets = new Map<Department, string[]>(DEPARTMENT_ORDER.map((d) => [d, []]))
  for (const d of desks) {
    const dept = deskDepartment(d.id, d.department, layout)
    buckets.get(dept)?.push(d.id)
  }
  return DEPARTMENT_ORDER.map((department) => ({
    department,
    deskIds: arrange(buckets.get(department) ?? [], layout.order),
  }))
}

export interface MoveDeskArgs {
  id: string
  department: Department
  /** Desk to drop in front of. null/undefined = the back of the pod. */
  beforeId?: string | null
  /** Every desk currently on the floor, in display order — so desks the operator has
   *  never dragged keep their relative places instead of being shuffled. */
  allIds: string[]
}

/** Seat a desk in a pod. Returns a new layout; the one passed in is left alone. */
export function moveDesk(layout: DeskLayout, args: MoveDeskArgs): DeskLayout {
  const { id, department, beforeId = null, allIds } = args
  // Dropped on itself: the operator changed their mind mid-drag. Nothing moved.
  if (beforeId === id) return layout

  const without = arrange(allIds, layout.order).filter((x) => x !== id)
  const at = beforeId ? without.indexOf(beforeId) : -1
  const order = at >= 0
    ? [...without.slice(0, at), id, ...without.slice(at)]
    : [...without, id]

  return { pod: { ...layout.pod, [id]: department }, order }
}

/** Rebuilds an arrangement from whatever was in storage, discarding anything that would
 *  not round-trip: a department that no longer exists, an order entry that is not an id. */
export function normalizeDeskLayout(raw: unknown): DeskLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { pod: {}, order: [] }
  const r = raw as { pod?: unknown; order?: unknown }

  const pod: Record<string, Department> = {}
  if (r.pod && typeof r.pod === 'object' && !Array.isArray(r.pod)) {
    for (const [id, dept] of Object.entries(r.pod as Record<string, unknown>)) {
      if (isDepartment(dept)) pod[id] = dept
    }
  }
  const order = Array.isArray(r.order)
    ? r.order.filter((x): x is string => typeof x === 'string')
    : []

  return { pod, order }
}

export function loadDeskLayout(): DeskLayout {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? normalizeDeskLayout(JSON.parse(raw)) : { pod: {}, order: [] }
  } catch {
    return { pod: {}, order: [] }
  }
}

export function saveDeskLayout(layout: DeskLayout): void {
  try { localStorage.setItem(KEY, JSON.stringify(layout)) } catch { /* seating is disposable */ }
}
