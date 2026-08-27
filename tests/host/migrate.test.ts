/**
 * host/migrate.ts — one-time rename of the plugin's data root
 * ($DSH_HOME/motion-pet → $DSH_HOME/petween, v1.2.0). The contract under
 * test: real user data must survive every path, the old tree is never
 * destroyed, and the outcome is idempotent (a second run is a no-op).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyHome, type MigrateLegacyHomeDeps } from '../../src/host/migrate'

/** Roots created during a test; removed afterwards whatever it asserted. */
const roots: string[] = []

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'petween-migrate-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/**
 * A realistic legacy home: config.json + binary asset + manifest + one
 * custom animation + one pet preset, i.e. everything a real user has.
 */
function seedLegacyHome(dir: string): void {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'animations'), { recursive: true })
  mkdirSync(join(dir, 'pets'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
  // Deliberately non-UTF8 bytes: byte identity, not string round-trip.
  writeFileSync(join(dir, 'assets', 'abc123.webp'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ abc123: { mimeType: 'image/webp' } }))
  writeFileSync(join(dir, 'animations', 'user_hop.json'), JSON.stringify({ version: 1, id: 'user:hop' }))
  writeFileSync(join(dir, 'pets', 'pet-1.json'), JSON.stringify({ id: 'pet-1', name: 'Mochi' }))
}

/** deps that make renameSync fail the way a cross-volume move does. */
const renameAlwaysFails: Pick<MigrateLegacyHomeDeps, 'renameDirSync'> = {
  renameDirSync: () => {
    const error = new Error('cross-device link') as NodeJS.ErrnoException
    error.code = 'EXDEV'
    throw error
  },
}

describe('migrateLegacyHome', () => {
  it('renames the legacy home onto the new path: content identical, legacy gone', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet')
    const target = join(home, 'petween')
    seedLegacyHome(legacy)

    expect(migrateLegacyHome(legacy, target)).toBe('renamed')

    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
    expect(readFileSync(join(target, 'assets', 'abc123.webp'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
    )
    expect(readFileSync(join(target, 'assets.json'), 'utf8')).toBe(JSON.stringify({ abc123: { mimeType: 'image/webp' } }))
    expect(readFileSync(join(target, 'animations', 'user_hop.json'), 'utf8')).toBe(JSON.stringify({ version: 1, id: 'user:hop' }))
    expect(readFileSync(join(target, 'pets', 'pet-1.json'), 'utf8')).toBe(JSON.stringify({ id: 'pet-1', name: 'Mochi' }))
    // Idempotent: the second boot sees only the target and does nothing.
    expect(migrateLegacyHome(legacy, target)).toBe('skipped')
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
  })

  it('skips entirely when the new home already exists: both trees untouched', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet')
    const target = join(home, 'petween')
    seedLegacyHome(legacy)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'config.json'), 'fresh install')

    expect(migrateLegacyHome(legacy, target)).toBe('skipped')

    // Nothing moved, nothing deleted — the pre-existing target wins.
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('fresh install')
    expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe(JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
    expect(existsSync(join(legacy, 'assets', 'abc123.webp'))).toBe(true)
  })

  it('has no side effect when the legacy home never existed (fresh install)', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet')
    const target = join(home, 'petween')

    expect(migrateLegacyHome(legacy, target)).toBe('skipped')
    expect(existsSync(target)).toBe(false) // no directory may be created
    expect(existsSync(legacy)).toBe(false)
  })

  it('falls back to copy-and-keep when rename fails (cross-volume / locked)', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet')
    const target = join(home, 'petween')
    seedLegacyHome(legacy)

    const outcome = migrateLegacyHome(legacy, target, {
      ...renameAlwaysFails,
      copyDirSync: (from, to) => {
        // The real cpSync with the exact options src/host/migrate.ts uses.
        cpSync(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
      },
    })
    expect(outcome).toBe('copied')

    // The safety net: new home fully readable, legacy tree still there.
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
    expect(readFileSync(join(target, 'assets', 'abc123.webp'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
    )
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(join(legacy, 'pets', 'pet-1.json'))).toBe(true)
  })

  it('warns, cleans a partial target and keeps the legacy home when even the copy fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const home = makeHome()
      const legacy = join(home, 'motion-pet')
      const target = join(home, 'petween')
      seedLegacyHome(legacy)

      const outcome = migrateLegacyHome(legacy, target, {
        renameDirSync: () => {
          throw new Error('EXDEV: cross-device link not permitted')
        },
        copyDirSync: () => {
          throw new Error('ENOSPC: no space left on device')
        },
      })
      expect(outcome).toBe('failed')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('petween:')
      // Partial target removed (next boot retries), legacy data intact.
      expect(existsSync(target)).toBe(false)
      expect(existsSync(join(legacy, 'config.json'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('never deletes a target another process fully migrated mid-race (concurrent boots)', () => {
    const home = makeHome()
    const legacy = join(home, 'motion-pet')
    const target = join(home, 'petween')
    seedLegacyHome(legacy)

    const outcome = migrateLegacyHome(legacy, target, {
      // Process A completes the migration AFTER this process's existsSync
      // checks: the legacy tree disappears and the target appears with real
      // data — then A's success surfaces here as just another rename failure.
      renameDirSync: (from, to) => {
        rmSync(from, { recursive: true, force: true })
        mkdirSync(to, { recursive: true })
        writeFileSync(join(to, 'config.json'), JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
        throw new Error('EEXIST: file already exists (lost the race)')
      },
      copyDirSync: () => {
        throw new Error('ENOENT: no such file or directory') // legacy is gone
      },
    })
    expect(outcome).toBe('skipped')
    // Process A's migrated data survives — the pre-guard code returned
    // 'failed' and deleted it, the only copy left.
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(JSON.stringify({ schema: 1, activePetId: 'pet-1' }))
  })
})
