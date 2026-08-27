/**
 * client/settings/PetweenCard.tsx — the compact settings.section entry
 * card. The ~600px settings dialog only carries the daily quick controls:
 * a status summary (imported poses · enabled state), the enable toggle, the
 * scale slider (0.3..4 — aligned with the full editor and host validation)
 * and a prominent link to the standalone full-page editor (EDITOR_PAGE_URL,
 * new tab). The full editor (PetweenSettings) lives on that page.
 *
 * State goes through the same EditorStore as the full editor (hub-shared in
 * production), so quick edits stay local until the shared Save button is
 * clicked.
 */
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { POSE_KEYS } from '../../core/types'
import { EDITOR_PAGE_URL } from '../api'
import { configHub } from '../config-hub'
import { EditorStore, type EditorApi } from '../stores/editor-store'
import { Slider, Toggle } from './controls'
import { SaveIndicator } from './PetweenSettings'
import styles from './settings.module.css'

export interface PetweenCardProps {
  /** Test seam; production shares the config hub with the overlay. */
  api?: EditorApi
}

export function PetweenCard(props: PetweenCardProps): JSX.Element {
  const [store] = useState(
    () => new EditorStore(props.api !== undefined ? { api: props.api } : { hub: configHub }),
  )
  useEffect(() => {
    void store.load()
    return () => {
      // DSH tears its settings dialog down without a vetoable close event, so
      // this cleanup is the card's only hook — the teardown cannot be stopped.
      // Closing NEVER saves: a save fired here would run after dispose() with
      // nobody left to see it fail (silent loss). Instead, tell the user the
      // draft is gone and how to keep it next time (the full-page editor
      // guards tab close via beforeunload; this guards the dialog close).
      if (store.getSnapshot().saveState === 'dirty') {
        window.alert('Petween 卡片有未保存的修改，已随卡片关闭丢弃。如需保留，请在关闭前点击保存。')
      }
      store.dispose()
    }
  }, [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  if (snapshot.status === 'loading') {
    return <div className={styles.status}>正在加载 Petween 配置…</div>
  }
  if (snapshot.status === 'error' || snapshot.config === null) {
    return (
      <div className={styles.status}>
        配置加载失败{snapshot.loadError !== null ? `：${snapshot.loadError}` : ''}
        <button type="button" className={`${styles.button} ${styles.retry}`} onClick={() => void store.load()}>
          重试
        </button>
      </div>
    )
  }

  const config = snapshot.config
  const imported = POSE_KEYS.filter((key) => {
    const assetId = config.poses[key].assetId
    return assetId !== undefined && snapshot.assets[assetId] !== undefined
  }).length

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Petween</span>
        <span className={styles.cardSummary}>
          已导入 {imported}/{POSE_KEYS.length} 张图 · {config.enabled ? '启用中' : '已停用'}
        </span>
      </div>
      <Toggle
        label="启用宠物"
        checked={config.enabled}
        onChange={(checked) =>
          store.updateConfig((draft) => {
            draft.enabled = checked
          })
        }
      />
      <Slider
        label="整体缩放"
        min={0.3}
        max={4}
        step={0.05}
        value={config.global.scale}
        onChange={(value) =>
          store.updateConfig((draft) => {
            draft.global.scale = value
          })
        }
      />
      {imported === 0 ? (
        <p className={styles.hint}>还没有导入图片——宠物不会显示。先到完整编辑器导入至少一张。</p>
      ) : null}
      <a className={styles.cardLink} href={EDITOR_PAGE_URL} target="_blank" rel="noreferrer">
        打开完整编辑器 →
      </a>
      <SaveIndicator snapshot={snapshot} store={store} />
    </div>
  )
}
