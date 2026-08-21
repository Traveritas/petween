// @vitest-environment jsdom
/**
 * PetRenderer tests (spec §16.2, §2.1): the React wrapper owns the PetStage
 * lifecycle only — mount creates the stage and hands it up via onStage,
 * unmount detaches (onStage(null)) and disposes the DOM; prop changes sync
 * into the live stage without recreating it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PetRenderer, type PetRendererProps } from '../../src/client/overlay/PetRenderer'
import { PetStage } from '../../src/client/overlay/pet-stage'

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

const render = (props: PetRendererProps): void => {
  act(() => {
    root.render(<PetRenderer {...props} />)
  })
}

/** Collects every onStage callback value, in order. */
const stageLog = (): { log: Array<PetStage | null>; onStage: (stage: PetStage | null) => void } => {
  const log: Array<PetStage | null> = []
  return {
    log,
    onStage: (stage) => {
      log.push(stage)
    },
  }
}

describe('PetRenderer', () => {
  it('renders nothing when visible=false (§2.1: no image → no overlay)', () => {
    const { log, onStage } = stageLog()
    render({ visible: false, onStage })
    expect(container.childElementCount).toBe(0)
    expect(log).toEqual([])
  })

  it('mounts the stage DOM and hands it up; unmount notifies then disposes', () => {
    const { log, onStage } = stageLog()
    render({ onStage })
    expect(log).toHaveLength(1)
    const stage = log[0]
    if (stage === null) throw new Error('stage missing')
    expect(stage).toBeInstanceOf(PetStage)
    expect(container.querySelector('.dsh-motion-pet-position')).toBe(stage.element)

    act(() => {
      root.unmount()
      mounted = false
    })
    // the controller is notified BEFORE the DOM is removed, so it can dispose
    // its MotionDirector (owner of all in-flight WAAPI animations, §23)
    expect(log).toEqual([stage, null])
    expect(container.querySelector('.dsh-motion-pet-position')).toBeNull()
  })

  it('syncs reducedMotion and the anchor marker into the live stage', () => {
    const { log, onStage } = stageLog()
    render({ onStage, reducedMotion: true })
    expect(log).toHaveLength(1)
    const stage = log[0]
    if (stage === null) throw new Error('stage missing')
    expect(stage.reducedMotion).toBe(true)
    const marker = stage.element.querySelector('.dsh-motion-pet-anchor-marker') as HTMLElement
    expect(marker.style.display).toBe('none')

    render({ onStage, reducedMotion: false, showAnchorMarker: true })
    expect(stage.reducedMotion).toBe(false)
    expect(marker.style.display).toBe('block')
    // the stage was NOT recreated: a MotionDirector bound to it stays valid
    expect(log).toHaveLength(1)
  })

  it('recreates the stage when visibility flips false → true', () => {
    const { log, onStage } = stageLog()
    render({ onStage, visible: false })
    expect(log).toEqual([])
    render({ onStage, visible: true })
    expect(log).toHaveLength(1)
    expect(log[0]).toBeInstanceOf(PetStage)
    expect(container.querySelector('.dsh-motion-pet-position')).not.toBeNull()
  })
})
