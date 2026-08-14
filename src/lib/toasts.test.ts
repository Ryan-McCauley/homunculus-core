import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// toasts.ts is a tiny in-memory pub/sub gated behind the `useToasts()` React
// hook: addToast/dismissToast mutate a module-level array and fan the new
// snapshot out to every subscribed `setToasts`. There's no jsdom/renderer in
// this project, so rather than mounting a real component we stub `react`'s
// useState/useEffect with trivial synchronous versions — useEffect just runs
// its callback immediately (registering the listener), and useState hands
// back a spy so we can assert exactly what each notify() delivered.
const hoisted = vi.hoisted(() => ({ lastSetState: null as any }))
vi.mock('react', () => ({
  useState: (init: unknown) => {
    const value = typeof init === 'function' ? (init as () => unknown)() : init
    hoisted.lastSetState = vi.fn()
    return [value, hoisted.lastSetState]
  },
  useEffect: (fn: () => void) => { fn() },
}))

// Each test re-imports the module after vi.resetModules() so the private
// `_toasts` array and `_listeners` set start fresh — they're not exported,
// so a full module reset is the only way to isolate tests from each other.
let mod: typeof import('./toasts')

beforeEach(async () => {
  vi.resetModules()
  hoisted.lastSetState = null
  mod = await import('./toasts')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('addToast / useToasts subscription', () => {
  it('starts with an empty toast list', () => {
    const { toasts } = mod.useToasts()
    expect(toasts).toEqual([])
  })

  it('notifies subscribers with the new toast on addToast', () => {
    mod.useToasts() // subscribes hoisted.lastSetState as a listener
    mod.addToast('hello world', { severity: 'warn', sub: 'details', icon: '!' })

    expect(hoisted.lastSetState).toHaveBeenCalledTimes(1)
    const delivered = hoisted.lastSetState.mock.calls[0][0]
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      message: 'hello world', severity: 'warn', sub: 'details', icon: '!',
    })
    expect(typeof delivered[0].id).toBe('string')
    expect(delivered[0].id.length).toBeGreaterThan(0)
  })

  it('defaults severity to "info" when not specified', () => {
    mod.useToasts()
    mod.addToast('plain message')
    const delivered = hoisted.lastSetState.mock.calls[0][0]
    expect(delivered[0].severity).toBe('info')
  })

  it('accumulates multiple toasts in order', () => {
    mod.useToasts()
    mod.addToast('first')
    mod.addToast('second')
    const delivered = hoisted.lastSetState.mock.calls[1][0]
    expect(delivered.map((t: any) => t.message)).toEqual(['first', 'second'])
  })
})

describe('dismissToast', () => {
  it('removes the toast with the matching id and notifies subscribers', () => {
    mod.useToasts()
    mod.addToast('to be dismissed')
    const id = hoisted.lastSetState.mock.calls[0][0][0].id

    mod.dismissToast(id)

    expect(hoisted.lastSetState).toHaveBeenCalledTimes(2)
    expect(hoisted.lastSetState.mock.calls[1][0]).toEqual([])
  })

  it('is a no-op when the id is not present', () => {
    mod.useToasts()
    mod.addToast('kept')
    mod.dismissToast('does-not-exist')

    const final = hoisted.lastSetState.mock.calls.at(-1)[0]
    expect(final).toHaveLength(1)
    expect(final[0].message).toBe('kept')
  })
})

describe('ttl auto-dismiss', () => {
  it('auto-dismisses after the default 7000ms ttl', () => {
    vi.useFakeTimers()
    mod.useToasts()
    mod.addToast('expires')

    vi.advanceTimersByTime(6999)
    expect(hoisted.lastSetState.mock.calls.at(-1)[0]).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(hoisted.lastSetState.mock.calls.at(-1)[0]).toEqual([])
  })

  it('honors a custom ttl', () => {
    vi.useFakeTimers()
    mod.useToasts()
    mod.addToast('expires fast', { ttl: 100 })

    vi.advanceTimersByTime(100)
    expect(hoisted.lastSetState.mock.calls.at(-1)[0]).toEqual([])
  })
})
