/**
 * motion/timeline-engine.ts — registry + compiler + instance factory
 * (spec §8.11/§8.17). The only way animations get executed: every animation,
 * built-in or custom, goes definition → compile → instance (§36.12).
 */
import { CompiledTimelineInstance, type TimelineInstance } from './animation-handle'
import type { AnimationRegistry } from './animation-registry'
import type { RepeatPolicy } from './animation-definition'
import { compileTimeline, type CompiledTimelineEvent } from './timeline-compiler'
import type { MotionStage } from './motion-stage'

export interface PlayOptions {
  params?: { strength?: number }
  durationMs?: number
  repeat?: RepeatPolicy
  onEvent?: (event: CompiledTimelineEvent) => void
  random?: () => number
}

export class TimelineEngine {
  private readonly stage: MotionStage
  private readonly registry: AnimationRegistry

  constructor(stage: MotionStage, registry: AnimationRegistry) {
    this.stage = stage
    this.registry = registry
  }

  createInstance(definitionId: string, options: PlayOptions = {}): TimelineInstance {
    const definition = this.registry.get(definitionId)
    if (definition === undefined) {
      throw new Error(`timeline-engine: unknown animation "${definitionId}"`)
    }
    const compiled = compileTimeline(definition, {
      params: options.params,
      durationMs: options.durationMs,
      repeat: options.repeat,
      reducedMotion: this.stage.reducedMotion,
    })
    return new CompiledTimelineInstance(definitionId, compiled, this.stage.layers, {
      onEvent: options.onEvent,
      random: options.random,
    })
  }

  /** Compile, instantiate and immediately play. */
  play(definitionId: string, options: PlayOptions = {}): TimelineInstance {
    const instance = this.createInstance(definitionId, options)
    void instance.play()
    return instance
  }
}
