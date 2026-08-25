/**
 * Host storage tests (spec §18.2, §29.2): safe reads, temp+fsync+rename
 * atomic writes, no temp residue.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonFile, writeJsonAtomic } from '../../src/host/storage'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'petween-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readJsonFile', () => {
  it('returns null for a missing file', async () => {
    expect(await readJsonFile(join(dir, 'missing.json'))).toBeNull()
  })

  it('returns null for corrupt JSON', async () => {
    const file = join(dir, 'corrupt.json')
    await writeFile(file, '{ not json', 'utf8')
    expect(await readJsonFile(file)).toBeNull()
  })
})

describe('writeJsonAtomic', () => {
  it('writes JSON that reads back identically, creating parent dirs', async () => {
    const file = join(dir, 'nested', 'deep', 'config.json')
    const data = { version: 1, enabled: false, nested: { list: [1, 2, 3] } }
    await writeJsonAtomic(file, data)
    expect(await readJsonFile(file)).toEqual(data)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(data)
  })

  it('replaces existing content and leaves no .tmp residue', async () => {
    const file = join(dir, 'config.json')
    await writeJsonAtomic(file, { a: 1 })
    await writeJsonAtomic(file, { a: 2 })
    expect(await readJsonFile(file)).toEqual({ a: 2 })
    const entries = await readdir(dir)
    expect(entries).toEqual(['config.json'])
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })

  it('serializes concurrent writers; the file stays valid JSON', async () => {
    const file = join(dir, 'config.json')
    await Promise.all([
      writeJsonAtomic(file, { writer: 'a' }),
      writeJsonAtomic(file, { writer: 'b' }),
      writeJsonAtomic(file, { writer: 'c' }),
    ])
    const loaded = await readJsonFile<{ writer: string }>(file)
    expect(['a', 'b', 'c']).toContain(loaded?.writer)
    expect((await readdir(dir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })
})
