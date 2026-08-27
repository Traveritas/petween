/**
 * client/overlay-session.ts — the shell.overlay controller. Binds a live
 * PetStage to the motion stack for the REAL overlay and, since M4, to the
 * DSH agent state: once the pet is on stage it owns a DshStateSource
 * (integration/dsh) that drives the MotionDirector through the SSE channel.
 *
 * Owns: registry/director lifecycle, boot preload + idle target, shared-config
 * application (config-hub publishes), the §22 reduced-motion policy
 * (matchMedia + config override; the stage never listens itself), the §23
 * visibility policy (director.pause/resume — ambient phase preserved), drag
 * position persistence (§27: debounced PUT + hub broadcast), the §28 click
 * interaction, and window-resize re-clamping. Since the extension service,
 * it additionally exposes the petween/client windows: stage snapshots,
 * the exclusive position-driver lease, by-id animation playback, and the
 * playback/registry probes (isPlaying / listAnimations / resyncAnimations).
 */
import { createPoseResolver } from '../core/pose-resolver'
import { BUILTIN_INTERACTION_DEFINITIONS } from '../core/transition-presets'
import { DEFAULT_POSE_ANCHOR } from '../core/types'
import type { AssetMeta, MotionTarget, PetweenConfig, PoseKey, ResolvedPose } from '../core/types'
import { POSE_KEYS } from '../core/types'
import { DshStateSource, getCurrentSessionSource } from '../integration/dsh/dsh-state-source'
import type { TimelineInstance } from '../motion/animation-handle'
import { createBuiltinRegistry, type AnimationRegistry } from '../motion/animation-registry'
import { MotionDirector, type DirectorPlaybackEvent } from '../motion/motion-director'
import { patchConfig as httpPatchConfig, type ConfigPatch } from './api'
import type { ConfigHub, ConfigSnapshot } from './config-hub'
import { syncCustomAnimations } from './custom-animations'
import type {
  AnimationSummary,
  ExternalPoseDefinition,
  PlayAnimationOptions,
  PlayState,
  PositionDriver,
  StageSnapshot,
  UserPointerEvent,
} from './extension-service'
import { DragController } from './overlay/drag-controller'
import { clampStagePosition, DEFAULT_OVERLAY_MARGIN, type PetStage } from './overlay/pet-stage'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** §21-style debounce for the drag-end position write. */
const DEFAULT_POSITION_SAVE_DEBOUNCE_MS = 300
/**
 * External pose ids share the animation library's `user:` namespace charset
 * (companion convention: `user:<pack>-<name>`), so they can never collide
 * with the six builtin slot names.
 */
const EXTERNAL_POSE_ID_RE = /^user:[A-Za-z0-9][A-Za-z0-9_-]*$/
/** Same bounds the host's config validation applies to per-pose zoom. */
const EXTERNAL_POSE_ZOOM_RANGE = { min: 0.2, max: 8 } as const
/** Click detail window (≈ the platform double-click threshold). */
const CLICK_DETAIL_WINDOW_MS = 400
const CLICK_DETAIL_RADIUS_PX = 25

function isValidExternalPose(definition: ExternalPoseDefinition): boolean {
  if (typeof definition.id !== 'string' || !EXTERNAL_POSE_ID_RE.test(definition.id)) return false
  if (typeof definition.url !== 'string' || definition.url.length === 0) return false
  if (definition.anchor !== undefined) {
    const { x, y } = definition.anchor
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return false
  }
  if (
    definition.zoom !== undefined &&
    (!Number.isFinite(definition.zoom) ||
      definition.zoom < EXTERNAL_POSE_ZOOM_RANGE.min ||
      definition.zoom > EXTERNAL_POSE_ZOOM_RANGE.max)
  ) {
    return false
  }
  for (const dimension of [definition.width, definition.height]) {
    if (dimension !== undefined && (!Number.isFinite(dimension) || dimension < 0)) return false
  }
  return true
}

function resolvedExternalPose(definition: ExternalPoseDefinition): ResolvedPose {
  return {
    poseKey: definition.id,
    asset: {
      id: definition.id,
      url: definition.url,
      width: definition.width ?? 0, // unknown dims degrade in layoutPose until the load event
      height: definition.height ?? 0,
    },
    anchor: definition.anchor === undefined ? { ...DEFAULT_POSE_ANCHOR } : { ...definition.anchor },
    zoom: definition.zoom ?? 1,
  }
}

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

/**
 * Session-side bookkeeping for a lent-out PositionDriver. `released` latches:
 * after it flips, every driver method degrades (apply false, commit still
 * persists whatever the session itself owns) and the lease can be re-granted.
 */
interface ActivePositionDriver {
  released: boolean
  dragListeners: Set<(phase: 'start' | 'end') => void>
}

/** config.overlay → px position; null means the §27 default corner. */
function readOverlayPosition(config: PetweenConfig): { x: number; y: number } | null {
  const { x, y } = config.overlay
  return x === null || y === null ? null : { x, y }
}

/**
 * Fan a value out to third-party listeners, isolating each one: a throwing
 * listener (a misbehaving companion) gets a console.warn and never breaks
 * the remaining listeners or the session's own flow.
 */
function fanOutSafely<T>(listeners: ReadonlyArray<(value: T) => void>, value: T, label: string): void {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch (error) {
      console.warn(`petween: ${label} failed`, error)
    }
  }
}

export class OverlaySession {
  readonly registry: AnimationRegistry
  readonly director: MotionDirector
  readonly drag: DragController

  private readonly stage: PetStage
  private readonly hub: ConfigHub
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
  /** Extension service: synchronous snapshot subscribers. */
  private readonly snapshotListeners = new Set<(snapshot: StageSnapshot) => void>()
  /** Extension service: service-level drag-gesture subscribers. */
  private readonly userDragListeners = new Set<(phase: 'start' | 'end') => void>()
  /** Extension service: instances played through playExternal, for interrupts. */
  private readonly externalInstances = new Set<TimelineInstance>()
  /** Extension service: the current position-driver lease, if any. */
  private activeDriver: ActivePositionDriver | null = null
  /** Unsubscribes the director's target stream (snapshot notifications). */
  private unsubscribeTarget: (() => void) | null = null
  /** Unsubscribes the stage's displayed-pose stream. */
  private unsubscribePoseSwap: (() => void) | null = null
  /** The latest hub-driven updateConfig run; resyncAnimations awaits it. */
  private pendingUpdate: Promise<void> = Promise.resolve()
  /** Extension service: pending flashPose restore timer, if any. */
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Extension service: the active external flash hold (attachment flashPose).
   * `until` is a Date.now() deadline — Infinity for holdMs<=0 (hold until the
   * next state change). One ledger for every pose writer: while a hold is
   * active it owns the stage pose (refreshCurrentPose defers to its restore),
   * and a pose-changing director target clears it (the state machine re-owns
   * the pose through its own enter/silent-swap path).
   */
  private flashHold: { pose: ResolvedPose; until: number } | null = null
  /**
   * Extension service: poses registered by companions (registerPoses). In-
   * memory only — the map dies with the session, and companions re-register
   * when the snapshot stream shows the pet coming back (null → non-null).
   */
  private readonly externalPoses = new Map<string, ResolvedPose>()
  /** Extension service: displayed-pose subscribers (bridged from PetStage). */
  private readonly poseListeners = new Set<(pose: ResolvedPose) => void>()
  /** Extension service: user pointer-event subscribers (click + hover). */
  private readonly userPointerListeners = new Set<(event: UserPointerEvent) => void>()
  /** Extension service: animation lifecycle subscribers (director hook). */
  private readonly animationListeners = new Set<(event: DirectorPlaybackEvent) => void>()
  /** Click detail bookkeeping (the double-click window). */
  private lastClick: { time: number; x: number; y: number; detail: number } | null = null
  /** Coalesced hover-move coordinates + the pending rAF handle. */
  private hoverFrame: number | null = null
  private pendingHover: { x: number; y: number } | null = null
  /**
   * The last target the director hook delivered. The director notifies every
   * target assignment BEFORE its own dedupe decision (§10.3), so the session
   * compares consecutive targets itself: a same-shape assignment (same
   * visualState + poseKey — e.g. a reasoning→tool activity switch under the
   * default config) never ends an active flash hold.
   */
  private lastSeenTarget: MotionTarget | null = null

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
    this.director = new MotionDirector({
      stage: options.stage,
      registry: this.registry,
      config: this.config,
      // Indirection: updateConfig swaps the resolver on config changes. The
      // seam accepts strings: builtin slots (fallback chains) plus the
      // external poses registered through the extension service.
      resolvePose: (poseKey) => this.resolvePoseAny(poseKey),
      // Pose-hold ledger: while an attachment's flashPose hold is active, a
      // click interaction's restore returns to the HELD pose instead of
      // cutting the hold short (M3); the hold's own restore realigns.
      getExternalPoseHold: () => {
        const hold = this.flashHold
        return hold !== null && Date.now() < hold.until ? hold.pose : null
      },
      // Animation lifecycle stream (the service's subscribeAnimation).
      onPlayback: (event) => this.notifyAnimation(event),
    })
    // Extension service: every target assignment (state/pose change) is a
    // snapshot event. Fired synchronously inside setTarget, before any
    // transition segment runs — subscribers see the NEW target immediately
    // (unconditionally: same-shape targets still update activityMode in the
    // StageSnapshot stream). A POSE-CHANGING target also ends any active
    // flash hold: its own enter/silent-swap path decides what the stage
    // shows next (the hold's restore would only fight it or no-op late). A
    // same-shape target (same visualState + poseKey, §10.3 dedupe) changes
    // nothing on stage and must leave the hold alone — its contract is
    // "until the next state change that would swap the pose".
    this.unsubscribeTarget = this.director.subscribeTarget((target) => {
      const previous = this.lastSeenTarget
      this.lastSeenTarget = target
      const changed =
        previous === null ||
        target === null ||
        previous.visualState !== target.visualState ||
        previous.poseKey !== target.poseKey
      if (changed) this.clearFlashHold()
      this.notifySnapshot()
    })

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
        this.notifySnapshot()
      },
      onDragStart: () => this.handleUserDragStart(),
      onDragEnd: () => {
        this.notifyUserDrag('end')
        this.notifyDriverDragPhase('end')
        this.notifySnapshot() // the snapshot dragging flag flips back with the gesture
        this.schedulePositionSave()
      },
      onClick: (x, y) => {
        this.notifyClick(x, y)
        this.clickPop()
      },
    })

    // Displayed-pose stream: PetStage.swapPose is the single write head for
    // every pose writer (state machine, flash, external animation swaps), so
    // bridging here observes them all without the session tracking callers.
    this.unsubscribePoseSwap = this.stage.subscribePoseSwap((pose) => {
      fanOutSafely([...this.poseListeners], pose, 'pose listener')
    })

    // Hover stream on the pet body (the img is the hit region). hover-move
    // coalesces to one event per animation frame (§23: no per-mousemove work).
    this.stage.interactiveElement.addEventListener('mouseenter', this.handleHoverEnter)
    this.stage.interactiveElement.addEventListener('mousemove', this.handleHoverMove)
    this.stage.interactiveElement.addEventListener('mouseleave', this.handleHoverLeave)

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

  /**
   * Boot: preload every resolvable pose (§16.3), then show idle. The target
   * goes straight to the director (reason 'session-switch') — it is the mount
   * bootstrap, not a semantic event, and must not consume the resolver's idle
   * dedupe (same contract as PreviewSession.start). No usable image (§2.1)
   * leaves the stage empty; a later hub publish retries via updateConfig.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return
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
    this.notifySnapshot()
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
    const next = structuredClone(snapshot.config)
    this.config.enabled = next.enabled
    this.config.global = next.global
    this.config.poses = next.poses
    this.config.states = next.states
    this.config.overlay = next.overlay
    this.config.advanced = next.advanced
    this.config.interactions = next.interactions
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
    if (!this.drag.isDragging && this.saveTimer === null && !this.saveInFlight && this.activeDriver === null) {
      this.position = readOverlayPosition(this.config)
      this.applyPosition()
    }

    if (!this.started) {
      await this.start() // the first boot found no image; retry now
      this.notifySnapshot()
      return
    }
    this.reconcileStateSource()
    await this.refreshCurrentPose()
    this.notifySnapshot()
  }

  /** §22: push the effective reduced-motion flag into stage + ambient engine. */
  applyReducedMotion(): void {
    const setting = this.config.global.reducedMotion
    const system = this.mediaQuery?.matches ?? false
    const effective = setting === 'always' || (setting === 'system' && system)
    this.stage.setReducedMotion(effective)
    this.director.refreshAmbient()
  }

  /**
   * V1.1: reconcile the registry's user:* entries with the hub's customs
   * (editor save/clone/delete, or another tab via poll). A dangling
   * animationId falls back to preset semantics at play time, so a removed
   * custom never breaks the pet.
   */
  private syncCustoms(customs: ConfigSnapshot['customs']): boolean {
    // Every NON-builtin entry (B6: user: plus any pack namespace the host
    // accepts) is the reconcilable custom set; builtin:* is registry-owned.
    const customIds = () =>
      JSON.stringify(this.registry.list().filter((definition) => !definition.id.startsWith('builtin:')))
    const before = customIds()
    for (const warning of syncCustomAnimations(this.registry, customs)) {
      console.warn(`petween: ${warning}`)
    }
    return customIds() !== before
  }

  dispose(): void {
    if (this.disposed) return
    this.stage.interactiveElement.removeEventListener('keydown', this.handleInteractiveKeydown)
    // L2: end an interrupted drag gesture FIRST, while the subscriber sets
    // are still live — drag.dispose() converts a mid-gesture teardown into a
    // cancel, and its onDragEnd fans the paired 'end' phase out to the drag
    // streams (the "'end' fires for release or cancel" contract) and
    // schedules the debounced save the block below converts into the final
    // write, so a teardown mid-gesture never loses the dragged position.
    this.drag.dispose()
    this.disposed = true
    // Extension service teardown: kill the lease (the lent-out driver's
    // methods degrade from here on), drop the subscriber sets and dispose
    // every externally played instance before the director goes.
    if (this.activeDriver !== null) {
      this.activeDriver.released = true
      this.activeDriver = null
    }
    this.snapshotListeners.clear()
    this.userDragListeners.clear()
    this.poseListeners.clear()
    this.userPointerListeners.clear()
    this.animationListeners.clear()
    this.externalPoses.clear()
    this.clearFlashHold()
    this.unsubscribeTarget?.()
    this.unsubscribeTarget = null
    this.unsubscribePoseSwap?.()
    this.unsubscribePoseSwap = null
    this.cancelHoverFrame()
    this.stage.interactiveElement.removeEventListener('mouseenter', this.handleHoverEnter)
    this.stage.interactiveElement.removeEventListener('mousemove', this.handleHoverMove)
    this.stage.interactiveElement.removeEventListener('mouseleave', this.handleHoverLeave)
    for (const instance of this.externalInstances) instance.dispose()
    this.externalInstances.clear()
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
   * Extension service: the live stage snapshot. Null once disposed; the §27
   * default corner (config overlay x/y still null) is folded into concrete
   * viewport px so x/y are always meaningful coordinates, never null.
   */
  getStageSnapshot(): StageSnapshot | null {
    if (this.disposed) return null
    const target = this.director.currentTarget
    const position = this.position ?? this.defaultPositionPx()
    const scale = this.config.global.scale
    // The pose <img> box in stage-square coords → viewport px through the
    // user-scale transform (its origin is the world anchor, §12.4). Resting
    // geometry only: motion-layer transforms are WAAPI state, not layout.
    const layout = this.stage.poseLayout
    let bodyRect: StageSnapshot['bodyRect'] = null
    if (layout !== null) {
      const size = this.stage.stageSize
      const originX = this.stage.anchor.x * size
      const originY = this.stage.anchor.y * size
      bodyRect = {
        x: position.x + originX + scale * (layout.offsetX - originX),
        y: position.y + originY + scale * (layout.offsetY - originY),
        width: layout.width * scale,
        height: layout.height * scale,
      }
    }
    return {
      x: position.x,
      y: position.y,
      scale,
      stageSize: this.stage.stageSize,
      visualState: target === null ? null : target.visualState,
      activityMode: target?.activityMode ?? null,
      started: this.started,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dragging: this.drag.isDragging,
      reducedMotion: this.stage.reducedMotion,
      poseKey: target?.poseKey ?? null,
      bodyRect,
    }
  }

  /**
   * Extension service: synchronous snapshot stream. Fires on drag moves,
   * driver applies, hub config publishes, director target changes, session
   * start and resize re-clamps; the service layer re-broadcasts to its own
   * subscribers and pushes null across session teardown (it detaches first).
   */
  subscribeSnapshot(listener: (snapshot: StageSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  /** Fan the current snapshot out; copied so a listener may unsubscribe mid-push. */
  private notifySnapshot(): void {
    if (this.disposed || this.snapshotListeners.size === 0) return
    const snapshot = this.getStageSnapshot()
    if (snapshot === null) return
    fanOutSafely([...this.snapshotListeners], snapshot, 'snapshot listener')
  }

  /**
   * Extension service: service-level drag-gesture stream (no lease needed).
   * 'start' pairs with the driver's onUserDrag notification; 'end' fires for
   * real-travel gestures only (release or cancel) — a click fires neither.
   */
  subscribeUserDrag(listener: (phase: 'start' | 'end') => void): () => void {
    this.userDragListeners.add(listener)
    return () => {
      this.userDragListeners.delete(listener)
    }
  }

  /** Fan a drag phase out; copied so a listener may unsubscribe mid-push. */
  private notifyUserDrag(phase: 'start' | 'end'): void {
    if (this.disposed) return
    fanOutSafely([...this.userDragListeners], phase, 'user drag listener')
  }

  /**
   * Extension service: the displayed-pose stream. Fires for every stage
   * swap (state machine transitions, silent swaps, flashes, external
   * animation swaps); the current pose arrives immediately on subscribe.
   */
  subscribePose(listener: (pose: ResolvedPose) => void): () => void {
    this.poseListeners.add(listener)
    const current = this.stage.currentPose
    if (current !== null) listener(current)
    return () => {
      this.poseListeners.delete(listener)
    }
  }

  /** The pose currently on stage (the display truth, post-fallback/flash). */
  get displayedPose(): ResolvedPose | null {
    return this.stage.currentPose
  }

  /**
   * Extension service: user pointer events on the pet body. 'click' carries
   * a maintained detail count (2 within the window+radius = a double-click);
   * keyboard activations (Enter/Space) are NOT pointer events and never
   * appear here. Hover-move coalesces to one event per animation frame.
   */
  subscribeUserPointer(listener: (event: UserPointerEvent) => void): () => void {
    this.userPointerListeners.add(listener)
    return () => {
      this.userPointerListeners.delete(listener)
    }
  }

  /**
   * Extension service: animation lifecycle stream — start + settle for every
   * playback (enter / interaction / external), including cancelled runs so
   * starts always pair.
   */
  subscribeAnimation(listener: (event: DirectorPlaybackEvent) => void): () => void {
    this.animationListeners.add(listener)
    return () => {
      this.animationListeners.delete(listener)
    }
  }

  private notifyAnimation(event: DirectorPlaybackEvent): void {
    if (this.disposed) return
    fanOutSafely([...this.animationListeners], event, 'animation listener')
  }

  private notifyUserPointer(event: UserPointerEvent): void {
    fanOutSafely([...this.userPointerListeners], event, 'user pointer listener')
  }

  /** DragController click: detail bookkeeping, then the pointer stream. */
  private notifyClick(x: number, y: number): void {
    const now = Date.now()
    const last = this.lastClick
    const detail =
      last !== null &&
      now - last.time <= CLICK_DETAIL_WINDOW_MS &&
      Math.hypot(x - last.x, y - last.y) <= CLICK_DETAIL_RADIUS_PX
        ? last.detail + 1
        : 1
    this.lastClick = { time: now, x, y, detail }
    this.notifyUserPointer({ kind: 'click', x, y, detail })
  }

  private readonly handleHoverEnter = (event: Event): void => {
    const mouse = event as MouseEvent
    this.cancelHoverFrame()
    this.pendingHover = null
    if (this.disposed) return
    this.notifyUserPointer({ kind: 'hover-enter', x: mouse.clientX, y: mouse.clientY })
  }

  private readonly handleHoverMove = (event: Event): void => {
    const mouse = event as MouseEvent
    this.pendingHover = { x: mouse.clientX, y: mouse.clientY }
    if (this.hoverFrame !== null) return
    if (typeof requestAnimationFrame !== 'function') {
      this.flushHoverFrame() // test environments without rAF
      return
    }
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = null
      this.flushHoverFrame()
    })
  }

  private readonly handleHoverLeave = (event: Event): void => {
    const mouse = event as MouseEvent
    this.cancelHoverFrame()
    this.pendingHover = null
    if (this.disposed) return
    this.notifyUserPointer({ kind: 'hover-leave', x: mouse.clientX, y: mouse.clientY })
  }

  private flushHoverFrame(): void {
    const pending = this.pendingHover
    this.pendingHover = null
    if (pending === null || this.disposed) return
    this.notifyUserPointer({ kind: 'hover-move', ...pending })
  }

  private cancelHoverFrame(): void {
    if (this.hoverFrame === null) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.hoverFrame)
    this.hoverFrame = null
    this.pendingHover = null
  }

  /**
   * Extension service: flash a pose — swap the image now, restore the state
   * machine's pose for the CURRENT target after holdMs. Accepts a builtin
   * slot (fallback chains apply) or a `user:` id registered through
   * registerPoses; unknown keys resolve to nothing → false. Direct stage
   * swap follows the refreshCurrentPose precedent (builtin poses are
   * boot-preloaded, §16.3; external ones preload at registration); swapPose
   * is idempotent by src, so a restore racing a real transition's own swap
   * is a no-op, and a transition firing during the hold simply plays from
   * the flashed pose (its target change also ends the hold). A second flash
   * replaces the pending restore; dispose cancels it (the stage is going
   * away anyway).
   *
   * Every write here goes through the director's pose ledger
   * (noteExternalPose) so its silent-swap skip guard stays truthful — a
   * flash followed by a same-URL silent swap must not skip the swap and
   * strand the flashed image (M2).
   */
  flashPose(poseKey: string, holdMs: number): boolean {
    if (this.disposed) return false
    const pose = this.resolvePoseAny(poseKey)
    if (pose === null) return false
    return this.flashResolvedPose(pose, holdMs)
  }

  /**
   * Extension service: flash a one-off pose image the companion hosts
   * itself (no registration). The URL is shown as-is for holdMs — first use
   * may show a load flash; companions wanting none should registerPoses
   * (registration preloads) or pre-decode the image themselves.
   */
  flashAsset(pose: Omit<ExternalPoseDefinition, 'id'>, holdMs: number): boolean {
    if (this.disposed) return false
    if (!isValidExternalPose({ ...pose, id: 'user:x' })) return false
    return this.flashResolvedPose(
      {
        poseKey: pose.url,
        asset: { id: pose.url, url: pose.url, width: pose.width ?? 0, height: pose.height ?? 0 },
        anchor: pose.anchor === undefined ? { ...DEFAULT_POSE_ANCHOR } : { ...pose.anchor },
        zoom: pose.zoom ?? 1,
      },
      holdMs,
    )
  }

  /** The shared flash core every flash entry point funnels through. */
  private flashResolvedPose(pose: ResolvedPose, holdMs: number): boolean {
    // An in-flight enter transition would fire its own pose-swap (or settle
    // through a silent swap) over the flashed image WITHOUT clearing the
    // hold — stage and ledger then drift apart (stage shows the state pose
    // while the hold reports the flash pose) for the rest of the hold, and
    // an untimed hold (until=Infinity, no timer) never self-heals. The
    // flash is the newest writer, so it preempts: same interrupt+settle
    // protocol playExternal applies before taking the stage.
    if (this.director.transitionInFlight) {
      this.director.interruptEnterTransition()
      this.director.settleCurrentTarget()
    }
    this.stage.swapPose(pose)
    this.director.noteExternalPose(pose.asset.url)
    this.clearFlashHold()
    this.flashHold = { pose, until: holdMs > 0 ? Date.now() + holdMs : Number.POSITIVE_INFINITY }
    if (!(holdMs > 0)) return true // hold until the next state change (the target hook clears it)
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null
      this.restoreFlashPose()
    }, holdMs)
    return true
  }

  /**
   * Extension service: register companion-hosted poses for flashPose and
   * interaction pose-swap targets. All-or-nothing: one invalid entry
   * registers nothing (false). Idempotent re-registration overwrites in
   * place and re-preloads. The map is session memory only — companions
   * re-register when the stage snapshot stream shows the pet remounting.
   */
  registerPoses(definitions: ExternalPoseDefinition[]): boolean {
    if (this.disposed) return false
    const resolved: ResolvedPose[] = []
    for (const definition of definitions) {
      if (!isValidExternalPose(definition)) return false
      resolved.push(resolvedExternalPose(definition))
    }
    for (const pose of resolved) this.externalPoses.set(pose.poseKey, pose)
    void this.stage.preload(resolved)
    return true
  }

  /** Extension service: drop registered poses (unknown ids are a no-op). */
  unregisterPoses(ids: string[]): void {
    for (const id of ids) this.externalPoses.delete(id)
  }

  /**
   * Unified pose resolution: builtin slots through the (config-swapped)
   * resolver with fallback chains; everything else through the external
   * registry. This is the seam the director and the flash paths share.
   */
  private resolvePoseAny(poseKey: string): ResolvedPose | null {
    if ((POSE_KEYS as readonly string[]).includes(poseKey)) return this.resolvePose(poseKey as PoseKey)
    return this.externalPoses.get(poseKey) ?? null
  }

  /** Drop the hold state and its pending restore timer, if any. */
  private clearFlashHold(): void {
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer)
      this.flashTimer = null
    }
    this.flashHold = null
  }

  /**
   * Complete the active flash hold: re-align the stage to the CURRENT
   * target's freshly resolved pose (a config publish during the hold may
   * have changed what that pose means) and record the write in the
   * director's ledger. Runs at the hold deadline and, early, when the page
   * goes hidden (the swap is pure image work — no animation — so completing
   * it at hide time beats a hidden-tab-throttled timer).
   */
  private restoreFlashPose(): void {
    this.clearFlashHold()
    if (this.disposed) return
    const target = this.director.currentTarget
    if (target === null) return
    const restore = this.resolvePose(target.poseKey)
    if (restore === null) return
    this.director.noteExternalPose(restore.asset.url)
    if (restore.asset.url !== this.stage.currentPose?.asset.url) this.stage.swapPose(restore)
  }

  /**
   * Extension service: lend the position to ONE external driver at a time.
   * While the lease is held the updateConfig guard ignores remote overlay
   * coordinates; user drags suspend the driver (onUserDrag fires, apply
   * returns false) until the gesture ends. The drag path itself stays the
   * owner of persistence on drag-end; the driver persists via commit().
   */
  createPositionDriver(): PositionDriver | null {
    if (this.disposed || this.activeDriver !== null) return null
    const state: ActivePositionDriver = { released: false, dragListeners: new Set() }
    const driver: PositionDriver = {
      apply: (x, y) => {
        if (state.released || this.disposed || this.drag.isDragging) return false
        // Same contract as the drag path: clamp BEFORE storing (§27) — the
        // stage re-clamps on apply, but this.position must never hold an
        // off-screen value a later commit would persist. Same visible-size
        // basis the stage itself uses, so memory and DOM agree at any scale.
        const clamped = clampStagePosition(x, y, this.stage.visibleSize, window.innerWidth, window.innerHeight)
        this.position = clamped
        this.stage.setPosition(clamped.x, clamped.y)
        this.notifySnapshot()
        return true
      },
      commit: async () => {
        // A pending drag debounce carries the same (or staler) position —
        // this immediate write supersedes it rather than double-writing.
        if (this.saveTimer !== null) {
          clearTimeout(this.saveTimer)
          this.saveTimer = null
        }
        await this.persistPosition()
      },
      release: () => {
        if (state.released) return
        state.released = true
        if (this.activeDriver === state) this.activeDriver = null
        this.notifySnapshot()
      },
      onUserDrag: (listener) => {
        state.dragListeners.add(listener)
        return () => {
          state.dragListeners.delete(listener)
        }
      },
    }
    this.activeDriver = state
    return driver
  }

  /** DragController threshold crossing: notify both drag audiences. */
  private handleUserDragStart(): void {
    this.notifyUserDrag('start')
    this.notifyDriverDragPhase('start')
    this.notifySnapshot() // the snapshot dragging flag flips on with the gesture
  }

  /**
   * Driver-level drag phases: the lease stays held across the suspension, so
   * 'end' is the signal that apply() is honored again (the v1 contract said
   * "suspended until the gesture ends" without an end event — widened 2026-08-27).
   */
  private notifyDriverDragPhase(phase: 'start' | 'end'): void {
    const state = this.activeDriver
    if (state === null) return
    fanOutSafely([...state.dragListeners], phase, 'driver drag listener')
  }

  /**
   * Extension service: play a registered animation (builtin: or the synced
   * user: namespace) on the live stage by id; unknown id → null. The
   * interrupt contract (PlayAnimationOptions): default true preempts — the
   * in-flight enter transition is invalidated (§10.2 generation bump) and
   * every previously lent-out instance is disposed; false gives up (null)
   * when anything is playing. An invalidated enter never fires its pose-swap
   * (generation guard), so interrupting one abandons its target — the settle
   * right after lands the target's pose and restarts its ambient, closing
   * the silent-stage gap. The settle runs ONLY with a transition actually in
   * flight: with a quiet stage it would pointlessly bump the generation and
   * reset live guards (e.g. a click flash restore). Instance tracking
   * mirrors PreviewSession.playCustom: dropped the moment a run settles,
   * disposed on interrupt and session teardown.
   */
  playExternal(id: string, options?: PlayAnimationOptions): TimelineInstance | null {
    if (this.disposed) return null
    if (this.registry.get(id) === undefined) return null
    if (options?.interrupt ?? true) {
      if (this.director.transitionInFlight) {
        this.director.interruptEnterTransition()
        this.director.settleCurrentTarget()
      }
      for (const instance of this.externalInstances) instance.dispose()
      this.externalInstances.clear()
    } else {
      if (this.director.transitionInFlight) return null
      for (const instance of this.externalInstances) {
        // A settled-but-not-yet-swept instance (microtask gap) is not playing.
        const status = instance.status
        if (status === 'running' || status === 'paused') return null
      }
    }
    let swappedPose: ResolvedPose | null = null
    const instance = this.director.play(
      id,
      {
        ...(options?.strength === undefined ? {} : { params: { strength: options.strength } }),
        onEvent: (event) => {
          // Interaction pose-swap events name their target; it resolves at
          // play time (builtin slot or registered pose — a miss skips the
          // swap, mirroring the dangling-animationId fallback discipline)
          // and rides the flash-hold ledger: hold until the run settles or
          // a pose-changing state target preempts (its hook clears holds).
          if (event.type === 'pose-swap' && event.pose !== undefined) {
            const pose = this.resolvePoseAny(event.pose)
            if (pose !== null) {
              swappedPose = pose
              this.flashResolvedPose(pose, 0)
            }
          }
        },
      },
    )
    this.externalInstances.add(instance)
    void instance.play().then(() => {
      this.externalInstances.delete(instance)
      // A swapped pose realigns to the state machine's when the run settles —
      // finished OR cancelled: an interrupting play's own swap (or dispose)
      // takes over from a clean baseline instead of a stranded hold. Only
      // when OUR hold is still the active one: a later flashPose/flashAsset
      // legitimately replaced the ledger mid-run and its hold must survive
      // this settle (its own timer, or the next state change, ends it).
      if (swappedPose !== null && this.flashHold?.pose === swappedPose) this.restoreFlashPose()
    })
    return instance
  }

  /**
   * Extension service: read-only playback probe for companions throttling
   * their own effects — split by owner, so a beat plugin can spare the state
   * machine's enter transitions without probing with interrupt:false nulls
   * (the same running/paused accounting playExternal's give-up path uses).
   */
  isPlaying(): PlayState {
    let external = false
    for (const instance of this.externalInstances) {
      const status = instance.status
      if (status === 'running' || status === 'paused') {
        external = true
        break
      }
    }
    return { enter: this.director.transitionInFlight, external }
  }

  /**
   * Extension service: the live registry as playAnimation sees it — builtin
   * presets plus every host-library entry synced so far. listAnimations is
   * client-side on purpose: the session's registry is the playable truth
   * (the host's GET /animations can run ahead of the hub sync).
   */
  listAnimations(): AnimationSummary[] {
    return this.registry.list().map((definition) => ({
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      durationMs: definition.durationMs,
      namespace: definition.id.startsWith('builtin:') ? ('builtin' as const) : ('user' as const),
    }))
  }

  /**
   * Extension service: force one hub poll and wait for the session to apply
   * whatever it fetched — the answer to "registerAnimation resolved but
   * playAnimation still returns null": the 3s poll (unbounded while the page
   * is hidden) is otherwise the only sync path. A failed fetch resolves with
   * the registry unchanged (the hub's silent-catch poll contract).
   */
  async resyncAnimations(): Promise<void> {
    if (this.disposed) return
    await this.hub.poll() // its emit starts updateConfig synchronously
    await this.pendingUpdate
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
    // M1: an active external flash hold owns the stage pose — forcing the
    // state pose here (a hub publish's refresh pass) would truncate it. The
    // hold's own restore re-resolves against the fresh config at its
    // deadline, so nothing is lost by skipping.
    if (this.flashHold !== null && Date.now() < this.flashHold.until) return
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
    if (next === null) return // every image removed; the overlay unmounts instead
    const unchanged =
      next.asset.url === current.asset.url &&
      next.anchor.x === current.anchor.x &&
      next.anchor.y === current.anchor.y &&
      next.zoom === current.zoom
    if (unchanged) return
    await this.stage.preload([next])
    if (this.disposed || seq !== this.poseRefreshSeq) return // superseded
    this.stage.swapPose(next)
    this.director.noteExternalPose(next.asset.url)
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
      if (this.flashTimer !== null) this.restoreFlashPose()
      this.director.pause()
    } else {
      this.director.resume()
    }
  }

  private readonly handleMediaChange = (): void => {
    this.applyReducedMotion()
    this.notifySnapshot() // the effective §22 flag is snapshot state
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
    this.notifySnapshot() // the re-clamp may have moved the snapshot x/y
  }
}
