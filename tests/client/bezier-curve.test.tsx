// @vitest-environment jsdom
/**
 * BezierCurveEditor tests (P14): mapping math round-trips, the plotted curve
 * shape, and handle drags emitting clamped/rounded cubic-bezier point pairs.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BEZIER_VIEW_Y_MAX,
  BEZIER_VIEW_Y_MIN,
  BezierCurveEditor,
  bezierAxis,
  curveXFromView,
  curveYFromView,
  viewX,
  viewY,
} from '../../src/client/timeline/BezierCurveEditor'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

interface BezierPointsSpy {
  calls: Array<[number, number, number, number]>
}

const mount = async (points: readonly [number, number, number, number]): Promise<BezierPointsSpy> => {
  const spy: BezierPointsSpy = { calls: [] }
  await act(async () => {
    root.render(<BezierCurveEditor points={points} onChange={(next) => spy.calls.push([...next] as [number, number, number, number])} />)
  })
  return spy
}

const svg = (): SVGSVGElement => {
  const el = container.querySelector('svg')
  if (el === null) throw new Error('missing svg')
  return el as SVGSVGElement
}

const handles = (): SVGCircleElement[] => [...svg().querySelectorAll('circle')]

describe('mapping math', () => {
  it('viewX/viewY round-trips the x axis and the y window', () => {
    for (const x of [0, 0.25, 0.5, 1]) {
      expect(curveXFromView(viewX(x))).toBeCloseTo(x, 10)
    }
    for (const y of [BEZIER_VIEW_Y_MIN, 0, 0.5, 1, BEZIER_VIEW_Y_MAX]) {
      expect(curveYFromView(viewY(y))).toBeCloseTo(y, 10)
    }
    // y grows downward in the viewBox: y=1 (full progress) sits at the TOP,
    // i.e. a SMALLER viewBox value than y=0
    expect(viewY(1)).toBeLessThan(viewY(0))
  })

  it('bezierAxis hits the endpoints and honors the control points', () => {
    expect(bezierAxis(0, 0.3, 0.7)).toBe(0)
    expect(bezierAxis(1, 0.3, 0.7)).toBe(1)
    expect(bezierAxis(0.5, 1, 0)).toBeCloseTo(0.5, 10) // 3·0.25·0.5·1 + 3·0.5·0.25·0 + 0.125
  })
})

describe('BezierCurveEditor', () => {
  it('renders the curve and both handles with an accessible label', async () => {
    await mount([0.2, 0.1, 0.8, 1.9])
    expect(svg().getAttribute('role')).toBe('img')
    expect(svg().getAttribute('aria-label')).toContain('cubic-bezier(0.2, 0.1, 0.8, 1.9)')
    expect(handles()).toHaveLength(2)
    expect(svg().querySelector('path.bezierCurve, path')?.getAttribute('d')).toContain('M')
  })

  it('a handle drag emits clamped, rounded points (x in 0..1)', async () => {
    const spy = await mount([0.2, 0.1, 0.8, 1.9])
    const svgEl = svg()
    // jsdom has no layout — stub a square client box (viewBox units = px).
    svgEl.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const [h1] = handles()
    act(() => {
      h1.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 60, clientY: 30 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 150, clientY: -50 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 150, clientY: -50 }))
    })
    expect(spy.calls.length).toBeGreaterThan(0)
    const last = spy.calls[spy.calls.length - 1]
    expect(last[0]).toBeLessThanOrEqual(1) // x clamped
    expect(last[0]).toBeGreaterThanOrEqual(0)
    expect(last[1]).toBeGreaterThanOrEqual(BEZIER_VIEW_Y_MIN - 0.001)
    expect(last[1]).toBeLessThanOrEqual(BEZIER_VIEW_Y_MAX + 0.001)
    // P2 untouched
    expect(last[2]).toBe(0.8)
    expect(last[3]).toBe(1.9)
  })

  it('no layout (zero-size svg): drags stay silent instead of guessing', async () => {
    const spy = await mount([0.2, 0.1, 0.8, 1.9])
    const [h1] = handles()
    act(() => {
      h1.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 60, clientY: 30 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 70, clientY: 30 }))
    })
    expect(spy.calls).toHaveLength(0)
  })
})
