import { useState, useEffect } from 'react'

export type ToastSeverity = 'info' | 'warn' | 'alert'

export interface Toast {
  id: string
  message: string
  sub?: string
  severity: ToastSeverity
  icon?: string
}

type Listener = (toasts: Toast[]) => void
let _toasts: Toast[] = []
const _listeners = new Set<Listener>()

function notify(): void {
  const snapshot = [..._toasts]
  _listeners.forEach((l) => l(snapshot))
}

export function addToast(
  message: string,
  opts?: { sub?: string; severity?: ToastSeverity; icon?: string; ttl?: number }
): void {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const t: Toast = { id, message, severity: 'info', ...opts }
  _toasts = [..._toasts, t]
  notify()
  setTimeout(() => dismissToast(id), opts?.ttl ?? 7000)
}

export function dismissToast(id: string): void {
  _toasts = _toasts.filter((t) => t.id !== id)
  notify()
}

export function useToasts(): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([..._toasts])
  useEffect(() => {
    _listeners.add(setToasts)
    return () => { _listeners.delete(setToasts) }
  }, [])
  return { toasts, dismiss: dismissToast }
}
