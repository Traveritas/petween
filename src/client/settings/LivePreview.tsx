/**
 * client/settings/LivePreview.tsx — the settings Live Preview (§2.1, §17.6).
 * Reuses the SAME PetRenderer + PreviewSession + ManualStateSource stack as
 * the standalone preview and the future overlay (§16.2 — no preview-only
 * transition path): state buttons go through the real PetStateResolver /
 * state machine, and every draft config change hot-swaps into the running
 * session (PreviewSession.updateConfig).
 *
 * Pose images come from the draft's assets map — i.e. only assets the host
 * has already accepted (the store uploads first, then updates the draft;
 * §19.3), so this component never deals with local File objects.
 */
import { useEffect, useState, type JSX, type MutableRefObject } from 'react'
import type { AssetMeta, PetweenConfig, PoseKey } from '../../core/types'
import { PetRenderer } from '../overlay/PetRenderer'
import type { PetStage } from '../overlay/pet-stage'
import { sendStateSlot, type PreviewSession } from '../preview-session'
import { Toggle } from './controls'
import { STATE_LABELS } from './StateList'
import styles from './settings.module.css'

/** Preview state buttons; sendStateSlot maps them to semantic events (the
 * reduction to visual targets stays the resolver's job). */
const STATE_BUTTONS: readonly PoseKey[] = ['idle', 'thinking', 'working', 'waiting', 'success', 'error']

export interface LivePreviewProps {
  config: PetweenConfig
  assets: Record<string, AssetMeta>
  /** Bumped by the store on every content change; drives the session hot-sync. */
  configRevision: number
  /** Owned by PetweenSettings: the session is born/dies with the stage. */
  sessionRef: MutableRefObject<PreviewSession | null>
  onStage: (stage: PetStage | null) => void
  onReplay: () => void
}

export function LivePreview(props: LivePreviewProps): JSX.Element {
  const { config, assets, configRevision, sessionRef, onStage, onReplay } = props
  const [showAnchor, setShowAnchor] = useState(false)

  // Push every draft edit into the live session. config/assets identities
  // only change together with configRevision, so the revision covers them.
  useEffect(() => {
    void sessionRef.current?.updateConfig(config, assets).catch((error: unknown) => {
      console.warn('petween: live preview config sync failed', error)
    })
  }, [config, assets, configRevision, sessionRef])

  return (
    <div className={styles.preview}>
      <div className={styles.previewStage}>
        <PetRenderer onStage={onStage} showAnchorMarker={showAnchor} embedded />
      </div>
      <div className={styles.previewButtons}>
        {STATE_BUTTONS.map((state) => (
          <button
            key={state}
            type="button"
            className={styles.button}
            onClick={() => {
              const session = sessionRef.current
              if (session !== null) sendStateSlot(session.source, state)
            }}
          >
            {STATE_LABELS[state]}
          </button>
        ))}
      </div>
      <div className={styles.previewToolbar}>
        <button
          type="button"
          className={styles.button}
          data-tooltip="预览与主界面宠物使用同一套渲染与状态机。"
          onClick={onReplay}
        >
          ▶ 重播进入动画
        </button>
        <Toggle label="锚点十字" checked={showAnchor} onChange={setShowAnchor} />
      </div>
    </div>
  )
}
