// @vitest-environment jsdom
/**
 * ConfigHub tests (M3): the single-GET cache, publish/subscribe broadcast,
 * poll diff detection with the §23 hidden-tab policy, and the EditorStore
 * integration — dirty drafts ignore publishes, successful saves broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPatch, GetConfigResponse } from '../../src/client/api'
import { ConfigHub, type ConfigSnapshot } from '../../src/client/config-hub'
import { EditorStore, type EditorApi } from '../../src/client/stores/editor-store'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { AssetMeta, MotionPetConfig } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

const DEBOUNCE_MS = 300

const asset = (id: string): AssetMeta => ({
  id,
  fileName: `${id}.webp`,
  mimeType: 'image/webp',
  width: 240,
  height: 240,
  sizeBytes: 1,
  sha256: `sha-${id}`,
  url: `/motion-pet-assets/${id}.webp`,
})

const makeCustom = (id: string, name = id): AnimationDefinition => ({
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

const makeSnapshot = (mutate?: (config: MotionPetConfig) => void, customs: AnimationDefinition[] = []): ConfigSnapshot => {
  const config = createDefaultMotionPetConfig()
  config.poses.idle.assetId = 'idle-asset'
  const assets = { 'idle-asset': asset('idle-asset') }
  mutate?.(config)
  return { config, assets, customs }
}

/** Fresh objects per call, like a real GET. */
const fetcherFor = (snapshot: ConfigSnapshot) =>
  vi.fn(async () => ({ config: structuredClone(snapshot.config), assets: { ...snapshot.assets } }))

/** The animations endpoint companion; tests pass customs through the options. */
const animationsFetcherFor = (customs: AnimationDefinition[] = [], warnings: string[] = []) =>
  vi.fn(async () => ({ customs: structuredClone(customs), warnings: [...warnings] }))

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

const setVisibility = (hidden: boolean): void => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ConfigHub — load/subscribe/publish', () => {
  it('load() performs exactly one GET and shares the cache', async () => {
    const fetchConfig = fetcherFor(makeSnapshot())
    const hub = new ConfigHub({ fetchConfig, fetchAnimations: animationsFetcherFor() })
    const [a, b] = await Promise.all([hub.load(), hub.load()])
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    await hub.load()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(a.config.enabled).toBe(true)
    expect(hub.getCurrent()?.config).toEqual(a.config)
    expect(b).toBe(a)
  })

  it('a failed load releases the promise so a retry can succeed', async () => {
    const snapshot = makeSnapshot()
    const fetchConfig = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementation(async () => ({ config: structuredClone(snapshot.config), assets: snapshot.assets }))
    const hub = new ConfigHub({ fetchConfig, fetchAnimations: animationsFetcherFor() })
    await expect(hub.load()).rejects.toThrow('down')
    await expect(hub.load()).resolves.toBeDefined()
    expect(fetchConfig).toHaveBeenCalledTimes(2)
  })

  it('publish broadcasts to subscribers and clones the snapshot', async () => {
    const hub = new ConfigHub({ fetchConfig: fetcherFor(makeSnapshot()), fetchAnimations: animationsFetcherFor() })
    await hub.load()
    const seen: ConfigSnapshot[] = []
    const unsubscribe = hub.subscribe((snapshot) => seen.push(snapshot))

    const published = makeSnapshot((config) => {
      config.global.scale = 1.7
    })
    hub.publish(published)
    expect(seen).toHaveLength(1)
    expect(seen[0].config.global.scale).toBe(1.7)
    expect(hub.getCurrent()?.config.global.scale).toBe(1.7)

    // later mutation of the caller's object must not leak into the hub cache
    published.config.global.scale = 0.5
    expect(hub.getCurrent()?.config.global.scale).toBe(1.7)

    unsubscribe()
    hub.publish(makeSnapshot())
    expect(seen).toHaveLength(1)
  })
})

describe('ConfigHub — polling (3s, §23 visibility)', () => {
  it('polls on the interval and publishes only on a JSON diff', async () => {
    const base = makeSnapshot()
    const fetchConfig = fetcherFor(base)
    const hub = new ConfigHub({ fetchConfig, fetchAnimations: animationsFetcherFor(), pollIntervalMs: 3000 })
    await hub.load()
    const seen: ConfigSnapshot[] = []
    hub.subscribe((snapshot) => seen.push(snapshot))
    hub.startPolling()

    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchConfig).toHaveBeenCalledTimes(2) // initial load + one poll
    expect(seen).toHaveLength(0) // identical JSON → no publish

    fetchConfig.mockImplementation(async () => ({
      config: { ...structuredClone(base.config), enabled: false },
      assets: base.assets,
    }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toHaveLength(1)
    expect(seen[0].config.enabled).toBe(false)

    await vi.advanceTimersByTimeAsync(9000) // no further diff → no more publishes
    expect(seen).toHaveLength(1)
    hub.stopPolling()
  })

  it('drops a poll result that was in flight when a local publish landed', async () => {
    const base = makeSnapshot()
    const fetchResolvers: Array<(value: GetConfigResponse) => void> = []
    const fetchConfig = vi
      .fn<() => Promise<GetConfigResponse>>()
      .mockImplementationOnce(async () => ({ config: structuredClone(base.config), assets: { ...base.assets } }))
      .mockImplementation(
        () =>
          new Promise<GetConfigResponse>((resolve) => {
            fetchResolvers.push(resolve)
          }),
      )
    const hub = new ConfigHub({ fetchConfig, fetchAnimations: animationsFetcherFor(), pollIntervalMs: 3000 })
    await hub.load()
    const seen: ConfigSnapshot[] = []
    hub.subscribe((snapshot) => seen.push(snapshot))
    hub.startPolling()

    await vi.advanceTimersByTimeAsync(3000) // the poll GET is now in flight
    expect(fetchConfig).toHaveBeenCalledTimes(2)

    // a local save publishes newer state while the poll is in flight
    hub.publish(
      makeSnapshot((config) => {
        config.global.scale = 1.5
      }),
    )
    expect(hub.getCurrent()?.config.global.scale).toBe(1.5)

    // the stale poll resolves with the older server state: dropped silently
    fetchResolvers[0]?.({ config: structuredClone(base.config), assets: { ...base.assets } })
    await flushMicrotasks()
    expect(hub.getCurrent()?.config.global.scale).toBe(1.5)
    expect(seen).toHaveLength(1) // only the local publish was broadcast
    hub.stopPolling()
  })

  it('stops the timer while hidden and refetches immediately on return (§23)', async () => {
    const fetchConfig = fetcherFor(makeSnapshot())
    const hub = new ConfigHub({ fetchConfig, fetchAnimations: animationsFetcherFor(), pollIntervalMs: 3000 })
    await hub.load()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    hub.startPolling()

    setVisibility(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchConfig).toHaveBeenCalledTimes(1) // no polling while hidden

    setVisibility(false)
    await flushMicrotasks()
    expect(fetchConfig).toHaveBeenCalledTimes(2) // immediate refetch on return
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchConfig).toHaveBeenCalledTimes(3) // interval resumed
    hub.stopPolling()
    setVisibility(false)
  })

  it('stopPolling cancels the timer for good', async () => {
    const fetchConfig = fetcherFor(makeSnapshot())
    const hub = new ConfigHub({ fetchConfig, fetchAnimations: animationsFetcherFor(), pollIntervalMs: 3000 })
    await hub.load()
    hub.startPolling()
    hub.stopPolling()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })
})

describe('ConfigHub ↔ EditorStore (M3 shared config)', () => {
  const makeEditorApi = (base: MotionPetConfig): { api: EditorApi; patchConfig: ReturnType<typeof vi.fn> } => {
    // Host stand-in: merge the patch onto the base, resolve the full config.
    const patchConfig = vi.fn(async (patch: ConfigPatch) => ({
      ...structuredClone(base),
      enabled: patch.enabled ?? base.enabled,
      global: { ...structuredClone(base.global), ...patch.global },
      poses: patch.poses ?? structuredClone(base.poses),
      states: patch.states ?? structuredClone(base.states),
    }))
    return {
      patchConfig,
      api: {
        getConfig: vi.fn(async () => {
          throw new Error('getConfig must not be called when a hub is present')
        }),
        getAnimations: vi.fn(async () => {
          throw new Error('getAnimations must not be called when a hub is present')
        }),
        patchConfig: patchConfig as EditorApi['patchConfig'],
        putAnimation: vi.fn(),
        deleteAnimation: vi.fn(),
        uploadAsset: vi.fn(),
        deleteAsset: vi.fn(),
      },
    }
  }

  it('the editor loads through the hub cache (no second GET) and saves broadcast', async () => {
    const snapshot = makeSnapshot()
    const hub = new ConfigHub({ fetchConfig: fetcherFor(snapshot), fetchAnimations: animationsFetcherFor() })
    await hub.load()
    const broadcasts: ConfigSnapshot[] = []
    hub.subscribe((next) => broadcasts.push(next))

    const { api, patchConfig } = makeEditorApi(snapshot.config)
    const store = new EditorStore({ api, hub, debounceMs: DEBOUNCE_MS })
    await store.load()
    expect(api.getConfig).not.toHaveBeenCalled() // the hub cache served it
    expect(store.getSnapshot().status).toBe('ready')

    store.updateConfig((draft) => {
      draft.global.scale = 1.4
    })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await flushMicrotasks()
    expect(patchConfig).toHaveBeenCalledTimes(1)
    // the save broadcast reached other hub subscribers (the overlay)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].config.global.scale).toBe(1.4)
    expect(hub.getCurrent()?.config.global.scale).toBe(1.4)
    store.dispose()
  })

  it('a clean editor adopts publishes; a dirty editor ignores them (no rollback)', async () => {
    const snapshot = makeSnapshot()
    const hub = new ConfigHub({ fetchConfig: fetcherFor(snapshot), fetchAnimations: animationsFetcherFor() })
    await hub.load()
    const { api } = makeEditorApi(snapshot.config)
    const store = new EditorStore({ api, hub, debounceMs: DEBOUNCE_MS })
    await store.load()
    const revision = store.getSnapshot().configRevision

    // clean: an external publish (overlay drag save) is adopted
    hub.publish(
      makeSnapshot((config) => {
        config.overlay = { x: 120, y: 200 }
      }),
    )
    expect(store.getSnapshot().config?.overlay).toEqual({ x: 120, y: 200 })
    expect(store.getSnapshot().configRevision).toBe(revision + 1)

    // dirty: a poll publish must not roll back the user's unsaved edit
    store.updateConfig((draft) => {
      draft.global.scale = 1.9
    })
    hub.publish(
      makeSnapshot((config) => {
        config.global.scale = 0.6
      }),
    )
    expect(store.getSnapshot().config?.global.scale).toBe(1.9)

    // once the save lands, the editor's own broadcast wins the hub
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await flushMicrotasks()
    expect(hub.getCurrent()?.config.global.scale).toBe(1.9)
    store.dispose()
  })
})

describe('ConfigHub — custom animations (V1.1)', () => {
  it('load() fetches config + animations in parallel and carries customs + warnings', async () => {
    const customs = [makeCustom('user:one')]
    const fetchConfig = fetcherFor(makeSnapshot())
    const fetchAnimations = animationsFetcherFor(customs, ['broken.json: skipped'])
    const hub = new ConfigHub({ fetchConfig, fetchAnimations })

    const snapshot = await hub.load()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(fetchAnimations).toHaveBeenCalledTimes(1)
    expect(snapshot.customs).toEqual(customs)
    expect(hub.getAnimationWarnings()).toEqual(['broken.json: skipped'])
  })

  it('a failed animations GET fails the load (and a retry can succeed)', async () => {
    const fetchConfig = fetcherFor(makeSnapshot())
    const fetchAnimations = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('animations down')))
      .mockImplementation(async () => ({ customs: [], warnings: [] }))
    const hub = new ConfigHub({ fetchConfig, fetchAnimations })
    await expect(hub.load()).rejects.toThrow('animations down')
    await expect(hub.load()).resolves.toBeDefined()
  })

  it('publish broadcasts customs and clones them', async () => {
    const hub = new ConfigHub({ fetchConfig: fetcherFor(makeSnapshot()), fetchAnimations: animationsFetcherFor() })
    await hub.load()
    const seen: ConfigSnapshot[] = []
    hub.subscribe((snapshot) => seen.push(snapshot))

    const published = makeSnapshot(undefined, [makeCustom('user:two')])
    hub.publish(published)
    expect(seen).toHaveLength(1)
    expect(seen[0].customs.map((custom) => custom.id)).toEqual(['user:two'])

    // later mutation of the caller's array must not leak into the hub cache
    published.customs[0].name = 'mutated'
    expect(hub.getCurrent()?.customs[0]?.name).toBe('user:two')
  })

  it('a poll publishes on a customs-only diff', async () => {
    const fetchConfig = fetcherFor(makeSnapshot())
    const fetchAnimations = animationsFetcherFor()
    const hub = new ConfigHub({ fetchConfig, fetchAnimations, pollIntervalMs: 3000 })
    await hub.load()
    const seen: ConfigSnapshot[] = []
    hub.subscribe((snapshot) => seen.push(snapshot))
    hub.startPolling()

    await vi.advanceTimersByTimeAsync(3000) // identical → no publish
    expect(seen).toHaveLength(0)

    fetchAnimations.mockImplementation(async () => ({ customs: [makeCustom('user:three')], warnings: [] }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toHaveLength(1)
    expect(seen[0].customs.map((custom) => custom.id)).toEqual(['user:three'])
    hub.stopPolling()
  })
})
