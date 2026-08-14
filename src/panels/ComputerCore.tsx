import { useEffect, useRef, useState } from 'react'
import { useChat } from '../hooks/useChat'
import type { ChatTurn } from '../hooks/useChat'

const QUICK = ['Status sweep', 'Home state report', 'Goodnight routine', 'Away mode']

const ROLE_LABEL: Record<ChatTurn['role'], string> = {
  user: 'COMMAND',
  assistant: 'COMPUTER',
  core: 'CORE ALERT'
}

const ROLE_COLOR: Record<ChatTurn['role'], string> = {
  user: 'var(--green-dim)',
  assistant: 'var(--chat-assistant-glow)',
  core: 'var(--chat-core-glow)'
}

const TEXT_COLOR: Record<ChatTurn['role'], string> = {
  user: 'var(--chat-user-color)',
  assistant: 'var(--green-soft)',
  core: 'var(--chat-core-color)'
}

/** Computer Core: the conversational Claude interface, now with actions and proactive alerts. */
export function ComputerCore(): JSX.Element {
  const { turns, busy, configured, model, send } = useChat()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  const submit = (text: string): void => {
    if (!text.trim()) return
    send(text)
    setDraft('')
  }

  return (
    <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-label">
        <span>Computer Core</span>
        <span className="muted">
          {configured === false ? 'NO SESSION' : busy ? 'WORKING' : 'STANDING BY'}
        </span>
      </div>

      <div
        className="card"
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, gap: 10 }}
      >
        {/* transcript */}
        <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 11 }}>
          {turns.map((t) => (
            <div
              key={t.id}
              style={t.role === 'core' ? {
                borderLeft: '2px solid var(--chat-core-border)',
                paddingLeft: 8,
                background: 'var(--chat-core-bubble)',
                borderRadius: 3
              } : undefined}
            >
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: 2,
                  marginBottom: 3,
                  color: ROLE_COLOR[t.role],
                  textAlign: t.role === 'user' ? 'right' : 'left'
                }}
              >
                {ROLE_LABEL[t.role]}
              </div>
              <div
                style={{
                  fontSize: 17,
                  lineHeight: 1.5,
                  color: t.error ? 'var(--crimson)' : TEXT_COLOR[t.role],
                  textAlign: t.role === 'user' ? 'right' : 'left',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {t.text}
                {t.streaming && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 6,
                      height: 13,
                      marginLeft: 2,
                      verticalAlign: 'text-bottom',
                      background: 'var(--green)',
                      boxShadow: 'var(--glow-green)',
                      animation: 'blink 1s step-end infinite'
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* quick commands */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {QUICK.map((q) => (
            <button
              key={q}
              disabled={busy || configured === false}
              onClick={() => submit(q)}
              style={{
                fontSize: 13,
                letterSpacing: 1,
                color: 'var(--green)',
                background: 'transparent',
                border: '0.5px solid var(--border-strong)',
                borderRadius: 3,
                padding: '3px 7px',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy || configured === false ? 0.4 : 1
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* input */}
        <div style={{ display: 'flex', gap: 7 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(draft) }}
            placeholder={
              configured === false
                ? 'Set CLAUDE_CODE_OAUTH_TOKEN in .env to engage…'
                : 'State your command, Captain…'
            }
            disabled={configured === false}
            style={{
              flex: 1,
              background: 'var(--bg)',
              border: '0.5px solid var(--border-strong)',
              borderRadius: 4,
              color: 'var(--green-soft)',
              fontFamily: 'var(--font-mono)',
              fontSize: 17,
              letterSpacing: 1,
              padding: '8px 11px',
              outline: 'none'
            }}
          />
          <button
            onClick={() => submit(draft)}
            disabled={busy || configured === false || !draft.trim()}
            style={{
              background: 'var(--crimson)',
              border: 'none',
              borderRadius: 4,
              color: 'var(--bg)',
              fontFamily: 'var(--font-display, monospace)',
              fontWeight: 700,
              fontSize: 16,
              letterSpacing: 2,
              padding: '8px 14px',
              cursor: 'pointer',
              opacity: busy || configured === false || !draft.trim() ? 0.5 : 1
            }}
          >
            EXEC
          </button>
        </div>

        {model && (
          <div style={{ fontSize: 11, letterSpacing: 1, color: 'var(--green-dim)', textAlign: 'right' }}>
            CLAUDE CORE · {model.toUpperCase()}
          </div>
        )}
      </div>
    </section>
  )
}
