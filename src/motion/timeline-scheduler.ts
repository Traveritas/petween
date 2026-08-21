/**
 * motion/timeline-scheduler.ts — executes a CompiledTimeline on the DOM
 * layers via WAAPI (spec §8.12, §10.1).
 *
 * Design:
 * - The timeline is pre-cut at event points; each segment becomes ONE WAAPI
 *   animation per touched layer. The scheduler `await animation.finished`
 *   between segments and fires events exactly at boundaries, so events can
 *   never drift from the visual timeline (no setTimeout-based pose swaps).
 * - cancel() calls WAAPI cancel(): the resulting `finished` rejection
 *   (AbortError) is the normal interruption path and is swallowed.
 * - Repeat policies (§8.6, §23): eventless loop/alternate compile to a single
 *   infinite WAAPI animation per layer (compositor-friendly); eventful loops
 *   re-run the segment passes; random-interval waits a random delay on a
 *   low-frequency timer, then plays one pass.
 * - Starting a new segment cancels the previous segment's animations on the
 *   same layers: boundary values are compiler-interpolated to match, so there
 *   is no visible jump and an instance never holds two active animations on
 *   the same layer.
 */
import type { CompiledSegment, CompiledTimeline, CompiledTimelineEvent } from './timeline-compiler'
import { randomInRange } from './math'
import { MOTION_LAYERS, type MotionLayer } from './motion-properties'

export type TimelineRunStatus = 'running' | 'paused' | 'cancelled' | 'finished'

export interface TimelineRunHooks {
  onEvent?: (event: CompiledTimelineEvent) => void
  /** Injectable RNG for deterministic tests. */
  random?: () => number
}

export interface TimelineRun {
  /** Settles when the run completes OR is cancelled; never rejects. */
  readonly finished: Promise<void>
  readonly status: TimelineRunStatus
  pause(): void
  resume(): void
  cancel(): void
}

export function runTimeline(
  compiled: CompiledTimeline,
  layers: Record<MotionLayer, HTMLElement>,
  hooks: TimelineRunHooks = {},
): TimelineRun {
  const random = hooks.random ?? Math.random
  let status: TimelineRunStatus = 'running'
  let current: Animation[] = []
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let delayResolve: ((proceeded: boolean) => void) | null = null
  let delayRemainingMs = 0
  let delayStartedAt = 0

  let resolveFinished!: () => void
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })

  const fireEvents = (beforeSegmentIndex: number): void => {
    for (const event of compiled.events) {
      if (event.beforeSegmentIndex === beforeSegmentIndex) hooks.onEvent?.(event)
    }
  }

  const cancelCurrentAnimations = (): void => {
    for (const animation of current) {
      try {
        animation.cancel()
      } catch {
        // already idle — nothing to cancel
      }
    }
    current = []
  }

  const createSegmentAnimations = (segment: CompiledSegment, options: KeyframeAnimationOptions): Animation[] => {
    const animations: Animation[] = []
    for (const layer of MOTION_LAYERS) {
      const keyframes = segment.layers[layer]
      if (keyframes === undefined || keyframes.length === 0) continue
      animations.push(layers[layer].animate(keyframes, options))
    }
    return animations
  }

  /** Plays one segment; resolves false when interrupted by cancel(). */
  const playSegment = async (segment: CompiledSegment): Promise<boolean> => {
    cancelCurrentAnimations()
    current = createSegmentAnimations(segment, {
      duration: segment.durationMs,
      fill: 'forwards',
    })
    if (status === 'paused') for (const animation of current) animation.pause()
    if (current.length === 0) return true
    try {
      await Promise.all(current.map((animation) => animation.finished))
      return true
    } catch {
      // WAAPI rejects `finished` with AbortError on cancel() — the normal
      // interruption path, not an error.
      return false
    }
  }

  /** One full pass through all segments, firing boundary events (§8.12). */
  const playPass = async (): Promise<boolean> => {
    // `isCancelled` is a function call on purpose: cancel() mutates `status`
    // from outside this async flow, and a plain comparison would be narrowed
    // away by TypeScript after the first check.
    const isCancelled = (): boolean => status === 'cancelled'
    for (let index = 0; index <= compiled.segments.length; index += 1) {
      // Cancel check first: an interrupted run must not fire further events
      // (a stale pose-swap would violate §10.2 even in the narrow window
      // between a segment's natural finish and the loop continuation).
      if (isCancelled()) return false
      fireEvents(index)
      if (index === compiled.segments.length) break
      const proceeded = await playSegment(compiled.segments[index])
      if (!proceeded || isCancelled()) return false
    }
    return true
  }

  /** Eventless loop/alternate: a single infinite animation per layer (§23). */
  const playInfinite = async (segment: CompiledSegment, mode: 'loop' | 'alternate'): Promise<void> => {
    cancelCurrentAnimations()
    current = createSegmentAnimations(segment, {
      duration: segment.durationMs,
      iterations: Infinity,
      direction: mode === 'alternate' ? 'alternate' : 'normal',
      fill: 'forwards',
    })
    if (status === 'paused') for (const animation of current) animation.pause()
    try {
      await Promise.all(current.map((animation) => animation.finished))
    } catch {
      // cancel() → AbortError — expected.
    }
  }

  /** Pausable/cancellable random-interval wait. Resolves false on cancel. */
  const waitDelay = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      delayResolve = resolve
      delayRemainingMs = ms
      delayStartedAt = Date.now()
      delayTimer = setTimeout(() => {
        delayTimer = null
        delayResolve = null
        resolve(true)
      }, ms)
    })

  const driver = async (): Promise<void> => {
    const repeat = compiled.repeat
    if (repeat.mode === 'once') {
      await playPass()
    } else if (
      (repeat.mode === 'loop' || repeat.mode === 'alternate') &&
      compiled.events.length === 0 &&
      compiled.segments.length === 1
    ) {
      await playInfinite(compiled.segments[0], repeat.mode)
    } else if (repeat.mode === 'loop' || repeat.mode === 'alternate') {
      // Eventful definitions cannot ride a single infinite WAAPI animation;
      // the scheduler re-runs the segment passes instead (§8.12).
      while (status !== 'cancelled') {
        const proceeded = await playPass()
        if (!proceeded) break
      }
    } else {
      // random-interval: delay first (the pet does not bounce the instant the
      // ambient starts), then one pass per random wait.
      while (status !== 'cancelled') {
        const proceeded = await waitDelay(randomInRange(repeat.minDelayMs, repeat.maxDelayMs, random))
        if (!proceeded) break
        const passed = await playPass()
        if (!passed) break
      }
    }
    cancelCurrentAnimations()
    if (status !== 'cancelled') status = 'finished'
    resolveFinished()
  }

  const run: TimelineRun = {
    finished,
    get status() {
      return status
    },
    pause() {
      if (status !== 'running') return
      status = 'paused'
      for (const animation of current) animation.pause()
      if (delayTimer !== null) {
        clearTimeout(delayTimer)
        delayTimer = null
        delayRemainingMs = Math.max(0, delayRemainingMs - (Date.now() - delayStartedAt))
      }
    },
    resume() {
      if (status !== 'paused') return
      status = 'running'
      for (const animation of current) animation.play()
      if (delayResolve !== null && delayTimer === null) {
        const resolve = delayResolve
        delayStartedAt = Date.now()
        delayTimer = setTimeout(() => {
          delayTimer = null
          delayResolve = null
          resolve(true)
        }, delayRemainingMs)
      }
    },
    cancel() {
      if (status === 'cancelled' || status === 'finished') return
      status = 'cancelled'
      if (delayTimer !== null) clearTimeout(delayTimer)
      delayTimer = null
      if (delayResolve !== null) {
        const resolve = delayResolve
        delayResolve = null
        resolve(false)
      }
      cancelCurrentAnimations()
    },
  }

  void driver()
  return run
}
