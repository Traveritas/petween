/**
 * core/pet-state-resolver.ts — visual state stabilizer (spec §14.4, §15).
 *
 * Sits between semantic events and the MotionDirector:
 *   PetSemanticEvent → (50~100ms coalescing) → reducePetState → dedupe →
 *   transient success/error holds → MotionTarget
 *
 * Hard rules implemented here:
 * - §15.1 identical state dedupe: same visualState + same activityMode emits nothing.
 * - §15.2 activity change inside `active`: emits a target with the SAME poseKey
 *   (unless config.advanced.changePoseWithinActive=true and the new slot's pose
 *   differs), so the director only refreshes ambient (§10.3) instead of playing
 *   a transition. The flag is read LIVE off the shared config object, so a hot
 *   config edit applies to the next activity change without a rebuild.
 * - §14.4 success/error are transient: after holdMs without new events the pet
 *   returns to idle; a new turn interrupts the terminal state immediately. With
 *   advanced.terminalHold='until-interaction' no hold timer runs — only a new
 *   activity or a {type:'dismiss'} event (pet click) releases the terminal face.
 *   The flag is read live, same as changePoseWithinActive.
 * - Stray-idle suppression: the runtime emits agent-idle immediately after
 *   turn/end, which must not kill the terminal face — the idle is dropped both
 *   while the turn-end is still coalescing and while success/error is held. A
 *   held terminal exits only via the hold timer, a new activity, or dismiss.
 */
import type { PetweenConfig, MotionTarget, MotionTargetReason, PetSemanticEvent, PoseKey } from './types'
import { reducePetState, stateSlotFor, type PetVisualSnapshot } from './state-machine'

export interface PetStateResolverOptions {
  config: Pick<PetweenConfig, 'states' | 'global' | 'advanced'>
  onTarget: (target: MotionTarget) => void
  /** §15.3 event coalescing window; default 60ms. */
  coalesceMs?: number
}

const DEFAULT_COALESCE_MS = 60
/**
 * §15.3 starvation cap: the coalescing window is trailing-edge (every event
 * resets it), so a steady event stream could postpone the commit forever.
 * At this distance from the FIRST still-uncommitted event the window is
 * forced to close and commit exactly once (the constant is the ceiling, not
 * the normal cadence — bursts still collapse inside the 60ms window).
 */
const MAX_COALESCE_WINDOW_MS = 200

export class PetStateResolver {
  private readonly config: PetStateResolverOptions['config']
  private readonly onTarget: (target: MotionTarget) => void
  private readonly coalesceMs: number

  private current: PetVisualSnapshot = { visualState: 'idle' }
  private currentPoseKey: PoseKey
  private pendingEvent: PetSemanticEvent | null = null
  /** When the current coalescing epoch started (first uncommitted event). */
  private pendingSince: number | null = null
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PetStateResolverOptions) {
    this.config = options.config
    this.onTarget = options.onTarget
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
    this.currentPoseKey = this.config.states.idle.pose
  }

  handleEvent(event: PetSemanticEvent): void {
    // Stray-idle suppression: the agent reports idle right after turn/end
    // (and an aborted/interrupted turn-end maps to idle too), which must not
    // cut the terminal face short. Drop the idle while a turn-end is still
    // coalescing or while success/error is on screen holding.
    if (event.type === 'idle' && this.isTerminalPendingOrHeld()) return
    // §15.3 coalescing: keep only the latest event inside the window so a burst
    // like turn-start + assistant-start + tool-start produces one visual op.
    this.pendingEvent = event
    const now = Date.now()
    if (this.pendingSince === null) this.pendingSince = now
    // The wait is the regular trailing window, capped by the starvation
    // deadline: never later than pendingSince + MAX_COALESCE_WINDOW_MS.
    const elapsed = now - this.pendingSince
    const remaining = Math.min(this.coalesceMs, Math.max(0, MAX_COALESCE_WINDOW_MS - elapsed))
    if (this.coalesceTimer !== null) clearTimeout(this.coalesceTimer)
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null
      this.pendingSince = null
      const pending = this.pendingEvent
      this.pendingEvent = null
      if (pending === null) return
      this.commit(reducePetState(this.current, pending), reasonFor(pending))
    }, remaining)
  }

  /** A turn-end is waiting out the coalescing window, or a terminal face is held. */
  private isTerminalPendingOrHeld(): boolean {
    return (
      this.pendingEvent?.type === 'turn-end' ||
      this.current.visualState === 'success' ||
      this.current.visualState === 'error'
    )
  }

  /** Cancel pending coalescing/hold timers. */
  dispose(): void {
    if (this.coalesceTimer !== null) clearTimeout(this.coalesceTimer)
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    this.coalesceTimer = null
    this.holdTimer = null
    this.pendingEvent = null
    this.pendingSince = null
  }

  private commit(next: PetVisualSnapshot, reason: MotionTargetReason): void {
    const prev = this.current
    if (next.visualState === prev.visualState) {
      if (next.visualState === 'active' && next.activityMode !== prev.activityMode) {
        this.commitActivityChange(next, reason)
      }
      // §15.1: identical state — emit nothing. A duplicate success/error does
      // not extend the running hold timer.
      return
    }
    this.clearHold()
    this.current = next
    this.currentPoseKey = this.config.states[stateSlotFor(next)].pose
    this.emit(next, reason)
    if (next.visualState === 'success' || next.visualState === 'error') {
      // 'until-interaction' arms no timer: only a new activity or a dismiss
      // releases the face. Read live, so a hot config edit applies to the
      // next terminal commit.
      if (this.config.advanced.terminalHold === 'timed') {
        const holdMs =
          next.visualState === 'success' ? this.config.global.successHoldMs : this.config.global.errorHoldMs
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null
          this.commit({ visualState: 'idle' }, 'agent-state')
        }, holdMs)
      }
    }
  }

  /** §15.2: activity change inside `active` is ambient-only by default. */
  private commitActivityChange(next: PetVisualSnapshot, reason: MotionTargetReason): void {
    const slotPose = this.config.states[stateSlotFor(next)].pose
    this.current = next
    if (this.config.advanced.changePoseWithinActive && slotPose !== this.currentPoseKey) {
      this.currentPoseKey = slotPose
    }
    // When changePoseWithinActive is false the target keeps the current
    // poseKey: same visualState + same poseKey makes the director skip the
    // transition and only refresh the ambient profile (§10.3). When it is
    // true the emitted poseKey differs and the director swaps the pose
    // silently (no transition).
    this.emit(next, reason)
  }

  private emit(snapshot: PetVisualSnapshot, reason: MotionTargetReason): void {
    this.onTarget({
      visualState: snapshot.visualState,
      activityMode: snapshot.activityMode,
      poseKey: this.currentPoseKey,
      reason,
    })
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer)
    this.holdTimer = null
  }
}

function reasonFor(event: PetSemanticEvent): MotionTargetReason {
  if (event.type === 'turn-end') {
    return event.outcome === 'success' ? 'terminal-success' : 'terminal-error'
  }
  return 'agent-state'
}
