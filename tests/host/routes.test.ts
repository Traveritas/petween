/**
 * Host route tests (spec §19, §29.2): the registered handlers are wired into
 * a real `node:http` server (exact-then-longest-prefix dispatch, mirroring
 * the DSH webServer) and exercised with real fetch calls — config roundtrip,
 * multipart uploads, static serving, traversal guards, delete semantics.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { PetweenConfig } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { AnimationsStore } from '../../src/host/animations'
import { AssetStore } from '../../src/host/assets'
import { ConfigStore } from '../../src/host/config'
import { ConfigViewStore } from '../../src/host/view-store'
import { DEFAULT_PET_NAME, PetsStore, type PetPreset } from '../../src/host/pets'
import { planMotionPackImport } from '../../src/host/packs'
import { createWriteLock } from '../../src/host/storage'
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
  const sharedWriteLock = createWriteLock()
  const petsStore = new PetsStore({ petsDir: join(dir, 'pets'), lock: sharedWriteLock })
  const configStore = new ConfigStore({
    configPath: join(dir, 'config.json'),
    lock: sharedWriteLock,
  })
  // The phase-2 view funnel, wired exactly as in src/index.ts (the onSaved
  // mirror is gone: slice writes land in the active preset through the
  // funnel, and the view resolves from the v2 document + that preset).
  const viewStore = new ConfigViewStore({ configStore, petsStore })
  const assetStore = new AssetStore({
    assetsDir: join(dir, 'assets'),
    manifestPath: join(dir, 'assets.json'),
    lock: sharedWriteLock,
  })
  const animationsStore = new AnimationsStore({ animationsDir: join(dir, 'animations'), lock: sharedWriteLock })
  deps = {
    loadConfig: () => viewStore.loadView(),
    updateConfig: (patch, options) => viewStore.update(patch, options),
    configRevision: () => viewStore.revision(),
    listAssets: () => assetStore.list(),
    saveAsset: (buffer, declaredMime) => assetStore.save(buffer, declaredMime),
    deleteAsset: (id, referencedBy) => assetStore.delete(id, referencedBy),
    resolveAssetPath: (id) => assetStore.resolve(id),
    maxAssetBytes: assetStore.maxFileBytes,
    listAnimations: () => animationsStore.loadAll(),
    saveAnimation: (definition, guard) => animationsStore.save(definition, guard),
    deleteAnimation: (id, referencedBy) => animationsStore.delete(id, referencedBy),
    importPack: (pack) => animationsStore.importAnimations((existing) => planMotionPackImport(pack, existing)),
    listPets: () => petsStore.list(),
    createPet: (name, slice, attribution, pluginConfigs) => petsStore.create(name, slice, attribution, pluginConfigs),
    readPet: (id) => petsStore.read(id),
    updatePetMeta: (id, changes) => petsStore.updateMeta(id, changes),
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

/**
 * Preset-authority phase 2 (host/view-store.ts): GET /config resolves the
 * materialized view — the v2 global document plus the ACTIVE preset's slice.
 * The matrix below locks the phase-2 contract: a present preset slice is
 * always adopted (divergence resolves in the preset's favor), and only the
 * no-usable-preset cases fall back to the document's own slice.
 */
describe('GET /api/petween/config — phase 2 materialized view', () => {
  const putConfig = (patch: unknown): Promise<Response> =>
    fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })

  const getConfig = async (): Promise<{ config: PetweenConfig; assets: unknown; revision: number }> => {
    const res = await fetch(`${base}/api/petween/config`)
    expect(res.status).toBe(200)
    return (await res.json()) as { config: PetweenConfig; assets: unknown; revision: number }
  }

  it('a null pointer (never-migrated store state) falls back to the document slice', async () => {
    // Without a slice write there is no pet yet: the view is the document.
    const body = await getConfig()
    expect(body.config).toEqual(createDefaultPetweenConfig())
    expect(body.config.activePetId).toBeNull()
  })

  it('the active preset\'s slice is adopted verbatim — the document\'s own slice never leaks', async () => {
    const seeded = await putConfig({ global: { scale: 1.5 }, poses: { idle: { assetId: '0123456789abcdef' } } })
    expect(seeded.status).toBe(200)
    const { config } = (await seeded.json()) as { config: PetweenConfig }
    // The slice write auto-provisioned the default pet (null pointer repair);
    // the view presents that pet and the v2 document's pointer at it.
    expect(config.global.scale).toBe(1.5)
    expect(config.poses.idle.assetId).toBe('0123456789abcdef')
    expect(config.activePetId).toMatch(/^pet_[a-z0-9]+$/)
    const { pets, activePetId } = (await (await fetch(`${base}/api/petween/pets`)).json()) as {
      pets: PetPreset[]
      activePetId: string
    }
    expect(activePetId).toBe(config.activePetId)
    expect(pets).toHaveLength(1)
    expect(pets[0]!.name).toBe(DEFAULT_PET_NAME)
    expect(pets[0]!.scale).toBe(1.5)
    // The document itself carries NO slice (writer = v2 global projection).
    const document = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(document.version).toBe(2)
    expect(document).not.toHaveProperty('poses')
    expect(document).not.toHaveProperty('states')
    expect(document.global).not.toHaveProperty('scale')
  })

  it('a diverged preset (out-of-band edit) wins over the document', async () => {
    const seeded = await putConfig({ global: { scale: 1.5 }, poses: { idle: { assetId: '0123456789abcdef' } } })
    const { config } = (await seeded.json()) as { config: PetweenConfig }
    // Edit the preset directly on disk: the view must follow the preset.
    const presetPath = join(dir, 'pets', `${config.activePetId}.json`)
    const raw = JSON.parse(await readFile(presetPath, 'utf8')) as Record<string, unknown>
    raw.scale = 2.5
    ;(raw.poses as Record<string, { assetId: string }>).idle.assetId = 'ffffffffffffffff'
    await writeFile(presetPath, JSON.stringify(raw))
    const body = await getConfig()
    expect(body.config.global.scale).toBe(2.5)
    expect(body.config.poses.idle.assetId).toBe('ffffffffffffffff')
  })

  it('a dangling pointer falls back to the document slice until a write heals it', async () => {
    const seeded = await putConfig({ global: { scale: 1.5 } })
    const { config } = (await seeded.json()) as { config: PetweenConfig }
    // Out-of-band deletion of the active preset file: the view degrades to
    // the document's own slice (defaults for a v2 document), tolerated.
    await rm(join(dir, 'pets', `${config.activePetId}.json`))
    const degraded = await getConfig()
    expect(degraded.config.global.scale).toBe(1)
    // The next slice write heals the pointer: a fresh default pet adopts the
    // document's slice and becomes active.
    const healed = await putConfig({ global: { scale: 2.2 } })
    expect(healed.status).toBe(200)
    const healedConfig = ((await healed.json()) as { config: PetweenConfig }).config
    expect(healedConfig.global.scale).toBe(2.2)
    expect(healedConfig.activePetId).toMatch(/^pet_[a-z0-9]+$/)
    expect(healedConfig.activePetId).not.toBe(config.activePetId)
    const { pets, activePetId } = (await (await fetch(`${base}/api/petween/pets`)).json()) as {
      pets: PetPreset[]
      activePetId: string
    }
    expect(pets.map((pet) => pet.id)).toEqual([healedConfig.activePetId])
    expect(activePetId).toBe(healedConfig.activePetId)
  })
})

describe('GET /api/petween/meta (B2 capability discovery)', () => {
  it('reports apiVersion/configVersion/revision and an additive feature list', async () => {
    const res = await fetch(`${base}/api/petween/meta`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiVersion).toBe(1)
    expect(body.configVersion).toBe(1)
    expect(body.revision).toBe(0) // fresh install
    for (const feature of ['config', 'config.revision', 'assets', 'animations', 'pets', 'pets.draft', 'pets.packages', 'meta']) {
      expect(body.features).toContain(feature)
    }
    expect((await fetch(`${base}/api/petween/meta`, { method: 'POST' })).status).toBe(405)
  })
})

describe('PUT /api/petween/config (§19.2)', () => {
  it('roundtrips a valid config; the slice lands in the auto-provisioned pet, the document stays v2-global', async () => {
    const config = createDefaultPetweenConfig()
    config.enabled = false
    config.global.scale = 1.5
    const res = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    expect(res.status).toBe(200)
    const saved = (await res.json()).config as PetweenConfig
    // The response is the materialized view: the PUT slice plus the pointer
    // of the default pet the null-pointer repair provisioned around it.
    expect({ ...saved, activePetId: null }).toEqual(config)
    expect(saved.activePetId).toMatch(/^pet_[a-z0-9]+$/)
    const got = await (await fetch(`${base}/api/petween/config`)).json()
    expect(got.config).toEqual(saved)
    // The document on disk is the v2 global projection (no slice fields).
    const document = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    expect(document).toEqual({
      version: 2,
      enabled: false,
      global: {
        transition: config.global.transition,
        reducedMotion: config.global.reducedMotion,
        successHoldMs: config.global.successHoldMs,
        errorHoldMs: config.global.errorHoldMs,
      },
      overlay: config.overlay,
      advanced: config.advanced,
      interactions: config.interactions,
      activePetId: saved.activePetId,
    })
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

  it('B3: GET/PUT carry a monotonic revision; x-petween-expected-revision guards stale writers', async () => {
    const put = (expectedRevision?: number) =>
      fetch(`${base}/api/petween/config`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(expectedRevision === undefined ? {} : { 'x-petween-expected-revision': String(expectedRevision) }),
        },
        body: JSON.stringify({ global: { scale: 1.2 } }),
      })
    const putText = await put()
    expect(putText.status).toBe(200)
    expect((await putText.json()).revision).toBe(1) // first bump
    expect((await (await fetch(`${base}/api/petween/config`)).json()).revision).toBe(1)
    // A writer holding the fresh revision wins…
    const ok = await put(1)
    expect(ok.status).toBe(200)
    expect((await ok.json()).revision).toBe(2)
    // …a writer holding the stale revision 1 is rejected BEFORE any write.
    const stale = await put(1)
    expect(stale.status).toBe(409)
    const staleBody = await stale.json()
    expect(staleBody.error.code).toBe('REVISION_MISMATCH')
    expect(staleBody.error.details).toEqual({ currentRevision: 2 })
    expect((await (await fetch(`${base}/api/petween/config`)).json()).config.global.scale).toBe(1.2) // untouched
    // Malformed header is a client bug, not a conflict — '0x10'/'1e2' shapes
    // included (digits-only parsing, 2026-08-28 review).
    for (const bad of ['soon', '0x10', '1e2', '-1']) {
      expect(
        (
          await fetch(`${base}/api/petween/config`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'x-petween-expected-revision': bad },
            body: JSON.stringify({ global: { scale: 1 } }),
          })
        ).status,
        bad,
      ).toBe(400)
    }
  })

  it('B3: the revision survives a host restart (persisted sidecar)', async () => {
    await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ global: { scale: 1.1 } }),
    })
    const persisted = JSON.parse(await readFile(join(dir, 'config.revision.json'), 'utf8'))
    expect(persisted.revision).toBeGreaterThan(0)
    // A fresh store over the same directory reads the counter back.
    const reborn = new ConfigStore({ configPath: join(dir, 'config.json') })
    expect(await reborn.revision()).toBe(persisted.revision)
  })

  it('B10: pose assetIds must be 16-hex host-generated ids (strict rejects, repair drops)', async () => {
    const config = createDefaultPetweenConfig()
    config.poses.idle.assetId = 'definitely-not-hex'
    const res = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_CONFIG')
    expect(body.error.details).toContainEqual({ path: 'poses.idle.assetId', message: 'expected a 16-hex asset id (host-generated)' })
    // Repair mode (config load) degrades to "no asset" instead of failing.
    await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf8')
    const loaded = await deps.loadConfig()
    expect(loaded.poses.idle.assetId).toBeUndefined()
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
    // Cross-document durability: the scale lives in the (auto-provisioned)
    // preset, the overlay in the v2 global document — neither clobbered.
    const document = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    expect(document.overlay).toEqual({ x: 12, y: 34 })
    const preset = JSON.parse(await readFile(join(dir, 'pets', `${got.config.activePetId}.json`), 'utf8'))
    expect(preset.scale).toBe(1.5)
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

describe('/api/petween/packs (P2 Motion Pack)', () => {
  /** An interaction-kind definition — the simplest schema-valid shape. */
  const packAnimation = (id: string, durationMs = 200) => ({
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'interaction',
    durationMs,
    repeat: { mode: 'once' },
    tracks: [{ property: 'transition.rotation', keyframes: [{ at: 0, value: 0 }, { at: 1, value: 12 }] }],
  })
  const packBody = (overrides: Record<string, unknown> = {}) => ({
    format: 'motion-pack',
    version: 1,
    name: '测试包',
    namespace: 'manga',
    animations: [packAnimation('manga:pop')],
    ...overrides,
  })
  const postImport = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/petween/packs/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const listedIds = async (): Promise<string[]> => {
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    return listed.customs.map((definition: { id: string }) => definition.id)
  }

  it('imports a pack: entries land in the library and GET /animations sees them', async () => {
    const res = await postImport(packBody())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toEqual([{ requestedId: 'manga:pop', finalId: 'manga:pop', status: 'imported' }])
    expect(body.namespace).toBe('manga')
    expect(await listedIds()).toEqual(['manga:pop'])
  })

  it('re-importing identical content is idempotent; changed content remaps to -2 with mounts rewritten', async () => {
    const enter = (durationMs: number) => ({
      ...packAnimation('manga:pop'),
      kind: 'transition',
      durationMs,
      events: [{ at: 0.5, type: 'pose-swap' }],
    })
    const withMounts = (durationMs: number) => packBody({ animations: [enter(durationMs)], mounts: { idle: { enter: 'manga:pop' } } })
    await postImport(withMounts(240))

    const identical = await (await postImport(withMounts(240))).json()
    expect(identical.entries[0].status).toBe('identical')

    const changed = await (await postImport(withMounts(500))).json()
    expect(changed.entries[0]).toEqual({ requestedId: 'manga:pop', finalId: 'manga:pop-2', status: 'remapped' })
    expect(changed.mounts).toEqual({ idle: { enter: 'manga:pop-2' } }) // rewritten to the FINAL id
    expect((await listedIds()).sort()).toEqual(['manga:pop', 'manga:pop-2'])
  })

  it('a pack with mounts also returns an applyPatch with FINAL ids; PUTting it mounts the animations', async () => {
    const enter = { ...packAnimation('manga:pop'), kind: 'transition', events: [{ at: 0.5, type: 'pose-swap' }] }
    const ambient = {
      ...packAnimation('manga:sway'),
      kind: 'ambient',
      repeat: { mode: 'loop' },
      tracks: [{ property: 'sway.rotation', keyframes: [{ at: 0, value: 0 }, { at: 1, value: 3 }] }],
    }
    // Claim manga:pop with different content first, so the mounted enter id remaps.
    await postImport(packBody({ animations: [{ ...enter, durationMs: 240 }] }))
    const body = await (
      await postImport(
        packBody({
          animations: [enter, ambient],
          mounts: { idle: { enter: 'manga:pop' }, thinking: { ambient: 'manga:sway' } },
        }),
      )
    ).json()
    // enter remapped, ambient imported as-is → the patch carries the FINAL ids only.
    expect(body.applyPatch).toEqual({
      states: {
        idle: { enter: { animationId: 'manga:pop-2' } },
        thinking: { ambient: { customAnimationId: 'manga:sway' } },
      },
    })
    // The patch is a plain config states patch: PUT mounts both animations
    // — the funnel routes the slice into the active pet (§11 挂载应用).
    const applied = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.applyPatch),
    })
    expect(applied.status).toBe(200)
    const { config } = (await applied.json()) as { config: PetweenConfig }
    expect(config.states.idle.enter.animationId).toBe('manga:pop-2')
    expect(config.states.thinking.ambient.customAnimationId).toBe('manga:sway')
    // A mounts-free import carries no applyPatch at all.
    const bare = await (await postImport(packBody({ animations: [ambient] }))).json()
    expect(bare.applyPatch).toBeUndefined()
  })

  it('rejects malformed packs with 400 PACK_INVALID and nothing is written', async () => {
    for (const broken of [
      packBody({ format: 'nope' }),
      packBody({ namespace: 'user', animations: [packAnimation('manga:pop')] }), // outside the declared ns
      packBody({ animations: [packAnimation('manga:pop', 0)] }), // schema violation (duration floor)
      packBody({ mounts: { idle: { enter: 'manga:pop' } } }), // interaction kind on an enter mount
    ]) {
      const res = await postImport(broken)
      expect(res.status, JSON.stringify(broken)).toBe(400)
      expect((await res.json()).error.code).toBe('PACK_INVALID')
    }
    expect(await listedIds()).toEqual([])
  })

  it('exports selected ids as a manifest; unknown or empty selections are 400s', async () => {
    await postImport(packBody())
    const res = await fetch(`${base}/api/petween/packs/export?ids=${encodeURIComponent('manga:pop')}`)
    expect(res.status).toBe(200)
    const pack = await res.json()
    expect(pack).toMatchObject({ format: 'motion-pack', version: 1, namespace: 'manga' })
    expect(pack.animations).toHaveLength(1)
    expect(pack.mounts).toBeUndefined()

    expect((await fetch(`${base}/api/petween/packs/export?ids=user:missing`)).status).toBe(400)
    expect((await fetch(`${base}/api/petween/packs/export`)).status).toBe(400)
    expect((await fetch(`${base}/api/petween/packs/import`, { method: 'GET' })).status).toBe(405)
  })

  it('export dedupes repeated ids (?ids=a,a yields ONE definition)', async () => {
    await postImport(packBody())
    const res = await fetch(
      `${base}/api/petween/packs/export?ids=${encodeURIComponent('manga:pop')},${encodeURIComponent('manga:pop')}`,
    )
    expect(res.status).toBe(200)
    const pack = await res.json()
    expect(pack.animations).toHaveLength(1)
    expect(pack.animations[0].id).toBe('manga:pop')
    // The deduped export re-imports cleanly (a duplicated one would 400 on
    // the pack's internal duplicate-id check).
    expect((await postImport(pack)).status).toBe(200)
  })

  it('an exported pack re-imports identically (round trip)', async () => {
    await postImport(packBody())
    const pack = await (await fetch(`${base}/api/petween/packs/export?ids=${encodeURIComponent('manga:pop')}`)).json()
    const round = await postImport(pack)
    expect(round.status).toBe(200)
    expect((await round.json()).entries[0].status).toBe('identical')
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
    expect(await empty.json()).toEqual({ customs: [], warnings: [], normalized: [] })

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

  it('B1: a NEWER format version is rejected with an explicit reader error (never silently stored)', async () => {
    const fromTheFuture = { ...makeTransition('user:pop'), version: 2 }
    const res = await putAnimation('user:pop', fromTheFuture)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_ANIMATION')
    expect(body.error.details.join(' ')).toContain('newer petween')
    expect((await (await fetch(`${base}/api/petween/animations`)).json()).customs).toEqual([])
  })

  it('B6: a pack-namespace animation round-trips and mounts like a user: one', async () => {
    const definition = makeTransition('motion:wall-bounce')
    expect((await putAnimation('motion:wall-bounce', definition)).status).toBe(200)
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    expect(listed.customs).toEqual([definition])

    const config = createDefaultPetweenConfig()
    config.states.idle.enter.animationId = 'motion:wall-bounce'
    const res = await putConfig(config)
    expect(res.status).toBe(200)
    expect((await res.json()).config.states.idle.enter.animationId).toBe('motion:wall-bounce')
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

  it('PUT rejects the reserved client preview draft id with 400', async () => {
    const res = await putAnimation('user:0draft', makeTransition('user:0draft'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_ANIMATION')
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    expect(listed.customs).toEqual([])
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

  it('PUT refuses 409 ANIMATION_IN_USE when a still-referenced animation changes kind', async () => {
    await putAnimation('user:pop', makeTransition('user:pop'))
    const config = createDefaultPetweenConfig()
    config.states.idle.enter.animationId = 'user:pop'
    expect((await putConfig(config)).status).toBe(200)

    // transition → ambient while mounted: refused, stored file untouched.
    const res = await putAnimation('user:pop', makeAmbient('user:pop'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    expect(listed.customs).toHaveLength(1)
    expect(listed.customs[0].kind).toBe('transition')

    // Same kind with other fields changed: allowed.
    const edited = { ...makeTransition('user:pop'), name: 'Custom Pop v2', durationMs: 320 }
    expect((await putAnimation('user:pop', edited)).status).toBe(200)

    // An unreferenced animation may change kind freely.
    await putAnimation('user:free', makeTransition('user:free'))
    expect((await putAnimation('user:free', makeAmbient('user:free'))).status).toBe(200)
  })

  it('PUT routes the kind-change probe through the store lock (guard callback)', async () => {
    await putAnimation('user:pop', makeTransition('user:pop'))
    const config = createDefaultPetweenConfig()
    config.states.idle.enter.animationId = 'user:pop'
    expect((await putConfig(config)).status).toBe(200)

    // Observe the contract: the route must hand the store a guard that
    // receives the fresh stored kind and runs the reference probe from inside
    // the save segment (the in-lock property itself is pinned in
    // animations.test.ts).
    const calls: string[] = []
    const original = deps.saveAnimation
    deps.saveAnimation = async (_definition, guard) => {
      calls.push('save')
      expect(typeof guard).toBe('function')
      await guard?.('transition') // the on-disk kind here
      // Deliberately skip the real write — the guard must have thrown.
    }
    try {
      const res = await putAnimation('user:pop', makeAmbient('user:pop'))
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'ANIMATION_IN_USE' })
      expect(calls).toEqual(['save'])
    } finally {
      deps.saveAnimation = original
    }
    // Untouched on disk.
    const listed = await (await fetch(`${base}/api/petween/animations`)).json()
    expect(listed.customs[0].kind).toBe('transition')
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

  const listPets = async (): Promise<{ pets: PetPreset[]; activePetId: string | null; warnings: string[] }> =>
    (await (await fetch(`${base}/api/petween/pets`)).json()) as { pets: PetPreset[]; activePetId: string | null; warnings: string[] }

  /**
   * PUT a config whose character slice is recognizably non-default; resolves
   * the default pet the null-pointer repair auto-provisioned around the
   * slice (it is the active pet afterwards).
   */
  async function seedConfig(scale = 1.5, assetId = '0123456789abcdef'): Promise<PetPreset> {
    const config = createDefaultPetweenConfig()
    config.global.scale = scale
    config.poses.idle.assetId = assetId
    const res = await putConfig(config)
    expect(res.status).toBe(200)
    const listed = await listPets()
    expect(listed.pets).toHaveLength(1)
    expect(listed.pets[0]!.name).toBe(DEFAULT_PET_NAME)
    expect(listed.activePetId).toBe(listed.pets[0]!.id)
    return listed.pets[0]!
  }

  it('GET returns an empty list and a null activePetId on a fresh install', async () => {
    const res = await fetch(`${base}/api/petween/pets`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pets: [], activePetId: null, warnings: [] })
  })

  it('POST from=current saves the current slice as a preset and makes it active', async () => {
    const seeded = await seedConfig()
    const res = await postPets({ name: 'Kitty', from: 'current' })
    expect(res.status).toBe(200)
    const { pet, config } = (await res.json()) as { pet: PetPreset; config: PetweenConfig }
    expect(pet.id).toMatch(/^pet_[a-z0-9]+$/)
    expect(pet.name).toBe('Kitty')
    expect(pet.scale).toBe(1.5)
    expect(pet.poses.idle.assetId).toBe('0123456789abcdef')
    expect(config.activePetId).toBe(pet.id)
    // persisted: the file is on disk and GET reflects the new active pointer.
    const onDisk = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(onDisk).toEqual(pet)
    const listed = await listPets()
    expect(listed.pets.map((candidate) => candidate.id).sort()).toEqual([seeded.id, pet.id].sort())
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

  it('POST from=blank adopts an empty pet: the view presents its default slice', async () => {
    await seedConfig()
    const res = await postPets({ name: 'Blank', from: 'blank' })
    expect(res.status).toBe(200)
    const { pet, config } = (await res.json()) as { pet: PetPreset; config: PetweenConfig }
    expect(config.activePetId).toBe(pet.id)
    expect(config.global.scale).toBe(1)
    expect(config.poses.idle.assetId).toBeUndefined()
    const listed = await listPets()
    expect(listed.pets.map((candidate: PetPreset) => candidate.name).sort()).toEqual(['Blank', DEFAULT_PET_NAME].sort())
  })

  it('POST from=blank keeps existing named presets', async () => {
    await postPets({ name: 'First', from: 'current' })
    const res = await postPets({ name: 'Blank', from: 'blank' })
    expect(res.status).toBe(200)
    const listed = await listPets()
    expect(listed.pets.map((preset: PetPreset) => preset.name).sort()).toEqual(['Blank', 'First'])
  })

  it('POST from=draft stores the supplied slice WITHOUT touching the active pet (A2)', async () => {
    await seedConfig(1.5, '0123456789abcdef')
    const { pet: active } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as {
      pet: PetPreset
    }
    // The variant fork: a client-side draft (unsaved edits included) — bigger
    // scale, a state field the saved config never got.
    const res = await postPets({
      name: 'Kitty 变体',
      from: 'draft',
      pet: {
        scale: 2.5,
        poses: { idle: { assetId: '0123456789abcdef' } },
        states: { idle: { enter: { preset: 'jelly', strength: 1.4, durationMs: 300 } } },
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pet: PetPreset; config?: unknown }
    expect(body.pet.name).toBe('Kitty 变体')
    expect(body.pet.scale).toBe(2.5)
    expect(body.pet.poses.idle.assetId).toBe('0123456789abcdef')
    expect(body.pet.states.idle.enter).toMatchObject({ preset: 'jelly', strength: 1.4 })
    expect(body.config).toBeUndefined() // a draft creation never adopts/returns a config
    // The active pointer, the active preset and the live view are untouched.
    const listed = await listPets()
    expect(listed.activePetId).toBe(active.id)
    expect(listed.pets.map((preset: PetPreset) => preset.name).sort()).toEqual(['Kitty', 'Kitty 变体', DEFAULT_PET_NAME].sort())
    const { config } = await (await fetch(`${base}/api/petween/config`)).json()
    expect(config.global.scale).toBe(1.5)
    expect(config.activePetId).toBe(active.id)
    expect(config.states.idle.enter.preset).toBe('soft')
  })

  it('POST from=draft rejects a slice referencing an unknown animation (400 INVALID_CONFIG)', async () => {
    const seeded = await seedConfig()
    const res = await postPets({
      name: 'Bad',
      from: 'draft',
      pet: { scale: 1, poses: {}, states: { idle: { enter: { animationId: 'user:missing' } } } },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_CONFIG')
    // No new pet was created (the seeded default pet is all there is).
    expect((await listPets()).pets.map((pet) => pet.id)).toEqual([seeded.id])
  })

  it('POST from=draft requires a pet slice object (400 INVALID_REQUEST)', async () => {
    const res = await postPets({ name: 'X', from: 'draft' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_REQUEST')
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
    expect((await listPets()).pets[0]!.name).toBe('New')

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

  it('DELETE removes an inactive preset plainly (non-active path unchanged)', async () => {
    const { pet: active } = (await (await postPets({ name: 'Active', from: 'current' })).json()) as { pet: PetPreset }
    const { pet: inactive } = (
      await (await postPets({ name: 'Inactive', from: 'draft', pet: { scale: 2, poses: {}, states: {} } })).json()
    ) as { pet: PetPreset }
    const res = await fetch(`${base}/api/petween/pets/${inactive.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: inactive.id }) // no config key on the non-active path
    const listed = await listPets()
    expect(listed.pets.map((pet) => pet.id)).toEqual([active.id])
    expect(listed.activePetId).toBe(active.id)
    expect((await fetch(`${base}/api/petween/pets/${inactive.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('DELETE on the ACTIVE preset falls the pointer back to the most recently updated remaining pet (C5-C)', async () => {
    const seeded = await seedConfig()
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    // Deleting the active pet used to be a 409 ACTIVE_PET; it now lands on
    // the most recently updated remaining preset in one round trip.
    const res = await fetch(`${base}/api/petween/pets/${pet.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: string; config: PetweenConfig }
    expect(body.deleted).toBe(pet.id)
    expect(body.config.activePetId).toBe(seeded.id)
    // The view presents the fallback pet's own slice.
    expect(body.config.global.scale).toBe(1.5)
    expect(body.config.poses.idle.assetId).toBe('0123456789abcdef')
    const listed = await listPets()
    expect(listed.pets.map((candidate) => candidate.id)).toEqual([seeded.id])
    expect(listed.activePetId).toBe(seeded.id)
  })

  it('DELETE on the only (active) pet auto-provisions a fresh default pet (C5-C + form (i))', async () => {
    const { pet } = (await (await postPets({ name: 'Solo', from: 'current' })).json()) as { pet: PetPreset }
    const res = await fetch(`${base}/api/petween/pets/${pet.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: string; config: PetweenConfig }
    expect(body.deleted).toBe(pet.id)
    expect(body.config.activePetId).toMatch(/^pet_[a-z0-9]+$/)
    expect(body.config.activePetId).not.toBe(pet.id)
    // The pointer is never null: a brand-new default pet holds the view.
    const listed = await listPets()
    expect(listed.pets).toHaveLength(1)
    expect(listed.pets[0]!.name).toBe(DEFAULT_PET_NAME)
    expect(listed.activePetId).toBe(listed.pets[0]!.id)
    expect(body.config.global.scale).toBe(1) // the fresh default slice
  })

  it('POST <id>/apply flips the pointer: the view presents the target preset\'s own slice', async () => {
    const seeded = await seedConfig()
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    // Edit the live slice (lands in Kitty, the active pet), then apply the
    // seeded default pet to bring its slice back.
    await putConfig({ global: { scale: 3 }, poses: { idle: { assetId: null } } })
    const res = await fetch(`${base}/api/petween/pets/${seeded.id}/apply`, { method: 'POST' })
    expect(res.status).toBe(200)
    const { config } = (await res.json()) as { config: PetweenConfig }
    expect(config.activePetId).toBe(seeded.id)
    expect(config.global.scale).toBe(1.5)
    expect(config.poses.idle.assetId).toBe('0123456789abcdef')
    // Kitty keeps her edited slice: no data crosses documents on a switch.
    const kittyDisk = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(kittyDisk.scale).toBe(3)
  })

  it('POST <id>/apply does not create an implicit unnamed preset', async () => {
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    // Edit the live slice (unsaved-then-saved work on Kitty), then re-apply.
    await putConfig({ global: { scale: 2.2 } })
    const res = await fetch(`${base}/api/petween/pets/${pet.id}/apply`, { method: 'POST' })
    expect(res.status).toBe(200)
    const listed = await listPets()
    expect(listed.pets.map((candidate) => candidate.name)).toEqual(['Kitty'])
    expect(listed.activePetId).toBe(pet.id)
  })

  it('POST <id>/apply 404s unknown ids; method and path guards hold', async () => {
    expect((await fetch(`${base}/api/petween/pets/pet_missing/apply`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/pet_missing`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/pet_missing`, { method: 'GET' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/..%2Fescape`, { method: 'DELETE' })).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/pet_x`, { method: 'PATCH' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/pets/pet_x/apply`, { method: 'PUT' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/pets`, { method: 'PUT' })).status).toBe(405)
  })

  it('GET /pets/<id> returns one preset (B10 single read); 404 unknown ids', async () => {
    const { pet } = (await (await postPets({ name: 'Solo', from: 'current' })).json()) as { pet: PetPreset }
    const res = await fetch(`${base}/api/petween/pets/${pet.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pet })
    expect((await fetch(`${base}/api/petween/pets/pet_missing`)).status).toBe(404)
  })

  it('config slice writes land in the active preset file; global-only writes never touch it', async () => {
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    await putConfig({ global: { scale: 2.4 } })
    const afterSlice = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(afterSlice.scale).toBe(2.4)
    // A global-only write (overlay drag persist) neither rewrites the preset
    // nor bumps its updatedAt (the no-churn rule covers identical slices).
    await putConfig({ overlay: { x: 10, y: 20 } })
    const afterGlobal = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(afterGlobal).toEqual(afterSlice)
  })

  // 2026-08-29 regression scenario, now structural: a bare activePetId switch
  // through PUT /config is a PURE pointer write — the view presents the
  // target pet's own slice and no data crosses presets (the old mirror that
  // clobbered the newly active preset is gone).
  it('PUT /config with a bare activePetId switch presents the target pet slice, both presets untouched', async () => {
    await seedConfig(1.5, 'aaaaaaaaaaaaaaaa')
    const { pet: petA } = (await (await postPets({ name: 'A', from: 'current' })).json()) as { pet: PetPreset }
    // Diverge the live slice (lands in A, the active pet).
    await putConfig({ global: { scale: 2.4 }, poses: { idle: { assetId: 'bbbbbbbbbbbbbbbb' } } })
    // A second preset whose slice differs from everything live.
    const { pet: petB } = (
      await (
        await postPets({
          name: 'B',
          from: 'draft',
          pet: {
            scale: 0.7,
            poses: { idle: { assetId: 'cccccccccccccccc' } },
            states: { success: { enter: { preset: 'jump', strength: 1.2, durationMs: 400 } } },
          },
        })
      ).json()
    ) as { pet: PetPreset }
    // The incident's exact call: switch with a bare pointer, no slice.
    const res = await putConfig({ activePetId: petB.id })
    expect(res.status).toBe(200)
    const { config } = (await res.json()) as { config: PetweenConfig }
    expect(config.activePetId).toBe(petB.id)
    // The live view now carries B's slice, not A's leftovers …
    expect(config.global.scale).toBe(0.7)
    expect(config.poses.idle.assetId).toBe('cccccccccccccccc')
    expect(config.states.success.enter.preset).toBe('jump')
    // … B keeps exactly its own data on disk …
    const bDisk = JSON.parse(await readFile(join(dir, 'pets', `${petB.id}.json`), 'utf8'))
    expect(bDisk.scale).toBe(0.7)
    expect(bDisk.poses.idle.assetId).toBe('cccccccccccccccc')
    expect(bDisk.states.success.enter.preset).toBe('jump')
    // … and A keeps the last data it actually owned (2.4 / bbbb).
    const aDisk = JSON.parse(await readFile(join(dir, 'pets', `${petA.id}.json`), 'utf8'))
    expect(aDisk.scale).toBe(2.4)
    expect(aDisk.poses.idle.assetId).toBe('bbbbbbbbbbbbbbbb')
  })

  it('a switch patch with caller slice fields writes them into the TARGET pet', async () => {
    await seedConfig(1.5, 'aaaaaaaaaaaaaaaa')
    await postPets({ name: 'A', from: 'current' })
    const { pet: petB } = (
      await (
        await postPets({ name: 'B', from: 'draft', pet: { scale: 0.7, poses: {}, states: {} } })
      ).json()
    ) as { pet: PetPreset }
    const res = await putConfig({ activePetId: petB.id, poses: { idle: { assetId: 'dddddddddddddddd' } } })
    expect(res.status).toBe(200)
    const { config } = (await res.json()) as { config: PetweenConfig }
    expect(config.poses.idle.assetId).toBe('dddddddddddddddd') // caller wins
    expect(config.global.scale).toBe(0.7) // the untouched fields still come from B
    const bDisk = JSON.parse(await readFile(join(dir, 'pets', `${petB.id}.json`), 'utf8'))
    expect(bDisk.poses.idle.assetId).toBe('dddddddddddddddd')
    expect(bDisk.scale).toBe(0.7)
  })

  it('a switch patch with a scale-less global takes the preset scale, not the previous pet\'s', async () => {
    await seedConfig(1.5, 'aaaaaaaaaaaaaaaa')
    await postPets({ name: 'A', from: 'current' })
    const { pet: petB } = (
      await (await postPets({ name: 'B', from: 'draft', pet: { scale: 0.7, poses: {}, states: {} } })).json()
    ) as { pet: PetPreset }
    const res = await putConfig({ activePetId: petB.id, global: { successHoldMs: 3000 } })
    expect(res.status).toBe(200)
    const { config } = (await res.json()) as { config: PetweenConfig }
    expect(config.global.scale).toBe(0.7) // NOT the 1.5 still live pre-switch
    expect(config.global.successHoldMs).toBe(3000)
  })

  it('a switch to a dangling pet id is a loud 404; explicit null is a tolerated no-op (phase 2)', async () => {
    await seedConfig()
    const { pet } = (await (await postPets({ name: 'Kitty', from: 'current' })).json()) as { pet: PetPreset }
    const dangling = await putConfig({ activePetId: 'pet_zzzzzzzzzzzzzz0' })
    expect(dangling.status).toBe(404)
    expect((await dangling.json()).error.code).toBe('NOT_FOUND')
    // The retired "detach": null carries no pointer opinion — the write
    // succeeds and the current pointer stays (roundtrip compatibility).
    const detach = await putConfig({ activePetId: null, global: { successHoldMs: 3000 } })
    expect(detach.status).toBe(200)
    // Neither attempt moved the live view.
    const { config } = await (await fetch(`${base}/api/petween/config`)).json()
    expect(config.global.scale).toBe(1.5)
    expect(config.global.successHoldMs).toBe(3000)
    expect(config.activePetId).toBe(pet.id)
  })

  it('DELETE /assets refuses 409 when only a non-active preset references the asset', async () => {
    const upload = await fetch(`${base}/api/petween/assets`, { method: 'POST', body: uploadBody(makePng(2, 3), 'image/png') })
    const assetId = ((await upload.json()) as { asset: { id: string } }).asset.id
    const seeded = await seedConfig(1.5, assetId) // the seeded pet references the asset
    await postPets({ name: 'Blank', from: 'blank' }) // switch away: the view no longer references it
    const res = await fetch(`${base}/api/petween/assets/${assetId}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'ASSET_IN_USE' })
    // Deleting the referencing (now inactive) preset frees the asset.
    await fetch(`${base}/api/petween/pets/${seeded.id}`, { method: 'DELETE' })
    expect((await fetch(`${base}/api/petween/assets/${assetId}`, { method: 'DELETE' })).status).toBe(200)
  })
})

describe('/api/petween/pets import/export (Pet Package §12)', () => {
  const putJson = (url: string, body: unknown): Promise<Response> =>
    fetch(`${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  const makeTransition = (id: string, durationMs = 240): AnimationDefinition => ({
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'transition',
    durationMs,
    repeat: { mode: 'once' },
    tracks: [{ property: 'transition.scaleX', keyframes: [{ at: 0, value: 1 }, { at: 1, value: 1 }] }],
    events: [{ at: 0.5, type: 'pose-swap' }],
  })

  const makeAmbient = (id: string): AnimationDefinition => ({
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'ambient',
    durationMs: 900,
    repeat: { mode: 'loop' },
    tracks: [{ property: 'sway.rotation', keyframes: [{ at: 0, value: -2 }, { at: 1, value: 2 }] }],
  })

  async function uploadPng(width: number, height: number): Promise<string> {
    const res = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      body: uploadBody(makePng(width, height), 'image/png'),
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { asset: { id: string } }).asset.id
  }

  /**
   * Seed a share-worthy active pet: two poses on real assets, a custom enter
   * on idle and a custom ambient on thinking — created via from:'draft' (a
   * slice-carrying creation that never touches the config, so no default pet
   * gets auto-provisioned), then applied, and carrying an attribution block.
   */
  async function seedShareablePet(): Promise<{ pet: PetPreset; idleId: string; thinkId: string }> {
    const idleId = await uploadPng(2, 3)
    const thinkId = await uploadPng(4, 5)
    for (const definition of [makeTransition('user:pop'), makeAmbient('user:float')]) {
      const res = await fetch(`${base}/api/petween/animations/${definition.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(definition),
      })
      expect(res.status).toBe(200)
    }
    const saved = await fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Share Me',
        from: 'draft',
        pet: {
          scale: 1,
          poses: { idle: { assetId: idleId }, thinking: { assetId: thinkId } },
          states: {
            idle: { enter: { animationId: 'user:pop' } },
            thinking: { ambient: { customAnimationId: 'user:float' } },
          },
        },
      }),
    })
    expect(saved.status).toBe(200)
    const { pet: created } = (await saved.json()) as { pet: PetPreset }
    const applied = await fetch(`${base}/api/petween/pets/${created.id}/apply`, { method: 'POST' })
    expect(applied.status).toBe(200)
    const attribution = { character: '溟月', creators: ['上善无形'], license: 'CC BY-NC-SA 4.0' }
    const meta = await putJson(`/api/petween/pets/${created.id}`, { attribution })
    expect(meta.status).toBe(200)
    return { pet: ((await meta.json()) as { pet: PetPreset }).pet, idleId, thinkId }
  }

  const exportZip = async (id: string): Promise<Buffer> => {
    const res = await fetch(`${base}/api/petween/pets/${id}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
    return Buffer.from(await res.arrayBuffer())
  }

  const postImport = (body: Buffer): Promise<Response> =>
    fetch(`${base}/api/petween/pets/import`, { method: 'POST', body: new Uint8Array(body) })

  /**
   * A hand-built package body with companion blobs (§12): one idle pose,
   * user:pop mounted on idle enter, and the given pluginConfigs verbatim.
   */
  function blobPackage(pluginConfigs: unknown): { body: Buffer; assetId: string } {
    const pose = makePng(2, 3)
    const sha256 = createHash('sha256').update(pose).digest('hex')
    const assetId = sha256.slice(0, 16)
    const manifest = {
      format: 'pet-package',
      version: 1,
      name: 'Blob Cat',
      pet: { scale: 1, poses: { idle: { assetId } }, states: { idle: { enter: { animationId: 'user:pop' } } } },
      assets: [{ id: assetId, sha256, file: `assets/${assetId}.png`, mimeType: 'image/png', width: 2, height: 3 }],
      motionPack: {
        format: 'motion-pack',
        version: 1,
        name: 'Blob 动画',
        namespace: 'user',
        animations: [makeTransition('user:pop')],
        mounts: { idle: { enter: 'user:pop' } },
      },
      pluginConfigs,
    }
    const body = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [`assets/${assetId}.png`]: new Uint8Array(pose) }),
    )
    return { body, assetId }
  }

  it('GET <id>/export streams a complete zip: manifest, both assets, derived mounts, attribution', async () => {
    const { pet, idleId, thinkId } = await seedShareablePet()
    const zip = unzipSync(new Uint8Array(await exportZip(pet.id)))
    expect(Object.keys(zip).sort()).toEqual([`assets/${idleId}.png`, `assets/${thinkId}.png`, 'manifest.json'].sort())
    const manifest = JSON.parse(strFromU8(zip['manifest.json'] as Uint8Array)) as Record<string, any>
    expect(manifest).toMatchObject({ format: 'pet-package', version: 1, name: 'Share Me' })
    expect(manifest.pet.scale).toBe(pet.scale)
    expect(manifest.pet.poses.idle.assetId).toBe(idleId)
    expect(manifest.assets.map((entry: { id: string }) => entry.id).sort()).toEqual([idleId, thinkId].sort())
    expect(manifest.motionPack.namespace).toBe('mixed')
    expect(manifest.motionPack.mounts).toEqual({ idle: { enter: 'user:pop' }, thinking: { ambient: 'user:float' } })
    expect(manifest.attribution).toEqual({ character: '溟月', creators: ['上善无形'], license: 'CC BY-NC-SA 4.0' })
    // The shipped bytes really hash to the content-addressed id.
    const sha = createHash('sha256').update(Buffer.from(zip[`assets/${idleId}.png`] as Uint8Array)).digest('hex')
    expect(sha.startsWith(idleId)).toBe(true)
  })

  it('export → import round trip: identical slice, attribution carried, assets reused, pet activated', async () => {
    const { pet, idleId, thinkId } = await seedShareablePet()
    const res = await postImport(await exportZip(pet.id))
    expect(res.status).toBe(200)
    const { pet: imported, config, report } = (await res.json()) as {
      pet: PetPreset
      config: PetweenConfig
      report: Record<string, unknown>
    }
    expect(imported.id).not.toBe(pet.id)
    expect(imported.name).toBe('Share Me')
    expect(imported.scale).toBe(pet.scale)
    expect(imported.poses).toEqual(pet.poses)
    expect(imported.states).toEqual(pet.states)
    expect(imported.attribution).toEqual(pet.attribution)
    // Import即用: the new pet is active and its slice is live.
    expect(config.activePetId).toBe(imported.id)
    expect(config.poses.idle.assetId).toBe(idleId)
    expect(config.states.thinking.ambient.customAnimationId).toBe('user:float')
    // The verbatim client report contract.
    expect(report).toEqual({
      assetsAdded: [],
      assetsReused: [idleId, thinkId],
      entries: [
        { requestedId: 'user:pop', finalId: 'user:pop', status: 'identical' },
        { requestedId: 'user:float', finalId: 'user:float', status: 'identical' },
      ],
      mounts: { idle: { enter: 'user:pop' }, thinking: { ambient: 'user:float' } },
      warnings: [],
    })
    const listed = (await (await fetch(`${base}/api/petween/pets`)).json()) as {
      pets: PetPreset[]
      activePetId: string
    }
    expect(listed.pets.map((candidate) => candidate.name)).toEqual(['Share Me', 'Share Me'])
    expect(listed.activePetId).toBe(imported.id)
  })

  it('an animation collision remaps: final ids land in the new pet, the mounts report and the applied config', async () => {
    const { pet } = await seedShareablePet()
    const bytes = await exportZip(pet.id)
    // Claim user:pop with DIFFERENT content before importing the package.
    const claim = await fetch(`${base}/api/petween/animations/user:pop`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeTransition('user:pop', 500)),
    })
    expect(claim.status).toBe(200)
    const res = await postImport(bytes)
    expect(res.status).toBe(200)
    const { pet: imported, config, report } = (await res.json()) as {
      pet: PetPreset
      config: PetweenConfig
      report: { entries: unknown[]; mounts: Record<string, unknown> }
    }
    expect(report.entries).toEqual([
      { requestedId: 'user:pop', finalId: 'user:pop-2', status: 'remapped' },
      { requestedId: 'user:float', finalId: 'user:float', status: 'identical' },
    ])
    expect(report.mounts).toEqual({ idle: { enter: 'user:pop-2' }, thinking: { ambient: 'user:float' } })
    expect(imported.states.idle.enter.animationId).toBe('user:pop-2')
    expect(config.states.idle.enter.animationId).toBe('user:pop-2')
    const { customs } = (await (await fetch(`${base}/api/petween/animations`)).json()) as {
      customs: AnimationDefinition[]
    }
    expect(customs.map((definition) => definition.id).sort()).toEqual(['user:float', 'user:pop', 'user:pop-2'])
  })

  it('import carries pluginConfigs into the record, injects the collision remap, never rewrites the blob', async () => {
    // Claim user:pop with DIFFERENT content so the import remaps it.
    const claim = await fetch(`${base}/api/petween/animations/user:pop`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeTransition('user:pop', 500)),
    })
    expect(claim.status).toBe(200)
    const config = { gravity: 2400, slideAnimationId: 'user:pop' }
    const { body } = blobPackage({
      'petween-physics': { config, animationIdRemap: { 'user:stale': 'user:stale-2' } },
    })
    const res = await postImport(body)
    expect(res.status).toBe(200)
    const { pet, report } = (await res.json()) as { pet: PetPreset; report: Record<string, unknown> }
    expect(report.pluginConfigs).toEqual(['petween-physics'])
    expect(report.entries).toEqual([{ requestedId: 'user:pop', finalId: 'user:pop-2', status: 'remapped' }])
    // The record carries the blob VERBATIM — the id inside is NOT rewritten…
    expect(pet.pluginConfigs?.['petween-physics']?.config).toEqual(config)
    // …while THIS import's collision plan replaces the stale manifest remap.
    expect(pet.pluginConfigs?.['petween-physics']?.animationIdRemap).toEqual({ 'user:pop': 'user:pop-2' })
    // The single-pet read (the companion's pull path) exposes the same blob.
    const single = (await (await fetch(`${base}/api/petween/pets/${pet.id}`)).json()) as { pet: PetPreset }
    expect(single.pet.pluginConfigs).toEqual(pet.pluginConfigs)
    // The apply is a pure pointer flip: nothing rewrote the record, so the
    // blob survives on disk verbatim.
    const onDisk = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(onDisk.pluginConfigs['petween-physics'].config).toEqual(config)
  })

  it('pluginConfigs round trip: export carries the record blob, re-import lands it field-equal', async () => {
    const { body } = blobPackage({ 'petween-physics': { config: { gravity: 2400, bounce: { restitution: 0.82 } } } })
    const first = await postImport(body)
    expect(first.status).toBe(200)
    const { pet: imported, report: firstReport } = (await first.json()) as { pet: PetPreset; report: Record<string, unknown> }
    expect(firstReport.pluginConfigs).toEqual(['petween-physics'])
    // No collision: the injected remap is this entry's identical mapping.
    expect(imported.pluginConfigs?.['petween-physics']?.animationIdRemap).toEqual({ 'user:pop': 'user:pop' })

    // Export the imported pet: the manifest carries the record blob verbatim.
    const zip = unzipSync(new Uint8Array(await exportZip(imported.id)))
    const manifest = JSON.parse(strFromU8(zip['manifest.json'] as Uint8Array)) as { pluginConfigs?: unknown }
    expect(manifest.pluginConfigs).toEqual(imported.pluginConfigs)

    // Re-import: the blob lands field-equal on the new record (the identical
    // remap re-injects to the same table).
    const second = await postImport(await exportZip(imported.id))
    expect(second.status).toBe(200)
    const { pet: reimported, report: secondReport } = (await second.json()) as { pet: PetPreset; report: Record<string, unknown> }
    expect(secondReport.pluginConfigs).toEqual(['petween-physics'])
    expect(reimported.pluginConfigs).toEqual(imported.pluginConfigs)
  })

  it('a structurally invalid package is a 400 and nothing is written', async () => {
    const snapshot = async (): Promise<Record<string, string[]>> => {
      const responses = await Promise.all([
        fetch(`${base}/api/petween/animations`),
        fetch(`${base}/api/petween/pets`),
        fetch(`${base}/api/petween/config`),
      ])
      const [animations, pets, config] = (await Promise.all(responses.map((response) => response.json()))) as unknown as [
        { customs: AnimationDefinition[] },
        { pets: PetPreset[] },
        { assets: Record<string, unknown> },
      ]
      return {
        animationIds: animations.customs.map((definition) => definition.id).sort(),
        petIds: pets.pets.map((candidate) => candidate.id).sort(),
        assetIds: Object.keys(config.assets).sort(),
      }
    }
    const before = await snapshot()
    const evil = Buffer.from(
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ format: 'pet-package', version: 1, name: 'Evil', pet: {}, assets: [] })),
        '../evil.png': new Uint8Array(makePng()),
      }),
    )
    const res = await postImport(evil)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PET_PACKAGE_INVALID')
    expect(await snapshot()).toEqual(before)
  })

  it('a package carrying the reserved client-draft animation id is a 400 before any write', async () => {
    const png = makePng(6, 7)
    const sha256 = createHash('sha256').update(png).digest('hex')
    const id = sha256.slice(0, 16)
    // 'user:0draft' passes the custom-id shape check but is reserved for the
    // client preview draft: pack validation now rejects it up front (it used
    // to slip through and only fail inside the animation transaction, after
    // the package's assets had already landed).
    const manifest = {
      format: 'pet-package',
      version: 1,
      name: 'Bad',
      pet: { scale: 1, poses: { idle: { assetId: id } }, states: { idle: { enter: { animationId: 'user:0draft' } } } },
      assets: [{ id, sha256, file: `assets/${id}.png`, mimeType: 'image/png', width: 6, height: 7 }],
      motionPack: {
        format: 'motion-pack',
        version: 1,
        name: 'Bad 动画',
        namespace: 'user',
        animations: [makeTransition('user:0draft')],
        mounts: { idle: { enter: 'user:0draft' } },
      },
    }
    const bytes = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [`assets/${id}.png`]: new Uint8Array(png) }),
    )
    const res = await postImport(bytes)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PET_PACKAGE_INVALID')
    // Zero writes: no asset, no animation, no pet.
    expect(await readdir(join(dir, 'assets')).catch(() => [])).toEqual([])
    expect(await readdir(join(dir, 'animations')).catch(() => [])).toEqual([])
    expect(await readdir(join(dir, 'pets')).catch(() => [])).toEqual([])
  })

  it('a slice mounting an ambient animation on an enter slot is a 400 before any write', async () => {
    const png = makePng(6, 7)
    const sha256 = createHash('sha256').update(png).digest('hex')
    const id = sha256.slice(0, 16)
    // Hand-made manifest: user:float is ambient-kind but mounted on enter —
    // validatePetPackage must reject before createPet could persist a pet
    // that every later strict config save would reject (a dead preset).
    const manifest = {
      format: 'pet-package',
      version: 1,
      name: 'Wrong Kind',
      pet: { scale: 1, poses: { idle: { assetId: id } }, states: { idle: { enter: { animationId: 'user:float' } } } },
      assets: [{ id, sha256, file: `assets/${id}.png`, mimeType: 'image/png', width: 6, height: 7 }],
      motionPack: {
        format: 'motion-pack',
        version: 1,
        name: 'Wrong Kind 动画',
        namespace: 'user',
        animations: [makeAmbient('user:float')],
      },
    }
    const bytes = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [`assets/${id}.png`]: new Uint8Array(png) }),
    )
    const res = await postImport(bytes)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details?: string[] } }
    expect(body.error.code).toBe('PET_PACKAGE_INVALID')
    expect(body.error.details?.join(' ')).toContain('user:float')
    expect(await readdir(join(dir, 'assets')).catch(() => [])).toEqual([])
    expect(await readdir(join(dir, 'animations')).catch(() => [])).toEqual([])
    expect(await readdir(join(dir, 'pets')).catch(() => [])).toEqual([])
  })

  it('a failure inside the animation transaction rolls the fresh assets back (no orphans, no half pet)', async () => {
    const png = makePng(6, 7)
    const sha256 = createHash('sha256').update(png).digest('hex')
    const id = sha256.slice(0, 16)
    const manifest = {
      format: 'pet-package',
      version: 1,
      name: 'Bad',
      pet: { scale: 1, poses: { idle: { assetId: id } }, states: { idle: { enter: { animationId: 'user:pop' } } } },
      assets: [{ id, sha256, file: `assets/${id}.png`, mimeType: 'image/png', width: 6, height: 7 }],
      motionPack: {
        format: 'motion-pack',
        version: 1,
        name: 'Bad 动画',
        namespace: 'user',
        animations: [makeTransition('user:pop')],
        mounts: { idle: { enter: 'user:pop' } },
      },
    }
    const bytes = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [`assets/${id}.png`]: new Uint8Array(png) }),
    )
    // Force the animation transaction to fail AFTER the asset writes landed.
    const original = deps.importPack
    deps.importPack = async () => {
      throw new Error('simulated import failure')
    }
    try {
      const res = await postImport(bytes)
      expect(res.status).toBe(500)
    } finally {
      deps.importPack = original
    }
    const { assets } = (await (await fetch(`${base}/api/petween/config`)).json()) as { assets: Record<string, unknown> }
    expect(assets[id]).toBeUndefined()
    const { pets } = (await (await fetch(`${base}/api/petween/pets`)).json()) as { pets: PetPreset[] }
    expect(pets).toEqual([])
  })

  it('a dedup-hit asset (created:false) survives the failure rollback — concurrent-import sharing', async () => {
    const png = makePng(6, 7)
    const sha256 = createHash('sha256').update(png).digest('hex')
    const id = sha256.slice(0, 16)
    const manifest = {
      format: 'pet-package',
      version: 1,
      name: 'Shared',
      pet: { scale: 1, poses: { idle: { assetId: id } }, states: {} },
      assets: [{ id, sha256, file: `assets/${id}.png`, mimeType: 'image/png', width: 6, height: 7 }],
    }
    const bytes = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [`assets/${id}.png`]: new Uint8Array(png) }),
    )
    // Simulate a concurrent importer owning the shared asset: the store's
    // content-hash dedup reports created:false (the bytes ARE on disk — the
    // "other" import wrote them — but THIS call did not create the entry).
    const originalSave = deps.saveAsset
    deps.saveAsset = async (buffer, declaredMime) => ({ ...(await originalSave(buffer, declaredMime)), created: false })
    // Force a failure after the asset step so the rollback runs.
    const originalCreate = deps.createPet
    deps.createPet = async () => {
      throw new Error('simulated create failure')
    }
    try {
      const res = await postImport(bytes)
      expect(res.status).toBe(500)
    } finally {
      deps.saveAsset = originalSave
      deps.createPet = originalCreate
    }
    // The shared asset must survive this import's rollback.
    const { assets } = (await (await fetch(`${base}/api/petween/config`)).json()) as { assets: Record<string, unknown> }
    expect(assets[id]).toBeDefined()
  })

  it('PUT /pets/<id> updates attribution field-by-field, clears with null; renames keep it', async () => {
    const blank = await fetch(`${base}/api/petween/pets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Meta', from: 'blank' }),
    })
    const { pet } = (await blank.json()) as { pet: PetPreset }
    expect((await putJson(`/api/petween/pets/${pet.id}`, { attribution: { character: '溟月' } })).status).toBe(200)
    const partial = (await (await putJson(`/api/petween/pets/${pet.id}`, { attribution: { creators: ['上善无形'] } })).json()) as {
      pet: PetPreset
    }
    expect(partial.pet.attribution).toEqual({ character: '溟月', creators: ['上善无形'] })
    const fieldCleared = (await (await putJson(`/api/petween/pets/${pet.id}`, { attribution: { character: null } })).json()) as {
      pet: PetPreset
    }
    expect(fieldCleared.pet.attribution).toEqual({ creators: ['上善无形'] })
    const renamed = (await (await putJson(`/api/petween/pets/${pet.id}`, { name: 'Renamed' })).json()) as { pet: PetPreset }
    expect(renamed.pet.name).toBe('Renamed')
    expect(renamed.pet.attribution).toEqual({ creators: ['上善无形'] })
    const cleared = (await (await putJson(`/api/petween/pets/${pet.id}`, { attribution: null })).json()) as { pet: PetPreset }
    expect(cleared.pet.attribution).toBeUndefined()
    // Invalid shapes are 400s and change nothing.
    expect((await putJson(`/api/petween/pets/${pet.id}`, { attribution: { creators: 'nope' } })).status).toBe(400)
    expect((await putJson(`/api/petween/pets/${pet.id}`, { attribution: 'nope' })).status).toBe(400)
    // A config slice write lands in the active preset WITHOUT dropping the
    // stored attribution (the attribution lives on the record, outside the
    // slice the write replaces).
    await putJson(`/api/petween/pets/${pet.id}`, { attribution: { license: 'MIT' } })
    await putJson('/api/petween/config', { global: { scale: 2 } })
    const onDisk = JSON.parse(await readFile(join(dir, 'pets', `${pet.id}.json`), 'utf8'))
    expect(onDisk.attribution).toEqual({ license: 'MIT' })
    expect(onDisk.scale).toBe(2)
  })

  it('export 404s unknown pets; import/export method and body guards hold', async () => {
    expect((await fetch(`${base}/api/petween/pets/pet_missing/export`)).status).toBe(404)
    expect((await fetch(`${base}/api/petween/pets/import`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`${base}/api/petween/pets/pet_x/export`, { method: 'POST' })).status).toBe(405)
    const notZip = await postImport(Buffer.from('not a zip at all'))
    expect(notZip.status).toBe(400)
    expect(((await notZip.json()) as { error: { code: string } }).error.code).toBe('PET_PACKAGE_INVALID')
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

  it('same-site is not enough on its own: a foreign Origin is rejected, a matching one passes', async () => {
    // Cross-port localhost counts as same-site — the guard must still compare
    // Origin against Host instead of trusting the fetch-metadata alone.
    const foreign = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-site', origin: 'http://localhost:9999', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(foreign.status).toBe(403)
    expect((await foreign.json()).error.code).toBe('CROSS_ORIGIN')
    const sameOrigin = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-site', origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(sameOrigin.status).toBe(200)
    // No Origin at all: a non-browser client annotating fetch metadata stays allowed.
    const cliStyle = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(cliStyle.status).toBe(200)
    // same-origin/none keep their fast path.
    const navStyle = await fetch(`${base}/api/petween/config`, {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(navStyle.status).toBe(200)
  })

  it('GETs are never guarded', async () => {
    const res = await fetch(`${base}/api/petween/config`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(200)
  })
})
