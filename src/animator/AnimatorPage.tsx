/**
 * animator/AnimatorPage.tsx — the standalone animation workbench served at
 * /petween-animator/ (host/animator-page.ts) and built as the self-contained
 * IIFE lib/animator.js. Layout: library column (built-ins + customs, Motion
 * Pack import/export) | scalar form beside a large audition preview |
 * full-width visual TimelineEditor | JSON view. Editing state lives in
 * AnimatorStore (draft now; playhead/zoom in Phase 12, multi-selection +
 * undo in Phase 13); persistence flows through the same EditorStore +
 * /api/petween/* API the settings editor uses, so both pages stay coherent
 * through the config hub's 3s poll + explicit saves.
 *
 * Scope (V1.2): animations only — pet/image/pose management stays in the
 * settings editor (/petween-editor/).
 *
 * The draft flows (guards, clone/save/delete, audition, JSON view) mirror
 * client/settings/AnimationLibrary.tsx on purpose: same UX contract, same
 * confirmation wording, same validation gating.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { PoseKey } from '../core/types'
import type { AnimationDefinition, MotionTrack, TimelineEvent } from '../motion/animation-definition'
import { isCustomAnimationId } from '../motion/animation-definition'
import { configHub } from '../client/config-hub'
import { confirmDialog } from '../client/dialog-queue'
import { PetRenderer } from '../client/overlay/PetRenderer'
import type { PetStage } from '../client/overlay/pet-stage'
import { PreviewSession } from '../client/preview-session'
import { NoticeBar } from '../client/settings/PetweenSettings'
import { ModalHost } from '../client/settings/modals'
import { STATE_LABELS } from '../client/settings/StateList'
import { FileImportButton, NumberField, SelectRow, Slider, Toggle } from '../client/settings/controls'
import settingsStyles from '../client/settings/settings.module.css'
import { EditorStore } from '../client/stores/editor-store'
import { TimelineEditor } from '../client/timeline/TimelineEditor'
import { validateTimelineDraft } from '../client/timeline/timeline-model'
import {
  AUTO_REPLAY_DELAY_MS,
  BUILTIN_DEFINITIONS,
  KIND_LABELS,
  KIND_OPTIONS,
  REPEAT_MODE_OPTIONS,
  type DraftState,
  draftDivergesFromBaseline,
  evaluateDraft,
  newAnimationTemplate,
  normalizeKindSwitch,
} from '../client/timeline/animation-draft'
import { AnimatorStore } from './animator-store'
import styles from './animator.module.css'

export function AnimatorPage(): JSX.Element {
  // Same store bootstrap as PetweenSettings: the standalone page shares the
  // config hub with its own browsing context (M3: one config, one GET).
  // StrictMode caveat applies here too — no production entry wraps this tree
  // in StrictMode (see the matching comment in PetweenSettings).
  const [store] = useState(() => new EditorStore({ hub: configHub }))
  useEffect(() => {
    void store.load()
    return () => store.dispose()
  }, [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const [animator] = useState(() => new AnimatorStore())
  useEffect(() => () => animator.dispose(), [animator])
  const animSnapshot = useSyncExternalStore(animator.subscribe, animator.getSnapshot)
  const draft: DraftState | null = animSnapshot.draft

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
  const latestPreviewData = useRef({ config: snapshot.config, assets: snapshot.assets, customs: snapshot.customs })
  latestPreviewData.current = { config: snapshot.config, assets: snapshot.assets, customs: snapshot.customs }

  const customs = snapshot.customs
  const selected =
    animSnapshot.selectedId === null
      ? undefined
      : (customs.find((definition) => definition.id === animSnapshot.selectedId) ??
        BUILTIN_DEFINITIONS.find((definition) => definition.id === animSnapshot.selectedId))
  // B6: every non-builtin namespace (user: or a pack's own) is editable
  // custom territory; only built-ins stay read-only.
  const readOnly = selected === undefined || !isCustomAnimationId(selected.id)
  const evaluation =
    selected !== undefined && draft !== null ? evaluateDraft(selected.id, selected.parameters, draft) : null
  /** Scalar/cross-field errors: everything the timeline editor does not already list. */
  const scalarErrors = evaluation === null ? [] : evaluation.errors.filter((error) => !timelineErrors.includes(error))
  const draftValid = evaluation?.definition != null && timelineErrors.length === 0
  const strengthBounds = selected?.parameters?.strength ?? { default: 1, min: 0, max: 1.8 }

  /** UX-2: divergence from the re-derived pristine baseline (see animation-draft.ts). */
  const draftDirty =
    draft !== null && selected !== undefined && draftDivergesFromBaseline(selected, evaluation?.definition ?? null)

  /** Refuse to silently discard unsaved timeline edits; false = aborted. */
  const guardUnsavedDraft = async (): Promise<boolean> =>
    !draftDirty || (await confirmDialog({ message: '当前动画有未保存的修改，继续将丢弃这些修改。' }))

  // Page-close protection for the timeline draft — unsaved edits may only
  // leave through an explicit browser confirmation. Clean states register
  // nothing.
  useEffect(() => {
    if (!draftDirty) return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [draftDirty])

  const applySelection = (definition: AnimationDefinition): void => {
    auditionSessionRef.current?.stopPreviewDefinition()
    auditionSessionRef.current?.endScrub() // a parked scrub freezes the pose; drop it on switch
    setAutoReplay(false)
    animator.selectAnimation(definition)
    setTimelineErrors(validateTimelineDraft(definition.kind, definition.tracks, definition.events ?? []))
    setJsonDraft(null)
    setPreviewStrength(definition.parameters?.strength?.default ?? 1)
  }

  /** List clicks keep their synchronous fast path; only a dirty draft detours through the modal guard. */
  const selectWithGuard = (definition: AnimationDefinition): void => {
    if (!draftDirty) {
      applySelection(definition)
      return
    }
    void guardUnsavedDraft().then((ok) => {
      if (ok) applySelection(definition)
    })
  }

  const handleNew = async (): Promise<void> => {
    if (!(await guardUnsavedDraft())) return
    setBusy(true)
    try {
      const definition = newAnimationTemplate()
      if (await store.saveAnimation(definition)) applySelection(definition)
    } finally {
      setBusy(false)
    }
  }

  /** P2 Motion Pack: the file's raw JSON goes to the host (it validates). */
  const handleImportPack = async (file: File): Promise<void> => {
    setBusy(true)
    try {
      await store.importPack(file)
    } finally {
      setBusy(false)
    }
  }

  /** P2 Motion Pack: every custom animation bundled into one downloadable manifest. */
  const handleExportPack = async (): Promise<void> => {
    setBusy(true)
    try {
      await store.exportPack()
    } finally {
      setBusy(false)
    }
  }

  const handleClone = async (): Promise<void> => {
    // Clone what you see: the current draft (must be valid) becomes the copy,
    // so timeline tweaks on a built-in survive into the custom.
    if (selected === undefined || draft === null || evaluation?.definition == null || timelineErrors.length > 0) return
    if (draftDirty && !(await confirmDialog({ message: '当前动画有未保存的修改，副本将包含这些修改。是否继续？' }))) return
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
    if (draftDirty && !(await confirmDialog({ message: '当前动画有未保存的修改，继续将丢弃这些修改。' }))) return
    if (!(await confirmDialog({ message: `确认删除动画「${draft?.name ?? selected.name}」？此操作不可恢复。` }))) return
    setBusy(true)
    try {
      if (await store.deleteAnimation(selected.id)) animator.clear()
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
    if (latest.config === null) return
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

  const config = snapshot.config
  useEffect(() => {
    if (config === null) return
    void auditionSessionRef.current?.updateConfig(config, snapshot.assets).catch((error: unknown) =>
      console.warn('petween: audition config sync failed', error),
    )
  }, [config, snapshot.assets, snapshot.configRevision])

  useEffect(() => {
    auditionSessionRef.current?.updateCustoms(customs)
  }, [customs])

  const audition = (): void => {
    if (evaluation?.definition != null && timelineErrors.length === 0) {
      auditionSessionRef.current?.endScrub()
      auditionSessionRef.current?.previewDefinition(evaluation.definition, { strength: previewStrength })
    }
  }

  const stopAudition = (): void => {
    setAutoReplay(false)
    auditionSessionRef.current?.stopPreviewDefinition()
    auditionSessionRef.current?.endScrub()
  }

  /**
   * Playhead scrub (V1.2): park the playhead in the store and freeze the
   * preview at the sampled frame — pixel-identical to playback (the sampler
   * shares the compiler's math). An invalid draft still moves the playhead;
   * only the preview apply is skipped.
   */
  const handlePlayheadChange = (at: number): void => {
    animator.setPlayhead(at)
    if (evaluation?.definition != null && timelineErrors.length === 0) {
      auditionSessionRef.current?.scrubDefinition(evaluation.definition, at, { strength: previewStrength })
    }
  }

  // Space toggles the audition (engine transport feel). Skipped while a form
  // control has focus. The latest-toggle ref keeps the listener stable.
  const toggleAuditionRef = useRef<() => void>(() => undefined)
  toggleAuditionRef.current = (): void => {
    if (draft === null) return
    if (autoReplay) {
      stopAudition()
      return
    }
    if (evaluation?.definition != null && timelineErrors.length === 0) audition()
  }
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target
      return (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      )
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space' && !event.repeat) {
        if (isEditableTarget(event.target)) return
        const el = event.target
        if (el instanceof HTMLElement && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'menu')) return
        event.preventDefault()
        toggleAuditionRef.current()
        return
      }
      // P13 undo/redo: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (skipped in form fields).
      if (!event.ctrlKey && !event.metaKey) return
      if (event.code === 'KeyZ' || event.code === 'KeyY') {
        if (isEditableTarget(event.target)) return
        event.preventDefault()
        if (event.shiftKey || event.code === 'KeyY') animator.redo()
        else animator.undo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [animator])
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

  const jsonPreviewText = draft === null ? '' : JSON.stringify({ tracks: draft.tracks, events: draft.events }, null, 2)

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
    animator.applyTimeline({ tracks, events })
    setJsonDraft(null)
  }

  // --- render ------------------------------------------------------------------

  const pendingMounts = snapshot.pendingMounts
  const libraryColumn = (
    <aside className={styles.libraryColumn} aria-label="动画库">
      {pendingMounts !== null ? (
        <div className={settingsStyles.mountBanner} role="status">
          <span className={settingsStyles.mountBannerText}>
            「{pendingMounts.packName}」带有挂载建议：
            {Object.entries(pendingMounts.mounts)
              .map(([slot, mount]) => {
                const parts: string[] = []
                if (mount.enter !== undefined) parts.push('进入动画')
                if (mount.ambient !== undefined) parts.push('循环动画')
                return `${STATE_LABELS[slot as PoseKey]}${parts.join(' + ')}`
              })
              .join('、')}
            ，应用后会并入草稿。
          </span>
          <button type="button" className={settingsStyles.button} onClick={() => store.applyPendingMounts()}>
            应用挂载
          </button>
          <button type="button" className={settingsStyles.button} onClick={() => store.dismissPendingMounts()}>
            忽略
          </button>
        </div>
      ) : null}
      <div className={settingsStyles.animationNewRow}>
        <button type="button" className={settingsStyles.button} disabled={busy} onClick={() => void handleNew()}>
          ＋ 新建空白
        </button>
        <FileImportButton
          label="导入动画包"
          disabled={busy}
          accept="application/json,.json"
          onFile={(file) => void handleImportPack(file)}
        />
        <button type="button" className={settingsStyles.button} disabled={busy} onClick={() => void handleExportPack()}>
          导出动画包
        </button>
      </div>
      <div className={settingsStyles.animationList}>
        {BUILTIN_DEFINITIONS.map((definition) => (
          <button
            key={definition.id}
            type="button"
            className={
              definition.id === animSnapshot.selectedId
                ? `${settingsStyles.stateItem} ${settingsStyles.stateItemSelected}`
                : settingsStyles.stateItem
            }
            onClick={() => selectWithGuard(definition)}
          >
            <span>{definition.name}</span>
            {definition.id === animSnapshot.selectedId && draftDirty ? (
              <span className={settingsStyles.dirtyDot} title="有未保存的修改">
                ●
              </span>
            ) : null}
            <span className={settingsStyles.stateHint}>{KIND_LABELS[definition.kind]} · 内置</span>
          </button>
        ))}
        {customs.map((definition) => (
          <button
            key={definition.id}
            type="button"
            className={
              definition.id === animSnapshot.selectedId
                ? `${settingsStyles.stateItem} ${settingsStyles.stateItemSelected}`
                : settingsStyles.stateItem
            }
            onClick={() => selectWithGuard(definition)}
          >
            <span>{definition.name}</span>
            {definition.id === animSnapshot.selectedId && draftDirty ? (
              <span className={settingsStyles.dirtyDot} title="有未保存的修改">
                ●
              </span>
            ) : null}
            <span className={settingsStyles.stateHint}>{KIND_LABELS[definition.kind]}</span>
          </button>
        ))}
      </div>
    </aside>
  )

  const formColumn =
    selected === undefined || draft === null || evaluation === null ? (
      <p className={settingsStyles.hint}>
        在左侧选择动画查看详情。内置动画只读，可克隆为自定义后编辑；保存后可在状态的过渡动画、循环动画与点击互动中选用。
      </p>
    ) : (
      <>
        <label className={readOnly ? `${settingsStyles.row} ${settingsStyles.disabled}` : settingsStyles.row}>
          <span className={settingsStyles.label}>名称</span>
          <input
            type="text"
            className={settingsStyles.textInput}
            value={draft.name}
            disabled={readOnly}
            onChange={(event) => animator.patchDraft({ name: event.target.value })}
          />
        </label>
        <SelectRow
          label="类型"
          value={draft.kind}
          options={KIND_OPTIONS}
          disabled={readOnly}
          tooltip="切换类型时会自动移除不适用的事件与轨道；切回过渡类型时会补充 pose-swap（换图）。"
          onChange={(kind) => animator.patchDraft(normalizeKindSwitch(draft, kind))}
        />
        <NumberField
          label="时长"
          min={1}
          max={60000}
          step={10}
          unit="ms"
          value={draft.durationMs}
          disabled={readOnly}
          onChange={(durationMs) => animator.patchDraft({ durationMs })}
        />
        <SelectRow
          label="重复"
          value={draft.repeatMode}
          options={REPEAT_MODE_OPTIONS}
          disabled={readOnly}
          onChange={(repeatMode) => animator.patchDraft({ repeatMode })}
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
              onChange={(repeatMinMs) => animator.patchDraft({ repeatMinMs })}
            />
            <NumberField
              label="最大间隔"
              min={1}
              max={600000}
              step={50}
              unit="ms"
              value={draft.repeatMaxMs}
              disabled={readOnly}
              onChange={(repeatMaxMs) => animator.patchDraft({ repeatMaxMs })}
            />
          </>
        ) : null}
      </>
    )

  const previewPanel = (
    <div className={styles.previewPanel} aria-label="动画试播渲染器">
      <div className={styles.previewStage}>
        <PetRenderer onStage={handleAuditionStage} embedded size={320} />
      </div>
      <div className={styles.previewActions}>
        <button type="button" className={settingsStyles.button} disabled={!previewReady} onClick={audition}>
          ▶ 试播
        </button>
        <button
          type="button"
          className={settingsStyles.button}
          disabled={!previewReady}
          data-tooltip="此渲染器只播放动画库试播。"
          onClick={stopAudition}
        >
          ■ 停止
        </button>
        <Toggle
          label="循环试播"
          checked={autoReplay}
          tooltip="编辑变更且校验通过后自动重播一次。"
          onChange={setAutoReplay}
        />
        <div className={styles.previewStrength}>
          <Slider
            label="试播强度"
            min={strengthBounds.min}
            max={strengthBounds.max}
            step={0.05}
            value={previewStrength}
            tooltip="只作用于预览，不写入定义。"
            onChange={setPreviewStrength}
          />
        </div>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>Petween 动画编辑器</h1>
          <p className={styles.subtitle}>
            独立动画工作台：左侧管理动画库，右侧编辑时间轴并试播。保存后可在设置编辑器的过渡动画、循环动画与点击互动中挂载。
          </p>
        </div>
      </header>
      {snapshot.status === 'loading' ? (
        <>
          <div className={settingsStyles.status}>正在加载 Petween 配置…</div>
          {/* C2 modal host: mounted in EVERY gate (see modals.tsx mount contract). */}
          <ModalHost />
        </>
      ) : snapshot.status === 'error' || snapshot.config === null ? (
        <>
          <div className={settingsStyles.status}>
            配置加载失败{snapshot.loadError !== null ? `：${snapshot.loadError}` : ''}
            <button type="button" className={`${settingsStyles.button} ${settingsStyles.retry}`} onClick={() => void store.load()}>
              重试
            </button>
          </div>
          <ModalHost />
        </>
      ) : (
        <>
          <NoticeBar snapshot={snapshot} store={store} />
          <div className={styles.workbench}>
            {libraryColumn}
            <div className={styles.mainColumn}>
              <div className={styles.topRow}>
                <div className={styles.formColumn}>{formColumn}</div>
                {previewPanel}
              </div>
              {selected === undefined || draft === null || evaluation === null ? null : (
                <>
                  <div className={styles.historyRow} aria-label="编辑历史">
                    <button
                      type="button"
                      className={settingsStyles.button}
                      disabled={!animSnapshot.canUndo}
                      data-tooltip="撤销上一步时间轴编辑（Ctrl+Z）。"
                      onClick={() => animator.undo()}
                    >
                      ↶ 撤销
                    </button>
                    <button
                      type="button"
                      className={settingsStyles.button}
                      disabled={!animSnapshot.canRedo}
                      data-tooltip="重做（Ctrl+Shift+Z / Ctrl+Y）。"
                      onClick={() => animator.redo()}
                    >
                      ↷ 重做
                    </button>
                  </div>
                  <TimelineEditor
                    key={selected.id}
                    advanced
                    kind={draft.kind}
                    tracks={draft.tracks}
                    events={draft.events}
                    durationMs={draft.durationMs}
                    playheadAt={animSnapshot.playheadAt}
                    onPlayheadChange={handlePlayheadChange}
                    zoom={animSnapshot.zoom}
                    onZoomChange={(zoom) => animator.setZoom(zoom)}
                    snapEnabled={animSnapshot.snapEnabled}
                    onSnapEnabledChange={(enabled) => animator.setSnapEnabled(enabled)}
                    onChange={({ tracks, events }) => animator.applyTimeline({ tracks, events })}
                    onValidationChange={setTimelineErrors}
                  />
                  <div className={settingsStyles.jsonView}>
                    <button
                      type="button"
                      className={settingsStyles.jsonToggle}
                      aria-expanded={jsonOpen}
                      data-tooltip="与时间轴实时同步；批量粘贴或外部工具产出的定义可经「编辑 JSON」应用。"
                      onClick={() => setJsonOpen((open) => !open)}
                    >
                      {jsonOpen ? '▾' : '▸'} JSON 视图
                    </button>
                    {jsonOpen ? (
                      jsonDraft === null ? (
                        <>
                          <pre className={settingsStyles.jsonPreview}>{jsonPreviewText}</pre>
                          <div className={settingsStyles.jsonActions}>
                            <button
                              type="button"
                              className={settingsStyles.button}
                              onClick={() => setJsonDraft({ text: jsonPreviewText, errors: [] })}
                            >
                              编辑 JSON…
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <textarea
                            className={settingsStyles.jsonEditor}
                            rows={12}
                            spellCheck={false}
                            aria-label="JSON 编辑"
                            value={jsonDraft.text}
                            onChange={(event) => setJsonDraft({ text: event.target.value, errors: [] })}
                          />
                          {jsonDraft.errors.length > 0 ? (
                            <ul className={settingsStyles.animationErrors} aria-label="JSON 错误">
                              {jsonDraft.errors.map((error) => (
                                <li key={error}>{error}</li>
                              ))}
                            </ul>
                          ) : null}
                          <div className={settingsStyles.jsonActions}>
                            <button
                              type="button"
                              className={settingsStyles.button}
                              data-tooltip="粘贴含 tracks / events 字段的 JSON 对象（例如完整动画定义）；校验通过后替换当前轨道与事件。"
                              onClick={applyJson}
                            >
                              应用 JSON
                            </button>
                            <button type="button" className={settingsStyles.button} onClick={() => setJsonDraft(null)}>
                              取消
                            </button>
                          </div>
                        </>
                      )
                    ) : null}
                  </div>
                  {scalarErrors.length > 0 ? (
                    <ul className={settingsStyles.animationErrors} aria-label="字段校验错误">
                      {scalarErrors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className={settingsStyles.animationActions}>
                    {readOnly ? null : (
                      <>
                        <button
                          type="button"
                          className={settingsStyles.button}
                          disabled={busy || !draftValid}
                          onClick={() => void handleSave()}
                        >
                          保存
                        </button>
                        <button type="button" className={settingsStyles.button} disabled={busy} onClick={() => void handleDelete()}>
                          删除
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={settingsStyles.button}
                      disabled={busy || !draftValid}
                      data-tooltip={
                        readOnly ? '内置动画只读：时间轴上的修改仅用于试播，克隆后随副本保存。' : undefined
                      }
                      onClick={() => void handleClone()}
                    >
                      克隆为自定义
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <ModalHost />
        </>
      )}
    </div>
  )
}
