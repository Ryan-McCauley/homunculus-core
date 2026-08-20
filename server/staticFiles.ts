// Serving the built web UI, lifted out of server/index.ts for the same reason the
// HTTP gates were: it is a self-contained decision with security consequences, and
// it had no test seam while it sat inside a module that starts a listening server
// on import.
//
// The decision worth testing is the first half — given a web root and a request
// URL, which file (if any) may be read? That is `resolveStaticRequest`, a pure
// function over strings. The second half is bytes onto a socket and reads a
// directory, so it stays a thin wrapper.

import type http from 'http'
import { existsSync, readFileSync, statSync } from 'fs'
import { extname, join, resolve, sep } from 'path'
import { securityHeaders } from './httpGates'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** Vite content-hashes everything it writes here, so these URLs are immutable by
 *  construction. index.html carries those hashes and must never be cached, or a
 *  deploy would keep serving the previous bundle indefinitely. */
const IMMUTABLE_SUBDIR = 'assets'

export type StaticResolution =
  | { ok: true; filePath: string }
  | { ok: false; code: 400 | 403; error: string }

/**
 * Which file under `webDir` a request URL is asking for, or why it may not have one.
 *
 * `webDir` MUST already be absolute and resolved — server/index.ts resolves it once
 * at startup. The traversal guard compares a resolved candidate against this string,
 * so a root carrying a trailing separator or a relative segment would not match its
 * own children and would refuse the entire UI.
 *
 * Order matters. The percent-decode happens FIRST so an asset whose name carries a
 * space or a non-ASCII character resolves rather than falling through to the SPA
 * index; that is safe only because the containment check below runs on the RESOLVED
 * path, by which point `resolve` has collapsed whatever the encoding was hiding.
 */
export function resolveStaticRequest(webDir: string, url: string | undefined): StaticResolution {
  const rawPath = (url || '/').split('?')[0] || '/'

  let urlPath: string
  try {
    urlPath = decodeURIComponent(rawPath)
  } catch {
    // A lone '%' or a truncated escape. Not a path we can reason about.
    return { ok: false, code: 400, error: 'bad request' }
  }
  // A NUL truncates a path at the syscall boundary on some platforms, so it must
  // never reach one — the string the guard checked would not be the string opened.
  if (urlPath.includes('\0')) return { ok: false, code: 400, error: 'bad request' }

  // Joined as an explicitly relative path so an absolute-looking URL cannot escape
  // the root before `resolve` sees it.
  const filePath = resolve(webDir, '.' + (urlPath === '/' ? '/index.html' : urlPath))

  // The trailing separator matters: without it, webDir="/app/out/renderer" would
  // also admit a sibling "/app/out/renderer-x".
  if (filePath !== webDir && !filePath.startsWith(webDir + sep)) {
    return { ok: false, code: 403, error: 'forbidden' }
  }
  return { ok: true, filePath }
}

/** Content-hashed bundler output, safe to cache forever. Anything else is not. */
export function isImmutableAsset(webDir: string, filePath: string): boolean {
  return filePath.startsWith(join(webDir, IMMUTABLE_SUBDIR) + sep)
}

export function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath)] || 'application/octet-stream'
}

/** Serves the built web UI from `webDir`, with an SPA fallback to index.html. */
export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, webDir: string): void {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  if (!existsSync(webDir)) {
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('Homunculus backend running. Web UI not built — run `npm run build`.')
    return
  }

  const resolved = resolveStaticRequest(webDir, req.url)
  if (!resolved.ok) {
    res.writeHead(resolved.code, securityHeaders()).end(resolved.error)
    return
  }

  // SPA fallback to index.html for unknown non-file routes.
  let filePath = resolved.filePath
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(webDir, 'index.html')
  }

  try {
    const body = readFileSync(filePath)
    res.writeHead(200, {
      'content-type': contentTypeFor(filePath),
      'cache-control': isImmutableAsset(webDir, filePath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      ...securityHeaders(),
    })
    res.end(body)
  } catch {
    res.writeHead(404, securityHeaders()).end('not found')
  }
}
