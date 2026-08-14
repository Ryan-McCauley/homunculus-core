// HTTP routes for the SCREENERS tab.
//
// Extracted from index.ts rather than inlined there so the routing has somewhere
// to be tested: index.ts's handler is one long function bound to a live server,
// while this is a plain (method, path, body) → (code, body) mapping with its store
// and engine injected. Returning `null` means "not my route", which is what lets
// index.ts try this first and fall through to everything else unchanged.
//
// The one rule worth stating: the id in the URL always wins. A run may carry an
// unsaved draft definition in its body — the rail is live, so editing a gate
// re-screens before anything is saved — but that draft is forced back onto the
// path's id before it runs. Otherwise a draft could quietly report itself as some
// other screener's results.

import {
  normalizeScreenerDef, validateScreenerDef,
  type ScreenerDef, type ScreenerResult,
} from '../shared/screener'
import type { CreateScreenerInput, StoreResult } from './screenerStore'

export interface ScreenerApiDeps {
  store: {
    list(): ScreenerDef[]
    get(id: string): ScreenerDef | undefined
    create(input: CreateScreenerInput): StoreResult
    update(id: string, patch: Partial<ScreenerDef>): StoreResult
    remove(id: string): StoreResult
  }
  run(screener: ScreenerDef): Promise<{ ok: boolean; result?: ScreenerResult; error: string }>
  /** Strategy gate snapshots offered as starting points, by id. */
  strategies: Record<string, { label: string }>
}

export interface ApiResponse { code: number; body: unknown }

const ROOT = '/api/crypto/screeners'

const fail = (code: number, error: string): ApiResponse => ({ code, body: { ok: false, error } })

/** A store failure is a 404 when the screener simply is not there, and a 400 when
 *  the request was understood but rejected. The distinction matters to the UI: one
 *  means "reload your list", the other means "fix your input". */
function storeFailure(result: StoreResult): ApiResponse {
  const error = (result.errors ?? ['request rejected']).join('; ')
  return fail(/^no screener named/.test(error) ? 404 : 400, error)
}

export async function handleScreenerRequest(
  method: string,
  path: string,
  body: Record<string, unknown>,
  deps: ScreenerApiDeps,
): Promise<ApiResponse | null> {
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null

  if (path === ROOT && method === 'GET') {
    return {
      code: 200,
      body: {
        ok: true,
        screeners: deps.store.list(),
        strategies: Object.entries(deps.strategies).map(([id, s]) => ({ id, label: s.label })),
      },
    }
  }

  if (path === ROOT && method === 'POST') {
    const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
    if (!name) return fail(400, 'name is required')
    const created = deps.store.create({
      name,
      timeframe: body['timeframe'] as CreateScreenerInput['timeframe'],
      universe: body['universe'] as CreateScreenerInput['universe'],
      gates: body['gates'] as CreateScreenerInput['gates'],
      copyFromId: typeof body['copyFromId'] === 'string' ? body['copyFromId'] : undefined,
      importStrategy: typeof body['importStrategy'] === 'string' ? body['importStrategy'] : undefined,
    })
    if (!created.ok) return storeFailure(created)
    return { code: 200, body: { ok: true, screener: created.screener } }
  }

  const rest = path.slice(ROOT.length + 1)

  if (rest.endsWith('/run') && method === 'POST') {
    const id = rest.slice(0, -'/run'.length)
    const saved = id ? deps.store.get(id) : undefined
    if (!saved) return fail(404, `no screener named ${id}`)

    // An unsaved draft re-screens live; the saved id is non-negotiable.
    let screener = saved
    const draft = body['screener']
    if (draft && typeof draft === 'object') {
      screener = normalizeScreenerDef({ ...(draft as Record<string, unknown>), id: saved.id })
      const check = validateScreenerDef(screener)
      if (!check.ok) return fail(400, check.errors.join('; '))
    }

    try {
      const outcome = await deps.run(screener)
      if (!outcome.ok) return fail(500, outcome.error)
      return { code: 200, body: { ok: true, result: outcome.result } }
    } catch (err) {
      return fail(500, err instanceof Error ? err.message : String(err))
    }
  }

  if (!rest.includes('/') && method === 'PATCH') {
    if (!rest) return fail(400, 'screener id is required')
    const patch: Partial<ScreenerDef> = {}
    if (typeof body['name'] === 'string') patch.name = body['name']
    if (body['timeframe']) patch.timeframe = body['timeframe'] as ScreenerDef['timeframe']
    if (body['universe']) patch.universe = body['universe'] as ScreenerDef['universe']
    if (body['gates'] && typeof body['gates'] === 'object') patch.gates = body['gates'] as ScreenerDef['gates']

    const updated = deps.store.update(rest, patch)
    if (!updated.ok) return storeFailure(updated)
    return { code: 200, body: { ok: true, screener: updated.screener } }
  }

  if (!rest.includes('/') && method === 'DELETE') {
    if (!rest) return fail(400, 'screener id is required')
    const removed = deps.store.remove(rest)
    if (!removed.ok) return storeFailure(removed)
    return { code: 200, body: { ok: true } }
  }

  return null
}
