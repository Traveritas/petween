// @vitest-environment jsdom
/**
 * ManualStateSource tests (spec §16.2/§17.6): preview button clicks go
 * through the real PetStateResolver / state machine — coalescing, dedupe and
 * transient success/error holds included — and reach the MotionDirector
 * re-tagged as reason 'manual-preview'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import { createPoseResolver } from '../../src/core/pose-resolver'
import type { AssetMeta, MotionPetConfig, MotionTarget } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
import { ManualStateSource } from '../../src/client/manual-state-source'
import { createBuiltinRegistry } from '../../src/motion/animation-registry'
import { MotionDirector } from '../../src/motion/motion-director'
import { createFakeStage, installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

let harness: FakeAnimateHarness

beforeEach(() => {
  vi.useFakeTimers()
  harness = installFakeAnimate()
})

afterEach(() => {
  vi.restoreAllMocks()
  harness.restore()
  vi.useRealTimers()
})

interface Setup {
  config: MotionPetConfig
  director: MotionDirector
  source: ManualStateSource
  targets: MotionTarget[]
}

const setup = (): Setup => {
  const stage = createFakeStage()
  const registry = createBuiltinRegistry()
  const config = createDefaultMotionPetConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of POSE_KEYS) {
    config.poses[key].assetId = `asset-${key}`
    assets[`asset-${key}`] = {
      id: `asset-${key}`,
      fileName: `${key}.webp`,
      mimeType: 'image/webp',
      width: 240,
      height: 240,
      sizeBytes: 1,
      sha256: `sha-${key}`,
      url: `https://example.test/${key}.webp`,
    }
  }
  const targets: MotionTarget[] = []
  const director = new MotionDirector({ stage, registry, config, resolvePose: createPoseResolver(config.poses, assets) })
  vi.spyOn(director, 'setTarget').mockImplementation(async (target) => {
    targets.push(target)
  })
  const source = new ManualStateSource({ config, director })
  return { config, director, source, targets }
}

const COALESCE_MS = 60

describe('ManualStateSource', () => {
  it('maps the six preview buttons onto real state-machine events', async () => {
    const { source, targets } = setup()
    source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    source.sendState('active', 'working')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    source.sendState('waiting')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    source.sendState('idle')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(targets).toEqual([
      { visualState: 'active', activityMode: 'thinking', poseKey: 'thinking', reason: 'manual-preview' },
      // §15.2: activity change inside `active` keeps the current poseKey, so
      // the director only refreshes the ambient profile (no transition).
      { visualState: 'active', activityMode: 'working', poseKey: 'thinking', reason: 'manual-preview' },
      { visualState: 'waiting', activityMode: undefined, poseKey: 'waiting', reason: 'manual-preview' },
      { visualState: 'idle', activityMode: undefined, poseKey: 'idle', reason: 'manual-preview' },
    ])
  })

  it('maps success/error to turn-end with the transient hold → idle (§14.4)', async () => {
    const { config, source, targets } = setup()
    source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    source.sendState('success')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(targets.map((target) => target.visualState)).toEqual(['active', 'success'])
    // the resolver's successHoldMs timer returns the pet to idle on its own
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs)
    expect(targets.map((target) => target.visualState)).toEqual(['active', 'success', 'idle'])
  })

  it('coalesces a burst of clicks into the latest event only (§15.3)', async () => {
    const { source, targets } = setup()
    source.sendState('active', 'thinking')
    source.sendState('waiting') // same 60ms window → supersedes
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(targets.map((target) => target.visualState)).toEqual(['waiting'])
  })

  it('dedupes the identical state (§15.1)', async () => {
    const { source, targets } = setup()
    source.sendState('idle') // the resolver starts in idle already
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    source.sendState('idle')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(targets).toEqual([])
  })

  it('dispose cancels pending coalescing and hold timers', async () => {
    const { source, targets } = setup()
    source.sendState('waiting')
    source.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(targets).toEqual([])
  })
})
