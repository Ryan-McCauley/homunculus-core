// Reading one pipeline stage's output as the next stage's trigger.
//
// The TRAPLINE pipeline hands off through the message board: the Scout opens a thread
// tagged 'trapline-run' whose body is one fenced JSON block, and the Setter reads "the
// newest thread tagged trapline-run". Two things went wrong with that.
//
//   1. WRONG THREAD. listThreads() sorts by updatedAt, and the Steward also posts under
//      that tag — so a tend post could shadow the scan and the Setter would stand down
//      reporting "no fresh scan" while the scan sat one thread down. Selection here is by
//      AUTHOR and by createdAt: the stage that produced the work, and when it produced it.
//
//   2. WRONG CLOCK. The Scout writes its own idea of UTC into the title and body (one run
//      at 15:47 titled its cycle 23:11), and the Setter then burned turns every run
//      reconciling body time against the server epoch. Freshness here reads createdAt
//      only — the one timestamp nothing can hallucinate.
//
// The handoff also carries a work count, which is what stops the downstream stage waking
// for a zero-candidate cycle. Unknown work counts wake it: a garbled post is a reason to
// look, not a reason to skip.

import type { BoardThread } from './office'

/** The fenced JSON block a pipeline stage posts. */
export interface StagePost {
  stage: string | null
  at: string | null
  /** Items handed downstream. null when the post did not say — treat as "look anyway". */
  work: number | null
  body: Record<string, unknown>
}

const FENCE = /```(?:[a-zA-Z]*)\r?\n([\s\S]*?)```/g

/** Pulls the first fenced block that parses as a JSON object. */
export function parseStagePost(body: string): StagePost | null {
  if (typeof body !== 'string') return null
  FENCE.lastIndex = 0
  for (let m = FENCE.exec(body); m; m = FENCE.exec(body)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[1])
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const obj = parsed as Record<string, unknown>
    return {
      stage: typeof obj.stage === 'string' ? obj.stage : null,
      at: typeof obj.at === 'string' ? obj.at : null,
      work: workCount(obj),
      body: obj
    }
  }
  return null
}

/** An explicit count wins; otherwise the candidate list; otherwise unknown. */
function workCount(obj: Record<string, unknown>): number | null {
  if (typeof obj.work === 'number' && Number.isFinite(obj.work)) return obj.work
  if (Array.isArray(obj.candidates)) return obj.candidates.length
  return null
}

export interface StageSelector {
  /** The upstream stage's agent id. */
  authorId: string
  tag: string
}

/** The newest thread this author opened under this tag, by creation time. */
export function newestStageThread(threads: readonly BoardThread[], sel: StageSelector): BoardThread | null {
  let best: BoardThread | null = null
  for (const t of threads) {
    if (t.authorId !== sel.authorId) continue
    if (!t.tags.includes(sel.tag)) continue
    if (!best || t.createdAt > best.createdAt) best = t
  }
  return best
}

export interface StagePostOptions {
  /** The upstream stage's agent id. */
  authorId: string
  /** Older than this and the prices behind it are not worth acting on. */
  maxAgeMs: number
  now: number
}

export interface FoundStagePost extends StagePost {
  /** Board-recorded time of the message — the honest one. Deliberately NOT called `at`:
   *  StagePost.at is whatever the agent wrote inside its own JSON block, and conflating
   *  the two is exactly the confusion this module exists to remove. */
  postedAt: number
  messageId: string
}

/**
 * The newest stage post the named upstream agent left on a thread, within the freshness
 * window. This is the single-board form of the same selection newestStageThread does
 * across threads, and it exists for the same reason: with the whole desk replying to one
 * board, "the newest post" is a downstream tend report far more often than it is the scan
 * the next stage is looking for.
 *
 * Returns null for a missing or stale post. A zero-candidate scan is NOT null — present
 * and empty is a different fact from absent, and the caller must be able to tell them
 * apart.
 */
export function newestStagePost(thread: BoardThread, opts: StagePostOptions): FoundStagePost | null {
  let best: FoundStagePost | null = null
  for (const m of thread.messages) {
    if (m.authorId !== opts.authorId) continue
    if (opts.now - m.at > opts.maxAgeMs) continue
    const post = parseStagePost(m.body)
    if (!post) continue
    if (!best || m.at > best.postedAt) best = { ...post, postedAt: m.at, messageId: m.id }
  }
  return best
}

export interface HandoffOptions extends StageSelector {
  /** Only hand off posts created after this epoch ms — normally the downstream stage's
   *  last automatic run, so one post wakes it exactly once. */
  since: number
  /** Older than this and the prices behind it are not worth acting on. */
  maxAgeMs: number
  now: number
}

export interface Handoff {
  threadId: string
  /** createdAt of the thread — the honest timestamp, not the one in the body. */
  at: number
  work: number | null
  post: StagePost | null
}

/** Work published upstream that the downstream stage has not been woken for yet. */
export function handoffDue(threads: readonly BoardThread[], opts: HandoffOptions): Handoff | null {
  const thread = newestStageThread(threads, opts)
  if (!thread) return null
  if (thread.createdAt <= opts.since) return null
  if (opts.now - thread.createdAt > opts.maxAgeMs) return null

  // The opening message is the stage's post; replies belong to downstream stages.
  const opening = thread.messages.find((m) => m.authorId === opts.authorId) ?? thread.messages[0]
  const post = opening ? parseStagePost(opening.body) : null
  const work = post ? post.work : null
  if (work !== null && work <= 0) return null
  return { threadId: thread.id, at: thread.createdAt, work, post }
}
