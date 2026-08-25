/**
 * client/timeline/EventTrack.tsx — timeline events as full-height marker
 * lines over the lanes (⚑ pose-swap, ✦ particle) plus the event inspector.
 * Markers drag horizontally like keyframes (same click/drag threshold);
 * clicking one opens the inspector below, where a particle changes effect
 * or gets deleted.
 *
 * Deletion rules (the schema has the final say): a transition needs exactly
 * one pose-swap, so a lone pose-swap is never deletable; extras (invalid
 * input) and pose-swaps on interaction kinds (also invalid input) can be
 * removed so the editor can heal a broken draft. Ambient kinds never render
 * this track at all (the editor hides it).
 */
import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { AnimationKind, ParticleEffectId, TimelineEvent } from '../../motion/animation-definition'
import { NumberField, SelectRow } from '../settings/controls'
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
  events: TimelineEvent[]
  /** Index of the selected event, -1 when none. */
  selectedIndex: number
  onSelectEvent: (eventIndex: number) => void
  onMoveEvent: (eventIndex: number, at: number) => void
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

  return (
    <div ref={overlayRef} className={styles.eventOverlay} aria-label="事件轨">
      {props.events.map((event, index) => (
        <div key={index} className={styles.eventMarker} style={{ left: `${event.at * 100}%` }}>
          <button
            type="button"
            className={
              index === props.selectedIndex ? `${styles.eventIcon} ${styles.eventIconSelected}` : styles.eventIcon
            }
            aria-label={eventLabel(event)}
            aria-pressed={index === props.selectedIndex}
            onPointerDown={handleMarkerDown(index)}
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
