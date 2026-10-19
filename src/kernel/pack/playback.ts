// Clip playback clock: which frame to show, segment flow (enter → loop → exit), markers, loop wraps.
// Pure and time-driven so it can be tested without a renderer.

import type { ClipDef } from '../../api/types';

export type Segment = 'enter' | 'loop' | 'exit';

export interface PlaybackTick {
  frame: number;
  markers: string[];
  /** The loop segment wrapped around during this tick. */
  wrapped: boolean;
  /** The exit segment reached its last frame. */
  ended: boolean;
}

export class ClipPlayback {
  segment: Segment;
  private segStart: number;
  private lastFrame = -1;
  readonly count: number;

  constructor(
    readonly id: string,
    readonly clip: ClipDef,
    now: number,
    frameCount: number,
  ) {
    this.count = clip.type === 'frames' ? Math.max(1, frameCount) : 1;
    this.segment = this.range('enter') ? 'enter' : 'loop';
    this.segStart = now;
  }

  private range(seg: Segment): [number, number] | null {
    const s = this.clip.segments?.[seg];
    if (s) return [Math.max(0, Math.min(s[0], this.count - 1)), Math.max(0, Math.min(s[1], this.count - 1))];
    return seg === 'loop' ? [0, this.count - 1] : null;
  }

  get animated() {
    return this.count > 1;
  }

  /** Play the exit segment; returns false when the clip has none. */
  startExit(now: number): boolean {
    if (!this.range('exit')) return false;
    this.segment = 'exit';
    this.segStart = now;
    this.lastFrame = -1;
    return true;
  }

  tick(now: number): PlaybackTick {
    const res: PlaybackTick = { frame: 0, markers: [], wrapped: false, ended: false };
    if (this.count <= 1) {
      res.ended = this.segment === 'exit';
      return res;
    }
    const fps = Math.max(1, this.clip.fps ?? 12);
    let [a, b] = this.range(this.segment)!;
    let len = b - a + 1;
    let n = Math.floor(((now - this.segStart) / 1000) * fps);

    if (this.segment === 'enter' && n >= len) {
      this.segment = 'loop';
      this.segStart += (len / fps) * 1000;
      this.lastFrame = b;
      [a, b] = this.range('loop')!;
      len = b - a + 1;
      n = Math.floor(((now - this.segStart) / 1000) * fps);
    }

    let frame: number;
    if (this.segment === 'loop') {
      frame = a + (((n % len) + len) % len);
      if (this.lastFrame >= a && this.lastFrame <= b && frame < this.lastFrame) res.wrapped = true;
    } else {
      frame = a + Math.min(n, len - 1);
      res.ended = this.segment === 'exit' && n >= len - 1;
    }

    // Markers on frames passed since the previous tick.
    const markers = this.clip.markers;
    if (markers && frame !== this.lastFrame) {
      for (const [f, name] of Object.entries(markers)) {
        const fi = Number(f);
        const passed = res.wrapped
          ? fi > this.lastFrame || fi <= frame
          : fi > this.lastFrame && fi <= frame;
        if (passed) res.markers.push(name);
      }
    }
    this.lastFrame = frame;
    res.frame = frame;
    return res;
  }
}
