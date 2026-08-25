/**
 * Standalone full-page settings editor. Served by the host at
 * /motion-pet-editor/ (host/editor-page.ts) and built as the self-contained
 * IIFE lib/editor.js — no shell, react inlined, same delivery pattern as
 * preview/preview.js.
 *
 * Mounts the SAME MotionPetSettings component the settings surfaces use, in
 * its spec §17 wide three-column layout (StateList | StateSettings |
 * LivePreview). Loads/saves through the same-origin /api/motion-pet/* HTTP
 * API via the shared editor store.
 *
 * Cross-page note: this page runs in its own browsing context, so its
 * config-hub publish() does NOT reach the main UI tab — the overlay there
 * learns edits through its 3s config poll. Acceptable by design.
 */
import { useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionPetSettings } from '../client/settings/MotionPetSettings'
import styles from './editor.module.css'

function EditorPage(): JSX.Element {
  // Portal host for the settings' SaveIndicator — the save state lives in the
  // EditorStore (owned by MotionPetSettings) but belongs visually in the page
  // header.
  const [saveSlot, setSaveSlot] = useState<HTMLSpanElement | null>(null)
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>Motion Pet 编辑器</h1>
          <p className={styles.subtitle}>
            导入姿势图片、调整过渡与循环动画，右侧实时预览。点击“保存修改”后应用到主界面。
          </p>
        </div>
        <span className={styles.saveSlot} ref={setSaveSlot} />
      </header>
      <MotionPetSettings wide saveIndicatorTarget={saveSlot} />
    </div>
  )
}

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(<EditorPage />)
}
