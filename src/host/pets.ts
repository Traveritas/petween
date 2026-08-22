/**
 * host/pets.ts — pet preset persistence (V1.1).
 *
 * Layout: `$DSH_HOME/motion-pet/pets/<id>.json` — one PetPreset per file,
 * written atomically (host/storage.ts). A preset owns the character slice of
 * the config — poses, states and the global scale; everything else (overlay,
 * enabled, advanced, interactions, …) stays global and never enters a
 * preset. Ids are host-generated (`pet_<base36><hex>`), so disk names never
 * derive from user input and traversal is impossible by construction.
 *
 * The store is also the mirror target: ConfigStore's onSaved hook re-writes
 * the active preset's slice on every config save, so editor changes to the
 * current pet automatically belong to that preset.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { MotionPetConfig, PetPreset, PetSlice } from '../core/types'
import { writeJsonAtomic } from './storage'
import { repairConfig } from './validation'

export type { PetPreset, PetSlice } from '../core/types'

export type PetErrorCode = 'INVALID_PRESET' | 'NOT_FOUND'

/** Pet-store failure with a stable code; the routes layer maps it to HTTP. */
export class PetError extends Error {
  override readonly name = 'PetError'
  constructor(
    readonly code: PetErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Storable pet ids: host-generated, filename-safe by construction. */
const PET_ID_RE = /^pet_[a-z0-9]+$/

/** Route-level id guard; the store derives every disk name from it. */
export function validatePetId(id: unknown): string | null {
  return typeof id === 'string' && PET_ID_RE.test(id) ? id : null
}

export function defaultPetsDir(): string {
  return dshHomePath('motion-pet', 'pets')
}

/** The preset-owned slice of a config (poses/states/global scale). */
export function petSliceFromConfig(config: MotionPetConfig): PetSlice {
  return { scale: config.global.scale, poses: config.poses, states: config.states }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Repair a raw slice into a valid one: the config walker's repair mode fills
 * missing pose keys / states / scale from the defaults (a blank slice becomes
 * an empty pet) and fixes invalid values field-wise. The output is always a
 * fresh deep copy, so stored presets never alias the caller's config objects.
 */
export function normalizePetSlice(raw: unknown): PetSlice {
  const source = isRecord(raw) ? raw : {}
  const repaired = repairConfig({
    global: { scale: source.scale },
    poses: source.poses,
    states: source.states,
  })
  return { scale: repaired.global.scale, poses: repaired.poses, states: repaired.states }
}

const MAX_PET_NAME_LENGTH = 120 // internal sanity bound

/** Non-empty trimmed name; anything else is an INVALID_PRESET store error. */
function requirePetName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new PetError('INVALID_PRESET', 'pet name must be a non-empty string')
  }
  const trimmed = name.trim()
  if (trimmed.length > MAX_PET_NAME_LENGTH) {
    throw new PetError('INVALID_PRESET', `pet name exceeds ${MAX_PET_NAME_LENGTH} characters`)
  }
  return trimmed
}

/** Hard per-file shape gate for scans: a problem description, or null. */
function presetShapeProblem(raw: unknown): string | null {
  if (!isRecord(raw)) return 'expected an object'
  if (validatePetId(raw.id) === null) return 'id: expected a "pet_<name>" id'
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) return 'name: expected a non-empty string'
  if (raw.scale !== undefined && (typeof raw.scale !== 'number' || !Number.isFinite(raw.scale))) {
    return 'scale: expected a number'
  }
  if (raw.poses !== undefined && !isRecord(raw.poses)) return 'poses: expected an object'
  if (raw.states !== undefined && !isRecord(raw.states)) return 'states: expected an object'
  return null
}

/** Parse a raw file into a preset; the caller already passed the shape gate. */
function toPreset(raw: Record<string, unknown>): PetPreset {
  return {
    id: raw.id as string,
    name: (raw.name as string).trim(),
    ...normalizePetSlice(raw),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

export interface PetsStoreOptions {
  /** Directory holding the preset files; created lazily on first write. */
  petsDir: string
  /** Clock injection for tests; defaults to real ISO timestamps. */
  now?: () => string
}

export class PetsStore {
  /** Serializes read-modify-write cycles in this process (AssetStore pattern). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: PetsStoreOptions) {}

  /**
   * Scan the directory and load every preset. Corrupt JSON and shape
   * violations are skipped with a warning — listing never blocks on a bad
   * file. Per-field junk inside a well-shaped file is repaired onto the
   * defaults (normalizePetSlice).
   */
  async list(): Promise<{ pets: PetPreset[]; warnings: string[] }> {
    let entries: string[]
    try {
      entries = await readdir(this.options.petsDir)
    } catch {
      return { pets: [], warnings: [] } // no directory yet = no presets
    }
    const pets: PetPreset[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(join(this.options.petsDir, entry), 'utf8'))
      } catch {
        warnings.push(`${entry}: unreadable or invalid JSON, skipped`)
        continue
      }
      const problem = presetShapeProblem(raw)
      if (problem !== null) {
        warnings.push(`${entry}: ${problem}, skipped`)
        continue
      }
      const preset = toPreset(raw as Record<string, unknown>)
      if (seen.has(preset.id)) {
        warnings.push(`${entry}: duplicate id "${preset.id}", skipped`)
        continue
      }
      seen.add(preset.id)
      pets.push(preset)
    }
    return { pets, warnings }
  }

  /** Create a preset from a name and a raw slice (repaired field-wise). */
  create(name: unknown, slice: unknown): Promise<PetPreset> {
    return this.enqueue(async () => {
      const now = this.now()
      const preset: PetPreset = {
        id: this.generateId(),
        name: requirePetName(name),
        ...normalizePetSlice(slice),
        createdAt: now,
        updatedAt: now,
      }
      await writeJsonAtomic(this.filePathFor(preset.id), preset)
      return preset
    })
  }

  /** Load one preset; NOT_FOUND for unknown ids and unreadable files. */
  async read(id: string): Promise<PetPreset> {
    const valid = validatePetId(id)
    if (valid === null) throw new PetError('NOT_FOUND', `unknown pet: ${String(id)}`)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.filePathFor(valid), 'utf8'))
    } catch {
      throw new PetError('NOT_FOUND', `unknown pet: ${valid}`)
    }
    if (presetShapeProblem(raw) !== null) throw new PetError('NOT_FOUND', `unreadable pet: ${valid}`)
    return toPreset(raw as Record<string, unknown>)
  }

  /** Rename a preset, bumping updatedAt; resolves the updated preset. */
  rename(id: string, name: unknown): Promise<PetPreset> {
    return this.enqueue(async () => {
      const preset = await this.read(id)
      const renamed: PetPreset = { ...preset, name: requirePetName(name), updatedAt: this.now() }
      await writeJsonAtomic(this.filePathFor(preset.id), renamed)
      return renamed
    })
  }

  /**
   * Replace a preset's slice (the config mirror path), keeping name and
   * createdAt. NOT_FOUND when the file is gone — the mirror caller treats
   * that as a warning, since the config stays authoritative.
   */
  saveSlice(id: string, slice: unknown): Promise<PetPreset> {
    return this.enqueue(async () => {
      const preset = await this.read(id)
      const updated: PetPreset = { ...preset, ...normalizePetSlice(slice), updatedAt: this.now() }
      await writeJsonAtomic(this.filePathFor(preset.id), updated)
      return updated
    })
  }

  /** Delete a preset file; NOT_FOUND for unknown ids. */
  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const valid = validatePetId(id)
      if (valid === null || !existsSync(this.filePathFor(valid))) {
        throw new PetError('NOT_FOUND', `unknown pet: ${String(id)}`)
      }
      await unlink(this.filePathFor(valid))
    })
  }

  private filePathFor(id: string): string {
    return join(this.options.petsDir, `${id}.json`)
  }

  /** Host-generated id; the random suffix keeps same-millisecond creates apart. */
  private generateId(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = `pet_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
      if (!existsSync(this.filePathFor(id))) return id
    }
    // 8 random hex bytes make a collision effectively impossible; reaching
    // this means the clock is broken, so fall back to pure randomness.
    return `pet_${randomBytes(8).toString('hex')}`
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
