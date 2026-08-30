// @vitest-environment jsdom
/**
 * PreviewSession / renderer flow tests (spec §29.3): the REAL stack —
 * PetStage (real layered DOM) + MotionDirector + Timeline Engine, driven by
 * ManualStateSource — with a fake WAAPI. Verifies pre transition → pose-swap
 * → post segment → ambient on the correct layers, interruption, dispose,
 * reduced motion and the §23 visibility policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetweenConfig, PoseKey } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
import { PetStage } from '../../src/client/overlay/pet-stage'
import { PreviewSession } from '../../src/client/preview-session'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

let harness: FakeAnimateHarness

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  harness.restore()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const COALESCE_MS = 60

const assetUrl = (key: PoseKey): string => `https://example.test/${key}.webp`

interface Setup {
  stage: PetStage
  config: PetweenConfig
  assets: Record<string, AssetMeta>
  session: PreviewSession
  image: HTMLImageElement
}

const setup = (mutateConfig?: (config: PetweenConfig) => void): Setup => {
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
      sha256: `sha-${key}`,
      url: assetUrl(key),
    }
  }
  mutateConfig?.(config)
  const session = new PreviewSession({ stage, config, assets })
  const image = stage.element.querySelector('img')
  if (image === null) throw new Error('pose img missing')
  return { stage, config, assets, session, image }
}

/** Flushes microtasks until the condition holds (bounded), then returns. */
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

/** Boots the session: preload → idle enter transition → idle ambient. */
const boot = async ({ session }: Setup): Promise<void> => {
  const started = session.start()
  await flushUntil(() => harness.animations.length > 0) // preload resolved, enter began
  await settleTransitions()
  await started
}

const runningLoopsOn = (layer: HTMLElement): number =>
  harness.pending().filter((animation) => animation.target === layer && animation.options.iterations === Infinity)
    .length

describe('PreviewSession — boot and the §29.3 flow', () => {
  it('start() preloads, then runs pre → pose-swap → post → ambient on the right layers', async () => {
    const context = setup()
    const { stage, session, image } = context
    const started = session.start()
    await flushUntil(() => harness.animations.length > 0)

    // pre transition on the transition layer; the pose has NOT swapped yet
    const pre = harness.animations.filter((animation) => animation.target === stage.layers.transition)
    expect(pre).toHaveLength(1)
    expect(pre[0].playState).toBe('running')
    expect(image.getAttribute('src')).toBeNull()

    // pre segment finished → the scheduler fires pose-swap → img src changes
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    expect(image.getAttribute('src')).toBe(assetUrl('idle'))

    // post segment runs on the transition layer as a second animation
    const transitionAnimations = harness.animations.filter(
      (animation) => animation.target === stage.layers.transition,
    )
    expect(transitionAnimations).toHaveLength(2)
    expect(transitionAnimations[1].playState).toBe('running')

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await started

    // idle ambient (§11.3): sway + breathe loops on their OWN layers, no bounce
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    expect(runningLoopsOn(stage.layers.breathe)).toBe(1)
    expect(runningLoopsOn(stage.layers.bounce)).toBe(0)
    expect(harness.pending().every((animation) => animation.options.iterations === Infinity)).toBe(true)
    session.dispose()
  })

  it('a state click walks source → resolver → director and lands each ambient channel on its layer', async () => {
    const context = setup()
    const { stage, session, image } = context
    await boot(context)
    const idleSwayLoop = harness.pending().find((animation) => animation.target === stage.layers.sway)

    session.source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)

    // the enter transition started; the previous ambient was stopped first
    expect(idleSwayLoop?.playState).toBe('idle')
    const pre = harness.pending().filter((animation) => animation.target === stage.layers.transition)
    expect(pre).toHaveLength(1)
    expect(image.getAttribute('src')).toBe(assetUrl('idle')) // old pose still up

    await settleTransitions()
    expect(image.getAttribute('src')).toBe(assetUrl('thinking'))

    // thinking ambient (§11.1): sway loop on sway layer, bounce pending on a
    // random-interval timer (800~1300ms), breathe off
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    expect(runningLoopsOn(stage.layers.breathe)).toBe(0)
    await vi.advanceTimersByTimeAsync(1500)
    const bouncePass = harness
      .pending()
      .find((animation) => animation.target === stage.layers.bounce && animation.options.iterations !== Infinity)
    expect(bouncePass).toBeDefined()
    session.dispose()
  })

  it('interrupt before pose-swap: the old transition cancels and never swaps', async () => {
    const context = setup()
    const { stage, session, image } = context
    await boot(context)
    const swapSpy = vi.spyOn(stage, 'swapPose')
    swapSpy.mockClear() // ignore the boot swap

    session.source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    const stalePre = harness.pending().filter((animation) => animation.target === stage.layers.transition)
    expect(stalePre).toHaveLength(1)

    // a new state arrives mid-transition: A must die immediately
    session.source.sendState('waiting')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    expect(stalePre.every((animation) => animation.playState === 'idle')).toBe(true)

    await settleTransitions()
    // A's pose-swap never fired — the sequence is exactly [waiting]
    expect(swapSpy.mock.calls.map(([pose]) => pose.poseKey)).toEqual(['waiting'])
    expect(image.getAttribute('src')).toBe(assetUrl('waiting'))
    // waiting ambient (§11.4): sway + breathe loops
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    expect(runningLoopsOn(stage.layers.breathe)).toBe(1)
    session.dispose()
  })

  it('reduced motion: transitions shrink ≤120ms, ambient never starts, pose still swaps (§22)', async () => {
    const context = setup((config) => {
      config.global.reducedMotion = 'always'
    })
    const { stage, session, image } = context
    expect(stage.reducedMotion).toBe(true) // applied by the session at construction
    const started = session.start()
    await flushUntil(() => harness.animations.length > 0)
    expect(harness.animations[0].options.duration).toBeLessThanOrEqual(120)
    await settleTransitions()
    await started
    expect(image.getAttribute('src')).toBe(assetUrl('idle'))
    expect(harness.pending()).toHaveLength(0) // no ambient loops at all
    session.dispose()
  })
})

describe('PreviewSession — §23 visibility policy and dispose', () => {
  const setVisibility = (hidden: boolean): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('hidden pauses everything in place; visible resumes the same loops (phase kept)', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const loopsBefore = harness.pending().filter((animation) => animation.options.iterations === Infinity)
    expect(loopsBefore.length).toBeGreaterThan(0)

    setVisibility(true)
    for (const animation of harness.pending()) expect(animation.playState).toBe('paused')
    await vi.advanceTimersByTimeAsync(5000) // ambient timers stay suspended too
    expect(harness.pending()).toHaveLength(loopsBefore.length) // frozen, not cancelled

    setVisibility(false)
    for (const animation of harness.pending()) expect(animation.playState).toBe('running')
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    expect(runningLoopsOn(stage.layers.breathe)).toBe(1)
    // the SAME loop instances resumed — the ambient phase survived the hidden stint
    expect(harness.pending().filter((animation) => animation.options.iterations === Infinity)).toEqual(loopsBefore)
    session.dispose()
  })

  it('dispose cancels every animation and timer (§23)', async () => {
    const context = setup()
    const { session } = context
    await boot(context)
    session.source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    session.dispose()
    expect(harness.pending()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000) // no bounce timer fires after dispose
    expect(harness.pending()).toHaveLength(0)
  })

  it('custom definitions play through director.play and are cancelled on dispose (§36)', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const custom: AnimationDefinition = {
      version: 1,
      id: 'user:spin',
      name: 'Spin',
      kind: 'interaction',
      durationMs: 300,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.rotation',
          keyframes: [
            { at: 0, value: 0 },
            { at: 1, value: 360 },
          ],
        },
      ],
    }
    session.registry.register(custom)
    const instance = session.playCustom('user:spin')
    const spin = harness.animations[harness.animations.length - 1]
    expect(spin.target).toBe(stage.layers.transition)
    expect(spin.playState).toBe('running')
    session.dispose()
    expect(spin.playState).toBe('idle')
    expect(harness.pending()).toHaveLength(0)
    expect(instance.status).not.toBe('running')
  })
})

describe('PreviewSession — replayStateEnter (edited-state preview)', () => {
  it('switches the stage to the edited slot — the switch itself plays its enter', async () => {
    const context = setup()
    const { stage, session, image } = context
    await boot(context)
    expect(image.getAttribute('src')).toBe(assetUrl('idle'))

    session.replayStateEnter('thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS) // resolver coalescing window
    const pre = harness.pending().filter((animation) => animation.target === stage.layers.transition)
    expect(pre).toHaveLength(1) // thinking's enter transition started
    await settleTransitions()
    expect(image.getAttribute('src')).toBe(assetUrl('thinking'))
    session.dispose()
  })

  it('replays directly when the stage already shows the edited slot', async () => {
    const context = setup()
    const { session, image } = context
    await boot(context) // boot leaves the stage on idle
    const before = harness.animations.length

    session.replayStateEnter('idle')
    await flushUntil(() => harness.animations.length > before)
    // a fresh idle enter began: had this delegated to sendState, the resolver
    // dedupe (§15.1) would have swallowed it and nothing would play
    expect(harness.animations.length).toBeGreaterThan(before)
    await settleTransitions()
    expect(image.getAttribute('src')).toBe(assetUrl('idle'))
    session.dispose()
  })
})

describe('PreviewSession — custom animation sync and 试播 (V1.1)', () => {
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

  const makeAmbient = (durationMs: number): AnimationDefinition => ({
    version: 1,
    id: 'user:float',
    name: 'Float',
    kind: 'ambient',
    durationMs,
    repeat: { mode: 'loop' },
    tracks: [
      {
        property: 'sway.rotation',
        keyframes: [
          { at: 0, value: -2 },
          { at: 1, value: 2 },
        ],
      },
    ],
  })

  it('registers option customs at construction and follows updateCustoms (add/change/remove)', async () => {
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
        sha256: `sha-${key}`,
        url: assetUrl(key),
      }
    }
    const session = new PreviewSession({ stage, config, assets, customs: [makeCustom('user:a')] })
    expect(session.registry.get('user:a')).toBeDefined()

    session.updateCustoms([makeCustom('user:a', 450), makeCustom('user:b')])
    expect(session.registry.get('user:a')?.durationMs).toBe(450)
    expect(session.registry.get('user:b')).toBeDefined()

    session.updateCustoms([])
    expect(session.registry.get('user:a')).toBeUndefined()
    expect(session.registry.get('user:b')).toBeUndefined()
    // built-ins survive every sync
    expect(session.registry.get('builtin:comic-pop')).toBeDefined()
    session.dispose()
  })

  it('runs a configured custom ambient and hot-restarts it after library edits', async () => {
    const context = setup((config) => {
      config.states.idle.ambient.sway.enabled = false
      config.states.idle.ambient.customAnimationId = 'user:float'
    })
    context.session.updateCustoms([makeAmbient(700)])
    await boot(context)
    const first = harness.animations.find(
      (animation) => animation.target === context.stage.layers.sway && animation.options.duration === 700,
    )
    expect(first?.playState).toBe('running')

    context.session.updateCustoms([makeAmbient(950)])
    expect(first?.playState).toBe('idle')
    const replacement = harness.animations.find(
      (animation) => animation.target === context.stage.layers.sway && animation.options.duration === 950,
    )
    expect(replacement?.playState).toBe('running')
    context.session.dispose()
  })

  it('previewDefinition validates, (re)registers under the scratch id and plays it', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)

    const draft: AnimationDefinition = {
      ...makeCustom('user:whatever'),
      kind: 'transition',
      tracks: [
        {
          property: 'transition.scaleY',
          keyframes: [
            { at: 0, value: 1 },
            { at: 1, value: 1 },
          ],
        },
      ],
      events: [{ at: 0.5, type: 'pose-swap' }],
    }
    const instance = session.previewDefinition(draft)
    const played = harness.animations[harness.animations.length - 1]
    expect(played.target).toBe(stage.layers.transition)
    expect(played.playState).toBe('running')
    expect(instance.status).toBe('running')

    // a second audition re-registers the scratch id instead of throwing
    const again = session.previewDefinition({ ...draft, durationMs: 500 })
    expect(again.status).toBe('running')

    // invalid definitions are rejected before anything is registered
    expect(() => session.previewDefinition({ ...draft, events: [] })).toThrow(/pose-swap/)
    // the scratch registration never leaks into the customs namespace sync
    session.updateCustoms([makeCustom('user:a')])
    expect(session.registry.get('user:a')).toBeDefined()
    // a re-audition after the sync re-registers the scratch id and plays
    const audition = session.previewDefinition(draft)
    expect(audition.status).toBe('running')
    expect(harness.animations[harness.animations.length - 1].target).toBe(stage.layers.transition)
    session.dispose()
  })
})

describe('PreviewSession — editor hot-reload fixes (M2 leftovers, M5)', () => {
  it('importing the shown pose\'s own image hot-swaps the fallback without another state click', async () => {
    // thinking (and working, its next fallback) have no image: the thinking
    // state shows the IDLE image through the fallback chain.
    const context = setup((config) => {
      config.poses.thinking.assetId = ''
      config.poses.working.assetId = ''
    })
    const { config, assets, session, image } = context
    await boot(context)

    session.source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    await settleTransitions()
    expect(image.getAttribute('src')).toBe(assetUrl('idle')) // fallback face

    // the thinking image lands in the draft: the preview must follow on its own
    const draft = structuredClone(config)
    draft.poses.thinking.assetId = 'asset-thinking'
    await session.updateConfig(draft, assets)
    expect(image.getAttribute('src')).toBe(assetUrl('thinking'))
    session.dispose()
  })

  it('an anchor/zoom edit during an in-flight transition wins over the stale pose-swap', async () => {
    const context = setup()
    const { config, assets, session, image } = context
    await boot(context)

    session.source.sendState('active', 'thinking')
    await vi.advanceTimersByTimeAsync(COALESCE_MS)
    // pre segment in flight; the pose has not swapped yet
    expect(image.getAttribute('src')).toBe(assetUrl('idle'))

    // the user drags the anchor/zoom sliders mid-transition
    const draft = structuredClone(config)
    draft.poses.thinking.anchor = { x: 0.5, y: 0.8 }
    draft.poses.thinking.zoom = 1.5
    const updating = session.updateConfig(draft, assets)

    await settleTransitions()
    await updating

    // the stage ends on the EDITED values, not the ones resolved at transition
    // start (anchor 0.96 / zoom 1 would leave top at -9.6px)
    expect(image.getAttribute('src')).toBe(assetUrl('thinking'))
    expect(image.style.width).toBe('240px') // 160 contain-fit × 1.5
    expect(image.style.top).toBe('-48px') // 0.9*160 - 0.8*240
    session.dispose()
  })

  it('a replayed enter transition is tracked too: edits during replay land after it settles', async () => {
    const context = setup()
    const { config, assets, session, image } = context
    await boot(context)

    session.replayEnter()
    await vi.advanceTimersByTimeAsync(0) // replay's pre segment is in flight

    const draft = structuredClone(config)
    draft.poses.idle.anchor = { x: 0.5, y: 1 }
    const updating = session.updateConfig(draft, assets)
    await settleTransitions()
    await updating

    expect(image.getAttribute('src')).toBe(assetUrl('idle'))
    expect(image.style.top).toBe('-16px') // 0.9*160 - 1*160
    session.dispose()
  })

  it('the aliased editor draft: in-place mutations still fire the ambient / reduced-motion refresh', async () => {
    // Regression: the constructor used to keep the PASSED config object, and
    // the editor mutates that same draft in place (EditorStore.updateConfig)
    // — updateConfig then compared the draft against itself, so the
    // refreshAmbient/applyReducedMotion calls below never fired.
    const context = setup()
    const { stage, config, assets, session } = context
    await boot(context)
    const swayLoop = harness.pending().find((animation) => animation.target === stage.layers.sway)
    expect(swayLoop?.playState).toBe('running')

    // Same reference, mutated in place — exactly what the editor hands over.
    config.states.idle.ambient.sway.enabled = false
    await session.updateConfig(config, assets)
    expect(swayLoop?.playState).toBe('idle') // refreshAmbient ran
    expect(runningLoopsOn(stage.layers.sway)).toBe(0)

    config.global.reducedMotion = 'always'
    await session.updateConfig(config, assets)
    expect(stage.reducedMotion).toBe(true) // applyReducedMotion ran
    expect(harness.pending()).toHaveLength(0) // ambient stays off under reduce
    session.dispose()
  })
})
