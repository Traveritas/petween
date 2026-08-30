/**
 * host/config.ts — config.json persistence (spec §18).
 *
 * `loadConfig` is the single migration entry (§18.3): every version branch
 * lives here, never scattered into UI. Today there is only v1 — anything
 * unrecognized is repaired field-wise onto v1 defaults; a future v1 → v2
 * migration chains in ahead of the repair pass.
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PetweenConfig } from '../core/types'
import type { AnimationKind } from '../motion/animation-definition'
import { readJsonFile, writeJsonAtomic, createWriteLock, type WriteLock } from './storage'
import { repairConfig, validateConfigPatch, type ConfigValidationOptions } from './validation'

export function defaultConfigPath(): string {
  return dshHomePath('petween', 'config.json')
}

/** Migration entry (spec §18.3): validate + defaults + version handling. */
export function loadConfig(raw: unknown, options: ConfigValidationOptions = {}): PetweenConfig {
  return repairConfig(raw, options)
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
   * Post-save hook (pet-preset mirror, V1.1): runs inside the serialized
   * update, after the atomic config write. A failure is warned and swallowed
   * — the config is authoritative, the mirror is secondary.
   */
  onSaved?: (config: PetweenConfig) => Promise<void>
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
  private readonly onSaved?: (config: PetweenConfig) => Promise<void>
  /** Serializes update() so concurrent writes never lose each other's fields. */
  private readonly lock: WriteLock
  private revisionCache: number | null = null

  constructor(options: ConfigStoreOptions = {}) {
    this.configPath = options.configPath ?? defaultConfigPath()
    this.revisionPath = options.revisionPath ?? `${this.configPath.replace(/\.json$/, '')}.revision.json`
    this.animationLookup = options.animationLookup
    this.onSaved = options.onSaved
    this.lock = options.lock ?? createWriteLock()
  }

  /** Load + repair; defaults when the file is missing or corrupt. */
  async load(): Promise<PetweenConfig> {
    return loadConfig(await readJsonFile(this.configPath), { animationLookup: this.animationLookup })
  }

  /**
   * Atomic save (temp + fsync + rename, see host/storage.ts) — WITHOUT the
   * revision bump or the pet mirror: a direct save bypasses optimistic
   * concurrency by design. Business writes must go through update(); this
   * stays public for tests and one-off migration-style setup only.
   */
  async save(config: PetweenConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, config)
  }
  /**
   * B3: the monotonic config revision. Persisted in a sidecar file (the
   * config schema itself is client-visible and must not grow server-owned
   * fields), bumped exactly once per successful update(); missing/corrupt
   * sidecar → 0 (a fresh install). Cached after the first read.
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
   * Serialized read-merge-write (§19.2): the patch is strictly validated
   * against the CURRENT on-disk config and atomically saved, as one unit per
   * caller. Concurrent PUTs queue behind each other, so two writers patching
   * different fields both land instead of the later one clobbering the first.
   * `expectedRevision` (B3, optional) opts a writer INTO conflict detection:
   * a mismatch rejects with RevisionMismatchError BEFORE any write happens;
   * writers that omit it keep the last-writer-wins behavior unchanged.
   */
  update(patch: unknown, options: { expectedRevision?: number } = {}): Promise<PetweenConfig> {
    // The write segment holds the (possibly shared) lock; the pet-preset
    // mirror deliberately runs AFTER the release — onSaved calls back into
    // PetsStore, which enqueues on the SAME shared lock, so running it inside
    // the segment would wait on itself. Each mirror still carries its own
    // slice payload and queues on the shared lock, so concurrent mirrors
    // converge (the mirror is best-effort by contract; the config stays
    // authoritative).
    const run = this.lock(async () => {
      const currentRevision = await this.revision()
      if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
        throw new RevisionMismatchError(currentRevision)
      }
      const config = validateConfigPatch(patch, await this.load(), { animationLookup: this.animationLookup })
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
    }).then(async (config) => {
      if (this.onSaved !== undefined) {
        try {
          await this.onSaved(config)
        } catch (error) {
          console.warn('petween: pet preset mirror failed', error)
        }
      }
      return config
    })
    return run
  }
}
