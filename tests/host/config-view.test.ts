/**
 * buildConfigView seam tests (preset-authority phase 1, host/config-view.ts):
 * the equivalence matrix — {no usable preset} × {preset in sync, preset
 * diverged} must all yield the legacy response (the config document itself),
 * with the preset path genuinely taken only when the two slices are
 * structurally identical.
 */
import { describe, expect, it } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import { POSE_KEYS, type PetweenConfig, type PoseConfig, type StateAppearance, type PoseKey } from '../../src/core/types'
import { buildConfigView } from '../../src/host/config-view'
import { petSliceFromConfig, type PetSlice } from '../../src/host/pets'

/** A recognizably non-default config with an active pointer set. */
function makeConfig(): PetweenConfig {
  const config = createDefaultPetweenConfig()
  config.global.scale = 1.5
  config.poses.idle.assetId = '0123456789abcdef'
  config.states.idle.enter.preset = 'jelly'
  config.activePetId = 'pet_abc123'
  return config
}

/** Deep clone through JSON, mirroring how the stores rebuild their objects. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('buildConfigView (preset-authority phase 1 seam)', () => {
  it('a null slice (null/dangling pointer, missing or corrupt file) returns the config itself', () => {
    const config = makeConfig()
    expect(buildConfigView(config, null)).toBe(config)
  })

  it('an in-sync preset slice is adopted — same values, preset object identity', () => {
    const config = makeConfig()
    const slice = clone(petSliceFromConfig(config))
    const view = buildConfigView(config, slice)
    // The response is byte-identical to the legacy one…
    expect(view).toEqual(config)
    // …but the slice genuinely came from the preset path (phase-2 groundwork).
    expect(view).not.toBe(config)
    expect(view.poses).toBe(slice.poses)
    expect(view.states).toBe(slice.states)
    expect(view.global.scale).toBe(slice.scale)
    // Non-slice fields stay the config document's own.
    expect(view.global.transition).toBe(config.global.transition)
    expect(view.overlay).toBe(config.overlay)
    expect(view.advanced).toBe(config.advanced)
    expect(view.interactions).toBe(config.interactions)
    expect(view.activePetId).toBe(config.activePetId)
  })

  it('a diverged scale (mirror lag/failure window) falls back to the config slice', () => {
    const config = makeConfig()
    const slice: PetSlice = { ...clone(petSliceFromConfig(config)), scale: 9.9 }
    expect(buildConfigView(config, slice)).toBe(config)
  })

  it('diverged poses fall back to the config slice', () => {
    const config = makeConfig()
    const slice = clone(petSliceFromConfig(config))
    slice.poses.idle.assetId = 'ffffffffffffffff'
    expect(buildConfigView(config, slice)).toBe(config)
  })

  it('diverged states fall back to the config slice', () => {
    const config = makeConfig()
    const slice = clone(petSliceFromConfig(config))
    slice.states.idle.enter.preset = 'comic-pop'
    expect(buildConfigView(config, slice)).toBe(config)
  })

  it('fails safe on a non-normalized slice: equal content in a different key order reads as diverged', () => {
    const config = makeConfig()
    // Both production sides pass through repairConfig's fixed key order; a
    // caller-built slice that skipped normalization cannot false-match — the
    // worst case is the fallback, which is exactly the legacy response.
    const reversed = <T>(record: Record<PoseKey, T>): Record<PoseKey, T> =>
      Object.fromEntries([...POSE_KEYS].reverse().map((key) => [key, record[key]])) as Record<PoseKey, T>
    const reordered: PetSlice = {
      scale: config.global.scale,
      poses: reversed<PoseConfig>(clone(config.poses)),
      states: reversed<StateAppearance>(clone(config.states)),
    }
    const view = buildConfigView(config, reordered)
    expect(view).toBe(config)
    expect(view).toEqual(config)
  })
})
