import { describe, expect, it } from 'vitest';
import type { ConnectorDef, HostApi, PluginContext } from '../../api/types';
import dsh from './index';
import { BRIDGE_FILENAME, PATCH_FILENAME, patchHasBlock } from './protocol';

const HOME = 'H:/.dsh';
const BRIDGE = `${HOME}/${BRIDGE_FILENAME}`;
const PATCH = `${HOME}/${PATCH_FILENAME}`;

function fakeCtx(files: Record<string, string>, settings: Record<string, unknown> = {}) {
  let connector: ConnectorDef | null = null;
  const host = {
    paths: { home: 'H:', appData: 'A:' },
    fs: {
      readText: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      writeText: async (p: string, c: string) => void (files[p] = c),
      exists: async (p: string) => p in files || p === HOME,
      remove: async (p: string) => void delete files[p],
      list: async () => [],
      mkdir: async () => {},
    },
  } as unknown as HostApi;
  const ctx = {
    host,
    settings: { get: (k: string, d: unknown) => (k in settings ? settings[k] : d) },
    log: { info() {}, warn() {}, error() {} },
    register: { connector: (d: ConnectorDef) => void (connector = d) },
  } as unknown as PluginContext;
  return { ctx, files, connector: () => connector! };
}

describe('dsh connector install', () => {
  it('writes the bridge and one patch row, and reports installed', async () => {
    const f = fakeCtx({ [PATCH]: "- id: foreign\n  name: './foreign.mjs'\n" });
    await dsh.activate(f.ctx);
    expect(await f.connector().status!()).toEqual({ installed: false, detail: undefined });

    await f.connector().install!();
    expect(f.files[BRIDGE]).toContain("name: 'petween-bridge'");
    expect(f.files[BRIDGE]).toContain("ctx.on('session/event'");
    expect(f.files[PATCH]).toContain("'./foreign.mjs'");
    expect(patchHasBlock(f.files[PATCH])).toBe(true);
    expect(await f.connector().status!()).toEqual({ installed: true, detail: 'DSH 启动时加载补丁' });
    expect(f.files[`${PATCH}.petween-bak`]).toBe("- id: foreign\n  name: './foreign.mjs'\n");

    const once = f.files[PATCH];
    await f.connector().install!();
    expect(f.files[PATCH]).toBe(once);
  });

  it('uninstalls only its own files and block', async () => {
    const original = "- id: foreign\n  name: './foreign.mjs'\n";
    const f = fakeCtx({ [PATCH]: original });
    await dsh.activate(f.ctx);
    await f.connector().install!();
    await f.connector().uninstall!();

    expect(BRIDGE in f.files).toBe(false);
    expect(f.files[PATCH]).toBe(original);
    expect(`${PATCH}.petween-bak` in f.files).toBe(false);
    expect(await f.connector().status!()).toEqual({ installed: false, detail: undefined });
  });

  it('leaves [] behind when the home patch was only ours', async () => {
    const f = fakeCtx({ [PATCH]: '[]\n' });
    await dsh.activate(f.ctx);
    await f.connector().install!();
    await f.connector().uninstall!();
    expect(f.files[PATCH]).toBe('[]\n');
  });

  it('refuses to install without a DSH home', async () => {
    const f = fakeCtx({}, { dshHome: 'M:/.dsh' });
    await dsh.activate(f.ctx);
    await expect(f.connector().install!()).rejects.toThrow(/找不到 DSH 数据目录/);
  });

  it('refreshes an old bridge and restores a missing row on activate', async () => {
    const f = fakeCtx({ [BRIDGE]: 'old bridge', [PATCH]: "- id: foreign\n  name: './foreign.mjs'\n" });
    await dsh.activate(f.ctx);
    expect(f.files[BRIDGE]).not.toBe('old bridge');
    expect(patchHasBlock(f.files[PATCH])).toBe(true);
  });

  it('normalizes a trailing slash in dshHome', async () => {
    const f = fakeCtx({ [PATCH]: '[]\n' }, { dshHome: '~/.dsh/' });
    await dsh.activate(f.ctx);
    await f.connector().install!();
    expect(BRIDGE in f.files).toBe(true);
    expect(patchHasBlock(f.files[PATCH])).toBe(true);
  });
});
