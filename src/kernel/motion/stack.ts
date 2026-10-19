// The motion channel (docs/02 §3): an additive stack. Every active motion contributes, in fixed layer order.

import type { MotionContext, MotionHandle, MotionLayer, MotionSource } from '../../api/types';
import { Emitter } from '../emitter';
import { applyDelta, identity, LAYERS, type Transform } from './compose';

/** docs/03 §6: a motion over budget for this many consecutive frames is stopped. */
export const BUDGET_MS = 1;
export const BUDGET_FRAMES = 30;

let seq = 0;

class Entry implements MotionHandle {
  readonly order = ++seq;
  start = -1;
  /** Time already evaluated; markers in (lastT, t] fire this frame. */
  lastT = -1;
  over = 0;
  active = true;
  readonly endEv = new Emitter<void>();
  readonly markerEv = new Emitter<string>();

  constructor(
    private stack: MotionStack,
    readonly source: MotionSource,
    readonly layer: MotionLayer,
    readonly blend: 'add' | 'override',
    public weight: number,
    readonly owner: string,
    readonly params: Record<string, unknown>,
  ) {}

  setWeight(w: number) {
    this.weight = w;
  }
  onEnd(fn: () => void) {
    return this.endEv.on(fn);
  }
  onMarker(fn: (name: string) => void) {
    return this.markerEv.on(fn);
  }
  dispose() {
    this.stack.remove(this);
  }
}

export class MotionStack {
  private entries: Entry[] = [];
  /** Reports motions stopped for blowing the frame budget. */
  onOverBudget?: (owner: string) => void;

  add(
    source: MotionSource,
    opts: { layer?: MotionLayer; blend?: 'add' | 'override'; weight?: number },
    owner: string,
    params: Record<string, unknown> = {},
  ): MotionHandle {
    const e = new Entry(this, source, opts.layer ?? 'plugin', opts.blend ?? 'add', opts.weight ?? 1, owner, params);
    this.entries.push(e);
    this.entries.sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || a.order - b.order);
    return e;
  }

  remove(e: Entry) {
    const i = this.entries.indexOf(e);
    if (i < 0) return;
    this.entries.splice(i, 1);
    e.active = false;
    try {
      e.source.dispose?.();
    } catch (err) {
      console.error(err);
    }
  }

  /** Inspector view of the running motions. */
  describe() {
    return this.entries.map((e) => ({ owner: e.owner, layer: e.layer, blend: e.blend, weight: e.weight }));
  }

  get size() {
    return this.entries.length;
  }

  /** Anything running above the ambient base layer (transitions, physics, plugin, interaction). */
  get hasForeground() {
    return this.entries.some((e) => e.layer !== 'base');
  }

  evaluate(now: number, dt: number, ctxFor: (params: Record<string, unknown>) => MotionContext): Transform {
    const acc = identity();
    const finished: Entry[] = [];
    for (const e of [...this.entries]) {
      if (e.start < 0) e.start = now;
      const t = now - e.start;
      const dur = e.source.duration;
      const tt = dur !== null ? Math.min(t, dur) : t;
      const t0 = performance.now();
      try {
        applyDelta(acc, e.source.evaluate(tt, dt, ctxFor(e.params)), e.blend, e.weight);
      } catch (err) {
        console.error(`motion from ${e.owner} threw`, err);
        finished.push(e);
        continue;
      }
      const cost = performance.now() - t0;
      e.over = cost > BUDGET_MS ? e.over + 1 : 0;
      if (e.over >= BUDGET_FRAMES) {
        this.remove(e);
        this.onOverBudget?.(e.owner);
        continue;
      }
      // Markers crossed since last frame (inclusive of the end).
      const markers = e.source.markers;
      if (markers) {
        for (const [ms, name] of Object.entries(markers)) {
          const m = Number(ms);
          if (m > e.lastT && m <= tt) e.markerEv.emit(name);
        }
      }
      e.lastT = tt;
      if ((dur !== null && t >= dur) || e.source.isDone?.()) finished.push(e);
    }
    for (const e of finished) {
      if (!e.active) continue;
      this.remove(e);
      e.endEv.emit();
    }
    return acc;
  }

  clear() {
    for (const e of [...this.entries]) this.remove(e);
  }
}
