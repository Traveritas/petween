// @vitest-environment jsdom
/**
 * TimelineEditor component tests (V1.1 P1): the controlled visual editor —
 * kind-gated chrome (ruler / event overlay / toolbar), lane-click keyframe
 * creation with 0.01 snapping, diamond drags (click threshold, clamp,
 * collision rejection), inspector edits (at / value modes / named + custom
 * easing with the same-layer sync), event markers (pose-swap drag, particle
 * add/recolor/delete, deletion rules) and the validation surfacing that the
 * host panel uses to block saving. Synthetic MouseEvents stand in for
 * PointerEvents (jsdom lacks them, same as the DragController tests); lane
 * rects are stubbed because jsdom does no layout.
 */
import { act, useState, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineEditor } from '../../src/client/timeline/TimelineEditor'
import { validateTimelineDraft } from '../../src/client/timeline/timeline-model'
import type { AnimationKind, MotionTrack, TimelineEvent } from '../../src/motion/animation-definition'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

// --- fixtures ---------------------------------------------------------------

/** Single linear track, valid with one pose-swap. */
const linearTracks = (): MotionTrack[] => [
  { property: 'transition.scaleY', keyframes: [{ at: 0, value: 1 }, { at: 1, value: 2 }] },
]

/** Two mirrored transition-layer tracks (the valid multi-track shape). */
const duoTracks = (): MotionTrack[] => [
  {
    property: 'transition.scaleY',
    keyframes: [
      { at: 0, value: 1, easing: 'ease-in' },
      { at: 0.5, value: 0.8, easing: 'ease-out' },
      { at: 1, value: 1 },
    ],
  },
  {
    property: 'transition.scaleX',
    keyframes: [
      { at: 0, value: 1, easing: 'ease-in' },
      { at: 0.5, value: 1.2, easing: 'ease-out' },
      { at: 1, value: 1 },
    ],
  },
]

const poseSwap = (): TimelineEvent[] => [{ at: 0.5, type: 'pose-swap' }]

// --- harness ----------------------------------------------------------------

interface MountResult {
  changes: Array<{ tracks: MotionTrack[]; events: TimelineEvent[] }>
  validations: string[][]
}

const mount = async (kind: AnimationKind, tracks: MotionTrack[], events: TimelineEvent[]): Promise<MountResult> => {
  const changes: MountResult['changes'] = []
  const validations: string[][] = []
  const Wrapper = (): JSX.Element => {
    const [state, setState] = useState(() => ({ tracks, events }))
    return (
      <TimelineEditor
        kind={kind}
        tracks={state.tracks}
        events={state.events}
        onChange={(next) => {
          changes.push(next)
          setState(next)
        }}
        onValidationChange={(list) => validations.push(list)}
      />
    )
  }
  await act(async () => {
    root.render(<Wrapper />)
  })
  return { changes, validations }
}

const remount = async (kind: AnimationKind, tracks: MotionTrack[], events: TimelineEvent[]): Promise<MountResult> => {
  act(() => root.unmount())
  mounted = false
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
  return mount(kind, tracks, events)
}

// --- queries and events -----------------------------------------------------

const q = <T extends Element>(selector: string): T => {
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`missing: ${selector}`)
  return el as T
}

const lane = (property: string): HTMLDivElement => q<HTMLDivElement>(`[aria-label="轨道 ${property}"]`)

const keyframeDiamonds = (property: string): HTMLButtonElement[] => [
  ...lane(property).querySelectorAll<HTMLButtonElement>('button[aria-label^="关键帧"]'),
]

const inspector = (): HTMLElement => q<HTMLElement>('[aria-label="关键帧检查器"]')

const controlRow = (rootEl: Element, labelText: string): HTMLLabelElement => {
  const label = [...rootEl.querySelectorAll('label')].find((el) => el.textContent?.includes(labelText))
  if (label === undefined) throw new Error(`control row missing: ${labelText}`)
  return label
}

/** jsdom does no layout — the lanes measure themselves, so tests stub rects. */
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

/** React reads select edits through the native 'change' event. */
const choose = (select: HTMLSelectElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(select, value)
  act(() => {
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** React reads input edits through the native 'input' event. NumberField only commits on blur, so the helper also fires the delegated 'focusout' to commit. */
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(input, value)
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('focusout', { bubbles: true }))
  })
}

const clickLane = (property: string, clientX: number): void => {
  act(() => {
    lane(property).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY: 10 }))
  })
}

const expectValidDrafts = (kind: AnimationKind, changes: MountResult['changes']): void => {
  for (const change of changes) {
    expect(validateTimelineDraft(kind, change.tracks, change.events)).toEqual([])
  }
}

// --- tests ------------------------------------------------------------------

describe('TimelineEditor — chrome per kind', () => {
  it('transition shows ruler, lanes, the event overlay and the particle select', async () => {
    await mount('transition', linearTracks(), poseSwap())
    expect(container.textContent).toContain('0%')
    expect(container.textContent).toContain('50%')
    expect(container.textContent).toContain('100%')
    expect(q('[aria-label="事件轨"]')).toBeDefined()
    expect(q('[aria-label="pose-swap（换图）事件 @ 0.5"]')).toBeDefined()
    expect(q('select[aria-label="添加粒子事件"]')).toBeDefined()
    // a valid lone pose-swap needs no heal button
    expect(container.textContent).not.toContain('＋ 添加 pose-swap（换图）')
    // no selection yet: the inspector slot shows the hint
    expect(container.querySelector('[aria-label="关键帧检查器"]')).toBeNull()
    expect(container.textContent).toContain('选中关键帧或事件标记进行编辑')
  })

  it('interaction keeps the event overlay (particles only), ambient drops all event chrome', async () => {
    await mount('interaction', linearTracks(), [])
    expect(q('[aria-label="事件轨"]')).toBeDefined()
    expect(container.querySelector('[aria-label^="pose-swap"]')).toBeNull()
    expect(q('select[aria-label="添加粒子事件"]')).toBeDefined()

    await remount('ambient', linearTracks(), [])
    expect(container.querySelector('[aria-label="事件轨"]')).toBeNull()
    expect(container.querySelector('select[aria-label="添加粒子事件"]')).toBeNull()
  })
})

describe('TimelineEditor — keyframe creation and selection', () => {
  it('lane click adds a snapped, curve-sampled keyframe and selects it; re-click selects instead', async () => {
    const { changes } = await mount('transition', linearTracks(), poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    clickLane('transition.scaleY', 90) // 90/200 = 0.45
    expect(keyframeDiamonds('transition.scaleY')).toHaveLength(3)
    const added = changes[0].tracks[0].keyframes[2]
    expect(added).toEqual({ at: 0.45, value: 1.45 }) // linear sample, no easing
    expect(inspector().textContent).toContain('关键帧：transition.scaleY（纵向挤压） @ 0.45')

    clickLane('transition.scaleY', 90) // same slot: no duplicate
    expect(changes).toHaveLength(1)
    expect(keyframeDiamonds('transition.scaleY')).toHaveLength(3)
    expect(inspector().textContent).toContain('@ 0.45')
  })

  it('keyframe press below the drag threshold selects it without producing changes', async () => {
    const { changes } = await mount('transition', linearTracks(), poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[1] // @ 1
    down(diamond, 200)
    move(202) // 2px — under the 3px threshold
    up(202)
    expect(changes).toHaveLength(0)
    expect(inspector().textContent).toContain('关键帧：transition.scaleY（纵向挤压） @ 1')
  })
})

describe('TimelineEditor — keyframe dragging', () => {
  it('drags retime with clamp + 0.01 snap, live through onChange', async () => {
    const { changes } = await mount('transition', linearTracks(), poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[0] // @ 0
    down(diamond, 0)
    move(30) // 0.15
    move(50) // 0.25
    move(91.2) // 0.456 → 0.46
    up(91.2)
    expect(changes.map((change) => change.tracks[0].keyframes[0].at)).toEqual([0.15, 0.25, 0.46])
    expect(keyframeDiamonds('transition.scaleY')[0].getAttribute('aria-label')).toContain('@ 0.46')
    expectValidDrafts('transition', changes)
  })

  it('clamps drags past the lane edges to 0 and 1', async () => {
    const tracks: MotionTrack[] = [{ property: 'transition.scaleY', keyframes: [{ at: 0.5, value: 1 }] }]
    const { changes } = await mount('transition', tracks, poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[0]
    down(diamond, 100)
    move(500)
    move(-100)
    up(-100)
    expect(changes.map((change) => change.tracks[0].keyframes[0].at)).toEqual([1, 0])
  })

  it('unmounting mid-drag cancels the gesture: the window listeners leave with the lane', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { changes } = await mount('transition', linearTracks(), poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[0]
    down(diamond, 0)
    move(30)
    expect(changes).toHaveLength(1) // the drag is live

    act(() => root.unmount())
    mounted = false
    const removedTypes = removeSpy.mock.calls.map(([type]) => type)
    expect(removedTypes).toContain('pointermove')
    expect(removedTypes).toContain('pointerup')
    expect(removedTypes).toContain('pointercancel')

    move(60) // no listener survives: no more drags, and the release is no click either
    up(60)
    expect(changes).toHaveLength(1)
  })

  it('rejects drops onto an occupied time: the diamond keeps its last legal slot', async () => {
    const tracks: MotionTrack[] = [
      { property: 'transition.scaleY', keyframes: [{ at: 0, value: 1 }, { at: 0.5, value: 0.8 }] },
    ]
    const { changes } = await mount('transition', tracks, poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[0] // @ 0
    down(diamond, 0)
    move(60) // 0.3 — free
    move(100) // 0.5 — occupied, rejected
    move(140) // 0.7 — free again
    up(140)
    expect(changes.map((change) => change.tracks[0].keyframes[0].at)).toEqual([0.3, 0.7])
    const labels = keyframeDiamonds('transition.scaleY').map((el) => el.getAttribute('aria-label'))
    expect(labels.some((label) => label?.includes('@ 0.5'))).toBe(true)
    expect(labels.some((label) => label?.includes('@ 0.7'))).toBe(true)
    expectValidDrafts('transition', changes)
  })
})

describe('TimelineEditor — inspector: at and value', () => {
  const selectFirstKeyframe = async (): Promise<MountResult> => {
    const result = await mount('transition', linearTracks(), poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[0]
    down(diamond, 0)
    up(0)
    return result
  }

  it('edits at with clamp + snap and rejects duplicates of a sibling time', async () => {
    const { changes } = await selectFirstKeyframe()
    const atInput = controlRow(inspector(), '时间 at').querySelector('input')
    if (atInput === null) throw new Error('at input missing')

    type(atInput, '0.557') // snapped to 0.56
    expect(changes[0].tracks[0].keyframes[0].at).toBe(0.56)

    type(atInput, '1.7') // NumberField clamps to 1 — occupied by the sibling, rejected
    expect(changes).toHaveLength(1)

    type(atInput, '0.3')
    expect(changes[1].tracks[0].keyframes[0].at).toBe(0.3)
    expectValidDrafts('transition', changes)
  })

  it('switches value between fixed and strength-parameterized, preserving the shown curve', async () => {
    const { changes } = await selectFirstKeyframe()
    const modeSelect = controlRow(inspector(), '取值').querySelector('select')
    if (modeSelect === null) throw new Error('value mode select missing')

    choose(modeSelect, 'parameterized')
    expect(changes[0].tracks[0].keyframes[0].value).toEqual({ base: 1, parameter: 'strength', amount: 0 })

    const baseInput = controlRow(inspector(), '基础值 base').querySelector('input')
    const amountInput = controlRow(inspector(), '强度系数 amount').querySelector('input')
    if (baseInput === null || amountInput === null) throw new Error('parameter inputs missing')
    // UX: the formula note lives on the amount row's tooltip, not a resident hint
    expect(controlRow(inspector(), '强度系数 amount').getAttribute('data-tooltip')).toContain('base + 强度 × amount')
    type(baseInput, '0.8')
    expect(changes[1].tracks[0].keyframes[0].value).toEqual({ base: 0.8, parameter: 'strength', amount: 0 })
    type(amountInput, '-0.25')
    expect(changes[2].tracks[0].keyframes[0].value).toEqual({ base: 0.8, parameter: 'strength', amount: -0.25 })

    choose(controlRow(inspector(), '取值').querySelector('select') as HTMLSelectElement, 'fixed')
    expect(changes[3].tracks[0].keyframes[0].value).toBe(0.55) // base + amount at strength 1
    expectValidDrafts('transition', changes)
  })
})

describe('TimelineEditor — inspector: easing and the same-layer sync', () => {
  const selectMidKeyframe = async (tracks: MotionTrack[]): Promise<MountResult> => {
    const result = await mount('transition', tracks, poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[1] // @ 0.5
    down(diamond, 100)
    up(100)
    return result
  }

  it('applies a named easing and syncs the governed interval across the layer', async () => {
    const otherLayer: MotionTrack = {
      property: 'bounce.y',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-in' },
        { at: 1, value: 0 },
      ],
    }
    const { changes } = await selectMidKeyframe([...duoTracks(), otherLayer])
    const easingSelect = controlRow(inspector(), '缓动').querySelector('select')
    if (easingSelect === null) throw new Error('easing select missing')
    choose(easingSelect, 'overshoot')

    const next = changes[0]
    expect(next.tracks[0].keyframes[1].easing).toBe('overshoot')
    expect(next.tracks[1].keyframes[1].easing).toBe('overshoot') // synced, same layer
    expect(next.tracks[0].keyframes[0].easing).toBe('ease-in') // outside the interval
    expect(next.tracks[1].keyframes[0].easing).toBe('ease-in')
    expect(next.tracks[2]).toEqual(otherLayer) // different layer untouched
    // UX: the same-layer note moved from a resident hint to the row's tooltip
    expect(controlRow(inspector(), '缓动').getAttribute('data-tooltip')).toContain('同层轨道共享缓动')
    expectValidDrafts('transition', changes)
  })

  it('linear clears the easing on the whole governed interval', async () => {
    const { changes } = await selectMidKeyframe(duoTracks())
    choose(controlRow(inspector(), '缓动').querySelector('select') as HTMLSelectElement, 'linear')
    const next = changes[0]
    expect('easing' in next.tracks[0].keyframes[1]).toBe(false)
    expect('easing' in next.tracks[1].keyframes[1]).toBe(false)
    expectValidDrafts('transition', changes)
  })

  it('custom cubic-bezier: default points from the current curve, then per-point edits', async () => {
    const { changes } = await selectMidKeyframe(duoTracks())
    choose(controlRow(inspector(), '缓动').querySelector('select') as HTMLSelectElement, 'custom')
    // the 0.5 keyframe had ease-out [0, 0, 0.58, 1]
    expect(changes[0].tracks[0].keyframes[1].easing).toBe('cubic-bezier(0,0,0.58,1)')
    expect(changes[0].tracks[1].keyframes[1].easing).toBe('cubic-bezier(0,0,0.58,1)')

    const x1 = controlRow(inspector(), 'x1').querySelector('input')
    if (x1 === null) throw new Error('x1 input missing')
    type(x1, '0.5')
    expect(changes[1].tracks[0].keyframes[1].easing).toBe('cubic-bezier(0.5,0,0.58,1)')
    expectValidDrafts('transition', changes)
  })
})

describe('TimelineEditor — tracks', () => {
  it('adds a track through the layer-grouped select (existing properties excluded), seeded to stay valid', async () => {
    const { changes } = await mount('transition', duoTracks(), poseSwap())
    const select = q<HTMLSelectElement>('select[aria-label="添加轨道"]')
    const values = [...select.querySelectorAll('option')].map((option) => option.value)
    expect(values).not.toContain('transition.scaleY')
    expect(values).not.toContain('transition.scaleX')
    expect(values).toContain('transition.rotation')
    // display-layer Chinese gloss rides along; the raw value stays the contract
    const rotationOption = [...select.querySelectorAll('option')].find(
      (option) => option.value === 'transition.rotation',
    )
    expect(rotationOption?.textContent).toBe('transition.rotation（旋转）')
    const groups = [...select.querySelectorAll('optgroup')].map((group) => group.label)
    expect(groups).toEqual(['过渡层', '摇摆层', '弹跳层', '呼吸层'])

    choose(select, 'transition.rotation')
    const added = changes[0].tracks[2]
    expect(added.property).toBe('transition.rotation')
    // seeded on the layer's keyframe times with matching per-interval easings
    expect(added.keyframes).toEqual([
      { at: 0, value: 0, easing: 'ease-in' },
      { at: 0.5, value: 0, easing: 'ease-out' },
      { at: 1, value: 0 },
    ])
    expect(inspector().textContent).toContain('关键帧：transition.rotation（旋转） @ 0')
    expectValidDrafts('transition', changes)
  })

  it('deletes keyframes and tracks; an empty animation shows the editor-level error', async () => {
    const { changes, validations } = await mount('transition', linearTracks(), poseSwap())
    stubRect(lane('transition.scaleY'), 0, 200)
    const diamond = keyframeDiamonds('transition.scaleY')[0]
    down(diamond, 0)
    up(0)
    act(() => {
      const button = [...inspector().querySelectorAll('button')].find((el) => el.textContent === '删除关键帧')
      if (button === undefined) throw new Error('delete keyframe button missing')
      button.click()
    })
    expect(changes[0].tracks[0].keyframes).toHaveLength(1)
    expect(container.querySelector('[aria-label="关键帧检查器"]')).toBeNull() // selection cleared

    act(() => {
      q<HTMLButtonElement>('[aria-label="删除轨道 transition.scaleY"]').click()
    })
    expect(changes[1].tracks).toHaveLength(0)
    expect(container.textContent).toContain('至少需要一条轨道')
    expect(validations[validations.length - 1]).toContain('至少需要一条轨道')
  })
})

describe('TimelineEditor — events', () => {
  it('drags the pose-swap marker (clamped + snapped); the lone pose-swap is not deletable', async () => {
    const { changes } = await mount('transition', linearTracks(), poseSwap())
    const overlay = q<HTMLElement>('[aria-label="事件轨"]')
    stubRect(overlay, 0, 200)
    const marker = q<HTMLButtonElement>('[aria-label="pose-swap（换图）事件 @ 0.5"]')
    down(marker, 100)
    move(60) // 0.3
    move(500) // clamped to 1
    up(500)
    expect(changes.map((change) => change.events[0].at)).toEqual([0.3, 1])
    expect(q('[aria-label="pose-swap（换图）事件 @ 1"]')).toBeDefined()

    // select it: the inspector offers no delete for the only pose-swap
    down(q('[aria-label="pose-swap（换图）事件 @ 1"]'), 200)
    up(200)
    const eventInspector = q<HTMLElement>('[aria-label="事件检查器"]')
    expect(eventInspector.textContent).toContain('不可删除')
    expect([...eventInspector.querySelectorAll('button')].some((el) => el.textContent === '删除事件')).toBe(false)
    expectValidDrafts('transition', changes)
  })

  it('adds, recolors, drags and deletes particle markers', async () => {
    const { changes } = await mount('transition', linearTracks(), poseSwap())
    choose(q<HTMLSelectElement>('select[aria-label="添加粒子事件"]'), 'confetti')
    expect(changes[0].events[1]).toEqual({ at: 0.5, type: 'particle', effect: 'confetti' })
    // newly added marker is selected: the event inspector shows
    const eventInspector = q<HTMLElement>('[aria-label="事件检查器"]')
    expect(eventInspector.textContent).toContain('粒子事件 confetti @ 0.5')

    const effectSelect = controlRow(eventInspector, '特效').querySelector('select')
    if (effectSelect === null) throw new Error('effect select missing')
    choose(effectSelect, 'sparkle')
    expect(changes[1].events[1]).toEqual({ at: 0.5, type: 'particle', effect: 'sparkle' })

    const overlay = q<HTMLElement>('[aria-label="事件轨"]')
    stubRect(overlay, 0, 200)
    const marker = q<HTMLButtonElement>('[aria-label="粒子事件 sparkle @ 0.5"]')
    down(marker, 100)
    move(40) // 0.2
    up(40)
    expect(changes[2].events[1]).toEqual({ at: 0.2, type: 'particle', effect: 'sparkle' })

    const deleteButton = [...q<HTMLElement>('[aria-label="事件检查器"]').querySelectorAll('button')].find(
      (el) => el.textContent === '删除事件',
    )
    if (deleteButton === undefined) throw new Error('delete event button missing')
    act(() => deleteButton.click())
    expect(changes[3].events).toEqual(poseSwap())
    expectValidDrafts('transition', changes)
  })
})

describe('TimelineEditor — validation surfacing', () => {
  it('a transition without a pose-swap shows the schema error and heals via the toolbar button', async () => {
    const { changes, validations } = await mount('transition', linearTracks(), [])
    expect(validations[0].some((error) => error.includes('pose-swap'))).toBe(true)
    expect(container.textContent).toContain('pose-swap')
    const heal = [...container.querySelectorAll('button')].find((el) => el.textContent === '＋ 添加 pose-swap（换图）')
    if (heal === undefined) throw new Error('heal button missing')
    act(() => heal.click())
    expect(changes[0].events).toEqual([{ at: 0.5, type: 'pose-swap' }])
    expect(validations[validations.length - 1]).toEqual([])
    expect(container.querySelector('[aria-label="时间轴校验错误"]')).toBeNull()
  })

  it('an interaction carrying a pose-swap (invalid input) can delete it to heal', async () => {
    const { changes, validations } = await mount('interaction', linearTracks(), poseSwap())
    expect(validations[0].some((error) => error.includes('pose-swap'))).toBe(true)
    const marker = q<HTMLButtonElement>('[aria-label="pose-swap（换图）事件 @ 0.5"]')
    down(marker, 100)
    up(100)
    const eventInspector = q<HTMLElement>('[aria-label="事件检查器"]')
    const deleteButton = [...eventInspector.querySelectorAll('button')].find((el) => el.textContent === '删除事件')
    if (deleteButton === undefined) throw new Error('delete event button missing')
    act(() => deleteButton.click())
    expect(changes[0].events).toEqual([])
    expect(validations[validations.length - 1]).toEqual([])
  })
})

describe('TimelineEditor — keyboard operability', () => {
  const key = (el: Element, value: string): void => {
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    })
  }
  /** The click a focused button fires on Enter/Space: detail === 0. */
  const keyboardClick = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('Enter selects a diamond, ←/→ nudge by one grid step, Delete removes it', async () => {
    const { changes } = await mount('transition', duoTracks(), poseSwap())
    const diamonds = keyframeDiamonds('transition.scaleY')
    expect(diamonds).toHaveLength(3)

    // Enter/Space activation (detail === 0) selects and opens the inspector
    keyboardClick(diamonds[1])
    expect(inspector().textContent).toContain('@ 0.5')

    key(diamonds[1], 'ArrowRight')
    const moved = changes[changes.length - 1]
    expect(moved?.tracks[0]?.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 0.51, 1])

    // re-query: the nudge re-rendered the diamond row
    const again = keyframeDiamonds('transition.scaleY')
    expect(again[1]?.getAttribute('aria-label')).toContain('0.51')
    key(again[1], 'Delete')
    const removed = changes[changes.length - 1]
    expect(removed?.tracks[0]?.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 1])
  })

  it('event markers select with Enter; Delete follows the schema deletion rules', async () => {
    const { changes } = await mount('transition', linearTracks(), [
      { at: 0.3, type: 'pose-swap' },
      { at: 0.7, type: 'particle', effect: 'confetti' },
    ])
    const poseSwapMarker = q<HTMLButtonElement>('[aria-label="pose-swap（换图）事件 @ 0.3"]')
    const particleMarker = q<HTMLButtonElement>('[aria-label="粒子事件 confetti @ 0.7"]')

    keyboardClick(poseSwapMarker)
    expect(q<HTMLElement>('[aria-label="事件检查器"]').textContent).toContain('@ 0.3')

    // a transition's lone pose-swap is not deletable — neither by keyboard…
    const before = changes.length
    key(poseSwapMarker, 'Delete')
    expect(changes.length).toBe(before)
    expect(container.querySelector('[aria-label="事件轨"]')).not.toBeNull()

    // …while the particle event deletes fine
    key(particleMarker, 'Delete')
    expect(changes[changes.length - 1]?.events.map((event) => event.type)).toEqual(['pose-swap'])
  })
})

describe('TimelineEditor — keyboard focus retention & interaction pose-swap authoring', () => {
  const key = (el: Element, value: string): void => {
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    })
  }

  it('←/→ nudge keeps focus on the diamond — continuous keyboard nudging works', async () => {
    const { changes } = await mount('transition', duoTracks(), poseSwap())
    const diamonds = keyframeDiamonds('transition.scaleY')
    act(() => {
      diamonds[1]?.focus()
    })
    expect(document.activeElement).toBe(diamonds[1])

    key(diamonds[1] as Element, 'ArrowRight')
    expect(changes[changes.length - 1]?.tracks[0]?.keyframes[1]?.at).toBe(0.51)
    // The button must be the SAME DOM node after the re-render (an at-bearing
    // key would remount it and drop focus to <body>, killing step 2).
    const after = keyframeDiamonds('transition.scaleY')
    expect(document.activeElement).toBe(after[1])
    key(after[1] as Element, 'ArrowRight')
    expect(changes[changes.length - 1]?.tracks[0]?.keyframes[1]?.at).toBe(0.52)
  })

  it('interaction: the toolbar adds a TARGETED pose-swap; the inspector retargets it', async () => {
    const { changes, validations } = await mount('interaction', linearTracks(), [])
    const add = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === '＋ 添加 pose-swap（换图）',
    )
    if (add === undefined) throw new Error('add pose-swap button missing for interaction kind')
    act(() => {
      add.click()
    })
    // The schema requires every interaction pose-swap to name a target — a
    // fresh addition defaults to the idle slot and stays valid.
    expect(changes[0]?.events).toEqual([{ at: 0.5, type: 'pose-swap', pose: 'idle' }])
    expect(validations[validations.length - 1]).toEqual([])

    const marker = q<HTMLButtonElement>('[aria-label="pose-swap（换图）事件 @ 0.5"]')
    down(marker, 100)
    up(100)
    const eventInspector = q<HTMLElement>('[aria-label="事件检查器"]')
    const poseInput = eventInspector.querySelector('input[type="text"]')
    if (poseInput === null) throw new Error('pose target input missing')
    type(poseInput as HTMLInputElement, 'working')
    expect(changes[changes.length - 1]?.events).toEqual([{ at: 0.5, type: 'pose-swap', pose: 'working' }])
    expect(validations[validations.length - 1]).toEqual([])
    // The play-time semantics moved into the pose field's tooltip (UX: no
    // resident teaching hints) instead of telling the author to delete a
    // legal event.
    expect(controlRow(eventInspector, '目标姿态').getAttribute('data-tooltip')).toContain('播放时')

    // Clearing the target makes the draft invalid (schema) until fixed.
    type(poseInput as HTMLInputElement, '')
    expect(validations[validations.length - 1].some((error) => error.includes('pose'))).toBe(true)
  })
})
