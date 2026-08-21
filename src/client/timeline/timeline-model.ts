/**
 * client/timeline/timeline-model.ts — the pure editing operations behind the
 * visual timeline editor (V1.1 P1). Every helper takes the current
 * tracks/events and returns new ones (nothing mutates in place), so the
 * React components stay a thin controlled wrapper.
 *
 * Invariants the operations preserve (the schema validator still has the
 * final say — see validateTimelineDraft):
 * - keyframe/event times clamp to 0..1 and snap to a 0.01 grid;
 * - a track never holds two keyframes at the same time (drops onto a sibling
 *   are rejected — no silent merges);
 * - same-layer tracks keep one easing per interval (V1 rule): easing edits
 *   propagate across the layer over the governed interval, and inserted
 *   keyframes (lane clicks, new tracks, sync inserts) inherit the easing in
 *   force at their time so a valid draft stays valid.
 */
import type {
  AnimationKind,
  MotionEasing,
  MotionKeyframe,
  MotionTrack,
  ParticleEffectId,
  TimelineEvent,
} from '../../motion/animation-definition'
import { parseEasing, validateAnimationDefinition } from '../../motion/animation-definition'
import { clamp, createCubicBezier, lerp, resolveParameterizedValue } from '../../motion/math'
import { MOTION_PROPERTIES, type MotionProperty } from '../../motion/motion-properties'

/** Keyframe/event times snap to a 0.01 grid on the normalized 0..1 axis. */
export function snapAt(at: number): number {
  // *100/100 (not */0.01*0.01): keeps grid values free of FP noise
  return clamp(Math.round(at * 100) / 100, 0, 1)
}

/** Keep edited numbers readable (and JSON diffs stable). */
export function roundValue(value: number): number {
  return Math.round(value * 10000) / 10000
}

function clampToProperty(property: MotionProperty, value: number): number {
  const descriptor = MOTION_PROPERTIES[property]
  return clamp(value, descriptor.min ?? -Infinity, descriptor.max ?? Infinity)
}

const LINEAR_POINTS = [0, 0, 1, 1] as const

/**
 * Easing-aware sample of a track at `at` with strength fixed at 1 — mirrors
 * the compiler's sampleTrack, so a keyframe created mid-segment starts with
 * the value the curve already has there (click-insert is curve-preserving).
 */
export function sampleTrackValue(track: MotionTrack, at: number): number {
  const keyframes = [...track.keyframes].sort((a, b) => a.at - b.at)
  if (keyframes.length === 0) return MOTION_PROPERTIES[track.property].defaultValue
  const evaluate = (keyframe: MotionKeyframe): number =>
    clampToProperty(track.property, resolveParameterizedValue(keyframe.value, { strength: 1 }))
  if (at <= keyframes[0].at) return roundValue(evaluate(keyframes[0]))
  const last = keyframes[keyframes.length - 1]
  if (at >= last.at) return roundValue(evaluate(last))
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index]
    const to = keyframes[index + 1]
    if (at > from.at && at < to.at) {
      const points = (from.easing === undefined ? null : parseEasing(from.easing)) ?? LINEAR_POINTS
      const eased = createCubicBezier(points)((at - from.at) / (to.at - from.at))
      return roundValue(clampToProperty(track.property, lerp(evaluate(from), evaluate(to), eased)))
    }
  }
  return roundValue(evaluate(last))
}

/**
 * The easing in force on a track at `at`: the exact keyframe's when present,
 * else the governing (previous) keyframe's, else undefined (= linear) — the
 * same reading the validator's easingAt makes on the normalized timeline.
 */
export function easingInForceAt(track: MotionTrack, at: number): MotionEasing | undefined {
  const sorted = [...track.keyframes].sort((a, b) => a.at - b.at)
  const exact = sorted.find((keyframe) => keyframe.at === at)
  if (exact !== undefined) return exact.easing
  let governing: MotionKeyframe | undefined
  for (const keyframe of sorted) {
    if (keyframe.at >= at) break
    governing = keyframe
  }
  return governing?.easing
}

export interface KeyframeEdit {
  track: MotionTrack
  index: number
  created: boolean
}

/**
 * Lane click: create a keyframe at the (snapped) time with the sampled curve
 * value; an existing keyframe at that exact time is reported without creating
 * a duplicate (the caller selects it). The new keyframe inherits the easing
 * in force on its track, which — given a previously valid draft — keeps the
 * layer's per-interval easing consistent.
 */
export function addKeyframe(track: MotionTrack, at: number): KeyframeEdit {
  const snapped = snapAt(at)
  const existing = track.keyframes.findIndex((keyframe) => keyframe.at === snapped)
  if (existing !== -1) return { track, index: existing, created: false }
  const easing = easingInForceAt(track, snapped)
  const keyframe: MotionKeyframe = {
    at: snapped,
    value: sampleTrackValue(track, snapped),
    ...(easing === undefined ? {} : { easing }),
  }
  return { track: { ...track, keyframes: [...track.keyframes, keyframe] }, index: track.keyframes.length, created: true }
}

export interface MoveEdit {
  track: MotionTrack
  moved: boolean
}

/**
 * Drag/inspector retime: clamp + snap; a drop exactly onto a sibling keyframe
 * is rejected (moved: false), so the diamond stays at its last legal grid
 * slot instead of merging — simple and lossless.
 */
export function moveKeyframe(track: MotionTrack, keyframeIndex: number, at: number): MoveEdit {
  const snapped = snapAt(at)
  const keyframe = track.keyframes[keyframeIndex]
  if (keyframe === undefined || keyframe.at === snapped) return { track, moved: false }
  if (track.keyframes.some((sibling, index) => index !== keyframeIndex && sibling.at === snapped)) {
    return { track, moved: false }
  }
  const keyframes = track.keyframes.map((sibling, index) =>
    index === keyframeIndex ? { ...sibling, at: snapped } : sibling,
  )
  return { track: { ...track, keyframes }, moved: true }
}

export function removeKeyframe(track: MotionTrack, keyframeIndex: number): MotionTrack {
  return { ...track, keyframes: track.keyframes.filter((_, index) => index !== keyframeIndex) }
}

export function setKeyframeValue(
  track: MotionTrack,
  keyframeIndex: number,
  value: MotionKeyframe['value'],
): MotionTrack {
  return {
    ...track,
    keyframes: track.keyframes.map((keyframe, index) => (index === keyframeIndex ? { ...keyframe, value } : keyframe)),
  }
}

function withEasing(keyframe: MotionKeyframe, easing: MotionEasing | undefined): MotionKeyframe {
  return easing === undefined ? { at: keyframe.at, value: keyframe.value } : { at: keyframe.at, value: keyframe.value, easing }
}

/**
 * Easing edits are layer-scoped: V1 merges same-layer tracks into one WAAPI
 * keyframe list, so the validator requires one easing per interval across
 * them. Changing one keyframe therefore syncs every same-layer track over the
 * interval [at, next) the keyframe governs:
 * - a track missing a keyframe at `at` gets one inserted (value sampled off
 *   its own curve, so the shape is preserved) carrying the new easing;
 * - keyframes inside the interval adopt the new easing;
 * - a "resume" keyframe is inserted at the interval end (sampled value,
 *   previous easing) so the sync does not leak past it.
 * Moving or deleting keyframes can still desync a layer — the residue is
 * flagged by the validator and shown inline rather than silently repaired.
 */
export function setKeyframeEasing(
  tracks: MotionTrack[],
  trackIndex: number,
  keyframeIndex: number,
  easing: MotionEasing | undefined,
): MotionTrack[] {
  const source = tracks[trackIndex]
  const keyframe = source.keyframes[keyframeIndex]
  const layer = MOTION_PROPERTIES[source.property].targetLayer
  const start = keyframe.at
  const end =
    source.keyframes
      .map((sibling) => sibling.at)
      .filter((at) => at > start)
      .sort((a, b) => a - b)[0] ?? 1
  return tracks.map((track, index) => {
    if (MOTION_PROPERTIES[track.property].targetLayer !== layer) return track
    if (index === trackIndex) {
      return {
        ...track,
        keyframes: track.keyframes.map((sibling, siblingIndex) =>
          siblingIndex === keyframeIndex ? withEasing(sibling, easing) : sibling,
        ),
      }
    }
    const keyframes: MotionKeyframe[] = track.keyframes.map((sibling) =>
      sibling.at >= start && sibling.at < end ? withEasing(sibling, easing) : { ...sibling },
    )
    // Easing at the final point governs no interval — nothing to sync at 1.
    if (start < 1 && !keyframes.some((sibling) => sibling.at === start)) {
      keyframes.push({ at: start, value: sampleTrackValue(track, start), ...(easing === undefined ? {} : { easing }) })
    }
    if (end < 1 && !keyframes.some((sibling) => sibling.at === end)) {
      const resume = easingInForceAt(track, end)
      keyframes.push({ at: end, value: sampleTrackValue(track, end), ...(resume === undefined ? {} : { easing: resume }) })
    }
    keyframes.sort((a, b) => a.at - b.at)
    return { ...track, keyframes }
  })
}

export interface TrackEdit {
  tracks: MotionTrack[]
  index: number
}

/**
 * New track seeded with no-op keyframes at the property default. When the
 * target layer already has tracks the seed mirrors the layer's keyframe
 * times and per-interval easings, so the layer stays consistent (V1 rule)
 * and the draft remains valid.
 */
export function addTrack(tracks: MotionTrack[], property: MotionProperty): TrackEdit {
  const descriptor = MOTION_PROPERTIES[property]
  const layerTracks = tracks.filter(
    (track) => MOTION_PROPERTIES[track.property].targetLayer === descriptor.targetLayer,
  )
  let keyframes: MotionKeyframe[]
  if (layerTracks.length === 0) {
    keyframes = [
      { at: 0, value: descriptor.defaultValue },
      { at: 1, value: descriptor.defaultValue },
    ]
  } else {
    const times = new Set<number>([0, 1])
    for (const track of layerTracks) {
      for (const keyframe of track.keyframes) times.add(keyframe.at)
    }
    keyframes = [...times].sort((a, b) => a - b).map((at) => {
      const easing = easingInForceAt(layerTracks[0], at)
      return { at, value: descriptor.defaultValue, ...(easing === undefined ? {} : { easing }) }
    })
  }
  return { tracks: [...tracks, { property, keyframes }], index: tracks.length }
}

export function removeTrack(tracks: MotionTrack[], trackIndex: number): MotionTrack[] {
  return tracks.filter((_, index) => index !== trackIndex)
}

export function moveEvent(events: TimelineEvent[], eventIndex: number, at: number): TimelineEvent[] {
  return events.map((event, index) => (index === eventIndex ? { ...event, at: snapAt(at) } : event))
}

export function setParticleEffect(
  events: TimelineEvent[],
  eventIndex: number,
  effect: ParticleEffectId,
): TimelineEvent[] {
  return events.map((event, index) =>
    index === eventIndex && event.type === 'particle' ? { ...event, effect } : event,
  )
}

export function removeEvent(events: TimelineEvent[], eventIndex: number): TimelineEvent[] {
  return events.filter((_, index) => index !== eventIndex)
}

export interface EventEdit {
  events: TimelineEvent[]
  index: number
}

export function addParticleEvent(events: TimelineEvent[], effect: ParticleEffectId, at = 0.5): EventEdit {
  return { events: [...events, { at: snapAt(at), type: 'particle', effect }], index: events.length }
}

export function addPoseSwapEvent(events: TimelineEvent[], at = 0.5): EventEdit {
  return { events: [...events, { at: snapAt(at), type: 'pose-swap' }], index: events.length }
}

/**
 * The editor owns only kind/tracks/events, so validation runs on a synthetic
 * definition whose scalar fields are known-valid — every reported error
 * therefore concerns the timeline itself. An extra editor-level rule
 * requires at least one track (the schema tolerates an empty array, but an
 * empty animation is never a useful save).
 */
export function validateTimelineDraft(
  kind: AnimationKind,
  tracks: MotionTrack[],
  events: TimelineEvent[],
): string[] {
  const errors: string[] = []
  if (tracks.length === 0) errors.push('至少需要一条轨道')
  const result = validateAnimationDefinition({
    version: 1,
    id: 'user:timeline-editor',
    name: '时间轴草稿',
    kind,
    durationMs: 300,
    repeat: { mode: 'once' },
    tracks,
    events,
  })
  if (!result.valid) errors.push(...result.errors)
  return errors
}
