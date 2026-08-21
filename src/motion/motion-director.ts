/**
 * motion/motion-director.ts — the MotionDirector (spec §24): the single entry
 * point the rest of the app talks to.
 *
 * Flow per §10/§15: setTarget dedupes identical visual targets (§10.3:
 * same visualState + same poseKey → ambient-only refresh); a same-state
 * target with a NEW poseKey (§15.2 changePoseWithinActive) follows the
 * advanced.activityTransition switch — silent swap, the builtin:activity-swap
 * timeline, or a full enter; a visual-state change bumps the transition
 * generation, stops ambient, runs the enter transition (definition-driven;
 * pose swap happens on the scheduler's pose-swap event), then applies the new
 * ambient profile only if the transition completed.
 *
 * `play(definitionId)` is the §36 acceptance hatch: ANY registered
 * definition — built-in or user — instantiates and executes through the same
 * path with zero dedicated branches. playInteraction() (§28) rides on it.
 *
 * §23 hidden-tab policy: pause()/resume() freeze ambient loops/timers and
 * in-flight play() instances in place (phase preserved — no restart jump on
 * return). An enter transition already in flight is finite (≤2000ms) and runs
 * to completion; if it completes while paused, its ambient restart is started
 * pre-paused by the AmbientEngine, so nothing animates while hidden.
 */
import { BUILTIN_ACTIVITY_SWAP, BUILTIN_CLICK_POP, transitionDefinitionId } from '../core/transition-presets'
import { stateSlotFor } from '../core/state-machine'
import type {
  MotionPetConfig,
  MotionTarget,
  PoseKey,
  ResolvedPose,
  StateAppearance,
  TransitionConfig,
  TransitionPreset,
} from '../core/types'
import { TRANSITION_DURATION_LIMITS, TRANSITION_STRENGTH_LIMITS } from '../core/types'
import { clamp } from './math'
import { AmbientEngine } from './ambient-engine'
import type { TimelineInstance } from './animation-handle'
import type { AnimationRegistry } from './animation-registry'
import { TimelineEngine, type PlayOptions } from './timeline-engine'
import { TransitionEngine } from './transition-engine'
import type { MotionStage } from './motion-stage'

export interface MotionDirectorOptions {
  stage: MotionStage
  registry: AnimationRegistry
  config: MotionPetConfig
  /** Pose fallback resolution (core/pose-resolver); null = no image imported. */
  resolvePose: (poseKey: PoseKey) => ResolvedPose | null
}

/** A fully resolved enter-transition request (preset already dereferenced). */
interface ResolvedEnter {
  definitionId: string
  strength: number
  durationMs: number
}

/** §15.2 'subtle' activity swap: the definition's own data, strength 1. */
const ACTIVITY_SWAP_ENTER: ResolvedEnter = {
  definitionId: BUILTIN_ACTIVITY_SWAP.id,
  strength: 1,
  durationMs: BUILTIN_ACTIVITY_SWAP.durationMs,
}

export class MotionDirector {
  private readonly options: MotionDirectorOptions
  private readonly engine: TimelineEngine
  private readonly transitions: TransitionEngine
  private readonly ambient: AmbientEngine
  private readonly playedInstances = new Set<TimelineInstance>()
  private current: MotionTarget | null = null
  private paused = false
  /** Settle-view of the in-flight enter transition (null = the stage is quiet). */
  private pendingTransition: Promise<void> | null = null
  /** Bumped per click interaction: only the latest flash may swap the pose back. */
  private interactionGeneration = 0
  /**
   * Asset URL the director last put on stage (completed enter or silent swap).
   * Used only to skip redundant silent swaps; sessions re-resolving poses on
   * config hot-edits converge the stage back via their own refresh pass.
   */
  private stagePoseUrl: string | null = null

  constructor(options: MotionDirectorOptions) {
    this.options = options
    this.engine = new TimelineEngine(options.stage, options.registry)
    this.transitions = new TransitionEngine(options.stage, this.engine)
    this.ambient = new AmbientEngine(options.stage, this.engine)
  }

  async setTarget(target: MotionTarget): Promise<void> {
    const previous = this.current
    this.current = target
    if (previous !== null && previous.visualState === target.visualState) {
      if (previous.poseKey === target.poseKey) {
        // §10.3: identical visual target (e.g. streaming activity changes that
        // only swap ActivityMode) never re-triggers a transition.
        this.refreshAmbient()
        return
      }
      // §15.2 changePoseWithinActive: same visual state, new pose. The
      // advanced.activityTransition switch picks how it animates (read live
      // off the shared config object, like the resolver reads its flags):
      // 'none' swaps silently, 'subtle' plays builtin:activity-swap through
      // the normal TransitionEngine path, 'state' replays the full enter.
      const activityTransition = this.options.config.advanced.activityTransition
      if (activityTransition === 'state') {
        await this.runEnter(target)
        return
      }
      if (activityTransition === 'subtle') {
        await this.runEnter(target, ACTIVITY_SWAP_ENTER)
        return
      }
      this.swapPoseSilently(target)
      return
    }
    await this.runEnter(target)
  }

  /** Replays the current state's enter transition (settings preview, §17.6). */
  async replayEnter(): Promise<void> {
    if (this.current === null) return
    await this.runEnter(this.current)
  }

  /** Re-applies the ambient profile of the current target. */
  refreshAmbient(): void {
    if (this.current === null) return
    this.ambient.apply(this.appearanceFor(this.current).ambient)
  }

  /**
   * The current visual target (read-only). Config editors re-resolve poses
   * against this target's poseKey: the pose on stage may carry a FALLBACK
   * source key, while the target keeps the requested one.
   */
  get currentTarget(): MotionTarget | null {
    return this.current
  }

  /** True while an enter transition (setTarget/replayEnter) is in flight. */
  get transitionInFlight(): boolean {
    return this.pendingTransition !== null
  }

  /**
   * Resolves once the in-flight enter transition settles — completed OR
   * superseded (an interrupted play resolves false, which still settles
   * waiters). With no transition in flight it resolves immediately.
   */
  whenSettled(): Promise<void> {
    return this.pendingTransition ?? Promise.resolve()
  }

  stop(): void {
    this.transitions.cancel()
    this.ambient.stop()
  }

  /**
   * §23: freeze everything the director owns, preserving ambient phase.
   * Instances handed out by play() are tracked so an interaction in flight
   * pauses too; anything started while paused begins pre-paused.
   */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.ambient.pause()
    for (const instance of this.playedInstances) instance.pause()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.ambient.resume()
    for (const instance of this.playedInstances) instance.resume()
  }

  dispose(): void {
    this.stop()
    for (const instance of this.playedInstances) instance.dispose()
    this.playedInstances.clear()
  }

  /**
   * §36 acceptance: `registry.register(custom); director.play(custom.id)`
   * executes any valid definition with no special-casing. Particle events on
   * the played definition (interactions may declare them, §8.5) are forwarded
   * to the stage's particle layer; a caller-provided onEvent still runs.
   */
  play(definitionId: string, options: PlayOptions = {}): TimelineInstance {
    const instance = this.engine.play(definitionId, {
      ...options,
      onEvent: (event) => {
        if (event.type === 'particle') this.options.stage.emitParticle?.(event.effect)
        options.onEvent?.(event)
      },
    })
    this.playedInstances.add(instance)
    // play() was already called by the engine; the second call returns the
    // same (never-rejecting) completion promise — used here only for cleanup.
    void instance.play().finally(() => {
      this.playedInstances.delete(instance)
    })
    if (this.paused) instance.pause()
    return instance
  }

  /**
   * §15.2 silent pose change (the activityTransition='none' path): the target
   * keeps the current visual state but carries a new poseKey. Any in-flight enter transition is invalidated via
   * the generation guard (cancel bumps it), so its pose-swap event can never
   * fire and its ambient restart is skipped; the new pose is swapped directly
   * (skipped when the resolved asset URL is already on stage) and the new
   * activity's ambient profile applies. No transition instance is created and
   * nothing is tracked in pendingTransition: a silent swap is not a
   * transition, so whenSettled()/transitionInFlight ignore it. Preloading is
   * not needed here — sessions boot-preload every resolvable pose (§16.3).
   */
  private swapPoseSilently(target: MotionTarget): void {
    this.transitions.cancel()
    const pose = this.options.resolvePose(target.poseKey)
    if (pose !== null && pose.asset.url !== this.stagePoseUrl) {
      this.options.stage.swapPose(pose)
      this.stagePoseUrl = pose.asset.url
    }
    this.refreshAmbient()
  }

  private async runEnter(target: MotionTarget, enterOverride?: ResolvedEnter): Promise<void> {
    this.ambient.stop()
    const pose = this.options.resolvePose(target.poseKey)
    if (pose === null) {
      // No image imported at all (§2.1): nothing to show, ambient pointless.
      return
    }
    const enter = enterOverride ?? this.resolveEnter(this.appearanceFor(target).enter)
    const playing = this.transitions.play({
      pose,
      definitionId: enter.definitionId,
      params: { strength: enter.strength },
      durationMs: enter.durationMs,
    })
    // Track the settle so config hot-edits can wait out a transition whose
    // pose-swap event still carries pre-edit values. A superseded play
    // resolves false (or an unknown definition rejects): both settle waiters.
    const tracked = playing.then(
      () => undefined,
      () => undefined,
    )
    this.pendingTransition = tracked
    void tracked.finally(() => {
      if (this.pendingTransition === tracked) this.pendingTransition = null
    })
    const completed = await playing
    if (!completed) return // superseded: an interrupted transition must not restart ambient (§10.2)
    // A completed enter always fired its pose-swap event: record what the
    // stage shows so silent swaps can skip a redundant swap.
    this.stagePoseUrl = pose.asset.url
    this.refreshAmbient()
  }

  private appearanceFor(target: MotionTarget): StateAppearance {
    const slot = stateSlotFor({ visualState: target.visualState, activityMode: target.activityMode })
    return this.options.config.states[slot]
  }

  /**
   * 'global' resolves through the global transition config; clamps per §7.4.
   * §8.14: an enter.animationId registered in the registry takes priority over
   * the preset mapping; a dangling id (deleted custom animation) falls back to
   * the preset. Either way the state's strength/durationMs still override.
   */
  private resolveEnter(enter: TransitionConfig): ResolvedEnter {
    const globalTransition = this.options.config.global.transition
    const preset: Exclude<TransitionPreset, 'global'> = enter.preset === 'global' ? globalTransition.preset : enter.preset
    const strength = enter.preset === 'global' ? globalTransition.strength : enter.strength
    const durationMs = enter.preset === 'global' ? globalTransition.durationMs : enter.durationMs
    const override = enter.animationId === undefined ? undefined : this.options.registry.get(enter.animationId)
    return {
      definitionId: override?.id ?? transitionDefinitionId(preset),
      strength: clamp(strength, TRANSITION_STRENGTH_LIMITS.min, TRANSITION_STRENGTH_LIMITS.max),
      durationMs: clamp(durationMs, TRANSITION_DURATION_LIMITS.min, TRANSITION_DURATION_LIMITS.max),
    }
  }

  /**
   * §28 click interaction. Plays the configured interaction animation through
   * the zero-branch play() path — an unknown id or a non-interaction kind
   * falls back to builtin:click-pop (the host validates shape only).
   *
   * When interactions.click.pose is set and resolves to an image, the stage
   * wears that pose for the animation's duration and returns to the CURRENT
   * target's pose once the instance finishes (await-driven, never a bare
   * setTimeout). Preemption: a real target arriving mid-flash bumps the
   * transition generation (runEnter/swapPoseSilently), which skips the
   * swap-back — the new state's own path decides the pose. A newer click also
   * supersedes an in-flight flash via interactionGeneration.
   */
  async playInteraction(): Promise<void> {
    const click = this.options.config.interactions.click
    const configured = this.options.registry.get(click.animation)
    const definitionId = configured !== undefined && configured.kind === 'interaction' ? configured.id : BUILTIN_CLICK_POP.id

    const interactionGeneration = ++this.interactionGeneration
    const transitionGeneration = this.transitions.currentGeneration
    const flashPose = click.pose === null ? null : this.options.resolvePose(click.pose)
    if (flashPose !== null && flashPose.asset.url !== this.stagePoseUrl) {
      // Keep stagePoseUrl equal to what the stage actually shows, so a silent
      // swap landing mid-flash cannot skip a needed swap (or vice versa).
      this.options.stage.swapPose(flashPose)
      this.stagePoseUrl = flashPose.asset.url
    }

    const instance = this.play(definitionId)
    await instance.play()
    if (flashPose === null) return // no flash requested or resolvable: nothing to restore
    if (instance.status !== 'finished') return // cancelled (dispose): leave the stage alone
    if (interactionGeneration !== this.interactionGeneration) return // a newer click owns the restore
    if (transitionGeneration !== this.transitions.currentGeneration) return // preempted by a real target
    const restore = this.current === null ? null : this.options.resolvePose(this.current.poseKey)
    if (restore === null || restore.asset.url === this.stagePoseUrl) return
    this.options.stage.swapPose(restore)
    this.stagePoseUrl = restore.asset.url
  }
}
