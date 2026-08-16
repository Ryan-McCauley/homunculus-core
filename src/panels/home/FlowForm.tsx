// Renders one step of a Home Assistant config flow.
//
// The form is described entirely by HA — we never hardcode what an integration
// asks for — so this walks the normalized field list and renders a control per
// field. Secret fields render as password inputs; a field whose selector we
// cannot render says so plainly instead of pretending to be a text box, because
// silently submitting a blank for a required entity picker would fail in a way
// nobody could diagnose from the UI.

import { useEffect, useState } from 'react'
import {
  normalizeFields, flowStepKind, type FlowField, type FlowStepPayload,
} from '../../../shared/haConfigFlow'

interface Props {
  step: FlowStepPayload
  fieldErrors?: Record<string, string>
  busy: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onCancel: () => void
}

/** Initial values: HA's suggestion first, then its default, then empty. */
function initialValues(fields: FlowField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.kind === 'section') {
      values[field.name] = initialValues(field.fields ?? [])
      continue
    }
    if (field.suggested !== undefined) values[field.name] = field.suggested
    else if (field.default !== undefined) values[field.name] = field.default
    else if (field.kind === 'boolean') values[field.name] = false
    else if (field.kind === 'multi_select') values[field.name] = []
    else values[field.name] = ''
  }
  return values
}

const inputStyle: React.CSSProperties = {
  flex: 1, minWidth: 160, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
  color: 'var(--green-soft)', background: '#2effb006',
  border: '1px solid var(--border-holo)', outline: 'none',
}

export function FlowForm({ step, fieldErrors, busy, onSubmit, onCancel }: Props): JSX.Element {
  const kind = flowStepKind(step)
  const fields = normalizeFields(step.data_schema as never)
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(fields))

  // A new step means a new form; keyed on the step id so answers from the
  // previous step never leak into the next one.
  useEffect(() => { setValues(initialValues(normalizeFields(step.data_schema as never))) },
    [step.flow_id, step.step_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (name: string, value: unknown): void => setValues((prev) => ({ ...prev, [name]: value }))
  const setNested = (section: string, name: string, value: unknown): void =>
    setValues((prev) => ({ ...prev, [section]: { ...(prev[section] as object), [name]: value } }))

  // A menu step is a choice of next step; HA synthesizes a one-field select for
  // it, but rendering the options as buttons reads far better.
  if (kind === 'menu') {
    const options = Array.isArray(step.menu_options)
      ? (step.menu_options as string[]).map((o) => ({ value: o, label: o }))
      : Object.entries((step.menu_options ?? {}) as Record<string, string>).map(([value, label]) => ({ value, label }))
    return (
      <div>
        <StepHeading step={step} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {options.map((o) => (
            <button
              key={o.value} type="button" className="holo-btn" disabled={busy}
              style={{ cursor: 'pointer' }}
              onClick={() => onSubmit({ next_step_id: o.value })}
            >{o.label.toUpperCase()}</button>
          ))}
        </div>
      </div>
    )
  }

  if (kind === 'external') {
    return (
      <div>
        <StepHeading step={step} />
        <div className="holo-l" style={{ marginTop: 10 }}>
          THIS INTEGRATION NEEDS YOU TO AUTHORIZE IT IN A BROWSER.
        </div>
        {typeof step.url === 'string' && (
          <a
            href={step.url} target="_blank" rel="noreferrer"
            className="holo-btn" style={{ display: 'inline-block', marginTop: 10, textDecoration: 'none' }}
          >OPEN AUTHORIZATION PAGE ▸</a>
        )}
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button type="button" className="holo-btn" style={{ cursor: 'pointer' }} disabled={busy} onClick={() => onSubmit({})}>
            I&apos;VE DONE IT — CONTINUE
          </button>
          <button type="button" className="holo-btn" style={{ cursor: 'pointer' }} onClick={onCancel}>CANCEL</button>
        </div>
      </div>
    )
  }

  if (kind === 'progress' || kind === 'progress_done' || kind === 'external_done') {
    return (
      <div>
        <StepHeading step={step} />
        <div className="holo-l" style={{ marginTop: 10 }}>
          {kind === 'progress'
            ? `WORKING… ${String(step.progress_action ?? '').toUpperCase()}`
            : 'READY TO CONTINUE.'}
        </div>
        <button
          type="button" className="holo-btn" style={{ cursor: 'pointer', marginTop: 10 }}
          disabled={busy} onClick={() => onSubmit({})}
        >CONTINUE ▸</button>
      </div>
    )
  }

  // Ordinary form step.
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(values) }}
      aria-label={`Config flow step ${step.step_id ?? ''}`}
    >
      <StepHeading step={step} />

      {step.errors && Object.keys(step.errors).length > 0 && (
        <div className="holo-l" style={{ color: 'var(--crimson)', marginTop: 8 }}>
          {Object.entries(step.errors).map(([k, v]) => `${k === 'base' ? '' : `${k}: `}${v}`).join(' · ').toUpperCase()}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {fields.length === 0 && (
          <div className="holo-l">THIS STEP ASKS FOR NOTHING — CONFIRM TO CONTINUE.</div>
        )}
        {fields.map((field) => field.kind === 'section' ? (
          <fieldset key={field.name} style={{ border: '1px solid #2effb022', padding: 10 }}>
            <legend className="holo-l">{field.label}</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(field.fields ?? []).map((sub) => (
                <FieldRow
                  key={sub.name} field={sub}
                  value={(values[field.name] as Record<string, unknown>)?.[sub.name]}
                  error={fieldErrors?.[sub.name]}
                  onChange={(v) => setNested(field.name, sub.name, v)}
                />
              ))}
            </div>
          </fieldset>
        ) : (
          <FieldRow
            key={field.name} field={field} value={values[field.name]}
            error={fieldErrors?.[field.name]}
            onChange={(v) => set(field.name, v)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="submit" className="holo-btn" style={{ cursor: 'pointer' }} disabled={busy}>
          {busy ? 'SENDING…' : 'SUBMIT ▸'}
        </button>
        <button type="button" className="holo-btn" style={{ cursor: 'pointer' }} onClick={onCancel}>CANCEL</button>
      </div>
    </form>
  )
}

function StepHeading({ step }: { step: FlowStepPayload }): JSX.Element {
  const placeholders = step.description_placeholders ?? {}
  return (
    <div>
      <div className="holo-h" style={{ fontSize: 14 }}>
        {String(step.handler ?? '').toUpperCase()}
        {step.step_id ? ` · ${step.step_id.replace(/_/g, ' ').toUpperCase()}` : ''}
      </div>
      {Object.keys(placeholders).length > 0 && (
        <div className="holo-l" style={{ marginTop: 6 }}>
          {Object.entries(placeholders).map(([k, v]) => `${k}: ${v}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

function FieldRow({
  field, value, error, onChange,
}: { field: FlowField; value: unknown; error?: string; onChange: (v: unknown) => void }): JSX.Element {
  const id = `flow-field-${field.name}`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <label htmlFor={id} className="holo-l" style={{ width: 170, color: 'var(--green-soft)' }}>
        {field.label}{field.required ? ' *' : ''}
        {field.secret && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>SECRET</span>}
      </label>
      <Control field={field} id={id} value={value} onChange={onChange} />
      {error && <span className="holo-l" style={{ color: 'var(--crimson)', width: '100%' }}>{error}</span>}
    </div>
  )
}

function Control({
  field, id, value, onChange,
}: { field: FlowField; id: string; value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  switch (field.kind) {
    case 'password':
      return (
        <input
          id={id} type="password" autoComplete="new-password" style={inputStyle}
          value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      )
    case 'number':
      return (
        <input
          id={id} type="number" style={inputStyle}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          value={value === '' || value == null ? '' : Number(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          required={field.required}
        />
      )
    case 'boolean':
      return (
        <input
          id={id} type="checkbox" checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          style={{ accentColor: 'var(--holo)', width: 16, height: 16 }}
        />
      )
    case 'select':
      return (
        <select
          id={id} style={inputStyle} value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)} required={field.required}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    case 'multi_select':
      return (
        <select
          id={id} multiple style={{ ...inputStyle, minHeight: 80 }}
          value={(Array.isArray(value) ? value : []).map(String)}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
        >
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    case 'unsupported':
      return (
        <span className="holo-l" style={{ color: 'var(--amber)', flex: 1 }}>
          THIS FIELD NEEDS A PICKER THIS PANEL CANNOT RENDER — FINISH THIS INTEGRATION IN THE HOME ASSISTANT UI
        </span>
      )
    default:
      return (
        <input
          id={id} type="text" style={inputStyle}
          value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      )
  }
}
