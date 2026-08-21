/**
 * host/editor-page.ts — serves the standalone full-page settings editor as a
 * self-contained browser page (the settings dialog is ~600px wide; the page
 * restores spec §17's three-column layout). The host answers the HTML shell
 * plus the prebuilt IIFE bundle (lib/editor.js, react inlined); the page then
 * talks to the same-origin `/api/motion-pet/*` HTTP API. No shell module
 * loader involved — the same pattern as preview/preview.js.
 *
 * Routes (one prefix registration, `/motion-pet-editor`):
 * - GET/HEAD `/motion-pet-editor` and `/motion-pet-editor/` → the HTML shell
 * - GET/HEAD `/motion-pet-editor/client.js`                 → the editor bundle
 * Everything below the prefix: 404. Other methods: 405.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RoutesHost } from './routes'

export const EDITOR_PAGE_PATH = '/motion-pet-editor'

export interface EditorPageDeps {
  /**
   * Reads the prebuilt editor bundle; injected by tests. The default resolves
   * lib/editor.js next to the built host bundle via import.meta.url — both
   * link installs (repo lib/) and tarball installs (package lib/) carry it.
   */
  loadBundle?: () => Promise<Buffer>
}

/**
 * `<base>` makes the relative `./client.js` resolve to the prefix even when
 * the page was served from the bare no-slash path. `no-store` everywhere: a
 * rebuilt plugin must show up after a plain restart + reload.
 */
const EDITOR_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="/motion-pet-editor/" />
    <title>Motion Pet 编辑器</title>
    <style>
      html, body { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./client.js"></script>
  </body>
</html>
`

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { error: { code, message } }, headers)
}

function sendPage(
  req: IncomingMessage,
  res: ServerResponse,
  contentType: string,
  body: Buffer | string,
): void {
  const data = typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : data)
}

function parsePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

/** Register the editor page route; the returned disposer unregisters it. */
export function registerEditorPage(host: RoutesHost, deps: EditorPageDeps = {}): () => void {
  // Read once, up front; the settled promise doubles as the cache. A missing
  // bundle (unbuilt checkout) resolves null and degrades to a clear 500
  // instead of an unhandled rejection or a hung request.
  const bundle: Promise<Buffer | null> = Promise.resolve()
    .then(deps.loadBundle ?? (() => readFile(new URL('./editor.js', import.meta.url))))
    .then(
      (data) => data,
      () => null,
    )
  return host.webServer.register({
    kind: 'prefix',
    path: EDITOR_PAGE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'expected GET or HEAD', { allow: 'GET, HEAD' })
        return
      }
      const pathname = parsePathname(req.url)
      if (pathname === EDITOR_PAGE_PATH || pathname === `${EDITOR_PAGE_PATH}/`) {
        sendPage(req, res, 'text/html; charset=utf-8', EDITOR_HTML)
        return
      }
      if (pathname === `${EDITOR_PAGE_PATH}/client.js`) {
        const data = await bundle
        if (data === null) {
          sendError(res, 500, 'EDITOR_BUNDLE_MISSING', 'editor bundle unavailable — run "pnpm run build" and restart dsh')
          return
        }
        sendPage(req, res, 'text/javascript; charset=utf-8', data)
        return
      }
      sendError(res, 404, 'NOT_FOUND', 'unknown editor path')
    },
  })
}
