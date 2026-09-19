/**
 * P13 batch-selection model tests (timeline-model.ts): selection key
 * round-trips, batch moves (delta application, clamp, silent collision
 * drops, anchor-only when unselected frames sit in the way), and duplicate
 * (+0.05 offset, occupied-slot skips, post-merge selection keys).
 */
import { describe, expect, it } from 'vitest'
import type { MotionTrack, TimelineEvent } from '../../src/motion/animation-definition'
import {
  duplicateSelectedKeyframes,
  eventKey,
  keyframeKey,
  moveSelectionBatch,
  parseSelectionKey,
} from '../../src/client/timeline/timeline-model'

const track = (at: number[]): MotionTrack => ({
  property: 'transition.scaleY',
  keyframes: at.map((time) => ({ at: time, value: 1 })),
})

describe('selection keys', () => {
  it('round-trips keyframe and event keys', () => {
    expect(parseSelectionKey(keyframeKey(2, 3))).toEqual({ kind: 'keyframe', trackIndex: 2, keyframeIndex: 3 })
    expect(parseSelectionKey(eventKey(5))).toEqual({ kind: 'event', eventIndex: 5 })
    expect(parseSelectionKey('garbage')).toBeNull()
    expect(parseSelectionKey('keyframe:x:1')).toBeNull()
  })
})

describe('moveSelectionBatch', () => {
  it('moves every selected keyframe and event by the same delta', () => {
    const tracks = [track([0.1, 0.5, 0.9])]
    const events: TimelineEvent[] = [{ at: 0.2, type: 'pose-swap' }]
    const selection = new Set([keyframeKey(0, 0), keyframeKey(0, 1), eventKey(0)])
    const next = moveSelectionBatch(tracks, events, selection, 0.1)
    expect(next.tracks[0].keyframes.map((keyframe) => keyframe.at)).toEqual([0.2, 0.6, 0.9])
    expect(next.events[0].at).toBe(0.3)
  })

  it('clamps at the edges instead of dropping outside', () => {
    const tracks = [track([0.95])]
    const next = moveSelectionBatch(tracks, [], new Set([keyframeKey(0, 0)]), 0.2)
    expect(next.tracks[0].keyframes[0].at).toBe(1)
  })

  it('drops a move that would collide with an unselected frame (no merge)', () => {
    const tracks = [track([0.1, 0.2])]
    const next = moveSelectionBatch(tracks, [], new Set([keyframeKey(0, 0)]), 0.1)
    expect(next.tracks[0].keyframes[0].at).toBe(0.1) // stayed put
    expect(next.tracks[0].keyframes[1].at).toBe(0.2) // untouched
  })

  it('never moves unselected frames and ignores empty selections/deltas', () => {
    const tracks = [track([0.1, 0.5])]
    expect(moveSelectionBatch(tracks, [], new Set([keyframeKey(0, 1)]), 0)).toEqual({ tracks, events: [] })
    expect(moveSelectionBatch(tracks, [], new Set(), 0.3)).toEqual({ tracks, events: [] })
    const untouched = moveSelectionBatch(tracks, [], new Set([keyframeKey(0, 0)]), 0.05)
    expect(untouched.tracks[0].keyframes[1].at).toBe(0.5)
  })
})

describe('duplicateSelectedKeyframes', () => {
  it('copies at +0.05 and selects the copies (post-merge indices)', () => {
    const tracks = [track([0.1, 0.4])]
    const next = duplicateSelectedKeyframes(tracks, new Set([keyframeKey(0, 1)]))
    // merged sorted: 0.1 (idx 0), 0.4 (idx 1), 0.45 copy (idx 2)
    expect(next.tracks[0].keyframes.map((keyframe) => keyframe.at)).toEqual([0.1, 0.4, 0.45])
    expect(next.selection).toEqual([keyframeKey(0, 2)])
  })

  it('skips occupied slots silently', () => {
    const tracks = [track([0.1, 0.15])]
    const next = duplicateSelectedKeyframes(tracks, new Set([keyframeKey(0, 0)]))
    // 0.1 + 0.05 = 0.15 is occupied → no copy; nothing selected afterwards
    expect(next.tracks[0].keyframes.map((keyframe) => keyframe.at)).toEqual([0.1, 0.15])
    expect(next.selection).toEqual([])
  })

  it('leaves events alone and keeps the easing/value payload of the copy', () => {
    const source: MotionTrack = {
      property: 'sway.rotation',
      keyframes: [{ at: 0.2, value: 7, easing: 'ease-in' }],
    }
    const next = duplicateSelectedKeyframes([source], new Set([keyframeKey(0, 0)]))
    expect(next.tracks[0].keyframes).toHaveLength(2)
    expect(next.tracks[0].keyframes[1]).toMatchObject({ at: 0.25, value: 7, easing: 'ease-in' })
  })
})
