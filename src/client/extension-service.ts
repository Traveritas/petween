/**
 * client/extension-service.ts — the `petween/client` extension surface:
 * the first cordis service this plugin provides to OTHER DSH plugins (wired
 * with ctx.provide in client/index.ts, the only file allowed to touch ctx).
 * Windows onto the live pet: stage snapshots, exclusive position control,
 * animation playback by registry id, the playback/registry probes
 * (isPlaying / listAnimations / resyncAnimations), the open pose channel
 * (registerPoses / flashPose / flashAsset), and the observational streams
 * (subscribePose / subscribeUserPointer / subscribeAnimation). All widening
 * is additive — the contract version stays 1.
 *
 * Architecture: a module-level singleton that stays cordis-free (the client
 * half's boundary discipline). It learns about the live overlay through the
 * ACTIVE SESSION BRIDGE — PetOverlay registers each OverlaySession as it is
 * created and unregisters it BEFORE dispose, the same tolerate-the-absence
 * module-bridge pattern as installCurrentSessionSource (integration/dsh).
 * The overlay mounts and unmounts with config.enabled and image usability
 * (§2.1), so "no active session" is a normal window every API must degrade
 * through: null returns, or a null snapshot push to stage subscribers.
 */
import type { ActivityMode, PoseAnchor, PoseKey, ResolvedPose, VisualState } from '../core/types'
import type { AnimationKind } from '../motion/animation-definition'
import type { TimelineInstance } from '../motion/animation-handle'
import type { DirectorPlaybackEvent } from '../motion/motion-director'
import type { OverlaySession } from './overlay-session'

export interface StageSnapshot {
  /** Viewport px; the never-dragged default corner is folded into concrete px. */
  x: number
  y: number
  /** The configured user scale (global.scale). */
  scale: number
  /**
   * Base stage square in px. The pet's on-screen bounding box is
   * `stageSize * scale` — companions doing wall/edge math need both.
   */
  stageSize: number
  /** Null until the session booted (the director has no target yet). */
  visualState: VisualState | null
  activityMode: ActivityMode | null
  started: boolean
  // v1 widening (2026-08-27): context every companion was re-deriving alone
  // (physics shipped its own viewport getter; hit-testing approximated the
  // img box with the stage square). Additive fields — version stays 1.
  /** The viewport the position/clamp math runs against. */
  viewport: { width: number; height: number }
  /** True between the drag-threshold crossing and the gesture's end. */
  dragging: boolean
  /** The §22 effective flag (config override ∨ prefers-reduced-motion). */
  reducedMotion: boolean
  /**
   * The CURRENT motion target's pose key — what the state machine wants,
   * not necessarily the displayed image (a flashPose/click hold may own the
   * stage, and the enter's own swap fires mid-transition). Null before boot.
   */
  poseKey: PoseKey | null
  /**
   * The resting pose <img> box in viewport px: stage position + user scale
   * and the §12.3 anchor math applied, motion-layer transforms (sway/bounce/
   * breathe/transition) excluded. This is the pet's real pointer hit region —
   * the square `stageSize * scale` approximation overshoots transparent
   * margins by a typical 30-60% on real assets. Null before the first swap.
   */
  bodyRect: { x: number; y: number; width: number; height: number } | null
}

export interface PositionDriver {
  /**
   * Apply a viewport position (through the §27 clamp, same math as a user
   * drag). Returns false while suspended (a user drag is in flight) or after
   * release — the caller then owns no part of the pet.
   */
  apply(x: number, y: number): boolean
  /**
   * Persist the current position immediately through the session's existing
   * path (overlay-only config patch + hub broadcast); a pending drag debounce
   * is superseded, not doubled.
   */
  commit(): Promise<void>
  /** Hand the position back; remote overlay coordinates apply again. */
  release(): void
  /**
   * A user drag gesture started OR ended against the driver's lease: 'start'
   * suspends it (apply returns false) until the matching 'end'; both fire
   * only for real-travel gestures — a click fires neither. The user's hand
   * outranks the driver for the gesture's duration, no longer.
   */
  onUserDrag(listener: (phase: 'start' | 'end') => void): () => void
}

export interface PlayAnimationOptions {
  /**
   * Default true. true: preempt — invalidate the in-flight enter transition
   * (§10.2 generation bump) and dispose instances previously played through
   * this service. false: give up (null) when anything is playing — this
   * service's own live instances, or an enter transition in flight.
   */
  interrupt?: boolean
  /** Passed through as PlayOptions.params.strength. */
  strength?: number
}

/** Read-only playback state, split by owner (no preemption, no null-guessing). */
export interface PlayState {
  /** An enter transition (state-machine ownership) is in flight. */
  enter: boolean
  /** Any instance played through this service is running or paused. */
  external: boolean
}

/** A registry entry as listed for companions: playable through playAnimation. */
export interface AnimationSummary {
  id: string
  name: string
  kind: AnimationKind
  durationMs: number
  /** 'builtin:' ids versus everything synced from the host's library. */
  namespace: 'builtin' | 'user'
}

/**
 * A companion-hosted pose (2026-08-27 pose channel): the companion stores
 * the image itself; the main plugin only ever sees the URL. `id` shares the
 * animation library's `user:` namespace charset (convention
 * `user:<pack>-<name>`) so it can never collide with the six builtin slots.
 * Unknown width/height degrade in the layout until the image loads.
 */
export interface ExternalPoseDefinition {
  id: string
  url: string
  /** Defaults to the per-pose default {0.5, 0.96} (foot-center). */
  anchor?: PoseAnchor
  /** Defaults to 1; same 0.2..8 bounds as the config validation. */
  zoom?: number
  width?: number
  height?: number
}

/**
 * User pointer events on the pet body (click + hover). 'click' carries a
 * maintained detail count — 2 within ~400ms and 25px means a double-click.
 * Keyboard activations (Enter/Space) are not pointer events and never
 * appear here. hover-move coalesces to one event per animation frame.
 */
export type UserPointerEvent =
  | { kind: 'click'; x: number; y: number; detail: number }
  | { kind: 'hover-enter'; x: number; y: number }
  | { kind: 'hover-move'; x: number; y: number }
  | { kind: 'hover-leave'; x: number; y: number }

export interface PetweenClientService {
  /** Contract version. Bump and widen, never mutate in place. */
  readonly version: 1
  /** Null while no overlay session is active (pet disabled/unmounted). */
  getStageSnapshot(): StageSnapshot | null
  /**
   * Live snapshot stream: the current value arrives immediately on subscribe
   * (possibly null), then every position/scale/state change and every
   * session lifecycle transition pushes a new value.
   */
  subscribeStage(listener: (snapshot: StageSnapshot | null) => void): () => void
  /**
   * User drag gestures on the pet itself, service-level (no lease needed —
   * a throw-style companion samples subscribeStage during the gesture and
   * only requests the driver at 'end'). 'start' fires once when the gesture
   * crosses the drag threshold; 'end' fires once when it ends with real
   * travel (release or cancel). A click fires neither.
   */
  subscribeUserDrag(listener: (phase: 'start' | 'end') => void): () => void
  /** Null without an active session or while another driver holds the lease. */
  requestPositionControl(): PositionDriver | null
  /**
   * Play a registered animation on the live stage by id (builtin: and user:
   * namespaces alike — customs sync from the host's animation library).
   * Null without a session or for an unknown id.
   */
  playAnimation(id: string, options?: PlayAnimationOptions): TimelineInstance | null
  /**
   * Flash a pose: swap the image now, restore the state machine's pose for
   * the current target after holdMs (a pose-swap event inside a played
   * animation cannot express "then revert"). Accepts a builtin slot name
   * (resolver fallback applies) or a `user:` id registered through
   * registerPoses. holdMs <= 0 keeps the pose until the next state change.
   * False without a session or when the key resolves to nothing.
   */
  flashPose(poseKey: string, holdMs: number): boolean
  /**
   * Flash a one-off companion-hosted image (no registration needed). First
   * use may show a load flash — registerPoses preloads, this does not.
   * False without a session or on an invalid definition.
   */
  flashAsset(pose: Omit<ExternalPoseDefinition, 'id'>, holdMs: number): boolean
  /**
   * Register companion-hosted poses as flashPose / interaction pose-swap
   * targets. All-or-nothing: one invalid entry registers nothing. In-memory
   * only — re-register when the snapshot stream shows the pet remounting
   * (null → non-null).
   */
  registerPoses(poses: ExternalPoseDefinition[]): boolean
  /** Drop registered poses; unknown ids are a no-op. No-op without a session. */
  unregisterPoses(ids: string[]): void
  /**
   * Read-only playback probe: what is playing right now, split by owner —
   * the unified throttle basis for coexisting effect companions. Null
   * without a session.
   */
  isPlaying(): PlayState | null
  /**
   * The live registry as playAnimation accepts it right now: builtin
   * presets plus every synced user/custom entry. Null without a session.
   */
  listAnimations(): AnimationSummary[] | null
  /**
   * Force one config/animations fetch and resolve once the session applied
   * it — closes the register→sync window (the 3s poll, unbounded while the
   * page is hidden), so "registerAnimation then playAnimation" works on
   * return. Resolves immediately without a session; a failed fetch resolves
   * with the registry unchanged.
   */
  resyncAnimations(): Promise<void>
  /**
   * Displayed-pose stream: the pose actually on stage (state transitions,
   * silent swaps, flashes, external animation swaps all included — unlike
   * the snapshot's poseKey, which is the state machine's WANT). The current
   * pose (null before the first swap / without a session) arrives
   * immediately on subscribe; null is pushed across session teardown.
   */
  subscribePose(listener: (pose: ResolvedPose | null) => void): () => void
  /**
   * User pointer events on the pet body: clicks (with a double-click detail
   * count) and hover enter/move/leave. No lease and no immediate value —
   * purely observational; the pet's own drag/click handling is unaffected.
   */
  subscribeUserPointer(listener: (event: UserPointerEvent) => void): () => void
  /**
   * Animation lifecycle: start + settle for every playback — enter
   * transitions, click interactions, and external plays, each attributed.
   * Cancelled runs settle with status 'cancelled', so starts always pair.
   */
  subscribeAnimation(listener: (event: DirectorPlaybackEvent) => void): () => void
}

/** The session PetOverlay last registered (null = no live pet surface). */
let activeSession: OverlaySession | null = null
/** Its snapshot subscription, kept so a replacement can detach it. */
let detachSession: (() => void) | null = null
/** Its user-drag subscription, detached alongside the snapshot one. */
let detachDrag: (() => void) | null = null
/** Its displayed-pose / pointer / animation subscriptions, detached with it. */
let detachPose: (() => void) | null = null
let detachPointer: (() => void) | null = null
let detachAnimation: (() => void) | null = null
/** Service-level stage subscribers; fed by the active session's notifications. */
const stageListeners = new Set<(snapshot: StageSnapshot | null) => void>()
/** Service-level drag-gesture subscribers; fanned out from the active session. */
const userDragListeners = new Set<(phase: 'start' | 'end') => void>()
/** Service-level displayed-pose subscribers; bridged from the active session. */
const poseListeners = new Set<(pose: ResolvedPose | null) => void>()
/** Service-level user pointer subscribers; fanned out from the active session. */
const userPointerListeners = new Set<(event: UserPointerEvent) => void>()
/** Service-level animation lifecycle subscribers; fanned out from the director. */
const animationListeners = new Set<(event: DirectorPlaybackEvent) => void>()

const snapshotOf = (): StageSnapshot | null => activeSession?.getStageSnapshot() ?? null

/**
 * Fan a value out to third-party listeners, isolating each one: a throwing
 * listener gets a console.warn and never breaks the others or the host flow
 * (the same discipline as the session-side notifications).
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

/** Push the current snapshot to every subscriber (listeners may unsubscribe mid-push). */
const emitSnapshot = (): void => {
  const snapshot = snapshotOf()
  fanOutSafely([...stageListeners], snapshot, 'stage listener')
}

/** Fan a drag phase out to every service-level subscriber. */
const emitUserDrag = (phase: 'start' | 'end'): void => {
  fanOutSafely([...userDragListeners], phase, 'user drag listener')
}

/** Fan the displayed pose (null across teardown) out to every subscriber. */
const emitPose = (pose: ResolvedPose | null): void => {
  fanOutSafely([...poseListeners], pose, 'pose listener')
}

/** Fan a user pointer event out to every service-level subscriber. */
const emitUserPointer = (event: UserPointerEvent): void => {
  fanOutSafely([...userPointerListeners], event, 'user pointer listener')
}

/** Fan an animation lifecycle event out to every service-level subscriber. */
const emitAnimation = (event: DirectorPlaybackEvent): void => {
  fanOutSafely([...animationListeners], event, 'animation listener')
}

function detachAllSessionBridges(): void {
  detachSession?.()
  detachDrag?.()
  detachPose?.()
  detachPointer?.()
  detachAnimation?.()
  detachSession = null
  detachDrag = null
  detachPose = null
  detachPointer = null
  detachAnimation = null
}

/**
 * PetOverlay: a fresh OverlaySession went live. Last one wins (mounts are
 * serialized by React, so at most one live session registers); replacing
 * detaches the previous session's subscriptions first.
 */
export function setActivePetSession(session: OverlaySession): void {
  detachAllSessionBridges()
  activeSession = session
  detachSession = session.subscribeSnapshot(() => emitSnapshot())
  detachDrag = session.subscribeUserDrag(emitUserDrag)
  detachPose = session.subscribePose(emitPose)
  detachPointer = session.subscribeUserPointer(emitUserPointer)
  detachAnimation = session.subscribeAnimation(emitAnimation)
  emitSnapshot()
}

/**
 * PetOverlay: the session is going away — called BEFORE dispose so the
 * service still sees a live session while it emits its final null. A stale
 * clear (an older session's teardown racing a newer mount) is ignored: only
 * the current session can take the bridge down.
 */
export function clearActivePetSession(session: OverlaySession): void {
  if (activeSession !== session) return
  detachAllSessionBridges()
  activeSession = null
  emitSnapshot()
  emitPose(null)
}

/** The service singleton client/index.ts provides as 'petween/client'. */
export const petweenClientService: PetweenClientService = {
  version: 1,
  getStageSnapshot: () => snapshotOf(),
  subscribeStage: (listener) => {
    stageListeners.add(listener)
    listener(snapshotOf()) // contract: the current value arrives immediately
    return () => {
      stageListeners.delete(listener)
    }
  },
  subscribeUserDrag: (listener) => {
    userDragListeners.add(listener)
    return () => {
      userDragListeners.delete(listener)
    }
  },
  requestPositionControl: () => activeSession?.createPositionDriver() ?? null,
  playAnimation: (id, options) => activeSession?.playExternal(id, options) ?? null,
  flashPose: (poseKey, holdMs) => activeSession?.flashPose(poseKey, holdMs) ?? false,
  flashAsset: (pose, holdMs) => activeSession?.flashAsset(pose, holdMs) ?? false,
  registerPoses: (poses) => activeSession?.registerPoses(poses) ?? false,
  unregisterPoses: (ids) => activeSession?.unregisterPoses(ids),
  isPlaying: () => activeSession?.isPlaying() ?? null,
  listAnimations: () => activeSession?.listAnimations() ?? null,
  resyncAnimations: async () => {
    await activeSession?.resyncAnimations()
  },
  subscribePose: (listener) => {
    poseListeners.add(listener)
    listener(activeSession?.displayedPose ?? null) // contract: current value first
    return () => {
      poseListeners.delete(listener)
    }
  },
  subscribeUserPointer: (listener) => {
    userPointerListeners.add(listener)
    return () => {
      userPointerListeners.delete(listener)
    }
  },
  subscribeAnimation: (listener) => {
    animationListeners.add(listener)
    return () => {
      animationListeners.delete(listener)
    }
  },
}
