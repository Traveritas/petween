/**
 * motion/animation-registry.ts — unified registry for built-in and user
 * animations (spec §8.13).
 *
 * Protection rules (locked by tests):
 * - `builtin:*` is a reserved namespace: user `register` cannot claim it and
 *   `unregister` cannot remove a built-in.
 * - ids are unique: re-registering an existing id throws (customize = clone
 *   to a fresh `user:<uuid>`, §8.15).
 */
import { BUILTIN_AMBIENT_DEFINITIONS } from '../core/ambient-presets'
import { BUILTIN_TRANSITION_DEFINITIONS } from '../core/transition-presets'
import type { AnimationDefinition, AnimationKind } from './animation-definition'
import { assertValidAnimationDefinition } from './animation-definition'

const BUILTIN_PREFIX = 'builtin:'

export class AnimationRegistry {
  private readonly definitions = new Map<string, AnimationDefinition>()
  private readonly protectedIds = new Set<string>()

  get(id: string): AnimationDefinition | undefined {
    return this.definitions.get(id)
  }

  list(kind?: AnimationKind): AnimationDefinition[] {
    const all = [...this.definitions.values()]
    return kind === undefined ? all : all.filter((definition) => definition.kind === kind)
  }

  /** Register a user animation. Throws on invalid schema, builtin namespace, or duplicate id. */
  register(definition: AnimationDefinition): void {
    assertValidAnimationDefinition(definition)
    if (definition.id.startsWith(BUILTIN_PREFIX)) {
      throw new Error(`cannot register "${definition.id}": the "builtin:" namespace is reserved`)
    }
    if (this.definitions.has(definition.id)) {
      throw new Error(`cannot register "${definition.id}": id already registered`)
    }
    this.definitions.set(definition.id, definition)
  }

  /** Built-in presets only: registered once at startup and protected afterwards. */
  registerBuiltin(definition: AnimationDefinition): void {
    assertValidAnimationDefinition(definition)
    if (this.definitions.has(definition.id)) {
      throw new Error(`cannot register "${definition.id}": id already registered`)
    }
    this.definitions.set(definition.id, definition)
    this.protectedIds.add(definition.id)
  }

  unregister(id: string): void {
    if (this.protectedIds.has(id)) {
      throw new Error(`cannot unregister "${id}": built-in animations are protected`)
    }
    this.definitions.delete(id)
  }
}

/** Registry pre-loaded with every built-in transition and ambient definition. */
export function createBuiltinRegistry(): AnimationRegistry {
  const registry = new AnimationRegistry()
  for (const definition of BUILTIN_TRANSITION_DEFINITIONS) registry.registerBuiltin(definition)
  for (const definition of BUILTIN_AMBIENT_DEFINITIONS) registry.registerBuiltin(definition)
  return registry
}
