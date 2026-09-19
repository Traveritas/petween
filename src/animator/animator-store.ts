/**
 * animator/animator-store.ts — the animation workbench's editing state
 * (V1.2 Phase 11 skeleton): which library entry is open and its editable
 * draft. Pure TS on the EditorStore pattern (subscribe/getSnapshot consumed
 * via useSyncExternalStore, no React import) so the later feel batches can
 * grow it without another lift — playhead/zoom (Phase 12) and multi-selection
 * plus the undo/redo stacks (Phase 13) land as additional snapshot fields.
 *
 * The settings editor's AnimationLibrary keeps its local useState draft by
 * design (its behavior is frozen at the V1.1 UX); this store serves the
 * /petween-animator/ page only. Shared draft math lives in
 * client/timeline/animation-draft.ts.
 */
import type { AnimationDefinition, MotionTrack, TimelineEvent } from '../motion/animation-definition'
import { draftFrom, type DraftState } from '../client/timeline/animation-draft'

export interface AnimatorSnapshot {
  selectedId: string | null
  draft: DraftState | null
  /** Playhead position (normalized 0..1); null = no playhead parked. */
  playheadAt: number | null
  /** Timeline zoom: 1 = the full duration fills the lane width. */
  zoom: number
  /** Target snapping (grid + frames/events/playhead); Alt-hold overrides. */
  snapEnabled: boolean
}

/** Zoom keeps a sane working range: 1×..64× (beyond that ticks hit 1ms). */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 64

export class AnimatorStore {
  private snapshot: AnimatorSnapshot = { selectedId: null, draft: null, playheadAt: null, zoom: 1, snapEnabled: true }
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): AnimatorSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Open a library entry: a fresh pristine draft from its saved definition. */
  selectAnimation(definition: AnimationDefinition): void {
    this.set({ ...this.snapshot, selectedId: definition.id, draft: draftFrom(definition), playheadAt: null })
  }

  /** Patch scalar fields / structured replaces (kind switches land here too). */
  patchDraft(patch: Partial<DraftState>): void {
    if (this.snapshot.draft === null) return
    this.set({ ...this.snapshot, draft: { ...this.snapshot.draft, ...patch } })
  }

  /** Timeline edits from the TimelineEditor. */
  applyTimeline(next: { tracks: MotionTrack[]; events: TimelineEvent[] }): void {
    this.patchDraft(next)
  }

  /** Close the open entry (deleted externally, or an explicit close). */
  clear(): void {
    if (this.snapshot.selectedId === null && this.snapshot.draft === null) return
    this.set({ ...this.snapshot, selectedId: null, draft: null, playheadAt: null })
  }

  /** Park/move the playhead (null clears it, e.g. on audition start). */
  setPlayhead(at: number | null): void {
    if (at !== null) {
      const clamped = Math.min(1, Math.max(0, at))
      if (this.snapshot.playheadAt === clamped) return
      this.set({ ...this.snapshot, playheadAt: clamped })
      return
    }
    if (this.snapshot.playheadAt === null) return
    this.set({ ...this.snapshot, playheadAt: null })
  }

  setZoom(zoom: number): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    if (this.snapshot.zoom === clamped) return
    this.set({ ...this.snapshot, zoom: clamped })
  }

  setSnapEnabled(enabled: boolean): void {
    if (this.snapshot.snapEnabled === enabled) return
    this.set({ ...this.snapshot, snapEnabled: enabled })
  }

  dispose(): void {
    this.listeners.clear()
  }

  private set(snapshot: AnimatorSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
