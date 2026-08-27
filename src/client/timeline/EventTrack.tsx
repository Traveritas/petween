/**
 * client/timeline/EventTrack.tsx — timeline events as full-height marker
 * lines over the lanes (⚑ pose-swap, ✦ particle) plus the event inspector.
 * Markers drag horizontally like keyframes (same click/drag threshold);
 * clicking one opens the inspector below, where a particle changes effect
 * or gets deleted.
 *
 * Markers are keyboard-operable like keyframe diamonds (Enter/Space select,
 * ←/→ nudge, Delete deletes when the schema allows it); `touch-action: none`
 * keeps touch presses from scrolling instead of dragging.
 *
 * Deletion rules (the schema has the final say): a transition needs exactly
 * one pose-swap, so a lone pose-swap is never deletable; extras (invalid
 * input) can be removed so the editor can heal a broken draft. Interaction
 * pose-swaps are legal with a named target (see the inspector) and always
 * deletable (0 is allowed). Ambient kinds never render this track at all
 * (the editor hides it).
 */
import { useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AnimationKind, ParticleEffectId, TimelineEvent } from '../../motion/animation-definition'
import { POSE_KEYS } from '../../core/types'
import { NumberField, SelectRow, TextField } from '../settings/controls'
import settingsStyles from '../settings/settings.module.css'
import { eventTypeDisplayName } from './display-labels'
import { beginPointerGesture } from './pointer-gesture'
import { snapAt } from './timeline-model'
import styles from './timeline.module.css'

export const PARTICLE_EFFECT_OPTIONS: ReadonlyArray<{ value: ParticleEffectId; label: string }> = [
  { value: 'confetti', label: '彩带 confetti' },
  { value: 'star-burst', label: '星芒 star-burst' },
  { value: 'sparkle', label: '火花 sparkle' },
]

export function eventLabel(event: TimelineEvent): string {
  return event.type === 'pose-swap'
    ? `${eventTypeDisplayName('pose-swap')}事件 @ ${event.at}`
    : `粒子事件 ${event.effect} @ ${event.at}`
}

export interface EventTrackProps {
  kind: AnimationKind
  poseSwapCount: number
  events: TimelineEvent[]
  /** Index of the selected event, -1 when none. */
  selectedIndex: number
  onSelectEvent: (eventIndex: number) => void
  onMoveEvent: (eventIndex: number, at: number) => void
  onDeleteEvent: (eventIndex: number) => void
}

export function EventTrack(props: EventTrackProps): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null)

  const atFromClientX = (clientX: number): number | null => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) return null
    return snapAt((clientX - rect.left) / rect.width)
  }

  const handleMarkerDown = (eventIndex: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    beginPointerGesture(event, {
      onClick: () => props.onSelectEvent(eventIndex),
      onDrag: (clientX) => {
        const at = atFromClientX(clientX)
        if (at !== null) props.onMoveEvent(eventIndex, at)
      },
    })
  }

  // Keyboard activation: the same detail === 0 distinction as TrackLane —
  // pointer selection goes through the gesture's own click callback.
  const handleMarkerClick = (
    eventIndex: number,
  ) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    // Same contract as TrackLane's diamond clicks: never bubble — future
    // click handlers on an ancestor must not see marker activations.
    event.stopPropagation()
    if (event.detail === 0) props.onSelectEvent(eventIndex)
  }

  const deletable = (event: TimelineEvent): boolean =>
    event.type === 'particle' || props.kind !== 'transition' || props.poseSwapCount > 1

  const handleMarkerKeyDown =
    (eventIndex: number, event: TimelineEvent) =>
    (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const nudge = e.key === 'ArrowLeft' ? -0.01 : e.key === 'ArrowRight' ? 0.01 : 0
      if (nudge !== 0) {
        e.preventDefault()
        props.onMoveEvent(eventIndex, snapAt(event.at + nudge))
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && deletable(event)) {
        e.preventDefault()
        props.onDeleteEvent(eventIndex)
      }
    }

  return (
    <div ref={overlayRef} className={styles.eventOverlay} aria-label="事件轨">
      {props.events.map((event, index) => (
        // key = overlay index, not the `at` (same rationale as TrackLane: an
        // at-bearing key remounts the marker on ←→ nudge and kills focus).
        <div key={index} className={styles.eventMarker} style={{ left: `${event.at * 100}%` }}>
          <button
            type="button"
            className={
              index === props.selectedIndex ? `${styles.eventIcon} ${styles.eventIconSelected}` : styles.eventIcon
            }
            aria-label={eventLabel(event)}
            aria-pressed={index === props.selectedIndex}
            onPointerDown={handleMarkerDown(index)}
            onClick={handleMarkerClick(index)}
            onKeyDown={handleMarkerKeyDown(index, event)}
          >
            {event.type === 'pose-swap' ? '⚑' : '✦'}
          </button>
        </div>
      ))}
    </div>
  )
}

export interface EventInspectorProps {
  kind: AnimationKind
  event: TimelineEvent
  poseSwapCount: number
  onSetAt: (at: number) => void
  onSetEffect: (effect: ParticleEffectId) => void
  onSetPose: (pose: string | undefined) => void
  onDelete: () => void
}

export function EventInspector(props: EventInspectorProps): JSX.Element {
  const { event } = props
  const deletable =
    event.type === 'particle' || props.kind !== 'transition' || props.poseSwapCount > 1
  return (
    <div className={styles.inspector} aria-label="事件检查器">
      <div className={styles.inspectorTitle}>{eventLabel(event)}</div>
      <NumberField label="时间 at" min={0} max={1} step={0.01} value={event.at} onChange={props.onSetAt} />
      {event.type === 'particle' ? (
        <SelectRow label="特效" value={event.effect} options={PARTICLE_EFFECT_OPTIONS} onChange={props.onSetEffect} />
      ) : props.kind === 'interaction' ? (
        // Interaction pose-swaps are legal (0..n) but every one MUST name
        // its target — the swap resolves at play time: a builtin slot walks
        // its fallback chain, a user: id needs a companion registration; a
        // miss silently skips the swap (dangling-id discipline).
        <>
          <TextField
            label="目标姿态 pose"
            value={event.pose ?? ''}
            placeholder="内置槽名（idle…）或 user: 姿态 id"
            listId="petween-pose-targets"
            listOptions={POSE_KEYS}
            onChange={(value) => props.onSetPose(value.trim() === '' ? undefined : value.trim())}
          />
          <p className={styles.hint}>
            互动动画的 pose-swap 在播放时切到目标姿态：内置槽名走回退链，user: 姿态需先由附属插件注册；未命中的目标会被跳过。
          </p>
        </>
      ) : deletable ? (
        // A deletable pose-swap on a transition is an extra beyond the
        // mandatory exactly-one — the draft cannot save until it is removed.
        <p className={styles.hint}>过渡动画必须恰好包含一个 pose-swap（换图），多余的 pose-swap 建议删除。</p>
      ) : (
        <p className={styles.hint}>过渡动画必须恰好包含一个 pose-swap（换图），因此唯一的 pose-swap 不可删除。</p>
      )}
      {deletable ? (
        <button type="button" className={settingsStyles.button} onClick={props.onDelete}>
          删除事件
        </button>
      ) : null}
    </div>
  )
}
