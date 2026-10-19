// Plugin lifecycle (docs/06 §3): discover → order by dependencies → activate; everything a plugin
// registered through its context is cleaned up by its scope on deactivate. Hot reload takes dependents along.

import { API_VERSION, type PetHandle, type PluginContext, type PluginManifest, type PluginModule } from '../api/types';
import type { Pet } from './pet';
import { Scope } from './scope';

export interface PluginRecord {
  manifest: PluginManifest;
  builtin: boolean;
  load(): Promise<PluginModule>;
  status: 'inactive' | 'active' | 'failed';
  error?: string;
  module?: PluginModule;
  scope?: Scope;
  views?: Map<string, PetHandle>;
}

// ---------- versions ----------

const parse = (v: string) => v.replace(/^[^\d]*/, '').split('.').map((x) => parseInt(x, 10) || 0);

function cmp(a: number[], b: number[]) {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** Minimal range check: `*`, exact, `^x.y.z`, `~x.y.z`, `>=x.y.z`. */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (r === '*' || r === '') return true;
  const v = parse(version);
  const base = parse(r);
  if (r.startsWith('>=')) return cmp(v, base) >= 0;
  if (r.startsWith('^')) return v[0] === base[0] && cmp(v, base) >= 0;
  if (r.startsWith('~')) return v[0] === base[0] && v[1] === base[1] && cmp(v, base) >= 0;
  return cmp(v, base) === 0;
}

/** Dependency order (deps first), ties by id. Records with missing deps or cycles come back as failures. */
export function orderPlugins(records: PluginRecord[]): { order: PluginRecord[]; failed: { rec: PluginRecord; reason: string }[] } {
  const byId = new Map(records.map((r) => [r.manifest.id, r]));
  const failed: { rec: PluginRecord; reason: string }[] = [];
  const bad = new Set<string>();

  // Missing / mismatched dependencies, propagated to dependents.
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records) {
      if (bad.has(r.manifest.id)) continue;
      for (const [dep, range] of Object.entries(r.manifest.dependencies ?? {})) {
        const d = byId.get(dep);
        const reason = !d ? `缺少依赖 ${dep}` : bad.has(dep) ? `依赖 ${dep} 无法加载` : !satisfies(d.manifest.version, range) ? `依赖 ${dep}@${d.manifest.version} 不满足 ${range}` : null;
        if (reason) {
          bad.add(r.manifest.id);
          failed.push({ rec: r, reason });
          changed = true;
          break;
        }
      }
    }
  }

  const order: PluginRecord[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (r: PluginRecord, stack: string[]): boolean => {
    const id = r.manifest.id;
    if (state.get(id) === 'done') return true;
    if (state.get(id) === 'visiting') return false;
    state.set(id, 'visiting');
    for (const dep of Object.keys(r.manifest.dependencies ?? {}).sort()) {
      if (!visit(byId.get(dep)!, [...stack, id])) {
        if (!bad.has(id)) {
          bad.add(id);
          failed.push({ rec: r, reason: `循环依赖：${[...stack, id, dep].join(' → ')}` });
        }
        state.set(id, 'done');
        return false;
      }
    }
    state.set(id, 'done');
    order.push(r);
    return true;
  };
  for (const r of [...records].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    if (!bad.has(r.manifest.id)) visit(r, []);
  }
  return { order: order.filter((r) => !bad.has(r.manifest.id)), failed };
}

export function dependentsOf(records: PluginRecord[], id: string): string[] {
  const out = new Set<string>();
  const walk = (x: string) => {
    for (const r of records) {
      if (r.manifest.dependencies && x in r.manifest.dependencies && !out.has(r.manifest.id)) {
        out.add(r.manifest.id);
        walk(r.manifest.id);
      }
    }
  };
  walk(id);
  return [...out];
}

// ---------- manager ----------

export class PluginManager {
  readonly records = new Map<string, PluginRecord>();

  constructor(
    private makeContext: (rec: PluginRecord, scope: Scope) => PluginContext,
    private log: (level: 'info' | 'warn' | 'error', line: string) => void,
  ) {}

  add(rec: PluginRecord) {
    const id = rec.manifest?.id;
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      this.log('error', `plugin id "${id}" invalid (lowercase letters, digits, dashes)`);
      return;
    }
    if (this.records.has(id)) {
      this.log('error', `plugin "${id}" found twice; keeping the first`);
      return;
    }
    this.records.set(id, rec);
  }

  async activateAll(enabled: (id: string) => boolean = () => true) {
    const { order, failed } = orderPlugins([...this.records.values()]);
    for (const f of failed) {
      f.rec.status = 'failed';
      f.rec.error = f.reason;
      this.log('error', `plugin ${f.rec.manifest.id}: ${f.reason}`);
    }
    for (const r of order) if (enabled(r.manifest.id)) await this.activate(r);
  }

  async activate(rec: PluginRecord) {
    const id = rec.manifest.id;
    if (rec.status === 'active') return;
    if (rec.manifest.apiVersion !== API_VERSION) {
      rec.status = 'failed';
      rec.error = `需要 API ${rec.manifest.apiVersion}，当前为 ${API_VERSION}`;
      this.log('error', `plugin ${id}: ${rec.error}`);
      return;
    }
    for (const dep of Object.keys(rec.manifest.dependencies ?? {})) {
      if (this.records.get(dep)?.status !== 'active') {
        rec.status = 'failed';
        rec.error = `依赖 ${dep} 未激活`;
        this.log('error', `plugin ${id}: ${rec.error}`);
        return;
      }
    }
    const scope = new Scope();
    rec.scope = scope;
    rec.views = new Map();
    const t0 = performance.now();
    try {
      rec.module = await rec.load();
      if (typeof rec.module?.activate !== 'function') throw new Error('入口没有导出 activate');
      await rec.module.activate(this.makeContext(rec, scope));
      rec.status = 'active';
      rec.error = undefined;
      this.log('info', `plugin ${id} active (${(performance.now() - t0).toFixed(1)}ms)`);
    } catch (e) {
      scope.dispose();
      rec.status = 'failed';
      rec.error = String(e);
      this.log('error', `plugin ${id} failed to activate: ${e}`);
    }
  }

  async deactivate(rec: PluginRecord) {
    if (rec.status !== 'active') return;
    try {
      await rec.module?.deactivate?.();
    } catch (e) {
      this.log('error', `plugin ${rec.manifest.id} deactivate threw: ${e}`);
    }
    rec.scope?.dispose();
    rec.views?.clear();
    rec.status = 'inactive';
  }

  /** Deactivate a plugin and its dependents, then bring them back in dependency order. */
  async reload(id: string, refresh?: (id: string) => Promise<PluginRecord | null>) {
    const all = [...this.records.values()];
    const ids = [id, ...dependentsOf(all, id)];
    const recs = ids.map((x) => this.records.get(x)).filter((r): r is PluginRecord => !!r);
    for (const r of [...recs].reverse()) await this.deactivate(r);
    if (refresh) {
      const fresh = await refresh(id);
      if (fresh) this.records.set(id, fresh);
      else this.records.delete(id);
    }
    const { order } = orderPlugins([...this.records.values()].filter((r) => ids.includes(r.manifest.id)));
    for (const r of order) await this.activate(r);
  }

  viewFor(owner: string, pet: Pet, make: (pet: Pet, owner: string, scope: Scope) => PetHandle): PetHandle {
    const rec = this.records.get(owner);
    if (!rec?.scope || !rec.views) throw new Error(`plugin ${owner} is not active`);
    let v = rec.views.get(pet.id);
    if (!v) {
      v = make(pet, owner, rec.scope);
      rec.views.set(pet.id, v);
    }
    return v;
  }

  async deactivateAll() {
    const { order } = orderPlugins([...this.records.values()]);
    for (const r of [...order].reverse()) await this.deactivate(r);
  }
}
