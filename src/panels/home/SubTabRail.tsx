// The sub-tab rail under the DOMICILE OPERATIONS masthead.
//
// Reuses the app's own tab-chip language — corner-cut, Orbitron, holo glow — so
// it reads as native rather than as a widget bolted into the tab.

import { HOME_VIEWS, formatHomeRoute, type HomeRoute, type HomeView } from '../../../shared/homeRoute'
import { navAttrs } from './agentAttrs'

const LABELS: Record<HomeView, string> = {
  overview: 'OVERVIEW',
  sectors: 'SECTORS',
  devices: 'DEVICES',
  registry: 'REGISTRY',
  automata: 'AUTOMATA',
}

interface Props {
  route: HomeRoute
  counts: Partial<Record<HomeView, number>>
  onNavigate: (next: HomeRoute) => void
  onOpenUplink: () => void
  haVersion?: string | null
}

export function SubTabRail({ route, counts, onNavigate, onOpenUplink }: Props): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
      {HOME_VIEWS.map((view) => {
        const on = route.view === view
        const count = counts[view]
        return (
          <button
            key={view}
            type="button"
            onClick={() => onNavigate({ view })}
            aria-current={on ? 'page' : undefined}
            {...navAttrs(formatHomeRoute({ view }), `${LABELS[view]} sub-view${on ? ', selected' : ''}`)}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 11,
              letterSpacing: 3,
              padding: '6px 16px',
              cursor: 'pointer',
              color: on ? 'var(--holo)' : 'var(--holo-dim)',
              border: `1px solid ${on ? 'var(--border-holo)' : 'transparent'}`,
              borderBottom: 'none',
              background: on ? '#2effb00c' : 'transparent',
              clipPath: on ? 'polygon(8px 0,100% 0,100% 100%,0 100%,0 8px)' : undefined,
              textShadow: on ? '0 0 8px #2effb066' : undefined,
            }}
          >
            {LABELS[view]}
            {count != null && (
              <span style={{ color: 'var(--green-dim)', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 0, marginLeft: 6 }}>
                {count}
              </span>
            )}
          </button>
        )
      })}

      <button
        type="button"
        className="holo-btn"
        onClick={onOpenUplink}
        aria-label="Open the command uplink"
        data-agent-route={formatHomeRoute({ view: route.view, uplink: true })}
        style={{ marginLeft: 'auto', cursor: 'pointer' }}
      >
        ⌁ UPLINK <span style={{ fontSize: 10, color: 'var(--green-dim)', marginLeft: 4 }}>⌘K</span>
      </button>
    </div>
  )
}
