/**
 * client/timeline/TrackLane.tsx — one motion-property track: the label (with
 * the delete-track button) plus the keyframe lane. Clicking empty lane space
 * adds a keyframe at that time; pressing a diamond selects it, dragging it
 * retimes it. Raw pixels become snapped 0..1 times here, where the lane's
 * bounding rect lives; the model keeps the data rules (clamp/snap/no-dup).
 *
 * Diamonds are real buttons and keyboard-operable: Enter/Space select (the
 * pointer gesture never sees those synthetic clicks), ←/→ nudge the time by
 * one 0.01 grid step, Delete removes. `touch-action: none` keeps touch
 * presses on a diamond from scrolling the page instead of dragging.
 */
import { useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { MotionTrack } from '../../motion/animation-definition'
import { motionPropertyDisplayName } from './display-labels'
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
  onRemoveKeyframe: (keyframeIndex: number) => void
  onRemoveTrack: () => void
}

export function TrackLane(props: TrackLaneProps): JSX.Element {
  const { track } = props
  const laneRef = useRef<HTMLDivElement | null>(null)
  /** The in-flight gesture's cancel handle — the lane hosts one at a time. */
  const gestureCancelRef = useRef<(() => void) | null>(null)

  // A gesture only self-cleans on move/up/cancel: a mid-press unmount would
  // leak its window listeners (and keep retiming a dead lane) otherwise.
  useEffect(() => () => gestureCancelRef.current?.(), [])

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
    gestureCancelRef.current?.() // a fresh press supersedes a gesture still open
    gestureCancelRef.current = beginPointerGesture(event, {
      onClick: () => props.onSelectKeyframe(keyframeIndex),
      onDrag: (clientX) => {
        const at = atFromClientX(clientX)
        if (at !== null) props.onMoveKeyframe(keyframeIndex, at)
      },
    })
  }

  // The pointer path selects through beginPointerGesture's onClick; Enter /
  // Space produce clicks with detail === 0 that never traverse it — handle
  // them here so Tab+Enter works instead of a dead aria-pressed button.
  const handleKeyframeClick = (
    keyframeIndex: number,
  ) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (event.detail === 0) props.onSelectKeyframe(keyframeIndex)
  }

  const handleKeyframeKeyDown =
    (keyframeIndex: number, at: number) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const nudge = event.key === 'ArrowLeft' ? -0.01 : event.key === 'ArrowRight' ? 0.01 : 0
      if (nudge !== 0) {
        event.preventDefault()
        props.onMoveKeyframe(keyframeIndex, snapAt(at + nudge))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        props.onRemoveKeyframe(keyframeIndex)
      }
    }

  return (
    <div className={styles.timelineRow}>
      <div className={styles.trackLabel}>
        {/* Visible label carries the Chinese gloss; the tooltip keeps the raw
            property as the canonical identifier for copy/reference. */}
        <span className={styles.trackProperty} title={track.property}>
          {motionPropertyDisplayName(track.property)}
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
          // key = lane index, deliberately NOT the `at`: a ←→ nudge changes
          // `at`, and an at-bearing key would remount the button — focus
          // drops to <body> and keyboard nudging dies after one step. The
          // index is stable across moves (moveKeyframe maps in place).
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
            onClick={handleKeyframeClick(index)}
            onKeyDown={handleKeyframeKeyDown(index, keyframe.at)}
          />
        ))}
      </div>
    </div>
  )
}
