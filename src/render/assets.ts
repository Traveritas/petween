// Clip images: decoded once per URL, with a low-resolution alpha mask for hit testing (docs/03 §2).

export interface Asset {
  url: string;
  /** Object URL used by the DOM (the source may be served no-store). */
  displayUrl: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  frameW: number;
  frameH: number;
  /** Alpha of the whole sheet at `maskScale`. */
  mask: Uint8Array;
  maskW: number;
  maskH: number;
  maskScale: number;
}

/** Longest frame edge in the mask. */
const MASK_EDGE = 128;

export class AssetCache {
  private ready = new Map<string, Asset>();
  private pending = new Map<string, Promise<Asset | null>>();
  onLoaded?: (a: Asset) => void;

  key(url: string, columns: number, count: number) {
    return `${url}#${columns}x${count}`;
  }

  get(url: string, columns = 1, count = 1): Asset | undefined {
    const a = this.ready.get(this.key(url, columns, count));
    if (!a) void this.load(url, columns, count);
    return a;
  }

  load(url: string, columns = 1, count = 1): Promise<Asset | null> {
    const k = this.key(url, columns, count);
    const hit = this.ready.get(k);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(k);
    if (!p) {
      p = this.decode(url, columns, count)
        .then((a) => {
          this.ready.set(k, a);
          this.onLoaded?.(a);
          return a;
        })
        .catch((e) => {
          console.error(`load ${url} failed`, e);
          return null;
        });
      this.pending.set(k, p);
    }
    return p;
  }

  private async decode(url: string, columns: number, count: number): Promise<Asset> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const cols = Math.max(1, Math.min(columns, count));
    const rows = Math.max(1, Math.ceil(count / cols));
    const frameW = bmp.width / cols;
    const frameH = bmp.height / rows;
    const maskScale = Math.min(1, MASK_EDGE / Math.max(frameW, frameH));
    const maskW = Math.max(1, Math.round(bmp.width * maskScale));
    const maskH = Math.max(1, Math.round(bmp.height * maskScale));
    const c = new OffscreenCanvas(maskW, maskH);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0, maskW, maskH);
    const px = g.getImageData(0, 0, maskW, maskH).data;
    const mask = new Uint8Array(maskW * maskH);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3];
    const asset: Asset = {
      url,
      displayUrl: URL.createObjectURL(blob),
      width: bmp.width,
      height: bmp.height,
      columns: cols,
      rows,
      frameW,
      frameH,
      mask,
      maskW,
      maskH,
      maskScale,
    };
    bmp.close();
    return asset;
  }
}

const opaqueCache = new WeakMap<Asset, Map<number, { x: number; y: number; w: number; h: number } | null>>();

/** Visible-pixel box of one frame, in frame pixels (from the mask; cached). null = fully transparent. */
export function opaqueBox(a: Asset, frame: number): { x: number; y: number; w: number; h: number } | null {
  let m = opaqueCache.get(a);
  if (!m) opaqueCache.set(a, (m = new Map()));
  if (m.has(frame)) return m.get(frame)!;
  const col = frame % a.columns;
  const row = Math.floor(frame / a.columns);
  const x0 = Math.floor(col * a.frameW * a.maskScale), y0 = Math.floor(row * a.frameH * a.maskScale);
  const x1 = Math.min(a.maskW, Math.ceil((col + 1) * a.frameW * a.maskScale));
  const y1 = Math.min(a.maskH, Math.ceil((row + 1) * a.frameH * a.maskScale));
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (a.mask[y * a.maskW + x] > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const box = maxX < 0 ? null : { x: (minX - x0) / a.maskScale, y: (minY - y0) / a.maskScale, w: (maxX - minX + 1) / a.maskScale, h: (maxY - minY + 1) / a.maskScale };
  m.set(frame, box);
  return box;
}

/** Alpha (0..255) at frame-local pixel (u, v) of `frame`. */
export function alphaAt(a: Asset, frame: number, u: number, v: number): number {
  if (u < 0 || v < 0 || u >= a.frameW || v >= a.frameH) return 0;
  const col = frame % a.columns;
  const row = Math.floor(frame / a.columns);
  const mx = Math.floor((col * a.frameW + u) * a.maskScale);
  const my = Math.floor((row * a.frameH + v) * a.maskScale);
  if (mx < 0 || my < 0 || mx >= a.maskW || my >= a.maskH) return 0;
  return a.mask[my * a.maskW + mx];
}
