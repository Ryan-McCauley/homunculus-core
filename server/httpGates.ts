// The HTTP security posture, lifted out of server/index.ts so it can be read and
// tested as one thing.
//
// Nothing here changed when it moved: these are the same gates, with the same
// order and the same answers. What changed is that they are now a module with a
// visible surface instead of four functions buried at line 90 of a 2,300-line
// router, where the only way to answer "what protects this endpoint?" was to
// trace control flow. index.ts keeps one-line wrappers that bind the process
// tokens, so call sites read exactly as they did before.
//
// The reasoning for each gate is kept verbatim from index.ts — it is the record
// of why this shape and not a simpler one.

import type http from 'http'
import { ADMIN_TOKEN_HEADER, constantTimeEquals } from '../shared/audit'

/** The Vite renderer in dev. Not trusted in production builds — it simply never
 *  appears as an Origin there. */
export const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

/** Whether a request originates from the home PC itself. */
export function isLocalReq(req: http.IncomingMessage): boolean {
  const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1'
}

// ── Origin gate ─────────────────────────────────────────────────────────
//
// The localhost bypass in requireToken (and the WS upgrade handler's own copy of
// it) exists for the desktop UI hitting its own backend — a real convenience. Its
// blind spot is that a browser enforces none of that intent: ANY page open in the
// same browser, on any domain, can fetch() or open a WebSocket to localhost:8787
// and is just as "local" by the isLocalReq test above. What tells the two apart is
// the Origin header, which a browser attaches to every cross-origin fetch/XHR and
// to every WebSocket handshake, and which script cannot forge.
//
// A non-browser caller (curl, a strategy skill, the sync peer-to-peer fetch) sends
// no Origin at all — that is not a browser signature to trust, so an ABSENT Origin
// falls through to whatever token gate already applies. A PRESENT Origin that
// isn't this server's own origin (or, in dev, the Vite renderer) is exactly what a
// malicious cross-site page looks like on the wire, and is rejected outright
// before any handler — including the token check — runs.
export function isAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (DEV_ORIGINS.has(origin)) return true
  try {
    // Same-origin: the Origin's host:port equals whatever the client dialed (the
    // Host header) — true whether that's localhost:8787 or a tailnet address:8787,
    // and independent of which of those this node happens to be.
    return new URL(origin).host === (req.headers.host || '')
  } catch {
    return false
  }
}

/** The CORS response value for a request that has already passed isAllowedOrigin:
 *  reflect the specific Origin back (never '*') so the browser's own same-origin
 *  rules are what decide who can read the response. A caller with no Origin (curl,
 *  a peer node, a skill) isn't a browser and ignores this header entirely. */
export function corsOrigin(req: http.IncomingMessage): string {
  return req.headers.origin || '*'
}

// Defensive headers on every response, API and static alike. nosniff and
// no-referrer are cheap and standard. The CSP mirrors index.html's own <meta>
// policy (Google Fonts, ws:/wss: for the transport) so it tightens nothing that
// already works — except frame-ancestors and base-uri, which a <meta> CSP is
// spec'd to ignore and only an HTTP header can enforce. frame-ancestors is the
// one that matters most here: it closes the clickjacking angle CORS says nothing
// about (a confirm-trade button framed invisibly on another site).
export function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; connect-src 'self' ws: wss: http://localhost:* https://localhost:*; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
      "script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  }
}

/** The token a request presents, from either ?token= or the x-homunculus-token
 *  header. Header wins only when the query string carries none. */
export function presentedToken(req: http.IncomingMessage): string {
  const url = new URL(req.url || '', 'http://localhost')
  const raw = req.headers['x-homunculus-token']
  return url.searchParams.get('token') || (Array.isArray(raw) ? raw[0] : raw) || ''
}

/** What a gate decided, and — when it refused — the status and message to send.
 *  Returned rather than written so the decision can be tested without a socket. */
export type GateVerdict =
  | { ok: true }
  | { ok: false; code: number; error: string }

// Token gate for sensitive routes (mirrors the WS upgrade handler): localhost is
// always allowed; remote callers (e.g. the iPhone view over Tailscale) must
// present HOMUNCULUS_TOKEN via ?token= or the x-homunculus-token header. Used to
// protect /api/crypto/* so portfolio data isn't served unauthenticated off the
// home PC.
//
// This is the SECOND gate, not the only one: isAllowedOrigin above has already run
// for every /api/ request by the time this is called, so a request that reaches
// here either carried no Origin (a trusted non-browser caller) or one that matches
// this server. A token alone was never enough to stop a same-machine browser page
// — that is what the Origin check is for.
export function tokenVerdict(req: http.IncomingMessage, token: string): GateVerdict {
  if (isLocalReq(req)) return { ok: true }
  // An unconfigured gate is a CLOSED gate, exactly as the admin gate has always
  // treated it. This used to allow everything when the token was empty, which made
  // "no token configured" mean "no authentication at all" for every remote caller:
  // published on a LAN or a tailnet, that served finance data, trade staging and
  // the agent fleet to anyone who could reach the port. Localhost still bypasses
  // (above) so the desktop app and the operator's own machine are unaffected.
  if (!token) {
    return { ok: false, code: 503, error: 'HOMUNCULUS_TOKEN is not configured — remote access is refused until it is set' }
  }
  if (constantTimeEquals(presentedToken(req), token)) return { ok: true }
  return { ok: false, code: 401, error: 'unauthorized' }
}

// Admin gate for audit-log management. Three deliberate differences from the token
// gate: no localhost bypass, header only (a query-string secret leaks into shell
// history and proxy logs), and constant-time comparison. When
// HOMUNCULUS_ADMIN_TOKEN is unset the answer is 503, not 200 — an unconfigured
// admin gate is a closed one. Audit *recording* never depends on this; it only
// governs the annotate route, the sole sanctioned way to amend the record.
export function adminVerdict(req: http.IncomingMessage, adminToken: string): GateVerdict {
  if (!adminToken) {
    return { ok: false, code: 503, error: 'admin token not configured (set HOMUNCULUS_ADMIN_TOKEN)' }
  }
  const raw = req.headers[ADMIN_TOKEN_HEADER]
  const provided = Array.isArray(raw) ? raw[0] || '' : raw || ''
  if (constantTimeEquals(provided, adminToken)) return { ok: true }
  return { ok: false, code: 401, error: 'admin token required' }
}
