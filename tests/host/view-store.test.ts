/**
 * ConfigViewStore tests (preset-authority phase 2): the single funnel's
 * invariants that sit BELOW HTTP — revision semantics (one bump per funnel
 * run, 409 pre-flight without side effects), the auto-provision repair, and
 * the response-is-a-view contract. Route-level coverage lives in
 * routes.test.ts; these pin the store composition directly.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import { ConfigStore, RevisionMismatchError } from '../../src/host/config'
import { ConfigViewStore } from '../../src/host/view-store'
import { DEFAULT_PET_NAME, PetsStore } from '../../src/host/pets'
import { createWriteLock } from '../../src/host/storage'

let dir: string
let configStore: ConfigStore
let petsStore: PetsStore
let viewStore: ConfigViewStore
let tick: number

/** Deterministic clock: every call lands one second later. */
const now = (): string => new Date(1_760_000_000_000 + tick++ * 1000).toISOString()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'petween-view-store-'))
  tick = 0
  const lock = createWriteLock()
  petsStore = new PetsStore({ petsDir: join(dir, 'pets'), lock, now })
  configStore = new ConfigStore({ configPath: join(dir, 'config.json'), lock })
  viewStore = new ConfigViewStore({ configStore, petsStore })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ConfigViewStore.update — revision semantics (B3 + phase 2)', () => {
  it('bumps the ONE revision exactly once per funnel run, slice writes included', async () => {
    expect(await viewStore.revision()).toBe(0)
    // Slice-only run: one bump even though the preset (not the document)
    // carries the change.
    await viewStore.update({ global: { scale: 1.5 } })
    expect(await viewStore.revision()).toBe(1)
    // Global-only run: one bump.
    await viewStore.update({ overlay: { x: 1, y: 2 } })
    expect(await viewStore.revision()).toBe(2)
    // Mixed run (globals + slice + pointer): still exactly one bump.
    const pet = await petsStore.create('Target', {})
    await viewStore.update({ activePetId: pet.id, global: { scale: 2.2, successHoldMs: 3000 } })
    expect(await viewStore.revision()).toBe(3)
  })

  it('a stale expectedRevision 409s BEFORE any side effect — no orphaned default pet', async () => {
    await viewStore.update({ enabled: false }) // revision 1
    // The patch carries slice fields (which would auto-provision a pet):
    // the conflict must fire first.
    await expect(viewStore.update({ global: { scale: 2 } }, { expectedRevision: 0 })).rejects.toThrow(RevisionMismatchError)
    expect(await petsStore.list()).toEqual({ pets: [], warnings: [] })
    expect(await viewStore.revision()).toBe(1) // no bump either
  })

  it('a matching expectedRevision passes and rides the same single bump', async () => {
    await viewStore.update({ enabled: false })
    const view = await viewStore.update({ global: { scale: 1.8 } }, { expectedRevision: 1 })
    expect(view.global.scale).toBe(1.8)
    expect(await viewStore.revision()).toBe(2)
  })
})

describe('ConfigViewStore.update — funnel routing', () => {
  it('the response is the materialized view (PUT-response-is-a-view contract)', async () => {
    const pet = await petsStore.create('Kitty', { scale: 0.7, poses: { idle: { assetId: '0123456789abcdef' } } })
    const view = await viewStore.update({ activePetId: pet.id, enabled: false })
    expect(view.activePetId).toBe(pet.id)
    expect(view.enabled).toBe(false)
    expect(view.global.scale).toBe(0.7)
    expect(view.poses.idle.assetId).toBe('0123456789abcdef')
    expect(view.version).toBe(1) // the legacy shape, not the v2 document
    // And it equals what a fresh read resolves.
    expect(await viewStore.loadView()).toEqual(view)
  })

  it('a mounts-style partial states patch merges onto the active preset slice', async () => {
    const pet = await petsStore.create('Kitty', {})
    await viewStore.update({ activePetId: pet.id })
    // Same shape as packs.ts mountsStatesPatch: only the mounted fields.
    const view = await viewStore.update({
      states: { thinking: { ambient: { customAnimationId: 'user:float' } } },
    })
    expect(view.states.thinking.ambient.customAnimationId).toBe('user:float')
    expect(view.states.idle).toEqual(createDefaultPetweenConfig().states.idle) // merged, not replaced
    expect((await petsStore.read(pet.id)).states.thinking.ambient.customAnimationId).toBe('user:float')
  })

  it('a slice 400 leaves globals AND the pointer untouched (validate-before-write)', async () => {
    const pet = await petsStore.create('Kitty', {})
    const error = await viewStore
      .update({ activePetId: pet.id, enabled: false, poses: { idle: { assetId: 'not-hex' } } })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const view = await viewStore.loadView()
    expect(view.activePetId).toBeNull() // the pointer flip never happened
    expect(view.enabled).toBe(true) // nor the global write
    expect((await petsStore.read(pet.id)).poses.idle.assetId).toBeUndefined()
  })

  it('auto-provisions the default pet from the legacy document slice (null pointer repair)', async () => {
    // Simulate a pre-migration v1 document: write a full v1 config directly.
    const v1 = createDefaultPetweenConfig()
    v1.global.scale = 1.6
    v1.poses.idle.assetId = '0123456789abcdef'
    await (await import('node:fs/promises')).writeFile(join(dir, 'config.json'), JSON.stringify(v1), 'utf8')
    const healed = await viewStore.update({ global: { scale: 1.9 } })
    expect(healed.activePetId).toMatch(/^pet_[a-z0-9]+$/)
    const { pets } = await petsStore.list()
    expect(pets).toHaveLength(1)
    expect(pets[0]!.name).toBe(DEFAULT_PET_NAME)
    // The v1 slice survived the provision (scale came from the write, the
    // assetId from the legacy document base).
    expect(pets[0]!.scale).toBe(1.9)
    expect(pets[0]!.poses.idle.assetId).toBe('0123456789abcdef')
    // The document was rewritten as the v2 projection by the same funnel run.
    const document = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(document.version).toBe(2)
    expect(document).not.toHaveProperty('poses')
  })
})
