/**
 * motion/math.ts — pure numeric helpers shared by compiler, scheduler and
 * core tests (spec §9.2 strength math, §7.4 clamps).
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/** Scale semantics of spec §9.2: strength never multiplies scale directly. */
export function scaleByStrength(base: number, strength: number): number {
  return 1 + (base - 1) * strength
}

/** Translate semantics of spec §9.2. */
export function translateByStrength(basePx: number, strength: number): number {
  return basePx * strength
}

/** Evaluate `base + params[parameter] * amount` (spec §8.8). */
export function resolveParameterizedValue(
  value: number | { base: number; parameter: 'strength'; amount: number },
  params: { strength: number },
): number {
  if (typeof value === 'number') return value
  return value.base + params.strength * value.amount
}

export function randomInRange(min: number, max: number, random: () => number = Math.random): number {
  return min + random() * (max - min)
}

export type CubicBezierPoints = readonly [number, number, number, number]

/**
 * Standard cubic-bezier timing evaluation (Newton–Raphson with a bisection
 * fallback, same approach as WebKit's UnitBezier). Used to sample exact
 * values at segment cut points; WAAPI itself receives the CSS string.
 */
export function createCubicBezier(points: CubicBezierPoints): (t: number) => number {
  const [x1, y1, x2, y2] = points

  const sampleX = (t: number): number => {
    const u = 1 - t
    return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t
  }
  const sampleY = (t: number): number => {
    const u = 1 - t
    return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t
  }
  const sampleDerivativeX = (t: number): number => {
    const u = 1 - t
    return 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2)
  }

  const solveX = (x: number): number => {
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x
      if (Math.abs(error) < 1e-6) return t
      const derivative = sampleDerivativeX(t)
      if (Math.abs(derivative) < 1e-6) break
      t -= error / derivative
    }
    let lo = 0
    let hi = 1
    t = x
    while (hi - lo > 1e-6) {
      if (sampleX(t) < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return t
  }

  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    return sampleY(solveX(t))
  }
}
