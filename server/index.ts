// Homunculus backend. A single Node process (containerizable) that serves the
// web UI and multiplexes telemetry, the Computer Core, and the terminal over
// one WebSocket per client. Both the browser and the Electron shell are clients.

import 'dotenv/config'
import http from 'http'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { telemetryHub } from './telemetry'
import { ChatSession, chatStatus, addProactiveListener, proactiveMonitor, broadcastProactive } from './chat'
import { TerminalManager } from './terminal'
import { haHub } from './homeassistant'
import { executeRoutine, ROUTINES } from './routines'
import { compileIntent, compileOps, executePlan, type RawOp } from './agentIntent'
// Aliased: server/sync.ts already exports a buildManifest (the file manifest a
// peer node diffs against), and these two are unrelated.
import { buildManifest as buildAgentManifest } from '../shared/agentManifest'
import {
  abortFlow, deleteEntry, fetchDiscoveredFlows, getFlow, listEntries, listHandlers,
  reloadEntry, startFlow, submitStep,
} from './haConfigFlow'
import { normalizeFields, redactValues } from '../shared/haConfigFlow'
import { historyHub } from './history'
import { osintHub } from './osint'
import { archiveHub } from './archive'
import { homeWatcher } from './homewatch'
import { cryptoHub, autoPlanner } from './crypto'
import { alertStore } from './cryptoAlerts'
import { strategyRunner, isStrategyId, getEnabledStrategy, setEnabledStrategy } from './strategyRunner'
import { agentFleet, isAgentAutonomy, isAgentEvent } from './agents'
import { office, isDepartment, isEmploymentStatus, isSourceRef } from './office'
import { library } from './library'
import { blockerBoard } from './blockers'
import { managerFile } from './managerFile'
import { agentMayOpenThread } from '../shared/activeBoard'
import { newestStagePost } from '../shared/agentHandoff'
import { isArtifactFormat, isArtifactKind, isArtifactOutcome } from '../shared/library'
import { isBlockerSeverity } from '../shared/blockers'
import { screenerStore, STRATEGY_PRESETS } from './screenerStore'
import { handleScreenerRequest } from './screenerApi'
import { buildScreenerJob, runScreenerEngine, screenerInputsFromSnapshot } from './screenerRunner'
import {
  getAllStrategyDefinitions, getStrategySettings, getResolvedStrategySettings,
  setStrategySettings, resetStrategySettings,
  isKnownStrategyForSettings, createStrategyDefinition
} from './cryptoStrategySettings'
import { auditLog, withActor, currentActor } from './auditLog'
import { stateStore } from './stateStore'
import { claudeProcesses } from './claudeProcesses'
import { componentKind, componentLabel, edgeForAudit } from '../shared/timeline'
import type { TimelineComponent, TimelineEdge, TimelineEvent, TimelineRun } from '../shared/timeline'
import { ACTOR_HEADER, constantTimeEquals, deriveActor } from '../shared/audit'
import { isLocalReq, isAllowedOrigin, corsOrigin, securityHeaders, tokenVerdict, adminVerdict, type GateVerdict } from './httpGates'
import { serveStatic } from './staticFiles'
import { ALERT_SOURCES, ALERT_TIMEFRAMES } from '../shared/alerts'
import { getLayout, setLayout, resetLayout, isSetupComplete, markSetupComplete } from './layout'
import { buildManifest, getSyncConfig, readSyncFile, runSync, setSyncConfig, writeSyncFile } from './sync'
import { SYNC_AREAS } from '../shared/sync'
import { applyVault, status as secretStatus, moduleReadiness } from './secrets'
import { SECRET_SPECS } from '../shared/secrets'
import type { TelemetryMetric } from './history'
import type { ClientMsg, ServerMsg } from '../shared/protocol'
import { getBuildInfo } from '../shared/version'

// Resolved once at startup — version/commit don't change while the process runs.
const BUILD_INFO = getBuildInfo()

const PORT = Number(process.env['HOMUNCULUS_PORT'] || 8787)
const HOST = process.env['HOMUNCULUS_HOST'] || '0.0.0.0'
const TOKEN = process.env['HOMUNCULUS_TOKEN'] || ''

// A second, stronger secret that gates the few audit-log management routes.
// Unlike TOKEN this is NEVER waived for localhost: the whole point of the audit
// log is that the operator's own machine — where every agent and skill also runs
// — cannot quietly touch the record. Unset means those routes are simply closed.
const ADMIN_TOKEN = process.env['HOMUNCULUS_ADMIN_TOKEN'] || ''

// Where the built web UI lives; ./staticFiles serves it. Resolved, not merely
// joined: the traversal guard there compares a resolved candidate against this
// string, so an override carrying a trailing separator or a relative segment
// (HOMUNCULUS_WEB_DIR=./out/renderer/) would not match its own children and would
// 403 the entire UI.
const WEB_DIR = resolve(process.env['HOMUNCULUS_WEB_DIR'] || join(process.cwd(), 'out', 'renderer'))

// The HTTP security posture — the Origin gate, the token gate, the admin gate,
// the CORS reflection and the defensive headers — now lives in ./httpGates so it
// can be read and tested as one unit. The wrappers below bind this process's
// tokens and turn a verdict into a response; the behaviour is unchanged, and the
// full reasoning for each gate moved with it.
//
// A refused request gets the same defensive headers as a served one. They were
// missing here, which meant the responses most likely to be reached by something
// that should not be reaching them — a 401 or a 503 — were the only ones served
// without nosniff, frame-ancestors or a CSP. `vary: origin` matters for the same
// reason it does on the success path: the ACAO value is computed per caller, so a
// cache must not hand one origin's copy to another.
function refuse(req: http.IncomingMessage, res: http.ServerResponse, verdict: Extract<GateVerdict, { ok: false }>): false {
  res.writeHead(verdict.code, {
    'content-type': 'application/json',
    'access-control-allow-origin': corsOrigin(req),
    vary: 'origin',
    ...securityHeaders(),
  })
  res.end(JSON.stringify({ ok: false, error: verdict.error }))
  return false
}

function requireToken(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const verdict = tokenVerdict(req, TOKEN)
  return verdict.ok ? true : refuse(req, res, verdict)
}

function requireAdminToken(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const verdict = adminVerdict(req, ADMIN_TOKEN)
  return verdict.ok ? true : refuse(req, res, verdict)
}

// ── API routes ────────────────────────────────────────────────────────
async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string
): Promise<boolean> {
  // Every mutating request gets one audit entry here, whatever route handles it.
  // This is the safety net: a new route added later is audited the day it is
  // written, with no ceremony. Modules that can describe a change properly —
  // strategy settings, agents, alerts — also record a richer entry with
  // before/after snapshots, so those changes appear twice by design: once as
  // "someone called this endpoint", once as "and here is what it did".
  //
  // Bodies are not captured: they range from a two-field toggle to a full
  // strategy report, and some carry API detail we would rather not duplicate to
  // a file that is never rewritten. Failures are recorded too — a rejected
  // attempt is exactly the kind of thing an audit reader wants to see.
  const auditable = req.method !== 'GET' && req.method !== 'OPTIONS' && !path.startsWith('/api/audit')
  const json = (code: number, body: unknown): void => {
    // Reflects the caller's own Origin rather than '*' — see isAllowedOrigin
    // above, which has already rejected anything that shouldn't be here. A
    // caller with no Origin (curl, a peer node, a skill) never reads this
    // header at all, so '*' there is inert, not a grant.
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': corsOrigin(req),
      vary: 'origin',
      ...securityHeaders(),
    })
    res.end(JSON.stringify(body))
    if (auditable) {
      const ok = (body as { ok?: unknown } | null)?.ok
      const actor = currentActor()
      // An agent:/skill: actor on an 'http' entry is, structurally, always a
      // self-asserted claim: deriveActor only ever produces that shape from the
      // caller-supplied x-homunculus-actor header (see the comment where it's
      // read below), and nothing here cryptographically ties a request to a
      // specific agent the way HOMUNCULUS_TOKEN ties it to "some holder of the
      // token". Flagging it costs nothing and lets a reader of the log (or a
      // future admin view) tell "the fleet did this" apart from "someone with
      // the token said the fleet did this" — a distinction the audit log's own
      // stated purpose depends on. Richer per-feature entries recorded with
      // origin:'internal' (agent.trade.*, agent.run.*, …) are unaffected: those
      // set actor from a server-side record lookup, not a header, so the claim
      // there is already the authenticated one.
      const selfAsserted = actor.startsWith('agent:') || actor.startsWith('skill:')
      auditLog.record({
        actor,
        origin: 'http',
        action: `http.${(req.method || 'get').toLowerCase()}`,
        resource: path,
        summary: `${req.method} ${path} → ${code}`,
        meta: {
          method: req.method, path, status: code, ...(typeof ok === 'boolean' ? { ok } : {}),
          ...(selfAsserted ? { actorSelfAsserted: true } : {}),
        },
      })
    }
  }

  // Runs before every other check, including the CORS preflight below: a
  // request whose Origin doesn't belong to this server (or, in dev, the Vite
  // renderer) is refused outright. This is what actually stops a same-machine
  // browser page from reaching localhost-bypassed routes — requireToken alone
  // never could, since the browser IS the local caller as far as isLocalReq
  // can tell. See isAllowedOrigin's own comment for the full reasoning.
  if (!isAllowedOrigin(req)) {
    res.writeHead(403, { 'content-type': 'application/json', ...securityHeaders() })
    res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }))
    return true
  }

  // CORS preflight: the dev renderer (vite :5173) sends an OPTIONS preflight before any
  // cross-origin POST that carries `content-type: application/json`. Without this, those
  // POSTs fail with "Failed to fetch" while header-less POSTs/GETs (no preflight) work.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': corsOrigin(req),
      vary: 'origin',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-homunculus-token, x-homunculus-actor, x-homunculus-admin-token',
      'access-control-max-age': '86400',
      ...securityHeaders(),
    })
    res.end()
    return true
  }

  // GET /api/version  — build identity (semver + commit + build date)
  if (path === '/api/version' && req.method === 'GET') {
    return json(200, { ok: true, ...BUILD_INFO }), true
  }

  // ── Layout: tab order / enabled tabs / default tab / widget grids ─────
  // Server-side (not localStorage) so the Electron shell and the browser view
  // over Tailscale render the same dashboard. Token-gated like the other
  // personal-config routes.

  // GET /api/layout
  if (path === '/api/layout' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, layout: getLayout() }), true
  }

  // POST /api/layout  — replace the whole layout (body.layout)
  if (path === '/api/layout' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    return json(200, { ok: true, layout: setLayout(body['layout'] ?? body) }), true
  }

  // POST /api/layout/reset  — back to the shipped arrangement
  if (path === '/api/layout/reset' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, layout: resetLayout() }), true
  }

  // ── Node sync ─────────────────────────────────────────────────────────
  // Two audiences on the same routes. /config and /run are the operator's, from
  // the Settings → SYNC panel. /manifest and /file are the *peer's*: another
  // Homunculus backend on the tailnet reading and writing this node's data dir.
  //
  // That makes /file the widest route in this file, so it is worth being plain
  // about the gate. Reaching it means being on the tailnet AND holding
  // HOMUNCULUS_TOKEN (or being localhost) — the same bar as /api/crypto. What
  // it will then serve or accept is bounded twice over inside server/sync.ts:
  // the path must resolve under data/, and its area must be enabled HERE. A peer
  // names files, never locations, and never widens this node's own choices.

  // GET /api/sync/config  — peers (tokens redacted), areas, last run
  if (path === '/api/sync/config' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, config: getSyncConfig(), areas: SYNC_AREAS }), true
  }

  // POST /api/sync/config  — replace peers/areas. Peer tokens are write-only.
  if (path === '/api/sync/config' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    return json(200, { ok: true, config: setSyncConfig(body['config'] ?? body) }), true
  }

  // POST /api/sync/run  — the button: sync every enabled peer, both directions
  if (path === '/api/sync/run' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    try {
      return json(200, { ok: true, report: await runSync() }), true
    } catch (err) {
      return json(500, { ok: false, error: (err as Error).message }), true
    }
  }

  // GET /api/sync/manifest?areas=a,b  — what this node holds, for a peer to diff
  if (path === '/api/sync/manifest' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const url = new URL(req.url || '', 'http://localhost')
    const raw = url.searchParams.get('areas')
    const areas = raw === null ? undefined : raw.split(',').map((a) => a.trim()).filter(Boolean)
    return json(200, { ok: true, manifest: buildManifest(areas) }), true
  }

  // GET /api/sync/file?path=…  — one file, base64, with its mtime
  if (path === '/api/sync/file' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const url = new URL(req.url || '', 'http://localhost')
    const result = readSyncFile(url.searchParams.get('path') ?? '')
    return json(result.ok ? 200 : 400, result), true
  }

  // POST /api/sync/file  — a peer hands us a file it holds newer. A larger cap
  // than the general body reader: base64 inflates a file by ~1/3, so matching
  // sync.ts's own 32 MB MAX_FILE_BYTES needs headroom past that, not up to it.
  if (path === '/api/sync/file' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const raw = await readRawBody(req, 48 * 1024 * 1024)
    if (raw === null) return json(413, { ok: false, error: 'payload too large' }), true
    let body: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' }), true
    }
    const result = writeSyncFile(
      String(body['path'] ?? ''),
      String(body['content'] ?? ''),
      Number(body['mtime'] ?? 0)
    )
    return json(result.ok ? 200 : 400, result), true
  }

  // ── Secrets ───────────────────────────────────────────────────────────
  // Read server/secrets.ts before touching these. Values move client → server
  // ONLY, and only from localhost. Nothing here returns a plaintext secret.

  // GET /api/secrets  — catalogue + presence. No values.
  if (path === '/api/secrets' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const local = isLocalReq(req)
    return json(200, {
      ok: true,
      specs: SECRET_SPECS,
      secrets: secretStatus(),
      modules: moduleReadiness(),
      capability: {
        // The client additionally requires window.homunculusVault (Electron).
        // A browser on localhost passes this check but has no vault, and its
        // KEYS panel stays read-only — both gates have to hold.
        writable: local,
        reason: local ? '' : 'Keys can only be set from the Electron app on the machine running the backend. Remote sessions read them from .env.',
      },
    }), true
  }

  // POST /api/secrets/unlock  — Electron main pushes the decrypted vault in.
  // LOCALHOST ONLY, unconditionally: a credential must never cross the network,
  // so this deliberately ignores HOMUNCULUS_TOKEN rather than accepting it as
  // proof of authorisation from a remote caller.
  if (path === '/api/secrets/unlock' && req.method === 'POST') {
    if (!isLocalReq(req)) {
      return json(403, { ok: false, error: 'unlock is localhost-only' }), true
    }
    const body = await readBody(req)
    const secrets = body['secrets']
    if (!secrets || typeof secrets !== 'object') {
      return json(400, { ok: false, error: 'body.secrets required' }), true
    }
    const { applied, ignored } = applyVault(secrets as Record<string, unknown>)
    return json(200, { ok: true, applied, ignored, secrets: secretStatus() }), true
  }

  // ── First-run setup ───────────────────────────────────────────────────

  // GET /api/setup  — has the wizard been completed?
  if (path === '/api/setup' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, complete: isSetupComplete() }), true
  }

  // POST /api/setup  — mark complete (body.complete, default true)
  if (path === '/api/setup' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const complete = body['complete'] !== false
    markSetupComplete(complete)
    return json(200, { ok: true, complete }), true
  }

  // POST /api/proactive/trigger  — fire a proactive check right now
  if (path === '/api/proactive/trigger' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const snap = haHub.getLatest()
    if (!snap?.connected) return json(503, { ok: false, error: 'HA offline' }), true
    proactiveMonitor.triggerNow(snap)
    return json(200, { ok: true, message: 'Proactive check triggered' }), true
  }

  // POST /api/proactive/say  — broadcast a custom message to all clients
  if (path === '/api/proactive/say' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const text = body.text as string
    if (!text) return json(400, { ok: false, error: 'body.text required' }), true
    broadcastProactive(text)
    return json(200, { ok: true }), true
  }

  // POST /api/routine/:name  — execute a named routine. Gated: several routines
  // (open the charge port, start charging) act on physical hardware.
  if (path.startsWith('/api/routine/') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const name = path.slice('/api/routine/'.length)
    const result = await executeRoutine(name)
    return json(result.ok ? 200 : 400, result), true
  }

  // GET /api/routines  — list available routines
  if (path === '/api/routines' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const list = Object.entries(ROUTINES).map(([key, r]) => ({ key, label: r.label, description: r.description }))
    return json(200, list), true
  }

  // ── Devices: adding and removing Home Assistant integrations ────────────
  //
  // OPERATOR ONLY, BY CONSTRUCTION. None of this is reachable from the agent
  // uplink: /api/agent/intent executes manifest actions, a manifest action is an
  // HA *service* call, and a config flow is not a service — it is a different API
  // that these routes are the only path to. That separation is deliberate.
  // Adding an integration means typing credentials and granting a new piece of
  // software access to the house, which is a decision for the person, not for
  // something compiling intent out of free text.

  // GET /api/ha/integrations  — every integration domain that can be set up
  if (path === '/api/ha/integrations' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    try {
      return json(200, { ok: true, handlers: await listHandlers() }), true
    } catch (err) {
      return json(502, { ok: false, error: (err as Error).message }), true
    }
  }

  // GET /api/ha/entries  — integrations already configured
  if (path === '/api/ha/entries' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    try {
      return json(200, { ok: true, entries: await listEntries() }), true
    } catch (err) {
      return json(502, { ok: false, error: (err as Error).message }), true
    }
  }

  // GET /api/ha/discovered  — devices HA found on the network but nobody has set
  // up yet. Websocket-only upstream, and empty rather than fatal when unavailable.
  if (path === '/api/ha/discovered' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, flows: await fetchDiscoveredFlows() }), true
  }

  // POST /api/ha/flow  — begin adding an integration
  if (path === '/api/ha/flow' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const handler = typeof body['handler'] === 'string' ? body['handler'] : ''
    if (!handler) return json(400, { ok: false, error: 'body.handler required' }), true
    const outcome = await startFlow(handler)
    auditLog.note({
      action: 'ha.config_flow.start',
      resource: `integration:${handler}`,
      summary: `started a config flow for ${handler}`,
    })
    return json(200, outcome), true
  }

  // GET|POST|DELETE /api/ha/flow/:flowId  — read, advance, or cancel a flow
  if (path.startsWith('/api/ha/flow/')) {
    if (!requireToken(req, res)) return true
    const flowId = path.slice('/api/ha/flow/'.length)

    if (req.method === 'GET') return json(200, await getFlow(flowId)), true

    if (req.method === 'DELETE') {
      auditLog.note({ action: 'ha.config_flow.abort', resource: `flow:${flowId}`, summary: 'aborted a config flow' })
      return json(200, await abortFlow(flowId)), true
    }

    if (req.method === 'POST') {
      const body = await readBody(req)
      const values = (body['values'] ?? {}) as Record<string, unknown>

      // The audit entry is written from a REDACTED copy, and the redaction needs
      // the step's own schema to know which fields are credentials — so the
      // current step is read back first. If that read fails we pass no schema,
      // and redactValues fails closed and masks everything. This log is
      // append-only and never rewritten: a password written here is written
      // permanently, so the safe direction is the only acceptable one.
      const current = await getFlow(flowId)
      const fields = current.ok ? normalizeFields(current.step.data_schema as never) : []
      auditLog.note({
        action: 'ha.config_flow.step',
        resource: `flow:${flowId}`,
        summary: `submitted step ${current.ok ? current.step.step_id ?? '?' : '?'} of a config flow`,
        meta: { handler: current.ok ? current.step.handler : undefined, values: redactValues(values, fields) },
      })

      return json(200, await submitStep(flowId, values)), true
    }
  }

  // DELETE /api/ha/entries/:entryId  — remove an integration entirely
  if (path.startsWith('/api/ha/entries/') && req.method === 'DELETE') {
    if (!requireToken(req, res)) return true
    const entryId = path.slice('/api/ha/entries/'.length)
    const result = await deleteEntry(entryId)
    auditLog.note({
      action: 'ha.config_entry.delete',
      resource: `entry:${entryId}`,
      summary: `removed config entry ${entryId}`,
      meta: { ok: result.ok },
    })
    return json(result.ok ? 200 : 400, result), true
  }

  // POST /api/ha/entries/:entryId/reload  — reload an integration in place
  if (path.startsWith('/api/ha/entries/') && path.endsWith('/reload') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const entryId = path.slice('/api/ha/entries/'.length, -'/reload'.length)
    return json(200, await reloadEntry(entryId)), true
  }

  // GET /api/agent/manifest  — the HOME tab's action contract, derived from the
  // live entity list. An agent reads this instead of inferring what it can do
  // from the rendered page: every route, every action id, its payload schema,
  // and the guardrail tier that decides whether it may act alone.
  if (path === '/api/agent/manifest' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, ...buildAgentManifest(haHub.getLatest()?.entities ?? []) }), true
  }

  // POST /api/agent/intent  — the uplink. Takes { text } or { ops }, compiles a
  // plan, and executes it unless dry_run. The ⌘K palette and an autonomous agent
  // both come through here, so there is one validator and one audit trail
  // regardless of who asked.
  //
  // Confirm-tier ops never execute on this call's say-so: `confirm` lists op
  // NUMBERS a human approved, and anything confirm-tier without its number in
  // that list comes back `held` for the operator to release.
  if (path === '/api/agent/intent' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const entities = haHub.getLatest()?.entities ?? []
    const manifest = buildAgentManifest(entities)

    const rawOps = Array.isArray(body['ops']) ? body['ops'] as RawOp[] : null
    const text = typeof body['text'] === 'string' ? body['text'] : ''
    if (!rawOps && !text.trim()) {
      return json(400, { ok: false, error: 'body.text or body.ops required' }), true
    }

    const plan = rawOps ? compileOps(rawOps, manifest) : compileIntent(text, manifest, entities)
    const confirmed = Array.isArray(body['confirm'])
      ? (body['confirm'] as unknown[]).filter((n): n is number => typeof n === 'number')
      : []
    const dryRun = body['dry_run'] === true
    const result = await executePlan(plan, manifest, { confirmed, dryRun, actor: currentActor() })
    return json(200, { ok: result.ok, plan, result }), true
  }

  // GET /api/history/telemetry?metric=cpu_load&from=<ms>&to=<ms>&limit=500
  if (path === '/api/history/telemetry' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const q = new URL(req.url || '', 'http://localhost').searchParams
    const metric = (q.get('metric') || 'cpu_load') as TelemetryMetric
    const now = Date.now()
    const from = Number(q.get('from') || now - 24 * 60 * 60 * 1000)
    const to = Number(q.get('to') || now)
    const limit = Math.min(Number(q.get('limit') || 500), 5000)
    const points = await historyHub.queryTelemetry(metric, from, to, limit)
    return json(200, { metric, points }), true
  }

  // GET /api/history/ha?entity_id=sensor.voltaire_battery_level&from=<ms>&to=<ms>&limit=500
  if (path === '/api/history/ha' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const q = new URL(req.url || '', 'http://localhost').searchParams
    const entityId = q.get('entity_id') || ''
    if (!entityId) return json(400, { ok: false, error: 'entity_id required' }), true
    const now = Date.now()
    const from = Number(q.get('from') || now - 24 * 60 * 60 * 1000)
    const to = Number(q.get('to') || now)
    const limit = Math.min(Number(q.get('limit') || 500), 5000)
    const points = await historyHub.queryHa(entityId, from, to, limit)
    return json(200, { entity_id: entityId, points }), true
  }

  // GET /api/history/entities  — list all HA entity IDs that have history
  if (path === '/api/history/entities' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const entities = await historyHub.listHaEntities()
    return json(200, { entities }), true
  }

  // ── Screeners ─────────────────────────────────────────────────────────
  // Routing lives in screenerApi.ts so it can be tested without a live server;
  // this block only supplies the store, the engine, and the market data the job
  // is built from. A null return means the path was not a screener route.
  if (path.startsWith('/api/crypto/screeners')) {
    if (!requireToken(req, res)) return true
    const body = req.method === 'GET' ? {} : await readBody(req)
    const handled = await handleScreenerRequest(req.method || 'GET', path, body, {
      store: screenerStore,
      strategies: STRATEGY_PRESETS,
      run: async (screener) => runScreenerEngine(buildScreenerJob(
        screener,
        screenerInputsFromSnapshot(
          cryptoHub.getSnapshot(),
          (symbol, tf) => cryptoHub.getCandles(symbol, tf as Parameters<typeof cryptoHub.getCandles>[1]),
          cryptoHub.getMarketCaps(),
          cryptoHub.getCmcVolumes(),
        ),
        Date.now(),
      )),
    })
    if (handled) return json(handled.code, handled.body), true
  }

  // ── Crypto (token-gated for non-localhost) ────────────────────────────
  if (path === '/api/crypto/snapshot' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, snapshot: cryptoHub.getSnapshot() }), true
  }

  // GET /api/crypto/positions — the open-position slice only. The BRIDGE widgets are
  // mounted app-wide and poll every 6s; serving them the full snapshot meant ~750 KB of
  // signals/tradeHistory/planReports parsed and discarded on every tick, on every tab.
  if (path === '/api/crypto/positions' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, snapshot: cryptoHub.getPositionsSnapshot() }), true
  }

  if (path === '/api/crypto/trades' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, trades: cryptoHub.getTrades() }), true
  }

  // ── MARKET indicator alerts ───────────────────────────────────────────
  // GET /api/crypto/alerts[?symbol=BTCUSD] — armed + fired alerts.
  if (path === '/api/crypto/alerts' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const symbol = new URL(req.url || '', 'http://localhost').searchParams.get('symbol')
    return json(200, { ok: true, alerts: symbol ? alertStore.listFor(symbol) : alertStore.list() }), true
  }

  // GET /api/crypto/alerts/sources — the catalog of source/condition ids.
  // Exposed because the ids are exact and unguessable: an agent (or a skill) that
  // cannot enumerate them has to invent them, and every near-miss is a 400.
  if (path === '/api/crypto/alerts/sources' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, sources: ALERT_SOURCES, timeframes: ALERT_TIMEFRAMES }), true
  }

  // POST /api/crypto/alerts — arm a new alert.
  if (path === '/api/crypto/alerts' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const input = await readBody(req) as unknown as import('./cryptoAlerts.ts').NewAlertInput
    if (!input.symbol || !input.source || !input.condition) {
      return json(400, { ok: false, error: 'symbol, source, condition required' }), true
    }
    const result = alertStore.create(input)
    if ('error' in result) return json(400, { ok: false, error: result.error }), true
    return json(200, { ok: true, alert: result }), true
  }

  // POST /api/crypto/alerts/:id/arm  — pause or re-arm without deleting.
  if (path.startsWith('/api/crypto/alerts/') && path.endsWith('/arm') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const id = path.split('/')[4] ?? ''
    const body = await readBody(req)
    return json(200, { ok: alertStore.setArmed(id, body.armed !== false) }), true
  }

  // DELETE /api/crypto/alerts/:id
  if (path.startsWith('/api/crypto/alerts/') && req.method === 'DELETE') {
    if (!requireToken(req, res)) return true
    const id = path.split('/')[4] ?? ''
    return json(200, { ok: alertStore.remove(id) }), true
  }

  // GET /api/crypto/closed-trades — realized round-trip ledger + per-strategy win rate.
  if (path === '/api/crypto/closed-trades' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const { trades, stats } = cryptoHub.getClosedTrades()
    return json(200, { ok: true, trades, stats }), true
  }

  // POST /api/crypto/trades/purge  — remove trade-log records from the TRADES tab.
  //   Body { status?: 'executed'|'dismissed'|'failed', olderThanMin?: number }.
  //   Removes records matching BOTH criteria (status AND age). Live orders untouched.
  if (path === '/api/crypto/trades/purge' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const status = typeof body.status === 'string' ? body.status : undefined
    const olderThanMin = typeof body.olderThanMin === 'number' ? body.olderThanMin : undefined
    const result = cryptoHub.purgeTrades({
      status: status as import('../shared/crypto.ts').TradeRecord['status'] | undefined,
      olderThanMs: olderThanMin != null ? olderThanMin * 60_000 : undefined,
    })
    return json(200, { ok: true, ...result }), true
  }

  if (path === '/api/crypto/refresh' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    // non-blocking — client will re-poll
    void cryptoHub.fullRefresh()
    return json(200, { ok: true }), true
  }

  if (path.startsWith('/api/crypto/candles/') && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const parts = path.split('/')
    const symbol = parts[4] ?? ''
    const tf = parts[5] ?? '1hr'
    const candles = await cryptoHub.getCandlesFresh(symbol, tf)
    return json(200, { ok: true, candles }), true
  }

  // Auto-plan controls. Plans are keyed by their primary symbol (steps[0].symbol) — the
  // engine runs one plan per symbol concurrently; only same-symbol plans serialize. Most
  // endpoints below accept an optional `?symbol=` query param to target a specific plan;
  // omitted, they resolve only when there's exactly one unambiguous candidate.
  const url = new URL(req.url || '', 'http://localhost')
  if (path === '/api/crypto/autoplan/start' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const steps = body.steps as import('../shared/crypto.ts').AutoStep[] | undefined
    const started = autoPlanner.start(steps)
    return json(started ? 200 : 409, { ok: started, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Stage steps for review without executing — skill should call this instead of /start
  if (path === '/api/crypto/autoplan/propose' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const rawSteps = body.steps as import('../shared/crypto.ts').AutoStep[] | undefined
    const label = (body.label as string | undefined) ?? `Plan — ${new Date().toLocaleString()}`
    if (!rawSteps?.length) return json(400, { ok: false, error: 'steps required' }), true
    // A top-level `strategy` stamps every step, so a skill sets ownership once per call; a
    // step may still override it (a plan that pairs legs from two tracks).
    const planStrategy = typeof body.strategy === 'string' ? body.strategy : undefined
    const steps = planStrategy ? rawSteps.map((s) => ({ ...s, strategy: s.strategy ?? planStrategy })) : rawSteps
    const proposed = autoPlanner.propose(steps, label)
    if (!proposed) {
      return json(409, { ok: false, error: 'A plan for this symbol is already active — stop it first before proposing a new one. (Different symbols do not block each other.)', statuses: autoPlanner.getAllStatuses() }), true
    }
    return json(200, { ok: true, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Confirm a staged proposal and begin execution. ?symbol= required when more than one
  // plan is staged for review at once.
  if (path === '/api/crypto/autoplan/confirm' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const symbol = url.searchParams.get('symbol') ?? undefined
    const ok = autoPlanner.confirmProposal(symbol)
    return json(ok ? 200 : 409, { ok, error: ok ? undefined : 'Could not confirm — pass ?symbol= to disambiguate which staged plan to confirm.', statuses: autoPlanner.getAllStatuses() }), true
  }

  // Edit a single step's prices before confirming. Optional `symbol` in the body
  // disambiguates when step ids (e.g. "step_1") collide across different symbols' plans.
  if (path.startsWith('/api/crypto/autoplan/step/') && req.method === 'PATCH') {
    if (!requireToken(req, res)) return true
    const stepId = path.split('/')[5]
    if (!stepId) return json(400, { ok: false, error: 'stepId required' }), true
    const body = await readBody(req)
    const ok = autoPlanner.patchStep(stepId, {
      limitPrice: body.limitPrice as string | undefined,
      stopPrice: body.stopPrice as string | undefined,
      amountSpec: body.amountSpec as string | undefined,
      tp1Price: body.tp1Price as string | undefined,
      approved: body.approved as boolean | undefined,
    }, body.symbol as string | undefined)
    return json(ok ? 200 : 400, { ok, error: ok ? undefined : 'Step not found or its plan is active' }), true
  }

  // Lock/unlock a live managed bracket — while locked, the auto-trade monitor freezes the
  // trade exactly as-is (no TP scale-out, final exit, trailing ratchet, or time-stop exit).
  if (path === '/api/crypto/bracket/lock' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const symbol = body.symbol as string | undefined
    const locked = body.locked as boolean | undefined
    if (!symbol || typeof locked !== 'boolean') return json(400, { ok: false, error: 'symbol and locked (boolean) required' }), true
    const result = autoPlanner.lockBracket(symbol, locked)
    return json(result.ok ? 200 : 400, result), true
  }

  // Kill switch for a specific plan. ?symbol= required when more than one plan is active.
  if (path === '/api/crypto/autoplan/stop' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    autoPlanner.stop(url.searchParams.get('symbol') ?? undefined)
    return json(200, { ok: true }), true
  }

  // Clear a plan entirely. ?symbol= required when more than one plan exists.
  if (path === '/api/crypto/autoplan/reset' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    // force=1 overrides the naked-sell guard (see AutoPlanner.stop). Without it, a reset that
    // would orphan a filled-but-unhedged BTC ladder sell is refused.
    const forced = url.searchParams.get('force') === '1'
    const ok = autoPlanner.reset(url.searchParams.get('symbol') ?? undefined, forced)
    return json(ok ? 200 : 409, { ok, ...(ok ? {} : { error: 'reset refused: a filled BTC ladder sell has no placed rebuy — reset would orphan it into a naked sell. Adjust the rebuy in place, or retry with force=1.' }) }), true
  }

  if (path === '/api/crypto/autoplan/status' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const symbol = url.searchParams.get('symbol') ?? undefined
    return json(200, { ok: true, status: autoPlanner.getStatus(symbol), statuses: autoPlanner.getAllStatuses() }), true
  }

  // ── Managed bracket (confirm-first entry, then autonomous stop/TP/OCO/trail/time-stop) ──
  // Stage a bracket: body { label, bracket: BracketSpec }. Confirm-first like autoplan/propose.
  // Brackets for different symbols run concurrently — only the SAME symbol serializes.
  if (path === '/api/crypto/bracket/propose' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const spec = body.bracket as import('../shared/crypto.ts').BracketSpec | undefined
    if (!spec?.symbol || !spec.entry?.limitPrice || !spec.entry?.amountSpec) {
      return json(400, { ok: false, error: 'bracket spec with entry.limitPrice + entry.amountSpec required' }), true
    }
    const label = (body.label as string | undefined) ?? `Bracket — ${spec.symbol}`
    const step: import('../shared/crypto.ts').AutoStep = {
      id: `bracket_${Date.now()}`, label, symbol: spec.symbol, side: 'buy', type: 'limit',
      amountSpec: spec.entry.amountSpec, kind: 'bracket', bracket: spec,
      reason: label, status: 'pending',
      // Ownership from either the body or the spec — the step is built here, so without this
      // every bracket would be 'unattributed' and exempt from its own strategy's caps.
      strategy: (typeof body.strategy === 'string' ? body.strategy : undefined) ?? spec.strategy,
    }
    const proposed = autoPlanner.propose([step], label)
    if (!proposed) {
      return json(409, { ok: false, error: `A plan for ${spec.symbol} is already active — stop it first before proposing a new bracket for the same symbol. (Other symbols are unaffected.)`, statuses: autoPlanner.getAllStatuses() }), true
    }
    return json(200, { ok: true, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Confirm a staged bracket and begin the managed lifecycle (alias of autoplan/confirm).
  // ?symbol= required when more than one bracket is staged at once.
  if (path === '/api/crypto/bracket/confirm' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const symbol = url.searchParams.get('symbol') ?? undefined
    const ok = autoPlanner.confirmProposal(symbol)
    return json(ok ? 200 : 409, { ok, error: ok ? undefined : 'Could not confirm — pass ?symbol= to disambiguate which staged bracket to confirm.', statuses: autoPlanner.getAllStatuses() }), true
  }

  // Kill switch — cancels one bracket's live orders and ends that plan. ?symbol= required
  // when more than one bracket is active (never guesses which to kill).
  if (path === '/api/crypto/bracket/stop' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    autoPlanner.stop(url.searchParams.get('symbol') ?? undefined)
    return json(200, { ok: true, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Adjust a LIVE bracket's stop / take-profit levels as the market moves.
  //   ?symbol=  (required)   body { stopPrice?, tp1Price?, tp2Price?, trailPct?, note?, mode? }
  //   mode 'confirm' (default) stages the change for review (bracket/adjust/confirm applies it);
  //   mode 'auto' applies it immediately. Widening a stop is allowed but flagged in the result.
  if (path === '/api/crypto/bracket/adjust' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const symbol = url.searchParams.get('symbol') ?? undefined
    if (!symbol) return json(400, { ok: false, error: '?symbol= required' }), true
    const body = await readBody(req)
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined)
    const req2 = {
      stopPrice: num(body.stopPrice), tp1Price: num(body.tp1Price),
      tp2Price: num(body.tp2Price), trailPct: num(body.trailPct),
      note: typeof body.note === 'string' ? body.note : undefined,
    }
    if (req2.stopPrice === undefined && req2.tp1Price === undefined && req2.tp2Price === undefined && req2.trailPct === undefined) {
      return json(400, { ok: false, error: 'at least one of stopPrice/tp1Price/tp2Price/trailPct required' }), true
    }
    const mode = body.mode === 'auto' ? 'auto' : 'confirm'
    const result = mode === 'auto'
      ? await autoPlanner.autoBracketAdjust(symbol, req2)
      : autoPlanner.proposeBracketAdjust(symbol, req2)
    return json(result.ok ? 200 : 409, { ...result, mode, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Confirm a staged (confirm-first) bracket adjustment. ?symbol= required.
  if (path === '/api/crypto/bracket/adjust/confirm' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const symbol = url.searchParams.get('symbol') ?? undefined
    if (!symbol) return json(400, { ok: false, error: '?symbol= required' }), true
    const result = await autoPlanner.confirmBracketAdjust(symbol)
    return json(result.ok ? 200 : 409, { ...result, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Discard a staged (unconfirmed) bracket adjustment. ?symbol= required.
  if (path === '/api/crypto/bracket/adjust/cancel' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const symbol = url.searchParams.get('symbol') ?? undefined
    if (!symbol) return json(400, { ok: false, error: '?symbol= required' }), true
    const result = autoPlanner.cancelBracketAdjust(symbol)
    return json(result.ok ? 200 : 409, { ...result, statuses: autoPlanner.getAllStatuses() }), true
  }

  // Multi-timeframe market history for the skill: body { symbols: string[], tfs?: string[] }
  if (path === '/api/crypto/market-history' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const symbols = body.symbols as string[] | undefined
    const tfs = body.tfs as ('1m' | '5m' | '15m' | '1hr' | '1day')[] | undefined
    if (!symbols?.length) return json(400, { ok: false, error: 'symbols required' }), true
    const history = await cryptoHub.getMarketHistory(symbols, tfs)
    return json(200, { ok: true, history }), true
  }

  if (path === '/api/crypto/stage' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readRawBody(req)
    if (body === null) return json(413, { ok: false, error: 'payload too large' }), true
    try {
      const payload = JSON.parse(body) as {
        symbol: string; side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop-limit'
        amount: string; price?: string; stopPrice?: string
        orderOptions?: ('maker-or-cancel' | 'immediate-or-cancel' | 'fill-or-kill')[]
        reason: string; tag?: string
      }
      if (!payload.symbol || !payload.side || !payload.amount) {
        return json(400, { ok: false, error: 'symbol, side, amount required' }), true
      }
      const trade = cryptoHub.addPending(payload)
      return json(200, { ok: true, trade }), true
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' }), true
    }
  }

  if (path.startsWith('/api/crypto/trade/') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const parts = path.split('/')
    const id = parts[4]
    const action = parts[5]
    if (action === 'execute') {
      const result = await cryptoHub.executeTrade(id)
      return json(result.ok ? 200 : 500, result), true
    }
    if (action === 'dismiss') {
      cryptoHub.dismissTrade(id)
      return json(200, { ok: true }), true
    }
    return json(404, { ok: false, error: 'unknown action' }), true
  }

  // POST /api/crypto/order/:orderId/cancel  — cancel a live Gemini order
  if (path.startsWith('/api/crypto/order/') && path.endsWith('/cancel') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const orderId = path.split('/')[4]
    if (!orderId) return json(400, { ok: false, error: 'orderId required' }), true
    const result = await cryptoHub.cancelOpenOrder(orderId)
    return json(result.ok ? 200 : 500, result), true
  }

  // POST /api/crypto/order/:orderId/close  — cancel a resting order and re-open it as a
  // marketable limit at the current price, closing the position now.
  if (path.startsWith('/api/crypto/order/') && path.endsWith('/close') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const orderId = path.split('/')[4]
    if (!orderId) return json(400, { ok: false, error: 'orderId required' }), true
    const result = await cryptoHub.closePosition(orderId)
    return json(result.ok ? 200 : 500, result), true
  }

  // POST /api/crypto/position/:symbol/close  — cancel all resting orders for a symbol and
  // sell 100% of the held quantity as a single limit order 0.1% above the current market price.
  if (path.startsWith('/api/crypto/position/') && path.endsWith('/close') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const symbol = path.split('/')[4]
    if (!symbol) return json(400, { ok: false, error: 'symbol required' }), true
    const result = await cryptoHub.closeSymbolPosition(symbol)
    return json(result.ok ? 200 : 500, result), true
  }

  // POST /api/crypto/order/:orderId/modify  — cancel-and-replace a resting order with new
  // price/amount (and stop trigger for stop-limits). Body: { price?, amount?, stopPrice? }.
  if (path.startsWith('/api/crypto/order/') && path.endsWith('/modify') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const orderId = path.split('/')[4]
    if (!orderId) return json(400, { ok: false, error: 'orderId required' }), true
    const body = await readBody(req)
    const patch: { price?: string; amount?: string; stopPrice?: string } = {}
    if (body.price !== undefined) patch.price = String(body.price)
    if (body.amount !== undefined) patch.amount = String(body.amount)
    if (body.stopPrice !== undefined) patch.stopPrice = String(body.stopPrice)
    const result = await cryptoHub.modifyOpenOrder(orderId, patch)
    return json(result.ok ? 200 : 400, result), true
  }

  // POST /api/crypto/order/:orderId/safe-mode  — arm/adjust/disarm a software-side stop.
  //   { enabled: true, stopPct: number, exitPct: number }          → arm (re-bases to current price)
  //   { adjust: true, stopPct?, exitPct?, triggerPrice? }          → move/alter IN PLACE (order untouched)
  //   { enabled: false }                                           → disarm
  if (path.startsWith('/api/crypto/order/') && path.endsWith('/safe-mode') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const orderId = path.split('/')[4]
    if (!orderId) return json(400, { ok: false, error: 'orderId required' }), true
    const body = await readBody(req)
    if (body.enabled === false) {
      return json(200, cryptoHub.disarmSafeMode(orderId)), true
    }
    if (body.adjust === true) {
      // Only forward fields that were actually supplied so unspecified ones stay put.
      const opts: { stopPct?: number; exitPct?: number; triggerPrice?: number } = {}
      if (body.stopPct !== undefined) opts.stopPct = Number(body.stopPct)
      if (body.exitPct !== undefined) opts.exitPct = Number(body.exitPct)
      if (body.triggerPrice !== undefined) opts.triggerPrice = Number(body.triggerPrice)
      const result = cryptoHub.adjustSafeMode(orderId, opts)
      return json(result.ok ? 200 : 400, result), true
    }
    const stopPct = Number(body.stopPct)
    const exitPct = Number(body.exitPct)
    if (!(stopPct > 0) || !(exitPct >= 0)) {
      return json(400, { ok: false, error: 'stopPct must be > 0 and exitPct ≥ 0' }), true
    }
    const result = cryptoHub.armSafeMode(orderId, stopPct, exitPct)
    return json(result.ok ? 200 : 400, result), true
  }

  // GET/POST /api/crypto/loop-mode  — read or set the auto-run-after-close toggle.
  if (path === '/api/crypto/loop-mode' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { enabled: cryptoHub.getLoopMode() }), true
  }
  if (path === '/api/crypto/loop-mode' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const enabled = cryptoHub.setLoopMode(!!body.enabled)
    return json(200, { ok: true, enabled }), true
  }

  // GET/POST /api/crypto/strategy/interval  — read or set the auto-run interval (minutes; 0 = off).
  if (path === '/api/crypto/strategy/interval' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, minutes: cryptoHub.getStrategyInterval() }), true
  }
  if (path === '/api/crypto/strategy/interval' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const minutes = cryptoHub.setStrategyInterval(Number(body.minutes))
    return json(200, { ok: true, minutes }), true
  }

  // GET /api/crypto/strategy/intervals  — per-strategy auto-run intervals (minutes; 0/absent = off).
  // Setting any of these makes the universal interval above go inert — see armIntervalTimer.
  if (path === '/api/crypto/strategy/intervals' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, intervals: cryptoHub.getStrategyIntervals() }), true
  }
  // POST /api/crypto/strategy/intervals?strategy=<id>  — set/clear one strategy's interval.
  if (path === '/api/crypto/strategy/intervals' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const strategy = url.searchParams.get('strategy')
    if (!isStrategyId(strategy)) return json(400, { ok: false, error: 'unknown strategy' }), true
    const body = await readBody(req)
    const intervals = cryptoHub.setStrategyIntervalFor(strategy, Number(body.minutes))
    return json(200, { ok: true, intervals }), true
  }

  // POST /api/crypto/plan-report  — skill posts markdown trade plan status here
  if (path === '/api/crypto/plan-report' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readRawBody(req)
    if (body === null) return json(413, { ok: false, error: 'payload too large' }), true
    try {
      const { report } = JSON.parse(body) as { report: string }
      if (typeof report !== 'string') return json(400, { ok: false, error: 'report string required' }), true
      cryptoHub.setPlanReport(report)
      return json(200, { ok: true }), true
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' }), true
    }
  }

  // POST /api/crypto/strategy/run  — manually trigger a strategy skill headlessly.
  //   { strategy?: 'crypto-strategy' | 'fast-cash' }  (defaults to crypto-strategy)
  if (path === '/api/crypto/strategy/run' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    // Explicit choice wins; otherwise run whichever strategy is enabled in the app.
    const strategy = isStrategyId(body.strategy) ? body.strategy : getEnabledStrategy()
    const started = strategyRunner.start(strategy)
    return json(started ? 200 : 409, {
      ok: started,
      error: started ? undefined : 'A strategy run is already in progress.',
      status: strategyRunner.getStatus()
    }), true
  }

  // POST /api/crypto/portfolio-baseline/reset  — re-baseline BTC/USD growth to current balances
  if (path === '/api/crypto/portfolio-baseline/reset' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const growth = cryptoHub.resetPortfolioBaseline()
    return json(200, { ok: true, growth }), true
  }

  // POST /api/crypto/portfolio-baseline  — reconstruct at a date, or set explicit baseline
  //   { reconstructFrom: <ms> }  → walk balances back to that time from trades + transfers
  //   { btc, usd, at }           → manual correction
  if (path === '/api/crypto/portfolio-baseline' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    if (typeof body.reconstructFrom === 'number' && body.reconstructFrom > 0) {
      const { growth, truncated } = await cryptoHub.reconstructBaselineAt(body.reconstructFrom)
      return json(200, { ok: true, growth, truncated }), true
    }
    if (typeof body.btc === 'number' && typeof body.usd === 'number' && typeof body.at === 'number') {
      const growth = cryptoHub.setPortfolioBaseline(body.btc, body.usd, body.at)
      return json(200, { ok: true, growth }), true
    }
    return json(400, { ok: false, error: 'provide reconstructFrom, or btc+usd+at' }), true
  }

  // GET /api/crypto/auto-execute  — current opt-in autonomy config { enabled, maxUsd }
  if (path === '/api/crypto/auto-execute' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, config: autoPlanner.getAutoExecute() }), true
  }

  // POST /api/crypto/auto-execute  — update { enabled?, maxUsd? }
  if (path === '/api/crypto/auto-execute' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const patch: { enabled?: boolean; btcLadderMaxUsd?: number; altMaxUsd?: number; perStrategy?: Record<string, boolean> } = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.btcLadderMaxUsd === 'number' && body.btcLadderMaxUsd > 0) patch.btcLadderMaxUsd = body.btcLadderMaxUsd
    if (typeof body.altMaxUsd === 'number' && body.altMaxUsd > 0) patch.altMaxUsd = body.altMaxUsd
    // { perStrategy: { sniper: false } } — merged server-side, so one strategy's toggle
    // never clobbers another's.
    if (body.perStrategy && typeof body.perStrategy === 'object') {
      const per: Record<string, boolean> = {}
      for (const [id, on] of Object.entries(body.perStrategy as Record<string, unknown>)) per[id] = !!on
      patch.perStrategy = per
    }
    const config = autoPlanner.setAutoExecute(patch)
    return json(200, { ok: true, config }), true
  }

  // GET /api/crypto/strategy/settings[?strategy=<id>]  — admin-tunable knobs for the
  // strategy skills. No strategy param → every strategy definition (id/label/description/
  // fields/values), for the admin panel. With strategy → just that strategy's flat
  // settings object (what the skill docs curl at Step 0 of each run).
  if (path === '/api/crypto/strategy/settings' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const strategy = url.searchParams.get('strategy')
    if (strategy) {
      if (!isKnownStrategyForSettings(strategy)) return json(400, { ok: false, error: 'unknown strategy' }), true
      // ?resolved=1 underlays the shared _global values (strategy's own win on collision) so a
      // skill doc gets one flat object and never has to implement the fallback itself.
      const settings = url.searchParams.get('resolved')
        ? getResolvedStrategySettings(strategy)
        : getStrategySettings(strategy)
      return json(200, { ok: true, settings }), true
    }
    return json(200, { ok: true, definitions: getAllStrategyDefinitions() }), true
  }

  // POST /api/crypto/strategy/settings?strategy=<id>  — patch one strategy's settings.
  // POST /api/crypto/strategy/settings?strategy=<id>&reset=1  — reset it to defaults.
  if (path === '/api/crypto/strategy/settings' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const strategy = url.searchParams.get('strategy')
    if (!isKnownStrategyForSettings(strategy)) return json(400, { ok: false, error: 'unknown strategy' }), true
    if (url.searchParams.get('reset')) {
      return json(200, { ok: true, settings: resetStrategySettings(strategy) }), true
    }
    const body = await readBody(req)
    return json(200, { ok: true, settings: setStrategySettings(strategy, body) }), true
  }

  // POST /api/crypto/strategy/create  — the "+ NEW STRATEGY" form. Body:
  // { label, description?, fields: [{key,label,min,max,step,unit,default}] }
  if (path === '/api/crypto/strategy/create' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    if (typeof body.label !== 'string' || !body.label.trim()) {
      return json(400, { ok: false, error: 'label required' }), true
    }
    if (!Array.isArray(body.fields)) {
      return json(400, { ok: false, error: 'fields array required' }), true
    }
    try {
      const definition = createStrategyDefinition({
        label: body.label, description: typeof body.description === 'string' ? body.description : undefined, fields: body.fields
      })
      return json(200, { ok: true, definition }), true
    } catch (e) {
      return json(400, { ok: false, error: (e as Error).message }), true
    }
  }

  // GET /api/crypto/strategy/status  — poll the current/last strategy run
  if (path === '/api/crypto/strategy/status' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, status: strategyRunner.getStatus() }), true
  }

  // POST /api/crypto/strategy/heartbeat  — a headless/scheduled routine (the hourly job)
  // signals that it's running so the app can show a live "ROUTINE RUNNING" badge. Called
  // by the skill's bookend scripts: crypto-session.py pings 'begin', crypto-report-post.py
  // pings 'end'. Body: { phase: 'begin'|'beat'|'end', strategy?, activity? }
  if (path === '/api/crypto/strategy/heartbeat' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const phase = body.phase
    if (phase !== 'begin' && phase !== 'beat' && phase !== 'end') {
      return json(400, { ok: false, error: "phase must be 'begin', 'beat', or 'end'" }), true
    }
    const strategy = isStrategyId(body.strategy) ? body.strategy : 'crypto-strategy'
    const activity = typeof body.activity === 'string' ? body.activity : undefined
    strategyRunner.externalHeartbeat(phase, strategy, activity)
    return json(200, { ok: true, status: strategyRunner.getStatus() }), true
  }

  // GET /api/crypto/strategy/enabled  — which strategy is enabled in the app
  //   (the persisted preference a headless routine dispatches on)
  if (path === '/api/crypto/strategy/enabled' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, strategy: getEnabledStrategy() }), true
  }

  // POST /api/crypto/strategy/enabled  — set the enabled strategy { strategy }
  if (path === '/api/crypto/strategy/enabled' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    if (!isStrategyId(body.strategy)) {
      return json(400, { ok: false, error: 'strategy must be one of: crypto-strategy, fast-cash' }), true
    }
    return json(200, { ok: true, strategy: setEnabledStrategy(body.strategy) }), true
  }

  // ── Intelligence agents (INTELLIGENCE tab) ────────────────────────────
  // User-authored Claude agents. The autonomy dial is enforced in agentFleet.propose(),
  // never by the agent's own prompt — see server/agents.ts.

  // GET /api/crypto/agents  — the whole fleet with live status
  if (path === '/api/crypto/agents' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, agents: agentFleet.list() }), true
  }

  // POST /api/crypto/agents  — create one { name, mandate, autonomy?, maxUsd?, ... }
  if (path === '/api/crypto/agents' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    try {
      const view = agentFleet.create({
        name: String(body.name ?? ''),
        mandate: String(body.mandate ?? ''),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(isAgentAutonomy(body.autonomy) ? { autonomy: body.autonomy } : {}),
        ...(typeof body.maxUsd === 'number' ? { maxUsd: body.maxUsd } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.intervalMinutes === 'number' ? { intervalMinutes: body.intervalMinutes } : {}),
        ...(Array.isArray(body.events) ? { events: (body.events as unknown[]).filter(isAgentEvent) } : {}),
        ...(typeof body.drawdownPct === 'number' ? { drawdownPct: body.drawdownPct } : {}),
        ...(typeof body.cooldownMinutes === 'number' ? { cooldownMinutes: body.cooldownMinutes } : {})
      })
      return json(200, { ok: true, agent: view }), true
    } catch (e) {
      return json(400, { ok: false, error: (e as Error).message }), true
    }
  }

  if (path.startsWith('/api/crypto/agents/')) {
    const rest = path.slice('/api/crypto/agents/'.length)
    const [agentId, action] = rest.split('/')
    if (!agentId) return json(400, { ok: false, error: 'agent id required' }), true
    if (!requireToken(req, res)) return true

    // PATCH /api/crypto/agents/:id  — update settings (autonomy dial, triggers, mandate)
    if (!action && req.method === 'PATCH') {
      const body = await readBody(req)
      const patch: Record<string, unknown> = {}
      for (const k of ['name', 'mandate', 'model'] as const) if (typeof body[k] === 'string') patch[k] = body[k]
      for (const k of ['maxUsd', 'intervalMinutes', 'drawdownPct', 'cooldownMinutes'] as const) {
        if (typeof body[k] === 'number') patch[k] = body[k]
      }
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (isAgentAutonomy(body.autonomy)) patch.autonomy = body.autonomy
      if (Array.isArray(body.events)) patch.events = (body.events as unknown[]).filter(isAgentEvent)
      try {
        const view = agentFleet.update(agentId, patch)
        return view ? (json(200, { ok: true, agent: view }), true) : (json(404, { ok: false, error: 'unknown agent' }), true)
      } catch (e) {
        // A rejected model id, today. The agent is left untouched — see update().
        return json(400, { ok: false, error: (e as Error).message }), true
      }
    }

    // DELETE /api/crypto/agents/:id
    if (!action && req.method === 'DELETE') {
      const gone = agentFleet.remove(agentId)
      return json(gone ? 200 : 404, { ok: gone, ...(gone ? {} : { error: 'unknown agent' }) }), true
    }

    // GET /api/crypto/agents/:id
    if (!action && req.method === 'GET') {
      const view = agentFleet.get(agentId)
      return view ? (json(200, { ok: true, agent: view }), true) : (json(404, { ok: false, error: 'unknown agent' }), true)
    }

    // POST /api/crypto/agents/:id/run  — manual RUN (ignores enabled/cooldown; you asked)
    if (action === 'run' && req.method === 'POST') {
      const r = agentFleet.start(agentId, 'manual')
      return json(r.ok ? 200 : 409, r), true
    }

    // POST /api/crypto/agents/:id/propose  — THE trade gate. Called by the agent itself.
    //
    // Requires that agent's OWN key, not just the shared token. Every agent runs on
    // localhost (where requireToken is waived) and every agent id is listed in every
    // agent's prompt, so without this an advisory agent — or any injected instruction
    // reaching any agent — could POST to an auto agent's URL and trade under its cap.
    // The autonomy dial has to belong to the caller, not to the path.
    if (action === 'propose' && req.method === 'POST') {
      const rawKey = req.headers['x-homunculus-agent-key']
      const agentKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey) || ''
      if (!agentFleet.verifyProposeKey(agentId, agentKey)) {
        return json(403, {
          ok: false,
          outcome: 'refused',
          error: 'x-homunculus-agent-key missing or does not belong to this agent',
        }), true
      }
      const body = await readBody(req)
      const result = await agentFleet.propose(agentId, {
        symbol: String(body.symbol ?? ''),
        side: body.side === 'sell' ? 'sell' : 'buy',
        ...(body.type === 'market' || body.type === 'limit' ? { type: body.type } : {}),
        amount: String(body.amount ?? ''),
        ...(body.price !== undefined ? { price: String(body.price) } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {})
      })
      return json(result.ok ? 200 : 403, result), true
    }

    // POST /api/crypto/agents/:id/chat  — talk to the agent { message }
    if (action === 'chat' && req.method === 'POST') {
      const body = await readBody(req)
      const message = String(body.message ?? '').trim()
      if (!message) return json(400, { ok: false, error: 'message required' }), true
      const result = await agentFleet.chat(agentId, message)
      return json(result.ok ? 200 : 409, result), true
    }

    // DELETE /api/crypto/agents/:id/chat  — wipe the transcript and its resumed session
    if (action === 'chat' && req.method === 'DELETE') {
      const done = agentFleet.clearTranscript(agentId)
      return json(done ? 200 : 404, { ok: done }), true
    }

    return json(404, { ok: false, error: 'unknown agent route' }), true
  }

  // ── The office (HR, cubicles, message board) ──────────────────────────
  // Personnel records, journals, minds and the board. Nothing here grants trading
  // authority — that lives entirely in agentFleet.propose().

  // GET /api/crypto/office  — the whole roster with HR records
  if (path === '/api/crypto/office' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const roster = agentFleet.roster().map((r) => ({
      ...r,
      personnel: office.ensurePersonnel(r.id, r.name),
      inbox: office.inbox(r.id).length
    }))
    return json(200, { ok: true, roster }), true
  }

  // GET /api/crypto/office/board  — every thread, newest activity first
  if (path === '/api/crypto/office/board' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, threads: office.listThreads() }), true
  }

  // GET /api/crypto/office/board/active — the thread everyone is posting to right now,
  // so an agent can find it without guessing at titles or sorting the board itself.
  if (path === '/api/crypto/office/board/active' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const thread = office.ensureActiveBoard(managerFile.managerId(), agentFleet.mentionableIds())
    return json(200, { ok: true, thread }), true
  }

  // GET /api/crypto/office/board/stage?from=trap-scout&maxAgeMin=90
  //
  // The newest stage post a named upstream agent left on the active board. This is a
  // pipeline handoff done mechanically rather than by judgement: the downstream stage used
  // to be told to find "the newest thread tagged trapline-run", which selected by last
  // activity and so returned a downstream tend report whenever one had landed more
  // recently than the scan. The Setter then stood down reporting "no fresh scan" with a
  // scan sitting right there. Author, freshness and payload are decided here, once.
  if (path === '/api/crypto/office/board/stage' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const from = String(url.searchParams.get('from') ?? '').trim()
    if (!from) return json(400, { ok: false, error: 'from=<agentId> required' }), true
    const maxAgeMin = Number(url.searchParams.get('maxAgeMin') ?? 90)
    const thread = office.ensureActiveBoard(managerFile.managerId(), agentFleet.mentionableIds())
    const post = newestStagePost(thread, {
      authorId: from,
      maxAgeMs: (Number.isFinite(maxAgeMin) && maxAgeMin > 0 ? maxAgeMin : 90) * 60_000,
      now: Date.now()
    })
    return json(200, {
      ok: true,
      boardId: thread.id,
      // null means no fresh post from that stage — stand down. A post with work 0 is
      // present and empty, which is a different thing and must read differently.
      post,
      fresh: post !== null
    }), true
  }

  // POST /api/crypto/office/board  — open a thread { authorId, title, body, tags? }
  if (path === '/api/crypto/office/board' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const authorId = String(body.authorId ?? 'operator')
    if (!String(body.body ?? '').trim()) return json(400, { ok: false, error: 'body required' }), true
    // Colleagues reply on the active board; only the manager opens threads. Enforced here
    // rather than asked for in the mandate, for the same reason the autonomy dial is: a
    // rule an agent can forget is not a rule. Sixty-one near-empty Scout threads in four
    // days is what the polite version produced.
    const mayOpen = agentMayOpenThread(authorId, managerFile.managerId())
    if (!mayOpen.ok) {
      const active = office.ensureActiveBoard(managerFile.managerId(), agentFleet.mentionableIds())
      return json(403, { ok: false, error: mayOpen.error, activeBoardId: active.id }), true
    }
    const thread = office.postThread({
      title: String(body.title ?? ''),
      body: String(body.body),
      authorId,
      ...(Array.isArray(body.tags) ? { tags: (body.tags as unknown[]).map(String) } : {})
    }, agentFleet.mentionableIds())
    return json(200, { ok: true, thread }), true
  }

  if (path.startsWith('/api/crypto/office/board/')) {
    const rest = path.slice('/api/crypto/office/board/'.length)
    const [threadId, action] = rest.split('/')
    if (!threadId) return json(400, { ok: false, error: 'thread id required' }), true
    if (!requireToken(req, res)) return true

    // POST /api/crypto/office/board/:id/reply  { authorId, body }
    if (action === 'reply' && req.method === 'POST') {
      const body = await readBody(req)
      if (!String(body.body ?? '').trim()) return json(400, { ok: false, error: 'body required' }), true
      const thread = office.reply(threadId, {
        body: String(body.body),
        authorId: String(body.authorId ?? 'operator')
      }, agentFleet.mentionableIds())
      return thread ? (json(200, { ok: true, thread }), true) : (json(404, { ok: false, error: 'unknown thread' }), true)
    }

    // POST /api/crypto/office/board/:id/resolve  { resolved }
    if (action === 'resolve' && req.method === 'POST') {
      const body = await readBody(req)
      const thread = office.setResolved(threadId, body.resolved !== false)
      return thread ? (json(200, { ok: true, thread }), true) : (json(404, { ok: false, error: 'unknown thread' }), true)
    }

    if (!action && req.method === 'GET') {
      const thread = office.getThread(threadId)
      return thread ? (json(200, { ok: true, thread }), true) : (json(404, { ok: false, error: 'unknown thread' }), true)
    }
    return json(404, { ok: false, error: 'unknown board route' }), true
  }

  // ── Blockers ───────────────────────────────────────────────────────────
  // What each employee is waiting on. Matched before the /api/crypto/office/<agentId>
  // catch-all, same as the board and the library.

  // GET /api/crypto/office/blockers  — the whole board, open first, oldest open on top
  if (path === '/api/crypto/office/blockers' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, blockers: blockerBoard.list() }), true
  }

  // POST /api/crypto/office/blockers  — raise one. Idempotent per (asker, askee, question).
  if (path === '/api/crypto/office/blockers' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const r = blockerBoard.raise({
      agentId: String(body.agentId ?? ''),
      askedOf: String(body.askedOf ?? ''),
      question: String(body.question ?? ''),
      ...(typeof body.why === 'string' ? { why: body.why } : {}),
      ...(isBlockerSeverity(body.severity) ? { severity: body.severity } : {}),
      ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {})
    })
    if (!r.ok) return json(400, r), true
    // Asking a colleague wakes them now, so the asker can wait a few seconds and finish
    // its run with the answer rather than parking the question until their next shift.
    // Only on a fresh ask: re-raising a duplicate must not re-wake anyone.
    const inline = r.duplicate
      ? { ok: false, reason: 'already asked — the original is still open' }
      : agentFleet.dispatchInlineAnswer({
        blockerId: r.blocker.id,
        askedBy: r.blocker.agentId,
        askedOf: r.blocker.askedOf,
        question: r.blocker.question
      })
    // A duplicate is answered with the original and said plainly, so an agent that asks
    // twice learns it already asked rather than believing it asked twice.
    return json(200, {
      ok: true,
      blocker: r.blocker,
      duplicate: r.duplicate,
      wokeAnswerer: inline.ok,
      note: r.duplicate
        ? 'You already asked this and it is still open. Do not ask again — you will be woken when it is answered.'
        : inline.ok
          ? `${inline.reason} Poll this blocker (every ~10s, up to ~2 min) and finish your run with the answer.`
          : `Not answered inline: ${inline.reason}. You will be woken when it is answered.`
    }), true
  }

  if (path.startsWith('/api/crypto/office/blockers/')) {
    const rest = path.slice('/api/crypto/office/blockers/'.length)
    const [id, action] = rest.split('/')
    if (!id) return json(400, { ok: false, error: 'blocker id required' }), true
    if (!requireToken(req, res)) return true

    // POST .../answer  { answer }  — unblocks the asker and wakes it with the answer
    if (action === 'answer' && req.method === 'POST') {
      const body = await readBody(req)
      const by = currentActor()
      const r = blockerBoard.answer(id, String(body.answer ?? ''), by)
      return json(r.ok ? 200 : 400, r), true
    }

    // POST .../withdraw  — the question is no longer needed
    if (action === 'withdraw' && req.method === 'POST') {
      const r = blockerBoard.withdraw(id, currentActor())
      return json(r.ok ? 200 : 400, r), true
    }

    if (!action && req.method === 'GET') {
      const b = blockerBoard.get(id)
      return b ? (json(200, { ok: true, blocker: b }), true) : (json(404, { ok: false, error: 'unknown blocker' }), true)
    }
    return json(404, { ok: false, error: 'unknown blocker route' }), true
  }

  // ── The Manager's File ─────────────────────────────────────────────────
  // Every outstanding question on the desk, in one queue. Mentions no longer wake the
  // colleague they tag; they land here, and the manager dispatches. Matched before the
  // /api/crypto/office/<agentId> catch-all, same as the board and the library.

  // GET /api/crypto/office/manager-file — refreshed from the board on read, so the file
  // is never a stale copy of a conversation that has already moved on.
  if (path === '/api/crypto/office/manager-file' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    managerFile.refresh()
    return json(200, {
      ok: true,
      items: managerFile.list(),
      stats: managerFile.stats(),
      managerId: managerFile.managerId()
    }), true
  }

  if (path.startsWith('/api/crypto/office/manager-file/')) {
    const rest = path.slice('/api/crypto/office/manager-file/'.length)
    const cut = rest.lastIndexOf('/')
    // Item ids are colon-joined (mention:<thread>:<message>) and may arrive raw from an
    // agent's curl or percent-encoded from the UI. Splitting the action off the END works
    // for both, since neither form contains a slash; decoding is then a no-op on the raw one.
    const id = decodeURIComponent(cut >= 0 ? rest.slice(0, cut) : rest)
    const action = cut >= 0 ? rest.slice(cut + 1) : ''
    if (!id) return json(400, { ok: false, error: 'item id required' }), true
    if (!requireToken(req, res)) return true

    // POST .../assign  { to, instruction }  — dispatch. This is what wakes a colleague.
    if (action === 'assign' && req.method === 'POST') {
      const body = await readBody(req)
      const r = managerFile.assign(id, String(body.to ?? ''), String(body.instruction ?? ''), currentActor())
      return json(r.ok ? 200 : 400, r), true
    }

    // POST .../answer  { answer }  — what the assignee sends back.
    if (action === 'answer' && req.method === 'POST') {
      const body = await readBody(req)
      const r = managerFile.answer(id, String(body.answer ?? ''), currentActor())
      return json(r.ok ? 200 : 400, r), true
    }

    // POST .../close  — handled, or not worth the desk's time.
    if (action === 'close' && req.method === 'POST') {
      const r = managerFile.close(id, currentActor())
      return json(r.ok ? 200 : 400, r), true
    }

    // POST .../note  { note }  — the manager's own working note.
    if (action === 'note' && req.method === 'POST') {
      const body = await readBody(req)
      const r = managerFile.note(id, String(body.note ?? ''))
      return json(r.ok ? 200 : 400, r), true
    }

    if (!action && req.method === 'GET') {
      const item = managerFile.get(id)
      return item ? (json(200, { ok: true, item }), true) : (json(404, { ok: false, error: 'unknown item' }), true)
    }
    return json(404, { ok: false, error: "unknown manager-file route" }), true
  }

  // ── The library ────────────────────────────────────────────────────────
  // Documents employees file to outlive their runs. Matched before the
  // /api/crypto/office/<agentId> catch-all below, same as the board.

  // GET /api/crypto/office/library  — the shelf (metadata only, no bodies)
  if (path === '/api/crypto/office/library' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, artifacts: library.list() }), true
  }

  // POST /api/crypto/office/library  — file a document
  if (path === '/api/crypto/office/library' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readBody(req)
    const r = library.create({
      title: String(body.title ?? ''),
      body: String(body.body ?? ''),
      authorId: String(body.authorId ?? 'operator'),
      ...(isArtifactKind(body.kind) ? { kind: body.kind } : {}),
      ...(isArtifactFormat(body.format) ? { format: body.format } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(Array.isArray(body.tags) ? { tags: (body.tags as unknown[]).map(String) } : {}),
      ...(Array.isArray(body.symbols) ? { symbols: (body.symbols as unknown[]).map(String) } : {}),
      ...(typeof body.resolvesAt === 'number' ? { resolvesAt: body.resolvesAt } : {}),
      ...(typeof body.supersedes === 'string' ? { supersedes: body.supersedes } : {})
    })
    return json(r.ok ? 200 : 400, r), true
  }

  if (path.startsWith('/api/crypto/office/library/')) {
    const id = path.slice('/api/crypto/office/library/'.length).split('/')[0] ?? ''
    if (!id) return json(400, { ok: false, error: 'artifact id required' }), true
    if (!requireToken(req, res)) return true

    // GET  — the whole document, body included
    if (req.method === 'GET') {
      const artifact = library.get(id)
      return artifact ? (json(200, { ok: true, artifact }), true) : (json(404, { ok: false, error: 'unknown artifact' }), true)
    }

    // PATCH — revise it, grade it, or pin it
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      const patch: Record<string, unknown> = {}
      if (typeof body.title === 'string') patch.title = body.title
      if (typeof body.body === 'string') patch.body = body.body
      if (isArtifactKind(body.kind)) patch.kind = body.kind
      if (isArtifactFormat(body.format)) patch.format = body.format
      if (typeof body.summary === 'string') patch.summary = body.summary
      if (Array.isArray(body.tags)) patch.tags = (body.tags as unknown[]).map(String)
      if (Array.isArray(body.symbols)) patch.symbols = (body.symbols as unknown[]).map(String)
      if (body.resolvesAt === null || typeof body.resolvesAt === 'number') patch.resolvesAt = body.resolvesAt
      if (isArtifactOutcome(body.outcome)) patch.outcome = body.outcome
      if (typeof body.resolution === 'string') patch.resolution = body.resolution
      if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
      const r = library.update(id, patch)
      return json(r.ok ? 200 : 404, r), true
    }

    if (req.method === 'DELETE') {
      const done = library.remove(id)
      return json(done ? 200 : 404, { ok: done }), true
    }

    return json(404, { ok: false, error: 'unknown library route' }), true
  }

  if (path.startsWith('/api/crypto/office/')) {
    const rest = path.slice('/api/crypto/office/'.length)
    const [agentId, action] = rest.split('/')
    if (!agentId) return json(400, { ok: false, error: 'agent id required' }), true
    if (!requireToken(req, res)) return true
    const known = agentFleet.get(agentId)
    if (!known) return json(404, { ok: false, error: 'unknown agent' }), true

    // GET /api/crypto/office/:id  — the cubicle: personnel + journal + mind + inbox
    if (!action && req.method === 'GET') {
      return json(200, { ok: true, cubicle: office.cubicle(agentId, known.agent.name) }), true
    }

    // PATCH /api/crypto/office/:id  — edit the HR record
    if (!action && req.method === 'PATCH') {
      const body = await readBody(req)
      office.ensurePersonnel(agentId, known.agent.name)
      const patch: Record<string, unknown> = {}
      if (typeof body.title === 'string') patch.title = body.title
      if (isDepartment(body.department)) patch.department = body.department
      if (isEmploymentStatus(body.status)) patch.status = body.status
      if (body.reportsTo === null || typeof body.reportsTo === 'string') patch.reportsTo = body.reportsTo
      if (typeof body.notes === 'string') patch.notes = body.notes
      if (body.resume && typeof body.resume === 'object') patch.resume = body.resume
      if (body.jobDescription && typeof body.jobDescription === 'object') patch.jobDescription = body.jobDescription
      if (Array.isArray(body.sources)) patch.sources = (body.sources as unknown[]).filter(isSourceRef)
      const personnel = office.updatePersonnel(agentId, patch)
      // Department, status and reportsTo are what decide who the desk manager is, and the
      // Manager's File routes every mention to whoever that is. Take effect on the edit
      // rather than a minute later.
      if (personnel) managerFile.invalidateManager()
      return personnel ? (json(200, { ok: true, personnel }), true) : (json(404, { ok: false, error: 'no personnel file' }), true)
    }

    // POST /api/crypto/office/:id/journal  — append a note { title?, body, tags?, author? }
    if (action === 'journal' && req.method === 'POST') {
      const body = await readBody(req)
      if (!String(body.body ?? '').trim()) return json(400, { ok: false, error: 'body required' }), true
      const entry = office.appendJournal(agentId, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        body: String(body.body),
        ...(Array.isArray(body.tags) ? { tags: (body.tags as unknown[]).map(String) } : {}),
        author: body.author === 'operator' ? 'operator' : 'agent'
      })
      return json(200, { ok: true, entry }), true
    }

    // POST /api/crypto/office/:id/mind  — record a thought deliberately { kind?, text }
    if (action === 'mind' && req.method === 'POST') {
      const body = await readBody(req)
      const text = String(body.text ?? '').trim()
      if (!text) return json(400, { ok: false, error: 'text required' }), true
      const kind = ['reasoning', 'action', 'observation', 'decision'].includes(String(body.kind))
        ? (body.kind as 'reasoning' | 'action' | 'observation' | 'decision')
        : 'observation'
      return json(200, { ok: true, thought: office.think(agentId, { kind, text }) }), true
    }

    return json(404, { ok: false, error: 'unknown office route' }), true
  }

  // GET /api/crypto/plan-report/archive  — every past STRATEGY REPORT (newest first),
  // so the skill can pull prior runs to reference/adjust strategy, not just the latest.
  if (path === '/api/crypto/plan-report/archive' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, reports: cryptoHub.getPlanReportArchive() }), true
  }

  // POST /api/crypto/cost-basis  — record a manual cost-basis override { currency, price }
  // price=null clears the override. Used when Gemini trade history can't reconstruct an entry.
  if (path === '/api/crypto/cost-basis' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const body = await readRawBody(req)
    if (body === null) return json(413, { ok: false, error: 'payload too large' }), true
    try {
      const { currency, price } = JSON.parse(body) as { currency: string; price: number | null }
      if (typeof currency !== 'string' || !currency) return json(400, { ok: false, error: 'currency required' }), true
      if (price !== null && (typeof price !== 'number' || price <= 0)) return json(400, { ok: false, error: 'price must be a positive number or null' }), true
      const overrides = cryptoHub.setCostBasisOverride(currency, price)
      return json(200, { ok: true, overrides }), true
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' }), true
    }
  }

  // ── Audit log ────────────────────────────────────────────────────────
  //
  // Read routes sit behind the normal token; the record is the operator's own
  // history and is no more sensitive than the data it describes. There is no
  // route that edits or deletes an entry — none exists anywhere in the codebase,
  // by design. The one way to amend the record is /api/audit/annotate, which
  // appends a correction referencing the disputed seq and needs the admin token.

  // GET /api/audit?actor=&resource=&action=&since=&until=&limit=&before=
  if (path === '/api/audit' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const q = new URL(req.url || '', 'http://localhost').searchParams
    const num = (k: string): number | undefined => {
      const v = q.get(k)
      return v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined
    }
    const entries = await auditLog.read({
      ...(q.get('actor') ? { actor: q.get('actor')! } : {}),
      ...(q.get('resource') ? { resource: q.get('resource')! } : {}),
      ...(q.get('action') ? { action: q.get('action')! } : {}),
      ...(q.get('since') ? { since: q.get('since')! } : {}),
      ...(q.get('until') ? { until: q.get('until')! } : {}),
      ...(num('limit') !== undefined ? { limit: num('limit')! } : {}),
      ...(num('before') !== undefined ? { before: num('before')! } : {}),
    })
    const nextCursor = entries.length ? entries[entries.length - 1]!.seq : null
    return json(200, { ok: true, entries, nextCursor }), true
  }

  // GET /api/crypto/timeline?since=&until=  — the INTELLIGENCE activity timeline.
  //
  // Runs come from agent_runs (durable, so the window can reach past the fleet's
  // 25-run cap); edges and point events are derived from the audit log, which
  // already records actor + resource for every mutation. Nothing new is written
  // to produce this view — it is the same record read edge-first.
  if (path === '/api/crypto/timeline' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    const q = new URL(req.url || '', 'http://localhost').searchParams
    const until = Number(q.get('until')) || Date.now()
    const since = Number(q.get('since')) || until - 24 * 60 * 60_000
    const [runRows, auditRows] = await Promise.all([
      stateStore.readRuns(since, until),
      stateStore.readAuditWindow(since, until),
    ])

    const runs: TimelineRun[] = runRows.map((r) => ({
      id: String(r['id']),
      component: String(r['component']),
      label: String(r['label']),
      trigger: String(r['trigger']),
      startedAt: Number(r['started_at']),
      endedAt: r['ended_at'] === null || r['ended_at'] === undefined ? null : Number(r['ended_at']),
      state: String(r['state']) as TimelineRun['state'],
      summary: String(r['summary'] ?? ''),
    }))

    const edges: TimelineEdge[] = []
    const events: TimelineEvent[] = []
    for (const row of auditRows) {
      const entry = {
        ts: String(row['ts']), actor: String(row['actor']), origin: String(row['origin']),
        action: String(row['action']), resource: String(row['resource']),
        summary: String(row['summary'] ?? ''),
        meta: (row['meta'] ?? null) as Record<string, unknown> | null,
      }
      const edge = edgeForAudit(entry)
      if (edge) edges.push(edge)
      // Point events: the unattended paths, which have no run bar of their own and
      // would otherwise be invisible on a lane-per-runner timeline.
      if (entry.action === 'alert.fired.autostage' || entry.action === 'plan.autoexecute') {
        events.push({
          at: Date.parse(entry.ts),
          component: entry.action === 'alert.fired.autostage' ? 'alerts' : 'system',
          action: entry.action,
          summary: entry.summary,
        })
      }
    }

    // Lanes: everything that appears anywhere in the window, agents/skills first.
    const names: Record<string, string> = {}
    for (const r of runs) names[r.component] = r.label
    const ids = new Set<string>([
      ...runs.map((r) => r.component),
      ...events.map((e) => e.component),
      ...edges.flatMap((e) => [e.from, e.to]),
    ])
    const components: TimelineComponent[] = [...ids].map((id) => ({
      id, kind: componentKind(id), label: componentLabel(id, names),
    })).sort((a, b) => {
      const rank = (k: string) => (k === 'agent' ? 0 : k === 'skill' ? 1 : k === 'system' ? 2 : k === 'operator' ? 3 : 4)
      return rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label)
    })

    return json(200, { ok: true, timeline: { since, until, components, runs, events, edges } }), true
  }

  // ── Live Claude sessions ─────────────────────────────────────────────
  // Everything in this process currently talking to Claude, and the ability to
  // stop one. See server/claudeProcesses.ts for why stopping goes through the
  // SDK's abortController rather than query.interrupt().

  // GET /api/claude/running
  if (path === '/api/claude/running' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, processes: claudeProcesses.list() }), true
  }

  // POST /api/claude/:id/stop
  if (path.startsWith('/api/claude/') && path.endsWith('/stop') && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    const id = path.split('/')[3] ?? ''
    const result = claudeProcesses.stop(id)
    // A stop that finds nothing is the ordinary race — the run ended while the
    // operator was reading the list — so it is reported, not treated as failure.
    return json(result.ok ? 200 : 409, result), true
  }

  // POST /api/claude/stop-all
  if (path === '/api/claude/stop-all' && req.method === 'POST') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, stopped: claudeProcesses.stopAll() }), true
  }

  // GET /api/state — where the app's JSON state actually lives right now.
  // Reports the Postgres connection, anything still queued after an outage, and
  // any key where the file and the database disagreed at boot.
  if (path === '/api/state' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, state: stateStore.status(), audit: auditLog.dbStatus() }), true
  }

  // GET /api/audit/verify — re-derive every hash in the chain.
  if (path === '/api/audit/verify' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, result: await auditLog.verify() }), true
  }

  // GET /api/audit/files — inventory of the log files and the seq span in each.
  if (path === '/api/audit/files' && req.method === 'GET') {
    if (!requireToken(req, res)) return true
    return json(200, { ok: true, files: auditLog.listFiles(), db: auditLog.dbStatus() }), true
  }

  // POST /api/audit/annotate {seq, note}  — admin only.
  // Corrections are appends, never edits: if seq 412 recorded something wrongly,
  // the fix is a new entry saying so, and both stay in the chain forever.
  if (path === '/api/audit/annotate' && req.method === 'POST') {
    if (!requireAdminToken(req, res)) return true
    const body = await readBody(req)
    const seq = Number(body['seq'])
    const note = body['note']
    if (!Number.isInteger(seq) || seq < 1) return json(400, { ok: false, error: 'seq must be a positive integer' }), true
    if (typeof note !== 'string' || !note.trim()) return json(400, { ok: false, error: 'note required' }), true
    const entry = auditLog.record({
      actor: 'operator',
      origin: 'http',
      action: 'audit.annotation',
      resource: `audit:${seq}`,
      summary: `admin annotation on seq ${seq}: ${note.trim().slice(0, 200)}`,
      meta: { targetSeq: seq, note: note.trim() },
    })
    return json(200, { ok: true, entry }), true
  }

  return false
}

// Bytes past which a request body is rejected outright, sized for the largest
// ordinary JSON payload this API accepts (a strategy report, a full agent
// mandate) with headroom. A chunked-encoding request carries no Content-Length
// a handler could check up front, so this cap is enforced on the accumulation
// itself — the only place that works for every route uniformly. The one route
// that legitimately needs more is /api/sync/file, which reads through
// readRawBody with its own larger explicit limit below.
const MAX_BODY_BYTES = 4 * 1024 * 1024

// Accumulates a request body up to maxBytes; destroys the connection and
// resolves null past that instead of continuing to buffer. Every JSON body
// reader in this file goes through this, so none of them can be walked into
// exhausting the process by a body with no declared length.
function readRawBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    let raw = ''
    let bytes = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        finish(null)
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => finish(raw))
    req.on('error', () => finish(null))
  })
}

/** Parsed JSON body. A body over the cap or that fails to parse resolves to {}
 *  — every call site already treats a missing expected field as a 400, so an
 *  oversized or malformed body fails the same way a truly empty one would. */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return readRawBody(req).then((raw) => {
    if (raw === null) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  })
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0]
  if (path.startsWith('/api/')) {
    // Establish who is calling for the whole request, including anything it kicks
    // off downstream. Skills and agents identify themselves with x-homunculus-actor;
    // an absent or malformed header means 'operator', and no caller can claim to be
    // 'system' (see deriveActor) — that label is reserved for the server's own timers.
    const actor = deriveActor(req.headers[ACTOR_HEADER])
    const handled = await withActor(actor, () => handleApi(req, res, path))
    if (handled) return
  }
  serveStatic(req, res, WEB_DIR)
})
// maxPayload caps a single WS frame; ws's own default is 100 MB, which a
// terminal or chat connection has no legitimate reason to ever send. 8 MB
// matches the general HTTP body cap above.
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })

// ── Auth on WS upgrade (optional token) ───────────────────────────────
//
// A WebSocket handshake is not subject to the browser's same-origin policy the
// way fetch()/XHR are, so the Origin check here carries the whole weight of
// keeping an arbitrary page from opening this socket — there is no equivalent
// of the REST layer's CORS response headers to fall back on. See
// isAllowedOrigin's own comment for why an absent Origin still passes through
// to the token check below rather than being rejected outright.
server.on('upgrade', (req, socket, head) => {
  if (!isAllowedOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const remoteIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1'
  if (!isLocal) {
    // Fail closed, matching requireToken: an unset HOMUNCULUS_TOKEN refuses
    // remote sockets rather than waiving the check for them. This socket carries
    // telemetry, home state, the Computer Core and (token permitting) a PTY.
    if (!TOKEN) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }
    const url = new URL(req.url || '', 'http://localhost')
    if (!constantTimeEquals(url.searchParams.get('token') || '', TOKEN)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

// ── Liveness ──────────────────────────────────────────────────────────
//
// A client that vanishes without a close frame — a phone that sleeps, a laptop
// that leaves the tailnet, a NAT table that forgets — leaves a socket that looks
// open to us for as long as the OS keeps the TCP connection around, which can be
// hours. Every one of those holds a ChatSession, a TerminalManager (with live
// PTYs) and four hub subscriptions that keep serialising snapshots into a socket
// nobody is reading. Ping every client on an interval and drop the ones that did
// not answer the previous round; `ws` replies to a ping automatically, so a client
// only fails this if it is genuinely gone.
const HEARTBEAT_MS = 30_000
const alive = new WeakSet<WebSocket>()

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue }   // missed the last round
    alive.delete(ws)
    try { ws.ping() } catch { ws.terminate() }
  }
}, HEARTBEAT_MS)
// Node keeps the process alive for any pending timer; this one must not be the
// reason a shut-down server lingers.
heartbeat.unref()

// ── Per-connection wiring ─────────────────────────────────────────────
wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  alive.add(ws)
  ws.on('pong', () => alive.add(ws))

  const send = (msg: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  // The upgrade handler above waives the token for a local socket, the same
  // convenience requireToken gives ordinary REST routes — sensible for the
  // dashboard itself, but not for a channel that hands out a shell with the
  // process's own environment (Gemini/HA/Claude credentials) in it. The
  // terminal re-checks the actual token match here rather than inheriting the
  // upgrade's localhost waiver, so opening a PTY always costs the real secret
  // once one is configured, regardless of where the socket dialed in from.
  const wsUrl = new URL(req.url || '', 'http://localhost')
  const hasValidToken = !TOKEN || constantTimeEquals(wsUrl.searchParams.get('token') || '', TOKEN)

  const chat = new ChatSession(send)
  const term = new TerminalManager(send)
  let unsubTelemetry: (() => void) | null = null
  let unsubHa: (() => void) | null = null
  let unsubOsint: (() => void) | null = null
  let unsubArchive: (() => void) | null = null
  const unsubProactive = addProactiveListener((id, text, meta) =>
    send({ ch: 'chat', type: 'proactive', id, text, meta })
  )

  ws.on('message', (raw) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    switch (msg.ch) {
      case 'telemetry':
        if (msg.type === 'subscribe' && !unsubTelemetry) {
          unsubTelemetry = telemetryHub.subscribe((snapshot) =>
            send({ ch: 'telemetry', type: 'update', snapshot })
          )
        }
        break
      case 'chat':
        if (msg.type === 'status') send({ ch: 'chat', type: 'status', status: chatStatus() })
        else if (msg.type === 'send') void chat.streamTurn(msg.id, msg.text, telemetryHub.getLatest())
        break
      case 'term':
        if (msg.type === 'start') {
          if (!hasValidToken) {
            send({
              ch: 'term', type: 'data', id: msg.id,
              data: '\x1b[31m[ Terminal blocked ]\x1b[0m HOMUNCULUS_TOKEN required to open a shell.\r\n',
            })
            send({ ch: 'term', type: 'exit', id: msg.id, exitCode: 1 })
            break
          }
          term.start(msg.id, msg.cols, msg.rows)
        }
        else if (msg.type === 'input') term.input(msg.id, msg.data)
        else if (msg.type === 'resize') term.resize(msg.id, msg.cols, msg.rows)
        else if (msg.type === 'kill') term.kill(msg.id)
        break
      case 'ha':
        if (msg.type === 'subscribe' && !unsubHa) {
          unsubHa = haHub.subscribe((snapshot) =>
            send({ ch: 'ha', type: 'update', snapshot })
          )
        } else if (msg.type === 'command') {
          haHub.sendCommand(msg.entityId, msg.service, msg.data)
            .then(() => send({ ch: 'ha', type: 'command_ack', ok: true }))
            .catch((err: Error) => send({ ch: 'ha', type: 'command_ack', ok: false, error: err.message }))
        }
        break
      case 'osint':
        if (msg.type === 'subscribe' && !unsubOsint) {
          unsubOsint = osintHub.subscribe((snapshot) =>
            send({ ch: 'osint', type: 'update', snapshot })
          )
        } else if (msg.type === 'refresh') {
          osintHub.refreshNow().then((snapshot) =>
            send({ ch: 'osint', type: 'update', snapshot })
          )
        } else if (msg.type === 'geofence') {
          osintHub.setGeofence(msg.config)
        }
        break
      case 'archive':
        if (msg.type === 'subscribe' && !unsubArchive) {
          // Send the recent slice, then stream new events live.
          void archiveHub.recent().then((events) =>
            send({ ch: 'archive', type: 'snapshot', snapshot: { events } })
          )
          unsubArchive = archiveHub.subscribe((event) =>
            send({ ch: 'archive', type: 'event', event })
          )
        }
        break
    }
  })

  ws.on('close', () => {
    unsubTelemetry?.()
    unsubHa?.()
    unsubOsint?.()
    unsubArchive?.()
    unsubProactive()
    term.disposeAll()
  })
})

proactiveMonitor.start()
osintHub.start()
homeWatcher.start()
void cryptoHub.start()
// Wakes enabled INTELLIGENCE agents on their interval / portfolio events.
agentFleet.startWatching()

// Start history capture. Tees are process-wide (not per-connection) so data is
// captured even when no UI client is connected.
void historyHub.start().then(() => {
  if (historyHub.enabled) {
    telemetryHub.subscribe((snap) => { void historyHub.recordTelemetry(snap) })
    haHub.subscribe((snap) => { void historyHub.recordHa(snap) })
  }
  // Start the archive after history so the events table is migrated and
  // write-throughs land in Postgres from the first event.
  archiveHub.start()
})

// ── Crash guards & graceful shutdown ────────────────────────────────────
//
// This process holds live exchange orders — the software stop-loss/take-profit
// monitor tracks brackets only in memory — and runs ~13 interval timers plus
// many fire-and-forget calls into Gemini, Home Assistant, CoinMarketCap and
// Postgres. Node's default on an unhandled rejection is to terminate; without a
// handler, one flaky network response kills the process mid-bracket with resting
// orders still live on the exchange and nothing watching them. These make that
// loud and recorded instead of silent, and give a real shutdown signal
// (SIGTERM/SIGINT — what `docker stop`, a process manager, or Ctrl-C send) a
// chance to flush the audit queue and close connections before exit, rather
// than the process just vanishing.
let shuttingDown = false

function logFatal(kind: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack || err.message) : String(err)
  console.error(`[fatal] ${kind}:`, message)
  try {
    auditLog.record({
      actor: 'system', origin: 'internal', action: 'process.fatal',
      resource: 'server', summary: `${kind}: ${message.split('\n')[0]?.slice(0, 200) ?? message.slice(0, 200)}`,
    })
  } catch {
    // The audit write itself is what's failing here — nothing more to do.
  }
}

process.on('unhandledRejection', (reason) => {
  // Logged, not exited: most of this app's own rejections are already handled
  // (every hub method that can fail returns a result rather than throwing), so
  // an unhandled one is more likely a bug worth surfacing than a sign the
  // process is unrecoverable. uncaughtException below is the one that exits.
  logFatal('unhandledRejection', reason)
})

process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err)
  // Node's own guidance: the process is in an undefined state after a truly
  // uncaught exception and must not keep serving requests. Exit non-zero so a
  // supervisor (Docker's restart: unless-stopped, a process manager) restarts
  // it clean rather than it limping on half-initialized.
  process.exit(1)
})

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[homunculus] ${signal} received, shutting down…`)
  clearInterval(heartbeat)
  for (const ws of wss.clients) ws.close(1001, 'server shutting down')
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  // Bounded: an idle keep-alive HTTP connection can otherwise hold server.close()
  // open indefinitely. 5s is generous for anything genuinely in flight.
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
  await auditLog.stop().catch((err) => console.error('[homunculus] auditLog.stop failed:', (err as Error).message))
  await stateStore.stop().catch((err) => console.error('[homunculus] stateStore.stop failed:', (err as Error).message))
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

server.listen(PORT, HOST, () => {
  console.log(`[homunculus] backend listening on http://${HOST}:${PORT}`)
  console.log(`[homunculus] auth: ${TOKEN
    ? 'token required for remote callers (localhost waived)'
    : 'LOCALHOST ONLY — no HOMUNCULUS_TOKEN set, remote callers are refused (503)'}`)
  console.log(`[homunculus] web dir: ${WEB_DIR} (${existsSync(WEB_DIR) ? 'present' : 'not built'})`)
  // Binding every interface with no token is the configuration that used to serve
  // the terminal and the trading API to the whole LAN. It now fails closed, but the
  // operator almost certainly meant to set a token — say so where they will see it.
  if (!TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn(
      `[homunculus] WARNING: listening on ${HOST} with no HOMUNCULUS_TOKEN. Remote requests are ` +
      `refused, so anything beyond this machine will not work until you set one.`
    )
  }
  // Surface the chain state at boot: a broken chain means someone edited the
  // record, and that is not something to discover weeks later in the UI.
  void (async () => {
    await stateStore.start()
    await auditLog.start()
    const audit = await auditLog.verify()
    console.log(
      audit.ok
        ? `[audit] chain intact: ${audit.entries} entries across ${audit.files.length} file(s)`
        : `[audit] CHAIN BROKEN at seq ${audit.brokenAt}: ${audit.reason}`
    )
    if (audit.db && !audit.db.ok) {
      console.error(`[audit] POSTGRES DIVERGED FROM THE FILE: ${audit.db.reason}`)
    }
  })()
  if (!ADMIN_TOKEN) console.warn('[audit] HOMUNCULUS_ADMIN_TOKEN not set — audit admin routes are closed (503)')
})
