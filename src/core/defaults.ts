/**
 * core/defaults.ts — default configuration (spec §26) and the six default
 * StateAppearances (ambient defaults per spec §11).
 */
import type { AmbientConfig, MotionPetConfig, PoseConfig, PoseKey, StateAppearance } from './types'
import { DEFAULT_POSE_ANCHOR, POSE_KEYS } from './types'

export function createDefaultPoseConfigs(): Record<PoseKey, PoseConfig> {
  const poses = {} as Record<PoseKey, PoseConfig>
  for (const key of POSE_KEYS) {
    poses[key] = { anchor: { ...DEFAULT_POSE_ANCHOR }, zoom: 1 }
  }
  return poses
}

const idleAmbient = (): AmbientConfig => ({
  // spec §11.3
  bounce: { enabled: false, strength: 0.35, intervalMinMs: 800, intervalMaxMs: 1300, durationMs: 360 },
  sway: { enabled: true, angleDeg: 0.7, periodMs: 3600 },
  breathe: { enabled: true, strength: 0.25, periodMs: 2800 },
})

const thinkingAmbient = (): AmbientConfig => ({
  // spec §11.1 — bounce interval must stay random, never a fixed mechanical loop
  bounce: { enabled: true, strength: 0.35, intervalMinMs: 800, intervalMaxMs: 1300, durationMs: 360 },
  sway: { enabled: true, angleDeg: 1.3, periodMs: 2700 },
  breathe: { enabled: false, strength: 0.18, periodMs: 2800 },
})

const workingAmbient = (): AmbientConfig => ({
  // spec §11.2 — tighter, busier
  bounce: { enabled: true, strength: 0.22, intervalMinMs: 550, intervalMaxMs: 850, durationMs: 360 },
  sway: { enabled: false, angleDeg: 1.3, periodMs: 2700 },
  breathe: { enabled: true, strength: 0.18, periodMs: 2800 },
})

const waitingAmbient = (): AmbientConfig => ({
  // spec §11.4
  bounce: { enabled: false, strength: 0.35, intervalMinMs: 800, intervalMaxMs: 1300, durationMs: 360 },
  sway: { enabled: true, angleDeg: 0.9, periodMs: 4200 },
  breathe: { enabled: true, strength: 0.16, periodMs: 2800 },
})

const successAmbient = (): AmbientConfig => ({
  // spec §11.5 — success leans on the enter transition; ambient stays faint
  bounce: { enabled: false, strength: 0.35, intervalMinMs: 800, intervalMaxMs: 1300, durationMs: 360 },
  sway: { enabled: false, angleDeg: 0.7, periodMs: 3600 },
  breathe: { enabled: true, strength: 0.1, periodMs: 3000 },
})

const errorAmbient = (): AmbientConfig => ({
  // spec §11.5 — slow sway + weak breathing
  bounce: { enabled: false, strength: 0.35, intervalMinMs: 800, intervalMaxMs: 1300, durationMs: 360 },
  sway: { enabled: true, angleDeg: 0.6, periodMs: 5200 },
  breathe: { enabled: true, strength: 0.12, periodMs: 3200 },
})

export function createDefaultStateAppearances(): Record<PoseKey, StateAppearance> {
  return {
    idle: {
      pose: 'idle',
      enter: { preset: 'soft', strength: 1, durationMs: 220 },
      ambient: idleAmbient(),
    },
    thinking: {
      pose: 'thinking',
      enter: { preset: 'global', strength: 1, durationMs: 260 },
      ambient: thinkingAmbient(),
    },
    working: {
      pose: 'working',
      enter: { preset: 'global', strength: 1, durationMs: 260 },
      ambient: workingAmbient(),
    },
    waiting: {
      pose: 'waiting',
      enter: { preset: 'soft', strength: 1, durationMs: 220 },
      ambient: waitingAmbient(),
    },
    success: {
      pose: 'success',
      enter: { preset: 'celebrate', strength: 1, durationMs: 420 },
      ambient: successAmbient(),
    },
    error: {
      pose: 'error',
      enter: { preset: 'deflate', strength: 1, durationMs: 300 },
      ambient: errorAmbient(),
    },
  }
}

/** Fresh deep-copied default config (spec §26). Callers mutate their own copy. */
export function createDefaultMotionPetConfig(): MotionPetConfig {
  return {
    version: 1,
    enabled: true,
    global: {
      scale: 1,
      transition: { preset: 'comic-pop', strength: 1, durationMs: 260 },
      reducedMotion: 'system',
      successHoldMs: 1600,
      errorHoldMs: 1800,
    },
    poses: createDefaultPoseConfigs(),
    states: createDefaultStateAppearances(),
    overlay: { x: null, y: null },
    advanced: { changePoseWithinActive: false, activityTransition: 'subtle', terminalHold: 'timed', particles: true },
    interactions: { click: { animation: 'builtin:click-pop', pose: null } },
    activePetId: null,
  }
}
