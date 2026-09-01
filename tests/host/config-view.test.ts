/**
 * buildConfigView tests (preset-authority phase 2, host/config-view.ts): the
 * active preset's slice is the single source of truth — a present slice is
 * ALWAYS adopted (divergence resolves in the preset's favor), and only the
 * no-usable-preset cases (null/dangling pointer, missing/corrupt file)
 * fall back to the config document's own slice.
 */
import { describe, expect, it } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { PetweenConfig } from '../../src/core/types'
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

describe('buildConfigView (preset-authority phase 2)', () => {
  it('a null slice (null/dangling pointer, missing or corrupt file) returns the config itself', () => {
    const config = makeConfig()
    expect(buildConfigView(config, null)).toBe(config)
  })

  it('an in-sync preset slice is adopted (the steady state)', () => {
    const config = makeConfig()
    const slice = clone(petSliceFromConfig(config))
    const view = buildConfigView(config, slice)
    expect(view).toEqual(config)
    expect(view).not.toBe(config)
    expect(view.poses).toBe(slice.poses)
    expect(view.states).toBe(slice.states)
    expect(view.global.scale).toBe(slice.scale)
  })

  it('a diverged scale resolves in the PRESET\'s favor (the slice moved out of the document)', () => {
    const config = makeConfig()
    const slice: PetSlice = { ...clone(petSliceFromConfig(config)), scale: 2.5 }
    const view = buildConfigView(config, slice)
    expect(view.global.scale).toBe(2.5)
    expect(view.poses).toBe(slice.poses)
    // Non-slice fields stay the document's own.
    expect(view.global.transition).toBe(config.global.transition)
    expect(view.overlay).toBe(config.overlay)
    expect(view.advanced).toBe(config.advanced)
    expect(view.interactions).toBe(config.interactions)
    expect(view.activePetId).toBe(config.activePetId)
  })

  it('diverged poses and states resolve in the preset\'s favor', () => {
    const config = makeConfig()
    const slice = clone(petSliceFromConfig(config))
    slice.poses.idle.assetId = 'ffffffffffffffff'
    slice.states.idle.enter.preset = 'comic-pop'
    const view = buildConfigView(config, slice)
    expect(view.poses.idle.assetId).toBe('ffffffffffffffff')
    expect(view.states.idle.enter.preset).toBe('comic-pop')
  })

  it('a v2 global document (default slice) presents the preset slice verbatim', () => {
    // The phase-2 steady state: the document's own slice is just the
    // defaults — everything visible comes from the preset.
    const config = createDefaultPetweenConfig()
    config.activePetId = 'pet_abc123'
    const slice: PetSlice = { ...clone(petSliceFromConfig(makeConfig())), scale: 1.8 }
    const view = buildConfigView(config, slice)
    expect(view.global.scale).toBe(1.8)
    expect(view.poses.idle.assetId).toBe('0123456789abcdef')
    expect(view.states.idle.enter.preset).toBe('jelly')
    expect(view.version).toBe(1) // the legacy view shape is unchanged
  })
})
