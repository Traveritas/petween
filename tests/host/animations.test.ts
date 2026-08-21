/**
 * AnimationsStore tests (V1.1 plan §3): directory scanning with per-file fault
 * tolerance, schema + namespace enforcement on save, atomic writes, serialized
 * concurrent writes, delete semantics (404/409) and traversal guards.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { AnimationError, AnimationsStore, validateAnimationId, validateUserAnimationId } from '../../src/host/animations'

let dir: string
let store: AnimationsStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'motion-pet-animations-'))
  store = new AnimationsStore({ animationsDir: join(dir, 'animations') })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A minimal valid interaction definition (no events needed for that kind). */
function makeDefinition(id: string, overrides: Record<string, unknown> = {}): AnimationDefinition {
  return {
    version: 1,
    id,
    name: 'Test Animation',
    kind: 'interaction',
    durationMs: 200,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.rotation',
        keyframes: [
          { at: 0, value: 0 },
          { at: 1, value: 0 },
        ],
      },
    ],
    ...overrides,
  } as AnimationDefinition
}

describe('AnimationsStore.loadAll', () => {
  it('returns empty lists when the directory does not exist', async () => {
    expect(await store.loadAll()).toEqual({ customs: [], warnings: [] })
  })

  it('loads every stored definition and ignores non-JSON files', async () => {
    await store.save(makeDefinition('user:wiggle'))
    await store.save(makeDefinition('user:hop'))
    await writeFile(join(dir, 'animations', 'notes.txt'), 'not an animation', 'utf8')
    const { customs, warnings } = await store.loadAll()
    expect(customs.map((definition) => definition.id)).toEqual(['user:hop', 'user:wiggle']) // sorted scan
    expect(warnings).toEqual([])
  })

  it('skips corrupt JSON, invalid definitions and builtin ids with warnings', async () => {
    await store.save(makeDefinition('user:ok'))
    await writeFile(join(dir, 'animations', 'user_broken.json'), '{ not json', 'utf8')
    await writeFile(
      join(dir, 'animations', 'user_invalid.json'),
      JSON.stringify(makeDefinition('user:invalid', { durationMs: 0 })),
      'utf8',
    )
    await writeFile(
      join(dir, 'animations', 'builtin_soft.json'),
      JSON.stringify(makeDefinition('builtin:soft')),
      'utf8',
    )
    const { customs, warnings } = await store.loadAll()
    expect(customs.map((definition) => definition.id)).toEqual(['user:ok'])
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('builtin_soft.json')
    expect(warnings[0]).toContain('user:')
    expect(warnings[1]).toContain('user_broken.json')
    expect(warnings[2]).toContain('user_invalid.json')
    expect(warnings[2]).toContain('durationMs')
  })

  it('skips a duplicate id with a warning, keeping the first file', async () => {
    await mkdir(join(dir, 'animations'), { recursive: true })
    await writeFile(join(dir, 'animations', 'user_dup.json'), JSON.stringify(makeDefinition('user:dup')), 'utf8')
    await writeFile(
      join(dir, 'animations', 'zzz.json'),
      JSON.stringify(makeDefinition('user:dup', { name: 'The Copy' })),
      'utf8',
    )
    const { customs, warnings } = await store.loadAll()
    expect(customs).toHaveLength(1)
    expect(customs[0].name).toBe('Test Animation')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('duplicate')
  })
})

describe('AnimationsStore.save', () => {
  it('writes atomically: the file round-trips and no .tmp residue remains', async () => {
    const definition = makeDefinition('user:wiggle')
    await store.save(definition)
    const onDisk = JSON.parse(await readFile(join(dir, 'animations', 'user_wiggle.json'), 'utf8'))
    expect(onDisk).toEqual(definition)
    const entries = await readdir(join(dir, 'animations'))
    expect(entries).toEqual(['user_wiggle.json'])
    const { customs } = await store.loadAll()
    expect(customs).toEqual([definition])
  })

  it('rejects schema violations with field details', async () => {
    const error = await store.save(makeDefinition('user:bad', { durationMs: 0 })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AnimationError)
    expect((error as AnimationError).code).toBe('INVALID_DEFINITION')
    expect((error as AnimationError).message).toContain('durationMs')
  })

  it('rejects non-user namespaces (builtin ids included) and traversal shapes', async () => {
    for (const id of ['builtin:soft', 'other:thing', 'user:../escape', 'user:a/b', 'user:a.b']) {
      const error = await store.save(makeDefinition(id)).catch((e: unknown) => e)
      expect(error, id).toBeInstanceOf(AnimationError)
      expect((error as AnimationError).code).toBe('INVALID_DEFINITION')
    }
    expect(await store.listIds()).toEqual([])
  })

  it('serializes concurrent writes: every save lands intact', async () => {
    const ids = ['user:a', 'user:b', 'user:c', 'user:d']
    await Promise.all(ids.map((id) => store.save(makeDefinition(id))))
    const { customs, warnings } = await store.loadAll()
    expect(warnings).toEqual([])
    expect(customs.map((definition) => definition.id).sort()).toEqual(ids)
    // a concurrent save + overwrite of the same id leaves a consistent file
    await Promise.all([
      store.save(makeDefinition('user:a', { name: 'V2' })),
      store.save(makeDefinition('user:a', { name: 'V3' })),
    ])
    const reloaded = (await store.loadAll()).customs.find((definition) => definition.id === 'user:a')
    expect(['V2', 'V3']).toContain(reloaded?.name)
  })
})

describe('AnimationsStore.delete', () => {
  it('deletes a stored animation; the file disappears', async () => {
    await store.save(makeDefinition('user:wiggle'))
    await store.delete('user:wiggle', () => false)
    expect(store.exists('user:wiggle')).toBe(false)
    expect(await store.listIds()).toEqual([])
  })

  it('throws NOT_FOUND for unknown or malformed ids', async () => {
    for (const id of ['user:missing', 'user:../escape', 'builtin:soft']) {
      const error = await store.delete(id, () => false).catch((e: unknown) => e)
      expect(error, id).toBeInstanceOf(AnimationError)
      expect((error as AnimationError).code).toBe('NOT_FOUND')
    }
  })

  it('throws IN_USE when the id is still referenced', async () => {
    await store.save(makeDefinition('user:wiggle'))
    const error = await store.delete('user:wiggle', () => true).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AnimationError)
    expect((error as AnimationError).code).toBe('IN_USE')
    expect(store.exists('user:wiggle')).toBe(true) // untouched
  })
})

describe('AnimationsStore.exists / listIds', () => {
  it('reflect the directory contents with shape filtering', async () => {
    expect(store.exists('user:wiggle')).toBe(false)
    await store.save(makeDefinition('user:wiggle'))
    expect(store.exists('user:wiggle')).toBe(true)
    expect(store.listIds()).toEqual(['user:wiggle'])
    // shape-unsafe or foreign-namespace ids never resolve
    expect(store.exists('user:../config')).toBe(false)
    expect(store.exists('builtin:soft')).toBe(false)
  })
})

describe('animation id guards', () => {
  it('validateUserAnimationId accepts user:<safe> only', () => {
    expect(validateUserAnimationId('user:wiggle-2_x')).toBe('user:wiggle-2_x')
    for (const bad of ['builtin:soft', 'user:', 'user:../x', 'user:a/b', 'user:a b', 42, null]) {
      expect(validateUserAnimationId(bad)).toBeNull()
    }
  })

  it('validateAnimationId accepts any safe namespace:name (route-level guard)', () => {
    expect(validateAnimationId('builtin:soft')).toBe('builtin:soft')
    expect(validateAnimationId('user:wiggle')).toBe('user:wiggle')
    for (const bad of ['user:../x', 'a/b', 'no-colon', 'user:', 42, null]) {
      expect(validateAnimationId(bad)).toBeNull()
    }
  })
})
