/**
 * client/settings/PoseEditor.tsx — per-state pose image panel (§17.2):
 * import/replace/remove the image (upload flow lives in the editor store,
 * §19.4), Anchor X/Y sliders (0..1, step 0.01 — spec §7.3) and the Zoom
 * slider (0.2..8, host validation bounds).
 */
import type { JSX } from 'react'
import type { AssetMeta, MotionPetConfig, PoseKey } from '../../core/types'
import type { EditorStore } from '../stores/editor-store'
import { FileImportButton, Slider } from './controls'
import { STATE_LABELS } from './StateList'
import styles from './settings.module.css'

export interface PoseEditorProps {
  state: PoseKey
  config: MotionPetConfig
  assets: Record<string, AssetMeta>
  /** UX-3: true while this slot's image upload is in flight (shows 上传中…). */
  importing?: boolean
  store: EditorStore
}

export function PoseEditor(props: PoseEditorProps): JSX.Element {
  const { state, config, assets, store } = props
  const pose = config.poses[state]
  const asset = pose.assetId !== undefined ? assets[pose.assetId] : undefined

  return (
    <section className={styles.section} aria-label="姿势图片">
      <h3 className={styles.sectionTitle}>姿势图片 · {STATE_LABELS[state]}</h3>
      {asset !== undefined ? (
        <div className={styles.assetRow}>
          <img className={styles.assetThumb} src={asset.url} alt={`${STATE_LABELS[state]}姿势图片`} />
          <div className={styles.assetMeta}>
            <span>
              {asset.width}×{asset.height}
            </span>
            <button type="button" className={styles.button} onClick={() => void store.removeImage(state)}>
              移除图片
            </button>
          </div>
        </div>
      ) : (
        <p className={styles.hint}>未导入图片，该状态将跟随其它状态的图片。</p>
      )}
      <FileImportButton
        label={asset !== undefined ? '更换图片' : '导入图片'}
        busy={props.importing === true}
        onFile={(file) => void store.importImage(state, file)}
      />
      <Slider
        label="锚点 X"
        min={0}
        max={1}
        step={0.01}
        value={pose.anchor.x}
        onChange={(value) =>
          store.updateConfig((draft) => {
            draft.poses[state].anchor.x = value
          })
        }
      />
      <Slider
        label="锚点 Y"
        min={0}
        max={1}
        step={0.01}
        value={pose.anchor.y}
        onChange={(value) =>
          store.updateConfig((draft) => {
            draft.poses[state].anchor.y = value
          })
        }
      />
      <Slider
        label="图片缩放"
        min={0.2}
        max={8}
        step={0.05}
        value={pose.zoom}
        onChange={(value) =>
          store.updateConfig((draft) => {
            draft.poses[state].zoom = value
          })
        }
      />
      <p className={styles.hint}>锚点（Anchor）是图片上对准地面固定点的位置（默认 0.5 / 0.96，即脚底中心）。</p>
    </section>
  )
}
