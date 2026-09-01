/**
 * client/shared-config-registry.ts — the neutral pet-package P3 collect seam
 * between companion plugins and the settings editor's export path.
 *
 * WHY this module exists: a pet record's §12 pluginConfigs pocket is a
 * SNAPSHOT — it only knows blobs a package import carried. Pets created
 * before a companion existed (or whose companion state moved on since) would
 * export an incomplete personality. Companions register a provider here; the
 * editor's export path collects every provider's CURRENT config and ships it
 * as the POST /pets/<id>/export body, and the host overlays it per namespace
 * onto the record snapshot. Cordis-free like overlay/session-surface.ts: the
 * extension service delegates here and the editor store imports it directly,
 * so neither side knows the other. Capability, not policy — blob content is
 * never interpreted on this side of the wire.
 */

/**
 * A companion's CURRENT config blob for its own §12 namespace. Returning
 * undefined abstains ("nothing to share right now") — that namespace keeps
 * the record snapshot at export time.
 */
export type SharedPluginConfigProvider = () => unknown

const providers = new Map<string, SharedPluginConfigProvider>()

/**
 * Register the export-time config provider for one plugin namespace (the
 * companion's cordis name, e.g. 'petween-physics'). Re-registering the same
 * id replaces the previous provider; the returned unregister is stale-safe —
 * it removes only its own registration, never a newer replacement. The id's
 * charset is enforced host-side at export; this module stays policy-free.
 */
export function registerSharedPluginConfigProvider(pluginId: string, provider: SharedPluginConfigProvider): () => void {
  providers.set(pluginId, provider)
  return () => {
    if (providers.get(pluginId) === provider) providers.delete(pluginId)
  }
}

/**
 * Collect every registered provider's current blob as a §12 pluginConfigs
 * object. A throwing provider (a misbehaving companion) gets a console.warn
 * and never breaks the remaining providers or the export; an undefined return
 * abstains. No providers at all (or all abstaining) returns an empty object,
 * which the export path reads as "fall back to the plain GET".
 */
export function collectSharedPluginConfigs(): Record<string, { config: unknown }> {
  const collected: Record<string, { config: unknown }> = {}
  for (const [pluginId, provider] of providers) {
    try {
      const config = provider()
      if (config !== undefined) collected[pluginId] = { config }
    } catch (error) {
      console.warn(`petween: shared config provider '${pluginId}' failed`, error)
    }
  }
  return collected
}
