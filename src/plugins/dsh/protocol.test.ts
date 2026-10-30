import { describe, expect, it } from 'vitest';
import type { HookRequest } from '../../api/types';
import { BRIDGE_FILENAME, BRIDGE_ROW_ID, bridgeBlock, installPatch, parseDshHook, patchHasBlock, uninstallPatch } from './protocol';

const req = (body: object | string): HookRequest => ({
  connectorId: 'dsh',
  query: '',
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
  receivedAt: 1000,
});

const event = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  cwd: 'D:/work',
  at: 1234,
  event: type,
  data,
  ...extra,
});

const types = (body: object | string, seen = new Set<string>()) => parseDshHook(req(body), seen).map((e) => e.type);

describe('parseDshHook (docs/05 §2)', () => {
  it('synthesizes session-start once, then maps the DSH event', () => {
    const seen = new Set<string>();
    const [start, turn] = parseDshHook(req(event('turn/start', { turn: 2 })), seen);
    expect(start).toMatchObject({ agent: 'dsh', sessionId: 's1', type: 'session-start', at: 1234 });
    expect(turn).toMatchObject({
      agent: 'dsh',
      sessionId: 's1',
      type: 'turn-start',
      at: 1234,
      extra: { hookEvent: 'turn/start', cwd: 'D:/work', turnId: '2' },
    });
    expect(types(event('turn/start', { turn: 3 }), seen)).toEqual(['turn-start']);
  });

  it('keeps the real DSH tool name and classifies it', () => {
    const seen = new Set<string>();
    const tool = (name: string) => parseDshHook(req(event('tool/call', { turn: 1, step: 1, callId: 'c', name })), seen).at(-1);
    expect(tool('edit')).toMatchObject({ type: 'tool-start', tool: { name: 'edit', kind: 'edit' } });
    expect(tool('write')).toMatchObject({ tool: { name: 'write', kind: 'edit' } });
    expect(tool('str_replace_editor')).toMatchObject({ tool: { kind: 'edit' } });
    expect(tool('pwsh')).toMatchObject({ tool: { name: 'pwsh', kind: 'command' } });
    expect(tool('read')).toMatchObject({ tool: { kind: 'read' } });
    expect(tool('glob')).toMatchObject({ tool: { kind: 'search' } });
    expect(tool('web_fetch')).toMatchObject({ tool: { kind: 'web' } });
    expect(tool('present')).toMatchObject({ tool: { kind: 'other' } });
  });

  it('carries parsed tool arguments for stats-hud', () => {
    const [turn] = parseDshHook(req(event('tool/call', { turn: 1, step: 1, callId: 'c', name: 'edit', arguments: '{"path":"a.txt","old":"x"}' })), new Set());
    expect(turn.extra?.toolInput).toEqual({ path: 'a.txt', old: 'x' });
  });

  it('treats DSH question tools and approvals as waiting', () => {
    const seen = new Set<string>();
    expect(types(event('tool/call', { turn: 1, step: 1, callId: 'q', name: 'ask_user_question' }), seen)).toEqual(['session-start', 'waiting']);
    expect(types(event('tool/result', { callId: 'q', message: { callId: 'q', isError: false } }, { tool_name: 'ask_user_question' }), seen)).toEqual(['tool-end']);
    expect(types(event('approval/asked', { id: 'a1', toolName: 'pwsh' }), seen)).toEqual(['waiting']);
    expect(types(event('approval/decided', { id: 'a1', outcome: 'allowed-once' }), seen)).toEqual(['thinking']);
  });

  it('maps turn-end reasons to outcomes', () => {
    const outcome = (kind: string) => parseDshHook(req(event('turn/end', { turn: 1, reason: { kind } })), new Set(['s1'])).at(-1)?.outcome;
    expect(outcome('completed')).toBe('success');
    expect(outcome('error')).toBe('error');
    expect(outcome('aborted')).toBe('interrupted');
    expect(outcome('interrupted')).toBe('interrupted');
    expect(outcome('blocked')).toBe('interrupted');
    expect(outcome('max-tokens')).toBe('success');
    expect(outcome('unknown-future-reason')).toBe('success');
  });

  it('ends the session and forgets it', () => {
    const seen = new Set(['s1']);
    expect(parseDshHook(req(event('session/disposed')), seen)).toEqual([
      expect.objectContaining({ type: 'session-end', sessionId: 's1' }),
    ]);
    expect(seen.has('s1')).toBe(false);
    expect(types(event('turn/start', { turn: 1 }), seen)).toEqual(['session-start', 'turn-start']);
  });

  it('drops subagents, unknown events and junk', () => {
    expect(types({ ...event('turn/start'), subagent: true })).toEqual([]);
    expect(types(event('assistant/message', { turn: 1 }))).toEqual([]);
    expect(types(event('session/title', { title: 'x' }))).toEqual([]);
    expect(types('not json')).toEqual([]);
    expect(types({ event: 'turn/start' })).toEqual([]);
    expect(types({ ...event('turn/start'), session_id: 's'.repeat(201) })).toEqual([]);
    expect(parseDshHook(req(event('turn/start')), new Set())).toHaveLength(2);
  });

  it('does not mark a session seen for an ignored event', () => {
    const seen = new Set<string>();
    expect(parseDshHook(req(event('assistant/message', { turn: 1 })), seen)).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

describe('$DSH_HOME patch ownership', () => {
  const foreign = "- id: someone-else\n  name: './someone-else.mjs'\n";

  it('writes our insert row with a patch-relative module name', () => {
    const block = bridgeBlock();
    expect(block).toContain(`- id: ${BRIDGE_ROW_ID}`);
    expect(block).toContain(`name: './${BRIDGE_FILENAME}'`);
    expect(patchHasBlock(block)).toBe(true);
  });

  it('creates the file, replaces [] and appends to foreign rows', () => {
    expect(installPatch(null)).toBe(bridgeBlock());
    expect(installPatch('')).toBe(bridgeBlock());
    expect(installPatch('# comment only\n')).toBe(bridgeBlock());
    expect(installPatch('[]\n')).toBe(bridgeBlock());
    const both = installPatch(foreign);
    expect(both.startsWith(foreign.trim())).toBe(true);
    expect(both).toContain(BRIDGE_ROW_ID);
  });

  it('is idempotent and refreshes a stale block in place', () => {
    const once = installPatch(foreign);
    expect(installPatch(once)).toBe(once);
    const stale = once.replace(`./${BRIDGE_FILENAME}`, './old-bridge.mjs');
    expect(installPatch(stale)).toBe(once);
  });

  it('refuses shapes it cannot edit safely', () => {
    expect(() => installPatch('[ { id: x } ]\n')).toThrow(/内联列表/);
    expect(() => installPatch('some: mapping\n')).toThrow(/不是条目列表/);
    expect(() => installPatch(`${bridgeBlock().replace('# <<< petween <<<\n', '')}`)).toThrow(/不完整/);
  });

  it('uninstalls only our block, leaving foreign rows alone', () => {
    expect(uninstallPatch(null)).toEqual({ text: '', removed: false });
    expect(uninstallPatch(foreign)).toEqual({ text: foreign, removed: false });
    expect(uninstallPatch(installPatch('[]\n'))).toEqual({ text: '[]\n', removed: true });
    const both = installPatch(foreign);
    const removed = uninstallPatch(both);
    expect(removed.removed).toBe(true);
    expect(removed.text).toBe(`${foreign.trim()}\n`);
    expect(patchHasBlock(removed.text)).toBe(false);
  });
});
