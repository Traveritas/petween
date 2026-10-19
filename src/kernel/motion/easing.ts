// Easing for keyframes: named curves, cubic-bezier, and step.

export type EaseSpec = string | [number, number, number, number] | undefined;

function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-5) break;
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    if (t < 0 || t > 1) {
      // Bisection fallback.
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}

const NAMED: Record<string, (t: number) => number> = {
  linear: (t) => t,
  in: bezier(0.42, 0, 1, 1),
  out: bezier(0, 0, 0.58, 1),
  inOut: bezier(0.42, 0, 0.58, 1),
  outBack: bezier(0.34, 1.56, 0.64, 1),
  step: (t) => (t < 1 ? 0 : 1),
};

const cache = new Map<string, (t: number) => number>();

export function easing(spec: EaseSpec): (t: number) => number {
  if (spec === undefined) return NAMED.linear;
  if (Array.isArray(spec)) return bezier(spec[0], spec[1], spec[2], spec[3]);
  const hit = NAMED[spec] ?? cache.get(spec);
  if (hit) return hit;
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(spec.trim());
  if (m) {
    const [a, b, c, d] = m[1].split(',').map(Number);
    const f = bezier(a, b, c, d);
    cache.set(spec, f);
    return f;
  }
  return NAMED.linear;
}
