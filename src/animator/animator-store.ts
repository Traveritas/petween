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
}

export class AnimatorStore {
  private snapshot: AnimatorSnapshot = { selectedId: null, draft: null }
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
    this.set({ selectedId: definition.id, draft: draftFrom(definition) })
  }

  /** Patch scalar fields / structured replaces (kind switches land here too). */
  patchDraft(patch: Partial<DraftState>): void {
    if (this.snapshot.draft === null) return
    this.set({ selectedId: this.snapshot.selectedId, draft: { ...this.snapshot.draft, ...patch } })
  }

  /** Timeline edits from the TimelineEditor. */
  applyTimeline(next: { tracks: MotionTrack[]; events: TimelineEvent[] }): void {
    this.patchDraft(next)
  }

  /** Close the open entry (deleted externally, or an explicit close). */
  clear(): void {
    if (this.snapshot.selectedId === null && this.snapshot.draft === null) return
    this.set({ selectedId: null, draft: null })
  }

  dispose(): void {
    this.listeners.clear()
  }

  private set(snapshot: AnimatorSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
