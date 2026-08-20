// What an agent is actually doing, written so a human can read it.
//
// The mind stream used to record every tool call as "Used Bash". These agents work almost
// entirely through curl — every pull, every proposal, every board post is a Bash call — so
// that one line covered essentially all of their behaviour and explained none of it. A
// run that read three endpoints and staged a trade looked exactly like a run that did
// nothing.
//
// Everything here is derived from the tool input, and everything is redacted before it is
// written anywhere the operator (or another agent) can read it: every agent's curl carries
// the shared token and its own propose key, and the mind is not a secret store.

export interface ToolNarration {
  /** One short line for the live activity ticker. */
  activity: string
  /** The fuller line written into the agent's mind. */
  detail: string
}

const MAX_ACTIVITY = 160
const MAX_DETAIL = 480

/** Redacts the credentials that appear in nearly every command these agents run. */
export function redactSecrets(s: string): string {
  return s
    .replace(/([?&]token=)[^&"'\s]+/gi, '$1***')
    .replace(/(x-homunculus-agent-key\s*:\s*)[^"'\s]+/gi, '$1***')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Pulls the path out of a URL without needing it to be well-formed. */
function urlPath(u: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/[^\s"']*)?/i.exec(u)
  const path = m?.[1] ?? u
  return path.replace(/[?&]token=[^&"'\s]*/gi, '')
}

interface CurlParts {
  method: string
  url: string
}

function parseCurl(cmd: string): CurlParts | null {
  if (!/(^|[|;&\s])curl\b/.test(cmd)) return null
  const method = /-X\s+([A-Z]+)/.exec(cmd)?.[1]
    ?? (/(^|\s)(-d|--data|--data-raw|--data-binary)\b/.test(cmd) ? 'POST' : 'GET')
  // The URL is the first http(s) token, quoted or not.
  const url = /["']?(https?:\/\/[^\s"']+)["']?/.exec(cmd)?.[1] ?? ''
  return { method, url }
}

/** The jq program, when the command pipes through jq. */
function parseJq(cmd: string): string | null {
  const m = /\|\s*jq\s+(?:-[a-zA-Z-]+\s+)*(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(cmd)
  if (!m) return null
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null
}

function narrateBash(input: Record<string, unknown>): ToolNarration {
  const raw = str(input.command)
  const described = str(input.description)
  if (!raw) {
    return { activity: clip(described ?? 'Bash', MAX_ACTIVITY), detail: clip(described ?? 'Ran a Bash command with no command text', MAX_DETAIL) }
  }
  const cmd = redactSecrets(raw)

  const curl = parseCurl(cmd)
  if (curl && curl.url) {
    const path = urlPath(redactSecrets(curl.url))
    const jq = parseJq(cmd)
    const detail = jq
      ? `${curl.method} ${path} | jq ${jq}`
      : `${curl.method} ${path}`
    return {
      activity: clip(described ?? `${curl.method} ${path}`, MAX_ACTIVITY),
      detail: clip(detail, MAX_DETAIL)
    }
  }

  // Not a curl — lead with the program and its first arguments, which is usually enough
  // to tell a jq of a local file from a git command from a python script.
  const program = cmd.trim().split(/\s+/)[0] ?? 'shell'
  return {
    activity: clip(described ?? cmd, MAX_ACTIVITY),
    detail: clip(`${program}: ${cmd}`, MAX_DETAIL)
  }
}

/**
 * A readable account of one tool call. Never throws, and never returns an empty string —
 * it is called from the middle of a stream loop where a fault would kill the run.
 */
export function narrateTool(name: string, input: unknown): ToolNarration {
  const obj: Record<string, unknown> = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  try {
    switch (name) {
      case 'Bash':
      case 'BashOutput':
        return narrateBash(obj)
      case 'Read': {
        const f = str(obj.file_path)
        return { activity: clip(f ? `Read ${f}` : 'Read', MAX_ACTIVITY), detail: clip(f ? `Read ${f}` : 'Read a file', MAX_DETAIL) }
      }
      case 'Write': {
        const f = str(obj.file_path)
        return { activity: clip(f ? `Write ${f}` : 'Write', MAX_ACTIVITY), detail: clip(f ? `Wrote ${f}` : 'Wrote a file', MAX_DETAIL) }
      }
      case 'Edit': {
        const f = str(obj.file_path)
        return { activity: clip(f ? `Edit ${f}` : 'Edit', MAX_ACTIVITY), detail: clip(f ? `Edited ${f}` : 'Edited a file', MAX_DETAIL) }
      }
      case 'Grep': {
        const p = str(obj.pattern)
        return { activity: clip(p ? `Grep ${p}` : 'Grep', MAX_ACTIVITY), detail: clip(`Searched for ${p ?? '(no pattern)'}${str(obj.path) ? ` in ${str(obj.path)}` : ''}`, MAX_DETAIL) }
      }
      case 'WebFetch': {
        const u = str(obj.url)
        const shown = u ? redactSecrets(u).replace(/^https?:\/\//, '') : null
        return { activity: clip(shown ? `Fetched ${shown}` : 'WebFetch', MAX_ACTIVITY), detail: clip(shown ? `Fetched ${shown}` : 'Fetched a URL', MAX_DETAIL) }
      }
      default: {
        const hint = str(obj.description) ?? str(obj.prompt) ?? str(obj.query)
        return {
          activity: clip(hint ? `${name}: ${hint}` : `Used ${name}`, MAX_ACTIVITY),
          detail: clip(hint ? `${name} — ${redactSecrets(hint)}` : `Used ${name}`, MAX_DETAIL)
        }
      }
    }
  } catch {
    return { activity: clip(`Used ${name}`, MAX_ACTIVITY), detail: clip(`Used ${name}`, MAX_DETAIL) }
  }
}
