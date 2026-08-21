/**
 * motion/motion-stage.ts — the boundary between the renderer and the motion
 * engine. The renderer (client/, M3) owns the layered DOM and image swapping;
 * the engine only ever touches the four whitelisted layers via WAAPI and
 * asks for pose swaps through this contract.
 */
import type { ResolvedPose } from '../core/types'
import type { MotionLayer } from './motion-properties'

export interface MotionStage {
  /** One element per transform-ownership layer (spec §3.4). */
  readonly layers: Record<MotionLayer, HTMLElement>
  /** Synchronous image swap; the renderer guarantees the asset is preloaded. */
  swapPose(pose: ResolvedPose): void
  /**
   * `particle` timeline events (spec §8.5): fire a particle burst. Optional —
   * a stage without a particle layer simply drops the event.
   */
  emitParticle?(effect: string): void
  /** Runtime environment flag (config reducedMotion + prefers-reduced-motion). */
  readonly reducedMotion: boolean
}
