// Answering a colleague's question while they are still working.
//
// Until now a blocking question parked the asker until the answerer happened to wake on
// its own interval — which on this desk could be an hour, and during the 08-18 timeout
// streak was never. The asker's correct behaviour was to stand down and report that it
// was waiting, so a question between two agents cost at least two runs and usually a
// cycle of market time.
//
// Now raising a question at a colleague wakes that colleague immediately, ahead of the
// concurrency cap, to answer that one question and nothing else. The asker polls its own
// blocker for a few seconds and carries on with the answer in hand, so a run ends with an
// empty inbox rather than a parked question.
//
// The whole risk of that design is recursion: A asks B, B asks C, C asks A, and the desk
// wakes itself forever. Three bounds, all checked here:
//   - an agent already in the chain is never re-entered (cycle break)
//   - the chain may not grow past MAX_INLINE_DEPTH
//   - only a known, unbenched agent is ever woken, and never the human

/** How many agents deep one question may cascade before the desk stops obliging. */
export const MAX_INLINE_DEPTH = 3

export interface InlineAskContext {
  /** The agent raising the question. */
  askedBy: string
  /** Who they are asking — an agent id, or 'operator' for the human. */
  askedOf: string
  /** Agents already woken in this cascade, oldest first, including the original asker. */
  chain: string[]
  /** Every agent id on the desk. */
  knownAgents: string[]
  /** The answerer is suspended in their personnel file. */
  benched?: boolean
  /** The answerer's master switch. Present for symmetry — it deliberately does NOT block
   *  an inline answer (see below). */
  enabled?: boolean
}

export interface InlineAnswerVerdict {
  ok: boolean
  reason: string
}

export function canAnswerInline(ctx: InlineAskContext): InlineAnswerVerdict {
  if (ctx.askedOf === 'operator') {
    return { ok: false, reason: 'the operator is a human — the question waits for them' }
  }
  if (ctx.askedOf === ctx.askedBy) {
    return { ok: false, reason: 'an agent cannot answer its own question' }
  }
  if (!ctx.knownAgents.includes(ctx.askedOf)) {
    return { ok: false, reason: `unknown agent '${ctx.askedOf}' — nobody to wake` }
  }
  if (ctx.chain.includes(ctx.askedOf)) {
    return { ok: false, reason: `circular ask — @${ctx.askedOf} is already awake in this chain` }
  }
  if (ctx.chain.length >= MAX_INLINE_DEPTH) {
    return { ok: false, reason: `inline answer depth ${MAX_INLINE_DEPTH} reached — the question is filed for the next scheduled run` }
  }
  if (ctx.benched) {
    return { ok: false, reason: `@${ctx.askedOf} is benched — reinstate them first` }
  }
  // `enabled` is NOT checked. That dial governs an agent's own automatic triggers — whether
  // it goes looking for work. Being asked a direct question by a colleague is not the agent
  // acting on its own, and a disabled expert who still holds the answer should still give it.
  return { ok: true, reason: `waking @${ctx.askedOf} to answer` }
}

/** The chain to hand the next hop. Idempotent, and never mutates its argument. */
export function nextChain(chain: readonly string[], answerer: string): string[] {
  return chain.includes(answerer) ? [...chain] : [...chain, answerer]
}
