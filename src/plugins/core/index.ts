// `core`: the built-in entries of the registries (docs/01 §3) — motion types, transition types,
// the `single` binding rule. Registered through the same API any plugin uses.

import { definePlugin, type PluginManifest, type TransitionTypeDef } from '../../api/types';
import { BUILTIN_MOTION_TYPES } from '../../kernel/motion/builtin';

export const manifest: PluginManifest = {
  id: 'core',
  name: '内核内置项',
  version: '0.1.0',
  apiVersion: 1,
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const BUILTIN_TRANSITIONS: TransitionTypeDef[] = [
  { id: 'cut', plan: () => ({ crossfadeMs: 0 }) },
  { id: 'crossfade', plan: (p) => ({ crossfadeMs: Math.max(0, num(p.durationMs, 200)) }) },
  { id: 'onMarker', plan: (p) => ({ crossfadeMs: 0, waitFor: { marker: typeof p.marker === 'string' ? p.marker : 'swap' } }) },
  { id: 'afterLoop', plan: () => ({ crossfadeMs: 0, waitFor: 'loop-end' }) },
];

export default definePlugin({
  activate(ctx) {
    for (const m of BUILTIN_MOTION_TYPES) ctx.register.motionType(m);
    for (const t of BUILTIN_TRANSITIONS) ctx.register.transitionType(t);
    // docs/05 §5: every session drives the main pet (the first one).
    ctx.register.bindingRule({ id: 'single', route: (_e, pets) => pets.slice(0, 1) });
  },
});
