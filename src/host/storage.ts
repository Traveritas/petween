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
