/**
 * client/extension-service.ts — the `motion-pet/client` extension surface:
 * the first cordis service this plugin provides to OTHER DSH plugins (wired
 * with ctx.provide in client/index.ts, the only file allowed to touch ctx).
 * Three windows onto the live pet: stage snapshots, exclusive position
 * control, and animation playback by registry id.
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
import type { ActivityMode, VisualState } from '../core/types'
import type { TimelineInstance } from '../motion/animation-handle'
import type { OverlaySession } from './overlay-session'

export interface StageSnapshot {
  /** Viewport px; the never-dragged default corner is folded into concrete px. */
  x: number
  y: number
  /** The configured user scale (global.scale). */
  scale: number
  /** Null until the session booted (the director has no target yet). */
  visualState: VisualState | null
  activityMode: ActivityMode | null
  started: boolean
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
   * A user drag gesture started: the driver is suspended (apply returns
   * false) until the gesture ends. The user's hand outranks the driver.
   */
  onUserDrag(listener: () => void): () => void
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

export interface MotionPetClientService {
  readonly version: 1
  /** Null while no overlay session is active (pet disabled/unmounted). */
  getStageSnapshot(): StageSnapshot | null
  /**
   * Live snapshot stream: the current value arrives immediately on subscribe
   * (possibly null), then every position/scale/state change and every
   * session lifecycle transition pushes a new value.
   */
  subscribeStage(listener: (snapshot: StageSnapshot | null) => void): () => void
  /** Null without an active session or while another driver holds the lease. */
  requestPositionControl(): PositionDriver | null
  /**
   * Play a registered animation on the live stage by id (builtin: and user:
   * namespaces alike — customs sync from the host's animation library).
   * Null without a session or for an unknown id.
   */
  playAnimation(id: string, options?: PlayAnimationOptions): TimelineInstance | null
}

/** The session PetOverlay last registered (null = no live pet surface). */
let activeSession: OverlaySession | null = null
/** Its snapshot subscription, kept so a replacement can detach it. */
let detachSession: (() => void) | null = null
/** Service-level stage subscribers; fed by the active session's notifications. */
const stageListeners = new Set<(snapshot: StageSnapshot | null) => void>()

const snapshotOf = (): StageSnapshot | null => activeSession?.getStageSnapshot() ?? null

/** Push the current snapshot to every subscriber (listeners may unsubscribe mid-push). */
const emitSnapshot = (): void => {
  const snapshot = snapshotOf()
  for (const listener of [...stageListeners]) listener(snapshot)
}

/**
 * PetOverlay: a fresh OverlaySession went live. Last one wins (mounts are
 * serialized by React, so at most one live session registers); replacing
 * detaches the previous session's subscription first.
 */
export function setActivePetSession(session: OverlaySession): void {
  detachSession?.()
  detachSession = null
  activeSession = session
  detachSession = session.subscribeSnapshot(() => emitSnapshot())
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
  detachSession?.()
  detachSession = null
  activeSession = null
  emitSnapshot()
}

/** The service singleton client/index.ts provides as 'motion-pet/client'. */
export const motionPetClientService: MotionPetClientService = {
  version: 1,
  getStageSnapshot: () => snapshotOf(),
  subscribeStage: (listener) => {
    stageListeners.add(listener)
    listener(snapshotOf()) // contract: the current value arrives immediately
    return () => {
      stageListeners.delete(listener)
    }
  },
  requestPositionControl: () => activeSession?.createPositionDriver() ?? null,
  playAnimation: (id, options) => activeSession?.playExternal(id, options) ?? null,
}
