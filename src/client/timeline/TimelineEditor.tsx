/**
 * client/timeline/TimelineEditor.tsx — the visual timeline editor: toolbar
 * (add-track grouped by layer, add-particle, heal a missing pose-swap) +
 * ruler + event markers + keyframe lanes + inspector. Purely controlled:
 * every edit produces new tracks/events through onChange and nothing is
 * persisted here.
 *
 * V1.1 (P1) mode is the default: a fit-width normalized timeline, single
 * selection, 0.01 grid snapping. The optional `advanced` mode (V1.2, the
 * /petween-animator/ workbench) adds the game-engine feel on top: an
 * interactive playhead with scrub, Ctrl+wheel zoom around the cursor +
 * wheel panning (sticky track labels), an adaptive ms ruler, and target
 * snapping (frames/events/playhead, Alt-hold to bypass). All advanced props
 * are opt-in; the settings-page AnimationLibrary keeps its frozen V1.1 UX.
 *
 * Every change is re-validated against the real schema
 * (validateTimelineDraft — a synthetic known-valid definition around
 * kind/tracks/events). The errors are listed inline AND reported through
 * onValidationChange, so the host panel disables its 保存 button while the
 * list is non-empty.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from 'react'
import type {
  AnimationKind,
  MotionEasing,
  MotionKeyframe,
  MotionTrack,
  ParticleEffectId,
  TimelineEvent,
} from '../../motion/animation-definition'
import {
  MOTION_LAYERS,
  isMotionProperty,
  motionPropertiesOfLayer,
  type MotionLayer,
  type MotionProperty,
} from '../../motion/motion-properties'
import settingsStyles from '../settings/settings.module.css'
import { motionPropertyDisplayName } from './display-labels'
import { EventInspector, EventTrack, PARTICLE_EFFECT_OPTIONS } from './EventTrack'
import { KeyframeInspector } from './KeyframeInspector'
import { ScrubRuler, TimelineRuler } from './TimelineRuler'
import { TrackLane } from './TrackLane'
import {
  addKeyframe,
  addParticleEvent,
  addPoseSwapEvent,
  addTrack,
  adaptiveGridStep,
  moveEvent,
  moveKeyframe,
  removeEvent,
  removeKeyframe,
  removeTrack,
  setEventPose,
  setKeyframeEasing,
  setKeyframeValue,
  setParticleEffect,
  snapAtWithTargets,
  validateTimelineDraft,
} from './timeline-model'
import styles from './timeline.module.css'

export interface TimelineEditorProps {
  kind: AnimationKind
  tracks: MotionTrack[]
  events: TimelineEvent[]
  onChange: (next: { tracks: MotionTrack[]; events: TimelineEvent[] }) => void
  /** Fires with the current validation error list after every change (and on mount). */
  onValidationChange?: (errors: string[]) => void
  /** V1.2 workbench mode: playhead/scrub + zoom/pan + ms ruler + target snap. */
  advanced?: boolean
  /** Parked playhead position (normalized); null hides it. */
  playheadAt?: number | null
  onPlayheadChange?: (at: number) => void
  /** Timeline zoom: 1 = the full duration fills the lane width. */
  zoom?: number
  onZoomChange?: (zoom: number) => void
  /** Needed for the ms ruler + adaptive grid; defaults to 300. */
  durationMs?: number
  snapEnabled?: boolean
  onSnapEnabledChange?: (enabled: boolean) => void
}

type Selection =
  | { type: 'keyframe'; trackIndex: number; keyframeIndex: number }
  | { type: 'event'; eventIndex: number }

const LAYER_LABELS: Record<MotionLayer, string> = {
  transition: '过渡层',
  sway: '摇摆层',
  bounce: '弹跳层',
  breathe: '呼吸层',
}

/** Snap capture radius in px — converted to normalized units per lane width. */
const SNAP_THRESHOLD_PX = 6

export function TimelineEditor(props: TimelineEditorProps): JSX.Element {
  const { kind, tracks, events } = props
  const [selection, setSelection] = useState<Selection | null>(null)
  const advanced = props.advanced === true
  const zoom = props.zoom ?? 1
  const durationMs = props.durationMs ?? 300

  const errors = useMemo(() => validateTimelineDraft(kind, tracks, events), [kind, tracks, events])
  useEffect(() => {
    props.onValidationChange?.(errors)
  }, [props.onValidationChange, errors])

  const poseSwapCount = events.filter((event) => event.type === 'pose-swap').length
  const showEvents = kind !== 'ambient'

  // --- advanced mode plumbing: measured lane width + Alt bypass ----------

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [laneWidthPx, setLaneWidthPx] = useState(0)
  const [altHeld, setAltHeld] = useState(false)
  /** Zoom anchor: keep the timeline time under the cursor stationary. */
  const zoomAnchorRef = useRef<{ clientX: number; anchorAt: number } | null>(null)

  useEffect(() => {
    if (!advanced) return
    const trackAlt = (down: boolean) => (event: KeyboardEvent): void => {
      if (event.key === 'Alt') {
        event.preventDefault()
        setAltHeld(down)
      }
    }
    const onKeyDown = trackAlt(true)
    const onKeyUp = trackAlt(false)
    const onBlur = (): void => setAltHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [advanced])

  useEffect(() => {
    if (!advanced) return
    const element = contentRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setLaneWidthPx(element.getBoundingClientRect().width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [advanced])

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    if (anchor === null) return
    zoomAnchorRef.current = null
    const scrollEl = scrollRef.current
    const content = contentRef.current
    if (scrollEl === null || content === null) return
    const rect = content.getBoundingClientRect()
    const localX = anchor.clientX - scrollEl.getBoundingClientRect().left
    scrollEl.scrollLeft = Math.max(0, anchor.anchorAt * rect.width - localX)
  }, [zoom])

  useEffect(() => {
    if (!advanced) return
    const scrollEl = scrollRef.current
    if (scrollEl === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) {
        // Ctrl+wheel zooms around the cursor.
        event.preventDefault()
        const content = contentRef.current
        if (content === null || props.onZoomChange === undefined) return
        const rect = content.getBoundingClientRect()
        zoomAnchorRef.current = {
          clientX: event.clientX,
          anchorAt: (event.clientX - rect.left) / Math.max(rect.width, 1),
        }
        props.onZoomChange(zoom * Math.exp(-event.deltaY * 0.002))
        return
      }
      // Wheel/trackpad pans the timeline horizontally (engine convention).
      if (scrollEl.scrollWidth > scrollEl.clientWidth) event.preventDefault()
      scrollEl.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX
    }
    scrollEl.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', onWheel)
  }, [advanced, zoom, props.onZoomChange])

  const frameEventTargets = useMemo(() => {
    if (!advanced) return []
    const targets: number[] = []
    for (const track of tracks) {
      for (const keyframe of track.keyframes) targets.push(keyframe.at)
    }
    for (const event of events) targets.push(event.at)
    return targets
  }, [advanced, tracks, events])

  const grid = useMemo(
    () => adaptiveGridStep(durationMs, laneWidthPx > 0 ? laneWidthPx : 800, zoom).grid,
    [durationMs, laneWidthPx, zoom],
  )

  /** Frame/event drags snap to grid + siblings + the playhead. */
  const snapEdit = useMemo(() => {
    if (!advanced) return null
    const enabled = (props.snapEnabled ?? true) && !altHeld
    const threshold = SNAP_THRESHOLD_PX / Math.max(laneWidthPx, 1)
    const targets = props.playheadAt != null ? [...frameEventTargets, props.playheadAt] : frameEventTargets
    return (at: number): number => snapAtWithTargets(at, { enabled, grid, targets, threshold })
  }, [advanced, props.snapEnabled, props.playheadAt, altHeld, grid, frameEventTargets, laneWidthPx])

  /** Playhead scrubbing snaps to grid + frames/events — never to itself. */
  const snapScrub = useMemo(() => {
    if (!advanced) return null
    const enabled = (props.snapEnabled ?? true) && !altHeld
    const threshold = SNAP_THRESHOLD_PX / Math.max(laneWidthPx, 1)
    return (at: number): number => snapAtWithTargets(at, { enabled, grid, targets: frameEventTargets, threshold })
  }, [advanced, props.snapEnabled, altHeld, grid, frameEventTargets, laneWidthPx])

  const handleScrub = (at: number): void => {
    props.onPlayheadChange?.(snapScrub !== null ? snapScrub(at) : at)
  }

  // --- track-level ops -----------------------------------------------------

  const updateTracks = (nextTracks: MotionTrack[]): void => props.onChange({ tracks: nextTracks, events })
  const updateEvents = (nextEvents: TimelineEvent[]): void => props.onChange({ tracks, events: nextEvents })

  const replaceTrack = (trackIndex: number, track: MotionTrack): void =>
    updateTracks(tracks.map((current, index) => (index === trackIndex ? track : current)))

  const handleAddTrack = (property: MotionProperty): void => {
    const edit = addTrack(tracks, property)
    updateTracks(edit.tracks)
    setSelection({ type: 'keyframe', trackIndex: edit.index, keyframeIndex: 0 })
  }

  const handleRemoveTrack = (trackIndex: number): void => {
    updateTracks(removeTrack(tracks, trackIndex))
    setSelection((current) => {
      if (current === null || current.type !== 'keyframe') return current
      if (current.trackIndex === trackIndex) return null
      return current.trackIndex > trackIndex ? { ...current, trackIndex: current.trackIndex - 1 } : current
    })
  }

  // --- keyframe ops --------------------------------------------------------

  const handleAddKeyframe = (trackIndex: number, at: number): void => {
    const edit = addKeyframe(tracks[trackIndex], at)
    if (edit.created) replaceTrack(trackIndex, edit.track)
    setSelection({ type: 'keyframe', trackIndex, keyframeIndex: edit.index })
  }

  const handleMoveKeyframe = (trackIndex: number, keyframeIndex: number, at: number): void => {
    const edit = moveKeyframe(tracks[trackIndex], keyframeIndex, at)
    if (edit.moved) replaceTrack(trackIndex, edit.track)
  }

  const handleSetValue = (trackIndex: number, keyframeIndex: number, value: MotionKeyframe['value']): void => {
    replaceTrack(trackIndex, setKeyframeValue(tracks[trackIndex], keyframeIndex, value))
  }

  const handleSetEasing = (trackIndex: number, keyframeIndex: number, easing: MotionEasing | undefined): void => {
    updateTracks(setKeyframeEasing(tracks, trackIndex, keyframeIndex, easing))
  }

  const handleDeleteKeyframe = (trackIndex: number, keyframeIndex: number): void => {
    replaceTrack(trackIndex, removeKeyframe(tracks[trackIndex], keyframeIndex))
    setSelection((current) => {
      if (current === null || current.type !== 'keyframe' || current.trackIndex !== trackIndex) return current
      if (current.keyframeIndex === keyframeIndex) return null
      return current.keyframeIndex > keyframeIndex ? { ...current, keyframeIndex: current.keyframeIndex - 1 } : current
    })
  }

  // --- event ops -----------------------------------------------------------

  const handleDeleteEvent = (eventIndex: number): void => {
    updateEvents(removeEvent(events, eventIndex))
    setSelection((current) => {
      if (current === null || current.type !== 'event') return current
      if (current.eventIndex === eventIndex) return null
      return current.eventIndex > eventIndex ? { ...current, eventIndex: current.eventIndex - 1 } : current
    })
  }

  const handleAddParticle = (effect: ParticleEffectId): void => {
    const edit = addParticleEvent(events, effect)
    updateEvents(edit.events)
    setSelection({ type: 'event', eventIndex: edit.index })
  }

  const handleAddPoseSwap = (): void => {
    // Interaction additions name the idle slot so the draft stays valid
    // (every interaction pose-swap must declare a target); the author
    // retargets in the inspector. A transition addition stays anonymous —
    // its pose is state-machine-owned (schema forbids the field).
    const edit = addPoseSwapEvent(events, 0.5, kind === 'interaction' ? 'idle' : undefined)
    updateEvents(edit.events)
    setSelection({ type: 'event', eventIndex: edit.index })
  }

  // --- toolbar selects -----------------------------------------------------

  const handleTrackSelect = (event: ChangeEvent<HTMLSelectElement>): void => {
    const property = event.target.value
    if (isMotionProperty(property)) handleAddTrack(property)
  }

  const handleParticleSelect = (event: ChangeEvent<HTMLSelectElement>): void => {
    const effect = event.target.value
    if (PARTICLE_EFFECT_OPTIONS.some((option) => option.value === effect)) {
      handleAddParticle(effect as ParticleEffectId)
    }
  }

  // --- inspector target ----------------------------------------------------

  const keyframeSelection = selection !== null && selection.type === 'keyframe' ? selection : null
  const eventSelection = selection !== null && selection.type === 'event' ? selection : null
  const selectedTrack = keyframeSelection === null ? undefined : tracks[keyframeSelection.trackIndex]
  const selectedEvent = eventSelection === null ? undefined : events[eventSelection.eventIndex]

  let inspector: JSX.Element
  if (keyframeSelection !== null && selectedTrack !== undefined) {
    inspector = (
      <KeyframeInspector
        track={selectedTrack}
        keyframeIndex={keyframeSelection.keyframeIndex}
        onSetAt={(keyframeIndex, at) => handleMoveKeyframe(keyframeSelection.trackIndex, keyframeIndex, at)}
        onSetValue={(keyframeIndex, value) => handleSetValue(keyframeSelection.trackIndex, keyframeIndex, value)}
        onSetEasing={(keyframeIndex, easing) => handleSetEasing(keyframeSelection.trackIndex, keyframeIndex, easing)}
        onDelete={(keyframeIndex) => handleDeleteKeyframe(keyframeSelection.trackIndex, keyframeIndex)}
      />
    )
  } else if (eventSelection !== null && selectedEvent !== undefined) {
    inspector = (
      <EventInspector
        kind={kind}
        event={selectedEvent}
        poseSwapCount={poseSwapCount}
        onSetAt={(at) => updateEvents(moveEvent(events, eventSelection.eventIndex, at))}
        onSetEffect={(effect) => updateEvents(setParticleEffect(events, eventSelection.eventIndex, effect))}
        onSetPose={(pose) => updateEvents(setEventPose(events, eventSelection.eventIndex, pose))}
        onDelete={() => handleDeleteEvent(eventSelection.eventIndex)}
      />
    )
  } else {
    inspector = <p className={styles.hint}>选中关键帧或事件标记进行编辑；同层轨道的缓动按区间自动保持一致。</p>
  }

  const playhead = advanced ? (props.playheadAt ?? null) : null

  return (
    <div className={styles.timeline} aria-label="时间轴编辑器">
      <div className={styles.timelineToolbar}>
        <select
          className={settingsStyles.select}
          aria-label="添加轨道"
          value=""
          onChange={handleTrackSelect}
        >
          <option value="" disabled>
            ＋ 添加轨道…
          </option>
          {MOTION_LAYERS.map((layer) => {
            const available = motionPropertiesOfLayer(layer).filter(
              (property) => !tracks.some((track) => track.property === property),
            )
            if (available.length === 0) return null
            return (
              <optgroup key={layer} label={LAYER_LABELS[layer]}>
                {available.map((property) => (
                  <option key={property} value={property}>
                    {motionPropertyDisplayName(property)}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        {showEvents ? (
          <select
            className={settingsStyles.select}
            aria-label="添加粒子事件"
            value=""
            onChange={handleParticleSelect}
          >
            <option value="" disabled>
              ＋ 粒子事件…
            </option>
            {PARTICLE_EFFECT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {(kind === 'transition' && poseSwapCount === 0) || kind === 'interaction' ? (
          <button type="button" className={settingsStyles.button} onClick={handleAddPoseSwap}>
            ＋ 添加 pose-swap（换图）
          </button>
        ) : null}
        {advanced ? (
          <>
            <button
              type="button"
              className={
                (props.snapEnabled ?? true)
                  ? `${settingsStyles.button} ${styles.toolbarToggleOn}`
                  : settingsStyles.button
              }
              aria-pressed={props.snapEnabled ?? true}
              data-tooltip="吸附到网格、其他关键帧/事件与播放头；按住 Alt 临时禁用。"
              onClick={() => props.onSnapEnabledChange?.(!(props.snapEnabled ?? true))}
            >
              ⌗ 吸附
            </button>
            <button
              type="button"
              className={settingsStyles.button}
              disabled={zoom === 1}
              data-tooltip="缩放复位（Ctrl+滚轮以光标为中心缩放，滚轮平移）。"
              onClick={() => props.onZoomChange?.(1)}
            >
              ⤢ {Math.round(zoom * 100)}%
            </button>
          </>
        ) : null}
        <span className={styles.timelineHint}>
          {advanced
            ? '拖标尺移动播放头（预览实时定格）；Ctrl+滚轮缩放、滚轮平移；单击轨道空白添加关键帧，拖动微调时间；Alt 临时禁用吸附。'
            : '单击轨道空白添加关键帧；拖动或选中菱形/事件标记后用 ←→ 微调、Delete 删除；同层轨道共享缓动'}
        </span>
      </div>
      <div className={styles.timelineLanes}>
        <div ref={scrollRef} className={styles.timelineScroll}>
          <div
            ref={contentRef}
            className={styles.timelineContent}
            style={zoom !== 1 ? { width: `${zoom * 100}%` } : undefined}
          >
            <div className={styles.timelineRow}>
              <div className={styles.trackLabel} aria-hidden="true" />
              {advanced ? (
                <ScrubRuler
                  durationMs={durationMs}
                  laneWidthPx={laneWidthPx}
                  zoom={zoom}
                  playheadAt={playhead}
                  onScrub={handleScrub}
                />
              ) : (
                <TimelineRuler />
              )}
            </div>
            {tracks.map((track, trackIndex) => (
              <TrackLane
                key={track.property}
                track={track}
                selectedKeyframeIndex={
                  keyframeSelection !== null && keyframeSelection.trackIndex === trackIndex
                    ? keyframeSelection.keyframeIndex
                    : -1
                }
                onSelectKeyframe={(keyframeIndex) => setSelection({ type: 'keyframe', trackIndex, keyframeIndex })}
                onAddKeyframe={(at) => handleAddKeyframe(trackIndex, at)}
                onMoveKeyframe={(keyframeIndex, at) => handleMoveKeyframe(trackIndex, keyframeIndex, at)}
                onRemoveKeyframe={(keyframeIndex) => handleDeleteKeyframe(trackIndex, keyframeIndex)}
                onRemoveTrack={() => handleRemoveTrack(trackIndex)}
                snapAt={snapEdit ?? undefined}
              />
            ))}
            {showEvents ? (
              <EventTrack
                kind={kind}
                poseSwapCount={poseSwapCount}
                events={events}
                selectedIndex={eventSelection === null ? -1 : eventSelection.eventIndex}
                onSelectEvent={(eventIndex) => setSelection({ type: 'event', eventIndex })}
                onMoveEvent={(eventIndex, at) => updateEvents(moveEvent(events, eventIndex, at))}
                onDeleteEvent={(eventIndex) => handleDeleteEvent(eventIndex)}
                snapAt={snapEdit ?? undefined}
              />
            ) : null}
            {playhead !== null ? (
              <div className={styles.playhead} style={{ left: `${playhead * 100}%` }} aria-hidden="true">
                <span className={styles.playheadHead} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {inspector}
      {errors.length > 0 ? (
        <ul className={settingsStyles.animationErrors} aria-label="时间轴校验错误">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
