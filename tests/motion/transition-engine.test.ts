// @vitest-environment jsdom
/**
 * TransitionEngine unit tests (spec §10): the request-level seam runEnter
 * relies on — a pose-swap past the generation guard lands on the stage and
 * reports through `onSwap` at swap time, independent of eventual completion.
 * The ledger-truthfulness regression this locks is covered end-to-end in
 * motion-director.test.ts ("a silent same-state swap lands even when...").
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedPose } from '../../src/core/types'
import type { TimelineInstance, TimelineInstanceStatus } from '../../src/motion/animation-handle'
import type { MotionStage } from '../../src/motion/motion-stage'
import type { PlayOptions, TimelineEngine } from '../../src/motion/timeline-engine'
import { TransitionEngine } from '../../src/motion/transition-engine'

const pose = (key: string): ResolvedPose => ({
  poseKey: key,
  asset: { id: key, url: `/petween-assets/${key}.webp`, width: 240, height: 240 },
  anchor: { x: 0.5, y: 0.96 },
  zoom: 1,
})

/** Scripted engine: every createInstance is captured; play() stays pending until finish(). */
class ScriptedEngine {
  readonly created: Array<{ definitionId: string; options: PlayOptions }> = []
  cancelled = false
  private status: TimelineInstanceStatus = 'idle'
  private resolvers: Array<() => void> = []

  createInstance(definitionId: string, options: PlayOptions = {}): TimelineInstance {
    const shell = this
    this.created.push({ definitionId, options })
    return {
      id: `scripted-${this.created.length}`,
      definitionId,
      get status(): TimelineInstanceStatus {
        return shell.status
      },
      play(): Promise<void> {
        return new Promise<void>((resolve) => {
          shell.resolvers.push(resolve)
        })
      },
      pause(): void {},
      resume(): void {},
      cancel(): void {
        shell.cancelled = true
        shell.status = 'cancelled'
      },
      dispose(): void {},
    }
  }

  /** Resolves every pending play(); instances report the given terminal status. */
  finish(status: TimelineInstanceStatus = 'finished'): void {
    this.status = status
    for (const resolve of this.resolvers.splice(0)) resolve()
  }
}

function makeHarness(): { engine: ScriptedEngine; swaps: ResolvedPose[]; transitions: TransitionEngine } {
  const swaps: ResolvedPose[] = []
  const stage = { swapPose: (p: ResolvedPose) => swaps.push(p) } as unknown as MotionStage
  const engine = new ScriptedEngine()
  return { engine, swaps, transitions: new TransitionEngine(stage, engine as unknown as TimelineEngine) }
}

describe('TransitionEngine — request.onSwap seam', () => {
  it('swaps the stage and reports onSwap at event time, before completion', async () => {
    const { engine, swaps, transitions } = makeHarness()
    let swapsReported = 0

    const playing = transitions.play({
      pose: pose('thinking'),
      definitionId: 'builtin:comic-pop',
      onSwap: () => {
        swapsReported += 1
      },
    })
    expect(engine.created).toHaveLength(1)
    const onEvent = engine.created[0]?.options.onEvent
    expect(onEvent).toBeTypeOf('function')

    // While play() is still pending: the event lands synchronously with its
    // side effects — this is exactly what "ledger write-back at swap time"
    // needs, because an interruption afterwards changes nothing on stage.
    onEvent?.({ at: 0.4, type: 'pose-swap', beforeSegmentIndex: 1 })
    expect(swaps.map((entry) => entry.poseKey)).toEqual(['thinking'])
    expect(swapsReported).toBe(1)

    engine.finish('finished')
    expect(await playing).toBe(true)
  })

  it('events past the generation guard neither swap nor report', async () => {
    const { engine, swaps, transitions } = makeHarness()
    let swapsReported = 0

    const first = transitions.play({
      pose: pose('working'),
      definitionId: 'builtin:comic-pop',
      onSwap: () => {
        swapsReported += 1
      },
    })
    // A second enter supersedes the first — generation bumped before the old
    // instance even finished, exactly like an arriving state target does.
    transitions.play({ pose: pose('success'), definitionId: 'builtin:soft' })
    expect(engine.created).toHaveLength(2)
    // The superseded instance was actually cancelled too — the generation
    // guard only silences its events; without cancel() its WAAPI animation
    // would keep running on the transition layer as a zombie.
    expect(engine.cancelled).toBe(true)

    // A late event from the STALE first instance is inert: no stage swap,
    // no ledger report, and play resolves false (superseded).
    engine.created[0]?.options.onEvent?.({ at: 0.4, type: 'pose-swap', beforeSegmentIndex: 1 })
    engine.finish()
    expect(await first).toBe(false)
    expect(swaps.map((entry) => entry.poseKey)).toEqual([])
    expect(swapsReported).toBe(0)
  })
})
