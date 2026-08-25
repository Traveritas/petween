/**
 * Host config tests (spec §18.3, §26, §29.2): default fallback, corrupt-file
 * fallback, per-field repair, unknown-field stripping, atomic save roundtrip.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import { ConfigStore, loadConfig } from '../../src/host/config'

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
})

describe('ConfigStore', () => {
  it('loads defaults when the file does not exist', async () => {
    expect(await store.load()).toEqual(createDefaultPetweenConfig())
  })

  it('loads defaults when the file is corrupt', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(store.configPath, '### not json ###', 'utf8')
    expect(await store.load()).toEqual(createDefaultPetweenConfig())
  })

  it('saves atomically: readable afterwards, no .tmp residue', async () => {
    const config = createDefaultPetweenConfig()
    config.enabled = false
    config.global.scale = 1.8
    await store.save(config)
    expect(await store.load()).toEqual(config)
    const entries = await readdir(dir)
    expect(entries).toEqual(['config.json'])
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })
})

describe('ConfigStore.update (serialized read-merge-write, §19.2)', () => {
  it('merges a partial patch onto the current config and persists it', async () => {
    const merged = await store.update({ global: { scale: 1.5 } })
    expect(merged.global.scale).toBe(1.5)
    // untouched fields come from the current config (defaults here)
    expect(merged.overlay).toEqual(createDefaultPetweenConfig().overlay)
    expect(await store.load()).toEqual(merged)
  })

  it('serializes concurrent updates: both patches land (no lost update)', async () => {
    const [a, b] = await Promise.all([
      store.update({ global: { scale: 1.5 } }),
      store.update({ overlay: { x: 12, y: 34 } }),
    ])
    expect(a.global.scale).toBe(1.5)
    expect(b.overlay).toEqual({ x: 12, y: 34 })
    const final = await store.load()
    expect(final.global.scale).toBe(1.5)
    expect(final.overlay).toEqual({ x: 12, y: 34 })
  })

  it('a rejected patch does not wedge the queue', async () => {
    await expect(store.update({ enabled: 'yes' })).rejects.toThrow(/enabled/)
    const merged = await store.update({ overlay: { x: 1, y: 2 } })
    expect(merged.overlay).toEqual({ x: 1, y: 2 })
    // the invalid patch never reached the disk
    expect((await store.load()).enabled).toBe(createDefaultPetweenConfig().enabled)
  })
})
