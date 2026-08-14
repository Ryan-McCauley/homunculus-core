import { useToasts } from '../lib/toasts'
import type { Toast } from '../lib/toasts'

const SEVERITY_COLOR = {
  info: '#2effb0',
  warn: '#f5a623',
  alert: '#e0245e',
}

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: () => void }): JSX.Element {
  const color = SEVERITY_COLOR[t.severity]
  return (
    <div
      className="toast-enter"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        background: '#050e0acc',
        border: `0.5px solid ${color}55`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 4,
        padding: '9px 12px',
        boxShadow: `0 0 18px ${color}22, inset 0 0 12px ${color}08`,
        backdropFilter: 'blur(6px)',
        minWidth: 280,
        maxWidth: 380,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* scan line */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
        opacity: 0.6,
      }} />

      {t.icon && (
        <i className={`ti ${t.icon}`} style={{ color, fontSize: 16, marginTop: 1, flexShrink: 0 }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 10,
          letterSpacing: 2,
          color,
          textShadow: `0 0 8px ${color}66`,
        }}>
          {t.message}
        </div>
        {t.sub && (
          <div style={{ fontSize: 9, letterSpacing: 1, color: '#2f8b6a', marginTop: 3 }}>
            {t.sub}
          </div>
        )}
      </div>

      <button
        onClick={onDismiss}
        style={{
          background: 'none',
          border: 'none',
          color: '#2f8b6a',
          cursor: 'pointer',
          fontSize: 12,
          padding: '0 0 0 6px',
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        <i className="ti ti-x" />
      </button>
    </div>
  )
}

export function ToastOverlay(): JSX.Element {
  const { toasts, dismiss } = useToasts()
  if (toasts.length === 0) return <></>
  return (
    <div
      style={{
        position: 'fixed',
        top: 80,
        right: 16,
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <ToastItem t={t} onDismiss={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  )
}
