// Import pipeline, the pure parts (docs/03 §2 导入管线): sizes, sheet layout, trimming, background
// removal, frame rate. No DOM here, so all of it is unit-tested.

/** Longest frame edge after import (docs/03 §2). */
export const MAX_EDGE = 512;
/** Longest clip we keep as frames (docs/03 §2: ≤ 10 s). */
export const MAX_SECONDS = 10;
/** Frame cap per clip; longer sequences are thinned evenly. */
export const MAX_FRAMES = 120;
/** WebP's hard limit on either side. */
export const MAX_SHEET_EDGE = 16383;

/** Scale (≤ 1) that brings the longest edge down to `maxEdge`. */
export function fitScale(w: number, h: number, maxEdge = MAX_EDGE): number {
  const edge = Math.max(w, h);
  return edge > maxEdge ? maxEdge / edge : 1;
}

/** A roughly square grid that stays under the WebP size limit. */
export function sheetLayout(count: number, frameW: number, frameH: number): { columns: number; rows: number } {
  const n = Math.max(1, count);
  let columns = Math.max(1, Math.ceil(Math.sqrt((n * frameH) / Math.max(1, frameW))));
  columns = Math.min(columns, n, Math.max(1, Math.floor(MAX_SHEET_EDGE / Math.max(1, frameW))));
  const rows = Math.ceil(n / columns);
  if (rows * frameH > MAX_SHEET_EDGE) throw new Error('帧太多或太大，放不进一张图');
  return { columns, rows };
}

/** Indices to keep when thinning `count` frames down to `max`, evenly spread. */
export function thinFrames(count: number, max = MAX_FRAMES): number[] {
  if (count <= max) return [...Array(count).keys()];
  return [...Array(max).keys()].map((i) => Math.floor((i * count) / max));
}

/** Playback rate from per-frame delays (ms), clamped to 1..30. Missing delays count as 100 ms. */
export function fpsFromDelays(delays: number[]): number {
  if (!delays.length) return 12;
  const avg = delays.reduce((s, d) => s + (d > 0 ? d : 100), 0) / delays.length;
  return Math.max(1, Math.min(30, Math.round(1000 / avg)));
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Box of pixels with alpha above `threshold`, or null when the frame is empty. */
export function opaqueBox(px: Uint8ClampedArray, w: number, h: number, threshold = 8): Box | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function unionBox(boxes: (Box | null)[]): Box | null {
  const real = boxes.filter((b): b is Box => !!b);
  if (!real.length) return null;
  const x = Math.min(...real.map((b) => b.x));
  const y = Math.min(...real.map((b) => b.y));
  const r = Math.max(...real.map((b) => b.x + b.w));
  const bt = Math.max(...real.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bt - y };
}

/** Grow a box by `pad` px on each side, clipped to the image. */
export function padBox(b: Box, pad: number, w: number, h: number): Box {
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, w: Math.min(w, b.x + b.w + pad) - x, h: Math.min(h, b.y + b.h + pad) - y };
}

/**
 * Feet-centre anchor of a trimmed picture: horizontally centred on the visible pixels of the bottom
 * rows, vertically at the lowest visible row. Falls back to (0.5, 0.96).
 */
export function footAnchor(px: Uint8ClampedArray, w: number, h: number, threshold = 8): { x: number; y: number } {
  let bottom = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > threshold) bottom = y;
  }
  if (bottom < 0) return { x: 0.5, y: 0.96 };
  // Centre of mass of the lowest 8% of the figure, so a tail or a shadow off to one side matters less.
  const band = Math.max(1, Math.round(h * 0.08));
  let sum = 0, n = 0;
  for (let y = Math.max(0, bottom - band); y <= bottom; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > threshold) {
        sum += x;
        n++;
      }
    }
  }
  return { x: round3((n ? sum / n + 0.5 : w / 2) / w), y: round3((bottom + 1) / h) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** True when no pixel is noticeably transparent. */
export function isOpaque(px: Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return false;
  return true;
}

/**
 * Remove a solid background (typical for AI pictures on white / green): flood-fill from every border
 * pixel through pixels whose colour is within `tolerance` (0..255, per-channel distance) of the
 * border's dominant colour, making them transparent. Interior areas of the same colour that don't
 * touch the border are kept. Edges get a one-pixel soft fade. Mutates `px`; returns how many pixels
 * were cleared.
 */
export function removeBackground(px: Uint8ClampedArray, w: number, h: number, tolerance = 40): number {
  const bg = dominantBorderColor(px, w, h);
  if (!bg) return 0;
  const near = (i: number) => px[i + 3] > 0 && Math.max(Math.abs(px[i] - bg[0]), Math.abs(px[i + 1] - bg[1]), Math.abs(px[i + 2] - bg[2])) <= tolerance;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const k = y * w + x;
    if (seen[k]) return;
    seen[k] = 1;
    if (near(k * 4)) stack.push(k);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  let cleared = 0;
  const cleared_ = new Uint8Array(w * h);
  while (stack.length) {
    const k = stack.pop()!;
    px[k * 4 + 3] = 0;
    cleared_[k] = 1;
    cleared++;
    const x = k % w, y = (k - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  // Soften the cut: kept pixels next to a cleared one lose some alpha.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (cleared_[k]) continue;
      const touches = (x > 0 && cleared_[k - 1]) || (x < w - 1 && cleared_[k + 1]) || (y > 0 && cleared_[k - w]) || (y < h - 1 && cleared_[k + w]);
      if (touches) px[k * 4 + 3] = Math.round(px[k * 4 + 3] * 0.6);
    }
  }
  return cleared;
}

/** Most common (coarsely quantised) colour on the border, among opaque pixels. */
export function dominantBorderColor(px: Uint8ClampedArray, w: number, h: number): [number, number, number] | null {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (px[i + 3] < 250) return;
    const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += px[i];
    c.g += px[i + 1];
    c.b += px[i + 2];
    counts.set(key, c);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  if (!best) return null;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

/** A file-system-safe clip id from a file name: ascii letters, digits, dashes; never empty. */
export function clipIdFrom(fileName: string, taken: Set<string>): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'clip';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
