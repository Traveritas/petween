// @vitest-environment jsdom
/**
 * DragController tests (spec §27/§28): click vs drag thresholding, clamped
 * coordinates during and after a drag (32px always visible), pointercancel
 * persistence, and gesture hygiene (secondary buttons/pointers, dispose).
 * Synthetic MouseEvents stand in for PointerEvents — the controller reads
 * clientX/clientY and feature-detects pointerId/capture, which jsdom lacks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DragController, DRAG_THRESHOLD_PX } from '../../src/client/overlay/drag-controller'

const STAGE_SIZE = 160
const VIEWPORT = { width: 1024, height: 768 } // the jsdom window size

interface Harness {
  handle: HTMLDivElement
  controller: DragController
  moves: Array<{ x: number; y: number }>
  dragEnds: Array<{ x: number; y: number }>
  clicks: number
  position: { x: number; y: number }
}

const setup = (start: { x: number; y: number } = { x: 800, y: 500 }): Harness => {
  const handle = document.createElement('div')
  document.body.appendChild(handle)
  const harness: Harness = {
    handle,
    controller: undefined as unknown as DragController,
    moves: [],
    dragEnds: [],
    clicks: 0,
    position: start,
  }
  harness.controller = new DragController({
    handle,
    stageSize: () => STAGE_SIZE,
    getPosition: () => harness.position,
    onMove: (x, y) => {
      harness.position = { x, y }
      harness.moves.push({ x, y })
    },
    onDragEnd: (x, y) => harness.dragEnds.push({ x, y }),
    onClick: () => {
      harness.clicks += 1
    },
    viewport: () => VIEWPORT,
  })
  return harness
}

const pointer = (type: string, x: number, y: number, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init })

const down = (harness: Harness, x: number, y: number, init?: MouseEventInit): void => {
  harness.handle.dispatchEvent(pointer('pointerdown', x, y, init))
}
const move = (x: number, y: number): void => {
  window.dispatchEvent(pointer('pointermove', x, y))
}
const up = (x: number, y: number): void => {
  window.dispatchEvent(pointer('pointerup', x, y))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DragController — click vs drag (§28)', () => {
  it('travel below 4px is a click: no move, no drag persist', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(DRAG_THRESHOLD_PX - 2 + 100, 100) // 2px — under the threshold
    expect(harness.moves).toHaveLength(0)
    expect(harness.controller.isDragging).toBe(false)
    up(DRAG_THRESHOLD_PX - 2 + 100, 100)
    expect(harness.clicks).toBe(1)
    expect(harness.dragEnds).toHaveLength(0)
    harness.controller.dispose()
  })

  it('travel of 4px or more is a drag: moves apply, drag end persists, no click', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(100 + DRAG_THRESHOLD_PX, 100)
    expect(harness.controller.isDragging).toBe(true)
    move(160, 140)
    up(160, 140)
    expect(harness.clicks).toBe(0)
    expect(harness.dragEnds).toHaveLength(1)
    // start (800,500) + delta (60,40)
    expect(harness.moves[harness.moves.length - 1]).toEqual({ x: 860, y: 540 })
    expect(harness.dragEnds[0]).toEqual({ x: 860, y: 540 })
    harness.controller.dispose()
  })
})

describe('DragController — cursor feedback (drag affordance)', () => {
  it('switches to grabbing while dragging and restores the previous cursor on release', () => {
    const harness = setup()
    harness.handle.style.cursor = 'grab' // the stage sets this on the hit element
    down(harness, 100, 100)
    move(101, 100) // 1px: still a click-shaped gesture, cursor untouched
    expect(harness.handle.style.cursor).toBe('grab')
    move(100 + DRAG_THRESHOLD_PX, 100) // crosses the threshold: drag begins
    expect(harness.handle.style.cursor).toBe('grabbing')
    up(100 + DRAG_THRESHOLD_PX, 100)
    expect(harness.handle.style.cursor).toBe('grab') // restored after release
    harness.controller.dispose()
  })

  it('restores the cursor on pointercancel and dispose too, and never touches a click', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(200, 200)
    expect(harness.handle.style.cursor).toBe('grabbing')
    window.dispatchEvent(pointer('pointercancel', 200, 200))
    expect(harness.handle.style.cursor).toBe('')

    // dispose mid-gesture must not leave 'grabbing' behind either
    harness.handle.style.cursor = 'grab'
    down(harness, 100, 100)
    move(200, 200)
    harness.controller.dispose()
    expect(harness.handle.style.cursor).toBe('grab')
  })
})

describe('DragController — viewport clamp (§27)', () => {
  it('a drag far off-screen is pulled back, keeping 32px visible', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(5000, 5000)
    up(5000, 5000)
    // 800+4900 → clamped to viewport-32 on both axes
    expect(harness.dragEnds[0]).toEqual({ x: VIEWPORT.width - 32, y: VIEWPORT.height - 32 })
    harness.controller.dispose()
  })

  it('the negative edge clamps to size-32 beyond the viewport', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(-5000, -5000)
    up(-5000, -5000)
    expect(harness.dragEnds[0]).toEqual({ x: -(STAGE_SIZE - 32), y: -(STAGE_SIZE - 32) })
    harness.controller.dispose()
  })

  it('every intermediate move is clamped too', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(5000, 100)
    expect(harness.moves[harness.moves.length - 1]).toEqual({ x: VIEWPORT.width - 32, y: 500 })
    up(5000, 100)
    harness.controller.dispose()
  })
})

describe('DragController — onDragStart seam', () => {
  it('fires once when the threshold is crossed; a click never fires it', () => {
    const handle = document.createElement('div')
    document.body.appendChild(handle)
    const dragStarts: number[] = []
    const controller = new DragController({
      handle,
      stageSize: () => STAGE_SIZE,
      getPosition: () => ({ x: 800, y: 500 }),
      onMove: () => {},
      onDragEnd: () => {},
      onClick: () => {},
      onDragStart: () => {
        dragStarts.push(1)
      },
      viewport: () => VIEWPORT,
    })

    // a click: under the threshold, onDragStart stays silent
    handle.dispatchEvent(pointer('pointerdown', 100, 100))
    move(100 + DRAG_THRESHOLD_PX - 1, 100)
    up(100 + DRAG_THRESHOLD_PX - 1, 100)
    expect(dragStarts).toHaveLength(0)

    // a drag: crossing the threshold fires exactly once, further moves do not re-fire
    handle.dispatchEvent(pointer('pointerdown', 100, 100))
    move(100 + DRAG_THRESHOLD_PX, 100)
    expect(dragStarts).toHaveLength(1)
    move(160, 140)
    expect(dragStarts).toHaveLength(1)
    up(160, 140)
    expect(dragStarts).toHaveLength(1)
    controller.dispose()
  })
})

describe('DragController — gesture hygiene', () => {
  it('pointercancel after real travel still persists the final position', () => {
    const harness = setup()
    down(harness, 100, 100)
    move(200, 200)
    window.dispatchEvent(pointer('pointercancel', 200, 200))
    expect(harness.clicks).toBe(0)
    expect(harness.dragEnds).toEqual([{ x: 900, y: 600 }])
    expect(harness.controller.isDragging).toBe(false)
    harness.controller.dispose()
  })

  it('ignores non-main buttons and never starts a gesture', () => {
    const harness = setup()
    down(harness, 100, 100, { button: 2 })
    move(300, 300)
    up(300, 300)
    expect(harness.moves).toHaveLength(0)
    expect(harness.clicks).toBe(0)
    expect(harness.dragEnds).toHaveLength(0)
    harness.controller.dispose()
  })

  it('ignores a second pointerdown while a gesture is active', () => {
    const harness = setup()
    down(harness, 100, 100)
    down(harness, 900, 900) // a second finger lands elsewhere
    move(160, 160) // travel measured from the FIRST origin
    up(160, 160)
    expect(harness.dragEnds).toEqual([{ x: 860, y: 560 }])
    harness.controller.dispose()
  })

  it('dispose mid-gesture ends the drag with a final onDragEnd and swallows the rest (L2)', () => {
    const harness = setup()
    const onUp = vi.fn()
    down(harness, 100, 100)
    move(200, 200)
    harness.controller.dispose()
    // Real travel happened: the gesture ends like a cancel — the final
    // position is handed to onDragEnd so teardown can persist it.
    expect(harness.clicks).toBe(0)
    expect(harness.dragEnds).toEqual([{ x: 900, y: 600 }])
    expect(harness.controller.isDragging).toBe(false)
    window.addEventListener('pointerup', onUp)
    up(200, 200)
    expect(harness.clicks).toBe(0) // the post-dispose gesture is dead
    expect(harness.dragEnds).toHaveLength(1)
    window.removeEventListener('pointerup', onUp)
  })
})
