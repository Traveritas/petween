// @vitest-environment jsdom
/**
 * MotionPetSettings render tests (spec §2.1, §17): the settings page gates on
 * "at least one imported image" — without one it shows the empty state with an
 * import button and renders NO stage; with one it renders the full editor
 * (state list with ●/○ fallback indicators, pose/transition/ambient panels,
 * and the Live Preview running the real PetStage + PreviewSession stack).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionPetSettings } from '../../src/client/settings/MotionPetSettings'
import type { ConfigPatch } from '../../src/client/api'
import type { EditorApi } from '../../src/client/stores/editor-store'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { AssetMeta } from '../../src/core/types'
import { installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  harness.restore()
  vi.unstubAllGlobals()
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
  url: '/motion-pet-assets/aaaa1111bbbb2222',
}

const makeApi = (withImage: boolean): EditorApi => {
  const config = createDefaultMotionPetConfig()
  const assets: Record<string, AssetMeta> = {}
  if (withImage) {
    config.poses.idle.assetId = idleAsset.id
    assets[idleAsset.id] = idleAsset
  }
  return {
    getConfig: vi.fn(async () => ({ config, assets })),
    getAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
    patchConfig: vi.fn(async (patch: ConfigPatch) => ({
      ...structuredClone(config),
      enabled: patch.enabled ?? config.enabled,
      global: { ...structuredClone(config.global), ...patch.global },
      poses: patch.poses ?? structuredClone(config.poses),
      states: patch.states ?? structuredClone(config.states),
      advanced: patch.advanced ?? structuredClone(config.advanced),
      interactions: patch.interactions ?? structuredClone(config.interactions),
    })),
    putAnimation: vi.fn(async () => {}),
    deleteAnimation: vi.fn(async () => {}),
    uploadAsset: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    deleteAsset: vi.fn(async () => {}),
  }
}

const render = async (api: EditorApi): Promise<void> => {
  await act(async () => {
    root.render(<MotionPetSettings api={api} />)
  })
}

const findControlRow = (labelText: string): HTMLLabelElement => {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.includes(labelText))
  if (label === undefined) throw new Error(`control row missing: ${labelText}`)
  return label
}

/** React reads select edits through the native 'change' event. */
const choose = (select: HTMLSelectElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('MotionPetSettings', () => {
  it('without any image it shows the §2.1 empty state and no stage', async () => {
    await render(makeApi(false))
    expect(container.textContent).toContain('请先导入至少一张图片')
    expect(container.textContent).toContain('导入图片')
    // the editor columns and the pet stage must not render at all
    expect(container.querySelector('.dsh-motion-pet-position')).toBeNull()
    expect(container.textContent).not.toContain('环境动态')
  })

  it('with one image it renders the full editor and the live preview stack', async () => {
    await render(makeApi(true))
    // StateList: every state present; idle is ● (own image), the rest ○ fallback
    for (const label of ['待机', '思考', '工作', '等待', '成功', '错误']) {
      expect(container.textContent).toContain(label)
    }
    expect(container.textContent).toContain('●')
    expect(container.textContent).toContain('○')
    expect(container.textContent).toContain('跟随待机')
    // the three setting panels
    expect(container.textContent).toContain('姿势图片')
    expect(container.textContent).toContain('进入过渡动画')
    expect(container.textContent).toContain('环境动态')
    // global bar + save indicator
    expect(container.textContent).toContain('启用宠物')
    // Live Preview: manual state buttons + replay + anchor toggle
    expect(container.textContent).toContain('重播进入动画')
    expect(container.textContent).toContain('Anchor 十字')
    // the current pose thumbnail
    const thumb = container.querySelector('img[src="/motion-pet-assets/aaaa1111bbbb2222"]')
    expect(thumb).not.toBeNull()
    // the real PetStage is mounted inside the preview
    expect(container.querySelector('.dsh-motion-pet-position')).not.toBeNull()
  })

  it('the terminal-hold select saves advanced.terminalHold and disables the hold duration inputs', async () => {
    vi.useFakeTimers()
    const api = makeApi(true)
    await render(api)
    // default: timed holds, the duration inputs stay editable
    const successHold = findControlRow('成功停留').querySelector('input')
    expect(successHold?.disabled).toBe(false)

    const select = findControlRow('成功/失败停留').querySelector('select')
    if (select === null) throw new Error('terminal-hold select missing')
    act(() => choose(select, 'until-interaction'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400) // the §21 debounce
    })
    expect(api.patchConfig).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.patchConfig).mock.calls[0][0].advanced).toEqual({
      changePoseWithinActive: false,
      activityTransition: 'subtle',
      terminalHold: 'until-interaction',
      particles: true,
    })
    // the draft re-rendered: hold durations no longer apply
    expect(findControlRow('成功停留').querySelector('input')?.disabled).toBe(true)
    expect(findControlRow('失败停留').querySelector('input')?.disabled).toBe(true)
    expect(container.textContent).toContain('停留时长不适用')
  })

  it('the activity-transition select saves advanced.activityTransition (enabled by the pose toggle)', async () => {
    vi.useFakeTimers()
    const api = makeApi(true)
    await render(api)
    // changePoseWithinActive is off by default: the select starts disabled
    expect(findControlRow('活跃内切换动画').querySelector('select')?.disabled).toBe(true)

    const toggle = findControlRow('活跃状态内切换姿势').querySelector('input')
    if (toggle === null) throw new Error('change-pose toggle missing')
    act(() => toggle.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(findControlRow('活跃内切换动画').querySelector('select')?.disabled).toBe(false)

    const select = findControlRow('活跃内切换动画').querySelector('select')
    if (select === null) throw new Error('activity-transition select missing')
    act(() => choose(select, 'state'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    const calls = vi.mocked(api.patchConfig).mock.calls
    expect(calls[calls.length - 1][0].advanced).toEqual({
      changePoseWithinActive: true,
      activityTransition: 'state',
      terminalHold: 'timed',
      particles: true,
    })
  })

  it('the particles toggle saves advanced.particles', async () => {
    vi.useFakeTimers()
    const api = makeApi(true)
    await render(api)

    const toggle = findControlRow('粒子特效').querySelector('input')
    if (toggle === null) throw new Error('particles toggle missing')
    expect(toggle.checked).toBe(true) // default on
    act(() => toggle.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    const calls = vi.mocked(api.patchConfig).mock.calls
    expect(calls[calls.length - 1][0].advanced?.particles).toBe(false)
  })

  it('the interaction selects save interactions.click', async () => {
    vi.useFakeTimers()
    const api = makeApi(true)
    await render(api)

    const animation = findControlRow('点击动画').querySelector('select')
    if (animation === null) throw new Error('click-animation select missing')
    act(() => choose(animation, 'builtin:click-spin'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(vi.mocked(api.patchConfig).mock.calls[0][0].interactions).toEqual({
      click: { animation: 'builtin:click-spin', pose: null },
    })

    const pose = findControlRow('点击闪现姿势').querySelector('select')
    if (pose === null) throw new Error('flash-pose select missing')
    act(() => choose(pose, 'success'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(vi.mocked(api.patchConfig).mock.calls[1][0].interactions).toEqual({
      click: { animation: 'builtin:click-spin', pose: 'success' },
    })
  })
})
