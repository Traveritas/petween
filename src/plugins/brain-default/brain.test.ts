// Behavioural contract ported from v0 pet-state-resolver.test.ts, adapted to AgentEvent in / state key out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../api/types';
import { createBrain, type BrainClock, type BrainCore, type BrainOptions } from './brain';

const WINDOW = 60;

const clock: BrainClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

let keys: string[];
let brain: BrainCore;
let n: number;

type Ev = Omit<AgentEvent, 'agent' | 'sessionId' | 'at'> & { agent?: string; sessionId?: string };
const ev = (e: Ev): AgentEvent => ({ agent: 'claude-code', sessionId: 's1', at: n++, ...e });

const make = (o: Partial<BrainOptions> = {}) => {
  brain?.dispose();
  brain = createBrain((k) => keys.push(k), clock, o);
};

/** Feed an event and flush the merge window. */
const send = async (e: Ev) => {
  brain.onEvent(ev(e));
  await vi.advanceTimersByTimeAsync(WINDOW);
};
const feed = (e: Ev) => brain.onEvent(ev(e));
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const turnStart: Ev = { type: 'turn-start' };
const end = (outcome: 'success' | 'error' | 'interrupted'): Ev => ({ type: 'turn-end', outcome });
const tool = (name: string, kind: 'edit' | 'command' | 'read' | 'search' | 'web' | 'other'): Ev => ({
  type: 'tool-start',
  tool: { name, kind },
});

beforeEach(() => {
  vi.useFakeTimers();
  keys = [];
  n = 0;
  make();
});

afterEach(() => {
  brain.dispose();
  vi.useRealTimers();
});

describe('state transitions', () => {
  it('idle -> active.thinking on turn-start', async () => {
    await send(turnStart);
    expect(keys).toEqual(['active.thinking']);
  });

  it('dedupes identical states', async () => {
    await send(turnStart);
    await send(turnStart);
    await send({ type: 'thinking' });
    expect(keys).toEqual(['active.thinking']);
  });

  it('waiting takes over from active and back', async () => {
    await send(turnStart);
    await send({ type: 'waiting' });
    await send(tool('Bash', 'command'));
    expect(keys).toEqual(['active.thinking', 'waiting', 'active.command.Bash']);
  });

  it('activity change inside active emits a new key; repeats dedupe', async () => {
    await send(turnStart);
    await send(tool('Bash', 'command'));
    await send(tool('Bash', 'command'));
    expect(keys).toEqual(['active.thinking', 'active.command.Bash']);
  });
});

describe('key derivation (docs/05 §4.2)', () => {
  const cases: [string, Ev, string][] = [
    ['turn-start', turnStart, 'active.thinking'],
    ['thinking', { type: 'thinking' }, 'active.thinking'],
    ['edit tool', tool('apply_patch', 'edit'), 'active.edit'],
    ['command tool keeps the real name', tool('exec_command', 'command'), 'active.command.exec_command'],
    ['read tool', tool('Read', 'read'), 'active.other'],
    ['search tool', tool('Grep', 'search'), 'active.other'],
    ['web tool', tool('WebFetch', 'web'), 'active.other'],
    ['other tool', tool('Foo', 'other'), 'active.other'],
    ['waiting', { type: 'waiting' }, 'waiting'],
    ['turn-end success', end('success'), 'success'],
    ['turn-end error', end('error'), 'error'],
  ];
  for (const [name, e, key] of cases) {
    it(`${name} -> ${key}`, async () => {
      await send(e);
      expect(keys).toEqual([key]);
    });
  }

  it('turn-end interrupted -> idle', async () => {
    await send(turnStart);
    await send(end('interrupted'));
    expect(keys).toEqual(['active.thinking', 'idle']);
  });

  it('tool-end goes back to thinking, including after a permission wait', async () => {
    await send(tool('Bash', 'command'));
    await send({ type: 'tool-end', tool: { name: 'Bash', kind: 'command', ok: true } });
    await send({ type: 'waiting' });
    await send({ type: 'tool-end', tool: { name: 'Bash', kind: 'command', ok: true } });
    expect(keys).toEqual(['active.command.Bash', 'active.thinking', 'waiting', 'active.thinking']);
  });

  it('a late tool-end after the turn ended does not wake the pet', async () => {
    await send({ type: 'tool-end', tool: { name: 'Bash', kind: 'command' } });
    expect(keys).toEqual([]);
  });

  it('session-start alone stays idle', async () => {
    await send({ type: 'session-start' });
    expect(keys).toEqual([]);
  });
});

describe('transient success/error', () => {
  it('success holds successHoldMs then returns to idle', async () => {
    await send(turnStart);
    await send(end('success'));
    expect(keys).toEqual(['active.thinking', 'success']);
    await tick(1599);
    expect(keys).toHaveLength(2);
    await tick(1);
    expect(keys).toEqual(['active.thinking', 'success', 'idle']);
  });

  it('error holds errorHoldMs then returns to idle', async () => {
    await send(turnStart);
    await send(end('error'));
    await tick(1799);
    expect(keys).toHaveLength(2);
    await tick(1);
    expect(keys).toEqual(['active.thinking', 'error', 'idle']);
  });

  it('hold durations are configurable', async () => {
    make({ successHoldMs: 500 });
    await send(end('success'));
    await tick(500);
    expect(keys).toEqual(['success', 'idle']);
  });

  it('a new activity interrupts the terminal state and cancels the pending idle', async () => {
    await send(turnStart);
    await send(end('success'));
    await tick(800);
    await send(turnStart);
    expect(keys).toEqual(['active.thinking', 'success', 'active.thinking']);
    await tick(5000);
    expect(keys).toHaveLength(3);
  });

  it('an interrupted success does not resurface when the new turn is interrupted', async () => {
    await send(turnStart);
    await send(end('success'));
    await send(turnStart);
    await send(end('interrupted'));
    expect(keys).toEqual(['active.thinking', 'success', 'active.thinking', 'idle']);
  });
});

describe('merging (trailing window + cap)', () => {
  it('collapses a burst inside the window into one change', async () => {
    feed(turnStart);
    feed(tool('Edit', 'edit'));
    await tick(WINDOW);
    expect(keys).toEqual(['active.edit']);
  });

  it('events outside the window are processed separately', async () => {
    await send(turnStart);
    await tick(200);
    await send({ type: 'waiting' });
    expect(keys).toEqual(['active.thinking', 'waiting']);
  });

  it('a sustained stream cannot starve the commit: forced at the 200ms cap', async () => {
    feed(turnStart);
    for (let i = 0; i < 3; i += 1) {
      await tick(50);
      feed({ type: 'thinking' });
    }
    await tick(49);
    expect(keys).toHaveLength(0);
    await tick(1);
    expect(keys).toEqual(['active.thinking']);
  });

  it('the cap commits repeatedly under a nonstop stream', async () => {
    feed(turnStart);
    for (let i = 1; i <= 12; i += 1) {
      await tick(40);
      feed(i % 2 === 1 ? { type: 'waiting' } : turnStart);
    }
    await tick(200);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys.every((k) => k === 'active.thinking' || k === 'waiting')).toBe(true);
  });

  it('mergeWindowMs / maxDelayMs are configurable', async () => {
    make({ mergeWindowMs: 10, maxDelayMs: 30 });
    feed(turnStart);
    await tick(10);
    expect(keys).toEqual(['active.thinking']);
  });
});

describe('stray-idle suppression', () => {
  it('an idle racing the turn-end inside the window is dropped', async () => {
    await send(turnStart);
    feed(end('success'));
    feed({ type: 'session-end' }); // merged state would be idle; must not win the window
    await tick(WINDOW);
    expect(keys).toEqual(['active.thinking', 'success']);
    await tick(1599);
    expect(keys).toHaveLength(2);
    await tick(1);
    expect(keys).toEqual(['active.thinking', 'success', 'idle']);
  });

  it('idles during the hold are dropped; the hold still runs to completion', async () => {
    await send(turnStart);
    await send(end('success'));
    await send({ type: 'session-end' });
    expect(keys).toHaveLength(2);
    await tick(800);
    await send({ type: 'session-start', sessionId: 's2' });
    expect(keys).toHaveLength(2);
    await tick(800);
    expect(keys).toEqual(['active.thinking', 'success', 'idle']);
  });

  it('an idle while an error holds is dropped too', async () => {
    await send(end('error'));
    await send({ type: 'session-end' });
    expect(keys).toEqual(['error']);
    await tick(1800);
    expect(keys).toEqual(['error', 'idle']);
  });

  it('an idle goes through normally when nothing terminal is pending or held', async () => {
    await send(turnStart);
    await send(end('interrupted'));
    expect(keys).toEqual(['active.thinking', 'idle']);
  });
});

describe('holdUntilClick / release()', () => {
  it('release ends a held success immediately and cancels the hold timer', async () => {
    await send(turnStart);
    await send(end('success'));
    brain.release();
    expect(keys).toEqual(['active.thinking', 'success', 'idle']);
    await tick(5000);
    expect(keys).toHaveLength(3);
  });

  it('release ends a held error', async () => {
    await send(end('error'));
    brain.release();
    expect(keys).toEqual(['error', 'idle']);
  });

  it('release is a no-op outside success/error', async () => {
    brain.release();
    await send(turnStart);
    brain.release();
    await send({ type: 'waiting' });
    brain.release();
    expect(keys).toEqual(['active.thinking', 'waiting']);
  });

  it('holdUntilClick: no timer; release ends it', async () => {
    make({ holdUntilClick: true });
    await send(turnStart);
    await send(end('success'));
    await tick(60_000);
    expect(keys).toEqual(['active.thinking', 'success']);
    brain.release();
    expect(keys).toEqual(['active.thinking', 'success', 'idle']);
  });

  it('holdUntilClick: a new turn releases the face and leaves no stale timer', async () => {
    make({ holdUntilClick: true });
    await send(end('error'));
    await tick(10_000);
    await send(turnStart);
    expect(keys).toEqual(['error', 'active.thinking']);
    await tick(10_000);
    expect(keys).toHaveLength(2);
  });

  it('holdUntilClick: stray idle is still dropped while the terminal holds', async () => {
    make({ holdUntilClick: true });
    feed(end('success'));
    feed({ type: 'session-end' });
    await tick(WINDOW);
    await send({ type: 'session-start', sessionId: 's2' });
    await tick(60_000);
    expect(keys).toEqual(['success']);
  });
});

describe('idle.long', () => {
  it('goes idle.long after idleLongMs of idle', async () => {
    await tick(299_999);
    expect(keys).toEqual([]);
    await tick(1);
    expect(keys).toEqual(['idle.long']);
  });

  it('counts from when idle was entered', async () => {
    make({ idleLongMs: 5000 });
    await send(turnStart);
    await send(end('success'));
    await tick(1600); // hold ends -> idle
    await tick(4999);
    expect(keys).toEqual(['active.thinking', 'success', 'idle']);
    await tick(1);
    expect(keys).toEqual(['active.thinking', 'success', 'idle', 'idle.long']);
  });

  it('activity leaves idle.long and the idle timer is cancelled', async () => {
    make({ idleLongMs: 1000 });
    await tick(1000);
    await send(turnStart);
    expect(keys).toEqual(['idle.long', 'active.thinking']);
    await tick(5000);
    expect(keys).toHaveLength(2);
  });

  it('a plain idle (e.g. session-start) does not wake idle.long', async () => {
    make({ idleLongMs: 1000 });
    await tick(1000);
    await send({ type: 'session-start' });
    expect(keys).toEqual(['idle.long']);
  });
});

describe('multi-session merge (docs/05 §4.3)', () => {
  const a = (e: Ev): Ev => ({ ...e, sessionId: 'a' });
  const b = (e: Ev): Ev => ({ ...e, sessionId: 'b' });

  it('waiting > error > active > success > idle', async () => {
    make({ successHoldMs: 100_000, errorHoldMs: 100_000 });
    await send(a(end('success')));
    expect(keys.at(-1)).toBe('success');
    await send(b(tool('Edit', 'edit')));
    expect(keys.at(-1)).toBe('active.edit'); // active beats success
    await send(a(end('error')));
    expect(keys.at(-1)).toBe('error'); // error beats active
    await send(b({ type: 'waiting' }));
    expect(keys.at(-1)).toBe('waiting'); // waiting beats error
  });

  it('same rank: most recent event wins', async () => {
    await send(a(tool('Edit', 'edit')));
    await send(b(tool('Bash', 'command')));
    expect(keys).toEqual(['active.edit', 'active.command.Bash']);
    await send(a({ type: 'thinking' }));
    expect(keys.at(-1)).toBe('active.thinking');
  });

  it('sessions of different agents are distinct', async () => {
    await send({ type: 'turn-start', agent: 'codex', sessionId: 'x' });
    await send({ type: 'turn-start', agent: 'claude-code', sessionId: 'x' });
    await send({ type: 'turn-end', outcome: 'interrupted', agent: 'codex', sessionId: 'x' });
    expect(keys).toEqual(['active.thinking']); // claude-code:x is still active
  });

  it('a lower-ranked finish does not disturb the leader', async () => {
    await send(a(turnStart));
    await send(b(turnStart));
    await send(b(end('interrupted')));
    expect(keys).toEqual(['active.thinking']);
  });

  it('after a hold the remaining active session shows through', async () => {
    await send(a(turnStart));
    await send(b(turnStart));
    await send(a(end('error')));
    expect(keys).toEqual(['active.thinking', 'error']);
    await tick(1800);
    expect(keys).toEqual(['active.thinking', 'error', 'active.thinking']);
  });
});

describe('session-end', () => {
  it('drops the session so the other one shows', async () => {
    await send({ type: 'waiting', sessionId: 'a' });
    await send({ type: 'turn-start', sessionId: 'b' });
    expect(keys).toEqual(['waiting']);
    await send({ type: 'session-end', sessionId: 'a' });
    expect(keys).toEqual(['waiting', 'active.thinking']);
  });

  it('dropping the last active session returns to idle', async () => {
    await send(turnStart);
    await send({ type: 'session-end' });
    expect(keys).toEqual(['active.thinking', 'idle']);
  });

  it('a session-end for an unknown session is harmless', async () => {
    await send({ type: 'session-end', sessionId: 'nope' });
    expect(keys).toEqual([]);
  });
});

describe('followFocus', () => {
  const a = (e: Ev): Ev => ({ ...e, sessionId: 'a' });
  const b = (e: Ev): Ev => ({ ...e, sessionId: 'b' });

  it('off: attention ranking wins over recency of focus', async () => {
    await send(a({ type: 'waiting' }));
    await send(b(turnStart));
    expect(keys).toEqual(['waiting']);
  });

  it('on: only the session that most recently had a focus event drives the pet', async () => {
    make({ followFocus: true });
    await send(a(turnStart));
    await send(b(turnStart)); // b is now the focus
    await send(a({ type: 'waiting' })); // a is not focused: ignored
    expect(keys).toEqual(['active.thinking']);
    await send(b(tool('Edit', 'edit')));
    expect(keys).toEqual(['active.thinking', 'active.edit']);
  });

  it('on: focus moves back on turn-start and the session shows its own state', async () => {
    make({ followFocus: true });
    await send(a(turnStart));
    await send(b(turnStart));
    await send(a({ type: 'waiting' }));
    await send(a(turnStart)); // a regains focus
    expect(keys.at(-1)).toBe('active.thinking');
    await send(a(tool('Bash', 'command')));
    expect(keys.at(-1)).toBe('active.command.Bash');
  });

  it('on: session-start gives focus', async () => {
    make({ followFocus: true });
    await send(a(turnStart));
    await send(b({ type: 'session-start' }));
    expect(keys).toEqual(['active.thinking', 'idle']);
  });

  it('on: when the focused session ends, the previous focus takes over', async () => {
    make({ followFocus: true });
    await send(a(turnStart));
    await send(b({ type: 'session-start' }));
    await send(b({ type: 'session-end' }));
    expect(keys.at(-1)).toBe('active.thinking');
  });

  it('on: with no focus event seen (attached mid-session) falls back to all sessions', async () => {
    make({ followFocus: true });
    await send(a(tool('Edit', 'edit')));
    expect(keys).toEqual(['active.edit']);
  });
});

describe('watchdog events', () => {
  it('synthetic turn-end interrupted returns a stuck waiting session to idle', async () => {
    await send({ type: 'waiting' });
    await send({ type: 'turn-end', outcome: 'interrupted', extra: { synthetic: 'watchdog' } });
    expect(keys).toEqual(['waiting', 'idle']);
  });

  it('synthetic session-end drops the session like a real one', async () => {
    await send(turnStart);
    await send({ type: 'session-end', extra: { synthetic: 'watchdog' } });
    expect(keys).toEqual(['active.thinking', 'idle']);
  });
});

describe('dispose', () => {
  it('cancels all timers', async () => {
    await send(turnStart);
    await send(end('success'));
    feed(turnStart);
    brain.dispose();
    await tick(600_000);
    expect(keys).toEqual(['active.thinking', 'success']);
  });
});
