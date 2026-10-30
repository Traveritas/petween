// Renderers (docs/01 §3 `renderers`): draw RenderPets into one stage and hit-test them. v1 has only
// dom2d; the kernel, the mirror stages and the editor preview all create theirs through the registry.

import type { Point } from '../api/types';
import type { Transform } from '../kernel/motion/compose';
import type { Coords } from './coords';
import type { ClipSource, ClipTypeLookup, MediaCache } from './media';

export interface RenderLayer extends ClipSource {
  frame: number;
  opacity: number;
  anchor: Point;
  /** Global px per image px. */
  scale: number;
}

/** Serializable frame description of one pet (also sent to mirror stages). */
export interface RenderPet {
  id: string;
  z: number;
  /** Anchor position, global. */
  x: number;
  y: number;
  transform: Transform;
  layers: RenderLayer[];
  /** Rescue mode: whole box is clickable and outlined. */
  outline: boolean;
}

export interface Renderer {
  coords: Coords;
  render(pets: RenderPet[]): void;
  /** Topmost pet under a stage-local CSS point. `padPx` widens the test (hysteresis while hovering). */
  hitTest(pt: Point, padPx?: number, prefer?: string | null): string | null;
  clear(): void;
}

export interface RendererEnv {
  media: MediaCache;
  clipTypes: ClipTypeLookup;
}

export interface RendererDef {
  id: string;
  create(root: HTMLElement, env: RendererEnv, coords: Coords): Renderer;
}
