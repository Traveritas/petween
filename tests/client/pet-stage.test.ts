// @vitest-environment jsdom
/**
 * PetStage tests (spec §3.4 layered DOM, §12 anchor alignment, §16.3 preload,
 * §27 position clamp). Pure DOM — the motion engine is not involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PoseAnchor, PoseKey, ResolvedPose } from '../../src/core/types'
import { computeAnchorLayout, MIN_VISIBLE_PX, PetStage } from '../../src/client/overlay/pet-stage'
import { installFakeAnimate } from '../motion/fake-animate'

const STAGE_SIZE = 160
const WORLD_ANCHOR: PoseAnchor = { x: 0.5, y: 0.9 }

const makePose = (partial: {
  key?: PoseKey
  url?: string
  width?: number
  height?: number
  anchor?: PoseAnchor
  zoom?: number
}): ResolvedPose => {
  const key = partial.key ?? 'idle'
  return {
    poseKey: key,
    asset: {
      id: key,
      url: partial.url ?? `https://example.test/${key}.webp`,
      width: partial.width ?? 240,
      height: partial.height ?? 240,
    },
    anchor: partial.anchor ?? { x: 0.5, y: 0.96 },
    zoom: partial.zoom ?? 1,
  }
}

const imageOf = (stage: PetStage): HTMLImageElement => {
  const image = stage.element.querySelector('img')
  if (image === null) throw new Error('pose img missing')
  return image
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('PetStage — layered DOM (§3.4)', () => {
  it('builds the exact ownership chain with the four motion layers exposed', () => {
    const stage = new PetStage()
    const classChain: string[] = []
    let current: Element | null = stage.element
    while (current !== null) {
      classChain.push(current.className)
      current = current.firstElementChild
    }
    expect(classChain).toEqual([
      'dsh-motion-pet-position',
      'dsh-motion-pet-user-scale',
      'dsh-motion-pet-sway',
      'dsh-motion-pet-bounce',
      'dsh-motion-pet-breathe',
      'dsh-motion-pet-transition',
      'dsh-motion-pet-stage',
      'dsh-motion-pet-pose', // the img is the stage layer's first (leaf) child
    ])
    expect(stage.layers.sway.className).toBe('dsh-motion-pet-sway')
    expect(stage.layers.bounce.className).toBe('dsh-motion-pet-bounce')
    expect(stage.layers.breathe.className).toBe('dsh-motion-pet-breathe')
    expect(stage.layers.transition.className).toBe('dsh-motion-pet-transition')
    // every motion layer's box is the stage square, origin at the world anchor
    for (const layer of [stage.layers.sway, stage.layers.bounce, stage.layers.breathe, stage.layers.transition]) {
      expect(layer.style.transformOrigin).toBe('50% 90%')
      expect(layer.style.width).toBe('100%')
      expect(layer.style.height).toBe('100%')
    }
    stage.dispose()
  })

  it('keeps the pointer-events contract: click-through shell, interactive body', () => {
    const stage = new PetStage()
    expect(stage.element.style.pointerEvents).toBe('none')
    expect(stage.layers.transition.firstElementChild).not.toBeNull()
    const stageLayer = stage.layers.transition.firstElementChild as HTMLElement
    expect(stageLayer.style.pointerEvents).toBe('auto')
    stage.dispose()
  })
})

describe('PetStage — anchor alignment (§12)', () => {
  it('lays the image out so the pose anchor lands on the world anchor', () => {
    const stage = new PetStage({ size: STAGE_SIZE })
    stage.swapPose(makePose({ width: 240, height: 240, anchor: { x: 0.5, y: 0.96 } }))
    const image = imageOf(stage)
    expect(image.style.width).toBe('160px') // contain-fit into the square
    expect(image.style.height).toBe('160px')
    expect(image.style.left).toBe('0px')
    expect(image.style.top).toBe('-9.6px') // 0.9*160 - 0.96*160
    stage.dispose()
  })

  it('keeps the world anchor fixed when swapping poses with different anchors', () => {
    const stage = new PetStage({ size: STAGE_SIZE })
    const image = imageOf(stage)
    const worldAnchorY = (): number => Number.parseFloat(image.style.top) + Number.parseFloat(image.style.height) * anchorY
    let anchorY = 0.96
    stage.swapPose(makePose({ key: 'idle', anchor: { x: 0.5, y: anchorY } }))
    const idleWorldY = worldAnchorY()
    expect(idleWorldY).toBeCloseTo(WORLD_ANCHOR.y * STAGE_SIZE, 6)

    anchorY = 0.8
    stage.swapPose(makePose({ key: 'thinking', anchor: { x: 0.5, y: anchorY } }))
    expect(image.style.top).toBe('16px') // compensation actually moved the image
    expect(worldAnchorY()).toBeCloseTo(idleWorldY, 6) // zero world displacement
    stage.dispose()
  })

  it('respects natural aspect ratio and zoom', () => {
    const stage = new PetStage({ size: STAGE_SIZE })
    stage.swapPose(makePose({ width: 480, height: 120, anchor: { x: 0.5, y: 1 } }))
    const image = imageOf(stage)
    expect(image.style.width).toBe('160px')
    expect(image.style.height).toBe('40px')
    expect(image.style.top).toBe('104px') // 144 - 40

    stage.swapPose(makePose({ key: 'thinking', width: 240, height: 240, anchor: { x: 0.5, y: 0.96 }, zoom: 2 }))
    expect(image.style.width).toBe('320px')
    expect(image.style.left).toBe('-80px') // 80 - 0.5*320
    expect(image.style.top).toBe('-163.2px') // 144 - 0.96*320
    stage.dispose()
  })

  it('keeps the world anchor fixed for a 2:1 pose with a custom anchor and zoom ≠ 1', () => {
    const stage = new PetStage({ size: STAGE_SIZE })
    const image = imageOf(stage)
    // The pose anchor's stage-space position; must be the world anchor exactly.
    const worldOf = (anchor: PoseAnchor): { x: number; y: number } => ({
      x: Number.parseFloat(image.style.left) + Number.parseFloat(image.style.width) * anchor.x,
      y: Number.parseFloat(image.style.top) + Number.parseFloat(image.style.height) * anchor.y,
    })

    const anchorA: PoseAnchor = { x: 0.5, y: 0.96 }
    stage.swapPose(makePose({ key: 'idle', anchor: anchorA })) // square, zoom 1
    const before = worldOf(anchorA)
    expect(before.x).toBeCloseTo(WORLD_ANCHOR.x * STAGE_SIZE, 6)
    expect(before.y).toBeCloseTo(WORLD_ANCHOR.y * STAGE_SIZE, 6)

    // Non-square image + off-center anchor + zoom: zero world displacement.
    const anchorB: PoseAnchor = { x: 0.3, y: 0.7 }
    stage.swapPose(makePose({ key: 'thinking', width: 480, height: 240, anchor: anchorB, zoom: 1.5 }))
    expect(image.style.width).toBe('240px') // fit 1/3 × 480 × 1.5
    expect(image.style.height).toBe('120px')
    expect(image.style.left).toBe('8px') // 80 - 0.3*240
    expect(image.style.top).toBe('60px') // 144 - 0.7*120
    const after = worldOf(anchorB)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    stage.dispose()
  })

  it('degrades to a centered stage fill while the image size is unknown', () => {
    const stage = new PetStage({ size: STAGE_SIZE })
    stage.swapPose(makePose({ width: 0, height: 0 })) // jsdom naturalWidth is 0 too
    const image = imageOf(stage)
    expect(image.style.left).toBe('0px')
    expect(image.style.top).toBe('0px')
    expect(image.style.width).toBe('160px')
    expect(image.style.height).toBe('160px')
    stage.dispose()
  })

  it('computeAnchorLayout is pure and matches the stage math', () => {
    const layout = computeAnchorLayout({
      stageSize: STAGE_SIZE,
      worldAnchor: WORLD_ANCHOR,
      poseAnchor: { x: 0.25, y: 0.5 },
      zoom: 1,
      naturalWidth: 100,
      naturalHeight: 200,
    })
    // fit = min(160/100, 160/200) = 0.8 → 80×160
    expect(layout.width).toBeCloseTo(80, 6)
    expect(layout.height).toBeCloseTo(160, 6)
    expect(layout.offsetX).toBeCloseTo(0.5 * STAGE_SIZE - 0.25 * 80, 6)
    expect(layout.offsetY).toBeCloseTo(0.9 * STAGE_SIZE - 0.5 * 160, 6)
    // unknown image size → centered fill
    expect(
      computeAnchorLayout({
        stageSize: STAGE_SIZE,
        worldAnchor: WORLD_ANCHOR,
        poseAnchor: { x: 0.5, y: 0.96 },
        zoom: 1,
        naturalWidth: 0,
        naturalHeight: 0,
      }),
    ).toEqual({ width: STAGE_SIZE, height: STAGE_SIZE, offsetX: 0, offsetY: 0 })
  })
})

describe('PetStage — swapPose / preload (§16.3)', () => {
  it('swapPose updates the img src synchronously', () => {
    const stage = new PetStage()
    const image = imageOf(stage)
    expect(image.getAttribute('src')).toBeNull()
    const pose = makePose({})
    stage.swapPose(pose)
    expect(image.getAttribute('src')).toBe(pose.asset.url)
    expect(stage.currentPose).toBe(pose)
    stage.dispose()
  })

  it('preload resolves after decoding every pose image', async () => {
    const decoded: string[] = []
    class FakeImage {
      src = ''
      decode(): Promise<void> {
        decoded.push(this.src)
        return Promise.resolve()
      }
    }
    vi.stubGlobal('Image', FakeImage)
    const stage = new PetStage()
    await stage.preload([makePose({ key: 'idle' }), makePose({ key: 'thinking' })])
    expect(decoded).toEqual(['https://example.test/idle.webp', 'https://example.test/thinking.webp'])
    // preloaded URLs are not fetched again
    await stage.preload([makePose({ key: 'idle' })])
    expect(decoded).toHaveLength(2)
    stage.dispose()
  })

  it('preload tolerates undecodable images', async () => {
    class FakeImage {
      src = ''
      decode(): Promise<void> {
        return Promise.reject(new Error('broken'))
      }
    }
    vi.stubGlobal('Image', FakeImage)
    const stage = new PetStage()
    await expect(stage.preload([makePose({})])).resolves.toBeUndefined()
    stage.dispose()
  })

  it('a failed preload is not marked: the next preload retries the URL', async () => {
    const attempts: string[] = []
    let broken = true
    class FakeImage {
      src = ''
      decode(): Promise<void> {
        attempts.push(this.src)
        return broken ? Promise.reject(new Error('broken')) : Promise.resolve()
      }
    }
    vi.stubGlobal('Image', FakeImage)
    const stage = new PetStage()
    const pose = makePose({})
    await stage.preload([pose]) // fails, swallowed
    await stage.preload([pose]) // must retry — the failure was not cached
    expect(attempts).toEqual([pose.asset.url, pose.asset.url])

    broken = false
    await stage.preload([pose]) // succeeds and marks
    await stage.preload([pose]) // now cached: no further fetch
    expect(attempts).toHaveLength(3)
    stage.dispose()
  })
})

describe('PetStage — scale, position (§27), reduced motion, marker, dispose', () => {
  it('setUserScale writes the user-scale layer only', () => {
    const stage = new PetStage()
    stage.setUserScale(1.4)
    const userScaleLayer = stage.element.firstElementChild as HTMLElement
    expect(userScaleLayer.style.transform).toBe('scale(1.4)')
    expect(userScaleLayer.style.transformOrigin).toBe('50% 90%') // grows from the ground
    stage.dispose()
  })

  it('setPosition clamps into the viewport keeping MIN_VISIBLE_PX visible', () => {
    const stage = new PetStage() // jsdom viewport is 1024×768
    stage.setPosition(5000, 5000)
    expect(stage.element.style.left).toBe(`${1024 - MIN_VISIBLE_PX}px`)
    expect(stage.element.style.top).toBe(`${768 - MIN_VISIBLE_PX}px`)
    stage.setPosition(-5000, -5000)
    expect(stage.element.style.left).toBe(`${-(stage.stageSize - MIN_VISIBLE_PX)}px`)
    expect(stage.element.style.top).toBe(`${-(stage.stageSize - MIN_VISIBLE_PX)}px`)
    stage.dispose()
  })

  it('reducedMotion is pushed in by the outer layer, never self-detected', () => {
    const stage = new PetStage()
    expect(stage.reducedMotion).toBe(false)
    stage.setReducedMotion(true)
    expect(stage.reducedMotion).toBe(true)
    stage.dispose()
    expect(new PetStage({ reducedMotion: true }).reducedMotion).toBe(true)
  })

  it('toggles the anchor marker at the world anchor position', () => {
    const stage = new PetStage()
    const marker = stage.element.querySelector('.dsh-motion-pet-anchor-marker') as HTMLElement
    expect(marker.style.display).toBe('none')
    stage.setAnchorMarkerVisible(true)
    expect(marker.style.display).toBe('block')
    expect(marker.style.left).toBe('50%')
    expect(marker.style.top).toBe('90%')
    stage.dispose()
  })

  it('setSize resizes the square and re-runs the anchor layout', () => {
    const stage = new PetStage()
    stage.swapPose(makePose({}))
    stage.setSize(240)
    expect(stage.element.style.width).toBe('240px')
    const image = imageOf(stage)
    expect(image.style.width).toBe('240px')
    expect(image.style.top).toBe('-14.4px') // 0.9*240 - 0.96*240
    stage.dispose()
  })

  it('dispose removes the DOM and swapPose afterwards is a no-op', () => {
    const stage = new PetStage()
    document.body.appendChild(stage.element)
    stage.dispose()
    expect(document.body.querySelector('.dsh-motion-pet-position')).toBeNull()
    stage.swapPose(makePose({}))
    expect(imageOf(stage).getAttribute('src')).toBeNull() // detached element untouched
  })
})

describe('PetStage — particle layer (§8.5)', () => {
  it('mounts an inert particle layer above the pose image', () => {
    const stage = new PetStage()
    const layer = stage.element.querySelector('.dsh-motion-pet-particles') as HTMLElement
    expect(layer).not.toBeNull()
    expect(layer.parentElement?.className).toBe('dsh-motion-pet-stage')
    expect(layer.previousElementSibling?.className).toBe('dsh-motion-pet-pose') // above the img
    expect(layer.style.position).toBe('absolute')
    expect(layer.style.left).toBe('0px')
    expect(layer.style.right).toBe('0px')
    expect(layer.style.overflow).toBe('visible')
    expect(layer.style.pointerEvents).toBe('none')
    stage.dispose()
  })

  it('emitParticle bursts into the layer; reduced-motion and the config switch gate it', () => {
    const harness = installFakeAnimate()
    try {
      const stage = new PetStage()
      const layer = stage.element.querySelector('.dsh-motion-pet-particles') as HTMLElement
      stage.emitParticle('confetti')
      expect(layer.children.length).toBeGreaterThan(0)
      expect(harness.animations.length).toBe(layer.children.length)

      stage.setReducedMotion(true) // gates further bursts
      stage.emitParticle('confetti')
      expect(harness.animations.length).toBe(layer.children.length)

      stage.setReducedMotion(false)
      stage.setParticlesEnabled(false) // the advanced.particles switch
      stage.emitParticle('confetti')
      expect(harness.animations.length).toBe(layer.children.length)

      stage.setParticlesEnabled(true)
      stage.emitParticle('sparkle')
      expect(harness.animations.length).toBeGreaterThan(layer.children.length - 1)
      stage.dispose()
      expect(layer.children).toHaveLength(0) // dispose cleared the burst
    } finally {
      harness.restore()
    }
  })

  it('the particles:false option starts the emitter gated', () => {
    const harness = installFakeAnimate()
    try {
      const stage = new PetStage({ particles: false })
      stage.emitParticle('confetti')
      expect(harness.animations).toHaveLength(0)
      stage.dispose()
    } finally {
      harness.restore()
    }
  })
})
