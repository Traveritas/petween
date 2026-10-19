// Factory for a hook-connector plugin: parse + install/uninstall/status + a tray toggle.
// Each agent supplies only where its config lives and how a hook entry looks.

import type { ConnectorStatus, PluginContext } from '../../api/types';
import {
  mergeEvents,
  ourGroups,
  parseHook,
  readConfig,
  removeBackup,
  sameJson,
  serialized,
  stripEvents,
  writeConfig,
  type HookKind,
} from './hook-connector';

export interface HookCommand {
  command: string;
  args: string[];
}

export interface ConnectorSpec {
  id: string;
  name: string;
  /** Absolute config file paths to manage (some agents allow several config dirs). */
  files(ctx: PluginContext): string[];
  /** Agent event name → our kind, in registration order. */
  events: [event: string, kind: HookKind, timeoutSec?: number][];
  /** One matcher group for an event. */
  group(cmd: HookCommand, timeoutSec?: number): unknown;
  /** Read / write the event → groups map inside the config object. */
  getEvents(config: Record<string, unknown>, file: string): Record<string, unknown>;
  setEvents(config: Record<string, unknown>, events: Record<string, unknown>, installing: boolean): void;
  /** Shown on the settings card after install. */
  installNote?: string;
}

const home = (ctx: PluginContext, p: string) => (p.startsWith('~') ? ctx.host.paths.home + p.slice(1) : p).replace(/\\/g, '/');

export function connectorActivate(spec: ConnectorSpec) {
  return async (ctx: PluginContext) => {
    const expected = async (): Promise<Record<string, unknown[]>> => {
      const out: Record<string, unknown[]> = {};
      for (const [event, kind, timeout] of spec.events) {
        const cmd = await ctx.host.hookCommand(spec.id, `e=${kind}`);
        (out[event] ??= []).push(spec.group(cmd, timeout));
      }
      return out;
    };
    const files = () => spec.files(ctx).map((f) => home(ctx, f));

    const install = async () => {
      const ours = await expected();
      for (const file of files()) {
        await serialized(file, async () => {
          const config = (await readConfig(ctx.host, file)) ?? {};
          spec.setEvents(config, mergeEvents(spec.getEvents(config, file), ours, spec.id, file), true);
          await writeConfig(ctx.host, file, config);
        });
      }
      ctx.log.info(`hooks installed → ${files().join(', ')}`);
    };

    const uninstall = async () => {
      for (const file of files()) {
        await serialized(file, async () => {
          const config = await readConfig(ctx.host, file);
          if (!config) return;
          const { events, removed } = stripEvents(spec.getEvents(config, file), spec.id);
          if (!removed) return;
          spec.setEvents(config, events, false);
          await writeConfig(ctx.host, file, config);
          await removeBackup(ctx.host, file);
        });
      }
      ctx.log.info('hooks removed');
    };

    /** installed = any managed file has our hooks; stale = they point at another exe / old event list. */
    const inspect = async () => {
      const ours = await expected();
      let installed = false;
      let stale = false;
      for (const file of files()) {
        const config = await readConfig(ctx.host, file).catch(() => null);
        if (!config) continue;
        const mine = ourGroups(spec.getEvents(config, file), spec.id);
        if (Object.keys(mine).length) {
          installed = true;
          if (!sameJson(mine, ours)) stale = true;
        }
      }
      return { installed, stale };
    };

    const status = async (): Promise<ConnectorStatus> => {
      const { installed } = await inspect();
      return { installed, detail: installed ? spec.installNote : undefined };
    };

    ctx.register.connector({
      id: spec.id,
      name: spec.name,
      parse: (req) => parseHook(spec.id, req),
      install,
      uninstall,
      status,
    });

    // Keep installed hooks pointing at this executable (the app may have moved or been updated).
    const first = await inspect();
    if (first.installed && first.stale) {
      ctx.log.info('installed hooks are stale; refreshing');
      await install().catch((e) => ctx.log.error(`refresh failed: ${e}`));
    }
  };
}
