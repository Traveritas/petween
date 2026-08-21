/**
 * core/state-machine.ts — pure VisualState transitions (spec §14).
 *
 * The reducer is deliberately trivial: every semantic event fully determines
 * the next snapshot. Stabilization policy (dedupe, coalescing, transient
 * holds) lives in pet-state-resolver.ts, not here.
 */
import type { ActivityMode, PetSemanticEvent, PoseKey, VisualState } from './types'

/** Current visual position of the pet: a VisualState plus the activity while active. */
export interface PetVisualSnapshot {
  visualState: VisualState
  activityMode?: ActivityMode
}

/** State diagram of spec §14.3 as a pure function. */
export function reducePetState(current: PetVisualSnapshot, event: PetSemanticEvent): PetVisualSnapshot {
  switch (event.type) {
    case 'turn-start':
      return { visualState: 'active', activityMode: 'thinking' }
    case 'activity':
      return { visualState: 'active', activityMode: event.mode }
    case 'waiting':
      return { visualState: 'waiting' }
    case 'turn-end':
      return { visualState: event.outcome }
    case 'idle':
      return { visualState: 'idle' }
    case 'dismiss':
      // Dismiss only releases a held terminal face; anything else is a no-op.
      return current.visualState === 'success' || current.visualState === 'error' ? { visualState: 'idle' } : current
  }
  return current
}

/**
 * Map a snapshot to one of the six editor state slots (spec §2.1: thinking
 * and working are the two materialized faces of `active`). Every non-thinking
 * ActivityMode shares the `working` slot so reasoning → tool → command does
 * not swap poses (§14.2).
 */
export function stateSlotFor(snapshot: PetVisualSnapshot): PoseKey {
  switch (snapshot.visualState) {
    case 'idle':
      return 'idle'
    case 'waiting':
      return 'waiting'
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'active':
      return snapshot.activityMode === undefined || snapshot.activityMode === 'thinking' ? 'thinking' : 'working'
  }
}
