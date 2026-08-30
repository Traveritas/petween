// @vitest-environment jsdom
/**
 * Timeline Scheduler tests (spec §29.0): multi-segment scheduling with
 * boundary events, interruption before/after pose-swap, and all four repeat
 * policies — through the fake WAAPI harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBuiltinRegistry } from '../../src/motion/animation-registry'
import { TimelineEngine } from '../../src/motion/timeline-engine'
import type { CompiledTimelineEvent } from '../../src/motion/timeline-compiler'
import { createFakeStage, flushScheduler, installFakeAnimate, type FakeAnimateHarness } from './fake-animate'

let harness: FakeAnimateHarness

beforeEach(() => {
  harness = installFakeAnimate()
})

afterEach(() => {
  harness.restore()
  vi.useRealTimers()
})

const setup = () => {
  const stage = createFakeStage()
  const engine = new TimelineEngine(stage, createBuiltinRegistry())
  const events: CompiledTimelineEvent[] = []
  return { stage, engine, events }
}

describe('timeline scheduler — segments and events', () => {
  it('runs pre segment → pose-swap event → post segment, each awaited via finished', async () => {
    const { stage, engine, events } = setup()
    const instance = engine.createInstance('builtin:comic-pop', { onEvent: (event) => events.push(event) })
    const done = instance.play()

    // pre segment: exactly one active animation on the transition layer
    expect(harness.animations).toHaveLength(1)
    expect(harness.animations[0].target).toBe(stage.layers.transition)
    expect(harness.animations[0].options.duration).toBeCloseTo(104)
    const preKeyframes = harness.animations[0].keyframes as Array<{ offset: number }>
    expect(preKeyframes[0].offset).toBe(0)
    expect(preKeyframes[preKeyframes.length - 1].offset).toBe(1)
    expect(events).toEqual([])

    harness.finishPending()
    await flushScheduler()

    // pose-swap fired exactly at the segment boundary, then the post segment started
    expect(events.map((event) => `${event.type}@${event.at}`)).toEqual(['pose-swap@0.4'])
    expect(harness.animations).toHaveLength(2)
    expect(harness.animations[1].options.duration).toBeCloseTo(156)
    // the pre segment animation was replaced — one active animation per layer per instance
    expect(harness.animations[0].playState).toBe('idle')
    expect(harness.animations[1].playState).toBe('running')

    harness.finishPending()
    await flushScheduler()
    await done
    expect(instance.status).toBe('finished')
    // finished runs clean up their fill effects
    expect(harness.animations[1].playState).toBe('idle')
  })

  it('cancel before pose-swap: the event never fires', async () => {
    const { engine, events } = setup()
    const instance = engine.createInstance('builtin:comic-pop', { onEvent: (event) => events.push(event) })
    const done = instance.play()
    instance.cancel()
    await done
    expect(events).toEqual([])
    expect(harness.animations[0].playState).toBe('idle')
    expect(instance.status).toBe('cancelled')
  })

  it('cancel after pose-swap: the post segment is cancelled and no further events fire', async () => {
    const { engine, events } = setup()
    const instance = engine.createInstance('builtin:comic-pop', { onEvent: (event) => events.push(event) })
    const done = instance.play()
    harness.finishPending() // complete the pre segment
    await flushScheduler()
    expect(events).toHaveLength(1) // pose-swap happened

    instance.cancel()
    await done
    expect(harness.animations[1].playState).toBe('idle') // post segment cancelled
    expect(events).toHaveLength(1) // nothing more
    expect(instance.status).toBe('cancelled')
  })

  it('a throwing onEvent listener is isolated: the run still completes and settles', async () => {
    const { engine, events } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = engine.createInstance('builtin:comic-pop', {
      onEvent: (event) => {
        events.push(event)
        throw new Error('listener boom')
      },
    })
    const done = instance.play()
    harness.finishPending() // pre segment → pose-swap fires, the listener throws
    await flushScheduler()
    expect(events).toHaveLength(1) // the event still fired
    harness.finishPending() // post segment
    await flushScheduler()
    await done
    expect(instance.status).toBe('finished')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('an onEvent listener may cancel the run: no further segment animations are created', async () => {
    const { engine, events } = setup()
    const instance = engine.createInstance('builtin:comic-pop', {
      onEvent: (event) => {
        events.push(event)
        instance.cancel()
      },
    })
    const done = instance.play()
    harness.finishPending() // pre segment completes → the pose-swap listener cancels the run
    await flushScheduler()
    await done
    expect(events).toHaveLength(1)
    // the post segment never started: only the pre segment animation exists
    expect(harness.animations).toHaveLength(1)
    expect(harness.animations[0].playState).toBe('idle')
    expect(instance.status).toBe('cancelled')
  })

  it('an event at 0 fires before any animation (builtin:none needs no tracks)', async () => {
    const { engine, events } = setup()
    const instance = engine.createInstance('builtin:none', { onEvent: (event) => events.push(event) })
    const done = instance.play()
    await done
    expect(events.map((event) => event.at)).toEqual([0])
    expect(harness.animations).toHaveLength(0)
    expect(instance.status).toBe('finished')
  })

  it('pause/resume propagate to the running WAAPI animations', async () => {
    const { engine } = setup()
    const instance = engine.createInstance('builtin:comic-pop')
    void instance.play()
    instance.pause()
    expect(harness.animations[0].playState).toBe('paused')
    expect(instance.status).toBe('paused')
    instance.resume()
    expect(harness.animations[0].playState).toBe('running')
    expect(instance.status).toBe('running')
    instance.cancel()
    await instance.play()
  })
})

describe('timeline scheduler — repeat policies (§8.6)', () => {
  it('once: plays exactly one pass', async () => {
    const { engine } = setup()
    const instance = engine.createInstance('builtin:soft')
    const done = instance.play()
    harness.finishPending() // pre segment
    await flushScheduler()
    harness.finishPending() // post segment
    await flushScheduler()
    await done
    expect(instance.status).toBe('finished')
    // exactly two segments ran, and nothing is re-scheduled afterwards
    expect(harness.animations).toHaveLength(2)
    await flushScheduler()
    expect(harness.animations).toHaveLength(2)
  })

  it('loop without events: a single infinite WAAPI animation per layer (§23)', async () => {
    const { stage, engine } = setup()
    const instance = engine.createInstance('builtin:sway')
    const done = instance.play()
    expect(harness.animations).toHaveLength(1)
    expect(harness.animations[0].target).toBe(stage.layers.sway)
    expect(harness.animations[0].options.iterations).toBe(Infinity)
    expect(harness.animations[0].options.direction).toBe('normal')
    instance.cancel()
    await done
    expect(instance.status).toBe('cancelled')
  })

  it('alternate without events: single infinite animation with direction alternate', async () => {
    const { engine } = setup()
    const instance = engine.createInstance('builtin:sway', { repeat: { mode: 'alternate' } })
    const done = instance.play()
    expect(harness.animations).toHaveLength(1)
    expect(harness.animations[0].options.iterations).toBe(Infinity)
    expect(harness.animations[0].options.direction).toBe('alternate')
    instance.cancel()
    await done
  })

  it('loop with events: the scheduler re-runs segment passes', async () => {
    const { engine, events } = setup()
    const instance = engine.createInstance('builtin:comic-pop', {
      repeat: { mode: 'loop' },
      onEvent: (event) => events.push(event),
    })
    const done = instance.play()
    for (let pass = 0; pass < 3; pass += 1) {
      harness.finishPending() // pre segment
      await flushScheduler()
      harness.finishPending() // post segment
      await flushScheduler()
    }
    expect(events).toHaveLength(3)
    instance.cancel()
    await done
  })

  it('random-interval: waits a random delay, plays one pass, repeats (fake timers)', async () => {
    vi.useFakeTimers()
    const { engine } = setup()
    // random: () => 0 → always the minimum delay (800ms for builtin:bounce)
    const instance = engine.createInstance('builtin:bounce', { random: () => 0 })
    const done = instance.play()

    // delay-first: nothing animates before the first interval elapses
    expect(harness.animations).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(800)
    expect(harness.animations).toHaveLength(1)
    expect(harness.animations[0].options.duration).toBe(360)

    harness.finishPending()
    await vi.advanceTimersByTimeAsync(0) // let the pass complete and schedule the next delay
    await vi.advanceTimersByTimeAsync(800)
    expect(harness.animations).toHaveLength(2)

    // cancel clears the pending delay timer
    instance.cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.animations).toHaveLength(2)
    await done
    expect(instance.status).toBe('cancelled')
  })

  it('random-interval pause freezes the pending delay, resume continues it', async () => {
    vi.useFakeTimers()
    const { engine } = setup()
    const instance = engine.createInstance('builtin:bounce', { random: () => 0 })
    void instance.play()
    await vi.advanceTimersByTimeAsync(400) // halfway through the first 800ms delay
    instance.pause()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.animations).toHaveLength(0) // frozen
    instance.resume()
    await vi.advanceTimersByTimeAsync(400) // only the remaining 400ms
    expect(harness.animations).toHaveLength(1)
    instance.cancel()
    await instance.play()
  })
})
