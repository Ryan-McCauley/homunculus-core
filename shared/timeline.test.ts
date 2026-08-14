import { describe, it, expect } from 'vitest'
import { serviceForPath, edgeForAudit, componentLabel, componentKind, SERVICES } from './timeline'

describe('serviceForPath', () => {
  it('routes the library sub-path before the generic office path (longest-prefix-first)', () => {
    expect(serviceForPath('/api/crypto/office/library/artifacts')).toBe('library')
  })
  it('routes the rest of office to office', () => {
    expect(serviceForPath('/api/crypto/office/personnel')).toBe('office')
  })
  it('routes agents to fleet', () => {
    expect(serviceForPath('/api/crypto/agents/sniper/propose')).toBe('fleet')
  })
  it('routes alerts to alerts', () => {
    expect(serviceForPath('/api/crypto/alerts')).toBe('alerts')
  })
  it('routes plan-report to reports', () => {
    expect(serviceForPath('/api/crypto/plan-report')).toBe('reports')
  })
  it('routes audit to audit', () => {
    expect(serviceForPath('/api/audit/log')).toBe('audit')
  })
  it('routes strategy settings and create to strategy-config, ahead of the generic strategy route', () => {
    expect(serviceForPath('/api/crypto/strategy/settings')).toBe('strategy-config')
    expect(serviceForPath('/api/crypto/strategy/create')).toBe('strategy-config')
  })
  it('routes the remaining strategy paths (e.g. run) to fleet', () => {
    expect(serviceForPath('/api/crypto/strategy/run')).toBe('fleet')
  })
  it('routes trade-shaped paths to trade-engine', () => {
    for (const p of [
      '/api/crypto/stage', '/api/crypto/trade', '/api/crypto/order',
      '/api/crypto/position', '/api/crypto/bracket', '/api/crypto/autoplan',
      '/api/crypto/cost-basis', '/api/crypto/auto-execute',
    ]) {
      expect(serviceForPath(p)).toBe('trade-engine')
    }
  })
  it('returns null for a read-only path that belongs to nobody (e.g. snapshot polling)', () => {
    expect(serviceForPath('/api/crypto/snapshot')).toBeNull()
  })
  it('returns null for an unrelated path', () => {
    expect(serviceForPath('/api/finance/accounts')).toBeNull()
  })
})

function auditEntry(overrides: Partial<Parameters<typeof edgeForAudit>[0]> = {}): Parameters<typeof edgeForAudit>[0] {
  return {
    ts: '2026-08-09T12:00:00.000Z',
    actor: 'operator',
    origin: 'http',
    action: 'http.post',
    resource: '/api/crypto/stage',
    summary: 'staged a trade',
    ...overrides,
  }
}

describe('edgeForAudit', () => {
  it('returns null when the timestamp does not parse', () => {
    expect(edgeForAudit(auditEntry({ ts: 'not-a-date' }))).toBeNull()
  })
  it('maps an agent trade action to an edge from the agent to trade-engine', () => {
    const e = edgeForAudit(auditEntry({ actor: 'agent:sniper', action: 'agent.trade.propose' }))
    expect(e).toMatchObject({ from: 'agent:sniper', to: 'trade-engine', action: 'agent.trade.propose' })
  })
  it('maps an alert wake to an edge from alerts to the named agent resource', () => {
    const e = edgeForAudit(auditEntry({ action: 'alert.wake', resource: 'agent:manager' }))
    expect(e).toMatchObject({ from: 'alerts', to: 'agent:manager', action: 'alert.wake' })
  })
  it('maps alert.wake.refused the same way as alert.wake', () => {
    const e = edgeForAudit(auditEntry({ action: 'alert.wake.refused', resource: 'agent:manager' }))
    expect(e).toMatchObject({ from: 'alerts', to: 'agent:manager' })
  })
  it('maps alert create/remove/arm to an edge from the actor to the alerts store', () => {
    for (const action of ['alert.create', 'alert.remove', 'alert.arm']) {
      const e = edgeForAudit(auditEntry({ action, actor: 'operator' }))
      expect(e).toMatchObject({ from: 'operator', to: 'alerts', action })
    }
  })
  it('returns null for an alert.* action with no specific edge mapping', () => {
    expect(edgeForAudit(auditEntry({ action: 'alert.something-else' }))).toBeNull()
  })
  it('maps alert.fired.autostage to alerts -> trade-engine', () => {
    const e = edgeForAudit(auditEntry({ action: 'alert.fired.autostage' }))
    expect(e).toMatchObject({ from: 'alerts', to: 'trade-engine' })
  })
  it('maps plan.autoexecute to system -> trade-engine', () => {
    const e = edgeForAudit(auditEntry({ action: 'plan.autoexecute' }))
    expect(e).toMatchObject({ from: 'system', to: 'trade-engine' })
  })
  it('maps strategy.settings.* and strategy.create to the actor -> strategy-config', () => {
    expect(edgeForAudit(auditEntry({ action: 'strategy.settings.update', actor: 'operator' }))).toMatchObject({
      from: 'operator', to: 'strategy-config',
    })
    expect(edgeForAudit(auditEntry({ action: 'strategy.create', actor: 'operator' }))).toMatchObject({
      from: 'operator', to: 'strategy-config',
    })
  })
  it('maps office.personnel.* to the actor -> office', () => {
    const e = edgeForAudit(auditEntry({ action: 'office.personnel.hire', actor: 'operator' }))
    expect(e).toMatchObject({ from: 'operator', to: 'office' })
  })
  it('maps an http-origin mutation to actor -> the service the path resolves to', () => {
    const e = edgeForAudit(auditEntry({ origin: 'http', action: 'http.post', resource: '/api/crypto/stage', actor: 'operator' }))
    expect(e).toMatchObject({ from: 'operator', to: 'trade-engine' })
  })
  it('returns null for an http action whose path resolves to no service', () => {
    expect(edgeForAudit(auditEntry({ origin: 'http', action: 'http.get', resource: '/api/crypto/snapshot' }))).toBeNull()
  })
  it('returns null for an unrecognized action entirely', () => {
    expect(edgeForAudit(auditEntry({ origin: 'internal', action: 'something.unmapped', resource: 'x' }))).toBeNull()
  })
})

describe('componentLabel', () => {
  it('prefers an explicit name override', () => {
    expect(componentLabel('agent:sniper', { 'agent:sniper': 'The Sniper' })).toBe('The Sniper')
  })
  it('falls back to the SERVICES catalog', () => {
    expect(componentLabel('trade-engine')).toBe(SERVICES['trade-engine'])
  })
  it('strips the agent: prefix and upper-cases the rest', () => {
    expect(componentLabel('agent:manager')).toBe('MANAGER')
  })
  it('strips the skill: prefix and upper-cases the rest', () => {
    expect(componentLabel('skill:sniper')).toBe('SNIPER')
  })
  it('upper-cases an unrecognized id as a last resort', () => {
    expect(componentLabel('operator')).toBe('OPERATOR')
  })
})

describe('componentKind', () => {
  it('classifies agent: and skill: prefixed ids', () => {
    expect(componentKind('agent:manager')).toBe('agent')
    expect(componentKind('skill:sniper')).toBe('skill')
  })
  it('classifies operator and system by exact id', () => {
    expect(componentKind('operator')).toBe('operator')
    expect(componentKind('system')).toBe('system')
  })
  it('defaults everything else to service', () => {
    expect(componentKind('trade-engine')).toBe('service')
    expect(componentKind('alerts')).toBe('service')
  })
})
