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
import type { AssetMeta, MotionPetConfig, PoseKey } from '../../core/types'
import { PetRenderer } from '../overlay/PetRenderer'
import type { PetStage } from '../overlay/pet-stage'
import type { PreviewSession } from '../preview-session'
import { Toggle } from './controls'
import { STATE_LABELS } from './StateList'
import styles from './settings.module.css'

/** Button → semantic intent; the reduction to visual targets is the resolver's job. */
const STATE_BUTTONS: ReadonlyArray<{ state: PoseKey; send: (session: PreviewSession) => void }> = [
  { state: 'idle', send: (session) => session.source.sendState('idle') },
  { state: 'thinking', send: (session) => session.source.sendState('active', 'thinking') },
  { state: 'working', send: (session) => session.source.sendState('active', 'working') },
  { state: 'waiting', send: (session) => session.source.sendState('waiting') },
  { state: 'success', send: (session) => session.source.sendState('success') },
  { state: 'error', send: (session) => session.source.sendState('error') },
]

export interface LivePreviewProps {
  config: MotionPetConfig
  assets: Record<string, AssetMeta>
  /** Bumped by the store on every content change; drives the session hot-sync. */
  configRevision: number
  /** Owned by MotionPetSettings: the session is born/dies with the stage. */
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
    void sessionRef.current?.updateConfig(config, assets)
  }, [config, assets, configRevision, sessionRef])

  return (
    <div className={styles.preview}>
      <div className={styles.previewStage}>
        <PetRenderer onStage={onStage} showAnchorMarker={showAnchor} embedded />
      </div>
      <div className={styles.previewButtons}>
        {STATE_BUTTONS.map((button) => (
          <button
            key={button.state}
            type="button"
            className={styles.button}
            onClick={() => {
              const session = sessionRef.current
              if (session !== null) button.send(session)
            }}
          >
            {STATE_LABELS[button.state]}
          </button>
        ))}
      </div>
      <div className={styles.previewToolbar}>
        <button type="button" className={styles.button} onClick={onReplay}>
          ▶ 重播进入动画
        </button>
        <Toggle label="Anchor 十字" checked={showAnchor} onChange={setShowAnchor} />
      </div>
      <p className={styles.hint}>预览与真实 Overlay 使用同一套渲染与状态机（§16.2）。</p>
    </div>
  )
}
