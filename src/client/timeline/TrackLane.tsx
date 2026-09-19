/**
 * client/timeline/TrackLane.tsx — one motion-property track: the label (with
 * the delete-track button) plus the keyframe lane. Clicking empty lane space
 * adds a keyframe at that time; pressing a diamond selects it, dragging it
 * retimes it. Raw pixels become snapped 0..1 times here, where the lane's
 * bounding rect lives; the model keeps the data rules (clamp/snap/no-dup).
 *
 * V1.2 (advanced mode): the selection is a set (shift = range within the
 * track, ctrl = toggle); dragging on EMPTY lane space is a time-band marquee
 * (the DOM click that follows a drag is suppressed); right-click opens the
 * context menu (keyframe / lane / track targets).
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
import { snapAt as snapAtGrid } from './timeline-model'
import styles from './timeline.module.css'

/** Click modifiers for multi-select (advanced mode); absent in V1.1 clicks. */
export interface SelectModifiers {
  shift: boolean
  toggle: boolean
}

export interface LaneContextMenuTarget {
  kind: 'keyframe'
  trackIndex: number
  keyframeIndex: number
}

export interface TrackLaneProps {
  track: MotionTrack
  trackIndex: number
  /** Selected keyframe indices (V1.1 passes a 0/1-entry set). */
  selectedKeyframeIndices: ReadonlySet<number>
  onSelectKeyframe: (keyframeIndex: number, modifiers?: SelectModifiers) => void
  onAddKeyframe: (at: number) => void
  onMoveKeyframe: (keyframeIndex: number, at: number) => void
  onRemoveKeyframe: (keyframeIndex: number) => void
  onRemoveTrack: () => void
  /** V1.2: zoom-adaptive snap with targets; default = the 0.01 grid. */
  snapAt?: (at: number) => number
  /** V1.2: empty-lane drag marquee — phase start/move/end with band times. */
  onMarquee?: (phase: 'start' | 'move' | 'end', fromAt: number, toAt: number, shift: boolean) => void
  onContextMenu?: (target: LaneContextMenuTarget | { kind: 'lane'; at: number } | { kind: 'track' }, x: number, y: number) => void
}

export function TrackLane(props: TrackLaneProps): JSX.Element {
  const { track } = props
  const laneRef = useRef<HTMLDivElement | null>(null)
  /** The in-flight gesture's cancel handle — the lane hosts one at a time. */
  const gestureCancelRef = useRef<(() => void) | null>(null)
  /** A marquee drag suppresses the DOM click that follows the pointerup. */
  const marqueeDraggedRef = useRef(false)

  // A gesture only self-cleans on move/up/cancel: a mid-press unmount would
  // leak its window listeners (and keep retiming a dead lane) otherwise.
  useEffect(() => () => gestureCancelRef.current?.(), [])

  const snap = props.snapAt ?? snapAtGrid
  const atFromClientX = (clientX: number): number | null => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) return null // no layout (jsdom without a stub) — no-op
    return snap((clientX - rect.left) / rect.width)
  }

  const handleLaneClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (marqueeDraggedRef.current) {
      marqueeDraggedRef.current = false
      return
    }
    if (event.target !== event.currentTarget) return // diamond clicks bubble up here
    const at = atFromClientX(event.clientX)
    if (at !== null) props.onAddKeyframe(at)
  }

  // V1.2: empty-lane press = marquee (drag) or add-keyframe (click via the DOM
  // click handler above). Only in advanced mode (onMarquee provided).
  const handleLanePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (props.onMarquee === undefined || event.button !== 0) return
    if (event.target !== event.currentTarget) return // diamond presses own their gesture
    event.preventDefault()
    marqueeDraggedRef.current = false
    const shift = event.shiftKey
    const atOf = (clientX: number): number | null => {
      const rect = laneRef.current?.getBoundingClientRect()
      if (rect === undefined || rect.width <= 0) return null
      return (clientX - rect.left) / rect.width // raw band times; the commit decides
    }
    const startAt = atOf(event.clientX)
    if (startAt === null) return
    let lastAt = startAt
    gestureCancelRef.current?.()
    gestureCancelRef.current = beginPointerGesture(event, {
      onDrag: (clientX) => {
        const at = atOf(clientX)
        if (at === null) return
        marqueeDraggedRef.current = true
        lastAt = at
        props.onMarquee?.('move', startAt, at, shift)
      },
      onClick: () => undefined, // the DOM click handler adds the keyframe
      onEnd: (dragged) => {
        if (!dragged) return
        props.onMarquee?.('end', Math.min(startAt, lastAt), Math.max(startAt, lastAt), shift)
      },
    })
  }

  const handleKeyframeDown = (keyframeIndex: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    gestureCancelRef.current?.() // a fresh press supersedes a gesture still open
    const modifiers: SelectModifiers | undefined = props.onMarquee === undefined ? undefined : {
      shift: event.shiftKey,
      toggle: event.ctrlKey || event.metaKey,
    }
    gestureCancelRef.current = beginPointerGesture(event, {
      onClick: () => props.onSelectKeyframe(keyframeIndex, modifiers),
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
  ) => (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (event.detail === 0) props.onSelectKeyframe(keyframeIndex)
  }

  const handleKeyframeKeyDown =
    (keyframeIndex: number, at: number) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const nudge = event.key === 'ArrowLeft' ? -0.01 : event.key === 'ArrowRight' ? 0.01 : 0
      if (nudge !== 0) {
        event.preventDefault()
        props.onMoveKeyframe(keyframeIndex, snapAtGrid(at + nudge))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        props.onRemoveKeyframe(keyframeIndex)
      }
    }

  return (
    <div className={styles.timelineRow}>
      <div
        className={styles.trackLabel}
        onContextMenu={
          props.onContextMenu === undefined
            ? undefined
            : (event) => {
                event.preventDefault()
                props.onContextMenu?.({ kind: 'track' }, event.clientX, event.clientY)
              }
        }
      >
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
      <div
        ref={laneRef}
        className={styles.lane}
        aria-label={`轨道 ${track.property}`}
        onClick={handleLaneClick}
        onPointerDown={handleLanePointerDown}
        onContextMenu={
          props.onContextMenu === undefined
            ? undefined
            : (event) => {
                if (event.target !== event.currentTarget) return // diamonds own theirs
                event.preventDefault()
                const at = atFromClientX(event.clientX)
                if (at !== null) props.onContextMenu?.({ kind: 'lane', at }, event.clientX, event.clientY)
              }
        }
      >
        {track.keyframes.map((keyframe, index) => (
          // key = lane index, deliberately NOT the `at`: a ←→ nudge changes
          // `at`, and an at-bearing key would remount the button — focus
          // drops to <body> and keyboard nudging dies after one step. The
          // index is stable across moves (moveKeyframe maps in place).
          <button
            key={index}
            type="button"
            className={
              props.selectedKeyframeIndices.has(index)
                ? `${styles.keyframe} ${styles.keyframeSelected}`
                : styles.keyframe
            }
            style={{ left: `${keyframe.at * 100}%` }}
            aria-label={`关键帧 ${track.property} @ ${keyframe.at}`}
            aria-pressed={props.selectedKeyframeIndices.has(index)}
            onPointerDown={handleKeyframeDown(index)}
            onClick={handleKeyframeClick(index)}
            onKeyDown={handleKeyframeKeyDown(index, keyframe.at)}
            onContextMenu={
              props.onContextMenu === undefined
                ? undefined
                : (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    props.onContextMenu?.(
                      { kind: 'keyframe', trackIndex: props.trackIndex, keyframeIndex: index },
                      event.clientX,
                      event.clientY,
                    )
                  }
            }
          />
        ))}
      </div>
    </div>
  )
}
