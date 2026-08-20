import { describe, it, expect } from 'vitest'
import type http from 'http'
import {
  DEV_ORIGINS, isLocalReq, isAllowedOrigin, corsOrigin, securityHeaders,
  presentedToken, tokenVerdict, adminVerdict,
} from './httpGates'
import { ADMIN_TOKEN_HEADER } from '../shared/audit'

// The security posture of the HTTP surface, tested directly for the first time.
//
// These gates were previously inline in server/index.ts, which self-starts a
// listener at module scope — importing it in a test boots a real server and a
// Postgres connection, so the whole 2,300-line file sat at 0% and the auth rules
// were verified only by reading them. They are the same functions, unchanged;
// extracting them gave them a seam.
//
// The cases below are written as an auth matrix rather than as a tour of the
// implementation: for each gate, who gets in, who does not, and what the refusal
// says. The ones that matter most are the CLOSED-when-unconfigured rules — an
// empty token meaning "no authentication" is the failure mode the comments in
// httpGates.ts were written about.

/** A request as the gates see it: socket address, headers, url. */
function req(over: {
  ip?: string
  origin?: string
  host?: string
  url?: string
  token?: string
  adminToken?: string
  headers?: Record<string, string | string[]>
} = {}): http.IncomingMessage {
  const headers: Record<string, string | string[]> = { ...(over.headers ?? {}) }
  if (over.origin !== undefined) headers['origin'] = over.origin
  if (over.host !== undefined) headers['host'] = over.host
  if (over.token !== undefined) headers['x-homunculus-token'] = over.token
  if (over.adminToken !== undefined) headers[ADMIN_TOKEN_HEADER] = over.adminToken
  return {
    headers,
    url: over.url ?? '/api/crypto/positions',
    socket: { remoteAddress: over.ip ?? '203.0.113.9' },
  } as unknown as http.IncomingMessage
}

// ── Locality ───────────────────────────────────────────────────────────────

describe('isLocalReq', () => {
  it('accepts loopback in v4, v6, and v4-mapped-v6 form', () => {
    expect(isLocalReq(req({ ip: '127.0.0.1' }))).toBe(true)
    expect(isLocalReq(req({ ip: '::1' }))).toBe(true)
    // Node reports v4 loopback over a dual-stack socket like this; missing the
    // prefix strip would silently treat the local desktop app as remote.
    expect(isLocalReq(req({ ip: '::ffff:127.0.0.1' }))).toBe(true)
  })

  it('rejects everything else, including a LAN address', () => {
    expect(isLocalReq(req({ ip: '192.168.1.50' }))).toBe(false)
    expect(isLocalReq(req({ ip: '10.0.0.4' }))).toBe(false)
    expect(isLocalReq(req({ ip: '' }))).toBe(false)
  })

  it('does not mistake a lookalike address for loopback', () => {
    expect(isLocalReq(req({ ip: '127.0.0.10' }))).toBe(false)
    expect(isLocalReq(req({ ip: '8.8.8.8' }))).toBe(false)
  })
})

// ── Origin gate ────────────────────────────────────────────────────────────

describe('isAllowedOrigin', () => {
  it('allows a request with no Origin at all', () => {
    // curl, a peer node, a skill. Not a browser signature to trust — it simply
    // falls through to whatever token gate applies.
    expect(isAllowedOrigin(req({ host: 'localhost:8787' }))).toBe(true)
  })

  it('allows same-origin, on localhost and on a tailnet address alike', () => {
    expect(isAllowedOrigin(req({ origin: 'http://localhost:8787', host: 'localhost:8787' }))).toBe(true)
    expect(isAllowedOrigin(req({ origin: 'http://100.74.2.9:8787', host: '100.74.2.9:8787' }))).toBe(true)
  })

  it('allows the dev renderer', () => {
    for (const o of DEV_ORIGINS) {
      expect(isAllowedOrigin(req({ origin: o, host: 'localhost:8787' }))).toBe(true)
    }
  })

  it('REJECTS a cross-site page — the attack this gate exists for', () => {
    // A page on evil.com fetching http://localhost:8787 is "local" by IP, so the
    // token gate's localhost bypass would wave it straight through. This is the
    // only thing that stops it.
    expect(isAllowedOrigin(req({ origin: 'https://evil.com', host: 'localhost:8787' }))).toBe(false)
  })

  it('rejects a port mismatch on the same host', () => {
    expect(isAllowedOrigin(req({ origin: 'http://localhost:3000', host: 'localhost:8787' }))).toBe(false)
  })

  it('rejects an unparseable Origin rather than failing open', () => {
    expect(isAllowedOrigin(req({ origin: 'not a url', host: 'localhost:8787' }))).toBe(false)
  })

  it('rejects when the Host header is absent and the Origin is not', () => {
    expect(isAllowedOrigin(req({ origin: 'https://evil.com' }))).toBe(false)
  })
})

// ── CORS reflection ────────────────────────────────────────────────────────

describe('corsOrigin', () => {
  it('reflects the caller Origin rather than a wildcard', () => {
    expect(corsOrigin(req({ origin: 'http://localhost:8787' }))).toBe('http://localhost:8787')
  })

  it('falls back to * only for a caller that has no Origin to reflect', () => {
    // Inert: a non-browser caller ignores this header entirely, and a browser
    // caller always has an Origin, so this branch never grants anything.
    expect(corsOrigin(req({}))).toBe('*')
  })
})

// ── Defensive headers ──────────────────────────────────────────────────────

describe('securityHeaders', () => {
  const h = securityHeaders()

  it('sets the cheap standard headers', () => {
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['referrer-policy']).toBe('no-referrer')
    expect(h['x-frame-options']).toBe('DENY')
  })

  it('forbids framing — the clickjacking angle CORS says nothing about', () => {
    // A confirm-trade button framed invisibly on another site. x-frame-options
    // and the CSP directive must agree; a <meta> CSP cannot express the latter.
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
  })

  it('locks base-uri and confines scripts to self', () => {
    expect(h['content-security-policy']).toContain("base-uri 'none'")
    expect(h['content-security-policy']).toContain("script-src 'self'")
  })

  it('still permits the transport and the font host the app actually uses', () => {
    const csp = h['content-security-policy']!
    expect(csp).toContain('ws:')
    expect(csp).toContain('wss:')
    expect(csp).toContain('https://fonts.googleapis.com')
    expect(csp).toContain('https://fonts.gstatic.com')
  })
})

// ── Token presentation ─────────────────────────────────────────────────────

describe('presentedToken', () => {
  it('reads the query string', () => {
    expect(presentedToken(req({ url: '/api/x?token=abc' }))).toBe('abc')
  })

  it('reads the header', () => {
    expect(presentedToken(req({ token: 'abc' }))).toBe('abc')
  })

  it('prefers the query string when both are present', () => {
    expect(presentedToken(req({ url: '/api/x?token=fromquery', token: 'fromheader' }))).toBe('fromquery')
  })

  it('takes the first value of a repeated header', () => {
    expect(presentedToken(req({ headers: { 'x-homunculus-token': ['first', 'second'] } }))).toBe('first')
  })

  it('is empty when nothing is presented', () => {
    expect(presentedToken(req({}))).toBe('')
  })
})

// ── Token gate ─────────────────────────────────────────────────────────────

describe('tokenVerdict', () => {
  it('waives localhost so the desktop app works with no token configured', () => {
    expect(tokenVerdict(req({ ip: '127.0.0.1' }), '')).toEqual({ ok: true })
  })

  it('FAILS CLOSED for a remote caller when no token is configured', () => {
    // The regression this guards: returning ok here made "no token configured"
    // mean "no authentication at all", serving finance data, trade staging and
    // the agent fleet to anyone who could reach the port on a LAN or tailnet.
    const v = tokenVerdict(req({ ip: '192.168.1.50' }), '')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe(503)
    expect(v.error).toMatch(/not configured/)
  })

  it('admits a remote caller presenting the right token, by header or query', () => {
    expect(tokenVerdict(req({ ip: '192.168.1.50', token: 'sekret' }), 'sekret')).toEqual({ ok: true })
    expect(tokenVerdict(req({ ip: '192.168.1.50', url: '/api/x?token=sekret' }), 'sekret')).toEqual({ ok: true })
  })

  it('rejects a wrong or absent token with 401', () => {
    for (const r of [req({ ip: '192.168.1.50', token: 'wrong' }), req({ ip: '192.168.1.50' })]) {
      const v = tokenVerdict(r, 'sekret')
      expect(v.ok).toBe(false)
      if (v.ok) return
      expect(v.code).toBe(401)
      expect(v.error).toBe('unauthorized')
    }
  })

  it('is not fooled by a token that is merely a prefix of the real one', () => {
    expect(tokenVerdict(req({ ip: '192.168.1.50', token: 'sek' }), 'sekret').ok).toBe(false)
    expect(tokenVerdict(req({ ip: '192.168.1.50', token: 'sekretsekret' }), 'sekret').ok).toBe(false)
  })
})

// ── Admin gate ─────────────────────────────────────────────────────────────

describe('adminVerdict', () => {
  it('has NO localhost bypass — the audit record is not amendable just by being here', () => {
    const v = adminVerdict(req({ ip: '127.0.0.1' }), 'adm')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe(401)
  })

  it('fails closed with 503 when no admin token is configured', () => {
    const v = adminVerdict(req({ ip: '127.0.0.1', adminToken: 'anything' }), '')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe(503)
    expect(v.error).toMatch(/not configured/)
  })

  it('admits the correct token in the admin header', () => {
    expect(adminVerdict(req({ adminToken: 'adm' }), 'adm')).toEqual({ ok: true })
  })

  it('IGNORES a query-string admin token — it would leak into logs and history', () => {
    // Deliberate difference from the ordinary token gate. ?adminToken= must not work.
    const v = adminVerdict(req({ url: `/api/audit/annotate?${ADMIN_TOKEN_HEADER}=adm` }), 'adm')
    expect(v.ok).toBe(false)
  })

  it('rejects a wrong token with 401', () => {
    const v = adminVerdict(req({ adminToken: 'nope' }), 'adm')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.code).toBe(401)
    expect(v.error).toBe('admin token required')
  })

  it('takes the first value of a repeated admin header', () => {
    expect(adminVerdict(req({ headers: { [ADMIN_TOKEN_HEADER]: ['adm', 'other'] } }), 'adm')).toEqual({ ok: true })
  })
})

// ── The layering, stated as one matrix ─────────────────────────────────────

describe('gate layering', () => {
  it('a cross-site page fails the Origin gate even though it looks local to the token gate', () => {
    // The two gates in combination are the actual protection. Each alone is
    // insufficient, and this is the case that proves it.
    const crossSite = req({ ip: '127.0.0.1', origin: 'https://evil.com', host: 'localhost:8787' })

    expect(tokenVerdict(crossSite, 'sekret')).toEqual({ ok: true })   // token gate waves it through
    expect(isAllowedOrigin(crossSite)).toBe(false)                     // origin gate stops it
  })

  it('a curl caller from the LAN passes the Origin gate and is stopped by the token gate', () => {
    const curl = req({ ip: '192.168.1.50' })

    expect(isAllowedOrigin(curl)).toBe(true)          // no Origin to object to
    expect(tokenVerdict(curl, 'sekret').ok).toBe(false)  // token gate stops it
  })
})
