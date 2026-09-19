/**
 * AnimatorStore unit tests (animator/animator-store.ts): the /petween-animator/
 * page's editing state — selection lifecycle, draft patching semantics, and
 * the subscribe/notify contract used by useSyncExternalStore.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MotionTrack, TimelineEvent } from '../../src/motion/animation-definition'
import { AnimatorStore } from '../../src/animator/animator-store'
import { BUILTIN_DEFINITIONS } from '../../src/client/timeline/animation-draft'

describe('AnimatorStore', () => {
  it('starts with nothing open and the default feel state', () => {
    const store = new AnimatorStore()
    expect(store.getSnapshot()).toEqual({ selectedId: null, draft: null, playheadAt: null, zoom: 1, snapEnabled: true })
  })

  it('selectAnimation opens a pristine draft of the saved definition', () => {
    const store = new AnimatorStore()
    const builtin = BUILTIN_DEFINITIONS[0]
    store.selectAnimation(builtin)
    const snapshot = store.getSnapshot()
    expect(snapshot.selectedId).toBe(builtin.id)
    expect(snapshot.draft).not.toBeNull()
    expect(snapshot.draft?.name).toBe(builtin.name)
    expect(snapshot.draft?.kind).toBe(builtin.kind)
    expect(snapshot.draft?.durationMs).toBe(builtin.durationMs)
    expect(snapshot.draft?.tracks).toEqual(builtin.tracks)
  })

  it('patchDraft patches the open draft and ignores patches while nothing is open', () => {
    const store = new AnimatorStore()
    store.patchDraft({ name: 'ignored' })
    expect(store.getSnapshot().draft).toBeNull()

    store.selectAnimation(BUILTIN_DEFINITIONS[0])
    store.patchDraft({ durationMs: 1234 })
    const draft = store.getSnapshot().draft
    expect(draft?.durationMs).toBe(1234)
    // untouched fields survive a partial patch
    expect(draft?.name).toBe(BUILTIN_DEFINITIONS[0].name)
  })

  it('applyTimeline replaces tracks/events wholesale', () => {
    const store = new AnimatorStore()
    store.selectAnimation(BUILTIN_DEFINITIONS[0])
    const nextTracks: MotionTrack[] = [
      { property: 'sway.rotation', keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }] },
    ]
    const nextEvents: TimelineEvent[] = [{ at: 0.5, type: 'pose-swap' }]
    store.applyTimeline({ tracks: nextTracks, events: nextEvents })
    const draft = store.getSnapshot().draft
    expect(draft?.tracks).toEqual(nextTracks)
    expect(draft?.events).toEqual(nextEvents)
  })

  it('clear closes the open entry and stays a no-op when already closed', () => {
    const store = new AnimatorStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.clear() // nothing open: no notification, no state churn
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toEqual({ selectedId: null, draft: null, playheadAt: null, zoom: 1, snapEnabled: true })

    store.selectAnimation(BUILTIN_DEFINITIONS[0])
    expect(listener).toHaveBeenCalledTimes(1)
    store.clear()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toMatchObject({ selectedId: null, draft: null })
  })

  it('selection switches drop the parked playhead (a stale scrub would lie)', () => {
    const store = new AnimatorStore()
    store.selectAnimation(BUILTIN_DEFINITIONS[0])
    store.setPlayhead(0.3)
    expect(store.getSnapshot().playheadAt).toBe(0.3)
    store.selectAnimation(BUILTIN_DEFINITIONS[1])
    expect(store.getSnapshot().playheadAt).toBeNull()
  })

  it('playhead clamps, dedupes, and clears', () => {
    const store = new AnimatorStore()
    store.selectAnimation(BUILTIN_DEFINITIONS[0])
    const listener = vi.fn()
    store.subscribe(listener)

    store.setPlayhead(1.7)
    expect(store.getSnapshot().playheadAt).toBe(1)
    store.setPlayhead(1) // unchanged: no notification
    expect(listener).toHaveBeenCalledTimes(1)
    store.setPlayhead(null)
    expect(store.getSnapshot().playheadAt).toBeNull()
    store.setPlayhead(null) // already null: no notification
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('zoom clamps into the working range and snap toggles', () => {
    const store = new AnimatorStore()
    store.setZoom(0.2)
    expect(store.getSnapshot().zoom).toBe(1)
    store.setZoom(500)
    expect(store.getSnapshot().zoom).toBe(64)
    store.setSnapEnabled(false)
    expect(store.getSnapshot().snapEnabled).toBe(false)
  })

  it('notifies subscribers on every mutation and honors unsubscribe/dispose', () => {
    const store = new AnimatorStore()
    const a = vi.fn()
    const b = vi.fn()
    const unsubscribeA = store.subscribe(a)
    store.subscribe(b)

    store.selectAnimation(BUILTIN_DEFINITIONS[0])
    store.patchDraft({ name: 'renamed' })
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)

    unsubscribeA()
    store.clear()
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(3)

    store.dispose()
    store.selectAnimation(BUILTIN_DEFINITIONS[1])
    expect(b).toHaveBeenCalledTimes(3) // disposed: no more notifications
  })
})
