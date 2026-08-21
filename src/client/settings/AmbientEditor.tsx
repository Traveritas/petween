/**
 * client/settings/AmbientEditor.tsx — the three stackable ambient channels
 * (§17.4): Bounce / Sway / Breathing, each with an enable toggle and its own
 * parameters. Ranges mirror the host validation bounds (host/validation.ts):
 * strength 0..1.8, bounce interval 50..120000ms, bounce duration 50..5000ms,
 * sway angle 0..60°, period 200..120000ms. intervalMin never exceeds
 * intervalMax locally (the host 400s on that).
 */
import type { JSX } from 'react'
import type { MotionPetConfig, PoseKey } from '../../core/types'
import type { EditorStore } from '../stores/editor-store'
import { NumberField, Slider, Toggle } from './controls'
import styles from './settings.module.css'

export interface AmbientEditorProps {
  state: PoseKey
  config: MotionPetConfig
  store: EditorStore
}

export function AmbientEditor(props: AmbientEditorProps): JSX.Element {
  const { state, config, store } = props
  const ambient = config.states[state].ambient

  return (
    <section className={styles.section} aria-label="环境动态">
      <h3 className={styles.sectionTitle}>环境动态 Ambient</h3>

      <Toggle
        label="Bounce 弹跳"
        checked={ambient.bounce.enabled}
        onChange={(checked) =>
          store.updateConfig((draft) => {
            draft.states[state].ambient.bounce.enabled = checked
          })
        }
      />
      <div className={styles.channelFields}>
        <Slider
          label="强度"
          min={0}
          max={1.8}
          step={0.05}
          value={ambient.bounce.strength}
          disabled={!ambient.bounce.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.states[state].ambient.bounce.strength = value
            })
          }
        />
        <NumberField
          label="最小间隔"
          min={50}
          max={120000}
          step={50}
          unit="ms"
          value={ambient.bounce.intervalMinMs}
          disabled={!ambient.bounce.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              const bounce = draft.states[state].ambient.bounce
              bounce.intervalMinMs = value
              if (bounce.intervalMaxMs < value) bounce.intervalMaxMs = value
            })
          }
        />
        <NumberField
          label="最大间隔"
          min={50}
          max={120000}
          step={50}
          unit="ms"
          value={ambient.bounce.intervalMaxMs}
          disabled={!ambient.bounce.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              const bounce = draft.states[state].ambient.bounce
              bounce.intervalMaxMs = Math.max(value, bounce.intervalMinMs)
            })
          }
        />
        <NumberField
          label="弹跳时长"
          min={50}
          max={5000}
          step={10}
          unit="ms"
          value={ambient.bounce.durationMs}
          disabled={!ambient.bounce.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.states[state].ambient.bounce.durationMs = value
            })
          }
        />
      </div>

      <Toggle
        label="Sway 摇摆"
        checked={ambient.sway.enabled}
        onChange={(checked) =>
          store.updateConfig((draft) => {
            draft.states[state].ambient.sway.enabled = checked
          })
        }
      />
      <div className={styles.channelFields}>
        <Slider
          label="角度"
          min={0}
          max={60}
          step={0.1}
          unit="°"
          value={ambient.sway.angleDeg}
          disabled={!ambient.sway.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.states[state].ambient.sway.angleDeg = value
            })
          }
        />
        <NumberField
          label="周期"
          min={200}
          max={120000}
          step={100}
          unit="ms"
          value={ambient.sway.periodMs}
          disabled={!ambient.sway.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.states[state].ambient.sway.periodMs = value
            })
          }
        />
      </div>

      <Toggle
        label="Breathing 呼吸"
        checked={ambient.breathe.enabled}
        onChange={(checked) =>
          store.updateConfig((draft) => {
            draft.states[state].ambient.breathe.enabled = checked
          })
        }
      />
      <div className={styles.channelFields}>
        <Slider
          label="强度"
          min={0}
          max={1.8}
          step={0.02}
          value={ambient.breathe.strength}
          disabled={!ambient.breathe.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.states[state].ambient.breathe.strength = value
            })
          }
        />
        <NumberField
          label="周期"
          min={200}
          max={120000}
          step={100}
          unit="ms"
          value={ambient.breathe.periodMs}
          disabled={!ambient.breathe.enabled}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.states[state].ambient.breathe.periodMs = value
            })
          }
        />
      </div>
    </section>
  )
}
