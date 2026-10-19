/**
 * ledger — the agent-agnostic stats account book. It consumes AgentEvents and
 * owns everything downstream: thinking-time accumulation, per-session line
 * totals, a seq-numbered event ring the HUD polls, and the "focused session"
 * pointer (explicit target when set, else the last active session).
 *
 * Storage is integers and ids ONLY (edit content is reduced to counts by
 * line-count before it lands here — never persisted). Sessions leave via a
 * `session-end` event (the kernel's watchdog synthesizes one for idle
 * sessions); the ring is bounded so a chatty session cannot grow memory.
 *
 * Pure TS; time comes from AgentEvent.at, no clock inside.
 */
import type { AgentEvent } from '../../api/types';
import { countEditLines, editToolClass } from './line-count';

export type LedgerAgentState = 'idle' | 'thinking' | 'working' | 'waiting' | 'success' | 'error';

export interface LedgerEvent {
  seq: number;
  at: number;
  sessionId: string;
  type: 'state' | 'edit' | 'turn-summary';
  state?: LedgerAgentState;
  tool?: 'edit' | 'write' | 'patch';
  filePath?: string;
  /** Null = payload shape unknown: the edit still counts, without lines. */
  added?: number | null;
  removed?: number | null;
  turnId?: string;
  /** turn-summary payload: per-turn deltas + wall duration. */
  summary?: { thinkingMs: number; linesAdded: number; linesRemoved: number; edits: number; durationMs: number };
}

export interface LedgerSessionSummary {
  agent: string;
  state: LedgerAgentState;
  /** Accumulated thinking time across the session so far (ms). */
  thinkingMs: number;
  /** Non-null while the session is thinking (live timer anchor, epoch ms). */
  thinkingSince: number | null;
  linesAdded: number;
  linesRemoved: number;
  edits: number;
  lastAt: number;
}

export interface LedgerSnapshot {
  /** Monotonic; pass back as `since` to fetch only newer events. */
  cursor: number;
  focusedSessionId: string | null;
  sessions: Record<string, LedgerSessionSummary>;
  /** Ring events with seq > since (the whole ring when since is 0/absent). */
  events: LedgerEvent[];
}

export interface StatsLedger {
  /** Feed one AgentEvent; the ledger derives state / turn start / edit / dispose from it. */
  record(e: AgentEvent): void;
  /** Explicit focus (follow target); null falls back to the last active session. */
  setFocus(sessionId: string | null): void;
  /** Drop a session row without an event (session-end does this already). */
  disposeSession(sessionId: string): void;
  snapshot(since?: number): LedgerSnapshot;
}

const RING_CAPACITY = 256;

interface SessionRow {
  summary: LedgerSessionSummary;
  /** Open turn baseline (null between turns); closed into a turn-summary on success. */
  turn: {
    startedAt: number;
    baseThinkingMs: number;
    baseAdded: number;
    baseRemoved: number;
    baseEdits: number;
    turnId?: string;
  } | null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Where an edit tool says it writes; shapes differ per agent. */
function filePathOf(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const o = toolInput as Record<string, unknown>;
  return str(o.file_path) ?? str(o.filePath) ?? str(o.notebook_path) ?? str(o.path);
}

/** Ledger state an event implies, or null for session-end (dispose, no state). */
function stateOf(e: AgentEvent): LedgerAgentState | null {
  switch (e.type) {
    case 'session-start':
      return 'idle';
    case 'turn-start':
    case 'thinking':
    case 'tool-end':
      return 'thinking';
    case 'tool-start':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'turn-end':
      // An interrupted turn is abandoned (no summary), like v0's idle decay.
      if (e.outcome === 'error') return 'error';
      return e.outcome === 'interrupted' ? 'idle' : 'success';
    case 'session-end':
      return null;
  }
}

export function createStatsLedger(): StatsLedger {
  const sessions = new Map<string, SessionRow>();
  const ring: LedgerEvent[] = [];
  let seq = 0;
  let focus: string | null = null;

  const pushEvent = (event: Omit<LedgerEvent, 'seq'>): void => {
    seq += 1;
    ring.push({ ...event, seq });
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  };

  const rowOf = (sessionId: string, agent: string, at: number): SessionRow => {
    let row = sessions.get(sessionId);
    if (row === undefined) {
      row = {
        summary: { agent, state: 'idle', thinkingMs: 0, thinkingSince: null, linesAdded: 0, linesRemoved: 0, edits: 0, lastAt: at },
        turn: null,
      };
      sessions.set(sessionId, row);
    }
    return row;
  };

  const closeThinking = (row: SessionRow, at: number): void => {
    if (row.summary.thinkingSince === null) return;
    row.summary.thinkingMs += Math.max(0, at - row.summary.thinkingSince);
    row.summary.thinkingSince = null;
  };

  const recordState = (row: SessionRow, sessionId: string, state: LedgerAgentState, at: number, turnId?: string): void => {
    if (state === 'thinking' && row.summary.state !== 'thinking') {
      row.summary.thinkingSince = at;
    } else if (state !== 'thinking') {
      closeThinking(row, at);
    }
    row.summary.state = state;
    row.summary.lastAt = at;
    pushEvent({ at, sessionId, type: 'state', state });
    // Turn end: emit the per-turn deltas, then arm the next turn.
    if (state === 'success' && row.turn !== null) {
      const turn = row.turn;
      row.turn = null;
      pushEvent({
        at,
        sessionId,
        type: 'turn-summary',
        turnId: turnId ?? turn.turnId,
        summary: {
          thinkingMs: Math.max(0, row.summary.thinkingMs - turn.baseThinkingMs),
          linesAdded: row.summary.linesAdded - turn.baseAdded,
          linesRemoved: row.summary.linesRemoved - turn.baseRemoved,
          edits: row.summary.edits - turn.baseEdits,
          durationMs: Math.max(0, at - turn.startedAt),
        },
      });
    }
    // An abandoned turn (session restart / interrupt) never summarizes.
    if (state === 'idle') row.turn = null;
  };

  const recordTurnStart = (row: SessionRow, at: number, turnId?: string): void => {
    row.turn = {
      startedAt: at,
      baseThinkingMs: row.summary.thinkingMs,
      baseAdded: row.summary.linesAdded,
      baseRemoved: row.summary.linesRemoved,
      baseEdits: row.summary.edits,
      turnId,
    };
  };

  const recordEdit = (row: SessionRow, e: AgentEvent, turnId?: string): void => {
    const toolInput = e.extra?.toolInput;
    const counts = countEditLines(e.tool?.name, toolInput);
    const added = counts === null ? null : counts.added;
    const removed = counts === null ? null : counts.removed;
    row.summary.edits += 1;
    if (added !== null) row.summary.linesAdded += added;
    if (removed !== null) row.summary.linesRemoved += removed;
    row.summary.lastAt = e.at;
    pushEvent({
      at: e.at,
      sessionId: e.sessionId,
      type: 'edit',
      tool: editToolClass(e.tool?.name),
      filePath: filePathOf(toolInput),
      added,
      removed,
      turnId,
    });
  };

  const disposeSession = (sessionId: string): void => {
    sessions.delete(sessionId);
    if (focus === sessionId) focus = null;
  };

  return {
    record(e) {
      const state = stateOf(e);
      if (state === null) {
        disposeSession(e.sessionId);
        return;
      }
      const row = rowOf(e.sessionId, e.agent, e.at);
      const turnId = str(e.extra?.turnId);
      // turnId rides only on the turn-end state (v0 statsTurnIdKinds: stop).
      recordState(row, e.sessionId, state, e.at, e.type === 'turn-end' ? turnId : undefined);
      if (e.type === 'turn-start') recordTurnStart(row, e.at, turnId);
      if (e.type === 'tool-start' && e.tool?.kind === 'edit') recordEdit(row, e, turnId);
    },

    setFocus(sessionId) {
      focus = sessionId;
    },

    disposeSession,

    snapshot(since = 0) {
      const summaries: Record<string, LedgerSessionSummary> = {};
      for (const [id, row] of sessions) summaries[id] = { ...row.summary };
      const events = since > 0 ? ring.filter((event) => event.seq > since) : [...ring];
      return {
        cursor: seq,
        focusedSessionId: focus ?? lastActiveSession(sessions),
        sessions: summaries,
        events,
      };
    },
  };
}

/** Fallback focus: the session whose last fact is newest (no explicit target). */
function lastActiveSession(sessions: Map<string, SessionRow>): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const [id, row] of sessions) {
    if (row.summary.lastAt >= bestAt) {
      best = id;
      bestAt = row.summary.lastAt;
    }
  }
  return best;
}
