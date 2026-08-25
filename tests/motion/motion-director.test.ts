// @vitest-environment jsdom
/**
 * MotionDirector tests (spec §24, §10, §29.1, §29.3): enter transition flow
 * (pre → swap → post), same-state ambient-only updates, the interruption
 * matrix, reduced-motion behavior, and the §36 acceptance hatch — a custom
 * definition executed through director.play() with zero dedicated branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import { createPoseResolver } from '../../src/core/pose-resolver'
import { BUILTIN_ACTIVITY_SWAP, BUILTIN_INTERACTION_DEFINITIONS } from '../../src/core/transition-presets'
import type { AssetMeta, MotionPetConfig, MotionTarget, ResolvedPose } from '../../src/core/types'
import { AmbientEngine } from '../../src/motion/ambient-engine'
import { createBuiltinRegistry, type AnimationRegistry } from '../../src/motion/animation-registry'
import { MotionDirector } from '../../src/motion/motion-director'
import { TimelineEngine } from '../../src/motion/timeline-engine'
import { TransitionEngine } from '../../src/motion/transition-engine'
import type { MotionStage } from '../../src/motion/motion-stage'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { createFakeStage, installFakeAnimate, type FakeAnimateHarness, type FakeStage } from './fake-animate'

let harness: FakeAnimateHarness

beforeEach(() => {
  vi.useFakeTimers()
  harness = installFakeAnimate()
})

afterEach(() => {
  vi.restoreAllMocks()
  harness.restore()
  vi.useRealTimers()
})

const asset = (id: string): AssetMeta => ({
  id,
  fileName: `${id}.webp`,
  mimeType: 'image/webp',
  width: 240,
  height: 240,
  sizeBytes: 1024,
  sha256: `sha-${id}`,
  url: `/motion-pet-assets/${id}.webp`,
})

interface Setup {
  harness: FakeAnimateHarness
  stage: FakeStage
  registry: AnimationRegistry
  config: MotionPetConfig
  director: MotionDirector
}

const setup = (reducedMotion = false): Setup => {
  const stage = createFakeStage(reducedMotion)
  const registry = createBuiltinRegistry()
  // Interactions are session-registered in production (overlay-session).
  for (const definition of BUILTIN_INTERACTION_DEFINITIONS) registry.registerBuiltin(definition)
  const config = createDefaultMotionPetConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
    assets[key] = asset(key)
    config.poses[key].assetId = key
  }
  const director = new MotionDirector({
    stage,
    registry,
    config,
    resolvePose: createPoseResolver(config.poses, assets),
  })
  return { harness, stage, registry, config, director }
}

const target = (partial: Partial<MotionTarget> & Pick<MotionTarget, 'visualState' | 'poseKey'>): MotionTarget => ({
  reason: 'agent-state',
  ...partial,
})

/** Drains all finite (non-ambient) animations until only infinite ones remain. */
const settleTransitions = async (): Promise<void> => {
  for (let guard = 0; guard < 20; guard += 1) {
    const running = harness
      .pending()
      .filter((animation) => animation.options.iterations !== Infinity)
    if (running.length === 0) return
    for (const animation of running) animation.finish()
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error('animations did not settle')
}

describe('MotionDirector — enter transition flow (§10)', () => {
  it('runs pre → pose swap → post → ambient, in order', async () => {
    const { stage, director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))

    // pre segment running on the transition layer, pose not yet swapped
    expect(harness.animations).toHaveLength(1)
    expect(harness.animations[0].target).toBe(stage.layers.transition)
    expect(stage.swapped).toEqual([])

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await pending

    // thinking ambient: sway loop started (bounce is a pending random-interval timer)
    const sway = harness.animations.find((animation) => animation.target === stage.layers.sway)
    expect(sway?.options.iterations).toBe(Infinity)
    director.dispose()
  })

  it("'none' preset swaps the pose without any animation", async () => {
    const { stage, config, director } = setup()
    config.states.waiting.enter.preset = 'none'
    const pending = director.setTarget(target({ visualState: 'waiting', poseKey: 'waiting' }))
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['waiting'])
    expect(harness.animations.filter((a) => a.target === stage.layers.transition)).toHaveLength(0)
    director.dispose()
  })

  it('same visualState + poseKey only refreshes ambient (§10.3)', async () => {
    const { stage, director } = setup()
    const first = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await first
    const countAfterEnter = harness.animations.length

    // activity change inside `active` — the resolver keeps the same poseKey
    const second = director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'thinking' }))
    await vi.advanceTimersByTimeAsync(0)
    await second

    const added = harness.animations.slice(countAfterEnter)
    // no new transition animation; ambient switched to the working profile (breathe on, sway off)
    expect(added.filter((animation) => animation.target === stage.layers.transition)).toHaveLength(0)
    expect(added.some((animation) => animation.target === stage.layers.breathe)).toBe(true)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])
    director.dispose()
  })
})

describe('MotionDirector — interruption matrix (§29.1 generation cancellation)', () => {
  it('A interrupted before pose-swap: A never swaps, B takes over', async () => {
    const { stage, director } = setup()
    const applySpy = vi.spyOn(AmbientEngine.prototype, 'apply')

    const pendingA = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    const pendingB = director.setTarget(target({ visualState: 'waiting', poseKey: 'waiting' }))

    expect(harness.animations[0].playState).toBe('idle') // A's pre segment cancelled immediately
    await settleTransitions()
    await Promise.all([pendingA, pendingB])

    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['waiting']) // A's pose never applied
    expect(applySpy).toHaveBeenCalledTimes(1) // only B restarted ambient
    director.dispose()
  })

  it('A interrupted after pose-swap: A runs no post segment, B owns the final state', async () => {
    const { stage, director } = setup()
    const applySpy = vi.spyOn(AmbientEngine.prototype, 'apply')

    const pendingA = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    harness.finishPending() // A's pre segment completes → pose swap happens
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])
    const postA = harness.animations[harness.animations.length - 1]
    expect(postA.playState).toBe('running') // A's post segment in flight

    const pendingB = director.setTarget(target({ visualState: 'success', poseKey: 'success' }))
    expect(postA.playState).toBe('idle') // A's post segment cancelled
    await settleTransitions()
    await Promise.all([pendingA, pendingB])

    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success'])
    // A was interrupted: it must not restart its ambient — only B (completed) applied ambient
    expect(applySpy).toHaveBeenCalledTimes(1)
    // the final ambient profile is success's: breathe loop, no sway
    const infinite = harness.animations.filter((a) => a.options.iterations === Infinity && a.playState === 'running')
    expect(infinite.map((a) => a.target)).toEqual([stage.layers.breathe])
    director.dispose()
  })
})

describe('MotionDirector — silent pose change inside a visual state (§15.2, activityTransition=none)', () => {
  it('same visualState + new poseKey swaps silently: no transition, ambient applied', async () => {
    const { stage, config, director } = setup()
    config.advanced.activityTransition = 'none'
    const first = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await first
    const countAfterEnter = harness.animations.length

    const silent = director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    expect(director.transitionInFlight).toBe(false) // a silent swap is not a transition
    await director.whenSettled() // resolves immediately
    await silent

    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'working'])
    const added = harness.animations.slice(countAfterEnter)
    expect(added.filter((animation) => animation.target === stage.layers.transition)).toHaveLength(0)
    // the working ambient profile applied: breathe on, sway off
    const infinite = added.filter((animation) => animation.options.iterations === Infinity)
    expect(infinite.map((animation) => animation.target)).toEqual([stage.layers.breathe])
    director.dispose()
  })

  it('a silent target supersedes an in-flight enter transition: its pose-swap never fires', async () => {
    const { stage, config, director } = setup()
    config.advanced.activityTransition = 'none'
    const boot = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    await settleTransitions()
    await boot

    const enter = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    const pre = harness.animations[harness.animations.length - 1]
    expect(pre.target).toBe(stage.layers.transition)
    expect(pre.playState).toBe('running') // thinking's pre segment in flight, pose not swapped yet

    const silent = director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    expect(pre.playState).toBe('idle') // the in-flight enter was cancelled immediately
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([enter, silent])

    // thinking's pose-swap event must never have landed; only the silent swap did
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle', 'working'])
    expect(director.transitionInFlight).toBe(false)
    await director.whenSettled()
    // ambient is the working profile, restarted exactly once (idle's enter + silent)
    const infinite = harness.pending().filter((animation) => animation.options.iterations === Infinity)
    expect(infinite.map((animation) => animation.target)).toEqual([stage.layers.breathe])
    director.dispose()
  })

  it('skips the swap when the new pose resolves to the asset already on stage', async () => {
    const { stage, config, director } = setup()
    config.advanced.activityTransition = 'none'
    config.poses.working.assetId = 'thinking' // working shares the thinking asset
    const first = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await first
    const countAfterEnter = harness.animations.length

    await director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking']) // no redundant swap
    // …but the new activity's ambient profile still applied (breathe on)
    const added = harness.animations.slice(countAfterEnter)
    expect(added.some((animation) => animation.target === stage.layers.breathe)).toBe(true)
    director.dispose()
  })
})

describe('MotionDirector — activityTransition switch (§15.2)', () => {
  const bootThinking = async (director: MotionDirector): Promise<void> => {
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending
  }

  it("'subtle' (default): a same-state pose change plays builtin:activity-swap through the transition path", async () => {
    const { stage, director } = setup()
    await bootThinking(director)

    const swap = director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    expect(director.transitionInFlight).toBe(true) // a real timeline, tracked like any transition
    const pre = harness.animations[harness.animations.length - 1]
    expect(pre.target).toBe(stage.layers.transition)
    // 170ms cut at the 0.4 pose-swap point → a 68ms pre segment (the fade data, no dedicated branch)
    expect(pre.options.duration).toBeCloseTo(BUILTIN_ACTIVITY_SWAP.durationMs * 0.4, 5)
    expect((pre.keyframes as Array<{ opacity: string }>).map((keyframe) => keyframe.opacity)).toEqual(['1', '0.55'])
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking']) // the swap waits for the event

    harness.finishPending() // pre segment completes → the pose-swap event fires
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'working'])

    await settleTransitions()
    await swap
    expect(director.transitionInFlight).toBe(false)
    // ambient restarted with the working profile (breathe on, sway off)
    const infinite = harness.pending().filter((animation) => animation.options.iterations === Infinity)
    expect(infinite.map((animation) => animation.target)).toEqual([stage.layers.breathe])
    director.dispose()
  })

  it("'subtle' interrupted by a real state change: its swap never fires, the new state owns the stage", async () => {
    const { stage, director } = setup()
    const applySpy = vi.spyOn(AmbientEngine.prototype, 'apply')
    const boot = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    await settleTransitions()
    await boot
    applySpy.mockClear()

    const swap = director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    const pre = harness.animations[harness.animations.length - 1]
    expect(pre.playState).toBe('running') // activity-swap pre segment in flight

    const enter = director.setTarget(target({ visualState: 'success', poseKey: 'success' }))
    expect(pre.playState).toBe('idle') // cancelled immediately by the generation bump
    await settleTransitions()
    await Promise.all([swap, enter])

    // the interrupted activity-swap never swapped to 'working' and restarted no ambient
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle', 'success'])
    expect(applySpy).toHaveBeenCalledTimes(1) // only the completed success enter
    const infinite = harness.pending().filter((animation) => animation.options.iterations === Infinity)
    expect(infinite.map((animation) => animation.target)).toEqual([stage.layers.breathe])
    director.dispose()
  })

  it("'subtle' compiles under reduced-motion: ≤120ms, pose-swap event survives", async () => {
    const { stage, director } = setup(true)
    const boot = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    await settleTransitions()
    await boot

    const swap = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    expect(harness.animations[harness.animations.length - 1].options.duration).toBeLessThanOrEqual(120)
    await settleTransitions()
    await swap
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle', 'thinking'])
    director.dispose()
  })

  it("'state': a same-state pose change replays the target state's enter transition", async () => {
    const { stage, config, director } = setup()
    config.advanced.activityTransition = 'state'
    await bootThinking(director)

    const swap = director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    expect(director.transitionInFlight).toBe(true)
    const pre = harness.animations[harness.animations.length - 1]
    expect(pre.target).toBe(stage.layers.transition)
    // working's enter is the global preset (comic-pop 260ms, swap at 0.4) → 104ms pre segment
    expect(pre.options.duration).toBeCloseTo(104, 5)

    await settleTransitions()
    await swap
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'working'])
    director.dispose()
  })
})

describe('MotionDirector — playInteraction (§28)', () => {
  const bootThinking = async (director: MotionDirector): Promise<void> => {
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending
  }

  it('plays the configured interaction animation, no pose swap by default', async () => {
    const { stage, config, director } = setup()
    config.interactions.click.animation = 'builtin:click-wiggle'
    await bootThinking(director)

    const done = director.playInteraction()
    const animation = harness.animations[harness.animations.length - 1]
    expect(animation.target).toBe(stage.layers.transition)
    expect(animation.options.duration).toBe(280)
    await settleTransitions()
    await done
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])
    director.dispose()
  })

  it('falls back to builtin:click-pop for unknown ids and non-interaction kinds', async () => {
    const { stage, config, director } = setup()
    await bootThinking(director)

    config.interactions.click.animation = 'user:missing'
    const unknown = director.playInteraction()
    expect(harness.animations[harness.animations.length - 1].options.duration).toBe(140)
    await settleTransitions()
    await unknown

    config.interactions.click.animation = 'builtin:soft' // a transition, not an interaction
    const wrongKind = director.playInteraction()
    expect(harness.animations[harness.animations.length - 1].options.duration).toBe(140)
    await settleTransitions()
    await wrongKind
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking']) // nothing ever swapped
    director.dispose()
  })

  it('flash pose: swaps to it for the animation duration and back on finish (await-driven)', async () => {
    const { stage, config, director } = setup()
    config.interactions.click.pose = 'success'
    await bootThinking(director)

    const done = director.playInteraction()
    // the flash lands synchronously, ahead of the animation finishing
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success'])

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success', 'thinking'])
    director.dispose()
  })

  it('skips the flash when the pose resolves to the asset already on stage', async () => {
    const { stage, config, director } = setup()
    config.interactions.click.pose = 'thinking'
    await bootThinking(director)

    const done = director.playInteraction()
    expect(harness.animations[harness.animations.length - 1].options.duration).toBe(140) // the pop still plays
    await settleTransitions()
    await done
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking']) // no redundant swap either way
    director.dispose()
  })

  it('skips the flash when the pose resolves to no image at all', async () => {
    const { stage, config, director } = setup()
    for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
      delete config.poses[key].assetId
    }
    config.interactions.click.pose = 'success'
    await director.setTarget(target({ visualState: 'idle', poseKey: 'idle' })) // no image: quiet stage

    const done = director.playInteraction()
    expect(harness.animations[harness.animations.length - 1].options.duration).toBe(140)
    await settleTransitions()
    await done
    expect(stage.swapped).toEqual([])
    director.dispose()
  })

  it('a real target preempts the flash: the swap-back is skipped, the new state owns the pose', async () => {
    const { stage, config, director } = setup()
    config.interactions.click.pose = 'success'
    await bootThinking(director)

    const done = director.playInteraction()
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success']) // flash on stage

    const enter = director.setTarget(target({ visualState: 'error', poseKey: 'error' }))
    await settleTransitions()
    await Promise.all([done, enter])
    // no forced swap-back to 'thinking' after the preemption
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success', 'error'])
    director.dispose()
  })

  it('a newer click supersedes an in-flight flash swap-back', async () => {
    const { stage, config, director } = setup()
    config.interactions.click.pose = 'success'
    await bootThinking(director)
    const baseCount = harness.animations.length

    const first = director.playInteraction()
    const second = director.playInteraction() // same flash pose: no second swap, but a new generation
    const firstAnimation = harness.animations[baseCount]
    const secondAnimation = harness.animations[baseCount + 1]

    firstAnimation.finish()
    await vi.advanceTimersByTimeAsync(0)
    await first
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success']) // no early swap-back

    secondAnimation.finish()
    await vi.advanceTimersByTimeAsync(0)
    await second
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success', 'thinking'])
    director.dispose()
  })
})

describe('MotionDirector — external pose ledger (flash holds)', () => {
  const bootThinking = async (director: MotionDirector): Promise<void> => {
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending
  }

  it('noteExternalPose keeps the silent-swap guard truthful after an out-of-band swap (M2)', async () => {
    const { stage, config, director } = setup()
    config.advanced.activityTransition = 'none'
    config.poses.working.assetId = 'thinking' // working shares the thinking asset
    await bootThinking(director)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])

    // What the overlay session's flashPose does: a direct stage write plus a
    // ledger note. Without the note, stagePoseUrl still says 'thinking' and
    // the silent swap below would skip and strand the flashed image.
    const resolve = createPoseResolver(config.poses, {
      thinking: asset('thinking'),
      success: asset('success'),
    })
    const flashed = resolve('success')
    if (flashed === null) throw new Error('flash pose unresolvable')
    stage.swapPose(flashed)
    director.noteExternalPose(flashed.asset.url)

    await director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'working' }))
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success', 'working'])
    director.dispose()
  })

  it('playInteraction restores to a held external pose; the hold realigns later (M3)', async () => {
    const stage = createFakeStage()
    const registry = createBuiltinRegistry()
    for (const definition of BUILTIN_INTERACTION_DEFINITIONS) registry.registerBuiltin(definition)
    const config = createDefaultMotionPetConfig()
    const assets: Record<string, AssetMeta> = {}
    for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
      assets[key] = asset(key)
      config.poses[key].assetId = key
    }
    const resolvePose = createPoseResolver(config.poses, assets)
    const held = resolvePose('error')
    if (held === null) throw new Error('held pose unresolvable')
    let holdActive = true
    const director = new MotionDirector({
      stage,
      registry,
      config,
      resolvePose,
      getExternalPoseHold: () => (holdActive ? held : null),
    })
    config.interactions.click.pose = 'success'
    await bootThinking(director)

    const done = director.playInteraction()
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success']) // the click's flash

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await done
    // The pending external hold owns the stage pose: the click returned to
    // the HELD pose (error), not the state machine's pose (thinking).
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success', 'error'])
    director.dispose()
  })

  it('playInteraction restores normally once the hold has expired', async () => {
    const stage = createFakeStage()
    const registry = createBuiltinRegistry()
    for (const definition of BUILTIN_INTERACTION_DEFINITIONS) registry.registerBuiltin(definition)
    const config = createDefaultMotionPetConfig()
    const assets: Record<string, AssetMeta> = {}
    for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
      assets[key] = asset(key)
      config.poses[key].assetId = key
    }
    const held = createPoseResolver(config.poses, assets)('error')
    if (held === null) throw new Error('held pose unresolvable')
    let holdActive = false // the hold ended before the click's animation did
    const director = new MotionDirector({
      stage,
      registry,
      config,
      resolvePose: createPoseResolver(config.poses, assets),
      getExternalPoseHold: () => (holdActive ? held : null),
    })
    config.interactions.click.pose = 'success'
    await bootThinking(director)

    const done = director.playInteraction()
    holdActive = false // the hold's deadline passes mid-animation
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking', 'success', 'thinking'])
    director.dispose()
  })
})

describe('MotionDirector — custom definitions (§36 acceptance)', () => {
  it('registry.register(custom) + director.play(custom.id) executes with zero branches', async () => {
    const { stage, registry, director } = setup()
    const custom: AnimationDefinition = {
      version: 1,
      id: 'user:wiggle',
      name: 'Wiggle',
      kind: 'interaction',
      durationMs: 200,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.rotation',
          keyframes: [
            { at: 0, value: 0 },
            { at: 0.5, value: { base: 0, parameter: 'strength', amount: 10 } },
            { at: 1, value: 0 },
          ],
        },
      ],
    }
    registry.register(custom)
    const instance = director.play('user:wiggle', { params: { strength: 1 } })

    expect(harness.animations).toHaveLength(1)
    const animation = harness.animations[0]
    expect(animation.target).toBe(stage.layers.transition)
    const keyframes = animation.keyframes as Array<{ rotate: string }>
    expect(keyframes.map((keyframe) => keyframe.rotate)).toEqual(['0deg', '10deg', '0deg'])

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await instance.play()
    expect(instance.status).toBe('finished')
    director.dispose()
  })

  it('director.play throws for unknown definition ids', () => {
    const { director } = setup()
    expect(() => director.play('user:missing')).toThrow(/unknown animation/)
    director.dispose()
  })
})

describe('MotionDirector — reduced motion (§22)', () => {
  it('transitions shrink to <=120ms and ambient never starts, but pose-swap still happens', async () => {
    const { stage, director } = setup(true)
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    expect(harness.animations[0].options.duration).toBeLessThanOrEqual(120)
    await settleTransitions()
    await pending
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])
    expect(harness.animations.filter((a) => a.options.iterations === Infinity)).toHaveLength(0)
    director.dispose()
  })
})

describe('MotionDirector — stop/dispose', () => {
  it('dispose cancels the in-flight transition and all ambient timers', async () => {
    const { director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending
    director.dispose()
    expect(harness.pending()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000) // no bounce timer survives
    expect(harness.pending()).toHaveLength(0)
  })
})

describe('MotionDirector — pause/resume (§23 hidden-tab policy)', () => {
  it('pause suspends ambient animations and timers; resume continues them in place', async () => {
    const { director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending
    // thinking ambient: one infinite sway loop; bounce waits on a random-interval timer
    const countBefore = harness.animations.length
    const swayLoop = harness.pending().find((animation) => animation.options.iterations === Infinity)
    expect(swayLoop?.playState).toBe('running')

    director.pause()
    for (const animation of harness.pending()) expect(animation.playState).toBe('paused')
    await vi.advanceTimersByTimeAsync(10_000) // the bounce timer stays suspended
    expect(harness.animations).toHaveLength(countBefore)

    director.resume()
    for (const animation of harness.pending()) expect(animation.playState).toBe('running')
    expect(harness.animations).toHaveLength(countBefore) // resumed in place, not restarted
    await vi.advanceTimersByTimeAsync(1500) // the suspended bounce wait fires (800~1300ms)
    expect(harness.animations.length).toBeGreaterThan(countBefore)
    director.dispose()
  })

  it('pause/resume covers in-flight play() instances and forgets finished ones', async () => {
    const { stage, registry, director } = setup()
    const wiggle: AnimationDefinition = {
      version: 1,
      id: 'user:wiggle',
      name: 'Wiggle',
      kind: 'interaction',
      durationMs: 200,
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
    registry.register(wiggle)
    const instance = director.play('user:wiggle')
    const animation = harness.animations[harness.animations.length - 1]
    expect(animation.target).toBe(stage.layers.transition)
    expect(animation.playState).toBe('running')

    director.pause()
    expect(animation.playState).toBe('paused')
    expect(instance.status).toBe('paused')

    director.resume()
    expect(animation.playState).toBe('running')
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    await instance.play()
    expect(instance.status).toBe('finished')

    // a finished instance is dropped from tracking: a later pause must not revive it
    director.pause()
    expect(instance.status).toBe('finished')
    director.resume()
    director.dispose()
  })

  it('an enter transition started while paused begins paused: no animation advances while hidden (§23)', async () => {
    const { stage, director } = setup()
    director.pause()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await vi.advanceTimersByTimeAsync(0)

    // the enter's pre segment exists but is frozen: playState paused, not running
    const finite = harness.pending().filter((animation) => animation.options.iterations !== Infinity)
    expect(finite).toHaveLength(1)
    expect(finite[0].target).toBe(stage.layers.transition)
    expect(finite[0].playState).toBe('paused')
    expect(stage.swapped).toEqual([]) // a frozen pre segment never reaches its pose-swap

    director.resume()
    expect(finite[0].playState).toBe('running')
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking']) // swap fires only after resume
    await settleTransitions()
    await pending
    director.dispose()
  })

  it('pausing mid-enter freezes the in-flight transition in place; resume completes it', async () => {
    const { stage, director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await vi.advanceTimersByTimeAsync(0)
    const pre = harness.animations[harness.animations.length - 1]
    expect(pre.playState).toBe('running')

    director.pause() // the tab hides while the enter is in flight
    expect(pre.playState).toBe('paused')
    await vi.advanceTimersByTimeAsync(10_000) // a paused WAAPI animation never advances
    expect(pre.playState).toBe('paused')
    expect(stage.swapped).toEqual([])

    director.resume()
    expect(pre.playState).toBe('running')
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['thinking'])
    await settleTransitions()
    await pending
    director.dispose()
  })

  it('a superseded paused enter is still cancelled by the next transition (generation guard intact)', async () => {
    const { stage, director } = setup()
    director.pause()
    const pendingA = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await vi.advanceTimersByTimeAsync(0)
    const preA = harness.pending().find((animation) => animation.options.iterations !== Infinity)
    expect(preA?.playState).toBe('paused')

    const pendingB = director.setTarget(target({ visualState: 'waiting', poseKey: 'waiting' }))
    expect(preA?.playState).toBe('idle') // A was cancelled, not merely paused
    await settleTransitions()
    await Promise.all([pendingA, pendingB])
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['waiting']) // A never swapped
    director.dispose()
  })
})

describe('MotionDirector — currentTarget (read-only, M5)', () => {
  it('is null before any target and reflects the latest setTarget, dedupe included', async () => {
    const { director } = setup()
    expect(director.currentTarget).toBeNull()

    const thinking = target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' })
    const pending = director.setTarget(thinking)
    expect(director.currentTarget).toEqual(thinking) // visible already mid-transition
    await settleTransitions()
    await pending
    expect(director.currentTarget).toEqual(thinking)

    // a deduped re-target (ambient-only refresh, §10.3) still updates the target
    await director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'thinking' }))
    expect(director.currentTarget?.visualState).toBe('active')
    expect(director.currentTarget?.activityMode).toBe('command')
    director.dispose()
    expect(director.currentTarget).not.toBeNull() // dispose does not forget the target
  })
})

describe('MotionDirector — transition tracking (transitionInFlight / whenSettled)', () => {
  it('is quiet before/after a transition and in flight while it runs', async () => {
    const { director } = setup()
    expect(director.transitionInFlight).toBe(false)
    await director.whenSettled() // no transition: resolves immediately

    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    expect(director.transitionInFlight).toBe(true)

    await settleTransitions()
    await pending
    expect(director.transitionInFlight).toBe(false)
    await director.whenSettled()
    director.dispose()
  })

  it('a deduped ambient-only setTarget (§10.3) is not a transition', async () => {
    const { director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending
    await director.setTarget(target({ visualState: 'active', activityMode: 'command', poseKey: 'thinking' }))
    expect(director.transitionInFlight).toBe(false)
    director.dispose()
  })

  it('an interrupted transition still settles its whenSettled waiters', async () => {
    const { director } = setup()
    const pendingA = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    let settledA = false
    void director.whenSettled().then(() => {
      settledA = true
    })

    // B supersedes A mid-flight: A's play resolves false — that still settles.
    const pendingB = director.setTarget(target({ visualState: 'waiting', poseKey: 'waiting' }))
    expect(director.transitionInFlight).toBe(true) // B is tracked now
    await settleTransitions()
    await Promise.all([pendingA, pendingB])
    await vi.advanceTimersByTimeAsync(0)
    expect(settledA).toBe(true)
    expect(director.transitionInFlight).toBe(false) // B settled too
    director.dispose()
  })

  it('replayEnter transitions are tracked as well', async () => {
    const { director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    await settleTransitions()
    await pending

    const replay = director.replayEnter()
    expect(director.transitionInFlight).toBe(true)
    await settleTransitions()
    await replay
    expect(director.transitionInFlight).toBe(false)
    director.dispose()
  })

  it('dispose settles a waiter for the in-flight transition', async () => {
    const { director } = setup()
    const pending = director.setTarget(target({ visualState: 'active', activityMode: 'thinking', poseKey: 'thinking' }))
    let settled = false
    void director.whenSettled().then(() => {
      settled = true
    })
    director.dispose()
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(director.transitionInFlight).toBe(false)
  })
})

describe('MotionDirector — particle timeline events (§8.5)', () => {
  const particleTransition = (): AnimationDefinition => ({
    version: 1,
    id: 'user:party-pop',
    name: 'Party Pop',
    kind: 'transition',
    durationMs: 200,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.scaleX',
        keyframes: [
          { at: 0, value: 1 },
          { at: 1, value: 1 },
        ],
      },
    ],
    events: [
      { at: 0.5, type: 'pose-swap' },
      { at: 0.5, type: 'particle', effect: 'star-burst' },
      { at: 1, type: 'particle', effect: 'sparkle' },
    ],
  })

  const pose = (key: string): ResolvedPose => ({
    poseKey: key as ResolvedPose['poseKey'],
    asset: { id: key, url: `/motion-pet-assets/${key}.webp`, width: 240, height: 240 },
    anchor: { x: 0.5, y: 0.96 },
    zoom: 1,
  })

  it('transition particle events reach the stage at their segment boundaries', async () => {
    const stage = createFakeStage()
    const registry = createBuiltinRegistry()
    registry.register(particleTransition())
    const engine = new TransitionEngine(stage, new TimelineEngine(stage, registry))

    const playing = engine.play({ pose: pose('thinking'), definitionId: 'user:party-pop' })
    expect(stage.swapped).toEqual([])
    expect(stage.emittedParticles).toEqual([]) // pre segment: nothing yet

    harness.finishPending() // segment [0, 0.5] completes
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((entry) => entry.poseKey)).toEqual(['thinking'])
    expect(stage.emittedParticles).toEqual(['star-burst']) // at=1 'sparkle' still pending

    harness.finishPending() // segment [0.5, 1] completes
    await vi.advanceTimersByTimeAsync(0)
    expect(await playing).toBe(true)
    expect(stage.emittedParticles).toEqual(['star-burst', 'sparkle'])
  })

  it('an interrupted transition never emits: cancel before and after the boundary', async () => {
    const stage = createFakeStage()
    const registry = createBuiltinRegistry()
    registry.register(particleTransition())
    const engine = new TransitionEngine(stage, new TimelineEngine(stage, registry))

    // Cancelled during the pre segment: neither swap nor particles.
    const first = engine.play({ pose: pose('thinking'), definitionId: 'user:party-pop' })
    engine.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(await first).toBe(false)
    expect(stage.swapped).toEqual([])
    expect(stage.emittedParticles).toEqual([])

    // Cancelled during the post segment: the at=1 particle must not fire.
    const second = engine.play({ pose: pose('thinking'), definitionId: 'user:party-pop' })
    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.emittedParticles).toEqual(['star-burst'])
    engine.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(await second).toBe(false)
    expect(stage.emittedParticles).toEqual(['star-burst'])
  })

  it('a stage without emitParticle simply drops particle events (optional contract)', async () => {
    const stage = createFakeStage()
    const bareStage: MotionStage = {
      layers: stage.layers,
      swapPose: stage.swapPose,
      reducedMotion: false,
    }
    const registry = createBuiltinRegistry()
    registry.register(particleTransition())
    const engine = new TransitionEngine(bareStage, new TimelineEngine(bareStage, registry))
    const playing = engine.play({ pose: pose('thinking'), definitionId: 'user:party-pop' })
    await settleTransitions()
    expect(await playing).toBe(true) // ran to completion without a particle layer
  })

  it('success enter (builtin:celebrate) bursts confetti through the director path', async () => {
    const { stage, director } = setup()
    const pending = director.setTarget(target({ visualState: 'success', poseKey: 'success' }))
    expect(stage.emittedParticles).toEqual([])
    await settleTransitions()
    await pending
    expect(stage.swapped.map((entry) => entry.poseKey)).toEqual(['success'])
    expect(stage.emittedParticles).toEqual(['confetti'])
    director.dispose()
  })

  it('interaction definitions burst particles through playInteraction()', async () => {
    const { stage, registry, config, director } = setup()
    const interaction: AnimationDefinition = {
      version: 1,
      id: 'user:click-party',
      name: 'Click Party',
      kind: 'interaction',
      durationMs: 160,
      repeat: { mode: 'once' },
      tracks: [
        {
          property: 'transition.rotation',
          keyframes: [
            { at: 0, value: 0 },
            { at: 1, value: 0 },
          ],
        },
      ],
      events: [
        { at: 0.5, type: 'particle', effect: 'sparkle' },
        { at: 1, type: 'particle', effect: 'star-burst' },
      ],
    }
    registry.register(interaction)
    config.interactions.click.animation = 'user:click-party'

    const pending = director.playInteraction()
    expect(stage.emittedParticles).toEqual([])
    harness.finishPending() // segment [0, 0.5]
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.emittedParticles).toEqual(['sparkle'])
    harness.finishPending() // segment [0.5, 1]
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(stage.emittedParticles).toEqual(['sparkle', 'star-burst'])
    director.dispose()
  })
})

describe('MotionDirector — enter animationId (§8.14, V1.1)', () => {
  const customEnter = (): AnimationDefinition => ({
    version: 1,
    id: 'user:enter-spin',
    name: 'Enter Spin',
    kind: 'transition',
    durationMs: 500,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.rotation',
        keyframes: [
          { at: 0, value: { base: 0, parameter: 'strength', amount: 0 } },
          { at: 1, value: { base: 0, parameter: 'strength', amount: 90 } },
        ],
      },
    ],
    events: [{ at: 0.5, type: 'pose-swap' }],
    parameters: { strength: { default: 1, min: 0, max: 3 } },
  })

  it('a registered animationId wins over the preset; strength/durationMs still override', async () => {
    const { stage, registry, config, director } = setup()
    registry.register(customEnter())
    config.states.idle.enter = { preset: 'soft', strength: 2, durationMs: 800, animationId: 'user:enter-spin' }

    const pending = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    // the custom data runs, not builtin:soft (which would be 220ms with scale tracks)
    const pre = harness.animations[0]
    expect(pre.target).toBe(stage.layers.transition)
    expect(pre.options.duration).toBeCloseTo(400, 5) // 800ms override cut at the 0.5 pose-swap
    const keyframes = pre.keyframes as Array<{ rotate: string }>
    expect(keyframes.map((keyframe) => keyframe.rotate)).toEqual(['0deg', '90deg']) // strength 2 × 90 at t=0.5
    expect(stage.swapped).toEqual([])

    harness.finishPending() // the custom timeline's pose-swap event fires
    await vi.advanceTimersByTimeAsync(0)
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle'])

    await settleTransitions()
    await pending
    director.dispose()
  })

  it('a builtin animationId resolves through the same registry path', async () => {
    const { stage, config, director } = setup()
    config.states.idle.enter = { preset: 'soft', strength: 1, durationMs: 300, animationId: 'builtin:flip' }

    const pending = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    const pre = harness.animations[0]
    expect(pre.options.duration).toBeCloseTo(150, 5) // flip: 300ms, swap at 0.5
    const keyframes = pre.keyframes as Array<{ scale: string }>
    expect(keyframes.map((keyframe) => keyframe.scale)).toEqual(['1 1', '0 1.06'])

    await settleTransitions()
    await pending
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle'])
    director.dispose()
  })

  it('a dangling animationId (deleted custom) falls back to the preset mapping', async () => {
    const { stage, config, director } = setup()
    config.states.idle.enter = { preset: 'snap', strength: 1, durationMs: 160, animationId: 'user:missing' }

    const pending = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    const pre = harness.animations[0]
    expect(pre.options.duration).toBeCloseTo(76.8, 5) // builtin:snap 160ms cut at 0.48
    const keyframes = pre.keyframes as Array<{ scale: string }>
    expect(keyframes[0].scale).toBe('1 1') // scale tracks, not the custom rotation

    await settleTransitions()
    await pending
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle'])
    director.dispose()
  })

  it('a wrong-kind animationId (ambient custom mounted on an enter) falls back to the preset', async () => {
    const { stage, registry, config, director } = setup()
    registry.register({
      version: 1,
      id: 'user:float',
      name: 'Float',
      kind: 'ambient',
      durationMs: 700,
      repeat: { mode: 'loop' },
      tracks: [
        { property: 'sway.rotation', keyframes: [{ at: 0, value: -3 }, { at: 1, value: 3 }] },
      ],
    })
    config.states.idle.enter = { preset: 'snap', strength: 1, durationMs: 160, animationId: 'user:float' }

    const pending = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    const pre = harness.animations[0]
    // The enter played builtin:snap (160ms cut at 0.48), NOT the 700ms looping
    // ambient: an enter without pose-swap would strand stagePoseUrl (§12).
    expect(pre.options.duration).toBeCloseTo(76.8, 5)
    expect(pre.options.iterations ?? 1).toBe(1)

    await settleTransitions()
    await pending
    expect(stage.swapped.map((pose) => pose.poseKey)).toEqual(['idle'])
    director.dispose()
  })
})

describe('MotionDirector — custom ambient animation per state', () => {
  const customAmbient = (durationMs = 777): AnimationDefinition => ({
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
          { at: 0, value: -3 },
          { at: 1, value: 3 },
        ],
      },
    ],
  })

  const disableBuiltinAmbient = (config: MotionPetConfig): void => {
    const ambient = config.states.idle.ambient
    ambient.bounce.enabled = false
    ambient.sway.enabled = false
    ambient.breathe.enabled = false
  }

  it('plays the selected ambient definition after enter and keeps it through ambient-only refreshes', async () => {
    const { stage, registry, config, director } = setup()
    disableBuiltinAmbient(config)
    registry.register(customAmbient())
    config.states.idle.ambient.customAnimationId = 'user:float'

    const entering = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    await settleTransitions()
    await entering
    const custom = harness.animations.find(
      (animation) => animation.target === stage.layers.sway && animation.options.duration === 777,
    )
    expect(custom?.options.iterations).toBe(Infinity)
    const count = harness.animations.length

    await director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    expect(harness.animations).toHaveLength(count)
    expect(custom?.playState).toBe('running')
    director.dispose()
  })

  it('stops the old custom on selection clear and restarts when its definition changes', async () => {
    const { stage, registry, config, director } = setup()
    disableBuiltinAmbient(config)
    registry.register(customAmbient())
    config.states.idle.ambient.customAnimationId = 'user:float'
    const entering = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    await settleTransitions()
    await entering
    const first = harness.animations.find(
      (animation) => animation.target === stage.layers.sway && animation.options.duration === 777,
    )
    expect(first?.playState).toBe('running')

    registry.unregister('user:float')
    registry.register(customAmbient(999))
    director.refreshAmbient()
    expect(first?.playState).toBe('idle')
    const replacement = harness.animations.find(
      (animation) => animation.target === stage.layers.sway && animation.options.duration === 999,
    )
    expect(replacement?.playState).toBe('running')

    delete config.states.idle.ambient.customAnimationId
    director.refreshAmbient()
    expect(replacement?.playState).toBe('idle')
    director.dispose()
  })

  it('ignores dangling/wrong-kind ids and suppresses custom ambient under reduced motion', async () => {
    const wrongKind = setup()
    disableBuiltinAmbient(wrongKind.config)
    wrongKind.registry.register({ ...customAmbient(), kind: 'interaction' })
    wrongKind.config.states.idle.ambient.customAnimationId = 'user:float'
    const wrongEntering = wrongKind.director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
    await settleTransitions()
    await wrongEntering
    expect(harness.animations.some((animation) => animation.options.duration === 777)).toBe(false)
    wrongKind.director.dispose()
    harness.animations.length = 0

    for (const reducedMotion of [false, true]) {
      const { registry, config, director } = setup(reducedMotion)
      disableBuiltinAmbient(config)
      registry.register(customAmbient())
      config.states.idle.ambient.customAnimationId = reducedMotion ? 'user:float' : 'user:missing'
      const entering = director.setTarget(target({ visualState: 'idle', poseKey: 'idle' }))
      await settleTransitions()
      await entering
      expect(harness.animations.some((animation) => animation.options.duration === 777)).toBe(false)
      director.dispose()
      harness.animations.length = 0
    }
  })
})
