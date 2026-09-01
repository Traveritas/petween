/**
 * host/migrate-v2.ts tests — the v1→v2 preset-authority boot migration:
 * the slice push into the active preset (lossless, mirror-lag healing),
 * null/dangling pointer self-healing through the default pet, a
 * strict-validation failure keeping the v1 file untouched, idempotent
 * re-runs, the backup file, first-run provisioning, v2 pointer repair, and
 * the "old data is never destroyed / non-active presets untouched"
 * discipline.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { PetweenConfig } from '../../src/core/types'
import { loadConfig } from '../../src/host/config'
import { ensurePresetAuthority } from '../../src/host/migrate-v2'
import { DEFAULT_PET_NAME, petSliceFromConfig } from '../../src/host/pets'

/** Roots created during a test; removed afterwards whatever it asserted. */
const roots: string[] = []

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'petween-migrate-v2-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function configPath(root: string): string {
  return join(root, 'config.json')
}

function backupPath(root: string): string {
  return join(root, 'config.v1.backup.json')
}

function writePet(root: string, id: string, name: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(root, 'pets'), { recursive: true })
  const slice = petSliceFromConfig(createDefaultPetweenConfig())
  writeFileSync(
    join(root, 'pets', `${id}.json`),
    JSON.stringify({
      id,
      name,
      ...slice,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    }),
  )
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** A v1 config with a recognizably non-default slice AND non-default globals. */
function makeV1Config(): PetweenConfig {
  const config = createDefaultPetweenConfig()
  config.enabled = false
  config.global.scale = 1.7
  config.global.successHoldMs = 3000
  config.poses.idle.assetId = '0123456789abcdef'
  config.states.success.enter = { preset: 'jump', strength: 1.2, durationMs: 400 }
  config.overlay = { x: 12, y: 34 }
  return config
}

describe('ensurePresetAuthority — v1 → v2 migration', () => {
  it('pushes the v1 slice into the pointed preset (healing mirror lag), backs up, rewrites v2', () => {
    const root = makeHome()
    const v1 = makeV1Config()
    v1.activePetId = 'pet_mochi'
    writeFileSync(configPath(root), JSON.stringify(v1, null, 2))
    // The on-disk preset LAGS (a swallowed mirror failure): stale scale/poses,
    // plus identity and out-of-slice fields that must survive.
    writePet(root, 'pet_mochi', 'Mochi', {
      scale: 0.8,
      attribution: { character: '溟月' },
      pluginConfigs: { 'petween-physics': { config: { gravity: 2400 } } },
    })

    expect(ensurePresetAuthority(root)).toBe('migrated')

    // The original v1 file survives VERBATIM as the backup …
    expect(readFileSync(backupPath(root), 'utf8')).toBe(JSON.stringify(v1, null, 2))
    // … and config.json is now the v2 global document: same globals, same
    // pointer, no slice fields anywhere.
    const document = readJson(configPath(root))
    expect(document).toEqual({
      version: 2,
      enabled: false,
      global: {
        transition: v1.global.transition,
        reducedMotion: v1.global.reducedMotion,
        successHoldMs: 3000,
        errorHoldMs: v1.global.errorHoldMs,
      },
      overlay: { x: 12, y: 34 },
      advanced: v1.advanced,
      interactions: v1.interactions,
      activePetId: 'pet_mochi',
    })
    // The preset absorbed the config slice (the stale one is gone — config
    // was authoritative), while identity and out-of-slice fields survived.
    const preset = readJson(join(root, 'pets', 'pet_mochi.json'))
    expect(preset.scale).toBe(1.7)
    expect((preset.poses as Record<string, { assetId?: string }>).idle.assetId).toBe('0123456789abcdef')
    expect((preset.states as Record<string, { enter: { preset: string } }>).success.enter.preset).toBe('jump')
    expect(preset.name).toBe('Mochi')
    expect(preset.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(preset.attribution).toEqual({ character: '溟月' })
    expect(preset.pluginConfigs).toEqual({ 'petween-physics': { config: { gravity: 2400 } } })
    expect((preset.updatedAt as string) > '2026-08-01T00:00:00.000Z').toBe(true)

    // Idempotent: a second boot sees the healthy v2 install and does nothing.
    const before = readFileSync(configPath(root), 'utf8')
    expect(ensurePresetAuthority(root)).toBe('skipped')
    expect(readFileSync(configPath(root), 'utf8')).toBe(before)
  })

  it('skips the preset write entirely when the slice is already in sync (no churn)', () => {
    const root = makeHome()
    const v1 = createDefaultPetweenConfig() // default slice == the preset's
    v1.activePetId = 'pet_sync'
    writeFileSync(configPath(root), JSON.stringify(v1))
    writePet(root, 'pet_sync', 'In Sync')
    const presetBefore = readFileSync(join(root, 'pets', 'pet_sync.json'), 'utf8')

    expect(ensurePresetAuthority(root)).toBe('migrated')
    // updatedAt and bytes untouched — the push was a no-op.
    expect(readFileSync(join(root, 'pets', 'pet_sync.json'), 'utf8')).toBe(presetBefore)
  })

  it('a null pointer builds the default pet FROM the v1 slice and points at it', () => {
    const root = makeHome()
    const v1 = makeV1Config() // activePetId stays null
    writeFileSync(configPath(root), JSON.stringify(v1))

    expect(ensurePresetAuthority(root)).toBe('migrated')

    const document = readJson(configPath(root))
    const pointer = document.activePetId as string
    expect(pointer).toMatch(/^pet_[a-z0-9]+$/)
    const pet = readJson(join(root, 'pets', `${pointer}.json`))
    expect(pet.name).toBe(DEFAULT_PET_NAME)
    // The live slice moved into the pet — nothing was lost to defaults.
    expect(pet.scale).toBe(1.7)
    expect((pet.poses as Record<string, { assetId?: string }>).idle.assetId).toBe('0123456789abcdef')
    expect(existsSync(backupPath(root))).toBe(true)
  })

  it('a dangling pointer self-heals the same way (the missing preset stays missing)', () => {
    const root = makeHome()
    const v1 = makeV1Config()
    v1.activePetId = 'pet_gone'
    writeFileSync(configPath(root), JSON.stringify(v1))

    expect(ensurePresetAuthority(root)).toBe('migrated')

    const document = readJson(configPath(root))
    const pointer = document.activePetId as string
    expect(pointer).toMatch(/^pet_[a-z0-9]+$/)
    expect(pointer).not.toBe('pet_gone')
    expect(existsSync(join(root, 'pets', 'pet_gone.json'))).toBe(false)
    const pet = readJson(join(root, 'pets', `${pointer}.json`))
    expect(pet.name).toBe(DEFAULT_PET_NAME)
    expect(pet.scale).toBe(1.7)
  })

  it('a structurally invalid slice keeps the v1 file untouched and boots on the old format', () => {
    const root = makeHome()
    const v1 = makeV1Config()
    v1.poses.idle.assetId = 'definitely-not-hex' // strict slice validation must fail
    const text = JSON.stringify(v1)
    writeFileSync(configPath(root), text)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(ensurePresetAuthority(root)).toBe('failed')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    // Nothing moved: the v1 file is byte-identical, no backup, no pet — and
    // the dual-readable loader still boots it (repair drops the bad field).
    expect(readFileSync(configPath(root), 'utf8')).toBe(text)
    expect(existsSync(backupPath(root))).toBe(false)
    expect(existsSync(join(root, 'pets'))).toBe(false)
    expect(loadConfig(JSON.parse(text)).poses.idle.assetId).toBeUndefined()
  })

  it('never touches non-active presets during the migration', () => {
    const root = makeHome()
    const v1 = makeV1Config()
    v1.activePetId = 'pet_active'
    writeFileSync(configPath(root), JSON.stringify(v1))
    writePet(root, 'pet_active', 'Active')
    writePet(root, 'pet_other', 'Other', { scale: 3.3 })
    const otherBefore = readFileSync(join(root, 'pets', 'pet_other.json'), 'utf8')

    expect(ensurePresetAuthority(root)).toBe('migrated')
    expect(readFileSync(join(root, 'pets', 'pet_other.json'), 'utf8')).toBe(otherBefore)
  })
})

describe('ensurePresetAuthority — first run and v2 repair', () => {
  it('a first run provisions the default pet and the v2 document (pointer never null)', () => {
    const root = makeHome()
    expect(ensurePresetAuthority(root)).toBe('provisioned')

    const document = readJson(configPath(root))
    expect(document.version).toBe(2)
    const pointer = document.activePetId as string
    expect(pointer).toMatch(/^pet_[a-z0-9]+$/)
    const pet = readJson(join(root, 'pets', `${pointer}.json`))
    expect(pet.name).toBe(DEFAULT_PET_NAME)
    expect(pet.scale).toBe(1) // the default slice
    // Nothing to back up on a true first run.
    expect(existsSync(backupPath(root))).toBe(false)
    // Idempotent: the next boot is a no-op.
    expect(ensurePresetAuthority(root)).toBe('skipped')
  })

  it('a missing config with existing pets points at the most recently updated one', () => {
    const root = makeHome()
    writePet(root, 'pet_old', 'Old', { updatedAt: '2026-08-01T00:00:00.000Z' })
    writePet(root, 'pet_new', 'New', { updatedAt: '2026-08-20T00:00:00.000Z' })

    expect(ensurePresetAuthority(root)).toBe('repaired')
    expect(readJson(configPath(root)).activePetId).toBe('pet_new')
  })

  it('a v2 document with a dangling pointer is repaired onto the newest preset', () => {
    const root = makeHome()
    writePet(root, 'pet_a', 'A', { updatedAt: '2026-08-02T00:00:00.000Z' })
    writePet(root, 'pet_b', 'B', { updatedAt: '2026-08-03T00:00:00.000Z' })
    const globals = createDefaultPetweenConfig()
    writeFileSync(
      configPath(root),
      JSON.stringify({
        version: 2,
        enabled: globals.enabled,
        global: {
          transition: globals.global.transition,
          reducedMotion: globals.global.reducedMotion,
          successHoldMs: globals.global.successHoldMs,
          errorHoldMs: globals.global.errorHoldMs,
        },
        overlay: globals.overlay,
        advanced: globals.advanced,
        interactions: globals.interactions,
        activePetId: 'pet_gone',
      }),
    )

    expect(ensurePresetAuthority(root)).toBe('repaired')
    const document = readJson(configPath(root))
    expect(document.version).toBe(2)
    expect(document.activePetId).toBe('pet_b')
    // Repaired again? No — now the install is healthy.
    expect(ensurePresetAuthority(root)).toBe('skipped')
  })

  it('a v2 document with no presets left re-provisions the default pet', () => {
    const root = makeHome()
    const globals = createDefaultPetweenConfig()
    writeFileSync(
      configPath(root),
      JSON.stringify({
        version: 2,
        enabled: globals.enabled,
        global: {
          transition: globals.global.transition,
          reducedMotion: globals.global.reducedMotion,
          successHoldMs: globals.global.successHoldMs,
          errorHoldMs: globals.global.errorHoldMs,
        },
        overlay: globals.overlay,
        advanced: globals.advanced,
        interactions: globals.interactions,
        activePetId: 'pet_gone',
      }),
    )

    expect(ensurePresetAuthority(root)).toBe('repaired')
    const document = readJson(configPath(root))
    const pointer = document.activePetId as string
    expect(pointer).toMatch(/^pet_[a-z0-9]+$/)
    expect(readJson(join(root, 'pets', `${pointer}.json`)).name).toBe(DEFAULT_PET_NAME)
  })

  it('a corrupt config is backed up, then the document is rebuilt around the newest preset', () => {
    const root = makeHome()
    writePet(root, 'pet_kept', 'Kept', { updatedAt: '2026-08-05T00:00:00.000Z' })
    writeFileSync(configPath(root), '### not json ###')

    expect(ensurePresetAuthority(root)).toBe('repaired')
    expect(readFileSync(backupPath(root), 'utf8')).toBe('### not json ###')
    expect(readJson(configPath(root)).activePetId).toBe('pet_kept')
  })

  it('a healthy v2 install is a no-op (files untouched)', () => {
    const root = makeHome()
    writePet(root, 'pet_ok', 'OK')
    const globals = createDefaultPetweenConfig()
    const document = {
      version: 2,
      enabled: false,
      global: {
        transition: globals.global.transition,
        reducedMotion: globals.global.reducedMotion,
        successHoldMs: 2500,
        errorHoldMs: globals.global.errorHoldMs,
      },
      overlay: { x: 1, y: 2 },
      advanced: globals.advanced,
      interactions: globals.interactions,
      activePetId: 'pet_ok',
    }
    writeFileSync(configPath(root), JSON.stringify(document, null, 2))

    expect(ensurePresetAuthority(root)).toBe('skipped')
    expect(readFileSync(configPath(root), 'utf8')).toBe(JSON.stringify(document, null, 2))
  })
})
