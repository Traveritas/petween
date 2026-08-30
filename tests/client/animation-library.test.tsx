// @vitest-environment jsdom
/**
 * Animation library tests (V1.1): the standalone editor page (wide) mounts the
 * library — builtin (read-only) + custom entries, 新建 / 克隆 / 重命名 / 删除
 * through the explicit-save EditorStore actions. The P1 visual TimelineEditor
 * drives the draft's tracks/events; gating comes from its onValidationChange
 * channel plus the scalar schema validation. Covered here: keyframe drags →
 * 保存 PUT payload, the collapsible JSON view (read-only sync + 应用 JSON),
 * kind-switch invalid guidance + the pose-swap self-heal, 循环试播 with the
 * strength slider riding the preview chain, and the TransitionEditor's
 * grouped 内置/自定义 select (animationId set/clear/echo) plus the
 * click-interaction select listing interaction customs. Real PetStage +
 * PreviewSession with a fake WAAPI; the EditorApi is injected.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPatch } from '../../src/client/api'
import { PetweenSettings } from '../../src/client/settings/PetweenSettings'
import type { EditorApi } from '../../src/client/stores/editor-store'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetweenConfig } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { validateAnimationDefinition } from '../../src/motion/animation-definition'
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
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    let sequence = 0
    vi.stubGlobal('crypto', {
      randomUUID: () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, '0')}`,
    })
  }
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
  url: '/petween-assets/aaaa1111bbbb2222',
}

const transitionCustom = (id: string, name: string): AnimationDefinition => ({
  version: 1,
  id,
  name,
  kind: 'transition',
  durationMs: 300,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: 1 },
        { at: 0.5, value: 0.8 },
        { at: 1, value: 1 },
      ],
    },
  ],
  events: [{ at: 0.5, type: 'pose-swap' }],
})

const interactionCustom = (id: string, name: string, durationMs = 517): AnimationDefinition => ({
  version: 1,
  id,
  name,
  kind: 'interaction',
  durationMs,
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

const ambientCustom = (id: string, name: string): AnimationDefinition => ({
  version: 1,
  id,
  name,
  kind: 'ambient',
  durationMs: 900,
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
})

interface ApiMocks {
  getConfig: ReturnType<typeof vi.fn>
  getAnimations: ReturnType<typeof vi.fn>
  patchConfig: ReturnType<typeof vi.fn>
  putAnimation: ReturnType<typeof vi.fn>
  deleteAnimation: ReturnType<typeof vi.fn>
  importMotionPack: ReturnType<typeof vi.fn>
  exportMotionPack: ReturnType<typeof vi.fn>
}

const makeApi = (
  options: { customs?: AnimationDefinition[]; mutateConfig?: (config: PetweenConfig) => void } = {},
): { api: EditorApi; mocks: ApiMocks } => {
  const config = createDefaultPetweenConfig()
  config.poses.idle.assetId = idleAsset.id
  options.mutateConfig?.(config)
  const assets = { [idleAsset.id]: idleAsset }
  let serverCustoms = structuredClone(options.customs ?? [])
  const mocks = {
    getConfig: vi.fn(async () => ({ config: structuredClone(config), assets })),
    getAnimations: vi.fn(async () => ({ customs: structuredClone(serverCustoms), warnings: [] as string[], normalized: [] as string[] })),
    patchConfig: vi.fn(async (patch: ConfigPatch) => ({
      ...structuredClone(config),
      enabled: patch.enabled ?? config.enabled,
      global: { ...structuredClone(config.global), ...patch.global },
      poses: patch.poses ?? structuredClone(config.poses),
      states: patch.states ?? structuredClone(config.states),
      advanced: patch.advanced ?? structuredClone(config.advanced),
      interactions: patch.interactions ?? structuredClone(config.interactions),
    })),
    putAnimation: vi.fn(async (definition: AnimationDefinition) => {
      const index = serverCustoms.findIndex((custom) => custom.id === definition.id)
      if (index === -1) serverCustoms.push(structuredClone(definition))
      else serverCustoms[index] = structuredClone(definition)
    }),
    deleteAnimation: vi.fn(async (id: string) => {
      serverCustoms = serverCustoms.filter((custom) => custom.id !== id)
    }),
    importMotionPack: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
    exportMotionPack: vi.fn(async () => {
      throw new Error('not used in these tests')
    }),
  }
  const api: EditorApi = {
    ...mocks,
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
  }
  return { api, mocks }
}

const render = async (api: EditorApi, wide: boolean): Promise<void> => {
  await act(async () => {
    root.render(<PetweenSettings api={api} wide={wide} />)
  })
}

const saveConfig = async (): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === '保存修改' && !candidate.disabled,
  )
  if (button === undefined) throw new Error('enabled config save button missing')
  await act(async () => button.click())
}

const librarySection = (): HTMLElement => {
  const section = container.querySelector('section[aria-label="动画库"]')
  if (section === null) throw new Error('animation library missing')
  return section as HTMLElement
}

const libraryButton = (text: string): HTMLButtonElement => {
  const button = [...librarySection().querySelectorAll('button')].find((el) => el.textContent?.includes(text))
  if (button === undefined) throw new Error(`library button missing: ${text}`)
  return button
}

const findControlRow = (labelText: string): HTMLLabelElement => {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.includes(labelText))
  if (label === undefined) throw new Error(`control row missing: ${labelText}`)
  return label
}

/** Control row scoped to the animation library section. */
const libraryControlRow = (labelText: string): HTMLLabelElement => {
  const label = [...librarySection().querySelectorAll('label')].find((el) => el.textContent?.includes(labelText))
  if (label === undefined) throw new Error(`library control row missing: ${labelText}`)
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

/** React reads textarea edits through the native 'input' event. */
const typeTextarea = (textarea: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

// --- timeline pointer helpers (jsdom does no layout: lanes get stub rects) ---

const stubRect = (el: Element, left: number, width: number): void => {
  el.getBoundingClientRect = () =>
    ({
      left,
      width,
      right: left + width,
      top: 0,
      bottom: 28,
      height: 28,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
}

const pointer = (type: string, x: number, y = 10): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })

const down = (el: Element, x: number): void => {
  act(() => {
    el.dispatchEvent(pointer('pointerdown', x))
  })
}
const move = (x: number): void => {
  act(() => {
    window.dispatchEvent(pointer('pointermove', x))
  })
}
const up = (x: number): void => {
  act(() => {
    window.dispatchEvent(pointer('pointerup', x))
  })
}

const lane = (property: string): HTMLDivElement => {
  const el = librarySection().querySelector(`[aria-label="轨道 ${property}"]`)
  if (el === null) throw new Error(`lane missing: ${property}`)
  return el as HTMLDivElement
}

const keyframeDiamonds = (property: string): HTMLButtonElement[] => [
  ...lane(property).querySelectorAll<HTMLButtonElement>('button[aria-label^="关键帧"]'),
]

describe('AnimationLibrary — panel and list', () => {
  it('wide mode renders builtin (read-only marker) + custom entries; narrow mode hides the panel', async () => {
    const { api } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    const section = librarySection()
    expect(section.textContent).toContain('Comic Pop')
    expect(section.textContent).toContain('内置')
    expect(section.textContent).toContain('My Pop')

    act(() => root.unmount())
    mounted = false
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mounted = true
    const narrow = makeApi()
    await render(narrow.api, false)
    expect(container.querySelector('section[aria-label="动画库"]')).toBeNull()
    // the in-dialog host keeps the interactions card though
    expect(container.textContent).toContain('点击动画')
  })

  it('selecting a builtin shows the read-only view (no 保存/删除, 克隆 available)', async () => {
    const { api } = makeApi()
    await render(api, true)
    act(() => libraryButton('Comic Pop').click())
    const buttons = [...librarySection().querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toContain('克隆为自定义')
    expect(buttons).toContain('▶ 试播')
    expect(buttons).not.toContain('保存')
    expect(buttons).not.toContain('删除')
    expect(librarySection().textContent).toContain('内置动画只读')
  })

  it('B6: a pack-namespace custom is editable (only builtins are read-only)', async () => {
    const { api } = makeApi({ customs: [transitionCustom('manga-pop:pop', 'Manga Pop')] })
    await render(api, true)
    act(() => libraryButton('Manga Pop').click())
    const buttons = [...librarySection().querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toContain('保存')
    expect(buttons).toContain('删除')
    expect(librarySection().textContent).not.toContain('内置动画只读')
  })

  it('新建空白 saves a valid user: template and opens it for editing', async () => {
    const { api, mocks } = makeApi()
    await render(api, true)
    await act(async () => {
      libraryButton('新建空白').click()
    })
    expect(mocks.putAnimation).toHaveBeenCalledTimes(1)
    const saved = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(saved.id).toMatch(/^user:[0-9a-f-]+$/)
    expect(validateAnimationDefinition(saved).valid).toBe(true)
    const nameInput = librarySection().querySelector('input[type="text"]') as HTMLInputElement | null
    expect(nameInput?.value).toBe('新建动画')
  })

  it('克隆 a builtin creates a user: copy named 「副本」 with the same tracks', async () => {
    const { api, mocks } = makeApi()
    await render(api, true)
    act(() => libraryButton('Comic Pop').click())
    await act(async () => {
      libraryButton('克隆为自定义').click()
    })
    expect(mocks.putAnimation).toHaveBeenCalledTimes(1)
    const clone = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(clone.id).toMatch(/^user:/)
    expect(clone.name).toBe('Comic Pop 副本')
    expect(clone.kind).toBe('transition')
    expect(clone.tracks.length).toBeGreaterThan(0)
    // the clone is selected for editing: save/delete are now offered
    const nameInput = librarySection().querySelector('input[type="text"]') as HTMLInputElement | null
    expect(nameInput?.value).toBe('Comic Pop 副本')
    expect(libraryButton('保存')).toBeDefined()
  })
})

describe('AnimationLibrary — editing, validation, save', () => {
  it('dragging a keyframe updates the draft; 保存 PUTs the retimed tracks', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    act(() => libraryButton('My Pop').click())

    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[1] // @ 0.5
    down(diamond, 100)
    move(60) // 0.3
    up(60)
    expect(keyframeDiamonds('transition.scaleY')[1].getAttribute('aria-label')).toContain('@ 0.3')
    expect(libraryButton('保存').disabled).toBe(false)

    await act(async () => {
      libraryButton('保存').click()
    })
    expect(mocks.putAnimation).toHaveBeenCalledTimes(1)
    const payload = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(payload.id).toBe('user:t1')
    expect(payload.tracks[0].keyframes).toEqual([
      { at: 0, value: 1 },
      { at: 0.3, value: 0.8 },
      { at: 1, value: 1 },
    ])
    expect(payload.events).toEqual([{ at: 0.5, type: 'pose-swap' }])
    expect(container.textContent).toContain('已保存')
  })

  it('JSON 视图 mirrors the draft; 应用 JSON validates and replaces tracks/events', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    act(() => libraryButton('My Pop').click())

    // open the view: formatted JSON of the current draft
    act(() => libraryButton('JSON 视图').click())
    const preview = librarySection().querySelector('pre')
    if (preview === null) throw new Error('JSON preview missing')
    expect(preview.textContent).toContain('"property": "transition.scaleY"')

    // edit mode: unparseable JSON is rejected without touching the draft
    act(() => libraryButton('编辑 JSON…').click())
    const editor = librarySection().querySelector('textarea[aria-label="JSON 编辑"]') as HTMLTextAreaElement | null
    if (editor === null) throw new Error('JSON editor missing')
    act(() => typeTextarea(editor, '{ not json'))
    act(() => libraryButton('应用 JSON').click())
    expect(librarySection().textContent).toContain('JSON 解析失败')
    expect(keyframeDiamonds('transition.scaleY')).toHaveLength(3)

    // parseable but schema-illegal (non-whitelist property)
    act(() =>
      typeTextarea(editor, JSON.stringify({ tracks: [{ property: 'css.transform', keyframes: [{ at: 0, value: 1 }] }] })),
    )
    act(() => libraryButton('应用 JSON').click())
    expect(librarySection().textContent).toContain('unknown motion property')
    expect(keyframeDiamonds('transition.scaleY')).toHaveLength(3)

    // legal payload: applied, the timeline reflects it and the view closes
    act(() =>
      typeTextarea(
        editor,
        JSON.stringify({
          tracks: [
            {
              property: 'transition.scaleY',
              keyframes: [
                { at: 0, value: 1 },
                { at: 0.25, value: 0.7 },
                { at: 1, value: 1 },
              ],
            },
          ],
          events: [{ at: 0.25, type: 'pose-swap' }],
        }),
      ),
    )
    act(() => libraryButton('应用 JSON').click())
    expect(librarySection().querySelector('textarea[aria-label="JSON 编辑"]')).toBeNull()
    expect(keyframeDiamonds('transition.scaleY')[1].getAttribute('aria-label')).toContain('@ 0.25')
    expect(librarySection().querySelector('[aria-label="pose-swap（换图）事件 @ 0.25"]')).not.toBeNull()

    // the read-only view stays in sync with visual edits
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[1] // @ 0.25
    down(diamond, 50)
    move(80) // 0.4
    up(80)
    expect(librarySection().querySelector('pre')?.textContent).toContain('"at": 0.4')

    await act(async () => {
      libraryButton('保存').click()
    })
    const payload = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(payload.tracks[0].keyframes).toEqual([
      { at: 0, value: 1 },
      { at: 0.4, value: 0.7 },
      { at: 1, value: 1 },
    ])
    // the keyframe drag does not retime the (separate) pose-swap event
    expect(payload.events).toEqual([{ at: 0.25, type: 'pose-swap' }])
  })

  it('switching kind normalizes incompatible events and tracks automatically', async () => {
    const { api } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    expect(libraryButton('保存').disabled).toBe(false)
    expect(librarySection().textContent).toContain('自动移除不适用的事件')

    // transition → ambient removes the pose-swap AND the transition-layer
    // track (the schema keeps ambient off that layer), seeding a default loop.
    const kindSelect = libraryControlRow('类型').querySelector('select')
    if (kindSelect === null) throw new Error('kind select missing')
    act(() => choose(kindSelect, 'ambient'))
    expect(librarySection().textContent).not.toContain('must not declare events')
    expect(librarySection().querySelector('[aria-label^="pose-swap"]')).toBeNull()
    expect(librarySection().textContent).not.toContain('must not animate')
    expect(librarySection().querySelector('[aria-label="轨道 transition.scaleY"]')).toBeNull() // dropped
    expect(librarySection().querySelector('[aria-label="轨道 sway.rotation"]')).not.toBeNull() // seeded
    expect(keyframeDiamonds('sway.rotation').length).toBeGreaterThan(0)
    expect(libraryButton('保存').disabled).toBe(false)

    // Back to transition adds the required pose-swap.
    act(() => choose(kindSelect, 'transition'))
    expect(librarySection().querySelector('[aria-label="pose-swap（换图）事件 @ 0.5"]')).not.toBeNull()
    expect(libraryButton('保存').disabled).toBe(false)
  })

  it('switching to interaction keeps the pose-swap timing but names an idle target; back to transition strips it', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    act(() => libraryButton('My Pop').click())

    const kindSelect = libraryControlRow('类型').querySelector('select')
    if (kindSelect === null) throw new Error('kind select missing')
    act(() => choose(kindSelect, 'interaction'))
    // The swap survives with a named target (the schema requires one on
    // interactions) — the author retargets in the event inspector.
    expect(librarySection().querySelector('[aria-label^="pose-swap"]')).not.toBeNull()
    expect(librarySection().textContent).not.toContain('must not declare pose-swap')
    expect(libraryButton('保存').disabled).toBe(false)

    await act(async () => {
      libraryButton('保存').click()
    })
    let payload = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(payload.kind).toBe('interaction')
    expect(payload.events).toEqual([{ at: 0.5, type: 'pose-swap', pose: 'idle' }])

    // And back: the target is stripped (the enter pose is state-machine-
    // owned), the exactly-one swap kept, the draft still saves.
    act(() => choose(kindSelect, 'transition'))
    expect(libraryButton('保存').disabled).toBe(false)
    await act(async () => {
      libraryButton('保存').click()
    })
    payload = mocks.putAnimation.mock.calls[mocks.putAnimation.mock.calls.length - 1][0] as AnimationDefinition
    expect(payload.kind).toBe('transition')
    expect(payload.events).toEqual([{ at: 0.5, type: 'pose-swap' }])
  })

  it('试播 plays the current draft on the live preview stage', async () => {
    const { api } = makeApi({ customs: [interactionCustom('user:w1', 'Wiggy')] })
    await render(api, true)
    act(() => libraryButton('Wiggy').click())
    const before = harness.animations.length
    act(() => libraryButton('试播').click())
    expect(harness.animations.length).toBe(before + 1)
    const played = harness.animations[before]
    expect(played.options.duration).toBe(517)
    const preview = librarySection().querySelector('[aria-label="动画试播渲染器"]')
    expect(preview?.contains(played.target as Node)).toBe(true)
    const stop = libraryButton('■ 停止')
    act(() => stop.click())
    expect(played.playState).toBe('idle')
  })

  it('循环试播 auto-replays a valid draft after edits; the strength slider rides along', async () => {
    vi.useFakeTimers()
    const parameterized: AnimationDefinition = {
      version: 1,
      id: 'user:p1',
      name: 'Param Pop',
      kind: 'transition',
      durationMs: 300,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.scaleY',
          keyframes: [
            { at: 0, value: 1 },
            { at: 0.5, value: { base: 1, parameter: 'strength', amount: -0.25 } },
            { at: 1, value: 1 },
          ],
        },
      ],
      events: [{ at: 0.5, type: 'pose-swap' }],
      parameters: { strength: { default: 1, min: 0, max: 3 } },
    }
    const { api } = makeApi({ customs: [parameterized] })
    await render(api, true)
    act(() => libraryButton('Param Pop').click())
    const before = harness.animations.length

    // enabling 循环试播 auditions the current draft once (debounced)
    const toggle = libraryControlRow('循环试播').querySelector('input[type="checkbox"]') as HTMLInputElement | null
    if (toggle === null) throw new Error('auto-replay toggle missing')
    act(() => toggle.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(harness.animations.length).toBeGreaterThan(before)
    // default strength 1: the parameterized mid keyframe resolves to 0.75
    expect(
      harness.animations.slice(before).some((a) => JSON.stringify(a.keyframes).includes('"scale":"1 0.75"')),
    ).toBe(true)

    // an edit (rename) re-triggers the debounced replay
    const afterFirst = harness.animations.length
    const nameInput = librarySection().querySelector('input[type="text"]') as HTMLInputElement | null
    if (nameInput === null) throw new Error('name input missing')
    act(() => typeInput(nameInput, 'Param Pop v2'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(harness.animations.length).toBeGreaterThan(afterFirst)

    // the strength slider overrides the definition default for the audition
    const afterRename = harness.animations.length
    const slider = libraryControlRow('试播强度').querySelector('input[type="range"]') as HTMLInputElement | null
    if (slider === null) throw new Error('strength slider missing')
    act(() => typeInput(slider, '2'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    const fresh = harness.animations.slice(afterRename)
    expect(fresh.length).toBeGreaterThan(0)
    // strength 2: 1 + 2 × (-0.25) = 0.5
    expect(fresh.some((a) => JSON.stringify(a.keyframes).includes('"scale":"1 0.5"'))).toBe(true)
    expect(fresh.some((a) => JSON.stringify(a.keyframes).includes('"scale":"1 0.75"'))).toBe(false)
  })

  it('deleting a referenced custom names the referencing state and skips the API', async () => {
    const { api, mocks } = makeApi({
      customs: [transitionCustom('user:t1', 'My Pop')],
      mutateConfig: (config) => {
        config.states.thinking.enter.animationId = 'user:t1'
      },
    })
    vi.stubGlobal('confirm', vi.fn(() => true)) // the delete confirmation
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    await act(async () => {
      libraryButton('删除').click()
    })
    expect(mocks.deleteAnimation).not.toHaveBeenCalled()
    expect(container.textContent).toContain('无法删除')
    expect(container.textContent).toContain('思考')
  })
})

describe('AnimationLibrary — mounting customs into the config editors', () => {
  it('the state transition select groups 内置/自定义 and sets/clears animationId', async () => {
    vi.useFakeTimers()
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    const select = findControlRow('预设').querySelector('select')
    if (select === null) throw new Error('preset select missing')
    const groups = [...select.querySelectorAll('optgroup')].map((group) => group.label)
    expect(groups).toEqual(['内置', '自定义'])
    const customOption = [...select.querySelectorAll('option')].find((option) => option.value === 'user:t1')
    expect(customOption?.textContent).toBe('My Pop')

    act(() => choose(select, 'user:t1'))
    await saveConfig()
    let payload = mocks.patchConfig.mock.calls[mocks.patchConfig.mock.calls.length - 1][0] as ConfigPatch
    expect(payload.states?.idle.enter.animationId).toBe('user:t1')

    act(() => choose(select, 'comic-pop'))
    await saveConfig()
    payload = mocks.patchConfig.mock.calls[mocks.patchConfig.mock.calls.length - 1][0] as ConfigPatch
    expect(payload.states?.idle.enter.preset).toBe('comic-pop')
    expect(payload.states?.idle.enter.animationId).toBeNull()
  })

  it('B6: a pack-namespace transition mounts by animationId (never written back as a preset name)', async () => {
    vi.useFakeTimers()
    const { api, mocks } = makeApi({ customs: [transitionCustom('manga-pop:pop', 'Manga Pop')] })
    await render(api, true)
    const select = findControlRow('预设').querySelector('select')
    if (select === null) throw new Error('preset select missing')
    const customOption = [...select.querySelectorAll('option')].find((option) => option.value === 'manga-pop:pop')
    expect(customOption?.textContent).toBe('Manga Pop')

    act(() => choose(select, 'manga-pop:pop'))
    await saveConfig()
    const payload = mocks.patchConfig.mock.calls[mocks.patchConfig.mock.calls.length - 1][0] as ConfigPatch
    // the pack id lands verbatim on animationId; the preset stays the fallback
    expect(payload.states?.idle.enter.animationId).toBe('manga-pop:pop')
    expect(payload.states?.idle.enter.preset).toBe('soft') // untouched default
  })

  it('the transition select echoes the custom referenced by animationId', async () => {
    const { api } = makeApi({
      customs: [transitionCustom('user:t1', 'My Pop')],
      mutateConfig: (config) => {
        config.states.idle.enter.animationId = 'user:t1'
      },
    })
    await render(api, true)
    const select = findControlRow('预设').querySelector('select')
    expect(select?.value).toBe('user:t1')
  })

  it('the click-animation select lists interaction customs (not transition ones)', async () => {
    const { api } = makeApi({
      customs: [interactionCustom('user:w1', 'Wiggy'), transitionCustom('user:t1', 'My Pop')],
    })
    await render(api, true)
    const select = findControlRow('点击动画').querySelector('select')
    if (select === null) throw new Error('click-animation select missing')
    const options = [...select.querySelectorAll('option')].map((option) => [option.value, option.textContent])
    expect(options).toContainEqual(['user:w1', '自定义：Wiggy'])
    expect(options.some(([value]) => value === 'user:t1')).toBe(false)
  })

  it('each state can select and clear an ambient custom, excluding other kinds', async () => {
    vi.useFakeTimers()
    const { api, mocks } = makeApi({
      customs: [ambientCustom('user:a1', 'Floaty'), transitionCustom('user:t1', 'My Pop')],
    })
    await render(api, true)
    const select = findControlRow('自定义循环动画').querySelector('select')
    if (select === null) throw new Error('custom ambient select missing')
    const options = [...select.querySelectorAll('option')].map((option) => [option.value, option.textContent])
    expect(options).toContainEqual(['user:a1', 'Floaty'])
    expect(options.some(([value]) => value === 'user:t1')).toBe(false)

    act(() => choose(select, 'user:a1'))
    await saveConfig()
    let payload = mocks.patchConfig.mock.calls[mocks.patchConfig.mock.calls.length - 1][0] as ConfigPatch
    expect(payload.states?.idle.ambient.customAnimationId).toBe('user:a1')

    act(() => choose(select, ''))
    await saveConfig()
    payload = mocks.patchConfig.mock.calls[mocks.patchConfig.mock.calls.length - 1][0] as ConfigPatch
    expect(payload.states?.idle.ambient.customAnimationId).toBeNull()
  })

  it('echoes a dangling custom ambient id instead of silently selecting none', async () => {
    const { api } = makeApi({
      mutateConfig: (config) => {
        config.states.idle.ambient.customAnimationId = 'user:missing'
      },
    })
    await render(api, true)
    const select = findControlRow('自定义循环动画').querySelector('select')
    expect(select?.value).toBe('user:missing')
    expect(select?.textContent).toContain('不可用')
  })

  it('echoes a dangling custom transition id instead of silently showing the preset', async () => {
    const { api } = makeApi({
      mutateConfig: (config) => {
        config.states.idle.enter.animationId = 'user:missing'
      },
    })
    await render(api, true)
    const select = findControlRow('预设').querySelector('select')
    // the real config value stays visible as an explicit 「不可用」 option
    expect(select?.value).toBe('user:missing')
    expect(select?.textContent).toContain('user:missing（不可用）')
  })
})

describe('AnimationLibrary — unsaved draft protection (UX-2)', () => {
  const nameInput = (): HTMLInputElement => {
    const input = librarySection().querySelector('input[type="text"]') as HTMLInputElement | null
    if (input === null) throw new Error('name input missing')
    return input
  }

  const renameDraft = (name: string): void => {
    act(() => typeInput(nameInput(), name))
  }

  it('marks the selected entry with ● while the draft diverges; saving clears it', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    expect(libraryButton('My Pop').textContent).not.toContain('●')

    renameDraft('My Pop v2')
    expect(libraryButton('My Pop').textContent).toContain('●')

    await act(async () => {
      libraryButton('保存').click()
    })
    // the saved list entry becomes the draft's baseline again
    expect(mocks.putAnimation).toHaveBeenCalledTimes(1)
    expect((mocks.putAnimation.mock.calls[0][0] as AnimationDefinition).name).toBe('My Pop v2')
    expect(libraryButton('My Pop v2').textContent).not.toContain('●')
  })

  it('a built-in entry edited for audition also counts as dirty and is guarded', async () => {
    const { api } = makeApi()
    const confirm = vi.fn().mockReturnValueOnce(false)
    vi.stubGlobal('confirm', confirm)
    await render(api, true)
    act(() => libraryButton('Comic Pop').click())
    renameDraft('Comic Pop tweaked')
    expect(libraryButton('Comic Pop').textContent).toContain('●')

    act(() => libraryButton('Jelly').click()) // declined: the tweaks survive
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(nameInput().value).toBe('Comic Pop tweaked')

    confirm.mockReturnValueOnce(true)
    act(() => libraryButton('Jelly').click()) // accepted: the draft resets
    expect(nameInput().value).toBe('Jelly')
    expect(libraryButton('Comic Pop').textContent).not.toContain('●')
  })

  it('新建空白 and 克隆为自定义 guard the dirty draft', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirm)
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    renameDraft('Renamed')

    await act(async () => {
      libraryButton('新建空白').click()
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.putAnimation).not.toHaveBeenCalled()

    await act(async () => {
      libraryButton('克隆为自定义').click()
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(mocks.putAnimation).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('Renamed') // still on the dirty draft
  })

  it('克隆 keeps the unsaved edits and says the copy will include them', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    const confirm = vi.fn().mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    renameDraft('My Pop v2')

    await act(async () => {
      libraryButton('克隆为自定义').click()
    })
    // not the discard wording: the edits ride into the copy
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('副本将包含这些修改')
    expect(mocks.putAnimation).toHaveBeenCalledTimes(1)
    const clone = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(clone.name).toBe('My Pop v2 副本')
  })

  it('clears the ● marker after saving a switch away from random-interval repeat', async () => {
    // The saved definition keeps custom 500/900 interval bounds; switching to
    // 单次 persists only {mode:'once'} (min/max never reach the wire), so the
    // raw-draft baseline (defaults 800/1300) could never match the draft's
    // leftover 500/900 again — the marker must compare ASSEMBLED definitions.
    const randomized: AnimationDefinition = {
      ...transitionCustom('user:r1', 'Random Pop'),
      repeat: { mode: 'random-interval', minDelayMs: 500, maxDelayMs: 900 },
    }
    const { api, mocks } = makeApi({ customs: [randomized] })
    await render(api, true)
    act(() => libraryButton('Random Pop').click())
    expect(libraryButton('Random Pop').textContent).not.toContain('●')

    const repeatSelect = libraryControlRow('重复').querySelector('select')
    if (repeatSelect === null) throw new Error('repeat select missing')
    act(() => choose(repeatSelect, 'once'))
    expect(libraryButton('Random Pop').textContent).toContain('●') // repeat changed, unsaved

    await act(async () => {
      libraryButton('保存').click()
    })
    const payload = mocks.putAnimation.mock.calls[0][0] as AnimationDefinition
    expect(payload.repeat).toEqual({ mode: 'once' })
    // the draft still carries the 500/900 leftovers; assembled vs assembled
    // they are equal, so the marker clears (it used to be stuck forever)
    expect(libraryButton('Random Pop').textContent).not.toContain('●')
  })

  it('registers a beforeunload guard while the timeline draft is dirty', async () => {
    const { api } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false) // clean draft: nothing registered

    renameDraft('My Pop v2')
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true) // unsaved edits: leaving is guarded
  })

  it('删除 asks for an irreversible confirmation naming the animation', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    await render(api, true)
    act(() => libraryButton('My Pop').click())

    await act(async () => {
      libraryButton('删除').click() // declined
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('My Pop')
    expect(confirm.mock.calls[0][0]).toContain('不可恢复')
    expect(mocks.deleteAnimation).not.toHaveBeenCalled()

    await act(async () => {
      libraryButton('删除').click() // accepted
    })
    expect(mocks.deleteAnimation).toHaveBeenCalledWith('user:t1')
    expect(librarySection().textContent).not.toContain('My Pop')
  })

  it('deleting a dirty draft requires the discard AND the delete confirmation', async () => {
    const { api, mocks } = makeApi({ customs: [transitionCustom('user:t1', 'My Pop')] })
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    await render(api, true)
    act(() => libraryButton('My Pop').click())
    renameDraft('Renamed')

    await act(async () => {
      libraryButton('删除').click() // discard declined → nothing happens
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteAnimation).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('Renamed')

    await act(async () => {
      libraryButton('删除').click() // discard + delete accepted
    })
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(confirm.mock.calls[1][0]).toContain('未保存的修改')
    expect(confirm.mock.calls[2][0]).toContain('不可恢复')
    expect(mocks.deleteAnimation).toHaveBeenCalledWith('user:t1')
  })
})

describe('AnimationLibrary — Motion Pack buttons (P2)', () => {
  it('导入动画包 reads the chosen JSON file and hands it to store.importPack', async () => {
    const { api } = makeApi()
    await render(api, true)
    const section = librarySection()
    const input = section.querySelector<HTMLInputElement>('input[type="file"][accept="application/json,.json"]')
    if (input === null) throw new Error('pack import file input missing')
    const file = new File([JSON.stringify({ format: 'motion-pack' })], 'pack.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // The import ran through the REAL store: the api mock rejected it (these
    // tests stub it unused), which surfaces as the error notice — proof the
    // file reached importPack.
    expect(container.textContent).toContain('导入动画包失败')
  })

  it('导入带挂载的包后出现横幅；「应用挂载」并入草稿并清掉横幅', async () => {
    const { api, mocks } = makeApi()
    mocks.importMotionPack.mockImplementation(async () => ({
      name: '挂载包',
      namespace: 'manga',
      entries: [{ requestedId: 'manga:sway', finalId: 'manga:sway', status: 'imported' as const }],
      mounts: { idle: { ambient: 'manga:sway' } },
      warnings: [],
      applyPatch: { states: { idle: { ambient: { customAnimationId: 'manga:sway' } } } },
    }))
    await render(api, true)
    const input = librarySection().querySelector<HTMLInputElement>('input[type="file"][accept="application/json,.json"]')
    if (input === null) throw new Error('pack import file input missing')
    const file = new File(['{}'], 'pack.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // The banner lists the pack name, the state slot (Chinese label) and both actions.
    expect(container.textContent).toContain('挂载建议')
    expect(librarySection().textContent).toContain('待机')
    await act(async () => {
      libraryButton('应用挂载').click()
    })
    expect(container.textContent).not.toContain('挂载建议')
    expect(container.textContent).toContain('挂载已并入当前草稿')
  })

  it('导出动画包 downloads a manifest for every custom animation', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const downloads: string[] = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    const mangaPop: AnimationDefinition = {
      version: 1,
      id: 'manga:pop',
      name: 'Pop',
      kind: 'interaction' as const,
      durationMs: 200,
      repeat: { mode: 'once' as const },
      tracks: [{ property: 'transition.rotation' as const, keyframes: [{ at: 0, value: 0 }, { at: 1, value: 12 }] }],
    }
    const { api } = makeApi({ customs: [mangaPop] })
    const exportMock = vi.fn(async (_ids: string[]) => ({
      format: 'motion-pack' as const,
      version: 1 as const,
      name: 'Motion Pack',
      namespace: 'manga',
      animations: [],
    }))
    api.exportMotionPack = exportMock
    try {
      await render(api, true)
      await act(async () => {
        libraryButton('导出动画包').click()
      })
      expect(exportMock).toHaveBeenCalledWith(['manga:pop'])
      expect(downloads).toEqual(['motion-pack-manga.json'])
      expect(container.textContent).toContain('已导出动画包')
    } finally {
      clickSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
