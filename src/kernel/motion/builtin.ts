// Built-in motion types (docs/03 §3.2): keyframes, spring, noise, sine.
// Every output is scaled by ctx.strength. Under reducedMotion, sine/noise go still and the others soften.

import type { MotionContext, MotionSource, MotionType, TransformDelta } from '../../api/types';
import { isProperty, restValue, type Property } from './compose';
import { easing, type EaseSpec } from './easing';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function prop(p: unknown, fallback: Property): Property {
  return isProperty(p) ? p : fallback;
}

/** Turn an offset around the rest value into a delta, scaled by strength. */
function out(p: Property, offset: number, strength: number): TransformDelta {
  return { [p]: restValue(p) + offset * strength };
}

const strengthOf = (ctx: MotionContext, reducedFactor: number) => ctx.strength * (ctx.reducedMotion ? reducedFactor : 1);

// ---------- sine ----------

export const sine: MotionType = {
  id: 'sine',
  create(params) {
    const p = prop(params.property, 'y');
    const amp = num(params.amplitude, p === 'scaleX' || p === 'scaleY' ? 0.02 : 4);
    const period = Math.max(1, num(params.periodMs, 3000));
    const phase = num(params.phase, 0);
    return {
      duration: null,
      evaluate(t, _dt, ctx) {
        const s = strengthOf(ctx, 0);
        if (s === 0) return {};
        return out(p, amp * Math.sin((t / period + phase) * Math.PI * 2), s);
      },
    };
  },
};

// ---------- noise: smooth 1-D value noise ----------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export const noise: MotionType = {
  id: 'noise',
  create(params) {
    const p = prop(params.property, 'rotate');
    const amp = num(params.amplitude, p === 'scaleX' || p === 'scaleY' ? 0.01 : 1);
    const freq = Math.max(0.01, num(params.frequency, 2));
    const r = rng(num(params.seed, Math.floor(Math.random() * 1e9)));
    const table = Array.from({ length: 256 }, r);
    const at = (x: number) => {
      const i = Math.floor(x);
      const f = x - i;
      const a = table[i & 255], b = table[(i + 1) & 255];
      const u = f * f * (3 - 2 * f);
      return a + (b - a) * u;
    };
    return {
      duration: null,
      evaluate(t, _dt, ctx) {
        const s = strengthOf(ctx, 0);
        if (s === 0) return {};
        return out(p, amp * at((t / 1000) * freq), s);
      },
    };
  },
};

// ---------- spring ----------

export const spring: MotionType = {
  id: 'spring',
  create(params) {
    const p = prop(params.property, 'scaleY');
    const k = Math.max(1, num(params.stiffness, 180));
    const c = Math.max(0, num(params.damping, 12));
    const drive = params.drive === 'velocityX' || params.drive === 'velocityY' ? params.drive : null;
    const gain = num(params.gain, 0.01);
    const max = num(params.max, Infinity);
    let x = 0;
    let v = num(params.impulse, 0);
    let started = false;
    let settled = false;
    return {
      duration: null,
      isDone: () => !drive && settled,
      evaluate(_t, dt, ctx) {
        started = true;
        let target = 0;
        if (drive) {
          const vel = drive === 'velocityX' ? ctx.pet.velocity.x : ctx.pet.velocity.y;
          target = Math.max(-max, Math.min(max, vel * gain));
        }
        // Semi-implicit Euler in ≤8ms steps.
        let rest = Math.min(dt, 100) / 1000;
        while (rest > 0) {
          const h = Math.min(rest, 0.008);
          v += (-k * (x - target) - c * v) * h;
          x += v * h;
          rest -= h;
        }
        settled = started && Math.abs(x - target) < 1e-3 && Math.abs(v) < 1e-2;
        return out(p, x, strengthOf(ctx, 0.3));
      },
    };
  },
};

// ---------- keyframes ----------

interface Key {
  t: number;
  v: number;
  ease?: EaseSpec;
}

export const keyframes: MotionType = {
  id: 'keyframes',
  create(params) {
    const tracks: [Property, Key[]][] = [];
    const raw = (params.tracks ?? {}) as Record<string, unknown>;
    let end = 0;
    for (const [name, keys] of Object.entries(raw)) {
      if (!isProperty(name) || !Array.isArray(keys) || keys.length === 0) continue;
      const ks = (keys as Key[])
        .filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.v))
        .sort((a, b) => a.t - b.t);
      if (!ks.length) continue;
      tracks.push([name, ks]);
      end = Math.max(end, ks[ks.length - 1].t);
    }
    const duration = num(params.durationMs, end);
    const markers: Record<number, string> = {};
    for (const [ms, name] of Object.entries((params.markers ?? {}) as Record<string, string>)) {
      if (Number.isFinite(Number(ms)) && typeof name === 'string') markers[Number(ms)] = name;
    }
    const source: MotionSource = {
      duration,
      markers,
      evaluate(t, _dt, ctx) {
        const s = strengthOf(ctx, 0.3);
        const d: TransformDelta = {};
        for (const [p, ks] of tracks) {
          let v: number;
          if (t <= ks[0].t) v = ks[0].v;
          else if (t >= ks[ks.length - 1].t) v = ks[ks.length - 1].v;
          else {
            let i = 1;
            while (ks[i].t < t) i++;
            const a = ks[i - 1], b = ks[i];
            const f = easing(b.ease)((t - a.t) / Math.max(1e-6, b.t - a.t));
            v = a.v + (b.v - a.v) * f;
          }
          d[p] = restValue(p) + (v - restValue(p)) * s;
        }
        return d;
      },
    };
    return source;
  },
};

export const BUILTIN_MOTION_TYPES: MotionType[] = [keyframes, spring, noise, sine];
