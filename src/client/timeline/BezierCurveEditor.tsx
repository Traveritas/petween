/**
 * client/timeline/BezierCurveEditor.tsx — the P14 visual single-segment
 * cubic-bezier editor (DevTools-style): an SVG plot of the parametric curve
 * with two draggable control handles (P1 = outgoing, P2 = incoming). The
 * numeric inputs in KeyframeInspector remain the precise/accessible path —
 * this canvas is the game-engine convenience on top, bidirectionally synced
 * through the same onChange.
 *
 * Math notes: the plotted curve is the PARAMETRIC (x(t), y(t)) polynomial
 * (createCubicBezier solves y for a given x-progress — wrong shape to plot
 * directly). Handle xs clamp to [0,1] per CSS cubic-bezier rules; ys clamp
 * to the plotted window, not the schema's ±10, so a drag never yanks the
 * curve out of view (the inputs still allow the wider range).
 */
import { useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { beginPointerGesture } from './pointer-gesture'
import { roundValue } from './timeline-model'
import styles from './timeline.module.css'

/** Plotted window: x is fixed [0,1]; y gives the handles some overshoot room. */
export const BEZIER_VIEW_Y_MIN = -1
export const BEZIER_VIEW_Y_MAX = 2
const VIEW_SIZE = 100
const VIEW_PAD = 8

export type BezierPoints = readonly [number, number, number, number]

/** One axis of the parametric cubic: 3(1-t)²t·p1 + 3(1-t)t²·p2 + t³. */
export function bezierAxis(t: number, p1: number, p2: number): number {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

/** Map a curve x (0..1) into viewBox units. */
export function viewX(x: number): number {
  return VIEW_PAD + x * (VIEW_SIZE - 2 * VIEW_PAD)
}

/** Map a curve y (view window) into viewBox units (y grows downward in SVG). */
export function viewY(y: number): number {
  const inner = VIEW_SIZE - 2 * VIEW_PAD
  const clamped = Math.min(BEZIER_VIEW_Y_MAX, Math.max(BEZIER_VIEW_Y_MIN, y))
  return VIEW_PAD + (1 - (clamped - BEZIER_VIEW_Y_MIN) / (BEZIER_VIEW_Y_MAX - BEZIER_VIEW_Y_MIN)) * inner
}

/** Inverse of viewY: viewBox units → curve y (unclamped by the caller). */
export function curveYFromView(view: number): number {
  const inner = VIEW_SIZE - 2 * VIEW_PAD
  return BEZIER_VIEW_Y_MIN + (1 - (view - VIEW_PAD) / inner) * (BEZIER_VIEW_Y_MAX - BEZIER_VIEW_Y_MIN)
}

/** Inverse of viewX: viewBox units → curve x. */
export function curveXFromView(view: number): number {
  return (view - VIEW_PAD) / (VIEW_SIZE - 2 * VIEW_PAD)
}

export interface BezierCurveEditorProps {
  points: BezierPoints
  onChange: (points: BezierPoints) => void
}

export function BezierCurveEditor(props: BezierCurveEditorProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const gestureCancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => gestureCancelRef.current?.(), [])

  const [x1, y1, x2, y2] = props.points

  /** Pointer position → viewBox units via the svg's client box (rect stubbed in jsdom). */
  const toView = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width <= 0) return null
    return {
      x: ((clientX - rect.left) / rect.width) * VIEW_SIZE,
      y: ((clientY - rect.top) / rect.height) * VIEW_SIZE,
    }
  }

  const handleDown = (pointIndex: 0 | 2) => (event: ReactPointerEvent<SVGCircleElement>): void => {
    event.stopPropagation()
    gestureCancelRef.current?.()
    gestureCancelRef.current = beginPointerGesture(event, {
      onClick: () => undefined,
      onDrag: (clientX, clientY) => {
        const view = toView(clientX, clientY)
        if (view === null) return
        const nextX = Math.min(1, Math.max(0, roundValue(curveXFromView(view.x))))
        const nextY = Math.min(BEZIER_VIEW_Y_MAX, Math.max(BEZIER_VIEW_Y_MIN, roundValue(curveYFromView(view.y))))
        const next = [...props.points] as [number, number, number, number]
        next[pointIndex] = nextX
        next[pointIndex + 1] = nextY
        props.onChange(next)
      },
    })
  }

  const curvePath = (() => {
    const steps = 64
    const parts: string[] = []
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      const x = bezierAxis(t, x1, x2)
      const y = bezierAxis(t, y1, y2)
      parts.push(`${step === 0 ? 'M' : 'L'}${viewX(x).toFixed(2)},${viewY(y).toFixed(2)}`)
    }
    return parts.join(' ')
  })()

  const guideLines = [
    `M${viewX(x1)},${viewY(y1)} L${viewX(0)},${viewY(0)}`,
    `M${viewX(x2)},${viewY(y2)} L${viewX(1)},${viewY(1)}`,
  ]

  return (
    <div className={styles.bezierEditor}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
        className={styles.bezierSvg}
        role="img"
        aria-label={`缓动曲线 cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})，拖动两个手柄调整`}
      >
        {/* frame + unit grid */}
        <rect x={viewX(0)} y={viewY(1)} width={viewX(1) - viewX(0)} height={viewY(0) - viewY(1)} className={styles.bezierFrame} />
        <line x1={viewX(0.5)} y1={viewY(BEZIER_VIEW_Y_MAX)} x2={viewX(0.5)} y2={viewY(BEZIER_VIEW_Y_MIN)} className={styles.bezierGridLine} />
        <line x1={viewX(0)} y1={viewY(0.5)} x2={viewX(1)} y2={viewY(0.5)} className={styles.bezierGridLine} />
        <line x1={viewX(0)} y1={viewY(1)} x2={viewX(1)} y2={viewY(1)} className={styles.bezierAxis} />
        <line x1={viewX(0)} y1={viewY(0)} x2={viewX(0)} y2={viewY(0)} className={styles.bezierAxis} />
        {/* control guides + the curve */}
        {guideLines.map((d) => (
          <path key={d} d={d} className={styles.bezierGuide} />
        ))}
        <path d={curvePath} className={styles.bezierCurve} />
        {/* handles */}
        <circle cx={viewX(x1)} cy={viewY(y1)} r={3} className={styles.bezierHandle} onPointerDown={handleDown(0)} />
        <circle cx={viewX(x2)} cy={viewY(y2)} r={3} className={styles.bezierHandle} onPointerDown={handleDown(2)} />
      </svg>
    </div>
  )
}
