/**
 * client/settings/TransitionEditor.tsx — per-state enter transition panel
 * (§17.3): the transition select is grouped into 内置 presets (`global` =
 * inherit the global transition, in which case strength/duration are inherited
 * and disabled) plus a 自定义 group of the transition-kind customs (§8.14 —
 * picking one sets enter.animationId, which the director prioritizes over the
 * preset; picking a preset clears it). Strength (0..3) and duration
 * (60..2000ms) sliders per the widened §7.4 bounds, plus a replay button that
 * runs the real transition through the Live Preview session.
 */
import type { JSX } from 'react'
import type { PetweenConfig, PoseKey, TransitionPreset } from '../../core/types'
import type { AnimationDefinition } from '../../motion/animation-definition'
import type { EditorStore } from '../stores/editor-store'
import { GroupedSelectRow, Slider } from './controls'
import styles from './settings.module.css'

export const TRANSITION_PRESET_OPTIONS: ReadonlyArray<{ value: TransitionPreset; label: string }> = [
  { value: 'global', label: '继承全局' },
  { value: 'none', label: '无' },
  { value: 'soft', label: '柔和 Soft' },
  { value: 'comic-pop', label: '漫画弹出 Comic Pop' },
  { value: 'jelly', label: '果冻 Jelly' },
  { value: 'jump', label: '跳跃 Jump' },
  { value: 'snap', label: '闪现 Snap' },
  { value: 'flip', label: '翻转 Flip' },
  { value: 'celebrate', label: '庆祝 Celebrate' },
  { value: 'deflate', label: '泄气 Deflate' },
]

export interface TransitionEditorProps {
  state: PoseKey
  config: PetweenConfig
  /** V1.1 customs (all kinds; only transition-kind ones are listed). */
  customs: AnimationDefinition[]
  store: EditorStore
  onReplay: () => void
}

export function TransitionEditor(props: TransitionEditorProps): JSX.Element {
  const { state, config, customs, store, onReplay } = props
  const enter = config.states[state].enter
  const inherited = enter.preset === 'global'

  const customTransitions = customs.filter((definition) => definition.kind === 'transition')
  // A custom selection is shown by its animationId; a `builtin:` id echoes
  // the preset option. A dangling user: id (the custom was deleted) gets an
  // explicit 「（不可用）」 option instead of silently showing the fallback
  // preset — the real config value stays visible (mirrors AmbientEditor).
  const customSelected =
    enter.animationId !== undefined && customTransitions.some((definition) => definition.id === enter.animationId)
  const builtinAnimationId =
    enter.animationId !== undefined && enter.animationId.startsWith('builtin:')
      ? enter.animationId.slice('builtin:'.length)
      : undefined
  const builtinEchoed =
    builtinAnimationId !== undefined && TRANSITION_PRESET_OPTIONS.some((option) => option.value === builtinAnimationId)
  const danglingAnimationId =
    enter.animationId !== undefined && !customSelected && !builtinEchoed ? enter.animationId : undefined
  const selectValue = customSelected
    ? (enter.animationId as string)
    : builtinEchoed
      ? (builtinAnimationId as TransitionPreset)
      : (danglingAnimationId ?? enter.preset)

  const customOptions = customTransitions.map((definition) => ({ value: definition.id, label: definition.name }))
  if (danglingAnimationId !== undefined) {
    customOptions.push({ value: danglingAnimationId, label: `${danglingAnimationId}（不可用）` })
  }
  const groups: Array<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }> = [
    { label: '内置', options: TRANSITION_PRESET_OPTIONS },
  ]
  if (customOptions.length > 0) {
    groups.push({ label: '自定义', options: customOptions })
  }

  return (
    <section className={styles.section} aria-label="进入过渡动画">
      <h3 className={styles.sectionTitle}>进入过渡动画</h3>
      <GroupedSelectRow
        label="预设"
        value={selectValue}
        groups={groups}
        onChange={(value) =>
          store.updateConfig((draft) => {
            const draftEnter = draft.states[state].enter
            if (value.startsWith('user:')) {
              // §8.14: the preset stays as the fallback for a dangling id.
              draftEnter.animationId = value
            } else {
              draftEnter.preset = value as TransitionPreset
              delete draftEnter.animationId
            }
          })
        }
      />
      {customSelected ? (
        <p className={styles.hint}>使用自定义动画；上方预设作为自定义动画缺失时的回落。</p>
      ) : null}
      {inherited ? <p className={styles.hint}>继承上方全局过渡动画的参数。</p> : null}
      <Slider
        label="强度"
        min={0}
        max={3}
        step={0.05}
        value={enter.strength}
        disabled={inherited}
        onChange={(value) =>
          store.updateConfig((draft) => {
            draft.states[state].enter.strength = value
          })
        }
      />
      <Slider
        label="时长"
        min={60}
        max={2000}
        step={10}
        unit="ms"
        value={enter.durationMs}
        disabled={inherited}
        onChange={(value) =>
          store.updateConfig((draft) => {
            draft.states[state].enter.durationMs = value
          })
        }
      />
      <button type="button" className={styles.button} onClick={onReplay}>
        ▶ 预览进入动画
      </button>
    </section>
  )
}
