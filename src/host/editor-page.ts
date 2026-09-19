/**
 * host/editor-page.ts — serves the standalone full-page settings editor at
 * /petween-editor/ (the settings dialog is ~600px wide; the page restores
 * spec §17's three-column layout). The route skeleton (HTML shell + prebuilt
 * IIFE bundle + 404/405/500 guards) lives in static-page.ts; this file only
 * names the editor's slot in it. The page bundle is lib/editor.js (react
 * inlined) and talks to the same-origin `/api/petween/*` HTTP API once
 * loaded.
 */
import type { RoutesHost } from './routes'
import { createStaticPageRoute, type StaticPageDeps } from './static-page'

export const EDITOR_PAGE_PATH = '/petween-editor'

export type EditorPageDeps = StaticPageDeps

/** Register the editor page route; the returned disposer unregisters it. */
export const registerEditorPage: (host: RoutesHost, deps?: EditorPageDeps) => () => void =
  createStaticPageRoute({
    path: EDITOR_PAGE_PATH,
    title: 'Petween 编辑器',
    bundleRelPath: './editor.js',
    bundleErrorCode: 'EDITOR_BUNDLE_MISSING',
  })
