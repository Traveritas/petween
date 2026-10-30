// `dsh` connector (docs/05 §1.2, docs/06 §6).
//
// DSH (DeepSeek Harness) has no executable hook: its extension point is a Cordis host plugin. We
// install a tiny bridge module into $DSH_HOME and add one row to the home-level cordis.patch.yml;
// the bridge forwards DSH's session events to the same local hook server as every other connector.
// Uninstall removes exactly those two things.

import { definePlugin, type AgentEvent, type ConnectorStatus, type HookRequest, type PluginContext, type PluginManifest } from '../../api/types';
import bridgeSource from './petween-bridge.mjs?raw';
import { BRIDGE_FILENAME, PATCH_FILENAME, installPatch, parseDshHook, patchHasBlock, uninstallPatch } from './protocol';

export const manifest: PluginManifest = {
  id: 'dsh',
  name: 'DSH 接入',
  version: '0.1.0',
  apiVersion: 1,
  permissions: ['fs:read', 'fs:write'],
  contributes: {
    settings: [
      {
        key: 'dshHome',
        label: 'DSH 数据目录',
        type: 'string',
        default: '~/.dsh',
        description: 'DSH 的 DSH_HOME（里面有 profiles/）；改了以后要重新接入',
      },
    ],
  },
};

export function dshActivate() {
  return async (ctx: PluginContext) => {
    const seen = new Set<string>();
    const root = () => {
      const configured = ctx.settings.get<string>('dshHome', '~/.dsh') || '~/.dsh';
      return (configured.startsWith('~') ? ctx.host.paths.home + configured.slice(1) : configured).replace(/\\/g, '/').replace(/\/+$/, '');
    };
    const patchPath = () => `${root()}/${PATCH_FILENAME}`;
    const bridgePath = () => `${root()}/${BRIDGE_FILENAME}`;

    const readPatch = async (): Promise<string | null> => {
      if (!(await ctx.host.fs.exists(patchPath()))) return null;
      return ctx.host.fs.readText(patchPath());
    };
    const writePatch = async (text: string) => {
      if (await ctx.host.fs.exists(patchPath())) {
        await ctx.host.fs.writeText(`${patchPath()}.petween-bak`, await ctx.host.fs.readText(patchPath()));
      }
      await ctx.host.fs.writeText(patchPath(), text);
    };

    const install = async () => {
      if (!(await ctx.host.fs.exists(root()))) throw new Error(`找不到 DSH 数据目录 ${root()}（可在插件设置里改 DSH_HOME）`);
      await ctx.host.fs.writeText(bridgePath(), bridgeSource);
      const current = await readPatch();
      const next = installPatch(current);
      if (next !== current) await writePatch(next);
      ctx.log.info(`DSH bridge installed → ${root()}`);
    };

    const uninstall = async () => {
      const current = await readPatch();
      if (current !== null) {
        const { text, removed } = uninstallPatch(current);
        if (removed) await writePatch(text);
      }
      if (await ctx.host.fs.exists(bridgePath())) await ctx.host.fs.remove(bridgePath());
      const backup = `${patchPath()}.petween-bak`;
      if (await ctx.host.fs.exists(backup)) await ctx.host.fs.remove(backup);
      ctx.log.info('DSH bridge removed');
    };

    const status = async (): Promise<ConnectorStatus> => {
      try {
        const installed = (await ctx.host.fs.exists(bridgePath())) && patchHasBlock(await readPatch());
        return { installed, detail: installed ? 'DSH 启动时加载补丁' : undefined };
      } catch {
        return { installed: false };
      }
    };

    ctx.register.connector({
      id: 'dsh',
      name: 'DeepSeek Harness (DSH)',
      parse: (req: HookRequest): AgentEvent[] => parseDshHook(req, seen),
      install,
      uninstall,
      status,
    });

    // The bridge is a file we own: an app update (or a moved $DSH_HOME) must not leave an old copy.
    try {
      if (await ctx.host.fs.exists(bridgePath())) {
        const current = await ctx.host.fs.readText(bridgePath());
        if (current !== bridgeSource || !patchHasBlock(await readPatch())) {
          ctx.log.info('DSH bridge is stale; refreshing');
          await install().catch((e) => ctx.log.error(`DSH bridge refresh failed: ${e}`));
        }
      }
    } catch (e) {
      ctx.log.error(`DSH bridge check failed: ${e}`);
    }
  };
}

export default definePlugin({ activate: dshActivate() });
