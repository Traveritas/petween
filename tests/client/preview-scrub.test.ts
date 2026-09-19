// @vitest-environment jsdom
/**
 * PreviewSession scrub API tests (V1.2 Phase 12): scrubDefinition writes the
 * sampled individual-transform styles onto the stage layers (compiler-parity
 * values), swaps the pose for NAMED pose-swap targets only, and endScrub
 * clears the inline styles again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { PetStage } from '../../src/client/overlay/pet-stage'
import { PreviewSession } from '../../src/client/preview-session'
import { installFakeAnimate } from '../motion/fake-animate'

let harness: ReturnType<typeof installFakeAnimate>

beforeEach(() => {
  harness = installFakeAnimate()
  vi.stubGlobal(
    'Image',
    class FakeImage {
      src = ''
      decode(): Promise<void> {
        return Promise.resolve()
      }
    },
  )
})

afterEach(() => {
  harness.restore()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function makeSession(): { session: PreviewSession; stage: PetStage } {
  const stage = new PetStage()
  document.body.appendChild(stage.element)
  const config = createDefaultPetweenConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of POSE_KEYS) {
    config.poses[key].assetId = `asset-${key}`
    assets[`asset-${key}`] = {
      id: `asset-${key}`,
      fileName: `${key}.webp`,
      mimeType: 'image/webp',
      width: 240,
      height: 240,
      sizeBytes: 1,
      sha256: 'x',
      url: `/petween-assets/asset-${key}`,
    }
  }
  const session = new PreviewSession({ stage, config, assets, auditionOnly: true })
  return { session, stage }
}

const definition = (events: AnimationDefinition['events'] = []): AnimationDefinition => ({
  version: 1,
  id: 'user:scrub',
  name: 'scrub',
  kind: 'interaction',
  durationMs: 400,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'sway.rotation',
      keyframes: [
        { at: 0, value: 0 },
        { at: 1, value: 10 },
      ],
    },
  ],
  events: events ?? [],
})

describe('PreviewSession.scrubDefinition (V1.2)', () => {
  it('applies the sampled value to the stage layer as an inline style', () => {
    const { session, stage } = makeSession()
    session.scrubDefinition(definition(), 0.5)
    expect(stage.layers.sway.style.rotate).toBe('5deg')
    expect(stage.layers.transition.style.rotate).toBe('') // untouched layer
  })

  it('re-scrubs freely and stays cheap (last call wins)', () => {
    const { session, stage } = makeSession()
    session.scrubDefinition(definition(), 0.25)
    session.scrubDefinition(definition(), 0.75)
    expect(stage.layers.sway.style.rotate).toBe('7.5deg')
  })

  it('endScrub clears the inline scrub styles', async () => {
    const { session, stage } = makeSession()
    session.scrubDefinition(definition(), 0.5)
    expect(stage.layers.sway.style.rotate).toBe('5deg')
    session.endScrub()
    expect(stage.layers.sway.style.rotate).toBe('')
  })

  it('a NAMED pose-swap at/before the scrub time swaps the pose', async () => {
    const { session, stage } = makeSession()
    const swapPose = vi.spyOn(stage, 'swapPose')
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    session.scrubDefinition(definition([{ at: 0.2, type: 'pose-swap', pose: 'waiting' }]), 0.5)
    await settle() // the preload → swapPose chain resolves on microtasks
    expect(swapPose).toHaveBeenCalledTimes(1)
    // before the swap time: the pose stays untouched
    swapPose.mockClear()
    session.scrubDefinition(definition([{ at: 0.2, type: 'pose-swap', pose: 'waiting' }]), 0.1)
    await settle()
    expect(swapPose).not.toHaveBeenCalled()
  })

  it('anonymous pose-swaps (transition semantics) never swap the pose', async () => {
    const { session, stage } = makeSession()
    const swapPose = vi.spyOn(stage, 'swapPose')
    session.scrubDefinition(
      { ...definition([{ at: 0.4, type: 'pose-swap' }]), kind: 'transition' },
      0.9,
    )
    await Promise.resolve()
    expect(swapPose).not.toHaveBeenCalled()
  })
})
