// Bridges server proactive events → on-screen toasts. Every event the backend
// broadcasts (device transitions, crypto fills, OSINT escalations, AI alerts)
// is already archived server-side; this surfaces the same event as a toast so
// toast + ARCHIVE stay in lock-step. Mounted once, at the app root.
import { useEffect } from 'react'
import type { EventSeverity, EventSource } from '../../shared/archive'
import { addToast } from '../lib/toasts'
import type { ToastSeverity } from '../lib/toasts'

const SEVERITY_MAP: Record<EventSeverity, ToastSeverity> = {
  info: 'info',
  notice: 'info',
  warn: 'warn',
  critical: 'alert',
}

// Fallback icon when an event carries no explicit one (e.g. AI/OSINT alerts).
const SOURCE_ICON: Record<EventSource, string> = {
  OSINT: 'ti-radar',
  HOME: 'ti-home',
  COMPUTER: 'ti-cpu',
  CRYPTO: 'ti-currency-bitcoin',
  FINANCE: 'ti-file-dollar',
  SYSTEM: 'ti-terminal-2',
}

export function useProactiveToasts(): void {
  useEffect(() => {
    if (!window.homunculus) return
    return window.homunculus.onChatProactive(({ text, meta }) => {
      const severity = meta ? SEVERITY_MAP[meta.severity] : 'info'
      const icon = meta?.icon ?? (meta ? SOURCE_ICON[meta.source] : 'ti-bell')
      // If the event has a distinct title, show the fuller text as the subtitle.
      const head = meta?.title ?? text
      const sub = meta?.sub ?? (meta?.title && text !== meta.title ? text : undefined)
      addToast(head, {
        sub,
        severity,
        icon,
        // Critical events linger; routine notices auto-dismiss quickly.
        ttl: severity === 'alert' ? 14000 : 7000,
      })
    })
  }, [])
}
