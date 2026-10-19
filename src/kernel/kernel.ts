// The kernel (docs/01 §3): plugin lifecycle, event bus, arbitration, storage, compose + render loop.
// Runs in stage-0 only; other stages mirror what it renders (docs/01 §2).

import type { PetHandle, PluginManifest, PluginModule, Point, Rect, StageLayer, TrayItemHandle, TrayItemOptions } from '../api/types';
import { AssetCache } from '../render/assets';
import { Coords, type StageInfo } from '../render/coords';
import { Dom2dRenderer, type RenderPet } from '../render/dom2d';
import { BUILTIN_PLUGINS } from '../plugins';
import { Admin } from './admin';
import { AgentHub } from './agent';
import { createContext, type KernelServices } from './context';
import { Emitter } from './emitter';
import { joinPath, PACK_BASE, PLUGIN_BASE, type Host, type HostPaths, type RemoteInput } from './host';
import { validatePack } from './pack/resolve';
import { Pet, petView, type LoadedPack } from './pet';
import { PluginManager, type PluginRecord } from './plugins';
import { Registries } from './registry';
import { Scope, toDisposable } from './scope';
import { FileStore } from './store';

interface Instance {
  id: string;
  pack: string;
  x: number;
  y: number;
  scale: number;
}

const DRAG_THRESHOLD = 4;
const HOVER_PAD = 6;
const RESCUE_MS = 20000;
const DEFAULT_PACK = 'default';
const APP_VERSION = '0.1.0';
/** docs/03 §6: ambient-only animation (breathing, idle frames) renders at this rate to save CPU. */
const AMBIENT_FPS = 30;

export class Kernel {
  private paths!: HostPaths;
  private layout: StageInfo[] = [];
  private coords!: Coords;
  readonly registries = new Registries();
  private agent!: AgentHub;
  private plugins!: PluginManager;
  private assets = new AssetCache();
  private renderer!: Dom2dRenderer;
  private pets: Pet[] = [];
  private petAdded = new Emitter<Pet>();
  private petRemoved = new Emitter<Pet>();
  private screensChanged = new Emitter<Rect[]>();
  private stores = new Map<string, FileStore>();
  private settings!: FileStore;
  private kernelScope = new Scope();
  private kernelViews = new Map<string, PetHandle>();
  private frameFns = new Set<(now: number, dt: number) => void>();
  private layers = new Set<{ el: HTMLElement; hitTest?: (p: Point) => boolean; owner: string }>();
  private trayItems = new Map<string, { owner: string; opts: TrayItemOptions }>();
  private traySeq = 0;
  private traySync = false;
  private bus = new Map<string, Emitter<unknown>>();
  private services = new Map<string, { owner: string; impl: unknown }>();

  private running = false;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNow = 0;
  private cursor: Point = { x: -1e6, y: -1e6 };
  private hit = false;
  private hover: string | null = null;
  private remoteHover = new Map<string, string | null>();
  private press: { petId: string; start: Point; button: number; dragging: boolean } | null = null;
  private zSeq = 0;
  private rescueTimer: ReturnType<typeof setTimeout> | null = null;
  private mirrorHadPets = new Map<string, boolean>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private admin!: Admin;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private host: Host,
    private root: HTMLElement,
    private layerRoot: HTMLElement,
  ) {}

  private log = (level: 'info' | 'warn' | 'error', line: string) => this.host.log(level, line);

  // ---------- boot ----------

  async boot() {
    this.paths = await this.host.paths();
    this.setLayout(await this.host.layout());
    this.renderer = new Dom2dRenderer(this.root, this.assets, this.coords);
    this.assets.onLoaded = () => this.wake();
    this.settings = await new FileStore(this.host, joinPath(this.paths.settings, 'kernel.json')).load();

    this.agent = new AgentHub({
      registries: this.registries,
      pets: () => this.pets,
      viewFor: (owner, pet) => this.viewFor(owner, pet),
      setting: (k, d) => this.settings.get(k, d),
      log: this.log,
    });

    const services: KernelServices = {
      host: this.host,
      paths: this.paths,
      registries: this.registries,
      agent: this.agent,
      pets: () => this.pets,
      spawnPet: (pack, at, scale, persist) => this.spawnPet(pack, at, undefined, scale, persist),
      removePet: (id) => this.removePet(id),
      screens: () => this.screens(),
      screensChanged: this.screensChanged,
      petAdded: this.petAdded,
      petRemoved: this.petRemoved,
      viewFor: (owner, pet) => this.viewFor(owner, pet),
      store: (id, kind) => this.store(id, kind),
      addLayer: (owner, opts) => this.addLayer(owner, opts),
      addTrayItem: (owner, item) => this.addTrayItem(owner, item),
      onFrame: (fn) => {
        this.frameFns.add(fn);
        this.wake();
        return toDisposable(() => this.frameFns.delete(fn));
      },
      log: this.log,
      bus: this.bus,
      services: this.services,
    };
    this.plugins = new PluginManager((rec, scope) => createContext(rec, scope, services), this.log);

    // Stores must be loaded before plugins read them synchronously.
    const recs: PluginRecord[] = [
      ...BUILTIN_PLUGINS.map(({ manifest, module }) => ({ manifest, builtin: true, load: async () => module, status: 'inactive' as const })),
      ...(await this.discoverPlugins()),
    ];
    for (const r of recs) {
      await this.store(r.manifest.id, 'settings').load();
      await this.store(r.manifest.id, 'data').load();
      this.plugins.add(r);
    }
    const disabled = new Set(this.settings.get<string[]>('disabled', []));
    await this.plugins.activateAll((id) => id === 'core' || !disabled.has(id));

    this.admin = new Admin({
      host: this.host,
      paths: this.paths,
      plugins: this.plugins,
      registries: this.registries,
      agent: this.agent,
      settings: this.settings,
      pets: () => this.pets,
      store: (id, kind) => this.store(id, kind),
      addPet: async (pack, at, id, scale) => void (await this.spawnPet(pack, at, id, scale)),
      removePet: (id) => this.removePet(id),
      saveInstances: () => this.saveInstances(),
      version: APP_VERSION,
    });
    await this.restoreInstances();
    await this.listen();
    this.wake();
    this.log('info', `kernel up: ${this.pets.length} pet(s), ${this.layout.length} stage(s), primary scale ${this.coords.primaryScale}`);
  }

  private setLayout(layout: StageInfo[]) {
    this.layout = layout;
    const self = layout.find((s) => s.label === 'stage-0') ?? layout[0];
    this.coords = new Coords(layout, self);
    if (this.renderer) this.renderer.coords = this.coords;
  }

  private store(id: string, kind: 'settings' | 'data') {
    const key = `${kind}:${id}`;
    let s = this.stores.get(key);
    if (!s) {
      s = new FileStore(this.host, joinPath(kind === 'settings' ? this.paths.settings : this.paths.data, `${id}.json`));
      this.stores.set(key, s);
    }
    return s;
  }

  private viewFor(owner: string, pet: Pet): PetHandle {
    if (owner === 'kernel') {
      let v = this.kernelViews.get(pet.id);
      if (!v) this.kernelViews.set(pet.id, (v = petView(pet, 'kernel', this.kernelScope)));
      return v;
    }
    return this.plugins.viewFor(owner, pet, petView);
  }

  // ---------- third-party plugins ----------

  private async discoverPlugins(): Promise<PluginRecord[]> {
    const out: PluginRecord[] = [];
    let dirs: { name: string; isDir: boolean }[] = [];
    try {
      dirs = await this.host.list(this.paths.plugins);
    } catch (e) {
      this.log('warn', `cannot list plugins: ${e}`);
    }
    for (const d of dirs.filter((x) => x.isDir)) {
      const rec = await this.readPlugin(d.name);
      if (rec) out.push(rec);
    }
    return out;
  }

  private async readPlugin(dir: string): Promise<PluginRecord | null> {
    const file = joinPath(this.paths.plugins, dir, 'plugin.json');
    try {
      if (!(await this.host.exists(file))) return null;
      const manifest = JSON.parse(await this.host.readText(file)) as PluginManifest;
      if (manifest.id !== dir) this.log('warn', `plugin folder "${dir}" holds id "${manifest.id}"`);
      const main = manifest.main ?? 'main.js';
      return {
        manifest,
        builtin: false,
        status: 'inactive',
        load: async () => {
          const url = `${PLUGIN_BASE}/${encodeURIComponent(dir)}/${main}?v=${Date.now()}`;
          const mod = await import(/* @vite-ignore */ url);
          return (mod.default ?? mod) as PluginModule;
        },
      };
    } catch (e) {
      this.log('error', `plugin ${dir}: bad plugin.json: ${e}`);
      return null;
    }
  }

  private onPluginChanged(dir: string) {
    if (!this.settings.get('devMode', false)) return;
    clearTimeout(this.reloadTimers.get(dir));
    this.reloadTimers.set(
      dir,
      setTimeout(async () => {
        const known = this.plugins.records.get(dir);
        if (known?.builtin) return;
        this.log('info', `dev mode: reloading plugin ${dir}`);
        if (known) {
          await this.plugins.reload(dir, (id) => this.readPlugin(id));
        } else {
          const rec = await this.readPlugin(dir);
          if (rec) {
            await this.store(rec.manifest.id, 'settings').load();
            await this.store(rec.manifest.id, 'data').load();
            this.plugins.add(rec);
            await this.plugins.activate(rec);
          }
        }
        this.wake();
      }, 200),
    );
  }

  // ---------- packs + instances ----------

  private async loadPack(id: string): Promise<LoadedPack> {
    const userFile = joinPath(this.paths.pets, id, 'pet.json');
    let raw: unknown;
    let baseUrl: string;
    if (await this.host.exists(userFile)) {
      raw = JSON.parse(await this.host.readText(userFile));
      baseUrl = `${PACK_BASE}/${encodeURIComponent(id)}/`;
    } else {
      const url = new URL(`packs/${id}/pet.json`, location.href);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`宠物包 ${id} 不存在`);
      raw = await res.json();
      baseUrl = new URL(`packs/${id}/`, location.href).href;
    }
    const { pack, warnings } = validatePack(raw);
    for (const w of warnings) this.log('warn', `pack ${id}: ${w}`);
    // Decode every clip up front so bounds and hit masks are ready on first frame.
    await Promise.all(
      Object.values(pack.clips).map((c) => {
        const count = c.type === 'frames' ? Math.max(1, c.frames?.count ?? 1) : 1;
        return this.assets.load(new URL(c.source, baseUrl).href, c.frames?.columns ?? count, count);
      }),
    );
    return { pack, baseUrl };
  }

  private async restoreInstances() {
    let list: Instance[] = [];
    try {
      if (await this.host.exists(this.paths.instances)) list = JSON.parse(await this.host.readText(this.paths.instances)).pets ?? [];
    } catch (e) {
      this.log('warn', `instances.json unreadable: ${e}`);
    }
    if (!list.length) {
      const r = Coords.globalRect(this.layout[0], this.coords.primaryScale);
      list = [{ id: 'pet-1', pack: DEFAULT_PACK, x: r.x + r.width * 0.82, y: r.y + r.height * 0.86, scale: 1 }];
    }
    for (const inst of list) await this.addPet(inst);
    this.saveInstances();
  }

  private async addPet(inst: Instance, transient = false): Promise<Pet> {
    let loaded: LoadedPack;
    try {
      loaded = await this.loadPack(inst.pack);
    } catch (e) {
      this.log('error', `pet ${inst.id}: pack "${inst.pack}" failed (${e}); using default`);
      loaded = await this.loadPack(DEFAULT_PACK);
    }
    const pet = new Pet(inst.id, loaded, inst.scale || 1, { x: inst.x, y: inst.y }, {
      registries: this.registries,
      assets: this.assets,
      reducedMotion: () => this.reduced.matches,
      log: this.log,
      wake: () => this.wake(),
    });
    pet.z = ++this.zSeq;
    pet.transient = transient;
    pet.basePositionEv.on(() => this.saveInstances());
    pet.stateKeyEv.on((key) => this.log('info', `pet ${pet.id} → ${key}`));
    this.pets.push(pet);
    this.agent.attach(pet);
    this.petAdded.emit(pet);
    if (!this.onAnyStage(pet.pos)) this.bringBack(pet);
    return pet;
  }

  /** New pet at `at` (default: middle of the primary screen). */
  private async spawnPet(pack: string, at?: Point, id?: string, scale = 1, persist = true): Promise<Pet> {
    const r = Coords.globalRect(this.layout[0], this.coords.primaryScale);
    let n = this.pets.length + 1;
    while (!id && this.pets.some((p) => p.id === `pet-${n}`)) n++;
    const p = at ?? { x: r.x + r.width / 2 + (this.pets.length % 5) * 40, y: r.y + r.height * 0.8 };
    const pet = await this.addPet({ id: id ?? `pet-${n}`, pack, x: p.x, y: p.y, scale }, !persist);
    this.saveInstances();
    this.wake();
    return pet;
  }

  private removePet(id: string) {
    const i = this.pets.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [pet] = this.pets.splice(i, 1);
    this.agent.detach(pet);
    this.petRemoved.emit(pet);
    pet.dispose();
    this.kernelViews.delete(id);
    for (const r of this.plugins.records.values()) r.views?.delete(id);
    if (this.hover === id) this.hover = null;
    if (this.press?.petId === id) this.press = null;
    this.saveInstances();
    this.wake();
  }

  private saveInstances() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const pets: Instance[] = this.pets.filter((p) => !p.transient).map((p) => ({ id: p.id, pack: p.loaded.pack.id, x: Math.round(p.position.baseValue.x), y: Math.round(p.position.baseValue.y), scale: p.scale }));
      void this.host.writeText(this.paths.instances, JSON.stringify({ pets }, null, 2));
    }, 800);
  }

  private screens(): Rect[] {
    return this.layout.map((s) => Coords.globalRect(s, this.coords.primaryScale));
  }

  private onAnyStage(p: Point) {
    return this.layout.some((s) => {
      const r = Coords.globalRect(s, this.coords.primaryScale);
      return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
    });
  }

  private bringBack(pet: Pet) {
    const r = Coords.globalRect(this.layout[0], this.coords.primaryScale);
    pet.setBasePosition({ x: r.x + r.width / 2, y: r.y + r.height * 0.75 });
  }

  // ---------- stage layers + tray ----------

  private addLayer(owner: string, opts: { z: number; hitTest?: (p: Point) => boolean }): StageLayer {
    const el = document.createElement('div');
    el.className = 'layer';
    el.dataset.owner = owner;
    el.style.zIndex = String(opts.z);
    this.layerRoot.appendChild(el);
    const entry = { el, hitTest: opts.hitTest, owner };
    this.layers.add(entry);
    return {
      el,
      toLocal: (p) => this.coords.toLocal(p),
      dispose: () => {
        this.layers.delete(entry);
        el.remove();
      },
    };
  }

  private addTrayItem(owner: string, item: TrayItemOptions): TrayItemHandle {
    const id = `${owner}.${++this.traySeq}`;
    const entry = { owner, opts: { ...item } };
    this.trayItems.set(id, entry);
    this.syncTray();
    return {
      update: (patch) => {
        Object.assign(entry.opts, patch);
        this.syncTray();
      },
      dispose: () => {
        this.trayItems.delete(id);
        this.syncTray();
      },
    };
  }

  private syncTray() {
    if (this.traySync) return;
    this.traySync = true;
    queueMicrotask(() => {
      this.traySync = false;
      const items = [...this.trayItems].map(([id, { opts }]) => ({ id, label: opts.label, checked: opts.checked, enabled: opts.enabled }));
      void this.host.traySetItems(items);
    });
  }

  // ---------- host events ----------

  private async listen() {
    const h = this.host;
    await h.on('cursor', (c) => this.onCursor(this.coords.physToGlobal(c.x, c.y)));
    await h.on('layout', (l) => {
      this.setLayout(l);
      this.screensChanged.emit(this.screens());
      for (const p of this.pets) if (!this.onAnyStage(p.pos)) this.bringBack(p);
      this.wake();
    });
    await h.on('hook', (req) => this.agent.ingest(req));
    await h.on('plugin-changed', (id) => this.onPluginChanged(id));
    await h.on('tray-click', (id) => this.trayItems.get(id)?.opts.onClick());
    await h.on('rescue', () => this.toggleRescue());
    await h.on('second-instance', () => this.toggleRescue(true));
    await h.on('admin-call', async (call) => {
      const res = await this.admin.handle(call);
      void this.host.emitTo(call.from, 'admin-result', res);
    });
    await h.on('remote-input', (r) => this.onRemote(r));

    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('pointerdown', (e) => {
      const g = this.coords.toGlobal({ x: e.clientX, y: e.clientY });
      const id = this.renderer.hitTest({ x: e.clientX, y: e.clientY }, HOVER_PAD, this.hover);
      if (!id) return;
      document.body.setPointerCapture(e.pointerId);
      this.onDown(id, g, e.button);
    });
    addEventListener('pointerup', (e) => this.onUp(this.coords.toGlobal({ x: e.clientX, y: e.clientY }), e.button));
    addEventListener('lostpointercapture', () => {
      if (this.press) this.onUp(this.cursor, this.press.button);
    });
    this.reduced.addEventListener('change', () => this.wake());
  }

  private pet(id: string | null) {
    return id ? this.pets.find((p) => p.id === id) : undefined;
  }

  private emitInput(petId: string, type: Parameters<Pet['inputEv']['emit']>[0]['type'], p: Point, button = 0) {
    this.pet(petId)?.inputEv.emit({ type, x: p.x, y: p.y, button });
  }

  private onCursor(g: Point) {
    this.cursor = g;
    const pr = this.press;
    if (pr && pr.button === 0) {
      if (!pr.dragging && Math.hypot(g.x - pr.start.x, g.y - pr.start.y) > DRAG_THRESHOLD) {
        pr.dragging = true;
        const pet = this.pet(pr.petId);
        if (pet) pet.z = ++this.zSeq;
        this.emitInput(pr.petId, 'drag-start', pr.start);
      }
      if (pr.dragging) this.emitInput(pr.petId, 'drag-move', g);
    }
    if (!this.running) this.updateHit();
  }

  private onDown(petId: string, g: Point, button: number) {
    this.press = { petId, start: g, button, dragging: false };
    this.emitInput(petId, 'down', g, button);
    this.wake();
  }

  private onUp(g: Point, button: number) {
    const pr = this.press;
    if (!pr) return;
    this.press = null;
    if (pr.dragging) this.emitInput(pr.petId, 'drag-end', g, button);
    else {
      this.emitInput(pr.petId, 'up', g, button);
      if (button === 0) this.emitInput(pr.petId, 'click', g, button);
      if (button === 2) this.emitInput(pr.petId, 'context', g, button);
    }
    this.wake();
  }

  private onRemote(r: RemoteInput) {
    const g = { x: r.x, y: r.y };
    if (r.type === 'hover') {
      this.remoteHover.set(r.stage, r.petId);
      this.updateHover();
    } else if (r.type === 'down' && r.petId) this.onDown(r.petId, g, r.button);
    else if (r.type === 'up') this.onUp(g, r.button);
  }

  private updateHover() {
    const local = this.renderer.hitTest(this.coords.toLocal(this.cursor), HOVER_PAD, this.hover);
    const next = local ?? [...this.remoteHover.values()].find((x) => x) ?? null;
    if (next !== this.hover) {
      if (this.hover) this.emitInput(this.hover, 'hover-end', this.cursor);
      this.hover = next;
      if (next) this.emitInput(next, 'hover-start', this.cursor);
    }
    return local;
  }

  private updateHit() {
    const localPet = this.updateHover();
    const h =
      this.press !== null ||
      localPet !== null ||
      [...this.layers].some((l) => {
        try {
          return !!l.hitTest?.(this.cursor);
        } catch {
          return false;
        }
      });
    if (h !== this.hit) {
      this.hit = h;
      void this.host.setHit(h);
    }
  }

  private toggleRescue(force?: boolean) {
    const on = force ?? !this.pets[0]?.outline;
    for (const p of this.pets) {
      p.outline = on;
      if (on && !this.onAnyStage(p.pos)) this.bringBack(p);
    }
    if (this.rescueTimer) clearTimeout(this.rescueTimer);
    if (on) this.rescueTimer = setTimeout(() => this.toggleRescue(false), force ? 3000 : RESCUE_MS);
    this.log('info', `rescue ${on ? 'on' : 'off'}`);
    this.wake();
  }

  // ---------- frame loop ----------

  wake() {
    // Cut an ambient-rate wait short: something wants full speed now.
    if (this.ambientTimer) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
      requestAnimationFrame((t) => this.frame(t));
      return;
    }
    if (this.running || !this.renderer) return;
    this.running = true;
    requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    const dt = this.lastNow ? Math.min(100, now - this.lastNow) : 16;
    this.lastNow = now;
    for (const fn of [...this.frameFns]) fn(now, dt);

    const out: RenderPet[] = this.pets.map((p) => p.tick(now, dt, this.viewFor('kernel', p)));
    this.renderer.render(out);
    this.sendMirrors(out);
    this.updateHit();

    const busy = this.frameFns.size > 0 || this.press !== null || this.pets.some((p) => p.busy);
    if (busy) requestAnimationFrame((t) => this.frame(t));
    else if (this.pets.some((p) => p.animated)) {
      this.ambientTimer = setTimeout(() => {
        this.ambientTimer = null;
        requestAnimationFrame((t) => this.frame(t));
      }, 1000 / AMBIENT_FPS - 4);
    } else {
      this.running = false;
      this.lastNow = 0;
    }
  }

  private sendMirrors(out: RenderPet[]) {
    if (this.layout.length < 2) return;
    const ps = this.coords.primaryScale;
    for (const s of this.layout.slice(1)) {
      const r = Coords.globalRect(s, ps);
      const subset = out.filter((rp) => {
        const b = this.pet(rp.id)!.bounds();
        const m = Math.max(b.width, b.height) * 0.5 + 40;
        return b.x + b.width + m > r.x && b.x - m < r.x + r.width && b.y + b.height + m > r.y && b.y - m < r.y + r.height;
      });
      if (subset.length || this.mirrorHadPets.get(s.label)) void this.host.emitTo(s.label, 'frame', subset);
      this.mirrorHadPets.set(s.label, subset.length > 0);
    }
  }
}
