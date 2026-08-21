/**
 * PetStateResolver tests (spec §29.1 StateResolver + §14/§15): visual
 * transitions, activity-change stabilization, waiting, transient
 * success/error with configurable holds, interruption of terminal states and
 * event coalescing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import { PetStateResolver } from '../../src/core/pet-state-resolver'
import type { MotionPetConfig, MotionTarget, PetSemanticEvent } from '../../src/core/types'

const COALESCE = 60

let config: MotionPetConfig
let targets: MotionTarget[]
let resolver: PetStateResolver

beforeEach(() => {
  vi.useFakeTimers()
  targets = []
  config = createDefaultMotionPetConfig()
  resolver = new PetStateResolver({
    config,
    onTarget: (next) => targets.push(next),
  })
})

afterEach(() => {
  resolver.dispose()
  vi.useRealTimers()
})

/** Feed an event and flush the coalescing window. */
const send = async (event: PetSemanticEvent): Promise<void> => {
  resolver.handleEvent(event)
  await vi.advanceTimersByTimeAsync(COALESCE)
}

describe('PetStateResolver — visual transitions (§14)', () => {
  it('idle → active on turn-start', async () => {
    await send({ type: 'turn-start' })
    expect(targets).toEqual([
      { visualState: 'active', activityMode: 'thinking', poseKey: 'thinking', reason: 'agent-state' },
    ])
  })

  it('dedupes identical states (§15.1)', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'turn-start' })
    await send({ type: 'activity', mode: 'thinking' })
    expect(targets).toHaveLength(1)
  })

  it('waiting takes over from active and back (§14.3)', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'waiting' })
    await send({ type: 'activity', mode: 'working' })
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'waiting', 'active'])
    expect(targets[1].poseKey).toBe('waiting')
    expect(targets[2].poseKey).toBe('working') // working activity maps to the working slot
  })
})

describe('PetStateResolver — activity changes inside active (§15.2)', () => {
  it('thinking → command emits an ambient-only target (same poseKey, new activityMode)', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'activity', mode: 'command' })
    expect(targets).toHaveLength(2)
    expect(targets[1]).toEqual({
      visualState: 'active',
      activityMode: 'command',
      poseKey: 'thinking', // unchanged → the director plays no transition (§10.3)
      reason: 'agent-state',
    })
    // a repeated identical activity dedupes away
    await send({ type: 'activity', mode: 'command' })
    expect(targets).toHaveLength(2)
  })

  it('advanced.changePoseWithinActive=true lets the working slot pose through', async () => {
    config.advanced.changePoseWithinActive = true
    await send({ type: 'turn-start' })
    await send({ type: 'activity', mode: 'command' })
    expect(targets[1].poseKey).toBe('working')
  })

  it('reads the flag live off the config object (hot edits apply without a rebuild)', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'activity', mode: 'command' })
    expect(targets[1].poseKey).toBe('thinking') // flag off: ambient-only target
    config.advanced.changePoseWithinActive = true
    await send({ type: 'activity', mode: 'working' })
    expect(targets[2].poseKey).toBe('working') // flag on: the new slot pose emits
    await send({ type: 'activity', mode: 'thinking' })
    expect(targets[3].poseKey).toBe('thinking')
    config.advanced.changePoseWithinActive = false
    await send({ type: 'activity', mode: 'command' })
    expect(targets[4].poseKey).toBe('thinking') // off again: keeps the current pose
  })
})

describe('PetStateResolver — transient success/error (§14.4)', () => {
  it('success holds successHoldMs then returns to idle', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'success' })
    expect(targets[1]).toMatchObject({ visualState: 'success', poseKey: 'success', reason: 'terminal-success' })
    await vi.advanceTimersByTimeAsync(1599)
    expect(targets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(targets[2]).toMatchObject({ visualState: 'idle', poseKey: 'idle' })
  })

  it('error holds errorHoldMs then returns to idle', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'error' })
    expect(targets[1]).toMatchObject({ visualState: 'error', poseKey: 'error', reason: 'terminal-error' })
    await vi.advanceTimersByTimeAsync(1799)
    expect(targets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(targets[2]).toMatchObject({ visualState: 'idle' })
  })

  it('hold durations are configurable via config.global', async () => {
    resolver.dispose()
    const config = createDefaultMotionPetConfig()
    config.global.successHoldMs = 500
    resolver = new PetStateResolver({ config, onTarget: (next) => targets.push(next) })
    await send({ type: 'turn-end', outcome: 'success' })
    await vi.advanceTimersByTimeAsync(500)
    expect(targets.map((next) => next.visualState)).toEqual(['success', 'idle'])
  })

  it('a new activity interrupts the terminal state and cancels the pending idle', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'success' })
    await vi.advanceTimersByTimeAsync(800) // halfway through the hold
    await send({ type: 'turn-start' })
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'success', 'active'])
    await vi.advanceTimersByTimeAsync(5_000) // the stale hold must never fire
    expect(targets).toHaveLength(3)
  })
})

describe('PetStateResolver — coalescing (§15.3)', () => {
  it('collapses a burst of events inside the window into one target', async () => {
    resolver.handleEvent({ type: 'turn-start' })
    resolver.handleEvent({ type: 'activity', mode: 'command' }) // same tick burst
    await vi.advanceTimersByTimeAsync(COALESCE)
    // single idle→active transition; the latest activity wins (command → working slot)
    expect(targets).toEqual([
      { visualState: 'active', activityMode: 'command', poseKey: 'working', reason: 'agent-state' },
    ])
  })

  it('events outside the window are processed separately', async () => {
    await send({ type: 'turn-start' })
    await vi.advanceTimersByTimeAsync(200)
    await send({ type: 'waiting' })
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'waiting'])
  })
})

describe('PetStateResolver — stray-idle suppression (§14.4)', () => {
  it('an agent-idle racing the turn-end inside the coalescing window is dropped', async () => {
    await send({ type: 'turn-start' })
    resolver.handleEvent({ type: 'turn-end', outcome: 'success' })
    resolver.handleEvent({ type: 'idle' }) // the runtime's post-turn idle must not win the window
    await vi.advanceTimersByTimeAsync(COALESCE)
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'success'])
    // the terminal face then holds for the full configured duration
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs - 1)
    expect(targets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(targets[2]).toMatchObject({ visualState: 'idle', poseKey: 'idle' })
  })

  it('agent-idle events during the hold are dropped; the hold still runs to completion', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'success' })
    await send({ type: 'idle' }) // post-commit stray idle, hold running
    expect(targets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(800)
    await send({ type: 'idle' })
    expect(targets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(800) // successHoldMs reached
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'success', 'idle'])
  })

  it('an idle while an error holds is dropped too', async () => {
    await send({ type: 'turn-end', outcome: 'error' })
    await send({ type: 'idle' })
    expect(targets.map((next) => next.visualState)).toEqual(['error'])
    await vi.advanceTimersByTimeAsync(config.global.errorHoldMs)
    expect(targets.map((next) => next.visualState)).toEqual(['error', 'idle'])
  })

  it('an idle reaches through normally when nothing terminal is pending or held', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'idle' }) // e.g. an aborted turn-end normalized to idle
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'idle'])
  })
})

describe('PetStateResolver — dismiss (§14.4)', () => {
  it('dismiss releases a held success immediately and cancels the hold timer', async () => {
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'success' })
    await send({ type: 'dismiss' })
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'success', 'idle'])
    expect(targets[2].reason).toBe('agent-state')
    await vi.advanceTimersByTimeAsync(5_000) // the canceled hold must never fire
    expect(targets).toHaveLength(3)
  })

  it('dismiss releases a held error', async () => {
    await send({ type: 'turn-end', outcome: 'error' })
    await send({ type: 'dismiss' })
    expect(targets.map((next) => next.visualState)).toEqual(['error', 'idle'])
  })

  it('dismiss is a no-op outside success/error', async () => {
    await send({ type: 'dismiss' }) // idle
    await send({ type: 'turn-start' })
    await send({ type: 'dismiss' }) // active
    await send({ type: 'waiting' })
    await send({ type: 'dismiss' }) // waiting
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'waiting'])
  })
})

describe('PetStateResolver — advanced.terminalHold until-interaction (§14.4)', () => {
  it('success never auto-returns to idle; a dismiss releases it', async () => {
    config.advanced.terminalHold = 'until-interaction'
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'success' })
    await vi.advanceTimersByTimeAsync(60_000) // far past successHoldMs
    expect(targets.map((next) => next.visualState)).toEqual(['active', 'success'])
    await send({ type: 'dismiss' })
    expect(targets[2]).toMatchObject({ visualState: 'idle', poseKey: 'idle' })
  })

  it('a new turn releases the held terminal face', async () => {
    config.advanced.terminalHold = 'until-interaction'
    await send({ type: 'turn-end', outcome: 'error' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(targets).toHaveLength(1)
    await send({ type: 'turn-start' })
    expect(targets[1]).toMatchObject({ visualState: 'active', activityMode: 'thinking' })
    await vi.advanceTimersByTimeAsync(10_000) // no late idle from a stale timer
    expect(targets).toHaveLength(2)
  })

  it('stray agent-idle is still dropped while the terminal holds indefinitely', async () => {
    config.advanced.terminalHold = 'until-interaction'
    resolver.handleEvent({ type: 'turn-end', outcome: 'success' })
    resolver.handleEvent({ type: 'idle' })
    await vi.advanceTimersByTimeAsync(COALESCE)
    await send({ type: 'idle' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(targets.map((next) => next.visualState)).toEqual(['success'])
  })

  it('the flag is read live: switching back to timed applies to the next terminal commit', async () => {
    config.advanced.terminalHold = 'until-interaction'
    await send({ type: 'turn-end', outcome: 'success' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(targets).toHaveLength(1) // still held
    config.advanced.terminalHold = 'timed'
    await send({ type: 'turn-start' })
    await send({ type: 'turn-end', outcome: 'success' })
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs)
    expect(targets.map((next) => next.visualState)).toEqual(['success', 'active', 'success', 'idle'])
  })
})
