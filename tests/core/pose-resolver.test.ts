/**
 * PoseResolver tests (spec §29.1): exact pose, fallback chain, single image,
 * no image — plus stale asset ids falling through the chain.
 */
import { describe, expect, it } from 'vitest'
import { createDefaultPoseConfigs } from '../../src/core/defaults'
import { resolvePose } from '../../src/core/pose-resolver'
import type { AssetMeta, PoseKey } from '../../src/core/types'

const asset = (id: string): AssetMeta => ({
  id,
  fileName: `${id}.webp`,
  mimeType: 'image/webp',
  width: 240,
  height: 240,
  sizeBytes: 1024,
  sha256: `sha-${id}`,
  url: `/motion-pet-assets/${id}.webp`,
})

/** poses: which pose slots have an asset (asset id === pose key). */
const setup = (configured: PoseKey[]) => {
  const poses = createDefaultPoseConfigs()
  const assets: Record<string, AssetMeta> = {}
  for (const key of configured) {
    poses[key].assetId = key
    assets[key] = asset(key)
  }
  const lookup = (assetId: string): AssetMeta | undefined => assets[assetId]
  return { poses, lookup }
}

describe('resolvePose (§2.1 fallback)', () => {
  it('exact pose: uses the requested pose asset, anchor and zoom', () => {
    const { poses, lookup } = setup(['idle', 'thinking'])
    poses.thinking.anchor = { x: 0.4, y: 0.9 }
    poses.thinking.zoom = 1.2
    const resolved = resolvePose('thinking', poses, lookup)
    expect(resolved?.poseKey).toBe('thinking')
    expect(resolved?.asset.url).toBe('/motion-pet-assets/thinking.webp')
    expect(resolved?.asset.width).toBe(240)
    expect(resolved?.anchor).toEqual({ x: 0.4, y: 0.9 })
    expect(resolved?.zoom).toBe(1.2)
  })

  it('fallback: thinking → working → idle → first available', () => {
    // thinking missing, working present: working wins over idle
    const withWorking = setup(['idle', 'working'])
    expect(resolvePose('thinking', withWorking.poses, withWorking.lookup)?.poseKey).toBe('working')
    // thinking and working missing: idle
    const onlyIdle = setup(['idle'])
    expect(resolvePose('thinking', onlyIdle.poses, onlyIdle.lookup)?.poseKey).toBe('idle')
    // waiting → idle → thinking: idle wins over thinking
    const waitingChain = setup(['idle', 'thinking'])
    expect(resolvePose('waiting', waitingChain.poses, waitingChain.lookup)?.poseKey).toBe('idle')
  })

  it('only one image: every pose resolves to that image', () => {
    const { poses, lookup } = setup(['working'])
    for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
      expect(resolvePose(key, poses, lookup)?.poseKey).toBe('working')
    }
  })

  it('no image at all: null (overlay stays hidden)', () => {
    const { poses, lookup } = setup([])
    expect(resolvePose('idle', poses, lookup)).toBeNull()
    expect(resolvePose('success', poses, lookup)).toBeNull()
  })

  it('a stale assetId (asset deleted) falls through to the next chain entry', () => {
    const { poses } = setup(['idle'])
    poses.thinking.assetId = 'deleted-asset'
    const resolved = resolvePose('thinking', poses, (assetId) => (assetId === 'idle' ? asset('idle') : undefined))
    expect(resolved?.poseKey).toBe('idle')
  })
})
