// Import pipeline, the browser half (docs/03 §2): any picture / animation / short video → one
// clip: a still or a WebP spritesheet, shrunk to ≤ 512 px, trimmed to the visible figure, with the
// anchor on its feet. Decoding uses what the WebView already has (ImageDecoder, <video>), so no
// ffmpeg is needed. The files are produced here; writing them into a pack is the caller's job.

import type { ClipDef } from '../../api/types';
import { clipIdFrom, fitScale, footAnchor, fpsFromDelays, isOpaque, MAX_FRAMES, MAX_SECONDS, opaqueBox, padBox, removeBackground, sheetLayout, thinFrames, unionBox, type Box } from './process';

export interface ImportOptions {
  /** Make a solid background colour transparent (AI pictures on white / green). */
  removeBackground?: boolean;
  /** 0..255; how far from the background colour still counts as background. */
  tolerance?: number;
  /** Video sampling rate. */
  videoFps?: number;
}

export interface ImportResult {
  /** Suggested clip id (unique against `taken`). */
  id: string;
  /** Path inside the pack, e.g. `clips/happy-3fa1c2d4.webp`. */
  path: string;
  bytes: Uint8Array;
  clip: ClipDef;
  /** Frame size after import. */
  width: number;
  height: number;
  warnings: string[];
}

interface Frame {
  canvas: OffscreenCanvas;
  delay: number;
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
const ANIMATABLE = ['image/gif', 'image/png', 'image/apng', 'image/webp', 'image/avif'];

function mimeOf(file: File) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return { gif: 'image/gif', png: 'image/png', apng: 'image/apng', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext ?? ''] ?? '';
}

function toCanvas(src: CanvasImageSource, w: number, h: number): OffscreenCanvas {
  const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// ---------- decoding ----------

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}

async function decodeImage(file: File, mime: string, warnings: string[]): Promise<Frame[]> {
  const Decoder = (globalThis as { ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => ImageDecoderLike }).ImageDecoder;
  if (Decoder && ANIMATABLE.includes(mime)) {
    const dec = new Decoder({ data: await file.arrayBuffer(), type: mime === 'image/apng' ? 'image/png' : mime });
    try {
      await dec.tracks.ready;
      const count = dec.tracks.selectedTrack?.frameCount ?? 1;
      if (count > 1) {
        const frames: Frame[] = [];
        let elapsed = 0;
        for (let i = 0; i < count; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          const delay = (image.duration ?? 100_000) / 1000;
          frames.push({ canvas: toCanvas(image, image.displayWidth, image.displayHeight), delay });
          image.close();
          elapsed += delay;
          if (elapsed >= MAX_SECONDS * 1000) {
            if (i < count - 1) warnings.push(`动画超过 ${MAX_SECONDS} 秒，只保留了前 ${MAX_SECONDS} 秒`);
            break;
          }
        }
        return frames;
      }
    } finally {
      dec.close();
    }
  }
  const bmp = await createImageBitmap(file);
  const frame = { canvas: toCanvas(bmp, bmp.width, bmp.height), delay: 0 };
  bmp.close();
  return [frame];
}

async function decodeVideo(file: File, fps: number, warnings: string[]): Promise<Frame[]> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((ok, fail) => {
      v.onloadeddata = () => ok();
      v.onerror = () => fail(new Error('这个视频格式打不开（试试 WebM 或 MP4）'));
    });
    let duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('读不出视频时长');
    if (duration > MAX_SECONDS) {
      warnings.push(`视频超过 ${MAX_SECONDS} 秒，只保留了前 ${MAX_SECONDS} 秒`);
      duration = MAX_SECONDS;
    }
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(duration * fps)));
    const frames: Frame[] = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.min(duration - 0.001, i / fps);
      await new Promise<void>((ok) => (v.onseeked = () => ok()));
      frames.push({ canvas: toCanvas(v, v.videoWidth, v.videoHeight), delay: 1000 / fps });
    }
    return frames;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

// ---------- the pipeline ----------

export async function importFile(file: File, taken: Set<string>, opts: ImportOptions = {}): Promise<ImportResult> {
  const warnings: string[] = [];
  const mime = mimeOf(file);
  const isVideo = mime.startsWith('video/') || VIDEO_EXT.test(file.name);
  if (!isVideo && !mime.startsWith('image/')) throw new Error(`不认识的文件类型：${file.name}`);
  let frames = isVideo ? await decodeVideo(file, opts.videoFps ?? 12, warnings) : await decodeImage(file, mime, warnings);
  if (!frames.length) throw new Error('没有读出任何画面');

  if (frames.length > MAX_FRAMES) {
    const keep = thinFrames(frames.length, MAX_FRAMES);
    const step = frames.length / keep.length;
    frames = keep.map((i) => ({ ...frames[i], delay: frames[i].delay * step }));
    warnings.push(`帧数太多，均匀抽取到 ${MAX_FRAMES} 帧`);
  }

  // 1. Shrink, read pixels, optionally drop the background.
  const src = frames[0].canvas;
  const s = fitScale(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  const pixels = frames.map((f) => {
    const c = toCanvas(f.canvas, w, h);
    return c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  });
  const opaque = pixels.every((p) => isOpaque(p.data));
  if (opts.removeBackground) {
    let cleared = 0;
    for (const p of pixels) cleared += removeBackground(p.data, w, h, opts.tolerance ?? 40);
    if (!cleared) warnings.push('没找到可以去掉的纯色背景');
  } else if (opaque) {
    warnings.push(isVideo ? '视频没有透明背景（需要带透明的 WebM）；可以勾选「去掉纯色背景」' : '图片没有透明背景；可以勾选「去掉纯色背景」');
  }

  // 2. Trim to the figure (union over all frames, so the clip doesn't wobble), with a small margin.
  const union = unionBox(pixels.map((p) => opaqueBox(p.data, w, h)));
  const crop: Box = union ? padBox(union, Math.round(Math.max(w, h) * 0.02), w, h) : { x: 0, y: 0, w, h };
  const cropped = pixels.map((p) => {
    const c = new OffscreenCanvas(crop.w, crop.h);
    c.getContext('2d')!.putImageData(p, -crop.x, -crop.y);
    return c;
  });

  // 3. Feet: from the frames laid over each other (the lowest point any frame reaches).
  const stack = new OffscreenCanvas(crop.w, crop.h);
  const sg = stack.getContext('2d', { willReadFrequently: true })!;
  for (const c of cropped) sg.drawImage(c, 0, 0);
  const anchor = footAnchor(sg.getImageData(0, 0, crop.w, crop.h).data, crop.w, crop.h);

  // 4. One picture: the frame itself, or a sheet.
  const n = cropped.length;
  const { columns, rows } = sheetLayout(n, crop.w, crop.h);
  const sheet = new OffscreenCanvas(crop.w * columns, crop.h * rows);
  const g = sheet.getContext('2d')!;
  cropped.forEach((c, i) => g.drawImage(c, (i % columns) * crop.w, Math.floor(i / columns) * crop.h));
  const bytes = new Uint8Array(await (await sheet.convertToBlob({ type: 'image/webp', quality: 0.92 })).arrayBuffer());

  const id = clipIdFrom(file.name, taken);
  const path = `clips/${id}-${await shortHash(bytes)}.webp`;
  const clip: ClipDef =
    n > 1
      ? { type: 'frames', source: path, fps: fpsFromDelays(frames.map((f) => f.delay)), frames: { count: n, columns }, anchor }
      : { type: 'still', source: path, anchor };
  return { id, path, bytes, clip, width: crop.w, height: crop.h, warnings };
}

async function shortHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
