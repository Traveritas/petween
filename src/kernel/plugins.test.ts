import { describe, expect, it, vi } from 'vitest';
import type { PluginContext, PluginManifest, PluginModule } from '../api/types';
import { orderPlugins, PluginManager, satisfies, type PluginRecord } from './plugins';
import { toDisposable } from './scope';

const rec = (id: string, deps: Record<string, string> = {}, module: Partial<PluginModule> = {}, version = '1.0.0'): PluginRecord => ({
  manifest: { id, name: id, version, apiVersion: 1, dependencies: deps } as PluginManifest,
  builtin: false,
  status: 'inactive',
  load: async () => ({ activate: () => {}, ...module }),
});

describe('satisfies', () => {
  it('handles ^ ~ >= exact *', () => {
    expect(satisfies('1.4.0', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('0.9.0', '>=1.0.0')).toBe(false);
    expect(satisfies('1.0.0', '1.0.0')).toBe(true);
    expect(satisfies('5.0.0', '*')).toBe(true);
  });
});

describe('orderPlugins (docs/06 §3)', () => {
  it('dependencies first, otherwise by id', () => {
    const { order } = orderPlugins([rec('roamer', { physics: '^1.0.0' }), rec('physics'), rec('bubble'), rec('aaa')]);
    expect(order.map((r) => r.manifest.id)).toEqual(['aaa', 'bubble', 'physics', 'roamer']);
  });

  it('missing, mismatched and cyclic dependencies fail — and their dependents too', () => {
    const { order, failed } = orderPlugins([
      rec('a', { missing: '*' }),
      rec('b', { a: '*' }),
      rec('c', { d: '^2.0.0' }),
      rec('d'),
      rec('x', { y: '*' }),
      rec('y', { x: '*' }),
    ]);
    expect(order.map((r) => r.manifest.id)).toEqual(['d']);
    expect(failed.map((f) => f.rec.manifest.id).sort()).toEqual(['a', 'b', 'c', 'x', 'y']);
  });
});

describe('PluginManager', () => {
  const makeMgr = () => {
    const disposed: string[] = [];
    const mgr = new PluginManager(
      (r, scope) => {
        scope.add(toDisposable(() => disposed.push(r.manifest.id)));
        return { id: r.manifest.id } as PluginContext;
      },
      () => {},
    );
    return { mgr, disposed };
  };

  it('a failing activate does not stop the others and cleans its scope', async () => {
    const { mgr, disposed } = makeMgr();
    mgr.add(rec('bad', {}, { activate: () => { throw new Error('nope'); } }));
    mgr.add(rec('good'));
    await mgr.activateAll();
    expect(mgr.records.get('bad')!.status).toBe('failed');
    expect(mgr.records.get('good')!.status).toBe('active');
    expect(disposed).toEqual(['bad']);
  });

  it('rejects other API versions', async () => {
    const { mgr } = makeMgr();
    const r = rec('future');
    r.manifest.apiVersion = 2;
    mgr.add(r);
    await mgr.activateAll();
    expect(mgr.records.get('future')!.status).toBe('failed');
  });

  it('reload takes dependents along, in order', async () => {
    const { mgr, disposed } = makeMgr();
    const calls: string[] = [];
    const tracked = (id: string, deps = {}) => rec(id, deps, { activate: () => void calls.push(`on:${id}`), deactivate: () => void calls.push(`off:${id}`) });
    mgr.add(tracked('physics'));
    mgr.add(tracked('roamer', { physics: '*' }));
    mgr.add(tracked('other'));
    await mgr.activateAll();
    calls.length = 0;
    const refresh = vi.fn(async (id: string) => tracked(id));
    await mgr.reload('physics', refresh);
    expect(calls).toEqual(['off:roamer', 'off:physics', 'on:physics', 'on:roamer']);
    expect(disposed).toEqual(['roamer', 'physics']);
    expect(refresh).toHaveBeenCalledWith('physics');
  });

  it('rejects invalid and duplicate ids', () => {
    const { mgr } = makeMgr();
    mgr.add(rec('Bad Id'));
    mgr.add(rec('ok'));
    mgr.add(rec('ok'));
    expect([...mgr.records.keys()]).toEqual(['ok']);
  });
});
