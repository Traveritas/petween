/**
 * client/preview-session.ts — the glue between a live PetStage and the motion
 * stack for the standalone preview page (and later the settings Live Preview,
 * §16.2). DSH-free by design: it only knows core/motion/overlay types.
 *
 * Owns: the animation registry, the MotionDirector, the ManualStateSource,
 * pose preloading (§16.3), config hot-swapping for the settings editor
 * (updateConfig, §16.2), the reduced-motion policy (§22 — the session
 * subscribes to the media query and pushes the effective flag into the stage;
 * the stage itself never listens), and the page-visibility policy (§23 —
 * hidden pages must not run timers or animations).
 */
import { createPoseResolver } from '../core/pose-resolver'
import { stateSlotFor } from '../core/state-machine'
import type { AssetMeta, PetweenConfig, PoseKey, ResolvedPose } from '../core/types'
import { POSE_KEYS } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'
import { assertValidAnimationDefinition } from '../motion/animation-definition'
import { createBuiltinRegistry, type AnimationRegistry } from '../motion/animation-registry'
import type { TimelineInstance } from '../motion/animation-handle'
import { MotionDirector } from '../motion/motion-director'
import type { PlayOptions } from '../motion/timeline-engine'
import { DRAFT_ANIMATION_ID, syncCustomAnimations } from './custom-animations'
import { ManualStateSource } from './manual-state-source'
import type { PetStage } from './overlay/pet-stage'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface PreviewSessionOptions {
  stage: PetStage
  config: PetweenConfig
  assets: Record<string, AssetMeta>
  /** V1.1 custom animations to register on top of the built-ins. */
  customs?: AnimationDefinition[]
  registry?: AnimationRegistry
  coalesceMs?: number
  /** Static boot for the animation-library renderer: show idle without its enter/ambient motion. */
  auditionOnly?: boolean
}

export class PreviewSession {
  readonly registry: AnimationRegistry
  readonly director: MotionDirector
  readonly source: ManualStateSource

  private readonly stage: PetStage
  private readonly config: PetweenConfig
  private assets: Record<string, AssetMeta>
  private resolvePose: (poseKey: PoseKey) => ResolvedPose | null
  private readonly customInstances = new Set<TimelineInstance>()
  private readonly auditionOnly: boolean
  private previewInstance: TimelineInstance | null = null
  private mediaQuery: MediaQueryList | null = null
  private hidden = false
  private disposed = false
  private started = false
  private startPromise: Promise<void> | null = null
  private poseRefreshSeq = 0

  constructor(options: PreviewSessionOptions) {
    this.stage = options.stage
    this.auditionOnly = options.auditionOnly ?? false
    this.config = options.config
    this.assets = options.assets
    this.registry = options.registry ?? createBuiltinRegistry()
    this.resolvePose = createPoseResolver(options.config.poses, options.assets)
    this.director = new MotionDirector({
      stage: options.stage,
      registry: this.registry,
      config: options.config,
      // Indirection: updateConfig swaps the resolver on config hot-edits. The
      // seam is string-keyed (external poses); the preview owns none, so any
      // non-builtin key simply resolves to nothing.
      resolvePose: (poseKey) =>
        (POSE_KEYS as readonly string[]).includes(poseKey) ? this.resolvePose(poseKey as PoseKey) : null,
    })
    if (options.customs !== undefined) this.updateCustoms(options.customs)
    this.source = new ManualStateSource({
      config: options.config,
      director: this.director,
      coalesceMs: options.coalesceMs,
    })

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
      this.mediaQuery.addEventListener('change', this.handleMediaChange)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    this.applyReducedMotion()
    this.stage.setParticlesEnabled(this.config.advanced.particles)
  }

  /**
   * §16.3 boot: preload every resolvable pose image, then show idle. The
   * initial target goes straight to the director (reason 'session-switch') —
   * it is the mount bootstrap, not a semantic event, so it must not consume
   * the resolver's idle dedupe.
   *
   * Memoized while a boot is in flight or has succeeded; a boot that found no
   * usable image (§2.1) is NOT memoized, so the editor can retry start() once
   * the first image lands (see updateConfig).
   */
  start(): Promise<void> {
    if (this.started) return this.startPromise ?? Promise.resolve()
    if (this.startPromise === null) {
      const booting = this.boot().finally(() => {
        if (!this.started) this.startPromise = null
      })
      this.startPromise = booting
    }
    return this.startPromise
  }

  /**
   * §16.2 editor hot path: move the session onto an edited config/assets
   * draft. The session's own config OBJECT is kept and its fields are
   * replaced with a deep copy of the draft, so the MotionDirector and the
   * ManualStateSource's resolver — both holding the original object — read
   * the new values live. Ambient restarts only when the states payload (or
   * the reduced-motion setting) actually changed: unrelated slider drags must
   * not restart loops mid-gesture.
   */
  async updateConfig(config: PetweenConfig, assets: Record<string, AssetMeta>): Promise<void> {
    if (this.disposed) return
    const snapshot = structuredClone(config)
    const previousStates = JSON.stringify(this.config.states)
    const previousReducedMotion = this.config.global.reducedMotion

    this.config.enabled = snapshot.enabled
    this.config.global = snapshot.global
    this.config.poses = snapshot.poses
    this.config.states = snapshot.states
    this.config.overlay = snapshot.overlay
    this.config.advanced = snapshot.advanced
    this.config.interactions = snapshot.interactions
    this.assets = { ...assets }
    this.resolvePose = createPoseResolver(this.config.poses, this.assets)
    this.stage.setParticlesEnabled(this.config.advanced.particles)

    this.stage.setUserScale(this.config.global.scale)
    if (this.config.global.reducedMotion !== previousReducedMotion) {
      this.applyReducedMotion()
    } else if (!this.auditionOnly && JSON.stringify(this.config.states) !== previousStates) {
      this.director.refreshAmbient()
    }

    if (!this.started) {
      // The first boot found no image; try again now that assets changed.
      await this.start()
      return
    }
    if (this.auditionOnly) await this.refreshAuditionPose()
    else await this.refreshCurrentPose()
  }

  private async boot(): Promise<void> {
    if (this.disposed) return
    const seen = new Set<string>()
    const poses: ResolvedPose[] = []
    for (const key of POSE_KEYS) {
      const pose = this.resolvePose(key)
      if (pose !== null && !seen.has(pose.asset.id)) {
        seen.add(pose.asset.id)
        poses.push(pose)
      }
    }
    await this.stage.preload(poses)
    if (this.disposed) return
    if (this.resolvePose(this.config.states.idle.pose) === null) {
      return // §2.1: no image at all → nothing to show
    }
    if (this.auditionOnly) {
      const pose = this.resolvePose(this.config.states.idle.pose)
      if (pose !== null) this.stage.swapPose(pose)
    } else {
      await this.director.setTarget({
        visualState: 'idle',
        poseKey: this.config.states.idle.pose,
        reason: 'session-switch',
      })
    }
    this.started = true
    // A config edit may have landed while the boot preload was in flight.
    if (this.auditionOnly) await this.refreshAuditionPose()
    else await this.refreshCurrentPose()
  }

  /** Keep the animation-library renderer on the configured idle pose. */
  private async refreshAuditionPose(): Promise<void> {
    const next = this.resolvePose(this.config.states.idle.pose)
    if (next === null) return
    const current = this.stage.currentPose
    if (
      current !== null &&
      next.asset.url === current.asset.url &&
      next.anchor.x === current.anchor.x &&
      next.anchor.y === current.anchor.y &&
      next.zoom === current.zoom
    ) {
      return
    }
    await this.stage.preload([next])
    if (!this.disposed) this.stage.swapPose(next)
  }

  /**
   * Re-resolve the current target's pose after a config edit; swap if it
   * changed. Resolution follows the DIRECTOR's target, not the slot on stage:
   * a pose shown through fallback carries the fallback SOURCE key on stage,
   * while the target keeps the requested key — so importing that pose's image
   * hot-swaps it without another state click.
   *
   * A transition in flight still pose-swaps the values resolved at its start,
   * so the refresh first waits for it to settle and then re-resolves against
   * the edited config. A transition that started after the edit already
   * resolved fresh values; the refresh leaves the stage to it.
   */
  private async refreshCurrentPose(): Promise<void> {
    const seq = ++this.poseRefreshSeq
    if (this.director.transitionInFlight) {
      await this.director.whenSettled()
      if (this.disposed || seq !== this.poseRefreshSeq) return
      if (this.director.transitionInFlight) return // a newer transition owns the stage
    }
    const target = this.director.currentTarget
    if (target === null) return
    const current = this.stage.currentPose
    if (current === null) return
    const next = this.resolvePose(target.poseKey)
    if (next === null) return // every image unimported; the editor shows its empty state
    const unchanged =
      next.asset.url === current.asset.url &&
      next.anchor.x === current.anchor.x &&
      next.anchor.y === current.anchor.y &&
      next.zoom === current.zoom
    if (unchanged) return
    await this.stage.preload([next])
    if (this.disposed || seq !== this.poseRefreshSeq) return // superseded by a newer edit
    this.stage.swapPose(next)
    this.director.noteExternalPose(next.asset.url)
  }

  /** §22: push the effective reduced-motion flag into stage + ambient engine. */
  applyReducedMotion(): void {
    const setting = this.config.global.reducedMotion
    const system = this.mediaQuery?.matches ?? false
    const effective = setting === 'always' || (setting === 'system' && system)
    this.stage.setReducedMotion(effective)
    // Re-evaluate the ambient profile: under reduce, ambient stays off.
    if (!this.auditionOnly) this.director.refreshAmbient()
  }

  /** Re-applies the current target's ambient profile after a config edit. */
  applyAmbientProfile(): void {
    this.director.refreshAmbient()
  }

  /**
   * §23: a hidden page must not burn timers or frames. pause()/resume()
   * freeze the ambient loops/timers and in-flight play() instances in place —
   * the ambient phase survives a hidden stint instead of restarting. A finite
   * enter transition already in flight (≤650ms) runs out; its ambient restart
   * begins pre-paused (see MotionDirector).
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) this.director.pause()
    else this.director.resume()
  }

  /** §17.6: replay the current enter transition (tracked by the director). */
  replayEnter(): void {
    if (this.disposed) return
    this.director.replayEnter().catch((error: unknown) => {
      console.error('petween: replay enter failed', error)
    })
  }

  /**
   * UX: preview the ENTER transition of the EDITED state slot, not whatever
   * the stage happens to show. When the session already shows that slot the
   * state machine would dedupe a redundant sendState (§15.1 — nothing would
   * play), so the director's current target is replayed directly. Otherwise
   * the slot is pushed through the ManualStateSource: the switch itself runs
   * the new state's enter transition through the real resolver → director
   * path (§16.2), pose fallback chains included. Caveat: a thinking↔working
   * hop inside `active` follows advanced.activityTransition (the full enter
   * only plays on 'state'; 'subtle'/'none' swap more quietly) — clicking
   * preview again once the slot matches replays the full enter.
   */
  replayStateEnter(slot: PoseKey): void {
    if (this.disposed) return
    const current = this.director.currentTarget
    if (current !== null && stateSlotFor(current) === slot) {
      this.replayEnter()
      return
    }
    sendStateSlot(this.source, slot)
  }

  /** §36 hatch demo: play any registered definition; tracked for cancel/dispose. */
  playCustom(definitionId: string, options: PlayOptions = {}): TimelineInstance {
    const instance = this.director.play(definitionId, options)
    this.customInstances.add(instance)
    void instance.play().then(() => this.customInstances.delete(instance))
    return instance
  }

  /**
   * V1.1: reconcile the registry's user:* entries with the latest customs
   * (editor save/clone/delete). Failures are logged, never fatal.
   */
  updateCustoms(customs: AnimationDefinition[]): void {
    if (this.disposed) return
    const before = JSON.stringify(this.registry.list().filter((definition) => definition.id.startsWith('user:')))
    for (const warning of syncCustomAnimations(this.registry, customs)) {
      console.warn(`petween: ${warning}`)
    }
    const after = JSON.stringify(this.registry.list().filter((definition) => definition.id.startsWith('user:')))
    if (before !== after) this.director.refreshAmbient()
  }

  /**
   * Animation-library audition: validate the draft, (re)register it under the
   * session-local scratch id and play it on the preview stage. The scratch id
   * is exempt from the customs sync, so an audition never collides with a
   * stored custom. `options.strength` overrides the definition's default for
   * the audition only (the 试播强度 slider). Throws when the definition is
   * invalid (the library UI validates live, so this is the backstop).
   */
  previewDefinition(definition: AnimationDefinition, options: { strength?: number } = {}): TimelineInstance {
    if (this.disposed) throw new Error('preview session is disposed')
    assertValidAnimationDefinition(definition)
    this.stopPreviewDefinition()
    if (this.registry.get(DRAFT_ANIMATION_ID) !== undefined) this.registry.unregister(DRAFT_ANIMATION_ID)
    this.registry.register({ ...definition, id: DRAFT_ANIMATION_ID })
    const instance = this.playCustom(
      DRAFT_ANIMATION_ID,
      options.strength === undefined ? {} : { params: { strength: options.strength } },
    )
    this.previewInstance = instance
    return instance
  }

  /** Cancel the current audition, including loop/random-interval timelines. */
  stopPreviewDefinition(): void {
    const instance = this.previewInstance
    if (instance === null) return
    instance.dispose()
    this.customInstances.delete(instance)
    this.previewInstance = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mediaQuery?.removeEventListener('change', this.handleMediaChange)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    for (const instance of this.customInstances) instance.dispose()
    this.customInstances.clear()
    this.previewInstance = null
    this.source.dispose()
    this.director.dispose()
    this.mediaQuery = null
  }

  private readonly handleMediaChange = (): void => {
    this.applyReducedMotion()
  }

  private readonly handleVisibilityChange = (): void => {
    this.setHidden(document.visibilityState === 'hidden')
  }
}

/**
 * Editor pose slot → the semantic event that drives the real state machine.
 * Single source of truth for the LivePreview state buttons and
 * replayStateEnter — the reduction to visual targets stays the resolver's job.
 */
export function sendStateSlot(source: ManualStateSource, slot: PoseKey): void {
  switch (slot) {
    case 'idle':
      source.sendState('idle')
      break
    case 'thinking':
      source.sendState('active', 'thinking')
      break
    case 'working':
      source.sendState('active', 'working')
      break
    case 'waiting':
      source.sendState('waiting')
      break
    case 'success':
      source.sendState('success')
      break
    case 'error':
      source.sendState('error')
      break
  }
}
