/**
 * Host route tests (spec §19, §29.2): the registered handlers are wired into
 * a real `node:http` server (exact-then-longest-prefix dispatch, mirroring
 * the DSH webServer) and exercised with real fetch calls — config roundtrip,
 * multipart uploads, static serving, traversal guards, delete semantics.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { PetweenConfig } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { AnimationsStore } from '../../src/host/animations'
import { AssetStore } from '../../src/host/assets'
import { ConfigStore } from '../../src/host/config'
import { PetsStore, petSliceFromConfig, type PetPreset } from '../../src/host/pets'
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
  dir = await mkdtemp(join(tmpdir(), 'petween-routes-'))
  const petsStore = new PetsStore({ petsDir: join(dir, 'pets') })
  const configStore = new ConfigStore({
    configPath: join(dir, 'config.json'),
    // The pet-preset mirror, wired exactly as in src/index.ts.
    onSaved: async (config) => {
      if (config.activePetId !== null) await petsStore.saveSlice(config.activePetId, petSliceFromConfig(config))
    },
  })
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
    listPets: () => petsStore.list(),
    createPet: (name, slice) => petsStore.create(name, slice),
    readPet: (id) => petsStore.read(id),
    renamePet: (id, name) => petsStore.rename(id, name),
    deletePet: (id) => petsStore.delete(id),
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

describe('GET /api/petween/config (§19.1)', () => {
  it('returns defaults and empty assets without any files on disk', async () => {
    const res = await fetch(`${base}/api/petween/config`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.config).toEqual(createDefaultPetweenConfig())
    expect(body.assets).toEqual({})
  })

  it('rejects other methods', async () => {
    const res = await fetch(`${base}/api/petween/config`, { method: 'DELETE' })
    expect(res.status).toBe(405)
  })
})

describe('PUT /api/petween/config (§19.2)', () => {
  it('roundtrips a valid config and persists it to disk', async () => {
    const config = createDefaultPetweenConfig()
    config.enabled = false
    config.global.scale = 1.5
    const res = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).config).toEqual(config)
    const got = await (await fetch(`${base}/api/petween/config`)).json()
    expect(got.config).toEqual(config)
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual(config)
  })

  it('strips unknown fields', async () => {
    const res = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...createDefaultPetweenConfig(), injected: 'x' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).config).not.toHaveProperty('injected')
  })

  it('rejects invalid configs with 400 and field paths', async () => {
    const res = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...createDefaultPetweenConfig(), enabled: 'yes' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CONFIG')
    expect(body.error.details).toEqual([{ path: 'enabled', message: 'expected boolean' }])
  })

  it('rejects malformed JSON and oversized bodies', async () => {
    const bad = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ nope',
    })
    expect(bad.status).toBe(400)
    const huge = await fetch(`${base}/api/petween/config`, {
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
      fetch(`${base}/api/petween/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ global: { scale: 1.5 } }),
      }),
      fetch(`${base}/api/petween/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overlay: { x: 12, y: 34 } }),
      }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const got = await (await fetch(`${base}/api/petween/config`)).json()
    expect(got.config.global.scale).toBe(1.5)
    expect(got.config.overlay).toEqual({ x: 12, y: 34 })
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).global.scale).toBe(1.5)
  })

  it('an editor patch (no overlay field) never drops a drag-saved position, in either write order', async () => {
    const put = async (body: unknown): Promise<PetweenConfig> => {
      const res = await fetch(`${base}/api/petween/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { config: PetweenConfig }).config
    }
    // The editor save shape (P1): full owned sections, no overlay, no version.
    const editorPatch = (scale: number): Record<string, unknown> => {
      const config = createDefaultPetweenConfig()
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

describe('POST /api/petween/assets (§19.3)', () => {
  it('accepts PNG, WebP and JPEG uploads', async () => {
    for (const [bytes, mime] of [
      [makePng(2, 3), 'image/png'],
      [makeWebp(4, 5), 'image/webp'],
      [makeJpeg(10, 11), 'image/jpeg'],
    ] as const) {
      const res = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: uploadBody(bytes, mime) })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.asset.id).toMatch(/^[0-9a-f]{16}$/)
      expect(body.asset.url).toBe(`/petween-assets/${body.asset.id}`)
      expect(body.asset.width).toBeGreaterThan(0)
    }
  })

  it('rejects SVG with 415', async () => {
    const res = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      body: uploadBody(makeSvg(), 'image/svg+xml'),
    })
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('UNSUPPORTED_TYPE')
  })

  it('rejects forged magic bytes with 415', async () => {
    const res = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      body: uploadBody(makePng(2, 3), 'image/webp'),
    })
    expect(res.status).toBe(415)
    expect((await res.json()).error.code).toBe('MIME_MISMATCH')
  })

  it('rejects files over 10MB with 413', async () => {
    const res = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      body: uploadBody(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png'),
    })
    expect(res.status).toBe(413)
  })

  it('rejects over-dimension images with 413 and missing file fields with 400', async () => {
    const big = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      body: uploadBody(makePng(5000, 10), 'image/png'),
    })
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe('DIMENSIONS_TOO_LARGE')
    const empty = new FormData()
    empty.append('note', new Blob(['hello'], { type: 'text/plain' }))
    const missing = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: empty })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error.code).toBe('FILE_FIELD_MISSING')
  })
})

describe('GET /petween-assets/<id> (§19.5)', () => {
  it('serves a registered asset with the right Content-Type and bytes', async () => {
    const png = makePng(2, 3)
    const upload = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: uploadBody(png, 'image/png') })
    const { asset } = await upload.json()
    const res = await fetch(`${base}${asset.url}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Number(res.headers.get('content-length'))).toBe(png.length)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
  })

  it('supports HEAD', async () => {
    const upload = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: uploadBody(makePng(), 'image/png') })
    const { asset } = await upload.json()
    const res = await fetch(`${base}${asset.url}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('')
  })

  it('404s unknown ids, traversal attempts and odd shapes', async () => {
    for (const path of [
      '/petween-assets/0123456789abcdef',
      '/petween-assets/..%2F..%2Fconfig.json',
      '/petween-assets/%2e%2e',
      '/petween-assets/0123456789abcdef/extra',
      '/petween-assets/..',
    ]) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
    }
  })

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${base}/petween-assets/0123456789abcdef`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})

describe('DELETE /api/petween/assets/<id> (§19.4)', () => {
  async function uploadPng(): Promise<string> {
    const res = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: uploadBody(makePng(2, 3), 'image/png') })
    return (await res.json()).asset.id as string
  }

  it('deletes an unreferenced asset; the static route 404s afterwards', async () => {
    const id = await uploadPng()
    const res = await fetch(`${base}/api/petween/assets/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await fetch(`${base}/petween-assets/${id}`)).status).toBe(404)
  })

  it('refuses to delete a referenced asset with 409 ASSET_IN_USE', async () => {
    const id = await uploadPng()
    const config = createDefaultPetweenConfig()
    config.poses.idle.assetId = id
    await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    const res = await fetch(`${base}/api/petween/assets/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ASSET_IN_USE' })
    // Still served.
    expect((await fetch(`${base}/petween-assets/${id}`)).status).toBe(200)
    // Unreference, then delete succeeds.
    await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createDefaultPetweenConfig()),
    })
    expect((await fetch(`${base}/api/petween/assets/${id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('404s unknown and malformed ids', async () => {
    expect((await fetch(`${base}/api/petween/assets/0123456789abcdef`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/assets/..%2Fconfig`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('/api/petween/animations (V1.1 plan §3)', () => {
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

  function makeAmbient(id: string): AnimationDefinition {
    return {
      version: 1,
      id,
      name: 'Custom Float',
      kind: 'ambient',
      durationMs: 900,
      repeat: { mode: 'loop' },
      tracks: [
        {
          property: 'sway.rotation',
          keyframes: [
            { at: 0, value: -2 },
            { at: 1, value: 2 },
          ],
        },
      ],
    }
  }

  const putAnimation = (id: string, body: unknown): Promise<Response> =>
    fetch(`${base}/api/petween/animations/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const putConfig = (config: PetweenConfig): Promise<Response> =>
    fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })

  it('GET lists nothing before any save, then the stored custom animation', async () => {
    const empty = await fetch(`${base}/api/petween/animations`)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ customs: [], warnings: [] })

    const definition = makeTransition('user:pop')
    expect((await putAnimation('user:pop', definition)).status).toBe(200)
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    expect(listed.customs).toEqual([definition])
    expect(listed.warnings).toEqual([])
  })

  it('PUT writes the file and DELETE removes it; GET reflects both', async () => {
    const definition = makeTransition('user:pop')
    const put = await putAnimation('user:pop', definition)
    expect(put.status).toBe(200)
    expect((await put.json()).animation).toEqual(definition)
    expect(JSON.parse(await readFile(join(dir, 'animations', 'user_pop.json'), 'utf8'))).toEqual(definition)

    const del = await fetch(`${base}/api/petween/animations/user:pop`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ deleted: 'user:pop' })
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    expect(listed.customs).toEqual([])
  })

  it('PUT rejects schema violations with 400 and field details', async () => {
    const invalid = { ...makeTransition('user:pop'), events: [] } // a transition needs its pose-swap
    const res = await putAnimation('user:pop', invalid)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_ANIMATION')
    expect(body.error.details.join(' ')).toContain('pose-swap')
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
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
    expect((await fetch(`${base}/api/petween/animations/user%3A..%2Fx`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/animations`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/animations/user:pop`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/animations`, { method: 'PUT' })).status).toBe(405)
  })

  it('DELETE refuses 409 ANIMATION_IN_USE while a state enter references the id', async () => {
    await putAnimation('user:pop', makeTransition('user:pop'))
    const config = createDefaultPetweenConfig()
    config.states.idle.enter.animationId = 'user:pop'
    expect((await putConfig(config)).status).toBe(200)

    const res = await fetch(`${base}/api/petween/animations/user:pop`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })

    // Unreference (explicit null clears the field), then the delete succeeds.
    const clear = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ states: { idle: { enter: { animationId: null } } } }),
    })
    expect(clear.status).toBe(200)
    expect((await fetch(`${base}/api/petween/animations/user:pop`, { method: 'DELETE' })).status).toBe(200)
  })

  it('DELETE refuses 409 while interactions.click.animation references the id', async () => {
    await putAnimation('user:pop', makeTransition('user:pop'))
    const config = createDefaultPetweenConfig()
    config.interactions.click.animation = 'user:pop'
    expect((await putConfig(config)).status).toBe(200)

    const res = await fetch(`${base}/api/petween/animations/user:pop`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })
  })

  it('DELETE refuses 409 for a custom ambient referenced only by a non-active pet preset', async () => {
    await putAnimation('user:float', makeAmbient('user:float'))
    const config = createDefaultPetweenConfig()
    config.states.idle.ambient.customAnimationId = 'user:float'
    expect((await putConfig(config)).status).toBe(200)

    const saved = await fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'With Float', from: 'current' }),
    })
    expect(saved.status).toBe(200)
    const blank = await fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Blank', from: 'blank' }),
    })
    expect(blank.status).toBe(200)
    expect((await blank.json()).config.states.idle.ambient.customAnimationId).toBeUndefined()

    const res = await fetch(`${base}/api/petween/animations/user:float`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })
  })

  it('DELETE 404s an unregistered id', async () => {
    expect((await fetch(`${base}/api/petween/animations/user:missing`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('/api/petween/pets (V1.1 pet presets)', () => {
  const postPets = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const putConfig = (patch: unknown): Promise<Response> =>
    fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })

  /** PUT a config whose character slice is recognizably non-default. */
  async function seedConfig(scale = 1.5, assetId = '0123456789abcdef'): Promise<void> {
    const config = createDefaultPetweenConfig()
    config.global.scale = scale
    config.poses.idle.assetId = assetId
    const res = await putConfig(config)
    expect(res.status).toBe(200)
  }

  it('GET returns an empty list and a null activePetId on a fresh install', async () => {
    const res = await fetch(`${base}/api/petween/pets`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pets: [], activePetId: null, warnings: [] })
  })

  it('POST from=current saves the current slice as a preset and makes it active', async () => {
    await seedConfig()
    const res = await postPets({ name: 'Kitty', from: 'current' })
    expect(res.status).toBe(200)
    const { pet, config } = (await res.json()) as { pet: PetPreset; config: PetweenConfig }
    expect(pet.id).toMatch(/^pet_[a-z0-9]+$/)
    expect(pet.name).toBe('Kitty')
    expect(pet.scale).toBe(1.5)
    expect(pet.poses.idle.assetId).toBe('0123456789abcdef')
    expect(config.activePetId).toBe(pet.id)
    // persisted: the file is on disk and GET reflects the new active pointer.
    // (The adopt-update mirrors the slice back, so the on-disk updatedAt may
    // tick past the created one — everything else must match verbatim.)
    const onDisk = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(onDisk).toEqual({ ...pet, updatedAt: expect.any(String) })
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    expect(listed.pets).toEqual([onDisk])
    expect(listed.activePetId).toBe(pet.id)
  })

  it('POST from=current rejects a missing name with 400 INVALID_PRESET', async () => {
    const res = await postPets({ from: 'current' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_PRESET')
    expect(await (await fetch(`${base}/api/petween/pets`)).json()).toMatchObject({ pets: [] })
  })

  it('POST rejects an unknown "from" with 400', async () => {
    const res = await postPets({ name: 'X', from: 'somewhere' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_REQUEST')
  })

  it('POST from=blank applies an empty pet without creating an unnamed preset', async () => {
    await seedConfig()
    const res = await postPets({ name: 'Blank', from: 'blank' })
    expect(res.status).toBe(200)
    const { pet, config } = (await res.json()) as { pet: PetPreset; config: PetweenConfig }
    expect(config.activePetId).toBe(pet.id)
    expect(config.global.scale).toBe(1)
    expect(config.poses.idle.assetId).toBeUndefined()
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    expect(listed.pets.map((candidate: PetPreset) => candidate.name)).toEqual(['Blank'])
  })

  it('POST from=blank keeps existing named presets', async () => {
    await postPets({ name: 'First', from: 'current' })
    const res = await postPets({ name: 'Blank', from: 'blank' })
    expect(res.status).toBe(200)
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    expect(listed.pets.map((preset: PetPreset) => preset.name).sort()).toEqual(['Blank', 'First'])
  })

  it('PUT renames a preset; 404 unknown ids, 400 empty names', async () => {
    const { pet } = (await (await postPets({ name: 'Old', from: 'current' })).json()) as { pet: PetPreset }
    const res = await fetch(`${base}/api/petween/pets/${pet.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).pet.name).toBe('New')
    expect((await (await fetch(`${base}/api/petween/pets`)).json()).pets[0].name).toBe('New')

    const unknown = await fetch(`${base}/api/petween/pets/pet_missing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(unknown.status).toBe(404)
    const empty = await fetch(`${base}/api/petween/pets/${pet.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ' ' }),
    })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error.code).toBe('INVALID_PRESET')
  })

  it('DELETE removes the preset; deleting the active one clears only activePetId', async () => {
    await seedConfig()
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    const res = await fetch(`${base}/api/petween/pets/${pet.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: pet.id })
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    expect(listed.pets).toEqual([])
    expect(listed.activePetId).toBeNull()
    // the config content stays: the pet keeps showing as unsaved edits
    const got = await (await fetch(`${base}/api/petween/config`)).json()
    expect(got.config.global.scale).toBe(1.5)
    expect(got.config.poses.idle.assetId).toBe('0123456789abcdef')
    expect(got.config.activePetId).toBeNull()
    expect((await fetch(`${base}/api/petween/pets/${pet.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('POST <id>/apply writes the preset slice into the config and sets it active', async () => {
    await seedConfig()
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    // Change the live config, then apply the preset to bring the slice back.
    await putConfig({ activePetId: null, global: { scale: 3 }, poses: { idle: { assetId: null } } })
    const res = await fetch(`${base}/api/petween/pets/${pet.id}/apply`, { method: 'POST' })
    expect(res.status).toBe(200)
    const { config } = (await res.json()) as { config: PetweenConfig }
    expect(config.activePetId).toBe(pet.id)
    expect(config.global.scale).toBe(1.5)
    expect(config.poses.idle.assetId).toBe('0123456789abcdef')
  })

  it('POST <id>/apply does not create an implicit unnamed preset', async () => {
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    // Detach and edit: the current slice is now unsaved work.
    await putConfig({ activePetId: null, global: { scale: 2.2 } })
    const res = await fetch(`${base}/api/petween/pets/${pet.id}/apply`, { method: 'POST' })
    expect(res.status).toBe(200)
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    expect(listed.pets.map((candidate: PetPreset) => candidate.name)).toEqual(['Kitty'])
    expect(listed.activePetId).toBe(pet.id)
  })

  it('POST <id>/apply 404s unknown ids; method and path guards hold', async () => {
    expect((await fetch(`${base}/api/petween/pets/pet_missing/apply`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/pet_missing`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/..%2Fescape`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/pet_x`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/pets/pet_x/apply`, { method: 'PUT' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/pets`, { method: 'PUT' })).status).toBe(405)
  })

  it('config updates mirror into the active preset file; a null activePetId mirrors nothing', async () => {
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    await putConfig({ global: { scale: 2.4 } })
    const mirrored = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(mirrored.scale).toBe(2.4)
    // detach, then edit again: no preset is touched
    await putConfig({ activePetId: null })
    await putConfig({ global: { scale: 3 } })
    expect(JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8')).scale).toBe(2.4)
  })

  it('DELETE /assets refuses 409 when only a non-active preset references the asset', async () => {
    const upload = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: uploadBody(makePng(2, 3), 'image/png') })
    const assetId = ((await upload.json()) as { asset: { id: string } }).asset.id
    await seedConfig(1.5, assetId)
    await postPets({ name: 'Kitty', from: 'current' }) // Kitty references the asset
    await postPets({ name: 'Blank', from: 'blank' }) // switch away: the config no longer references it
    const res = await fetch(`${base}/api/petween/assets/${assetId}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ASSET_IN_USE' })
    // Deleting the referencing preset frees the asset.
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    const kitty = listed.pets.find((candidate: PetPreset) => candidate.name === 'Kitty')
    await fetch(`${base}/api/petween/pets/${kitty.id}`, { method: 'DELETE' })
    expect((await fetch(`${base}/api/petween/assets/${assetId}`, { method: 'DELETE' })).status).toBe(200)
  })
})

describe('cross-origin write guard (§20 defense-in-depth)', () => {
  it('rejects a Sec-Fetch-Site: cross-site upload with 403 and no side effect', async () => {
    const res = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: uploadBody(makePng(2, 3), 'image/png'),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('CROSS_ORIGIN')
    expect(await readdir(join(dir, 'assets')).catch(() => [])).toEqual([])
  })

  it('rejects a foreign Origin on POST /pets (simple text/plain writes never preflight)', async () => {
    const res = await fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'Evil', from: 'blank' }),
    })
    expect(res.status).toBe(403)
    const listed = await (await fetch(`${base}/api/petween/pets`)).json()
    expect(listed.pets).toEqual([])
  })

  it('same-origin Origin headers pass and non-browser clients (no metadata) stay allowed', async () => {
    const sameOrigin = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, enabled: false }),
    })
    expect(sameOrigin.status).toBe(200)
    const cliStyle = await fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Cli', from: 'blank' }),
    })
    expect(cliStyle.status).toBe(200)
  })

  it('GETs are never guarded', async () => {
    const res = await fetch(`${base}/api/petween/config`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(200)
  })
})
