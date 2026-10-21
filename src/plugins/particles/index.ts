// `particles` (docs/06 §6, L3): bursts of confetti, stars, hearts… around a pet.
// Three ways to set one off:
//   - a pet entering a state: the user's defaults (settings) merged with the pack's
//     `plugins.particles.onState`; the burst waits for the picture switch, so it lands with the new face;
//   - a clip marker named `particle:<effect>` (frame-exact, for animated clips);
//   - other plugins, through the `particles` service.

import { definePlugin, type Disposable, type PetHandle, type PluginManifest, type Point } from '../../api/types';
import { BUILTIN_EFFECTS, EFFECT_LABELS, ParticleEmitter, type ParticleEffectSpec } from './effects';
import { effectFor, markerEffect, mergeStateEffects } from './triggers';

export type { ParticleEffectSpec } from './effects';

/** What `ctx.services.use('particles')` returns. */
export interface ParticlesService {
  /** One burst at a pet (centre of its visible pixels) or at a desktop point. Unknown effects are ignored. */
  burst(at: PetHandle | Point, effect: string, opts?: { amount?: number }): void;
  /** Add an effect. Use `<your plugin id>:<name>` as the id; dispose it when your plugin stops. */
  define(id: string, spec: ParticleEffectSpec): Disposable;
  effects(): string[];
}

const NONE = 'none';
const EFFECT_OPTIONS = [{ value: NONE, label: '不放' }, ...Object.entries(EFFECT_LABELS).map(([value, label]) => ({ value, label }))];
const DEFAULTS = { successEffect: 'confetti', errorEffect: NONE, amount: 1 };

/** A state change bursts when the new picture shows up, or after this long if it never switches. */
const SWAP_WAIT_MS = 1500;

export const manifest: PluginManifest = {
  id: 'particles',
  name: '粒子',
  version: '0.1.0',
  apiVersion: 1,
  contributes: {
    settings: [
      { key: 'successEffect', label: '成功时', type: 'select', default: DEFAULTS.successEffect, options: EFFECT_OPTIONS, description: '宠物包自己配了特效时以宠物包为准' },
      { key: 'errorEffect', label: '出错时', type: 'select', default: DEFAULTS.errorEffect, options: EFFECT_OPTIONS },
      { key: 'amount', label: '数量', type: 'number', default: DEFAULTS.amount, min: 0.25, max: 2, step: 0.25, unit: '倍' },
    ],
  },
};

const CSS = `.pw-particle { position: absolute; pointer-events: none; will-change: transform, opacity; }`;

export default definePlugin({
  activate(ctx) {
    const layer = ctx.stage.addLayer({ z: 10 });
    const style = document.createElement('style');
    style.textContent = CSS;
    layer.el.appendChild(style);
    // Particles in flight live in our layer, so they go away with it when the plugin stops.
    const emitter = new ParticleEmitter(layer.el);
    const effects = new Map<string, ParticleEffectSpec>(Object.entries(BUILTIN_EFFECTS));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');

    const setting = <K extends keyof typeof DEFAULTS>(k: K) => ctx.settings.get(k, DEFAULTS[k]) as (typeof DEFAULTS)[K];

    const burst: ParticlesService['burst'] = (at, effect, opts) => {
      const spec = effects.get(effect);
      if (!spec || reduced.matches) return;
      let p: Point;
      if ('opaqueBounds' in at) {
        const b = at.opaqueBounds;
        p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      } else p = at;
      const local = layer.toLocal(p);
      emitter.burst(spec, local.x, local.y, (opts?.amount ?? 1) * Number(setting('amount')));
    };

    ctx.services.provide('particles', {
      burst,
      define(id, spec) {
        if (effects.has(id)) throw new Error(`particle effect "${id}" already exists`);
        effects.set(id, spec);
        return { dispose: () => effects.get(id) === spec && effects.delete(id) };
      },
      effects: () => [...effects.keys()],
    } satisfies ParticlesService);

    const attach = (pet: PetHandle) => {
      let pending: { effect: string; timer: Disposable } | null = null;
      const fire = () => {
        if (!pending) return;
        const { effect, timer } = pending;
        pending = null;
        timer.dispose();
        burst(pet, effect);
      };
      const cancel = () => {
        pending?.timer.dispose();
        pending = null;
      };
      pet.on('stateKey', (key) => {
        cancel();
        const defaults = {
          success: setting('successEffect') === NONE ? null : setting('successEffect'),
          error: setting('errorEffect') === NONE ? null : setting('errorEffect'),
        };
        const effect = effectFor(mergeStateEffects(defaults, pet.pluginConfig()), key);
        if (effect) pending = { effect, timer: ctx.setTimeout(fire, SWAP_WAIT_MS) };
      });
      pet.on('clip', fire);
      pet.on('playback', (e) => {
        const effect = e.kind === 'marker' ? markerEffect(e.marker) : null;
        if (effect) burst(pet, effect);
      });
      return cancel;
    };

    const cancels = new Map<string, () => void>();
    for (const pet of ctx.pets.list()) cancels.set(pet.id, attach(pet));
    ctx.pets.on('added', (pet) => cancels.set(pet.id, attach(pet)));
    ctx.pets.on('removed', (pet) => {
      cancels.get(pet.id)?.();
      cancels.delete(pet.id);
    });
  },
});
