/**
 * host/static-page.ts — the shared skeleton behind the host-served
 * standalone pages (/petween-editor/ and /petween-animator/): an HTML shell
 * plus a prebuilt self-contained IIFE bundle under one prefix route. The
 * page then talks to the same-origin `/api/petween/*` HTTP API. No shell
 * module loader involved — the same delivery pattern as preview/preview.js.
 *
 * Route shape (one prefix registration per page):
 * - GET/HEAD `<path>` and `<path>/`   → the HTML shell
 * - GET/HEAD `<path>/client.js`       → the page bundle
 * Everything below the prefix: 404. Other methods: 405.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RoutesHost } from './routes'

export interface StaticPageOptions {
  /** Prefix the page is served under, e.g. '/petween-editor'. */
  path: string
  /** The HTML shell's `<title>`. */
  title: string
  /**
   * Where the default loadBundle finds the prebuilt bundle, relative to the
   * built host bundle (lib/index.js) — e.g. './editor.js'. Both repo lib/ and
   * tarball lib/ carry the bundle. Injected loadBundles (tests, the desktop
   * shell deep-importing TS source) bypass this entirely.
   */
  bundleRelPath: string
  /** Machine-readable error code for the bundle-missing 500. */
  bundleErrorCode: string
}

export interface StaticPageDeps {
  /** Reads the prebuilt page bundle; injected by tests and the desktop shell. */
  loadBundle?: () => Promise<Buffer>
}

/**
 * `<base>` makes the relative `./client.js` resolve to the prefix even when
 * the page was served from the bare no-slash path. `no-store` everywhere: a
 * rebuilt plugin must show up after a plain restart + reload.
 */
function pageHtml(options: StaticPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="${options.path}/" />
    <title>${options.title}</title>
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
}

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

/**
 * Build a page registrar for one standalone page. The returned function
 * registers the prefix route; its disposer unregisters it.
 */
export function createStaticPageRoute(
  options: StaticPageOptions,
): (host: RoutesHost, deps?: StaticPageDeps) => () => void {
  const html = pageHtml(options)
  return (host: RoutesHost, deps: StaticPageDeps = {}) => {
    // Read once, up front; the settled promise doubles as the cache. A missing
    // bundle (unbuilt checkout) resolves null and degrades to a clear 500
    // instead of an unhandled rejection or a hung request.
    const bundle: Promise<Buffer | null> = Promise.resolve()
      .then(deps.loadBundle ?? (() => readFile(new URL(options.bundleRelPath, import.meta.url))))
      .then(
        (data) => data,
        () => null,
      )
    return host.webServer.register({
      kind: 'prefix',
      path: options.path,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', 'expected GET or HEAD', { allow: 'GET, HEAD' })
          return
        }
        const pathname = parsePathname(req.url)
        if (pathname === options.path || pathname === `${options.path}/`) {
          sendPage(req, res, 'text/html; charset=utf-8', html)
          return
        }
        if (pathname === `${options.path}/client.js`) {
          const data = await bundle
          if (data === null) {
            sendError(res, 500, options.bundleErrorCode, 'page bundle unavailable — run "pnpm run build" and restart dsh')
            return
          }
          sendPage(req, res, 'text/javascript; charset=utf-8', data)
          return
        }
        sendError(res, 404, 'NOT_FOUND', `unknown ${options.path} path`)
      },
    })
  }
}
