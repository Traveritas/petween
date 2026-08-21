/**
 * Host route tests (spec §19, §29.2): the registered handlers are wired into
 * a real `node:http` server (exact-then-longest-prefix dispatch, mirroring
 * the DSH webServer) and exercised with real fetch calls — config roundtrip,
 * multipart uploads, static serving, traversal guards, delete semantics.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { MotionPetConfig } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { AnimationsStore } from '../../src/host/animations'
import { AssetStore } from '../../src/host/assets'
import { ConfigStore } from '../../src/host/config'
import { registerRoutes, type RoutesDeps } from '../../src/host/routes'
import { makeJpeg, makePng, makeSvg, makeWebp } from './fixtures'

let dir: string
let server: Server
let base: string
let disposeRoutes: () => void
let deps: RoutesDeps

function uploadBody(bytes: Buffer, mime: string, fieldName = 'file'): FormData {
  const form = new FormData()
  form.append(fieldName, new Blob([new Uint8Array(bytes)], { type: mime }), 'pose-image')
  return form
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'motion-pet-routes-'))
  const configStore = new ConfigStore({ configPath: join(dir, 'config.json') })
  const assetStore = new AssetStore({ assetsDir: join(dir, 'assets'), manifestPath: join(dir, 'assets.json') })
  const animationsStore = new AnimationsStore({ animationsDir: join(dir, 'animations') })
  deps = {
    loadConfig: () => configStore.load(),
    updateConfig: (patch) => configStore.update(patch),
    listAssets: () => assetStore.list(),
    saveAsset: (buffer, declaredMime) => assetStore.save(buffer, declaredMime),
    deleteAsset: (id, referencedBy) => assetStore.delete(id, referencedBy),
    resolveAssetPath: (id) => assetStore.resolve(id),
    maxAssetBytes: assetStore.maxFileBytes,
    listAnimations: () => animationsStore.loadAll(),
    saveAnimation: (definition) => animationsStore.save(definition),
    deleteAnimation: (id, referencedBy) => animationsStore.delete(id, referencedBy),
  }
  const routes: WebRoute[] = []
  disposeRoutes = registerRoutes(
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
  // Dispatch exactly like the DSH webServer: exact table first, then the
  // longest matching prefix (M0 §2).
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route =
      routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname) ??
      routes
        .filter((candidate) => candidate.kind === 'prefix' && (pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0]
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  disposeRoutes()
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('GET /api/motion-pet/config (§19.1)', () => {
  it('returns defaults and empty assets without any files on disk', async () => {
    const res = await fetch(`${base}/api/motion-pet/config`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.config).toEqual(createDefaultMotionPetConfig())
    expect(body.assets).toEqual({})
  })

  it('rejects other methods', async () => {
    const res = await fetch(`${base}/api/motion-pet/config`, { method: 'DELETE' })
    expect(res.status).toBe(405)
  })
})

describe('PUT /api/motion-pet/config (§19.2)', () => {
  it('roundtrips a valid config and persists it to disk', async () => {
    const config = createDefaultMotionPetConfig()
    config.enabled = false
    config.global.scale = 1.5
    const res = await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).config).toEqual(config)
    const got = await (await fetch(`${base}/api/motion-pet/config`)).json()
    expect(got.config).toEqual(config)
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual(config)
  })

  it('strips unknown fields', async () => {
    const res = await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...createDefaultMotionPetConfig(), injected: 'x' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).config).not.toHaveProperty('injected')
  })

  it('rejects invalid configs with 400 and field paths', async () => {
    const res = await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...createDefaultMotionPetConfig(), enabled: 'yes' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CONFIG')
    expect(body.error.details).toEqual([{ path: 'enabled', message: 'expected boolean' }])
  })

  it('rejects malformed JSON and oversized bodies', async () => {
    const bad = await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ nope',
    })
    expect(bad.status).toBe(400)
    const huge = await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: `{"pad":"${'x'.repeat(70 * 1024)}"}`,
    })
    expect(huge.status).toBe(413)
  })

  it('serializes concurrent PATCH-style PUTs: no lost update', async () => {
    // Two overlapping partial writes touching DIFFERENT fields: without the
    // serialized read-merge-write the second save would clobber the first.
    const [a, b] = await Promise.all([
      fetch(`${base}/api/motion-pet/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ global: { scale: 1.5 } }),
      }),
      fetch(`${base}/api/motion-pet/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overlay: { x: 12, y: 34 } }),
      }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const got = await (await fetch(`${base}/api/motion-pet/config`)).json()
    expect(got.config.global.scale).toBe(1.5)
    expect(got.config.overlay).toEqual({ x: 12, y: 34 })
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).global.scale).toBe(1.5)
  })

  it('an editor patch (no overlay field) never drops a drag-saved position, in either write order', async () => {
    const put = async (body: unknown): Promise<MotionPetConfig> => {
      const res = await fetch(`${base}/api/motion-pet/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { config: MotionPetConfig }).config
    }
    // The editor save shape (P1): full owned sections, no overlay, no version.
    const editorPatch = (scale: number): Record<string, unknown> => {
      const config = createDefaultMotionPetConfig()
      return {
        enabled: config.enabled,
        global: { ...config.global, scale },
        poses: config.poses,
        states: config.states,
      }
    }

    // overlay → editor: the editor save must not roll the position back
    await put({ overlay: { x: 12, y: 34 } })
    const afterEditor = await put(editorPatch(1.5))
    expect(afterEditor.overlay).toEqual({ x: 12, y: 34 })
    expect(afterEditor.global.scale).toBe(1.5)

    // editor → overlay: the drag save must not roll the editor fields back
    await put(editorPatch(1.8))
    const afterDrag = await put({ overlay: { x: 56, y: 78 } })
    expect(afterDrag.overlay).toEqual({ x: 56, y: 78 })
    expect(afterDrag.global.scale).toBe(1.8)
  })
})

describe('POST /api/motion-pet/assets (§19.3)', () => {
  it('accepts PNG, WebP and JPEG uploads', async () => {
    for (const [bytes, mime] of [
      [makePng(2, 3), 'image/png'],
      [makeWebp(4, 5), 'image/webp'],
      [makeJpeg(10, 11), 'image/jpeg'],
    ] as const) {
      const res = await fetch(`${base}/api/motion-pet/assets`, { method: 'POST', body: uploadBody(bytes, mime) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.asset.id).toMatch(/^[0-9a-f]{16}$/)
      expect(body.asset.url).toBe(`/motion-pet-assets/${body.asset.id}`)
      expect(body.asset.width).toBeGreaterThan(0)
    }
  })

  it('rejects SVG with 415', async () => {
    const res = await fetch(`${base}/api/motion-pet/assets`, {
      method: 'POST',
      body: uploadBody(makeSvg(), 'image/svg+xml'),
    })
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('UNSUPPORTED_TYPE')
  })

  it('rejects forged magic bytes with 415', async () => {
    const res = await fetch(`${base}/api/motion-pet/assets`, {
      method: 'POST',
      body: uploadBody(makePng(2, 3), 'image/webp'),
    })
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('MIME_MISMATCH')
  })

  it('rejects files over 10MB with 413', async () => {
    const res = await fetch(`${base}/api/motion-pet/assets`, {
      method: 'POST',
      body: uploadBody(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png'),
    })
    expect(res.status).toBe(413)
  })

  it('rejects over-dimension images with 413 and missing file fields with 400', async () => {
    const big = await fetch(`${base}/api/motion-pet/assets`, {
      method: 'POST',
      body: uploadBody(makePng(5000, 10), 'image/png'),
    })
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe('DIMENSIONS_TOO_LARGE')
    const empty = new FormData()
    empty.append('note', new Blob(['hello'], { type: 'text/plain' }))
    const missing = await fetch(`${base}/api/motion-pet/assets`, { method: 'POST', body: empty })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error.code).toBe('FILE_FIELD_MISSING')
  })
})

describe('GET /motion-pet-assets/<id> (§19.5)', () => {
  it('serves a registered asset with the right Content-Type and bytes', async () => {
    const png = makePng(2, 3)
    const upload = await fetch(`${base}/api/motion-pet/assets`, { method: 'POST', body: uploadBody(png, 'image/png') })
    const { asset } = await upload.json()
    const res = await fetch(`${base}${asset.url}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Number(res.headers.get('content-length'))).toBe(png.length)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
  })

  it('supports HEAD', async () => {
    const upload = await fetch(`${base}/api/motion-pet/assets`, { method: 'POST', body: uploadBody(makePng(), 'image/png') })
    const { asset } = await upload.json()
    const res = await fetch(`${base}${asset.url}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('')
  })

  it('404s unknown ids, traversal attempts and odd shapes', async () => {
    for (const path of [
      '/motion-pet-assets/0123456789abcdef',
      '/motion-pet-assets/..%2F..%2Fconfig.json',
      '/motion-pet-assets/%2e%2e',
      '/motion-pet-assets/0123456789abcdef/extra',
      '/motion-pet-assets/..',
    ]) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
    }
  })

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${base}/motion-pet-assets/0123456789abcdef`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})

describe('DELETE /api/motion-pet/assets/<id> (§19.4)', () => {
  async function uploadPng(): Promise<string> {
    const res = await fetch(`${base}/api/motion-pet/assets`, { method: 'POST', body: uploadBody(makePng(2, 3), 'image/png') })
    return (await res.json()).asset.id as string
  }

  it('deletes an unreferenced asset; the static route 404s afterwards', async () => {
    const id = await uploadPng()
    const res = await fetch(`${base}/api/motion-pet/assets/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await fetch(`${base}/motion-pet-assets/${id}`)).status).toBe(404)
  })

  it('refuses to delete a referenced asset with 409 ASSET_IN_USE', async () => {
    const id = await uploadPng()
    const config = createDefaultMotionPetConfig()
    config.poses.idle.assetId = id
    await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    const res = await fetch(`${base}/api/motion-pet/assets/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ASSET_IN_USE' })
    // Still served.
    expect((await fetch(`${base}/motion-pet-assets/${id}`)).status).toBe(200)
    // Unreference, then delete succeeds.
    await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createDefaultMotionPetConfig()),
    })
    expect((await fetch(`${base}/api/motion-pet/assets/${id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('404s unknown and malformed ids', async () => {
    expect((await fetch(`${base}/api/motion-pet/assets/0123456789abcdef`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/motion-pet/assets/..%2Fconfig`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('/api/motion-pet/animations (V1.1 plan §3)', () => {
  function makeTransition(id: string): AnimationDefinition {
    return {
      version: 1,
      id,
      name: 'Custom Pop',
      kind: 'transition',
      durationMs: 240,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.scaleX',
          keyframes: [
            { at: 0, value: 1 },
            { at: 1, value: 1 },
          ],
        },
      ],
      events: [{ at: 0.5, type: 'pose-swap' }],
    }
  }

  const putAnimation = (id: string, body: unknown): Promise<Response> =>
    fetch(`${base}/api/motion-pet/animations/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const putConfig = (config: MotionPetConfig): Promise<Response> =>
    fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })

  it('GET lists nothing before any save, then the stored custom animation', async () => {
    const empty = await fetch(`${base}/api/motion-pet/animations`)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ customs: [], warnings: [] })

    const definition = makeTransition('user:pop')
    expect((await putAnimation('user:pop', definition)).status).toBe(200)
    const listed = await (await fetch(`${base}/api/motion-pet/animations`)).json()
    expect(listed.customs).toEqual([definition])
    expect(listed.warnings).toEqual([])
  })

  it('PUT writes the file and DELETE removes it; GET reflects both', async () => {
    const definition = makeTransition('user:pop')
    const put = await putAnimation('user:pop', definition)
    expect(put.status).toBe(200)
    expect((await put.json()).animation).toEqual(definition)
    expect(JSON.parse(await readFile(join(dir, 'animations', 'user_pop.json'), 'utf8'))).toEqual(definition)

    const del = await fetch(`${base}/api/motion-pet/animations/user:pop`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ deleted: 'user:pop' })
    const listed = await (await fetch(`${base}/api/motion-pet/animations`)).json()
    expect(listed.customs).toEqual([])
  })

  it('PUT rejects schema violations with 400 and field details', async () => {
    const invalid = { ...makeTransition('user:pop'), events: [] } // a transition needs its pose-swap
    const res = await putAnimation('user:pop', invalid)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_ANIMATION')
    expect(body.error.details.join(' ')).toContain('pose-swap')
    const listed = await (await fetch(`${base}/api/motion-pet/animations`)).json()
    expect(listed.customs).toEqual([])
  })

  it('PUT rejects a body id that does not match the path id', async () => {
    const res = await putAnimation('user:pop', makeTransition('user:other'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ID_MISMATCH')
  })

  it('PUT rejects builtin-namespace ids with 400', async () => {
    const res = await putAnimation('builtin:soft', makeTransition('builtin:soft'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_ANIMATION')
  })

  it('PUT/DELETE 404 on malformed path ids; unsupported methods 405', async () => {
    expect((await putAnimation('..%2Fescape', makeTransition('user:pop'))).status).toBe(404)
    expect((await fetch(`${base}/api/motion-pet/animations/user%3A..%2Fx`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/motion-pet/animations`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/motion-pet/animations/user:pop`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`${base}/api/motion-pet/animations`, { method: 'PUT' })).status).toBe(405)
  })

  it('DELETE refuses 409 ANIMATION_IN_USE while a state enter references the id', async () => {
    await putAnimation('user:pop', makeTransition('user:pop'))
    const config = createDefaultMotionPetConfig()
    config.states.idle.enter.animationId = 'user:pop'
    expect((await putConfig(config)).status).toBe(200)

    const res = await fetch(`${base}/api/motion-pet/animations/user:pop`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })

    // Unreference (explicit null clears the field), then the delete succeeds.
    const clear = await fetch(`${base}/api/motion-pet/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ states: { idle: { enter: { animationId: null } } } }),
    })
    expect(clear.status).toBe(200)
    expect((await fetch(`${base}/api/motion-pet/animations/user:pop`, { method: 'DELETE' })).status).toBe(200)
  })

  it('DELETE refuses 409 while interactions.click.animation references the id', async () => {
    await putAnimation('user:pop', makeTransition('user:pop'))
    const config = createDefaultMotionPetConfig()
    config.interactions.click.animation = 'user:pop'
    expect((await putConfig(config)).status).toBe(200)

    const res = await fetch(`${base}/api/motion-pet/animations/user:pop`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })
  })

  it('DELETE 404s an unregistered id', async () => {
    expect((await fetch(`${base}/api/motion-pet/animations/user:missing`, { method: 'DELETE' })).status).toBe(404)
  })
})
