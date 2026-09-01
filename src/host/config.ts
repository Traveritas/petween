/**
 * host/config.ts — config.json persistence (spec §18).
 *
 * Preset-authority phase 2 (docs/preset-authority-eval.md §2): config.json is
 * the v2 GLOBAL document — `{version: 2, enabled, global (WITHOUT scale),
 * overlay, advanced, interactions, activePetId}`. The character slice
 * (poses / states / global.scale) lives in the pet presets; the "current
 * config" clients see is the materialized view assembled by
 * host/view-store.ts (GET /config keeps the legacy v1 shape).
 *
 * `loadConfig` stays the single migration entry (§18.3) and reads BOTH v1
 * and v2 files: repairConfig fills the fields a v2 document does not carry
 * from the defaults, so a v1 full document and a v2 global document load
 * through the same path (the v1 read path retires in phase 4; the boot-time
 * v1→v2 file migration lives in host/migrate-v2.ts). The writer only ever
 * persists the v2 projection.
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PetweenConfig } from '../core/types'
import type { AnimationKind } from '../motion/animation-definition'
import { readJsonFile, writeJsonAtomic, createWriteLock, type WriteLock } from './storage'
import { repairConfig, validateGlobalPatch, type ConfigValidationOptions } from './validation'

export function defaultConfigPath(): string {
  return dshHomePath('petween', 'config.json')
}

/** Migration entry (spec §18.3): validate + defaults + version handling. */
export function loadConfig(raw: unknown, options: ConfigValidationOptions = {}): PetweenConfig {
  return repairConfig(raw, options)
}

/**
 * The persisted v2 document (preset authority): the global segments only.
 * `activePetId` points at the preset owning the character slice; it is never
 * null once the boot migration / repair paths ran (form (i) — every edit
 * belongs to a pet).
 */
export interface GlobalDocument {
  version: 2
  enabled: boolean
  global: {
    transition: PetweenConfig['global']['transition']
    reducedMotion: PetweenConfig['global']['reducedMotion']
    successHoldMs: number
    errorHoldMs: number
  }
  overlay: PetweenConfig['overlay']
  advanced: PetweenConfig['advanced']
  interactions: PetweenConfig['interactions']
  activePetId: string | null
}

/**
 * Project the v2 global document out of a full config shape. The writer's
 * only output form — the slice fields (poses / states / global.scale) are
 * deliberately dropped: presets own them now.
 */
export function toGlobalDocument(config: PetweenConfig): GlobalDocument {
  return {
    version: 2,
    enabled: config.enabled,
    global: {
      transition: config.global.transition,
      reducedMotion: config.global.reducedMotion,
      successHoldMs: config.global.successHoldMs,
      errorHoldMs: config.global.errorHoldMs,
    },
    overlay: config.overlay,
    advanced: config.advanced,
    interactions: config.interactions,
    activePetId: config.activePetId,
  }
}

/**
 * B3 optimistic concurrency: the PUT's `x-petween-expected-revision` did not
 * match the current counter (routes maps this to 409 REVISION_MISMATCH).
 * The current value rides along so the client can rebase and retry.
 */
export class RevisionMismatchError extends Error {
  override readonly name = 'RevisionMismatchError'
  constructor(readonly currentRevision: number) {
    super(`config revision mismatch: the expected revision is stale, current is ${currentRevision}`)
  }
}

export interface ConfigStoreOptions {
  /** Defaults to `$DSH_HOME/petween/config.json` (spec §18.1). */
  configPath?: string
  /** Custom-animation kind lookup for animation mounts (V1.1). */
  animationLookup?: (id: string) => AnimationKind | undefined
  /**
   * Shared cross-store write serializer (B10). Default: a private chain
   * (this store only); src/index.ts passes one lock shared with the asset/
   * animation/pet stores so cross-store mutations cannot interleave.
   */
  lock?: WriteLock
  /** Revision-counter sidecar; defaults next to the config file. */
  revisionPath?: string
}

export class ConfigStore {
  readonly configPath: string
  readonly revisionPath: string
  private readonly animationLookup?: (id: string) => AnimationKind | undefined
  /** Serializes update() so concurrent writes never lose each other's fields. */
  private readonly lock: WriteLock
  private revisionCache: number | null = null

  constructor(options: ConfigStoreOptions = {}) {
    this.configPath = options.configPath ?? defaultConfigPath()
    this.revisionPath = options.revisionPath ?? `${this.configPath.replace(/\.json$/, '')}.revision.json`
    this.animationLookup = options.animationLookup
    this.lock = options.lock ?? createWriteLock()
  }

  /**
   * Load + repair; defaults when the file is missing or corrupt. Reads BOTH
   * v1 (full document) and v2 (global document) — a v2 file repairs to a
   * full shape whose slice fields hold the DEFAULTS; the view layer replaces
   * them with the active preset's slice.
   */
  async load(): Promise<PetweenConfig> {
    return loadConfig(await readJsonFile(this.configPath), { animationLookup: this.animationLookup })
  }

  /**
   * Atomic save (temp + fsync + rename, see host/storage.ts) — WITHOUT the
   * revision bump: a direct save bypasses optimistic concurrency by design.
   * The writer only persists the v2 global projection (phase 2); business
   * writes must go through updateGlobals(). This stays public for tests and
   * one-off migration-style setup only.
   */
  async save(config: PetweenConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, toGlobalDocument(config))
  }
  /**
   * B3: the monotonic config revision. Persisted in a sidecar file (the
   * config schema itself is client-visible and must not grow server-owned
   * fields), bumped exactly once per successful updateGlobals(); missing/corrupt
   * sidecar → 0 (a fresh install). Cached after the first read.
   *
   * Phase 2: the SAME single counter also covers slice and pointer writes —
   * every view-affecting mutation funnels through host/view-store.ts, which
   * rides this bump, so polling clients see one monotonically moving
   * revision for any config-view change.
   */
  async revision(): Promise<number> {
    if (this.revisionCache !== null) return this.revisionCache
    const raw = await readJsonFile<{ revision?: unknown }>(this.revisionPath)
    const revision = typeof raw?.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
    // Monotonic merge, never a plain overwrite: the routes read the revision
    // OUTSIDE the write lock, so this read can interleave with an update()'s
    // bump — adopting an older file value here would roll the cache back and
    // let a stale expectedRevision pass the B3 conflict check.
    this.revisionCache = Math.max(revision, this.revisionCache ?? 0)
    return this.revisionCache
  }

  /**
   * Serialized read-merge-write of the GLOBAL document (§19.2 + phase 2):
   * the patch's global segments (enabled, the transition/reducedMotion/holds
   * triplet, overlay, advanced, interactions, activePetId) are strictly
   * validated against the CURRENT on-disk document and the v2 projection is
   * atomically saved, as one unit per caller. Slice fields in the patch are
   * not read here — they route through the view-store funnel to the active
   * preset. `expectedRevision` (B3, optional) opts a writer INTO conflict
   * detection: a mismatch rejects with RevisionMismatchError BEFORE any
   * write happens; writers that omit it keep the last-writer-wins behavior
   * unchanged.
   */
  updateGlobals(patch: unknown, options: { expectedRevision?: number } = {}): Promise<PetweenConfig> {
    return this.lock(async () => {
      const currentRevision = await this.revision()
      if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
        throw new RevisionMismatchError(currentRevision)
      }
      const config = validateGlobalPatch(patch, await this.load(), { animationLookup: this.animationLookup })
      const revision = currentRevision + 1
      // Fail-closed ordering (2026-08-28 review follow-up): the counter moves
      // BEFORE the config write. A crash between the two writes can then only
      // produce a spurious REVISION_MISMATCH (a client retry heals) — never a
      // lagged counter that would let a stale expectedRevision pass, which is
      // exactly the conflict B3 exists to flag. A failed sidecar write also
      // leaves the config untouched on disk.
      await writeJsonAtomic(this.revisionPath, { revision })
      await this.save(config)
      this.revisionCache = revision
      return config
    })
  }
}
