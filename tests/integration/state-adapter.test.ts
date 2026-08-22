/**
 * state-adapter tests (M4, spec §13.1 → §14): frame decoding, the
 * NormalizedAgentEvent → PetSemanticEvent mapping, §14.5 cross-session
 * aggregate priority, dedupe, EventSource-error fallback polling, session
 * switching, and dispose. Transport is a scripted fake EventSource.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSemanticEvent } from '../../src/core/types'
import {
  StateAdapter,
  toSemanticEvent,
  type EventSourceLike,
  type StateFetcher,
  type StateSnapshot,
} from '../../src/integration/dsh/state-adapter'
import type { NormalizedAgentEvent } from '../../src/integration/dsh/state-protocol'

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  open(): void {
    this.onopen?.()
  }
  message(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  raw(data: string): void {
    this.onmessage?.({ data })
  }
  fail(): void {
    this.onerror?.()
  }
  close(): void {
    this.closed = true
  }
}

let events: PetSemanticEvent[]
let fetchState: ReturnType<typeof vi.fn<StateFetcher>>

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  events = []
  fetchState = vi.fn(async () => ({ events: [] }))
})

afterEach(() => {
  vi.useRealTimers()
})

const makeAdapter = (sessionId?: string): StateAdapter =>
  new StateAdapter({
    onEvent: (event) => events.push(event),
    sessionId,
    eventSourceFactory: (url) => new FakeEventSource(url),
    fetchState,
  })

/** Distributive "ts optional" draft of the NormalizedAgentEvent union. */
type EventDraft = {
  [K in NormalizedAgentEvent['type']]: Omit<Extract<NormalizedAgentEvent, { type: K }>, 'ts'> & { ts?: number }
}[NormalizedAgentEvent['type']]

/**
 * Terminal TTLs are judged against the event's own `ts` (host epoch clock), so
 * the default timestamp is "now" under the faked clock; tests that need age
 * pass an explicit offset back in time.
 */
const event = (partial: EventDraft): NormalizedAgentEvent => ({ ts: Date.now(), ...partial }) as NormalizedAgentEvent

const lastSource = (): FakeEventSource => FakeEventSource.instances[FakeEventSource.instances.length - 1]

describe('connection modes', () => {
  it('connects filtered with ?session= and aggregate without', () => {
    makeAdapter('s1')
    expect(lastSource().url).toBe('/api/motion-pet/events?session=s1')
    makeAdapter()
    expect(lastSource().url).toBe('/api/motion-pet/events')
  })

  it('an empty snapshot resets the pet to idle exactly once', () => {
    makeAdapter('s1')
    lastSource().message({ kind: 'snapshot', events: [] })
    lastSource().message({ kind: 'snapshot', events: [] })
    expect(events).toEqual([{ type: 'idle' }])
  })

  it('ignores malformed frames', () => {
    makeAdapter('s1')
    lastSource().raw('not json at all')
    lastSource().raw('{"kind":"mystery"}')
    expect(events).toEqual([])
  })
})

describe('filtered mode: events pass through mapped', () => {
  it('feeds mapped semantic events in order', () => {
    makeAdapter('s1')
    const source = lastSource()
    source.message({ kind: 'snapshot', events: [] })
    source.message({ kind: 'event', event: event({ type: 'turn-start', sessionId: 's1' }) })
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1' }) })
    source.message({ kind: 'event', event: event({ type: 'tool-start', toolKind: 'edit', sessionId: 's1' }) })
    source.message({ kind: 'event', event: event({ type: 'waiting', sessionId: 's1' }) })
    source.message({ kind: 'event', event: event({ type: 'success', sessionId: 's1' }) })
    expect(events).toEqual([
      { type: 'idle' },
      { type: 'turn-start' },
      { type: 'activity', mode: 'thinking' },
      { type: 'activity', mode: 'coding' },
      { type: 'waiting' },
      { type: 'turn-end', outcome: 'success' },
    ])
  })
})

describe('aggregate mode (§14.5 priority)', () => {
  it('WAITING beats ACTIVE, ERROR beats ACTIVE, ACTIVE beats SUCCESS beats IDLE', () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1', ts: 10 }) })
    expect(events).toEqual([{ type: 'activity', mode: 'thinking' }])
    // A success in another session does not preempt the active one.
    source.message({ kind: 'event', event: event({ type: 'success', sessionId: 's2' }) })
    expect(events).toHaveLength(1)
    // An error anywhere does.
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's3' }) })
    expect(events).toEqual([{ type: 'activity', mode: 'thinking' }, { type: 'turn-end', outcome: 'error' }])
    // And waiting outranks the error.
    source.message({ kind: 'event', event: event({ type: 'waiting', sessionId: 's4', ts: 40 }) })
    expect(events[2]).toEqual({ type: 'waiting' })
  })

  it('falls back to the remaining winner when the top session goes idle', () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1', ts: 10 }) })
    source.message({ kind: 'event', event: event({ type: 'waiting', sessionId: 's2', ts: 20 }) })
    expect(events).toEqual([{ type: 'activity', mode: 'thinking' }, { type: 'waiting' }])
    source.message({ kind: 'event', event: event({ type: 'idle', sessionId: 's2', ts: 30 }) })
    expect(events[2]).toEqual({ type: 'activity', mode: 'thinking' })
  })

  it('dedupes a repeated aggregate winner', () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1', ts: 10 }) })
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1', ts: 20 }) })
    expect(events).toEqual([{ type: 'activity', mode: 'thinking' }])
  })
})

describe('aggregate terminal TTL (§14.5)', () => {
  it('a stale terminal state stops suppressing other sessions after its TTL', async () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's1' }) })
    expect(events).toEqual([{ type: 'turn-end', outcome: 'error' }])

    // within the TTL the error still outranks other sessions' activity
    await vi.advanceTimersByTimeAsync(1000)
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's2', ts: 20 }) })
    expect(events).toHaveLength(1)

    // past the TTL the stale error counts as absent: s2's activity shows
    await vi.advanceTimersByTimeAsync(1000) // 2000ms total ≥ 1800ms default
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's2', ts: 30 }) })
    expect(events).toEqual([
      { type: 'turn-end', outcome: 'error' },
      { type: 'activity', mode: 'thinking' },
    ])
  })

  it('success entries expire on their own (shorter) TTL', async () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'success', sessionId: 's1' }) })
    expect(events).toEqual([{ type: 'turn-end', outcome: 'success' }])
    // the expiry timer recomputes with no new event: nothing left → idle
    await vi.advanceTimersByTimeAsync(1700) // ≥ 1600ms default success TTL
    expect(events).toEqual([{ type: 'turn-end', outcome: 'success' }, { type: 'idle' }])
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's2', ts: 20 }) })
    expect(events).toEqual([
      { type: 'turn-end', outcome: 'success' },
      { type: 'idle' },
      { type: 'activity', mode: 'thinking' },
    ])
  })

  it('honors configurable TTLs', async () => {
    new StateAdapter({
      onEvent: (entry) => events.push(entry),
      eventSourceFactory: (url) => new FakeEventSource(url),
      fetchState,
      successTtlMs: 500,
      errorTtlMs: 500,
    })
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'success', sessionId: 's1' }) })
    await vi.advanceTimersByTimeAsync(600) // ≥ the 500ms TTL: expired → idle
    expect(events).toEqual([{ type: 'turn-end', outcome: 'success' }, { type: 'idle' }])
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's2', ts: 20 }) })
    expect(events).toEqual([
      { type: 'turn-end', outcome: 'success' },
      { type: 'idle' },
      { type: 'activity', mode: 'thinking' },
    ])
  })

  it('a fresh terminal event from the same session refreshes the entry', async () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's1' }) })
    await vi.advanceTimersByTimeAsync(5000) // the first error expired (idle emitted at the TTL)
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's1' }) })
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's2', ts: 30 }) })
    // the renewed error still wins; the idle in between came from the expiry
    expect(events).toEqual([
      { type: 'turn-end', outcome: 'error' },
      { type: 'idle' },
      { type: 'turn-end', outcome: 'error' },
    ])
  })

  it('a suppressed ACTIVE session surfaces when the winning terminal expires — no new event needed', async () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1', ts: 10 }) })
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's2' }) })
    expect(events).toEqual([
      { type: 'activity', mode: 'thinking' },
      { type: 'turn-end', outcome: 'error' },
    ])
    // at the error's expiry the one-shot timer recomputes: s1's live activity wins
    await vi.advanceTimersByTimeAsync(1800)
    expect(events).toEqual([
      { type: 'activity', mode: 'thinking' },
      { type: 'turn-end', outcome: 'error' },
      { type: 'activity', mode: 'thinking' },
    ])
  })

  it('an expiring terminal with nothing behind it returns the pet to idle exactly once', async () => {
    makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'success', sessionId: 's1' }) })
    expect(events).toEqual([{ type: 'turn-end', outcome: 'success' }])
    await vi.advanceTimersByTimeAsync(1600)
    expect(events).toEqual([{ type: 'turn-end', outcome: 'success' }, { type: 'idle' }])
    await vi.advanceTimersByTimeAsync(5000) // no duplicate idle, no stray timers
    expect(events).toHaveLength(2)
  })
})

describe('stale terminal snapshot replay (ghost celebration fix)', () => {
  it('a snapshot success with a stale ts never shows: expired on arrival', () => {
    makeAdapter()
    const source = lastSource()
    source.message({
      kind: 'snapshot',
      events: [event({ type: 'success', sessionId: 's1', ts: Date.now() - 60_000 })],
    })
    // The session finished a minute ago (SSE reconnect/poll replay): the
    // terminal counts as absent, NOT as a fresh celebration.
    expect(events).toEqual([{ type: 'idle' }])
  })

  it('a snapshot terminal with a fresh ts still shows', () => {
    makeAdapter()
    const source = lastSource()
    source.message({
      kind: 'snapshot',
      events: [event({ type: 'success', sessionId: 's1', ts: Date.now() })],
    })
    expect(events).toEqual([{ type: 'turn-end', outcome: 'success' }])
  })

  it("a stale terminal in a snapshot does not suppress another session's live activity", () => {
    makeAdapter()
    const source = lastSource()
    source.message({
      kind: 'snapshot',
      events: [
        event({ type: 'error', sessionId: 's1', ts: Date.now() - 120_000 }),
        event({ type: 'thinking', sessionId: 's2', ts: Date.now() - 1000 }),
      ],
    })
    expect(events).toEqual([{ type: 'activity', mode: 'thinking' }])
  })
})

describe('setTerminalTtls (live hold edits)', () => {
  it('shortening a TTL expires a still-winning terminal entry immediately', async () => {
    const adapter = makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's1', ts: 10 }) })
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's2' }) })
    expect(events).toEqual([
      { type: 'activity', mode: 'thinking' },
      { type: 'turn-end', outcome: 'error' },
    ])
    await vi.advanceTimersByTimeAsync(500) // error age 500 < 1800: still winning
    expect(events).toHaveLength(2)
    adapter.setTerminalTtls(1600, 400) // 500 ≥ 400 → the error expires NOW
    expect(events).toEqual([
      { type: 'activity', mode: 'thinking' },
      { type: 'turn-end', outcome: 'error' },
      { type: 'activity', mode: 'thinking' },
    ])
    adapter.dispose()
  })

  it('lengthening a TTL revives an already-expired terminal entry', async () => {
    const adapter = makeAdapter()
    const source = lastSource()
    source.message({ kind: 'event', event: event({ type: 'error', sessionId: 's1' }) })
    expect(events).toEqual([{ type: 'turn-end', outcome: 'error' }])
    await vi.advanceTimersByTimeAsync(2000) // past the 1800 default: expired → idle
    expect(events).toEqual([{ type: 'turn-end', outcome: 'error' }, { type: 'idle' }])
    adapter.setTerminalTtls(1600, 5000) // age 2000 < 5000 → the error competes again
    expect(events).toEqual([
      { type: 'turn-end', outcome: 'error' },
      { type: 'idle' },
      { type: 'turn-end', outcome: 'error' },
    ])
    adapter.dispose()
  })

  it('unchanged values are a no-op (no recompute, no emission)', () => {
    const adapter = makeAdapter()
    lastSource().message({ kind: 'event', event: event({ type: 'error', sessionId: 's1' }) })
    adapter.setTerminalTtls(1600, 1800)
    expect(events).toEqual([{ type: 'turn-end', outcome: 'error' }])
    adapter.dispose()
  })
})


describe('stale-connection guards (setSession)', () => {
  it('drops a poll snapshot for the old session that resolves after setSession', async () => {
    const fetchResolvers: Array<(snapshot: StateSnapshot) => void> = []
    fetchState.mockImplementation(
      () =>
        new Promise<StateSnapshot>((resolve) => {
          fetchResolvers.push(resolve)
        }),
    )
    const adapter = makeAdapter('s1')
    lastSource().fail()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledWith('s1')

    adapter.setSession('s2')
    // the s1 poll resolves late — its snapshot must not apply
    fetchResolvers[0]?.({ events: [event({ type: 'waiting', sessionId: 's1' })] })
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([])

    // the new session's stream still works
    lastSource().message({ kind: 'event', event: event({ type: 'thinking', sessionId: 's2' }) })
    expect(events).toEqual([{ type: 'activity', mode: 'thinking' }])
  })

  it('ignores frames arriving from the previous session stream', () => {
    const adapter = makeAdapter('s1')
    const first = lastSource()
    adapter.setSession('s2')
    // a queued frame on the closed s1 stream must not apply
    first.message({ kind: 'event', event: event({ type: 'waiting', sessionId: 's1' }) })
    expect(events).toEqual([])
    lastSource().message({ kind: 'event', event: event({ type: 'waiting', sessionId: 's2' }) })
    expect(events).toEqual([{ type: 'waiting' }])
  })
})

describe('recovery', () => {
  it('polls /state only while the stream errors; a reopen stops polling', async () => {
    makeAdapter('s1')
    const source = lastSource()
    expect(fetchState).not.toHaveBeenCalled()
    source.fail()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledTimes(1)
    expect(fetchState).toHaveBeenCalledWith('s1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledTimes(2)
    source.open()
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetchState).toHaveBeenCalledTimes(2)
  })

  it('applies polled snapshots like SSE snapshots', async () => {
    fetchState.mockResolvedValue({ events: [event({ type: 'waiting', sessionId: 's1' })] })
    makeAdapter('s1')
    lastSource().fail()
    await vi.advanceTimersByTimeAsync(2000)
    expect(events).toEqual([{ type: 'waiting' }])
  })
})

describe('session switching', () => {
  it('reconnects with the new session and forgets the old aggregate state', () => {
    const adapter = makeAdapter('s1')
    const first = lastSource()
    first.message({ kind: 'event', event: event({ type: 'waiting', sessionId: 's1' }) })
    expect(events).toEqual([{ type: 'waiting' }])

    adapter.setSession('s2')
    expect(first.closed).toBe(true)
    expect(lastSource().url).toBe('/api/motion-pet/events?session=s2')
    // The new session's empty snapshot returns the pet to idle.
    lastSource().message({ kind: 'snapshot', events: [] })
    expect(events).toEqual([{ type: 'waiting' }, { type: 'idle' }])
  })

  it('setSession with the same id is a no-op', () => {
    const adapter = makeAdapter('s1')
    adapter.setSession('s1')
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('dispose', () => {
  it('closes the stream and stops polling', async () => {
    const adapter = makeAdapter('s1')
    const source = lastSource()
    source.fail()
    adapter.dispose()
    expect(source.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchState).not.toHaveBeenCalled()
  })
})

describe('§23 visibility policy for the fallback poll', () => {
  // This file runs in the node environment: stub the minimal document surface.
  const listeners = new Map<string, () => void>()
  let docHidden = false

  const setHidden = (hidden: boolean): void => {
    docHidden = hidden
    listeners.get('visibilitychange')?.()
  }

  beforeEach(() => {
    listeners.clear()
    docHidden = false
    vi.stubGlobal('document', {
      get hidden() {
        return docHidden
      },
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string, fn: () => void) => {
        if (listeners.get(name) === fn) listeners.delete(name)
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('suspends polling while hidden and resumes it on return when the stream is still down', async () => {
    makeAdapter('s1')
    const source = lastSource()
    source.fail()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledTimes(1)

    setHidden(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchState).toHaveBeenCalledTimes(1) // no polls while hidden

    setHidden(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledTimes(2) // polling resumed
  })

  it('does not start polling for a stream error that arrives while hidden', async () => {
    setHidden(true)
    makeAdapter('s1')
    lastSource().fail()
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchState).not.toHaveBeenCalled()

    setHidden(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledTimes(1)
  })

  it('stays quiet on return when the stream recovered while hidden', async () => {
    makeAdapter('s1')
    const source = lastSource()
    source.fail()
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchState).toHaveBeenCalledTimes(1)

    setHidden(true)
    source.open() // the EventSource's own reconnect beat the poll
    setHidden(false)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchState).toHaveBeenCalledTimes(1)
  })

  it('dispose removes the visibility listener', () => {
    const adapter = makeAdapter('s1')
    expect(listeners.has('visibilitychange')).toBe(true)
    adapter.dispose()
    expect(listeners.has('visibilitychange')).toBe(false)
  })
})

describe('toSemanticEvent (§13.3 mapping)', () => {
  it.each([
    [{ type: 'idle' }, { type: 'idle' }],
    [{ type: 'turn-start' }, { type: 'turn-start' }],
    [{ type: 'thinking' }, { type: 'activity', mode: 'thinking' }],
    [{ type: 'tool-start', toolKind: 'edit' }, { type: 'activity', mode: 'coding' }],
    [{ type: 'tool-start', toolKind: 'command' }, { type: 'activity', mode: 'command' }],
    [{ type: 'tool-start', toolKind: 'other' }, { type: 'activity', mode: 'working' }],
    [{ type: 'tool-end' }, { type: 'activity', mode: 'thinking' }],
    [{ type: 'waiting' }, { type: 'waiting' }],
    [{ type: 'success' }, { type: 'turn-end', outcome: 'success' }],
    [{ type: 'error' }, { type: 'turn-end', outcome: 'error' }],
  ] as const)('%o → %o', (input, expected) => {
    expect(toSemanticEvent({ ts: 0, ...input } as NormalizedAgentEvent)).toEqual(expected)
  })
})
