// One place that decides whether an Agent SDK run actually did anything.
//
// WHY THIS EXISTS. The SDK's terminal `result` message is not a reliable success
// signal on its own. When the CLI cannot resolve the prompt — the usual cause being
// a slash command that does not exist in `cwd` (the strategy skills live in
// `.claude/`, which is gitignored, so a fresh clone has none of them) — it answers:
//
//   { type: 'result', subtype: 'success', is_error: false, num_turns: 0,
//     result: 'Unknown command: /sniper' }
//
// `subtype === 'success'` and `is_error === false`, so the obvious check passes and
// every caller reported a completed run that had in fact burned 78ms and done
// nothing. Autorun did the same on every tick, silently. Treat a zero-turn run that
// reports an unknown command as the failure it is.

/** The fields of the SDK's `result` message this guard reads. */
export interface ClaudeResultLike {
  subtype: string
  is_error?: boolean
  num_turns?: number
  result?: unknown
}

/**
 * Returns a human-readable error when the run failed, or null when it genuinely
 * succeeded. Callers throw on a non-null return.
 */
export function claudeResultError(message: ClaudeResultLike): string | null {
  const detail = typeof message.result === 'string' && message.result ? message.result : message.subtype

  if (message.subtype !== 'success' || message.is_error) return String(detail)

  // The no-op cases the SDK dresses up as success. A real run always takes turns.
  if (typeof message.result === 'string' && /^\s*Unknown command:/i.test(message.result)) {
    return `${message.result.trim()} — the skill is missing from this checkout. The strategy commands live in .claude/, which is gitignored, so a fresh clone has none of them.`
  }
  if (message.num_turns === 0) {
    return `Claude ended the run without taking a turn: ${String(detail)}`
  }

  return null
}
