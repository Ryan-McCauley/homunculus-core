// ── Tile configuration ─────────────────────────────────────────────────
// The editable half of the HOME tab's device tiles. Discovery guesses; this is
// where the operator corrects the guess, and the correction is what persists.
//
// One screen, three things to do: rebind a slot, retune a threshold, add or drop
// a tile. Everything is a plain control writing straight through to the server
// (debounced) — no draft/apply step, because a mis-bound slot is visible in the
// tile behind this panel the moment it changes, which is a faster correctness
// check than any confirm dialog.
//
// SLOT PICKERS SHOW EVERY LEGAL ENTITY, ordered by how well it fits. The ranking
// is discovery's own scoring, so the entity it would have chosen sits at the
// top, but nothing is hidden — a house that names things unusually is exactly
// the house that needs the full list.

import { useMemo, useState } from 'react'
import type { HaEntity } from '../../../shared/homeassistant'
import {
  candidatesFor, stemOf,
  type HomeTileConfig, type HomeTileRow, type TileOption, type TileSlot, type TileSpec,
} from '../../../shared/homeTiles'
import { getTileSpec, TILE_SPECS } from '../../../shared/homeTileSpecs'
import type { HomeTilesApi } from '../../hooks/useHomeTiles'

const label: React.CSSProperties = {
  fontSize: 11, letterSpacing: 1.5, color: 'var(--green-dim)', textTransform: 'uppercase',
}

const input: React.CSSProperties = {
  background: 'var(--bg-elev)', border: '0.5px solid var(--border)', color: 'var(--green)',
  fontFamily: 'var(--font-mono)', fontSize: 12, padding: '4px 6px', width: '100%',
}

const btn = (tone: 'normal' | 'danger' | 'primary' = 'normal'): React.CSSProperties => ({
  background: tone === 'primary' ? 'var(--bg-elev)' : 'transparent',
  border: `0.5px solid ${tone === 'danger' ? 'var(--border-crimson)' : 'var(--border)'}`,
  color: tone === 'danger' ? 'var(--crimson)' : 'var(--green-dim)',
  fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1,
  padding: '4px 9px', cursor: 'pointer',
})

/** `sensor.washer_power` + friendly name + live state, for a picker option. */
function optionLabel(e: HaEntity): string {
  const state = e.state.length > 18 ? `${e.state.slice(0, 18)}…` : e.state
  return `${e.entityId}  ·  ${e.name}  ·  ${state}${e.unit ?? ''}`
}

// ── One slot ────────────────────────────────────────────────────────────

function SlotRow({
  slot, value, entities, stem, onChange,
}: {
  slot: TileSlot
  value: string
  entities: HaEntity[]
  stem: string | undefined
  onChange: (entityId: string) => void
}): JSX.Element {
  const candidates = useMemo(() => candidatesFor(slot, entities, stem), [slot, entities, stem])
  // A binding pointing at an entity HA no longer reports must stay selectable,
  // or opening this panel while an integration is reloading would silently drop
  // it on the next keystroke elsewhere in the form.
  const missing = value && !candidates.some((c) => c.entityId === value)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 8, alignItems: 'start' }}>
      <div style={{ paddingTop: 5 }}>
        <div style={{ ...label, color: slot.required ? 'var(--green)' : 'var(--green-dim)' }}>
          {slot.label}{slot.required ? ' *' : ''}
        </div>
        {slot.hint && (
          <div style={{ fontSize: 10, color: 'var(--green-dim)', opacity: 0.7, marginTop: 2, lineHeight: 1.4 }}>
            {slot.hint}
          </div>
        )}
      </div>
      <div>
        <select value={value} onChange={(e) => onChange(e.target.value)} style={input}>
          <option value="">— not bound —</option>
          {missing && <option value={value}>{value} · (not currently reported by HA)</option>}
          {candidates.map((c) => (
            <option key={c.entityId} value={c.entityId}>{optionLabel(c)}</option>
          ))}
        </select>
        {candidates.length === 0 && (
          <div style={{ fontSize: 10, color: 'var(--green-dim)', marginTop: 3 }}>
            No {slot.domains.join(' / ')} entities in this house.
          </div>
        )}
      </div>
    </div>
  )
}

// ── One option ──────────────────────────────────────────────────────────

function OptionRow({
  option, value, onChange,
}: {
  option: TileOption
  value: string | number | boolean
  onChange: (v: string | number | boolean) => void
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 8, alignItems: 'start' }}>
      <div style={{ paddingTop: 5 }}>
        <div style={label}>{option.label}</div>
        {option.hint && (
          <div style={{ fontSize: 10, color: 'var(--green-dim)', opacity: 0.7, marginTop: 2, lineHeight: 1.4 }}>
            {option.hint}
          </div>
        )}
      </div>
      <div>
        {option.kind === 'number' && (
          <input
            type="number" style={input} value={String(value)}
            min={option.min} max={option.max} step={option.min && option.min < 1 ? 0.5 : 1}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        )}
        {option.kind === 'text' && (
          <input type="text" style={input} value={String(value)} onChange={(e) => onChange(e.target.value)} />
        )}
        {option.kind === 'select' && (
          <select style={input} value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {(option.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {option.kind === 'boolean' && (
          <button type="button" style={btn(value ? 'primary' : 'normal')} onClick={() => onChange(!value)}>
            {value ? '◉ ON' : '○ OFF'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Repeatable rows ─────────────────────────────────────────────────────

function RowsEditor({
  spec, tile, entities, onChange,
}: {
  spec: TileSpec
  tile: HomeTileConfig
  entities: HaEntity[]
  onChange: (rows: HomeTileRow[]) => void
}): JSX.Element | null {
  const rowSpec = spec.rows
  if (!rowSpec) return null
  const rows = tile.rows ?? []

  const setRow = (i: number, next: HomeTileRow): void =>
    onChange(rows.map((r, j) => (j === i ? next : r)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((row, i) => {
        // Each row is its own device, so its slots rank against its own anchor.
        const anchor = row.bindings[rowSpec.slots[0]?.key ?? '']
        const stem = anchor ? stemOf(anchor) : undefined
        return (
          <div key={i} style={{ border: '0.5px solid var(--border)', padding: 9, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text" style={{ ...input, width: 160 }} value={row.label}
                placeholder={`${rowSpec.noun} name`}
                onChange={(e) => setRow(i, { ...row, label: e.target.value })}
              />
              <span style={{ flex: 1 }} />
              <button type="button" style={btn('danger')} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                ✕ REMOVE
              </button>
            </div>
            {rowSpec.slots.map((slot) => (
              <SlotRow
                key={slot.key} slot={slot} entities={entities} stem={stem}
                value={row.bindings[slot.key] ?? ''}
                onChange={(entityId) => {
                  const bindings = { ...row.bindings }
                  if (entityId) bindings[slot.key] = entityId
                  else delete bindings[slot.key]
                  setRow(i, { ...row, bindings })
                }}
              />
            ))}
          </div>
        )
      })}
      <div>
        <button
          type="button" style={btn()}
          onClick={() => onChange([...rows, { label: `New ${rowSpec.noun}`, bindings: {} }])}
        >
          + ADD {rowSpec.noun.toUpperCase()}
        </button>
      </div>
    </div>
  )
}

// ── One tile ────────────────────────────────────────────────────────────

function TileEditor({
  tile, spec, entities, api, index, total,
}: {
  tile: HomeTileConfig
  spec: TileSpec
  entities: HaEntity[]
  api: HomeTilesApi
  index: number
  total: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorId = tile.bindings[spec.anchor]
  const stem = anchorId ? stemOf(anchorId) : undefined

  const setBinding = (key: string, entityId: string): void => {
    api.updateTile(tile.id, (t) => {
      const bindings = { ...t.bindings }
      if (entityId) bindings[key] = entityId
      else delete bindings[key]
      return { ...t, bindings }
    })
  }

  const unbound = spec.slots.filter((s) => !tile.bindings[s.key]).length

  return (
    <div style={{ border: '0.5px solid var(--border)', background: 'var(--bg-elev)' }}>
      {/* summary row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px' }}>
        <button
          type="button" onClick={() => setOpen((v) => !v)}
          style={{ ...btn(), border: 'none', padding: 0, width: 16, color: 'var(--green)' }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>
        <i className={`ti ${spec.icon}`} style={{ color: 'var(--green)', fontSize: 14 }} />
        <input
          type="text"
          style={{ ...input, width: 180, opacity: tile.enabled ? 1 : 0.5 }}
          value={tile.title}
          placeholder={spec.defaultTitle}
          onChange={(e) => api.updateTile(tile.id, (t) => ({ ...t, title: e.target.value }))}
        />
        <span style={{ ...label, opacity: 0.7 }}>{spec.label}</span>
        {unbound > 0 && (
          <span style={{ ...label, color: 'var(--green-dim)' }}>· {unbound} slot{unbound > 1 ? 's' : ''} empty</span>
        )}
        <span style={{ flex: 1 }} />

        <button type="button" style={btn()} disabled={index === 0}
          onClick={() => api.moveTile(tile.id, -1)} aria-label="Move up"
        >▲</button>
        <button type="button" style={btn()} disabled={index === total - 1}
          onClick={() => api.moveTile(tile.id, 1)} aria-label="Move down"
        >▼</button>
        <button
          type="button" style={btn(tile.enabled ? 'primary' : 'normal')}
          onClick={() => api.updateTile(tile.id, (t) => ({ ...t, enabled: !t.enabled }))}
          title="A hidden tile keeps its bindings and still claims its device on a re-scan"
        >
          {tile.enabled ? '◉ SHOWN' : '○ HIDDEN'}
        </button>
        <button type="button" style={btn('danger')} onClick={() => api.removeTile(tile.id)}>✕</button>
      </div>

      {open && (
        <div style={{ borderTop: '0.5px solid var(--border)', padding: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {spec.slots.map((slot) => (
            <SlotRow
              key={slot.key} slot={slot} entities={entities}
              // The anchor ranks against nothing; everything else ranks against
              // the anchor's device, which is what puts the right sensor first.
              stem={slot.key === spec.anchor ? undefined : stem}
              value={tile.bindings[slot.key] ?? ''}
              onChange={(id) => setBinding(slot.key, id)}
            />
          ))}

          {spec.rows && (
            <>
              <div style={{ ...label, borderTop: '0.5px solid var(--border)', paddingTop: 9 }}>
                {spec.rows.noun}s
              </div>
              <RowsEditor
                spec={spec} tile={tile} entities={entities}
                onChange={(rows) => api.updateTile(tile.id, (t) => ({ ...t, rows }))}
              />
            </>
          )}

          {spec.options.length > 0 && (
            <>
              <div style={{ ...label, borderTop: '0.5px solid var(--border)', paddingTop: 9 }}>Options</div>
              {spec.options.map((opt) => (
                <OptionRow
                  key={opt.key} option={opt}
                  value={tile.options[opt.key] ?? opt.default}
                  onChange={(v) => api.updateTile(tile.id, (t) => ({ ...t, options: { ...t.options, [opt.key]: v } }))}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────

export function TileConfigPanel({
  api, entities, onClose,
}: {
  api: HomeTilesApi
  entities: HaEntity[]
  onClose: () => void
}): JSX.Element {
  const [adding, setAdding] = useState('')
  const tiles = api.config.tiles

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        borderBottom: '0.5px solid var(--border)', paddingBottom: 9,
      }}>
        <span style={{ ...label, color: 'var(--green)', fontSize: 12 }}>DEVICE TILES</span>
        <span style={{ fontSize: 10, color: 'var(--green-dim)' }}>
          {tiles.length} configured · {entities.length} entities available
        </span>
        <span style={{ flex: 1 }} />

        <button type="button" style={btn()} disabled={api.busy} onClick={api.rescan}
          title="Add tiles for devices that appeared since setup. Existing tiles are left exactly as they are."
        >
          {api.busy ? '…' : '⟳ SCAN FOR NEW DEVICES'}
        </button>
        <button type="button" style={btn('danger')} disabled={api.busy} onClick={api.reset}
          title="Discard every tile and rebuild from the house as it is now. Renames, thresholds and manual bindings are lost."
        >
          RESET ALL
        </button>
        <button type="button" style={btn('primary')} onClick={onClose}>DONE</button>
      </div>

      {api.error && (
        <div style={{ fontSize: 11, color: 'var(--crimson)', letterSpacing: 1 }}>{api.error}</div>
      )}

      {tiles.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--green-dim)', letterSpacing: 1, padding: '14px 0', lineHeight: 1.6 }}>
          No device tiles yet.
          {entities.length === 0
            ? ' Home Assistant is not reporting any entities — check HA_URL and HA_TOKEN.'
            : ' Press SCAN FOR NEW DEVICES to look for thermostats, appliances and litter boxes, or add a tile below and bind it yourself.'}
        </div>
      )}

      {tiles.map((tile, i) => {
        const spec = getTileSpec(tile.type)
        if (!spec) return null
        return (
          <TileEditor
            key={tile.id} tile={tile} spec={spec} entities={entities}
            api={api} index={i} total={tiles.length}
          />
        )
      })}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 4 }}>
        <span style={label}>Add a tile</span>
        <select
          style={{ ...input, width: 240 }} value={adding}
          onChange={(e) => {
            if (e.target.value) api.addTile(e.target.value)
            setAdding('')
          }}
        >
          <option value="">— choose a type —</option>
          {TILE_SPECS.map((s) => <option key={s.type} value={s.type}>{s.label}</option>)}
        </select>
      </div>
    </div>
  )
}
