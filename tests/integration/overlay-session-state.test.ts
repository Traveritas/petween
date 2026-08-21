// @vitest-environment jsdom
/**
 * OverlaySession ↔ DSH state source wiring (M4): the source is created only
 * once the pet is actually on stage (boot found a usable image) and the pet
 * is enabled — no SSE without an image or with enabled=false — and it is
 * torn down on dispose / on a live disable. The motion stack itself is
 * covered by dsh-flow.test.ts; here only the lifecycle contract matters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigHub } from '../../src/client/config-hub'
import { OverlaySession, type OverlayStateSourceHandle } from '../../src/client/overlay-session'
import { PetStage } from '../../src/client/overlay/pet-stage'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { AssetMeta, MotionPetConfig } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
import { installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

let harness: FakeAnimateHarness

beforeEach(() => {
  vi.useFakeTimers()
  harness = installFakeAnimate()
  vi.stubGlobal(
    'Image',
    class FakeImage {
      src = ''
      decode(): Promise<void> {
        return Promise.resolve()
      }
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  harness.restore()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const makeAsset = (id: string): AssetMeta => ({
  id,
  fileName: `${id}.webp`,
  mimeType: 'image/webp',
  width: 240,
  height: 240,
  sizeBytes: 1,
  sha256: `sha-${id}`,
  url: `https://example.test/${id}.webp`,
})

interface Setup {
  session: OverlaySession
  hub: ConfigHub
  config: MotionPetConfig
  assets: Record<string, AssetMeta>
  factory: ReturnType<typeof vi.fn>
  handles: OverlayStateSourceHandle[]
}

const setup = (options?: { withImages?: boolean }): Setup => {
  const withImages = options?.withImages ?? true
  const stage = new PetStage()
  document.body.appendChild(stage.element)
  const config = createDefaultMotionPetConfig()
  const assets: Record<string, AssetMeta> = {}
  if (withImages) {
    for (const key of POSE_KEYS) {
      config.poses[key].assetId = `asset-${key}`
      assets[`asset-${key}`] = makeAsset(`asset-${key}`)
    }
  }
  const hub = new ConfigHub({ fetchConfig: vi.fn(async () => ({ config, assets })) })
  hub.publish({ config, assets, customs: [] })
  const handles: OverlayStateSourceHandle[] = []
  const factory = vi.fn(() => {
    const handle: OverlayStateSourceHandle = { dispose: vi.fn(), setTerminalTtls: vi.fn() }
    handles.push(handle)
    return handle
  })
  const session = new OverlaySession({ stage, hub, patchConfig: vi.fn(async () => structuredClone(config)), createStateSource: factory })
  return { session, hub, config, assets, factory, handles }
}

const boot = async (session: OverlaySession): Promise<void> => {
  const started = session.start()
  await vi.advanceTimersByTimeAsync(0)
  for (let guard = 0; guard < 20; guard += 1) {
    const finite = harness.pending().filter((animation) => animation.options.iterations !== Infinity)
    if (finite.length === 0) break
    for (const animation of finite) animation.finish()
    await vi.advanceTimersByTimeAsync(0)
  }
  await started
}

describe('OverlaySession state source wiring (M4)', () => {
  it('creates the state source after a successful boot', async () => {
    const { session, factory } = setup()
    expect(factory).not.toHaveBeenCalled()
    await boot(session)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(session.director, expect.objectContaining({ enabled: true }))
    session.dispose()
  })

  it('never connects when the boot finds no usable image (§2.1)', async () => {
    const { session, hub, config, assets, factory, handles } = setup({ withImages: false })
    await boot(session)
    expect(factory).not.toHaveBeenCalled()
    // Images arriving later (hub publish) boot the pet and connect the source.
    for (const key of POSE_KEYS) {
      config.poses[key].assetId = `asset-${key}`
      assets[`asset-${key}`] = makeAsset(`asset-${key}`)
    }
    hub.publish({ config: structuredClone(config), assets: { ...assets }, customs: [] })
    await vi.advanceTimersByTimeAsync(0)
    for (let guard = 0; guard < 20; guard += 1) {
      const finite = harness.pending().filter((animation) => animation.options.iterations !== Infinity)
      if (finite.length === 0) break
      for (const animation of finite) animation.finish()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(factory).toHaveBeenCalledTimes(1)
    session.dispose()
    expect(handles[0].dispose).toHaveBeenCalled()
  })

  it('dispose tears the state source down', async () => {
    const { session, handles } = setup()
    await boot(session)
    expect(handles).toHaveLength(1)
    session.dispose()
    expect(handles[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('a live enabled=false publish disconnects; re-enable reconnects', async () => {
    const { session, hub, config, assets, handles, factory } = setup()
    await boot(session)
    expect(factory).toHaveBeenCalledTimes(1)

    const disabled = structuredClone(config)
    disabled.enabled = false
    hub.publish({ config: disabled, assets, customs: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(handles[0].dispose).toHaveBeenCalledTimes(1)

    hub.publish({ config: structuredClone(config), assets, customs: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(factory).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it('forwards live success/error hold edits to the state source (§14.5 TTLs)', async () => {
    const { session, hub, config, assets, handles } = setup()
    await boot(session)
    const setter = handles[0].setTerminalTtls

    // an unrelated global edit does not touch the TTLs
    const unrelated = structuredClone(config)
    unrelated.global.scale = 1.5
    hub.publish({ config: unrelated, assets, customs: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(setter).not.toHaveBeenCalled()

    // a hold edit is forwarded with both live values
    const edited = structuredClone(config)
    edited.global.errorHoldMs = 2400
    hub.publish({ config: edited, assets, customs: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter).toHaveBeenCalledWith(config.global.successHoldMs, 2400)
    session.dispose()
  })
})
