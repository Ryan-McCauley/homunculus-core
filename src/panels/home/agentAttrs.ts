// Machine-interface attributes for interactive controls.
//
// Two of the six conventions live here. `data-agent-id` gives every actionable a
// stable address derived from entity identity and verb — never from position — so
// an agent's grip on a control survives a layout edit, a reorder, or a relabel.
// `aria-label` states what the control does and what state it is in, in words,
// which is what a model reading the DOM or a screenshot needs and what a screen
// reader needed anyway.

import type { GuardrailTier } from '../../../shared/agentManifest'

export interface AgentAttrs {
  'data-agent-id': string
  'data-agent-tier'?: GuardrailTier
  'aria-label': string
}

/** Attributes for a control that maps to a manifest action. */
export function agentAttrs(actionId: string, label: string, tier?: GuardrailTier): AgentAttrs {
  return {
    'data-agent-id': actionId,
    ...(tier ? { 'data-agent-tier': tier } : {}),
    'aria-label': label,
  }
}

/** Attributes for navigation — routes are addressable too. */
export function navAttrs(route: string, label: string): { 'data-agent-route': string; 'aria-label': string } {
  return { 'data-agent-route': route, 'aria-label': label }
}
