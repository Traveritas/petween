/**
 * host/storage.ts — JSON file persistence (spec §18.2).
 *
 * Reads never throw: a missing or corrupt file yields null and the caller
 * falls back to defaults. Writes are temp + fsync + rename; the official
 * `writeFileAtomic` deliberately skips fsync (M0 finding §2), so the write is
 * hand-rolled here while its `withFileLock` is reused to serialize writers of
 * the same file (in-process and cross-process).
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** Read and parse a JSON file; null when absent or unparsable. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Replace `filePath` with `data` atomically (spec §18.2):
 * `<path>.tmp` → write + fsync + close → rename → best-effort dir fsync.
 * Concurrent writers are serialized through the official `withFileLock`
 * (`<path>.lock` sibling, released on both outcomes).
 */
export async function writeJsonAtomic<T>(filePath: string, data: T): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const content = JSON.stringify(data, null, 2)
  await withFileLock(filePath, async () => {
    const tmp = `${filePath}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, filePath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    // Best effort: directory entry durability. Unsupported on some platforms.
    try {
      const dirHandle = await open(dir, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      /* directory fsync not supported — rename alone still satisfies §18.2 */
    }
  })
}

/**
 * Synchronous twin of {@link writeJsonAtomic} for the boot-time v1→v2
 * migration (host/migrate-v2.ts): it must complete before the first store
 * exists, so the async/lock machinery is unavailable. Same temp + fsync +
 * rename discipline, minus the cross-process file lock — boot migrations run
 * before any other writer can exist (the legacy-home rename in
 * host/migrate.ts sets the precedent).
 */
export function writeJsonAtomicSync<T>(filePath: string, data: T): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const content = JSON.stringify(data, null, 2)
  const tmp = `${filePath}.tmp`
  const handle = openSync(tmp, 'w')
  try {
    writeFileSync(handle, content, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(tmp, filePath)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  // Best effort: directory entry durability. Unsupported on some platforms.
  try {
    const dirHandle = openSync(dir, 'r')
    try {
      fsyncSync(dirHandle)
    } finally {
      closeSync(dirHandle)
    }
  } catch {
    /* directory fsync not supported — rename alone still satisfies §18.2 */
  }
}

/**
 * Minimal promise-chain serializer. Each host store owns one for its
 * read-modify-write cycles; passing the SAME lock to every store (src/index.ts)
 * additionally serializes mutations ACROSS stores, closing the cross-store
 * TOCTOU window (e.g. an asset delete checking references while a config
 * write is still in flight — B10). Reads never take the lock.
 */
export type WriteLock = <T>(op: () => Promise<T>) => Promise<T>

export function createWriteLock(): WriteLock {
  let chain: Promise<unknown> = Promise.resolve()
  return (op) => {
    const run = chain.then(op)
    chain = run.then(
      () => undefined,
      () => undefined, // a failed op must not poison the chain
    )
    return run
  }
}
