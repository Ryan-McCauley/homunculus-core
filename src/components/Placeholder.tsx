interface Props {
  label: string
  note?: string
  /** Roughly how tall the stub should be, in flex units. */
  flex?: number
}

/**
 * A "coming online" stub for panels we haven't wired yet (terminal, chat,
 * globe, etc.). Keeps the bridge layout complete while we build incrementally.
 */
export function Placeholder({ label, note = 'module offline', flex }: Props): JSX.Element {
  return (
    <section style={{ flex, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-label">
        <span>{label}</span>
        <span className="muted">standby</span>
      </div>
      <div
        className="card"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--green-dim)',
          fontSize: 10,
          letterSpacing: 1,
          minHeight: 60
        }}
      >
        ░ {note} ░
      </div>
    </section>
  )
}
