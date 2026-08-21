/**
 * dsh-state-source tests (M4): the adapter feeds the REAL PetStateResolver
 * (coalescing, dedupe, transient holds included) and targets land on the
 * (faked) MotionDirector; the installed current-session bridge drives stream
 * reconnects. Node env is enough — neither class touches the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import type { MotionTarget } from '../../src/core/types'
import type { MotionDirector } from '../../src/motion/motion-director'
import type { EventSourceLike } from '../../src/integration/dsh/state-adapter'
import {
  DshStateSource,
  getCurrentSessionSource,
  installCurrentSessionSource,
  type CurrentSessionSource,
} from '../../src/integration/dsh/dsh-state-source'

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  message(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  close(): void {
    this.closed = true
  }
}

class FakeSessionSource implements CurrentSessionSource {
  private readonly listeners = new Set<() => void>()
  current: string | undefined = 's1'
  getCurrent(): string | undefined {
    return this.current
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  select(id: string | undefined): void {
    this.current = id
    for (const listener of this.listeners) listener()
  }
}

let targets: MotionTarget[]
let director: MotionDirector
let config: ReturnType<typeof createDefaultMotionPetConfig>

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  targets = []
  director = { setTarget: vi.fn(async (target: MotionTarget) => void targets.push(target)) } as unknown as MotionDirector
  config = createDefaultMotionPetConfig()
})

afterEach(() => {
  installCurrentSessionSource(null)
  vi.useRealTimers()
})

const lastSource = (): FakeEventSource => FakeEventSource.instances[FakeEventSource.instances.length - 1]

const makeSource = (sessionSource?: CurrentSessionSource): DshStateSource =>
  new DshStateSource({
    config,
    director,
    sessionSource,
    eventSourceFactory: (url) => new FakeEventSource(url),
  })

describe('DshStateSource', () => {
  it('runs stream events through the real resolver onto the director', async () => {
    const source = makeSource()
    const stream = lastSource()
    // Empty snapshot → idle, which the resolver dedupes (it starts idle).
    stream.message({ kind: 'snapshot', events: [] })
    await vi.advanceTimersByTimeAsync(100)
    expect(targets).toEqual([])

    stream.message({ kind: 'event', event: { type: 'turn-start', sessionId: '', ts: 1 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ visualState: 'active', activityMode: 'thinking', reason: 'agent-state' })
    source.dispose()
  })

  it('coalesces a same-window burst into one target', async () => {
    const source = makeSource()
    const stream = lastSource()
    stream.message({ kind: 'event', event: { type: 'turn-start', ts: 1 } })
    stream.message({ kind: 'event', event: { type: 'thinking', ts: 2 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets).toHaveLength(1)
    source.dispose()
  })

  it('success is transient: the resolver returns the pet to idle after the hold', async () => {
    const source = makeSource()
    const stream = lastSource()
    stream.message({ kind: 'event', event: { type: 'turn-start', ts: 1 } })
    await vi.advanceTimersByTimeAsync(60)
    stream.message({ kind: 'event', event: { type: 'success', ts: 2 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets).toHaveLength(2)
    expect(targets[1]).toMatchObject({ visualState: 'success', reason: 'terminal-success' })
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs + 60)
    expect(targets).toHaveLength(3)
    expect(targets[2]).toMatchObject({ visualState: 'idle', reason: 'agent-state' })
    source.dispose()
  })

  it('passes config.global terminal holds to the adapter as aggregate TTLs (§14.5)', async () => {
    config.global.errorHoldMs = 100 // short hold: the aggregate TTL follows it
    const source = makeSource() // no bridge → aggregate stream
    const stream = lastSource()
    stream.message({ kind: 'event', event: { type: 'error', sessionId: 's1', ts: 1 } })
    await vi.advanceTimersByTimeAsync(60) // resolver coalescing
    expect(targets.map((target) => target.visualState)).toEqual(['error'])

    // past the configured TTL, the stale error stops suppressing s2's turn
    await vi.advanceTimersByTimeAsync(150)
    stream.message({ kind: 'event', event: { type: 'turn-start', sessionId: 's2', ts: 2 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets[targets.length - 1]).toMatchObject({ visualState: 'active', activityMode: 'thinking' })
    source.dispose()
  })

  it('setTerminalTtls hot-applies live hold edits to the adapter', async () => {
    const source = makeSource() // aggregate stream; holds are the defaults
    const stream = lastSource()
    stream.message({ kind: 'event', event: { type: 'thinking', sessionId: 's1', ts: 1 } })
    await vi.advanceTimersByTimeAsync(60)
    stream.message({ kind: 'event', event: { type: 'error', sessionId: 's2', ts: 2 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets.map((target) => target.visualState)).toEqual(['active', 'error'])

    // the error still wins at this age; shrinking the TTL below it frees s1
    await vi.advanceTimersByTimeAsync(500)
    source.setTerminalTtls(1600, 400)
    await vi.advanceTimersByTimeAsync(60) // resolver coalescing for the freed activity
    expect(targets[targets.length - 1]).toMatchObject({ visualState: 'active', activityMode: 'thinking' })
    source.dispose()
  })

  it('dismissTerminal releases a held success through the real resolver; no-op outside a terminal', async () => {
    const source = makeSource()
    const stream = lastSource()
    stream.message({ kind: 'event', event: { type: 'success', sessionId: 's1', ts: 1 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ visualState: 'success', reason: 'terminal-success' })

    source.dismissTerminal()
    await vi.advanceTimersByTimeAsync(60) // dismiss passes through the coalescing window
    expect(targets).toHaveLength(2)
    expect(targets[1]).toMatchObject({ visualState: 'idle', reason: 'agent-state' })

    source.dismissTerminal() // already idle — nothing happens
    await vi.advanceTimersByTimeAsync(60)
    expect(targets).toHaveLength(2)
    source.dispose()
  })

  it('the post-turn agent idle does not cut success short (stray-idle suppression)', async () => {
    const source = makeSource()
    const stream = lastSource()
    // Same session: the idle replaces the success entry and reaches the
    // resolver inside the coalescing window — it must be dropped.
    stream.message({ kind: 'event', event: { type: 'success', sessionId: 's1', ts: 1 } })
    stream.message({ kind: 'event', event: { type: 'idle', sessionId: 's1', ts: 2 } })
    await vi.advanceTimersByTimeAsync(60)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ visualState: 'success' })
    await vi.advanceTimersByTimeAsync(config.global.successHoldMs)
    expect(targets[1]).toMatchObject({ visualState: 'idle' })
    source.dispose()
  })

  it('connects with the bridge-provided current session and follows changes', () => {
    const sessions = new FakeSessionSource()
    const source = makeSource(sessions)
    expect(lastSource().url).toBe('/api/motion-pet/events?session=s1')
    sessions.select('s2')
    expect(lastSource().url).toBe('/api/motion-pet/events?session=s2')
    expect(FakeEventSource.instances[0].closed).toBe(true)
    sessions.select(undefined) // no current session → aggregate stream
    expect(lastSource().url).toBe('/api/motion-pet/events')
    source.dispose()
  })

  it('without a bridge it connects to the aggregate stream', () => {
    const source = makeSource()
    expect(lastSource().url).toBe('/api/motion-pet/events')
    source.dispose()
  })

  it('dispose closes the stream and cancels pending resolver work', async () => {
    const source = makeSource()
    const stream = lastSource()
    stream.message({ kind: 'event', event: { type: 'turn-start', ts: 1 } })
    source.dispose()
    expect(stream.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(targets).toEqual([]) // coalescing timer canceled before commit
  })
})

describe('session-source bridge', () => {
  it('install/uninstall exposes the singleton', () => {
    const sessions = new FakeSessionSource()
    expect(getCurrentSessionSource()).toBeNull()
    installCurrentSessionSource(sessions)
    expect(getCurrentSessionSource()).toBe(sessions)
    installCurrentSessionSource(null)
    expect(getCurrentSessionSource()).toBeNull()
  })
})
