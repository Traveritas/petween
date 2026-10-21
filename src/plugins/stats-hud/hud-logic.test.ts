/**
 * hud-logic: the pure bubble state machine (Phase 10). Every timing policy
 * is exercised here — threshold gating, episode accumulation across polls,
 * hide-on-leave with holds, focus switching, and the age cap. No DOM.
 */
import { describe, expect, it } from 'vitest'
import {
  createHudReducer,
  DEFAULT_HUD_OPTIONS,
  type HudCommand,
} from './hud-logic'
import type { LedgerEvent as StatsLedgerEvent, LedgerSnapshot as StatsSnapshot, LedgerSessionSummary as StatsSessionSummary } from './ledger'

const T0 = 1_000_000

const session = (overrides: Partial<StatsSessionSummary>): StatsSessionSummary => ({
  agent: 'test',
  state: 'idle',
  thinkingMs: 0,
  thinkingSince: null,
  linesAdded: 0,
  linesRemoved: 0,
  edits: 0,
  lastAt: T0,
  ...overrides,
})

const stateEvent = (seq: number, at: number, state: StatsSessionSummary['state'], sessionId = 's1'): StatsLedgerEvent => ({
  seq,
  at,
  sessionId,
  type: 'state',
  state,
})

const editEvent = (
  seq: number,
  at: number,
  added: number,
  removed: number,
  sessionId = 's1',
): StatsLedgerEvent => ({ seq, at, sessionId, type: 'edit', tool: 'edit', added, removed })

const snapshot = (parts: {
  cursor: number
  focusedSessionId: string | null
  sessions: Record<string, StatsSessionSummary>
  events?: StatsLedgerEvent[]
}): StatsSnapshot => ({ events: [], ...parts })

const types = (commands: HudCommand[]): string[] => commands.map((command) => command.type)

describe('thinking bubble', () => {
  it('shows once the threshold is crossed (live reconciliation path)', () => {
    const reducer = createHudReducer()
    const commands = reducer.apply(
      snapshot({ cursor: 1, focusedSessionId: 's1', sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) } }),
      T0 + DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs + 100,
    )
    expect(commands).toEqual([{ type: 'thinking-show', sessionId: 's1', startedAt: T0 }])
  })

  it('below the threshold nothing shows, and a later leave is silent', () => {
    const reducer = createHudReducer()
    const first = reducer.apply(
      snapshot({ cursor: 2, focusedSessionId: 's1', sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) } }),
      T0 + 500,
    )
    expect(first).toEqual([])
    const second = reducer.apply(
      snapshot({
        cursor: 3,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [stateEvent(3, T0 + 900, 'working')],
      }),
      T0 + 1000,
    )
    expect(second).toEqual([])
  })

  it('hides with the interval total and hold when thinking ends while shown', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({ cursor: 1, focusedSessionId: 's1', sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) } }),
      T0 + 4000,
    )
    const commands = reducer.apply(
      snapshot({
        cursor: 2,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [stateEvent(2, T0 + 4500, 'working')],
      }),
      T0 + 4600,
    )
    expect(commands).toEqual([
      { type: 'thinking-hide', sessionId: 's1', totalMs: 4500, holdMs: DEFAULT_HUD_OPTIONS.thinkingHoldMs },
    ])
  })

  it('hides a stuck thinking bubble when the ring wrapped past the transition (summary fallback)', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({ cursor: 10, focusedSessionId: 's1', sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) } }),
      T0 + 4000,
    )
    // Ring wrap: the cursor jumped past the thinking→working event, so the
    // event stream can never deliver the hide — the summary must (v0.4.0
    // review; without this the timer bubbles forever on a throttled overlay).
    const commands = reducer.apply(
      snapshot({ cursor: 310, focusedSessionId: 's1', sessions: { s1: session({ state: 'working' }) } }),
      T0 + 9000,
    )
    expect(commands).toEqual([
      { type: 'thinking-hide', sessionId: 's1', totalMs: 9000, holdMs: DEFAULT_HUD_OPTIONS.thinkingHoldMs },
    ])
  })

  it('a wrapped ring that started a NEW thinking interval hides the stale one and re-seeds', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({ cursor: 10, focusedSessionId: 's1', sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) } }),
      T0 + 4000,
    )
    const commands = reducer.apply(
      snapshot({
        cursor: 310,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'thinking', thinkingSince: T0 + 8000 }) },
      }),
      T0 + 10_000,
    )
    expect(commands).toEqual([
      { type: 'thinking-hide', sessionId: 's1', totalMs: 10_000, holdMs: DEFAULT_HUD_OPTIONS.thinkingHoldMs },
      { type: 'thinking-show', sessionId: 's1', startedAt: T0 + 8000 },
    ])
  })
})

describe('edit bubble episodes', () => {
  it('spawns on the first edit, accumulates live, hides on leaving working', () => {
    const reducer = createHudReducer()
    const commands = reducer.apply(
      snapshot({
        cursor: 4,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(2, T0 + 10, 3, 1), editEvent(3, T0 + 20, 5, 2), stateEvent(4, T0 + 30, 'thinking')],
      }),
      T0 + 100,
    )
    expect(commands).toEqual([
      { type: 'edit-show', sessionId: 's1', added: 3, removed: 1, files: 1 },
      { type: 'edit-update', sessionId: 's1', added: 8, removed: 3, files: 2 },
      { type: 'edit-hide', sessionId: 's1', holdMs: DEFAULT_HUD_OPTIONS.editHoldMs, maxAgeReached: false },
    ])
  })

  it('accumulates across polls (real-time updating bubble)', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(1, T0, 4, 0)],
      }),
      T0 + 50,
    )
    const second = reducer.apply(
      snapshot({
        cursor: 2,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(2, T0 + 400, 6, 2)],
      }),
      T0 + 500,
    )
    expect(second).toEqual([{ type: 'edit-update', sessionId: 's1', added: 10, removed: 2, files: 2 }])
  })

  it('a new episode after a hide spawns a fresh bubble (counts restart)', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({
        cursor: 2,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(1, T0, 4, 0), stateEvent(2, T0 + 100, 'thinking')],
      }),
      T0 + 150,
    )
    const second = reducer.apply(
      snapshot({
        cursor: 4,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [stateEvent(3, T0 + 200, 'working'), editEvent(4, T0 + 300, 1, 1)],
      }),
      T0 + 350,
    )
    expect(types(second)).toEqual(['edit-show'])
    expect(second[0]).toMatchObject({ added: 1, removed: 1, files: 1 })
  })

  it('unknown counts still bubble (null values pass through)', () => {
    const reducer = createHudReducer()
    const commands = reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [{ seq: 1, at: T0, sessionId: 's1', type: 'edit', tool: 'edit', added: null, removed: null }],
      }),
      T0 + 10,
    )
    expect(commands).toEqual([{ type: 'edit-show', sessionId: 's1', added: null, removed: null, files: 1 }])
  })

  it('enforces the age cap on runaway working episodes', () => {
    const reducer = createHudReducer({ editMaxAgeMs: 5000 })
    reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(1, T0, 2, 0)],
      }),
      T0 + 100,
    )
    const later = reducer.apply(
      snapshot({ cursor: 1, focusedSessionId: 's1', sessions: { s1: session({ state: 'working' }) } }),
      T0 + 6000,
    )
    expect(later).toEqual([{ type: 'edit-hide', sessionId: 's1', holdMs: 0, maxAgeReached: true }])
  })
})

describe('focus scoping', () => {
  it('v1 mode (multiSession off) ignores non-focused sessions entirely', () => {
    const reducer = createHudReducer({ multiSession: false })
    const commands = reducer.apply(
      snapshot({
        cursor: 3,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }), s2: session({ state: 'thinking', thinkingSince: T0 - 9999 }) },
        events: [editEvent(2, T0, 9, 9, 's2'), stateEvent(3, T0, 'thinking', 's2')],
      }),
      T0 + 10_000,
    )
    expect(commands).toEqual([])
  })

  it('multiSession (default) tracks background sessions too — they get their own bubbles', () => {
    const reducer = createHudReducer()
    const commands = reducer.apply(
      snapshot({
        cursor: 3,
        focusedSessionId: 's1',
        sessions: {
          s1: session({ state: 'working' }),
          s2: session({ state: 'thinking', thinkingSince: T0 - 9999 }),
        },
        events: [editEvent(2, T0, 9, 9, 's2'), stateEvent(3, T0, 'thinking', 's2')],
      }),
      T0 + 10_000,
    )
    expect(commands).toContainEqual({ type: 'edit-show', sessionId: 's2', added: 9, removed: 9, files: 1 })
    expect(commands).toContainEqual({ type: 'thinking-show', sessionId: 's2', startedAt: T0 - 9999 })
  })

  it('sessions missing from the snapshot (watchdog dispose) retire their bubbles', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }), s2: session({ state: 'working' }) },
        events: [editEvent(1, T0, 4, 0, 's2')],
      }),
      T0 + 100,
    )
    const after = reducer.apply(
      snapshot({ cursor: 2, focusedSessionId: 's1', sessions: { s1: session({ state: 'working' }) } }),
      T0 + 200,
    )
    expect(after).toEqual([{ type: 'edit-hide', sessionId: 's2', holdMs: 0, maxAgeReached: false }])
  })

  it('multiSession off: a focus switch immediately hides the previous focus bubbles (thinking live)', () => {
    const reducer = createHudReducer({ multiSession: false })
    reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) },
      }),
      T0 + 5000,
    )
    const switched = reducer.apply(
      snapshot({ cursor: 2, focusedSessionId: 's2', sessions: { s2: session({ state: 'idle' }) } }),
      T0 + 5100,
    )
    expect(switched).toEqual([{ type: 'thinking-hide', sessionId: 's1', totalMs: 0, holdMs: 0 }])
  })

  it('multiSession off: a focus switch immediately hides the previous focus bubbles (edit episode live)', () => {
    const reducer = createHudReducer({ multiSession: false })
    reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(1, T0, 3, 1)],
      }),
      T0 + 100,
    )
    const switched = reducer.apply(
      snapshot({ cursor: 2, focusedSessionId: 's2', sessions: { s2: session({ state: 'idle' }) } }),
      T0 + 200,
    )
    expect(switched).toEqual([{ type: 'edit-hide', sessionId: 's1', holdMs: 0, maxAgeReached: false }])
  })

  it('null focus produces no commands', () => {
    const reducer = createHudReducer()
    const commands = reducer.apply(snapshot({ cursor: 0, focusedSessionId: null, sessions: {} }), T0)
    expect(commands).toEqual([])
  })
})

describe('turn summary bubbles (second batch)', () => {
  const summaryEvent = (seq: number, at: number, sessionId = 's1') => ({
    seq,
    at,
    sessionId,
    type: 'turn-summary' as const,
    turnId: 'turn_x',
    summary: { thinkingMs: 21_000, linesAdded: 40, linesRemoved: 3, edits: 4, durationMs: 134_000 },
  })

  it('emits turn-show for the summary event', () => {
    const reducer = createHudReducer()
    const commands = reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'success' }) },
        events: [summaryEvent(1, T0 + 5000)],
      }),
      T0 + 6000,
    )
    expect(commands).toEqual([
      {
        type: 'turn-show',
        sessionId: 's1',
        turnId: 'turn_x',
        thinkingMs: 21_000,
        linesAdded: 40,
        linesRemoved: 3,
        edits: 4,
        durationMs: 134_000,
      },
    ])
  })

  it('turnSummary off suppresses it', () => {
    const reducer = createHudReducer({ turnSummary: false })
    const commands = reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'success' }) },
        events: [summaryEvent(1, T0 + 5000)],
      }),
      T0 + 6000,
    )
    expect(commands).toEqual([])
  })
})

describe('edit milestones (second batch)', () => {
  it('fires once per crossing of milestoneEveryLines added lines', () => {
    const reducer = createHudReducer({ milestoneEveryLines: 100 })
    const commands = reducer.apply(
      snapshot({
        cursor: 3,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(1, T0, 60, 0), editEvent(2, T0 + 10, 30, 0), editEvent(3, T0 + 20, 90, 0), editEvent(4, T0 + 30, 20, 0)],
      }),
      T0 + 100,
    )
    // Totals 60, 90, 180, 200 → level 1 at 180, level 2 at 200.
    expect(commands.filter((command) => command.type === 'edit-milestone')).toEqual([
      { type: 'edit-milestone', sessionId: 's1', lines: 180, level: 1 },
      { type: 'edit-milestone', sessionId: 's1', lines: 200, level: 2 },
    ])
  })

  it('milestones reset with a new episode', () => {
    const reducer = createHudReducer({ milestoneEveryLines: 100 })
    reducer.apply(
      snapshot({
        cursor: 2,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [editEvent(1, T0, 120, 0), stateEvent(2, T0 + 10, 'thinking')],
      }),
      T0 + 100,
    )
    const second = reducer.apply(
      snapshot({
        cursor: 4,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'working' }) },
        events: [stateEvent(3, T0 + 200, 'working'), editEvent(4, T0 + 300, 150, 0)],
      }),
      T0 + 400,
    )
    const milestones = second.filter((command) => command.type === 'edit-milestone')
    expect(milestones).toEqual([{ type: 'edit-milestone', sessionId: 's1', lines: 150, level: 1 }])
  })
})

describe('multiSession focus switches (second batch)', () => {
  it('multiSession on: a focus switch keeps the previous focus bubbles alive', () => {
    const reducer = createHudReducer()
    reducer.apply(
      snapshot({
        cursor: 1,
        focusedSessionId: 's1',
        sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }) },
      }),
      T0 + 5000,
    )
    const switched = reducer.apply(
      snapshot({ cursor: 2, focusedSessionId: 's2', sessions: { s1: session({ state: 'thinking', thinkingSince: T0 }), s2: session({ state: 'idle' }) } }),
      T0 + 5100,
    )
    expect(switched).toEqual([])
  })
})
