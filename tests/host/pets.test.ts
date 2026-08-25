/**
 * PetsStore tests (V1.1 pet presets): directory scanning with per-file fault
 * tolerance, slice normalization (defaults fill), serialized writes, rename /
 * saveSlice / delete semantics, id guards — plus the ConfigStore onSaved
 * mirror wiring exactly as src/index.ts assembles it.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig, createDefaultPoseConfigs, createDefaultStateAppearances } from '../../src/core/defaults'
import { ConfigStore } from '../../src/host/config'
import { PetError, PetsStore, petSliceFromConfig, validatePetId, type PetSlice } from '../../src/host/pets'

let dir: string
let store: PetsStore
let tick: number

/** Deterministic clock: every call lands one second later. */
const now = (): string => new Date(1_760_000_000_000 + tick++ * 1000).toISOString()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'petween-pets-'))
  tick = 0
  store = new PetsStore({ petsDir: join(dir, 'pets'), now })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A slice with recognizable non-default content. */
function makeSlice(scale = 1.5): PetSlice {
  const config = createDefaultPetweenConfig()
  config.global.scale = scale
  config.poses.idle.assetId = '0123456789abcdef'
  config.states.success.enter = { preset: 'jump', strength: 1.2, durationMs: 400 }
  return petSliceFromConfig(config)
}

describe('PetsStore.create / read', () => {
  it('writes <id>.json atomically with a host-generated id and timestamps', async () => {
    const preset = await store.create('Kitty', makeSlice())
    expect(preset.id).toMatch(/^pet_[a-z0-9]+$/)
    expect(preset.createdAt).toBe(preset.updatedAt)
    expect(preset.scale).toBe(1.5)
    expect(preset.poses.idle.assetId).toBe('0123456789abcdef')
    expect(preset.states.success.enter.preset).toBe('jump')
    const onDisk = JSON.parse(await readFile(join(dir, 'pets', `${preset.id}.json`), 'utf8'))
    expect(onDisk).toEqual(preset)
    expect(await readdir(join(dir, 'pets'))).toEqual([`${preset.id}.json`]) // no .tmp residue
    expect(await store.read(preset.id)).toEqual(preset)
  })

  it('fills a blank slice with defaults: empty poses, default states, scale 1', async () => {
    const preset = await store.create('Blank', {})
    expect(preset.scale).toBe(1)
    expect(preset.poses).toEqual(createDefaultPoseConfigs())
    expect(preset.states).toEqual(createDefaultStateAppearances())
  })

  it('repairs invalid slice fields instead of rejecting the create', async () => {
    const preset = await store.create('Messy', {
      scale: 99, // out of range → default
      poses: { idle: { zoom: 'huge' }, dragon: { zoom: 2 } },
      states: { thinking: { pose: 'nope' } },
    })
    expect(preset.scale).toBe(1)
    expect(preset.poses.idle.zoom).toBe(1)
    expect(preset.poses).not.toHaveProperty('dragon')
    expect(preset.states.thinking.pose).toBe('thinking')
  })

  it('rejects empty and non-string names with INVALID_PRESET', async () => {
    for (const name of ['', '   ', 42, null, undefined]) {
      const error = await store.create(name, makeSlice()).catch((e: unknown) => e)
      expect(error, String(name)).toBeInstanceOf(PetError)
      expect((error as PetError).code).toBe('INVALID_PRESET')
    }
    expect(await store.list()).toEqual({ pets: [], warnings: [] })
  })

  it('never aliases the caller objects: later mutations do not leak into the file', async () => {
    const slice = makeSlice()
    const preset = await store.create('Kitty', slice)
    slice.poses.idle.assetId = 'ffffffffffffffff'
    slice.states.idle.ambient.sway.angleDeg = 42
    const onDisk = JSON.parse(await readFile(join(dir, 'pets', `${preset.id}.json`), 'utf8'))
    expect(onDisk.poses.idle.assetId).toBe('0123456789abcdef')
    expect(onDisk.states.idle.ambient.sway.angleDeg).not.toBe(42)
  })

  it('read throws NOT_FOUND for unknown, malformed and corrupt files', async () => {
    for (const id of ['pet_missing', 'pet_../escape', '../etc', 'not-a-pet']) {
      const error = await store.read(id).catch((e: unknown) => e)
      expect(error, id).toBeInstanceOf(PetError)
      expect((error as PetError).code).toBe('NOT_FOUND')
    }
    await mkdir(join(dir, 'pets'), { recursive: true })
    await writeFile(join(dir, 'pets', 'pet_broken.json'), '{ nope', 'utf8')
    const error = await store.read('pet_broken').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PetError)
    expect((error as PetError).code).toBe('NOT_FOUND')
  })
})

describe('PetsStore.list', () => {
  it('returns empty lists when the directory does not exist', async () => {
    expect(await store.list()).toEqual({ pets: [], warnings: [] })
  })

  it('loads every stored preset sorted by file name, ignoring non-JSON files', async () => {
    await store.create('B', makeSlice())
    await store.create('A', makeSlice(2))
    await writeFile(join(dir, 'pets', 'notes.txt'), 'not a preset', 'utf8')
    const { pets, warnings } = await store.list()
    expect(pets.map((preset) => preset.name).sort()).toEqual(['A', 'B'])
    expect(warnings).toEqual([])
  })

  it('skips corrupt JSON and shape violations with warnings, keeping the good files', async () => {
    const good = await store.create('Good', makeSlice())
    await writeFile(join(dir, 'pets', 'pet_broken.json'), '{ not json', 'utf8')
    await writeFile(join(dir, 'pets', 'pet_noname.json'), JSON.stringify({ id: 'pet_noname', name: '' }), 'utf8')
    await writeFile(join(dir, 'pets', 'pet_badscale.json'), JSON.stringify({ id: 'pet_badscale', name: 'X', scale: 'big' }), 'utf8')
    await writeFile(join(dir, 'pets', 'pet_badposes.json'), JSON.stringify({ id: 'pet_badposes', name: 'X', poses: [1] }), 'utf8')
    const { pets, warnings } = await store.list()
    expect(pets.map((preset) => preset.id)).toEqual([good.id])
    expect(warnings).toHaveLength(4)
    expect(warnings[0]).toContain('pet_badposes.json')
    expect(warnings[1]).toContain('pet_badscale.json')
    expect(warnings[2]).toContain('pet_broken.json')
    expect(warnings[3]).toContain('pet_noname.json')
  })

  it('skips a duplicate id with a warning, keeping the first file', async () => {
    const preset = await store.create('First', makeSlice())
    await writeFile(
      join(dir, 'pets', 'zzz.json'),
      JSON.stringify({ ...JSON.parse(await readFile(join(dir, 'pets', `${preset.id}.json`), 'utf8')), name: 'The Copy' }),
      'utf8',
    )
    const { pets, warnings } = await store.list()
    expect(pets).toHaveLength(1)
    expect(pets[0].name).toBe('First')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('duplicate')
  })
})

describe('PetsStore.rename / saveSlice / delete', () => {
  it('rename updates the name and updatedAt, keeping slice and createdAt', async () => {
    const preset = await store.create('Old', makeSlice())
    const renamed = await store.rename(preset.id, '  New Name  ')
    expect(renamed.name).toBe('New Name')
    expect(renamed.createdAt).toBe(preset.createdAt)
    expect(renamed.updatedAt > preset.updatedAt).toBe(true)
    expect(renamed.poses).toEqual(preset.poses)
    expect(await store.read(preset.id)).toEqual(renamed)
  })

  it('rename rejects bad names and unknown ids', async () => {
    const preset = await store.create('Old', makeSlice())
    const bad = await store.rename(preset.id, ' ').catch((e: unknown) => e)
    expect((bad as PetError).code).toBe('INVALID_PRESET')
    const missing = await store.rename('pet_missing', 'X').catch((e: unknown) => e)
    expect((missing as PetError).code).toBe('NOT_FOUND')
  })

  it('saveSlice replaces the slice, keeping name and createdAt', async () => {
    const preset = await store.create('Kitty', makeSlice())
    const next = makeSlice(2.5)
    next.poses.idle.assetId = 'aaaaaaaaaaaaaaaa'
    const updated = await store.saveSlice(preset.id, next)
    expect(updated.name).toBe('Kitty')
    expect(updated.createdAt).toBe(preset.createdAt)
    expect(updated.updatedAt > preset.updatedAt).toBe(true)
    expect(updated.scale).toBe(2.5)
    expect(updated.poses.idle.assetId).toBe('aaaaaaaaaaaaaaaa')
    expect(await store.read(preset.id)).toEqual(updated)
  })

  it('saveSlice throws NOT_FOUND when the file is gone', async () => {
    const error = await store.saveSlice('pet_missing', makeSlice()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PetError)
    expect((error as PetError).code).toBe('NOT_FOUND')
  })

  it('delete removes the file; unknown and malformed ids throw NOT_FOUND', async () => {
    const preset = await store.create('Kitty', makeSlice())
    await store.delete(preset.id)
    expect((await store.list()).pets).toEqual([])
    for (const id of [preset.id, 'pet_../escape']) {
      const error = await store.delete(id).catch((e: unknown) => e)
      expect(error, id).toBeInstanceOf(PetError)
      expect((error as PetError).code).toBe('NOT_FOUND')
    }
  })

  it('serializes concurrent writes: every create lands and the last saveSlice wins', async () => {
    const [a, b, c] = await Promise.all([store.create('A', makeSlice()), store.create('B', makeSlice()), store.create('C', makeSlice())])
    const { pets, warnings } = await store.list()
    expect(warnings).toEqual([])
    expect(pets.map((preset) => preset.name).sort()).toEqual(['A', 'B', 'C'])
    await Promise.all([store.saveSlice(a.id, makeSlice(1.1)), store.saveSlice(a.id, makeSlice(1.2))])
    const reloaded = await store.read(a.id)
    expect([1.1, 1.2]).toContain(reloaded.scale)
    expect(b.id).not.toBe(c.id)
  })
})

describe('pet id guard', () => {
  it('validatePetId accepts pet_<safe> only', () => {
    expect(validatePetId('pet_lx3ab9f2')).toBe('pet_lx3ab9f2')
    for (const bad of ['user:x', 'pet_', 'pet_../x', 'pet_a/b', 'pet_a b', 'Pet_ABC', 42, null]) {
      expect(validatePetId(bad)).toBeNull()
    }
  })
})

describe('config → preset mirror (ConfigStore.onSaved, wired as in src/index.ts)', () => {
  let configStore: ConfigStore

  beforeEach(() => {
    configStore = new ConfigStore({
      configPath: join(dir, 'config.json'),
      onSaved: async (config) => {
        if (config.activePetId !== null) await store.saveSlice(config.activePetId, petSliceFromConfig(config))
      },
    })
  })

  it('syncs the slice into the active preset on every config update', async () => {
    const preset = await store.create('Kitty', makeSlice())
    await configStore.update({ activePetId: preset.id })
    await configStore.update({ global: { scale: 2.4 }, poses: { idle: { assetId: 'bbbbbbbbbbbbbbbb' } } })
    const mirrored = await store.read(preset.id)
    expect(mirrored.scale).toBe(2.4)
    expect(mirrored.poses.idle.assetId).toBe('bbbbbbbbbbbbbbbb')
  })

  it('writes nothing when activePetId is null', async () => {
    await configStore.update({ global: { scale: 2 } })
    expect(await store.list()).toEqual({ pets: [], warnings: [] })
  })

  it('a mirror failure warns but never fails or rolls back the config update', async () => {
    const preset = await store.create('Kitty', makeSlice())
    await configStore.update({ activePetId: preset.id })
    await store.delete(preset.id) // out-of-band deletion: the mirror target is gone
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const config = await configStore.update({ global: { scale: 3 } })
      expect(config.global.scale).toBe(3)
      expect((await configStore.load()).global.scale).toBe(3)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
