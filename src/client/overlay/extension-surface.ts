/**
 * client/overlay/extension-surface.ts — the companion-facing half of a pet
 * session (C1-B, extracted from OverlaySession): stage snapshots, the five
 * observational streams, external playback, the pose channel (registerPoses /
 * flash*), the exclusive position-driver lease and the playback/registry
 * probes. Everything a `petween/client` consumer can touch lives here; the
 * session keeps the session domain (config hot-apply, §27 position
 * persistence, §23 visibility, §28 click interaction, boot/state source).
 *
 * The split is deliberate: Motion Pack import lands on this surface instead
 * of growing a fifth concern inside the session. The surface never touches
 * the session CLASS — only the ExtensionSurfaceHost seam below — so a future
 * session can host it just as well.
 */
import { DEFAULT_POSE_ANCHOR, POSE_KEYS, type PoseKey, type ResolvedPose } from '../../core/types'
import type { TimelineInstance } from '../../motion/animation-handle'
import type { AnimationRegistry } from '../../motion/animation-registry'
import type { MotionDirector, DirectorPlaybackEvent } from '../../motion/motion-director'
import type { ConfigHub } from '../config-hub'
import type { DragController } from './drag-controller'
import type { PetStage } from './pet-stage'
import {
  fanOutSafely,
  type AnimationSummary,
  type ExternalPoseDefinition,
  type PlayAnimationOptions,
  type PlayState,
  type PositionDriver,
  type StageSnapshot,
  type UserPointerEvent,
} from './session-surface'

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

/**
 * Session-side bookkeeping for a lent-out PositionDriver. `released` latches:
 * after it flips, every driver method degrades (apply false, commit still
 * persists whatever the session itself owns) and the lease can be re-granted.
 */
interface ActivePositionDriver {
  released: boolean
  dragListeners: Set<(phase: 'start' | 'end') => void>
}

/**
 * Everything the surface needs from its hosting session. `director` is read
 * LAZILY: the session constructs the surface before the director (the
 * director's resolve/pose-hold seams call INTO the surface), then attaches
 * it — by the time any surface method runs, the field is assigned.
 */
export interface ExtensionSurfaceHost {
  readonly stage: PetStage
  readonly registry: AnimationRegistry
  readonly hub: ConfigHub
  readonly director: MotionDirector
  readonly drag: DragController
  isDisposed(): boolean
  /** The §2.1 gate: booted and showing a target. */
  isStarted(): boolean
  /** Builtin-slot resolution (config poses + fallback chains). */
  resolveBuiltinPose(poseKey: PoseKey): ResolvedPose | null
  /** §27 position domain — the session owns persistence; the driver borrows. */
  positionPx(): { x: number; y: number }
  currentScale(): number
  /** Clamp (visible-size basis) + store + apply to the stage. */
  applyExternalPosition(x: number, y: number): boolean
  cancelPendingPositionSave(): void
  persistPositionNow(): Promise<void>
  /** Resolves once the session applied the hub's latest fetch. */
  awaitPendingUpdate(): Promise<void>
}

export class ExtensionSurface {
  private readonly host: ExtensionSurfaceHost

  /** Synchronous snapshot subscribers. */
  private readonly snapshotListeners = new Set<(snapshot: StageSnapshot) => void>()
  /** Service-level drag-gesture subscribers. */
  private readonly userDragListeners = new Set<(phase: 'start' | 'end') => void>()
  /** Instances played through playExternal, for interrupts. */
  private readonly externalInstances = new Set<TimelineInstance>()
  /** The current position-driver lease, if any. */
  private activeDriver: ActivePositionDriver | null = null
  private unsubscribeTarget: (() => void) | null = null
  private unsubscribePoseSwap: (() => void) | null = null
  /** Pending flashPose restore timer, if any. */
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The active external flash hold (attachment flashPose). `until` is a
   * Date.now() deadline — Infinity for holdMs<=0 (hold until the next state
   * change). One ledger for every pose writer: while a hold is active it owns
   * the stage pose (refreshCurrentPose defers to its restore), and a
   * pose-changing director target clears it (the state machine re-owns the
   * pose through its own enter/silent-swap path).
   */
  private flashHold: { pose: ResolvedPose; until: number } | null = null
  /** Poses registered by companions (registerPoses); session memory only. */
  private readonly externalPoses = new Map<string, ResolvedPose>()
  /** Displayed-pose subscribers (bridged from PetStage). */
  private readonly poseListeners = new Set<(pose: ResolvedPose) => void>()
  /** User pointer-event subscribers (click + hover). */
  private readonly userPointerListeners = new Set<(event: UserPointerEvent) => void>()
  /** Animation lifecycle subscribers (director hook). */
  private readonly animationListeners = new Set<(event: DirectorPlaybackEvent) => void>()
  /** Click detail bookkeeping (the double-click window). */
  private lastClick: { time: number; x: number; y: number; detail: number } | null = null
  /** Coalesced hover-move coordinates + the pending rAF handle. */
  private hoverFrame: number | null = null
  private pendingHover: { x: number; y: number } | null = null
  /**
   * The last target the director hook delivered. The director notifies every
   * target assignment BEFORE its own dedupe decision (§10.3), so the surface
   * compares consecutive targets itself: a same-shape assignment (same
   * visualState + poseKey — e.g. a reasoning→tool activity switch under the
   * default config) never ends an active flash hold.
   */
  private lastSeenTarget: MotionDirector['currentTarget'] | null = null

  constructor(host: ExtensionSurfaceHost) {
    this.host = host

    // Displayed-pose stream: PetStage.swapPose is the single write head for
    // every pose writer (state machine, flash, external animation swaps), so
    // bridging here observes them all without tracking callers.
    this.unsubscribePoseSwap = host.stage.subscribePoseSwap((pose) => {
      fanOutSafely([...this.poseListeners], pose, 'pose listener')
    })

    // Hover stream on the pet body (the img is the hit region). hover-move
    // coalesces to one event per animation frame (§23: no per-mousemove work).
    const interactive = host.stage.interactiveElement
    interactive.addEventListener('mouseenter', this.handleHoverEnter)
    interactive.addEventListener('mousemove', this.handleHoverMove)
    interactive.addEventListener('mouseleave', this.handleHoverLeave)
  }

  /**
   * Second construction phase: the session builds the director with seams
   * INTO this surface, then attaches it here so the target stream starts
   * flowing. Everything before this point is stage-side wiring only.
   */
  attachDirector(director: MotionDirector): void {
    // Every target assignment (state/pose change) is a snapshot event. Fired
    // synchronously inside setTarget, before any transition segment runs —
    // subscribers see the NEW target immediately (unconditionally: same-shape
    // targets still update activityMode in the StageSnapshot stream). A
    // POSE-CHANGING target also ends any active flash hold: its own enter/
    // silent-swap path decides what the stage shows next (the hold's restore
    // would only fight it or no-op late). A same-shape target (same
    // visualState + poseKey, §10.3 dedupe) changes nothing on stage and must
    // leave the hold alone — its contract is "until the next state change
    // that would swap the pose".
    this.unsubscribeTarget = director.subscribeTarget((target) => this.handleTarget(target))
  }

  private handleTarget(target: MotionDirector['currentTarget']): void {
    const previous = this.lastSeenTarget
    this.lastSeenTarget = target
    const changed =
      previous === null ||
      target === null ||
      previous.visualState !== target.visualState ||
      previous.poseKey !== target.poseKey
    if (changed) this.clearFlashHold()
    this.notifySnapshot()
  }

  dispose(): void {
    // Kill the lease (the lent-out driver's methods degrade from here on),
    // drop the subscriber sets and dispose every externally played instance.
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
    const interactive = this.host.stage.interactiveElement
    interactive.removeEventListener('mouseenter', this.handleHoverEnter)
    interactive.removeEventListener('mousemove', this.handleHoverMove)
    interactive.removeEventListener('mouseleave', this.handleHoverLeave)
    for (const instance of this.externalInstances) instance.dispose()
    this.externalInstances.clear()
  }

  /**
   * The live stage snapshot. Null once the session is disposed; the §27
   * default corner (config overlay x/y still null) is folded into concrete
   * viewport px so x/y are always meaningful coordinates, never null.
   */
  getStageSnapshot(): StageSnapshot | null {
    if (this.host.isDisposed()) return null
    const director = this.host.director
    const target = director.currentTarget
    const position = this.host.positionPx()
    const scale = this.host.currentScale()
    // The pose <img> box in stage-square coords → viewport px through the
    // user-scale transform (its origin is the world anchor, §12.4). Resting
    // geometry only: motion-layer transforms are WAAPI state, not layout.
    const layout = this.host.stage.poseLayout
    let bodyRect: StageSnapshot['bodyRect'] = null
    if (layout !== null) {
      const size = this.host.stage.stageSize
      const originX = this.host.stage.anchor.x * size
      const originY = this.host.stage.anchor.y * size
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
      stageSize: this.host.stage.stageSize,
      visualState: target === null ? null : target.visualState,
      activityMode: target?.activityMode ?? null,
      started: this.host.isStarted(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dragging: this.host.drag.isDragging,
      reducedMotion: this.host.stage.reducedMotion,
      poseKey: target?.poseKey ?? null,
      bodyRect,
    }
  }

  subscribeSnapshot(listener: (snapshot: StageSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  /** Fan the current snapshot out; copied so a listener may unsubscribe mid-push. */
  notifySnapshot(): void {
    if (this.host.isDisposed() || this.snapshotListeners.size === 0) return
    const snapshot = this.getStageSnapshot()
    if (snapshot === null) return
    fanOutSafely([...this.snapshotListeners], snapshot, 'snapshot listener')
  }

  /**
   * Service-level drag-gesture stream (no lease needed). 'start' pairs with
   * the driver's onUserDrag notification; 'end' fires for real-travel
   * gestures only (release or cancel) — a click fires neither.
   */
  subscribeUserDrag(listener: (phase: 'start' | 'end') => void): () => void {
    this.userDragListeners.add(listener)
    return () => {
      this.userDragListeners.delete(listener)
    }
  }

  /** Fan a drag phase out; copied so a listener may unsubscribe mid-push. */
  private notifyUserDrag(phase: 'start' | 'end'): void {
    if (this.host.isDisposed()) return
    fanOutSafely([...this.userDragListeners], phase, 'user drag listener')
  }

  /**
   * The drag controller's threshold crossing / gesture end, fanned to BOTH
   * drag audiences (the service-level stream and the active driver's lease
   * listeners) plus a snapshot push (the dragging flag is snapshot state).
   */
  notifyDragGesture(phase: 'start' | 'end'): void {
    this.notifyUserDrag(phase)
    this.notifyDriverDragPhase(phase)
    this.notifySnapshot()
  }

  /**
   * Displayed-pose stream. Fires for every stage swap (state machine
   * transitions, silent swaps, flashes, external animation swaps); the
   * current pose arrives immediately on subscribe.
   */
  subscribePose(listener: (pose: ResolvedPose) => void): () => void {
    this.poseListeners.add(listener)
    const current = this.host.stage.currentPose
    if (current !== null) listener(current)
    return () => {
      this.poseListeners.delete(listener)
    }
  }

  /** The pose currently on stage (the display truth, post-fallback/flash). */
  get displayedPose(): ResolvedPose | null {
    return this.host.stage.currentPose
  }

  /**
   * User pointer events on the pet body. 'click' carries a maintained detail
   * count (2 within the window+radius = a double-click); keyboard
   * activations (Enter/Space) are NOT pointer events and never appear here.
   * Hover-move coalesces to one event per animation frame.
   */
  subscribeUserPointer(listener: (event: UserPointerEvent) => void): () => void {
    this.userPointerListeners.add(listener)
    return () => {
      this.userPointerListeners.delete(listener)
    }
  }

  /**
   * Animation lifecycle stream — start + settle for every playback (enter /
   * interaction / external), including cancelled runs so starts always pair.
   */
  subscribeAnimation(listener: (event: DirectorPlaybackEvent) => void): () => void {
    this.animationListeners.add(listener)
    return () => {
      this.animationListeners.delete(listener)
    }
  }

  /** Director onPlayback seam: fan lifecycle events out (listener-isolated). */
  notifyAnimation(event: DirectorPlaybackEvent): void {
    if (this.host.isDisposed()) return
    fanOutSafely([...this.animationListeners], event, 'animation listener')
  }

  /** DragController click: detail bookkeeping, then the pointer stream. */
  notifyClick(x: number, y: number): void {
    const now = Date.now()
    const last = this.lastClick
    const detail =
      last !== null &&
      now - last.time <= CLICK_DETAIL_WINDOW_MS &&
      Math.hypot(x - last.x, y - last.y) <= CLICK_DETAIL_RADIUS_PX
        ? last.detail + 1
        : 1
    this.lastClick = { time: now, x, y, detail }
    fanOutSafely([...this.userPointerListeners], { kind: 'click', x, y, detail }, 'user pointer listener')
  }

  private readonly handleHoverEnter = (event: Event): void => {
    const mouse = event as MouseEvent
    this.cancelHoverFrame()
    this.pendingHover = null
    if (this.host.isDisposed()) return
    fanOutSafely([...this.userPointerListeners], { kind: 'hover-enter', x: mouse.clientX, y: mouse.clientY }, 'user pointer listener')
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
    if (this.host.isDisposed()) return
    fanOutSafely([...this.userPointerListeners], { kind: 'hover-leave', x: mouse.clientX, y: mouse.clientY }, 'user pointer listener')
  }

  private flushHoverFrame(): void {
    const pending = this.pendingHover
    this.pendingHover = null
    if (pending === null || this.host.isDisposed()) return
    fanOutSafely([...this.userPointerListeners], { kind: 'hover-move', ...pending }, 'user pointer listener')
  }

  private cancelHoverFrame(): void {
    if (this.hoverFrame === null) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.hoverFrame)
    this.hoverFrame = null
    this.pendingHover = null
  }

  /**
   * Flash a pose — swap the image now, restore the state machine's pose for
   * the CURRENT target after holdMs. Accepts a builtin slot (fallback chains
   * apply) or a `user:` id registered through registerPoses; unknown keys
   * resolve to nothing → false. Direct stage swap follows the
   * refreshCurrentPose precedent (builtin poses are boot-preloaded, §16.3;
   * external ones preload at registration); swapPose is idempotent by src,
   * so a restore racing a real transition's own swap is a no-op, and a
   * transition firing during the hold simply plays from the flashed pose
   * (its target change also ends the hold). A second flash replaces the
   * pending restore; dispose cancels it (the stage is going away anyway).
   *
   * Every write here goes through the director's pose ledger
   * (noteExternalPose) so its silent-swap skip guard stays truthful — a
   * flash followed by a same-URL silent swap must not skip the swap and
   * strand the flashed image (M2).
   */
  flashPose(poseKey: string, holdMs: number): boolean {
    if (this.host.isDisposed()) return false
    const pose = this.resolvePoseAny(poseKey)
    if (pose === null) return false
    return this.flashResolvedPose(pose, holdMs)
  }

  /**
   * Flash a one-off pose image the companion hosts itself (no registration).
   * The URL is shown as-is for holdMs — first use may show a load flash;
   * companions wanting none should registerPoses (registration preloads) or
   * pre-decode the image themselves.
   */
  flashAsset(pose: Omit<ExternalPoseDefinition, 'id'>, holdMs: number): boolean {
    if (this.host.isDisposed()) return false
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
    const director = this.host.director
    // An in-flight enter transition would fire its own pose-swap (or settle
    // through a silent swap) over the flashed image WITHOUT clearing the
    // hold — stage and ledger then drift apart (stage shows the state pose
    // while the hold reports the flash pose) for the rest of the hold, and
    // an untimed hold (until=Infinity, no timer) never self-heals. The
    // flash is the newest writer, so it preempts: same interrupt+settle
    // protocol playExternal applies before taking the stage.
    if (director.transitionInFlight) {
      director.interruptEnterTransition()
      director.settleCurrentTarget()
    }
    this.host.stage.swapPose(pose)
    director.noteExternalPose(pose.asset.url)
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
   * Register companion-hosted poses for flashPose and interaction pose-swap
   * targets. All-or-nothing: one invalid entry registers nothing (false).
   * Idempotent re-registration overwrites in place and re-preloads. The map
   * is session memory only — companions re-register when the snapshot stream
   * shows the pet remounting.
   */
  registerPoses(definitions: ExternalPoseDefinition[]): boolean {
    if (this.host.isDisposed()) return false
    const resolved: ResolvedPose[] = []
    for (const definition of definitions) {
      if (!isValidExternalPose(definition)) return false
      resolved.push(resolvedExternalPose(definition))
    }
    for (const pose of resolved) this.externalPoses.set(pose.poseKey, pose)
    void this.host.stage.preload(resolved)
    return true
  }

  /** Drop registered poses (unknown ids are a no-op). */
  unregisterPoses(ids: string[]): void {
    for (const id of ids) this.externalPoses.delete(id)
  }

  /**
   * Unified pose resolution: builtin slots through the (config-swapped)
   * resolver with fallback chains; everything else through the external
   * registry. This is the seam the director and the flash paths share.
   */
  resolvePoseAny(poseKey: string): ResolvedPose | null {
    if ((POSE_KEYS as readonly string[]).includes(poseKey)) {
      return this.host.resolveBuiltinPose(poseKey as PoseKey)
    }
    return this.externalPoses.get(poseKey) ?? null
  }

  /** The director's getExternalPoseHold seam: the pose a live hold shows. */
  activeExternalPoseHold(): ResolvedPose | null {
    const hold = this.flashHold
    return hold !== null && Date.now() < hold.until ? hold.pose : null
  }

  /** refreshCurrentPose consults this: an active hold owns the stage pose. */
  hasActiveFlashHold(): boolean {
    return this.flashHold !== null && Date.now() < this.flashHold.until
  }

  /** §23 hidden-path helper: complete a pending timed restore now. */
  flushPendingFlashRestore(): void {
    if (this.flashTimer !== null) this.restoreFlashPose()
  }

  /** updateConfig guard: a live lease means remote coordinates must not yank. */
  hasPositionDriver(): boolean {
    return this.activeDriver !== null
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
    if (this.host.isDisposed()) return
    const director = this.host.director
    const target = director.currentTarget
    if (target === null) return
    const restore = this.host.resolveBuiltinPose(target.poseKey)
    if (restore === null) return
    director.noteExternalPose(restore.asset.url)
    if (restore.asset.url !== this.host.stage.currentPose?.asset.url) this.host.stage.swapPose(restore)
  }

  /**
   * Lend the position to ONE external driver at a time. While the lease is
   * held the updateConfig guard ignores remote overlay coordinates; user
   * drags suspend the driver (onUserDrag fires, apply returns false) until
   * the gesture ends. The drag path itself stays the owner of persistence
   * on drag-end; the driver persists via commit().
   */
  createPositionDriver(): PositionDriver | null {
    if (this.host.isDisposed() || this.activeDriver !== null) return null
    const state: ActivePositionDriver = { released: false, dragListeners: new Set() }
    const driver: PositionDriver = {
      apply: (x, y) => {
        if (state.released || this.host.isDisposed() || this.host.drag.isDragging) return false
        // The session clamps BEFORE storing (§27) — this.position must never
        // hold an off-screen value a later commit would persist. Same
        // visible-size basis the stage itself uses, so memory and DOM agree
        // at any scale.
        const applied = this.host.applyExternalPosition(x, y)
        this.notifySnapshot()
        return applied
      },
      commit: async () => {
        // A pending drag debounce carries the same (or staler) position —
        // this immediate write supersedes it rather than double-writing.
        this.host.cancelPendingPositionSave()
        await this.host.persistPositionNow()
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
   * Play a registered animation (builtin: or any synced custom namespace) on
   * the live stage by id; unknown id → null. The interrupt contract
   * (PlayAnimationOptions): default true preempts — the in-flight enter
   * transition is invalidated (§10.2 generation bump) and every previously
   * lent-out instance is disposed; false gives up (null) when anything is
   * playing. An invalidated enter never fires its pose-swap (generation
   * guard), so interrupting one abandons its target — the settle right after
   * lands the target's pose and restarts its ambient, closing the
   * silent-stage gap. The settle runs ONLY with a transition actually in
   * flight: with a quiet stage it would pointlessly bump the generation and
   * reset live guards (e.g. a click flash restore). Instance tracking
   * mirrors PreviewSession.playCustom: dropped the moment a run settles,
   * disposed on interrupt and session teardown.
   */
  playExternal(id: string, options?: PlayAnimationOptions): TimelineInstance | null {
    if (this.host.isDisposed()) return null
    const director = this.host.director
    if (this.host.registry.get(id) === undefined) return null
    if (options?.interrupt ?? true) {
      if (director.transitionInFlight) {
        director.interruptEnterTransition()
        director.settleCurrentTarget()
      }
      for (const instance of this.externalInstances) instance.dispose()
      this.externalInstances.clear()
    } else {
      if (director.transitionInFlight) return null
      for (const instance of this.externalInstances) {
        // A settled-but-not-yet-swept instance (microtask gap) is not playing.
        const status = instance.status
        if (status === 'running' || status === 'paused') return null
      }
    }
    let swappedPose: ResolvedPose | null = null
    const instance = director.play(
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
   * Read-only playback probe for companions throttling their own effects —
   * split by owner, so a beat plugin can spare the state machine's enter
   * transitions without probing with interrupt:false nulls (the same
   * running/paused accounting playExternal's give-up path uses).
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
    return { enter: this.host.director.transitionInFlight, external }
  }

  /**
   * The live registry as playAnimation sees it — builtin presets plus every
   * host-library entry synced so far. listAnimations is client-side on
   * purpose: the session's registry is the playable truth (the host's
   * GET /animations can run ahead of the hub sync).
   */
  listAnimations(): AnimationSummary[] {
    return this.host.registry.list().map((definition) => ({
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      durationMs: definition.durationMs,
      // The literal namespace segment ('builtin', 'user', 'motion', …) —
      // widened with B6 so pack namespaces do not masquerade as 'user'.
      namespace: definition.id.startsWith('builtin:')
        ? 'builtin'
        : definition.id.slice(0, definition.id.indexOf(':')),
    }))
  }

  /**
   * Force one hub poll and wait for the session to apply whatever it
   * fetched — the answer to "registerAnimation resolved but playAnimation
   * still returns null": the 3s poll (unbounded while the page is hidden)
   * is otherwise the only sync path. A failed fetch resolves with the
   * registry unchanged (the hub's silent-catch poll contract).
   */
  async resyncAnimations(): Promise<void> {
    if (this.host.isDisposed()) return
    await this.host.hub.poll() // its emit starts the session's updateConfig synchronously
    await this.host.awaitPendingUpdate()
  }
}
