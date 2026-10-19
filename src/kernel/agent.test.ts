import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, HookRequest } from '../api/types';
import { AgentHub } from './agent';
import { Registries } from './registry';

const req = (body: object, query = ''): HookRequest => ({ connectorId: 'test', query, headers: {}, body: JSON.stringify(body), receivedAt: 0 });

function hub(session?: { waitingTimeoutMs?: number; disposeAfterMs?: number }) {
  const registries = new Registries();
  registries.connectors.add(
    {
      id: 'test',
      session,
      parse: (r) => {
        const b = JSON.parse(r.body);
        return [{ agent: 'test', sessionId: b.s, at: Date.now(), type: b.t, outcome: b.o }];
      },
    },
    'tester',
  );
  const h = new AgentHub({ registries, pets: () => [], viewFor: () => { throw new Error('no pets'); }, setting: (_k, d) => d, log: () => {} });
  const seen: AgentEvent[] = [];
  h.event.on((e) => seen.push(e));
  return { h, seen };
}

describe('AgentHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('parses through the connector and keeps a session table', () => {
    const { h, seen } = hub();
    h.ingest(req({ s: 'a', t: 'session-start' }));
    h.ingest(req({ s: 'a', t: 'turn-start' }));
    h.ingest(req({ s: 'b', t: 'turn-start' }));
    expect(seen.map((e) => e.type)).toEqual(['session-start', 'turn-start', 'turn-start']);
    expect(h.list().map((s) => [s.sessionId, s.lastEvent])).toEqual([['a', 'turn-start'], ['b', 'turn-start']]);
    h.ingest(req({ s: 'a', t: 'session-end' }));
    expect(h.list().map((s) => s.sessionId)).toEqual(['b']);
  });

  it('unknown connectors and parse errors are dropped, not thrown', () => {
    const { h, seen } = hub();
    h.ingest({ ...req({}), connectorId: 'nope' });
    h.ingest({ ...req({}), body: 'not json' });
    expect(seen).toEqual([]);
  });

  it('a stranded waiting turns into an interrupted turn-end', () => {
    const { h, seen } = hub({ waitingTimeoutMs: 1000 });
    h.ingest(req({ s: 'a', t: 'waiting' }));
    vi.advanceTimersByTime(999);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen[1]).toMatchObject({ type: 'turn-end', outcome: 'interrupted', extra: { synthetic: 'watchdog' } });
  });

  it('any newer event cancels the waiting watchdog', () => {
    const { h, seen } = hub({ waitingTimeoutMs: 1000 });
    h.ingest(req({ s: 'a', t: 'waiting' }));
    vi.advanceTimersByTime(500);
    h.ingest(req({ s: 'a', t: 'tool-start' }));
    vi.advanceTimersByTime(5000);
    expect(seen.map((e) => e.type)).toEqual(['waiting', 'tool-start']);
  });

  it('a silent session ends itself', () => {
    const { h, seen } = hub({ disposeAfterMs: 2000 });
    h.ingest(req({ s: 'a', t: 'turn-start' }));
    vi.advanceTimersByTime(1500);
    h.ingest(req({ s: 'a', t: 'thinking' }));
    vi.advanceTimersByTime(1999);
    expect(h.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toMatchObject({ type: 'session-end', extra: { synthetic: 'watchdog' } });
    expect(h.list()).toHaveLength(0);
  });
});
