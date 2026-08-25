// @vitest-environment jsdom
/**
 * Integration test (spec §29.4): PetStateResolver → MotionDirector over the
 * fake stage. Walks idle → thinking → command → waiting → thinking → success
 * → idle and asserts transition counts and ambient-only updates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import { PetStateResolver } from '../../src/core/pet-state-resolver'
import { createPoseResolver } from '../../src/core/pose-resolver'
import type { AssetMeta, PetSemanticEvent } from '../../src/core/types'
import { createBuiltinRegistry } from '../../src/motion/animation-registry'
import { MotionDirector } from '../../src/motion/motion-director'
import { createFakeStage, installFakeAnimate, type FakeAnimateHarness, type FakeStage } from './fake-animate'

let harness: FakeAnimateHarness
let stage: FakeStage
let director: MotionDirector
let resolver: PetStateResolver

beforeEach(() => {
  vi.useFakeTimers()
  harness = installFakeAnimate()
  stage = createFakeStage()
  const config = createDefaultPetweenConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
    assets[key] = {
      id: key,
      fileName: `${key}.webp`,
      mimeType: 'image/webp',
      width: 240,
      height: 240,
      sizeBytes: 1024,
      sha256: `sha-${key}`,
      url: `/petween-assets/${key}.webp`,
    }
    config.poses[key].assetId = key
  }
  director = new MotionDirector({
    stage,
    registry: createBuiltinRegistry(),
    config,
    resolvePose: createPoseResolver(config.poses, assets),
  })
  resolver = new PetStateResolver({
    config,
    onTarget: (next) => {
      void director.setTarget(next)
    },
  })
})

afterEach(() => {
  resolver.dispose()
  director.dispose()
  harness.restore()
  vi.useRealTimers()
})

/** Feed an event, flush coalescing, and drain every transition animation. */
const step = async (event: PetSemanticEvent): Promise<void> => {
  resolver.handleEvent(event)
  await vi.advanceTimersByTimeAsync(60)
  for (let guard = 0; guard < 20; guard += 1) {
    const running = harness.pending().filter((animation) => animation.options.iterations !== Infinity)
    if (running.length === 0) return
    for (const animation of running) animation.finish()
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error('animations did not settle')
}

const transitionRunCount = (): number =>
  harness.animations.filter((animation) => animation.target === stage.layers.transition).length

describe('integration: resolver → director (§29.4)', () => {
  it('idle → thinking → command → waiting → thinking → success → idle', async () => {
    // idle → active(thinking): one enter transition (comic-pop via 'global')
    await step({ type: 'turn-start' })
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])
    expect(transitionRunCount()).toBe(2) // pre + post segments
    // thinking ambient: sway loop running on the sway layer
    expect(
      harness.animations.some((a) => a.target === stage.layers.sway && a.options.iterations === Infinity),
    ).toBe(true)

    // thinking → command: ZERO pose transition, ambient-only update
    await step({ type: 'activity', mode: 'command' })
    expect(stage.swapped).toHaveLength(1)
    expect(transitionRunCount()).toBe(2)
    // working ambient: breathe loop on, sway loop stopped
    expect(
      harness.animations.some((a) => a.target === stage.layers.breathe && a.playState === 'running'),
    ).toBe(true)
    expect(harness.animations.filter((a) => a.target === stage.layers.sway && a.playState === 'running')).toHaveLength(0)

    // active → waiting: one transition
    await step({ type: 'waiting' })
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'waiting'])
    expect(transitionRunCount()).toBe(4)

    // waiting → active(thinking): one transition back to the thinking pose
    await step({ type: 'activity', mode: 'thinking' })
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'waiting', 'thinking'])
    expect(transitionRunCount()).toBe(6)

    // active → success: celebrate runs once
    await step({ type: 'turn-end', outcome: 'success' })
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'waiting', 'thinking', 'success'])
    expect(transitionRunCount()).toBe(8)

    // success is transient: after the hold the pet returns to idle by itself
    await vi.advanceTimersByTimeAsync(1600)
    await vi.advanceTimersByTimeAsync(60) // coalescing window of the idle target
    for (let guard = 0; guard < 20 && harness.pending().some((a) => a.options.iterations !== Infinity); guard += 1) {
      harness.finishPending()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'waiting', 'thinking', 'success', 'idle'])
    expect(transitionRunCount()).toBe(10)
  })
})
