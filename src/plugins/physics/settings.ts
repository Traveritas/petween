// Reads and validates the physics plugin's settings. Invalid values fall back to the default, out-of-range values clamp
// (v0 rejected on PUT; here settings are hand-editable files, so tolerating beats refusing).

import type { Store } from '../../api/types';
import { DEFAULT_PARAMS, PARAM_LIMITS, type ThrowParams } from './throw';

export interface PhysicsSettings extends ThrowParams {
  /** Play the squash motion on wall hits (v0 bounceAnimation.enabled). */
  bounceMotion: boolean;
  /** > 0: hold state `physics.hit` this long after a wall hit. 0 = off. */
  hitStateMs: number;
  /** Hold state `physics.slide` while sliding on the floor. */
  slideState: boolean;
}

export const DEFAULT_SETTINGS: PhysicsSettings = {
  ...DEFAULT_PARAMS,
  bounceMotion: true,
  hitStateMs: 0,
  slideState: false,
};

const HIT_STATE_LIMIT = { min: 0, max: 60_000 };

function num(raw: unknown, fallback: number, lim: { min: number; max: number }): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, lim.min), lim.max);
}

export function readSettings(store: Pick<Store, 'get'>): PhysicsSettings {
  const out: PhysicsSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(PARAM_LIMITS) as (keyof ThrowParams)[]) {
    out[key] = num(store.get<unknown>(key), DEFAULT_PARAMS[key], PARAM_LIMITS[key]);
  }
  out.hitStateMs = num(store.get<unknown>('hitStateMs'), 0, HIT_STATE_LIMIT);
  const bounce = store.get<unknown>('bounceMotion');
  out.bounceMotion = typeof bounce === 'boolean' ? bounce : true;
  const slide = store.get<unknown>('slideState');
  out.slideState = typeof slide === 'boolean' ? slide : false;
  return out;
}
