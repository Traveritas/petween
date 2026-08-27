// @vitest-environment jsdom
/**
 * OverlaySession tests (M3, spec §27/§28/§22/§23): boot into idle + ambient,
 * the §2.1 no-image gate, hub-driven config hot-apply (pose re-resolve,
 * scale, substantive ambient restarts), the three reduced-motion modes,
 * in-place pause/resume on visibility change, drag persistence through the
 * hub, click pop, double-click → editor page, and resize re-clamping. Real
 * PetStage + Timeline Engine with a fake WAAPI; the hub and saveConfig are
 * injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPatch } from '../../src/client/api'
import { ConfigHub, type ConfigSnapshot } from '../../src/client/config-hub'
import { OverlaySession, type OverlaySessionOptions } from '../../src/client/overlay-session'
import { PetStage } from '../../src/client/overlay/pet-stage'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AssetMeta, PetweenConfig, PoseKey } from '../../src/core/types'
import { POSE_KEYS } from '../../src/core/types'
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
  image: HTMLImageElement
}

const setup = (
  mutateConfig?: (config: PetweenConfig, assets: Record<string, AssetMeta>) => void,
  sessionOptions?: Partial<OverlaySessionOptions>,
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
    fetchAnimations: vi.fn(async () => ({ customs: structuredClone(customs), warnings: [] })),
  })
  hub.publish({ config, assets, customs: structuredClone(customs) }) // seeds the cache synchronously
  // Simulates the host: merge the patch onto the current config, return it.
  const patchConfig = vi.fn(async (patch: ConfigPatch) => {
    const merged = structuredClone(hub.getCurrent()?.config ?? config)
    if (patch.overlay !== undefined) merged.overlay = { ...merged.overlay, ...patch.overlay }
    return merged
  })
  const session = new OverlaySession({ stage, hub, patchConfig, ...sessionOptions })
  const image = stage.element.querySelector('img')
  if (image === null) throw new Error('pose img missing')
  return { stage, config, assets, hub, session, patchConfig, image }
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

const runningLoopsOn = (layer: HTMLElement): number =>
  harness.pending().filter(
    (animation) => animation.target === layer && animation.options.iterations === Infinity && animation.playState === 'running',
  ).length

const pointer = (type: string, x: number, y: number): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })

const setVisibility = (hidden: boolean): void => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('OverlaySession — boot and the §2.1 gate', () => {
  it('boots into idle: pose swapped in, idle ambient loops on their layers', async () => {
    const context = setup()
    const { stage, session, image } = context
    await boot(context)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))
    // idle ambient (§11.3): sway + breathe, no bounce
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    expect(runningLoopsOn(stage.layers.breathe)).toBe(1)
    expect(runningLoopsOn(stage.layers.bounce)).toBe(0)
    session.dispose()
  })

  it('no usable image → nothing renders or animates; a later publish boots it', async () => {
    const context = setup((config, assets) => {
      for (const key of POSE_KEYS) delete config.poses[key].assetId
      for (const key of Object.keys(assets)) delete assets[key]
    })
    const { stage, session, image, hub } = context
    await session.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.currentPose).toBeNull()
    expect(image.getAttribute('src')).toBeNull()
    expect(harness.animations).toHaveLength(0)

    // the editor imports the first image and its save publishes (M3 path)
    const config = structuredClone(hub.getCurrent()?.config) as PetweenConfig
    config.poses.idle.assetId = 'asset-idle'
    publish(hub, config, { 'asset-idle': makeAsset('asset-idle') })
    await flushUntil(() => harness.animations.length > 0)
    await settleTransitions()
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    session.dispose()
  })
})

describe('OverlaySession — hub-driven config hot-apply', () => {
  it('re-resolves the pose and follows scale on publish', async () => {
    const context = setup()
    const { stage, session, image, hub } = context
    await boot(context)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))

    const next = structuredClone(hub.getCurrent()?.config) as PetweenConfig
    next.poses.idle.assetId = 'asset-new'
    next.global.scale = 1.5
    publish(hub, next, { ...context.assets, 'asset-new': makeAsset('asset-new') })
    await flushUntil(() => image.getAttribute('src') === assetUrl('asset-new'))
    expect(image.getAttribute('src')).toBe(assetUrl('asset-new'))
    const userScaleLayer = stage.element.firstElementChild as HTMLElement
    expect(userScaleLayer.style.transform).toBe('scale(1.5)')
    session.dispose()
  })

  it('a pose/anchor edit during an in-flight transition wins over the stale pose-swap', async () => {
    const context = setup()
    const { session, hub, image } = context
    await boot(context)

    // a transition starts (the agent-state path drives the same director)
    const pending = session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle')) // pre segment: no swap yet

    // mid-transition edit: the thinking anchor/zoom change
    const next = structuredClone(hub.getCurrent()?.config) as PetweenConfig
    next.poses.thinking.anchor = { x: 0.5, y: 0.8 }
    next.poses.thinking.zoom = 1.5
    publish(hub, next, context.assets)

    await settleTransitions()
    await pending
    // the refresh waited out the in-flight transition, then applied the NEW
    // values — the transition's own pose-swap carried pre-edit values
    await flushUntil(() => image.style.top === '-48px')
    expect(image.getAttribute('src')).toBe(assetUrl('asset-thinking'))
    expect(image.style.width).toBe('240px') // 160 contain-fit × 1.5
    expect(image.style.top).toBe('-48px') // 0.9*160 - 0.8*240 (stale would be -9.6px)
    session.dispose()
  })

  it('restarts ambient only on a substantive states change', async () => {
    const context = setup()
    const { stage, session, hub } = context
    await boot(context)
    const swayBefore = harness.pending().find((animation) => animation.target === stage.layers.sway)
    const countBefore = harness.animations.length

    // identical content republished (e.g. a poll diff false positive): no restart
    publish(hub, hub.getCurrent()?.config as PetweenConfig, context.assets)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.animations).toHaveLength(countBefore)
    expect(harness.pending().find((animation) => animation.target === stage.layers.sway)).toBe(swayBefore)

    // a real ambient change restarts the affected channel
    const next = structuredClone(hub.getCurrent()?.config) as PetweenConfig
    next.states.idle.ambient.sway.angleDeg = 2.2
    publish(hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0)
    expect(swayBefore?.playState).toBe('idle') // old loop disposed
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)
    expect(harness.animations.length).toBeGreaterThan(countBefore)
    session.dispose()
  })
})

describe('OverlaySession — reduced motion (§22)', () => {
  const stubMatchMedia = (initial: boolean): { setMatches(value: boolean): void } => {
    let matches = initial
    const listeners = new Set<() => void>()
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        get matches() {
          return matches
        },
        media: query,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      })),
    )
    return {
      setMatches(value: boolean) {
        matches = value
        for (const listener of listeners) listener()
      },
    }
  }

  it("'always' reduces at construction: transitions shrink, ambient stays off", async () => {
    const context = setup((config) => {
      config.global.reducedMotion = 'always'
    })
    const { stage, session, image } = context
    expect(stage.reducedMotion).toBe(true)
    const started = session.start()
    await flushUntil(() => harness.animations.length > 0)
    expect(harness.animations[0].options.duration).toBeLessThanOrEqual(120)
    await settleTransitions()
    await started
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))
    expect(harness.pending()).toHaveLength(0) // no ambient under reduce
    session.dispose()
  })

  it("'never' overrides a reducing system; 'system' follows live changes", async () => {
    const media = stubMatchMedia(true)
    const context = setup((config) => {
      config.global.reducedMotion = 'never'
    })
    const { stage, session } = context
    expect(stage.reducedMotion).toBe(false) // override beats the reducing system
    await boot(context)
    expect(runningLoopsOn(stage.layers.sway)).toBe(1)

    // switch the config to 'system' → reduce applies; flip the OS setting → lifts
    const next = structuredClone(context.hub.getCurrent()?.config) as PetweenConfig
    next.global.reducedMotion = 'system'
    publish(context.hub, next, context.assets)
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.reducedMotion).toBe(true)
    expect(harness.pending()).toHaveLength(0)

    media.setMatches(false)
    expect(stage.reducedMotion).toBe(false)
    expect(runningLoopsOn(stage.layers.sway)).toBe(1) // ambient profile back on
    session.dispose()
  })
})

describe('OverlaySession — §23 visibility policy', () => {
  it('hidden pauses ambient in place; visible resumes the same loops', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const loopsBefore = harness.pending()
    expect(loopsBefore.length).toBeGreaterThan(0)

    setVisibility(true)
    for (const animation of harness.pending()) expect(animation.playState).toBe('paused')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.animations.filter((animation) => animation.playState === 'paused')).toHaveLength(loopsBefore.length)

    setVisibility(false)
    for (const animation of harness.pending()) expect(animation.playState).toBe('running')
    expect(runningLoopsOn(stage.layers.sway)).toBe(1) // phase preserved, not restarted
    session.dispose()
  })
})

describe('OverlaySession — position, drag persistence, click (§27/§28)', () => {
  it('uses the §27 default corner until the first drag', () => {
    const { stage, session } = setup()
    expect(stage.element.style.right).toBe('24px')
    expect(stage.element.style.bottom).toBe('24px')
    expect(stage.element.style.left).toBe('auto')
    session.dispose()
  })

  it('applies a persisted position from config.overlay on construction', () => {
    const { stage, session } = setup((config) => {
      config.overlay = { x: 300, y: 200 }
    })
    expect(stage.element.style.left).toBe('300px')
    expect(stage.element.style.top).toBe('200px')
    expect(stage.element.style.right).toBe('auto')
    session.dispose()
  })

  it('a drag moves the pet and persists the clamped position as an overlay-only patch', async () => {
    const context = setup()
    const { stage, session, hub, patchConfig } = context
    await boot(context)
    const body = stage.interactiveElement
    // default corner in jsdom (1024×768, 160px stage, 24px margin) = (840, 584)
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 940, 640))
    expect(stage.element.style.left).toBe('880px') // (840,584) + (40,40)
    expect(stage.element.style.top).toBe('624px')
    window.dispatchEvent(pointer('pointerup', 940, 640))
    expect(patchConfig).not.toHaveBeenCalled() // debounce pending

    await vi.advanceTimersByTimeAsync(300)
    expect(patchConfig).toHaveBeenCalledTimes(1)
    // only the overlay slice is submitted — never a full copied config
    expect(patchConfig.mock.calls[0][0]).toEqual({ overlay: { x: 880, y: 624 } })
    await vi.advanceTimersByTimeAsync(0) // publish lands
    expect(hub.getCurrent()?.config.overlay).toEqual({ x: 880, y: 624 })
    // the self-echo must not move the pet anywhere
    expect(stage.element.style.left).toBe('880px')
    session.dispose()
  })

  it('a click plays the click-pop on the transition layer without swapping the pose', async () => {
    const context = setup()
    const { stage, session, image } = context
    await boot(context)
    const srcBefore = image.getAttribute('src')
    const countBefore = harness.animations.length

    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600)) // 1px — a click
    expect(harness.animations.length).toBeGreaterThan(countBefore)
    const pop = harness.animations[harness.animations.length - 1]
    expect(pop.target).toBe(stage.layers.transition)
    expect(pop.options.duration).toBe(140)
    expect(image.getAttribute('src')).toBe(srcBefore) // §28: no state/pose change
    await settleTransitions()
    session.dispose()
  })

  it('Enter and Space on the focused pet body trigger the same interaction as a click (a11y)', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const body = stage.interactiveElement
    expect(body.getAttribute('role')).toBe('button') // the hit region is focusable
    expect(body.tabIndex).toBe(0)

    const countBefore = harness.animations.length
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    body.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(harness.animations.length).toBeGreaterThan(countBefore)
    await settleTransitions()

    const countAfterEnter = harness.animations.length
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    body.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(true) // Space must not scroll the page
    expect(harness.animations.length).toBeGreaterThan(countAfterEnter)
    await settleTransitions()
    session.dispose()
  })

  it('modified or unrelated keys never trigger the keyboard interaction', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const countBefore = harness.animations.length
    const body = stage.interactiveElement

    const modified = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })
    body.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(false) // browser shortcuts stay intact
    const unrelated = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    body.dispatchEvent(unrelated)
    expect(harness.animations.length).toBe(countBefore)
    session.dispose()
  })

  it('a click dismisses a held terminal face through the state source (§14.4)', async () => {
    const dismissTerminal = vi.fn()
    const context = setup(undefined, {
      createStateSource: () => ({ dispose: vi.fn(), dismissTerminal }),
    })
    const { stage, session } = context
    await boot(context)

    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600)) // 1px — a click
    expect(dismissTerminal).toHaveBeenCalledTimes(1)
    await settleTransitions()
    session.dispose()
  })

  it('a click plays the configured interaction; the dismiss stays ahead of it', async () => {
    const dismissTerminal = vi.fn()
    const context = setup(
      (config) => {
        config.interactions.click.animation = 'builtin:click-spin'
      },
      { createStateSource: () => ({ dispose: vi.fn(), dismissTerminal }) },
    )
    const { stage, session } = context
    await boot(context)
    const playSpy = vi.spyOn(session.director, 'playInteraction')

    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600))
    expect(dismissTerminal).toHaveBeenCalledTimes(1)
    expect(playSpy).toHaveBeenCalledTimes(1)
    expect(dismissTerminal.mock.invocationCallOrder[0]).toBeLessThan(playSpy.mock.invocationCallOrder[0])
    const pop = harness.animations[harness.animations.length - 1]
    expect(pop.target).toBe(stage.layers.transition)
    expect(pop.options.duration).toBe(380) // the configured spin, not the 140ms default pop
    await settleTransitions()
    session.dispose()
  })

  it('a click flashes the configured pose and restores it when the animation finishes', async () => {
    const context = setup((config) => {
      config.interactions.click.pose = 'success'
    })
    const { stage, session, image } = context
    await boot(context)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))

    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600))
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success')) // flashed synchronously

    await settleTransitions()
    await flushUntil(() => image.getAttribute('src') === assetUrl('asset-idle'))
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle')) // restored on finish
    session.dispose()
  })

  it('window resize re-clamps a dragged position into the new viewport (§27)', async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 960, 700))
    window.dispatchEvent(pointer('pointerup', 960, 700))
    expect(stage.element.style.left).toBe('900px')

    vi.stubGlobal('innerWidth', 500)
    window.dispatchEvent(new Event('resize'))
    expect(stage.element.style.left).toBe(`${500 - 32}px`)
    session.dispose()
  })
})

describe('OverlaySession — flash hold + teardown edges (review round 2)', () => {
  it('going hidden completes a pending flash restore immediately (L1)', async () => {
    const context = setup()
    const { session, image } = context
    await boot(context)
    expect(session.flashPose('success', 5000)).toBe(true)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))

    setVisibility(true)
    // The restore is a pure pose swap (no animation): complete it at hide
    // time instead of letting a hidden-tab-throttled timer drag it out.
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))

    await vi.advanceTimersByTimeAsync(10_000)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle')) // no late swap
    session.dispose()
  })

  it('dispose mid-gesture still persists the dragged position (L2)', async () => {
    const context = setup()
    const { stage, session, patchConfig } = context
    await boot(context)
    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 940, 640))
    expect(stage.element.style.left).toBe('880px')

    session.dispose() // gesture interrupted by teardown
    expect(patchConfig).toHaveBeenCalledTimes(1) // the final position was not lost
    expect(patchConfig.mock.calls[0][0]).toEqual({ overlay: { x: 880, y: 624 } })
  })

  it('a same-shape target (§10.3 dedupe) never ends a holdMs<=0 flash hold', async () => {
    const context = setup()
    const { session, image } = context
    await boot(context)
    const pending = session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await settleTransitions()
    await pending
    expect(image.getAttribute('src')).toBe(assetUrl('asset-thinking'))

    expect(session.flashPose('success', 0)).toBe(true)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))

    // reasoning→tool switch: same visualState, same poseKey → the director's
    // dedupe branch (§10.3, ambient-only). The director hook still fires, but
    // a same-shape target must not clear the hold — the stage keeps the flash.
    await session.director.setTarget({
      visualState: 'active',
      activityMode: 'command',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success')) // hold intact

    // A hub publish (e.g. the physics companion's settle commit) runs the
    // refresh pass — an active hold defers it. With the hold wrongly cleared
    // the refresh would force the state pose back and strand the ledger.
    publish(context.hub, context.config, context.assets)
    await vi.advanceTimersByTimeAsync(100)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))

    // a real state change still re-owns the pose (flash is not sticky)
    const back = session.director.setTarget({ visualState: 'idle', poseKey: 'idle', reason: 'agent-state' })
    await settleTransitions()
    await back
    expect(image.getAttribute('src')).toBe(assetUrl('asset-idle'))
    session.dispose()
  })

  it('a same-shape target never cancels a pending timed flash restore', async () => {
    const context = setup()
    const { session, image } = context
    await boot(context)
    const pending = session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await settleTransitions()
    await pending

    expect(session.flashPose('success', 1000)).toBe(true)
    // the same activity switch mid-hold must not cancel the restore timer
    await session.director.setTarget({
      visualState: 'active',
      activityMode: 'command',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))
    await vi.advanceTimersByTimeAsync(1)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-thinking')) // restored on schedule
    session.dispose()
  })
})

describe('OverlaySession — custom animation sync (V1.1)', () => {
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

  it('registers hub customs at construction and follows publish add/change/remove', async () => {
    const context = setup(undefined, undefined, [makeCustom('user:a')])
    const { hub, session, config, assets } = context
    expect(session.registry.get('user:a')).toBeDefined()
    await boot(context)

    publish(hub, config, assets, [makeCustom('user:a', 450), makeCustom('user:b')])
    await flushUntil(() => session.registry.get('user:b') !== undefined)
    expect(session.registry.get('user:a')?.durationMs).toBe(450)

    publish(hub, config, assets, [])
    await flushUntil(() => session.registry.get('user:a') === undefined)
    expect(session.registry.get('user:b')).toBeUndefined()
    // built-ins are never swept
    expect(session.registry.get('builtin:comic-pop')).toBeDefined()
    expect(session.registry.get('builtin:click-pop')).toBeDefined()
    session.dispose()
  })

  it('a configured custom click interaction plays through the synced registry (§28)', async () => {
    const context = setup(
      (config) => {
        config.interactions.click.animation = 'user:wig'
      },
      undefined,
      [makeCustom('user:wig', 260)],
    )
    const { stage, session } = context
    await boot(context)
    const countBefore = harness.animations.length

    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointerup', 901, 600))
    expect(harness.animations.length).toBeGreaterThan(countBefore)
    const pop = harness.animations[harness.animations.length - 1]
    expect(pop.target).toBe(stage.layers.transition)
    expect(pop.options.duration).toBe(260) // the custom, not builtin:click-pop (140ms)
    await settleTransitions()
    session.dispose()
  })

  it('hot-restarts the active custom ambient when the hub definition changes', async () => {
    const context = setup(
      (config) => {
        config.states.idle.ambient.sway.enabled = false
        config.states.idle.ambient.customAnimationId = 'user:float'
      },
      undefined,
      [makeAmbient(700)],
    )
    const { stage, session, hub, config, assets } = context
    await boot(context)
    const first = harness.animations.find(
      (animation) => animation.target === stage.layers.sway && animation.options.duration === 700,
    )
    expect(first?.playState).toBe('running')

    publish(hub, config, assets, [makeAmbient(950)])
    await flushUntil(() => harness.animations.some((animation) => animation.options.duration === 950))
    expect(first?.playState).toBe('idle')
    expect(
      harness.animations.find(
        (animation) => animation.target === stage.layers.sway && animation.options.duration === 950,
      )?.playState,
    ).toBe('running')
    session.dispose()
  })
})

describe('OverlaySession — pose ledger hardening + clamp basis (review round 3, 2026-08-27)', () => {
  const swapFlashCustom = (): AnimationDefinition => ({
    version: 1,
    id: 'user:swapflash',
    name: 'Swap Flash',
    kind: 'interaction',
    durationMs: 600,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.scaleX',
        keyframes: [
          { at: 0, value: 1 },
          { at: 1, value: 1.2 },
        ],
      },
    ],
    events: [{ at: 0.5, type: 'pose-swap', pose: 'success' }],
  })

  it("an external run's settle never clears a LATER flashPose hold (P1)", async () => {
    const context = setup(undefined, undefined, [swapFlashCustom()])
    const { session, image } = context
    await boot(context)
    const enter = session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    await settleTransitions()
    await enter
    expect(image.getAttribute('src')).toBe(assetUrl('asset-thinking'))

    const instance = session.playExternal('user:swapflash')
    expect(instance).not.toBeNull()
    // Finish the pre-swap segment: the event lands the success hold
    // (holdMs 0 = until the next state change).
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))

    // A later flash legitimately replaces the ledger mid-run…
    expect(session.flashPose('error', 10_000)).toBe(true)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-error'))

    // …so the run's own settle must NOT cut the 10s hold short.
    await settleTransitions()
    await instance?.play()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-error'))
    // The hold's own timer restores the CURRENT target's pose on schedule.
    await vi.advanceTimersByTimeAsync(5_001)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-thinking'))
    session.dispose()
  })

  it('a flash mid-enter preempts the transition: stage and ledger never drift (P1)', async () => {
    const context = setup()
    const { session, image } = context
    await boot(context)
    const enter = session.director.setTarget({
      visualState: 'active',
      activityMode: 'thinking',
      poseKey: 'thinking',
      reason: 'agent-state',
    })
    // Still in the pre segment — the enter's own pose-swap has not fired.
    expect(session.director.transitionInFlight).toBe(true)
    expect(session.flashPose('success', 800)).toBe(true)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))

    // Whatever the interrupted enter leaves behind settles cleanly; the flash
    // image stays on stage (pre-fix, the enter's swap overwrote it here and
    // the ledger kept reporting the flash pose).
    await settleTransitions()
    await enter
    expect(image.getAttribute('src')).toBe(assetUrl('asset-success'))
    await vi.advanceTimersByTimeAsync(801)
    expect(image.getAttribute('src')).toBe(assetUrl('asset-thinking'))
    session.dispose()
  })

  it('drag clamps on the VISIBLE square (side × scale): memory, DOM and snapshot agree', async () => {
    const context = setup((config) => {
      config.global.scale = 0.5
    })
    const { stage, session, patchConfig } = context
    await boot(context)
    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', -5000, 600)) // hard against the left wall
    window.dispatchEvent(pointer('pointerup', -5000, 600))
    // visibleSize = max(160×0.5, 32) = 80 → the floor is -(80−32) = −48 on
    // ALL three surfaces. (The pre-fix drag clamp used the unscaled 160 and
    // let this.position carry −128 while the DOM showed −48.)
    expect(stage.element.style.left).toBe('-48px')
    expect(session.getStageSnapshot()?.x).toBe(-48)
    await vi.advanceTimersByTimeAsync(500) // drag-end debounce → the overlay-only patch
    expect(patchConfig.mock.calls[0][0]).toEqual({ overlay: { x: -48, y: 584 } })
    session.dispose()
  })

  it("teardown mid-gesture fires the paired 'end' phase before the streams go dark", async () => {
    const context = setup()
    const { stage, session } = context
    await boot(context)
    const phases: string[] = []
    session.subscribeUserDrag((phase) => {
      phases.push(phase)
    })
    const body = stage.interactiveElement
    body.dispatchEvent(pointer('pointerdown', 900, 600))
    window.dispatchEvent(pointer('pointermove', 940, 640)) // crosses the threshold → 'start'
    expect(phases).toEqual(['start'])
    session.dispose()
    expect(phases).toEqual(['start', 'end'])
  })
})
