// @vitest-environment jsdom
/**
 * PetweenCard tests: the settings.section entry card — status summary
 * (imported poses · enabled state), the enable toggle and scale slider saving
 * through the editor store's explicit-save discipline, the save prompt on
 * dialog close (unmount with a dirty draft), the no-image hint, and the link
 * to the standalone full-page editor.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EDITOR_PAGE_URL, type ConfigPatch } from '../../src/client/api'
import { PetweenCard } from '../../src/client/settings/PetweenCard'
import type { EditorApi } from '../../src/client/stores/editor-store'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta } from '../../src/core/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

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

interface ApiMocks {
  getConfig: ReturnType<typeof vi.fn>
  patchConfig: ReturnType<typeof vi.fn>
}

const makeApi = (withImage: boolean): { api: EditorApi; mocks: ApiMocks } => {
  const config = createDefaultPetweenConfig()
  const assets: Record<string, AssetMeta> = {}
  if (withImage) {
    config.poses.idle.assetId = idleAsset.id
    assets[idleAsset.id] = idleAsset
  }
  const mocks = {
    getConfig: vi.fn(async () => ({ config, assets })),
    patchConfig: vi.fn(async (patch: ConfigPatch) => ({
      ...structuredClone(config),
      enabled: patch.enabled ?? config.enabled,
      global: { ...structuredClone(config.global), ...patch.global },
      poses: patch.poses ?? structuredClone(config.poses),
      states: patch.states ?? structuredClone(config.states),
    })),
  }
  const api: EditorApi = {
    ...mocks,
    getAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    getPets: vi.fn(async () => ({ pets: [], activePetId: null, warnings: [] })),
    createPet: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    createPetFromDraft: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    renamePet: vi.fn(async () => {}),
    deletePet: vi.fn(async () => {}),
    applyPet: vi.fn(async () => structuredClone(config)),
    putAnimation: vi.fn(async () => {}),
    deleteAnimation: vi.fn(async () => {}),
    importMotionPack: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    exportMotionPack: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    exportPetPackage: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    importPetPackage: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    updatePetMeta: vi.fn(async () => {}),
    uploadAsset: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    deleteAsset: vi.fn(async () => {}),
  } as EditorApi
  return { api, mocks }
}

const render = async (api: EditorApi): Promise<void> => {
  await act(async () => {
    root.render(<PetweenCard api={api} />)
  })
}

/** React reads range inputs through the native 'input' event. */
const moveSlider = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PetweenCard', () => {
  it('renders the summary, quick controls and the editor link', async () => {
    const { api } = makeApi(true)
    await render(api)
    expect(container.textContent).toContain('Petween')
    expect(container.textContent).toContain('已导入 1/6 张图 · 启用中')
    expect(container.textContent).toContain('启用宠物')
    expect(container.textContent).toContain('整体缩放')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe(EDITOR_PAGE_URL)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.textContent).toContain('打开完整编辑器')
    // the card never mounts the full editor columns or a stage
    expect(container.textContent).not.toContain('循环动画')
    expect(container.querySelector('.petween-position')).toBeNull()
  })

  it('without any image it shows the 0/6 summary plus the import hint', async () => {
    const { api } = makeApi(false)
    await render(api)
    expect(container.textContent).toContain('已导入 0/6 张图 · 启用中')
    expect(container.textContent).toContain('还没有导入图片')
  })

  it('the enable toggle stays local until Save is clicked', async () => {
    const { api, mocks } = makeApi(true)
    await render(api)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox === null) throw new Error('enable toggle missing')
    act(() => checkbox.click())
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存修改' && !button.disabled)
    if (save === undefined) throw new Error('save button missing')
    await act(async () => save.click())
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect((mocks.patchConfig.mock.calls[0][0] as ConfigPatch).enabled).toBe(false)
    expect(container.textContent).toContain('已导入 1/6 张图 · 已停用')
    expect(container.textContent).toContain('已保存')
  })

  it('the scale slider spans 0.3..4, aligned with the full editor and host validation', async () => {
    const { api } = makeApi(true)
    await render(api)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')
    if (range === null) throw new Error('scale slider missing')
    expect(range.min).toBe('0.3')
    expect(range.max).toBe('4')
  })

  it('the scale slider is persisted by the manual Save button', async () => {
    const { api, mocks } = makeApi(true)
    await render(api)
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')
    if (range === null) throw new Error('scale slider missing')
    act(() => moveSlider(range, '1.5'))
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存修改' && !button.disabled)
    if (save === undefined) throw new Error('save button missing')
    await act(async () => save.click())
    expect(mocks.patchConfig).toHaveBeenCalledTimes(1)
    expect((mocks.patchConfig.mock.calls[0][0] as ConfigPatch).global?.scale).toBe(1.5)
  })

  it('closing with unsaved edits warns (alert) and discards — never fires a save', async () => {
    const { api, mocks } = makeApi(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    await render(api)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox === null) throw new Error('enable toggle missing')
    act(() => checkbox.click())
    await act(async () => {
      root.unmount()
    })
    mounted = false
    expect(alertSpy).toHaveBeenCalledTimes(1)
    expect(alertSpy.mock.calls[0][0]).toContain('未保存的修改')
    // Closing never saves: a post-dispose PUT could fail with nobody left to
    // see it — the discard notice is the honest contract.
    expect(mocks.patchConfig).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('a clean card unmounts without any prompt', async () => {
    const { api } = makeApi(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    await render(api)
    await act(async () => {
      root.unmount()
    })
    mounted = false
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })
})
