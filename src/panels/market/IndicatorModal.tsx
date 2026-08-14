// Indicator picker for the focused chart. Checkbox list grouped into overlays
// (drawn on the price pane) and panes (their own strip below), plus presets.
// Selection is per-symbol, so BTC can run SWING while SOL runs SCALP.

import { INDICATORS, INDICATOR_PRESETS } from '../../lib/marketPrefs'
import type { IndicatorId } from '../../lib/marketPrefs'
import { G, GD, BORDER, MONO, Lbl } from '../../lib/cryptoUi'

export function IndicatorModal({ symbol, active, onToggle, onPreset, onClose }: {
  symbol: string
  active: IndicatorId[]
  onToggle: (id: IndicatorId) => void
  onPreset: (ids: IndicatorId[]) => void
  onClose: () => void
}) {
  const overlays = INDICATORS.filter((m) => m.kind === 'overlay')
  const panes = INDICATORS.filter((m) => m.kind === 'pane')

  const Row = ({ id, label, hint }: { id: IndicatorId; label: string; hint: string }) => {
    const on = active.includes(id)
    return (
      <div onClick={() => onToggle(id)} title={hint} style={{
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 6px',
        cursor: 'pointer', background: on ? 'var(--bg-elev)' : 'transparent',
      }}>
        <span style={{ ...MONO, fontSize: 12, color: on ? G : GD }}>{on ? '▣' : '☐'}</span>
        <span style={{ ...MONO, fontSize: 12, color: on ? 'var(--green-soft)' : GD, whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ ...MONO, fontSize: 10, color: GD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>
      </div>
    )
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 40, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'color-mix(in srgb, var(--bg) 72%, transparent)',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 620, maxHeight: '86%', overflowY: 'auto', background: 'var(--bg-panel)',
        border: `1px solid ${G}`, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: BORDER, position: 'sticky', top: 0, background: 'var(--bg-panel)' }}>
          <span style={{ ...MONO, fontSize: 13, color: G, letterSpacing: 2 }}>INDICATORS · {symbol.replace(/USD$/, '')}</span>
          <Lbl>{active.length} ACTIVE</Lbl>
          <div style={{ flex: 1 }} />
          <span onClick={onClose} style={{ ...MONO, fontSize: 14, color: GD, cursor: 'pointer' }}>✕</span>
        </div>

        <div style={{ padding: '6px 14px 10px' }}>
          <div style={{ margin: '8px 0 3px' }}><Lbl c={G} size={10}>OVERLAYS · ON THE CANDLES</Lbl></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
            {overlays.map((m) => <Row key={m.id} id={m.id} label={m.label} hint={m.hint} />)}
          </div>
          <div style={{ margin: '12px 0 3px' }}><Lbl c={G} size={10}>PANES · BELOW THE CHART</Lbl></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
            {panes.map((m) => <Row key={m.id} id={m.id} label={m.label} hint={m.hint} />)}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderTop: BORDER, position: 'sticky', bottom: 0, background: 'var(--bg-panel)' }}>
          <Lbl size={10}>PRESETS</Lbl>
          {INDICATOR_PRESETS.map((p) => (
            <button key={p.id} onClick={() => onPreset(p.ids)} style={{
              ...MONO, fontSize: 10, letterSpacing: 1, padding: '3px 10px',
              background: 'transparent', border: `0.5px dashed var(--border-strong)`, color: GD, cursor: 'pointer',
            }}>{p.label}</button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{
            ...MONO, fontSize: 11, letterSpacing: 2, padding: '5px 18px',
            background: G, border: 'none', color: 'var(--bg)', cursor: 'pointer',
          }}>DONE</button>
        </div>
      </div>
    </div>
  )
}
