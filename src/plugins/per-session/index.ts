// `per-session` binding rule (docs/05 §5): every agent session gets its own temporary pet,
// which leaves when the session ends. Only acts while it is the selected binding (settings → 接入).

import { definePlugin, type AgentEvent, type PetHandle, type PluginManifest } from '../../api/types';

export const manifest: PluginManifest = {
  id: 'per-session',
  name: '每个会话一只宠物',
  version: '0.1.0',
  apiVersion: 1,
  contributes: {
    settings: [
      { key: 'packs', label: '新宠物从这些宠物包里挑', type: 'list', default: [], description: '填宠物包 id；留空就和第一只宠物穿一样的' },
      { key: 'maxPets', label: '最多同时几只', type: 'number', default: 4, min: 1, max: 12, step: 1, unit: '只' },
      { key: 'includeMain', label: '第一只宠物也跟着所有会话', type: 'boolean', default: false },
    ],
  },
};

const key = (e: AgentEvent) => `${e.agent}:${e.sessionId}`;

export default definePlugin({
  activate(ctx) {
    const bySession = new Map<string, string>();
    const spawning = new Set<string>();

    const spawn = async (e: AgentEvent) => {
      const k = key(e);
      const main = ctx.pets.list()[0];
      const pool = ctx.settings.get<string[]>('packs', []).filter(Boolean);
      const pack = pool.length ? pool[bySession.size % pool.length] : main?.pack.id;
      if (!pack || bySession.size >= ctx.settings.get('maxPets', 4)) return;
      spawning.add(k);
      try {
        // Line them up to the left of the main pet.
        const at = main ? { x: main.position.x - 140 * (bySession.size + 1), y: main.position.y } : undefined;
        const pet = await ctx.pets.add({ pack, position: at, persist: false });
        bySession.set(k, pet.id);
        ctx.log.info(`${k} → ${pet.id} (${pack})`);
      } catch (err) {
        ctx.log.warn(`could not spawn a pet for ${k}: ${err}`);
      } finally {
        spawning.delete(k);
      }
    };

    ctx.register.bindingRule({
      id: 'perSession',
      route(e, pets) {
        const k = key(e);
        const out: PetHandle[] = ctx.settings.get('includeMain', false) && pets[0] ? [pets[0]] : [];
        const id = bySession.get(k);
        if (e.type === 'session-end') {
          if (id) {
            bySession.delete(k);
            ctx.setTimeout(() => ctx.pets.remove(id), 1500);
          }
          return out;
        }
        if (id) {
          const pet = pets.find((p) => p.id === id);
          if (pet) out.push(pet);
          else bySession.delete(k); // removed by the user in settings
        } else if (!spawning.has(k)) {
          // The first event of a session arrives before its pet exists; the pet picks up from the next one.
          void spawn(e);
        }
        return out;
      },
    });
  },
});
