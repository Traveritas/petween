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
 * in-flight play() instances AND enter transitions in place (phase preserved —
 * no restart jump on a return). Anything started while paused begins
 * pre-paused, so nothing animates while hidden; an enter that completes only
 * after resume restarts its ambient then, already unpaused.
 */
import { BUILTIN_ACTIVITY_SWAP, BUILTIN_CLICK_POP, transitionDefinitionId } from '../core/transition-presets'
import { stateSlotFor } from '../core/state-machine'
import type {
  PetweenConfig,
  MotionTarget,
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
import type { MotionStage } from './motion-stage'
import { TimelineEngine, type PlayOptions } from './timeline-engine'
import { TransitionEngine } from './transition-engine'

export interface MotionDirectorOptions {
  stage: MotionStage
  registry: AnimationRegistry
  config: PetweenConfig
  /**
   * Pose resolution (core/pose-resolver plus the session's external poses);
   * null = no image imported. Widened from PoseKey to string (2026-08-27):
   * interaction animations may name `user:` pose targets in their pose-swap
   * events, resolved at play time through this seam. Builtin-slot strings
   * keep their fallback-chain semantics.
   */
  resolvePose: (poseKey: string) => ResolvedPose | null
  /**
   * External pose-hold ledger (the overlay session's attachment flashPose):
   * returns the pose a hold is currently showing, or null when no hold is
   * active. playInteraction's restore consults it so a click never cuts a
   * pending hold short — the click returns to the HELD pose and the hold's
   * own restore (its timer, or the next state change) realigns afterwards.
   * Optional: without it the restore keeps its original semantics.
   */
  getExternalPoseHold?: () => ResolvedPose | null
  /**
   * Playback lifecycle observer (the extension service's animation event
   * stream): fired at the start and settle of every playback the director
   * owns — enter transitions, click interactions, and external play() calls.
   * Settle fires for cancelled runs too (status 'cancelled'), so companions
   * can always pair their starts. Optional; purely observational.
   */
  onPlayback?: (event: DirectorPlaybackEvent) => void
}

/** Who started a playback (the animation event stream's attribution). */
export type PlaybackSource = 'enter' | 'interaction' | 'external'

export interface DirectorPlaybackEvent {
  phase: 'start' | 'settle'
  source: PlaybackSource
  definitionId: string
  /** Settle only: ran to completion vs cancelled/superseded. */
  status?: 'finished' | 'cancelled'
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

/**
 * §23: the transition path's engine view. TransitionEngine.play creates its
 * TimelineInstance internally (generation guard + pose-swap events), so the
 * director cannot reach it through the play() bookkeeping — this view reports
 * every created instance back, letting pause()/resume() freeze an in-flight
 * enter transition exactly like play() instances. Pure side channel: it adds
 * the registration and changes no execution semantics.
 */
class EnterReportingEngine extends TimelineEngine {
  private readonly reportInstance: (instance: TimelineInstance) => void

  constructor(
    stage: MotionStage,
    registry: AnimationRegistry,
    reportInstance: (instance: TimelineInstance) => void,
  ) {
    super(stage, registry)
    this.reportInstance = reportInstance
  }

  override createInstance(definitionId: string, options: PlayOptions = {}): TimelineInstance {
    const instance = super.createInstance(definitionId, options)
    this.reportInstance(instance)
    return instance
  }
}

export class MotionDirector {
  private readonly options: MotionDirectorOptions
  private readonly engine: TimelineEngine
  private readonly transitions: TransitionEngine
  private readonly ambient: AmbientEngine
  private readonly playedInstances = new Set<TimelineInstance>()
  private current: MotionTarget | null = null
  /**
   * External target observers (the overlay session's snapshot notifications).
   * Notified synchronously on every `current` assignment — setTarget is the
   * only writer, so one hook covers every path.
   */
  private readonly targetListeners = new Set<(target: MotionTarget | null) => void>()
  private paused = false
  /** Settle-view of the in-flight enter transition (null = the stage is quiet). */
  private pendingTransition: Promise<void> | null = null
  /**
   * The in-flight enter transition's instance (§23 pause coverage). The
   * TransitionEngine creates it internally; the EnterReportingEngine view
   * reports it here so pause()/resume() can freeze it like any play()
   * instance. Null whenever no enter transition is running.
   */
  private enterInstance: TimelineInstance | null = null
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
    this.transitions = new TransitionEngine(
      options.stage,
      new EnterReportingEngine(options.stage, options.registry, (instance) => {
        this.enterInstance = instance
      }),
    )
    this.ambient = new AmbientEngine(options.stage, this.engine, options.registry)
  }

  async setTarget(target: MotionTarget): Promise<void> {
    const previous = this.current
    this.current = target
    this.notifyTarget(target)
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

  /**
   * Subscribe to target changes: fired synchronously at every `current`
   * assignment. Null never occurs today (setTarget never clears) — the type
   * keeps the door open for a future clear-on-dispose without breaking
   * listeners. Listeners must not call back into the director synchronously.
   */
  subscribeTarget(listener: (target: MotionTarget | null) => void): () => void {
    this.targetListeners.add(listener)
    return () => {
      this.targetListeners.delete(listener)
    }
  }

  private notifyTarget(target: MotionTarget | null): void {
    if (this.targetListeners.size === 0) return
    for (const listener of [...this.targetListeners]) listener(target)
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
    this.invalidateEnterTransition()
    this.ambient.stop()
  }

  /**
   * §23: freeze everything the director owns, preserving ambient phase.
   * Instances handed out by play() are tracked so an interaction in flight
   * pauses too; anything started while paused begins pre-paused — including
   * enter transitions started by setTarget/replayEnter while hidden.
   */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.ambient.pause()
    for (const instance of this.playedInstances) instance.pause()
    this.enterInstance?.pause()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.ambient.resume()
    for (const instance of this.playedInstances) instance.resume()
    this.enterInstance?.resume()
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
   * The source only feeds playback attribution (the onPlayback observer).
   */
  play(definitionId: string, options: PlayOptions = {}, source: 'external' | 'interaction' = 'external'): TimelineInstance {
    const instance = this.engine.play(definitionId, {
      ...options,
      onEvent: (event) => {
        if (event.type === 'particle') this.options.stage.emitParticle?.(event.effect)
        options.onEvent?.(event)
      },
    })
    // Start is announced only once the instance exists — engine.play throws
    // synchronously on a registry miss, and an emitted start must always
    // have the settle in the finally below to pair it.
    this.notifyPlayback({ phase: 'start', source, definitionId })
    this.playedInstances.add(instance)
    // play() was already called by the engine; the second call returns the
    // same (never-rejecting) completion promise — used here only for cleanup.
    void instance.play().finally(() => {
      this.playedInstances.delete(instance)
      this.notifyPlayback({
        phase: 'settle',
        source,
        definitionId,
        status: instance.status === 'finished' ? 'finished' : 'cancelled',
      })
    })
    if (this.paused) instance.pause()
    return instance
  }

  /** The onPlayback observer fan-out (absent by default — zero overhead). */
  private notifyPlayback(event: DirectorPlaybackEvent): void {
    this.options.onPlayback?.(event)
  }

  /**
   * External preemption of the in-flight enter transition (the extension
   * service's interrupt path): same §10.2 invalidation a real target or a
   * silent swap performs — the interrupted timeline can neither swap the pose
   * nor restart ambient. A no-op when the stage is quiet: a spurious
   * generation bump would needlessly invalidate live guards (e.g. a click
   * flash restore riding on the same generation).
   */
  interruptEnterTransition(): void {
    if (this.pendingTransition === null) return
    this.invalidateEnterTransition()
  }

  /**
   * Land the CURRENT target after an external interrupt invalidated its
   * in-flight enter transition (the overlay session's interrupt path): swap
   * the stage to the target's resolved pose through the silent-swap path
   * (same pose-ledger bookkeeping, same skip guard) and re-apply its ambient
   * profile. This is the DIRECTOR settling after the interrupt, not the
   * interrupted timeline swapping the pose — cancel() already guarantees the
   * timeline can do neither (§10.2); without the settle the interrupted
   * enter's target would simply be abandoned: stale pose on stage, ambient
   * silent (runEnter stops it first and never restarts after a cancel), and
   * a later same-shape target cannot heal it (§10.3 dedupe swaps nothing).
   *
   * Self-guarded like interruptEnterTransition: with no transition in flight
   * it is a no-op — the silent-swap path would bump the generation for no
   * reason and needlessly invalidate live guards (e.g. a click flash
   * restore). Interrupt-then-settle in one tick still passes: the pending
   * promise is cleared on a later microtask, after this call.
   */
  settleCurrentTarget(): void {
    if (this.pendingTransition === null) return
    if (this.current === null) return
    this.swapPoseSilently(this.current)
  }

  /**
   * Pose-ledger hook for external stage writers (the overlay session's
   * flashPose and its restore): records that `url` is what the stage shows
   * now. Without the note, a flash followed by a same-URL silent swap would
   * trip the skip guard in swapPoseSilently and strand the flashed image
   * (the M2 drift) — playInteraction already keeps the ledger honest for its
   * own flash; this is the same bookkeeping for out-of-band writers.
   */
  noteExternalPose(url: string): void {
    this.stagePoseUrl = url
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
    this.invalidateEnterTransition()
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
      // Ledger write-back at swap time, not completion: an enter interrupted
      // during its post segment has already put the new image on stage, and
      // the silent-swap skip guard must compare against that fact.
      onSwap: () => {
        this.stagePoseUrl = pose.asset.url
      },
    })
    // Start is announced only once the instance exists: a synchronous
    // createInstance throw (unknown definition id) must not leave an orphan
    // start with no settle to pair it — the tracked promise below is also
    // never installed in that case.
    this.notifyPlayback({ phase: 'start', source: 'enter', definitionId: enter.definitionId })
    // The transition engine created AND started its instance synchronously;
    // freeze it straight away when the director is paused (§23 — the same
    // contract play() applies to its instances).
    const enterInstance = this.enterInstance
    if (this.paused && enterInstance !== null) enterInstance.pause()
    // Track the settle so config hot-edits can wait out a transition whose
    // pose-swap event still carries pre-edit values. A superseded play
    // resolves false (or an unknown definition rejects): both settle waiters.
    const tracked = playing.then(
      (completed) => {
        this.notifyPlayback({
          phase: 'settle',
          source: 'enter',
          definitionId: enter.definitionId,
          status: completed ? 'finished' : 'cancelled',
        })
      },
      () => {
        this.notifyPlayback({ phase: 'settle', source: 'enter', definitionId: enter.definitionId, status: 'cancelled' })
      },
    )
    this.pendingTransition = tracked
    void tracked.finally(() => {
      if (this.pendingTransition === tracked) this.pendingTransition = null
      if (this.enterInstance === enterInstance) this.enterInstance = null
    })
    const completed = await playing
    if (!completed) return // superseded: an interrupted transition must not restart ambient (§10.2)
    // Redundant with the swap-time ledger write in most runs, but idempotent —
    // kept so a completed enter always converges the ledger even if a future
    // event path skips onSwap.
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
   * the preset mapping; a dangling id (deleted custom animation) OR a
   * non-transition kind (an enter must fire pose-swap, §12) falls back to the
   * preset. Either way the state's strength/durationMs still override.
   */
  private resolveEnter(enter: TransitionConfig): ResolvedEnter {
    const globalTransition = this.options.config.global.transition
    const preset: Exclude<TransitionPreset, 'global'> = enter.preset === 'global' ? globalTransition.preset : enter.preset
    const strength = enter.preset === 'global' ? globalTransition.strength : enter.strength
    const durationMs = enter.preset === 'global' ? globalTransition.durationMs : enter.durationMs
    const candidate = enter.animationId === undefined ? undefined : this.options.registry.get(enter.animationId)
    // A repeating transition (loop/alternate/random-interval) never settles —
    // the scheduler replays its (mandatory) pose-swap event forever — so an
    // enter mounted on it would await forever: ambient stays stopped,
    // transitionInFlight stays true, whenSettled() hangs until the next
    // setTarget preempts. Only a 'once' candidate may drive an enter.
    const override = candidate?.kind === 'transition' && candidate.repeat.mode === 'once' ? candidate : undefined
    return {
      definitionId: override?.id ?? transitionDefinitionId(preset),
      strength: clamp(strength, TRANSITION_STRENGTH_LIMITS.min, TRANSITION_STRENGTH_LIMITS.max),
      durationMs: clamp(durationMs, TRANSITION_DURATION_LIMITS.min, TRANSITION_DURATION_LIMITS.max),
    }
  }

  /**
   * §28 click interaction. Plays the configured interaction animation through
   * the zero-branch play() path — an unknown id, a non-interaction kind, or a
   * repeating definition falls back to builtin:click-pop (the host validates
   * shape only).
   *
   * When interactions.click.pose is set and resolves to an image, the stage
   * wears that pose for the animation's duration and returns to the CURRENT
   * target's pose once the instance finishes (await-driven, never a bare
   * setTimeout). With interactions.click.honorAnimationPoseSwap the
   * animation's own named pose-swap events swap the stage the same way
   * (latest swap wins; one restore at settle). Preemption: a real target
   * arriving mid-flash bumps the transition generation
   * (runEnter/swapPoseSilently), which skips the swap-back — the new state's
   * own path decides the pose. A newer click also supersedes an in-flight
   * flash via interactionGeneration.
   */
  async playInteraction(): Promise<void> {
    const click = this.options.config.interactions.click
    const configured = this.options.registry.get(click.animation)
    // Same once-only discipline as resolveEnter: a repeating interaction
    // (loop/alternate/random-interval) never settles, so the await below
    // would hang forever — the flash pose never restores and the instance
    // never leaves playedInstances. Only a 'once' candidate may play.
    const definitionId =
      configured !== undefined && configured.kind === 'interaction' && configured.repeat.mode === 'once'
        ? configured.id
        : BUILTIN_CLICK_POP.id

    const interactionGeneration = ++this.interactionGeneration
    // §10.2 guard over the transition generation: a real target arriving
    // mid-flash (runEnter/swapPoseSilently/external interrupt bumps it)
    // preempts the swap-back below.
    const enterGuard = this.captureEnterGuard()
    const flashPose = click.pose === null ? null : this.options.resolvePose(click.pose)
    if (flashPose !== null && flashPose.asset.url !== this.stagePoseUrl) {
      // Keep stagePoseUrl equal to what the stage actually shows, so a silent
      // swap landing mid-flash cannot skip a needed swap (or vice versa).
      this.options.stage.swapPose(flashPose)
      this.stagePoseUrl = flashPose.asset.url
    }

    // Opt-in (interactions.click.honorAnimationPoseSwap): the animation's own
    // named pose-swap events swap the stage for the run's duration — the same
    // swap/restore contract as the config flash pose above (latest swap wins,
    // one restore at the end under the same preemption guards). Off by
    // default: a click animation authored for external play may carry swaps
    // the click feel shouldn't perform.
    let swappedPose: ResolvedPose | null = null
    const instance = this.play(
      definitionId,
      click.honorAnimationPoseSwap
        ? {
            onEvent: (event) => {
              if (event.type !== 'pose-swap' || event.pose === undefined) return
              const pose = this.options.resolvePose(event.pose)
              if (pose === null) return // dangling target: skip (fallback discipline)
              swappedPose = pose
              if (pose.asset.url !== this.stagePoseUrl) {
                this.options.stage.swapPose(pose)
                this.stagePoseUrl = pose.asset.url
              }
            },
          }
        : {},
      'interaction',
    )
    await instance.play()
    if (flashPose === null && swappedPose === null) return // nothing was swapped: nothing to restore
    if (instance.status !== 'finished') return // cancelled (dispose): leave the stage alone
    if (interactionGeneration !== this.interactionGeneration) return // a newer click owns the restore
    if (!enterGuard.isCurrent()) return // preempted by a real target
    // An external flash hold (attachment flashPose) owns the stage pose: the
    // click returns to the HELD pose — never the state machine's pose — and
    // the hold's own restore (timer or next state change) realigns later.
    const held = this.options.getExternalPoseHold?.() ?? null
    if (held !== null) {
      if (held.asset.url !== this.stagePoseUrl) {
        this.options.stage.swapPose(held)
        this.stagePoseUrl = held.asset.url
      }
      return
    }
    const restore = this.current === null ? null : this.options.resolvePose(this.current.poseKey)
    if (restore === null || restore.asset.url === this.stagePoseUrl) return
    this.options.stage.swapPose(restore)
    this.stagePoseUrl = restore.asset.url
  }

  /**
   * §10.2 generation-guard token: captures the TransitionEngine's current
   * generation; isCurrent() flips false once any newer enter, a silent swap
   * or interruptEnterTransition() bumps it. playInteraction's flash restore
   * rides on this to detect preemption by a real target. Purely derived from
   * the engine — no extra director state.
   */
  private captureEnterGuard(): { isCurrent(): boolean } {
    const generation = this.transitions.currentGeneration
    return { isCurrent: () => generation === this.transitions.currentGeneration }
  }

  /**
   * §10.2 invalidation, the shared preemption path: bump the engine's
   * generation and cancel its active instance. The interrupted timeline can
   * then neither fire its pose-swap event (engine event guard) nor resolve
   * completed (its play resolves false), so runEnter skips the ambient
   * restart. Used by stop()/swapPoseSilently() and the public
   * interruptEnterTransition().
   */
  private invalidateEnterTransition(): void {
    this.transitions.cancel()
    this.enterInstance = null
  }
}
