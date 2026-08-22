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
import type { ConfigPatch, UploadedAsset } from '../../src/client/api'
import { PreviewSession } from '../../src/client/preview-session'
import type { EditorApi } from '../../src/client/stores/editor-store'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { AssetMeta, PetPreset } from '../../src/core/types'
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
    getPets: vi.fn(async () => ({ pets: [], activePetId: null, warnings: [] })),
    createPet: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    renamePet: vi.fn(async () => {}),
    deletePet: vi.fn(async () => {}),
    applyPet: vi.fn(async () => structuredClone(config)),
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

const render = async (api: EditorApi, wide = false): Promise<void> => {
  await act(async () => {
    root.render(<MotionPetSettings api={api} wide={wide} />)
  })
}

const saveChanges = async (): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === '保存修改' && !candidate.disabled,
  )
  if (button === undefined) throw new Error('enabled save button missing')
  await act(async () => button.click())
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

/** React reads input edits through the native 'input' event. */
const typeInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Simulates picking a file in the hidden import input (fires 'change'). */
const pickFile = (input: HTMLInputElement, file: File): void => {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Fires the blur the NumberField commits on (React 18 delegates via focusout). */
const blurInput = (input: HTMLInputElement): void => {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

/** Fires the Enter keydown the NumberField commits on. */
const pressEnter = (input: HTMLInputElement): void => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

const clickButton = (text: string): void => {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text)
  if (button === undefined) throw new Error(`button missing: ${text}`)
  button.click()
}

/** StateList rows carry ●/○ markers + hints, so match by containment. */
const clickStateRow = (label: string): void => {
  const nav = container.querySelector('nav[aria-label="状态列表"]')
  const button = [...(nav?.querySelectorAll('button') ?? [])].find((candidate) =>
    candidate.textContent?.includes(label),
  )
  if (button === undefined) throw new Error(`state row missing: ${label}`)
  button.click()
}

const flushActions = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
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
    expect(api.patchConfig).not.toHaveBeenCalled()
    await saveChanges()
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
    expect(findControlRow('活跃内切换动画').querySelector('select')?.disabled).toBe(false)

    const select = findControlRow('活跃内切换动画').querySelector('select')
    if (select === null) throw new Error('activity-transition select missing')
    act(() => choose(select, 'state'))
    await saveChanges()
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
    await saveChanges()
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
    await saveChanges()
    expect(vi.mocked(api.patchConfig).mock.calls[0][0].interactions).toEqual({
      click: { animation: 'builtin:click-spin', pose: null },
    })

    const pose = findControlRow('点击闪现姿势').querySelector('select')
    if (pose === null) throw new Error('flash-pose select missing')
    act(() => choose(pose, 'success'))
    await saveChanges()
    expect(vi.mocked(api.patchConfig).mock.calls[1][0].interactions).toEqual({
      click: { animation: 'builtin:click-spin', pose: 'success' },
    })
  })

  it('wide editor switches, creates blank, renames and confirms deletion through the pet card', async () => {
    const api = makeApi(true)
    const response = await api.getConfig()
    const config = response.config
    const makePet = (id: string, name: string, scale: number): PetPreset => ({
      id,
      name,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      scale,
      poses: structuredClone(config.poses),
      states: structuredClone(config.states),
    })
    let pets = [makePet('pet_a', '蓝猫', 1), makePet('pet_b', '白猫', 1.5)]
    config.activePetId = 'pet_a'
    const getPets = vi.fn(async () => ({ pets: structuredClone(pets), activePetId: config.activePetId, warnings: [] }))
    const applyPet = vi.fn(async (id: string) => {
      const pet = pets.find((candidate) => candidate.id === id)
      if (pet === undefined) throw new Error('missing pet')
      config.activePetId = id
      config.global.scale = pet.scale
      return structuredClone(config)
    })
    const createPet = vi.fn(async ({ name, from }: { name: string; from: 'current' | 'blank' }) => {
      const blank = createDefaultMotionPetConfig()
      const source = from === 'blank' ? blank : config
      const pet = makePet('pet_c', name, source.global.scale)
      pet.poses = structuredClone(source.poses)
      pet.states = structuredClone(source.states)
      pets = [...pets, pet]
      config.activePetId = pet.id
      config.global.scale = pet.scale
      config.poses = structuredClone(pet.poses)
      config.states = structuredClone(pet.states)
      return { pet: structuredClone(pet), config: structuredClone(config) }
    })
    const renamePet = vi.fn(async (id: string, name: string) => {
      pets = pets.map((pet) => (pet.id === id ? { ...pet, name } : pet))
    })
    const deletePet = vi.fn(async (id: string) => {
      pets = pets.filter((pet) => pet.id !== id)
      if (config.activePetId === id) config.activePetId = null
    })
    api.getPets = getPets
    api.applyPet = applyPet
    api.createPet = createPet
    api.renamePet = renamePet
    api.deletePet = deletePet
    const prompt = vi.fn().mockReturnValueOnce('空白猫').mockReturnValueOnce('改名猫')
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('prompt', prompt)
    vi.stubGlobal('confirm', confirm)

    await render(api, true)
    expect(container.textContent).toContain('有未保存修改时无法切换宠物')
    expect(container.textContent).toContain('新建副本')

    const select = findControlRow('当前宠物').querySelector('select')
    if (select === null) throw new Error('pet select missing')
    act(() => choose(select, 'pet_b'))
    await flushActions()
    expect(applyPet).toHaveBeenCalledWith('pet_b')
    expect(select.value).toBe('pet_b')

    act(() => clickButton('新建空白'))
    await flushActions()
    expect(createPet).toHaveBeenCalledWith({ name: '空白猫', from: 'blank' })
    expect(container.textContent).toContain('空白猫')
    expect(container.textContent).toContain('请先导入至少一张图片')

    act(() => clickButton('重命名'))
    await flushActions()
    expect(renamePet).toHaveBeenCalledWith('pet_c', '改名猫')
    expect(container.textContent).toContain('改名猫')

    act(() => clickButton('删除'))
    await flushActions()
    expect(deletePet).not.toHaveBeenCalled()
    act(() => clickButton('删除'))
    await flushActions()
    expect(deletePet).toHaveBeenCalledWith('pet_c')
    expect(findControlRow('当前宠物').querySelector('select')?.value).toBe('')
    expect(container.textContent).toContain('未保存的当前配置')
  })

  it('registers beforeunload only while there is unsaved work (UX-1a)', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const api = makeApi(true)
    await render(api)
    // clean boot: no guard registered
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function))

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox === null) throw new Error('enable toggle missing')
    act(() => checkbox.click()) // dirty
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    const guard = addSpy.mock.calls.find(([type]) => type === 'beforeunload')?.[1] as (event: Event) => void

    // the handler actually asks the browser to confirm
    const event = new Event('beforeunload', { cancelable: true })
    guard(event)
    expect(event.defaultPrevented).toBe(true)

    await saveChanges() // clean again → the guard is removed
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', guard)
    removeSpy.mockRestore()
    addSpy.mockRestore()
  })

  it('撤回修改 reloads the saved config after confirmation; declining keeps the draft (UX-1b)', async () => {
    const api = makeApi(true)
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    await render(api)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox === null) throw new Error('enable toggle missing')
    act(() => checkbox.click())
    expect(container.textContent).toContain('有未保存修改')
    const getConfig = vi.mocked(api.getConfig)
    const callsBefore = getConfig.mock.calls.length

    const revert = [...container.querySelectorAll('button')].find((b) => b.textContent === '撤回修改')
    if (revert === undefined) throw new Error('revert button missing')
    act(() => revert.click()) // declined: the draft is kept
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(getConfig.mock.calls.length).toBe(callsBefore)
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)

    await act(async () => revert.click()) // confirmed: revert to the saved config
    await flushActions()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(getConfig.mock.calls.length).toBe(callsBefore + 1)
    expect(api.patchConfig).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(container.textContent).toContain('已撤回未保存的修改')
    expect(container.textContent).not.toContain('有未保存修改')
  })

  it('a failed save also offers 撤回修改 next to 重试', async () => {
    const api = makeApi(true)
    api.patchConfig = vi.fn(async () => {
      throw new Error('disk full')
    })
    vi.stubGlobal('confirm', vi.fn(() => true))
    await render(api)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (checkbox === null) throw new Error('enable toggle missing')
    act(() => checkbox.click())
    await saveChanges()
    expect(container.textContent).toContain('保存失败：disk full')
    await act(async () => clickButton('撤回修改'))
    await flushActions()
    expect(container.textContent).toContain('已撤回未保存的修改')
    expect(container.textContent).not.toContain('保存失败')
  })

  it('the global transition select offers 翻转 Flip and persists it', async () => {
    vi.useFakeTimers()
    const api = makeApi(true)
    await render(api)
    const select = findControlRow('过渡动画').querySelector('select')
    if (select === null) throw new Error('global transition select missing')
    expect([...select.querySelectorAll('option')].some((option) => option.value === 'flip')).toBe(true)
    act(() => choose(select, 'flip'))
    await saveChanges()
    const calls = vi.mocked(api.patchConfig).mock.calls
    expect(calls[calls.length - 1][0].global?.transition?.preset).toBe('flip')
  })

  it('NumberField commits on blur/Enter only, clamps, and reverts invalid input', async () => {
    vi.useFakeTimers()
    const api = makeApi(true)
    await render(api)
    const input = findControlRow('成功停留').querySelector('input')
    if (input === null) throw new Error('success-hold input missing')
    expect(input.value).toBe('1600')

    // typing neither commits nor marks the draft dirty
    act(() => typeInput(input, '250'))
    expect(input.value).toBe('250')
    expect(container.textContent).not.toContain('有未保存修改')

    // blur commits
    act(() => blurInput(input))
    expect(input.value).toBe('250')
    expect(container.textContent).toContain('有未保存修改')

    // Enter commits too, clamped to the host bounds
    act(() => typeInput(input, '999999'))
    act(() => pressEnter(input))
    expect(input.value).toBe('120000')

    // empty/invalid input reverts to the last committed value on blur
    act(() => typeInput(input, ''))
    act(() => blurInput(input))
    expect(input.value).toBe('120000')

    await saveChanges()
    const calls = vi.mocked(api.patchConfig).mock.calls
    expect(calls[calls.length - 1][0].global?.successHoldMs).toBe(120000)
  })

  it('the empty-state import button shows the in-flight upload (UX-3)', async () => {
    const api = makeApi(false)
    let resolveUpload!: (asset: UploadedAsset) => void
    api.uploadAsset = vi.fn(
      () =>
        new Promise<UploadedAsset>((resolve) => {
          resolveUpload = resolve
        }),
    )
    await render(api)
    expect(container.textContent).toContain('将作为「待机」姿势')
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === '导入图片')
    if (button === undefined) throw new Error('empty-state import button missing')
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('file input missing')

    act(() => pickFile(input, new File(['png-bytes'], 'pet.png', { type: 'image/png' })))
    await flushActions()
    expect(button.textContent).toBe('上传中…')
    expect(button.disabled).toBe(true)

    resolveUpload({ id: 'bbbb3333cccc4444', url: '/motion-pet-assets/bbbb3333cccc4444', width: 240, height: 240 })
    await flushActions()
    // the first image exits the §2.1 empty state; the button is no longer busy
    expect(container.querySelector('section[aria-label="姿势图片"]')).not.toBeNull()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '上传中…')).toBe(false)
  })

  it('error notices are role=alert, info notices stay role=status', async () => {
    const api = makeApi(true)
    await render(api)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('file input missing')

    // rejected type → error notice, assertive
    act(() => pickFile(input, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })))
    await flushActions()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('仅支持 PNG')
    act(() => alert?.querySelector('button')?.click()) // dismiss

    // accepted JPEG → info notice, polite
    api.uploadAsset = vi.fn(async () => ({
      id: 'bbbb3333cccc4444',
      url: '/motion-pet-assets/bbbb3333cccc4444',
      width: 240,
      height: 240,
    }))
    await act(async () => pickFile(input, new File(['jpg'], 'pet.jpg', { type: 'image/jpeg' })))
    await flushActions()
    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('JPEG')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('the transition panel previews the EDITED state; the toolbar replays the shown state', async () => {
    const api = makeApi(true)
    await render(api)
    await flushActions()
    const replayStateEnter = vi.spyOn(PreviewSession.prototype, 'replayStateEnter')
    const replayEnter = vi.spyOn(PreviewSession.prototype, 'replayEnter')

    // select 思考 in the state list, then use the panel preview
    act(() => clickStateRow('思考'))
    act(() => clickButton('▶ 预览进入动画'))
    expect(replayStateEnter).toHaveBeenCalledWith('thinking')

    // the LivePreview toolbar button keeps its replay-the-shown-state meaning
    act(() => clickButton('▶ 重播进入动画'))
    expect(replayEnter).toHaveBeenCalled()
    expect(replayStateEnter).toHaveBeenCalledTimes(1)

    replayStateEnter.mockRestore()
    replayEnter.mockRestore()
  })
})
