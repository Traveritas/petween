// Glue behaviour against fake kernel objects: leases, frame subscription, mid-air catch, state holds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Disposable, InputEvent, Lease, LeaseRequest, PetHandle, PluginContext, Point, Rect } from '../../api/types';
import plugin, { manifest } from './index';

class FakePosChannel {
  stack: FakeLease[] = [];
  base: Point = { x: 0, y: 0 };
  request(req: LeaseRequest<Point>): Lease<Point> {
    if (req.preempt) {
      for (const l of this.stack.filter((s) => s.priority <= req.priority)) l.revoke();
    }
    const lease = new FakeLease(this, req.priority, req.value);
    this.stack.push(lease);
    return lease as unknown as Lease<Point>;
  }
  get value(): Point { return this.stack.at(-1)?.value ?? this.base; }
}

class FakeLease {
  revoked = false;
  private revokedFns: (() => void)[] = [];
  constructor(private ch: FakePosChannel, readonly priority: number, public value: Point) {}
  update(v: Point) { this.value = v; }
  release() {
    if (this.revoked) return;
    this.ch.stack = this.ch.stack.filter((s) => s !== this);
    this.ch.base = this.value; // kernel commits the last value as base
    this.revoked = true;
  }
  revoke() {
    if (this.revoked) return;
    this.revoked = true;
    this.ch.stack = this.ch.stack.filter((s) => s !== this);
    this.revokedFns.forEach((f) => f());
  }
  onRevoked(fn: () => void): Disposable { this.revokedFns.push(fn); return { dispose() {} }; }
}

const SCREEN: Rect = { x: 0, y: 0, width: 1000, height: 800 };

function setup(settings: Record<string, unknown> = {}) {
  const pos = new FakePosChannel();
  pos.base = { x: 500, y: 700 };
  let onInput: (e: InputEvent) => void = () => {};
  const states: { key: string; released: boolean }[] = [];
  const plays: unknown[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let frameFn: ((now: number, dt: number) => void) | null = null;
  let frameSubs = 0;

  const pet = {
    get position() { return pos.value; },
    get opaqueBounds(): Rect { const p = pos.value; return { x: p.x - 30, y: p.y - 100, width: 60, height: 100 }; },
    on: (ev: string, fn: (e: InputEvent) => void) => { if (ev === 'input') onInput = fn; return { dispose() {} }; },
    channel: () => pos,
    motion: { add: () => ({ dispose() {} }) },
    play: (m: unknown) => { plays.push(m); return {}; },
    showState: (key: string) => {
      const s = { key, released: false };
      states.push(s);
      return { release: () => { s.released = true; } };
    },
  } as unknown as PetHandle;

  const ctx = {
    pets: { list: () => [pet], on: () => ({ dispose() {} }) },
    desktop: { screens: () => [SCREEN], on: () => ({ dispose() {} }) },
    settings: { get: (k: string, fb?: unknown) => (k in settings ? settings[k] : fb) },
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return { dispose() { t.live = false; } };
    },
    requestFrame: (fn: (now: number, dt: number) => void) => {
      frameFn = fn;
      frameSubs++;
      return { dispose() { if (frameFn === fn) frameFn = null; frameSubs--; } };
    },
  } as unknown as PluginContext;

  void plugin.activate(ctx);
  const input = (type: InputEvent['type'], x: number, y: number) => onInput({ type, x, y, button: 0 });
  const tick = (n: number, dt = 16) => { for (let i = 0; i < n && frameFn; i++) frameFn(0, dt); };
  return { pos, input, tick, states, plays, timers, frameActive: () => frameFn !== null, frameSubs: () => frameSubs };
}

/** Drag right at 2000 px/s ending at the given point, using a controllable clock. */
function fling(h: ReturnType<typeof setup>, clock: { t: number }, speedPerMs: number) {
  h.input('drag-start', 500, 600);
  for (let i = 1; i <= 6; i++) {
    clock.t += 16;
    h.input('drag-move', 500 + i * 16 * speedPerMs, 600);
  }
  h.input('drag-end', 500 + 6 * 16 * speedPerMs, 600);
}

describe('physics plugin glue', () => {
  const clock = { t: 1000 };
  beforeEach(() => {
    clock.t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  });
  afterEach(() => vi.restoreAllMocks());

  it('manifest declares channels and state keys', () => {
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.contributes?.channels).toEqual(['position', 'motion', 'state']);
    expect(manifest.contributes?.stateKeys?.map((s) => s.key)).toEqual(['physics.hit', 'physics.slide']);
  });

  it('slow release: just drops, no flight, no frame subscription', () => {
    const h = setup();
    fling(h, clock, 0.1); // 100 px/s < minThrowSpeed
    expect(h.frameActive()).toBe(false);
    expect(h.pos.stack).toHaveLength(0);
    expect(h.pos.base.x).toBeCloseTo(500 + 6 * 1.6);
  });

  it('fast release flies under a lease, keeps the box inside, settles and releases (frame subscription gone)', () => {
    const h = setup();
    fling(h, clock, 2); // 2000 px/s
    expect(h.frameActive()).toBe(true);
    expect(h.pos.stack.map((l) => l.priority)).toEqual([85]);
    for (let i = 0; i < 3000 && h.frameActive(); i++) {
      h.tick(1);
      const p = h.pos.value;
      expect(p.x - 30).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x + 30).toBeLessThanOrEqual(1000 + 1e-6);
      expect(p.y).toBeLessThanOrEqual(800 + 1e-6);
    }
    expect(h.frameActive()).toBe(false);
    expect(h.frameSubs()).toBe(0);
    expect(h.pos.stack).toHaveLength(0);
    expect(h.pos.base.y).toBe(800); // feet on the floor of the work area
    expect(h.plays.length).toBeGreaterThan(1); // grab + at least one bounce squash
  });

  it('mid-air catch: the drag lease preempts the flight, simulation stops', () => {
    const h = setup();
    fling(h, clock, 2);
    h.tick(5);
    const caught = { ...h.pos.value };
    h.input('drag-start', caught.x, caught.y - 50);
    expect(h.frameActive()).toBe(false);
    expect(h.pos.stack.map((l) => l.priority)).toEqual([95]);
    expect(h.pos.value).toEqual(caught);
    h.input('drag-move', caught.x + 10, caught.y - 50);
    expect(h.pos.value.x).toBe(caught.x + 10);
  });

  it('hitStateMs > 0 holds physics.hit and releases it on the timer; 0 never touches state', () => {
    const on = setup({ hitStateMs: 400 });
    fling(on, clock, 2);
    for (let i = 0; i < 3000 && on.frameActive() && !on.states.length; i++) on.tick(1);
    expect(on.states.map((s) => s.key)).toContain('physics.hit');
    const t = on.timers.find((x) => x.ms === 400 && x.live)!;
    t.fn();
    expect(on.states[0].released).toBe(true);

    const off = setup();
    fling(off, clock, 2);
    for (let i = 0; i < 3000 && off.frameActive(); i++) off.tick(1);
    expect(off.states).toEqual([]);
  });

  it('slideState holds physics.slide during the slide and drops it on settle', () => {
    const h = setup({ slideState: true });
    h.pos.base = { x: 100, y: 800 };
    // Flat fast throw along the floor: slides.
    h.input('drag-start', 100, 790);
    for (let i = 1; i <= 6; i++) { clock.t += 16; h.input('drag-move', 100 + i * 16 * 1.5, 790 + i * 1.6); }
    h.input('drag-end', 100 + 6 * 24, 799);
    for (let i = 0; i < 3000 && h.frameActive(); i++) h.tick(1);
    const slide = h.states.filter((s) => s.key === 'physics.slide');
    expect(slide.length).toBe(1);
    expect(slide[0].released).toBe(true);
  });
});
