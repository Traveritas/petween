import { describe, expect, it, vi } from 'vitest';

// pack-cli pulls in the editor's file layer, which talks to Tauri; none of that runs in these tests.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(), listen: vi.fn() }));

const { parseArgs, resolvePath, runPackCli, USAGE } = await import('./pack-cli');

describe('parseArgs', () => {
  it('splits positionals and flags', () => {
    expect(parseArgs(['import', 'cat', 'a.png', 'b.gif', '--state', 'success', '--remove-bg', '--fps=10'])).toEqual({
      pos: ['import', 'cat', 'a.png', 'b.gif'],
      flags: { state: 'success', 'remove-bg': true, fps: '10' },
    });
  });

  it('boolean flags never swallow the next argument; a trailing flag is boolean', () => {
    expect(parseArgs(['set-state', 'cat', 'idle', '--remove', 'x'])).toEqual({ pos: ['set-state', 'cat', 'idle', 'x'], flags: { remove: true } });
    expect(parseArgs(['x', '--loop'])).toEqual({ pos: ['x'], flags: { loop: true } });
    expect(parseArgs(['--loop', '--enter', 'pop'])).toEqual({ pos: [], flags: { loop: true, enter: 'pop' } });
  });

  it('keeps "=" inside values', () => {
    expect(parseArgs(['--source=https://x.y/?a=b']).flags.source).toBe('https://x.y/?a=b');
  });
});

describe('resolvePath', () => {
  it('leaves absolute paths, joins relative ones', () => {
    expect(resolvePath('C:\\art\\a.png', 'D:/x')).toBe('C:/art/a.png');
    expect(resolvePath('/home/a.png', 'D:/x')).toBe('/home/a.png');
    expect(resolvePath('art\\a.png', 'D:\\work\\')).toBe('D:/work/art/a.png');
  });
});

describe('runPackCli', () => {
  const admin = vi.fn(async (method: string) => (method === 'packs.list' ? [{ id: 'default', name: '团子', builtin: true }] : [])) as never;

  it('help and unknown commands', async () => {
    expect(await runPackCli([], '', admin)).toEqual({ ok: true, usage: USAGE });
    expect(await runPackCli(['dance'], '', admin)).toMatchObject({ ok: false, error: '不认识的命令 dance' });
  });

  it('refuses to change built-in packs and rejects bad ids', async () => {
    expect(await runPackCli(['set', 'default', '--name', 'x'], '', admin)).toMatchObject({ ok: false });
    expect(String((await runPackCli(['set', 'default', '--name', 'x'], '', admin)).error)).toContain('内置');
    expect(await runPackCli(['new', 'Bad Id'], '', admin)).toMatchObject({ ok: false });
    expect(await runPackCli(['show', 'nope'], '', admin)).toMatchObject({ ok: false, error: '没有宠物包 nope' });
  });
});
