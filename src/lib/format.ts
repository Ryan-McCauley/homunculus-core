/** Human-friendly byte formatting, e.g. 12.4 GB. */
export function bytes(n: number, digits = 1): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

/** Uptime seconds -> "14d 06:01". */
export function uptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return d > 0 ? `${d}d ${hh}:${mm}` : `${hh}:${mm}`
}

/** Build a sparkline polyline `points` string from a value history (0-100). */
export function sparkline(history: number[], w: number, h: number): string {
  if (history.length === 0) return ''
  const max = 100
  const step = history.length > 1 ? w / (history.length - 1) : w
  return history
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ')
}

/** Severity color token for a 0-100 utilization value. */
export function loadColor(pct: number): string {
  if (pct >= 85) return 'var(--crimson)'
  if (pct >= 60) return 'var(--amber)'
  return 'var(--green)'
}
