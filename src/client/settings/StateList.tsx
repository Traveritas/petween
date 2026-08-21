/**
 * client/settings/StateList.tsx — the six pose slots (§17.1). Each row shows
 * whether the state resolves to its OWN image (● 已导入) or falls back to
 * another slot's image (○ 跟随 X), judged through the core pose-resolver's
 * real fallback chains — never a hand-rolled copy of them.
 */
import type { JSX } from 'react'
import { createPoseResolver } from '../../core/pose-resolver'
import type { AssetMeta, MotionPetConfig, PoseKey } from '../../core/types'
import { POSE_KEYS } from '../../core/types'
import styles from './settings.module.css'

export const STATE_LABELS: Record<PoseKey, string> = {
  idle: '待机',
  thinking: '思考',
  working: '工作',
  waiting: '等待',
  success: '成功',
  error: '错误',
}

export interface StateListProps {
  config: MotionPetConfig
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
        const hint = own ? '已导入' : resolved !== null ? `跟随${STATE_LABELS[resolved.poseKey]}` : '无图片'
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
