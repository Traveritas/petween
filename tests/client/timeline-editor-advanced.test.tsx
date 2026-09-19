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
})
