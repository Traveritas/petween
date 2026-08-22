/**
 * client/settings/MotionPetSettings.tsx — the full settings editor (spec §17).
 * Owns the EditorStore (load on mount, dispose on unmount) and the
 * PreviewSession lifecycle (the session binds to the Live Preview's PetStage
 * via onStage). Renders: the global-settings card on top, then the three
 * columns — StateList | StateSettings (Pose/Transition/Ambient) | LivePreview
 * — then the full-width advanced & interactions card below. Wide mode (the
 * standalone editor page) additionally mounts the V1.1 animation library
 * (visual timeline editor for custom animations, P1) at the bottom.
 *
 * Two hosts mount this component: the standalone editor page
 * (src/editor/index.tsx, served at /motion-pet-editor/) with `wide` — the
 * spec §17 three-column layout — and nothing else: the in-dialog settings
 * section is the compact MotionPetCard. It has no slot-owner props; the only
 * inputs are the optional `api` test seam and the optional
 * `saveIndicatorTarget` portal host (the editor page header).
 *
 * §2.1 gates: loading / load-error / empty (no usable image at all →
 * 「请先导入至少一张图片」 plus an import button) replace the editor columns.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { ActivityTransition, MotionPetConfig, PoseKey, TerminalHold, TransitionPreset } from '../../core/types'
import { POSE_KEYS } from '../../core/types'
import type { AnimationDefinition } from '../../motion/animation-definition'
import { configHub } from '../config-hub'
import type { PetStage } from '../overlay/pet-stage'
import { PreviewSession } from '../preview-session'
import {
  EditorStore,
  hasAnyUsableImage,
  type EditorApi,
  type EditorSnapshot,
} from '../stores/editor-store'
import { AmbientEditor } from './AmbientEditor'
import { AnimationLibrary } from './AnimationLibrary'
import { FileImportButton, NumberField, SelectRow, Slider, Toggle } from './controls'
import { LivePreview } from './LivePreview'
import { PoseEditor } from './PoseEditor'
import { StateList, STATE_LABELS } from './StateList'
import { TransitionEditor } from './TransitionEditor'
import styles from './settings.module.css'

export interface MotionPetSettingsProps {
  /** Test seam; production always uses the default same-origin HTTP API. */
  api?: EditorApi
  /**
   * Standalone editor page: restores the spec §17 three-column layout
   * (StateList | StateSettings | LivePreview). Unset inside narrow hosts.
   */
  wide?: boolean
  /**
   * Standalone editor page: portal host for the SaveIndicator (the page
   * header). Unset → the indicator renders inside the global card instead.
   */
  saveIndicatorTarget?: HTMLElement | null
}

const GLOBAL_PRESET_OPTIONS: ReadonlyArray<{ value: Exclude<TransitionPreset, 'global'>; label: string }> = [
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

const REDUCED_MOTION_OPTIONS: ReadonlyArray<{ value: 'system' | 'always' | 'never'; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'always', label: '始终减弱' },
  { value: 'never', label: '从不减弱' },
]

const TERMINAL_HOLD_OPTIONS: ReadonlyArray<{ value: TerminalHold; label: string }> = [
  { value: 'timed', label: '定时返回（使用停留时长）' },
  { value: 'until-interaction', label: '直到点击宠物或新对话' },
]

const ACTIVITY_TRANSITION_OPTIONS: ReadonlyArray<{ value: ActivityTransition; label: string }> = [
  { value: 'subtle', label: '轻柔淡换（默认）' },
  { value: 'none', label: '直接换图' },
  { value: 'state', label: '播放状态转场' },
]

const CLICK_ANIMATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'builtin:click-pop', label: '轻弹 Pop' },
  { value: 'builtin:click-wiggle', label: '摇摆 Wiggle' },
  { value: 'builtin:click-bounce', label: '弹跳 Bounce' },
  { value: 'builtin:click-spin', label: '旋转 Spin' },
]

/** Built-in click interactions plus the interaction-kind customs (V1.1). */
function clickAnimationOptions(customs: AnimationDefinition[], current: string): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [...CLICK_ANIMATION_OPTIONS]
  for (const definition of customs) {
    if (definition.kind === 'interaction') options.push({ value: definition.id, label: `自定义：${definition.name}` })
  }
  // A dangling id (custom deleted elsewhere) stays visible instead of the
  // select silently showing the first option; the runtime falls back to
  // builtin:click-pop for unknown ids.
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${current}（不可用）` })
  }
  return options
}

const FLASH_POSE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '无（不换图）' },
  ...POSE_KEYS.map((key) => ({ value: key as string, label: STATE_LABELS[key] })),
]

export function SaveIndicator(props: { snapshot: EditorSnapshot; store: EditorStore }): JSX.Element {
  const { snapshot, store } = props
  // UX: 撤回修改 drops the unsaved draft and returns to the last saved
  // config — the same confirm pattern as pet deletion. Offered in the dirty
  // AND error branches (a failed save may be exactly what the user wants to
  // give up on); disabled while a save is in flight (the PUT may still land).
  const revert = (): void => {
    if (!window.confirm('放弃所有未保存的修改，恢复到上次保存的状态？')) return
    void store.revertConfig()
  }
  const revertButton = (disabled: boolean): JSX.Element => (
    <button type="button" className={styles.button} disabled={disabled} onClick={revert}>
      撤回修改
    </button>
  )
  switch (snapshot.saveState) {
    case 'saving':
      return (
        <span className={`${styles.saveState} ${styles.saveBusy}`}>
          <button type="button" className={styles.button} disabled>保存中…</button>
          {revertButton(true)}
        </span>
      )
    case 'dirty':
      return (
        <span className={`${styles.saveState} ${styles.saveBusy}`}>
          <span>有未保存修改</span>
          <button type="button" className={styles.button} onClick={() => void store.saveConfig()}>
            保存修改
          </button>
          {revertButton(false)}
        </span>
      )
    case 'saved':
      return (
        <span className={`${styles.saveState} ${styles.saveOk}`}>
          <span>已保存</span>
          <button type="button" className={styles.button} disabled>保存修改</button>
        </span>
      )
    case 'error':
      return (
        <span className={`${styles.saveState} ${styles.saveError}`}>
          保存失败{snapshot.saveError !== null ? `：${snapshot.saveError}` : ''}
          <button type="button" className={styles.button} onClick={() => store.retrySave()}>
            重试
          </button>
          {revertButton(false)}
        </span>
      )
    default:
      return (
        <span className={`${styles.saveState} ${styles.saveIdle}`}>
          <button type="button" className={styles.button} disabled>保存修改</button>
        </span>
      )
  }
}

function NoticeBar(props: { snapshot: EditorSnapshot; store: EditorStore }): JSX.Element | null {
  const { snapshot, store } = props
  const notice = snapshot.notice
  if (notice === null) return null
  const kindClass =
    notice.kind === 'error' ? styles.noticeError : notice.kind === 'warn' ? styles.noticeWarn : styles.noticeInfo
  return (
    <div
      className={`${styles.notice} ${kindClass}`}
      // Errors are assertive (screen readers interrupt); info/warn stay polite.
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      <button type="button" className={styles.noticeDismiss} aria-label="关闭提示" onClick={() => store.clearNotice()}>
        ✕
      </button>
    </div>
  )
}

/** Named character preset controls, shown only in the standalone editor. */
function PetPresetCard(props: { snapshot: EditorSnapshot; store: EditorStore }): JSX.Element {
  const { snapshot, store } = props
  const config = snapshot.config
  if (config === null) return <></>
  const active = snapshot.pets.find((pet) => pet.id === config.activePetId)

  const askName = (title: string, initial: string): string | null => {
    const value = window.prompt(title, initial)?.trim()
    return value === undefined || value === '' ? null : value
  }

  return (
    <section className={styles.section} aria-label="宠物预设">
      <h2 className={styles.sectionTitle}>宠物</h2>
      <div className={styles.petToolbar}>
        <label className={styles.petSelectLabel}>
          <span className={styles.label}>当前宠物</span>
          <select
            className={styles.select}
            value={config.activePetId ?? ''}
            onChange={(event) => {
              if (event.target.value !== '') void store.applyPet(event.target.value)
            }}
          >
            <option value="">未保存的当前配置</option>
            {snapshot.pets.map((pet) => (
              <option key={pet.id} value={pet.id}>
                {pet.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.petActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              const name = askName('新建当前宠物的副本', active === undefined ? '新宠物' : `${active.name} 副本`)
              if (name !== null) void store.createPetCurrent(name)
            }}
          >
            新建副本
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              const name = askName('新建空白宠物', '新宠物')
              if (name !== null) void store.createPetBlank(name)
            }}
          >
            新建空白
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={active === undefined}
            onClick={() => {
              if (active === undefined) return
              const name = askName('重命名宠物', active.name)
              if (name !== null) void store.renamePet(active.id, name)
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={active === undefined}
            onClick={() => {
              if (active === undefined || !window.confirm(`确认删除宠物「${active.name}」？当前配置会继续保留。`)) return
              void store.deletePet(active.id)
            }}
          >
            删除
          </button>
        </div>
      </div>
      <p className={styles.hint}>点击“保存修改”后，当前配置会写入所选宠物预设；有未保存修改时无法切换宠物。</p>
    </section>
  )
}

/**
 * Global settings card: enabled, scale, reduced motion, the global transition
 * (preset/strength/duration) and the terminal hold durations — a responsive
 * grid of label-aligned control rows (no flex-wrap squeezing).
 */
function GlobalCard(props: { config: MotionPetConfig; store: EditorStore }): JSX.Element {
  const { config, store } = props
  const global = config.global
  return (
    <section className={styles.section} aria-label="全局设置">
      <h2 className={styles.sectionTitle}>全局设置</h2>
      <div className={styles.cardGrid}>
        <Toggle
          label="启用宠物"
          checked={config.enabled}
          onChange={(checked) =>
            store.updateConfig((draft) => {
              draft.enabled = checked
            })
          }
        />
        <Slider
          label="整体缩放"
          min={0.3}
          max={4}
          step={0.05}
          value={global.scale}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.scale = value
            })
          }
        />
        <SelectRow
          label="减少动态"
          value={global.reducedMotion}
          options={REDUCED_MOTION_OPTIONS}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.reducedMotion = value
            })
          }
        />
        <SelectRow
          label="过渡动画"
          value={global.transition.preset}
          options={GLOBAL_PRESET_OPTIONS}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.transition.preset = value
            })
          }
        />
        <Slider
          label="过渡强度"
          min={0}
          max={3}
          step={0.05}
          value={global.transition.strength}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.transition.strength = value
            })
          }
        />
        <Slider
          label="过渡时长"
          min={60}
          max={2000}
          step={10}
          unit="ms"
          value={global.transition.durationMs}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.transition.durationMs = value
            })
          }
        />
        <NumberField
          label="成功停留"
          min={0}
          max={120000}
          step={100}
          unit="ms"
          value={global.successHoldMs}
          disabled={config.advanced.terminalHold !== 'timed'}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.successHoldMs = value
            })
          }
        />
        <NumberField
          label="失败停留"
          min={0}
          max={120000}
          step={100}
          unit="ms"
          value={global.errorHoldMs}
          disabled={config.advanced.terminalHold !== 'timed'}
          onChange={(value) =>
            store.updateConfig((draft) => {
              draft.global.errorHoldMs = value
            })
          }
        />
        {config.advanced.terminalHold === 'until-interaction' && (
          <p className={`${styles.hint} ${styles.hintFull}`}>当前为「直到点击宠物或新对话」，停留时长不适用。</p>
        )}
      </div>
    </section>
  )
}

/**
 * Full-width card below the editor columns: the advanced behaviour switches
 * in one column and the click interactions in another. Long explanations
 * live on their own hint lines so they never break a control row.
 */
function AdvancedCard(props: { config: MotionPetConfig; customs: AnimationDefinition[]; store: EditorStore }): JSX.Element {
  const { config, customs, store } = props
  return (
    <section className={styles.section} aria-label="高级与互动">
      <h2 className={styles.sectionTitle}>高级与互动</h2>
      <div className={styles.cardGrid}>
        <div className={styles.cardColumn}>
          <div className={styles.groupTitle}>高级</div>
          <Toggle
            label="活跃状态内切换姿势"
            checked={config.advanced.changePoseWithinActive}
            onChange={(checked) =>
              store.updateConfig((draft) => {
                draft.advanced.changePoseWithinActive = checked
              })
            }
          />
          <SelectRow
            label="活跃内切换动画"
            value={config.advanced.activityTransition}
            options={ACTIVITY_TRANSITION_OPTIONS}
            disabled={!config.advanced.changePoseWithinActive}
            onChange={(value) =>
              store.updateConfig((draft) => {
                draft.advanced.activityTransition = value
              })
            }
          />
          <p className={styles.hint}>开启后思考/工作使用各自图片，reasoning 与工具调用之间按上方所选方式换图。</p>
          <SelectRow
            label="成功/失败停留"
            value={config.advanced.terminalHold}
            options={TERMINAL_HOLD_OPTIONS}
            onChange={(value) =>
              store.updateConfig((draft) => {
                draft.advanced.terminalHold = value
              })
            }
          />
          <Toggle
            label="粒子特效"
            checked={config.advanced.particles}
            onChange={(checked) =>
              store.updateConfig((draft) => {
                draft.advanced.particles = checked
              })
            }
          />
          <p className={styles.hint}>过渡/交互动画里的纸屑与星星等粒子爆发；开启减少动态效果时始终不发射。</p>
        </div>
        <div className={styles.cardColumn}>
          <div className={styles.groupTitle}>互动</div>
          <SelectRow
            label="点击动画"
            value={config.interactions.click.animation}
            options={clickAnimationOptions(customs, config.interactions.click.animation)}
            onChange={(value) =>
              store.updateConfig((draft) => {
                draft.interactions.click.animation = value
              })
            }
          />
          <SelectRow
            label="点击闪现姿势"
            value={config.interactions.click.pose ?? ''}
            options={FLASH_POSE_OPTIONS}
            onChange={(value) =>
              store.updateConfig((draft) => {
                draft.interactions.click.pose = value === '' ? null : (value as PoseKey)
              })
            }
          />
          <p className={styles.hint}>闪现姿势只在点击动画播放期间临时换图；该姿势没有可用图片时保持不变。</p>
        </div>
      </div>
    </section>
  )
}

export function MotionPetSettings(props: MotionPetSettingsProps): JSX.Element {
  // With an injected api (tests) the store talks to it directly; in production
  // it shares the config hub with the overlay (M3: one config, one GET).
  const [store] = useState(
    () => new EditorStore(props.api !== undefined ? { api: props.api } : { hub: configHub }),
  )
  useEffect(() => {
    void store.load()
    return () => store.dispose()
  }, [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const sessionRef = useRef<PreviewSession | null>(null)

  // UX: an unsaved draft (or a failed/in-flight save) must only leave the page
  // through an explicit browser confirmation. Clean states register nothing.
  useEffect(() => {
    if (snapshot.saveState !== 'dirty' && snapshot.saveState !== 'saving' && snapshot.saveState !== 'error') return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Legacy Chromium/IE only show the prompt when returnValue is assigned.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [snapshot.saveState])

  // The PreviewSession binds to the Live Preview's PetStage; it must be
  // disposed BEFORE the stage DOM goes (PetRenderer's onStage(null) contract).
  const handleStage = useCallback(
    (stage: PetStage | null) => {
      if (stage === null) {
        sessionRef.current?.dispose()
        sessionRef.current = null
        return
      }
      const current = store.getSnapshot()
      if (current.config === null) return // LivePreview only renders when ready
      const session = new PreviewSession({
        stage,
        config: current.config,
        assets: current.assets,
        customs: current.customs,
      })
      sessionRef.current = session
      void session.start()
    },
    [store],
  )

  // V1.1: keep the session registry in step with custom-animation saves.
  const customs = snapshot.customs
  useEffect(() => {
    sessionRef.current?.updateCustoms(customs)
  }, [customs])

  const replayEnter = useCallback(() => {
    sessionRef.current?.replayEnter()
  }, [])

  // UX: the transition panel's 预览进入动画 previews the EDITED state, not
  // whatever the stage currently shows — see PreviewSession.replayStateEnter.
  // The LivePreview toolbar button keeps replaying the shown state.
  const previewEditedEnter = useCallback(() => {
    sessionRef.current?.replayStateEnter(snapshot.selectedState)
  }, [snapshot.selectedState])

  // The save indicator lives in the editor page header when the page supplies
  // a portal host; otherwise (tests, hypothetical narrow hosts) it falls back
  // to a row above the global card. Kept mounted through every gate so the
  // header slot never flashes empty between states.
  const saveIndicator =
    props.saveIndicatorTarget != null ? (
      createPortal(<SaveIndicator snapshot={snapshot} store={store} />, props.saveIndicatorTarget)
    ) : (
      <div className={styles.saveRow}>
        <SaveIndicator snapshot={snapshot} store={store} />
      </div>
    )

  if (snapshot.status === 'loading') {
    return (
      <>
        {saveIndicator}
        <div className={styles.status}>正在加载 Motion Pet 配置…</div>
      </>
    )
  }
  if (snapshot.status === 'error' || snapshot.config === null) {
    return (
      <>
        {saveIndicator}
        <div className={styles.status}>
          配置加载失败{snapshot.loadError !== null ? `：${snapshot.loadError}` : ''}
          <button type="button" className={`${styles.button} ${styles.retry}`} onClick={() => void store.load()}>
            重试
          </button>
        </div>
      </>
    )
  }

  const config = snapshot.config
  const rootClass = props.wide === true ? `${styles.root} ${styles.wide}` : styles.root
  if (!hasAnyUsableImage(config, snapshot.assets)) {
    return (
      <div className={rootClass}>
        {saveIndicator}
        {props.wide === true ? <PetPresetCard snapshot={snapshot} store={store} /> : null}
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>Motion Pet</h2>
          <p className={styles.hint}>
            请先导入至少一张图片（将作为「待机」姿势；推荐透明背景的 PNG 或 WebP，正方形画布）。
          </p>
          <FileImportButton
            label="导入图片"
            busy={snapshot.importing !== null}
            onFile={(file) => void store.importImage(snapshot.selectedState, file)}
          />
        </div>
        <NoticeBar snapshot={snapshot} store={store} />
      </div>
    )
  }

  return (
    <div className={rootClass}>
      {saveIndicator}
      {props.wide === true ? <PetPresetCard snapshot={snapshot} store={store} /> : null}
      <GlobalCard config={config} store={store} />
      <NoticeBar snapshot={snapshot} store={store} />
      <div className={styles.columns}>
        <StateList
          config={config}
          assets={snapshot.assets}
          selected={snapshot.selectedState}
          onSelect={(state) => store.selectState(state)}
        />
        <div className={styles.stateSettings}>
          <PoseEditor
            state={snapshot.selectedState}
            config={config}
            assets={snapshot.assets}
            importing={snapshot.importing === snapshot.selectedState}
            store={store}
          />
          <TransitionEditor
            state={snapshot.selectedState}
            config={config}
            customs={snapshot.customs}
            store={store}
            onReplay={previewEditedEnter}
          />
          <AmbientEditor
            state={snapshot.selectedState}
            config={config}
            customs={snapshot.customs}
            store={store}
          />
        </div>
        <LivePreview
          config={config}
          assets={snapshot.assets}
          configRevision={snapshot.configRevision}
          sessionRef={sessionRef}
          onStage={handleStage}
          onReplay={replayEnter}
        />
      </div>
      <AdvancedCard config={config} customs={snapshot.customs} store={store} />
      {props.wide === true ? (
        <AnimationLibrary
          store={store}
          customs={snapshot.customs}
          config={config}
          assets={snapshot.assets}
          configRevision={snapshot.configRevision}
        />
      ) : null}
    </div>
  )
}
