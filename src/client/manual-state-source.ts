/**
 * client/manual-state-source.ts — the Manual Preview controller (spec §16.2,
 * §17.6). Translates preview button clicks into PetSemanticEvents and runs
 * them through the REAL PetStateResolver / state machine — coalescing,
 * dedupe and transient success/error holds included. There is deliberately
 * no preview-only transition shortcut.
 *
 * Emitted targets are re-tagged reason 'manual-preview' and handed to the
 * MotionDirector. The source does not own the director: dispose() only
 * cancels the resolver's pending timers.
 */
import { PetStateResolver } from '../core/pet-state-resolver'
import type { ActivityMode, MotionPetConfig, PetSemanticEvent, VisualState } from '../core/types'
import type { MotionDirector } from '../motion/motion-director'

export interface ManualStateSourceOptions {
  config: Pick<MotionPetConfig, 'states' | 'global' | 'advanced'>
  director: MotionDirector
  /** §15.3 coalescing window; defaults to the resolver's 60ms. */
  coalesceMs?: number
}

export class ManualStateSource {
  private readonly director: MotionDirector
  private readonly resolver: PetStateResolver

  constructor(options: ManualStateSourceOptions) {
    this.director = options.director
    this.resolver = new PetStateResolver({
      config: options.config,
      coalesceMs: options.coalesceMs,
      onTarget: (target) => {
        // Transition lifecycle is tracked by the director itself
        // (transitionInFlight/whenSettled) — no source-side bookkeeping.
        this.director.setTarget({ ...target, reason: 'manual-preview' }).catch((error: unknown) => {
          console.error('motion-pet: manual preview setTarget failed', error)
        })
      },
    })
  }

  /** Push a preview button through the real state machine. */
  sendState(state: VisualState, activity?: ActivityMode): void {
    this.resolver.handleEvent(eventFor(state, activity))
  }

  /** Cancels pending coalescing/hold timers. The director is NOT disposed. */
  dispose(): void {
    this.resolver.dispose()
  }
}

/** Button intent → semantic event (§14.3 reduction is the resolver's job). */
function eventFor(state: VisualState, activity: ActivityMode | undefined): PetSemanticEvent {
  switch (state) {
    case 'idle':
      return { type: 'idle' }
    case 'waiting':
      return { type: 'waiting' }
    case 'success':
      return { type: 'turn-end', outcome: 'success' }
    case 'error':
      return { type: 'turn-end', outcome: 'error' }
    case 'active':
      // 'thinking' is the turn's entry face; other activities map directly.
      if (activity === undefined || activity === 'thinking') return { type: 'turn-start' }
      return { type: 'activity', mode: activity }
  }
}
