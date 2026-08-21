/**
 * client/custom-animations.ts — sync the hub's custom AnimationDefinition
 * list into a session registry (V1.1 P0, plan §3).
 *
 * Both sessions (overlay + settings preview) run the same reconciliation:
 * a custom that is new registers, one whose content changed is unregistered
 * and re-registered, one that vanished from the hub is unregistered. Only the
 * `user:*` namespace is touched — built-ins are registry-protected and the
 * preview session's scratch draft id is left alone. A single failing
 * definition (invalid schema, id collision) is reported as a warning instead
 * of blocking the rest.
 */
import type { AnimationDefinition } from '../motion/animation-definition'
import type { AnimationRegistry } from '../motion/animation-registry'

const USER_PREFIX = 'user:'

/**
 * In-memory scratch id for the animation library's 试播 (PreviewSession.
 * previewDefinition re-registers the edited draft under it). Never persisted
 * and never touched by the customs sync.
 */
export const DRAFT_ANIMATION_ID = 'user:0draft'

function sameDefinition(a: AnimationDefinition, b: AnimationDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Reconcile registry user:* entries with the served customs; returns warnings. */
export function syncCustomAnimations(registry: AnimationRegistry, customs: AnimationDefinition[]): string[] {
  const warnings: string[] = []
  const incoming = new Map<string, AnimationDefinition>()
  for (const definition of customs) {
    // The host only serves user:* ids; stay defensive so a bad entry can
    // never unregister a built-in or the scratch draft.
    if (!definition.id.startsWith(USER_PREFIX) || definition.id === DRAFT_ANIMATION_ID) continue
    incoming.set(definition.id, definition)
  }

  // Sweep registered user definitions that vanished or changed.
  for (const registered of registry.list()) {
    if (!registered.id.startsWith(USER_PREFIX) || registered.id === DRAFT_ANIMATION_ID) continue
    const next = incoming.get(registered.id)
    if (next !== undefined && sameDefinition(next, registered)) continue
    try {
      registry.unregister(registered.id)
    } catch (error) {
      warnings.push(`unregister "${registered.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Register new arrivals and the changed ones swept above. A definition the
  // schema rejects (host data should be pre-validated; stay defensive) is
  // degraded to a warning instead of blocking the rest.
  for (const [id, definition] of incoming) {
    const current = registry.get(id)
    if (current !== undefined && sameDefinition(current, definition)) continue
    try {
      registry.register(definition)
    } catch (error) {
      warnings.push(`register "${id}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return warnings
}
