/**
 * client/overlay-session.ts — the shell.overlay controller. Binds a live
 * PetStage to the motion stack for the REAL overlay and, since M4, to the
 * DSH agent state: once the pet is on stage it owns a DshStateSource
 * (integration/dsh) that drives the MotionDirector through the SSE channel.
 *
 * Owns the SESSION domain: registry/director lifecycle, boot preload + idle
 * target, shared-config application (config-hub publishes), the §22
 * reduced-motion policy (matchMedia + config override; the stage never
 * listens itself), the §23 visibility policy (director.pause/resume —
 * ambient phase preserved), drag position persistence (§27: debounced PUT +
 * hub broadcast), the §28 click interaction, and window-resize re-clamping.
 *
 * Since C1-B the COMPANION domain (stage snapshots, the five observational
 * streams, external playback, the pose channel, the position-driver lease,
 * the playback/registry probes) lives in overlay/extension-surface.ts; this
 * class hosts it through the ExtensionSurfaceHost seam and re-exposes it
 * verbatim (the petween/client windows must not change shape).
 */
import { createPoseResolver } from '../core/pose-resolver'
import { BUILTIN_INTERACTION_DEFINITIONS } from '../core/transition-presets'
import type { AssetMeta, PetweenConfig, PoseKey, ResolvedPose } from '../core/types'
import { DshStateSource, getCurrentSessionSource } from '../integration/dsh/dsh-state-source'
import { createBuiltinRegistry, type AnimationRegistry } from '../motion/animation-registry'
import { MotionDirector } from '../motion/motion-director'
import type { TimelineInstance } from '../motion/animation-handle'
import { patchConfig as httpPatchConfig, type ConfigPatch } from './api'
import type { ConfigHub, ConfigSnapshot } from './config-hub'
import { reconcileCustomAnimations } from './custom-animations'
import { adoptConfigFields, collectBootPoses, effectiveReducedMotion, refreshTargetPose } from './session-core'
import type {
  AnimationSummary,
  ExternalPoseDefinition,
  PlayAnimationOptions,
  PlayState,
  PositionDriver,
  StageSnapshot,
  UserPointerEvent,
} from './overlay/session-surface'
import type { DirectorPlaybackEvent } from '../motion/motion-director'
import { ExtensionSurface } from './overlay/extension-surface'
import { DragController } from './overlay/drag-controller'
import { clampStagePosition, DEFAULT_OVERLAY_MARGIN, type PetStage } from './overlay/pet-stage'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** §21-style debounce for the drag-end position write. */
const DEFAULT_POSITION_SAVE_DEBOUNCE_MS = 300

/** Anything the overlay needs from the M4 agent-state source. */
export interface OverlayStateSourceHandle {
  dispose(): void
  /** Hot-applies §14.5 aggregate TTLs (success/error holds) after a live config edit. */
  setTerminalTtls?(successMs: number, errorMs: number): void
  /** §14.4: a pet click releases a held success/error face; no-op otherwise. */
  dismissTerminal?(): void
}

export interface OverlaySessionOptions {
  stage: PetStage
  /** The shared hub; must already be loaded (PetOverlay guarantees this). */
  hub: ConfigHub
  /**
   * Position persistence seam; production hits the real HTTP API. Sends a
   * partial patch (the host merges + serializes), resolves the full config.
   */
  patchConfig?: (patch: ConfigPatch) => Promise<PetweenConfig>
  registry?: AnimationRegistry
  positionSaveDebounceMs?: number
  /**
   * M4 seam: builds the agent-state source once the pet is on stage. The
   * default constructs the real DshStateSource wired to the SSE channel;
   * without an EventSource (non-browser test envs) it returns null and the
   * pet simply keeps its idle face (the M3 behavior).
   */
  createStateSource?: (director: MotionDirector, config: PetweenConfig) => OverlayStateSourceHandle | null
}

const defaultCreateStateSource = (
  director: MotionDirector,
  config: PetweenConfig,
): OverlayStateSourceHandle | null => {
  if (typeof EventSource !== 'function') return null
  return new DshStateSource({ config, director, sessionSource: getCurrentSessionSource() ?? undefined })
}

/** config.overlay → px position; null means the §27 default corner. */
function readOverlayPosition(config: PetweenConfig): { x: number; y: number } | null {
  const { x, y } = config.overlay
  return x === null || y === null ? null : { x, y }
}

export class OverlaySession {
  readonly registry: AnimationRegistry
  readonly director: MotionDirector
  readonly drag: DragController
  /** The companion-facing windows (C1-B); this class is its host. */
  private readonly surface: ExtensionSurface

  /** Public for the ExtensionSurfaceHost seam (C1-B); not consumer API. */
  readonly stage: PetStage
  /** Public for the ExtensionSurfaceHost seam (C1-B); not consumer API. */
  readonly hub: ConfigHub
  private readonly patchConfig: (patch: ConfigPatch) => Promise<PetweenConfig>
  private readonly positionSaveDebounceMs: number
  private readonly createStateSource: (director: MotionDirector, config: PetweenConfig) => OverlayStateSourceHandle | null
  private readonly unsubscribeHub: () => void
  private readonly config: PetweenConfig
  private assets: Record<string, AssetMeta>
  private resolvePose: (poseKey: PoseKey) => ResolvedPose | null
  private mediaQuery: MediaQueryList | null = null
  private stateSource: OverlayStateSourceHandle | null = null
  private position: { x: number; y: number } | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveInFlight = false
  private hidden = false
  private disposed = false
  private started = false
  private poseRefreshSeq = 0
  /** The latest hub-driven updateConfig run; resyncAnimations awaits it. */
  private pendingUpdate: Promise<void> = Promise.resolve()

  constructor(options: OverlaySessionOptions) {
    const snapshot = options.hub.getCurrent()
    if (snapshot === null) throw new Error('OverlaySession: the config hub must be loaded first')
    this.stage = options.stage
    this.hub = options.hub
    this.patchConfig = options.patchConfig ?? (async (patch) => (await httpPatchConfig(patch)).config)
    this.positionSaveDebounceMs = options.positionSaveDebounceMs ?? DEFAULT_POSITION_SAVE_DEBOUNCE_MS
    this.createStateSource = options.createStateSource ?? defaultCreateStateSource
    // Own copies: the hub replaces its cached objects on every publish, so the
    // director's config object must be session-owned and field-updated (same
    // trick as PreviewSession.updateConfig).
    this.config = structuredClone(snapshot.config)
    this.assets = { ...snapshot.assets }
    this.resolvePose = createPoseResolver(this.config.poses, this.assets)

    this.registry = options.registry ?? createBuiltinRegistry()
    // §28 click feedback is interaction data (core/transition-presets) and is
    // not part of the transition/ambient builtin arrays — register it here.
    for (const definition of BUILTIN_INTERACTION_DEFINITIONS) {
      if (this.registry.get(definition.id) === undefined) this.registry.registerBuiltin(definition)
    }
    this.syncCustoms(snapshot.customs)

    // C1-B construction order: the surface exists first (its stage-side
    // wiring has no director dependency), the director's seams call INTO it,
    // and only then does the target stream attach. Every director read on
    // the surface happens lazily after this constructor finished.
    this.surface = new ExtensionSurface(this)
    this.director = new MotionDirector({
      stage: options.stage,
      registry: this.registry,
      config: this.config,
      // Indirection: updateConfig swaps the resolver on config changes. The
      // seam accepts strings: builtin slots (fallback chains) plus the
      // external poses registered through the extension service.
      resolvePose: (poseKey) => this.surface.resolvePoseAny(poseKey),
      // Pose-hold ledger: while an attachment's flashPose hold is active, a
      // click interaction's restore returns to the HELD pose instead of
      // cutting the hold short (M3); the hold's own restore realigns.
      getExternalPoseHold: () => this.surface.activeExternalPoseHold(),
      // Animation lifecycle stream (the service's subscribeAnimation).
      onPlayback: (event) => this.surface.notifyAnimation(event),
    })
    this.surface.attachDirector(this.director)

    this.position = readOverlayPosition(this.config)
    this.stage.setUserScale(this.config.global.scale)
    this.applyPosition()

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
      this.mediaQuery.addEventListener('change', this.handleMediaChange)
    }
    this.applyReducedMotion()
    this.stage.setParticlesEnabled(this.config.advanced.particles)

    this.drag = new DragController({
      handle: this.stage.interactiveElement,
      stageSize: () => this.stage.visibleSize,
      getPosition: () => this.position ?? this.defaultPositionPx(),
      onMove: (x, y) => {
        this.position = { x, y }
        this.stage.setPosition(x, y)
        this.surface.notifySnapshot()
      },
      onDragStart: () => this.surface.notifyDragGesture('start'),
      onDragEnd: () => {
        this.surface.notifyDragGesture('end')
        this.schedulePositionSave()
      },
      onClick: (x, y) => {
        this.surface.notifyClick(x, y)
        this.clickPop()
      },
    })

    // §28 + a11y: the hit region is focusable (role=button, tabindex=0 on the
    // stage); Enter/Space trigger the exact same interaction as a pointer
    // click, without modifiers and with the default (scroll) suppressed.
    this.stage.interactiveElement.addEventListener('keydown', this.handleInteractiveKeydown)

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleResize)
    }
    this.unsubscribeHub = this.hub.subscribe((next) => {
      this.pendingUpdate = this.updateConfig(next).catch((error: unknown) => {
        console.error('petween: failed to apply a config update', error)
      })
    })
  }

  // --- ExtensionSurfaceHost (structural; consumed by the surface) ---

  isDisposed(): boolean {
    return this.disposed
  }

  isStarted(): boolean {
    return this.started
  }

  resolveBuiltinPose(poseKey: PoseKey): ResolvedPose | null {
    return this.resolvePose(poseKey)
  }

  positionPx(): { x: number; y: number } {
    return this.position ?? this.defaultPositionPx()
  }

  currentScale(): number {
    return this.config.global.scale
  }

  /**
   * Driver position write: clamp BEFORE storing (§27) — the stage re-clamps
   * on apply, but this.position must never hold an off-screen value a later
   * commit would persist. Same visible-size basis the stage itself uses, so
   * memory and DOM agree at any scale.
   */
  applyExternalPosition(x: number, y: number): boolean {
    const clamped = clampStagePosition(x, y, this.stage.visibleSize, window.innerWidth, window.innerHeight)
    this.position = clamped
    this.stage.setPosition(clamped.x, clamped.y)
    return true
  }

  cancelPendingPositionSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  persistPositionNow(): Promise<void> {
    return this.persistPosition()
  }

  awaitPendingUpdate(): Promise<void> {
    return this.pendingUpdate
  }

  // --- Companion windows (thin re-exposure of the surface; shapes frozen) ---

  getStageSnapshot(): StageSnapshot | null {
    return this.surface.getStageSnapshot()
  }

  subscribeSnapshot(listener: (snapshot: StageSnapshot) => void): () => void {
    return this.surface.subscribeSnapshot(listener)
  }

  subscribeUserDrag(listener: (phase: 'start' | 'end') => void): () => void {
    return this.surface.subscribeUserDrag(listener)
  }

  subscribePose(listener: (pose: ResolvedPose) => void): () => void {
    return this.surface.subscribePose(listener)
  }

  /** The pose currently on stage (the display truth, post-fallback/flash). */
  get displayedPose(): ResolvedPose | null {
    return this.surface.displayedPose
  }

  subscribeUserPointer(listener: (event: UserPointerEvent) => void): () => void {
    return this.surface.subscribeUserPointer(listener)
  }

  subscribeAnimation(listener: (event: DirectorPlaybackEvent) => void): () => void {
    return this.surface.subscribeAnimation(listener)
  }

  flashPose(poseKey: string, holdMs: number): boolean {
    return this.surface.flashPose(poseKey, holdMs)
  }

  flashAsset(pose: Omit<ExternalPoseDefinition, 'id'>, holdMs: number): boolean {
    return this.surface.flashAsset(pose, holdMs)
  }

  registerPoses(definitions: ExternalPoseDefinition[]): boolean {
    return this.surface.registerPoses(definitions)
  }

  unregisterPoses(ids: string[]): void {
    this.surface.unregisterPoses(ids)
  }

  createPositionDriver(): PositionDriver | null {
    return this.surface.createPositionDriver()
  }

  playExternal(id: string, options?: PlayAnimationOptions): TimelineInstance | null {
    return this.surface.playExternal(id, options)
  }

  isPlaying(): PlayState {
    return this.surface.isPlaying()
  }

  listAnimations(): AnimationSummary[] {
    return this.surface.listAnimations()
  }

  async resyncAnimations(): Promise<void> {
    await this.surface.resyncAnimations()
  }

  // --- Session domain ---

  /**
   * Boot: preload every resolvable pose (§16.3), then show idle. The target
   * goes straight to the director (reason 'session-switch') — it is the mount
   * bootstrap, not a semantic event, and must not consume the resolver's idle
   * dedupe (same contract as PreviewSession.start). No usable image (§2.1)
   * leaves the stage empty; a later hub publish retries via updateConfig.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return
    await this.stage.preload(collectBootPoses((key) => this.resolvePose(key)))
    if (this.disposed || this.started) return
    if (this.resolvePose(this.config.states.idle.pose) === null) return
    await this.director.setTarget({
      visualState: 'idle',
      poseKey: this.config.states.idle.pose,
      reason: 'session-switch',
    })
    if (this.disposed) return
    this.started = true
    this.reconcileStateSource()
    await this.refreshCurrentPose()
    this.surface.notifySnapshot()
  }

  /**
   * M4: the state source lives exactly while the pet is on stage and enabled
   * (spec: no SSE without a usable image or with enabled=false). Created
   * lazily after a successful boot; torn down live on a disable publish —
   * PetOverlay normally unmounts the whole session on either condition, so
   * this is the in-session backstop.
   */
  private reconcileStateSource(): void {
    const wanted = this.started && this.config.enabled && !this.disposed
    if (wanted && this.stateSource === null) {
      this.stateSource = this.createStateSource(this.director, this.config)
    } else if (!wanted && this.stateSource !== null) {
      this.stateSource.dispose()
      this.stateSource = null
    }
  }

  /**
   * Hub publish → hot-apply: re-resolve poses, follow scale/reduced-motion,
   * restart ambient only on a substantive states change, and follow a remotely
   * changed overlay position — unless a local drag/save currently owns it.
   */
  async updateConfig(snapshot: ConfigSnapshot): Promise<void> {
    if (this.disposed) return
    const previousStates = JSON.stringify(this.config.states)
    const previousReducedMotion = this.config.global.reducedMotion
    const previousScale = this.config.global.scale
    const previousSuccessHoldMs = this.config.global.successHoldMs
    const previousErrorHoldMs = this.config.global.errorHoldMs
    adoptConfigFields(this.config, snapshot.config)
    this.assets = { ...snapshot.assets }
    this.resolvePose = createPoseResolver(this.config.poses, this.assets)
    this.stage.setParticlesEnabled(this.config.advanced.particles)
    const customsChanged = this.syncCustoms(snapshot.customs)

    if (this.config.global.scale !== previousScale) this.stage.setUserScale(this.config.global.scale)
    if (this.config.global.reducedMotion !== previousReducedMotion) {
      this.applyReducedMotion()
    } else if (JSON.stringify(this.config.states) !== previousStates || customsChanged) {
      this.director.refreshAmbient()
    }

    // The state source reads the §14.5 holds once at construction; push edits.
    if (
      this.config.global.successHoldMs !== previousSuccessHoldMs ||
      this.config.global.errorHoldMs !== previousErrorHoldMs
    ) {
      this.stateSource?.setTerminalTtls?.(this.config.global.successHoldMs, this.config.global.errorHoldMs)
    }

    // A local drag, a pending debounced save, an in-flight save OR a live
    // position-driver lease means a local owner currently holds the position
    // — remote overlay coordinates (editor drag, another tab) must not yank
    // the pet out from under it.
    if (!this.drag.isDragging && this.saveTimer === null && !this.saveInFlight && !this.surface.hasPositionDriver()) {
      this.position = readOverlayPosition(this.config)
      this.applyPosition()
    }

    if (!this.started) {
      await this.start() // the first boot found no image; retry now
      this.surface.notifySnapshot()
      return
    }
    this.reconcileStateSource()
    await this.refreshCurrentPose()
    this.surface.notifySnapshot()
  }

  /** §22: push the effective reduced-motion flag into stage + ambient engine. */
  applyReducedMotion(): void {
    this.stage.setReducedMotion(effectiveReducedMotion(this.config, this.mediaQuery?.matches ?? false))
    this.director.refreshAmbient()
  }

  /**
   * V1.1: reconcile the registry's custom entries with the hub's customs
   * (editor save/clone/delete, or another tab via poll). A dangling
   * animationId falls back to preset semantics at play time, so a removed
   * custom never breaks the pet.
   */
  private syncCustoms(customs: ConfigSnapshot['customs']): boolean {
    return reconcileCustomAnimations(this.registry, customs)
  }

  dispose(): void {
    if (this.disposed) return
    this.stage.interactiveElement.removeEventListener('keydown', this.handleInteractiveKeydown)
    // L2: end an interrupted drag gesture FIRST, while the subscriber sets
    // are still live — drag.dispose() converts a mid-gesture teardown into a
    // cancel, and its onDragEnd fans the paired 'end' phase to the drag
    // streams (the "'end' fires for release or cancel" contract) and
    // schedules the debounced save the block below converts into the final
    // write, so a teardown mid-gesture never loses the dragged position.
    this.drag.dispose()
    this.disposed = true
    // Extension-surface teardown right after: the lease dies (the lent-out
    // driver's methods degrade from here on), the subscriber sets and stage
    // bridges drop, and every externally played instance disposes before the
    // director goes.
    this.surface.dispose()
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      void this.persistPosition() // best-effort final write (drag ended just now)
    }
    this.stateSource?.dispose()
    this.stateSource = null
    this.unsubscribeHub()
    this.mediaQuery?.removeEventListener('change', this.handleMediaChange)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleResize)
    }
    this.director.dispose()
    this.mediaQuery = null
  }

  /**
   * Re-resolve the current target's pose after a config change; swap if it
   * changed. Resolution follows the DIRECTOR's target (same rationale as
   * PreviewSession): a pose shown through fallback carries the fallback source
   * key on stage, so re-resolving the stage slot would miss a freshly
   * imported image until the next agent state change.
   *
   * A transition in flight still pose-swaps the values resolved at its start,
   * so the refresh first waits for it to settle and then re-resolves against
   * the new config. A transition that started after the config change already
   * resolved fresh values; the refresh leaves the stage to it.
   */
  private async refreshCurrentPose(): Promise<void> {
    // An active external flash hold owns the stage pose — forcing the state
    // pose here (a hub publish's refresh pass) would truncate it. The hold's
    // own restore re-resolves against the fresh config at its deadline, so
    // nothing is lost by skipping.
    if (this.surface.hasActiveFlashHold()) return
    const seq = ++this.poseRefreshSeq
    await refreshTargetPose({
      stage: this.stage,
      director: this.director,
      resolvePose: (poseKey) => this.resolvePose(poseKey),
      isDisposed: () => this.disposed,
      isSuperseded: () => seq !== this.poseRefreshSeq,
    })
  }

  /**
   * §28: a click plays the configured interaction (data-driven, no state
   * change on its own; an optional flash pose is handled by the director).
   * It also dismisses a held success/error face (§14.4 until-interaction) —
   * the dismiss stays ahead of the pop; outside a terminal hold it is a no-op.
   */
  private clickPop(): void {
    if (this.disposed || this.hidden) return
    this.stateSource?.dismissTerminal?.()
    void this.director.playInteraction().catch((error: unknown) => {
      console.error('petween: click interaction failed', error)
    })
  }

  /** Enter/Space on the focused pet body == a pointer click (§28 + a11y). */
  private readonly handleInteractiveKeydown = (event: Event): void => {
    if (this.disposed) return
    const keyboard = event as KeyboardEvent
    if (keyboard.key !== 'Enter' && keyboard.key !== ' ') return
    if (keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.shiftKey) return
    keyboard.preventDefault() // Space would scroll the page; Enter might click twice
    this.clickPop()
  }

  private applyPosition(): void {
    if (this.position === null) this.stage.setDefaultPosition()
    else this.stage.setPosition(this.position.x, this.position.y)
  }

  /** The §27 default corner, expressed in px for drag math. */
  private defaultPositionPx(): { x: number; y: number } {
    const size = this.stage.stageSize
    return clampStagePosition(
      window.innerWidth - size - DEFAULT_OVERLAY_MARGIN,
      window.innerHeight - size - DEFAULT_OVERLAY_MARGIN,
      size,
      window.innerWidth,
      window.innerHeight,
    )
  }

  private schedulePositionSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persistPosition()
    }, this.positionSaveDebounceMs)
  }

  /**
   * Debounced drag-end write: an overlay-only patch PUT — never a full config
   * copy, so a concurrent editor save cannot be clobbered (the host serializes
   * the read-merge-write). The host's merged config is broadcast to the hub.
   */
  private async persistPosition(): Promise<void> {
    const position = this.position
    if (position === null) return
    this.saveInFlight = true
    try {
      const saved = await this.patchConfig({ overlay: { x: Math.round(position.x), y: Math.round(position.y) } })
      const current = this.hub.getCurrent()
      if (!this.disposed && current !== null) {
        this.hub.publish({ config: saved, assets: current.assets, customs: current.customs })
      }
    } catch (error) {
      if (!this.disposed) console.error('petween: failed to save the pet position', error)
    } finally {
      this.saveInFlight = false
    }
  }

  /** §23: freeze ambient + in-flight interactions while hidden (phase kept). */
  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) {
      // L1: a pending flash restore is a pure pose swap (no animation) —
      // complete it now instead of letting a hidden-tab-throttled timer drag
      // the flashed image past its deadline. (A holdMs<=0 hold has no
      // restore to complete; the next state change still clears it.)
      this.surface.flushPendingFlashRestore()
      this.director.pause()
    } else {
      this.director.resume()
    }
  }

  private readonly handleMediaChange = (): void => {
    this.applyReducedMotion()
    this.surface.notifySnapshot() // the effective §22 flag is snapshot state
  }

  private readonly handleVisibilityChange = (): void => {
    this.setHidden(document.visibilityState === 'hidden')
  }

  private readonly handleResize = (): void => {
    // §27: a dragged position re-clamps into the new viewport; the default
    // corner re-anchors itself via right/bottom CSS. Mid-gesture the drag
    // owns the position (its next move re-clamps anyway) — writing here
    // would fight the gesture.
    if (this.disposed || this.position === null || this.drag.isDragging) return
    // stage.setPosition clamps internally, but this.position must mirror what
    // is actually on screen — the stage snapshot and position-lease consumers
    // read this field directly. Same visible-size basis setPosition itself
    // uses, so the re-clamp cannot leave memory and DOM disagreeing.
    this.position = clampStagePosition(
      this.position.x,
      this.position.y,
      this.stage.visibleSize,
      window.innerWidth,
      window.innerHeight,
    )
    this.applyPosition()
    this.surface.notifySnapshot() // the re-clamp may have moved the snapshot x/y
  }
}
