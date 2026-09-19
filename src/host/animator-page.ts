/**
 * host/animator-page.ts — serves the standalone animation workbench at
 * /petween-animator/ (V1.2): a timeline-first page (animation library, large
 * audition preview, full-width visual timeline editor) built as the
 * self-contained IIFE lib/animator.js. Same route skeleton as the settings
 * editor page (static-page.ts).
 *
 * Intended hosts: the desktop shell opens it in a dedicated on-demand
 * window; DSH users can reach it by URL (deliberately no settings-dialog
 * entry — pet/image/pose management stays in the settings editor, this page
 * edits animations only).
 */
import type { RoutesHost } from './routes'
import { createStaticPageRoute, type StaticPageDeps } from './static-page'

export const ANIMATOR_PAGE_PATH = '/petween-animator'

export type AnimatorPageDeps = StaticPageDeps

/** Register the animator page route; the returned disposer unregisters it. */
export const registerAnimatorPage: (host: RoutesHost, deps?: AnimatorPageDeps) => () => void =
  createStaticPageRoute({
    path: ANIMATOR_PAGE_PATH,
    title: 'Petween 动画编辑器',
    bundleRelPath: './animator.js',
    bundleErrorCode: 'ANIMATOR_BUNDLE_MISSING',
  })
