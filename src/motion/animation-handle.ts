/**
 * motion/animation-handle.ts — TimelineInstance (spec §8.17): one playable
 * execution of a compiled timeline. A definition can be instantiated any
 * number of times; each instance drives its own WAAPI animations and holds at
 * most one active animation per layer.
 */
import type { CompiledTimeline } from './timeline-compiler'
import { runTimeline, type TimelineRun, type TimelineRunHooks } from './timeline-scheduler'
import type { MotionLayer } from './motion-properties'

export type TimelineInstanceStatus = 'idle' | 'running' | 'paused' | 'cancelled' | 'finished'

export interface TimelineInstance {
  readonly id: string
  readonly definitionId: string
  readonly status: TimelineInstanceStatus
  play(): Promise<void>
  pause(): void
  resume(): void
  cancel(): void
  dispose(): void
}

let nextInstanceSeq = 0

export class CompiledTimelineInstance implements TimelineInstance {
  readonly id: string
  readonly definitionId: string
  private readonly compiled: CompiledTimeline
  private readonly layers: Record<MotionLayer, HTMLElement>
  private readonly hooks: TimelineRunHooks
  private run: TimelineRun | null = null
  private runStatus: TimelineInstanceStatus = 'idle'
  private disposed = false

  constructor(
    definitionId: string,
    compiled: CompiledTimeline,
    layers: Record<MotionLayer, HTMLElement>,
    hooks: TimelineRunHooks = {},
  ) {
    nextInstanceSeq += 1
    this.id = `timeline-${nextInstanceSeq}`
    this.definitionId = definitionId
    this.compiled = compiled
    this.layers = layers
    this.hooks = hooks
  }

  get status(): TimelineInstanceStatus {
    return this.runStatus
  }

  /** Starts the run; subsequent calls return the same completion promise. */
  play(): Promise<void> {
    if (this.disposed || this.runStatus === 'cancelled') return Promise.resolve()
    if (this.run !== null) return this.run.finished
    this.runStatus = 'running'
    this.run = runTimeline(this.compiled, this.layers, this.hooks)
    return this.run.finished.then(() => {
      if (this.runStatus === 'running' || this.runStatus === 'paused') this.runStatus = 'finished'
    })
  }

  pause(): void {
    if (this.runStatus !== 'running' || this.run === null) return
    this.run.pause()
    this.runStatus = 'paused'
  }

  resume(): void {
    if (this.runStatus !== 'paused' || this.run === null) return
    this.run.resume()
    this.runStatus = 'running'
  }

  cancel(): void {
    if (this.runStatus !== 'running' && this.runStatus !== 'paused') return
    this.run?.cancel()
    this.runStatus = 'cancelled'
  }

  dispose(): void {
    this.cancel()
    this.disposed = true
  }
}
