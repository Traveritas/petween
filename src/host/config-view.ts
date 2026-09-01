/**
 * host/config-view.ts — read-side materialized view for GET /config
 * (preset-authority phase 1, docs/preset-authority-eval.md §2/§6).
 *
 * Phase 1 is read-only: the config document stays authoritative and every
 * write path (PUT /config, the pet routes, the revision counter, the SSE
 * broadcast, the config→preset onSaved mirror) is untouched. GET /config
 * merely assembles its response through buildConfigView below. The active
 * preset's slice is adopted ONLY when it is structurally identical to the
 * config's own slice — the steady state under the mirror — so the response is
 * the legacy one in every scenario. A null pointer, a missing/corrupt preset
 * file, or a diverged slice (a mirror lag/failure window) all fall back to
 * the config's own slice, preserving today's "config is authoritative, the
 * mirror is secondary" contract (host/config.ts).
 *
 * Phase 2 flips the authority: presets become the character slice's single
 * source of truth, PUT /config slice fields redirect to the active preset,
 * the onSaved mirror retires, and the comparison below inverts — divergence
 * then adopts the PRESET slice, and the config-side fallback shrinks to
 * pointer-null/corrupt-preset recovery until the v1→v2 migration retires it.
 * This seam's shape (view = global document + active preset slice) is the
 * only phase-2 preparation landing in code.
 */
import type { PetweenConfig, PetSlice } from '../core/types'
import { petSliceFromConfig } from './pets'

/**
 * Assemble the config returned by GET /config (phase 1: identical to the
 * config document itself, by construction).
 *
 * `activePresetSlice` is the active preset's slice, or null when there is no
 * usable preset (a null/dangling pointer or an unreadable file — the routes
 * layer resolves all of those to null). The preset slice is adopted only when
 * structurally identical to the config's own slice. Both sides pass through
 * the repairConfig normalization (the config via loadConfig, the preset via
 * toPreset/normalizePetSlice), which builds fresh objects with a fixed key
 * order, so the stringify comparison is stable — the same invariant
 * PetsStore.saveSlice relies on. The comparison can only fail safe: a false
 * divergence (e.g. a caller passing a non-normalized slice) falls back to the
 * config's own slice, i.e. exactly the legacy response.
 */
export function buildConfigView(config: PetweenConfig, activePresetSlice: PetSlice | null): PetweenConfig {
  if (activePresetSlice === null) return config
  const own = petSliceFromConfig(config)
  const identical =
    own.scale === activePresetSlice.scale &&
    JSON.stringify(own.poses) === JSON.stringify(activePresetSlice.poses) &&
    JSON.stringify(own.states) === JSON.stringify(activePresetSlice.states)
  if (!identical) return config
  // In sync: adopt the preset slice. The values are identical by construction,
  // so the response is unchanged — but the seam genuinely flows through the
  // preset path, which phase 2 turns authoritative.
  return {
    ...config,
    global: { ...config.global, scale: activePresetSlice.scale },
    poses: activePresetSlice.poses,
    states: activePresetSlice.states,
  }
}
