import { describe, it, expect } from 'vitest'
import {
  DEPARTMENT_ORDER, EMPTY_DESK_LAYOUT,
  deskDepartment, groupDesks, moveDesk, normalizeDeskLayout, departmentLabel,
  type DeskLayout,
} from './officeLayout'
import type { Department } from '../../shared/office'

const layout = (over: Partial<DeskLayout> = {}): DeskLayout =>
  ({ ...EMPTY_DESK_LAYOUT, ...over })

const desk = (id: string, department?: Department) =>
  (department ? { id, department } : { id })

describe('DEPARTMENT_ORDER', () => {
  it('covers every department exactly once, so no desk can fall through the floor', () => {
    expect([...DEPARTMENT_ORDER].sort()).toEqual(
      ['executive', 'operations', 'research', 'risk', 'trading'])
  })

  it('reads top-down like an org chart, executive first', () => {
    expect(DEPARTMENT_ORDER[0]).toBe('executive')
  })

  it('labels every department for the pod header', () => {
    for (const d of DEPARTMENT_ORDER) expect(departmentLabel(d)).toMatch(/\S/)
  })
})

describe('deskDepartment', () => {
  it('uses the HR record when the operator has not moved the desk', () => {
    expect(deskDepartment('oracle', 'research', layout())).toBe('research')
  })

  it('lets a desk the operator dragged elsewhere override HR', () => {
    const l = layout({ pod: { oracle: 'risk' } })
    expect(deskDepartment('oracle', 'research', l)).toBe('risk')
  })

  it('files a desk with no HR department under operations rather than dropping it', () => {
    expect(deskDepartment('ghost', undefined, layout())).toBe('operations')
  })

  it('ignores an override naming a department this build does not have', () => {
    const l = layout({ pod: { oracle: 'accounting' as Department } })
    expect(deskDepartment('oracle', 'research', l)).toBe('research')
  })
})

describe('groupDesks', () => {
  it('returns a pod for every department, so an empty one can still be dropped into', () => {
    const pods = groupDesks([desk('oracle', 'research')], layout())
    expect(pods.map((p) => p.department)).toEqual(DEPARTMENT_ORDER)
  })

  it('files each desk under its own department', () => {
    const pods = groupDesks([
      desk('oracle', 'research'), desk('keel', 'risk'), desk('gate', 'trading'),
    ], layout())
    const by = Object.fromEntries(pods.map((p) => [p.department, p.deskIds]))
    expect(by['research']).toEqual(['oracle'])
    expect(by['risk']).toEqual(['keel'])
    expect(by['trading']).toEqual(['gate'])
  })

  it('honours a desk the operator dragged into another pod', () => {
    const pods = groupDesks([desk('oracle', 'research')], layout({ pod: { oracle: 'trading' } }))
    const by = Object.fromEntries(pods.map((p) => [p.department, p.deskIds]))
    expect(by['trading']).toEqual(['oracle'])
    expect(by['research']).toEqual([])
  })

  it('orders desks within a pod by the operator’s arrangement', () => {
    const pods = groupDesks(
      [desk('a', 'trading'), desk('b', 'trading'), desk('c', 'trading')],
      layout({ order: ['c', 'a', 'b'] }))
    expect(pods.find((p) => p.department === 'trading')!.deskIds).toEqual(['c', 'a', 'b'])
  })

  it('keeps newly hired desks in their natural order, after the arranged ones', () => {
    const pods = groupDesks(
      [desk('a', 'trading'), desk('new1', 'trading'), desk('b', 'trading'), desk('new2', 'trading')],
      layout({ order: ['b', 'a'] }))
    expect(pods.find((p) => p.department === 'trading')!.deskIds).toEqual(['b', 'a', 'new1', 'new2'])
  })

  it('ignores arranged ids for desks that no longer exist', () => {
    const pods = groupDesks([desk('a', 'trading')], layout({ order: ['fired', 'a'] }))
    expect(pods.find((p) => p.department === 'trading')!.deskIds).toEqual(['a'])
  })

  it('puts a desk with no department into operations', () => {
    const pods = groupDesks([desk('ghost')], layout())
    expect(pods.find((p) => p.department === 'operations')!.deskIds).toEqual(['ghost'])
  })
})

describe('moveDesk', () => {
  const allIds = ['a', 'b', 'c']

  it('records the pod the desk was dropped into', () => {
    const next = moveDesk(layout(), { id: 'a', department: 'risk', allIds })
    expect(next.pod['a']).toBe('risk')
  })

  it('drops the desk in front of the one it was dropped onto', () => {
    const next = moveDesk(layout(), { id: 'c', department: 'trading', beforeId: 'a', allIds })
    expect(next.order).toEqual(['c', 'a', 'b'])
  })

  it('sends the desk to the back of the pod when dropped on empty floor', () => {
    const next = moveDesk(layout(), { id: 'a', department: 'trading', beforeId: null, allIds })
    expect(next.order).toEqual(['b', 'c', 'a'])
  })

  it('reorders rather than duplicating when the desk stays in its pod', () => {
    const next = moveDesk(layout({ order: allIds }), { id: 'a', department: 'trading', beforeId: 'c', allIds })
    expect(next.order).toEqual(['b', 'a', 'c'])
    expect(next.order.filter((x) => x === 'a')).toHaveLength(1)
  })

  it('treats a desk dropped on itself as a no-op', () => {
    const before = layout({ order: allIds })
    expect(moveDesk(before, { id: 'a', department: 'trading', beforeId: 'a', allIds })).toEqual(before)
  })

  it('does not mutate the layout it was given', () => {
    const before = layout({ order: ['a', 'b', 'c'], pod: {} })
    const snapshot = JSON.parse(JSON.stringify(before))
    moveDesk(before, { id: 'a', department: 'risk', beforeId: 'c', allIds })
    expect(before).toEqual(snapshot)
  })

  it('keeps desks it has never been told about', () => {
    const next = moveDesk(layout(), { id: 'a', department: 'risk', allIds })
    expect([...next.order].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('normalizeDeskLayout', () => {
  it('returns an empty arrangement for anything that is not one', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      expect(normalizeDeskLayout(junk)).toEqual(EMPTY_DESK_LAYOUT)
    }
  })

  it('keeps a well-formed arrangement', () => {
    const raw = { pod: { oracle: 'risk' }, order: ['oracle', 'keel'] }
    expect(normalizeDeskLayout(raw)).toEqual(raw)
  })

  it('drops pod entries naming a department this build does not have', () => {
    const out = normalizeDeskLayout({ pod: { oracle: 'accounting', keel: 'risk' }, order: [] })
    expect(out.pod).toEqual({ keel: 'risk' })
  })

  it('drops order entries that are not ids', () => {
    expect(normalizeDeskLayout({ pod: {}, order: ['ok', 7, null, 'fine'] }).order).toEqual(['ok', 'fine'])
  })

  it('survives a partially written record', () => {
    expect(normalizeDeskLayout({ order: ['a'] })).toEqual({ pod: {}, order: ['a'] })
    expect(normalizeDeskLayout({ pod: { a: 'risk' } })).toEqual({ pod: { a: 'risk' }, order: [] })
  })
})
