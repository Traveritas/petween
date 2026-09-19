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

/**
 * V1.2 target snapping (game-engine feel): the raw time first rounds to the
 * adaptive grid (like snapAt, but the grid follows zoom), then any snap
 * TARGET — another keyframe/event time or the playhead — wins when it sits
 * within `threshold` normalized units. Disabled passes the raw clamped time
 * through (the Alt-hold escape hatch).
 */
export interface SnapOptions {
  enabled: boolean
  /** Adaptive grid step in normalized units (see adaptiveGridStep). */
  grid: number
  /** Snap candidates in normalized units (other frames, events, playhead). */
  targets: readonly number[]
  /** Capture radius in normalized units (~px / lane width). */
  threshold: number
}

export function snapAtWithTargets(at: number, options: SnapOptions): number {
  const clamped = clamp(at, 0, 1)
  if (!options.enabled) return clamped
  const steps = Math.max(1, Math.round(1 / options.grid))
  const gridRounded = clamp(Math.round(clamped * steps) / steps, 0, 1)
  let best = gridRounded
  let bestDistance = Math.abs(clamped - gridRounded)
  for (const target of options.targets) {
    const distance = Math.abs(clamped - target)
    if (distance <= options.threshold && distance < bestDistance) {
      best = clamp(target, 0, 1)
      bestDistance = distance
    }
  }
  return roundValue(best)
}

/** 1-2-5 nice steps keep ruler labels readable at every zoom (ms units). */
const NICE_STEPS_MS = [1, 2, 5]

/**
 * The adaptive ruler/grid step for a zoomed lane: the smallest 1/2/5×10^k ms
 * step whose on-screen size stays >= minStepPx, so ticks never crowd
 * together while zooming. Returns the step in ms plus its normalized size.
 */
export function adaptiveGridStep(durationMs: number, laneWidthPx: number, zoom: number, minStepPx = 44): { stepMs: number; grid: number } {
  const pxPerMs = (laneWidthPx * zoom) / Math.max(1, durationMs)
  const minStepMs = Math.max(1, Math.ceil(minStepPx / Math.max(pxPerMs, Number.EPSILON)))
  const magnitude = 10 ** Math.floor(Math.log10(minStepMs))
  let stepMs = 10 * magnitude // minStepMs above every 1/2/5 of this magnitude → next decade's 1×
  for (const nice of NICE_STEPS_MS) {
    const candidate = nice * magnitude
    if (candidate >= minStepMs) {
      stepMs = candidate
      break
    }
  }
  return { stepMs, grid: clamp(stepMs / Math.max(1, durationMs), 0.001, 1) }
}

/** Format a tick label in engine style: seconds past 1000ms (nice 1/2/5 steps
 *  keep ≤1 decimal), ms below, bare zero. */
export function formatTickMs(ms: number): string {
  if (ms === 0) return '0'
  if (ms >= 1000 && ms % 100 === 0) {
    const seconds = Math.round(ms / 100) / 10 // ≤1 decimal for 1-2-5 steps
    return `${seconds}s`
  }
  return `${Math.round(ms)}ms`
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

export function addPoseSwapEvent(events: TimelineEvent[], at = 0.5, pose?: string): EventEdit {
  // An interaction pose-swap must name its target (schema); the editor
  // defaults to the idle slot so a freshly added event stays valid — the
  // inspector lets the author change it (builtin slot or user: pose id).
  const event: TimelineEvent =
    pose === undefined ? { at: snapAt(at), type: 'pose-swap' } : { at: snapAt(at), type: 'pose-swap', pose }
  return { events: [...events, event], index: events.length }
}

/** Set/replace/clear the pose target of a pose-swap event (interaction authoring). */
export function setEventPose(events: TimelineEvent[], eventIndex: number, pose: string | undefined): TimelineEvent[] {
  return events.map((event, index) => {
    if (index !== eventIndex || event.type !== 'pose-swap') return event
    return pose === undefined || pose === '' ? { at: event.at, type: 'pose-swap' } : { ...event, pose }
  })
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

// --- V1.2 Phase 13: multi-selection batch operations (pure) ----------------

/**
 * Selection identity across renders: string keys, not object references.
 * `keyframe:<trackIndex>:<keyframeIndex>` / `event:<eventIndex>`.
 */
export type SelectionKey = string

export function keyframeKey(trackIndex: number, keyframeIndex: number): SelectionKey {
  return `keyframe:${trackIndex}:${keyframeIndex}`
}

export function eventKey(eventIndex: number): SelectionKey {
  return `event:${eventIndex}`
}

export type ParsedSelection =
  | { kind: 'keyframe'; trackIndex: number; keyframeIndex: number }
  | { kind: 'event'; eventIndex: number }

export function parseSelectionKey(key: SelectionKey): ParsedSelection | null {
  const parts = key.split(':')
  if (parts.length !== 3 && parts.length !== 2) return null
  if (parts[0] === 'keyframe' && parts.length === 3) {
    const trackIndex = Number(parts[1])
    const keyframeIndex = Number(parts[2])
    if (!Number.isInteger(trackIndex) || !Number.isInteger(keyframeIndex)) return null
    return { kind: 'keyframe', trackIndex, keyframeIndex }
  }
  if (parts[0] === 'event' && parts.length === 2) {
    const eventIndex = Number(parts[1])
    if (!Number.isInteger(eventIndex)) return null
    return { kind: 'event', eventIndex }
  }
  return null
}

/**
 * Batch-move the whole selection by the anchor's (already snapped) step:
 * every selected keyframe/event shifts by `delta` from its CURRENT time
 * (per-tick application makes a drag cumulative — no gesture-start snapshot
 * needed), clamped to 0..1 on the 0.01 grid. Collisions drop silently (the
 * colliding frame stays put rather than merging — same discipline as single
 * moves). Non-selected frames never move.
 */
export function moveSelectionBatch(
  tracks: MotionTrack[],
  events: TimelineEvent[],
  selection: ReadonlySet<SelectionKey>,
  delta: number,
): { tracks: MotionTrack[]; events: TimelineEvent[] } {
  if (selection.size === 0 || delta === 0) return { tracks, events }
  const selectedKeyframes = new Map<number, Set<number>>() // trackIndex -> keyframe indices
  const selectedEvents = new Set<number>()
  for (const key of selection) {
    const parsed = parseSelectionKey(key)
    if (parsed === null) continue
    if (parsed.kind === 'keyframe') {
      const indices = selectedKeyframes.get(parsed.trackIndex) ?? new Set<number>()
      indices.add(parsed.keyframeIndex)
      selectedKeyframes.set(parsed.trackIndex, indices)
    } else {
      selectedEvents.add(parsed.eventIndex)
    }
  }

  const nextTracks = tracks.map((track, trackIndex) => {
    const indices = selectedKeyframes.get(trackIndex)
    if (indices === undefined) return track
    // Occupancy after the move decides collisions: build the target times
    // first, then keep unselected frames and non-colliding moves.
    const targets = track.keyframes.map((keyframe, index) =>
      indices.has(index) ? snapAt(keyframe.at + delta) : keyframe.at,
    )
    const kept: number[] = [] // indices whose move survives
    for (const index of indices) {
      const target = targets[index]
      const clash = track.keyframes.some(
        (keyframe, other) => !indices.has(other) && snapAt(keyframe.at) === target,
      )
      const internalClash = kept.some((keptIndex) => targets[keptIndex] === target)
      if (!clash && !internalClash) kept.push(index)
    }
    return {
      ...track,
      keyframes: track.keyframes.map((keyframe, index) =>
        kept.includes(index) ? { ...keyframe, at: targets[index] } : keyframe,
      ),
    }
  })

  const nextEvents = events.map((event, index) =>
    selectedEvents.has(index) ? { ...event, at: snapAt(event.at + delta) } : event,
  )

  return { tracks: nextTracks, events: nextEvents }
}

/** Default offset for duplicated keyframes (one half grid step region). */
export const DUPLICATE_OFFSET = 0.05

/**
 * Duplicate every selected keyframe at `at + 0.05` (clamped/snapped; occupied
 * slots are skipped silently). Events are not duplicated. Returns the new
 * tracks and the copies' selection keys (the copies become the selection).
 */
export function duplicateSelectedKeyframes(
  tracks: MotionTrack[],
  selection: ReadonlySet<SelectionKey>,
): { tracks: MotionTrack[]; selection: SelectionKey[] } {
  const byTrack = new Map<number, Set<number>>()
  for (const key of selection) {
    const parsed = parseSelectionKey(key)
    if (parsed === null || parsed.kind !== 'keyframe') continue
    const indices = byTrack.get(parsed.trackIndex) ?? new Set<number>()
    indices.add(parsed.keyframeIndex)
    byTrack.set(parsed.trackIndex, indices)
  }

  const createdKeys: SelectionKey[] = []
  const nextTracks = tracks.map((track, trackIndex) => {
    const indices = byTrack.get(trackIndex)
    if (indices === undefined) return track
    const occupied = new Set(track.keyframes.map((keyframe) => snapAt(keyframe.at)))
    const additions: Array<{ at: number; keyframe: MotionKeyframe }> = []
    for (const index of indices) {
      const source = track.keyframes[index]
      if (source === undefined) continue
      const target = snapAt(Math.min(1, source.at + DUPLICATE_OFFSET))
      if (occupied.has(target)) continue
      occupied.add(target)
      additions.push({
        at: target,
        keyframe: { ...structuredClone(source), at: target },
      })
    }
    if (additions.length === 0) return track
    const merged = [...track.keyframes, ...additions.map((addition) => addition.keyframe)].sort(
      (a, b) => a.at - b.at,
    )
    // Selection keys must reference the POST-merge indices (object identity:
    // an at-bearing lookup would misfire on same-at neighbors).
    for (const addition of additions) {
      const mergedIndex = merged.indexOf(addition.keyframe)
      if (mergedIndex >= 0) createdKeys.push(keyframeKey(trackIndex, mergedIndex))
    }
    return { ...track, keyframes: merged }
  })

  return { tracks: nextTracks, selection: createdKeys }
}
