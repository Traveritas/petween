/**
 * client/timeline/TrackLane.tsx — one motion-property track: the label (with
 * the delete-track button) plus the keyframe lane. Clicking empty lane space
 * adds a keyframe at that time; pressing a diamond selects it, dragging it
 * retimes it. Raw pixels become snapped 0..1 times here, where the lane's
 * bounding rect lives; the model keeps the data rules (clamp/snap/no-dup).
 */
import { useRef, type JSX, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { MotionTrack } from '../../motion/animation-definition'
import { beginPointerGesture } from './pointer-gesture'
import { snapAt } from './timeline-model'
import styles from './timeline.module.css'

export interface TrackLaneProps {
  track: MotionTrack
  /** Index of the selected keyframe, -1 when none. */
  selectedKeyframeIndex: number
  onSelectKeyframe: (keyframeIndex: number) => void
  onAddKeyframe: (at: number) => void
  onMoveKeyframe: (keyframeIndex: number, at: number) => void
  onRemoveTrack: () => void
}

export function TrackLane(props: TrackLaneProps): JSX.Element {
  const { track } = props
  const laneRef = useRef<HTMLDivElement | null>(null)

  const atFromClientX = (clientX: number): number | null => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) return null // no layout (jsdom without a stub) — no-op
    return snapAt((clientX - rect.left) / rect.width)
  }

  const handleLaneClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return // diamond clicks bubble up here
    const at = atFromClientX(event.clientX)
    if (at !== null) props.onAddKeyframe(at)
  }

  const handleKeyframeDown = (keyframeIndex: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    beginPointerGesture(event, {
      onClick: () => props.onSelectKeyframe(keyframeIndex),
      onDrag: (clientX) => {
        const at = atFromClientX(clientX)
        if (at !== null) props.onMoveKeyframe(keyframeIndex, at)
      },
    })
  }

  return (
    <div className={styles.timelineRow}>
      <div className={styles.trackLabel}>
        <span className={styles.trackProperty} title={track.property}>
          {track.property}
        </span>
        <button
          type="button"
          className={styles.trackDelete}
          aria-label={`删除轨道 ${track.property}`}
          onClick={props.onRemoveTrack}
        >
          ✕
        </button>
      </div>
      <div ref={laneRef} className={styles.lane} aria-label={`轨道 ${track.property}`} onClick={handleLaneClick}>
        {track.keyframes.map((keyframe, index) => (
          <button
            key={index}
            type="button"
            className={
              index === props.selectedKeyframeIndex ? `${styles.keyframe} ${styles.keyframeSelected}` : styles.keyframe
            }
            style={{ left: `${keyframe.at * 100}%` }}
            aria-label={`关键帧 ${track.property} @ ${keyframe.at}`}
            aria-pressed={index === props.selectedKeyframeIndex}
            onPointerDown={handleKeyframeDown(index)}
            onClick={(event) => event.stopPropagation()}
          />
        ))}
      </div>
    </div>
  )
}
