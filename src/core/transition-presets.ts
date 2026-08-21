/**
 * core/transition-presets.ts — built-in enter transitions as
 * AnimationDefinition data (spec §8.10, §9).
 *
 * These are plain data: the runtime executes them through the same Timeline
 * Compiler / Scheduler as user animations — there is no per-preset code path
 * (spec §36.3/§36.12). Keyframe tables follow §9.1 (Comic Pop) and the
 * handoff prototype for jelly/jump/snap; pose-swap points per §8.10/§9.
 *
 * ParameterizedValue conventions (both §9.2 semantics expressible, §8.8):
 * - scale:     { base: 1, parameter: 'strength', amount: v - 1 } → 1 + (v-1)·strength
 * - translate: { base: 0, parameter: 'strength', amount: px }    → px·strength
 */
import type { AnimationDefinition, MotionTrack, ParameterizedValue } from '../motion/animation-definition'
import type { TransitionPreset } from './types'

const scale = (amount: number): ParameterizedValue => ({ base: 1, parameter: 'strength', amount })
const translate = (px: number): ParameterizedValue => ({ base: 0, parameter: 'strength', amount: px })

// Max widened 1.8 → 3 with TRANSITION_STRENGTH_LIMITS (user-signed-off spec
// deviation) so the relaxed strength actually reaches the compiled keyframes.
const STRENGTH_PARAMETER = { strength: { default: 1, min: 0, max: 3 } } as const

function transitionTracks(
  scaleX: Array<[number, number]>,
  scaleY: Array<[number, number]>,
  y: Array<[number, number]>,
  rotation?: Array<[number, number]>,
): MotionTrack[] {
  const tracks: MotionTrack[] = [
    { property: 'transition.scaleX', keyframes: scaleX.map(([at, amount]) => ({ at, value: scale(amount) })) },
    { property: 'transition.scaleY', keyframes: scaleY.map(([at, amount]) => ({ at, value: scale(amount) })) },
    { property: 'transition.y', keyframes: y.map(([at, px]) => ({ at, value: translate(px) })) },
  ]
  if (rotation !== undefined) {
    tracks.push({
      property: 'transition.rotation',
      keyframes: rotation.map(([at, deg]) => ({ at, value: translate(deg) })),
    })
  }
  return tracks
}

/**
 * No-op transition: zero tracks and an immediate pose-swap. The scheduler
 * runs it like any other definition — the "none" preset needs no branch.
 */
export const BUILTIN_NONE: AnimationDefinition = {
  version: 1,
  id: 'builtin:none',
  name: 'None',
  kind: 'transition',
  durationMs: 80,
  repeat: { mode: 'once' },
  tracks: [],
  events: [{ at: 0, type: 'pose-swap' }],
}

/** Spec §9.3 — very light state switch. */
export const BUILTIN_SOFT: AnimationDefinition = {
  version: 1,
  id: 'builtin:soft',
  name: 'Soft',
  kind: 'transition',
  durationMs: 220,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.35, 0.04],
      [0.7, -0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.35, -0.04],
      [0.7, 0.03],
      [1, 0],
    ],
    [
      [0, 0],
      [0.35, 2],
      [0.7, -2],
      [1, 0],
    ],
  ),
  events: [{ at: 0.4, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/** Spec §9.1 — the signature effect. Keyframe table restored in full. */
export const BUILTIN_COMIC_POP: AnimationDefinition = {
  version: 1,
  id: 'builtin:comic-pop',
  name: 'Comic Pop',
  kind: 'transition',
  durationMs: 260,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.18, 0.05],
      [0.38, 0.16],
      [0.57, -0.1],
      [0.76, 0.04],
      [0.9, -0.015],
      [1, 0],
    ],
    [
      [0, 0],
      [0.18, -0.05],
      [0.38, -0.18],
      [0.57, 0.13],
      [0.76, -0.04],
      [0.9, 0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.18, 2],
      [0.38, 4],
      [0.57, -6],
      [0.76, 1],
      [0.9, -1],
      [1, 0],
    ],
  ),
  events: [{ at: 0.4, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/** Spec §9.4 — pronounced jelly wobble. */
export const BUILTIN_JELLY: AnimationDefinition = {
  version: 1,
  id: 'builtin:jelly',
  name: 'Jelly',
  kind: 'transition',
  durationMs: 380,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.25, 0.16],
      [0.48, -0.1],
      [0.68, 0.07],
      [0.84, -0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.25, -0.16],
      [0.48, 0.13],
      [0.68, -0.06],
      [0.84, 0.03],
      [1, 0],
    ],
    [
      [0, 0],
      [0.25, 3],
      [0.48, -5],
      [0.68, 1],
      [0.84, -1],
      [1, 0],
    ],
  ),
  events: [{ at: 0.33, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/** Spec §9.5 — squash, jump up (peak ≈ -16px·strength), land, settle. */
export const BUILTIN_JUMP: AnimationDefinition = {
  version: 1,
  id: 'builtin:jump',
  name: 'Jump',
  kind: 'transition',
  durationMs: 380,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.22, 0.14],
      [0.48, -0.09],
      [0.72, 0.1],
      [0.87, -0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.22, -0.16],
      [0.48, 0.12],
      [0.72, -0.1],
      [0.87, 0.03],
      [1, 0],
    ],
    [
      [0, 0],
      [0.22, 4],
      [0.48, -16],
      [0.72, 0],
      [0.87, -3],
      [1, 0],
    ],
  ),
  events: [{ at: 0.42, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/** Spec §9.6 — fast anime cut, 140~180ms. */
export const BUILTIN_SNAP: AnimationDefinition = {
  version: 1,
  id: 'builtin:snap',
  name: 'Snap',
  kind: 'transition',
  durationMs: 160,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.42, 0.1],
      [0.62, -0.06],
      [1, 0],
    ],
    [
      [0, 0],
      [0.42, -0.11],
      [0.62, 0.08],
      [1, 0],
    ],
    [
      [0, 0],
      [0.42, 2],
      [0.62, -3],
      [1, 0],
    ],
  ),
  events: [{ at: 0.48, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/**
 * Axis flip: scaleX 1 → 0 (ease-in), pose swap at the invisible midpoint,
 * scaleX 0 → 1 (ease-out) — the swap hides inside the flip, so the image
 * change reads as one continuous motion. scaleX uses plain numbers: the flip
 * must fully close at any strength; only the slight scaleY compensation is
 * strength-parameterized. Same-layer easings match per interval (V1 rule).
 */
export const BUILTIN_FLIP: AnimationDefinition = {
  version: 1,
  id: 'builtin:flip',
  name: 'Flip',
  kind: 'transition',
  durationMs: 300,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1, easing: 'ease-in' },
        { at: 0.5, value: 0, easing: 'ease-out' },
        { at: 1, value: 1 },
      ],
    },
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: scale(0), easing: 'ease-in' },
        { at: 0.5, value: scale(0.06), easing: 'ease-out' },
        { at: 1, value: scale(0) },
      ],
    },
  ],
  events: [{ at: 0.5, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/** Spec §26 success default — a small celebratory hop with a rotation wiggle. */
export const BUILTIN_CELEBRATE: AnimationDefinition = {
  version: 1,
  id: 'builtin:celebrate',
  name: 'Celebrate',
  kind: 'transition',
  durationMs: 420,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.2, 0.08],
      [0.45, -0.08],
      [0.7, 0.05],
      [0.85, -0.01],
      [1, 0],
    ],
    [
      [0, 0],
      [0.2, -0.1],
      [0.45, 0.14],
      [0.7, -0.05],
      [0.85, 0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.2, 2],
      [0.45, -14],
      [0.7, 0],
      [0.85, -2],
      [1, 0],
    ],
    [
      [0, 0],
      [0.2, -3],
      [0.45, 3],
      [0.7, -1.5],
      [0.85, 0.5],
      [1, 0],
    ],
  ),
  events: [
    { at: 0.45, type: 'pose-swap' },
    // Confetti bursts the instant the success face lands (§8.5).
    { at: 0.45, type: 'particle', effect: 'confetti' },
  ],
  parameters: STRENGTH_PARAMETER,
}

/** Spec §26 error default — a subdued deflate. */
export const BUILTIN_DEFLATE: AnimationDefinition = {
  version: 1,
  id: 'builtin:deflate',
  name: 'Deflate',
  kind: 'transition',
  durationMs: 300,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.3, 0.06],
      [0.55, -0.03],
      [0.8, 0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.3, -0.08],
      [0.55, 0.04],
      [0.8, -0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.3, 2],
      [0.55, -1],
      [0.8, 1],
      [1, 0],
    ],
  ),
  events: [{ at: 0.5, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

/**
 * Spec §28 — overlay click feedback: a light pop (scale 1 → ~1.06 → 1, 140ms)
 * that never swaps the pose and never changes state. Kind 'interaction', so it
 * is NOT part of BUILTIN_TRANSITION_DEFINITIONS; the overlay registers it on
 * its registry and plays it through the same engine path as everything else
 * (§36 zero-branch execution).
 */
export const BUILTIN_CLICK_POP: AnimationDefinition = {
  version: 1,
  id: 'builtin:click-pop',
  name: 'Click Pop',
  kind: 'interaction',
  durationMs: 140,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.45, 0.06],
      [1, 0],
    ],
    [
      [0, 0],
      [0.45, 0.06],
      [1, 0],
    ],
    [
      [0, 0],
      [0.45, -2],
      [1, 0],
    ],
  ),
  parameters: STRENGTH_PARAMETER,
}

/** Click interaction — a quick left/right rotation wobble. */
export const BUILTIN_CLICK_WIGGLE: AnimationDefinition = {
  version: 1,
  id: 'builtin:click-wiggle',
  name: 'Click Wiggle',
  kind: 'interaction',
  durationMs: 280,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: translate(0) },
        { at: 0.2, value: translate(-6) },
        { at: 0.45, value: translate(5) },
        { at: 0.7, value: translate(-2.5) },
        { at: 0.88, value: translate(1) },
        { at: 1, value: translate(0) },
      ],
    },
  ],
  parameters: STRENGTH_PARAMETER,
}

/** Click interaction — a fast small hop with a squash on takeoff. */
export const BUILTIN_CLICK_BOUNCE: AnimationDefinition = {
  version: 1,
  id: 'builtin:click-bounce',
  name: 'Click Bounce',
  kind: 'interaction',
  durationMs: 240,
  repeat: { mode: 'once' },
  tracks: transitionTracks(
    [
      [0, 0],
      [0.3, 0.08],
      [0.6, -0.05],
      [0.85, 0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.3, -0.09],
      [0.6, 0.06],
      [0.85, -0.02],
      [1, 0],
    ],
    [
      [0, 0],
      [0.3, 2],
      [0.6, -10],
      [1, 0],
    ],
  ),
  parameters: STRENGTH_PARAMETER,
}

/** Click interaction — one full spin with a slight scale bounce. */
export const BUILTIN_CLICK_SPIN: AnimationDefinition = {
  version: 1,
  id: 'builtin:click-spin',
  name: 'Click Spin',
  kind: 'interaction',
  durationMs: 380,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: translate(0) },
        { at: 1, value: translate(360) },
      ],
    },
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: scale(0) },
        { at: 0.5, value: scale(0.08) },
        { at: 1, value: scale(0) },
      ],
    },
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: scale(0) },
        { at: 0.5, value: scale(0.08) },
        { at: 1, value: scale(0) },
      ],
    },
  ],
  parameters: STRENGTH_PARAMETER,
}

/**
 * Every built-in §28 interaction. They stay OUT of
 * BUILTIN_TRANSITION_DEFINITIONS (no pose-swap events, never state enters);
 * sessions register them next to the transition/ambient builtins.
 */
export const BUILTIN_INTERACTION_DEFINITIONS: readonly AnimationDefinition[] = [
  BUILTIN_CLICK_POP,
  BUILTIN_CLICK_WIGGLE,
  BUILTIN_CLICK_BOUNCE,
  BUILTIN_CLICK_SPIN,
]

/**
 * §15.2 'subtle' activity swap: a gentle fade-and-settle for same-state pose
 * changes (opacity dips to ~0.55 over the pose-swap, scale 1 → 0.96 → 1 with a
 * micro rebound). It is transition-kind data with a pose-swap at 0.4, so the
 * director runs it through the plain TransitionEngine path — no dedicated
 * branch — and reduced-motion compilation shrinks it like any transition.
 */
export const BUILTIN_ACTIVITY_SWAP: AnimationDefinition = {
  version: 1,
  id: 'builtin:activity-swap',
  name: 'Activity Swap',
  kind: 'transition',
  durationMs: 170,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.opacity',
      keyframes: [
        { at: 0, value: scale(0) },
        { at: 0.4, value: scale(-0.45) },
        { at: 1, value: scale(0) },
      ],
    },
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: scale(0) },
        { at: 0.4, value: scale(-0.04) },
        { at: 0.68, value: scale(0.012) },
        { at: 0.86, value: scale(-0.004) },
        { at: 1, value: scale(0) },
      ],
    },
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: scale(0) },
        { at: 0.4, value: scale(-0.04) },
        { at: 0.68, value: scale(0.012) },
        { at: 0.86, value: scale(-0.004) },
        { at: 1, value: scale(0) },
      ],
    },
  ],
  events: [{ at: 0.4, type: 'pose-swap' }],
  parameters: STRENGTH_PARAMETER,
}

export const BUILTIN_TRANSITION_DEFINITIONS: readonly AnimationDefinition[] = [
  BUILTIN_NONE,
  BUILTIN_SOFT,
  BUILTIN_COMIC_POP,
  BUILTIN_JELLY,
  BUILTIN_JUMP,
  BUILTIN_SNAP,
  BUILTIN_FLIP,
  BUILTIN_CELEBRATE,
  BUILTIN_DEFLATE,
  BUILTIN_ACTIVITY_SWAP,
]

/** TransitionConfig.preset → registry id (spec §8.14: presets are definition references). */
export function transitionDefinitionId(preset: Exclude<TransitionPreset, 'global'>): string {
  return `builtin:${preset}`
}
