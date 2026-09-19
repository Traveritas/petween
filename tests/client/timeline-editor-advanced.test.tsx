// @vitest-environment jsdom
/**
 * TimelineEditor advanced-mode tests (V1.2, /petween-animator/): the scrub
 * ruler (click parks the playhead, drag scrubs, arrows step it), the ms tick
 * ruler, zoom plumbing (Ctrl+wheel → onZoomChange), target snapping on
 * keyframe drags (playhead capture, disabled bypass), and the V1.1 default
 * staying chrome-free. Same synthetic-pointer/rect-stub conventions as
 * timeline-editor.test.tsx.
 */
import { act, useState, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineEditor } from '../../src/client/timeline/TimelineEditor'
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

const tracks = (): MotionTrack[] => [
  {
    property: 'transition.scaleY',
    keyframes: [
      { at: 0, value: 1 },
      { at: 1, value: 2 },
    ],
  },
]
const poseSwap = (): TimelineEvent[] => [{ at: 0.5, type: 'pose-swap' }]

interface AdvancedState {
  playheadAt: number | null
  zoom: number
  snapEnabled: boolean
}

interface MountResult {
  state(): AdvancedState
  changes: number
}

const mountAdvanced = async (initial: Partial<AdvancedState> = {}): Promise<MountResult> => {
  let latest: AdvancedState = { playheadAt: initial.playheadAt ?? null, zoom: initial.zoom ?? 1, snapEnabled: initial.snapEnabled ?? true }
  const playheadLog: number[] = []
  const Wrapper = (): JSX.Element => {
    const [draft, setDraft] = useState(() => ({ tracks: tracks(), events: poseSwap() }))
    const [playheadAt, setPlayheadAt] = useState<number | null>(initial.playheadAt ?? null)
    const [zoom, setZoom] = useState(initial.zoom ?? 1)
    const [snapEnabled, setSnapEnabled] = useState(initial.snapEnabled ?? true)
    latest = { playheadAt, zoom, snapEnabled }
    return (
      <TimelineEditor
        advanced
        kind={'transition' as AnimationKind}
        tracks={draft.tracks}
        events={draft.events}
        durationMs={1000}
        playheadAt={playheadAt}
        onPlayheadChange={(at) => {
          playheadLog.push(at)
          setPlayheadAt(at)
        }}
        zoom={zoom}
        onZoomChange={setZoom}
        snapEnabled={snapEnabled}
        onSnapEnabledChange={setSnapEnabled}
        onChange={(next) => setDraft(next)}
      />
    )
  }
  await act(async () => {
    root.render(<Wrapper />)
  })
  return {
    state: () => latest,
    get changes() {
      return playheadLog.length
    },
  }
}

const q = <T extends Element>(selector: string): T => {
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`missing: ${selector}`)
  return el as T
}

const stubRect = (el: Element, left: number, width: number): void => {
  el.getBoundingClientRect = () =>
    ({ left, width, right: left + width, top: 0, bottom: 28, height: 28, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
}

const pointer = (type: string, x: number, y = 10): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })

describe('advanced timeline (V1.2)', () => {
  it('renders the ms scrub ruler and the playhead line at the parked position', async () => {
    await mountAdvanced({ playheadAt: 0.4 })
    const ruler = q('[aria-label="播放头位置"]')
    expect(ruler.getAttribute('aria-valuenow')).toBe('400') // ms over durationMs=1000
    // adaptive ticks: jsdom has no layout → the 800px fallback lane over
    // 1000ms → 100ms steps (0/100ms/…/900ms + the 1s end tick)
    expect(ruler.textContent).toContain('100ms')
    expect(ruler.textContent).toContain('1s')
    // the playhead line: a zero-width element parked at 40% of the content box
    const playhead = [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(
      (el) => el.style.left === '40%',
    )
    expect(playhead).toBeDefined()
  })

  it('a ruler click parks the playhead (snapped to the grid)', async () => {
    const result = await mountAdvanced()
    const ruler = q('[aria-label="播放头位置"]')
    stubRect(ruler, 100, 800) // lane px → at = (x-100)/800
    act(() => {
      ruler.dispatchEvent(pointer('pointerdown', 100 + 0.132 * 800))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 100 + 0.132 * 800))
    })
    act(() => {
      window.dispatchEvent(pointer('pointerup', 100 + 0.132 * 800))
    })
    // ~0.132 raw with the unmeasured-lane grid (800px/1000ms → 100ms → 0.1): 0.15 is not a grid line
    expect(result.state().playheadAt).toBe(0.1)
  })

  it('ruler arrows step the playhead by one adaptive grid step', async () => {
    await mountAdvanced({ playheadAt: 0.5 })
    const ruler = q('[aria-label="播放头位置"]')
    act(() => {
      ruler.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      )
    })
    const now = Number(ruler.getAttribute('aria-valuenow'))
    expect(now).toBe(600) // 0.5 + one 0.1 grid step (unmeasured-lane fallback)
  })

  it('Ctrl+wheel zooms (onZoomChange grows past 1)', async () => {
    const result = await mountAdvanced()
    const ruler = q('[aria-label="播放头位置"]')
    // ruler → row → .timelineContent → .timelineScroll (the native wheel host)
    const scroll = ruler.parentElement?.parentElement?.parentElement
    if (!(scroll instanceof HTMLElement)) throw new Error('missing scroll container')
    const spy = vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(
      ({ left: 0, width: 800, right: 800, top: 0, bottom: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: 400, clientY: 10, bubbles: true, cancelable: true })
    await act(async () => {
      scroll.dispatchEvent(wheel)
    })
    expect(result.state().zoom).toBeGreaterThan(1)
    spy.mockRestore()
  })

  it('a keyframe drag snaps onto the parked playhead', async () => {
    await mountAdvanced({ playheadAt: 0.3 })
    const lane = q<HTMLDivElement>('[aria-label="轨道 transition.scaleY"]')
    stubRect(lane, 0, 800)
    // The playhead snap target needs the measured width: stub the content box.
    const diamonds = [...lane.querySelectorAll('button')] as HTMLButtonElement[]
    stubRect(diamonds[1], 800, 11) // the tail diamond at 100%
    act(() => {
      diamonds[1].dispatchEvent(pointer('pointerdown', 800))
    })
    act(() => {
      // drag to 0.31 raw — within the 6px threshold (6/800 = 0.0075) of 0.3
      window.dispatchEvent(pointer('pointermove', 0.31 * 800))
    })
    act(() => {
      window.dispatchEvent(pointer('pointerup', 0.31 * 800))
    })
    const laneNow = q('[aria-label="轨道 transition.scaleY"]')
    const moved = [...laneNow.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('@ 0.3'))
    expect(moved).toBeDefined() // landed exactly on the playhead, not on the grid
  })

  it('snap disabled (toggle off) leaves the raw clamped time', async () => {
    await mountAdvanced({ snapEnabled: false })
    const lane = q<HTMLDivElement>('[aria-label="轨道 transition.scaleY"]')
    stubRect(lane, 0, 800)
    const diamonds = [...lane.querySelectorAll('button')] as HTMLButtonElement[]
    stubRect(diamonds[1], 800, 11)
    act(() => {
      diamonds[1].dispatchEvent(pointer('pointerdown', 800))
    })
    act(() => {
      window.dispatchEvent(pointer('pointermove', 0.333 * 800))
    })
    act(() => {
      window.dispatchEvent(pointer('pointerup', 0.333 * 800))
    })
    const laneNow = q('[aria-label="轨道 transition.scaleY"]')
    // Snap disabled skips grid/target overrides, but the data layer still
    // stores at on the 0.01 grid (normalized time resolution): 0.333 → 0.33.
    const moved = [...laneNow.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('@ 0.33'))
    expect(moved).toBeDefined()
  })

  it('V1.1 default mode stays chrome-free (no scrub ruler, no snap toggle)', async () => {
    const Wrapper = (): JSX.Element => {
      const [draft, setDraft] = useState(() => ({ tracks: tracks(), events: poseSwap() }))
      return (
        <TimelineEditor
          kind="transition"
          tracks={draft.tracks}
          events={draft.events}
          onChange={setDraft}
        />
      )
    }
    await act(async () => {
      root.render(<Wrapper />)
    })
    expect(container.querySelector('[aria-label="播放头位置"]')).toBeNull()
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('吸附'))).toBe(false)
    expect(container.textContent).toContain('%') // the normalized ruler remains
  })

  // --- P13: multi-selection, marquee, batch edits, context menu -------------

  const duoTracks = (): MotionTrack[] => [
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0.1, value: 1 },
        { at: 0.5, value: 1.2 },
        { at: 0.9, value: 1 },
      ],
    },
  ]

  const mountDuo = async (): Promise<{ current: () => { tracks: MotionTrack[]; events: TimelineEvent[] } }> => {
    const state: { tracks: MotionTrack[]; events: TimelineEvent[] } = {
      tracks: duoTracks(),
      events: [{ at: 0.5, type: 'pose-swap' }],
    }
    const Wrapper = (): JSX.Element => {
      const [draft, setDraft] = useState(() => ({ tracks: state.tracks, events: state.events }))
      state.tracks = draft.tracks
      state.events = draft.events
      return (
        <TimelineEditor
          advanced
          kind="transition"
          tracks={draft.tracks}
          events={draft.events}
          durationMs={1000}
          onChange={setDraft}
        />
      )
    }
    await act(async () => {
      root.render(<Wrapper />)
    })
    return { current: () => state }
  }

  const diamondsOf = (): HTMLButtonElement[] => [
    ...q<HTMLDivElement>('[aria-label="轨道 transition.scaleY"]').querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="关键帧"]',
    ),
  ]

  const press = (el: Element, x: number, opts: { shift?: boolean; ctrl?: boolean } = {}): void => {
    act(() => {
      el.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, shiftKey: opts.shift, ctrlKey: opts.ctrl }),
      )
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: x }))
    })
  }

  it('shift/ctrl clicks build a multi-selection (aria-pressed reflects the set)', async () => {
    await mountDuo()
    const [a, b, c] = diamondsOf()
    press(a, 100)
    press(b, 500, { shift: true })
    expect(a.getAttribute('aria-pressed')).toBe('true')
    expect(b.getAttribute('aria-pressed')).toBe('true') // within the 0.1..0.5 range
    expect(c.getAttribute('aria-pressed')).toBe('false')
    press(b, 500, { ctrl: true }) // toggle off
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(a.getAttribute('aria-pressed')).toBe('true')
  })

  it('an empty-lane drag marquee-selects the time band across the track', async () => {
    await mountDuo()
    const lane = q<HTMLDivElement>('[aria-label="轨道 transition.scaleY"]')
    stubRect(lane, 0, 800)
    act(() => {
      lane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 0.12 * 800 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 0.55 * 800 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 0.55 * 800 }))
    })
    const [a, b, c] = diamondsOf()
    expect(a.getAttribute('aria-pressed')).toBe('false') // 0.1 outside [0.12, 0.55]
    expect(b.getAttribute('aria-pressed')).toBe('true') // 0.5 in band
    expect(c.getAttribute('aria-pressed')).toBe('false') // 0.9 outside
    // the pose-swap event at 0.5 joined the selection too
    const marker = q<HTMLButtonElement>('[aria-label^="pose-swap"]')
    expect(marker.getAttribute('aria-pressed')).toBe('true')
  })

  it('Delete removes the whole selection (window keyboard, body focus)', async () => {
    const mounted = await mountDuo()
    const [a, b] = diamondsOf()
    press(a, 100)
    press(b, 500, { shift: true })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(mounted.current().tracks[0].keyframes).toHaveLength(1) // only 0.9 survives
  })

  it('Ctrl+D duplicates the selection at +0.05 and selects the copies', async () => {
    const mounted = await mountDuo()
    const [, b] = diamondsOf()
    press(b, 500)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    const ats = mounted.current().tracks[0].keyframes.map((keyframe) => keyframe.at)
    expect(ats).toContain(0.55)
    // the copy (0.55) is the selected one now
    const fresh = diamondsOf()
    const selected = fresh.find((button) => button.getAttribute('aria-pressed') === 'true')
    expect(selected?.getAttribute('aria-label')).toContain('@ 0.55')
  })

  it('right-click on a diamond opens the context menu; 删除 removes it', async () => {
    const mounted = await mountDuo()
    const [a] = diamondsOf()
    act(() => {
      a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    })
    const menu = q('[role="menu"]')
    expect(menu.textContent).toContain('删除关键帧')
    const deleteItem = [...menu.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('删除关键帧'),
    )
    act(() => {
      deleteItem?.click()
    })
    expect(mounted.current().tracks[0].keyframes.map((keyframe) => keyframe.at)).toEqual([0.5, 0.9])
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('Esc clears the selection', async () => {
    await mountDuo()
    const [a] = diamondsOf()
    press(a, 100)
    expect(a.getAttribute('aria-pressed')).toBe('true')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(diamondsOf()[0].getAttribute('aria-pressed')).toBe('false')
  })

  it('inspectorTarget docks the inspector into the host element (no inline copy)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const Wrapper = (): JSX.Element => {
      const [draft, setDraft] = useState<{ tracks: MotionTrack[]; events: TimelineEvent[] }>(() => ({
        tracks: duoTracks(),
        events: [{ at: 0.5, type: 'pose-swap' }],
      }))
      return (
        <TimelineEditor
          advanced
          kind="transition"
          tracks={draft.tracks}
          events={draft.events}
          durationMs={1000}
          inspectorTarget={host}
          onChange={setDraft}
        />
      )
    }
    await act(async () => {
      root.render(<Wrapper />)
    })
    const lane = q<HTMLDivElement>('[aria-label="轨道 transition.scaleY"]')
    stubRect(lane, 0, 800)
    const [a] = diamondsOf()
    press(a, 80)
    const docked = host.querySelector('[aria-label="关键帧检查器"]')
    expect(docked).not.toBeNull()
    expect(container.querySelector('[aria-label="关键帧检查器"]')).toBeNull() // not inline too
    host.remove()
  })
})
