/**
 * Animation Registry tests (spec §29.0): custom registration, duplicate
 * rejection, and builtin:* protection (register + unregister).
 */
import { describe, expect, it } from 'vitest'
import { AnimationRegistry, createBuiltinRegistry } from '../../src/motion/animation-registry'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

const customDefinition = (id = 'user:wiggle'): AnimationDefinition => ({
  version: 1,
  id,
  name: 'Wiggle',
  kind: 'interaction',
  durationMs: 200,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 0 },
        { at: 0.5, value: { base: 0, parameter: 'strength', amount: 10 } },
        { at: 1, value: 0 },
      ],
    },
  ],
})

describe('AnimationRegistry', () => {
  it('createBuiltinRegistry pre-registers all built-in transitions and ambients', () => {
    const registry = createBuiltinRegistry()
    const ids = registry.list().map((definition) => definition.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'builtin:none',
        'builtin:soft',
        'builtin:comic-pop',
        'builtin:jelly',
        'builtin:jump',
        'builtin:snap',
        'builtin:flip',
        'builtin:celebrate',
        'builtin:deflate',
        'builtin:activity-swap',
        'builtin:bounce',
        'builtin:sway',
        'builtin:breathe',
      ]),
    )
    expect(registry.list('ambient')).toHaveLength(3)
    expect(registry.list('transition')).toHaveLength(10)
  })

  it('registers, gets, lists and unregisters custom definitions', () => {
    const registry = createBuiltinRegistry()
    const definition = customDefinition()
    registry.register(definition)
    expect(registry.get('user:wiggle')).toBe(definition)
    expect(registry.list('interaction')).toEqual([definition])
    registry.unregister('user:wiggle')
    expect(registry.get('user:wiggle')).toBeUndefined()
    // unregistering an unknown id is a no-op
    expect(() => registry.unregister('user:never-registered')).not.toThrow()
  })

  it('rejects duplicate ids', () => {
    const registry = createBuiltinRegistry()
    registry.register(customDefinition())
    expect(() => registry.register(customDefinition())).toThrow(/already registered/)
  })

  it('protects the builtin: namespace from user registration (§8.13)', () => {
    const registry = createBuiltinRegistry()
    const impostor = customDefinition('builtin:evil-pop')
    expect(() => registry.register(impostor)).toThrow(/reserved/)
    // even re-registering over an existing builtin id is refused
    expect(() => registry.register(customDefinition('builtin:comic-pop'))).toThrow(/reserved/)
  })

  it('protects built-ins from unregister', () => {
    const registry = createBuiltinRegistry()
    expect(() => registry.unregister('builtin:comic-pop')).toThrow(/protected/)
    expect(registry.get('builtin:comic-pop')).toBeDefined()
  })

  it('rejects invalid definitions at registration time', () => {
    const registry = new AnimationRegistry()
    const broken = customDefinition()
    broken.tracks[0].property = 'transition.color' as never
    expect(() => registry.register(broken)).toThrow(/unknown motion property/)
  })
})
