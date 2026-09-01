/**
 * host/migrate-v2.ts — v1 → v2 boot migration for preset authority
 * (phase 2, docs/preset-authority-eval.md §4).
 *
 * src/index.ts runs {@link ensurePresetAuthority} once per boot AFTER the
 * legacy-home rename (host/migrate.ts) and BEFORE any store exists. It
 * guarantees the phase-2 on-disk invariants:
 *
 * 1. a v1 config.json (the pre-flip full document) is migrated: its slice is
 *    STRICTLY validated and pushed into the preset activePetId points at —
 *    lossless, because under the old contract the config was authoritative
 *    and the preset merely its mirror (the push also heals any historical
 *    mirror lag). A null or dangling pointer instead builds the default pet
 *    FROM that slice and points at it. The original file is backed up to
 *    `config.v1.backup.json` before config.json is rewritten as the v2
 *    global document.
 * 2. a v2 config.json with a null/dangling pointer is repaired onto the most
 *    recently updated preset — or a fresh default pet when none exists.
 * 3. a first run (no config.json) provisions the default pet and its v2
 *    document the same way, so activePetId is never null (form (i)).
 *
 * Discipline (same as host/migrate.ts): synchronous (must finish before the
 * first store read), idempotent (a healthy v2 install is a no-op), and old
 * data is never destroyed — the v1 file survives as the backup and
 * non-active presets are never touched (they were always
 * self-authoritative). ANY failure keeps the v1 file as-is, warns, and boots
 * on the old format: the dual-readable loader (host/config.ts) still
 * understands it.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDefaultPetweenConfig } from '../core/defaults'
import type { PetSlice } from '../core/types'
import { toGlobalDocument } from './config'
import { DEFAULT_PET_NAME, normalizePetSlice, petSliceFromConfig, validatePetId } from './pets'
import { writeJsonAtomicSync } from './storage'
import { repairConfig, validatePetSlicePatch } from './validation'

/** What {@link ensurePresetAuthority} ended up doing. */
export type PresetAuthorityOutcome =
  /** A v1 config was rewritten as the v2 global document (slice pushed). */
  | 'migrated'
  /** No usable config/pets existed: the default pet + v2 document were created. */
  | 'provisioned'
  /** A v2/corrupt config's null or dangling pointer was re-pointed or re-created. */
  | 'repaired'
  /** Healthy v2 install: nothing to do. */
  | 'skipped'
  /** A step failed; warned and booting on the old format (v1 stays readable). */
  | 'failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a JSON file synchronously; null when missing or unparsable. */
function readJsonSync(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

interface ScannedPet {
  id: string
  updatedAt: string
}

/**
 * Scan the pets directory synchronously for usable presets. The hard gate
 * mirrors PetsStore.list's (a file it would skip must never become the
 * active pointer): a `pet_*` id and a non-empty name.
 */
function scanPetsSync(petsDir: string): ScannedPet[] {
  let entries: string[]
  try {
    entries = readdirSync(petsDir)
  } catch {
    return [] // no directory yet = no presets
  }
  const pets: ScannedPet[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = readJsonSync(join(petsDir, entry))
    if (!isRecord(raw)) continue
    const id = validatePetId(raw.id)
    if (id === null) continue
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) continue
    pets.push({ id, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '' })
  }
  return pets
}

/** The "most recently updated" scan entry — the C5-C recency fallback. */
function newestPet(pets: ScannedPet[]): ScannedPet | undefined {
  return pets.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? 1 : -1))[0]
}

/** Host-generated id, same scheme as PetsStore.generateId. */
function generatePetIdSync(petsDir: string): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = `pet_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
    if (!existsSync(join(petsDir, `${id}.json`))) return id
  }
  return `pet_${randomBytes(8).toString('hex')}`
}

/**
 * Create the default pet around the given slice (the slice is re-normalized
 * defensively — callers pass either an already-validated v1 slice or the
 * defaults) and return its id. Shared by every "no pet to point at" path.
 */
function createDefaultPetSync(petsDir: string, slice: PetSlice): string {
  const id = generatePetIdSync(petsDir)
  const now = new Date().toISOString()
  writeJsonAtomicSync(join(petsDir, `${id}.json`), {
    id,
    name: DEFAULT_PET_NAME,
    ...normalizePetSlice(slice),
    createdAt: now,
    updatedAt: now,
  })
  return id
}

/**
 * Push the migrated v1 slice into an existing preset, preserving name,
 * createdAt and the out-of-slice fields (attribution, pluginConfigs). The
 * no-churn rule mirrors PetsStore: an unchanged slice skips the write (and
 * the updatedAt bump) entirely.
 */
function pushSliceSync(petsDir: string, id: string, slice: PetSlice): void {
  const filePath = join(petsDir, `${id}.json`)
  const raw = readJsonSync(filePath)
  if (!isRecord(raw)) throw new Error(`preset file unreadable mid-migration: ${filePath}`)
  const current = normalizePetSlice(raw)
  const unchanged =
    current.scale === slice.scale &&
    JSON.stringify(current.poses) === JSON.stringify(slice.poses) &&
    JSON.stringify(current.states) === JSON.stringify(slice.states)
  if (unchanged) return
  writeJsonAtomicSync(filePath, { ...raw, scale: slice.scale, poses: slice.poses, states: slice.states, updatedAt: new Date().toISOString() })
}

/** One boot-time pass; never throws (the plugin must not crash over its own data migration). */
export function ensurePresetAuthority(root: string): PresetAuthorityOutcome {
  try {
    return run(root)
  } catch (error) {
    console.warn('petween: preset-authority migration failed; booting on the existing v1 data', error)
    return 'failed'
  }
}

function run(root: string): PresetAuthorityOutcome {
  const configPath = join(root, 'config.json')
  const backupPath = join(root, 'config.v1.backup.json')
  const petsDir = join(root, 'pets')
  const parsed = readJsonSync(configPath)
  // Only a plain object can be a config document; anything else is corrupt.
  const raw = isRecord(parsed) ? parsed : null
  const pets = scanPetsSync(petsDir)
  const petIds = new Set(pets.map((pet) => pet.id))
  const pointerOf = (doc: Record<string, unknown>): string | null =>
    typeof doc.activePetId === 'string' && validatePetId(doc.activePetId) !== null ? doc.activePetId : null

  // --- v2 fast path: only the pointer can need repair. --------------------
  if (raw !== null && raw.version === 2) {
    const pointer = pointerOf(raw)
    if (pointer !== null && petIds.has(pointer)) return 'skipped'
    const activePetId = newestPet(pets)?.id ?? createDefaultPetSync(petsDir, petSliceFromConfig(createDefaultPetweenConfig()))
    const globals = repairConfig(raw)
    writeJsonAtomicSync(configPath, { ...toGlobalDocument(globals), activePetId })
    return 'repaired'
  }

  // --- missing / corrupt config: never delete it, and never invent pets over one.
  if (raw === null) {
    // A corrupt original is preserved before anything overwrites its path.
    if (existsSync(configPath)) copyFileSync(configPath, backupPath)
    if (pets.length > 0) {
      // Presets are self-authoritative: point at the newest and rebuild the
      // global document around it.
      const activePetId = newestPet(pets) as ScannedPet
      const globals = repairConfig(null)
      writeJsonAtomicSync(configPath, { ...toGlobalDocument(globals), activePetId: activePetId.id })
      return 'repaired'
    }
    // True first run: provision the default pet so the pointer is never null.
    const activePetId = createDefaultPetSync(petsDir, petSliceFromConfig(createDefaultPetweenConfig()))
    const globals = repairConfig(null)
    writeJsonAtomicSync(configPath, { ...toGlobalDocument(globals), activePetId })
    return 'provisioned'
  }

  // --- v1 document: strict-validate the slice BEFORE anything is written. --
  // A structurally invalid slice keeps the v1 file untouched and boots on
  // the old format (the dual-readable loader still understands it).
  let slice: PetSlice
  try {
    slice = validatePetSlicePatch(
      { scale: isRecord(raw.global) ? raw.global.scale : undefined, poses: raw.poses, states: raw.states },
      petSliceFromConfig(createDefaultPetweenConfig()),
    )
  } catch (error) {
    console.warn('petween: v1 config slice failed strict validation; keeping the v1 file unchanged', error)
    return 'failed'
  }
  const pointer = pointerOf(raw)
  let activePetId: string
  if (pointer !== null && petIds.has(pointer)) {
    // The config was authoritative, the preset its mirror: pushing the slice
    // is lossless and heals any historical mirror lag. Non-active presets
    // are never touched (they were always self-authoritative).
    pushSliceSync(petsDir, pointer, slice)
    activePetId = pointer
  } else {
    // Null or dangling pointer: the live slice becomes the default pet.
    activePetId = createDefaultPetSync(petsDir, slice)
  }
  // Ordering: the slice landed first, so a failure past this point leaves
  // the v1 config intact and the next boot simply retries (the push is
  // idempotent). The backup rides ahead of the rewrite — old data is never
  // destroyed.
  copyFileSync(configPath, backupPath)
  const globals = repairConfig(raw)
  writeJsonAtomicSync(configPath, { ...toGlobalDocument(globals), activePetId })
  return 'migrated'
}
