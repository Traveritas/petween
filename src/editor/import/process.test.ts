import { describe, expect, it } from 'vitest';
import { clipIdFrom, dominantBorderColor, fitScale, footAnchor, fpsFromDelays, isOpaque, opaqueBox, padBox, removeBackground, sheetLayout, thinFrames, unionBox } from './process';

/** w×h RGBA image filled with `fill`, then `paint(x, y)` returning a colour or null. */
function image(w: number, h: number, fill: number[], paint?: (x: number, y: number) => number[] | null) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint?.(x, y) ?? fill;
      px.set(c, (y * w + x) * 4);
    }
  }
  return px;
}
const alphaAt = (px: Uint8ClampedArray, w: number, x: number, y: number) => px[(y * w + x) * 4 + 3];

describe('sizes and layout', () => {
  it('fitScale only shrinks', () => {
    expect(fitScale(1024, 512)).toBe(0.5);
    expect(fitScale(300, 200)).toBe(1);
  });

  it('sheetLayout is near square and holds every frame', () => {
    const l = sheetLayout(24, 256, 256);
    expect(l.columns * l.rows).toBeGreaterThanOrEqual(24);
    expect(l.columns).toBe(5);
    expect(sheetLayout(1, 512, 512)).toEqual({ columns: 1, rows: 1 });
  });

  it('sheetLayout respects the WebP edge limit', () => {
    const l = sheetLayout(120, 512, 64);
    expect(l.columns * 512).toBeLessThanOrEqual(16383);
    expect(l.rows * 64).toBeLessThanOrEqual(16383);
  });

  it('thinFrames spreads evenly and keeps the first', () => {
    expect(thinFrames(5, 10)).toEqual([0, 1, 2, 3, 4]);
    const t = thinFrames(300, 100);
    expect(t).toHaveLength(100);
    expect(t[0]).toBe(0);
    expect(t[1]).toBe(3);
  });

  it('fpsFromDelays', () => {
    expect(fpsFromDelays([100, 100])).toBe(10);
    expect(fpsFromDelays([0, 0])).toBe(10);
    expect(fpsFromDelays([10])).toBe(30);
    expect(fpsFromDelays([])).toBe(12);
  });
});

describe('boxes and anchors', () => {
  const clear = [0, 0, 0, 0];
  const red = [255, 0, 0, 255];
  // A 10×10 picture with a figure at x 3..6, y 2..8.
  const fig = image(10, 10, clear, (x, y) => (x >= 3 && x <= 6 && y >= 2 && y <= 8 ? red : null));

  it('opaqueBox / unionBox / padBox', () => {
    expect(opaqueBox(fig, 10, 10)).toEqual({ x: 3, y: 2, w: 4, h: 7 });
    expect(opaqueBox(image(4, 4, clear), 4, 4)).toBeNull();
    expect(unionBox([{ x: 3, y: 2, w: 4, h: 7 }, null, { x: 1, y: 5, w: 2, h: 2 }])).toEqual({ x: 1, y: 2, w: 6, h: 7 });
    expect(padBox({ x: 1, y: 1, w: 3, h: 3 }, 2, 5, 5)).toEqual({ x: 0, y: 0, w: 5, h: 5 });
  });

  it('footAnchor sits under the figure', () => {
    const a = footAnchor(fig, 10, 10);
    expect(a.y).toBe(0.9);
    expect(a.x).toBe(0.5);
    expect(footAnchor(image(4, 4, clear), 4, 4)).toEqual({ x: 0.5, y: 0.96 });
  });

  it('isOpaque', () => {
    expect(isOpaque(image(3, 3, red))).toBe(true);
    expect(isOpaque(fig)).toBe(false);
  });
});

describe('removeBackground', () => {
  const white = [255, 255, 255, 255];
  const nearWhite = [246, 248, 250, 255];
  const blue = [20, 40, 200, 255];

  it('clears the border-connected background and keeps the figure', () => {
    // White background (with slight noise), a blue square in the middle with a white "eye" inside.
    const px = image(12, 12, white, (x, y) => {
      if (x >= 3 && x <= 8 && y >= 3 && y <= 8) return x === 5 && y === 5 ? white : blue;
      return (x + y) % 3 === 0 ? nearWhite : null;
    });
    expect(dominantBorderColor(px, 12, 12)).not.toBeNull();
    const cleared = removeBackground(px, 12, 12);
    expect(cleared).toBe(144 - 36);
    expect(alphaAt(px, 12, 0, 0)).toBe(0);
    expect(alphaAt(px, 12, 5, 5)).toBe(255); // enclosed white stays
    expect(alphaAt(px, 12, 6, 6)).toBe(255);
    expect(alphaAt(px, 12, 3, 5)).toBeLessThan(255); // edge softened
  });

  it('does nothing on an already transparent picture', () => {
    const px = image(5, 5, [0, 0, 0, 0]);
    expect(removeBackground(px, 5, 5)).toBe(0);
  });
});

describe('clipIdFrom', () => {
  it('makes safe, unique ids', () => {
    const taken = new Set(['happy']);
    expect(clipIdFrom('Happy.PNG', taken)).toBe('happy-2');
    expect(clipIdFrom('开心 1.gif', new Set())).toBe('1');
    expect(clipIdFrom('开心.gif', new Set())).toBe('clip');
  });
});
