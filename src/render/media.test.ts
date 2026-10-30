import { describe, expect, it } from 'vitest';
import type { ClipDef } from '../api/types';
import { Registries } from '../kernel/registry';
import { addRenderBuiltins, mediaCacheFor } from './builtin';
import type { ClipTypeDef } from './clip-types';
import { clipFrameCount, clipSource } from './media';

const BASE = 'http://pack.test/p/';

function setup() {
  const r = new Registries();
  addRenderBuiltins(r);
  return { r, types: (id: string) => r.clipTypes.get(id) };
}

describe('clip types', () => {
  it('built-ins: still is one frame, frames counts its sheet', () => {
    const { types } = setup();
    const still: ClipDef = { type: 'still', source: 'a.webp', frames: { count: 9 } };
    const frames: ClipDef = { type: 'frames', source: 'b.webp', frames: { count: 6, columns: 3 } };
    expect(clipFrameCount(types, still)).toBe(1);
    expect(clipFrameCount(types, frames)).toBe(6);
    expect(clipSource(types, still, BASE)).toEqual({ type: 'still', src: `${BASE}a.webp`, layout: { columns: 1, count: 1 } });
    expect(clipSource(types, frames, BASE)).toEqual({ type: 'frames', src: `${BASE}b.webp`, layout: { columns: 3, count: 6 } });
  });

  it('unknown types: no source, one frame', () => {
    const { types } = setup();
    const v: ClipDef = { type: 'video', source: 'c.webm' };
    expect(clipSource(types, v, BASE)).toBeNull();
    expect(clipFrameCount(types, v)).toBe(1);
  });

  it('a registered type loads once per source + layout through the cache', async () => {
    const { r } = setup();
    let loads = 0;
    const fake: ClipTypeDef<{ n: number }> = {
      id: 'test:dots',
      frameCount: (c) => c.frames?.count ?? 1,
      layout: (c) => ({ n: c.frames?.count ?? 1 }),
      load: async (url, l) => {
        loads++;
        return { url, frameW: 10 * l.n, frameH: 20, alphaAt: () => 255, opaqueBox: () => null };
      },
      dom2d: () => ({ draw() {} }),
    };
    r.clipTypes.add(fake, 'test');
    const media = mediaCacheFor(r);
    let loaded = 0;
    media.onLoaded = () => loaded++;
    const src = clipSource((id) => r.clipTypes.get(id), { type: 'test:dots', source: 'd', frames: { count: 3 } }, BASE)!;
    expect(media.get(src)).toBeUndefined();
    const m = await media.load(src);
    expect(m?.frameW).toBe(30);
    expect(media.get(src)).toBe(m);
    await media.load({ ...src, layout: { n: 3 } });
    expect(loads).toBe(1);
    expect(loaded).toBe(1);
  });

  it('loading an unregistered type resolves to null', async () => {
    const { r } = setup();
    const media = mediaCacheFor(r);
    const err = console.error;
    console.error = () => {};
    try {
      expect(await media.load({ type: 'nope', src: 'x', layout: null })).toBeNull();
    } finally {
      console.error = err;
    }
  });
});
