import { describe, expect, it } from 'vitest';
import type { ConnectorDef, HookRequest, HostApi, PluginContext, TrayItemOptions } from '../../api/types';
import claudeCode from '../claude-code';
import codex from '../codex';
import zcode from '../zcode';
import { isOurEntry, parseHook, toolKind } from './hook-connector';

const req = (query: string, body: object | string): HookRequest => ({
  connectorId: 'claude-code',
  query,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
  receivedAt: 1000,
});

describe('parseHook (docs/05 §2)', () => {
  it('keeps the real tool name and classifies it', () => {
    const [e] = parseHook('claude-code', req('e=pre-tool', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, prompt_id: 'p1', cwd: 'D:/x', hook_event_name: 'PreToolUse' }));
    expect(e).toMatchObject({ agent: 'claude-code', sessionId: 's1', type: 'tool-start', tool: { name: 'Bash', kind: 'command' }, at: 1000 });
    expect(e.extra).toEqual({ turnId: 'p1', cwd: 'D:/x', hookEvent: 'PreToolUse', toolInput: { command: 'ls' } });
  });

  it('maps every kind', () => {
    const t = (q: string) => parseHook('x', req(`e=${q}`, { session_id: 's', tool_name: 'Edit' }))[0];
    expect(t('session-start').type).toBe('session-start');
    expect(t('prompt').type).toBe('turn-start');
    expect(t('post-tool')).toMatchObject({ type: 'tool-end', tool: { ok: true, kind: 'edit' } });
    expect(t('post-tool-failure')).toMatchObject({ type: 'tool-end', tool: { ok: false } });
    expect(t('permission').type).toBe('waiting');
    expect(t('stop')).toMatchObject({ type: 'turn-end', outcome: 'success' });
    expect(t('interrupt')).toMatchObject({ type: 'turn-end', outcome: 'interrupted' });
    expect(t('session-end').type).toBe('session-end');
  });

  it('uses the source timestamp when present (zcode)', () => {
    const [e] = parseHook('zcode', req('e=prompt', { session_id: 's', timestamp: '2026-10-19T00:00:00Z' }));
    expect(e.at).toBe(Date.parse('2026-10-19T00:00:00Z'));
  });

  it('drops junk', () => {
    expect(parseHook('x', req('e=prompt', 'not json'))).toEqual([]);
    expect(parseHook('x', req('e=prompt', { nope: 1 }))).toEqual([]);
    expect(parseHook('x', req('', { session_id: 's' }))).toEqual([]);
    expect(parseHook('x', req('e=bogus', { session_id: 's' }))).toEqual([]);
  });

  it('classifies tool names across agents', () => {
    expect(['apply_patch', 'MultiEdit', 'ApplyPatch'].map(toolKind)).toEqual(['edit', 'edit', 'edit']);
    expect(['shell', 'exec_command', 'PowerShell'].map(toolKind)).toEqual(['command', 'command', 'command']);
    expect(['Grep', 'WebFetch', 'Task'].map(toolKind)).toEqual(['search', 'web', 'other']);
  });
});

describe('ownership', () => {
  it('matches petween --hook <id> in both entry shapes, any install path', () => {
    expect(isOurEntry({ command: 'C:/Apps/Petween/petween.exe', args: ['--hook', 'claude-code', 'e=stop'] }, 'claude-code')).toBe(true);
    expect(isOurEntry({ command: '"D:\\My Projects\\petween.exe" --hook codex e=stop' }, 'codex')).toBe(true);
    expect(isOurEntry({ command: 'C:/Apps/Petween/petween.exe', args: ['--hook', 'codex'] }, 'claude-code')).toBe(false);
    expect(isOurEntry({ command: 'curl.exe', args: ['--hook', 'claude-code'] }, 'claude-code')).toBe(false);
    expect(isOurEntry({ command: 'echo petween.exe --hook claude-code' }, 'claude-code')).toBe(false);
  });
});

// ---------- install / uninstall against an in-memory filesystem ----------

function fakeCtx(files: Record<string, string>, settings: Record<string, unknown> = {}) {
  let connector: ConnectorDef | null = null;
  const tray: TrayItemOptions[] = [];
  const host = {
    paths: { home: 'H:', appData: 'A:' },
    fs: {
      readText: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      writeText: async (p: string, c: string) => void (files[p] = c),
      exists: async (p: string) => p in files,
      remove: async (p: string) => void delete files[p],
      list: async () => [],
      mkdir: async () => {},
    },
    hookCommand: async (id: string, q?: string) => ({ command: 'C:/Petween/petween.exe', args: ['--hook', id, ...(q ? [q] : [])] }),
  } as unknown as HostApi;
  const ctx = {
    host,
    settings: { get: (k: string, d: unknown) => (k in settings ? settings[k] : d) },
    log: { info() {}, warn() {}, error() {} },
    register: { connector: (d: ConnectorDef) => void (connector = d) },
    tray: { addItem: (i: TrayItemOptions) => (tray.push(i), { update() {}, dispose() {} }) },
  } as unknown as PluginContext;
  return { ctx, files, connector: () => connector!, tray };
}

describe('claude-code install', () => {
  const foreign = { hooks: [{ type: 'command', command: 'D:/Pebrel/runtime/pebrel-hook.exe' }] };

  it('merges into settings.json, keeps foreign hooks and keys, and uninstalls cleanly', async () => {
    const original = { env: { TOKEN: 'secret' }, hooks: { Stop: [foreign], Custom: [foreign] } };
    const f = fakeCtx({ 'H:/.claude/settings.json': JSON.stringify(original) });
    await claudeCode.activate(f.ctx);
    const c = f.connector();
    expect(await c.status!()).toEqual({ installed: false, detail: undefined });

    await c.install!();
    const after = JSON.parse(f.files['H:/.claude/settings.json']);
    expect(after.env).toEqual({ TOKEN: 'secret' });
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.Stop[0]).toEqual(foreign);
    expect(after.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'C:/Petween/petween.exe', args: ['--hook', 'claude-code', 'e=pre-tool'], timeout: 5 });
    expect(f.files['H:/.claude/settings.json.petween-bak']).toBe(JSON.stringify(original));
    expect((await c.status!()).installed).toBe(true);

    await c.install!(); // idempotent
    expect(JSON.parse(f.files['H:/.claude/settings.json']).hooks.Stop).toHaveLength(2);

    await c.uninstall!();
    expect(JSON.parse(f.files['H:/.claude/settings.json'])).toEqual(original);
    expect('H:/.claude/settings.json.petween-bak' in f.files).toBe(false);
  });

  it('installs into every configured dir and creates missing files', async () => {
    const f = fakeCtx({}, { configDirs: ['~/.claude', 'P:/profile/'] });
    await claudeCode.activate(f.ctx);
    await f.connector().install!();
    expect(Object.keys(f.files).sort()).toEqual(['H:/.claude/settings.json', 'P:/profile/settings.json']);
    await f.connector().uninstall!();
    expect(JSON.parse(f.files['P:/profile/settings.json'])).toEqual({});
  });

  it('refuses to rewrite corrupt or malformed configs', async () => {
    const f = fakeCtx({ 'H:/.claude/settings.json': '{ broken' });
    await claudeCode.activate(f.ctx);
    await expect(f.connector().install!()).rejects.toThrow(/JSON/);
    f.files['H:/.claude/settings.json'] = JSON.stringify({ hooks: { Stop: 'nope' } });
    await expect(f.connector().install!()).rejects.toThrow(/不是数组/);
  });

  it('refreshes stale hooks (old exe path) on activate', async () => {
    const stale = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'E:/old/petween.exe', args: ['--hook', 'claude-code', 'e=stop'], timeout: 5 }] }] } };
    const f = fakeCtx({ 'H:/.claude/settings.json': JSON.stringify(stale) });
    await claudeCode.activate(f.ctx);
    const hooks = JSON.parse(f.files['H:/.claude/settings.json']).hooks;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0].hooks[0].command).toBe('C:/Petween/petween.exe');
    expect(Object.keys(hooks)).toContain('SessionEnd');
  });
});

describe('codex / zcode entry shapes', () => {
  it('codex: one command string with only the exe quoted', async () => {
    const f = fakeCtx({});
    await codex.activate(f.ctx);
    await f.connector().install!();
    const hooks = JSON.parse(f.files['H:/.codex/hooks.json']).hooks;
    expect(hooks.Interrupt[0].hooks[0]).toEqual({ type: 'command', command: '"C:/Petween/petween.exe" --hook codex e=interrupt', timeout: 3 });
    expect((await f.connector().status!()).installed).toBe(true);
  });

  it('zcode: process entries under hooks.events; enabled only when nothing was there', async () => {
    const f = fakeCtx({ 'H:/.zcode/cli/config.json': JSON.stringify({ mcp: { a: 1 } }) });
    await zcode.activate(f.ctx);
    await f.connector().install!();
    const cfg = JSON.parse(f.files['H:/.zcode/cli/config.json']);
    expect(cfg.mcp).toEqual({ a: 1 });
    expect(cfg.hooks.enabled).toBe(true);
    expect(cfg.hooks.events.Stop[0].hooks[0]).toEqual({ type: 'process', command: 'C:/Petween/petween.exe', args: ['--hook', 'zcode', 'e=stop'], timeoutMs: 2500 });
    await f.connector().uninstall!();
    expect(JSON.parse(f.files['H:/.zcode/cli/config.json']).hooks).toEqual({ enabled: false, events: {} });

    const g = fakeCtx({ 'H:/.zcode/cli/config.json': JSON.stringify({ hooks: { enabled: false, events: { Stop: [{ hooks: [{ command: 'mine' }] }] } } }) });
    await zcode.activate(g.ctx);
    await g.connector().install!();
    expect(JSON.parse(g.files['H:/.zcode/cli/config.json']).hooks.enabled).toBe(false);
  });
});
