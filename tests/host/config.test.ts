/**
 * Host config tests (spec §18.3, §26, §29.2): default fallback, corrupt-file
 * fallback, per-field repair, unknown-field stripping, atomic save roundtrip
 * — plus the preset-authority phase-2 contract: the writer persists ONLY the
 * v2 global document, the loader reads both v1 (full) and v2 (global) files.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import { ConfigStore, loadConfig, toGlobalDocument } from '../../src/host/config'

// Wrap (never replace) storage.readJsonFile so the revision-race test can park
// one read mid-flight; every other call passes through to the real file IO.
vi.mock('../../src/host/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/storage')>()
  return { ...actual, readJsonFile: vi.fn(actual.readJsonFile) }
})

let dir: string
let store: ConfigStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'petween-config-'))
  store = new ConfigStore({ configPath: join(dir, 'config.json') })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadConfig (§18.3)', () => {
  it('returns defaults for null / non-object input', () => {
    expect(loadConfig(null)).toEqual(createDefaultPetweenConfig())
    expect(loadConfig(42)).toEqual(createDefaultPetweenConfig())
    expect(loadConfig('broken')).toEqual(createDefaultPetweenConfig())
  })

  it('strips unknown fields and unknown pose keys', () => {
    const config = loadConfig({
      version: 1,
      enabled: false,
      bogus: 'drop me',
      global: { scale: 1.5, hacker: true },
      poses: { idle: { zoom: 2 }, dragon: { zoom: 9 } },
    })
    expect(config.enabled).toBe(false)
    expect(config.global.scale).toBe(1.5)
    expect(config).not.toHaveProperty('bogus')
    expect(config.global).not.toHaveProperty('hacker')
    expect(config.poses).not.toHaveProperty('dragon')
    expect(config.poses.idle.zoom).toBe(2)
  })

  it('repairs invalid values field-wise instead of rejecting the document', () => {
    const defaults = createDefaultPetweenConfig()
    const config = loadConfig({
      version: 1,
      enabled: 'yes', // wrong type → default
      global: {
        scale: 99, // out of range → default
        transition: { preset: 'hyper-spin', strength: 1.2, durationMs: 10 }, // bad preset + range → defaults
        reducedMotion: 'sometimes',
      },
      poses: { idle: { anchor: { x: 2, y: 0.5 }, zoom: 'big' } },
      states: { thinking: { pose: 'dragon', enter: { preset: 'jelly', strength: 0.8, durationMs: 300 } } },
    })
    expect(config.enabled).toBe(defaults.enabled)
    expect(config.global.scale).toBe(defaults.global.scale)
    expect(config.global.transition).toEqual({
      preset: defaults.global.transition.preset,
      strength: 1.2, // valid fields survive alongside repaired ones
      durationMs: defaults.global.transition.durationMs,
    })
    expect(config.global.reducedMotion).toBe(defaults.global.reducedMotion)
    expect(config.poses.idle.anchor).toEqual({ x: defaults.poses.idle.anchor.x, y: 0.5 })
    expect(config.poses.idle.zoom).toBe(defaults.poses.idle.zoom)
    expect(config.states.thinking.pose).toBe(defaults.states.thinking.pose)
    expect(config.states.thinking.enter).toEqual({ preset: 'jelly', strength: 0.8, durationMs: 300 })
  })

  it('accepts any/absent version and re-tags the document as v1', () => {
    expect(loadConfig({ enabled: false }).version).toBe(1)
    expect(loadConfig({ version: 2, enabled: false })).toMatchObject({ version: 1, enabled: false })
    expect(loadConfig({ version: 'one', enabled: false })).toMatchObject({ version: 1, enabled: false })
  })

  it('dual-read (phase 2): a v2 global document loads with the default slice', () => {
    const config = loadConfig({
      version: 2,
      enabled: false,
      global: { transition: { preset: 'jelly', strength: 1.2, durationMs: 300 }, successHoldMs: 3000 },
      overlay: { x: 12, y: 34 },
      activePetId: 'pet_abc123',
    })
    // The v2 global fields land …
    expect(config.enabled).toBe(false)
    expect(config.global.transition).toEqual({ preset: 'jelly', strength: 1.2, durationMs: 300 })
    expect(config.global.successHoldMs).toBe(3000)
    expect(config.overlay).toEqual({ x: 12, y: 34 })
    expect(config.activePetId).toBe('pet_abc123')
    // … and the slice fields a v2 document does not carry come from the
    // defaults (the view layer replaces them with the active preset's slice).
    const defaults = createDefaultPetweenConfig()
    expect(config.global.scale).toBe(defaults.global.scale)
    expect(config.poses).toEqual(defaults.poses)
    expect(config.states).toEqual(defaults.states)
  })
})

describe('ConfigStore', () => {
  it('loads defaults when the file does not exist', async () => {
    expect(await store.load()).toEqual(createDefaultPetweenConfig())
  })

  it('loads defaults when the file is corrupt', async () => {
    await writeFile(store.configPath, '### not json ###', 'utf8')
    expect(await store.load()).toEqual(createDefaultPetweenConfig())
  })

  it('reads a legacy v1 document with its slice intact (dual-read)', async () => {
    const v1 = createDefaultPetweenConfig()
    v1.enabled = false
    v1.global.scale = 1.7
    v1.poses.idle.assetId = '0123456789abcdef'
    await writeFile(store.configPath, JSON.stringify(v1), 'utf8')
    const loaded = await store.load()
    expect(loaded).toEqual(v1)
  })

  it('saves atomically as the v2 global projection: readable afterwards, no .tmp residue', async () => {
    const config = createDefaultPetweenConfig()
    config.enabled = false
    config.global.scale = 1.8
    config.activePetId = 'pet_abc123'
    await store.save(config)
    // The writer persists ONLY the v2 global document — the slice (scale
    // included) stays with the presets.
    expect(JSON.parse(await readFile(store.configPath, 'utf8'))).toEqual(toGlobalDocument(config))
    // … and it loads back as the same globals plus the default slice.
    const loaded = await store.load()
    expect({ ...loaded, activePetId: config.activePetId }).toEqual({
      ...createDefaultPetweenConfig(),
      enabled: false,
      activePetId: config.activePetId,
    })
    const entries = await readdir(dir)
    expect(entries).toEqual(['config.json'])
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })
})

describe('ConfigStore.updateGlobals (serialized read-merge-write, §19.2 + phase 2)', () => {
  it('merges a partial patch onto the current document and persists the v2 projection', async () => {
    const merged = await store.updateGlobals({ global: { successHoldMs: 3000 }, overlay: { x: 12, y: 34 } })
    expect(merged.global.successHoldMs).toBe(3000)
    // untouched fields come from the current config (defaults here)
    expect(merged.enabled).toBe(createDefaultPetweenConfig().enabled)
    expect(JSON.parse(await readFile(store.configPath, 'utf8'))).toEqual(toGlobalDocument(merged))
    expect(await store.load()).toEqual(merged)
  })

  it('ignores slice fields in the patch: they route to the presets, never to this document', async () => {
    const merged = await store.updateGlobals({ global: { scale: 1.5 }, poses: { idle: { assetId: '0123456789abcdef' } } })
    expect(merged.global.scale).toBe(1) // untouched — scale is slice-owned now
    expect(merged.poses.idle.assetId).toBeUndefined()
    const onDisk = JSON.parse(await readFile(store.configPath, 'utf8'))
    expect(onDisk.global).not.toHaveProperty('scale')
    expect(onDisk).not.toHaveProperty('poses')
  })

  it('serializes concurrent updates: both patches land (no lost update)', async () => {
    const [a, b] = await Promise.all([
      store.updateGlobals({ enabled: false }),
      store.updateGlobals({ overlay: { x: 12, y: 34 } }),
    ])
    expect(a.enabled).toBe(false)
    expect(b.overlay).toEqual({ x: 12, y: 34 })
    const final = await store.load()
    expect(final.enabled).toBe(false)
    expect(final.overlay).toEqual({ x: 12, y: 34 })
  })

  it('a rejected patch does not wedge the queue', async () => {
    await expect(store.updateGlobals({ enabled: 'yes' })).rejects.toThrow(/enabled/)
    const merged = await store.updateGlobals({ overlay: { x: 1, y: 2 } })
    expect(merged.overlay).toEqual({ x: 1, y: 2 })
    // the invalid patch never reached the disk
    expect((await store.load()).enabled).toBe(createDefaultPetweenConfig().enabled)
  })

  it('a lock-free revision read racing an update never rolls the cache back', async () => {
    // Seed the sidecar at 5.
    const { writeJsonAtomic } = await vi.importActual<typeof import('../../src/host/storage')>('../../src/host/storage')
    await writeJsonAtomic(store.revisionPath, { revision: 5 })
    // Park the lock-free read AFTER it has read the old value but BEFORE it
    // returns — exactly the window in which an update()'s bump lands first
    // (the routes read the revision outside the write lock, routes.ts
    // handleMeta/handleConfig).
    const storage = await import('../../src/host/storage')
    const readJsonFile = vi.mocked(storage.readJsonFile)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    readJsonFile.mockImplementationOnce(async (path: string) => {
      let value: unknown = null
      try {
        value = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        value = null
      }
      await gate
      return value
    })
    const staleRead = store.revision() // cache empty → reads 5, then parks
    // A full update lands in between: bumps the sidecar to 6 and caches 6.
    await store.updateGlobals({ enabled: false })
    release()
    // The stale read must merge monotonically — never restore the older 5.
    await expect(staleRead).resolves.toBe(6)
    expect(await store.revision()).toBe(6)
  })
})
