// @vitest-environment jsdom
/**
 * Animator entry smoke test (src/animator/index.tsx): the standalone workbench
 * boots itself into #root — page header, the animation library (built-ins +
 * import/export actions), the always-mounted audition renderer, and the empty
 * selection hint — loading the config through the same-origin API. No shell,
 * no slot: proof the page is self-contained.
 *
 * Single test on purpose (same discipline as editor-entry.test.tsx): the
 * entry renders at import time, and re-importing would pull a second React
 * instance into the same DOM.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta } from '../../src/core/types'
import { installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let harness: FakeAnimateHarness

beforeEach(() => {
  harness = installFakeAnimate()
  // jsdom never fires load/decode on real images; stub a decodable Image.
  vi.stubGlobal(
    'Image',
    class FakeImage {
      src = ''
      decode(): Promise<void> {
        return Promise.resolve()
      }
    },
  )
  const config = createDefaultPetweenConfig()
  const idleAsset: AssetMeta = {
    id: 'aaaa1111bbbb2222',
    fileName: 'idle.webp',
    mimeType: 'image/webp',
    width: 240,
    height: 240,
    sizeBytes: 10,
    sha256: 'x',
    url: '/petween-assets/aaaa1111bbbb2222',
  }
  config.poses.idle.assetId = idleAsset.id
  const assets = { [idleAsset.id]: idleAsset }
  // client/api.ts only reads .ok and .json() from the response.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/petween/config') return { ok: true, json: async () => ({ config, assets }) }
      if (url === '/api/petween/animations') return { ok: true, json: async () => ({ customs: [], warnings: [], normalized: [] }) }
      if (url === '/api/petween/pets') return { ok: true, json: async () => ({ pets: [], activePetId: null, warnings: [] }) }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  document.body.innerHTML = ''
  harness.restore()
  vi.unstubAllGlobals()
})

describe('animator entry (src/animator/index.tsx)', () => {
  // Booting the workbench (audition renderer included) in jsdom is inherently
  // heavy; under machine load it crosses vitest's 5s default. Allow 20s.
  it('boots the header, library and audition renderer into #root', { timeout: 20_000 }, async () => {
    await act(async () => {
      await import('../../src/animator/index')
    })
    const root = document.getElementById('root')
    expect(root).not.toBeNull()
    expect(root?.textContent).toContain('Petween 动画编辑器')
    // the library column: built-in entries + pack actions
    expect(root?.textContent).toContain('＋ 新建空白')
    expect(root?.textContent).toContain('导入动画包')
    expect(root?.textContent).toContain('导出动画包')
    // nothing selected yet: the empty-selection hint
    expect(root?.textContent).toContain('在左侧选择动画查看详情')
    // the always-mounted audition renderer's stage root
    expect(root?.querySelector('.petween-position')).not.toBeNull()
  })
})
