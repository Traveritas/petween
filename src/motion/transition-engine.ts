/**
 * motion/transition-engine.ts — enter transitions with generation-based
 * interruption (spec §10).
 *
 * The engine holds no preset keyframe logic (§10.1): the enter animation is
 * an AnimationDefinition executed by the Timeline Engine, and the pose swap
 * is the definition's pose-swap timeline event fired by the scheduler between
 * segments. A new transition invalidates the old one immediately (§10.2):
 * generation is bumped and the old instance is cancelled, so an interrupted
 * transition can neither swap the pose (event guard) nor be reported as
 * completed (callers must not restart ambient).
 */
import type { ResolvedPose } from '../core/types'
import type { TimelineInstance } from './animation-handle'
import type { TimelineEngine } from './timeline-engine'
import type { MotionStage } from './motion-stage'

export interface EnterRequest {
  pose: ResolvedPose
  definitionId: string
  params?: { strength?: number }
  durationMs?: number
  /**
   * Fires the moment the pose-swap event actually lands on the stage (past
   * the generation guard). Callers that keep a "what is on stage" ledger must
   * record at swap time, not completion: a transition interrupted during its
   * post segment has already changed the stage image.
   */
  onSwap?: () => void
}

export class TransitionEngine {
  private readonly stage: MotionStage
  private readonly engine: TimelineEngine
  private generation = 0
  private active: TimelineInstance | null = null

  constructor(stage: MotionStage, engine: TimelineEngine) {
    this.stage = stage
    this.engine = engine
  }

  /**
   * Plays the enter transition. Resolves true only when it ran to completion;
   * false means it was superseded or cancelled — the caller must not apply
   * any follow-up (ambient restart) in that case.
   */
  async play(request: EnterRequest): Promise<boolean> {
    const generation = ++this.generation
    this.active?.cancel()
    const instance = this.engine.createInstance(request.definitionId, {
      params: request.params,
      durationMs: request.durationMs,
      onEvent: (event) => {
        // Generation guard: an interrupted timeline must never swap the pose
        // or burst particles.
        if (generation !== this.generation) return
        if (event.type === 'pose-swap') {
          this.stage.swapPose(request.pose)
          request.onSwap?.()
        } else if (event.type === 'particle') {
          this.stage.emitParticle?.(event.effect)
        }
      },
    })
    this.active = instance
    await instance.play()
    if (generation !== this.generation) return false
    return instance.status === 'finished'
  }

  /** Invalidates any in-flight transition immediately (§10.2). */
  cancel(): void {
    this.generation += 1
    this.active?.cancel()
    this.active = null
  }

  get currentGeneration(): number {
    return this.generation
  }
}
