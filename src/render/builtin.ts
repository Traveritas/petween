// Built-in clip types and renderers (docs/01 §3). Registered by the kernel, the mirror stages and the
// editor preview alike, since mirrors and the preview run no plugins. Owner 'kernel'.

import type { Registries } from '../kernel/registry';
import { framesClip, stillClip } from './clip-types';
import type { Coords } from './coords';
import { dom2d } from './dom2d';
import { MediaCache } from './media';
import type { Renderer } from './renderer';

export const BUILTIN_CLIP_TYPES = [stillClip, framesClip];
export const BUILTIN_RENDERERS = [dom2d];
/** The renderer every stage uses until there is a setting to pick another (docs/06 §5 L4). */
export const DEFAULT_RENDERER = 'dom2d';

export function addRenderBuiltins(r: Registries) {
  for (const t of BUILTIN_CLIP_TYPES) r.clipTypes.add(t, 'kernel');
  for (const d of BUILTIN_RENDERERS) r.renderers.add(d, 'kernel');
}

export function mediaCacheFor(r: Registries) {
  return new MediaCache((id) => r.clipTypes.get(id));
}

export function createRenderer(r: Registries, root: HTMLElement, media: MediaCache, coords: Coords): Renderer {
  const def = r.renderers.get(DEFAULT_RENDERER);
  if (!def) throw new Error(`renderer "${DEFAULT_RENDERER}" is not registered`);
  return def.create(root, { media, clipTypes: (id) => r.clipTypes.get(id) }, coords);
}
