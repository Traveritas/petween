/**
 * Standalone animation workbench entry. Served by the host at
 * /petween-animator/ (host/animator-page.ts) and built as the self-contained
 * IIFE lib/animator.js — same delivery pattern as the settings editor page
 * (lib/editor.js), no shell, react inlined.
 *
 * The desktop shell opens this page in a dedicated on-demand window; DSH
 * users can reach it by URL. Cross-context note (same as the editor page):
 * this page's config-hub publishes do NOT reach other browsing contexts —
 * the overlay and the settings editor learn saves through their 3s polls.
 *
 * The editor page chrome import supplies the body treatment + token fallback
 * (editor.module.css); the workbench layout lives in animator.module.css.
 */
import { createRoot } from 'react-dom/client'
import { AnimatorPage } from './AnimatorPage'
import '../editor/editor.module.css'

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(<AnimatorPage />)
}
