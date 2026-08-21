/**
 * Transition math tests (spec §29.1): strength 0 / 1 / 1.8 for both §9.2
 * semantics, ParameterizedValue evaluation (§8.8), duration clamp (§7.4),
 * random ranges and the cubic-bezier sampler.
 */
import { describe, expect, it } from 'vitest'
import {
  clamp,
  createCubicBezier,
  lerp,
  randomInRange,
  resolveParameterizedValue,
  scaleByStrength,
  translateByStrength,
} from '../../src/motion/math'
import { TRANSITION_DURATION_LIMITS } from '../../src/core/types'

describe('strength math (§9.2)', () => {
  it.each([
    { strength: 0, expectedScale: 1, expectedPx: 0 },
    { strength: 1, expectedScale: 1.16, expectedPx: 4 },
    { strength: 1.8, expectedScale: 1.288, expectedPx: 7.2 },
  ])('strength=$strength', ({ strength, expectedScale, expectedPx }) => {
    expect(scaleByStrength(1.16, strength)).toBeCloseTo(expectedScale, 10)
    expect(translateByStrength(4, strength)).toBeCloseTo(expectedPx, 10)
  })

  it('ParameterizedValue evaluates base + strength * amount (§8.8)', () => {
    const value = { base: 1, parameter: 'strength' as const, amount: 0.16 }
    expect(resolveParameterizedValue(value, { strength: 0.5 })).toBeCloseTo(1.08, 10)
    expect(resolveParameterizedValue(value, { strength: 1 })).toBeCloseTo(1.16, 10)
    expect(resolveParameterizedValue(2.5, { strength: 1 })).toBe(2.5)
  })
})

describe('clamp / duration clamp (§7.4)', () => {
  it('clamps into range', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })

  it('transition duration clamps to 60..2000ms (widened §7.4)', () => {
    const { min, max } = TRANSITION_DURATION_LIMITS
    expect(clamp(10, min, max)).toBe(60)
    expect(clamp(5000, min, max)).toBe(2000)
    expect(clamp(260, min, max)).toBe(260)
  })
})

describe('lerp / randomInRange', () => {
  it('lerp', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5)
    expect(lerp(-4, 4, 1)).toBe(4)
  })

  it('randomInRange stays inside [min, max]', () => {
    expect(randomInRange(800, 1300, () => 0)).toBe(800)
    expect(randomInRange(800, 1300, () => 0.999)).toBeCloseTo(1299.5, 5)
    expect(randomInRange(800, 1300, () => 1)).toBe(1300)
  })
})

describe('createCubicBezier', () => {
  it('linear is identity, endpoints are exact', () => {
    const linear = createCubicBezier([0, 0, 1, 1])
    expect(linear(0)).toBe(0)
    expect(linear(0.5)).toBeCloseTo(0.5, 6)
    expect(linear(1)).toBe(1)
  })

  it('ease-out runs ahead of linear mid-way', () => {
    const easeOut = createCubicBezier([0, 0, 0.58, 1])
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
    expect(easeOut(0.5)).toBeLessThan(1)
  })
})
