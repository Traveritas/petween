import { describe, expect, it } from 'vitest';
import type { ClipDef, MotionRef, StateAppearance } from '../api/types';
import { Appearance, type AppearanceDeps, type Target } from './appearance';
import { keyframes, sine } from './motion/builtin';
import { MotionStack } from './motion/stack';

// Drive Appearance with a real MotionStack so motion markers / ends behave as in the app.
function harness(motions: Record<string, { type: string; [k: string]: unknown }>, plans: Record<string, number> = {}) {
  const stack = new MotionStack();
  const started: string[] = [];
  const types = { keyframes, sine } as Record<string, typeof keyframes>;
  const deps: AppearanceDeps = {
    play(ref: MotionRef, layer) {
      const def = typeof ref === 'string' ? motions[ref] : ref;
      if (!def) return null;
      const { type, ...params } = def;
      const source = types[type].create(params);
      started.push(`${layer}:${typeof ref === 'string' ? ref : type}`);
      return { handle: stack.add(source, { layer }, 'pack', params), markers: Object.values(source.markers ?? {}) };
    },
    plan: (ref) => ({ crossfadeMs: typeof ref === 'string' ? (plans[ref] ?? 0) : 0, waitFor: ref === 'afterLoop' ? 'loop-end' : undefined }),
  };
  const ap = new Appearance(deps);
  const ctx = { pet: { velocity: { x: 0, y: 0 } }, params: {}, strength: 1, reducedMotion: false } as never;
  const step = (now: number) => {
    stack.evaluate(now, 16, () => ctx);
    return ap.tick(now);
  };
  return { ap, stack, started, step };
}

const still = (source: string): ClipDef => ({ type: 'still', source });
const st = (key: string, clipId: string, appearance: StateAppearance): Target => ({ kind: 'state', resolvedKey: key, appearance, clipId, clip: still(clipId) });

const POP = { type: 'keyframes', tracks: { scaleY: [{ t: 0, v: 1 }, { t: 100, v: 1 }] }, markers: { 50: 'swap' } };
const BYE = { type: 'keyframes', tracks: { x: [{ t: 0, v: 0 }, { t: 80, v: 0 }] } };
const LOOP = { type: 'sine', property: 'y' };

describe('Appearance switch timing (docs/03 §4)', () => {
  it('swaps the clip at the enter motion swap marker, then starts loops', () => {
    const h = harness({ pop: POP, loop: LOOP });
    h.ap.set(st('idle', 'sit', { clips: ['sit'] }), 0);
    h.step(0);
    h.ap.set(st('active', 'type', { clips: ['type'], enter: 'pop', loop: ['loop'] }), 10);
    expect(h.step(20)[0].clipId).toBe('sit');
    expect(h.step(70)[0].clipId).toBe('type');
    expect(h.started).toEqual(['transition:pop']);
    h.step(120);
    h.step(140);
    expect(h.started).toEqual(['transition:pop', 'base:loop']);
  });

  it('without an enter motion the clip swaps immediately', () => {
    const h = harness({});
    h.ap.set(st('idle', 'sit', { clips: ['sit'] }), 0);
    h.step(0);
    h.ap.set(st('error', 'oops', { clips: ['oops'] }), 10);
    expect(h.step(10)[0].clipId).toBe('oops');
  });

  it('plays the outgoing exit motion first unless interrupted', () => {
    const h = harness({ bye: BYE, pop: POP });
    h.ap.set(st('a', 'A', { clips: ['A'], exit: 'bye' }), 0);
    h.step(0);
    h.ap.set(st('b', 'B', { clips: ['B'], enter: 'pop' }), 100);
    h.step(110);
    expect(h.started).toEqual(['transition:bye']);
    expect(h.step(150)[0].clipId).toBe('A');
    // Interrupt mid-exit with C: B's flow is dropped and A's exit is not replayed.
    h.ap.set(st('c', 'C', { clips: ['C'] }), 160);
    expect(h.step(170)[0].clipId).toBe('C');
    expect(h.started).toEqual(['transition:bye']);
  });

  it('crossfade keeps the outgoing clip underneath', () => {
    const h = harness({}, { crossfade: 200 });
    h.ap.set(st('a', 'A', { clips: ['A'] }), 0);
    h.step(0);
    h.ap.set(st('b', 'B', { clips: ['B'], transition: 'crossfade' }), 100);
    h.step(100); // swap happens on the first tick; the fade starts here
    const layers = h.step(200);
    expect(layers.map((l) => l.clipId)).toEqual(['A', 'B']);
    expect(layers[1].opacity).toBeCloseTo(0.5);
    expect(h.step(400).map((l) => l.clipId)).toEqual(['B']);
  });

  it('afterLoop waits for the outgoing loop to wrap', () => {
    const h = harness({});
    const frames: ClipDef = { type: 'frames', source: 'f', fps: 10, frames: { count: 10 } };
    h.ap.set({ kind: 'state', resolvedKey: 'a', appearance: { clips: ['F'] }, clipId: 'F', clip: frames }, 0);
    h.step(0);
    h.ap.set(st('b', 'B', { clips: ['B'], transition: 'afterLoop' }), 300);
    expect(h.step(500)[0].clipId).toBe('F');
    expect(h.step(1010)[0].clipId).toBe('B');
  });

  it('same resolved state is a no-op (no replayed enter)', () => {
    const h = harness({ pop: POP });
    const a = { clips: ['type'], enter: 'pop' };
    h.ap.set(st('active', 'type', a), 0);
    for (let t = 0; t < 300; t += 16) h.step(t);
    h.ap.set(st('active', 'type', a), 400);
    h.step(410);
    expect(h.started).toEqual(['transition:pop']);
  });
});
