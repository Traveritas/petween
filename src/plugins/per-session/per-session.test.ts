import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, BindingRuleDef, PetHandle, PluginContext } from '../../api/types';
import plugin from '.';

function setup(settings: Record<string, unknown> = {}) {
  let rule: BindingRuleDef | null = null;
  const pets: PetHandle[] = [{ id: 'main', pack: { id: 'cat' }, position: { x: 1000, y: 800 } } as unknown as PetHandle];
  const timers: (() => void)[] = [];
  const ctx = {
    settings: { get: (k: string, d: unknown) => (k in settings ? settings[k] : d) },
    log: { info() {}, warn() {}, error() {} },
    register: { bindingRule: (r: BindingRuleDef) => void (rule = r) },
    pets: {
      list: () => pets,
      add: vi.fn(async (o: { pack: string }) => {
        const p = { id: `p${pets.length}`, pack: { id: o.pack }, position: { x: 0, y: 0 } } as unknown as PetHandle;
        pets.push(p);
        return p;
      }),
      remove: vi.fn((id: string) => pets.splice(pets.findIndex((p) => p.id === id), 1)),
    },
    setTimeout: (fn: () => void) => (timers.push(fn), { dispose() {} }),
  } as unknown as PluginContext;
  plugin.activate(ctx);
  const ev = (sessionId: string, type: AgentEvent['type']): AgentEvent => ({ agent: 'claude-code', sessionId, at: 0, type });
  return { ctx, pets, route: (e: AgentEvent) => rule!.route(e, pets).map((p) => p.id), ev, timers };
}

describe('per-session binding', () => {
  it('spawns a pet on a session’s first event, routes later events to it, removes it at the end', async () => {
    const s = setup();
    expect(s.route(s.ev('a', 'session-start'))).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.ctx.pets.add).toHaveBeenCalledWith(expect.objectContaining({ pack: 'cat', persist: false }));
    expect(s.route(s.ev('a', 'turn-start'))).toEqual(['p1']);
    expect(s.route(s.ev('a', 'session-end'))).toEqual([]);
    s.timers.forEach((t) => t());
    expect(s.ctx.pets.remove).toHaveBeenCalledWith('p1');
  });

  it('respects maxPets, the pack pool and includeMain', async () => {
    const s = setup({ maxPets: 1, packs: ['dog'], includeMain: true });
    s.route(s.ev('a', 'turn-start'));
    await new Promise((r) => setTimeout(r, 0));
    s.route(s.ev('b', 'turn-start'));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ctx.pets.add).toHaveBeenCalledTimes(1);
    expect(s.ctx.pets.add).toHaveBeenCalledWith(expect.objectContaining({ pack: 'dog' }));
    expect(s.route(s.ev('a', 'thinking'))).toEqual(['main', 'p1']);
  });
});
