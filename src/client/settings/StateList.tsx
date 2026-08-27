/**
 * client/settings/StateList.tsx — the six pose slots (§17.1). Each row shows
 * whether the state resolves to its OWN image (● 已导入) or falls back to
 * another slot's image (○ 跟随 X), judged through the core pose-resolver's
 * real fallback chains — never a hand-rolled copy of them.
 */
import type { JSX } from 'react'
import { createPoseResolver } from '../../core/pose-resolver'
import type { AssetMeta, PetweenConfig, PoseKey } from '../../core/types'
import { POSE_KEYS } from '../../core/types'
import { STATE_LABELS } from './state-labels'
import styles from './settings.module.css'

// Re-exported for the existing import sites (PetweenSettings, PoseEditor,
// LivePreview); the definition lives in state-labels.ts so non-React modules
// (the editor store) can share it without pulling in components.
export { STATE_LABELS }

export interface StateListProps {
  config: PetweenConfig
  assets: Record<string, AssetMeta>
  selected: PoseKey
  onSelect: (state: PoseKey) => void
}

export function StateList(props: StateListProps): JSX.Element {
  const resolve = createPoseResolver(props.config.poses, props.assets)
  return (
    <nav className={styles.stateList} aria-label="状态列表">
      {POSE_KEYS.map((key) => {
        const resolved = resolve(key)
        const own = resolved !== null && resolved.poseKey === key
        // The builtin resolver only ever yields the six slots; the cast only
        // bridges ResolvedPose.poseKey's string widening for the label map.
        const source = resolved === null ? null : (POSE_KEYS as readonly string[]).includes(resolved.poseKey) ? (resolved.poseKey as PoseKey) : null
        const hint = own ? '已导入' : source !== null ? `跟随${STATE_LABELS[source]}` : '无图片'
        return (
          <button
            key={key}
            type="button"
            className={key === props.selected ? `${styles.stateItem} ${styles.stateItemSelected}` : styles.stateItem}
            onClick={() => props.onSelect(key)}
          >
            <span className={own ? styles.stateDotOwn : styles.stateDotFallback}>{own ? '●' : '○'}</span>
            <span>{STATE_LABELS[key]}</span>
            <span className={styles.stateHint}>{hint}</span>
          </button>
        )
      })}
    </nav>
  )
}
