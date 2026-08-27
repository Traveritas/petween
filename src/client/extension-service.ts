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
import type { ResolvedPose } from '../core/types'
import type { TimelineInstance } from '../motion/animation-handle'
import type { DirectorPlaybackEvent } from '../motion/motion-director'
import {
  fanOutSafely,
  type AnimationSummary,
  type ExternalPoseDefinition,
  type PetSessionSurface,
  type PlayAnimationOptions,
  type PlayState,
  type PositionDriver,
  type StageSnapshot,
  type UserPointerEvent,
} from './overlay/session-surface'

// C1: every shared contract type moved to overlay/session-surface.ts (the
// neutral module that broke the extension-service ⇄ overlay-session type
// cycle). Re-exported here so companion authors and the existing tests keep
// their single import point.
export type {
  AnimationSummary,
  ExternalPoseDefinition,
  PetSessionSurface,
  PlayAnimationOptions,
  PlayState,
  PositionDriver,
  StageSnapshot,
  UserPointerEvent,
} from './overlay/session-surface'

/**
 * The session PetOverlay last registered (null = no live pet surface).
 * Typed structurally (PetSessionSurface), never by class — the service must
 * not import the session module.
 */
let activeSession: PetSessionSurface | null = null

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
export function setActivePetSession(session: PetSessionSurface): void {
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
export function clearActivePetSession(session: PetSessionSurface): void {
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
