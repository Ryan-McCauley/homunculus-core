import type { TelemetrySnapshot } from '../../shared/telemetry'
import { Meter } from '../components/Meter'
import { bytes, sparkline } from '../lib/format'

interface Props {
  data: TelemetrySnapshot | null
}

/** Left column: CPU cores, memory, sensors, and top processes. */
export function SystemVitals({ data }: Props): JSX.Element {
  const cores = data?.cpu.cores ?? []
  const mem = data?.memory
  const cpu = data?.cpu

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11, height: '100%' }}>
      {/* CPU cores */}
      <section>
        <div className="panel-label">
          <span>CPU Cores</span>
          <span className="muted">
            {cores.length || '—'} · {cpu?.speedGHz ? `${cpu.speedGHz.toFixed(1)}GHz` : '—'}
          </span>
        </div>
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {cores.slice(0, 8).map((c) => (
              <div key={c.id}>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--green-dim)',
                    display: 'flex',
                    justifyContent: 'space-between'
                  }}
                >
                  <span>C{c.id}</span>
                  <span style={{ color: 'var(--green-soft)' }}>{c.load}%</span>
                </div>
                <svg viewBox="0 0 90 22" style={{ width: '100%' }}>
                  <polyline
                    fill="none"
                    stroke="var(--green)"
                    strokeWidth="1"
                    points={sparkline(c.history, 90, 22)}
                  />
                </svg>
              </div>
            ))}
            {cores.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--green-dim)' }}>awaiting telemetry…</div>
            )}
          </div>
        </div>
      </section>

      {/* Memory */}
      <section>
        <div className="panel-label">
          <span>Memory</span>
          <span className="muted">
            {mem ? `${bytes(mem.usedBytes)} / ${bytes(mem.totalBytes)}` : '—'}
          </span>
        </div>
        <div className="card">
          <Meter label="RAM" percent={mem?.percent ?? 0} />
          <Meter label="SWAP" percent={mem?.swapPercent ?? 0} />
        </div>
      </section>

      {/* Sensors */}
      <section>
        <div className="panel-label">
          <span>Temp / Tasks</span>
          <span className="muted">Sensors</span>
        </div>
        <div
          className="card"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--green-dim)' }}
        >
          <Stat label="TEMP" value={cpu?.tempC != null ? `${Math.round(cpu.tempC)}°C` : '—'} />
          <Stat
            label="MAX"
            value={cpu?.tempMaxC != null ? `${Math.round(cpu.tempMaxC)}°C` : '—'}
            color="var(--amber)"
          />
          <Stat label="TASKS" value={data ? String(data.tasks) : '—'} color="var(--green-soft)" />
        </div>
      </section>

      {/* Top processes */}
      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="panel-label">
          <span>Top Processes</span>
          <span className="muted">CPU%</span>
        </div>
        <div className="card" style={{ flex: 1, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {(data?.topProcesses ?? []).map((p, i) => (
                <tr key={`${p.pid}-${i}`}>
                  <td style={{ color: 'var(--green-dim)', width: 38, padding: '2px 0' }}>{p.pid}</td>
                  <td style={{ color: 'var(--green-soft)' }}>{p.name}</td>
                  <td
                    style={{
                      textAlign: 'right',
                      color: p.cpu >= 50 ? 'var(--amber)' : 'var(--green)'
                    }}
                  >
                    {p.cpu}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div>
      {label}
      <br />
      <b style={{ color: color ?? 'var(--green)', fontSize: 18 }}>{value}</b>
    </div>
  )
}
