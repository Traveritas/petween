/**
 * client/timeline/TimelineEditor.tsx — the V1.1 P1 visual timeline editor:
 * toolbar (add-track grouped by layer, add-particle, heal a missing
 * pose-swap) + ruler + event markers + keyframe lanes + inspector. Purely
 * controlled: every edit produces new tracks/events through onChange and
 * nothing is persisted here.
 *
 * Every change is re-validated against the real schema
 * (validateTimelineDraft — a synthetic known-valid definition around
 * kind/tracks/events). The errors are listed inline AND reported through
 * onValidationChange, so the host panel (AnimationLibrary integration, next
 * round) disables its 保存 button while the list is non-empty — the same
 * gating the P0 JSON editor applied via evaluation.definition === null.
 */
import { useEffect, useMemo, useState, type ChangeEvent, type JSX } from 'react'
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
import { EventInspector, EventTrack, PARTICLE_EFFECT_OPTIONS } from './EventTrack'
import { KeyframeInspector } from './KeyframeInspector'
import { TimelineRuler } from './TimelineRuler'
import { TrackLane } from './TrackLane'
import {
  addKeyframe,
  addParticleEvent,
  addPoseSwapEvent,
  addTrack,
  moveEvent,
  moveKeyframe,
  removeEvent,
  removeKeyframe,
  removeTrack,
  setKeyframeEasing,
  setKeyframeValue,
  setParticleEffect,
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

export function TimelineEditor(props: TimelineEditorProps): JSX.Element {
  const { kind, tracks, events } = props
  const [selection, setSelection] = useState<Selection | null>(null)

  const errors = useMemo(() => validateTimelineDraft(kind, tracks, events), [kind, tracks, events])
  useEffect(() => {
    props.onValidationChange?.(errors)
  }, [props.onValidationChange, errors])

  const poseSwapCount = events.filter((event) => event.type === 'pose-swap').length
  const showEvents = kind !== 'ambient'

  const updateTracks = (nextTracks: MotionTrack[]): void => props.onChange({ tracks: nextTracks, events })
  const updateEvents = (nextEvents: TimelineEvent[]): void => props.onChange({ tracks, events: nextEvents })

  const replaceTrack = (trackIndex: number, track: MotionTrack): void =>
    updateTracks(tracks.map((current, index) => (index === trackIndex ? track : current)))

  // --- track-level ops -----------------------------------------------------

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
    const edit = addPoseSwapEvent(events)
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
        onDelete={() => handleDeleteEvent(eventSelection.eventIndex)}
      />
    )
  } else {
    inspector = <p className={styles.hint}>选中关键帧或事件标记进行编辑；同层轨道的缓动按区间自动保持一致。</p>
  }

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
                    {property}
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
        {kind === 'transition' && poseSwapCount === 0 ? (
          <button type="button" className={settingsStyles.button} onClick={handleAddPoseSwap}>
            ＋ 添加 pose-swap
          </button>
        ) : null}
        <span className={styles.timelineHint}>
          单击轨道空白添加关键帧；拖动菱形或事件标记调整时间；同层轨道共享缓动
        </span>
      </div>
      <div className={styles.timelineLanes}>
        <div className={styles.timelineRow}>
          <div className={styles.trackLabel} aria-hidden="true" />
          <TimelineRuler />
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
            onRemoveTrack={() => handleRemoveTrack(trackIndex)}
          />
        ))}
        {showEvents ? (
          <EventTrack
            events={events}
            selectedIndex={eventSelection === null ? -1 : eventSelection.eventIndex}
            onSelectEvent={(eventIndex) => setSelection({ type: 'event', eventIndex })}
            onMoveEvent={(eventIndex, at) => updateEvents(moveEvent(events, eventIndex, at))}
          />
        ) : null}
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
