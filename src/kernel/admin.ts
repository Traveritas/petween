// Kernel side of the settings-window RPC (src/shared/admin.ts). Thin: every method maps onto
// kernel operations that already exist; the settings window never touches pet state directly.

import type { ClipIntent, Point } from '../api/types';
import type { AdminApi, AdminCall, AdminResult, InspectorPet, PackInfo } from '../shared/admin';
import type { AgentHub } from './agent';
import { pageHandlerKey } from './context';
import type { Host, HostPaths } from './host';
import { joinPath, PACK_BASE } from './host';
import type { Pet } from './pet';
import type { PluginManager } from './plugins';
import { dependentsOf } from './plugins';
import type { Registries } from './registry';
import type { FileStore } from './store';

export interface AdminDeps {
  host: Host;
  paths: HostPaths;
  plugins: PluginManager;
  registries: Registries;
  agent: AgentHub;
  settings: FileStore;
  pets(): Pet[];
  store(id: string, kind: 'settings' | 'data'): FileStore;
  addPet(pack: string, at?: Point, id?: string, scale?: number): Promise<void>;
  removePet(id: string): void;
  saveInstances(): void;
  pageHandlers: Map<string, (params: unknown) => unknown>;
  reloadPack(id: string): Promise<void>;
  tryPack(petId: string, raw: unknown, baseUrl: string): Promise<void>;
  tryEnd(petId: string): Promise<void>;
  forceState(petId: string, key: string | null): void;
  version: string;
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

export class Admin {
  constructor(private d: AdminDeps) {}

  disabled(): string[] {
    return this.d.settings.get<string[]>('disabled', []);
  }

  async handle(call: AdminCall): Promise<AdminResult> {
    try {
      const fn = (this.api as Record<string, (p: unknown) => unknown>)[call.method];
      if (!fn) throw new Error(`unknown method ${call.method}`);
      return { id: call.id, ok: true, value: await fn(call.params) };
    } catch (e) {
      return { id: call.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private registryOwners(id: string) {
    const out: string[] = [];
    const r = this.d.registries;
    for (const [name, reg] of [['connector', r.connectors], ['brain', r.brains], ['binding', r.bindingRules], ['motion', r.motionTypes], ['transition', r.transitionTypes]] as const) {
      for (const def of reg.list()) if (reg.ownerOf(def.id) === id) out.push(`${name}:${def.id}`);
    }
    return out;
  }

  private async builtinPacks(): Promise<string[]> {
    try {
      const res = await fetch(new URL('packs/index.json', location.href));
      return res.ok ? ((await res.json()) as string[]) : ['default'];
    } catch {
      return ['default'];
    }
  }

  private readonly api: { [K in keyof AdminApi]: (p: Parameters<AdminApi[K]>[0]) => ReturnType<AdminApi[K]> | Promise<ReturnType<AdminApi[K]>> } = {
    'plugins.list': () => {
      const disabled = this.disabled();
      return [...this.d.plugins.records.values()]
        .map((r) => ({
          id: r.manifest.id,
          name: r.manifest.name,
          version: r.manifest.version,
          builtin: r.builtin,
          enabled: !disabled.includes(r.manifest.id),
          status: r.status,
          error: r.error,
          permissions: r.manifest.permissions ?? [],
          provides: this.registryOwners(r.manifest.id),
          settings: r.manifest.contributes?.settings ?? [],
          settingsPage: r.settingsPage,
          baseUrl: r.baseUrl,
          manifest: r.manifest,
        }))
        .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id));
    },

    'plugins.setEnabled': async ({ id, enabled }) => {
      if (id === 'core') throw new Error('core 不能停用');
      const pm = this.d.plugins;
      const rec = pm.records.get(id);
      if (!rec) throw new Error(`没有插件 ${id}`);
      const set = new Set(this.disabled());
      if (enabled) set.delete(id);
      else set.add(id);
      this.d.settings.set('disabled', [...set]);
      const all = [...pm.records.values()];
      const chain = [id, ...dependentsOf(all, id)];
      if (!enabled) {
        for (const x of [...chain].reverse()) {
          const r = pm.records.get(x);
          if (r) await pm.deactivate(r);
        }
      } else {
        for (const x of chain) {
          const r = pm.records.get(x);
          if (r && !set.has(x) && r.status !== 'active') {
            r.status = 'inactive';
            await pm.activate(r);
          }
        }
      }
    },

    'settings.get': ({ plugin }) => this.d.store(plugin, 'settings').all(),
    'settings.set': ({ plugin, key, value }) => this.d.store(plugin, 'settings').set(key, value),
    'plugins.call': async ({ plugin, method, params }) => {
      const fn = this.d.pageHandlers.get(pageHandlerKey(plugin, method));
      if (!fn) {
        const running = this.d.plugins.records.get(plugin)?.status === 'active';
        throw new Error(running ? `插件 ${plugin} 没有处理 ${method}` : `插件 ${plugin} 没有在运行`);
      }
      return fn(params);
    },

    'connectors.list': async () => {
      const sessions = this.d.agent.list();
      return Promise.all(
        this.d.registries.connectors.list().map(async (c) => {
          let status = null;
          let error: string | undefined;
          try {
            status = (await c.status?.()) ?? null;
          } catch (e) {
            error = String(e instanceof Error ? e.message : e);
          }
          const mine = sessions.filter((s) => s.agent === c.id);
          return {
            id: c.id,
            name: c.name ?? c.id,
            owner: this.d.registries.connectors.ownerOf(c.id) ?? '',
            status,
            error,
            sessions: mine.length,
            lastEventAt: mine.length ? Math.max(...mine.map((s) => s.lastEventAt)) : null,
          };
        }),
      );
    },
    'connectors.install': async ({ id }) => {
      const c = this.d.registries.connectors.get(id);
      if (!c?.install) throw new Error(`${id} 不支持自动安装`);
      await c.install();
    },
    'connectors.uninstall': async ({ id }) => {
      const c = this.d.registries.connectors.get(id);
      if (!c?.uninstall) throw new Error(`${id} 不支持自动卸载`);
      await c.uninstall();
    },

    'pets.list': () =>
      this.d.pets().map((p) => ({ id: p.id, pack: p.loaded.pack.id, packName: p.loaded.pack.name, scale: p.scale, stateKey: p.state.value })),
    'pets.add': ({ pack }) => this.d.addPet(pack),
    'pets.remove': ({ id }) => {
      if (this.d.pets().length <= 1) throw new Error('至少要留一只宠物');
      this.d.removePet(id);
    },
    'pets.setPack': async ({ id, pack }) => {
      const p = this.d.pets().find((x) => x.id === id);
      if (!p) throw new Error(`没有宠物 ${id}`);
      const at = p.position.baseValue;
      const scale = p.scale;
      this.d.removePet(id);
      await this.d.addPet(pack, at, id, scale);
    },
    'packs.reload': ({ id }) => this.d.reloadPack(id),
    'pets.tryPack': ({ petId, pack, baseUrl }) => this.d.tryPack(petId, pack, baseUrl),
    'pets.tryEnd': ({ petId }) => this.d.tryEnd(petId),
    'pets.forceState': ({ petId, key }) => this.d.forceState(petId, key),
    'pets.setScale': ({ id, scale }) => {
      const p = this.d.pets().find((x) => x.id === id);
      if (!p) throw new Error(`没有宠物 ${id}`);
      p.scale = Math.max(0.2, Math.min(4, scale));
      this.d.saveInstances();
    },

    'packs.list': async () => {
      const out: PackInfo[] = [];
      for (const id of await this.builtinPacks()) {
        try {
          const base = new URL(`packs/${id}/`, location.href);
          const pack = await (await fetch(new URL('pet.json', base))).json();
          out.push(this.packInfo(pack, true, base.href));
        } catch {
          /* listed but unreadable: skip */
        }
      }
      let dirs: { name: string; isDir: boolean }[] = [];
      try {
        dirs = await this.d.host.list(this.d.paths.pets);
      } catch {
        /* no pets dir yet */
      }
      for (const dir of dirs.filter((x) => x.isDir)) {
        try {
          const pack = JSON.parse(await this.d.host.readText(joinPath(this.d.paths.pets, dir.name, 'pet.json')));
          out.push(this.packInfo(pack, false, `${PACK_BASE}/${encodeURIComponent(dir.name)}/`));
        } catch {
          /* not a pack */
        }
      }
      return out;
    },
    'packs.openFolder': async () => {
      await this.d.host.exec('explorer', [this.d.paths.pets.replace(/\//g, '\\')]);
    },

    'plugins.openFolder': async () => {
      await this.d.host.exec('explorer', [this.d.paths.plugins.replace(/\//g, '\\')]);
    },

    'kernel.get': () => ({
      devMode: this.d.settings.get('devMode', false),
      brain: this.d.settings.get('brain', 'default'),
      binding: this.d.settings.get('binding', 'single'),
      brains: this.d.registries.brains.list().map((b) => b.id),
      bindings: this.d.registries.bindingRules.list().map((b) => b.id),
      version: this.d.version,
      dataDir: this.d.paths.appData,
    }),
    'kernel.set': (patch) => {
      for (const [k, v] of Object.entries(patch)) this.d.settings.set(k, v);
      // A new brain choice applies to every pet right away.
      if ('brain' in patch) for (const p of this.d.pets()) this.d.agent.attach(p);
    },

    'inspector.snapshot': (): InspectorPet[] =>
      this.d.pets().map((p) => {
        const cur = p.appearance.current;
        const ch = <T,>(entries: { owner: string; priority: number; value: T; active: boolean }[], fmt: (v: T) => string) =>
          entries.map((e) => ({ owner: e.owner, priority: e.priority, value: fmt(e.value), active: e.active }));
        return {
          id: p.id,
          brain: this.d.agent.brainOf(p.id),
          stateKey: p.state.value,
          resolvedKey: cur?.kind === 'state' ? cur.resolvedKey : '(clip)',
          clip: cur?.clipId ?? '',
          state: [...ch(p.state.entries(), show), { owner: 'brain', priority: 0, value: p.state.baseValue, active: p.state.entries().length === 0 }],
          clipChannel: ch(p.clip.entries(), (v: ClipIntent | null) => (v ? (typeof v.clip === 'string' ? v.clip : '(inline)') : 'null')),
          position: [
            ...ch(p.position.entries(), (v: Point) => `${Math.round(v.x)}, ${Math.round(v.y)}`),
            { owner: 'base', priority: 0, value: `${Math.round(p.position.baseValue.x)}, ${Math.round(p.position.baseValue.y)}`, active: p.position.entries().length === 0 },
          ],
          bubble: p.bubble.entries(),
          motions: p.motions.describe(),
        };
      }),
  };

  private packInfo(pack: { id: string; name?: string; attribution?: { creators?: string[]; license?: string }; clips?: Record<string, { source: string; type?: string; frames?: { count: number; columns?: number } }>; states?: Record<string, { clips: string[] }> }, builtin: boolean, base: string): PackInfo {
    const idleClip = pack.states?.idle?.clips?.[0] ?? Object.keys(pack.clips ?? {})[0];
    const clip = idleClip ? pack.clips?.[idleClip] : undefined;
    const src = clip?.source;
    const count = clip?.type === 'frames' ? Math.max(1, clip.frames?.count ?? 1) : 1;
    const columns = clip?.frames?.columns ?? count;
    return {
      id: pack.id,
      name: pack.name ?? pack.id,
      builtin,
      creators: pack.attribution?.creators ?? [],
      license: pack.attribution?.license,
      preview: src ? new URL(src, base).href : undefined,
      previewGrid: count > 1 ? { columns, rows: Math.ceil(count / columns) } : undefined,
    };
  }
}
