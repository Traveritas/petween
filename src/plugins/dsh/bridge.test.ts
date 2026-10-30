import { beforeAll, describe, expect, it } from 'vitest';

type Compact = (session: unknown, event: unknown, pending: Map<string, string>) => Record<string, any> | null;

let compactEvent: Compact;

beforeAll(async () => {
  const mod = await import(/* @vite-ignore */ new URL('./petween-bridge.mjs', import.meta.url).href);
  compactEvent = mod.compactEvent as Compact;
});

const session = { id: 's1', header: { cwd: 'D:/work' } };
const call = (name: string, callId = 'c1', args: unknown = '{"path":"a.txt"}') => ({
  type: 'tool/call',
  time: 100,
  data: { turn: 2, step: 1, callId, name, arguments: args },
});

describe('DSH bridge compaction', () => {
  it('forwards only the fields Petween needs', () => {
    expect(compactEvent(session, { type: 'turn/start', time: 123, data: { turn: 2 } }, new Map())).toEqual({
      session_id: 's1',
      cwd: 'D:/work',
      at: 123,
      event: 'turn/start',
      data: { turn: 2 },
    });
  });

  it('pairs tool/results with the call name and detects failures', () => {
    const pending = new Map<string, string>();
    expect(compactEvent(session, call('edit'), pending)).toMatchObject({ event: 'tool/call', data: { name: 'edit', callId: 'c1' } });
    expect(pending.get('s1\u0000c1')).toBe('edit');
    const ok = compactEvent(session, { type: 'tool/result', time: 101, data: { turn: 2, step: 1, message: { callId: 'c1' } } }, pending);
    expect(ok).toMatchObject({ tool_name: 'edit', data: { callId: 'c1', isError: false } });
    expect(pending.size).toBe(0);

    const failed = compactEvent(session, { type: 'tool/result', data: { message: { callId: 'x', isError: true } } }, pending);
    expect(failed).toMatchObject({ data: { isError: true } });
  });

  it('carries approval identity and decision', () => {
    const asked = compactEvent(session, { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', callId: 'c' } }, new Map());
    expect(asked).toMatchObject({ event: 'approval/asked', data: { id: 'a1', toolName: 'pwsh' } });
    const decided = compactEvent(session, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } }, new Map());
    expect(decided).toMatchObject({ data: { id: 'a1', outcome: 'allowed-once' } });
  });

  it('reduces turn/end to its reason and drops unfinished calls', () => {
    const pending = new Map([['s1\u0000c1', 'edit']]);
    const end = compactEvent(session, { type: 'turn/end', time: 200, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } }, pending);
    expect(end).toMatchObject({ event: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } });
    expect(pending.size).toBe(0);
  });

  it('ignores subagents and event types Petween does not consume', () => {
    expect(compactEvent({ id: 'sub', header: { origin: 'subagent' } }, { type: 'turn/start', data: {} }, new Map())).toBeNull();
    expect(compactEvent(session, { type: 'assistant/message', data: { turn: 1 } }, new Map())).toBeNull();
    expect(compactEvent({ id: '' }, { type: 'turn/start', data: {} }, new Map())).toBeNull();
  });

  it('caps huge tool arguments instead of failing the request', () => {
    const huge = JSON.stringify({ old: 'x'.repeat(70_000) });
    const body = compactEvent(session, call('edit', 'c2', huge), new Map());
    expect((body?.data.arguments as string).length).toBe(64 * 1024);
  });

  it('accepts object arguments and falls back to now when the source has no time', () => {
    const body = compactEvent(session, { type: 'tool/call', data: { callId: 'c3', name: 'write', arguments: { path: 'b' } } }, new Map());
    expect(body?.data.arguments).toBe('{"path":"b"}');
    expect(typeof body?.at).toBe('number');
  });
});
