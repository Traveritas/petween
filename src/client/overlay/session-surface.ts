/**
 * client/overlay/session-surface.ts — the neutral contract between a live
 * pet session and the extension service (C1).
 *
 * WHY this module exists: extension-service.ts (the `petween/client` cordis
 * surface) and overlay-session.ts used to import each other's types — a
 * static, type-only cycle. Every shared shape now lives HERE, both sides
 * import downward, and the service no longer knows the OverlaySession CLASS,
 * only the structural PetSessionSurface below (PreviewSession or any future
 * session can implement it just as well).
 */
import type { ActivityMode, PoseAnchor, PoseKey, ResolvedPose, VisualState } from '../../core/types'
import type { AnimationKind } from '../../motion/animation-definition'
import type { TimelineInstance } from '../../motion/animation-handle'
import type { DirectorPlaybackEvent } from '../../motion/motion-director'

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
  /**
   * The id's namespace segment: 'builtin' for builtin:* ids, otherwise the
   * literal namespace ('user', 'motion', …). Widened from the historical
   * 'builtin' | 'user' union (2026-08-28 review): B6 opened arbitrary pack
   * namespaces, and silently grouping them under 'user' would have let
   * companion authors depend on binary semantics. Additive-compatible — the
   * two historical values are byte-for-byte unchanged.
   */
  namespace: string
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

/**
 * What the extension service needs from a live pet session — the structural
 * contract OverlaySession satisfies today (C1: the service stopped importing
 * the class, which broke the type cycle). All observational streams push
 * their CURRENT value themselves where the contract demands it; the service
 * layer fans values out to its own subscribers.
 */
export interface PetSessionSurface {
  getStageSnapshot(): StageSnapshot | null
  /** Session-level stream; the service re-broadcasts and adds null pushes. */
  subscribeSnapshot(listener: (snapshot: StageSnapshot) => void): () => void
  subscribeUserDrag(listener: (phase: 'start' | 'end') => void): () => void
  subscribePose(listener: (pose: ResolvedPose) => void): () => void
  subscribeUserPointer(listener: (event: UserPointerEvent) => void): () => void
  subscribeAnimation(listener: (event: DirectorPlaybackEvent) => void): () => void
  /** Null while another driver holds the exclusive lease. */
  createPositionDriver(): PositionDriver | null
  /** Null for an unknown id; the interrupt contract lives in PlayAnimationOptions. */
  playExternal(id: string, options?: PlayAnimationOptions): TimelineInstance | null
  flashPose(poseKey: string, holdMs: number): boolean
  flashAsset(pose: Omit<ExternalPoseDefinition, 'id'>, holdMs: number): boolean
  registerPoses(definitions: ExternalPoseDefinition[]): boolean
  unregisterPoses(ids: string[]): void
  isPlaying(): PlayState
  listAnimations(): AnimationSummary[]
  resyncAnimations(): Promise<void>
  /** The pose currently on stage (the display truth, post-fallback/flash). */
  readonly displayedPose: ResolvedPose | null
}

/**
 * Fan a value out to third-party listeners, isolating each one: a throwing
 * listener (a misbehaving companion) gets a console.warn and never breaks
 * the remaining listeners or the host flow. The ONE implementation shared by
 * the session-side notifications and the service-level streams (C1).
 */
export function fanOutSafely<T>(listeners: ReadonlyArray<(value: T) => void>, value: T, label: string): void {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch (error) {
      console.warn(`petween: ${label} failed`, error)
    }
  }
}
