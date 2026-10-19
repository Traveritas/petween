// Default brain core (docs/05 §4). Pure: time and output are injected so it tests with fake timers.
// Ported from v0 pet-state-resolver.ts + state-machine.ts; the stabilization behaviour is unchanged,
// only the input (AgentEvent) and output (state key) differ.

import type { AgentEvent } from '../../api/types';

export interface BrainClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BrainOptions {
  /** Trailing-edge merge window; every event inside it resets the wait. */
  mergeWindowMs: number;
  /** Starvation cap: a nonstop stream still commits this long after the first uncommitted event. */
  maxDelayMs: number;
  successHoldMs: number;
  errorHoldMs: number;
  /** Terminal faces hold until release() instead of a timer. */
  holdUntilClick: boolean;
  /** Idle this long -> `idle.long`. */
  idleLongMs: number;
  /** Merge policy: only the session that most recently had a focus event drives the pet. */
  followFocus: boolean;
}

export const DEFAULT_OPTIONS: BrainOptions = {
  mergeWindowMs: 60,
  maxDelayMs: 200,
  successHoldMs: 1600,
  errorHoldMs: 1800,
  holdUntilClick: false,
  idleLongMs: 300000,
  followFocus: false,
};

export interface BrainCore {
  onEvent(e: AgentEvent): void;
  /** Ends a terminal (success/error) hold early; no-op otherwise. */
  release(): void;
  /** Last committed key. */
  readonly key: string;
  dispose(): void;
}

const IDLE = 'idle';
const IDLE_LONG = 'idle.long';

const isTerminal = (k: string) => k === 'success' || k === 'error';

/** docs/05 §4.3: waiting > error > active.* > success > idle. */
function rank(k: string): number {
  if (k === 'waiting') return 4;
  if (k === 'error') return 3;
  if (k.startsWith('active.')) return 2;
  if (k === 'success') return 1;
  return 0;
}

/** Per-event key derivation (docs/05 §4.2). `prev` is the session's current key. */
function deriveKey(prev: string, e: AgentEvent): string {
  switch (e.type) {
    case 'session-start':
      return IDLE;
    case 'turn-start':
    case 'thinking':
      return 'active.thinking';
    case 'tool-start': {
      const t = e.tool;
      if (t?.kind === 'edit') return 'active.edit';
      if (t?.kind === 'command') return `active.command.${t.name}`;
      return 'active.other';
    }
    case 'tool-end':
      // The agent goes back to reasoning (also after a permission wait); a late tool-end after the turn ended is ignored.
      return prev.startsWith('active.') || prev === 'waiting' ? 'active.thinking' : prev;
    case 'waiting':
      return 'waiting';
    case 'turn-end':
      if (e.outcome === 'error') return 'error';
      if (e.outcome === 'interrupted') return IDLE;
      return 'success';
    default:
      return prev;
  }
}

interface Session {
  key: string;
  /** Arrival order; ties in the merge go to the larger one. Arrival, not `at`, so clock skew between agents can't matter. */
  seq: number;
  /** Arrival order of the last focus event (0 = never). */
  focusSeq: number;
}

export function createBrain(
  output: (key: string) => void,
  clock: BrainClock,
  options: Partial<BrainOptions> = {},
): BrainCore {
  const o: BrainOptions = { ...DEFAULT_OPTIONS, ...options };
  const sessions = new Map<string, Session>();
  let seq = 0;

  let current = IDLE;
  let pendingKey: string | null = null;
  let pendingSince: number | null = null;
  let mergeTimer: unknown = null;
  let holdTimer: unknown = null;
  let idleTimer: unknown = null;

  const cancel = (h: unknown) => {
    if (h !== null) clock.clearTimeout(h);
  };

  function merged(): string {
    let pool = [...sessions.values()];
    if (o.followFocus) {
      // No session has had a focus event yet (e.g. we attached mid-session): fall back to all.
      const focused = pool.filter((s) => s.focusSeq > 0);
      if (focused.length) pool = [focused.reduce((a, b) => (b.focusSeq > a.focusSeq ? b : a))];
    }
    let best: Session | null = null;
    for (const s of pool) {
      if (!best || rank(s.key) > rank(best.key) || (rank(s.key) === rank(best.key) && s.seq > best.seq)) best = s;
    }
    return best?.key ?? IDLE;
  }

  /** A terminal face is over: sessions still parked on success/error go back to idle so they can't resurface. */
  function clearTerminal() {
    for (const s of sessions.values()) if (isTerminal(s.key)) s.key = IDLE;
  }

  function commit(key: string) {
    // `idle.long` is still idle; a plain idle must not wake it.
    if (key === current || (key === IDLE && current === IDLE_LONG)) return;
    cancel(holdTimer);
    cancel(idleTimer);
    holdTimer = idleTimer = null;
    current = key;
    if (!isTerminal(key)) clearTerminal();
    output(key);
    if (isTerminal(key) && !o.holdUntilClick) {
      holdTimer = clock.setTimeout(() => {
        holdTimer = null;
        endHold();
      }, key === 'success' ? o.successHoldMs : o.errorHoldMs);
    }
    if (key === IDLE) {
      idleTimer = clock.setTimeout(() => {
        idleTimer = null;
        commit(IDLE_LONG);
      }, o.idleLongMs);
    }
  }

  function endHold() {
    clearTerminal();
    commit(merged());
  }

  idleTimer = clock.setTimeout(() => {
    idleTimer = null;
    commit(IDLE_LONG);
  }, o.idleLongMs);

  return {
    onEvent(e) {
      const id = `${e.agent}:${e.sessionId}`;
      if (e.type === 'session-end') {
        sessions.delete(id);
      } else {
        const s = sessions.get(id) ?? { key: IDLE, seq: 0, focusSeq: 0 };
        s.seq = ++seq;
        if (e.type === 'session-start' || e.type === 'turn-start') s.focusSeq = s.seq;
        s.key = deriveKey(s.key, e);
        sessions.set(id, s);
      }

      const key = merged();
      // Stray-idle suppression: the idle that trails a turn-end must not cut the terminal face short,
      // whether the turn-end is still merging or already held.
      if (!isTerminal(key) && key !== current && rank(key) === 0 && (isTerminal(current) || (pendingKey !== null && isTerminal(pendingKey)))) return;
      // Also when the idle equals the committed key: a success still merging must not be overwritten by it.
      if (key === IDLE && pendingKey !== null && isTerminal(pendingKey)) return;

      // Keep only the latest key inside the window so a burst (turn-start + thinking + tool-start) is one change.
      pendingKey = key;
      const now = clock.now();
      if (pendingSince === null) pendingSince = now;
      const remaining = Math.min(o.mergeWindowMs, Math.max(0, o.maxDelayMs - (now - pendingSince)));
      cancel(mergeTimer);
      mergeTimer = clock.setTimeout(() => {
        mergeTimer = null;
        pendingSince = null;
        const k = pendingKey;
        pendingKey = null;
        if (k !== null) commit(k);
      }, remaining);
    },

    release() {
      if (isTerminal(current)) {
        cancel(holdTimer);
        holdTimer = null;
        endHold();
      }
    },

    get key() {
      return current;
    },

    dispose() {
      cancel(mergeTimer);
      cancel(holdTimer);
      cancel(idleTimer);
      mergeTimer = holdTimer = idleTimer = null;
      pendingKey = null;
      pendingSince = null;
    },
  };
}
