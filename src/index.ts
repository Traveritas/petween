/**
 * petween host half — config persistence, image assets and the
 * `/api/petween/*` + `/petween-assets/*` HTTP API (spec §18–§20).
 * Wiring only: all logic lives in src/host/*, which stays DSH-free except
 * for the official home-paths/atomic-write helpers.
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AnimationsStore } from './host/animations'
import { AssetStore } from './host/assets'
import { ConfigStore } from './host/config'
import { createWriteLock } from './host/storage'
import { registerEditorPage } from './host/editor-page'
import { PetsStore, petSliceFromConfig } from './host/pets'
import { registerRoutes, type RoutesDeps } from './host/routes'
import { createPetweenHostService } from './host/service'
import { attachStateChannel } from './host/state-channel'
import { migrateLegacyHome } from './host/migrate'

export const name = 'petween'
export const inject = ['webServer']
/** Loader metadata: this plugin owns the `petween` companion service. */
export const provide = ['petween']

// Community mount-once convention (M0 §1): the bundle patch and a standalone
// install can both load this module; the second fiber must not double-
// register routes (duplicate (kind, path) registration throws). The flag is
// set only after every registration succeeded (inside the effect below), so a
// mid-init failure never wedges later in-process reloads behind a stale flag.
const MOUNT_FLAG = Symbol.for('petween/host')

export function apply(ctx: Context) {
  const registry = globalThis as unknown as Record<symbol, true | undefined>
  if (registry[MOUNT_FLAG] === true) return

  // Petween rename (v1.2.0): move $DSH_HOME/motion-pet onto
  // $DSH_HOME/petween BEFORE any store exists — a store constructed first
  // would read/write defaults from the empty new root and race the move.
  // The migration is idempotent, never deletes legacy data, and only warns
  // when even its copy fallback fails (see host/migrate.ts).
  migrateLegacyHome(dshHomePath('motion-pet'), dshHomePath('petween'))
  const root = dshHomePath('petween')
  // B10: ONE write lock shared by every store — cross-store mutations (a
  // config save vs. an asset delete's reference probe, a pet mirror write vs.
  // an animation delete) can no longer interleave, closing the cross-store
  // TOCTOU window the per-store chains left open.
  const sharedWriteLock = createWriteLock()
  const animationsStore = new AnimationsStore({ animationsDir: join(root, 'animations'), lock: sharedWriteLock })
  const petsStore = new PetsStore({ petsDir: join(root, 'pets'), lock: sharedWriteLock })
  const configStore = new ConfigStore({
    configPath: join(root, 'config.json'),
    lock: sharedWriteLock,
    animationLookup: (id) => animationsStore.kindOf(id),
    // Pet-preset mirror (V1.1): every config save re-writes the active
    // preset's slice, so editor changes to the current pet automatically
    // belong to that preset. Failures warn inside ConfigStore, never roll back.
    onSaved: async (config) => {
      if (config.activePetId !== null) await petsStore.saveSlice(config.activePetId, petSliceFromConfig(config))
    },
  })
  const assetStore = new AssetStore({
    assetsDir: join(root, 'assets'),
    manifestPath: join(root, 'assets.json'),
    lock: sharedWriteLock,
  })

  const deps: RoutesDeps = {
    loadConfig: () => configStore.load(),
    updateConfig: (patch, options) => configStore.update(patch, options),
    configRevision: () => configStore.revision(),
    listAssets: () => assetStore.list(),
    saveAsset: (buffer, declaredMime) => assetStore.save(buffer, declaredMime),
    deleteAsset: (id, referencedBy) => assetStore.delete(id, referencedBy),
    resolveAssetPath: (id) => assetStore.resolve(id),
    maxAssetBytes: assetStore.maxFileBytes,
    listAnimations: () => animationsStore.loadAll(),
    saveAnimation: (definition) => animationsStore.save(definition),
    deleteAnimation: (id, referencedBy) => animationsStore.delete(id, referencedBy),
    listPets: () => petsStore.list(),
    createPet: (name, slice) => petsStore.create(name, slice),
    readPet: (id) => petsStore.read(id),
    renamePet: (id, name) => petsStore.rename(id, name),
    deletePet: (id) => petsStore.delete(id),
  }

  // Directories are created lazily on first write (storage mkdir -p).
  // ctx.effect runs the callback synchronously while the fiber is active, so
  // the check above and the flag set below stay atomic against a second fiber.
  return ctx.effect(() => {
    let disposeRoutes: (() => void) | null = null
    let disposeEditor: (() => void) | null = null
    let disposeService: (() => void) | null = null
    try {
      disposeRoutes = registerRoutes(ctx, deps)
      // Standalone full-page settings editor at /petween-editor/.
      disposeEditor = registerEditorPage(ctx)
      // M4: agent-state SSE channel (session/event + agent/status + agent/error).
      const channel = attachStateChannel(ctx)
      // Companion service (L1): host plugins inject 'petween' to register
      // animations into the shared library. Provided last so a throw in any
      // registration above never advertises a service whose routes are gone.
      disposeService = ctx.provide('petween', createPetweenHostService(animationsStore))
      // Mark as mounted only once every registration succeeded: a mid-init
      // throw must not wedge later in-process reloads behind a stale flag.
      registry[MOUNT_FLAG] = true
      return () => {
        disposeService?.()
        channel.dispose()
        disposeEditor?.()
        disposeRoutes?.()
        registry[MOUNT_FLAG] = undefined
      }
    } catch (error) {
      disposeService?.() // roll back whatever registered before the throw
      disposeEditor?.() // roll back whatever registered before the throw
      disposeRoutes?.()
      registry[MOUNT_FLAG] = undefined
      throw error
    }
  }, 'petween: routes')
}
