/**
 * sampleTimelineAt tests (motion/timeline-compiler.ts, V1.2 scrub preview):
 * endpoint completion, easing-aware interpolation parity with the compiler's
 * own sampler, parameterized strength, per-layer composition, and the pose
 * semantics — the latest NAMED pose-swap at/before the time wins, anonymous
 * transition swaps and particle events never change the pose, and event
 * order in the payload is irrelevant.
 */
import { describe, expect, it } from 'vitest'
import { sampleTimelineAt } from '../../src/motion/timeline-compiler'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

function definition(overrides: Partial<AnimationDefinition> = {}): AnimationDefinition {
  return {
    version: 1,
    id: 'user:test',
    name: 'test',
    kind: 'transition',
    durationMs: 300,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.scaleY',
        keyframes: [
          { at: 0, value: 1 },
          { at: 1, value: 2 },
        ],
      },
    ],
    events: [{ at: 0.5, type: 'pose-swap' }],
    ...overrides,
  }
}

describe('sampleTimelineAt', () => {
  it('interpolates linearly between keyframes and clamps outside 0..1', () => {
    const sample = sampleTimelineAt(definition(), 0.25)
    expect(sample.layers.transition?.scale).toBe('1 1.25') // scaleX default 1, scaleY 1→2 at 0.25
    expect(sampleTimelineAt(definition(), -0.5).layers.transition?.scale).toBe('1 1') // head clamp
    expect(sampleTimelineAt(definition(), 1.5).layers.transition?.scale).toBe('1 2') // tail clamp
  })

  it('applies easing between keyframes (compiler math parity)', () => {
    const def = definition({
      tracks: [
        {
          property: 'transition.x',
          keyframes: [
            // The interval's easing lives on the STARTING keyframe (V1 rule).
            { at: 0, value: 0, easing: 'ease-in' },
            { at: 1, value: 100 },
          ],
        },
      ],
    })
    // ease-in starts slow: the half-time sample sits below the linear midpoint
    const half = sampleTimelineAt(def, 0.5).layers.transition
    expect(half?.translate).toBeDefined()
    if (half?.translate !== undefined) {
      const x = Number.parseFloat(half.translate)
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(50)
    }
  })

  it('resolves parameterized values against the strength override', () => {
    const def = definition({
      tracks: [
        {
          property: 'transition.y',
          keyframes: [{ at: 1, value: { base: 0, parameter: 'strength', amount: 10 } }],
        },
      ],
      parameters: { strength: { default: 1, min: 0, max: 3 } },
    })
    // Head completion starts at the property default (0); the tail keyframe's
    // parameterized value scales with strength.
    expect(sampleTimelineAt(def, 0).layers.transition?.translate).toBe('0px 0px')
    expect(sampleTimelineAt(def, 1, { params: { strength: 2 } }).layers.transition?.translate).toBe('0px 20px')
    expect(sampleTimelineAt(def, 1, { params: { strength: 3 } }).layers.transition?.translate).toBe('0px 30px')
  })

  it('composes every property of a touched layer in one sample', () => {
    const def = definition({
      kind: 'ambient',
      tracks: [
        {
          property: 'sway.rotation',
          keyframes: [{ at: 0, value: 10 }],
        },
        {
          property: 'breathe.scaleX',
          keyframes: [{ at: 0, value: 1.5 }],
        },
      ],
      events: [],
    })
    const sample = sampleTimelineAt(def, 0.7)
    expect(sample.layers.sway?.rotate).toBe('10deg')
    expect(sample.layers.breathe?.scale).toBe('1.5 1') // scaleY holds its default 1
    expect(sample.layers.transition).toBeUndefined() // untouched layer stays absent
  })

  it('returns the latest NAMED pose-swap at or before the time', () => {
    const def = definition({
      kind: 'interaction',
      events: [
        { at: 0.2, type: 'pose-swap', pose: 'idle' },
        { at: 0.6, type: 'pose-swap', pose: 'waiting' },
        { at: 0.9, type: 'pose-swap', pose: 'error' },
      ],
    })
    expect(sampleTimelineAt(def, 0.1).pose).toBeNull()
    expect(sampleTimelineAt(def, 0.2).pose).toBe('idle')
    expect(sampleTimelineAt(def, 0.5).pose).toBe('idle')
    expect(sampleTimelineAt(def, 0.7).pose).toBe('waiting')
    expect(sampleTimelineAt(def, 1).pose).toBe('error')
  })

  it('anonymous transition swaps and particle events never change the pose', () => {
    const anonymous = sampleTimelineAt(definition(), 0.9) // { at: 0.5, pose-swap } without pose
    expect(anonymous.pose).toBeNull()
    const particles = sampleTimelineAt(
      definition({ kind: 'interaction', events: [{ at: 0.3, type: 'particle', effect: 'confetti' }] }),
      0.5,
    )
    expect(particles.pose).toBeNull()
  })

  it('treats event order in the payload as irrelevant', () => {
    const def = definition({
      kind: 'interaction',
      events: [
        { at: 0.8, type: 'pose-swap', pose: 'success' },
        { at: 0.2, type: 'pose-swap', pose: 'idle' },
      ],
    })
    expect(sampleTimelineAt(def, 0.5).pose).toBe('idle')
    expect(sampleTimelineAt(def, 0.9).pose).toBe('success')
  })
})
