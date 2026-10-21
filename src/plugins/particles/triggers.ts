// When does a pet burst? Pure rules, kept apart from the DOM so they can be tested.

/** state key → effect id; `null` = explicitly none (lets a pack switch a default off). */
export type StateEffects = Record<string, string | null>;

/** What a pet pack may say under `plugins.particles` (docs/04 §5). */
export interface PackParticles {
  onState?: StateEffects;
}

/**
 * Effect for a state key: the longest configured key equal to it or a dotted prefix of it
 * (`success` covers `success.big`; `active` does not cover `actively`).
 */
export function effectFor(map: StateEffects, key: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [k, effect] of Object.entries(map)) {
    if ((k === key || key.startsWith(`${k}.`)) && k.length > bestLen) {
      best = effect;
      bestLen = k.length;
    }
  }
  return best;
}

/** The user's defaults first, then the pack on top (the pack knows its own art best). */
export function mergeStateEffects(defaults: StateEffects, pack: unknown): StateEffects {
  const onState = (pack as PackParticles | undefined)?.onState;
  const out: StateEffects = { ...defaults };
  if (onState && typeof onState === 'object') {
    for (const [k, v] of Object.entries(onState)) if (typeof v === 'string' || v === null) out[k] = v;
  }
  return out;
}

/** Clip markers named `particle:<effect>` burst on the frame they sit on. */
export function markerEffect(marker: string | undefined): string | null {
  return marker?.startsWith('particle:') ? marker.slice('particle:'.length) || null : null;
}
