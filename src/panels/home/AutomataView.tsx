// AUTOMATA — scenes, scripts, and automations.
//
// Structurally the registry table with the controls that belong to these three
// domains: activate a scene, run a script, enable/disable/trigger an automation.
// Automations are the only things in the house that act on their own, so their
// enabled state is spelled out rather than implied by a button's colour.

import type { HaEntity } from '../../../shared/homeassistant'
import { actionId } from '../../../shared/agentManifest'
import { relTime } from '../../lib/ha'
import { agentAttrs } from './agentAttrs'

type Send = (entityId: string, service: string, data: Record<string, unknown>) => void

export function AutomataView({ entities, send }: { entities: HaEntity[]; send: Send }): JSX.Element {
  const scenes = entities.filter((e) => e.domain === 'scene')
  const scripts = entities.filter((e) => e.domain === 'script')
  const automations = entities.filter((e) => e.domain === 'automation')

  if (!scenes.length && !scripts.length && !automations.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--green-dim)', letterSpacing: 1 }}>
        NO SCENES, SCRIPTS, OR AUTOMATIONS FOUND
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {scenes.length > 0 && (
        <Section title="SCENES" icon="ti-wand">
          {scenes.map((scene) => (
            <Row key={scene.entityId} name={scene.name} detail={`LAST SET ${relTime(scene.lastChanged)}`}>
              <button
                type="button" className="holo-btn" style={{ cursor: 'pointer' }}
                onClick={() => send(scene.entityId, 'scene.turn_on', {})}
                {...agentAttrs(actionId(scene.entityId, 'activate'), `Activate scene ${scene.name}`, 'write')}
              >ACTIVATE</button>
            </Row>
          ))}
        </Section>
      )}

      {scripts.length > 0 && (
        <Section title="SCRIPTS" icon="ti-script">
          {scripts.map((script) => (
            <Row key={script.entityId} name={script.name} detail={script.state === 'on' ? 'RUNNING' : 'IDLE'}>
              <button
                type="button" className="holo-btn" style={{ cursor: 'pointer' }}
                onClick={() => send(script.entityId, 'script.turn_on', {})}
                {...agentAttrs(actionId(script.entityId, 'run'), `Run script ${script.name}`, 'write')}
              >RUN</button>
            </Row>
          ))}
        </Section>
      )}

      {automations.length > 0 && (
        <Section title="AUTOMATIONS" icon="ti-robot">
          {automations.map((auto) => {
            const enabled = auto.state === 'on'
            const last = auto.attributes['last_triggered'] as string | undefined
            return (
              <Row
                key={auto.entityId}
                name={auto.name}
                detail={`${enabled ? 'ENABLED' : 'DISABLED'} · LAST TRIGGERED ${relTime(last ?? null)}`}
                dim={!enabled}
              >
                <button
                  type="button" className="holo-btn" style={{ cursor: 'pointer' }}
                  onClick={() => send(auto.entityId, 'automation.trigger', {})}
                  {...agentAttrs(actionId(auto.entityId, 'trigger'), `Trigger automation ${auto.name}`, 'write')}
                >TRIGGER</button>
                <button
                  type="button" className="holo-btn" style={{ cursor: 'pointer' }}
                  onClick={() => send(auto.entityId, `automation.turn_${enabled ? 'off' : 'on'}`, {})}
                  {...agentAttrs(actionId(auto.entityId, enabled ? 'disable' : 'enable'),
                    `${auto.name} is ${enabled ? 'enabled' : 'disabled'}; ${enabled ? 'disable' : 'enable'} it`, 'write')}
                >{enabled ? 'DISABLE' : 'ENABLE'}</button>
              </Row>
            )
          })}
        </Section>
      )}
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="holo">
      <div className="holo-h" style={{ fontSize: 13 }}><i className={`ti ${icon}`} style={{ marginRight: 8 }} />{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>{children}</div>
    </div>
  )
}

function Row({
  name, detail, dim, children,
}: { name: string; detail: string; dim?: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: dim ? 0.6 : 1, flexWrap: 'wrap' }}>
      <span className="holo-l" style={{ color: 'var(--green-soft)', minWidth: 180 }}>{name.toUpperCase()}</span>
      <span className="holo-l">{detail}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{children}</span>
    </div>
  )
}
