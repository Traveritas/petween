// Global desktop coordinates = physical pixels ÷ primary monitor scale (docs/01 §2).
// On one monitor this equals the stage's CSS pixels; across mixed-DPI monitors it stays consistent.

import type { Point } from '../api/types';

export interface StageInfo {
  label: string;
  /** Work area, physical pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export class Coords {
  constructor(
    readonly layout: StageInfo[],
    readonly self: StageInfo,
  ) {}

  get primaryScale() {
    return this.layout[0]?.scale ?? 1;
  }

  physToGlobal(px: number, py: number): Point {
    const p = this.primaryScale;
    return { x: px / p, y: py / p };
  }

  /** Global → this stage's CSS pixels. */
  toLocal(g: Point): Point {
    const p = this.primaryScale;
    return { x: (g.x * p - this.self.x) / this.self.scale, y: (g.y * p - this.self.y) / this.self.scale };
  }

  /** This stage's CSS pixels → global. */
  toGlobal(l: Point): Point {
    const p = this.primaryScale;
    return { x: (this.self.x + l.x * this.self.scale) / p, y: (this.self.y + l.y * this.self.scale) / p };
  }

  /** CSS px on this stage per global px (1 on the primary). */
  get cssPerGlobal() {
    return this.primaryScale / this.self.scale;
  }

  /** Stage work area in global coordinates. */
  static globalRect(s: StageInfo, primaryScale: number) {
    return { x: s.x / primaryScale, y: s.y / primaryScale, width: s.w / primaryScale, height: s.h / primaryScale };
  }
}
