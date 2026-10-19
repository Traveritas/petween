// Pure throw core (port of petween-physics v0 physics.ts + throw-controller.ts flight logic).
// No kernel / DOM access: time is injected by the caller, so every case is unit-testable to the pixel.
// Coordinates are global desktop px of the pet's ANCHOR (feet); y grows downward.

import type { Point, Rect } from '../../api/types';

export type Wall = 'left' | 'right' | 'top' | 'bottom';

/** Tunables, v0 names and defaults. Units: px, px/s, px/s², ms. */
export interface ThrowParams {
  gravity: number;
  restitution: number;
  /** Horizontal air drag per second: vx *= 1 - friction * dt. */
  friction: number;
  throwMultiplier: number;
  /** Release speed below this is a "park", not a throw. */
  minThrowSpeed: number;
  /** On the floor and slower than this → settled. */
  settleSpeed: number;
  maxSpeed: number;
  /** Energy-exhaustion guard: force-settle past this (e.g. restitution 1). */
  maxFlightMs: number;
  /** Predicted rebound height below which a floor hit becomes a ground slide. 0 = always bounce. */
  minBounceHeightPx: number;
  groundFriction: number;
  sampleWindowMs: number;
  /** Same-wall wall-hit debounce: corner jitter fires one event, not a burst. */
  effectDebounceMs: number;
}

export const DEFAULT_PARAMS: ThrowParams = {
  gravity: 3000,
  restitution: 0.6,
  friction: 0,
  throwMultiplier: 1,
  minThrowSpeed: 350,
  settleSpeed: 120,
  maxSpeed: 4000,
  maxFlightMs: 20_000,
  minBounceHeightPx: 12,
  groundFriction: 2,
  sampleWindowMs: 120,
  effectDebounceMs: 150,
};

export interface Range { min: number; max: number }

/** Same limits as v0 CONFIG_NUMERIC_FIELDS. */
export const PARAM_LIMITS: Record<keyof ThrowParams, Range> = {
  gravity: { min: 100, max: 100_000 },
  restitution: { min: 0, max: 1 },
  friction: { min: 0, max: 1 },
  throwMultiplier: { min: 0, max: 10 },
  minThrowSpeed: { min: 0, max: 10_000 },
  settleSpeed: { min: 0, max: 10_000 },
  maxSpeed: { min: 100, max: 100_000 },
  maxFlightMs: { min: 500, max: 600_000 },
  minBounceHeightPx: { min: 0, max: 2_000 },
  groundFriction: { min: 0, max: 50 },
  sampleWindowMs: { min: 10, max: 2_000 },
  effectDebounceMs: { min: 0, max: 5_000 },
};

/** Collision box as an offset from the anchor: left/top edge = anchor + (dx, dy). */
export interface Box {
  dx: number;
  dy: number;
  width: number;
  height: number;
}

/** Box from a global visible-pixel rect and the anchor it was measured against. */
export function boxFrom(rect: Rect, anchor: Point): Box {
  return { dx: rect.x - anchor.x, dy: rect.y - anchor.y, width: rect.width, height: rect.height };
}

/** Allowed anchor range such that the whole box stays inside `walls`. */
export interface Arena {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A box larger than the walls collapses the range to its min edge instead of thrashing. */
export function arenaFor(walls: Rect, box: Box): Arena {
  const minX = walls.x - box.dx;
  const minY = walls.y - box.dy;
  return {
    minX,
    minY,
    maxX: Math.max(minX, walls.x + walls.width - box.width - box.dx),
    maxY: Math.max(minY, walls.y + walls.height - box.height - box.dy),
  };
}

/** The screen containing p, else the nearest one by edge distance; null when there are none. */
export function pickScreen(screens: readonly Rect[], p: Point): Rect | null {
  let best: Rect | null = null;
  let bestD = Infinity;
  for (const s of screens) {
    const dx = Math.max(s.x - p.x, 0, p.x - (s.x + s.width));
    const dy = Math.max(s.y - p.y, 0, p.y - (s.y + s.height));
    const d = Math.hypot(dx, dy);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

// ---------- release velocity ----------

export interface Sample { x: number; y: number; t: number }
export interface Velocity { vx: number; vy: number }

/** Newest-last drag samples, bounded so a long drag does not grow without limit. */
export class VelocitySampler {
  private samples: Sample[] = [];

  reset(): void { this.samples = []; }

  push(x: number, y: number, t: number, windowMs: number): void {
    this.samples.push({ x, y, t });
    // Anything older than two windows can no longer enter the release computation.
    const cutoff = t - windowMs * 2;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }

  velocity(now: number, p: Pick<ThrowParams, 'sampleWindowMs' | 'throwMultiplier' | 'minThrowSpeed' | 'maxSpeed'>): Velocity | null {
    return releaseVelocity(this.samples, now, p);
  }
}

/**
 * displacement/time over the last window → × multiplier → clamp to maxSpeed.
 * null = no usable motion or below minThrowSpeed (a placement, not a throw).
 */
export function releaseVelocity(
  samples: readonly Sample[],
  now: number,
  p: Pick<ThrowParams, 'sampleWindowMs' | 'throwMultiplier' | 'minThrowSpeed' | 'maxSpeed'>,
): Velocity | null {
  // The oldest in-window sample is the reference: a short window tracks the final flick, not the whole drag.
  const start = now - p.sampleWindowMs;
  let first = 0;
  while (first < samples.length && samples[first].t < start) first++;
  if (samples.length - first < 2) return null;
  const from = samples[first];
  const to = samples[samples.length - 1];
  const dt = (to.t - from.t) / 1000;
  if (dt <= 0) return null;
  let vx = ((to.x - from.x) / dt) * p.throwMultiplier;
  let vy = ((to.y - from.y) / dt) * p.throwMultiplier;
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed) || speed < p.minThrowSpeed) return null;
  if (speed > p.maxSpeed) {
    const k = p.maxSpeed / speed;
    vx *= k;
    vy *= k;
  }
  return { vx, vy };
}

// ---------- integrator ----------

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Skidding on the floor after bounces fell below minBounceHeightPx. */
  sliding: boolean;
  /** Settled: further steps are no-ops. */
  resting: boolean;
}

/** dt clamp: a stalled frame must not teleport the pet through walls. */
export const MAX_STEP_MS = 40;
/** Floor-contact tolerance for the settle check (px). */
export const FLOOR_EPSILON_PX = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type StepParams = Pick<ThrowParams, 'gravity' | 'restitution' | 'friction' | 'settleSpeed' | 'minBounceHeightPx' | 'groundFriction'>;

export function stepBall(state: BallState, dtMs: number, p: StepParams, a: Arena): { state: BallState; walls: Wall[] } {
  if (state.resting) return { state: { ...state }, walls: [] };
  const dt = clamp(dtMs, 0, MAX_STEP_MS) / 1000;
  const restitution = clamp(p.restitution, 0, 1);
  const walls: Wall[] = [];
  let { x, y, vx, vy, sliding } = state;

  if (sliding) {
    // Slide = the no-more-impact phase: gravity off, side walls clamp without rebound or events.
    vx *= Math.max(0, 1 - Math.max(0, p.groundFriction) * dt);
    x += vx * dt;
    y = a.maxY;
    vy = 0;
    if (x <= a.minX) { x = a.minX; if (vx < 0) vx = 0; }
    else if (x >= a.maxX) { x = a.maxX; if (vx > 0) vx = 0; }
  } else {
    // Drag applies on bounce steps too, which gives the "vx damped across a bounce" feel.
    vx *= Math.max(0, 1 - Math.max(0, p.friction) * dt);
    vy += p.gravity * dt;
    x += vx * dt;
    y += vy * dt;

    // A wall is only reported when velocity pointed into it; resting against it is not a collision.
    if (x <= a.minX) {
      x = a.minX;
      if (vx < 0) { vx = -vx * restitution; walls.push('left'); }
    } else if (x >= a.maxX) {
      x = a.maxX;
      if (vx > 0) { vx = -vx * restitution; walls.push('right'); }
    }
    if (y <= a.minY) {
      y = a.minY;
      if (vy < 0) { vy = -vy * restitution; walls.push('top'); }
    } else if (y >= a.maxY) {
      y = a.maxY;
      if (vy > 0) {
        const bounceVy = vy * restitution;
        // Predicted rebound height vy²/2g; gravity <= 0 never slides (the height diverges).
        const height = p.gravity > 0 ? (bounceVy * bounceVy) / (2 * p.gravity) : Infinity;
        if (height < Math.max(0, p.minBounceHeightPx)) {
          vy = 0;
          sliding = true; // not an impact: no 'bottom' report
        } else {
          vy = -bounceVy;
          walls.push('bottom');
        }
      }
    }
  }

  const speed = sliding ? Math.abs(vx) : Math.hypot(vx, vy);
  if (y >= a.maxY - FLOOR_EPSILON_PX && speed < p.settleSpeed) {
    return { state: { x, y: a.maxY, vx: 0, vy: 0, sliding: false, resting: true }, walls };
  }
  return { state: { x, y, vx, vy, sliding, resting: false }, walls };
}

// ---------- flight ----------

export type ThrowEvent =
  | { type: 'wall-hit'; walls: Wall[] }
  | { type: 'slide-start' }
  | { type: 'settled' };

export interface FlightStep {
  x: number;
  y: number;
  events: ThrowEvent[];
}

/** One throw from release to settle. Time only advances through step(dt). */
export class Flight {
  private state: BallState;
  private elapsed = 0;
  private lastHit = new Map<Wall, number>();
  private done = false;

  constructor(start: Point, v: Velocity, private readonly params: ThrowParams) {
    this.state = { x: start.x, y: start.y, vx: v.vx, vy: v.vy, sliding: false, resting: false };
  }

  get position(): Point { return { x: this.state.x, y: this.state.y }; }
  get settled(): boolean { return this.done; }

  /** The arena may change every call (pose swap, monitor change); the flight follows. */
  step(dtMs: number, arena: Arena): FlightStep {
    if (this.done) return { ...this.position, events: [] };
    this.elapsed += Math.max(0, dtMs);
    const events: ThrowEvent[] = [];
    const wasSliding = this.state.sliding;
    const r = stepBall(this.state, dtMs, this.params, arena);
    this.state = r.state;

    const hits = r.walls.filter((w) => {
      const last = this.lastHit.get(w);
      if (last !== undefined && this.elapsed - last < this.params.effectDebounceMs) return false;
      this.lastHit.set(w, this.elapsed);
      return true;
    });
    if (hits.length) events.push({ type: 'wall-hit', walls: hits });
    if (!wasSliding && r.state.sliding) events.push({ type: 'slide-start' });

    if (r.state.resting || this.elapsed > this.params.maxFlightMs) {
      this.done = true;
      events.push({ type: 'settled' });
    }
    return { ...this.position, events };
  }
}
