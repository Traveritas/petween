/**
 * motion/ambient-engine.ts — orchestrates the built-in ambient channels plus
 * one optional user-defined ambient timeline (spec §25, §8.16).
 *
 * The engine selects and schedules timelines; it never hardcodes keyframes.
 * apply() diffs per channel so a config change only restarts the affected
 * channel (an untouched sway keeps its phase). Under reduced-motion the
 * whole ambient layer stays off (§22).
 */
import { resolveAmbientChannel, type ResolvedAmbientChannel } from '../core/ambient-presets'
import type { AmbientConfig } from '../core/types'
import { AMBIENT_CHANNELS, type AmbientChannel } from '../core/types'
import type { TimelineInstance } from './animation-handle'
import type { AnimationRegistry } from './animation-registry'
import type { TimelineEngine } from './timeline-engine'
import type { MotionStage } from './motion-stage'

interface ChannelState {
  /** JSON of ResolvedAmbientChannel — change detection for restart-on-diff. */
  key: string
  instance: TimelineInstance
}

export class AmbientEngine {
  private readonly stage: MotionStage
  private readonly engine: TimelineEngine
  private readonly registry: AnimationRegistry
  private readonly channels = new Map<AmbientChannel, ChannelState>()
  private customChannel: ChannelState | null = null
  private paused = false

  constructor(stage: MotionStage, engine: TimelineEngine, registry: AnimationRegistry) {
    this.stage = stage
    this.engine = engine
    this.registry = registry
  }

  apply(config: AmbientConfig): void {
    for (const channel of AMBIENT_CHANNELS) {
      const desired = this.stage.reducedMotion ? null : resolveAmbientChannel(channel, config)
      const key = desired === null ? null : JSON.stringify(desired)
      const current = this.channels.get(channel)
      const unchanged =
        (key === null && current === undefined) || (key !== null && current !== undefined && current.key === key)
      if (unchanged) continue // config change only restarts the affected channel
      current?.instance.dispose()
      this.channels.delete(channel)
      if (desired !== null && key !== null) {
        this.startChannel(channel, desired, key)
      }
    }
    this.applyCustom(config.customAnimationId)
  }

  /** Stops every channel; a later apply() starts fresh. */
  stop(): void {
    for (const state of this.channels.values()) state.instance.dispose()
    this.channels.clear()
    this.customChannel?.instance.dispose()
    this.customChannel = null
  }

  pause(): void {
    this.paused = true
    for (const state of this.channels.values()) state.instance.pause()
    this.customChannel?.instance.pause()
  }

  resume(): void {
    this.paused = false
    for (const state of this.channels.values()) state.instance.resume()
    this.customChannel?.instance.resume()
  }

  dispose(): void {
    this.stop()
  }

  private startChannel(channel: AmbientChannel, desired: ResolvedAmbientChannel, key: string): void {
    const instance = this.engine.createInstance(desired.definitionId, {
      params: desired.params,
      durationMs: desired.durationMs,
      repeat: desired.repeat,
    })
    this.channels.set(channel, { key, instance })
    void instance.play()
    if (this.paused) instance.pause()
  }

  /** Optional user ambient timeline; dangling or wrong-kind ids stay quiet. */
  private applyCustom(id: string | undefined): void {
    const definition = id === undefined ? undefined : this.registry.get(id)
    const desired = !this.stage.reducedMotion && definition?.kind === 'ambient' ? definition : null
    // Include the full definition so an in-place library edit restarts the
    // running instance once the session registry has been reconciled.
    const key = desired === null ? null : JSON.stringify(desired)
    if ((key === null && this.customChannel === null) || this.customChannel?.key === key) return
    this.customChannel?.instance.dispose()
    this.customChannel = null
    if (desired === null || key === null) return
    const instance = this.engine.createInstance(desired.id)
    this.customChannel = { key, instance }
    void instance.play()
    if (this.paused) instance.pause()
  }
}
