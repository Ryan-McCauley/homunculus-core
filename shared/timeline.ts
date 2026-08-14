// The activity timeline: what ran, when, and what called what.
//
// Two different questions, answered from two different sources:
//
//   "what ran"      → agent_runs, a durable record of every agent and skill run
//   "what called X" → audit_log, which already records actor + resource per write
//
// The audit log turned out to be exactly the right substrate for the arrows: it
// was built to answer "who changed this", and "who called whom" is the same
// question read edge-first instead of node-first.

/** A component is anything that can act: an agent, a skill, or the server itself. */
export type ComponentKind = 'agent' | 'skill' | 'system' | 'operator' | 'service'

export interface TimelineComponent {
  /** Stable id, e.g. 'agent:manager', 'skill:sniper', 'trade-engine'. */
  id: string
  kind: ComponentKind
  label: string
}

export type RunState = 'running' | 'done' | 'error'

/** One execution with a duration — drawn as a bar in its component's lane. */
export interface TimelineRun {
  id: string
  component: string
  label: string
  trigger: string
  startedAt: number
  /** null while still running. */
  endedAt: number | null
  state: RunState
  summary: string
}

/** A moment rather than a span — an alert firing, a plan auto-executing. */
export interface TimelineEvent {
  at: number
  component: string
  action: string
  summary: string
}

/** One component acting on another, at a moment. Drawn as an arrow between lanes. */
export interface TimelineEdge {
  at: number
  from: string
  to: string
  action: string
  summary: string
}

export interface TimelinePayload {
  since: number
  until: number
  components: TimelineComponent[]
  runs: TimelineRun[]
  events: TimelineEvent[]
  edges: TimelineEdge[]
}

/** Selectable rolling windows. */
export const TIMELINE_WINDOWS = [
  { key: '24h', label: '24H', ms: 24 * 60 * 60_000 },
  { key: '7d', label: '7D', ms: 7 * 24 * 60 * 60_000 },
  { key: '30d', label: '30D', ms: 30 * 24 * 60 * 60_000 },
] as const

export type TimelineWindowKey = typeof TIMELINE_WINDOWS[number]['key']

/** Services an actor can call. Ids are stable so lanes keep their identity. */
export const SERVICES: Record<string, string> = {
  'trade-engine': 'TRADE ENGINE',
  'office': 'OFFICE',
  'fleet': 'FLEET ADMIN',
  'strategy-config': 'STRATEGY CONFIG',
  'alerts': 'ALERTS',
  'reports': 'REPORTS',
  'library': 'LIBRARY',
  'audit': 'AUDIT',
}

/**
 * Which service an API path belongs to.
 *
 * Ordered longest-prefix-first where it matters: `/api/crypto/strategy/settings`
 * is configuration, while `/api/crypto/strategy/run` starts a run and belongs to
 * the fleet's side of the house. Returns null for paths that are nobody's call —
 * snapshot polling and other reads that would only add noise to the graph.
 */
export function serviceForPath(path: string): string | null {
  if (path.startsWith('/api/crypto/office/library')) return 'library'
  if (path.startsWith('/api/crypto/office')) return 'office'
  if (path.startsWith('/api/crypto/agents')) return 'fleet'
  if (path.startsWith('/api/crypto/alerts')) return 'alerts'
  if (path.startsWith('/api/crypto/plan-report')) return 'reports'
  if (path.startsWith('/api/audit')) return 'audit'
  if (path.startsWith('/api/crypto/strategy/settings') || path.startsWith('/api/crypto/strategy/create')) return 'strategy-config'
  if (path.startsWith('/api/crypto/strategy')) return 'fleet'
  if (
    path.startsWith('/api/crypto/stage') || path.startsWith('/api/crypto/trade') ||
    path.startsWith('/api/crypto/order') || path.startsWith('/api/crypto/position') ||
    path.startsWith('/api/crypto/bracket') || path.startsWith('/api/crypto/autoplan') ||
    path.startsWith('/api/crypto/cost-basis') || path.startsWith('/api/crypto/auto-execute')
  ) return 'trade-engine'
  return null
}

/**
 * Turns one audit entry into a call edge, or null if it is not a call.
 *
 * `origin: 'http'` entries carry the caller in `actor` and the callee in the
 * route path. The richer internal entries name their own relationship: an agent
 * proposing a trade is the fleet gate calling the trade engine, and an alert
 * auto-staging is the alert store doing the same thing without a human.
 */
export function edgeForAudit(e: {
  ts: string; actor: string; origin: string; action: string; resource: string; summary: string
  meta?: Record<string, unknown> | null
}): TimelineEdge | null {
  const at = Date.parse(e.ts)
  if (!Number.isFinite(at)) return null

  if (e.action.startsWith('agent.trade.')) {
    return { at, from: e.actor, to: 'trade-engine', action: e.action, summary: e.summary }
  }
  if (e.action === 'alert.wake' || e.action === 'alert.wake.refused') {
    // resource is `agent:<id>` — the alert is the caller, the agent the callee.
    return { at, from: 'alerts', to: e.resource, action: e.action, summary: e.summary }
  }
  if (e.action.startsWith('alert.')) {
    // Arming, disarming and deleting an alert: the actor acting on the alert store.
    if (e.action === 'alert.create' || e.action === 'alert.remove' || e.action === 'alert.arm') {
      return { at, from: e.actor, to: 'alerts', action: e.action, summary: e.summary }
    }
  }
  if (e.action === 'alert.fired.autostage') {
    return { at, from: 'alerts', to: 'trade-engine', action: e.action, summary: e.summary }
  }
  if (e.action === 'plan.autoexecute') {
    return { at, from: 'system', to: 'trade-engine', action: e.action, summary: e.summary }
  }
  if (e.action.startsWith('strategy.settings.') || e.action === 'strategy.create') {
    return { at, from: e.actor, to: 'strategy-config', action: e.action, summary: e.summary }
  }
  if (e.action.startsWith('office.personnel.')) {
    return { at, from: e.actor, to: 'office', action: e.action, summary: e.summary }
  }
  if (e.origin === 'http' && e.action.startsWith('http.')) {
    const to = serviceForPath(e.resource)
    if (!to) return null
    // A GET-shaped read never reaches here (only mutations are audited), so every
    // remaining edge is something that actually changed state.
    return { at, from: e.actor, to, action: e.action, summary: e.summary }
  }
  return null
}

/** Display label for a component id. */
export function componentLabel(id: string, names: Record<string, string> = {}): string {
  if (names[id]) return names[id]!
  if (SERVICES[id]) return SERVICES[id]!
  if (id.startsWith('agent:')) return id.slice(6).toUpperCase()
  if (id.startsWith('skill:')) return id.slice(6).toUpperCase()
  return id.toUpperCase()
}

export function componentKind(id: string): ComponentKind {
  if (id.startsWith('agent:')) return 'agent'
  if (id.startsWith('skill:')) return 'skill'
  if (id === 'operator') return 'operator'
  if (id === 'system') return 'system'
  return 'service'
}
