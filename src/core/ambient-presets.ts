/**
 * core/ambient-presets.ts — built-in ambient channels as AnimationDefinition
 * templates (spec §8.16, §11) plus the AmbientConfig → timeline mapping.
 *
 * The AmbientEngine never hardcodes keyframes: it maps the config of each
 * channel to (definition, params, duration/repeat overrides) and lets the
 * Timeline Engine run it. Channel parameters ride on the single 'strength'
 * parameter (§8.8): for sway, strength carries the angle in degrees.
 */
import type { AnimationDefinition, RepeatPolicy } from '../motion/animation-definition'
import type { AmbientChannel, AmbientConfig } from './types'

/**
 * Occasional squash-and-hop ("啵"). Keyframes mirror the handoff prototype;
 * repeat is random-interval so thinking never looks like a metronome (§11.1).
 */
export const BUILTIN_BOUNCE: AnimationDefinition = {
  version: 1,
  id: 'builtin:bounce',
  name: 'Bounce',
  kind: 'ambient',
  durationMs: 360,
  repeat: { mode: 'random-interval', minDelayMs: 800, maxDelayMs: 1300 },
  tracks: [
    {
      property: 'bounce.y',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-out' },
        { at: 0.26, value: { base: 0, parameter: 'strength', amount: 1.5 }, easing: 'ease-out' },
        { at: 0.56, value: { base: 0, parameter: 'strength', amount: -4.5 }, easing: 'ease-out' },
        { at: 1, value: 0 },
      ],
    },
    {
      property: 'bounce.scaleX',
      keyframes: [
        { at: 0, value: 1, easing: 'ease-out' },
        { at: 0.26, value: { base: 1, parameter: 'strength', amount: 0.05 }, easing: 'ease-out' },
        { at: 0.56, value: { base: 1, parameter: 'strength', amount: -0.025 }, easing: 'ease-out' },
        { at: 1, value: 1 },
      ],
    },
    {
      property: 'bounce.scaleY',
      keyframes: [
        { at: 0, value: 1, easing: 'ease-out' },
        { at: 0.26, value: { base: 1, parameter: 'strength', amount: -0.05 }, easing: 'ease-out' },
        { at: 0.56, value: { base: 1, parameter: 'strength', amount: 0.055 }, easing: 'ease-out' },
        { at: 1, value: 1 },
      ],
    },
  ],
  parameters: { strength: { default: 0.35, min: 0, max: 1.8 } },
}

/** Slow left/right rock around the anchor. strength carries angleDeg. */
export const BUILTIN_SWAY: AnimationDefinition = {
  version: 1,
  id: 'builtin:sway',
  name: 'Sway',
  kind: 'ambient',
  durationMs: 3600,
  repeat: { mode: 'loop' },
  tracks: [
    {
      property: 'sway.rotation',
      keyframes: [
        { at: 0, value: { base: 0, parameter: 'strength', amount: -1 }, easing: 'ease-in-out' },
        { at: 0.5, value: { base: 0, parameter: 'strength', amount: 1 }, easing: 'ease-in-out' },
        { at: 1, value: { base: 0, parameter: 'strength', amount: -1 } },
      ],
    },
  ],
  parameters: { strength: { default: 1, min: 0, max: 15 } },
}

/** Gentle idle breathing on the breathe layer. */
export const BUILTIN_BREATHE: AnimationDefinition = {
  version: 1,
  id: 'builtin:breathe',
  name: 'Breathing',
  kind: 'ambient',
  durationMs: 2800,
  repeat: { mode: 'loop' },
  tracks: [
    {
      property: 'breathe.scaleX',
      keyframes: [
        { at: 0, value: 1, easing: 'ease-in-out' },
        { at: 0.5, value: { base: 1, parameter: 'strength', amount: -0.008 }, easing: 'ease-in-out' },
        { at: 1, value: 1 },
      ],
    },
    {
      property: 'breathe.scaleY',
      keyframes: [
        { at: 0, value: 1, easing: 'ease-in-out' },
        { at: 0.5, value: { base: 1, parameter: 'strength', amount: 0.018 }, easing: 'ease-in-out' },
        { at: 1, value: 1 },
      ],
    },
  ],
  parameters: { strength: { default: 0.25, min: 0, max: 1.8 } },
}

export const BUILTIN_AMBIENT_DEFINITIONS: readonly AnimationDefinition[] = [
  BUILTIN_BOUNCE,
  BUILTIN_SWAY,
  BUILTIN_BREATHE,
]

export const AMBIENT_CHANNEL_DEFINITION_IDS: Record<AmbientChannel, string> = {
  bounce: 'builtin:bounce',
  sway: 'builtin:sway',
  breathe: 'builtin:breathe',
}

/** Everything the Timeline Engine needs to run one ambient channel. */
export interface ResolvedAmbientChannel {
  definitionId: string
  params: { strength: number }
  durationMs: number
  repeat: RepeatPolicy
}

/** Map one channel's config to a runnable timeline; null when disabled (§8.16). */
export function resolveAmbientChannel(channel: AmbientChannel, config: AmbientConfig): ResolvedAmbientChannel | null {
  switch (channel) {
    case 'bounce': {
      const bounce = config.bounce
      if (!bounce.enabled) return null
      return {
        definitionId: AMBIENT_CHANNEL_DEFINITION_IDS.bounce,
        params: { strength: bounce.strength },
        durationMs: bounce.durationMs,
        repeat: { mode: 'random-interval', minDelayMs: bounce.intervalMinMs, maxDelayMs: bounce.intervalMaxMs },
      }
    }
    case 'sway': {
      const sway = config.sway
      if (!sway.enabled) return null
      return {
        definitionId: AMBIENT_CHANNEL_DEFINITION_IDS.sway,
        params: { strength: sway.angleDeg },
        durationMs: sway.periodMs,
        repeat: { mode: 'loop' },
      }
    }
    case 'breathe': {
      const breathe = config.breathe
      if (!breathe.enabled) return null
      return {
        definitionId: AMBIENT_CHANNEL_DEFINITION_IDS.breathe,
        params: { strength: breathe.strength },
        durationMs: breathe.periodMs,
        repeat: { mode: 'loop' },
      }
    }
  }
}
