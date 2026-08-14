import { loadColor } from '../lib/format'

interface MeterProps {
  label: string
  /** 0-100 */
  percent: number
  /** Optional right-aligned value text; defaults to "NN%". */
  value?: string
}

/** A labelled horizontal utilization bar with severity coloring. */
export function Meter({ label, percent, value }: MeterProps): JSX.Element {
  const color = loadColor(percent)
  return (
    <div style={{ marginBottom: 7 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 8,
          color: 'var(--green-dim)',
          marginBottom: 3
        }}
      >
        <span>{label}</span>
        <span style={{ color: 'var(--green-soft)' }}>{value ?? `${Math.round(percent)}%`}</span>
      </div>
      <div
        style={{
          height: 5,
          background: 'var(--bg-meter)',
          borderRadius: 2,
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, Math.max(0, percent))}%`,
            background: color,
            boxShadow: `0 0 6px ${color}66`,
            transition: 'width 0.6s ease'
          }}
        />
      </div>
    </div>
  )
}
