/**
 * fake-animate.ts — a minimal WAAPI stand-in for tests (jsdom ships without
 * Web Animations API). Records every animate() call, exposes the pending
 * animations, and mimics the real `finished` contract: resolves on finish(),
 * rejects with an AbortError DOMException on cancel().
 */
import type { MotionStage } from '../../src/motion/motion-stage'
import type { ResolvedPose } from '../../src/core/types'

export interface FakeAnimationOptions {
  duration?: number
  iterations?: number
  direction?: string
  fill?: string
  easing?: string
}

export class FakeAnimation {
  readonly target: Element
  readonly keyframes: unknown
  readonly options: FakeAnimationOptions
  playState: 'idle' | 'running' | 'paused' | 'finished' = 'running'

  private readonly finishedPromise: Promise<FakeAnimation>
  private resolveFinished!: (animation: FakeAnimation) => void
  private rejectFinished!: (error: unknown) => void

  constructor(target: Element, keyframes: unknown, options: FakeAnimationOptions) {
    this.target = target
    this.keyframes = keyframes
    this.options = options
    this.finishedPromise = new Promise<FakeAnimation>((resolve, reject) => {
      this.resolveFinished = resolve
      this.rejectFinished = reject
    })
    // Pre-attached noop handler: a cancelled animation nobody awaited must not
    // surface as an unhandled rejection. Awaiters still see the rejection.
    this.finishedPromise.catch(() => {})
  }

  get finished(): Promise<FakeAnimation> {
    return this.finishedPromise
  }

  play(): void {
    if (this.playState === 'paused') this.playState = 'running'
  }

  pause(): void {
    if (this.playState === 'running') this.playState = 'paused'
  }

  cancel(): void {
    if (this.playState === 'idle') return
    this.playState = 'idle'
    this.rejectFinished(new DOMException('The animation was cancelled.', 'AbortError'))
  }

  finish(): void {
    if (this.playState !== 'running' && this.playState !== 'paused') return
    this.playState = 'finished'
    this.resolveFinished(this)
  }
}

export interface FakeAnimateHarness {
  /** Every animation created since install, in creation order. */
  readonly animations: FakeAnimation[]
  /** Animations still in flight (running or paused). */
  pending(): FakeAnimation[]
  /** finish() every pending animation; returns how many were finished. */
  finishPending(): number
  restore(): void
}

export function installFakeAnimate(): FakeAnimateHarness {
  const animations: FakeAnimation[] = []
  const original = Element.prototype.animate

  Element.prototype.animate = function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    // Normalize: the scheduler always passes numbers/strings, but the WAAPI
    // signature also allows CSSNumericValue etc. — keep only what we record.
    const normalized: FakeAnimationOptions =
      typeof options === 'number'
        ? { duration: options }
        : {
            duration: typeof options?.duration === 'number' ? options.duration : undefined,
            iterations: typeof options?.iterations === 'number' ? options.iterations : undefined,
            direction: typeof options?.direction === 'string' ? options.direction : undefined,
            fill: typeof options?.fill === 'string' ? options.fill : undefined,
            easing: typeof options?.easing === 'string' ? options.easing : undefined,
          }
    const animation = new FakeAnimation(this, keyframes, normalized)
    animations.push(animation)
    return animation as unknown as Animation
  }

  const pending = (): FakeAnimation[] =>
    animations.filter((animation) => animation.playState === 'running' || animation.playState === 'paused')

  return {
    animations,
    pending,
    finishPending: () => {
      const running = pending()
      for (const animation of running) animation.finish()
      return running.length
    },
    restore: () => {
      if (original === undefined) {
        delete (Element.prototype as Partial<Pick<Element, 'animate'>>).animate
      } else {
        Element.prototype.animate = original
      }
    },
  }
}

export interface FakeStage extends MotionStage {
  readonly swapped: ResolvedPose[]
  readonly emittedParticles: string[]
}

/** A MotionStage with four real divs and a recording swapPose/emitParticle. */
export function createFakeStage(reducedMotion = false): FakeStage {
  const swapped: ResolvedPose[] = []
  const emittedParticles: string[] = []
  return {
    layers: {
      transition: document.createElement('div'),
      sway: document.createElement('div'),
      bounce: document.createElement('div'),
      breathe: document.createElement('div'),
    },
    swapped,
    emittedParticles,
    swapPose(pose: ResolvedPose): void {
      swapped.push(pose)
    },
    emitParticle(effect: string): void {
      emittedParticles.push(effect)
    },
    reducedMotion,
  }
}

/** Flush the microtask queue (and one macrotask) so scheduler continuations run. */
export async function flushScheduler(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
