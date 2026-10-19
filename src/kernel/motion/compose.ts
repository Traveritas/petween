// Composition rules (docs/03 §3.3).
//   add:      x / y / rotate / skew sum; scale / opacity multiply, weighted as 1 + (v - 1) * w
//   override: pull the accumulated value toward this layer's value by `weight`

import type { MotionLayer, TransformDelta } from '../../api/types';

export type Transform = Required<TransformDelta>;

export const LAYERS: MotionLayer[] = ['base', 'transition', 'physics', 'plugin', 'interaction'];

export const identity = (): Transform => ({ x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, opacity: 1 });

const ADDITIVE = ['x', 'y', 'rotate', 'skewX', 'skewY'] as const;
const MULTIPLICATIVE = ['scaleX', 'scaleY', 'opacity'] as const;

export function applyDelta(acc: Transform, d: TransformDelta, blend: 'add' | 'override', weight: number): void {
  const w = Math.max(0, Math.min(1, weight));
  if (blend === 'override') {
    for (const k of [...ADDITIVE, ...MULTIPLICATIVE]) {
      const v = d[k];
      if (v !== undefined && Number.isFinite(v)) acc[k] = acc[k] + (v - acc[k]) * w;
    }
    return;
  }
  for (const k of ADDITIVE) {
    const v = d[k];
    if (v !== undefined && Number.isFinite(v)) acc[k] += v * w;
  }
  for (const k of MULTIPLICATIVE) {
    const v = d[k];
    if (v !== undefined && Number.isFinite(v)) acc[k] *= 1 + (v - 1) * w;
  }
}

export const PROPERTIES = [...ADDITIVE, ...MULTIPLICATIVE] as const;
export type Property = (typeof PROPERTIES)[number];

export const isProperty = (p: unknown): p is Property => typeof p === 'string' && (PROPERTIES as readonly string[]).includes(p);

/** Multiplicative properties rest at 1; additive ones at 0. */
export const restValue = (p: Property) => ((MULTIPLICATIVE as readonly string[]).includes(p) ? 1 : 0);
