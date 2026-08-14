import { useEffect, useState } from 'react'

/** Big bridge clock, ticking once a second. */
export function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return (
    <div
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: 30,
        fontWeight: 700,
        color: '#d8ffe8',
        letterSpacing: 3,
        textShadow: '0 0 14px #00ff6633'
      }}
    >
      {hh}:{mm}:{ss}
    </div>
  )
}

/** Federation-style stardate derived from the calendar date. */
export function stardate(d = new Date()): string {
  const start = new Date(d.getFullYear(), 0, 0)
  const day = Math.floor((d.getTime() - start.getTime()) / 86400000)
  return `${d.getFullYear()}.${String(day).padStart(3, '0')}`
}
