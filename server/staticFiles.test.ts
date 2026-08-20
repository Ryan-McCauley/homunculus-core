import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { contentTypeFor, isImmutableAsset, resolveStaticRequest } from './staticFiles'

// The web root as index.ts hands it over: absolute and already resolved.
const WEB_DIR = resolve('/srv/app/out/renderer')

const at = (...parts: string[]): string => join(WEB_DIR, ...parts)

describe('resolveStaticRequest', () => {
  it('maps / to index.html', () => {
    expect(resolveStaticRequest(WEB_DIR, '/')).toEqual({ ok: true, filePath: at('index.html') })
  })

  it('maps a plain asset path under the root', () => {
    expect(resolveStaticRequest(WEB_DIR, '/assets/main-a1b2c3.js'))
      .toEqual({ ok: true, filePath: at('assets', 'main-a1b2c3.js') })
  })

  it('ignores the query string', () => {
    expect(resolveStaticRequest(WEB_DIR, '/favicon.svg?v=2'))
      .toEqual({ ok: true, filePath: at('favicon.svg') })
  })

  it('refuses traversal out of the root', () => {
    for (const url of ['/../../etc/passwd', '/assets/../../../../etc/passwd', '/./../../secret']) {
      expect(resolveStaticRequest(WEB_DIR, url)).toEqual({ ok: false, code: 403, error: 'forbidden' })
    }
  })

  it('refuses PERCENT-ENCODED traversal, which decoding first would otherwise admit', () => {
    expect(resolveStaticRequest(WEB_DIR, '/%2e%2e/%2e%2e/etc/passwd'))
      .toEqual({ ok: false, code: 403, error: 'forbidden' })
    expect(resolveStaticRequest(WEB_DIR, '/..%2f..%2fetc%2fpasswd'))
      .toEqual({ ok: false, code: 403, error: 'forbidden' })
  })

  it('refuses a sibling directory that merely shares the root as a prefix', () => {
    // Without the trailing separator in the containment check, "/srv/app/out/renderer-x"
    // startsWith "/srv/app/out/renderer" and would be served.
    const escaped = resolveStaticRequest(WEB_DIR, '/../renderer-x/secret.js')
    expect(escaped).toEqual({ ok: false, code: 403, error: 'forbidden' })
  })

  it('rejects a NUL rather than letting it truncate the path at the syscall', () => {
    expect(resolveStaticRequest(WEB_DIR, '/index.html%00.png'))
      .toEqual({ ok: false, code: 400, error: 'bad request' })
  })

  it('rejects an undecodable escape instead of throwing', () => {
    expect(resolveStaticRequest(WEB_DIR, '/%')).toEqual({ ok: false, code: 400, error: 'bad request' })
    expect(resolveStaticRequest(WEB_DIR, '/%zz')).toEqual({ ok: false, code: 400, error: 'bad request' })
  })

  it('decodes an escaped name so a file with a space is found', () => {
    expect(resolveStaticRequest(WEB_DIR, '/my%20font.woff2'))
      .toEqual({ ok: true, filePath: at('my font.woff2') })
  })

  it('treats a missing url as the index', () => {
    expect(resolveStaticRequest(WEB_DIR, undefined)).toEqual({ ok: true, filePath: at('index.html') })
  })
})

describe('isImmutableAsset', () => {
  it('is true only for the content-hashed assets directory', () => {
    expect(isImmutableAsset(WEB_DIR, at('assets', 'main-a1b2c3.js'))).toBe(true)
    expect(isImmutableAsset(WEB_DIR, at('index.html'))).toBe(false)
    // A sibling that merely starts with the same characters is not the directory.
    expect(isImmutableAsset(WEB_DIR, `${at('assets')}-old${sep}x.js`)).toBe(false)
  })
})

describe('contentTypeFor', () => {
  it('maps the extensions the bundle emits', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/x/main.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/x/font.woff2')).toBe('font/woff2')
  })

  it('falls back to octet-stream for anything else', () => {
    expect(contentTypeFor('/x/blob.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('/x/no-extension')).toBe('application/octet-stream')
  })
})
