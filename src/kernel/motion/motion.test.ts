import { describe, expect, it } from 'vitest';
import type { MotionContext, MotionSource, PetHandle } from '../../api/types';
import { keyframes, noise, sine, spring } from './builtin';
import { applyDelta, identity } from './compose';
import { easing } from './easing';
import { MotionStack } from './stack';

const pet = { velocity: { x: 0, y: 0 } } as unknown as PetHandle;
const ctx = (over: Partial<MotionContext> = {}): MotionContext => ({ pet, params: {}, strength: 1, reducedMotion: false, ...over });

describe('compose (docs/03 §3.3)', () => {
  it('add sums offsets and multiplies scales, weighted', () => {
    const acc = identity();
    applyDelta(acc, { x: 10, rotate: 2, scaleY: 1.2 }, 'add', 1);
    applyDelta(acc, { x: 5, scaleY: 1.5 }, 'add', 0.5);
    expect(acc.x).toBeCloseTo(12.5);
    expect(acc.rotate).toBeCloseTo(2);
    expect(acc.scaleY).toBeCloseTo(1.2 * 1.25);
  });

  it('override pulls toward the layer value', () => {
    const acc = identity();
    applyDelta(acc, { x: 10 }, 'add', 1);
    applyDelta(acc, { x: 0 }, 'override', 1);
    expect(acc.x).toBe(0);
    applyDelta(acc, { x: 10 }, 'override', 0.5);
    expect(acc.x).toBe(5);
  });

  it('ignores non-finite values', () => {
    const acc = identity();
    applyDelta(acc, { x: NaN, y: Infinity }, 'add', 1);
    expect(acc.x).toBe(0);
    expect(acc.y).toBe(0);
  });
});

describe('easing', () => {
  it('named curves hit the endpoints', () => {
    for (const n of ['linear', 'in', 'out', 'inOut', 'outBack']) {
      expect(easing(n)(0)).toBeCloseTo(0);
      expect(easing(n)(1)).toBeCloseTo(1);
    }
    expect(easing('cubic-bezier(0.42, 0, 0.58, 1)')(0.5)).toBeCloseTo(0.5, 2);
    expect(easing('out')(0.5)).toBeGreaterThan(0.5);
  });
});

describe('built-in motion types', () => {
  it('sine oscillates around rest and goes still under reducedMotion', () => {
    const s = sine.create({ property: 'scaleY', amplitude: 0.1, periodMs: 1000 });
    expect(s.evaluate(250, 16, ctx()).scaleY).toBeCloseTo(1.1);
    expect(s.evaluate(750, 16, ctx()).scaleY).toBeCloseTo(0.9);
    expect(s.evaluate(250, 16, ctx({ reducedMotion: true }))).toEqual({});
    expect(s.duration).toBeNull();
  });

  it('noise stays within amplitude and is smooth', () => {
    const n = noise.create({ property: 'rotate', amplitude: 3, frequency: 2, seed: 7 });
    let prev = n.evaluate(0, 16, ctx()).rotate!;
    for (let t = 16; t < 3000; t += 16) {
      const v = n.evaluate(t, 16, ctx()).rotate!;
      expect(Math.abs(v)).toBeLessThanOrEqual(3);
      expect(Math.abs(v - prev)).toBeLessThan(0.6);
      prev = v;
    }
  });

  it('impulse spring settles and reports done', () => {
    const s = spring.create({ property: 'scaleY', impulse: 2, stiffness: 200, damping: 14 });
    let t = 0;
    while (!s.isDone!() && t < 5000) {
      s.evaluate(t, 16, ctx());
      t += 16;
    }
    expect(s.isDone!()).toBe(true);
    expect(t).toBeLessThan(5000);
  });

  it('velocity-driven spring follows the pet', () => {
    const moving = { velocity: { x: 500, y: 0 } } as unknown as PetHandle;
    const s = spring.create({ property: 'rotate', drive: 'velocityX', gain: 0.02, max: 8 });
    let v = 0;
    for (let t = 0; t < 2000; t += 16) v = s.evaluate(t, 16, ctx({ pet: moving })).rotate!;
    expect(v).toBeCloseTo(8, 1);
    expect(s.isDone!()).toBe(false);
  });

  it('keyframes interpolate with easing and clamp at the ends', () => {
    const k = keyframes.create({ tracks: { y: [{ t: 0, v: 0 }, { t: 100, v: -10 }], scaleX: [{ t: 0, v: 1 }, { t: 100, v: 2 }] }, markers: { 50: 'swap' } });
    expect(k.duration).toBe(100);
    expect(k.evaluate(50, 16, ctx()).y).toBeCloseTo(-5);
    expect(k.evaluate(500, 16, ctx()).scaleX).toBeCloseTo(2);
    expect(k.evaluate(50, 16, ctx({ strength: 0.5 })).y).toBeCloseTo(-2.5);
    expect(k.markers).toEqual({ 50: 'swap' });
  });
});

describe('MotionStack', () => {
  const ctxFor = () => ctx();

  it('composes layers in fixed order regardless of insertion order', () => {
    const st = new MotionStack();
    const src = (v: number): MotionSource => ({ duration: null, evaluate: () => ({ x: v }) });
    st.add(src(5), { layer: 'interaction', blend: 'override' }, 't');
    st.add(src(10), { layer: 'base' }, 't');
    expect(st.evaluate(0, 16, ctxFor).x).toBe(5);
  });

  it('fires markers once when crossed, then ends one-shots', () => {
    const st = new MotionStack();
    const k = keyframes.create({ tracks: { y: [{ t: 0, v: 0 }, { t: 100, v: 1 }] }, markers: { 0: 'start', 60: 'swap', 100: 'end' } });
    const h = st.add(k, { layer: 'transition' }, 't');
    const marks: string[] = [];
    let ended = 0;
    h.onMarker((m) => marks.push(m));
    h.onEnd(() => ended++);
    for (const now of [1000, 1050, 1070, 1090, 1120, 1200]) st.evaluate(now, 16, ctxFor);
    expect(marks).toEqual(['start', 'swap', 'end']);
    expect(ended).toBe(1);
    expect(st.size).toBe(0);
  });

  it('dispose removes without firing end', () => {
    const st = new MotionStack();
    const h = st.add(sine.create({}), {}, 't');
    let ended = false;
    h.onEnd(() => (ended = true));
    h.dispose();
    st.evaluate(0, 16, ctxFor);
    expect(ended).toBe(false);
    expect(h.active).toBe(false);
  });

  it('stops a motion that throws', () => {
    const st = new MotionStack();
    st.add({ duration: null, evaluate: () => { throw new Error('boom'); } }, {}, 'bad');
    st.evaluate(0, 16, ctxFor);
    expect(st.size).toBe(0);
  });
});
