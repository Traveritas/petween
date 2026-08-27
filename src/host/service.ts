/**
 * host/service.ts — the cordis surface companion plugins consume
 * (`inject: ['petween']`, provided by src/index.ts).
 *
 * Two query-free capabilities: registerAnimation persists an
 * AnimationDefinition into the shared animation library
 * ($DSH_HOME/petween/animations/) through the same AnimationsStore the
 * editor's PUT /api/petween/animations writes — one library, one
 * validation path, one atomic-write discipline; hasAnimation lets a
 * companion install its factory defaults only when absent, so user edits
 * survive companion reloads. The browser-side editor keeps using HTTP;
 * in-process host companions get the service because cross-plugin
 * collaboration goes through cordis, not module imports.
 *
 * Consequences of delegating to AnimationsStore.save:
 * - ids must live in the `user:` namespace with a filename-safe charset;
 *   companion packs conventionally use `user:<pack>-<name>` (e.g.
 *   `user:motion-run-wall-bounce`) so they collide neither with editor-made
 *   ids nor with each other;
 * - re-registering the same id overwrites the file (installs are idempotent,
 *   upgrades replace in place);
 * - uninstalling a companion leaves its animations in the library for the
 *   user to manage in the editor — the library is the plugin's single source
 *   of truth, not the companion's (agreed semantics).
 */
import type { AnimationDefinition } from '../motion/animation-definition'
import { AnimationError, type AnimationsStore } from './animations'

/** The host-half service contract. Bump and widen, never mutate in place. */
export interface PetweenHostService {
  readonly version: 1
  /**
   * Validate and persist a definition into the shared animation library.
   * Rejects with AnimationError('INVALID_DEFINITION') on schema violations
   * or ids outside the `user:` namespace; resolves once the atomic write
   * completed.
   *
   * 2026-08-27 widening — optional pack isolation: with `meta.pack` the id
   * must live under `user:<pack>-` (reject otherwise). That makes a
   * pack-scoped register structurally unable to touch the user's hand-made
   * animations or another companion's ids — the overwrite-in-place upgrade
   * semantics then only ever replace the pack's own entries.
   */
  registerAnimation(definition: AnimationDefinition, meta?: { pack?: string }): Promise<void>
  /**
   * Whether the library already holds `id` — companions register their
   * factory defaults only when missing, so a user's edits to a companion's
   * animation survive companion reloads/upgrades.
   */
  hasAnimation(id: string): Promise<boolean>
}

/** Pack ids share the user: charset after their prefix. */
const PACK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Build the service over a store; src/index.ts provides the result on ctx. */
export function createPetweenHostService(
  store: Pick<AnimationsStore, 'save' | 'exists'>,
): PetweenHostService {
  return {
    version: 1,
    registerAnimation: (definition, meta) => {
      if (meta?.pack !== undefined) {
        if (!PACK_RE.test(meta.pack)) {
          return Promise.reject(new AnimationError('INVALID_DEFINITION', `invalid pack id ${JSON.stringify(meta.pack)}`))
        }
        if (!definition.id.startsWith(`user:${meta.pack}-`)) {
          return Promise.reject(
            new AnimationError('INVALID_DEFINITION', `id "${definition.id}" is outside the user:${meta.pack}- namespace`),
          )
        }
      }
      return store.save(definition)
    },
    hasAnimation: (id) => Promise.resolve(store.exists(id)),
  }
}
