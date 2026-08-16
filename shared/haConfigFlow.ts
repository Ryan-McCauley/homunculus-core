// Home Assistant config flows — the machinery behind adding a new device.
//
// Adding an integration is a multi-step conversation: HA hands back a step, the
// operator fills in a form, the answers go back, and eventually a config entry is
// created. The forms are described by HA, not by us, so this module's job is to
// turn HA's schema serialization into something a React form can render without
// the UI having to know voluptuous.
//
// TWO SHAPES, NOT ONE. HA serializes a field either as `{"type": "string"}` or,
// for anything using a modern selector, as `{"selector": {"text": {...}}}` — and
// selector fields carry NO `type` key at all. Branching on `type` alone silently
// renders every selector-based integration as an unlabelled blank, which is most
// of the interesting ones. Both shapes are handled here.
//
// CREDENTIALS. These forms are where API keys, passwords and tokens get typed.
// Two consequences run through this file: the UI must know which fields to mask
// (isSecretField), and nothing may write raw values into the audit log, which is
// append-only and never rewritten (redactValues). Redaction fails CLOSED — a key
// the schema does not describe is redacted rather than kept, because a value we
// cannot classify is not a value we can prove is safe.

export type FieldKind =
  | 'text' | 'password' | 'number' | 'boolean'
  | 'select' | 'multi_select' | 'section' | 'unsupported'

export interface FieldOption {
  value: string
  label: string
}

/** One field of an HA form step, normalized for rendering. */
export interface FlowField {
  name: string
  label: string
  kind: FieldKind
  required: boolean
  secret: boolean
  default?: unknown
  /** HA's suggested_value — prefilled but overwritable. */
  suggested?: unknown
  options?: FieldOption[]
  min?: number
  max?: number
  /** Nested fields, for an expandable section. */
  fields?: FlowField[]
}

/** A field as HA serializes it. Deliberately loose — this is foreign JSON. */
export interface RawField {
  name?: string
  type?: string
  required?: boolean
  default?: unknown
  description?: unknown
  options?: unknown
  selector?: Record<string, unknown>
  schema?: RawField[]
  valueMin?: number
  valueMax?: number
  [key: string]: unknown
}

/** One step of a flow, as HA sends it. Loose on purpose — this is foreign JSON. */
export interface FlowStepPayload {
  type?: string
  flow_id?: string
  handler?: string
  step_id?: string
  data_schema?: unknown
  errors?: Record<string, string> | null
  description_placeholders?: Record<string, string> | null
  menu_options?: unknown
  reason?: string
  title?: string
  url?: string
  progress_action?: string
  [key: string]: unknown
}

/** A configured integration. */
export interface ConfigEntrySummary {
  entry_id: string
  domain: string
  title: string
  state: string
  source?: string
  supports_options?: boolean
  supports_unload?: boolean
  reason?: string | null
  [key: string]: unknown
}

/** A device HA found on the network that nobody has set up yet. */
export interface DiscoveredFlow {
  flowId: string
  handler: string
  source: string
  title: string
  uniqueId?: string
}

/** The result of any flow call: a step to render, or something to explain. */
export type FlowOutcome =
  | { ok: true; step: FlowStepPayload }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

export type FlowStepKind =
  | 'form' | 'create_entry' | 'abort' | 'menu'
  | 'external' | 'external_done' | 'progress' | 'progress_done' | 'unknown'

const STEP_KINDS = new Set<string>([
  'form', 'create_entry', 'abort', 'menu',
  'external', 'external_done', 'progress', 'progress_done',
])

/**
 * Names that mean "credential" regardless of how HA typed the field.
 *
 * The selector already tells us about `{"text": {"type": "password"}}`, but plenty
 * of integrations declare a token as a plain `cv.string`. Masking is cheap and
 * being wrong in the other direction leaks a secret into a screenshot or a log.
 */
const SECRET_NAME = /pass(word|phrase)?|secret|token|api[_-]?key|apikey|credential|\bpin\b/i

export const REDACTED = '[redacted]'

/** 'api_host' → 'API HOST'. */
function humanize(name: string): string {
  return name.replace(/_/g, ' ').toUpperCase()
}

function toOptions(raw: unknown): FieldOption[] | undefined {
  // HA's own `vol.In` serialization is a list of [value, label] pairs; selector
  // options are either bare strings or {value,label} objects; multi_select is a
  // plain object map. All three appear in the wild.
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (Array.isArray(entry)) return { value: String(entry[0]), label: String(entry[1] ?? entry[0]) }
      if (entry && typeof entry === 'object') {
        const o = entry as { value?: unknown; label?: unknown }
        return { value: String(o.value), label: String(o.label ?? o.value) }
      }
      return { value: String(entry), label: String(entry) }
    })
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([value, label]) => ({
      value, label: String(label),
    }))
  }
  return undefined
}

/** Field shape for a `{"selector": {...}}` field, which has no `type` key. */
function fromSelector(selector: Record<string, unknown>): Partial<FlowField> {
  const [kind, rawConfig] = Object.entries(selector)[0] ?? []
  const config = (rawConfig ?? {}) as Record<string, unknown>

  switch (kind) {
    case 'text':
      return { kind: config['type'] === 'password' ? 'password' : 'text' }
    case 'number':
      return {
        kind: 'number',
        ...(typeof config['min'] === 'number' ? { min: config['min'] } : {}),
        ...(typeof config['max'] === 'number' ? { max: config['max'] } : {}),
      }
    case 'boolean':
      return { kind: 'boolean' }
    case 'select': {
      const options = toOptions(config['options'])
      return {
        kind: config['multiple'] === true ? 'multi_select' : 'select',
        ...(options ? { options } : {}),
      }
    }
    default:
      // Entity pickers, device pickers, add-on selectors and friends. Rendering a
      // guess would be worse than saying plainly that this one needs the HA UI.
      return { kind: 'unsupported' }
  }
}

/** Field shape for a `{"type": "..."}` field. */
function fromType(raw: RawField): Partial<FlowField> | null {
  switch (raw.type) {
    case 'string':
      return { kind: 'text' }
    case 'integer':
    case 'float':
      return {
        kind: 'number',
        ...(typeof raw.valueMin === 'number' ? { min: raw.valueMin } : {}),
        ...(typeof raw.valueMax === 'number' ? { max: raw.valueMax } : {}),
      }
    case 'boolean':
      return { kind: 'boolean' }
    case 'select': {
      const options = toOptions(raw.options)
      return { kind: 'select', ...(options ? { options } : {}) }
    }
    case 'multi_select': {
      const options = toOptions(raw.options)
      return { kind: 'multi_select', ...(options ? { options } : {}) }
    }
    case 'expandable':
      return { kind: 'section', fields: normalizeFields(raw.schema) }
    case 'constant':
      // Display-only; it takes no input, so it is not a field.
      return null
    default:
      return { kind: 'unsupported' }
  }
}

/** Turns HA's serialized data_schema array into renderable fields. */
export function normalizeFields(schema: RawField[] | null | undefined): FlowField[] {
  if (!Array.isArray(schema)) return []

  const fields: FlowField[] = []
  for (const raw of schema) {
    if (!raw || typeof raw !== 'object' || !raw.name) continue

    const shape = raw.selector && typeof raw.selector === 'object'
      ? fromSelector(raw.selector)
      : fromType(raw)
    if (!shape) continue

    // HA puts the prefill in `description.suggested_value`; `description` is also
    // sometimes a plain string, which is documentation rather than a value.
    const description = raw.description
    const suggested = description && typeof description === 'object'
      ? (description as { suggested_value?: unknown }).suggested_value
      : undefined

    const field: FlowField = {
      name: raw.name,
      label: humanize(raw.name),
      kind: shape.kind ?? 'unsupported',
      required: raw.required === true,
      secret: false,
      ...(shape.options ? { options: shape.options } : {}),
      ...(shape.min !== undefined ? { min: shape.min } : {}),
      ...(shape.max !== undefined ? { max: shape.max } : {}),
      ...(shape.fields ? { fields: shape.fields } : {}),
      ...(raw.default !== undefined ? { default: raw.default } : {}),
      ...(suggested !== undefined ? { suggested } : {}),
    }
    field.secret = isSecretField(field)
    fields.push(field)
  }
  return fields
}

/** True when a field holds a credential and must be masked and redacted. */
export function isSecretField(field: FlowField): boolean {
  return field.kind === 'password' || SECRET_NAME.test(field.name)
}

/**
 * A copy of the submitted values safe to write to the audit log.
 *
 * Secret fields are replaced, and so is anything the schema did not describe —
 * see the fail-closed note at the top of this file.
 */
export function redactValues(
  values: Record<string, unknown>,
  fields: FlowField[],
): Record<string, unknown> {
  const byName = new Map(fields.map((f) => [f.name, f]))
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(values)) {
    const field = byName.get(key)
    if (!field || field.secret) {
      out[key] = REDACTED
      continue
    }
    if (field.kind === 'section' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactValues(value as Record<string, unknown>, field.fields ?? [])
      continue
    }
    out[key] = value
  }
  return out
}

/** The step type, normalized; anything unrecognized reads as 'unknown'. */
export function flowStepKind(step: { type?: unknown }): FlowStepKind {
  const type = typeof step.type === 'string' ? step.type : ''
  return STEP_KINDS.has(type) ? (type as FlowStepKind) : 'unknown'
}

/** True when the flow is over — the entry was created, or it gave up. */
export function isTerminalStep(step: { type?: unknown }): boolean {
  const kind = flowStepKind(step)
  return kind === 'create_entry' || kind === 'abort'
}

/**
 * Summarizes HA's raw in-progress flow objects into discovery cards.
 *
 * These come off the websocket un-serialized — they are HA's internal FlowResult
 * dicts, so they carry a `context` and no rendered `data_schema`. Only the
 * identifying bits are useful here; the renderable step comes from a separate
 * GET on the flow.
 */
export function parseDiscoveredFlows(raw: unknown): DiscoveredFlow[] {
  if (!Array.isArray(raw)) return []
  const out: DiscoveredFlow[] = []
  for (const row of raw) {
    const flow = row as { flow_id?: string; handler?: string; context?: Record<string, unknown> }
    if (!flow?.flow_id) continue
    const context = flow.context ?? {}
    const placeholders = (context['title_placeholders'] ?? {}) as Record<string, unknown>
    const uniqueId = context['unique_id']
    out.push({
      flowId: flow.flow_id,
      handler: flow.handler ?? 'unknown',
      source: String(context['source'] ?? 'discovery'),
      title: String(placeholders['name'] ?? placeholders['title'] ?? flow.handler ?? 'unknown'),
      ...(typeof uniqueId === 'string' ? { uniqueId } : {}),
    })
  }
  return out
}
