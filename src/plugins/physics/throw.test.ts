import { describe, expect, it } from 'vitest';
import {
  arenaFor,
  boxFrom,
  DEFAULT_PARAMS,
  Flight,
  FLOOR_EPSILON_PX,
  MAX_STEP_MS,
  pickScreen,
  releaseVelocity,
  stepBall,
  VelocitySampler,
  type Arena,
  type BallState,
  type ThrowEvent,
} from './throw';
import { DEFAULT_SETTINGS, readSettings } from './settings';

const PARAMS = { ...DEFAULT_PARAMS, minBounceHeightPx: 0 }; // 0 = legacy bounce-always; slide tests override
/** 1000x800 walls, 100px box anchored at its top-left → anchor range x∈[0,900], y∈[0,700]. */
const ARENA: Arena = { minX: 0, maxX: 900, minY: 0, maxY: 700 };
const NOGRAV = { ...PARAMS, gravity: 0 };

const ball = (x: number, y: number, vx: number, vy: number): BallState => ({ x, y, vx, vy, sliding: false, resting: false });

describe('stepBall: free flight', () => {
  it('integrates one gravity step (semi-implicit Euler)', () => {
    const { state, walls } = stepBall(ball(500, 100, 0, 0), 40, PARAMS, ARENA);
    expect(state).toEqual({ x: 500, y: 100 + 3000 * 0.04 * 0.04, vx: 0, vy: 3000 * 0.04, sliding: false, resting: false });
    expect(walls).toEqual([]);
  });

  it('is a no-op once resting', () => {
    const resting: BallState = { x: 500, y: 700, vx: 0, vy: 0, sliding: false, resting: true };
    const r = stepBall(resting, 100, PARAMS, ARENA);
    expect(r.state).toEqual(resting);
    expect(r.walls).toEqual([]);
  });

  it('clamps dt to MAX_STEP_MS', () => {
    expect(stepBall(ball(500, 100, 0, 0), 10_000, PARAMS, ARENA)).toEqual(stepBall(ball(500, 100, 0, 0), MAX_STEP_MS, PARAMS, ARENA));
  });
});

describe('stepBall: walls', () => {
  it('bounces off each wall with restitution', () => {
    let r = stepBall(ball(-50, 400, -200, 0), 16, NOGRAV, ARENA);
    expect([r.state.x, r.walls]).toEqual([0, ['left']]);
    expect(r.state.vx).toBeCloseTo(120, 10);
    r = stepBall(ball(950, 400, 200, 0), 16, NOGRAV, ARENA);
    expect([r.state.x, r.walls]).toEqual([900, ['right']]);
    r = stepBall(ball(500, -30, 0, -100), 16, NOGRAV, ARENA);
    expect([r.state.y, r.walls]).toEqual([0, ['top']]);
    r = stepBall(ball(500, 750, 0, 400), 16, NOGRAV, ARENA);
    expect([r.state.y, r.walls, r.state.resting]).toEqual([700, ['bottom'], false]);
    expect(r.state.vy).toBeCloseTo(-240, 10);
  });

  it('clamps without reporting when already moving away', () => {
    const r = stepBall(ball(-50, 400, 200, 0), 16, NOGRAV, ARENA);
    expect(r.state.x).toBe(0);
    expect(r.state.vx).toBe(200);
    expect(r.walls).toEqual([]);
  });

  it('reports both walls on a corner hit', () => {
    const r = stepBall(ball(990, 790, 2000, 2000), 16, NOGRAV, ARENA);
    expect([r.state.x, r.state.y, r.walls]).toEqual([900, 700, ['right', 'bottom']]);
  });

  it('pins to the origin corner when the box fills the walls', () => {
    const r = stepBall(ball(500, 300, 500, 0), 16, NOGRAV, arenaFor({ x: 0, y: 0, width: 100, height: 100 }, { dx: 0, dy: 0, width: 500, height: 500 }));
    expect(r.state.x).toBe(0);
  });
});

describe('stepBall: friction and settle', () => {
  it('air drag decays vx and never reverses it', () => {
    expect(stepBall(ball(500, 400, 100, 0), 40, { ...NOGRAV, friction: 1 }, ARENA).state.vx).toBeCloseTo(96, 10);
    expect(stepBall(ball(500, 400, 100, 0), 40, { ...NOGRAV, friction: 100 }, ARENA).state.vx).toBe(0);
  });

  it('settles on the floor below settleSpeed and still reports the bounce', () => {
    const r = stepBall(ball(500, 700, 30, 100), 16, PARAMS, ARENA);
    expect(r.state).toEqual({ x: 500 + 30 * 0.016, y: 700, vx: 0, vy: 0, sliding: false, resting: true });
    expect(r.walls).toEqual(['bottom']);
  });

  it('does not settle mid-air', () => {
    expect(stepBall(ball(500, 100, 0, 50), 16, PARAMS, ARENA).state.resting).toBe(false);
  });

  it('treats floor contact within the epsilon as on-floor', () => {
    const r = stepBall({ x: 500, y: 700 - FLOOR_EPSILON_PX / 2, vx: 30, vy: -20, sliding: false, resting: false }, 16, PARAMS, ARENA);
    expect([r.state.resting, r.state.y]).toEqual([true, 700]);
  });
});

describe('stepBall: ground slide', () => {
  const SLIDE = { ...PARAMS, minBounceHeightPx: 12 };

  it('a tiny predicted rebound starts a slide with no wall report', () => {
    const r = stepBall(ball(500, 750, 400, 300), 16, SLIDE, ARENA);
    expect([r.state.sliding, r.state.vy, r.state.y, r.walls]).toEqual([true, 0, 700, []]);
    expect(r.state.resting).toBe(false);
  });

  it('a big enough rebound still bounces', () => {
    const r = stepBall(ball(500, 750, 0, 450), 16, SLIDE, ARENA);
    expect([r.state.sliding, r.walls]).toEqual([false, ['bottom']]);
  });

  it('minBounceHeightPx 0 keeps bouncing sub-pixel rebounds', () => {
    expect(stepBall(ball(500, 750, 0, 100), 16, PARAMS, ARENA).state.sliding).toBe(false);
  });

  it('decays under groundFriction, pinned to the floor, then settles', () => {
    let s: BallState = { x: 500, y: 700, vx: 400, vy: 0, sliding: true, resting: false };
    const one = stepBall(s, 40, SLIDE, ARENA);
    expect(one.state.vx).toBeCloseTo(400 * (1 - 2 * 0.04), 10);
    expect([one.state.y, one.state.vy, one.walls]).toEqual([700, 0, []]);
    for (let i = 0; i < 200 && !s.resting; i++) s = stepBall(s, 40, SLIDE, ARENA).state;
    expect(s).toMatchObject({ resting: true, sliding: false, y: 700, vx: 0, vy: 0 });
  });

  it('groundFriction never reverses vx', () => {
    const s: BallState = { x: 500, y: 700, vx: 400, vy: 0, sliding: true, resting: false };
    expect(stepBall(s, 40, { ...SLIDE, groundFriction: 100 }, ARENA).state.vx).toBe(0);
  });

  it('stops against a side wall without rebound or report', () => {
    const r = stepBall({ x: 899, y: 700, vx: 400, vy: 0, sliding: true, resting: false }, 40, SLIDE, ARENA);
    expect([r.state.x, r.state.vx, r.state.resting, r.walls]).toEqual([900, 0, true, []]);
  });

  it('a vertical low drop settles in the step it would have slid', () => {
    const r = stepBall(ball(500, 750, 0, 300), 16, SLIDE, ARENA);
    expect([r.state.resting, r.state.sliding, r.walls]).toEqual([true, false, []]);
  });
});

describe('arena / collision box', () => {
  const walls = { x: 0, y: 0, width: 1000, height: 800 };

  it('keeps the whole box inside, honouring its offset from the anchor', () => {
    // Anchor at the feet: box spans 40 left, 20 right, 120 up, 5 below the anchor.
    const box = { dx: -40, dy: -120, width: 60, height: 125 };
    expect(arenaFor(walls, box)).toEqual({ minX: 40, maxX: 980, minY: 120, maxY: 795 });
  });

  it('boxFrom measures against the anchor it was taken with', () => {
    expect(boxFrom({ x: 460, y: 380, width: 60, height: 125 }, { x: 500, y: 500 })).toEqual({ dx: -40, dy: -120, width: 60, height: 125 });
  });

  it('a flight never lets any box edge cross the walls', () => {
    const box = { dx: -40, dy: -120, width: 60, height: 125 };
    const a = arenaFor(walls, box);
    const f = new Flight({ x: 500, y: 300 }, { vx: 3000, vy: -2500 }, DEFAULT_PARAMS);
    for (let i = 0; i < 2000 && !f.settled; i++) {
      const { x, y } = f.step(16, a);
      expect(x + box.dx).toBeGreaterThanOrEqual(walls.x - 1e-9);
      expect(x + box.dx + box.width).toBeLessThanOrEqual(walls.x + walls.width + 1e-9);
      expect(y + box.dy).toBeGreaterThanOrEqual(walls.y - 1e-9);
      expect(y + box.dy + box.height).toBeLessThanOrEqual(walls.y + walls.height + 1e-9);
    }
    expect(f.settled).toBe(true);
  });

  it('pickScreen: containing screen, else nearest, else null', () => {
    const screens = [{ x: 0, y: 0, width: 1000, height: 800 }, { x: 1000, y: 0, width: 800, height: 600 }];
    expect(pickScreen(screens, { x: 1200, y: 300 })).toBe(screens[1]);
    expect(pickScreen(screens, { x: 500, y: 900 })).toBe(screens[0]); // below the primary, nearest to it
    expect(pickScreen(screens, { x: 1900, y: 100 })).toBe(screens[1]);
    expect(pickScreen([], { x: 0, y: 0 })).toBeNull();
  });
});

describe('releaseVelocity', () => {
  const BASE = { sampleWindowMs: 120, throwMultiplier: 1, minThrowSpeed: 350, maxSpeed: 4000 };

  it('derives velocity from the oldest in-window sample to the newest', () => {
    expect(releaseVelocity([{ x: 100, y: 100, t: 1000 }, { x: 300, y: 100, t: 1100 }], 1100, BASE)).toEqual({ vx: 2000, vy: 0 });
  });

  it('ignores samples older than the window', () => {
    const s = [{ x: 0, y: 0, t: 0 }, { x: 500, y: 0, t: 500 }, { x: 100, y: 0, t: 1000 }, { x: 120, y: 0, t: 1010 }];
    expect(releaseVelocity(s, 1010, BASE)).toEqual({ vx: 2000, vy: 0 });
  });

  it('returns null for fewer than two in-window samples or zero elapsed time', () => {
    expect(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 50, y: 0, t: 500 }, { x: 100, y: 0, t: 1000 }], 1000, BASE)).toBeNull();
    expect(releaseVelocity([{ x: 100, y: 100, t: 1000 }, { x: 400, y: 100, t: 1000 }], 1000, BASE)).toBeNull();
  });

  it('slow release is a park: below minThrowSpeed → null', () => {
    expect(releaseVelocity([{ x: 100, y: 100, t: 1000 }, { x: 120, y: 100, t: 1100 }], 1100, BASE)).toBeNull();
  });

  it('applies the multiplier before the speed gates', () => {
    const s = [{ x: 100, y: 100, t: 1000 }, { x: 120, y: 100, t: 1100 }];
    expect(releaseVelocity(s, 1100, { ...BASE, throwMultiplier: 2 })).toEqual({ vx: 400, vy: 0 });
    expect(releaseVelocity(s, 1100, { ...BASE, throwMultiplier: 0.5 })).toBeNull();
  });

  it('clamps magnitude to maxSpeed, preserving direction', () => {
    const v = releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 3000, y: 4000, t: 100 }], 100, BASE)!;
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(4000, 8);
    expect(v.vx).toBeCloseTo(2400, 8);
    expect(v.vy).toBeCloseTo(3200, 8);
  });

  it('VelocitySampler trims old samples and resets', () => {
    const s = new VelocitySampler();
    s.push(0, 0, 0, 120);
    s.push(10, 0, 1000, 120);
    s.push(40, 0, 1010, 120);
    expect(s.velocity(1010, BASE)).toEqual({ vx: 3000, vy: 0 });
    s.reset();
    expect(s.velocity(1010, BASE)).toBeNull();
  });
});

describe('Flight', () => {
  const run = (f: Flight, arena: Arena, dt = 16, max = 5000): ThrowEvent[] => {
    const all: ThrowEvent[] = [];
    for (let i = 0; i < max && !f.settled; i++) all.push(...f.step(dt, arena).events);
    return all;
  };

  it('throw → bounces → settles on the floor exactly once', () => {
    const f = new Flight({ x: 100, y: 300 }, { vx: 1200, vy: -800 }, DEFAULT_PARAMS);
    const events = run(f, ARENA);
    expect(events.filter((e) => e.type === 'settled')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'settled' });
    expect(events.some((e) => e.type === 'wall-hit')).toBe(true);
    expect(f.position.y).toBe(700);
  });

  it('emits slide-start once before settling on a low flat throw', () => {
    const f = new Flight({ x: 100, y: 690 }, { vx: 900, vy: 0 }, DEFAULT_PARAMS);
    const events = run(f, ARENA);
    expect(events.filter((e) => e.type === 'slide-start')).toHaveLength(1);
    expect(events.findIndex((e) => e.type === 'slide-start')).toBeLessThan(events.findIndex((e) => e.type === 'settled'));
  });

  it('debounces same-wall hits within effectDebounceMs, re-arms after', () => {
    const p = { ...NOGRAV, effectDebounceMs: 150 };
    // Pinned in a corner-ish spot, pushed into the left wall every 16ms.
    const f = new Flight({ x: 0, y: 400 }, { vx: -500, vy: 0 }, { ...p, restitution: 1 });
    let hits = 0;
    for (let i = 0; i < 20; i++) { // 320ms; the ball bounces back and forth only at the wall
      const e = f.step(16, ARENA).events.filter((x) => x.type === 'wall-hit');
      hits += e.length;
      if (f.position.x > 0) f['state'].vx = -500; // keep slamming the same wall
    }
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(hits).toBeLessThanOrEqual(3); // ~320ms / 150ms, not 20
  });

  it('force-settles past maxFlightMs (near-elastic setup)', () => {
    const f = new Flight({ x: 100, y: 100 }, { vx: 800, vy: 0 }, { ...DEFAULT_PARAMS, restitution: 1, minBounceHeightPx: 0, maxFlightMs: 1000 });
    const events = run(f, ARENA, 16);
    expect(events.at(-1)).toEqual({ type: 'settled' });
  });

  it('does nothing after settling', () => {
    const f = new Flight({ x: 500, y: 700 }, { vx: 0, vy: 0 }, DEFAULT_PARAMS);
    run(f, ARENA);
    expect(f.step(16, ARENA).events).toEqual([]);
  });

  it('follows an arena that changes between steps (e.g. pose swap)', () => {
    const f = new Flight({ x: 500, y: 300 }, { vx: 0, vy: 0 }, DEFAULT_PARAMS);
    f.step(16, ARENA);
    const smaller: Arena = { ...ARENA, maxY: 400 };
    const events = run(f, smaller);
    expect(f.position.y).toBe(400);
    expect(events.at(-1)).toEqual({ type: 'settled' });
  });
});

describe('readSettings', () => {
  const store = (o: Record<string, unknown>) => ({ get: ((k: string, fb?: unknown) => (k in o ? o[k] : fb)) as never });

  it('returns v0 defaults plus hitStateMs 0 / slideState false', () => {
    expect(readSettings(store({}))).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ gravity: 3000, restitution: 0.6, minThrowSpeed: 350, hitStateMs: 0, slideState: false, bounceMotion: true });
  });

  it('clamps out-of-range numbers and ignores wrong types', () => {
    const s = readSettings(store({ gravity: 5, restitution: 9, maxSpeed: 'fast', hitStateMs: -3, slideState: 'yes', bounceMotion: false }));
    expect(s.gravity).toBe(100);
    expect(s.restitution).toBe(1);
    expect(s.maxSpeed).toBe(4000);
    expect(s.hitStateMs).toBe(0);
    expect(s.slideState).toBe(false);
    expect(s.bounceMotion).toBe(false);
  });

  it('rejects NaN / Infinity', () => {
    expect(readSettings(store({ gravity: NaN, friction: Infinity })).gravity).toBe(3000);
    expect(readSettings(store({ friction: Infinity })).friction).toBe(0);
  });
});
