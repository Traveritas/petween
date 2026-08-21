/**
 * Editor page route tests (host/editor-page.ts): the standalone full-page
 * editor is served over a real `node:http` server — the HTML shell at the
 * prefix root, the prebuilt bundle at client.js, 404 for unknown subpaths,
 * 405 for non-GET/HEAD, and a clear 500 when the bundle is missing. The
 * bundle read is injected; dispatch mirrors the DSH webServer (exact first,
 * then longest prefix).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { registerEditorPage, type EditorPageDeps } from '../../src/host/editor-page'

const TEST_BUNDLE = Buffer.from('/* motion-pet editor bundle (test) */')

let server: Server
let base: string
let dispose: () => void

const start = async (deps: EditorPageDeps): Promise<void> => {
  const routes: WebRoute[] = []
  dispose = registerEditorPage(
    {
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {
            routes.splice(routes.indexOf(route), 1)
          }
        },
      },
    },
    deps,
  )
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find(
      (candidate) =>
        candidate.kind === 'prefix' && (pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)),
    )
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(async () => {
  await start({ loadBundle: async () => TEST_BUNDLE })
})

afterEach(async () => {
  dispose()
  await new Promise((resolve) => server.close(resolve))
})

describe('GET /motion-pet-editor (HTML shell)', () => {
  it('serves the HTML shell at the bare path and the trailing slash', async () => {
    for (const path of ['/motion-pet-editor', '/motion-pet-editor/']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('<title>Motion Pet 编辑器</title>')
      expect(html).toContain('<div id="root"></div>')
      // relative bundle reference, anchored by <base> for the no-slash URL
      expect(html).toContain('<base href="/motion-pet-editor/"')
      expect(html).toContain('<script src="./client.js"></script>')
    }
  })

  it('answers HEAD with headers only', async () => {
    const res = await fetch(`${base}/motion-pet-editor/`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await res.text()).toBe('')
  })
})

describe('GET /motion-pet-editor/client.js (bundle)', () => {
  it('serves the prebuilt bundle as javascript with the right length', async () => {
    const res = await fetch(`${base}/motion-pet-editor/client.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('content-length')).toBe(String(TEST_BUNDLE.length))
    expect(await res.text()).toBe(TEST_BUNDLE.toString())
  })

  it('500s with a clear message when the bundle is missing', async () => {
    dispose()
    await new Promise((resolve) => server.close(resolve))
    await start({
      loadBundle: async () => {
        throw new Error('ENOENT: no such file')
      },
    })
    const res = await fetch(`${base}/motion-pet-editor/client.js`)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('EDITOR_BUNDLE_MISSING')
    expect(body.error.message).toContain('pnpm run build')
    // the HTML shell keeps working — only the bundle is missing
    expect((await fetch(`${base}/motion-pet-editor/`)).status).toBe(200)
  })
})

describe('route guards', () => {
  it('404s unknown subpaths', async () => {
    for (const path of ['/motion-pet-editor/foo', '/motion-pet-editor/client.js.map']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(404)
    }
  })

  it('405s non-GET/HEAD methods', async () => {
    const res = await fetch(`${base}/motion-pet-editor/`, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
    const onBundle = await fetch(`${base}/motion-pet-editor/client.js`, { method: 'DELETE' })
    expect(onBundle.status).toBe(405)
  })
})
