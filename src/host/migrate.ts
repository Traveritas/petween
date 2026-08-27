/**
 * host/migrate.ts — one-time home-directory rename for the Petween rename
 * (v1.2.0, 2026-08-26).
 *
 * The plugin's data root moved from `$DSH_HOME/motion-pet/` to
 * `$DSH_HOME/petween/` (config.json, assets/, assets.json, animations/,
 * pets/). Users have real data in the old directory, so src/index.ts calls
 * {@link migrateLegacyHome} once per boot BEFORE any store is constructed —
 * a store that ran first would re-create the new directory with defaults and
 * (worse) could race the move.
 *
 * Policy (strict, old data is never destroyed):
 * 1. target (`$DSH_HOME/petween`) already exists → skip entirely. A previous
 *    migration (or a fresh install that somehow has the new dir) wins; the
 *    legacy dir, if any, is left untouched for manual inspection.
 * 2. only the legacy dir exists → `fs.renameSync` it onto the target path.
 *    Rename is atomic within one volume and removes the legacy location in
 *    the same step, so there is no double-maintenance window.
 * 3. rename fails (EXDEV across volumes, EBUSY/EPERM while a file is held
 *    open on Windows) → fall back to `fs.cpSync(..., { recursive: true })`
 *    and KEEP the legacy directory. The copy is the safety net; deleting the
 *    old tree is never attempted here.
 * 4. even the copy fails (disk full, permissions) → warn, best-effort remove
 *    a half-written target so the next boot can retry, and keep booting on
 *    defaults. The plugin must not crash over its own data migration.
 *    Exception: when the legacy dir disappeared mid-flight, a concurrent
 *    process finished the migration — its target is complete data and is
 *    never removed ("skipped").
 */
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'

/** What {@link migrateLegacyHome} ended up doing. */
export type MigrationOutcome =
  /** Legacy dir renamed onto the target path (atomic, legacy gone). */
  | 'renamed'
  /** Legacy dir copied to the target; legacy kept as the safety copy. */
  | 'copied'
  /** Nothing to do: target already exists, or legacy never did. */
  | 'skipped'
  /** Both rename and copy failed; warned, partial target cleaned. */
  | 'failed'

/** Filesystem operations, injectable for tests (defaults: node:fs). */
export interface MigrateLegacyHomeDeps {
  renameDirSync(from: string, to: string): void
  copyDirSync(from: string, to: string): void
}

const defaultDeps: MigrateLegacyHomeDeps = {
  renameDirSync: (from, to) => renameSync(from, to),
  copyDirSync: (from, to) =>
    // force:false + errorOnExist:true: never overwrite anything that snuck
    // onto the target between the existsSync check and here.
    cpSync(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true }),
}

/**
 * Move one legacy data directory onto its new name, never losing data.
 * Synchronous on purpose: it must complete before the first store reads.
 */
export function migrateLegacyHome(
  legacyDir: string,
  targetDir: string,
  deps: MigrateLegacyHomeDeps = defaultDeps,
): MigrationOutcome {
  if (existsSync(targetDir)) return 'skipped'
  if (!existsSync(legacyDir)) return 'skipped'
  try {
    deps.renameDirSync(legacyDir, targetDir)
    return 'renamed'
  } catch {
    // Cross-volume or locked source: copy and keep the legacy directory.
    try {
      deps.copyDirSync(legacyDir, targetDir)
      return 'copied'
    } catch (error) {
      // Concurrency guard: two processes sharing $DSH_HOME may boot and
      // migrate at the same time. If the legacy dir is gone by now, another
      // process finished the migration after our existsSync checks — the
      // target holds its complete data, not our partial copy, and removing
      // it would destroy the only remaining copy ("old data is never
      // destroyed"). Skip instead.
      if (!existsSync(legacyDir)) return 'skipped'
      // Re-check immediately before the remove: a concurrent winner may have
      // renamed legacy onto the target AFTER the guard above passed — from
      // that moment the target is the winner's ONLY copy and rmSync would
      // destroy it. (A microsecond TOCTOU remains between this check and the
      // rmSync; on Windows a rename onto a non-empty target fails anyway, so
      // the re-check closes every practically reachable interleaving.)
      if (!existsSync(legacyDir)) return 'skipped'
      // Drop a partial copy so the next boot retries from a clean slate;
      // never touch the legacy tree.
      try {
        rmSync(targetDir, { recursive: true, force: true })
      } catch {
        /* best effort — a leftover partial dir just means "skip next boot" */
      }
      console.warn(`petween: failed to migrate ${legacyDir} to ${targetDir}`, error)
      return 'failed'
    }
  }
}
