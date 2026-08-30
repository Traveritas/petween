/**
 * Timeline Compiler tests (spec §29.0): keyframe normalization, endpoint
 * completion, ParameterizedValue resolution (strength 0 / 1 / 1.8), easing
 * aliases, event ordering, segment cutting with exact boundary interpolation,
 * duration clamp and reduced-motion compilation.
 */
import { describe, expect, it } from 'vitest'
import { compileTimeline, type CompiledTimeline } from '../../src/motion/timeline-compiler'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { BUILTIN_CELEBRATE, BUILTIN_COMIC_POP } from '../../src/core/transition-presets'
import { BUILTIN_SWAY } from '../../src/core/ambient-presets'
import type { MotionLayer } from '../../src/motion/motion-properties'

type CssKeyframe = { offset: number; easing: string } & Record<string, string | number>

const layerKeyframes = (compiled: CompiledTimeline, segment: number, layer: MotionLayer): CssKeyframe[] =>
  compiled.segments[segment].layers[layer] as CssKeyframe[]

const keyframeAt = (keyframes: CssKeyframe[], offset: number): CssKeyframe => {
  const found = keyframes.find((keyframe) => Math.abs(keyframe.offset - offset) < 1e-9)
  if (found === undefined) throw new Error(`no keyframe at offset ${offset}`)
  return found
}

describe('compileTimeline — keyframe normalization', () => {
  it('sorts out-of-order keyframes and completes both endpoints (§8.4)', () => {
    const definition: AnimationDefinition = {
      version: 1,
      id: 'user:fade',
      name: 'Fade',
      // Ambient definitions may not animate the transition layer (§8.5 data
      // guard); these normalization fixtures only exercise keyframe handling,
      // so the interaction kind carries them instead.
      kind: 'interaction',
      durationMs: 1000,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.opacity',
          keyframes: [
            { at: 0.8, value: 0.2 },
            { at: 0.2, value: 0.9 },
          ],
        },
      ],
    }
    const keyframes = layerKeyframes(compileTimeline(definition), 0, 'transition')
    expect(keyframes.map((keyframe) => keyframe.offset)).toEqual([0, 0.2, 0.8, 1])
    // missing head starts from the property default, missing tail holds the last value
    expect(keyframes.map((keyframe) => keyframe.opacity)).toEqual(['1', '0.9', '0.2', '0.2'])
  })

  it('resolves easing aliases to cubic-bezier on composed keyframes', () => {
    const definition: AnimationDefinition = {
      version: 1,
      id: 'user:eased',
      name: 'Eased',
      kind: 'interaction',
      durationMs: 1000,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.scaleX',
          keyframes: [
            { at: 0, value: 1, easing: 'spring-soft' },
            { at: 1, value: 1.2 },
          ],
        },
      ],
    }
    const keyframes = layerKeyframes(compileTimeline(definition), 0, 'transition')
    expect(keyframeAt(keyframes, 0).easing).toBe('cubic-bezier(0.25,1.1,0.45,1)')
  })
})

describe('compileTimeline — ParameterizedValue (§8.8, §9.2)', () => {
  it.each([
    { strength: 0, scale: '1 1', translateY: '0' },
    { strength: 1, scale: '1.16 0.82', translateY: '4' },
    { strength: 1.8, scale: '1.288 0.676', translateY: '7.2' },
  ])('comic-pop strength=$strength', ({ strength, scale, translateY }) => {
    const compiled = compileTimeline(BUILTIN_COMIC_POP, { params: { strength } })
    const keyframe = keyframeAt(layerKeyframes(compiled, 0, 'transition'), 0.95) // t=0.38 within segment [0, 0.4]
    expect(keyframe.scale).toBe(scale)
    expect(keyframe.translate).toBe(`0px ${translateY}px`)
  })

  it('clamps strength to the declared parameter range', () => {
    const compiled = compileTimeline(BUILTIN_COMIC_POP, { params: { strength: 5 } })
    const keyframe = keyframeAt(layerKeyframes(compiled, 0, 'transition'), 0.95)
    expect(keyframe.scale).toBe('1.48 0.46') // same as strength 3 (the widened max)
  })
})

describe('compileTimeline — events and segments (§8.12)', () => {
  it('cuts comic-pop into two segments at the pose-swap point with sorted events', () => {
    const compiled = compileTimeline(BUILTIN_COMIC_POP)
    expect(compiled.segments).toHaveLength(2)
    expect([compiled.segments[0].start, compiled.segments[0].end]).toEqual([0, 0.4])
    expect([compiled.segments[1].start, compiled.segments[1].end]).toEqual([0.4, 1])
    expect(compiled.events).toEqual([{ at: 0.4, type: 'pose-swap', beforeSegmentIndex: 1 }])
    expect(compiled.segments[0].durationMs).toBeCloseTo(104)
    expect(compiled.segments[1].durationMs).toBeCloseTo(156)
  })

  it('rejects a transition with more than one pose-swap event (V1 cardinality)', () => {
    const definition: AnimationDefinition = {
      version: 1,
      id: 'user:two-swaps',
      name: 'Two swaps',
      kind: 'transition',
      durationMs: 300,
      repeat: { mode: 'once' },
      tracks: [{ property: 'transition.scaleX', keyframes: [{ at: 0, value: 1 }, { at: 1, value: 1 }] }],
      events: [
        { at: 0.7, type: 'pose-swap' },
        { at: 0.3, type: 'pose-swap' },
      ],
    }
    expect(() => compileTimeline(definition)).toThrow(/exactly 1 pose-swap/)
  })

  it('interpolates exact boundary values at cut points and re-normalizes offsets', () => {
    const compiled = compileTimeline(BUILTIN_COMIC_POP)
    const pre = layerKeyframes(compiled, 0, 'transition')
    const post = layerKeyframes(compiled, 1, 'transition')
    // t=0.4 lies between keyframes 0.38 and 0.57 — both segments must start/end on the same sampled values
    const preEnd = keyframeAt(pre, 1)
    const postStart = keyframeAt(post, 0)
    expect(preEnd.scale).toBe('1.1326 0.8526')
    expect(preEnd.translate).toBe('0px 2.9474px')
    expect(postStart.scale).toBe(preEnd.scale)
    expect(postStart.translate).toBe(preEnd.translate)
    // offsets re-normalized 0..1 inside the post segment (keyframe 0.57 → 0.2833…)
    expect(post.map((keyframe) => keyframe.offset)).toEqual([0, expect.closeTo(0.28333, 4), 0.6, expect.closeTo(0.83333, 4), 1])
  })

  it('produces a single segment when the definition has no events', () => {
    const compiled = compileTimeline(BUILTIN_SWAY)
    expect(compiled.segments).toHaveLength(1)
    expect(compiled.events).toEqual([])
  })

  it('keeps multiple events at one boundary on the same segment cut (celebrate)', () => {
    const compiled = compileTimeline(BUILTIN_CELEBRATE)
    expect(compiled.segments).toHaveLength(2)
    expect([compiled.segments[0].start, compiled.segments[0].end]).toEqual([0, 0.45])
    expect(compiled.events).toEqual([
      { at: 0.45, type: 'pose-swap', beforeSegmentIndex: 1 },
      { at: 0.45, type: 'particle', effect: 'confetti', beforeSegmentIndex: 1 },
    ])
  })
})

describe('compileTimeline — duration and reduced motion', () => {
  it('clamps transition duration to 60..2000ms (widened §7.4)', () => {
    expect(compileTimeline(BUILTIN_COMIC_POP, { durationMs: 5000 }).durationMs).toBe(2000)
    expect(compileTimeline(BUILTIN_COMIC_POP, { durationMs: 10 }).durationMs).toBe(60)
  })

  it('clamps ambient duration to the generic range (widened to 120000ms)', () => {
    expect(compileTimeline(BUILTIN_SWAY, { durationMs: 90_000 }).durationMs).toBe(90_000)
    expect(compileTimeline(BUILTIN_SWAY, { durationMs: 200_000 }).durationMs).toBe(120_000)
  })

  it('lets callers override the repeat policy', () => {
    expect(compileTimeline(BUILTIN_COMIC_POP, { repeat: { mode: 'loop' } }).repeat).toEqual({ mode: 'loop' })
  })

  it('rejects a repeat override that would replay an eventful timeline as "alternate"', () => {
    // The override bypasses definition-level validation, so the eventful-
    // alternate rule is enforced here against the EFFECTIVE policy.
    expect(() => compileTimeline(BUILTIN_COMIC_POP, { repeat: { mode: 'alternate' } })).toThrowError(
      /"alternate" with events/,
    )
  })

  it('defaults undeclared strength bounds to the global transition limits (not the historical 1.8)', () => {
    const definition: AnimationDefinition = {
      version: 1,
      id: 'user:no-params',
      name: 'No Params',
      kind: 'interaction',
      durationMs: 200,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.scaleX',
          keyframes: [
            { at: 0, value: 1 },
            { at: 1, value: { base: 1, parameter: 'strength', amount: 0.3 } },
          ],
        },
      ],
      events: [],
    }
    // strength 3 (the widened global max) must pass through unclamped
    const compiled = compileTimeline(definition, { params: { strength: 3 } })
    const layer = compiled.segments[0]?.layers.transition?.[1]
    expect(layer).toBeDefined()
    expect(layer?.scale).toBe('1.9 1') // scaleX from the track; scaleY defaults to 1
    // and the cap still caps: strength 5 clamps to the same 3 output —
    // locks the upper bound, not just the raised floor.
    const clamped = compileTimeline(definition, { params: { strength: 5 } })
    expect(clamped.segments[0]?.layers.transition?.[1]?.scale).toBe('1.9 1')
  })

  it('reduced-motion: tracks collapse to final values, duration <= 120ms, events kept (§22)', () => {
    const compiled = compileTimeline(BUILTIN_COMIC_POP, { reducedMotion: true })
    expect(compiled.durationMs).toBe(120)
    expect(compiled.segments).toHaveLength(2)
    expect(compiled.events).toEqual([{ at: 0.4, type: 'pose-swap', beforeSegmentIndex: 1 }])
    compiled.segments.forEach((segment, index) => {
      for (const keyframe of layerKeyframes(compiled, index, 'transition')) {
        expect(keyframe.scale).toBe('1 1')
        expect(keyframe.translate).toBe('0px 0px')
        expect(keyframe.rotate).toBe('0deg')
        expect(keyframe.opacity).toBe('1')
      }
    })
  })

  it('reduced-motion: out-of-order keyframes collapse to the value at the latest at', () => {
    // Validation rejects duplicate `at` but not disorder (host/pack imports may
    // carry unsorted tracks) — the collapsed value must come from the largest
    // `at`, not the array tail.
    const definition: AnimationDefinition = {
      version: 1,
      id: 'user:unordered',
      name: 'Unordered',
      kind: 'interaction',
      durationMs: 1000,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.x',
          keyframes: [
            { at: 1, value: 5 },
            { at: 0, value: -5 },
            { at: 0.5, value: 3 },
          ],
        },
      ],
    }
    const compiled = compileTimeline(definition, { reducedMotion: true })
    for (const keyframe of layerKeyframes(compiled, 0, 'transition')) {
      expect(keyframe.translate).toBe('5px 0px')
    }
  })
})
