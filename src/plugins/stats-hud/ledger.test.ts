/**
 * ledger: per-session thinking accumulation, edit totals, the seq ring the HUD
 * polls, and focused-session resolution (explicit focus > last active).
 * Driven by AgentEvents; time comes from `at`.
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../api/types';
import { createStatsLedger } from './ledger';

const T0 = 1_000_000;

type Spec = Partial<Omit<AgentEvent, 'type' | 'at'>>;

const ev = (type: AgentEvent['type'], at: number, spec: Spec = {}): AgentEvent => ({
  agent: 'claude-code',
  sessionId: 's1',
  ...spec,
  at,
  type,
});
const editStart = (at: number, toolInput: unknown, spec: Spec = {}, name = 'Edit'): AgentEvent =>
  ev('tool-start', at, { ...spec, tool: { name, kind: 'edit' }, extra: { ...spec.extra, toolInput } });
const bash = (at: number, spec: Spec = {}): AgentEvent => ev('tool-start', at, { ...spec, tool: { name: 'Bash', kind: 'command' } });
// Edit input producing exactly n added lines, 0 removed.
const adds = (n: number): unknown => ({
  file_path: 'a.ts',
  old_string: '',
  new_string: Array.from({ length: n }, (_, i) => `l${i}`).join('\n'),
});

describe('thinking accumulation', () => {
  it('sums thinking intervals across a turn and exposes the live anchor', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    book.record(bash(T0 + 3000));
    book.record(ev('tool-end', T0 + 5000));
    const mid = book.snapshot();
    expect(mid.sessions.s1.thinkingMs).toBe(3000);
    expect(mid.sessions.s1.thinkingSince).toBe(T0 + 5000);
    book.record(ev('turn-end', T0 + 7500, { outcome: 'success' }));
    const done = book.snapshot();
    expect(done.sessions.s1.thinkingMs).toBe(5500);
    expect(done.sessions.s1.thinkingSince).toBeNull();
  });

  it('waiting interrupts thinking (permission pauses the clock)', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    book.record(ev('waiting', T0 + 2000));
    book.record(bash(T0 + 9000));
    expect(book.snapshot().sessions.s1.thinkingMs).toBe(2000);
  });
});

describe('state mapping', () => {
  it('maps event types to ledger states', () => {
    const book = createStatsLedger();
    const state = () => book.snapshot().sessions.s1.state;
    book.record(ev('session-start', T0));
    expect(state()).toBe('idle');
    book.record(ev('turn-start', T0 + 1));
    expect(state()).toBe('thinking');
    book.record(ev('tool-start', T0 + 2, { tool: { name: 'Read', kind: 'read' } }));
    expect(state()).toBe('working');
    book.record(ev('tool-end', T0 + 3));
    expect(state()).toBe('thinking');
    book.record(ev('waiting', T0 + 4));
    expect(state()).toBe('waiting');
    book.record(ev('turn-end', T0 + 5, { outcome: 'success' }));
    expect(state()).toBe('success');
    book.record(ev('turn-end', T0 + 6, { outcome: 'error' }));
    expect(state()).toBe('error');
    book.record(ev('turn-end', T0 + 7, { outcome: 'interrupted' }));
    expect(state()).toBe('idle');
  });

  it('session-end disposes the row without a state event', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    const before = book.snapshot().cursor;
    book.record(ev('session-end', T0 + 1));
    const snap = book.snapshot();
    expect(snap.sessions.s1).toBeUndefined();
    expect(snap.cursor).toBe(before);
  });

  it('records the agent on the session row', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0, { agent: 'codex' }));
    expect(book.snapshot().sessions.s1.agent).toBe('codex');
  });
});

describe('edit facts', () => {
  it('accumulates counts and edit count per session', () => {
    const book = createStatsLedger();
    book.record(editStart(T0, { file_path: 'a.ts', old_string: 'x\ny', new_string: 'p\nq\nr\ns\nt\nu' })); // +6 -2
    book.record(editStart(T0 + 100, { file_path: 'b.ts', content: 'l\n'.repeat(30) }, {}, 'Write')); // +30
    book.record(editStart(T0 + 200, { mystery: true }, { sessionId: 's2' }));
    const snap = book.snapshot();
    expect(snap.sessions.s1).toMatchObject({ linesAdded: 36, linesRemoved: 2, edits: 2 });
    expect(snap.sessions.s2).toMatchObject({ linesAdded: 0, linesRemoved: 0, edits: 1 });
  });

  it('ring events carry the fact fields; unknown counts stay null', () => {
    const book = createStatsLedger();
    book.record(editStart(T0, { mystery: true }, { extra: { turnId: 'turn_1' } }, 'apply_patch'));
    const edit = book.snapshot().events.find((event) => event.type === 'edit');
    expect(edit).toMatchObject({ type: 'edit', tool: 'patch', added: null, removed: null, turnId: 'turn_1' });
  });

  it('takes the file path from the tool input', () => {
    const book = createStatsLedger();
    book.record(editStart(T0, adds(1)));
    const edit = book.snapshot().events.find((event) => event.type === 'edit');
    expect(edit?.filePath).toBe('a.ts');
  });

  it('counts only tool-start with kind edit', () => {
    const book = createStatsLedger();
    book.record(ev('tool-start', T0, { tool: { name: 'Read', kind: 'read' }, extra: { toolInput: adds(5) } }));
    book.record(ev('tool-end', T0 + 1, { tool: { name: 'Edit', kind: 'edit' }, extra: { toolInput: adds(5) } }));
    expect(book.snapshot().sessions.s1.edits).toBe(0);
  });

  it('counts real tool names from Codex and Claude Code', () => {
    const book = createStatsLedger();
    book.record(editStart(T0, { input: '*** Begin Patch\n*** Add File: a\n+one\n+two\n*** End Patch' }, {}, 'apply_patch'));
    book.record(editStart(T0 + 1, { notebook_path: 'n.ipynb', new_source: 'x' }, {}, 'NotebookEdit'));
    book.record(editStart(T0 + 2, { file_path: 'a', edits: [{ old_string: 'a', new_string: 'a\nb' }] }, {}, 'MultiEdit'));
    expect(book.snapshot().sessions.s1).toMatchObject({ linesAdded: 4, linesRemoved: 0, edits: 3 });
  });
});

describe('cursor / incremental fetch', () => {
  it('returns only newer events via since; cursor is monotonic', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    const first = book.snapshot();
    book.record(editStart(T0 + 10, adds(1)));
    const second = book.snapshot(first.cursor);
    // The edit's own state event (working) plus the edit itself.
    expect(second.events.map((event) => event.type)).toEqual(['state', 'edit']);
    expect(second.cursor).toBe(first.cursor + 2);
  });
});

describe('focused session', () => {
  it('falls back to the most recently active session without explicit focus', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    book.record(bash(T0 + 500, { sessionId: 's2' }));
    expect(book.snapshot().focusedSessionId).toBe('s2');
  });

  it('explicit focus wins until cleared', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    book.record(bash(T0 + 500, { sessionId: 's2' }));
    book.setFocus('s1');
    expect(book.snapshot().focusedSessionId).toBe('s1');
    book.setFocus(null);
    expect(book.snapshot().focusedSessionId).toBe('s2');
  });
});

describe('session end', () => {
  it('drops the row and clears focus pointing at it', () => {
    const book = createStatsLedger();
    book.record(ev('thinking', T0));
    book.setFocus('s1');
    book.record(ev('session-end', T0 + 1));
    const snap = book.snapshot();
    expect(snap.sessions.s1).toBeUndefined();
    expect(snap.focusedSessionId).toBeNull();
    // Ring history survives (the HUD may still be fading its bubble).
    expect(snap.events.length).toBeGreaterThan(0);
  });
});

describe('turn tracking', () => {
  it('summarizes per-turn deltas on success and re-arms on the next prompt', () => {
    const book = createStatsLedger();
    book.record(ev('turn-start', T0, { extra: { turnId: 'turn_1' } }));
    book.record(bash(T0 + 4000));
    // +10 -2
    book.record(editStart(T0 + 5000, { file_path: 'a', old_string: 'a\nb', new_string: Array.from({ length: 10 }, (_, i) => `n${i}`).join('\n') }));
    book.record(ev('tool-end', T0 + 6000));
    book.record(editStart(T0 + 6500, adds(5)));
    book.record(ev('turn-end', T0 + 10_000, { outcome: 'success', extra: { turnId: 'turn_1' } }));
    const summary = book.snapshot().events.find((event) => event.type === 'turn-summary');
    // Thinking: 0-4000, then 6000-6500 (the next edit moves to working).
    expect(summary).toMatchObject({
      sessionId: 's1',
      turnId: 'turn_1',
      summary: { thinkingMs: 4500, linesAdded: 15, linesRemoved: 2, edits: 2, durationMs: 10_000 },
    });
    // Second turn: baselines reset.
    book.record(ev('turn-start', T0 + 20_000, { extra: { turnId: 'turn_2' } }));
    book.record(editStart(T0 + 21_000, { file_path: 'b', content: '1\n2\n3\n4\n5\n6\n7' }, {}, 'Write'));
    book.record(ev('turn-end', T0 + 22_000, { outcome: 'success', extra: { turnId: 'turn_2' } }));
    const summaries = book.snapshot().events.filter((event) => event.type === 'turn-summary');
    expect(summaries).toHaveLength(2);
    expect(summaries[1].summary).toEqual({ thinkingMs: 1000, linesAdded: 7, linesRemoved: 0, edits: 1, durationMs: 2000 });
  });

  it('an interrupted turn-end abandons an open turn (no summary later)', () => {
    const book = createStatsLedger();
    book.record(ev('turn-start', T0));
    book.record(editStart(T0 + 100, adds(3)));
    book.record(ev('turn-end', T0 + 500, { outcome: 'interrupted' }));
    book.record(ev('turn-end', T0 + 600, { outcome: 'success' }));
    expect(book.snapshot().events.some((event) => event.type === 'turn-summary')).toBe(false);
  });

  it('a session-start idle abandons an open turn', () => {
    const book = createStatsLedger();
    book.record(ev('turn-start', T0));
    book.record(ev('session-start', T0 + 500));
    book.record(ev('turn-end', T0 + 600, { outcome: 'success' }));
    expect(book.snapshot().events.some((event) => event.type === 'turn-summary')).toBe(false);
  });

  it('success without an open turn emits no summary', () => {
    const book = createStatsLedger();
    book.record(ev('turn-end', T0, { outcome: 'success' }));
    expect(book.snapshot().events.some((event) => event.type === 'turn-summary')).toBe(false);
  });

  it('the summary falls back to the turn-start turnId', () => {
    const book = createStatsLedger();
    book.record(ev('turn-start', T0, { extra: { turnId: 'turn_9' } }));
    book.record(ev('turn-end', T0 + 1, { outcome: 'success' }));
    expect(book.snapshot().events.find((event) => event.type === 'turn-summary')?.turnId).toBe('turn_9');
  });
});
