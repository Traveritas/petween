/**
 * Defaults and built-in preset data integrity (spec §26, §11, §9): locks the
 * default config, the six StateAppearances, the exact Comic Pop keyframe
 * table (§9.1) and the ambient config → timeline mapping.
 */
import { describe, expect, it } from 'vitest'
import { resolveAmbientChannel } from '../../src/core/ambient-presets'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import {
  BUILTIN_ACTIVITY_SWAP,
  BUILTIN_CELEBRATE,
  BUILTIN_CLICK_BOUNCE,
  BUILTIN_CLICK_POP,
  BUILTIN_CLICK_SPIN,
  BUILTIN_CLICK_WIGGLE,
  BUILTIN_COMIC_POP,
  BUILTIN_FLIP,
  BUILTIN_INTERACTION_DEFINITIONS,
  BUILTIN_NONE,
  BUILTIN_TRANSITION_DEFINITIONS,
} from '../../src/core/transition-presets'
import { compileTimeline } from '../../src/motion/timeline-compiler'
import { validateAnimationDefinition, type ParameterizedValue } from '../../src/motion/animation-definition'

describe('default config (§26)', () => {
  it('matches the spec defaults', () => {
    const config = createDefaultPetweenConfig()
    expect(config.version).toBe(1)
    expect(config.enabled).toBe(true)
    expect(config.global).toEqual({
      scale: 1,
      transition: { preset: 'comic-pop', strength: 1, durationMs: 260 },
      reducedMotion: 'system',
      successHoldMs: 1600,
      errorHoldMs: 1800,
    })
    expect(config.overlay).toEqual({ x: null, y: null })
    for (const pose of Object.values(config.poses)) {
      expect(pose.anchor).toEqual({ x: 0.5, y: 0.96 })
      expect(pose.zoom).toBe(1)
      expect(pose.assetId).toBeUndefined()
    }
  })

  it('state appearances: enter presets and ambient defaults (§26, §11)', () => {
    const { states } = createDefaultPetweenConfig()
    expect(states.idle.enter.preset).toBe('soft')
    expect(states.thinking.enter.preset).toBe('global')
    expect(states.working.enter.preset).toBe('global')
    expect(states.waiting.enter.preset).toBe('soft')
    expect(states.success.enter.preset).toBe('celebrate')
    expect(states.error.enter.preset).toBe('deflate')

    // §11.1 thinking: random-interval bounce + gentle sway, no breathing
    expect(states.thinking.ambient.bounce).toEqual({
      enabled: true,
      strength: 0.35,
      intervalMinMs: 800,
      intervalMaxMs: 1300,
      durationMs: 360,
    })
    expect(states.thinking.ambient.sway).toEqual({ enabled: true, angleDeg: 1.3, periodMs: 2700 })
    expect(states.thinking.ambient.breathe.enabled).toBe(false)

    // §11.3 idle: sway + breathing, no bounce
    expect(states.idle.ambient.sway).toEqual({ enabled: true, angleDeg: 0.7, periodMs: 3600 })
    expect(states.idle.ambient.breathe).toEqual({ enabled: true, strength: 0.25, periodMs: 2800 })
    expect(states.idle.ambient.bounce.enabled).toBe(false)

    // §11.2 working: quicker bounce + breathing
    expect(states.working.ambient.bounce).toMatchObject({
      enabled: true,
      strength: 0.22,
      intervalMinMs: 550,
      intervalMaxMs: 850,
    })
    expect(states.working.ambient.breathe).toMatchObject({ enabled: true, strength: 0.18 })
    expect(states.working.ambient.sway.enabled).toBe(false)

    // §11.4 waiting / §11.5 success+error
    expect(states.waiting.ambient.sway).toEqual({ enabled: true, angleDeg: 0.9, periodMs: 4200 })
    expect(states.waiting.ambient.breathe).toMatchObject({ enabled: true, strength: 0.16 })
    expect(states.success.ambient.breathe.enabled).toBe(true)
    expect(states.success.ambient.bounce.enabled).toBe(false)
    expect(states.error.ambient.sway.enabled).toBe(true)
    expect(states.error.ambient.breathe.enabled).toBe(true)
  })
})

describe('built-in transition definitions (§9)', () => {
  it('comic-pop restores the full §9.1 keyframe table with pose-swap at 0.40', () => {
    expect(BUILTIN_COMIC_POP.durationMs).toBe(260)
    expect(BUILTIN_COMIC_POP.events).toEqual([{ at: 0.4, type: 'pose-swap' }])

    const track = (property: string) => {
      const found = BUILTIN_COMIC_POP.tracks.find((candidate) => candidate.property === property)
      if (found === undefined) throw new Error(`missing track ${property}`)
      return found.keyframes
    }
    const amounts = (keyframes: ReturnType<typeof track>) =>
      keyframes.map((keyframe) => (keyframe.value as ParameterizedValue).amount)

    expect(track('transition.scaleX').map((keyframe) => keyframe.at)).toEqual([0, 0.18, 0.38, 0.57, 0.76, 0.9, 1])
    expect(amounts(track('transition.scaleX'))).toEqual([0, 0.05, 0.16, -0.1, 0.04, -0.015, 0])
    expect(amounts(track('transition.scaleY'))).toEqual([0, -0.05, -0.18, 0.13, -0.04, 0.02, 0])
    expect(amounts(track('transition.y'))).toEqual([0, 2, 4, -6, 1, -1, 0])
    // scale semantics ride on base 1, translate semantics on base 0 (§9.2)
    expect((track('transition.scaleX')[2].value as ParameterizedValue).base).toBe(1)
    expect((track('transition.y')[2].value as ParameterizedValue).base).toBe(0)
  })

  it('every transition except none carries exactly 1 pose-swap event inside 0..1 (particles may ride along)', () => {
    for (const definition of BUILTIN_TRANSITION_DEFINITIONS) {
      if (definition.id === 'builtin:none') continue
      const swaps = (definition.events ?? []).filter((event) => event.type === 'pose-swap')
      expect(swaps, definition.id).toHaveLength(1)
      expect(swaps[0].at, definition.id).toBeGreaterThan(0)
      expect(swaps[0].at, definition.id).toBeLessThan(1)
    }
  })

  it('builtin:celebrate bursts confetti right on the pose-swap (§8.5)', () => {
    expect(validateAnimationDefinition(BUILTIN_CELEBRATE).valid).toBe(true)
    expect(BUILTIN_CELEBRATE.events).toEqual([
      { at: 0.45, type: 'pose-swap' },
      { at: 0.45, type: 'particle', effect: 'confetti' },
    ])
  })

  it('builtin:flip closes scaleX to 0 around a midpoint pose-swap and reopens', () => {
    expect(validateAnimationDefinition(BUILTIN_FLIP).valid).toBe(true)
    expect(BUILTIN_FLIP.kind).toBe('transition')
    expect(BUILTIN_FLIP.durationMs).toBe(300)
    expect(BUILTIN_FLIP.events).toEqual([{ at: 0.5, type: 'pose-swap' }])
    const scaleX = BUILTIN_FLIP.tracks.find((track) => track.property === 'transition.scaleX')
    // plain numbers: the flip fully closes at any strength before the swap
    expect(scaleX?.keyframes.map((keyframe) => keyframe.value)).toEqual([1, 0, 1])
    expect(scaleX?.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 0.5, 1])

    const compiled = compileTimeline(BUILTIN_FLIP)
    expect(compiled.segments).toHaveLength(2)
    expect([compiled.segments[0].start, compiled.segments[0].end]).toEqual([0, 0.5])
    expect([compiled.segments[1].start, compiled.segments[1].end]).toEqual([0.5, 1])
  })

  it('builtin:none has zero tracks and an immediate pose-swap — no engine branch needed', () => {
    expect(BUILTIN_NONE.tracks).toEqual([])
    expect(BUILTIN_NONE.events).toEqual([{ at: 0, type: 'pose-swap' }])
  })
})

describe('builtin:click-pop (§28 click feedback)', () => {
  it('is valid interaction data: ~140ms, scale 1 → 1.06 → 1, no pose-swap event', () => {
    expect(validateAnimationDefinition(BUILTIN_CLICK_POP).valid).toBe(true)
    expect(BUILTIN_CLICK_POP.kind).toBe('interaction')
    expect(BUILTIN_CLICK_POP.durationMs).toBe(140)
    expect(BUILTIN_CLICK_POP.events).toBeUndefined() // a click must never swap the pose
    for (const track of BUILTIN_CLICK_POP.tracks) {
      expect(track.property.startsWith('transition.')).toBe(true) // whitelist channels only (§8.2)
    }
    const amounts = (property: string): number[] => {
      const track = BUILTIN_CLICK_POP.tracks.find((candidate) => candidate.property === property)
      if (track === undefined) throw new Error(`missing track ${property}`)
      return track.keyframes.map((keyframe) => (keyframe.value as ParameterizedValue).amount)
    }
    expect(amounts('transition.scaleX')).toEqual([0, 0.06, 0])
    expect(amounts('transition.scaleY')).toEqual([0, 0.06, 0])
  })

  it('stays out of BUILTIN_TRANSITION_DEFINITIONS (not a state enter transition)', () => {
    expect(BUILTIN_TRANSITION_DEFINITIONS.some((definition) => definition.id === BUILTIN_CLICK_POP.id)).toBe(false)
  })
})

describe('builtin:activity-swap (§15.2 subtle activity swap)', () => {
  it('is valid transition data: a 170ms fade-and-settle with the pose-swap at 0.4', () => {
    expect(validateAnimationDefinition(BUILTIN_ACTIVITY_SWAP).valid).toBe(true)
    expect(BUILTIN_ACTIVITY_SWAP.kind).toBe('transition')
    expect(BUILTIN_ACTIVITY_SWAP.durationMs).toBe(170)
    expect(BUILTIN_ACTIVITY_SWAP.events).toEqual([{ at: 0.4, type: 'pose-swap' }])
    const opacity = BUILTIN_ACTIVITY_SWAP.tracks.find((track) => track.property === 'transition.opacity')
    expect(opacity?.keyframes.map((keyframe) => (keyframe.value as ParameterizedValue).amount)).toEqual([0, -0.45, 0])
  })

  it('rides in BUILTIN_TRANSITION_DEFINITIONS so every registry gets it', () => {
    expect(BUILTIN_TRANSITION_DEFINITIONS.some((definition) => definition.id === BUILTIN_ACTIVITY_SWAP.id)).toBe(true)
  })
})

describe('built-in click interactions (§28)', () => {
  it('are valid interaction data without events (a click never swaps the pose by itself)', () => {
    expect(BUILTIN_INTERACTION_DEFINITIONS.map((definition) => definition.id)).toEqual([
      'builtin:click-pop',
      'builtin:click-wiggle',
      'builtin:click-bounce',
      'builtin:click-spin',
    ])
    for (const definition of BUILTIN_INTERACTION_DEFINITIONS) {
      expect(validateAnimationDefinition(definition).valid).toBe(true)
      expect(definition.kind).toBe('interaction')
      expect(definition.events).toBeUndefined()
      for (const track of definition.tracks) {
        expect(track.property.startsWith('transition.')).toBe(true) // whitelist channels only (§8.2)
      }
    }
  })

  it('the newer interactions stay in the 200..400ms click-feedback budget', () => {
    for (const definition of [BUILTIN_CLICK_WIGGLE, BUILTIN_CLICK_BOUNCE, BUILTIN_CLICK_SPIN]) {
      expect(definition.durationMs).toBeGreaterThanOrEqual(200)
      expect(definition.durationMs).toBeLessThanOrEqual(400)
    }
  })
})

describe('ambient config → timeline mapping (§8.16)', () => {
  const { states } = createDefaultPetweenConfig()

  it('disabled channels resolve to null', () => {
    expect(resolveAmbientChannel('bounce', states.idle.ambient)).toBeNull()
  })

  it('bounce maps to a random-interval repeat with the configured window', () => {
    const resolved = resolveAmbientChannel('bounce', states.thinking.ambient)
    expect(resolved).toEqual({
      definitionId: 'builtin:bounce',
      params: { strength: 0.35 },
      durationMs: 360,
      repeat: { mode: 'random-interval', minDelayMs: 800, maxDelayMs: 1300 },
    })
  })

  it('sway carries angleDeg on the strength parameter and loops with the period', () => {
    const resolved = resolveAmbientChannel('sway', states.idle.ambient)
    expect(resolved).toEqual({
      definitionId: 'builtin:sway',
      params: { strength: 0.7 },
      durationMs: 3600,
      repeat: { mode: 'loop' },
    })
  })

  it('breathe maps strength and period', () => {
    const resolved = resolveAmbientChannel('breathe', states.idle.ambient)
    expect(resolved).toEqual({
      definitionId: 'builtin:breathe',
      params: { strength: 0.25 },
      durationMs: 2800,
      repeat: { mode: 'loop' },
    })
  })
})
