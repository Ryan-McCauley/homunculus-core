import { describe, it, expect } from 'vitest'
import { narrateTool, redactSecrets } from './toolNarration'

describe('redactSecrets', () => {
  it('strips the shared token out of a url', () => {
    expect(redactSecrets('curl -s "http://x/api/crypto/positions?token=abc123"'))
      .toBe('curl -s "http://x/api/crypto/positions?token=***"')
  })

  it('strips the per-agent propose key, which is the one that carries authority', () => {
    const out = redactSecrets("-H 'x-homunculus-agent-key: k_9f3c2a'")
    expect(out).not.toContain('k_9f3c2a')
    expect(out).toContain('x-homunculus-agent-key: ***')
  })

  it('is case-insensitive about the header name', () => {
    expect(redactSecrets('-H "X-Homunculus-Agent-Key: secret"')).not.toContain('secret')
  })

  it('strips anything that looks like a long-lived Anthropic token', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant-oat01-AbCdEf123456 npm start'))
      .not.toContain('AbCdEf123456')
  })

  it('leaves an ordinary command untouched', () => {
    expect(redactSecrets('jq .positions')).toBe('jq .positions')
  })
})

describe('narrateTool — Bash', () => {
  it('names the endpoint a GET curl actually pulled, not just "Bash"', () => {
    const n = narrateTool('Bash', { command: 'curl -s "http://127.0.0.1:8787/api/crypto/positions?token=t"' })
    expect(n.activity).toContain('/api/crypto/positions')
    expect(n.detail).toContain('GET')
    expect(n.detail).toContain('/api/crypto/positions')
  })

  it('says which method a write used — a POST is not the same event as a read', () => {
    const n = narrateTool('Bash', {
      command: `curl -s -X POST "http://127.0.0.1:8787/api/crypto/bracket/propose?token=t" -d '{"symbol":"INJUSD"}'`
    })
    expect(n.detail).toContain('POST')
    expect(n.detail).toContain('/api/crypto/bracket/propose')
  })

  it('never leaks the token or the agent key into the mind, which the operator reads', () => {
    const n = narrateTool('Bash', {
      command: `curl -X POST "http://h/api/crypto/agents/x/propose?token=SEKRIT" -H 'x-homunculus-agent-key: KEY123'`
    })
    expect(JSON.stringify(n)).not.toContain('SEKRIT')
    expect(JSON.stringify(n)).not.toContain('KEY123')
  })

  it('prefers the model\'s own description when it wrote one', () => {
    const n = narrateTool('Bash', { command: 'curl -s http://h/api/crypto/positions', description: 'Check open positions' })
    expect(n.activity).toBe('Check open positions')
  })

  it('reports the jq filter applied to a pulled payload — the narrowing IS the work', () => {
    const n = narrateTool('Bash', {
      command: `curl -s "http://h/api/crypto/snapshot?token=t" | jq '.tickers["INJUSD"]'`
    })
    expect(n.detail).toContain('/api/crypto/snapshot')
    expect(n.detail).toContain('jq')
    expect(n.detail).toContain('.tickers["INJUSD"]')
  })

  it('describes a plain shell command by its program', () => {
    const n = narrateTool('Bash', { command: 'ls -la data/crypto' })
    expect(n.detail).toContain('ls')
    expect(n.detail).toContain('data/crypto')
  })

  it('summarises a long command rather than pasting a wall of shell into the mind', () => {
    const n = narrateTool('Bash', { command: `echo ${'x'.repeat(4000)}` })
    expect(n.detail.length).toBeLessThan(600)
    expect(n.activity.length).toBeLessThan(200)
  })

  it('handles a missing command without inventing one', () => {
    const n = narrateTool('Bash', {})
    expect(n.activity).toContain('Bash')
    expect(n.detail).toBeTruthy()
  })
})

describe('narrateTool — other tools', () => {
  it('names the file a read touched', () => {
    const n = narrateTool('Read', { file_path: '/data/crypto/active-bracket.json' })
    expect(n.detail).toContain('active-bracket.json')
  })

  it('names the file a write touched, and says it was a write', () => {
    const n = narrateTool('Write', { file_path: '/tmp/scan.json' })
    expect(n.detail.toLowerCase()).toContain('wrote')
    expect(n.detail).toContain('scan.json')
  })

  it('names the url a fetch went to', () => {
    const n = narrateTool('WebFetch', { url: 'https://example.com/rates' })
    expect(n.detail).toContain('example.com/rates')
  })

  it('falls back to the tool name for a tool it has no special knowledge of', () => {
    const n = narrateTool('SomeMcpThing', { whatever: 1 })
    expect(n.activity).toContain('SomeMcpThing')
    expect(n.detail).toContain('SomeMcpThing')
  })

  it('survives input that is not an object at all', () => {
    for (const bad of [null, undefined, 'str', 42]) {
      const n = narrateTool('Bash', bad)
      expect(typeof n.activity).toBe('string')
      expect(n.activity.length).toBeGreaterThan(0)
    }
  })
})
