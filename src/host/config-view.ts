/**
 * host/config-view.ts — the materialized config view (preset authority).
 *
 * Phase 2 (docs/preset-authority-eval.md §2/§6): the pet preset is the
 * character slice's single source of truth; config.json is the v2 global
 * document. The "current config" = global document + the active preset's
 * slice, assembled here. GET /config and every PUT response keep the legacy
 * v1 shape through this seam, so external consumers and the extension
 * surface never notice the flip.
 *
 * `config` is the loaded-and-repaired document (host/config.ts reads both v1
 * and v2 files; a v2 file's slice fields hold defaults, a v1 file's hold its
 * own legacy slice). `activePresetSlice` is the active preset's slice, or
 * null when there is no usable preset (a null/dangling pointer or an
 * unreadable file — resolved to null by the caller). A present slice is
 * ALWAYS adopted — divergence (a legacy mirror-lag window, an out-of-band
 * edit) resolves in the preset's favor. The null case falls back to the
 * config's own slice: correct for a not-yet-migrated v1 document, and a
 * safe default-slice degradation for a broken v2 install until the boot
 * repair (host/migrate-v2.ts) re-points or re-creates the active pet.
 */
import type { PetweenConfig, PetSlice } from '../core/types'

/**
 * Assemble the config returned by GET /config (phase 2: preset slice
 * authoritative, config-side slice as the no-preset fallback).
 */
export function buildConfigView(config: PetweenConfig, activePresetSlice: PetSlice | null): PetweenConfig {
  if (activePresetSlice === null) return config
  return {
    ...config,
    global: { ...config.global, scale: activePresetSlice.scale },
    poses: activePresetSlice.poses,
    states: activePresetSlice.states,
  }
}
