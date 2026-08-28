// @vitest-environment jsdom
/**
 * PetOverlay tests (M3, spec §2.1/§5.2): the shell.overlay entry renders
 * nothing until the config hub is loaded, renders nothing at all when the pet
 * is disabled or has no usable image, follows hub publishes live, and tears
 * the stage/session down on unmount. The hub is injected via props; WAAPI is
 * faked; image decode is stubbed (jsdom never loads).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigHub } from '../../src/client/config-hub'
import { PetOverlay } from '../../src/client/overlay/PetOverlay'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetweenConfig } from '../../src/core/types'
import { installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean
let harness: FakeAnimateHarness

const STAGE_SELECTOR = '.petween-position'

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

const makeHub = (mutate?: (config: PetweenConfig, assets: Record<string, AssetMeta>) => void): ConfigHub => {
  const config = createDefaultPetweenConfig()
  const assets: Record<string, AssetMeta> = {}
  config.poses.idle.assetId = 'asset-idle'
  assets['asset-idle'] = makeAsset('asset-idle')
  mutate?.(config, assets)
  return new ConfigHub({
    fetchConfig: vi.fn(async () => ({ config, assets })),
    fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
  })
}

beforeEach(() => {
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  harness.restore()
  document.body.innerHTML = ''
})

const render = async (hub: ConfigHub): Promise<void> => {
  await act(async () => {
    root.render(<PetOverlay hub={hub} />)
  })
}

describe('PetOverlay', () => {
  it('renders nothing until the hub loads, then mounts the pet stage', async () => {
    let resolveLoad!: (value: { config: PetweenConfig; assets: Record<string, AssetMeta> }) => void
    const config = createDefaultPetweenConfig()
    config.poses.idle.assetId = 'asset-idle'
    const assets = { 'asset-idle': makeAsset('asset-idle') }
    const hub = new ConfigHub({
      fetchConfig: vi.fn(
        () =>
          new Promise<{ config: PetweenConfig; assets: Record<string, AssetMeta> }>((resolve) => {
            resolveLoad = resolve
          }),
      ),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    await render(hub)
    expect(container.querySelector(STAGE_SELECTOR)).toBeNull() // still loading

    await act(async () => {
      resolveLoad({ config, assets })
    })
    expect(container.querySelector(STAGE_SELECTOR)).not.toBeNull()
  })

  it('renders nothing when the pet is disabled (config.enabled = false)', async () => {
    const hub = makeHub((config) => {
      config.enabled = false
    })
    await render(hub)
    expect(container.querySelector(STAGE_SELECTOR)).toBeNull()
  })

  it('renders nothing without a usable image — the overlay reserves no space (§2.1)', async () => {
    const hub = makeHub((config, assets) => {
      delete config.poses.idle.assetId
      delete assets['asset-idle']
    })
    await render(hub)
    expect(container.querySelector(STAGE_SELECTOR)).toBeNull()
  })

  it('follows hub publishes live: disabling the pet removes the stage', async () => {
    const hub = makeHub()
    await render(hub)
    expect(container.querySelector(STAGE_SELECTOR)).not.toBeNull()

    const current = hub.getCurrent()
    if (current === null) throw new Error('hub not loaded')
    await act(async () => {
      hub.publish({ config: { ...current.config, enabled: false }, assets: current.assets, customs: current.customs })
    })
    expect(container.querySelector(STAGE_SELECTOR)).toBeNull()

    await act(async () => {
      hub.publish({ config: { ...current.config, enabled: true }, assets: current.assets, customs: current.customs })
    })
    expect(container.querySelector(STAGE_SELECTOR)).not.toBeNull()
  })

  it('unmount removes the stage DOM', async () => {
    const hub = makeHub()
    await render(hub)
    expect(container.querySelector(STAGE_SELECTOR)).not.toBeNull()
    act(() => root.unmount())
    mounted = false
    expect(container.querySelector(STAGE_SELECTOR)).toBeNull()
  })
})
