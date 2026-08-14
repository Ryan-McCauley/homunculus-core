// The office floor, as a population rather than a grid of furniture.
//
// Everything here is pure: it turns the state the INTELLIGENCE tab already fetches —
// agent views, blockers, board threads — into the handful of little people the floor
// draws, and where they stand. No React, no DOM, no clocks of its own.
//
// The rule the whole module follows: a person on the floor is never decoration. Every
// pose, every walk across the room and every line between two desks corresponds to
// something the desk is actually doing. If we cannot name the signal, we do not draw it.

import type { AgentView } from '../../shared/agents'
import { type Blocker, OPERATOR_ID, suppresses } from '../../shared/blockers'
import type { BoardThread } from '../../shared/office'

// ── A · the seated crew ─────────────────────────────────────────────────────

/** What the little person at a desk is doing, and therefore how they are drawn.
 *
 *  'away' is the only pose with no body in the chair: that employee is standing at
 *  somebody else's desk waiting for an answer (see floorWalkers). */
export type DeskPose = 'type' | 'read' | 'write' | 'idle' | 'wait' | 'away' | 'off'

/** Working poses inferred from a live run's activity line. */
type WorkPose = 'type' | 'read' | 'write'

// Verb stems, not nouns: "reading the fee report" is reading, so 'report' must not vote
// for the writing pose. Writing is checked first — "writing a review" is writing.
const WRITE_STEMS = ['writ', 'draft', 'compos', 'summar', 'journal', 'author', 'record']
const READ_STEMS = ['read', 'scan', 'review', 'fetch', 'load', 'inspect', 'check', 'look', 'pull']

/** Maps a run's free-text activity line onto a posture. Unrecognized work is typing —
 *  the honest default, since a live run is definitely at the keyboard. */
export function activityPose(activity: string): WorkPose {
  const s = (activity || '').toLowerCase()
  if (WRITE_STEMS.some((k) => s.includes(k))) return 'write'
  if (READ_STEMS.some((k) => s.includes(k))) return 'read'
  return 'type'
}

export interface FloorContext {
  /** Agent ids that actually have a desk rendered on this floor. A colleague with no
   *  desk cannot be walked to and cannot be drawn a line to. */
  floorIds?: string[]
}

/** The oldest open blocking question an agent holds — what it is really stuck on. */
function stuckOn(blockers: Blocker[] | undefined): Blocker | null {
  const open = (blockers ?? []).filter(suppresses)
  if (open.length === 0) return null
  return open.reduce((a, b) => (b.createdAt < a.createdAt ? b : a))
}

/** How to draw the person at one desk.
 *
 *  Order matters. A live run outranks everything: if the desk is running, somebody is
 *  sitting at it, even when the agent is disabled (a manual RUN) or holds an open
 *  question. Only then do we ask whether they are away, waiting, or off duty. */
export function deskPose(view: AgentView, ctx: FloorContext = {}): DeskPose {
  const status = view.status
  if (status && status.state === 'running') return activityPose(status.activity)
  if (!view.agent.enabled) return 'off'

  const stuck = stuckOn(view.blockers)
  if (stuck) {
    const floorIds = ctx.floorIds ?? []
    const reachable = stuck.askedOf !== OPERATOR_ID
      && stuck.askedOf !== view.agent.id
      && floorIds.includes(stuck.askedOf)
    // Asked a colleague who is here → they get up and go ask. Asked you, or asked
    // somebody with no desk → they can only sit and wait.
    return reachable ? 'away' : 'wait'
  }
  return 'idle'
}

const POSE_HINTS: Record<DeskPose, string> = {
  type: 'at the keyboard',
  read: 'reading',
  write: 'writing',
  idle: 'on call',
  wait: 'waiting on an answer',
  away: 'away from desk — asking a colleague',
  off: 'off duty',
}

export function poseHint(pose: DeskPose): string {
  return POSE_HINTS[pose]
}

// ── B · speech threads ──────────────────────────────────────────────────────

/** How long after a message we still draw it as a live exchange on the floor. Long
 *  enough to catch it on the next poll, short enough that the floor goes quiet. */
export const CONVERSATION_WINDOW_MS = 15 * 60 * 1000

/** Lines drawn across the floor at once. Past this it stops reading as conversation
 *  and starts reading as string art. */
export const MAX_FLOOR_CONVERSATIONS = 4

const MAX_EXCERPT = 48

export interface FloorConversation {
  /** `${threadId}:${messageId}:${toId}` — stable across polls, so a bubble does not
   *  restart its animation every time the floor refreshes. The target is part of the key
   *  because one message tagging four colleagues draws four separate lines, and without
   *  it they would all claim the same React key. */
  id: string
  threadId: string
  fromId: string
  toId: string
  text: string
  at: number
  /** An answer is a reply to somebody who tagged you first; anything else is a question. */
  kind: 'question' | 'answer'
}

function excerpt(body: string): string {
  const s = (body || '').replace(/\s+/g, ' ').trim()
  return s.length > MAX_EXCERPT ? `${s.slice(0, MAX_EXCERPT - 1)}…` : s
}

export interface ConversationOptions extends FloorContext {
  now?: number
  windowMs?: number
  limit?: number
}

/** Recent @mentions between two desks that both exist on this floor, newest first.
 *
 *  Resolved threads are skipped — a settled conversation is not still happening — as
 *  are messages from anyone without a desk (the operator posts from outside the room). */
export function floorConversations(threads: BoardThread[], opts: ConversationOptions = {}): FloorConversation[] {
  const now = opts.now ?? Date.now()
  const windowMs = opts.windowMs ?? CONVERSATION_WINDOW_MS
  const limit = opts.limit ?? MAX_FLOOR_CONVERSATIONS
  const floorIds = opts.floorIds ?? []

  const out: FloorConversation[] = []
  for (const t of threads) {
    if (t.resolved) continue
    const messages = t.messages ?? []
    messages.forEach((m, i) => {
      if (now - m.at >= windowMs) return
      if (!floorIds.includes(m.authorId)) return
      for (const to of m.mentions ?? []) {
        if (to === m.authorId || !floorIds.includes(to)) continue
        // Did the person being tagged tag *us* earlier in this thread? Then this is a
        // reply, not a fresh ask — and the floor draws it in the answering colour.
        const answering = messages.slice(0, i).some(
          (p) => p.authorId === to && (p.mentions ?? []).includes(m.authorId))
        out.push({
          id: `${t.id}:${m.id}:${to}`,
          threadId: t.id,
          fromId: m.authorId,
          toId: to,
          text: excerpt(m.body),
          at: m.at,
          kind: answering ? 'answer' : 'question',
        })
      }
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}

// ── C · the walker ──────────────────────────────────────────────────────────

export interface FloorWalker {
  blockerId: string
  /** The stuck employee, who has left their desk. */
  fromId: string
  /** Whose desk they are standing at. */
  toId: string
  question: string
  since: number
  /** Position in the queue at that desk — 0 is at the front. */
  queueIndex: number
}

/** Who is standing at somebody else's desk waiting for an answer.
 *
 *  Only a blocking, still-open question moves an employee: a 'waiting' one explicitly
 *  means they can keep working, and an answered one means they already went home. One
 *  walker per employee — the oldest question is the one they are actually stuck on. */
export function floorWalkers(blockers: Blocker[], opts: FloorContext = {}): FloorWalker[] {
  const floorIds = opts.floorIds ?? []

  const eligible = blockers.filter((b) =>
    suppresses(b)
    && b.askedOf !== OPERATOR_ID
    && b.agentId !== b.askedOf
    && floorIds.includes(b.agentId)
    && floorIds.includes(b.askedOf))

  // One petitioner per employee: the question they have been stuck on longest.
  const oldestPerAgent = new Map<string, Blocker>()
  for (const b of eligible) {
    const held = oldestPerAgent.get(b.agentId)
    if (!held || b.createdAt < held.createdAt) oldestPerAgent.set(b.agentId, b)
  }

  const queued = new Map<string, number>()
  return [...oldestPerAgent.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((b) => {
      const n = queued.get(b.askedOf) ?? 0
      queued.set(b.askedOf, n + 1)
      return {
        blockerId: b.id,
        fromId: b.agentId,
        toId: b.askedOf,
        question: b.question,
        since: b.createdAt,
        queueIndex: n,
      }
    })
}

// ── D · the corkboard ───────────────────────────────────────────────────────

/** How warm a pinned slip looks: touched within the hour, today, or going yellow. */
export type SlipTone = 'fresh' | 'open' | 'stale'

export interface BoardSlip {
  threadId: string
  title: string
  authorId: string
  at: number
  tone: SlipTone
  replies: number
}

const HOUR_MS = 3_600_000
const DEFAULT_PINS = 6

export function corkboardSlips(
  threads: BoardThread[],
  opts: { now?: number; limit?: number } = {}
): BoardSlip[] {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? DEFAULT_PINS
  return threads
    .filter((t) => !t.resolved)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((t) => {
      const age = now - t.updatedAt
      const tone: SlipTone = age < HOUR_MS ? 'fresh' : age < 24 * HOUR_MS ? 'open' : 'stale'
      return {
        threadId: t.id,
        title: t.title,
        authorId: t.authorId,
        at: t.updatedAt,
        tone,
        replies: Math.max(0, (t.messages ?? []).length - 1),
      }
    })
}

// ── geometry ────────────────────────────────────────────────────────────────
//
// The overlay that carries bubbles and walkers is one SVG stretched over the desk
// grid, so every desk has to be reduced to a single point in that SVG's coordinates.

export interface Pt { x: number; y: number }

/** Rect shape shared with DOMRect, so a measured element can be passed straight in. */
export interface RectLike { left: number; top: number; width: number; height: number }

/** The point on a desk that people relate to: the chair — horizontally centred, at the
 *  desk's floor line. Returned in coordinates local to the overlay container. */
export function deskAnchor(rect: RectLike, container: { left: number; top: number }): Pt {
  return {
    x: rect.left - container.left + rect.width / 2,
    y: rect.top - container.top + rect.height,
  }
}

/** The point speech comes from: the same column as the chair, but at the top edge of
 *  the desk tile — so a bubble and the arc leaving it clear the tile instead of landing
 *  on the desk's own status line. */
export function deskTopAnchor(rect: RectLike, container: { left: number; top: number }): Pt {
  return {
    x: rect.left - container.left + rect.width / 2,
    y: rect.top - container.top,
  }
}

/** A quadratic arc between two desks, lifted clear of the higher one so the line never
 *  cuts through furniture. Rounded to whole pixels. */
export function arcPath(a: Pt, b: Pt, lift = 40): string {
  const r = Math.round
  const mx = r((a.x + b.x) / 2)
  const my = r(Math.min(a.y, b.y) - lift)
  return `M${r(a.x)},${r(a.y)} Q${mx},${my} ${r(b.x)},${r(b.y)}`
}

/** Where a petitioner stands relative to the desk they are visiting: just off the left
 *  edge, with anyone behind them lined up further back. */
export const WALKER_GAP = 44
export const WALKER_QUEUE_STEP = 18

export function walkerStop(target: Pt, queueIndex = 0): Pt {
  return { x: target.x - WALKER_GAP - queueIndex * WALKER_QUEUE_STEP, y: target.y }
}
