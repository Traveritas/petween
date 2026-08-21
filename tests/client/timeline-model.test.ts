/**
 * Timeline model tests (V1.1 P1): the pure editing operations behind the
 * visual editor — time snapping, easing-aware sampling, keyframe add/move
 * (dup rejection), the same-layer easing sync (V1 rule), track seeding and
 * event ops — plus the validateTimelineDraft wrapper the components gate on.
 */
import { describe, expect, it } from 'vitest'
import type { MotionTrack, TimelineEvent } from '../../src/motion/animation-definition'
import {
  addKeyframe,
  addParticleEvent,
  addPoseSwapEvent,
  addTrack,
  easingInForceAt,
  moveEvent,
  moveKeyframe,
  removeEvent,
  removeKeyframe,
  removeTrack,
  sampleTrackValue,
  setKeyframeEasing,
  setKeyframeValue,
  setParticleEffect,
  snapAt,
  validateTimelineDraft,
} from '../../src/client/timeline/timeline-model'

const scaleY = (keyframes: MotionTrack['keyframes']): MotionTrack => ({ property: 'transition.scaleY', keyframes })
const scaleX = (keyframes: MotionTrack['keyframes']): MotionTrack => ({ property: 'transition.scaleX', keyframes })
const bounceY = (keyframes: MotionTrack['keyframes']): MotionTrack => ({ property: 'bounce.y', keyframes })

/** Mirrored two-track transition layer, valid with one pose-swap. */
const duoTracks = (): MotionTrack[] => [
  scaleY([
    { at: 0, value: 1, easing: 'ease-in' },
    { at: 0.5, value: 0.8, easing: 'ease-out' },
    { at: 1, value: 1 },
  ]),
  scaleX([
    { at: 0, value: 1, easing: 'ease-in' },
    { at: 0.5, value: 1.2, easing: 'ease-out' },
    { at: 1, value: 1 },
  ]),
]
const poseSwap: TimelineEvent[] = [{ at: 0.5, type: 'pose-swap' }]

describe('timeline-model — snap and sampling', () => {
  it('snapAt clamps to 0..1 and snaps to the 0.01 grid', () => {
    expect(snapAt(0.457)).toBe(0.46)
    expect(snapAt(0.452)).toBe(0.45)
    expect(snapAt(-0.2)).toBe(0)
    expect(snapAt(1.3)).toBe(1)
    expect(snapAt(0)).toBe(0)
    expect(snapAt(1)).toBe(1)
  })

  it('sampleTrackValue mirrors the compiler: endpoints, linear, easing-aware, strength=1', () => {
    const empty = scaleY([])
    expect(sampleTrackValue(empty, 0.5)).toBe(1) // property default

    const linear = scaleY([
      { at: 0, value: 1 },
      { at: 1, value: 2 },
    ])
    expect(sampleTrackValue(linear, 0)).toBe(1)
    expect(sampleTrackValue(linear, 1)).toBe(2)
    expect(sampleTrackValue(linear, 0.45)).toBe(1.45)
    expect(sampleTrackValue(linear, -1)).toBe(1)
    expect(sampleTrackValue(linear, 2)).toBe(2)

    const eased = scaleY([
      { at: 0, value: 0, easing: 'ease-in' },
      { at: 1, value: 2 },
    ])
    const midpoint = sampleTrackValue(eased, 0.5)
    expect(midpoint).toBeGreaterThan(0)
    expect(midpoint).toBeLessThan(1) // ease-in runs behind the linear 1.0

    const parameterized = scaleY([
      { at: 0, value: { base: 1, parameter: 'strength', amount: -0.25 } },
      { at: 1, value: 1 },
    ])
    expect(sampleTrackValue(parameterized, 0)).toBe(0.75) // strength fixed at 1

    const clamped = sampleTrackValue(
      { property: 'transition.opacity', keyframes: [{ at: 0, value: 0 }, { at: 1, value: 5 }] },
      1,
    )
    expect(clamped).toBe(1) // clamped to the property max
  })

  it('easingInForceAt reads exact, governing and default (linear) easings', () => {
    const track = scaleY([
      { at: 0.2, value: 1, easing: 'ease-in' },
      { at: 0.6, value: 0.8 },
    ])
    expect(easingInForceAt(track, 0.6)).toBeUndefined() // exact keyframe, no easing
    expect(easingInForceAt(track, 0.5)).toBe('ease-in') // governed by the 0.2 keyframe
    expect(easingInForceAt(track, 0.1)).toBeUndefined() // before the first keyframe
  })
})

describe('timeline-model — keyframe ops', () => {
  it('addKeyframe inserts a snapped, curve-sampled keyframe inheriting the governing easing', () => {
    const track = scaleY([
      { at: 0, value: 1, easing: 'ease-in' },
      { at: 1, value: 2 },
    ])
    const edit = addKeyframe(track, 0.502)
    expect(edit.created).toBe(true)
    expect(edit.index).toBe(2)
    const inserted = edit.track.keyframes[2]
    expect(inserted.at).toBe(0.5)
    expect(inserted.easing).toBe('ease-in')
    expect(inserted.value).toBeLessThan(1.5) // behind the linear midpoint
    expect(inserted.value).toBeGreaterThan(1)
    expect(track.keyframes).toHaveLength(2) // input untouched
  })

  it('addKeyframe on an occupied time reports the existing keyframe instead', () => {
    const track = scaleY([
      { at: 0, value: 1 },
      { at: 0.5, value: 0.8 },
    ])
    const edit = addKeyframe(track, 0.5)
    expect(edit.created).toBe(false)
    expect(edit.index).toBe(1)
    expect(edit.track).toBe(track)
  })

  it('moveKeyframe snaps and rejects drops onto a sibling (no merge)', () => {
    const track = scaleY([
      { at: 0, value: 1 },
      { at: 0.5, value: 0.8 },
    ])
    const moved = moveKeyframe(track, 0, 0.312)
    expect(moved.moved).toBe(true)
    expect(moved.track.keyframes[0].at).toBe(0.31)

    const collision = moveKeyframe(track, 0, 0.5)
    expect(collision.moved).toBe(false)
    expect(collision.track).toBe(track)

    const noOp = moveKeyframe(track, 0, 0)
    expect(noOp.moved).toBe(false)
  })

  it('setKeyframeValue and removeKeyframe produce new track data', () => {
    const track = scaleY([
      { at: 0, value: 1 },
      { at: 1, value: 2 },
    ])
    const updated = setKeyframeValue(track, 1, { base: 1, parameter: 'strength', amount: 0.5 })
    expect(updated.keyframes[1].value).toEqual({ base: 1, parameter: 'strength', amount: 0.5 })
    expect(track.keyframes[1].value).toBe(2)

    const removed = removeKeyframe(updated, 0)
    expect(removed.keyframes).toHaveLength(1)
    expect(removed.keyframes[0].at).toBe(1)
  })
})

describe('timeline-model — same-layer easing sync (V1 rule)', () => {
  it('syncs the governed interval across mirrored tracks and stays valid', () => {
    const next = setKeyframeEasing(duoTracks(), 0, 1, 'overshoot') // scaleY @ 0.5
    expect(next[0].keyframes[1].easing).toBe('overshoot')
    expect(next[1].keyframes[1].easing).toBe('overshoot')
    // outside the interval (both keyframes at 0) untouched
    expect(next[0].keyframes[0].easing).toBe('ease-in')
    expect(next[1].keyframes[0].easing).toBe('ease-in')
    expect(validateTimelineDraft('transition', next, poseSwap)).toEqual([])
  })

  it('inserts a sampled keyframe into a sparse same-layer track and keeps the draft valid', () => {
    const tracks: MotionTrack[] = [
      scaleY([
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 0.5, value: 0.8, easing: 'ease-out' },
        { at: 1, value: 1 },
      ]),
      scaleX([
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 1, value: 1 },
      ]),
    ]
    const next = setKeyframeEasing(tracks, 0, 1, 'overshoot') // governs [0.5, 1)
    const synced = next[1]
    expect(synced.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 0.5, 1])
    const inserted = synced.keyframes[1]
    expect(inserted.easing).toBe('overshoot')
    expect(inserted.value).toBe(1) // sampled: scaleX is flat at 1 here
    expect(validateTimelineDraft('transition', next, poseSwap)).toEqual([])
  })

  it('adds a resume keyframe at the interval end so the sync does not leak past it', () => {
    // A sibling missing the interval-end time only arises from an already
    // desynced draft (valid layers mirror keyframe times); the resume
    // keyframe preserves the sibling's own curve past the edit instead of
    // stretching the new easing further. The validator reports the residue.
    const tracks: MotionTrack[] = [
      scaleY([
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 0.3, value: 0.8, easing: 'ease-out' },
        { at: 0.6, value: 1.1, easing: 'spring-soft' },
        { at: 1, value: 1 },
      ]),
      scaleX([
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 0.3, value: 1.1, easing: 'ease-out' },
        { at: 1, value: 1 },
      ]),
    ]
    const next = setKeyframeEasing(tracks, 0, 1, 'overshoot') // governs [0.3, 0.6)
    const synced = next[1]
    expect(synced.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 0.3, 0.6, 1])
    expect(synced.keyframes[1].easing).toBe('overshoot')
    // resume keyframe restores what governed past 0.6 before the edit
    expect(synced.keyframes[2].at).toBe(0.6)
    expect(synced.keyframes[2].easing).toBe('ease-out')
    // value sampled off its own eased curve (between the 0.3 and 1 values)
    expect(synced.keyframes[2].value).toBeGreaterThan(1)
    expect(synced.keyframes[2].value).toBeLessThan(1.1)
  })

  it('clears the easing key when set to undefined (linear) and leaves other layers alone', () => {
    const tracks = [...duoTracks(), bounceY([{ at: 0, value: 0, easing: 'ease-in' }, { at: 1, value: 0 }])]
    const next = setKeyframeEasing(tracks, 0, 1, undefined)
    expect('easing' in next[0].keyframes[1]).toBe(false)
    expect('easing' in next[1].keyframes[1]).toBe(false)
    expect(next[2]).toEqual(bounceY([{ at: 0, value: 0, easing: 'ease-in' }, { at: 1, value: 0 }]))
    expect(validateTimelineDraft('transition', next, poseSwap)).toEqual([])
  })

  it('does not insert sync keyframes for an edit on the final keyframe (no interval to govern)', () => {
    const next = setKeyframeEasing(duoTracks(), 0, 2, 'overshoot') // @ 1
    expect(next[0].keyframes[2].easing).toBe('overshoot')
    expect(next[1].keyframes).toHaveLength(3) // unchanged
  })
})

describe('timeline-model — track ops', () => {
  it('addTrack on an empty layer seeds two no-op keyframes at the property default', () => {
    const edit = addTrack([], 'bounce.y')
    expect(edit.index).toBe(0)
    expect(edit.tracks[0]).toEqual({
      property: 'bounce.y',
      keyframes: [
        { at: 0, value: 0 },
        { at: 1, value: 0 },
      ],
    })
  })

  it('addTrack on a busy layer mirrors keyframe times and per-interval easings (stays valid)', () => {
    const edit = addTrack(duoTracks(), 'transition.rotation')
    expect(edit.tracks[2]).toEqual({
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-in' },
        { at: 0.5, value: 0, easing: 'ease-out' },
        { at: 1, value: 0 },
      ],
    })
    expect(validateTimelineDraft('transition', edit.tracks, poseSwap)).toEqual([])
  })

  it('removeTrack drops the track by index', () => {
    expect(removeTrack(duoTracks(), 0).map((track) => track.property)).toEqual(['transition.scaleX'])
  })
})

describe('timeline-model — event ops', () => {
  it('moves, recolors, adds and removes events with snapped times', () => {
    const events: TimelineEvent[] = [{ at: 0.5, type: 'pose-swap' }]
    expect(moveEvent(events, 0, 0.457)[0].at).toBe(0.46)

    const added = addParticleEvent(events, 'confetti')
    expect(added.index).toBe(1)
    expect(added.events[1]).toEqual({ at: 0.5, type: 'particle', effect: 'confetti' })

    const recolored = setParticleEffect(added.events, 1, 'sparkle')
    expect(recolored[1]).toEqual({ at: 0.5, type: 'particle', effect: 'sparkle' })
    // setParticleEffect never touches a pose-swap
    expect(setParticleEffect(recolored, 0, 'sparkle')[0].type).toBe('pose-swap')

    expect(removeEvent(recolored, 1)).toEqual([{ at: 0.5, type: 'pose-swap' }])

    const swapped = addPoseSwapEvent([], 0.33)
    expect(swapped.events).toEqual([{ at: 0.33, type: 'pose-swap' }])
  })
})

describe('timeline-model — validateTimelineDraft', () => {
  it('accepts a well-formed draft of every kind', () => {
    expect(validateTimelineDraft('transition', duoTracks(), poseSwap)).toEqual([])
    expect(validateTimelineDraft('ambient', duoTracks(), [])).toEqual([])
    expect(validateTimelineDraft('interaction', duoTracks(), [{ at: 0.5, type: 'particle', effect: 'confetti' }])).toEqual([])
  })

  it('adds the editor-level "at least one track" error the schema does not have', () => {
    const errors = validateTimelineDraft('transition', [], poseSwap)
    expect(errors).toContain('至少需要一条轨道')
  })

  it('passes schema errors through: pose-swap cardinality, kind rules, layer easing mismatches', () => {
    expect(validateTimelineDraft('transition', duoTracks(), []).some((error) => error.includes('pose-swap'))).toBe(true)
    expect(
      validateTimelineDraft('interaction', duoTracks(), poseSwap).some((error) => error.includes('pose-swap')),
    ).toBe(true)
    expect(validateTimelineDraft('ambient', duoTracks(), poseSwap).some((error) => error.includes('ambient'))).toBe(true)

    const desynced: MotionTrack[] = [
      scaleY([
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 0.5, value: 0.8, easing: 'ease-out' },
        { at: 1, value: 1 },
      ]),
      scaleX([
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 1, value: 1 },
      ]),
    ]
    expect(
      validateTimelineDraft('transition', desynced, poseSwap).some((error) => error.includes('must share one easing')),
    ).toBe(true)
  })
})
