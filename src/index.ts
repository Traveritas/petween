/**
 * dsh-motion-pet host half — config persistence, image assets and the
 * `/api/motion-pet/*` + `/motion-pet-assets/*` HTTP API (spec §18–§20).
 * Wiring only: all logic lives in src/host/*, which stays DSH-free except
 * for the official home-paths/atomic-write helpers.
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AnimationsStore } from './host/animations'
import { AssetStore } from './host/assets'
import { ConfigStore } from './host/config'
import { registerEditorPage } from './host/editor-page'
import { registerRoutes, type RoutesDeps } from './host/routes'
import { attachStateChannel } from './host/state-channel'

export const name = 'motion-pet'
export const inject = ['webServer']

// Community mount-once convention (M0 §1): the bundle patch and a standalone
// install can both load this module; the second fiber must not double-
// register routes (duplicate (kind, path) registration throws). The flag is
// set only after every registration succeeded (inside the effect below), so a
// mid-init failure never wedges later in-process reloads behind a stale flag.
const MOUNT_FLAG = Symbol.for('dsh-motion-pet/host')

export function apply(ctx: Context) {
  const registry = globalThis as unknown as Record<symbol, true | undefined>
  if (registry[MOUNT_FLAG] === true) return

  const root = dshHomePath('motion-pet')
  const animationsStore = new AnimationsStore({ animationsDir: join(root, 'animations') })
  const configStore = new ConfigStore({
    configPath: join(root, 'config.json'),
    animationExists: (id) => animationsStore.exists(id),
  })
  const assetStore = new AssetStore({
    assetsDir: join(root, 'assets'),
    manifestPath: join(root, 'assets.json'),
  })

  const deps: RoutesDeps = {
    loadConfig: () => configStore.load(),
    updateConfig: (patch) => configStore.update(patch),
    listAssets: () => assetStore.list(),
    saveAsset: (buffer, declaredMime) => assetStore.save(buffer, declaredMime),
    deleteAsset: (id, referencedBy) => assetStore.delete(id, referencedBy),
    resolveAssetPath: (id) => assetStore.resolve(id),
    maxAssetBytes: assetStore.maxFileBytes,
    listAnimations: () => animationsStore.loadAll(),
    saveAnimation: (definition) => animationsStore.save(definition),
    deleteAnimation: (id, referencedBy) => animationsStore.delete(id, referencedBy),
  }

  // Directories are created lazily on first write (storage mkdir -p).
  // ctx.effect runs the callback synchronously while the fiber is active, so
  // the check above and the flag set below stay atomic against a second fiber.
  return ctx.effect(() => {
    let disposeRoutes: (() => void) | null = null
    let disposeEditor: (() => void) | null = null
    try {
      disposeRoutes = registerRoutes(ctx, deps)
      // Standalone full-page settings editor at /motion-pet-editor/.
      disposeEditor = registerEditorPage(ctx)
      // M4: agent-state SSE channel (session/event + agent/status + agent/error).
      const channel = attachStateChannel(ctx)
      // Mark as mounted only once every registration succeeded: a mid-init
      // throw must not wedge later in-process reloads behind a stale flag.
      registry[MOUNT_FLAG] = true
      return () => {
        channel.dispose()
        disposeEditor?.()
        disposeRoutes?.()
        registry[MOUNT_FLAG] = undefined
      }
    } catch (error) {
      disposeEditor?.() // roll back whatever registered before the throw
      disposeRoutes?.()
      registry[MOUNT_FLAG] = undefined
      throw error
    }
  }, 'motion-pet: routes')
}
