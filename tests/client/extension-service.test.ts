// @vitest-environment jsdom
/**
 * Extension service tests (petween/client): the three windows degrade
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
  petweenClientService,
  setActivePetSession,
  type StageSnapshot,
  type UserPointerEvent,
} from '../../src/client/extension-service'
import { OverlaySession } from '../../src/client/overlay-session'
import { PetOverlay } from '../../src/client/overlay/PetOverlay'
import { PetStage } from '../../src/client/overlay/pet-stage'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetweenConfig } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import type { DirectorPlaybackEvent } from '../../src/motion/motion-director'
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
  config: PetweenConfig
  assets: Record<string, AssetMeta>
  hub: ConfigHub
  session: OverlaySession
  patchConfig: ReturnType<typeof vi.fn>
}

const setup = (
  mutateConfig?: (config: PetweenConfig, assets: Record<string, AssetMeta>) => void,
  customs: AnimationDefinition[] = [],
): Setup => {
  const stage = new PetStage()
  document.body.appendChild(stage.element)
  const config = createDefaultPetweenConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of POSE_KEYS) {
    config.poses[key].assetId = `asset-${key}`
    assets[`asset-${key}`] = makeAsset(`asset-${key}`)
  }
  mutateConfig?.(config, assets)
  const hub = new ConfigHub({
    fetchConfig: vi.fn(async () => ({ config, assets })),
    fetchAnimations: vi.fn(async () => ({ customs: structuredClone(customs), warnings: [], normalized: [] })),
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
  config: PetweenConfig,
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

const makePoseSwapCustom = (id: string, pose: string, durationMs = 320): AnimationDefinition => ({
  ...makeCustom(id, durationMs),
  events: [{ at: 0.5, type: 'pose-swap', pose }],
})

const DOZE_URL = 'https://example.test/doze.webp'

describe('extension service — no active session', () => {
  it('all three APIs degrade to null', () => {
    expect(petweenClientService.getStageSnapshot()).toBeNull()
    expect(petweenClientService.requestPositionControl()).toBeNull()
    expect(petweenClientService.playAnimation('builtin:comic-pop')).toBeNull()
  })

  it('subscribeStage immediately pushes null', () => {
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(petweenClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    expect(seen).toEqual([null])
  })
})

describe('extension service — active session', () => {
  it('getStageSnapshot folds the default corner into px and reports idle after boot', async () => {
    const context = setup()
    setActivePetSession(context.session)
    // before boot: no target yet, boot not finished
    const early = petweenClientService.getStageSnapshot()
    expect(early?.visualState).toBeNull()
    expect(early?.activityMode).toBeNull()
    expect(early?.started).toBe(false)

    await boot(context)
    const snapshot = petweenClientService.getStageSnapshot()
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
    serviceUnsubscribers.push(petweenClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    expect(seen).toHaveLength(1) // contract: the current value arrives immediately

    await boot(context)
    expect(seen.length).toBeGreaterThan(1) // boot (target change + start) notified

    // a user drag moves the pet → snapshot push with the moved coordinates
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 950, 650))
    expect(seen[seen.length - 1]).toMatchObject({ x: 890, y: 634 }) // (840,584) + (50,50)
    window.dispatchEvent(pointer('pointerup', 950, 650))

    // a driver apply → snapshot push
    const driver = petweenClientService.requestPositionControl()
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
    serviceUnsubscribers.push(petweenClientService.subscribeStage((snapshot) => seen.push(snapshot)))

    const next = structuredClone(context.hub.getCurrent()?.config) as PetweenConfig
    next.global.scale = 1.5
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0) // updateConfig notifies at its end
    expect(petweenClientService.getStageSnapshot()?.scale).toBe(1.5)
    expect(seen.some((snapshot) => snapshot?.scale === 1.5)).toBe(true)
  })
})

describe('extension service — position driver', () => {
  it('apply clamps negative coordinates (32px stays reachable); commit persists a rounded overlay-only patch', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = petweenClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')

    expect(driver.apply(-500, -500)).toBe(true)
    // §27 negative edge: -(stageSize - 32) on both axes
    expect(context.stage.element.style.left).toBe('-128px')
    expect(context.stage.element.style.top).toBe('-128px')
    expect(petweenClientService.getStageSnapshot()).toMatchObject({ x: -128, y: -128 })

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
    const driver = petweenClientService.requestPositionControl()
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
    const driver = petweenClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')
    expect(driver.apply(300, 300)).toBe(true)

    const next = structuredClone(context.hub.getCurrent()?.config) as PetweenConfig
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
    const first = petweenClientService.requestPositionControl()
    expect(first).not.toBeNull()
    expect(petweenClientService.requestPositionControl()).toBeNull()
    first?.release()
    const second = petweenClientService.requestPositionControl()
    expect(second).not.toBeNull()
    second?.release()
  })
})

describe('extension service — drag arbitration', () => {
  it('a user drag suspends the driver (onUserDrag fires once, apply false) until pointerup', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = petweenClientService.requestPositionControl()
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

  it('the driver hears both gesture phases: start suspends, end resumes', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const driver = petweenClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')
    const phases: string[] = []
    const offDrag = driver.onUserDrag((phase) => phases.push(phase))
    expect(driver.apply(400, 400)).toBe(true)

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 460, 460))
    window.dispatchEvent(pointer('pointermove', 470, 470)) // ≥4px: threshold crossed
    expect(phases).toEqual(['start'])
    expect(driver.apply(200, 200)).toBe(false) // suspended for the gesture

    window.dispatchEvent(pointer('pointerup', 470, 470))
    expect(phases).toEqual(['start', 'end']) // the contract's end signal, not a guess
    expect(driver.apply(200, 200)).toBe(true)

    offDrag()
    driver.release()
  })

  it("a lease taken while the drag 'end' fans out never sees that 'end' (petween-physics flight regression)", async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    // No lease exists at gesture start. The service-level 'end' listener
    // takes one MID-FAN-OUT — exactly how petween-physics starts its flight
    // (velocity computed, requestPositionControl, driver.onUserDrag registered
    // to catch a re-grab). The gesture's trailing driver-level 'end' used to
    // reach that fresh lease too and physics's phase-agnostic listener killed
    // the flight in the same stack that started it.
    let flightDriver: ReturnType<typeof petweenClientService.requestPositionControl> = null
    const flightPhases: string[] = []
    const offService = petweenClientService.subscribeUserDrag((phase) => {
      if (phase === 'end' && flightDriver === null) {
        flightDriver = petweenClientService.requestPositionControl()
        expect(flightDriver).not.toBeNull()
        flightDriver!.onUserDrag((flightPhase) => flightPhases.push(flightPhase))
      }
    })
    serviceUnsubscribers.push(offService)

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 460, 460))
    window.dispatchEvent(pointer('pointermove', 470, 470)) // ≥4px: threshold crossed
    window.dispatchEvent(pointer('pointerup', 470, 470)) // 'end' fans: service first, then driver-level

    expect(flightDriver).not.toBeNull()
    expect(flightPhases).toEqual([]) // fresh lease was never suspended → no trailing 'end'
    // And the lease is fully functional (apply honored: the gesture is over).
    expect(flightDriver!.apply(300, 300)).toBe(true)
    expect(context.stage.element.style.left).toBe('300px')

    // A later REAL grab still reaches the lease holder (the catch contract).
    body.dispatchEvent(pointer('pointerdown', 360, 360))
    window.dispatchEvent(pointer('pointermove', 370, 370))
    expect(flightPhases).toEqual(['start'])
    window.dispatchEvent(pointer('pointerup', 370, 370))
    expect(flightPhases).toEqual(['start', 'end'])

    flightDriver!.release()
  })
})

describe('extension service — playAnimation', () => {
  it('reduced-motion constrains external playback at compile time — constant keyframes, ≤120ms, events kept (§22)', async () => {
    const customs = [makeCustom('user:spin', 320), makePoseSwapCustom('user:doze', 'user:doze-doze')]
    const context = setup(
      (config) => {
        config.global.reducedMotion = 'always'
      },
      customs,
    )
    setActivePetSession(context.session)
    expect(petweenClientService.registerPoses([{ id: 'user:doze-doze', url: DOZE_URL }])).toBe(true)
    await boot(context)
    expect(context.stage.reducedMotion).toBe(true)

    // The §22 gate is structural, not per-call-site: playAnimation rides the
    // same TimelineEngine compile as every other playback (engine passes
    // stage.reducedMotion into compileTimeline), so under reduce the tracks
    // collapse to their final value — constant keyframes, zero visible motion
    // — and the duration caps at 120ms. Locks the 2026-08-27 verification
    // that closed backlog F1 ("external playback ignores reduced-motion")
    // as inaccurate for this codebase.
    const before = harness.animations.length
    const instance = petweenClientService.playAnimation('user:spin')
    expect(instance).not.toBeNull()
    const played = harness.animations
      .slice(before)
      .filter((animation) => animation.target === context.stage.layers.transition)
    expect(played.length).toBeGreaterThan(0)
    for (const animation of played) {
      expect(animation.options.duration).toBeLessThanOrEqual(120)
      const frames = animation.keyframes as Array<{ rotate?: string }>
      expect(frames[0]?.rotate).toBe('12deg')
      expect(frames[frames.length - 1]?.rotate).toBe('12deg')
    }
    await settleTransitions()
    expect(instance?.status).toBe('finished')

    // Events survive the collapse: the pose-swap still lands mid-run (a pose
    // change is an image swap, not motion) and the settle still realigns to
    // the state pose — companions like physics keep their semantics.
    const seen: Array<string | null> = []
    serviceUnsubscribers.push(
      petweenClientService.subscribePose((pose) => seen.push(pose === null ? null : pose.poseKey)),
    )
    const swapInstance = petweenClientService.playAnimation('user:doze')
    await settleTransitions()
    expect(seen).toContain('user:doze-doze')
    const src = context.stage.element.querySelector('img')?.getAttribute('src') ?? null
    expect(src).toBe(assetUrl('asset-idle'))
    expect(swapInstance?.status).toBe('finished')

    // Flipping the preference off restores full-fidelity external playback:
    // the compile reads the stage flag at play time, not at construction.
    const next = structuredClone(context.hub.getCurrent()?.config ?? context.config)
    next.global.reducedMotion = 'never'
    publish(context.hub, next, context.assets, structuredClone(customs))
    expect(context.stage.reducedMotion).toBe(false)
    const fullBefore = harness.animations.length
    const fullInstance = petweenClientService.playAnimation('user:spin')
    expect(fullInstance).not.toBeNull()
    const fullPlayed = harness.animations
      .slice(fullBefore)
      .filter((animation) => animation.target === context.stage.layers.transition)
    expect(fullPlayed[fullPlayed.length - 1]?.options.duration).toBe(320)
    const fullFrames = fullPlayed[fullPlayed.length - 1]?.keyframes as Array<{ rotate?: string }>
    expect(fullFrames[0]?.rotate).toBe('0deg')
    expect(fullFrames[fullFrames.length - 1]?.rotate).toBe('12deg')
    await settleTransitions()
    expect(fullInstance?.status).toBe('finished')
  })

  it('unknown id → null; a hub custom becomes playable once synced', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.playAnimation('user:missing')).toBeNull()

    publish(context.hub, context.config, context.assets, [makeCustom('user:spin', 320)])
    await flushUntil(() => context.session.registry.get('user:spin') !== undefined)

    const instance = petweenClientService.playAnimation('user:spin')
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
    expect(petweenClientService.playAnimation('user:spin', { interrupt: false })).toBeNull()

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

    const instance = petweenClientService.playAnimation('user:spin', { interrupt: true })
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

    const first = petweenClientService.playAnimation('user:spin')
    expect(first).not.toBeNull()
    const firstAnimations = harness.pending().filter(
      (animation) => animation.target === context.stage.layers.transition,
    )

    const second = petweenClientService.playAnimation('user:wig')
    expect(second).not.toBeNull()
    expect(first?.status).toBe('cancelled') // disposed by the newer interrupting play
    for (const animation of firstAnimations) expect(animation.playState).toBe('idle')

    await settleTransitions()
    expect(second?.status).toBe('finished')
  })

  it('interrupt:true settles the abandoned target: pose landed, ambient running', async () => {
    const context = setup(undefined, [makeCustom('user:spin', 320)])
    setActivePetSession(context.session)
    await boot(context)
    const srcOf = (): string | null => context.stage.element.querySelector('img')?.getAttribute('src') ?? null

    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(context.session.director.transitionInFlight).toBe(true)
    expect(srcOf()).toBe(assetUrl('asset-idle')) // pre segment: no swap yet

    const instance = petweenClientService.playAnimation('user:spin', { interrupt: true })
    expect(instance).not.toBeNull()
    // Without the settle the interrupted enter left the target abandoned: the
    // stage kept the idle pose and ambient stayed silent after runEnter's stop.
    expect(srcOf()).toBe(assetUrl('asset-thinking')) // the current target's pose landed
    const sway = harness.pending().find(
      (animation) => animation.target === context.stage.layers.sway && animation.options.iterations === Infinity,
    )
    expect(sway?.playState).toBe('running') // thinking ambient restarted (no silent stage)

    await settleTransitions()
    await pending
    expect(instance?.status).toBe('finished')
  })

  it('no enter in flight: an interrupting play never settles (flash + ambient phase intact)', async () => {
    const context = setup(
      (config) => {
        config.interactions.click.pose = 'success'
      },
      [makeCustom('user:spin', 320)],
    )
    setActivePetSession(context.session)
    await boot(context)
    const srcOf = (): string | null => context.stage.element.querySelector('img')?.getAttribute('src') ?? null
    const swayLoop = harness.pending().find(
      (animation) => animation.target === context.stage.layers.sway && animation.options.iterations === Infinity,
    )
    expect(swayLoop?.playState).toBe('running')

    // a click flashes its pose while its pop plays out — no enter in flight
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600))
    expect(srcOf()).toBe(assetUrl('asset-success'))
    expect(context.session.director.transitionInFlight).toBe(false)

    const instance = petweenClientService.playAnimation('user:spin') // default interrupt: true
    expect(instance).not.toBeNull()
    // A spurious settle would bump the generation (killing the click's restore
    // guard) and swap the stage back to the state pose, cutting the flash.
    expect(srcOf()).toBe(assetUrl('asset-success')) // the click's flash still owns the stage
    expect(
      harness.pending().find(
        (animation) => animation.target === context.stage.layers.sway && animation.options.iterations === Infinity,
      ),
    ).toBe(swayLoop) // ambient kept its instance: no needless restart

    await settleTransitions()
    await flushUntil(() => srcOf() === assetUrl('asset-idle'))
    expect(srcOf()).toBe(assetUrl('asset-idle')) // the click's restore still realigned
  })
})

describe('extension service — stageSize', () => {
  it('the snapshot carries the base stage square (bounds = stageSize × scale)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const snapshot = petweenClientService.getStageSnapshot()
    expect(snapshot?.stageSize).toBe(context.stage.stageSize)
    expect(snapshot?.stageSize).toBe(160)
  })
})

describe('extension service — snapshot enrichment (v1 widening)', () => {
  it('before boot: poseKey and bodyRect null; after boot: viewport, flags and the resting img box', async () => {
    const context = setup()
    setActivePetSession(context.session)
    const early = petweenClientService.getStageSnapshot()
    expect(early?.poseKey).toBeNull()
    expect(early?.bodyRect).toBeNull()

    await boot(context)
    const snapshot = petweenClientService.getStageSnapshot()
    // jsdom viewport 1024×768 — the clamp math the position layer runs against
    expect(snapshot?.viewport).toEqual({ width: 1024, height: 768 })
    expect(snapshot?.dragging).toBe(false)
    expect(snapshot?.reducedMotion).toBe(false) // default 'system' with no media preference
    expect(snapshot?.poseKey).toBe('idle')
    // 240×240 asset contain-fit into the 160 square, pose anchor {0.5,0.96}
    // onto the world anchor {0.5,0.9}: full-square box shifted up by 9.6px
    expect(snapshot?.bodyRect?.x).toBe(840)
    expect(snapshot?.bodyRect?.y).toBeCloseTo(574.4, 5)
    expect(snapshot?.bodyRect?.width).toBeCloseTo(160, 5)
    expect(snapshot?.bodyRect?.height).toBeCloseTo(160, 5)
  })

  it('bodyRect follows the user scale through the world-anchor origin', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    const next = structuredClone(context.hub.getCurrent()?.config) as PetweenConfig
    next.global.scale = 1.5
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0)

    const snapshot = petweenClientService.getStageSnapshot()
    expect(snapshot?.scale).toBe(1.5)
    // scale around the world anchor (80,144): x' = 840+80+1.5*(0-80) = 800;
    // y' = 584+144+1.5*(-9.6-144) = 497.6; the box grows to 240×240
    expect(snapshot?.bodyRect?.x).toBe(800)
    expect(snapshot?.bodyRect?.y).toBeCloseTo(497.6, 5)
    expect(snapshot?.bodyRect?.width).toBeCloseTo(240, 5)
    expect(snapshot?.bodyRect?.height).toBeCloseTo(240, 5)
  })

  it('dragging flips with the gesture in the snapshot stream', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(petweenClientService.subscribeStage((snapshot) => seen.push(snapshot)))

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 920, 620)) // threshold crossed
    expect(seen[seen.length - 1]?.dragging).toBe(true)
    window.dispatchEvent(pointer('pointerup', 920, 620))
    expect(seen[seen.length - 1]?.dragging).toBe(false)
  })

  it('reducedMotion follows a config publish; poseKey follows a target change', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.getStageSnapshot()?.reducedMotion).toBe(false)

    const next = structuredClone(context.hub.getCurrent()?.config) as PetweenConfig
    next.global.reducedMotion = 'always'
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0)
    expect(petweenClientService.getStageSnapshot()?.reducedMotion).toBe(true)

    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    expect(petweenClientService.getStageSnapshot()?.poseKey).toBe('thinking')
    await settleTransitions()
    await pending
  })
})

describe('extension service — isPlaying', () => {
  it('null without a session; quiet after boot', async () => {
    expect(petweenClientService.isPlaying()).toBeNull()
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.isPlaying()).toEqual({ enter: false, external: false })
  })

  it('enter is true while an enter transition is in flight', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const pending = context.session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(petweenClientService.isPlaying()).toEqual({ enter: true, external: false })
    await settleTransitions()
    await pending
    expect(petweenClientService.isPlaying()).toEqual({ enter: false, external: false })
  })

  it('external tracks service-played instances through their lifecycle', async () => {
    const context = setup(undefined, [makeCustom('user:spin', 320)])
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.isPlaying()?.external).toBe(false)

    const instance = petweenClientService.playAnimation('user:spin')
    expect(instance).not.toBeNull()
    expect(petweenClientService.isPlaying()).toEqual({ enter: false, external: true })

    await settleTransitions()
    await flushUntil(() => petweenClientService.isPlaying()?.external === false)
    expect(instance?.status).toBe('finished')
    expect(petweenClientService.isPlaying()).toEqual({ enter: false, external: false })
  })
})

describe('extension service — listAnimations', () => {
  it('null without a session; builtin presets and synced customs with full metadata', async () => {
    expect(petweenClientService.listAnimations()).toBeNull()
    const context = setup(undefined, [makeCustom('user:spin', 320), makeCustom('motion:wall-bounce', 300)])
    setActivePetSession(context.session)
    await boot(context)

    const listed = petweenClientService.listAnimations()
    expect(listed).not.toBeNull()
    const builtin = listed?.find((entry) => entry.id === 'builtin:comic-pop')
    expect(builtin).toMatchObject({ id: 'builtin:comic-pop', namespace: 'builtin', kind: 'transition' })
    expect(builtin?.durationMs).toBeGreaterThan(0)
    expect(builtin?.name.length ?? 0).toBeGreaterThan(0)
    expect(listed).toContainEqual({
      id: 'user:spin',
      name: 'Custom user:spin',
      kind: 'interaction',
      durationMs: 320,
      namespace: 'user',
    })
    // B6 + 2026-08-28 review: a pack-namespace custom reports its LITERAL
    // namespace, never masquerading as 'user'.
    expect(listed).toContainEqual({
      id: 'motion:wall-bounce',
      name: 'Custom motion:wall-bounce',
      kind: 'interaction',
      durationMs: 300,
      namespace: 'motion',
    })
  })

  it('follows the hub: an unpublished custom appears after a publish', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.listAnimations()?.some((entry) => entry.id === 'user:spin')).toBe(false)

    publish(context.hub, context.config, context.assets, [makeCustom('user:spin', 320)])
    await flushUntil(() => context.session.registry.get('user:spin') !== undefined)
    expect(petweenClientService.listAnimations()?.some((entry) => entry.id === 'user:spin')).toBe(true)
  })
})

describe('extension service — resyncAnimations', () => {
  it('resolves without a session', async () => {
    await expect(petweenClientService.resyncAnimations()).resolves.toBeUndefined()
  })

  it('closes the register→sync window on demand (no 3s poll wait)', async () => {
    const customs: AnimationDefinition[] = []
    const context = setup(undefined, customs)
    setActivePetSession(context.session)
    await boot(context)
    expect(context.session.registry.get('user:spin')).toBeUndefined()

    // the "host" gains the animation (registerAnimation landed server-side)
    customs.push(makeCustom('user:spin', 320))
    expect(petweenClientService.playAnimation('user:spin')).toBeNull() // not synced yet

    await petweenClientService.resyncAnimations()
    expect(context.session.registry.get('user:spin')).toBeDefined()
    const instance = petweenClientService.playAnimation('user:spin')
    expect(instance).not.toBeNull()
    await settleTransitions()
  })
})

describe('extension service — subscribeUserDrag (service level)', () => {
  it('fires start at the threshold and end at release; a click fires neither', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const phases: string[] = []
    serviceUnsubscribers.push(petweenClientService.subscribeUserDrag((phase) => phases.push(phase)))

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
    serviceUnsubscribers.push(petweenClientService.subscribeUserDrag((phase) => phases.push(phase)))
    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 920, 620))
    window.dispatchEvent(pointer('pointerup', 920, 620))
    expect(phases).toEqual(['start', 'end'])
    expect(petweenClientService.getStageSnapshot()).toMatchObject({ x: 860, y: 604 }) // drag moved it
  })
})

describe('extension service — flashPose', () => {
  const srcOf = (context: Setup): string | null => context.stage.interactiveElement.getAttribute('src')

  it('swaps the pose image and restores the target pose after the hold', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(srcOf(context)).toBe(assetUrl('asset-idle'))

    expect(petweenClientService.flashPose('success', 800)).toBe(true)
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

    expect(petweenClientService.flashPose('success', 10_000)).toBe(true)
    expect(petweenClientService.flashPose('error', 200)).toBe(true)
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

    expect(petweenClientService.flashPose('success', 0)).toBe(true)
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
    expect(petweenClientService.flashPose('success', 500)).toBe(false)
  })
})

describe('extension service — flashPose competition (pose hold ledger)', () => {
  const srcOf = (context: Setup): string | null => context.stage.interactiveElement.getAttribute('src')

  it('a hub publish during the hold does not truncate the flashed pose (M1)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    expect(petweenClientService.flashPose('success', 2000)).toBe(true)
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

    expect(petweenClientService.flashPose('success', 0)).toBe(true)
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
    expect(petweenClientService.flashPose('success', 1000)).toBe(true)

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

    expect(petweenClientService.flashPose('error', 5000)).toBe(true)
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

describe('extension service — third-party listener isolation', () => {
  it('a throwing stage listener never breaks the fan-out or the emitting flow', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: Array<StageSnapshot | null> = []
    let badCalls = 0
    // survives the contract's immediate push (that call runs in the
    // companion's own subscribe stack); throws on every later emission
    serviceUnsubscribers.push(
      petweenClientService.subscribeStage(() => {
        badCalls += 1
        if (badCalls > 1) throw new Error('bad companion')
      }),
    )
    serviceUnsubscribers.push(petweenClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    const seenBefore = seen.length

    const driver = petweenClientService.requestPositionControl()
    expect(driver?.apply(100, 100)).toBe(true) // the emitting flow itself must not throw
    expect(seen.length).toBe(seenBefore + 1) // the healthy listener still heard it
    expect(warn).toHaveBeenCalledWith('petween: stage listener failed', expect.any(Error))
    driver?.release()
  })

  it('a throwing subscribeUserDrag listener never blocks the healthy one', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const phases: string[] = []
    serviceUnsubscribers.push(
      petweenClientService.subscribeUserDrag(() => {
        throw new Error('bad companion')
      }),
    )
    serviceUnsubscribers.push(petweenClientService.subscribeUserDrag((phase) => phases.push(phase)))

    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 920, 620)) // ≥4px: threshold crossed
    window.dispatchEvent(pointer('pointerup', 930, 630))
    expect(phases).toEqual(['start', 'end']) // both phases reached the healthy listener
    expect(warn).toHaveBeenCalledWith('petween: user drag listener failed', expect.any(Error))
  })

  it('session-level snapshot listeners and driver drag listeners are isolated too', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: StageSnapshot[] = []
    serviceUnsubscribers.push(
      context.session.subscribeSnapshot(() => {
        throw new Error('bad companion')
      }),
    )
    serviceUnsubscribers.push(context.session.subscribeSnapshot((snapshot) => seen.push(snapshot)))
    const driver = petweenClientService.requestPositionControl()
    if (driver === null) throw new Error('driver missing')
    let dragStarts = 0
    const offBad = driver.onUserDrag(() => {
      throw new Error('bad companion')
    })
    const offGood = driver.onUserDrag(() => {
      dragStarts += 1
    })

    expect(driver.apply(100, 100)).toBe(true) // notifySnapshot with a thrower inside
    expect(seen.some((snapshot) => snapshot.x === 100)).toBe(true)
    expect(warn).toHaveBeenCalledWith('petween: snapshot listener failed', expect.any(Error))

    context.stage.interactiveElement.dispatchEvent(pointer('pointerdown', 150, 150))
    window.dispatchEvent(pointer('pointermove', 160, 160)) // threshold crossed
    expect(dragStarts).toBe(1) // the healthy driver listener heard the gesture start
    expect(warn).toHaveBeenCalledWith('petween: driver drag listener failed', expect.any(Error))
    window.dispatchEvent(pointer('pointerup', 170, 170))

    offBad()
    offGood()
    driver.release()
  })
})

describe('extension service — active session bridge', () => {
  it('a stale clear never detaches the current session', async () => {
    const first = setup()
    const second = setup()
    setActivePetSession(second.session)
    const seen: Array<StageSnapshot | null> = []
    serviceUnsubscribers.push(petweenClientService.subscribeStage((snapshot) => seen.push(snapshot)))
    expect(seen).toEqual([second.session.getStageSnapshot()])

    // the FIRST session's teardown arrives late: must not clear the second
    clearActivePetSession(first.session)
    expect(seen).toHaveLength(1)
    expect(petweenClientService.getStageSnapshot()).not.toBeNull()

    clearActivePetSession(second.session)
    expect(petweenClientService.getStageSnapshot()).toBeNull()
    expect(seen[seen.length - 1]).toBeNull()
  })

  it('PetOverlay mount publishes the live session; unmount clears it', async () => {
    const config = createDefaultPetweenConfig()
    const assets: Record<string, AssetMeta> = {}
    for (const key of POSE_KEYS) {
      config.poses[key].assetId = `asset-${key}`
      assets[`asset-${key}`] = makeAsset(`asset-${key}`)
    }
    const hub = new ConfigHub({
      fetchConfig: vi.fn(async () => ({ config, assets })),
      fetchAnimations: vi.fn(async () => ({ customs: [], warnings: [], normalized: [] })),
    })
    hub.publish({ config, assets, customs: [] }) // preloaded: visible on first render

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    reactRoots.push(root)
    await act(async () => {
      root.render(createElement(PetOverlay, { hub }))
    })
    expect(petweenClientService.getStageSnapshot()).not.toBeNull()

    act(() => root.unmount())
    expect(petweenClientService.getStageSnapshot()).toBeNull()
  })
})

describe('extension service — external pose channel', () => {
  const srcOf = (context: Setup): string | null => context.stage.interactiveElement.getAttribute('src')

  it('registerPoses is all-or-nothing and unlocks flashPose by external id', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    // not a user: id — the whole batch refuses
    expect(petweenClientService.registerPoses([{ id: 'doze', url: DOZE_URL }])).toBe(false)
    expect(petweenClientService.flashPose('user:doze-doze', 100)).toBe(false) // nothing registered

    expect(
      petweenClientService.registerPoses([
        { id: 'user:doze-doze', url: DOZE_URL },
        { id: 'user:doze-snore', url: 'https://example.test/snore.webp', anchor: { x: 0.5, y: 1 }, zoom: 1.2 },
      ]),
    ).toBe(true)
    expect(petweenClientService.flashPose('user:doze-doze', 200)).toBe(true)
    expect(srcOf(context)).toBe(DOZE_URL)
    await vi.advanceTimersByTimeAsync(200)
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // restored to the target pose
  })

  it('flashAsset swaps a one-off companion-hosted image and restores', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)

    expect(petweenClientService.flashAsset({ url: 'https://example.test/mouth.webp' }, 150)).toBe(true)
    expect(srcOf(context)).toBe('https://example.test/mouth.webp')
    await vi.advanceTimersByTimeAsync(150)
    expect(srcOf(context)).toBe(assetUrl('asset-idle'))

    // invalid definitions refuse without touching the stage
    expect(petweenClientService.flashAsset({ url: '' }, 100)).toBe(false)
    expect(petweenClientService.flashAsset({ url: DOZE_URL, anchor: { x: 1.5, y: 0.5 } }, 100)).toBe(false)
    expect(srcOf(context)).toBe(assetUrl('asset-idle'))
  })

  it('unregisterPoses drops targets; registerPoses is false without a session', async () => {
    expect(petweenClientService.registerPoses([{ id: 'user:doze-doze', url: DOZE_URL }])).toBe(false)
    expect(petweenClientService.flashAsset({ url: DOZE_URL }, 100)).toBe(false)

    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.registerPoses([{ id: 'user:doze-doze', url: DOZE_URL }])).toBe(true)
    petweenClientService.unregisterPoses(['user:doze-doze'])
    expect(petweenClientService.flashPose('user:doze-doze', 100)).toBe(false)
  })

  it('an interaction animation pose-swaps to a registered pose mid-run and restores on settle', async () => {
    const context = setup(undefined, [makePoseSwapCustom('user:doze', 'user:doze-doze')])
    setActivePetSession(context.session)
    await boot(context)
    expect(petweenClientService.registerPoses([{ id: 'user:doze-doze', url: DOZE_URL }])).toBe(true)

    const seen: Array<string | null> = []
    serviceUnsubscribers.push(petweenClientService.subscribePose((pose) => seen.push(pose === null ? null : pose.poseKey)))
    const instance = petweenClientService.playAnimation('user:doze')
    expect(instance).not.toBeNull()
    await settleTransitions()
    expect(seen).toContain('user:doze-doze') // the mid-run swap fired
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // settle realigned to the state pose
    expect(instance?.status).toBe('finished')
  })

  it('a pose-swap naming an unregistered pose is skipped, never fatal', async () => {
    const context = setup(undefined, [makePoseSwapCustom('user:doze', 'user:missing')])
    setActivePetSession(context.session)
    await boot(context)

    const instance = petweenClientService.playAnimation('user:doze')
    expect(instance).not.toBeNull()
    await settleTransitions()
    expect(srcOf(context)).toBe(assetUrl('asset-idle')) // never swapped anywhere
    expect(instance?.status).toBe('finished')
  })
})

describe('extension service — subscribePose', () => {
  it('current pose arrives immediately; null without a session and across teardown', async () => {
    const beforeSession: Array<string | null> = []
    const offBefore = petweenClientService.subscribePose((pose) =>
      beforeSession.push(pose === null ? null : pose.poseKey),
    )
    expect(beforeSession).toEqual([null])
    offBefore()

    const context = setup()
    setActivePetSession(context.session)
    const seen: Array<string | null> = []
    serviceUnsubscribers.push(
      petweenClientService.subscribePose((pose) => seen.push(pose === null ? null : pose.poseKey)),
    )
    await boot(context)
    expect(seen).toContain('idle') // boot's idle swap (or the immediate push post-boot)

    clearActivePetSession(context.session)
    expect(seen[seen.length - 1]).toBeNull() // teardown pushes null
  })

  it('a flash drives the stream (the displayed truth, not the target want)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const seen: Array<string | null> = []
    serviceUnsubscribers.push(
      petweenClientService.subscribePose((pose) => seen.push(pose === null ? null : pose.poseKey)),
    )
    expect(petweenClientService.flashPose('success', 300)).toBe(true)
    expect(seen[seen.length - 1]).toBe('success') // flash shown NOW, unlike snapshot.poseKey
    await vi.advanceTimersByTimeAsync(300)
    expect(seen[seen.length - 1]).toBe('idle')
  })

  it('a throwing listener is isolated: the subscription registers and later pushes still land', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Direct surface consumer: the immediate push must not let a listener
    // throw back through subscribePose and lose the unsubscribe handle.
    let throwerCalls = 0
    serviceUnsubscribers.push(
      context.session.subscribePose(() => {
        throwerCalls += 1
        throw new Error('companion exploded')
      }),
    )
    expect(throwerCalls).toBe(1) // the current pose arrived…
    expect(warn).toHaveBeenCalledTimes(1) // …and the throw was isolated

    const seen: Array<string | null> = []
    serviceUnsubscribers.push(context.session.subscribePose((pose) => seen.push(pose.poseKey)))
    expect(seen).toEqual(['idle']) // a later subscriber still gets the immediate push

    // …and a runtime swap reaches the healthy listener past the thrower.
    expect(petweenClientService.flashPose('success', 300)).toBe(true)
    expect(seen[seen.length - 1]).toBe('success')
    expect(throwerCalls).toBe(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('extension service — subscribeUserPointer', () => {
  it('clicks carry a maintained detail count (double-click window)', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const events: UserPointerEvent[] = []
    serviceUnsubscribers.push(petweenClientService.subscribeUserPointer((event) => events.push(event)))

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 900, 600))
    body.dispatchEvent(pointer('pointerdown', 902, 601))
    window.dispatchEvent(pointer('pointerup', 902, 601))
    expect(events.filter((event) => event.kind === 'click')).toEqual([
      { kind: 'click', x: 900, y: 600, detail: 1 },
      { kind: 'click', x: 902, y: 601, detail: 2 },
    ])
    await settleTransitions() // the two click pops played out
  })

  it('a drag fires no click events', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const events: UserPointerEvent[] = []
    serviceUnsubscribers.push(petweenClientService.subscribeUserPointer((event) => events.push(event)))

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 920, 620)) // ≥4px: a drag
    window.dispatchEvent(pointer('pointerup', 920, 620))
    expect(events).toEqual([]) // neither click nor hover came from the gesture
  })

  it('hover enter/move/leave; move coalesces to the last position per frame', async () => {
    // Deterministic rAF: a faked-timer frame, so coalescing is observable.
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback): number => setTimeout(() => callback(performance.now()), 16) as unknown as number,
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
      clearTimeout(handle)
    })
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const events: UserPointerEvent[] = []
    serviceUnsubscribers.push(petweenClientService.subscribeUserPointer((event) => events.push(event)))

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('mouseenter', 910, 610))
    expect(events).toEqual([{ kind: 'hover-enter', x: 910, y: 610 }])

    body.dispatchEvent(pointer('mousemove', 911, 611))
    body.dispatchEvent(pointer('mousemove', 915, 614))
    expect(events.filter((event) => event.kind === 'hover-move')).toEqual([]) // still one frame out
    await vi.advanceTimersByTimeAsync(20)
    expect(events.filter((event) => event.kind === 'hover-move')).toEqual([{ kind: 'hover-move', x: 915, y: 614 }])

    body.dispatchEvent(pointer('mouseleave', 930, 630))
    expect(events[events.length - 1]).toEqual({ kind: 'hover-leave', x: 930, y: 630 })
  })
})

describe('extension service — subscribeAnimation', () => {
  it('external plays: start + settle(finished); an interrupted play settles cancelled', async () => {
    const context = setup(undefined, [makeCustom('user:spin', 320)])
    setActivePetSession(context.session)
    const events: DirectorPlaybackEvent[] = []
    serviceUnsubscribers.push(petweenClientService.subscribeAnimation((event) => events.push(event)))
    await boot(context) // the idle enter: start + settle(finished)
    expect(events.some((event) => event.source === 'enter' && event.phase === 'start')).toBe(true)
    expect(events.some((event) => event.source === 'enter' && event.phase === 'settle' && event.status === 'finished')).toBe(true)

    petweenClientService.playAnimation('user:spin')
    await settleTransitions()
    expect(events.filter((event) => event.source === 'external')).toEqual([
      { phase: 'start', source: 'external', definitionId: 'user:spin' },
      { phase: 'settle', source: 'external', definitionId: 'user:spin', status: 'finished' },
    ])

    petweenClientService.playAnimation('user:spin')
    petweenClientService.playAnimation('user:spin') // interrupts the one above
    await settleTransitions()
    expect(events.filter((event) => event.source === 'external' && event.status === 'cancelled')).toHaveLength(1)
  })

  it('click interactions attribute as interaction', async () => {
    const context = setup()
    setActivePetSession(context.session)
    await boot(context)
    const events: DirectorPlaybackEvent[] = []
    serviceUnsubscribers.push(petweenClientService.subscribeAnimation((event) => events.push(event)))

    const body = context.stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600)) // a click
    await settleTransitions()
    const interactions = events.filter((event) => event.source === 'interaction')
    expect(interactions[0]?.phase).toBe('start')
    expect(interactions.some((event) => event.phase === 'settle' && event.status === 'finished')).toBe(true)
  })
})
