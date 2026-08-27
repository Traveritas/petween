/**
 * custom-animations.ts tests (V1.1 P0): the registry reconciliation the
 * sessions run on hub snapshots — new customs register, changed ones are
 * swapped, vanished ones are removed; built-ins and the preview scratch draft
 * id are never touched, and a single bad definition degrades to a warning.
 */
import { describe, expect, it } from 'vitest'
import { DRAFT_ANIMATION_ID, syncCustomAnimations } from '../../src/client/custom-animations'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { BUILTIN_CLICK_POP } from '../../src/core/transition-presets'
import { createBuiltinRegistry } from '../../src/motion/animation-registry'

const makeCustom = (id: string, durationMs = 300): AnimationDefinition => ({
  version: 1,
  id,
  name: `Custom ${id}`,
  kind: 'interaction',
  durationMs,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 0 },
        { at: 1, value: 12 },
      ],
    },
  ],
})

describe('syncCustomAnimations', () => {
  it('registers new customs on top of the built-ins', () => {
    const registry = createBuiltinRegistry()
    const builtinCount = registry.list().length
    const warnings = syncCustomAnimations(registry, [makeCustom('user:a'), makeCustom('user:b')])
    expect(warnings).toEqual([])
    expect(registry.get('user:a')).toBeDefined()
    expect(registry.get('user:b')).toBeDefined()
    expect(registry.list()).toHaveLength(builtinCount + 2)
  })

  it('B6: pack-namespace customs sync like user: ones (every non-builtin id is custom territory)', () => {
    const registry = createBuiltinRegistry()
    const warnings = syncCustomAnimations(registry, [makeCustom('motion:wall-bounce')])
    expect(warnings).toEqual([])
    expect(registry.get('motion:wall-bounce')).toBeDefined()
    // …and vanish on the next sync, while builtin:* stays registry-owned.
    const builtinCount = registry.list().length
    expect(syncCustomAnimations(registry, [])).toEqual([])
    expect(registry.get('motion:wall-bounce')).toBeUndefined()
    expect(registry.list()).toHaveLength(builtinCount - 1)
  })

  it('re-registers a changed custom and unregisters a vanished one', () => {
    const registry = createBuiltinRegistry()
    syncCustomAnimations(registry, [makeCustom('user:a', 300), makeCustom('user:b')])
    const before = registry.get('user:a')

    const warnings = syncCustomAnimations(registry, [makeCustom('user:a', 450)])
    expect(warnings).toEqual([])
    expect(registry.get('user:b')).toBeUndefined() // vanished
    const after = registry.get('user:a')
    expect(after).not.toBe(before) // swapped object
    expect(after?.durationMs).toBe(450)
  })

  it('is a no-op for identical content (no unregister/register churn)', () => {
    const registry = createBuiltinRegistry()
    syncCustomAnimations(registry, [makeCustom('user:a')])
    const before = registry.get('user:a')
    const warnings = syncCustomAnimations(registry, [makeCustom('user:a')])
    expect(warnings).toEqual([])
    expect(registry.get('user:a')).toBe(before) // same object, untouched
  })

  it('never touches built-ins, even when a "custom" entry claims a builtin id', () => {
    const registry = createBuiltinRegistry()
    registry.registerBuiltin(BUILTIN_CLICK_POP)
    const builtinIds = registry.list().map((definition) => definition.id)
    const impostor = { ...makeCustom('user:x'), id: 'builtin:click-pop' }
    const warnings = syncCustomAnimations(registry, [impostor])
    expect(warnings).toEqual([]) // the non-user id is filtered out silently
    expect(registry.get('builtin:click-pop')).toBe(BUILTIN_CLICK_POP)
    expect(registry.list().map((definition) => definition.id)).toEqual(builtinIds)
    expect(() => syncCustomAnimations(registry, [])).not.toThrow()
    expect(registry.get('builtin:click-pop')).toBe(BUILTIN_CLICK_POP)
  })

  it('preserves the preview scratch draft id across syncs', () => {
    const registry = createBuiltinRegistry()
    registry.register({ ...makeCustom(DRAFT_ANIMATION_ID), name: 'Draft' })
    syncCustomAnimations(registry, [makeCustom('user:a')])
    expect(registry.get(DRAFT_ANIMATION_ID)?.name).toBe('Draft')
    // a served custom claiming the draft id is filtered out, never clobbering it
    const warnings = syncCustomAnimations(registry, [makeCustom(DRAFT_ANIMATION_ID, 999)])
    expect(warnings).toEqual([])
    expect(registry.get(DRAFT_ANIMATION_ID)?.durationMs).toBe(300)
  })

  it('an invalid custom degrades to a warning without blocking the others', () => {
    const registry = createBuiltinRegistry()
    // A non-whitelist motion property fails the schema at register time.
    const invalid = {
      ...makeCustom('user:bad'),
      tracks: [{ property: 'css.transform', keyframes: [{ at: 0, value: 1 }] }],
    } as unknown as AnimationDefinition
    const warnings = syncCustomAnimations(registry, [invalid, makeCustom('user:good')])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('user:bad')
    expect(registry.get('user:bad')).toBeUndefined()
    expect(registry.get('user:good')).toBeDefined()
  })
})
