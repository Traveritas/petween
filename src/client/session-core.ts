/**
 * client/session-core.ts — the flows OverlaySession and PreviewSession share
 * (C1-C dedup): config field adoption, §16.3 boot-pose collection, the
 * post-edit pose refresh, §22 reduced-motion evaluation and resting-pose
 * equality. Pure functions over injected seams — the two sessions keep their
 * own lifecycles and differ deliberately (overlay: SSE state source, §27
 * persistence, flash holds; preview: ManualStateSource, audition mode).
 */
import type { PetweenConfig, PoseKey, ResolvedPose } from '../core/types'
import { POSE_KEYS } from '../core/types'
import type { MotionDirector } from '../motion/motion-director'
import type { PetStage } from './overlay/pet-stage'

/**
 * §16.2 hot-swap: move a deep copy of the draft's fields onto the session's
 * OWN config object (the director/state-source hold the original reference,
 * so fields are replaced in place, never the object). Both sessions' config
 * objects stay structurally identical afterwards.
 */
export function adoptConfigFields(config: PetweenConfig, draft: PetweenConfig): void {
  const snapshot = structuredClone(draft)
  config.enabled = snapshot.enabled
  config.global = snapshot.global
  config.poses = snapshot.poses
  config.states = snapshot.states
  config.overlay = snapshot.overlay
  config.advanced = snapshot.advanced
  config.interactions = snapshot.interactions
}

/**
 * §16.3 boot preload set: every resolvable pose, deduped by asset id (six
 * slots often share images).
 */
export function collectBootPoses(resolvePose: (poseKey: PoseKey) => ResolvedPose | null): ResolvedPose[] {
  const seen = new Set<string>()
  const poses: ResolvedPose[] = []
  for (const key of POSE_KEYS) {
    const pose = resolvePose(key)
    if (pose !== null && !seen.has(pose.asset.id)) {
      seen.add(pose.asset.id)
      poses.push(pose)
    }
  }
  return poses
}

/** Resting equality of two resolved poses: same image, anchor and zoom. */
export function sameRestingPose(a: ResolvedPose, b: ResolvedPose): boolean {
  return (
    a.asset.url === b.asset.url && a.anchor.x === b.anchor.x && a.anchor.y === b.anchor.y && a.zoom === b.zoom
  )
}

/** §22: config setting ∨ system preference → the effective flag. */
export function effectiveReducedMotion(config: PetweenConfig, systemMatch: boolean): boolean {
  const setting = config.global.reducedMotion
  return setting === 'always' || (setting === 'system' && systemMatch)
}

/**
 * The shared post-edit pose refresh. Resolution follows the DIRECTOR's
 * target, not the slot on stage: a pose shown through fallback carries the
 * fallback SOURCE key on stage, while the target keeps the requested key —
 * so importing that pose's image hot-swaps it without another state change.
 *
 * A transition in flight still pose-swaps the values resolved at its start,
 * so the refresh first waits for it to settle and then re-resolves against
 * the new config. A transition that started after the edit already resolved
 * fresh values; the refresh leaves the stage to it. `isSuperseded` (the
 * caller's poseRefreshSeq guard) aborts a run overtaken by a newer refresh.
 */
export async function refreshTargetPose(args: {
  stage: PetStage
  director: MotionDirector
  resolvePose(poseKey: PoseKey): ResolvedPose | null
  isDisposed(): boolean
  isSuperseded(): boolean
}): Promise<void> {
  const { stage, director, resolvePose, isDisposed, isSuperseded } = args
  if (director.transitionInFlight) {
    await director.whenSettled()
    if (isDisposed() || isSuperseded()) return
    if (director.transitionInFlight) return // a newer transition owns the stage
  }
  const target = director.currentTarget
  if (target === null) return
  const current = stage.currentPose
  if (current === null) return
  const next = resolvePose(target.poseKey)
  if (next === null) return // no image for the target; the caller's empty path owns it
  if (sameRestingPose(next, current)) return
  await stage.preload([next])
  if (isDisposed() || isSuperseded()) return // superseded
  stage.swapPose(next)
  director.noteExternalPose(next.asset.url)
}
