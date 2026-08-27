/**
 * client/settings/AnimationLibrary.tsx — the V1.1 animation library.
 * Standalone editor page only (PetweenSettings renders it in wide mode):
 * built-in definitions (cloneable) and the host-persisted customs on the
 * left; the scalar form (name / kind / durationMs / repeat) plus the visual
 * TimelineEditor (P1) on the right, with a collapsible JSON view for
 * paste/apply bulk edits.
 *
 * Gating: the TimelineEditor reports validateTimelineDraft errors through
 * onValidationChange (also listed inline there); this panel adds the scalar
 * validation (name / durationMs / repeat / cross-field rules) by running
 * validateAnimationDefinition on the assembled candidate. 保存/试播/克隆 all
 * require both channels clean. 试播 uses the library's own renderer and can
 * be stopped independently; 循环试播 re-auditions automatically ~600ms after
 * the last edit. Switching/creating/cloning/deleting with unsaved edits asks
 * for confirmation first (the selected list entry carries a ● marker until
 * the draft matches its saved version again).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { BUILTIN_AMBIENT_DEFINITIONS } from '../../core/ambient-presets'
import { BUILTIN_INTERACTION_DEFINITIONS, BUILTIN_TRANSITION_DEFINITIONS } from '../../core/transition-presets'
import type { AssetMeta, PetweenConfig } from '../../core/types'
import type {
  AnimationDefinition,
  AnimationKind,
  MotionTrack,
  RepeatPolicy,
  TimelineEvent,
} from '../../motion/animation-definition'
import { validateAnimationDefinition } from '../../motion/animation-definition'
import { MOTION_PROPERTIES } from '../../motion/motion-properties'
import { TimelineEditor } from '../timeline/TimelineEditor'
import { addTrack, validateTimelineDraft } from '../timeline/timeline-model'
import { PetRenderer } from '../overlay/PetRenderer'
import type { PetStage } from '../overlay/pet-stage'
import { PreviewSession } from '../preview-session'
import type { EditorStore } from '../stores/editor-store'
import { NumberField, SelectRow, Slider, Toggle } from './controls'
import styles from './settings.module.css'

/** Every built-in definition, mirroring what the sessions register. */
const BUILTIN_DEFINITIONS: readonly AnimationDefinition[] = [
  ...BUILTIN_TRANSITION_DEFINITIONS,
  ...BUILTIN_AMBIENT_DEFINITIONS,
  ...BUILTIN_INTERACTION_DEFINITIONS,
]

const KIND_LABELS: Record<AnimationKind, string> = {
  transition: '过渡',
  ambient: '循环动画',
  interaction: '互动',
}

const KIND_OPTIONS: ReadonlyArray<{ value: AnimationKind; label: string }> = [
  { value: 'transition', label: '过渡 transition' },
  { value: 'ambient', label: '循环动画 ambient' },
  { value: 'interaction', label: '互动 interaction' },
]

const REPEAT_MODE_OPTIONS: ReadonlyArray<{ value: RepeatPolicy['mode']; label: string }> = [
  { value: 'once', label: '单次' },
  { value: 'loop', label: '循环' },
  { value: 'alternate', label: '往返' },
  { value: 'random-interval', label: '随机间隔' },
]

/** Debounce for the 循环试播 auto-replay after an edit. */
const AUTO_REPLAY_DELAY_MS = 600

/** A guaranteed-valid starting point for 新建 (one squash track + pose-swap). */
function newAnimationTemplate(): AnimationDefinition {
  return {
    version: 1,
    id: `user:${crypto.randomUUID()}`,
    name: '新建动画',
    kind: 'transition',
    durationMs: 300,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.scaleY',
        keyframes: [
          { at: 0, value: 1 },
          { at: 0.45, value: { base: 1, parameter: 'strength', amount: -0.25 }, easing: 'anticipate' },
          { at: 1, value: 1 },
        ],
      },
    ],
    events: [{ at: 0.45, type: 'pose-swap' }],
    parameters: { strength: { default: 1, min: 0, max: 3 } },
  }
}

/** The editable draft: scalar fields plus structured tracks/events. */
interface DraftState {
  name: string
  kind: AnimationKind
  durationMs: number
  repeatMode: RepeatPolicy['mode']
  repeatMinMs: number
  repeatMaxMs: number
  tracks: MotionTrack[]
  events: TimelineEvent[]
}

function draftFrom(definition: AnimationDefinition): DraftState {
  const repeat = definition.repeat
  return {
    name: definition.name,
    kind: definition.kind,
    durationMs: definition.durationMs,
    repeatMode: repeat.mode,
    repeatMinMs: repeat.mode === 'random-interval' ? repeat.minDelayMs : 800,
    repeatMaxMs: repeat.mode === 'random-interval' ? repeat.maxDelayMs : 1300,
    tracks: structuredClone(definition.tracks),
    events: structuredClone(definition.events ?? []),
  }
}

interface DraftEvaluation {
  /** The assembled definition; null while any field or timeline part is schema-invalid. */
  definition: AnimationDefinition | null
  errors: string[]
}

/** Assemble the draft into a candidate and run the real schema validation. */
function evaluateDraft(
  baseId: string,
  parameters: AnimationDefinition['parameters'],
  draft: DraftState,
): DraftEvaluation {
  const repeat: RepeatPolicy =
    draft.repeatMode === 'random-interval'
      ? { mode: 'random-interval', minDelayMs: draft.repeatMinMs, maxDelayMs: draft.repeatMaxMs }
      : { mode: draft.repeatMode }
  // version/id are immutable; parameters (strength range) are preserved from
  // the base definition. An empty events list is omitted from the payload.
  const candidate: Record<string, unknown> = {
    version: 1,
    id: baseId,
    name: draft.name,
    kind: draft.kind,
    durationMs: draft.durationMs,
    repeat,
    tracks: draft.tracks,
    ...(draft.events.length > 0 ? { events: draft.events } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  }
  const result = validateAnimationDefinition(candidate)
  if (!result.valid) return { definition: null, errors: result.errors }
  return { definition: candidate as unknown as AnimationDefinition, errors: [] }
}

/**
 * UX-2 dirty check, run on the ASSEMBLED definitions (exactly what a save
 * would persist). A raw DraftState comparison would flag repeatMinMs/MaxMs
 * leftovers — e.g. a custom interval from an earlier random-interval setting
 * that a non-random-interval save legitimately drops (evaluateDraft omits
 * them) — and keep the ● marker on forever after such a save. An invalid
 * draft (null assembly) always counts as dirty so the unsaved-edit guards
 * stay armed.
 */
function draftDivergesFromBaseline(
  selected: AnimationDefinition,
  assembled: AnimationDefinition | null,
): boolean {
  if (assembled === null) return true
  const baseline = evaluateDraft(selected.id, selected.parameters, draftFrom(selected)).definition
  return baseline === null || JSON.stringify(assembled) !== JSON.stringify(baseline)
}

export interface AnimationLibraryProps {
  store: EditorStore
  customs: AnimationDefinition[]
  config: PetweenConfig
  assets: Record<string, AssetMeta>
  configRevision: number
}

export function AnimationLibrary(props: AnimationLibraryProps): JSX.Element {
  const { store, customs, config, assets, configRevision } = props
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [busy, setBusy] = useState(false)
  /** Timeline validation channel (onValidationChange); includes the ≥1-track editor rule. */
  const [timelineErrors, setTimelineErrors] = useState<string[]>([])
  const [jsonOpen, setJsonOpen] = useState(false)
  /** Non-null while the JSON apply editor is open. */
  const [jsonDraft, setJsonDraft] = useState<{ text: string; errors: string[] } | null>(null)
  const [autoReplay, setAutoReplay] = useState(false)
  const [previewStrength, setPreviewStrength] = useState(1)
  const [previewReady, setPreviewReady] = useState(false)
  const auditionSessionRef = useRef<PreviewSession | null>(null)
  const latestPreviewData = useRef({ config, assets, customs })
  latestPreviewData.current = { config, assets, customs }

  const selected =
    selectedId === null
      ? undefined
      : (customs.find((definition) => definition.id === selectedId) ??
        BUILTIN_DEFINITIONS.find((definition) => definition.id === selectedId))
  const readOnly = selected === undefined || !selected.id.startsWith('user:')
  // The draft mirrors the selection; a stale draft (selection deleted
  // externally) is discarded with the editor area.
  const evaluation = selected !== undefined && draft !== null ? evaluateDraft(selected.id, selected.parameters, draft) : null
  /** Scalar/cross-field errors: everything the timeline editor does not already list. */
  const scalarErrors = evaluation === null ? [] : evaluation.errors.filter((error) => !timelineErrors.includes(error))
  const draftValid = evaluation?.definition != null && timelineErrors.length === 0
  const strengthBounds = selected?.parameters?.strength ?? { default: 1, min: 0, max: 1.8 }

  /**
   * UX-2: the pristine draft of the current selection — the baseline for
   * "unsaved edits" — is derived from `selected` itself: a customs entry IS
   * its saved version (a successful save refreshes the list, which clears
   * the marker), and builtins are immutable, so any divergence from the
   * re-derived baseline means the user edited something (builtins included —
   * timeline tweaks on a read-only entry are audition-only until cloned).
   * The comparison runs on assembled definitions (draftDivergesFromBaseline).
   */
  const draftDirty =
    draft !== null && selected !== undefined && draftDivergesFromBaseline(selected, evaluation?.definition ?? null)

  /** Refuse to silently discard unsaved timeline edits; false = aborted. */
  const guardUnsavedDraft = (): boolean =>
    !draftDirty || window.confirm('当前动画有未保存的修改，继续将丢弃这些修改。')

  // Page-close protection for the timeline draft, mirroring PetweenSettings'
  // config-draft guard: unsaved edits may only leave through an explicit
  // browser confirmation. Clean states register nothing.
  useEffect(() => {
    if (!draftDirty) return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Legacy Chromium/IE only show the prompt when returnValue is assigned.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [draftDirty])

  const applySelection = (definition: AnimationDefinition): void => {
    auditionSessionRef.current?.stopPreviewDefinition()
    setAutoReplay(false)
    setSelectedId(definition.id)
    setDraft(draftFrom(definition))
    setTimelineErrors(validateTimelineDraft(definition.kind, definition.tracks, definition.events ?? []))
    setJsonDraft(null)
    setPreviewStrength(definition.parameters?.strength?.default ?? 1)
  }

  const patchDraft = (patch: Partial<DraftState>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }))
  }

  /**
   * Kind switches normalize event rules AND the track set so a valid draft
   * stays editable: ambient timelines may keep no transition-layer track
   * (the schema rejects them — enter/click own that DOM layer), and an
   * emptied-out ambient is reseeded with a default loop. Pose-swap rules
   * convert in BOTH directions: → interaction keeps the timing but names a
   * target (idle — retarget in the inspector), → transition strips targets
   * and truncates to the exactly-one anonymous swap.
   */
  const changeKind = (kind: AnimationKind): void => {
    setDraft((current) => {
      if (current === null || current.kind === kind) return current
      let events = current.events
      let tracks = current.tracks
      if (kind === 'ambient') {
        events = []
        tracks = tracks.filter((track) => MOTION_PROPERTIES[track.property].targetLayer !== 'transition')
        if (tracks.length === 0) tracks = addTrack([], 'sway.rotation').tracks
      }
      if (kind === 'interaction') {
        // Interaction swaps are legal only with a named target; the timing
        // the author tuned on the transition survives the switch.
        events = events.map((event) =>
          event.type === 'pose-swap' && event.pose === undefined ? { ...event, pose: 'idle' } : event,
        )
      }
      if (kind === 'transition') {
        // Keep the FIRST pose-swap's timing, drop extras, strip the target:
        // the enter pose is state-machine-owned (schema forbids "pose").
        let keptSwap = false
        events = events.filter((event) => {
          if (event.type !== 'pose-swap') return true
          if (keptSwap) return false
          keptSwap = true
          return true
        })
        events = events.map((event) => (event.type === 'pose-swap' ? { at: event.at, type: 'pose-swap' } : event))
        if (!keptSwap) events = [...events, { at: 0.5, type: 'pose-swap' }]
      }
      const repeatMode = events.length > 0 && current.repeatMode === 'alternate' ? 'once' : current.repeatMode
      return { ...current, kind, events, repeatMode, tracks }
    })
  }

  const handleNew = async (): Promise<void> => {
    if (!guardUnsavedDraft()) return
    setBusy(true)
    try {
      const definition = newAnimationTemplate()
      if (await store.saveAnimation(definition)) applySelection(definition)
    } finally {
      setBusy(false)
    }
  }

  const handleClone = async (): Promise<void> => {
    // Clone what you see: the current draft (must be valid) becomes the copy,
    // so timeline tweaks on a built-in survive into the custom.
    if (selected === undefined || draft === null || evaluation?.definition == null || timelineErrors.length > 0) return
    // Unlike switching/deleting, a clone KEEPS the unsaved edits (they ride
    // into the copy), so it gets its own accurate wording instead of the
    // discard guard.
    if (draftDirty && !window.confirm('当前动画有未保存的修改，副本将包含这些修改。是否继续？')) return
    setBusy(true)
    try {
      const clone: AnimationDefinition = {
        ...structuredClone(evaluation.definition),
        id: `user:${crypto.randomUUID()}`,
        name: `${draft.name} 副本`,
      }
      if (await store.saveAnimation(clone)) applySelection(clone)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (selected === undefined || readOnly) return
    // Two explicit gates: the unsaved-edit warning first (the edits die with
    // the animation), then the irreversible delete itself.
    if (draftDirty && !window.confirm('当前动画有未保存的修改，继续将丢弃这些修改。')) return
    if (!window.confirm(`确认删除动画「${draft?.name ?? selected.name}」？此操作不可恢复。`)) return
    setBusy(true)
    try {
      if (await store.deleteAnimation(selected.id)) {
        setSelectedId(null)
        setDraft(null)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (evaluation?.definition == null || timelineErrors.length > 0 || readOnly) return
    setBusy(true)
    try {
      await store.saveAnimation(evaluation.definition)
    } finally {
      setBusy(false)
    }
  }

  // --- audition (试播 / 循环试播) -------------------------------------------

  const handleAuditionStage = useCallback((stage: PetStage | null): void => {
    auditionSessionRef.current?.dispose()
    auditionSessionRef.current = null
    setPreviewReady(false)
    if (stage === null) return
    const latest = latestPreviewData.current
    const session = new PreviewSession({
      stage,
      config: structuredClone(latest.config),
      assets: latest.assets,
      customs: latest.customs,
      auditionOnly: true,
    })
    auditionSessionRef.current = session
    void session.start().then(() => {
      if (auditionSessionRef.current === session) setPreviewReady(true)
    })
  }, [])

  useEffect(() => {
    void auditionSessionRef.current?.updateConfig(config, assets)
  }, [config, assets, configRevision])

  useEffect(() => {
    auditionSessionRef.current?.updateCustoms(customs)
  }, [customs])

  const audition = (): void => {
    if (evaluation?.definition != null && timelineErrors.length === 0) {
      auditionSessionRef.current?.previewDefinition(evaluation.definition, { strength: previewStrength })
    }
  }

  const stopAudition = (): void => {
    setAutoReplay(false)
    auditionSessionRef.current?.stopPreviewDefinition()
  }
  // Latest-callback ref so the debounce timer always auditions the live draft.
  const auditionRef = useRef(audition)
  useEffect(() => {
    auditionRef.current = audition
  })

  const auditionSignature =
    evaluation?.definition == null || timelineErrors.length > 0
      ? null
      : JSON.stringify([evaluation.definition, previewStrength])
  useEffect(() => {
    if (!autoReplay || auditionSignature === null) return
    const timer = window.setTimeout(() => auditionRef.current(), AUTO_REPLAY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [autoReplay, auditionSignature])

  // --- JSON view -------------------------------------------------------------

  const jsonPreviewText =
    draft === null ? '' : JSON.stringify({ tracks: draft.tracks, events: draft.events }, null, 2)

  /** Replace the draft's tracks/events with a parsed JSON object, if it validates. */
  const applyJson = (): void => {
    if (jsonDraft === null || draft === null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonDraft.text)
    } catch (error) {
      setJsonDraft({ ...jsonDraft, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] })
      return
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    if (record === null || !Array.isArray(record.tracks)) {
      setJsonDraft({ ...jsonDraft, errors: ['JSON 须为含 tracks 数组的对象（events 数组可选）'] })
      return
    }
    if (record.events !== undefined && !Array.isArray(record.events)) {
      setJsonDraft({ ...jsonDraft, errors: ['events 须为数组'] })
      return
    }
    const tracks = record.tracks as MotionTrack[]
    const events = (record.events ?? []) as TimelineEvent[]
    const errors = validateTimelineDraft(draft.kind, tracks, events)
    if (errors.length > 0) {
      setJsonDraft({ ...jsonDraft, errors })
      return
    }
    patchDraft({ tracks, events })
    setJsonDraft(null)
  }

  return (
    <section className={styles.section} aria-label="动画库">
      <h2 className={styles.sectionTitle}>动画库</h2>
      <div className={styles.animationLibrary}>
        <div>
          <div className={styles.animationNewRow}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void handleNew()}>
              ＋ 新建空白
            </button>
          </div>
          <div className={styles.animationList}>
            {BUILTIN_DEFINITIONS.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className={
                  definition.id === selectedId ? `${styles.stateItem} ${styles.stateItemSelected}` : styles.stateItem
                }
                onClick={() => {
                  if (guardUnsavedDraft()) applySelection(definition)
                }}
              >
                <span>{definition.name}</span>
                {definition.id === selectedId && draftDirty ? (
                  <span className={styles.dirtyDot} title="有未保存的修改">
                    ●
                  </span>
                ) : null}
                <span className={styles.stateHint}>
                  {KIND_LABELS[definition.kind]} · 内置
                </span>
              </button>
            ))}
            {customs.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className={
                  definition.id === selectedId ? `${styles.stateItem} ${styles.stateItemSelected}` : styles.stateItem
                }
                onClick={() => {
                  if (guardUnsavedDraft()) applySelection(definition)
                }}
              >
                <span>{definition.name}</span>
                {definition.id === selectedId && draftDirty ? (
                  <span className={styles.dirtyDot} title="有未保存的修改">
                    ●
                  </span>
                ) : null}
                <span className={styles.stateHint}>{KIND_LABELS[definition.kind]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.animationEditor}>
          <div className={styles.animationPreview} aria-label="动画试播渲染器">
            <div className={styles.animationPreviewStage}>
              <PetRenderer onStage={handleAuditionStage} embedded size={220} />
            </div>
            <div className={styles.animationPreviewActions}>
              <span className={styles.hint}>此渲染器只播放动画库试播。</span>
              <button type="button" className={styles.button} disabled={!previewReady} onClick={stopAudition}>
                ■ 停止
              </button>
            </div>
          </div>
          {selected === undefined || draft === null || evaluation === null ? (
            <p className={styles.hint}>
              在左侧选择动画查看详情。内置动画只读，可克隆为自定义后编辑；保存后可在状态的过渡动画、循环动画与点击互动中选用。
            </p>
          ) : (
            <>
              <label className={readOnly ? `${styles.row} ${styles.disabled}` : styles.row}>
                <span className={styles.label}>名称</span>
                <input
                  type="text"
                  className={styles.textInput}
                  value={draft.name}
                  disabled={readOnly}
                  onChange={(event) => patchDraft({ name: event.target.value })}
                />
              </label>
              <SelectRow
                label="类型"
                value={draft.kind}
                options={KIND_OPTIONS}
                disabled={readOnly}
                onChange={changeKind}
              />
              <p className={styles.hint}>切换类型时会自动移除不适用的事件与轨道；切回过渡类型时会补充 pose-swap（换图）。</p>
              <NumberField
                label="时长"
                min={1}
                max={60000}
                step={10}
                unit="ms"
                value={draft.durationMs}
                disabled={readOnly}
                onChange={(durationMs) => patchDraft({ durationMs })}
              />
              <SelectRow
                label="重复"
                value={draft.repeatMode}
                options={REPEAT_MODE_OPTIONS}
                disabled={readOnly}
                onChange={(repeatMode) => patchDraft({ repeatMode })}
              />
              {draft.repeatMode === 'random-interval' ? (
                <>
                  <NumberField
                    label="最小间隔"
                    min={1}
                    max={600000}
                    step={50}
                    unit="ms"
                    value={draft.repeatMinMs}
                    disabled={readOnly}
                    onChange={(repeatMinMs) => patchDraft({ repeatMinMs })}
                  />
                  <NumberField
                    label="最大间隔"
                    min={1}
                    max={600000}
                    step={50}
                    unit="ms"
                    value={draft.repeatMaxMs}
                    disabled={readOnly}
                    onChange={(repeatMaxMs) => patchDraft({ repeatMaxMs })}
                  />
                </>
              ) : null}
              <TimelineEditor
                key={selected.id}
                kind={draft.kind}
                tracks={draft.tracks}
                events={draft.events}
                onChange={({ tracks, events }) => patchDraft({ tracks, events })}
                onValidationChange={setTimelineErrors}
              />
              <div className={styles.jsonView}>
                <button
                  type="button"
                  className={styles.jsonToggle}
                  aria-expanded={jsonOpen}
                  onClick={() => setJsonOpen((open) => !open)}
                >
                  {jsonOpen ? '▾' : '▸'} JSON 视图
                </button>
                {jsonOpen ? (
                  jsonDraft === null ? (
                    <>
                      <pre className={styles.jsonPreview}>{jsonPreviewText}</pre>
                      <div className={styles.jsonActions}>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => setJsonDraft({ text: jsonPreviewText, errors: [] })}
                        >
                          编辑 JSON…
                        </button>
                      </div>
                      <p className={styles.hint}>与时间轴实时同步；批量粘贴或外部工具产出的定义可经「编辑 JSON」应用。</p>
                    </>
                  ) : (
                    <>
                      <textarea
                        className={styles.jsonEditor}
                        rows={12}
                        spellCheck={false}
                        aria-label="JSON 编辑"
                        value={jsonDraft.text}
                        onChange={(event) => setJsonDraft({ text: event.target.value, errors: [] })}
                      />
                      {jsonDraft.errors.length > 0 ? (
                        <ul className={styles.animationErrors} aria-label="JSON 错误">
                          {jsonDraft.errors.map((error) => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      ) : null}
                      <div className={styles.jsonActions}>
                        <button type="button" className={styles.button} onClick={applyJson}>
                          应用 JSON
                        </button>
                        <button type="button" className={styles.button} onClick={() => setJsonDraft(null)}>
                          取消
                        </button>
                      </div>
                      <p className={styles.hint}>
                        粘贴含 tracks / events 字段的 JSON 对象（例如完整动画定义）；校验通过后替换当前轨道与事件。
                      </p>
                    </>
                  )
                ) : null}
              </div>
              {scalarErrors.length > 0 ? (
                <ul className={styles.animationErrors} aria-label="字段校验错误">
                  {scalarErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              ) : null}
              <div className={styles.animationActions}>
                <button type="button" className={styles.button} disabled={!draftValid || !previewReady} onClick={audition}>
                  ▶ 试播
                </button>
                {readOnly ? null : (
                  <>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy || !draftValid}
                      onClick={() => void handleSave()}
                    >
                      保存
                    </button>
                    <button type="button" className={styles.button} disabled={busy} onClick={() => void handleDelete()}>
                      删除
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy || !draftValid}
                  onClick={() => void handleClone()}
                >
                  克隆为自定义
                </button>
              </div>
              <div className={styles.auditionRow}>
                <Toggle label="循环试播" checked={autoReplay} onChange={setAutoReplay} />
                <div className={styles.auditionStrength}>
                  <Slider
                    label="试播强度"
                    min={strengthBounds.min}
                    max={strengthBounds.max}
                    step={0.05}
                    value={previewStrength}
                    onChange={setPreviewStrength}
                  />
                </div>
              </div>
              <p className={styles.hint}>循环试播会在编辑变更且校验通过后自动重播一次；试播强度只作用于预览，不写入定义。</p>
              {readOnly ? (
                <p className={styles.hint}>内置动画只读：时间轴上的修改仅用于试播，「克隆为自定义」后随副本保存。</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
