/**
 * client/timeline/TimelineRuler.tsx — two rulers:
 * - TimelineRuler (V1.1): the normalized 0..1 display ruler (0/25/50/75/100%).
 * - ScrubRuler (V1.2, advanced mode): the interactive ms ruler — click parks
 *   the playhead, dragging scrubs it; ticks adapt to zoom via the shared
 *   adaptive step so labels never crowd. Keyboard: ←/→ step the playhead by
 *   one grid step (Shift ×10).
 */
import { useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { adaptiveGridStep, formatTickMs } from './timeline-model'
import { beginPointerGesture } from './pointer-gesture'
import styles from './timeline.module.css'

const TICKS = [0, 25, 50, 75, 100] as const

export function TimelineRuler(): JSX.Element {
  return (
    <div className={styles.ruler} aria-hidden="true">
      {TICKS.map((tick) => (
        <span key={tick} className={styles.rulerTick} style={{ left: `${tick}%` }}>
          {tick}%
        </span>
      ))}
    </div>
  )
}

export interface ScrubRulerProps {
  durationMs: number
  /** Measured content width (px) — drives the adaptive tick step. */
  laneWidthPx: number
  zoom: number
  playheadAt: number | null
  onScrub: (at: number) => void
  /** V1.2: right-click opens the context menu (playhead to here). */
  onContextMenu?: (at: number, x: number, y: number) => void
}

export function ScrubRuler(props: ScrubRulerProps): JSX.Element {
  const laneRef = useRef<HTMLDivElement | null>(null)
  /** Cancels the in-flight scrub gesture when the ruler unmounts mid-press. */
  const gestureCancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => gestureCancelRef.current?.(), [])

  const atFromClientX = (clientX: number): number | null => {
    const rect = laneRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) return null
    return (clientX - rect.left) / rect.width
  }

  const scrubTo = (clientX: number): void => {
    const at = atFromClientX(clientX)
    if (at !== null) props.onScrub(at)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    gestureCancelRef.current?.()
    gestureCancelRef.current = beginPointerGesture(event, {
      onDrag: scrubTo,
      onClick: () => scrubTo(event.clientX),
    })
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (props.playheadAt === null) return
    const { grid } = adaptiveGridStep(props.durationMs, props.laneWidthPx > 0 ? props.laneWidthPx : 800, props.zoom)
    const step = grid * (event.shiftKey ? 10 : 1)
    const nudge = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    if (nudge !== 0) {
      event.preventDefault()
      props.onScrub(props.playheadAt + nudge)
    }
  }

  const handleContextMenu = props.onContextMenu === undefined ? undefined : (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const at = atFromClientX(event.clientX)
    if (at !== null) props.onContextMenu?.(at, event.clientX, event.clientY)
  }

  const { stepMs } = adaptiveGridStep(props.durationMs, props.laneWidthPx > 0 ? props.laneWidthPx : 800, props.zoom)
  const ticks: Array<{ ms: number; at: number }> = []
  for (let ms = 0; ms < props.durationMs; ms += stepMs) {
    ticks.push({ ms, at: props.durationMs > 0 ? ms / props.durationMs : 0 })
  }
  ticks.push({ ms: props.durationMs, at: 1 })

  return (
    <div
      ref={laneRef}
      className={`${styles.ruler} ${styles.rulerScrub}`}
      role="slider"
      aria-label="播放头位置"
      aria-valuemin={0}
      aria-valuemax={props.durationMs}
      aria-valuenow={props.playheadAt === null ? undefined : Math.round(props.playheadAt * props.durationMs)}
      aria-valuetext={props.playheadAt === null ? '未放置' : `${Math.round(props.playheadAt * props.durationMs)}ms`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      {ticks.map((tick) => (
        <span key={tick.ms} className={styles.rulerTick} style={{ left: `${tick.at * 100}%` }}>
          {formatTickMs(tick.ms)}
        </span>
      ))}
    </div>
  )
}
