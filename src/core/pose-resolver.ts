/**
 * core/pose-resolver.ts — pose image fallback resolution (spec §2.1
 * "状态图片 fallback"). Users are not required to provide all six images;
 * every requested pose walks a fixed fallback chain and ends at the first
 * available image. Returns null only when nothing is imported at all.
 */
import type { AssetMeta, PoseConfig, PoseKey, ResolvedPose } from './types'
import { POSE_KEYS } from './types'

export type AssetLookup = (assetId: string) => AssetMeta | undefined

/**
 * Per-pose fallback chains (spec §2.1). "first available" is appended
 * implicitly and means the first configured pose in POSE_KEYS order.
 */
const FALLBACK_CHAINS: Record<PoseKey, readonly PoseKey[]> = {
  idle: ['idle'],
  thinking: ['thinking', 'working', 'idle'],
  working: ['working', 'thinking', 'idle'],
  waiting: ['waiting', 'idle', 'thinking'],
  success: ['success', 'idle', 'thinking'],
  error: ['error', 'idle', 'thinking'],
}

function tryResolve(poseKey: PoseKey, poses: Record<PoseKey, PoseConfig>, getAsset: AssetLookup): ResolvedPose | null {
  const config = poses[poseKey]
  if (config.assetId === undefined || config.assetId === '') return null
  const asset = getAsset(config.assetId)
  if (asset === undefined) return null
  return {
    poseKey,
    asset: { id: asset.id, url: asset.url, width: asset.width, height: asset.height },
    anchor: { ...config.anchor },
    zoom: config.zoom,
  }
}

/**
 * Resolve the pose to display for `requested`. Tries the fallback chain, then
 * any configured pose in POSE_KEYS order ("first available"). Null when the
 * user has not imported a single usable image (overlay stays hidden, §2.1).
 */
export function resolvePose(
  requested: PoseKey,
  poses: Record<PoseKey, PoseConfig>,
  getAsset: AssetLookup,
): ResolvedPose | null {
  const tried = new Set<PoseKey>()
  for (const key of FALLBACK_CHAINS[requested]) {
    tried.add(key)
    const resolved = tryResolve(key, poses, getAsset)
    if (resolved !== null) return resolved
  }
  for (const key of POSE_KEYS) {
    if (tried.has(key)) continue
    const resolved = tryResolve(key, poses, getAsset)
    if (resolved !== null) return resolved
  }
  return null
}

/** Convenience factory: bind pose configs + an asset map into a lookup fn. */
export function createPoseResolver(
  poses: Record<PoseKey, PoseConfig>,
  assets: Record<string, AssetMeta>,
): (requested: PoseKey) => ResolvedPose | null {
  return (requested) => resolvePose(requested, poses, (assetId) => assets[assetId])
}
