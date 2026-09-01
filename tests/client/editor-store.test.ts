/**
 * EditorStore tests: explicit config saving, latest-wins writes
 * while a PUT is in flight, the save-state machine, failure/retry, the
 * import/remove asset flows (upload → patch PUT → delete ordering), the
 * editor/overlay ownership split (P1: saves carry only the owned sections
 * and broadcast the host-merged response), and the §2.1 "at least one
 * image" gate helper. All timers are fake; the EditorApi is injected, no
 * fetch involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ConfigPatch, type PetPackageImportResponse, type UploadedAsset } from '../../src/client/api'
import { ConfigHub, type ConfigSnapshot } from '../../src/client/config-hub'
import {
  EditorStore,
  hasAnyUsableImage,
  type EditorApi,
} from '../../src/client/stores/editor-store'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetAttribution, PetweenConfig, PetPreset, PetSlice } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

interface ApiMocks {
  getConfig: ReturnType<typeof vi.fn>
  getAnimations: ReturnType<typeof vi.fn>
  getPets: ReturnType<typeof vi.fn>
  createPet: ReturnType<typeof vi.fn>
  createPetFromDraft: ReturnType<typeof vi.fn>
  renamePet: ReturnType<typeof vi.fn>
  deletePet: ReturnType<typeof vi.fn>
  applyPet: ReturnType<typeof vi.fn>
  patchConfig: ReturnType<typeof vi.fn>
  putAnimation: ReturnType<typeof vi.fn>
  deleteAnimation: ReturnType<typeof vi.fn>
  importMotionPack: ReturnType<typeof vi.fn>
  exportMotionPack: ReturnType<typeof vi.fn>
  exportPetPackage: ReturnType<typeof vi.fn>
  importPetPackage: ReturnType<typeof vi.fn>
  updatePetMeta: ReturnType<typeof vi.fn>
  uploadAsset: ReturnType<typeof vi.fn>
  deleteAsset: ReturnType<typeof vi.fn>
}

/** Merge a patch onto a base config the way the host does (§19.2). */
const mergePatch = (base: PetweenConfig, patch: ConfigPatch): PetweenConfig => ({
  ...structuredClone(base),
  enabled: patch.enabled ?? base.enabled,
  global: { ...structuredClone(base.global), ...patch.global },
  poses: patch.poses ?? structuredClone(base.poses),
  states: patch.states ?? structuredClone(base.states),
  advanced: patch.advanced ?? structuredClone(base.advanced),
  interactions: patch.interactions ?? structuredClone(base.interactions),
})

const makeApi = (overrides: Partial<EditorApi> = {}): { api: EditorApi; mocks: ApiMocks } => {
  // A truthful host stand-in: patches merge onto a server-side config and the
  // merged full config comes back (that response is what the store must
  // broadcast — never the local payload).
  let serverConfig = createDefaultPetweenConfig()
  let serverCustoms: AnimationDefinition[] = []
  let serverPets: PetPreset[] = []
  let petSequence = 0
  const mocks = {
    getConfig: vi.fn(async () => ({ config: structuredClone(serverConfig), assets: {} })),
    getAnimations: vi.fn(async () => ({ customs: structuredClone(serverCustoms), warnings: [] as string[], normalized: [] as string[] })),
    getPets: vi.fn(async () => ({
      pets: structuredClone(serverPets),
      activePetId: serverConfig.activePetId,
      warnings: [] as string[],
    })),
    createPet: vi.fn(async ({ name, from }: { name: string; from: 'current' | 'blank' }) => {
      const source = from === 'current' ? serverConfig : createDefaultPetweenConfig()
      const pet: PetPreset = {
        id: `pet_${++petSequence}`,
        name,
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
        scale: source.global.scale,
        poses: structuredClone(source.poses),
        states: structuredClone(source.states),
      }
      serverPets.push(pet)
      serverConfig.activePetId = pet.id
      if (from === 'blank') {
        serverConfig.global.scale = pet.scale
        serverConfig.poses = structuredClone(pet.poses)
        serverConfig.states = structuredClone(pet.states)
      }
      return { pet: structuredClone(pet), config: structuredClone(serverConfig) }
    }),
    createPetFromDraft: vi.fn(async (name: string, pet: PetSlice) => {
      // Truthful A2 stand-in: the supplied slice becomes a new preset and the
      // active config (and its activePetId) is NOT touched.
      const created: PetPreset = {
        id: `pet_${++petSequence}`,
        name,
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
        scale: pet.scale,
        poses: structuredClone(pet.poses),
        states: structuredClone(pet.states),
      }
      serverPets.push(created)
      return { pet: structuredClone(created) }
    }),
    renamePet: vi.fn(async (id: string, name: string) => {
      serverPets = serverPets.map((pet) => (pet.id === id ? { ...pet, name } : pet))
    }),
    deletePet: vi.fn(async (id: string) => {
      serverPets = serverPets.filter((pet) => pet.id !== id)
      if (serverConfig.activePetId === id) serverConfig.activePetId = null
    }),
    applyPet: vi.fn(async (id: string) => {
      const pet = serverPets.find((candidate) => candidate.id === id)
      if (pet === undefined) throw new Error('unknown pet')
      serverConfig = {
        ...serverConfig,
        activePetId: pet.id,
        global: { ...serverConfig.global, scale: pet.scale },
        poses: structuredClone(pet.poses),
        states: structuredClone(pet.states),
      }
      return structuredClone(serverConfig)
    }),
    patchConfig: vi.fn(async (patch: ConfigPatch) => {
      serverConfig = mergePatch(serverConfig, patch)
      return structuredClone(serverConfig)
    }),
    putAnimation: vi.fn(async (definition: AnimationDefinition) => {
      const index = serverCustoms.findIndex((custom) => custom.id === definition.id)
      if (index === -1) serverCustoms.push(structuredClone(definition))
      else serverCustoms[index] = structuredClone(definition)
    }),
    importMotionPack: vi.fn(async () => ({
      name: '',
      namespace: 'user',
      entries: [],
      mounts: {},
      warnings: [] as string[],
    })),
    exportMotionPack: vi.fn(async (_ids: string[]) => ({
      format: 'motion-pack' as const,
      version: 1 as const,
      name: 'Motion Pack',
      namespace: 'user',
      animations: [],
    })),
    exportPetPackage: vi.fn(async () => new ArrayBuffer(8)),
    importPetPackage: vi.fn(async (): Promise<PetPackageImportResponse> => {
      throw new Error('pet package import must be mocked per test')
    }),
    updatePetMeta: vi.fn(async (id: string, body: { name?: string; attribution?: PetAttribution | null }) => {
      let updated: PetPreset | undefined
      serverPets = serverPets.map((pet) => {
        if (pet.id !== id) return pet
        updated = { ...pet }
        if (body.name !== undefined) updated.name = body.name
        if (body.attribution === null) delete updated.attribution
        else if (body.attribution !== undefined) updated.attribution = body.attribution
        return updated
      })
      if (updated === undefined) throw new Error('unknown pet')
      return { pet: structuredClone(updated) }
    }),
    deleteAnimation: vi.fn(async (id: string) => {
      serverCustoms = serverCustoms.filter((custom) => custom.id !== id)
    }),
    uploadAsset: vi.fn(async () => ({ id: 'aaaa1111bbbb2222', url: '/petween-assets/aaaa1111bbbb2222', width: 240, height: 240 })),
    deleteAsset: vi.fn(async () => {}),
    ...overrides,
  } as ApiMocks
  return { api: mocks as EditorApi, mocks }
}

/** Drain the microtask queue (promise continuations under fake timers). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

let store: EditorStore

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  store.dispose()
  vi.useRealTimers()
})

const loadStore = async (api: EditorApi): Promise<EditorStore> => {
  store = new EditorStore({ api })
  await store.load()
  return store
}

describe('EditorStore — load', () => {
  it('loads config + assets and becomes ready', async () => {
    const { api } = makeApi()
    await loadStore(api)
    const snapshot = store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.config).not.toBeNull()
    expect(snapshot.selectedState).toBe('idle')
    expect(snapshot.saveState).toBe('idle')
  })

  it('a failed load lands in the error state with the message', async () => {
    const { api } = makeApi({ getConfig: vi.fn(async () => Promise.reject(new Error('boom'))) })
    await loadStore(api)
    expect(store.getSnapshot().status).toBe('error')
    expect(store.getSnapshot().loadError).toBe('boom')
  })
})

describe('EditorStore — explicit config saving', () => {
  it('keeps a burst of edits local until one manual save', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)

    for (const scale of [1.1, 1.2, 1.3, 1.4, 1.5]) {
      store.updateConfig((draft) => {
        draft.global.scale = scale
      })
    }
    expect(store.getSnapshot().saveState).toBe('dirty')
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    await store.saveConfig()
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect((mocks.patchConfig.mock.calls[0][0] as ConfigPatch).global?.scale).toBe(1.5)
    await flushMicrotasks()
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('latest-wins while a PUT is in flight: edits queue and flush right after', async () => {
    const resolvers: Array<(config: PetweenConfig) => void> = []
    const patchConfig = vi.fn(
      (patch: ConfigPatch) =>
        new Promise<PetweenConfig>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const { api } = makeApi({ patchConfig: patchConfig as EditorApi['patchConfig'] })
    await loadStore(api)

    store.updateConfig((draft) => {
      draft.global.scale = 1.2
    })
    const saving = store.saveConfig()
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(1) // in flight now

    store.updateConfig((draft) => {
      draft.global.scale = 1.7
    })
    expect(patchConfig).toHaveBeenCalledTimes(1) // queued behind the in-flight PUT

    resolvers[0](createDefaultPetweenConfig())
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(2)
    expect((patchConfig.mock.calls[1][0] as ConfigPatch).global?.scale).toBe(1.7)

    resolvers[1](createDefaultPetweenConfig())
    await saving
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('a failed PUT flips saveState to error; retrySave writes again', async () => {
    const patchConfig = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')))
      .mockImplementation(async () => createDefaultPetweenConfig())
    const { api } = makeApi({ patchConfig: patchConfig as EditorApi['patchConfig'] })
    await loadStore(api)

    store.updateConfig((draft) => {
      draft.global.scale = 1.3
    })
    await store.saveConfig()
    expect(store.getSnapshot().saveState).toBe('error')
    expect(store.getSnapshot().saveError).toBe('disk full')

    store.retrySave()
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('dispose does not persist an unsaved draft', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.9
    })
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    store.dispose()
    await flushMicrotasks()
    expect(mocks.patchConfig).not.toHaveBeenCalled()
  })
})

describe('EditorStore — §19.4 asset flows', () => {
  const pngFile = (): File => new File(['png-bytes'], 'pet.png', { type: 'image/png' })

  it('importImage orders upload → PUT(new assetId) → DELETE(old asset)', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    const config = store.getSnapshot().config
    if (config === null) throw new Error('config missing')
    config.poses.idle.assetId = 'old0000000000000'

    await store.importImage('idle', pngFile())
    await flushMicrotasks()

    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1)
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
    await store.saveConfig()
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(1)
    const [uploadOrder, putOrder, deleteOrder] = [
      mocks.uploadAsset.mock.invocationCallOrder[0],
      mocks.patchConfig.mock.invocationCallOrder[0],
      mocks.deleteAsset.mock.invocationCallOrder[0],
    ]
    expect(uploadOrder).toBeLessThan(putOrder)
    expect(putOrder).toBeLessThan(deleteOrder)

    // the patch body points the pose at the NEW asset (poses are editor-owned)
    expect((mocks.patchConfig.mock.calls[0][0] as ConfigPatch).poses?.idle.assetId).toBe('aaaa1111bbbb2222')
    expect(mocks.deleteAsset).toHaveBeenCalledWith('old0000000000000')

    // local maps follow: new asset added, old one dropped
    const snapshot = store.getSnapshot()
    expect(snapshot.config?.poses.idle.assetId).toBe('aaaa1111bbbb2222')
    expect(snapshot.assets['aaaa1111bbbb2222']?.url).toBe('/petween-assets/aaaa1111bbbb2222')
    expect(snapshot.assets['old0000000000000']).toBeUndefined()
    expect(snapshot.saveState).toBe('saved')
  })

  it('importImage of a JPEG warns about the missing transparency but proceeds', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    await store.importImage('idle', new File(['jpg'], 'pet.jpg', { type: 'image/jpeg' }))
    await flushMicrotasks()
    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().notice?.kind).toBe('info')
    expect(store.getSnapshot().notice?.text).toContain('JPEG')
  })

  it('importImage rejects unsupported types before any upload', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    await store.importImage('idle', new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))
    expect(mocks.uploadAsset).not.toHaveBeenCalled()
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.kind).toBe('error')
    expect(store.getSnapshot().importing).toBeNull()
  })

  it('importImage mirrors the in-flight upload on snapshot.importing and clears it after (UX-3)', async () => {
    let resolveUpload!: (asset: UploadedAsset) => void
    const uploadAsset = vi.fn(
      () => new Promise<UploadedAsset>((resolve) => {
        resolveUpload = resolve
      }),
    )
    const { api } = makeApi({ uploadAsset: uploadAsset as EditorApi['uploadAsset'] })
    await loadStore(api)
    const pending = store.importImage('idle', pngFile())
    await flushMicrotasks()
    expect(store.getSnapshot().importing).toBe('idle')

    resolveUpload({ id: 'aaaa1111bbbb2222', url: '/petween-assets/aaaa1111bbbb2222', width: 240, height: 240 })
    await pending
    await flushMicrotasks()
    expect(store.getSnapshot().importing).toBeNull()
    expect(store.getSnapshot().config?.poses.idle.assetId).toBe('aaaa1111bbbb2222')
    expect(store.getSnapshot().saveState).toBe('dirty')
  })

  it('a superseded import still lands its asset and revision; only importing belongs to the newest', async () => {
    const deferred: Array<(asset: UploadedAsset) => void> = []
    const uploadAsset = vi.fn(
      () =>
        new Promise<UploadedAsset>((resolve) => {
          deferred.push(resolve)
        }),
    )
    const { api } = makeApi({ uploadAsset: uploadAsset as EditorApi['uploadAsset'] })
    await loadStore(api)
    const first = store.importImage('idle', pngFile())
    const second = store.importImage('thinking', pngFile())
    await flushMicrotasks()
    expect(store.getSnapshot().importing).toBe('thinking')

    // The superseded upload resolves FIRST: its draft mutation already
    // happened, so its asset/revision patch must still land — otherwise the
    // snapshot falls behind the draft with no bump to heal it.
    deferred[0]({ id: 'asset000000000001', url: '/petween-assets/asset000000000001', width: 100, height: 100 })
    await flushMicrotasks()
    const mid = store.getSnapshot()
    expect(mid.importing).toBe('thinking') // the newest import still owns the flag
    expect(mid.config?.poses.idle.assetId).toBe('asset000000000001')
    expect(mid.assets['asset000000000001']).toBeDefined()
    expect(mid.configRevision).toBeGreaterThan(0)
    expect(mid.saveState).toBe('dirty')

    deferred[1]({ id: 'asset000000000002', url: '/petween-assets/asset000000000002', width: 100, height: 100 })
    await Promise.all([first, second])
    await flushMicrotasks()
    const snapshot = store.getSnapshot()
    expect(snapshot.importing).toBeNull()
    expect(snapshot.assets['asset000000000002']).toBeDefined()
    expect(snapshot.config?.poses.thinking.assetId).toBe('asset000000000002')
  })

  it('edits landing during the post-save cleanup window keep saveState dirty', async () => {
    let resolveDelete!: () => void
    const deleteAsset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )
    const { api, mocks } = makeApi({ deleteAsset: deleteAsset as EditorApi['deleteAsset'] })
    await loadStore(api)
    const config = store.getSnapshot().config
    if (config === null) throw new Error('config missing')
    config.poses.idle.assetId = 'old0000000000000'
    await store.importImage('idle', pngFile()) // replaces old → pending delete
    await flushMicrotasks()

    const saving = store.saveConfig()
    await flushMicrotasks() // PUT resolved; cleanup now hangs on the DELETE
    expect(mocks.deleteAsset).toHaveBeenCalledWith('old0000000000000')
    store.updateConfig((draft) => {
      draft.global.scale = 2.2
    })
    expect(store.getSnapshot().saveState).toBe('dirty')

    resolveDelete()
    await saving
    await flushMicrotasks()
    // The edit after the PUT must not be clobbered to 'saved' — that would
    // disable the save button and drop the beforeunload guard.
    expect(store.getSnapshot().saveState).toBe('dirty')
  })

  it('removeImage during an in-flight save reports saving and is swept into the same save', async () => {
    const resolvers: Array<(config: PetweenConfig) => void> = []
    const patchConfig = vi.fn(
      () =>
        new Promise<PetweenConfig>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const { api, mocks } = makeApi({ patchConfig: patchConfig as unknown as EditorApi['patchConfig'] })
    await loadStore(api)
    await store.importImage('idle', pngFile())
    await flushMicrotasks()

    const saving = store.saveConfig()
    await flushMicrotasks() // hanging in the first PUT
    store.removeImage('idle')
    expect(store.getSnapshot().saveState).toBe('saving') // not downgraded to 'dirty'
    resolvers[0](structuredClone(store.getSnapshot().config) as PetweenConfig)
    await flushMicrotasks()
    expect(mocks.patchConfig).toHaveBeenCalledTimes(2) // latest-wins sweeps the removal
    resolvers[1](structuredClone(store.getSnapshot().config) as PetweenConfig)
    await saving
    await flushMicrotasks()
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('a rejected upload clears importing and surfaces the error notice', async () => {
    const uploadAsset = vi.fn(async () => {
      throw new Error('connection reset')
    })
    const { api } = makeApi({ uploadAsset: uploadAsset as EditorApi['uploadAsset'] })
    await loadStore(api)
    await store.importImage('idle', pngFile())
    await flushMicrotasks()
    expect(store.getSnapshot().importing).toBeNull()
    expect(store.getSnapshot().notice?.kind).toBe('error')
    expect(store.getSnapshot().notice?.text).toContain('上传失败')
  })

  it('a failed old-asset DELETE only warns and keeps the new pose reference', async () => {
    const { api, mocks } = makeApi({
      deleteAsset: vi.fn(async () => Promise.reject(new Error('io error'))),
    })
    await loadStore(api)
    const config = store.getSnapshot().config
    if (config === null) throw new Error('config missing')
    config.poses.idle.assetId = 'old0000000000000'

    await store.importImage('idle', pngFile())
    await store.saveConfig()
    await flushMicrotasks()
    expect(store.getSnapshot().config?.poses.idle.assetId).toBe('aaaa1111bbbb2222')
    expect(store.getSnapshot().notice?.kind).toBe('warn')
  })

  it('removeImage clears the pose (assetId absent in the PUT body), then deletes the file', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    const config = store.getSnapshot().config
    if (config === null) throw new Error('config missing')
    config.poses.idle.assetId = 'old0000000000000'

    await store.removeImage('idle')
    await store.saveConfig()
    await flushMicrotasks()

    const body = mocks.patchConfig.mock.calls[0][0] as ConfigPatch
    expect(body.poses !== undefined && 'assetId' in body.poses.idle).toBe(false)
    expect(mocks.deleteAsset).toHaveBeenCalledWith('old0000000000000')
    expect(store.getSnapshot().config?.poses.idle.assetId).toBeUndefined()
  })

  it('removeImage skips the file delete while another pose still references it', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    const config = store.getSnapshot().config
    if (config === null) throw new Error('config missing')
    config.poses.idle.assetId = 'shared0000000000'
    config.poses.thinking.assetId = 'shared0000000000'

    await store.removeImage('idle')
    await store.saveConfig()
    await flushMicrotasks()
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })
})

describe('EditorStore — editor/overlay ownership split (P1)', () => {
  it('a dirty save sends only the owned sections and broadcasts the host response', async () => {
    // Host stand-in: the drag save lands mid-edit, so the server-side config
    // already carries overlay (500,300) when the editor's explicit save runs.
    const serverConfig = createDefaultPetweenConfig()
    serverConfig.overlay = { x: 0, y: 0 }
    const patchConfig = vi.fn(async (patch: ConfigPatch) => {
      const merged = mergePatch(serverConfig, patch)
      serverConfig.enabled = merged.enabled
      serverConfig.global = merged.global
      serverConfig.poses = merged.poses
      serverConfig.states = merged.states
      serverConfig.advanced = merged.advanced
      return structuredClone(serverConfig)
    })
    const { api } = makeApi({ patchConfig: patchConfig as EditorApi['patchConfig'] })
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config: structuredClone(serverConfig), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    store = new EditorStore({ api, hub })
    await store.load()

    // an editor edit dirties the draft, which still holds overlay (0,0)
    store.updateConfig((draft) => {
      draft.global.transition.strength = 1.4
    })
    // mid-edit, the overlay drag save publishes its merged config: the dirty
    // draft refuses to adopt it (the existing M3 rollback guard)
    serverConfig.overlay = { x: 500, y: 300 } // the host persisted the drag patch
    hub.publish({ config: structuredClone(serverConfig), assets: {}, customs: [] })
    expect(store.getSnapshot().config?.overlay).toEqual({ x: 0, y: 0 })

    await store.saveConfig()

    // the save carries ONLY the editor-owned sections — no overlay, no version
    expect(patchConfig).toHaveBeenCalledTimes(1)
    const body = patchConfig.mock.calls[0][0] as ConfigPatch
    expect('overlay' in body).toBe(false)
    expect('version' in body).toBe(false)
    expect(body.global?.transition?.strength).toBe(1.4)
    expect(body.poses).toBeDefined()
    expect(body.states).toBeDefined()
    expect(body.advanced).toBeDefined()

    // the hub broadcasts the HOST response (merged overlay), not the payload
    expect(hub.getCurrent()?.config.overlay).toEqual({ x: 500, y: 300 })
    expect(hub.getCurrent()?.config.global.transition.strength).toBe(1.4)
    // the now-clean draft adopts the publish, so the editor overlay follows
    expect(store.getSnapshot().config?.overlay).toEqual({ x: 500, y: 300 })
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('the advanced-section toggle travels in the explicit patch', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.advanced.changePoseWithinActive = true
    })
    await store.saveConfig()
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    const body = mocks.patchConfig.mock.calls[0][0] as ConfigPatch
    expect(body.advanced).toEqual({
      changePoseWithinActive: true,
      activityTransition: 'subtle',
      terminalHold: 'timed',
      particles: true,
    })
    // the host-merged response is adopted back into the draft
    expect(store.getSnapshot().config?.advanced.changePoseWithinActive).toBe(true)
    expect(store.getSnapshot().saveState).toBe('saved')
  })
})


describe('EditorStore — revertConfig (UX: discard unsaved edits)', () => {
  it('restores the saved config, drops pending asset deletes and keeps selection/customs', async () => {
    const custom: AnimationDefinition = {
      version: 1,
      id: 'user:a',
      name: 'Custom A',
      kind: 'interaction',
      durationMs: 300,
      repeat: { mode: 'once' },
      tracks: [
        { property: 'transition.rotation', keyframes: [{ at: 0, value: 0 }, { at: 1, value: 12 }] },
      ],
    }
    const { api, mocks } = makeApi({
      getAnimations: vi.fn(async () => ({ customs: [custom], warnings: [] as string[], normalized: [] as string[] })),
    })
    await loadStore(api)
    store.selectState('thinking')
    store.updateConfig((draft) => {
      draft.poses.idle.assetId = 'old0000000000000'
      draft.global.scale = 1.9
    })
    await store.removeImage('idle') // queues the replaced file for deletion
    store.updateConfig((draft) => {
      draft.global.scale = 2.5
    })
    expect(store.getSnapshot().saveState).toBe('dirty')

    await store.revertConfig()
    await flushMicrotasks()

    const snapshot = store.getSnapshot()
    expect(snapshot.saveState).toBe('idle')
    expect(snapshot.config?.global.scale).toBe(1) // default again
    expect(snapshot.config?.poses.idle.assetId).toBeUndefined()
    expect(snapshot.selectedState).toBe('thinking') // the editor selection survives
    expect(snapshot.customs.map((entry) => entry.id)).toEqual(['user:a']) // explicit-save data survives
    expect(snapshot.notice?.kind).toBe('info')
    expect(snapshot.notice?.text).toContain('已撤回')

    // clean now: saving is a no-op and the replaced file is never deleted
    await store.saveConfig()
    await flushMicrotasks()
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })

  it('awaits an in-flight save, then reverts to the server state', async () => {
    const resolvers: Array<(config: PetweenConfig) => void> = []
    const patchConfig = vi.fn(
      (patch: ConfigPatch) =>
        new Promise<PetweenConfig>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const { api, mocks } = makeApi({ patchConfig: patchConfig as EditorApi['patchConfig'] })
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.7
    })
    const saving = store.saveConfig()
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(1) // PUT in flight

    const reverting = store.revertConfig()
    await flushMicrotasks()
    expect(mocks.getConfig).toHaveBeenCalledTimes(1) // only the initial load — revert waits

    resolvers[0](mergePatch(createDefaultPetweenConfig(), { global: { scale: 1.7 } }))
    await reverting
    await saving
    await flushMicrotasks()
    expect(mocks.getConfig).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().saveState).toBe('idle')
    expect(store.getSnapshot().config?.global.scale).toBe(1)
  })

  it('a failed GET keeps the dirty draft and notices', async () => {
    let calls = 0
    const getConfig = vi.fn(async () => {
      calls += 1
      if (calls === 1) return { config: createDefaultPetweenConfig(), assets: {} }
      throw new Error('network down')
    })
    const { api } = makeApi({ getConfig })
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.9
    })
    await store.revertConfig()
    expect(store.getSnapshot().saveState).toBe('dirty')
    expect(store.getSnapshot().config?.global.scale).toBe(1.9)
    expect(store.getSnapshot().notice?.kind).toBe('error')
    expect(store.getSnapshot().notice?.text).toContain('撤回失败')
  })

  it('a save queued during the revert fetch aborts the revert', async () => {
    let releaseGet!: (value: { config: PetweenConfig; assets: Record<string, AssetMeta> }) => void
    let calls = 0
    const getConfig = vi.fn(async () => {
      calls += 1
      if (calls === 1) return { config: createDefaultPetweenConfig(), assets: {} as Record<string, AssetMeta> }
      return new Promise<{ config: PetweenConfig; assets: Record<string, AssetMeta> }>((resolve) => {
        releaseGet = resolve
      })
    })
    const { api, mocks } = makeApi({ getConfig })
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.9
    })
    const reverting = store.revertConfig()
    await flushMicrotasks()
    // the user hits Save while the revert's GET is still in flight
    void store.saveConfig()
    releaseGet({ config: createDefaultPetweenConfig(), assets: {} })
    await reverting
    await flushMicrotasks()
    expect(store.getSnapshot().config?.global.scale).toBe(1.9) // draft untouched
    expect(store.getSnapshot().notice?.text).toContain('已取消撤回')
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1) // the save went through
  })
})


describe('EditorStore — custom animations (V1.1, explicit save)', () => {
  const makeCustom = (id: string, name = `Custom ${id}`): AnimationDefinition => ({
    version: 1,
    id,
    name,
    kind: 'interaction',
    durationMs: 300,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.rotation',
        keyframes: [
          { at: 0, value: 0 },
          { at: 1, value: 12 },
        ],
      },
    ],
  })

  it('load carries the served customs and surfaces host scan warnings', async () => {
    const { api } = makeApi({
      getAnimations: vi.fn(async () => ({
        customs: [makeCustom('user:a')],
        warnings: ['broken.json: skipped'],
        normalized: [],
      })),
    })
    await loadStore(api)
    expect(store.getSnapshot().customs.map((custom) => custom.id)).toEqual(['user:a'])
    expect(store.getSnapshot().notice?.kind).toBe('warn')
    expect(store.getSnapshot().notice?.text).toContain('1 个自定义动画文件')
    expect(store.getSnapshot().notice?.text).toContain('已被跳过')
  })

  it('legacy-normalized animations are reported as compatibility info, never as skipped (BUG 2026-08-28)', async () => {
    // The host normalized these files and they ARE loaded — wording them
    // "损坏或不合法，已被跳过" made users believe working animations were lost.
    const { api } = makeApi({
      getAnimations: vi.fn(async () => ({
        customs: [makeCustom('user:a'), makeCustom('user:b')],
        warnings: [],
        normalized: [
          'user_a.json: legacy shape auto-normalized',
          'user_b.json: legacy shape auto-normalized',
        ],
      })),
    })
    await loadStore(api)
    expect(store.getSnapshot().customs).toHaveLength(2)
    const notice = store.getSnapshot().notice
    expect(notice?.kind).toBe('info')
    expect(notice?.text).toContain('2 个自定义动画为旧版格式')
    expect(notice?.text).toContain('已自动兼容并正常加载')
    expect(notice?.text).not.toContain('已被跳过')
    expect(notice?.text).not.toContain('损坏')
  })

  it('saveAnimation validates client-side: an invalid definition never hits the API', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    const ok = await store.saveAnimation({ ...makeCustom('user:bad'), name: '' })
    expect(ok).toBe(false)
    expect(mocks.putAnimation).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.kind).toBe('error')
    expect(store.getSnapshot().notice?.text).toContain('不合法')
    expect(store.getSnapshot().customs).toHaveLength(0)
  })

  it('saveAnimation PUTs, upserts the list and broadcasts through the hub (no debounce)', async () => {
    const { api, mocks } = makeApi()
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config: createDefaultPetweenConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    store = new EditorStore({ api, hub })
    await store.load()
    const seen: ConfigSnapshot[] = []
    hub.subscribe((snapshot) => seen.push(snapshot))

    // no debounce: the PUT fires without any timer advancing
    const ok = await store.saveAnimation(makeCustom('user:a'))
    expect(ok).toBe(true)
    expect(mocks.putAnimation).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().customs.map((custom) => custom.id)).toEqual(['user:a'])
    expect(hub.getCurrent()?.customs.map((custom) => custom.id)).toEqual(['user:a'])
    expect(seen).toHaveLength(1)
    expect(mocks.patchConfig).not.toHaveBeenCalled() // the config draft is untouched

    // a rename replaces in place and broadcasts again
    await store.saveAnimation(makeCustom('user:a', '改名'))
    expect(store.getSnapshot().customs).toHaveLength(1)
    expect(store.getSnapshot().customs[0].name).toBe('改名')
    expect(seen).toHaveLength(2)
  })

  it('saveAnimation surfaces an API rejection as a notice and keeps the list', async () => {
    const { api } = makeApi({
      putAnimation: vi.fn(async () => {
        throw new ApiError(400, 'INVALID_ANIMATION', 'invalid AnimationDefinition: "kind" …')
      }),
    })
    await loadStore(api)
    const ok = await store.saveAnimation(makeCustom('user:a'))
    expect(ok).toBe(false)
    expect(store.getSnapshot().notice?.text).toContain('动画保存失败')
    expect(store.getSnapshot().customs).toHaveLength(0)
  })

  it('transport TIMEOUT/NETWORK codes map to Chinese notices instead of the raw English message', async () => {
    const timeoutApi = makeApi({
      putAnimation: vi.fn(async () => {
        throw new ApiError(0, 'TIMEOUT', 'request timed out after 15000ms')
      }),
    })
    await loadStore(timeoutApi.api)
    await store.saveAnimation(makeCustom('user:a'))
    expect(store.getSnapshot().notice?.text).toContain('动画保存失败：请求超时，请稍后重试')

    const networkApi = makeApi({
      putAnimation: vi.fn(async () => {
        throw new ApiError(0, 'NETWORK', 'connection refused')
      }),
    })
    await loadStore(networkApi.api)
    await store.saveAnimation(makeCustom('user:a'))
    expect(store.getSnapshot().notice?.text).toContain('动画保存失败：网络连接失败，请检查网络')
  })

  it('deleteAnimation refuses while referenced — naming the state, without an API call', async () => {
    const config = createDefaultPetweenConfig()
    config.states.thinking.enter.animationId = 'user:a'
    const { api, mocks } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
    })
    await loadStore(api)
    await store.saveAnimation(makeCustom('user:a'))

    const ok = await store.deleteAnimation('user:a')
    expect(ok).toBe(false)
    expect(mocks.deleteAnimation).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.text).toContain('无法删除')
    expect(store.getSnapshot().notice?.text).toContain('思考')
    expect(store.getSnapshot().customs).toHaveLength(1) // kept
  })

  it('deleteAnimation refuses while the click interaction references it', async () => {
    const config = createDefaultPetweenConfig()
    config.interactions.click.animation = 'user:a'
    const { api, mocks } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
    })
    await loadStore(api)
    await store.saveAnimation(makeCustom('user:a'))

    const ok = await store.deleteAnimation('user:a')
    expect(ok).toBe(false)
    expect(mocks.deleteAnimation).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.text).toContain('点击互动')
  })

  it('deleteAnimation refuses while a state custom ambient references it', async () => {
    const config = createDefaultPetweenConfig()
    config.states.waiting.ambient.customAnimationId = 'user:a'
    const ambient: AnimationDefinition = {
      ...makeCustom('user:a'),
      kind: 'ambient',
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
    const { api, mocks } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
    })
    await loadStore(api)
    await store.saveAnimation(ambient)

    expect(await store.deleteAnimation('user:a')).toBe(false)
    expect(mocks.deleteAnimation).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.text).toContain('等待')
    expect(store.getSnapshot().notice?.text).toContain('循环动画')
  })

  it('deleteAnimation removes the entry and broadcasts on success', async () => {
    const { api, mocks } = makeApi()
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config: createDefaultPetweenConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    store = new EditorStore({ api, hub })
    await store.load()
    await store.saveAnimation(makeCustom('user:a'))

    const ok = await store.deleteAnimation('user:a')
    expect(ok).toBe(true)
    expect(mocks.deleteAnimation).toHaveBeenCalledWith('user:a')
    expect(store.getSnapshot().customs).toHaveLength(0)
    expect(hub.getCurrent()?.customs).toHaveLength(0)
  })

  it('a host 409 (referenced elsewhere) maps to an in-use notice', async () => {
    const { api } = makeApi({
      deleteAnimation: vi.fn(async () => {
        throw new ApiError(409, 'ANIMATION_IN_USE', 'animation is still referenced: user:a')
      }),
    })
    await loadStore(api)
    await store.saveAnimation(makeCustom('user:a'))
    const ok = await store.deleteAnimation('user:a')
    expect(ok).toBe(false)
    expect(store.getSnapshot().notice?.text).toContain('仍被配置引用')
    expect(store.getSnapshot().customs).toHaveLength(1)
  })

  it('a hub publish updates customs even while the config draft is dirty', async () => {
    const { api } = makeApi()
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config: createDefaultPetweenConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    store = new EditorStore({ api, hub })
    await store.load()

    store.updateConfig((draft) => {
      draft.global.scale = 1.7
    })
    const current = hub.getCurrent()
    if (current === null) throw new Error('hub not loaded')
    hub.publish({ config: current.config, assets: current.assets, customs: [makeCustom('user:x')] })
    // customs follow the hub; the dirty draft is not rolled back
    expect(store.getSnapshot().customs.map((custom) => custom.id)).toEqual(['user:x'])
    expect(store.getSnapshot().config?.global.scale).toBe(1.7)
  })
})

describe('EditorStore — pet presets (V1.1)', () => {
  const preset = (id: string, name: string, scale: number): PetPreset => {
    const config = createDefaultPetweenConfig()
    return {
      id,
      name,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      scale,
      poses: structuredClone(config.poses),
      states: structuredClone(config.states),
    }
  }

  it('loads pets in parallel and exposes the host active pointer', async () => {
    const pet = preset('pet_a', '蓝猫', 1.4)
    const { api } = makeApi({
      getPets: vi.fn(async () => ({ pets: [pet], activePetId: pet.id, warnings: [] })),
    })
    await loadStore(api)
    expect(store.getSnapshot().pets.map((candidate) => candidate.name)).toEqual(['蓝猫'])
    expect(store.getSnapshot().config?.activePetId).toBe('pet_a')
  })

  it('create current/blank and rename are immediate API actions followed by a list refresh', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)

    expect(await store.createPetCurrent('副本')).toBe(true)
    const id = store.getSnapshot().config?.activePetId
    expect(id).toBe('pet_1')
    expect(mocks.createPet).toHaveBeenCalledWith({ name: '副本', from: 'current' })
    expect(store.getSnapshot().pets[0].name).toBe('副本')

    expect(await store.renamePet(id ?? '', '改名')).toBe(true)
    expect(mocks.renamePet).toHaveBeenCalledWith('pet_1', '改名')
    expect(store.getSnapshot().pets[0].name).toBe('改名')

    expect(await store.createPetBlank('空白')).toBe(true)
    expect(mocks.createPet).toHaveBeenLastCalledWith({ name: '空白', from: 'blank' })
    expect(store.getSnapshot().config?.activePetId).toBe('pet_2')
    expect(store.getSnapshot().pets.map((candidate) => candidate.name)).toEqual(['改名', '空白'])
  })

  it('saveDraftAsNewPet forks the CURRENT DRAFT (unsaved edits included) without touching it (A2)', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)

    // An unsaved experiment on the draft: a scale no save ever persisted.
    store.updateConfig((draft) => {
      draft.global.scale = 2.75
    })
    expect(store.getSnapshot().saveState).toBe('dirty')

    expect(await store.saveDraftAsNewPet('变体')).toBe(true)
    // The fork carries the DRAFT values, not the server-saved ones.
    expect(mocks.createPetFromDraft).toHaveBeenCalledTimes(1)
    expect(mocks.createPetFromDraft.mock.calls[0]![0]).toBe('变体')
    expect(mocks.createPetFromDraft.mock.calls[0]![1].scale).toBe(2.75)
    // The active pointer, the local draft and its dirty state are untouched;
    // the pets list refresh is the only visible effect.
    expect(store.getSnapshot().config?.global.scale).toBe(2.75)
    expect(store.getSnapshot().config?.activePetId).toBeNull()
    expect(store.getSnapshot().saveState).toBe('dirty')
    expect(store.getSnapshot().pets.map((candidate) => candidate.name)).toEqual(['变体'])
    // the success path announces itself like every other pet action
    expect(store.getSnapshot().notice).toEqual({ kind: 'info', text: '已另存为新宠物「变体」。' })
    // The fork must not implicitly save anything.
    expect(mocks.patchConfig).not.toHaveBeenCalled()
  })

  it('saveDraftAsNewPet surfaces a host rejection as a notice and keeps the draft (A2)', async () => {
    const { api, mocks } = makeApi({
      createPetFromDraft: vi.fn(async () => {
        throw new Error('unknown custom animation: user:missing')
      }),
    })
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 2.75
    })
    expect(await store.saveDraftAsNewPet('变体')).toBe(false)
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'error' })
    expect(store.getSnapshot().saveState).toBe('dirty')
    expect(store.getSnapshot().config?.global.scale).toBe(2.75)
    expect(mocks.getPets).toHaveBeenCalledTimes(1) // no refresh after a failure
  })

  it('apply replaces the draft with the host config and publishes it through the hub', async () => {
    const targetPet = preset('pet_target', '目标', 2.25)
    const targetConfig = createDefaultPetweenConfig()
    targetConfig.activePetId = targetPet.id
    targetConfig.global.scale = targetPet.scale
    const { api, mocks } = makeApi({
      getPets: vi.fn(async () => ({ pets: [targetPet], activePetId: targetPet.id, warnings: [] })),
      applyPet: vi.fn(async () => structuredClone(targetConfig)),
    })
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config: createDefaultPetweenConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    store = new EditorStore({ api, hub })
    await store.load()

    // Force a different local selection so apply is not treated as a no-op.
    const current = store.getSnapshot().config
    if (current === null) throw new Error('config missing')
    current.activePetId = null
    expect(await store.applyPet(targetPet.id)).toBe(true)

    expect(mocks.applyPet).toHaveBeenCalledWith(targetPet.id)
    expect(store.getSnapshot().config?.global.scale).toBe(2.25)
    expect(hub.getCurrent()?.config.activePetId).toBe(targetPet.id)
    expect(hub.getCurrent()?.config.global.scale).toBe(2.25)
  })

  it('deleting the ACTIVE pet surfaces the host 409 as a friendly notice (C5)', async () => {
    const active = preset('pet_active', '当前', 1.8)
    const config = createDefaultPetweenConfig()
    config.activePetId = active.id
    config.global.scale = active.scale
    const { api } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
      getPets: vi.fn(async () => ({ pets: [active], activePetId: active.id, warnings: [] })),
      deletePet: vi.fn(async () => {
        // C5 方案 a: the host refuses to delete the active pet.
        throw new ApiError(409, 'ACTIVE_PET', 'ACTIVE_PET')
      }),
    })
    await loadStore(api)

    expect(await store.deletePet(active.id)).toBe(false)
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'error' })
    expect(store.getSnapshot().notice?.text).toContain('生效中的宠物不能删除')
    // nothing was deleted or re-pointed: the preset list and config survive
    expect(store.getSnapshot().pets.map((candidate) => candidate.id)).toEqual([active.id])
    expect(store.getSnapshot().config?.activePetId).toBe(active.id)
    expect(store.getSnapshot().config?.global.scale).toBe(1.8)
  })

  it('blocks pet switching while config changes are unsaved', async () => {
    const target = preset('pet_target', '目标', 1)
    const switched = createDefaultPetweenConfig()
    switched.activePetId = target.id
    const { api, mocks } = makeApi({
      getPets: vi.fn(async () => ({ pets: [target], activePetId: target.id, warnings: [] })),
      applyPet: vi.fn(async () => structuredClone(switched)),
    })
    await loadStore(api)
    const config = store.getSnapshot().config
    if (config === null) throw new Error('config missing')
    config.activePetId = null
    store.updateConfig((draft) => {
      draft.global.scale = 1.6
    })

    expect(await store.applyPet(target.id)).toBe(false)
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    expect(mocks.applyPet).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.text).toContain('请先点击保存')
  })

  it('rename/delete of a NON-active preset works while the draft is dirty (UX relaxation)', async () => {
    const active = preset('pet_active', '当前', 1)
    const other = preset('pet_other', '备用', 1.2)
    const config = createDefaultPetweenConfig()
    config.activePetId = active.id
    const { api, mocks } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
      getPets: vi.fn(async () => ({ pets: [active, other], activePetId: active.id, warnings: [] })),
    })
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.6 // dirty — must not block non-active identity ops
    })

    expect(await store.renamePet(other.id, '改名备用')).toBe(true)
    expect(mocks.renamePet).toHaveBeenCalledWith(other.id, '改名备用')
    expect(await store.deletePet(other.id)).toBe(true)
    expect(mocks.deletePet).toHaveBeenCalledWith(other.id)
    // the dirty draft is untouched by both operations
    expect(store.getSnapshot().config?.global.scale).toBe(1.6)
    expect(store.getSnapshot().saveState).toBe('dirty')
    expect(mocks.patchConfig).not.toHaveBeenCalled()

    // the ACTIVE pet still refuses while dirty
    expect(await store.renamePet(active.id, '改名当前')).toBe(false)
    expect(mocks.renamePet).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().notice?.text).toContain('请先点击保存')
  })

  it('a failed save blocks pet actions with an explicit notice instead of silence', async () => {
    const active = preset('pet_active', '当前', 1)
    const other = preset('pet_other', '备用', 1.2)
    const config = createDefaultPetweenConfig()
    config.activePetId = active.id
    const { api, mocks } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
      getPets: vi.fn(async () => ({ pets: [active, other], activePetId: active.id, warnings: [] })),
      patchConfig: vi.fn(async () => {
        throw new Error('disk full')
      }),
    })
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.6
    })
    await store.saveConfig()
    expect(store.getSnapshot().saveState).toBe('error')

    // the ACTIVE pet still refuses (a failed save keeps the draft dirty,
    // so the clean-draft gate fires with its own notice)
    expect(await store.renamePet(active.id, '改名当前')).toBe(false)
    expect(mocks.renamePet).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice?.text).toContain('请先点击保存')
    // a NON-active target never touches the draft, so a failed save does not block it
    expect(await store.renamePet(other.id, '改名备用')).toBe(true)
    expect(mocks.renamePet).toHaveBeenCalledWith(other.id, '改名备用')
  })
})


describe('hasAnyUsableImage (§2.1)', () => {  it('is false for a fresh config and true once a pose references a known asset', () => {
    const config = createDefaultPetweenConfig()
    expect(hasAnyUsableImage(config, {})).toBe(false)
    config.poses.idle.assetId = 'aaaa1111bbbb2222'
    expect(hasAnyUsableImage(config, {})).toBe(false) // dangling reference
    expect(
      hasAnyUsableImage(config, {
        aaaa1111bbbb2222: {
          id: 'aaaa1111bbbb2222',
          fileName: 'pet.png',
          mimeType: 'image/png',
          width: 240,
          height: 240,
          sizeBytes: 10,
          sha256: 'x',
          url: '/petween-assets/aaaa1111bbbb2222',
        },
      }),
    ).toBe(true)
  })
})

describe('EditorStore — Motion Pack import/export (P2)', () => {
  const packCustom = (id: string): AnimationDefinition => ({
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'interaction',
    durationMs: 200,
    repeat: { mode: 'once' },
    tracks: [
      { property: 'transition.rotation', keyframes: [{ at: 0, value: 0 }, { at: 1, value: 12 }] },
    ],
  })

  it('importPack sends the file text, refreshes the customs and summarizes the outcome', async () => {
    const { api, mocks } = makeApi({
      importMotionPack: vi.fn(async () => ({
        name: '弹跳包',
        namespace: 'manga',
        entries: [
          { requestedId: 'manga:pop', finalId: 'manga:pop', status: 'imported' as const },
          { requestedId: 'manga:pop', finalId: 'manga:pop-2', status: 'remapped' as const },
        ],
        mounts: {},
        warnings: [],
      })),
      getAnimations: vi.fn(async () => ({ customs: [packCustom('manga:pop'), packCustom('manga:pop-2')], warnings: [], normalized: [] })),
    })
    await loadStore(api)
    const file = new File([JSON.stringify({ format: 'motion-pack' })], 'pack.json', { type: 'application/json' })
    expect(await store.importPack(file)).toBe(true)
    expect(mocks.importMotionPack).toHaveBeenCalledWith(JSON.stringify({ format: 'motion-pack' }))
    expect(store.getSnapshot().customs.map((custom) => custom.id)).toEqual(['manga:pop', 'manga:pop-2'])
    const notice = store.getSnapshot().notice
    expect(notice?.kind).toBe('warn') // a remap is worth the user's attention
    expect(notice?.text).toContain('弹跳包')
    expect(notice?.text).toContain('manga:pop → manga:pop-2')
  })

  it('importPack failure surfaces the host error and keeps the library untouched', async () => {
    const { api } = makeApi({
      importMotionPack: vi.fn(async () => {
        throw new ApiError(400, 'PACK_INVALID', 'invalid Motion Pack')
      }),
    })
    await loadStore(api)
    expect(await store.importPack(new File(['{}'], 'p.json'))).toBe(false)
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'error' })
    expect(store.getSnapshot().customs).toEqual([])
  })

  it('importPack with mounts keeps them pending; applyPendingMounts merges the draft and clears', async () => {
    const applyPatch = { states: { idle: { ambient: { customAnimationId: 'manga:sway' } } } }
    const { api } = makeApi({
      importMotionPack: vi.fn(async () => ({
        name: '挂载包',
        namespace: 'manga',
        entries: [{ requestedId: 'manga:sway', finalId: 'manga:sway', status: 'imported' as const }],
        mounts: { idle: { ambient: 'manga:sway' } },
        warnings: [],
        applyPatch,
      })),
      getAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    await loadStore(api)
    expect(await store.importPack(new File(['{}'], 'p.json'))).toBe(true)
    expect(store.getSnapshot().pendingMounts).toEqual({
      packName: '挂载包',
      mounts: { idle: { ambient: 'manga:sway' } },
      applyPatch,
    })
    expect(store.getSnapshot().notice?.text).toContain('挂载建议')

    store.applyPendingMounts()
    const snap = store.getSnapshot()
    expect(snap.pendingMounts).toBeNull()
    expect(snap.config?.states.idle.ambient.customAnimationId).toBe('manga:sway')
    expect(snap.saveState).toBe('dirty') // §11: applied into the DRAFT, saved explicitly
    expect(snap.notice?.text).toContain('保存修改')
  })

  it('dismissPendingMounts drops the banner without touching the draft', async () => {
    const { api } = makeApi({
      importMotionPack: vi.fn(async () => ({
        name: '挂载包',
        namespace: 'manga',
        entries: [],
        mounts: { idle: { ambient: 'manga:sway' } },
        warnings: [],
        applyPatch: { states: { idle: { ambient: { customAnimationId: 'manga:sway' } } } },
      })),
      getAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    await loadStore(api)
    await store.importPack(new File(['{}'], 'p.json'))
    expect(store.getSnapshot().pendingMounts).not.toBeNull()
    store.dismissPendingMounts()
    expect(store.getSnapshot().pendingMounts).toBeNull()
    expect(store.getSnapshot().config?.states.idle.ambient.customAnimationId).toBeUndefined()
    expect(store.getSnapshot().saveState).toBe('idle')
  })

  it('exportPack without customs is a no-op warning', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    expect(await store.exportPack()).toBe(false)
    expect(mocks.exportMotionPack).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'warn' })
  })
})

describe('EditorStore — pet package import/export (§12)', () => {
  const preset = (id: string, name: string, scale = 1): PetPreset => {
    const config = createDefaultPetweenConfig()
    return {
      id,
      name,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      scale,
      poses: structuredClone(config.poses),
      states: structuredClone(config.states),
    }
  }

  it('exportPetPackage refuses an unsaved config with a warn notice', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    expect(await store.exportPetPackage()).toBe(false)
    expect(mocks.exportPetPackage).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'warn' })
    expect(store.getSnapshot().notice?.text).toContain('选中一只宠物')
  })

  it('exportPetPackage downloads the active pet as pet-<name>.zip', async () => {
    const pet = preset('pet_a', '蓝猫')
    const { api, mocks } = makeApi({
      getPets: vi.fn(async () => ({ pets: [structuredClone(pet)], activePetId: pet.id, warnings: [] })),
      exportPetPackage: vi.fn(async () => new ArrayBuffer(8)),
    })
    await loadStore(api)
    // Node test env: the store's download guards probe URL.createObjectURL
    // and document, both absent — stub minimal stand-ins like the UI tests do.
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const downloads: string[] = []
    const anchor = {
      href: '',
      download: '',
      click(this: { download: string }): void {
        downloads.push(this.download)
      },
    }
    vi.stubGlobal('document', { createElement: () => anchor })
    try {
      expect(await store.exportPetPackage()).toBe(true)
      expect(mocks.exportPetPackage).toHaveBeenCalledWith('pet_a')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(downloads).toEqual(['pet-蓝猫.zip'])
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
      expect(store.getSnapshot().notice).toMatchObject({ kind: 'info', text: '已导出宠物包「蓝猫」。' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exportPetPackage surfaces a host rejection as an error notice', async () => {
    const pet = preset('pet_a', '蓝猫')
    const { api } = makeApi({
      getPets: vi.fn(async () => ({ pets: [structuredClone(pet)], activePetId: pet.id, warnings: [] })),
      exportPetPackage: vi.fn(async () => {
        throw new ApiError(400, 'PET_INCOMPLETE', 'pose asset aaaa1111bbbb2222 is missing')
      }),
    })
    await loadStore(api)
    expect(await store.exportPetPackage()).toBe(false)
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'error' })
    expect(store.getSnapshot().notice?.text).toContain('导出宠物包失败')
  })

  it('importPetPackage sends the zip bytes, fully reloads and summarizes the report', async () => {
    const importedPet: PetPreset = {
      ...preset('pet_new', '鲸鱼娘'),
      attribution: { character: 'DeepSeek 女仆鲸鱼娘（溟月）', license: 'CC BY-NC-SA 4.0' },
    }
    const switched = createDefaultPetweenConfig()
    switched.activePetId = 'pet_new'
    let imported = false
    const { api, mocks } = makeApi({
      getPets: vi.fn(async () =>
        imported
          ? { pets: [structuredClone(importedPet)], activePetId: importedPet.id, warnings: [] }
          : { pets: [], activePetId: null, warnings: [] },
      ),
      getConfig: vi.fn(async () => ({
        config: structuredClone(imported ? switched : createDefaultPetweenConfig()),
        assets: {},
      })),
      importPetPackage: vi.fn(async (): Promise<PetPackageImportResponse> => {
        imported = true
        return {
          pet: structuredClone(importedPet),
          config: structuredClone(switched),
          report: {
            assetsAdded: ['aaaa1111bbbb2222', 'cccc3333dddd4444'],
            assetsReused: ['eeee5555ffff6666'],
            entries: [
              { requestedId: 'manga:pop', finalId: 'manga:pop', status: 'imported' as const },
              { requestedId: 'manga:sway', finalId: 'manga:sway', status: 'identical' as const },
              { requestedId: 'manga:y', finalId: 'manga:y-2', status: 'remapped' as const },
            ],
            mounts: { idle: { ambient: 'manga:sway' } },
            warnings: ['1 个未被引用的图片清单条目已忽略'],
          },
        }
      }),
    })
    await loadStore(api)
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'pet.zip', { type: 'application/zip' })
    expect(await store.importPetPackage(file)).toBe(true)
    expect(mocks.importPetPackage).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(mocks.importPetPackage.mock.calls[0]![0] as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    )
    // The store reloaded EVERYTHING (config + customs + pets), not a partial refresh.
    expect(mocks.getConfig).toHaveBeenCalledTimes(2)
    expect(mocks.getAnimations).toHaveBeenCalledTimes(2)
    expect(mocks.getPets).toHaveBeenCalledTimes(2)
    const snap = store.getSnapshot()
    expect(snap.config?.activePetId).toBe('pet_new')
    expect(snap.pets.map((candidate) => candidate.name)).toEqual(['鲸鱼娘'])
    expect(snap.pets[0]?.attribution?.character).toBe('DeepSeek 女仆鲸鱼娘（溟月）')
    const notice = snap.notice
    expect(notice).toBeDefined()
    expect(notice?.kind).toBe('warn') // a remap and a warning are worth attention
    expect(notice?.text).toContain('已导入宠物「鲸鱼娘」并切换')
    expect(notice?.text).toContain('图片 新增2/复用1')
    expect(notice?.text).toContain('动画 新增1/相同1/改号1')
    expect(notice?.text).toContain('manga:y → manga:y-2')
    expect(notice?.text).toContain('未被引用的图片清单条目')
  })

  it('importPetPackage rejects a bad package with an error notice and no reload', async () => {
    const { api, mocks } = makeApi({
      importPetPackage: vi.fn(async () => {
        throw new ApiError(400, 'PACK_INVALID', 'zip entry count exceeds 64')
      }),
    })
    await loadStore(api)
    const file = new File([new Uint8Array([1])], 'pet.zip', { type: 'application/zip' })
    expect(await store.importPetPackage(file)).toBe(false)
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'error' })
    expect(store.getSnapshot().notice?.text).toContain('导入宠物包失败')
    expect(mocks.getConfig).toHaveBeenCalledTimes(1) // no reload after a failure
  })

  it('importPetPackage asks before discarding a dirty draft; declining aborts before any request', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 2
    })
    // No ModalHost can be mounted in this (node) environment: the C2 dialog
    // queue settles the discard confirm with the cancel answer — a draft is
    // never dropped on an unanswered confirmation. The UI-driven accept
    // branch lives in petween-settings.test.tsx.
    expect(await store.importPetPackage(new File([new Uint8Array([1])], 'p.zip'))).toBe(false)
    expect(mocks.importPetPackage).not.toHaveBeenCalled()
    expect(mocks.getConfig).toHaveBeenCalledTimes(1) // no reload happened
    // The declined import leaves the dirty draft exactly as it was.
    expect(store.getSnapshot().config?.global.scale).toBe(2)
    expect(store.getSnapshot().saveState).toBe('dirty')
  })

  // The accept branch of the dirty-draft discard confirm moved to
  // petween-settings.test.tsx: with no ModalHost mountable in this node
  // environment the C2 dialog queue can only settle as a decline.

  it('savePetAttribution writes credit onto the active pet and refreshes the list', async () => {
    const pet = preset('pet_a', '蓝猫')
    const attribution: PetAttribution = { character: '溟月', creators: ['上善无形'], license: 'CC0' }
    let pets = [structuredClone(pet)]
    const { api, mocks } = makeApi({
      getPets: vi.fn(async () => ({ pets: structuredClone(pets), activePetId: pet.id, warnings: [] })),
      updatePetMeta: vi.fn(async () => {
        pets = [{ ...pet, attribution: structuredClone(attribution) }]
      }),
    })
    await loadStore(api)
    expect(await store.savePetAttribution(attribution)).toBe(true)
    expect(mocks.updatePetMeta).toHaveBeenCalledWith('pet_a', { attribution })
    expect(store.getSnapshot().pets[0]?.attribution).toEqual(attribution)
    expect(store.getSnapshot().notice?.text).toContain('署名已保存')
  })

  it('savePetAttribution refuses an unsaved config', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    expect(await store.savePetAttribution(null)).toBe(false)
    expect(mocks.updatePetMeta).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice).toMatchObject({ kind: 'warn' })
  })
})
