/**
 * V1.2 snap + adaptive ruler tests (client/timeline/timeline-model.ts):
 * target snapping semantics (grid rounding, target capture radius, Alt
 * bypass), the 1-2-5 adaptive step math across zoom levels, and tick labels.
 */
import { describe, expect, it } from 'vitest'
import { adaptiveGridStep, formatTickMs, snapAtWithTargets } from '../../src/client/timeline/timeline-model'

describe('snapAtWithTargets', () => {
  it('rounds to the adaptive grid when no target captures', () => {
    const snap = snapAtWithTargets(0.137, { enabled: true, grid: 0.1, targets: [], threshold: 0.01 })
    expect(snap).toBe(0.1)
    expect(snapAtWithTargets(0.999, { enabled: true, grid: 0.25, targets: [], threshold: 0.01 })).toBe(1)
  })

  it('a target inside the threshold wins over the grid', () => {
    const snap = snapAtWithTargets(0.52, { enabled: true, grid: 0.1, targets: [0.5], threshold: 0.05 })
    expect(snap).toBe(0.5)
  })

  it('targets outside the threshold are ignored', () => {
    expect(snapAtWithTargets(0.52, { enabled: true, grid: 0.1, targets: [0.6], threshold: 0.05 })).toBe(0.5)
  })

  it('the nearest of several capturing targets wins', () => {
    const snap = snapAtWithTargets(0.55, { enabled: true, grid: 0.1, targets: [0.5, 0.6], threshold: 0.2 })
    expect(snap).toBe(0.6) // |0.55-0.6| < |0.55-0.5|
  })

  it('disabled (Alt hold / toggle off) passes the raw clamped time through', () => {
    expect(snapAtWithTargets(0.137, { enabled: false, grid: 0.1, targets: [0.2], threshold: 0.5 })).toBe(0.137)
    expect(snapAtWithTargets(1.4, { enabled: false, grid: 0.1, targets: [], threshold: 0.1 })).toBe(1)
  })
})

describe('adaptiveGridStep', () => {
  it('keeps the step at or above the minimum pixel spacing', () => {
    // 1000ms over a 1000px lane at 1× → 1px/ms → smallest nice step ≥44px is 50ms
    expect(adaptiveGridStep(1000, 1000, 1)).toEqual({ stepMs: 50, grid: 0.05 })
    // zoomed 10× → 10px/ms → 5ms ticks stay ≥44px
    expect(adaptiveGridStep(1000, 1000, 10).stepMs).toBe(5)
    // a short 300ms animation on a narrow lane stays readable (≥44px → 10ms)
    expect(adaptiveGridStep(300, 300, 1).stepMs).toBe(50)
  })

  it('always returns a 1-2-5×10^k step', () => {
    for (const durationMs of [80, 300, 1200, 10000, 120000]) {
      for (const zoom of [1, 2, 4, 8, 16, 64]) {
        const { stepMs } = adaptiveGridStep(durationMs, 800, zoom)
        const mantissa = stepMs / 10 ** Math.floor(Math.log10(stepMs))
        expect([1, 2, 5]).toContain(mantissa)
      }
    }
  })

  it('crosses decades correctly when min spacing exceeds 5×10^k', () => {
    // 0.68px/ms → min 65ms → 10/20/50 all too small → next decade's 1× = 100ms
    expect(adaptiveGridStep(1000, 680, 1).stepMs).toBe(100)
    // ~0.147px/ms → min 300ms → 500 (5×10^2) is the first nice step that fits
    expect(adaptiveGridStep(1000, 1000 / 6.8, 1).stepMs).toBe(500)
  })
})

describe('formatTickMs', () => {
  it('labels seconds past 1000ms, ms below, and bare zero', () => {
    expect(formatTickMs(0)).toBe('0')
    expect(formatTickMs(50)).toBe('50ms')
    expect(formatTickMs(250)).toBe('250ms')
    expect(formatTickMs(1000)).toBe('1s')
    expect(formatTickMs(2500)).toBe('2.5s')
  })
})
