/**
 * EditorStore tests (spec §21, §19.4): debounce coalescing, latest-wins
 * while a PUT is in flight, the save-state machine, failure/retry, the
 * import/remove asset flows (upload → patch PUT → delete ordering), the
 * editor/overlay ownership split (P1: saves carry only the owned sections
 * and broadcast the host-merged response), and the §2.1 "at least one
 * image" gate helper. All timers are fake; the EditorApi is injected, no
 * fetch involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ConfigPatch } from '../../src/client/api'
import { ConfigHub, type ConfigSnapshot } from '../../src/client/config-hub'
import {
  EditorStore,
  hasAnyUsableImage,
  type EditorApi,
} from '../../src/client/stores/editor-store'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { MotionPetConfig } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

const DEBOUNCE_MS = 300

interface ApiMocks {
  getConfig: ReturnType<typeof vi.fn>
  getAnimations: ReturnType<typeof vi.fn>
  patchConfig: ReturnType<typeof vi.fn>
  putAnimation: ReturnType<typeof vi.fn>
  deleteAnimation: ReturnType<typeof vi.fn>
  uploadAsset: ReturnType<typeof vi.fn>
  deleteAsset: ReturnType<typeof vi.fn>
}

/** Merge a patch onto a base config the way the host does (§19.2). */
const mergePatch = (base: MotionPetConfig, patch: ConfigPatch): MotionPetConfig => ({
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
  let serverConfig = createDefaultMotionPetConfig()
  let serverCustoms: AnimationDefinition[] = []
  const mocks = {
    getConfig: vi.fn(async () => ({ config: structuredClone(serverConfig), assets: {} })),
    getAnimations: vi.fn(async () => ({ customs: structuredClone(serverCustoms), warnings: [] as string[] })),
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
    uploadAsset: vi.fn(async () => ({ id: 'aaaa1111bbbb2222', url: '/motion-pet-assets/aaaa1111bbbb2222', width: 240, height: 240 })),
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
  store = new EditorStore({ api, debounceMs: DEBOUNCE_MS })
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

describe('EditorStore — §21 debounced saving', () => {
  it('coalesces a burst of edits into one PUT carrying the latest draft', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)

    for (const scale of [1.1, 1.2, 1.3, 1.4, 1.5]) {
      store.updateConfig((draft) => {
        draft.global.scale = scale
      })
    }
    expect(store.getSnapshot().saveState).toBe('saving')
    expect(mocks.patchConfig).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect((mocks.patchConfig.mock.calls[0][0] as ConfigPatch).global?.scale).toBe(1.5)
    await flushMicrotasks()
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('latest-wins while a PUT is in flight: edits queue and flush right after', async () => {
    const resolvers: Array<(config: MotionPetConfig) => void> = []
    const patchConfig = vi.fn(
      (patch: ConfigPatch) =>
        new Promise<MotionPetConfig>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const { api } = makeApi({ patchConfig: patchConfig as EditorApi['patchConfig'] })
    await loadStore(api)

    store.updateConfig((draft) => {
      draft.global.scale = 1.2
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(patchConfig).toHaveBeenCalledTimes(1) // in flight now

    store.updateConfig((draft) => {
      draft.global.scale = 1.7
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(patchConfig).toHaveBeenCalledTimes(1) // queued behind the in-flight PUT

    resolvers[0](createDefaultMotionPetConfig())
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(2)
    expect((patchConfig.mock.calls[1][0] as ConfigPatch).global?.scale).toBe(1.7)

    resolvers[1](createDefaultMotionPetConfig())
    await flushMicrotasks()
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('a failed PUT flips saveState to error; retrySave writes again', async () => {
    const patchConfig = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')))
      .mockImplementation(async () => createDefaultMotionPetConfig())
    const { api } = makeApi({ patchConfig: patchConfig as EditorApi['patchConfig'] })
    await loadStore(api)

    store.updateConfig((draft) => {
      draft.global.scale = 1.3
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await flushMicrotasks()
    expect(store.getSnapshot().saveState).toBe('error')
    expect(store.getSnapshot().saveError).toBe('disk full')

    store.retrySave()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().saveState).toBe('saved')
  })

  it('dispose cancels the pending debounce and flushes one final write', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.global.scale = 1.9
    })
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    store.dispose()
    await flushMicrotasks()
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect((mocks.patchConfig.mock.calls[0][0] as ConfigPatch).global?.scale).toBe(1.9)
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
    expect(snapshot.assets['aaaa1111bbbb2222']?.url).toBe('/motion-pet-assets/aaaa1111bbbb2222')
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
    await flushMicrotasks()
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })
})

describe('EditorStore — editor/overlay ownership split (P1)', () => {
  it('a dirty save sends only the owned sections and broadcasts the host response', async () => {
    // Host stand-in: the drag save lands mid-edit, so the server-side config
    // already carries overlay (500,300) when the editor's debounced save runs.
    const serverConfig = createDefaultMotionPetConfig()
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
    store = new EditorStore({ api, hub, debounceMs: DEBOUNCE_MS })
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

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await flushMicrotasks()

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

  it('the advanced-section toggle travels in the debounced patch', async () => {
    const { api, mocks } = makeApi()
    await loadStore(api)
    store.updateConfig((draft) => {
      draft.advanced.changePoseWithinActive = true
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await flushMicrotasks()
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
      fetchConfig: vi.fn(async () => ({ config: createDefaultMotionPetConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
    })
    store = new EditorStore({ api, hub, debounceMs: DEBOUNCE_MS })
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
    const config = createDefaultMotionPetConfig()
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
    const config = createDefaultMotionPetConfig()
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

  it('deleteAnimation removes the entry and broadcasts on success', async () => {
    const { api, mocks } = makeApi()
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config: createDefaultMotionPetConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
    })
    store = new EditorStore({ api, hub, debounceMs: DEBOUNCE_MS })
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
      fetchConfig: vi.fn(async () => ({ config: createDefaultMotionPetConfig(), assets: {} })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
    })
    store = new EditorStore({ api, hub, debounceMs: DEBOUNCE_MS })
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


describe('hasAnyUsableImage (§2.1)', () => {  it('is false for a fresh config and true once a pose references a known asset', () => {
    const config = createDefaultMotionPetConfig()
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
          url: '/motion-pet-assets/aaaa1111bbbb2222',
        },
      }),
    ).toBe(true)
  })
})
