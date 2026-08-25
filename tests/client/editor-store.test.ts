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
import { ApiError, type ConfigPatch, type UploadedAsset } from '../../src/client/api'
import { ConfigHub, type ConfigSnapshot } from '../../src/client/config-hub'
import {
  EditorStore,
  hasAnyUsableImage,
  type EditorApi,
} from '../../src/client/stores/editor-store'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetweenConfig, PetPreset } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

interface ApiMocks {
  getConfig: ReturnType<typeof vi.fn>
  getAnimations: ReturnType<typeof vi.fn>
  getPets: ReturnType<typeof vi.fn>
  createPet: ReturnType<typeof vi.fn>
  renamePet: ReturnType<typeof vi.fn>
  deletePet: ReturnType<typeof vi.fn>
  applyPet: ReturnType<typeof vi.fn>
  patchConfig: ReturnType<typeof vi.fn>
  putAnimation: ReturnType<typeof vi.fn>
  deleteAnimation: ReturnType<typeof vi.fn>
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
    getAnimations: vi.fn(async () => ({ customs: structuredClone(serverCustoms), warnings: [] as string[] })),
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
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
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
      getAnimations: vi.fn(async () => ({ customs: [custom], warnings: [] as string[] })),
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
      getAnimations: vi.fn(async () => ({ customs: [makeCustom('user:a')], warnings: ['broken.json: skipped'] })),
    })
    await loadStore(api)
    expect(store.getSnapshot().customs.map((custom) => custom.id)).toEqual(['user:a'])
    expect(store.getSnapshot().notice?.kind).toBe('warn')
    expect(store.getSnapshot().notice?.text).toContain('1 个自定义动画文件')
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
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
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
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
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
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
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
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
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

  it('deleting the active preset keeps the current character and shows it as unsaved', async () => {
    const active = preset('pet_active', '当前', 1.8)
    const config = createDefaultPetweenConfig()
    config.activePetId = active.id
    config.global.scale = active.scale
    let deleted = false
    const { api, mocks } = makeApi({
      getConfig: vi.fn(async () => ({ config: structuredClone(config), assets: {} })),
      getPets: vi.fn(async () => ({
        pets: deleted ? [] : [active],
        activePetId: deleted ? null : active.id,
        warnings: [],
      })),
      deletePet: vi.fn(async () => {
        deleted = true
      }),
    })
    await loadStore(api)

    expect(await store.deletePet(active.id)).toBe(true)
    expect(mocks.deletePet).toHaveBeenCalledWith(active.id)
    expect(store.getSnapshot().pets).toEqual([])
    expect(store.getSnapshot().config?.activePetId).toBeNull()
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
