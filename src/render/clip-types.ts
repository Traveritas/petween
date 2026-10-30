// Clip types (docs/01 §3 `clipTypes`, docs/03 §2): what a clip's picture is — how many frames its
// playback clock has, how to load it, how big and where opaque it is, and how dom2d draws one layer.
// `still` / `frames` are built in; others (e.g. `video`) register the same way.

import type { ClipDef } from '../api/types';
import { alphaAt, decodeSprite, opaqueBox, type Asset } from './assets';

export interface OpaqueBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A clip's loaded picture, shared by every pet and layer showing it. */
export interface ClipMedia {
  /** Size of one frame, in image px. */
  readonly frameW: number;
  readonly frameH: number;
  /** Alpha (0..255) at frame-local image px (u, v): hit testing. */
  alphaAt(frame: number, u: number, v: number): number;
  /** Visible-pixel box of one frame, in frame px; null = fully transparent (collisions). */
  opaqueBox(frame: number): OpaqueBox | null;
}

/** One layer's picture inside dom2d. The renderer owns the element's box, transform and opacity. */
export interface Dom2dClipView<M extends ClipMedia = ClipMedia> {
  /** `w` / `h` = the element's CSS size. Called only when something changed. */
  draw(media: M, frame: number, w: number, h: number): void;
  dispose?(): void;
}

export interface ClipTypeDef<L = unknown, M extends ClipMedia = ClipMedia> {
  id: string;
  /** Frames on the clip's playback clock (1 = a still picture). */
  frameCount(clip: ClipDef): number;
  /** What loading and drawing need besides the source. JSON-serializable: it is sent to mirror stages. */
  layout(clip: ClipDef): L;
  load(url: string, layout: L): Promise<M>;
  /** Draw this type into one dom2d layer element. */
  dom2d(el: HTMLElement): Dom2dClipView<M>;
}

export type AnyClipType = ClipTypeDef<any, any>;

// ---------- still / frames: a spritesheet ----------

interface SpriteLayout {
  columns: number;
  count: number;
}

type SpriteMedia = Asset & ClipMedia;

function spriteType(id: string, count: (c: ClipDef) => number): ClipTypeDef<SpriteLayout, SpriteMedia> {
  return {
    id,
    frameCount: count,
    layout: (c) => {
      const n = count(c);
      return { columns: c.frames?.columns ?? n, count: n };
    },
    load: async (url, l) => {
      const a = await decodeSprite(url, l.columns, l.count);
      return Object.assign(a, {
        alphaAt: (f: number, u: number, v: number) => alphaAt(a, f, u, v),
        opaqueBox: (f: number) => opaqueBox(a, Math.min(f, a.columns * a.rows - 1)),
      });
    },
    dom2d: (el) => ({
      draw(a, frame, w, h) {
        const col = frame % a.columns;
        const row = Math.floor(frame / a.columns);
        const s = el.style;
        s.backgroundImage = `url("${a.displayUrl}")`;
        s.backgroundSize = `${a.columns * w}px ${a.rows * h}px`;
        s.backgroundPosition = `${-col * w}px ${-row * h}px`;
      },
      dispose() {
        const s = el.style;
        s.backgroundImage = s.backgroundSize = s.backgroundPosition = '';
      },
    }),
  };
}

export const stillClip = spriteType('still', () => 1);
export const framesClip = spriteType('frames', (c) => Math.max(1, c.frames?.count ?? 1));
