// @vitest-environment jsdom
/**
 * Extension service tests (motion-pet/client): the three windows degrade
 * through the "no active session" window (the overlay mounts/unmounts with
 * §2.1), snapshots follow drag/driver/target changes, the position-driver
 * lease arbitrates with user drags and remote overlay coordinates, and
 * playAnimation implements the interrupt contract (§10.2 preemption + the
 * PreviewSession-style instance tracking). Same harness as
 * overlay-session.test.ts: fake timers, recorded WAAPI, stubbed Image, an
 * injected-fetch ConfigHub and a vi.fn patchConfig.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPatch } from '../../src/client/api'
import { ConfigHub } from '../../src/client/config-hub'
import {
  clearActivePetSession,
  motionPetClientService,
  setActivePetSession,
  type StageSnapshot,
} from '../../src/client/extension-service'
import { OverlaySession } from '../../src/client/overlay-session'
import { PetOverlay } from '../../src/client/overlay/PetOverlay'
import { PetStage } from '../../src/client/overlay/pet-stage'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { AssetMeta, MotionPetConfig } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let harness: FakeAnimateHarness

/** The service is a module singleton: every subscriber must leave with its test. */
const serviceUnsubscribers: Array<() => void> = []
/** Every session built by setup(), torn down in afterEach. */
const contexts: Setup[] = []
/** React roots mounted by a test; unmounted in afterEach even on failure. */
const reactRoots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers()
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
})

afterEach(() => {
  for (const unsubscribe of serviceUnsubscribers.splice(0)) unsubscribe()
  for (const root of reactRoots.splice(0)) act(() => root.unmount()) // clears the bridge too
  for (const context of contexts.splice(0)) {
    clearActivePetSession(context.session) // no-op unless still attached
    context.session.dispose()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  harness.restore()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const assetUrl = (key: string): string => `https://example.test/${key}.webp`

const makeAsset = (id: string): AssetMeta => ({
  id,
  fileName: `${id}.webp`,
  mimeType: 'image/webp',
  width: 240,
  height: 240,
  sizeBytes: 1,
  sha256: `sha-${id}`,
  url: assetUrl(id),
})

interface Setup {
  stage: PetStage
  config: MotionPetConfig
  assets: Record<string, AssetMeta>
  hub: ConfigHub
  session: OverlaySession
  patchConfig: ReturnType<typeof vi.fn>
}

const setup = (
  mutateConfig?: (config: MotionPetConfig, assets: Record<string, AssetMeta>) => void,
  customs: AnimationDefinition[] = [],
): Setup => {
  const stage = new PetStage()
  document.body.appendChild(stage.element)
  const config = createDefaultMotionPetConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of POSE_KEYS) {
    config.poses[key].assetId = `asset-${key}`
    assets[`asset-${key}`] = makeAsset(`asset-${key}`)
  }
  mutateConfig?.(config, assets)
  const hub = new ConfigHub({
    fetchConfig: vi.fn(async () => ({ config, assets })),
    fetchAnimations: vi.fn(async () => ({ customs: structuredClone(customs), warnings: [] })),
  })
  hub.publish({ config, assets, customs: structuredClone(customs) }) // seeds the cache synchronously
  // Simulates the host: merge the patch onto the current config, return it.
  const patchConfig = vi.fn(async (patch: ConfigPatch) => {
    const merged = structuredClone(hub.getCurrent()?.config ?? config)
    if (patch.overlay !== undefined) merged.overlay = { ...merged.overlay, ...patch.overlay }
    return merged
  })
  const session = new OverlaySession({ stage, hub, patchConfig })
  const context: Setup = { stage, config, assets, hub, session, patchConfig }
  contexts.push(context)
  return context
}

const flushUntil = async (condition: () => boolean): Promise<void> => {
  for (let guard = 0; guard < 20 && !condition(); guard += 1) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

/** Drives every finite animation to completion; only infinite loops remain. */
const settleTransitions = async (): Promise<void> => {
  for (let guard = 0; guard < 20; guard += 1) {
    const finite = harness.pending().filter((animation) => animation.options.iterations !== Infinity)
    if (finite.length === 0) return
    for (const animation of finite) animation.finish()
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error('animations did not settle')
}

const boot = async ({ session }: Setup): Promise<void> => {
  const started = session.start()
  await flushUntil(() => harness.animations.length > 0)
  await settleTransitions()
  await started
}

const publish = (
  hub: ConfigHub,
  config: MotionPetConfig,
  assets: Record<string, AssetMeta>,
  customs: AnimationDefinition[] = [],
): void => {
  hub.publish({ config: structuredClone(config), assets: { ...assets }, customs: structuredClone(customs) })
}

const pointer = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })

const makeCustom = (id: string, durationMs = 300): AnimationDefinition => ({
  version: 1,
  id,
  name: `Custom ${id}`,
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

describe('extension service — no active session', () => {
  it('all three APIs degrade to null', () => {
    expect(motionPetClientService.getStageSnapshot()).toBeNull()
    expect(motionPetClientService.requestPositionControl()).toBeNull()
    expect(motionPetClientService.playAnimation('builtin:comic-pop')).toBeNull()
  })

  it('subscribeStage immediately pushes null', () => {
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(motionPetClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    expect(seen).toEqual([null])
  })
})

describe('extension service — active session', () => {
  it('getStageSnapshot folds the default corner into px and reports idle after boot', async () => {
    const context = setup()
    setActivePetSession(context.session)
    // before boot: no target yet, boot not finished
    const early = motionPetClientService.getStageSnapshot()
    expect(early?.visualState).toBeNull()
    expect(early?.activityMode).toBeNull()
    expect(early?.started).toBe(false)

    await boot(context)
    const snapshot = motionPetClientService.getStageSnapshot()
    expect(snapshot).not.toBeNull()
    // jsdom viewport 1024×768, 160px stage, 24px margin (§27 default corner)
    expect(snapshot?.x).toBe(1024 - 160 - 24)
    expect(snapshot?.y).toBe(768 - 160 - 24)
    expect(snapshot?.scale).toBe(1)
    expect(snapshot?.visualState).toBe('idle')
    expect(snapshot?.activityMode).toBeNull()
    expect(snapshot?.started).toBe(true)
  })

  it('subscribeStage pushes immediately and follows drag, driver apply and target changes', async () => {
    const context = setup()
    setActivePetSession(context.session)
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(motionPetClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    expect(seen).toHaveLength(1) // contract: the current value arrives immediately

    await boot(context)
    expect(seen.length).toBeGreaterThan(1) // boot (target change + start) notified

    // a user drag moves the pet → snapshot push with the moved coordinates
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 950, 650))
    expect(seen[seen.length - 1]).toMatchObject({ x: 890, y: 634 }) // (840,584) + (50,50)
    window.dispatchEvent(pointer('pointerup', 950, 650))

    // a driver apply → snapshot push
    const driver = motionPetClientService.requestPositionControl()
    expect(driver).not.toBeNull()
    expect(driver?.apply(100, 100)).toBe(true)
    expect(seen[seen.length - 1]).toMatchObject({ x: 100, y: 100 })

    // a director target change → snapshot push (synchronous, before the enter settles)
    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    expect(seen[seen.length - 1]).toMatchObject({ visualState: 'active', activityMode: 'thinking' })
    await settleTransitions()
    await pending
  })

  it('a hub publish that changes scale pushes an updated snapshot', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(motionPetClientService.subscribeStage((snapshot) => seen.push(snapshot)))

    const next = structuredClone(context.hub.getCurrent()?.config) as MotionPetConfig
    next.global.scale = 1.5
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0) // updateConfig notifies at its end
    expect(motionPetClientService.getStageSnapshot()?.scale).toBe(1.5)
    expect(seen.some((snapshot) => snapshot?.scale === 1.5)).toBe(true)
  })
})

describe('extension service — position driver', () => {
  it('apply clamps negative coordinates (32px stays reachable); commit persists a rounded overlay-only patch', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = motionPetClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')

    expect(driver.apply(-500, -500)).toBe(true)
    // §27 negative edge: -(stageSize - 32) on both axes
    expect(context.stage.element.style.left).toBe('-128px')
    expect(context.stage.element.style.top).toBe('-128px')
    expect(motionPetClientService.getStageSnapshot()).toMatchObject({ x: -128, y: -128 })

    expect(driver.apply(333.6, 444.4)).toBe(true)
    await driver.commit()
    expect(context.patchConfig).toHaveBeenCalledTimes(1)
    // only the overlay slice, rounded — never a full copied config
    expect(context.patchConfig.mock.calls[0][0]).toEqual({ overlay: { x: 334, y: 444 } })
    driver.release()
  })

  it('commit supersedes a pending drag debounce instead of double-writing', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = motionPetClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')

    // a user drag ends → debounced save pending
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 940, 640))
    window.dispatchEvent(pointer('pointerup', 940, 640))
    expect(context.patchConfig).not.toHaveBeenCalled()

    expect(driver.apply(700, 500)).toBe(true)
    await driver.commit()
    expect(context.patchConfig).toHaveBeenCalledTimes(1)
    expect(context.patchConfig.mock.calls[0][0]).toEqual({ overlay: { x: 700, y: 500 } })

    await vi.advanceTimersByTimeAsync(600) // the superseded debounce must not fire
    expect(context.patchConfig).toHaveBeenCalledTimes(1)
    driver.release()
  })

  it('remote overlay coordinates are ignored while the lease is held, honored after release', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = motionPetClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')
    expect(driver.apply(300, 300)).toBe(true)

    const next = structuredClone(context.hub.getCurrent()?.config) as MotionPetConfig
    next.overlay = { x: 11, y: 22 }
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.stage.element.style.left).toBe('300px') // lease held: no remote move

    driver.release()
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.stage.element.style.left).toBe('11px') // released: remote move applies
    expect(context.stage.element.style.top).toBe('22px')
  })

  it('the lease is exclusive: a second request fails until release', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const first = motionPetClientService.requestPositionControl()
    expect(first).not.toBeNull()
    expect(motionPetClientService.requestPositionControl()).toBeNull()
    first?.release()
    const second = motionPetClientService.requestPositionControl()
    expect(second).not.toBeNull()
    second?.release()
  })
})

describe('extension service — drag arbitration', () => {
  it('a user drag suspends the driver (onUserDrag fires once, apply false) until pointerup', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = motionPetClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')
    let dragStarts = 0
    const offDrag = driver.onUserDrag(() => {
      dragStarts += 1
    })
    expect(driver.apply(400, 400)).toBe(true)

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 460, 460))
    window.dispatchEvent(pointer('pointermove', 470, 470)) // ≥4px: threshold crossed
    expect(dragStarts).toBe(1)
    expect(context.session.drag.isDragging).toBe(true)

    expect(driver.apply(200, 200)).toBe(false) // suspended during the gesture
    window.dispatchEvent(pointer('pointermove', 480, 480)) // further moves never re-fire
    expect(dragStarts).toBe(1)
    expect(context.stage.element.style.left).toBe('420px') // the drag owns the position

    window.dispatchEvent(pointer('pointerup', 480, 480))
    expect(context.session.drag.isDragging).toBe(false)
    expect(driver.apply(200, 200)).toBe(true) // auto-resumed after the gesture
    expect(context.stage.element.style.left).toBe('200px')

    offDrag()
    driver.release()
  })
})

describe('extension service — playAnimation', () => {
  it('unknown id → null; a hub custom becomes playable once synced', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(motionPetClientService.playAnimation('user:missing')).toBeNull()

    publish(context.hub, context.config, context.assets, [makeCustom('user:spin', 320)])
    await flushUntil(() => context.session.registry.get('user:spin') !== undefined)

    const instance = motionPetClientService.playAnimation('user:spin')
    expect(instance).not.toBeNull()
    const animation = harness.animations[harness.animations.length - 1]
    expect(animation.target).toBe(context.stage.layers.transition)
    expect(animation.options.duration).toBe(320) // the synced custom actually plays
    await settleTransitions()
    expect(instance?.status).toBe('finished')
  })

  it('interrupt:false gives up while an enter transition is in flight', async () => {
    const context = setup(undefined, [makeCustom('user:spin', 320)])
    setActivePetSession(context.session)
    await boot(context)

    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(context.session.director.transitionInFlight).toBe(true)
    expect(motionPetClientService.playAnimation('user:spin', { interrupt: false })).toBeNull()

    await settleTransitions()
    await pending
  })

  it('interrupt:true preempts the in-flight enter and returns a live instance', async () => {
    const context = setup(undefined, [makeCustom('user:spin', 320)])
    setActivePetSession(context.session)
    await boot(context)

    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(context.session.director.transitionInFlight).toBe(true)
    const enterAnimations = harness.pending().filter(
      (animation) => animation.target === context.stage.layers.transition,
    )

    const instance = motionPetClientService.playAnimation('user:spin', { interrupt: true })
    expect(instance).not.toBeNull()
    // §10.2: the enter's WAAPI animations were cancelled (FakeAnimation → idle)
    for (const animation of enterAnimations) expect(animation.playState).toBe('idle')

    await settleTransitions()
    await pending // the superseded enter settles without restarting ambient
    expect(instance?.status).toBe('finished')
  })

  it('a second interrupt:true play disposes the first service-played instance', async () => {
    const context = setup(undefined, [makeCustom('user:spin', 320), makeCustom('user:wig', 260)])
    setActivePetSession(context.session)
    await boot(context)

    const first = motionPetClientService.playAnimation('user:spin')
    expect(first).not.toBeNull()
    const firstAnimations = harness.pending().filter(
      (animation) => animation.target === context.stage.layers.transition,
    )

    const second = motionPetClientService.playAnimation('user:wig')
    expect(second).not.toBeNull()
    expect(first?.status).toBe('cancelled') // disposed by the newer interrupting play
    for (const animation of firstAnimations) expect(animation.playState).toBe('idle')

    await settleTransitions()
    expect(second?.status).toBe('finished')
  })
})

describe('extension service — stageSize', () => {
  it('the snapshot carries the base stage square (bounds = stageSize × scale)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const snapshot = motionPetClientService.getStageSnapshot()
    expect(snapshot?.stageSize).toBe(context.stage.stageSize)
    expect(snapshot?.stageSize).toBe(160)
  })
})

describe('extension service — subscribeUserDrag (service level)', () => {
  it('fires start at the threshold and end at release; a click fires neither', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const phases: string[] = []
    serviceUnsubscribers.push(motionPetClientService.subscribeUserDrag((phase) => phases.push(phase)))

    // a click (sub-threshold travel) is no drag
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 902, 602))
    window.dispatchEvent(pointer('pointerup', 902, 602))
    expect(phases).toEqual([])

    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 920, 620)) // ≥4px: threshold crossed
    expect(phases).toEqual(['start'])
    window.dispatchEvent(pointer('pointermove', 930, 630)) // further moves never re-fire
    expect(phases).toEqual(['start'])
    window.dispatchEvent(pointer('pointerup', 930, 630))
    expect(phases).toEqual(['start', 'end'])
  })

  it('works without holding the position lease', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const phases: string[] = []
    serviceUnsubscribers.push(motionPetClientService.subscribeUserDrag((phase) => phases.push(phase)))
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 920, 620))
    window.dispatchEvent(pointer('pointerup', 920, 620))
    expect(phases).toEqual(['start', 'end'])
    expect(motionPetClientService.getStageSnapshot()).toMatchObject({ x: 860, y: 604 }) // drag moved it
  })
})

describe('extension service — flashPose', () => {
  const srcOf = (context: Setup): string | null => context.stage.interactiveElement.getAttribute('src')

  it('swaps the pose image and restores the target pose after the hold', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(srcOf(context)).toBe(assetUrl('asset-idle'))

    expect(motionPetClientService.flashPose('success', 800)).toBe(true)
    expect(srcOf(context)).toBe(assetUrl('asset-success'))

    await vi.advanceTimersByTimeAsync(799)
    expect(srcOf(context)).toBe(assetUrl('asset-success'))
    await vi.advanceTimersByTimeAsync(1)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // restored to the idle target's pose
  })

  it('a second flash replaces the pending restore (the new hold wins)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    expect(motionPetClientService.flashPose('success', 10_000)).toBe(true)
    expect(motionPetClientService.flashPose('error', 200)).toBe(true)
    expect(srcOf(context)).toBe(assetUrl('asset-error'))

    await vi.advanceTimersByTimeAsync(200)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // the 200ms hold ruled, not the 10s one
    await vi.advanceTimersByTimeAsync(10_000)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // no late swap from the replaced timer
  })

  it('holdMs <= 0 keeps the pose until the next state change', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    expect(motionPetClientService.flashPose('success', 0)).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(srcOf(context)).toBe(assetUrl('asset-success'))

    // a real state change still re-owns the pose (flash is not sticky)
    await settleTransitions()
    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await settleTransitions()
    await pending
    expect(srcOf(context)).toBe(assetUrl('asset-thinking'))
  })

  it('returns false without a session', () => {
    expect(motionPetClientService.flashPose('success', 500)).toBe(false)
  })
})

describe('extension service — flashPose competition (pose hold ledger)', () => {
  const srcOf = (context: Setup): string | null => context.stage.interactiveElement.getAttribute('src')

  it('a hub publish during the hold does not truncate the flashed pose (M1)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    expect(motionPetClientService.flashPose('success', 2000)).toBe(true)
    expect(srcOf(context)).toBe(assetUrl('asset-success'))

    // The physics companion's settle commit broadcasts the config mid-hold —
    // updateConfig's refresh pass must not force the state pose back early.
    publish(context.hub, context.config, context.assets)
    await vi.advanceTimersByTimeAsync(100)
    expect(srcOf(context)).toBe(assetUrl('asset-success'))

    await vi.advanceTimersByTimeAsync(1900)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // the hold's own restore realigned
  })

  it('holdMs=0: a later silent swap to the pre-flash URL re-owns the pose (M2)', async () => {
    const context = setup((config) => {
      config.advanced.activityTransition = 'none'
      // thinking/working share the idle image through fallback resolution
      delete config.poses.thinking.assetId
      delete config.poses.working.assetId
    })
    setActivePetSession(context.session)
    await boot(context)

    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await settleTransitions()
    await pending
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // thinking fell back to idle

    expect(motionPetClientService.flashPose('success', 0)).toBe(true)
    expect(srcOf(context)).toBe(assetUrl('asset-success'))

    // Same visual state, new poseKey: working ALSO resolves to the idle asset.
    // Without the ledger the silent swap's same-URL guard strands the flash.
    const silent = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'command',
      poseKey: 'working',
      reason: 'agent-state',
    })
    await silent
    expect(srcOf(context)).toBe(assetUrl('asset-idle'))
  })

  it('a click without a configured click pose leaves a pending hold untouched (M3 default lock)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(motionPetClientService.flashPose('success', 1000)).toBe(true)

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600)) // a click
    await settleTransitions() // the pop plays out; flashPose===null never touched the pose
    expect(srcOf(context)).toBe(assetUrl('asset-success'))

    await vi.advanceTimersByTimeAsync(1000)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // the hold still rules its deadline
  })

  it('a configured click restore returns to the HELD pose instead of cutting the hold short (M3)', async () => {
    const context = setup((config) => {
      config.interactions.click.pose = 'success'
    })
    setActivePetSession(context.session)
    await boot(context)

    expect(motionPetClientService.flashPose('error', 5000)).toBe(true)
    expect(srcOf(context)).toBe(assetUrl('asset-error'))

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600))
    expect(srcOf(context)).toBe(assetUrl('asset-success')) // the click's own flash

    await settleTransitions()
    await flushUntil(() => srcOf(context) === assetUrl('asset-error'))
    expect(srcOf(context)).toBe(assetUrl('asset-error')) // back to the held pose, not idle

    await vi.advanceTimersByTimeAsync(5000)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // the hold's restore realigned at its deadline
  })
})

describe('extension service — active session bridge', () => {
  it('a stale clear never detaches the current session', async () => {
    const first = setup()
    const second = setup()
    setActivePetSession(second.session)
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(motionPetClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    expect(seen).toEqual([second.session.getStageSnapshot()])

    // the FIRST session's teardown arrives late: must not clear the second
    clearActivePetSession(first.session)
    expect(seen).toHaveLength(1)
    expect(motionPetClientService.getStageSnapshot()).not.toBeNull()

    clearActivePetSession(second.session)
    expect(motionPetClientService.getStageSnapshot()).toBeNull()
    expect(seen[seen.length - 1]).toBeNull()
  })

  it('PetOverlay mount publishes the live session; unmount clears it', async () => {
    const config = createDefaultMotionPetConfig()
    const assets: Record<string, AssetMeta> = {}
    for (const key of POSE_KEYS) {
      config.poses[key].assetId = `asset-${key}`
      assets[`asset-${key}`] = makeAsset(`asset-${key}`)
    }
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config, assets })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [] })),
    })
    hub.publish({ config, assets, customs: [] }) // preloaded: visible on first render

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    reactRoots.push(root)
    await act(async () => {
      root.render(createElement(PetOverlay, { hub }))
    })
    expect(motionPetClientService.getStageSnapshot()).not.toBeNull()

    act(() => root.unmount())
    expect(motionPetClientService.getStageSnapshot()).toBeNull()
  })
})
