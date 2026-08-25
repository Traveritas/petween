/**
 * client/timeline/KeyframeInspector.tsx — edits the selected keyframe:
 * time at (clamped/snapped/dup-checked by the caller's model op), value
 * (fixed number or strength-parameterized base + amount), and easing
 * (named presets or a custom cubic-bezier). Easing changes go through
 * onSetEasing so the editor can sync the whole layer (V1 same-layer rule,
 * see timeline-model.setKeyframeEasing) — the hint under the control says
 * so to the user.
 */
import type { JSX } from 'react'
import type {
  MotionEasing,
  MotionEasingName,
  MotionKeyframe,
  MotionTrack,
  ParameterizedValue,
} from '../../motion/animation-definition'
import { EASING_BEZIERS, isParameterizedValue, parseEasing } from '../../motion/animation-definition'
import { MOTION_PROPERTIES } from '../../motion/motion-properties'
import { NumberField, SelectRow } from '../settings/controls'
import settingsStyles from '../settings/settings.module.css'
import { motionPropertyDisplayName } from './display-labels'
import { roundValue } from './timeline-model'
import styles from './timeline.module.css'

const EASING_LABELS: Record<MotionEasingName, string> = {
  linear: '线性 linear',
  ease: 'ease',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
  'spring-soft': '弹性·柔和 spring-soft',
  'spring-snappy': '弹性·干脆 spring-snappy',
  overshoot: '过冲 overshoot',
  anticipate: '回摆 anticipate',
}

const EASING_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...(Object.keys(EASING_BEZIERS) as MotionEasingName[]).map((name) => ({ value: name as string, label: EASING_LABELS[name] })),
  { value: 'custom', label: '自定义 cubic-bezier…' },
]

const VALUE_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'fixed', label: '固定值' },
  { value: 'parameterized', label: '强度参数' },
]

const BEZIER_POINT_LABELS = ['x1', 'y1', 'x2', 'y2'] as const

export interface KeyframeInspectorProps {
  track: MotionTrack
  keyframeIndex: number
  onSetAt: (keyframeIndex: number, at: number) => void
  onSetValue: (keyframeIndex: number, value: MotionKeyframe['value']) => void
  onSetEasing: (keyframeIndex: number, easing: MotionEasing | undefined) => void
  onDelete: (keyframeIndex: number) => void
}

export function KeyframeInspector(props: KeyframeInspectorProps): JSX.Element | null {
  const keyframe = props.track.keyframes[props.keyframeIndex]
  if (keyframe === undefined) return null
  const descriptor = MOTION_PROPERTIES[props.track.property]
  const valueStep = descriptor.kind === 'scale' || descriptor.kind === 'ratio' ? 0.01 : 1
  const valueMin = descriptor.min ?? -4096
  const valueMax = descriptor.max ?? 4096

  const value = keyframe.value
  const parameterized = isParameterizedValue(value)
  // Explicit views for the two modes; the guard has already vetted the shape.
  const fixedValue = value as number
  const paramValue = value as ParameterizedValue

  const isCustomBezier = keyframe.easing !== undefined && !(keyframe.easing in EASING_BEZIERS)
  const easingChoice = keyframe.easing === undefined ? 'linear' : isCustomBezier ? 'custom' : keyframe.easing
  // Points backing the custom-bezier inputs: the current curve, or ease when
  // switching in from a named preset, so the visible curve stays continuous.
  const bezierPoints = (keyframe.easing === undefined ? null : parseEasing(keyframe.easing)) ?? EASING_BEZIERS.ease

  const setValueMode = (mode: string): void => {
    if (mode === 'parameterized' && !parameterized) {
      props.onSetValue(props.keyframeIndex, { base: fixedValue, parameter: 'strength', amount: 0 })
    } else if (mode === 'fixed' && parameterized) {
      // Keep what the curve showed at the default strength (1): base + amount.
      props.onSetValue(props.keyframeIndex, roundValue(paramValue.base + paramValue.amount))
    }
  }

  const setEasingChoice = (choice: string): void => {
    if (choice === 'custom') {
      const [x1, y1, x2, y2] = bezierPoints
      props.onSetEasing(props.keyframeIndex, `cubic-bezier(${x1},${y1},${x2},${y2})`)
    } else if (choice === 'linear') {
      props.onSetEasing(props.keyframeIndex, undefined)
    } else {
      props.onSetEasing(props.keyframeIndex, choice as MotionEasing)
    }
  }

  const setBezierPoint = (pointIndex: number, pointValue: number): void => {
    const points = [...bezierPoints] as [number, number, number, number]
    points[pointIndex] = pointValue
    props.onSetEasing(props.keyframeIndex, `cubic-bezier(${points[0]},${points[1]},${points[2]},${points[3]})`)
  }

  return (
    <div className={styles.inspector} aria-label="关键帧检查器">
      <div className={styles.inspectorTitle}>
        关键帧：{motionPropertyDisplayName(props.track.property)} @ {keyframe.at}
      </div>
      <NumberField
        label="时间 at"
        min={0}
        max={1}
        step={0.01}
        value={keyframe.at}
        onChange={(at) => props.onSetAt(props.keyframeIndex, at)}
      />
      <SelectRow label="取值" value={parameterized ? 'parameterized' : 'fixed'} options={VALUE_MODE_OPTIONS} onChange={setValueMode} />
      {parameterized ? (
        <>
          <NumberField
            label="基础值 base"
            min={valueMin}
            max={valueMax}
            step={valueStep}
            value={paramValue.base}
            onChange={(base) => props.onSetValue(props.keyframeIndex, { ...paramValue, base })}
          />
          <NumberField
            label="强度系数 amount"
            min={-4096}
            max={4096}
            step={0.01}
            value={paramValue.amount}
            onChange={(amount) => props.onSetValue(props.keyframeIndex, { ...paramValue, amount })}
          />
          <p className={styles.hint}>实际值 = base + 强度 × amount（强度默认为 1）</p>
        </>
      ) : (
        <NumberField
          label="值"
          min={valueMin}
          max={valueMax}
          step={valueStep}
          value={fixedValue}
          onChange={(next) => props.onSetValue(props.keyframeIndex, next)}
        />
      )}
      <SelectRow label="缓动" value={easingChoice} options={EASING_OPTIONS} onChange={setEasingChoice} />
      {easingChoice === 'custom' ? (
        <div className={styles.bezierGrid}>
          {BEZIER_POINT_LABELS.map((name, pointIndex) => (
            <NumberField
              key={name}
              label={name}
              min={pointIndex % 2 === 0 ? 0 : -10}
              max={pointIndex % 2 === 0 ? 1 : 10}
              step={0.01}
              value={bezierPoints[pointIndex]}
              onChange={(pointValue) => setBezierPoint(pointIndex, pointValue)}
            />
          ))}
        </div>
      ) : null}
      <p className={styles.hint}>同层轨道共享缓动：此处的修改会同步到同层其他轨道的相交区间。</p>
      <button type="button" className={settingsStyles.button} onClick={() => props.onDelete(props.keyframeIndex)}>
        删除关键帧
      </button>
    </div>
  )
}
