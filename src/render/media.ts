// Loaded clip pictures, once per (type, source, layout), for every renderer and the kernel's
// bounds / collision math. What a picture *is* belongs to its clip type (clip-types.ts).

import type { ClipDef } from '../api/types';
import type { AnyClipType, ClipMedia } from './clip-types';

export type ClipTypeLookup = (id: string) => AnyClipType | undefined;

/** Where a clip's picture comes from. Serializable (mirror stages get it in RenderLayer). */
export interface ClipSource {
  type: string;
  src: string;
  layout: unknown;
}

/** null when the clip's type is not registered. */
export function clipSource(types: ClipTypeLookup, clip: ClipDef, baseUrl: string): ClipSource | null {
  const t = types(clip.type);
  if (!t) return null;
  return { type: clip.type, src: new URL(clip.source, baseUrl).href, layout: t.layout(clip) };
}

/** Frames on the clip's playback clock; 1 for unknown types. */
export function clipFrameCount(types: ClipTypeLookup, clip: ClipDef): number {
  const t = types(clip.type);
  return t ? Math.max(1, t.frameCount(clip)) : 1;
}

export class MediaCache {
  private ready = new Map<string, ClipMedia>();
  private pending = new Map<string, Promise<ClipMedia | null>>();
  onLoaded?: () => void;

  constructor(readonly types: ClipTypeLookup) {}

  private key(s: ClipSource) {
    return `${s.type}|${s.src}|${JSON.stringify(s.layout)}`;
  }

  get(s: ClipSource): ClipMedia | undefined {
    const m = this.ready.get(this.key(s));
    if (!m) void this.load(s);
    return m;
  }

  load(s: ClipSource): Promise<ClipMedia | null> {
    const k = this.key(s);
    const hit = this.ready.get(k);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(k);
    if (!p) {
      const t = this.types(s.type);
      p = (t ? t.load(s.src, s.layout) : Promise.reject(new Error(`clip type "${s.type}" is not registered`)))
        .then((m: ClipMedia) => {
          this.ready.set(k, m);
          this.onLoaded?.();
          return m;
        })
        .catch((e: unknown) => {
          console.error(`load ${s.src} failed`, e);
          return null;
        });
      this.pending.set(k, p);
    }
    return p;
  }
}
