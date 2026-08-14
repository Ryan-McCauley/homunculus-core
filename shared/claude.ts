// Live Claude sessions — shared between the server registry (server/claudeProcesses.ts)
// and the INTELLIGENCE tab's RUNNING view.

/** What kind of work a Claude session is doing. */
export type ClaudeKind =
  | 'agent'          // a fleet agent's scheduled or manual run
  | 'agent-chat'     // an operator chatting with an agent
  | 'agent-handoff'  // an agent writing its off-shift handoff note
  | 'skill'          // a strategy skill run (sniper, trapline, …)
  | 'core-chat'      // the Computer Core chat on the BRIDGE tab
  | 'proactive'      // the background proactive monitor

export interface ClaudeProcess {
  id: string
  kind: ClaudeKind
  /** Human name: "Desk Manager", "SNIPER", "Computer Core". */
  label: string
  /** One line on what it is doing — the trigger, or the prompt's subject. */
  detail: string
  /** Timeline/audit component id: 'agent:manager', 'skill:sniper', 'system'. */
  component: string
  model: string
  startedAt: number
  /** Present once a stop has been requested but the session has not yet exited. */
  stoppedBy?: string
}

export const CLAUDE_KIND_LABELS: Record<ClaudeKind, string> = {
  'agent': 'AGENT RUN',
  'agent-chat': 'AGENT CHAT',
  'agent-handoff': 'HANDOFF',
  'skill': 'STRATEGY',
  'core-chat': 'CORE CHAT',
  'proactive': 'MONITOR',
}

/** Sessions the operator should think twice about killing. */
export function isBackgroundKind(kind: ClaudeKind): boolean {
  return kind === 'proactive'
}
