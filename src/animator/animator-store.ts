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
  /** Undo/redo availability (P13; gesture-coalesced draft history). */
  canUndo: boolean
  canRedo: boolean
}

/** Zoom keeps a sane working range: 1×..64× (beyond that ticks hit 1ms). */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 64

/**
 * Edits within this window merge into one undo step (a drag's pointer ticks
 * and rapid form spinner changes); anything slower apart becomes its own.
 */
const HISTORY_COALESCE_MS = 600
const HISTORY_LIMIT = 100

export class AnimatorStore {
  private snapshot: AnimatorSnapshot = {
    selectedId: null,
    draft: null,
    playheadAt: null,
    zoom: 1,
    snapEnabled: true,
    canUndo: false,
    canRedo: false,
  }
  private readonly undoStack: DraftState[] = []
  private readonly redoStack: DraftState[] = []
  private lastHistoryAt = 0
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): AnimatorSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Open a library entry: a fresh pristine draft; the history resets. */
  selectAnimation(definition: AnimationDefinition): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.lastHistoryAt = 0
    this.set({
      ...this.snapshot,
      selectedId: definition.id,
      draft: draftFrom(definition),
      playheadAt: null,
      canUndo: false,
      canRedo: false,
    })
  }

  /** Patch scalar fields / structured replaces — history-aware (P13). */
  patchDraft(patch: Partial<DraftState>): void {
    if (this.snapshot.draft === null) return
    const next = { ...this.snapshot.draft, ...patch }
    this.commit(next)
  }

  /** Timeline edits from the TimelineEditor — history-aware (P13). */
  applyTimeline(next: { tracks: MotionTrack[]; events: TimelineEvent[] }): void {
    this.patchDraft(next)
  }

  /** Close the open entry (deleted externally, or an explicit close). */
  clear(): void {
    if (this.snapshot.selectedId === null && this.snapshot.draft === null) return
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.lastHistoryAt = 0
    this.set({ ...this.snapshot, selectedId: null, draft: null, playheadAt: null, canUndo: false, canRedo: false })
  }

  /** One undo step back; no-op at the history floor. */
  undo(): void {
    if (this.snapshot.draft === null || this.undoStack.length === 0) return
    this.redoStack.push(this.snapshot.draft)
    const draft = this.undoStack.pop() as DraftState
    this.lastHistoryAt = 0 // the step boundary breaks any in-flight coalescing
    this.set({ ...this.snapshot, draft, canUndo: this.undoStack.length > 0, canRedo: true })
  }

  /** Re-apply the most recently undone step; no-op when the redo stack is empty. */
  redo(): void {
    if (this.snapshot.draft === null || this.redoStack.length === 0) return
    this.undoStack.push(this.snapshot.draft)
    const draft = this.redoStack.pop() as DraftState
    this.lastHistoryAt = 0
    this.set({ ...this.snapshot, draft, canUndo: true, canRedo: this.redoStack.length > 0 })
  }

  /**
   * Push the PRE-edit state onto the undo stack (coalesced: edits inside the
   * window share one step — the stack top already holds the pre-gesture
   * state), drop the redo stack, then adopt the next draft.
   */
  private commit(next: DraftState): void {
    const current = this.snapshot.draft
    if (current === null) return
    const now = Date.now()
    if (now - this.lastHistoryAt > HISTORY_COALESCE_MS) {
      this.undoStack.push(current)
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
    }
    this.lastHistoryAt = now
    this.redoStack.length = 0
    this.set({ ...this.snapshot, draft: next, canUndo: this.undoStack.length > 0, canRedo: false })
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
