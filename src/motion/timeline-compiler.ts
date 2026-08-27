/**
 * motion/timeline-compiler.ts — AnimationDefinition → CompiledTimeline
 * (spec §8.11).
 *
 * The compiler owns ALL schema interpretation so the scheduler stays dumb:
 * - validation, keyframe sorting and endpoint completion (§8.4),
 * - ParameterizedValue evaluation against runtime params (§8.8),
 * - easing alias → cubic-bezier resolution (§8.7),
 * - duration clamp (transitions 60..2000ms, §7.4),
 * - event sorting and timeline pre-cutting into segments at event points
 *   (§8.12): boundary values are sampled exactly (easing-aware), and offsets
 *   inside each segment are re-normalized to 0..1,
 * - reduced-motion adaptation (§22): tracks collapse to their final value and
 *   duration shrinks to <=120ms, but events survive — pose-swap must still run.
 */
import type { CubicBezierPoints } from './math'
import { clamp, createCubicBezier, lerp, resolveParameterizedValue } from './math'
import type { AnimationDefinition, RepeatPolicy, TimelineEvent } from './animation-definition'
import { assertValidAnimationDefinition, easingAt, parseEasing, resolveEasingCss, unionTrackTimes } from './animation-definition'
import type { MotionLayer, MotionProperty } from './motion-properties'
import { MOTION_PROPERTIES, composeLayerCss } from './motion-properties'
import { TRANSITION_DURATION_LIMITS, TRANSITION_STRENGTH_LIMITS } from '../core/types'

export interface CompileOptions {
  params?: { strength?: number }
  /** Overrides definition.durationMs (still clamped). */
  durationMs?: number
  /** Overrides definition.repeat. */
  repeat?: RepeatPolicy
  /** Overrides the default kind-based clamp (transitions: 60..2000ms). */
  durationClamp?: readonly [number, number]
  reducedMotion?: boolean
}

export interface CompiledSegment {
  /** Normalized 0..1 bounds of this segment within the full timeline. */
  start: number
  end: number
  durationMs: number
  /** One WAAPI keyframe list per touched layer; offsets re-normalized 0..1. */
  layers: Partial<Record<MotionLayer, Keyframe[]>>
}

/** A definition event plus its segment boundary (distributive over the union). */
export type CompiledTimelineEvent = TimelineEvent extends infer Event
  ? Event extends TimelineEvent
    ? Event & {
        /** Fires before this segment index; === segments.length means after the last one. */
        beforeSegmentIndex: number
      }
    : never
  : never

export interface CompiledTimeline {
  definitionId: string
  durationMs: number
  repeat: RepeatPolicy
  segments: CompiledSegment[]
  events: CompiledTimelineEvent[]
  reducedMotion: boolean
}

const REDUCED_MOTION_MAX_DURATION_MS = 120
const LINEAR: CubicBezierPoints = [0, 0, 1, 1]

interface NumericKeyframe {
  at: number
  value: number
  easingCss: string
  ease: (t: number) => number
}

interface NumericTrack {
  property: MotionProperty
  keyframes: NumericKeyframe[]
}

function resolveEasing(easing: string | undefined): { easingCss: string; ease: (t: number) => number } {
  const points = (easing === undefined ? null : parseEasing(easing)) ?? LINEAR // validated; null unreachable
  return { easingCss: resolveEasingCss(easing), ease: createCubicBezier(points) }
}

function numericKeyframe(at: number, value: number, easing?: string): NumericKeyframe {
  const resolved = resolveEasing(easing)
  return { at, value, easingCss: resolved.easingCss, ease: resolved.ease }
}

/**
 * §8.4 normalization: sort by `at`, evaluate values, then make endpoints
 * explicit — missing head starts from the property default, missing tail
 * holds the last value to 1.
 */
function normalizeTrack(track: AnimationDefinition['tracks'][number], strength: number, reducedMotion: boolean): NumericTrack {
  const descriptor = MOTION_PROPERTIES[track.property]
  const evaluate = (value: number | { base: number; parameter: 'strength'; amount: number }): number => {
    const resolved = resolveParameterizedValue(value, { strength })
    return clamp(resolved, descriptor.min ?? -Infinity, descriptor.max ?? Infinity)
  }

  if (reducedMotion) {
    const finalValue = evaluate(track.keyframes[track.keyframes.length - 1].value)
    return {
      property: track.property,
      keyframes: [numericKeyframe(0, finalValue), numericKeyframe(1, finalValue)],
    }
  }

  const sorted = [...track.keyframes].sort((a, b) => a.at - b.at)
  const keyframes = sorted.map((keyframe) => numericKeyframe(keyframe.at, evaluate(keyframe.value), keyframe.easing))
  if (keyframes[0].at > 0) {
    keyframes.unshift(numericKeyframe(0, descriptor.defaultValue))
  }
  const last = keyframes[keyframes.length - 1]
  if (last.at < 1) {
    keyframes.push(numericKeyframe(1, last.value))
  }
  return { property: track.property, keyframes }
}

/** Easing-aware sample of a normalized track at normalized time `at`. */
function sampleTrack(track: NumericTrack, at: number): number {
  const keyframes = track.keyframes
  if (at <= keyframes[0].at) return keyframes[0].value
  const last = keyframes[keyframes.length - 1]
  if (at >= last.at) return last.value
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index]
    const to = keyframes[index + 1]
    if (at >= from.at && at <= to.at) {
      if (to.at === from.at) return to.value
      return lerp(from.value, to.value, from.ease((at - from.at) / (to.at - from.at)))
    }
  }
  return last.value
}

function buildSegment(start: number, end: number, totalDurationMs: number, tracks: NumericTrack[]): CompiledSegment {
  const layers: Partial<Record<MotionLayer, Keyframe[]>> = {}
  const touchedLayers = new Set<MotionLayer>(tracks.map((track) => MOTION_PROPERTIES[track.property].targetLayer))

  for (const layer of touchedLayers) {
    const layerTracks = tracks.filter((track) => MOTION_PROPERTIES[track.property].targetLayer === layer)
    const sortedTimes = unionTrackTimes(start, end, layerTracks)

    layers[layer] = sortedTimes.map((time) => {
      const valueOf = (property: MotionProperty): number => {
        const track = layerTracks.find((candidate) => candidate.property === property)
        return track === undefined ? MOTION_PROPERTIES[property].defaultValue : sampleTrack(track, time)
      }
      const firstTrack = layerTracks[0]
      const easing = firstTrack === undefined ? 'linear' : easingAt(firstTrack, time)
      return {
        offset: end === start ? 0 : (time - start) / (end - start),
        easing,
        ...composeLayerCss(layer, valueOf),
      }
    })
  }

  return { start, end, durationMs: (end - start) * totalDurationMs, layers }
}

export function compileTimeline(definition: AnimationDefinition, options: CompileOptions = {}): CompiledTimeline {
  assertValidAnimationDefinition(definition)

  const strengthParameter = definition.parameters?.strength
  // Undeclared parameter bounds default to the global transition limits, not
  // the historical 1.8 constant — externally registered definitions without a
  // `parameters` block keep the same headroom as editor-authored ones.
  const strength = clamp(
    options.params?.strength ?? strengthParameter?.default ?? 1,
    strengthParameter?.min ?? TRANSITION_STRENGTH_LIMITS.min,
    strengthParameter?.max ?? TRANSITION_STRENGTH_LIMITS.max,
  )

  const [minDuration, maxDuration] =
    options.durationClamp ??
    (definition.kind === 'transition'
      ? ([TRANSITION_DURATION_LIMITS.min, TRANSITION_DURATION_LIMITS.max] as const)
      : // Ambient periods are user-widened to 120000ms in the config schema, so
        // the generic clamp must not cut them back to the old 60000 ceiling.
        ([1, 120_000] as const))
  let durationMs = clamp(options.durationMs ?? definition.durationMs, minDuration, maxDuration)

  const reducedMotion = options.reducedMotion ?? false
  if (reducedMotion) durationMs = Math.min(durationMs, REDUCED_MOTION_MAX_DURATION_MS)

  const tracks = definition.tracks.map((track) => normalizeTrack(track, strength, reducedMotion))

  // Event points pre-cut the timeline (§8.12); events keep sorted order.
  const sortedEvents = [...(definition.events ?? [])].sort((a, b) => a.at - b.at)
  // The runtime repeat override is trusted input that bypasses definition-level
  // validation — enforce the same eventful-alternate rule here so an override
  // cannot silently replay eventful timelines forward with direction semantics.
  const repeat = options.repeat ?? definition.repeat
  if (sortedEvents.length > 0 && repeat.mode === 'alternate') {
    throw new Error(
      `compileTimeline(${definition.id}): repeat "alternate" with events is not supported (V1 replays eventful timelines forward)`,
    )
  }
  const boundaries = [...new Set<number>([0, 1, ...sortedEvents.map((event) => event.at)])].sort((a, b) => a - b)
  const segments: CompiledSegment[] = []
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    segments.push(buildSegment(boundaries[index], boundaries[index + 1], durationMs, tracks))
  }
  const events: CompiledTimelineEvent[] = sortedEvents.map((event) => ({
    ...event,
    // The boundary index of `at` is exactly the segment that starts there;
    // for at=1 it equals segments.length (fires after the final segment).
    beforeSegmentIndex: boundaries.indexOf(event.at),
  }))

  return {
    definitionId: definition.id,
    durationMs,
    repeat,
    segments,
    events,
    reducedMotion,
  }
}
