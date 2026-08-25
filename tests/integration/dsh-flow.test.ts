// @vitest-environment jsdom
/**
 * End-to-end M4 mainline (spec §29.4, DSH edition): raw DSH SessionEvent /
 * agent-status fixtures → the REAL host normalizer → a JSON roundtrip (the
 * SSE wire format) → the REAL client StateAdapter → DshStateSource → REAL
 * PetStateResolver → REAL MotionDirector over the fake-animate stage.
 *
 * Walks: idle → turn/start → reasoning → tool/call(bash) → tool/result →
 * approval/asked → approval/decided → turn/end(completed) → agent idle, i.e.
 * IDLE→ACTIVE→WAITING→ACTIVE→SUCCESS→IDLE, and asserts that
 * THINKING→TOOL→THINKING never plays a full transition (ambient-only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import { createPoseResolver } from '../../src/core/pose-resolver'
import type { AssetMeta, PetweenConfig } from '../../src/core/types'
import { DshStateSource } from '../../src/integration/dsh/dsh-state-source'
import {
  normalizeAgentStatus,
  normalizeSessionEvent,
  type RawSessionEvent,
} from '../../src/integration/dsh/event-normalizer'
import type { NormalizedAgentEvent } from '../../src/integration/dsh/state-protocol'
import type { EventSourceLike } from '../../src/integration/dsh/state-adapter'
import { createBuiltinRegistry } from '../../src/motion/animation-registry'
import { MotionDirector } from '../../src/motion/motion-director'
import { createFakeStage, installFakeAnimate, type FakeAnimateHarness, type FakeStage } from '../motion/fake-animate'

const SID = 'session-1'

/** The scripted EventSource the host frames are pushed through. */
class FakeEventSource implements EventSourceLike {
  static instance: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.instance = this
  }
  /** Push a normalized event exactly as the SSE channel would serialize it. */
  push(event: NormalizedAgentEvent | null): void {
    if (event === null) return // the host drops unmapped events before framing
    this.onmessage?.({ data: JSON.stringify({ kind: 'event', event }) })
  }
  close(): void {
    this.closed = true
  }
}

let harness: FakeAnimateHarness
let stage: FakeStage
let config: PetweenConfig
let director: MotionDirector
let source: DshStateSource
let clock = 0

beforeEach(() => {
  vi.useFakeTimers()
  harness = installFakeAnimate()
  stage = createFakeStage()
  clock = 0
  config = createDefaultPetweenConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of ['idle', 'thinking', 'working', 'waiting', 'success', 'error'] as const) {
    assets[key] = {
      id: key,
      fileName: `${key}.webp`,
      mimeType: 'image/webp',
      width: 240,
      height: 240,
      sizeBytes: 1024,
      sha256: `sha-${key}`,
      url: `/petween-assets/${key}.webp`,
    }
    config.poses[key].assetId = key
  }
  director = new MotionDirector({
    stage,
    registry: createBuiltinRegistry(),
    config,
    resolvePose: createPoseResolver(config.poses, assets),
  })
  source = new DshStateSource({
    config,
    director,
    eventSourceFactory: (url) => new FakeEventSource(url),
  })
  FakeEventSource.instance!.onopen?.()
})

afterEach(() => {
  source.dispose()
  director.dispose()
  harness.restore()
  vi.useRealTimers()
})

/** Host side: normalize a raw session event and push it down the wire. */
const sendSessionEvent = (type: string, data: unknown): void => {
  // Realistic epoch times (the adapter's terminal TTLs judge the event's own
  // `ts`, so a 1970 timestamp would arrive pre-expired).
  const raw: RawSessionEvent = { type, time: Date.now() + (clock += 1000), data }
  FakeEventSource.instance!.push(normalizeSessionEvent(SID, raw))
}

const sendAgentStatus = (status: 'idle' | 'running'): void => {
  FakeEventSource.instance!.push(normalizeAgentStatus(SID, status))
}

/** Flush the resolver's coalescing window and drain every finite animation. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(60)
  for (let guard = 0; guard < 20; guard += 1) {
    const finite = harness.pending().filter((animation) => animation.options.iterations !== Infinity)
    if (finite.length === 0) return
    for (const animation of finite) animation.finish()
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error('animations did not settle')
}

const transitionRunCount = (): number =>
  harness.animations.filter((animation) => animation.target === stage.layers.transition).length

const swappedPoses = (): string[] => stage.swapped.map((pose) => pose.poseKey)

describe('DSH mainline: IDLE→ACTIVE→WAITING→ACTIVE→SUCCESS→IDLE (§29.4)', () => {
  it('raw DSH events drive the pet without reasoning↔tool flapping', async () => {
    // The very first frame is the snapshot; an idle agent keeps the pet idle.
    sendAgentStatus('idle')
    await settle()
    expect(swappedPoses()).toEqual([])
    expect(transitionRunCount()).toBe(0)

    // turn/start → ACTIVE(thinking): one enter transition (pre + post).
    sendSessionEvent('turn/start', { turn: 1 })
    sendSessionEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '…' } })
    await settle()
    expect(swappedPoses()).toEqual(['thinking'])
    expect(transitionRunCount()).toBe(2)

    // More reasoning: identical state, nothing happens (§15.1).
    sendSessionEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '…' } })
    await settle()
    expect(transitionRunCount()).toBe(2)

    // tool/call bash → ACTIVE(command): ZERO pose transition, ambient-only.
    sendSessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    await settle()
    expect(swappedPoses()).toEqual(['thinking'])
    expect(transitionRunCount()).toBe(2)
    expect(
      harness.animations.some((a) => a.target === stage.layers.breathe && a.playState === 'running'),
    ).toBe(true)

    // tool/result → back to thinking activity: still ambient-only.
    sendSessionEvent('tool/result', { turn: 1, step: 1, message: {} })
    await settle()
    expect(swappedPoses()).toEqual(['thinking'])
    expect(transitionRunCount()).toBe(2)

    // approval/asked → WAITING: one transition.
    sendSessionEvent('approval/asked', { id: 'a1', toolName: 'bash' })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'waiting'])
    expect(transitionRunCount()).toBe(4)

    // approval/decided → ACTIVE again: one transition back to thinking.
    sendSessionEvent('approval/decided', { id: 'a1', outcome: 'allowed-once' })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'waiting', 'thinking'])
    expect(transitionRunCount()).toBe(6)

    // turn/end completed → SUCCESS: one celebrate transition. The real runtime
    // reports agent idle IMMEDIATELY after turn/end; that stray idle must not
    // cut the terminal face short (regression: success used to flash for ~60ms).
    sendSessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sendAgentStatus('idle')
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'waiting', 'thinking', 'success'])
    expect(transitionRunCount()).toBe(8)

    // The full hold still runs; only then does the pet return to idle.
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs)
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'waiting', 'thinking', 'success', 'idle'])
    expect(transitionRunCount()).toBe(10)
  })

  it('a post-commit agent idle during the hold is dropped as well', async () => {
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    sendSessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle() // success committed, hold running
    sendAgentStatus('idle') // a late stray idle must not clear the hold either
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'success'])
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs)
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'success', 'idle'])
  })

  it('a turn ending in error shows the error face and holds it for the full errorHoldMs', async () => {
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    sendSessionEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    sendAgentStatus('idle') // the runtime's immediate idle must not kill the error face
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'error'])
    await vi.advanceTimersByTimeAsync(config.global.errorHoldMs)
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'error', 'idle'])
  })

  it('an aborted turn returns straight to idle without an error face', async () => {
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    sendSessionEvent('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'idle'])
  })

  it('changePoseWithinActive + activityTransition=none: reasoning↔tool swaps poses silently (§15.2)', async () => {
    config.advanced.changePoseWithinActive = true // read live by the resolver
    config.advanced.activityTransition = 'none' // read live by the director
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    expect(swappedPoses()).toEqual(['thinking'])
    expect(transitionRunCount()).toBe(2) // the enter transition (pre + post)

    // tool/call bash → ACTIVE(command): silent pose swap, NO transition.
    sendSessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'working'])
    expect(transitionRunCount()).toBe(2)
    expect(director.transitionInFlight).toBe(false)

    // tool/result → back to thinking: a second silent swap, still no transition.
    sendSessionEvent('tool/result', { turn: 1, step: 1, message: {} })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'working', 'thinking'])
    expect(transitionRunCount()).toBe(2)

    // A visual-state change still plays the full enter transition.
    sendSessionEvent('approval/asked', { id: 'a1', toolName: 'bash' })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'working', 'thinking', 'waiting'])
    expect(transitionRunCount()).toBe(4)
  })
})

describe('terminalHold until-interaction: the terminal face waits for the user (§14.4)', () => {
  it('success survives the post-turn idle and holds until a pet click dismisses it', async () => {
    config.advanced.terminalHold = 'until-interaction' // read live by the resolver
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    sendSessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sendAgentStatus('idle') // dropped: stray idle while the terminal is pending/held
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'success'])

    // No auto-return: far past successHoldMs the success face persists.
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'success'])

    // A pet click releases it back to idle.
    source.dismissTerminal()
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'success', 'idle'])
  })

  it('a new turn releases the held error face', async () => {
    config.advanced.terminalHold = 'until-interaction'
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    sendSessionEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'error'])
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'error'])

    sendSessionEvent('turn/start', { turn: 2 })
    await settle()
    expect(swappedPoses()).toEqual(['thinking', 'error', 'thinking'])
  })

  it('dismissing with no terminal on screen is a no-op', async () => {
    sendSessionEvent('turn/start', { turn: 1 })
    await settle()
    source.dismissTerminal()
    await settle()
    expect(swappedPoses()).toEqual(['thinking'])
  })
})
