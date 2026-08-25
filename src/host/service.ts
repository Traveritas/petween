/**
 * host/service.ts — the cordis surface companion plugins consume
 * (`inject: ['motion-pet']`, provided by src/index.ts).
 *
 * V1 is deliberately one method: registerAnimation persists an
 * AnimationDefinition into the shared animation library
 * ($DSH_HOME/motion-pet/animations/) through the same AnimationsStore the
 * editor's PUT /api/motion-pet/animations writes — one library, one
 * validation path, one atomic-write discipline. The browser-side editor keeps
 * using HTTP; in-process host companions get the service because cross-plugin
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
import type { AnimationsStore } from './animations'

/** The host-half service contract. Bump and widen, never mutate in place. */
export interface MotionPetHostService {
  readonly version: 1
  /**
   * Validate and persist a definition into the shared animation library.
   * Rejects with AnimationError('INVALID_DEFINITION') on schema violations
   * or ids outside the `user:` namespace; resolves once the atomic write
   * completed.
   */
  registerAnimation(definition: AnimationDefinition): Promise<void>
}

/** Build the service over a store; src/index.ts provides the result on ctx. */
export function createMotionPetHostService(store: Pick<AnimationsStore, 'save'>): MotionPetHostService {
  return {
    version: 1,
    registerAnimation: (definition) => store.save(definition),
  }
}
