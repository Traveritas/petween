// Builds the PluginContext (docs/06 §4). Everything handed out is tracked in the plugin's scope,
// so deactivation releases leases, listeners, registrations, layers, tray items and timers.

import type {
  Disposable,
  PetHandle,
  PluginContext,
  Point,
  Rect,
  StageLayer,
  TrayItemHandle,
  TrayItemOptions,
} from '../api/types';
import type { AgentHub } from './agent';
import { Emitter } from './emitter';
import type { Host, HostPaths } from './host';
import type { Pet } from './pet';
import type { PluginRecord } from './plugins';
import type { Registries, Registry } from './registry';
import { type Scope, toDisposable } from './scope';
import type { FileStore } from './store';

export interface KernelServices {
  host: Host;
  paths: HostPaths;
  registries: Registries;
  agent: AgentHub;
  pets(): Pet[];
  spawnPet(pack: string, at: Point | undefined, scale: number, persist: boolean): Promise<Pet>;
  removePet(id: string): void;
  screens(): Rect[];
  screensChanged: Emitter<Rect[]>;
  petAdded: Emitter<Pet>;
  petRemoved: Emitter<Pet>;
  viewFor(owner: string, pet: Pet): PetHandle;
  store(pluginId: string, kind: 'settings' | 'data'): FileStore;
  addLayer(owner: string, opts: { z: number; hitTest?: (p: Point) => boolean }): StageLayer;
  addTrayItem(owner: string, item: TrayItemOptions): TrayItemHandle;
  onFrame(fn: (now: number, dt: number) => void): Disposable;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  bus: Map<string, Emitter<unknown>>;
  services: Map<string, { owner: string; impl: unknown }>;
  /** Settings-page request handlers, keyed by pageHandlerKey(plugin, method). */
  pageHandlers: Map<string, (params: unknown) => unknown>;
}

export const pageHandlerKey = (plugin: string, method: string) => `${plugin}\n${method}`;

/** Built-in names without a plugin prefix are reserved for the `core` plugin. */
const CORE = 'core';

function checkedRegister<T extends { id: string }>(reg: Registry<T>, owner: string, def: T, prefixed: boolean): Disposable {
  if (prefixed && owner !== CORE && !def.id.startsWith(`${owner}:`)) {
    throw new Error(`${reg.name}: "${def.id}" must start with "${owner}:"`);
  }
  return reg.add(def, owner);
}

export function createContext(rec: PluginRecord, scope: Scope, k: KernelServices): PluginContext {
  const id = rec.manifest.id;
  const t = <D extends Disposable>(d: D) => {
    scope.track(d);
    return d;
  };
  const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack ?? x.message : JSON.stringify(x))).join(' ');
  const safe = <A extends unknown[]>(fn: (...a: A) => void, what: string) => (...a: A) => {
    try {
      fn(...a);
    } catch (e) {
      k.log('error', `[${id}] ${what} threw: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  };

  return {
    id,
    log: {
      info: (...a) => k.log('info', `[${id}] ${fmt(a)}`),
      warn: (...a) => k.log('warn', `[${id}] ${fmt(a)}`),
      error: (...a) => k.log('error', `[${id}] ${fmt(a)}`),
    },

    pets: {
      list: () => k.pets().map((p) => k.viewFor(id, p)),
      async add(opts) {
        const pet = await k.spawnPet(opts.pack, opts.position, opts.scale ?? 1, opts.persist ?? false);
        if (!(opts.persist ?? false)) t(toDisposable(() => k.removePet(pet.id)));
        return k.viewFor(id, pet);
      },
      remove: (petId) => k.removePet(petId),
      on(event, fn) {
        const ev = event === 'added' ? k.petAdded : k.petRemoved;
        return t(ev.on(safe((p: Pet) => fn(k.viewFor(id, p)), `pets.on(${event})`)));
      },
    },

    agent: {
      on: (_event, fn) => t(k.agent.event.on(safe(fn, 'agent.on'))),
      sessions: () => k.agent.list(),
    },

    register: {
      connector: (def) => t(checkedRegister(k.registries.connectors, id, def, false)),
      brain: (def) => t(checkedRegister(k.registries.brains, id, def, false)),
      motionType: (def) => t(checkedRegister(k.registries.motionTypes, id, def, true)),
      transitionType: (def) => t(checkedRegister(k.registries.transitionTypes, id, def, true)),
      bindingRule: (def) => t(checkedRegister(k.registries.bindingRules, id, def, false)),
    },

    desktop: {
      screens: () => k.screens(),
      on: (_event, fn) => t(k.screensChanged.on(safe(fn, 'desktop.on'))),
    },

    stage: { addLayer: (opts) => t(k.addLayer(id, opts)) },
    tray: { addItem: (item) => t(k.addTrayItem(id, { ...item, onClick: safe(item.onClick, 'tray item') })) },

    settings: k.store(id, 'settings'),
    data: k.store(id, 'data'),

    host: {
      paths: { home: k.paths.home, appData: k.paths.appData },
      fs: {
        readText: (p) => k.host.readText(p),
        readTail: (p, n) => k.host.readTail(p, n),
        writeText: (p, c) => k.host.writeText(p, c),
        list: (p) => k.host.list(p),
        exists: (p) => k.host.exists(p),
        mkdir: (p) => k.host.mkdir(p),
        remove: (p) => k.host.remove(p),
      },
      shell: { exec: (cmd, args, opts) => k.host.exec(cmd, args, opts?.cwd) },
      openExternal: (url) => k.host.openExternal(url),
      hookPort: () => k.host.hookPort(),
      hookCommand: (id, q) => k.host.hookCommand(id, q),
    },

    bus: {
      emit(topic, payload) {
        k.bus.get(topic)?.emit(payload);
      },
      on(topic, fn) {
        let ev = k.bus.get(topic);
        if (!ev) k.bus.set(topic, (ev = new Emitter()));
        return t(ev.on(safe(fn, `bus.on(${topic})`)));
      },
    },

    services: {
      provide(name, impl) {
        const cur = k.services.get(name);
        if (cur) throw new Error(`service "${name}" already provided by ${cur.owner}`);
        k.services.set(name, { owner: id, impl });
        return t(toDisposable(() => {
          if (k.services.get(name)?.impl === impl) k.services.delete(name);
        }));
      },
      use: <T,>(name: string) => k.services.get(name)?.impl as T | undefined,
    },

    settingsPage: {
      handle(method, fn) {
        const key = pageHandlerKey(id, method);
        if (k.pageHandlers.has(key)) throw new Error(`settings page method "${method}" already handled`);
        k.pageHandlers.set(key, fn);
        return t(toDisposable(() => {
          if (k.pageHandlers.get(key) === fn) k.pageHandlers.delete(key);
        }));
      },
    },

    setTimeout(fn, ms) {
      const h = setTimeout(safe(fn, 'setTimeout'), ms);
      return t(toDisposable(() => clearTimeout(h)));
    },
    setInterval(fn, ms) {
      const h = setInterval(safe(fn, 'setInterval'), ms);
      return t(toDisposable(() => clearInterval(h)));
    },
    requestFrame: (fn) => t(k.onFrame(safe(fn, 'requestFrame'))),
  };
}
