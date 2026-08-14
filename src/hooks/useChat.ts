import { useCallback, useEffect, useRef, useState } from 'react'

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant' | 'core'
  text: string
  streaming?: boolean
  error?: boolean
}

export interface UseChat {
  turns: ChatTurn[]
  busy: boolean
  configured: boolean | null
  model: string
  send: (text: string) => void
}

let counter = 0
const nextId = (): string => `t${Date.now()}_${counter++}`

// The transcript is append-only and the app stays open for days, with server-pushed
// proactive events landing in it unprompted — so without a cap both the array and the
// DOM ComputerCore renders from it grow without bound. Oldest turns fall off; ARCHIVE
// remains the durable record of every event.
const MAX_TURNS = 200

function appendTurn(prev: ChatTurn[], turn: ChatTurn): ChatTurn[] {
  const next = [...prev, turn]
  return next.length > MAX_TURNS ? next.slice(-MAX_TURNS) : next
}

const GREETING: ChatTurn = {
  id: 'greeting',
  role: 'assistant',
  text: 'All systems functioning within normal parameters. Standing by for instructions, Captain.'
}

export function useChat(): UseChat {
  const [turns, setTurns] = useState<ChatTurn[]>([GREETING])
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [model, setModel] = useState('')
  // The id of the assistant turn currently streaming.
  const activeId = useRef<string | null>(null)

  useEffect(() => {
    if (!window.homunculus) return
    void window.homunculus.chatStatus().then((s) => {
      setConfigured(s.configured)
      setModel(s.model)
    })

    const offDelta = window.homunculus.onChatDelta(({ id, delta }) => {
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, text: t.text + delta } : t))
      )
    })
    const offDone = window.homunculus.onChatDone(({ id }) => {
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, streaming: false } : t))
      )
      if (activeId.current === id) activeId.current = null
      setBusy(false)
    })
    const offError = window.homunculus.onChatError(({ id, message }) => {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, streaming: false, error: true, text: `Unable to comply. ${message}` }
            : t
        )
      )
      if (activeId.current === id) activeId.current = null
      setBusy(false)
    })
    const offProactive = window.homunculus.onChatProactive(({ id, text, meta }) => {
      // Device / crypto events (chatLog:false) toast + archive only — keep them
      // out of the ship's-computer conversation so it isn't flooded with chatter.
      if (meta?.chatLog === false) return
      setTurns((prev) => appendTurn(prev, { id, role: 'core', text }))
    })
    return () => {
      offDelta()
      offDone()
      offError()
      offProactive()
    }
  }, [])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || busy || !window.homunculus) return
      const userTurn: ChatTurn = { id: nextId(), role: 'user', text: trimmed }
      const replyId = nextId()
      activeId.current = replyId
      setTurns((prev) =>
        appendTurn(appendTurn(prev, userTurn), {
          id: replyId, role: 'assistant', text: '', streaming: true
        })
      )
      setBusy(true)
      window.homunculus.sendChat(replyId, trimmed)
    },
    [busy]
  )

  return { turns, busy, configured, model, send }
}
