/**
 * motion/animation-definition.ts — the AnimationDefinition data model
 * (spec §8.3–§8.9) plus hand-written schema validation.
 *
 * The model is JSON-serializable by design (Motion Pack forward compat,
 * §8.18). Validation is hand-rolled: no schema dependency. Everything the
 * runtime needs is validated once at register/compile time; the scheduler
 * never re-interprets schema (§8.11).
 */
import type { CubicBezierPoints } from './math'
import { isMotionProperty, MOTION_PROPERTIES, type MotionLayer, type MotionProperty } from './motion-properties'

/** Spec §8.8. `value = base + params[parameter] * amount`. */
export interface ParameterizedValue {
  base: number
  parameter: 'strength'
  amount: number
}

/** Spec §8.7 named easings plus semantic aliases. */
export type MotionEasingName =
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'spring-soft'
  | 'spring-snappy'
  | 'overshoot'
  | 'anticipate'

export type MotionEasing = MotionEasingName | `cubic-bezier(${number},${number},${number},${number})`

/** Keyframe times are normalized 0..1, never absolute ms (spec §8.3). */
export interface MotionKeyframe {
  at: number
  value: number | ParameterizedValue
  easing?: MotionEasing
}

export interface MotionTrack {
  property: MotionProperty
  keyframes: MotionKeyframe[]
}

/** Particle burst effects the client renderer knows (spec §8.5 extension). */
export type ParticleEffectId = 'confetti' | 'star-burst' | 'sparkle'

export const PARTICLE_EFFECT_IDS: readonly ParticleEffectId[] = ['confetti', 'star-burst', 'sparkle']

/**
 * V1 events: the pose swap plus particle bursts (spec §8.5). The union still
 * leaves room for sound/etc.
 */
export type TimelineEvent =
  | {
      at: number
      type: 'pose-swap'
    }
  | {
      at: number
      type: 'particle'
      effect: ParticleEffectId
    }

export type RepeatPolicy =
  | { mode: 'once' }
  | { mode: 'loop' }
  | { mode: 'alternate' }
  | { mode: 'random-interval'; minDelayMs: number; maxDelayMs: number }

export type AnimationKind = 'transition' | 'ambient' | 'interaction'

export interface AnimationDefinition {
  version: 1
  /** `builtin:<name>` for presets, `user:<id>` for user animations (§8.13). */
  id: string
  name: string
  kind: AnimationKind
  durationMs: number
  repeat: RepeatPolicy
  tracks: MotionTrack[]
  events?: TimelineEvent[]
  parameters?: {
    strength?: {
      default: number
      min: number
      max: number
    }
  }
}

/** Semantic aliases compile down to cubic-bezier (spec §8.7); no spring solver in V1. */
export const EASING_BEZIERS: Record<MotionEasingName, CubicBezierPoints> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'spring-soft': [0.25, 1.1, 0.45, 1],
  'spring-snappy': [0.2, 1.4, 0.4, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, 0, 0.66, -0.56],
}

const CUBIC_BEZIER_RE =
  /^cubic-bezier\(\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)$/

/**
 * Parse any legal MotionEasing into bezier control points. CSS requires the
 * x values in 0..1 (y may overshoot); invalid input returns null.
 */
export function parseEasing(easing: string): CubicBezierPoints | null {
  if (easing in EASING_BEZIERS) return EASING_BEZIERS[easing as MotionEasingName]
  const match = CUBIC_BEZIER_RE.exec(easing)
  if (match === null) return null
  const points: CubicBezierPoints = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  if (points[0] < 0 || points[0] > 1 || points[2] < 0 || points[2] > 1) return null
  return points
}

export function isParameterizedValue(value: unknown): value is ParameterizedValue {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.base === 'number' &&
    Number.isFinite(candidate.base) &&
    candidate.parameter === 'strength' &&
    typeof candidate.amount === 'number' &&
    Number.isFinite(candidate.amount)
  )
}

/**
 * The canonical CSS string the compiler emits for an easing. Unknown input
 * degrades to linear, matching the compiler's fallback — invalid easings are
 * reported by validateKeyframe before this ever runs.
 */
export function resolveEasingCss(easing: string | undefined): string {
  if (easing === undefined) return 'linear'
  const points = parseEasing(easing)
  if (points === null) return 'linear'
  return `cubic-bezier(${points.join(',')})`
}

/** Minimal track shape the easing helpers need (the compiler's NumericTrack qualifies). */
export interface EasingTimeline {
  keyframes: Array<{ at: number; easingCss: string }>
}

/** The easing in force at `at`: the exact keyframe's, else the surrounding pair's. */
export function easingAt(track: EasingTimeline, at: number): string {
  const exact = track.keyframes.find((keyframe) => keyframe.at === at)
  if (exact !== undefined) return exact.easingCss
  for (let index = 0; index < track.keyframes.length - 1; index += 1) {
    const from = track.keyframes[index]
    const to = track.keyframes[index + 1]
    if (at > from.at && at < to.at) return from.easingCss
  }
  return 'linear'
}

/** Union of the segment bounds and every track keyframe time inside (start, end). */
export function unionTrackTimes(start: number, end: number, tracks: EasingTimeline[]): number[] {
  const times = new Set<number>([start, end])
  for (const track of tracks) {
    for (const keyframe of track.keyframes) {
      if (keyframe.at > start && keyframe.at < end) times.add(keyframe.at)
    }
  }
  return [...times].sort((a, b) => a - b)
}

export type AnimationValidationResult = { valid: true } | { valid: false; errors: string[] }

const ID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9_-]*$/
const ANIMATION_KINDS: readonly string[] = ['transition', 'ambient', 'interaction']
const DURATION_LIMITS = { min: 1, max: 60_000 } as const
const RANDOM_DELAY_LIMITS = { min: 0, max: 600_000 } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateKeyframe(keyframe: unknown, where: string, errors: string[]): void {
  if (!isRecord(keyframe)) {
    errors.push(`${where}: keyframe must be an object`)
    return
  }
  if (!isFiniteNumber(keyframe.at) || keyframe.at < 0 || keyframe.at > 1) {
    errors.push(`${where}: "at" must be a number in 0..1`)
  }
  if (!isFiniteNumber(keyframe.value) && !isParameterizedValue(keyframe.value)) {
    errors.push(`${where}: "value" must be a number or a ParameterizedValue`)
  }
  if (keyframe.easing !== undefined) {
    if (typeof keyframe.easing !== 'string' || parseEasing(keyframe.easing) === null) {
      errors.push(`${where}: unknown easing ${JSON.stringify(keyframe.easing)}`)
    }
  }
}

function validateRepeat(repeat: unknown, errors: string[]): void {
  if (!isRecord(repeat) || typeof repeat.mode !== 'string') {
    errors.push('"repeat" must be one of once / loop / alternate / random-interval')
    return
  }
  if (repeat.mode === 'once' || repeat.mode === 'loop' || repeat.mode === 'alternate') return
  if (repeat.mode === 'random-interval') {
    const { minDelayMs, maxDelayMs } = repeat
    if (
      !isFiniteNumber(minDelayMs) ||
      !isFiniteNumber(maxDelayMs) ||
      minDelayMs < RANDOM_DELAY_LIMITS.min ||
      maxDelayMs > RANDOM_DELAY_LIMITS.max ||
      minDelayMs > maxDelayMs
    ) {
      errors.push('"repeat.random-interval" requires 0 <= minDelayMs <= maxDelayMs <= 600000')
    }
    return
  }
  errors.push(`unknown repeat mode ${JSON.stringify(repeat.mode)}`)
}

/**
 * Easing view of one track after the compiler's §8.4 normalization (sort +
 * endpoint completion; synthetic endpoints are linear). Returns null when no
 * usable keyframe exists — such tracks are already reported elsewhere.
 */
function normalizedEasingTimeline(keyframes: unknown[]): EasingTimeline | null {
  const usable = keyframes.filter(
    (keyframe): keyframe is MotionKeyframe =>
      isRecord(keyframe) && isFiniteNumber(keyframe.at) && keyframe.at >= 0 && keyframe.at <= 1,
  )
  if (usable.length === 0) return null
  const sorted = [...usable].sort((a, b) => a.at - b.at)
  const normalized = sorted.map((keyframe) => ({ at: keyframe.at, easingCss: resolveEasingCss(keyframe.easing) }))
  if (normalized[0].at > 0) normalized.unshift({ at: 0, easingCss: 'linear' })
  const last = normalized[normalized.length - 1]
  if (last.at < 1) normalized.push({ at: 1, easingCss: 'linear' })
  return { keyframes: normalized }
}

/**
 * V1: tracks sharing a target layer merge into ONE WAAPI keyframe list, so a
 * single easing per keyframe has to serve all of them (the compiler takes the
 * first track's). Reject definitions whose same-layer tracks disagree on the
 * easing in force at any interval start — the runtime cannot honor both.
 */
function validateLayerEasingConsistency(
  layerTracks: Map<MotionLayer, Array<{ property: MotionProperty; timeline: EasingTimeline }>>,
  errors: string[],
): void {
  for (const [layer, tracks] of layerTracks) {
    if (tracks.length < 2) continue
    const times = unionTrackTimes(0, 1, tracks.map((track) => track.timeline))
    for (const time of times.slice(0, -1)) {
      const easings = tracks.map((track) => ({ property: track.property, easing: easingAt(track.timeline, time) }))
      if (new Set(easings.map((entry) => entry.easing)).size <= 1) continue
      const detail = easings.map((entry) => `${entry.property}=${entry.easing}`).join(', ')
      errors.push(`tracks on layer "${layer}" must share one easing per interval; mismatch at t=${time}: ${detail}`)
    }
  }
}

/**
 * Hand-written schema validation (spec §8.11: the compiler must not accept
 * illegal definitions). Collects all problems instead of failing fast.
 */
export function validateAnimationDefinition(definition: unknown): AnimationValidationResult {
  const errors: string[] = []
  if (!isRecord(definition)) {
    return { valid: false, errors: ['definition must be an object'] }
  }

  if (definition.version !== 1) errors.push('"version" must be 1')
  if (typeof definition.id !== 'string' || !ID_RE.test(definition.id)) {
    errors.push('"id" must match "<namespace>:<name>", e.g. builtin:comic-pop or user:<uuid>')
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    errors.push('"name" must be a non-empty string')
  }
  if (typeof definition.kind !== 'string' || !ANIMATION_KINDS.includes(definition.kind)) {
    errors.push('"kind" must be transition | ambient | interaction')
  }
  if (
    !isFiniteNumber(definition.durationMs) ||
    definition.durationMs < DURATION_LIMITS.min ||
    definition.durationMs > DURATION_LIMITS.max
  ) {
    errors.push(`"durationMs" must be ${DURATION_LIMITS.min}..${DURATION_LIMITS.max}`)
  }
  validateRepeat(definition.repeat, errors)

  const seenProperties = new Set<MotionProperty>()
  const layerTracks = new Map<MotionLayer, Array<{ property: MotionProperty; timeline: EasingTimeline }>>()

  if (!Array.isArray(definition.tracks)) {
    errors.push('"tracks" must be an array')
  } else {
    definition.tracks.forEach((track, trackIndex) => {
      const where = `tracks[${trackIndex}]`
      if (!isRecord(track)) {
        errors.push(`${where}: track must be an object`)
        return
      }
      const property: unknown = track.property
      let validProperty: MotionProperty | null = null
      if (!isMotionProperty(property)) {
        errors.push(`${where}: unknown motion property ${JSON.stringify(property)}`)
      } else if (seenProperties.has(property)) {
        // The compiler's per-layer lookup takes the first match — a second
        // track for the same property would be dead, ambiguous data.
        errors.push(`${where}: duplicate track for ${JSON.stringify(property)}`)
      } else {
        seenProperties.add(property)
        validProperty = property
      }
      if (!Array.isArray(track.keyframes) || track.keyframes.length === 0) {
        errors.push(`${where}: a track needs at least 1 keyframe`)
      } else {
        track.keyframes.forEach((keyframe, keyframeIndex) =>
          validateKeyframe(keyframe, `${where}.keyframes[${keyframeIndex}]`, errors),
        )
        if (validProperty !== null) {
          const timeline = normalizedEasingTimeline(track.keyframes)
          if (timeline !== null) {
            const layer = MOTION_PROPERTIES[validProperty].targetLayer
            const list = layerTracks.get(layer) ?? []
            list.push({ property: validProperty, timeline })
            layerTracks.set(layer, list)
          }
        }
      }
    })
    validateLayerEasingConsistency(layerTracks, errors)
  }

  if (definition.events !== undefined) {
    if (!Array.isArray(definition.events)) {
      errors.push('"events" must be an array')
    } else {
      definition.events.forEach((event, eventIndex) => {
        const where = `events[${eventIndex}]`
        if (!isRecord(event)) {
          errors.push(`${where}: event must be an object`)
          return
        }
        if (event.type !== 'pose-swap' && event.type !== 'particle') {
          errors.push(`${where}: unknown event type ${JSON.stringify(event.type)} (expected "pose-swap" or "particle")`)
        }
        if (event.type === 'particle' && !PARTICLE_EFFECT_IDS.includes(event.effect as ParticleEffectId)) {
          errors.push(`${where}: unknown particle effect ${JSON.stringify(event.effect)}`)
        }
        if (!isFiniteNumber(event.at) || event.at < 0 || event.at > 1) {
          errors.push(`${where}: "at" must be a number in 0..1`)
        }
      })
    }
  }

  // V1 event cardinality (§8.5/§8.10): a transition swaps the pose exactly
  // once and may burst particles; an interaction never swaps but may burst;
  // ambient timelines stay eventless.
  const events = Array.isArray(definition.events) ? definition.events : []
  const poseSwapCount = events.filter((event) => isRecord(event) && event.type === 'pose-swap').length
  if (definition.kind === 'transition' && poseSwapCount !== 1) {
    errors.push(`a transition needs exactly 1 pose-swap event, got ${poseSwapCount}`)
  }
  if (definition.kind === 'interaction' && poseSwapCount > 0) {
    errors.push('"interaction" definitions must not declare pose-swap events (V1)')
  }
  if (definition.kind === 'ambient' && events.length > 0) {
    errors.push('"ambient" definitions must not declare events (V1)')
  }
  // The scheduler replays eventful timelines forward; only eventless
  // alternate maps to WAAPI direction 'alternate' (§8.6/§8.12).
  if (isRecord(definition.repeat) && definition.repeat.mode === 'alternate' && events.length > 0) {
    errors.push('repeat "alternate" with events is not supported (V1 replays eventful timelines forward)')
  }

  if (definition.parameters !== undefined) {
    if (!isRecord(definition.parameters)) {
      errors.push('"parameters" must be an object')
    } else if (definition.parameters.strength !== undefined) {
      const strength = definition.parameters.strength
      if (
        !isRecord(strength) ||
        !isFiniteNumber(strength.default) ||
        !isFiniteNumber(strength.min) ||
        !isFiniteNumber(strength.max) ||
        strength.min > strength.max ||
        strength.default < strength.min ||
        strength.default > strength.max
      ) {
        errors.push('"parameters.strength" requires min <= default <= max')
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

/** Throwing variant used by registry/compiler. */
export function assertValidAnimationDefinition(definition: unknown): asserts definition is AnimationDefinition {
  const result = validateAnimationDefinition(definition)
  if (!result.valid) {
    const id = isRecord(definition) && typeof definition.id === 'string' ? definition.id : '<unknown>'
    throw new Error(`invalid AnimationDefinition "${id}":\n- ${result.errors.join('\n- ')}`)
  }
}
