/**
 * core/types.ts — persistent data model and shared value types (spec §7, §24).
 *
 * Pure data only: no runtime, no DSH, no DOM. Everything here must stay
 * JSON-serializable (Motion Pack forward compatibility, spec §8.18).
 */

/** The six user-facing pose slots (spec §7.1). */
export type PoseKey = 'idle' | 'thinking' | 'working' | 'waiting' | 'success' | 'error'

export const POSE_KEYS: readonly PoseKey[] = ['idle', 'thinking', 'working', 'waiting', 'success', 'error']

/** Visual states of the pet (spec §14.1). */
export type VisualState = 'idle' | 'active' | 'waiting' | 'success' | 'error'

/** What the agent is doing while `active` (spec §14.2); all map to visualState `active`. */
export type ActivityMode = 'thinking' | 'working' | 'coding' | 'command'

/** Uploaded image asset metadata; `id` and `fileName` are host-generated (spec §7.2). */
export interface AssetMeta {
  id: string
  fileName: string
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg'
  width: number
  height: number
  sizeBytes: number
  sha256: string
  url: string
}

/** Normalized (0..1) point inside the pose image; default is foot-center (spec §12.2). */
export interface PoseAnchor {
  x: number
  y: number
}

export const DEFAULT_POSE_ANCHOR: PoseAnchor = { x: 0.5, y: 0.96 }

export interface PoseConfig {
  assetId?: string
  anchor: PoseAnchor
  zoom: number
}

export type TransitionPreset =
  | 'global'
  | 'none'
  | 'soft'
  | 'comic-pop'
  | 'jelly'
  | 'jump'
  | 'snap'
  | 'flip'
  | 'celebrate'
  | 'deflate'

export interface TransitionConfig {
  preset: TransitionPreset
  strength: number
  durationMs: number
  /**
   * Definition reference (§8.14, V1.1): a `builtin:*` or `user:*` animation id.
   * When present and registered it takes priority over `preset`; a dangling id
   * falls back to the preset mapping at play time.
   */
  animationId?: string
}

/**
 * Spec §7.4 limits. User-signed-off spec deviation (post-release feedback):
 * strength widened 0..1.8 → 0..3, duration 80..650 → 60..2000ms.
 */
export const TRANSITION_STRENGTH_LIMITS = { min: 0, max: 3 } as const
export const TRANSITION_DURATION_LIMITS = { min: 60, max: 2000 } as const

export interface BounceConfig {
  enabled: boolean
  strength: number
  intervalMinMs: number
  intervalMaxMs: number
  durationMs: number
}

export interface SwayConfig {
  enabled: boolean
  angleDeg: number
  periodMs: number
}

export interface BreatheConfig {
  enabled: boolean
  strength: number
  periodMs: number
}

/** The three stackable ambient channels (spec §7.5). */
export interface AmbientConfig {
  bounce: BounceConfig
  sway: SwayConfig
  breathe: BreatheConfig
  /** Optional user-defined ambient timeline played alongside built-in channels. */
  customAnimationId?: string
}

export type AmbientChannel = 'bounce' | 'sway' | 'breathe'

export const AMBIENT_CHANNELS: readonly AmbientChannel[] = ['bounce', 'sway', 'breathe']

export interface StateAppearance {
  pose: PoseKey
  enter: TransitionConfig
  ambient: AmbientConfig
}

/** Root persisted config, version 1 (spec §7.7). */
export interface MotionPetConfig {
  version: 1
  enabled: boolean
  global: {
    scale: number
    transition: {
      preset: Exclude<TransitionPreset, 'global'>
      strength: number
      durationMs: number
    }
    reducedMotion: 'system' | 'always' | 'never'
    successHoldMs: number
    errorHoldMs: number
  }
  poses: Record<PoseKey, PoseConfig>
  states: Record<PoseKey, StateAppearance>
  overlay: {
    x: number | null
    y: number | null
  }
  /** Advanced behavior switches (spec §15.2). */
  advanced: {
    /** true: an activity change inside `active` swaps to the new slot's pose. */
    changePoseWithinActive: boolean
    /**
     * How the same-state pose swap animates (§15.2): 'subtle' plays
     * builtin:activity-swap through the normal timeline path, 'none' swaps
     * silently, 'state' replays the target state's full enter transition.
     */
    activityTransition: ActivityTransition
    /**
     * How success/error leave the screen (§14.4): 'timed' auto-returns to idle
     * after global.successHoldMs/errorHoldMs; 'until-interaction' holds the
     * terminal face until the pet is clicked or a new turn starts.
     */
    terminalHold: TerminalHold
    /**
     * Particle bursts for `particle` timeline events (§8.5); reduced-motion
     * suppresses them regardless of this switch.
     */
    particles: boolean
  }
  /** User-editable click interactions (§28). */
  interactions: {
    click: ClickInteraction
  }
  /**
   * Active pet preset id (`pet_*`, host/pets.ts, V1.1); null = the current
   * poses/states/scale are unsaved edits belonging to no preset. Config files
   * predating the field load as null — no migration needed.
   */
  activePetId: string | null
}

/** Same-state pose-swap animation policy for MotionPetConfig.advanced. */
export type ActivityTransition = 'subtle' | 'none' | 'state'

/**
 * §28 click behavior: the interaction animation to play (registry id; unknown
 * or non-interaction ids fall back to builtin:click-pop client-side) and an
 * optional pose flashed on stage for the animation's duration (null = never
 * swap). A flash pose that resolves to no image is simply not swapped.
 */
export interface ClickInteraction {
  animation: string
  pose: PoseKey | null
}

/** Terminal-state exit policy for MotionPetConfig.advanced.terminalHold. */
export type TerminalHold = 'timed' | 'until-interaction'

/** The preset-owned slice of the config (V1.1 pet presets, host/pets.ts). */
export interface PetSlice {
  scale: number
  poses: Record<PoseKey, PoseConfig>
  states: Record<PoseKey, StateAppearance>
}

/** A stored pet preset: the character slice plus identity and timestamps. */
export interface PetPreset extends PetSlice {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type MotionTargetReason =
  | 'agent-state'
  | 'terminal-success'
  | 'terminal-error'
  | 'manual-preview'
  | 'session-switch'
  | 'config-change'

/** What the MotionDirector is asked to show (spec §24). */
export interface MotionTarget {
  visualState: VisualState
  activityMode?: ActivityMode
  poseKey: PoseKey
  reason: MotionTargetReason
}

/**
 * Minimal semantic event stream consumed by the PetStateResolver. Raw DSH
 * events are normalized into these by the integration/dsh adapter (M4);
 * core/motion never see raw DSH concepts (spec §3.2, §13).
 */
export type PetSemanticEvent =
  | { type: 'turn-start' }
  | { type: 'activity'; mode: ActivityMode }
  | { type: 'waiting' }
  | { type: 'turn-end'; outcome: 'success' | 'error' }
  | { type: 'idle' }
  /** Local UI gesture (pet click): releases a held success/error face; a no-op in any other state. */
  | { type: 'dismiss' }

/** A pose after fallback resolution: the asset that is actually shown. */
export interface ResolvedPose {
  /** Pose slot the asset belongs to (post-fallback, may differ from the requested one). */
  poseKey: PoseKey
  asset: {
    id: string
    url: string
    width: number
    height: number
  }
  anchor: PoseAnchor
  zoom: number
}
