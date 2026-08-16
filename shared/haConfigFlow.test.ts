import { describe, it, expect } from 'vitest'
import {
  normalizeFields, isSecretField, redactValues, flowStepKind, isTerminalStep,
  type RawField,
} from './haConfigFlow'

describe('normalizeFields — type-shaped fields', () => {
  it('normalizes a plain string field', () => {
    const [field] = normalizeFields([{ name: 'username', required: true, type: 'string' }])
    expect(field).toMatchObject({ name: 'username', kind: 'text', required: true, secret: false })
  })

  it('humanizes the field name into a label', () => {
    const [field] = normalizeFields([{ name: 'api_host', type: 'string' }])
    expect(field?.label).toBe('API HOST')
  })

  it('treats a missing required flag as optional', () => {
    const [field] = normalizeFields([{ name: 'port', type: 'integer' }])
    expect(field?.required).toBe(false)
  })

  it('maps integer and float to a number field, carrying range bounds', () => {
    const fields = normalizeFields([
      { name: 'port', type: 'integer', valueMin: 1, valueMax: 65535 },
      { name: 'scale', type: 'float' },
    ])
    expect(fields[0]).toMatchObject({ kind: 'number', min: 1, max: 65535 })
    expect(fields[1]?.kind).toBe('number')
  })

  it('maps boolean', () => {
    expect(normalizeFields([{ name: 'ssl', type: 'boolean' }])[0]?.kind).toBe('boolean')
  })

  it('converts select option pairs into value/label objects', () => {
    const [field] = normalizeFields([
      { name: 'mode', type: 'select', options: [['a', 'Alpha'], ['b', 'Bravo']] },
    ])
    expect(field?.kind).toBe('select')
    expect(field?.options).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Bravo' },
    ])
  })

  it('converts a multi_select options map', () => {
    const [field] = normalizeFields([
      { name: 'zones', type: 'multi_select', options: { z1: 'Zone One', z2: 'Zone Two' } },
    ])
    expect(field?.kind).toBe('multi_select')
    expect(field?.options).toEqual([
      { value: 'z1', label: 'Zone One' },
      { value: 'z2', label: 'Zone Two' },
    ])
  })

  it('carries a default through', () => {
    expect(normalizeFields([{ name: 'port', type: 'integer', default: 8123 }])[0]?.default).toBe(8123)
  })

  it('reads a suggested value out of the description object', () => {
    const [field] = normalizeFields([
      { name: 'host', type: 'string', description: { suggested_value: '10.0.0.4' } },
    ])
    expect(field?.suggested).toBe('10.0.0.4')
  })

  it('ignores a description that is a plain string rather than a suggestion', () => {
    const [field] = normalizeFields([{ name: 'host', type: 'string', description: 'the hostname' }])
    expect(field?.suggested).toBeUndefined()
  })
})

describe('normalizeFields — selector-shaped fields', () => {
  it('recognizes a password text selector, which carries no type key at all', () => {
    const [field] = normalizeFields([
      { name: 'access_token', required: true, selector: { text: { type: 'password' } } },
    ])
    expect(field).toMatchObject({ kind: 'password', secret: true, required: true })
  })

  it('maps a plain text selector', () => {
    expect(normalizeFields([{ name: 'host', selector: { text: {} } }])[0]?.kind).toBe('text')
  })

  it('maps a number selector with its bounds', () => {
    const [field] = normalizeFields([{ name: 'port', selector: { number: { min: 1, max: 100 } } }])
    expect(field).toMatchObject({ kind: 'number', min: 1, max: 100 })
  })

  it('maps a boolean selector', () => {
    expect(normalizeFields([{ name: 'ssl', selector: { boolean: {} } }])[0]?.kind).toBe('boolean')
  })

  it('maps a select selector whose options are plain strings', () => {
    const [field] = normalizeFields([
      { name: 'mode', selector: { select: { options: ['fast', 'slow'] } } },
    ])
    expect(field?.options).toEqual([
      { value: 'fast', label: 'fast' },
      { value: 'slow', label: 'slow' },
    ])
  })

  it('maps a select selector whose options are value/label objects', () => {
    const [field] = normalizeFields([
      { name: 'mode', selector: { select: { options: [{ value: 'f', label: 'Fast' }] } } },
    ])
    expect(field?.options).toEqual([{ value: 'f', label: 'Fast' }])
  })

  it('marks a multiple select as multi_select', () => {
    const [field] = normalizeFields([
      { name: 'zones', selector: { select: { options: ['a'], multiple: true } } },
    ])
    expect(field?.kind).toBe('multi_select')
  })

  it('falls back to unsupported for a selector it cannot render', () => {
    const [field] = normalizeFields([{ name: 'thing', selector: { addon: {} } }])
    expect(field?.kind).toBe('unsupported')
  })
})

describe('normalizeFields — sections and edge cases', () => {
  it('recurses into an expandable section', () => {
    const [section] = normalizeFields([
      {
        name: 'advanced', type: 'expandable', expanded: false,
        schema: [{ name: 'timeout', type: 'integer' }],
      },
    ])
    expect(section?.kind).toBe('section')
    expect(section?.fields?.[0]).toMatchObject({ name: 'timeout', kind: 'number' })
  })

  it('skips constant display fields, which take no input', () => {
    expect(normalizeFields([{ name: 'note', type: 'constant', value: 'hi' }])).toEqual([])
  })

  it('skips a field with no name', () => {
    expect(normalizeFields([{ type: 'string' } as RawField])).toEqual([])
  })

  it('returns an empty list for a null or missing schema', () => {
    expect(normalizeFields(null)).toEqual([])
    expect(normalizeFields(undefined)).toEqual([])
  })

  it('preserves schema order', () => {
    const fields = normalizeFields([
      { name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'c', type: 'string' },
    ])
    expect(fields.map((f) => f.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('isSecretField', () => {
  const of = (raw: RawField) => normalizeFields([raw])[0]!

  it('treats a password selector as secret', () => {
    expect(isSecretField(of({ name: 'whatever', selector: { text: { type: 'password' } } }))).toBe(true)
  })

  it('treats obviously credential-shaped names as secret even as plain strings', () => {
    for (const name of ['password', 'api_key', 'apikey', 'access_token', 'client_secret', 'passphrase', 'pin']) {
      expect(isSecretField(of({ name, type: 'string' })), name).toBe(true)
    }
  })

  it('matches credential names case-insensitively', () => {
    expect(isSecretField(of({ name: 'API_KEY', type: 'string' }))).toBe(true)
  })

  it('does not treat ordinary fields as secret', () => {
    for (const name of ['host', 'port', 'username', 'name', 'ssl']) {
      expect(isSecretField(of({ name, type: 'string' })), name).toBe(false)
    }
  })
})

describe('redactValues', () => {
  const fields = normalizeFields([
    { name: 'host', type: 'string' },
    { name: 'password', type: 'string' },
    { name: 'port', type: 'integer' },
  ])

  it('keeps ordinary values so the audit entry stays useful', () => {
    expect(redactValues({ host: '10.0.0.4', port: 8123 }, fields))
      .toEqual({ host: '10.0.0.4', port: 8123 })
  })

  it('redacts a secret field', () => {
    expect(redactValues({ host: 'h', password: 'hunter2' }, fields))
      .toEqual({ host: 'h', password: '[redacted]' })
  })

  it('fails closed: redacts any key the schema does not describe', () => {
    // An unknown key cannot be classified, so it cannot be shown to be safe —
    // and the audit log is never rewritten.
    expect(redactValues({ mystery: 'value' }, fields)).toEqual({ mystery: '[redacted]' })
  })

  it('redacts every value when the schema is empty', () => {
    expect(redactValues({ a: 1, b: 2 }, [])).toEqual({ a: '[redacted]', b: '[redacted]' })
  })

  it('recurses into section values', () => {
    const withSection = normalizeFields([
      { name: 'advanced', type: 'expandable', schema: [
        { name: 'token', type: 'string' }, { name: 'timeout', type: 'integer' },
      ] },
    ])
    expect(redactValues({ advanced: { token: 'abc', timeout: 30 } }, withSection))
      .toEqual({ advanced: { token: '[redacted]', timeout: 30 } })
  })

  it('handles an empty payload', () => {
    expect(redactValues({}, fields)).toEqual({})
  })
})

describe('flowStepKind / isTerminalStep', () => {
  it('reads the step type', () => {
    expect(flowStepKind({ type: 'form' })).toBe('form')
    expect(flowStepKind({ type: 'create_entry' })).toBe('create_entry')
  })

  it('treats an unknown or missing type as unknown', () => {
    expect(flowStepKind({})).toBe('unknown')
    expect(flowStepKind({ type: 'something_new' })).toBe('unknown')
  })

  it('recognizes HA wire names for the external and progress steps', () => {
    expect(flowStepKind({ type: 'external' })).toBe('external')
    expect(flowStepKind({ type: 'progress_done' })).toBe('progress_done')
  })

  it('treats create_entry and abort as terminal, and form as not', () => {
    expect(isTerminalStep({ type: 'create_entry' })).toBe(true)
    expect(isTerminalStep({ type: 'abort' })).toBe(true)
    expect(isTerminalStep({ type: 'form' })).toBe(false)
    expect(isTerminalStep({ type: 'menu' })).toBe(false)
  })
})
