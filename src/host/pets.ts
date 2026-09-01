/**
 * host/pets.ts — pet preset persistence (V1.1).
 *
 * Layout: `$DSH_HOME/petween/pets/<id>.json` — one PetPreset per file,
 * written atomically (host/storage.ts). A preset owns the character slice of
 * the config — poses, states and the global scale; everything else (overlay,
 * enabled, advanced, interactions, …) stays global and never enters a
 * preset. Ids are host-generated (`pet_<base36><hex>`), so disk names never
 * derive from user input and traversal is impossible by construction.
 *
 * Preset-authority phase 2: presets are the slice's single source of truth.
 * The authoritative write path is {@link PetsStore.writeSlice} (strict
 * validation, config-PUT discipline); `saveSlice`'s repair-style
 * normalization survives only for read/import repair paths (create()).
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PetweenConfig, PetAttribution, PetPluginConfigs, PetPreset, PetSlice } from '../core/types'
import type { AnimationKind } from '../motion/animation-definition'
import { createWriteLock, writeJsonAtomic, type WriteLock } from './storage'
import { repairConfig, validatePetSlicePatch } from './validation'

export type { PetAttribution, PetPluginConfigEntry, PetPluginConfigs, PetPreset, PetSlice } from '../core/types'

/**
 * Attribution bounds (pet-package §12): all fields optional, strings bounded,
 * creators capped per-item and in count.
 */
const ATTRIBUTION_LIMITS = {
  character: 200,
  creatorItem: 120,
  creators: 8,
  sourceUrl: 500,
  license: 200,
} as const

export type AttributionValidation = { ok: true; attribution: PetAttribution } | { ok: false; errors: string[] }

/**
 * Validate a FULL attribution object (package import, record load): known
 * fields are checked for type and length, unknown fields are ignored, an
 * empty result is reported as an empty attribution (not an error).
 */
export function validatePetAttribution(raw: unknown): AttributionValidation {
  const attribution: PetAttribution = {}
  const errors: string[] = []
  if (raw === undefined || raw === null) return { ok: true, attribution }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['attribution must be an object'] }
  const source = raw as Record<string, unknown>
  const character = trimNonEmpty(source.character)
  if (character !== undefined) {
    if (character.length > ATTRIBUTION_LIMITS.character) errors.push(`attribution.character exceeds ${ATTRIBUTION_LIMITS.character} characters`)
    else attribution.character = character
  } else if (source.character !== undefined && source.character !== null) {
    errors.push('attribution.character must be a string')
  }
  if (source.creators !== undefined && source.creators !== null) {
    if (!Array.isArray(source.creators)) {
      errors.push('attribution.creators must be an array of strings')
    } else {
      const creators: string[] = []
      for (const [index, item] of source.creators.entries()) {
        const trimmed = trimNonEmpty(item)
        if (trimmed === undefined) {
          errors.push(`attribution.creators[${index}] must be a non-empty string`)
          continue
        }
        if (trimmed.length > ATTRIBUTION_LIMITS.creatorItem) {
          errors.push(`attribution.creators[${index}] exceeds ${ATTRIBUTION_LIMITS.creatorItem} characters`)
          continue
        }
        creators.push(trimmed)
      }
      if (creators.length > ATTRIBUTION_LIMITS.creators) {
        errors.push(`attribution.creators exceeds ${ATTRIBUTION_LIMITS.creators} entries`)
      } else if (creators.length > 0) {
        attribution.creators = creators
      }
    }
  }
  const sourceUrl = trimNonEmpty(source.sourceUrl)
  if (sourceUrl !== undefined) {
    if (sourceUrl.length > ATTRIBUTION_LIMITS.sourceUrl) errors.push(`attribution.sourceUrl exceeds ${ATTRIBUTION_LIMITS.sourceUrl} characters`)
    else attribution.sourceUrl = sourceUrl
  } else if (source.sourceUrl !== undefined && source.sourceUrl !== null) {
    errors.push('attribution.sourceUrl must be a string')
  }
  const license = trimNonEmpty(source.license)
  if (license !== undefined) {
    if (license.length > ATTRIBUTION_LIMITS.license) errors.push(`attribution.license exceeds ${ATTRIBUTION_LIMITS.license} characters`)
    else attribution.license = license
  } else if (source.license !== undefined && source.license !== null) {
    errors.push('attribution.license must be a string')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, attribution }
}

export type AttributionPatchResult = { ok: true; attribution?: PetAttribution } | { ok: false; errors: string[] }

/**
 * PUT /pets/&lt;id&gt; partial-update semantics: per attribution field,
 * absent = keep the current value, null = clear, a valid value = replace.
 * Returns the NEXT attribution (undefined when every field ended up empty).
 */
export function mergePetAttribution(
  current: PetAttribution | undefined,
  patch: Record<string, unknown>,
): AttributionPatchResult {
  const merged: PetAttribution = { ...current }
  const errors: string[] = []
  for (const field of ['character', 'creators', 'sourceUrl', 'license'] as const) {
    if (patch[field] === undefined) continue
    if (patch[field] === null) {
      delete merged[field]
      continue
    }
    if (field === 'creators') {
      if (!Array.isArray(patch.creators)) {
        errors.push('attribution.creators must be an array of strings or null')
        continue
      }
      if (patch.creators.length > ATTRIBUTION_LIMITS.creators) {
        errors.push(`attribution.creators exceeds ${ATTRIBUTION_LIMITS.creators} entries`)
        continue
      }
      const creators: string[] = []
      let bad = false
      for (const [index, item] of patch.creators.entries()) {
        const trimmed = trimNonEmpty(item)
        if (trimmed === undefined) {
          errors.push(`attribution.creators[${index}] must be a non-empty string`)
          bad = true
          break
        }
        if (trimmed.length > ATTRIBUTION_LIMITS.creatorItem) {
          errors.push(`attribution.creators[${index}] exceeds ${ATTRIBUTION_LIMITS.creatorItem} characters`)
          bad = true
          break
        }
        creators.push(trimmed)
      }
      if (!bad && creators.length > 0) merged.creators = creators
      else if (!bad) delete merged.creators
      continue
    }
    const trimmed = trimNonEmpty(patch[field])
    if (trimmed === undefined) {
      errors.push(`attribution.${field} must be a string or null`)
      continue
    }
    const limit = ATTRIBUTION_LIMITS[field]
    if (trimmed.length > limit) {
      errors.push(`attribution.${field} exceeds ${limit} characters`)
      continue
    }
    merged[field] = trimmed
  }
  const isEmpty = Object.keys(merged).length === 0
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, attribution: isEmpty ? undefined : merged }
}

/** Trimmed non-empty string, or undefined for absent/null/empty/non-string. */
function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Load-time tolerance: drop an unusable attribution instead of failing. */
function normalizeAttribution(raw: unknown): PetAttribution | undefined {
  const result = validatePetAttribution(raw)
  return result.ok && Object.keys(result.attribution).length > 0 ? result.attribution : undefined
}

/**
 * pluginConfigs bounds (pet-package §12): companion-plugin blobs stay small
 * shareable snippets — the per-config cap mirrors the companions' own PUT
 * body limits (16KiB), the rest keeps manifests and preset files lean.
 */
export const PLUGIN_CONFIG_LIMITS = {
  entries: 8,
  pluginIdLength: 64,
  configBytes: 16 * 1024,
  totalBytes: 64 * 1024,
} as const

/** Companion plugin ids are cordis names: lowercase, dash-separated. */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export type PluginConfigsValidation = { ok: true; pluginConfigs: PetPluginConfigs } | { ok: false; errors: string[] }

/** Serialized byte size of a JSON value; null when the value is not JSON-serializable. */
function jsonByteSize(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : Buffer.byteLength(text, 'utf8')
  } catch {
    return null
  }
}

/**
 * Validate a FULL pluginConfigs object (package import, record load): the
 * envelope is checked field-wise — plugin id charset/count, a present and
 * JSON-serializable `config` per entry, the remap shape, and the byte caps.
 * The total cap sizes the NORMALIZED block (what actually gets persisted —
 * unknown entry fields are dropped here) and only when the entries passed.
 * The `config` CONTENT is never validated or interpreted (§12: capability,
 * not policy — the schema belongs to the companion plugin).
 */
export function validatePluginConfigs(raw: unknown): PluginConfigsValidation {
  if (!isRecord(raw)) return { ok: false, errors: ['pluginConfigs must be an object'] }
  const errors: string[] = []
  if (Object.keys(raw).length > PLUGIN_CONFIG_LIMITS.entries) errors.push(`pluginConfigs exceeds ${PLUGIN_CONFIG_LIMITS.entries} entries`)
  const pluginConfigs: PetPluginConfigs = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!PLUGIN_ID_RE.test(id) || id.length > PLUGIN_CONFIG_LIMITS.pluginIdLength) {
      errors.push(`pluginConfigs.${id}: plugin id must match ^[a-z0-9][a-z0-9-]*$ and be ≤${PLUGIN_CONFIG_LIMITS.pluginIdLength} characters`)
      continue
    }
    if (!isRecord(value)) {
      errors.push(`pluginConfigs.${id}: expected an object with a "config" field`)
      continue
    }
    if (!('config' in value) || value.config === undefined) {
      errors.push(`pluginConfigs.${id}.config: required (any JSON value)`)
      continue
    }
    const configBytes = jsonByteSize(value.config)
    if (configBytes === null) {
      errors.push(`pluginConfigs.${id}.config must be JSON-serializable`)
      continue
    }
    if (configBytes > PLUGIN_CONFIG_LIMITS.configBytes) {
      errors.push(`pluginConfigs.${id}.config exceeds ${PLUGIN_CONFIG_LIMITS.configBytes / 1024}KiB serialized`)
      continue
    }
    const remap = value.animationIdRemap
    if (remap !== undefined && (!isRecord(remap) || Object.values(remap).some((mapped) => typeof mapped !== 'string'))) {
      errors.push(`pluginConfigs.${id}.animationIdRemap must be a string→string map`)
      continue
    }
    pluginConfigs[id] = { config: value.config, ...(remap === undefined ? {} : { animationIdRemap: remap as Record<string, string> }) }
  }
  if (errors.length === 0) {
    const totalBytes = jsonByteSize(pluginConfigs)
    if (totalBytes !== null && totalBytes > PLUGIN_CONFIG_LIMITS.totalBytes) {
      errors.push(`pluginConfigs exceeds ${PLUGIN_CONFIG_LIMITS.totalBytes / 1024}KiB serialized`)
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, pluginConfigs }
}

/** Load-time tolerance: drop unusable pluginConfigs instead of failing. */
function normalizePluginConfigs(raw: unknown): PetPluginConfigs | undefined {
  const result = validatePluginConfigs(raw)
  return result.ok && Object.keys(result.pluginConfigs).length > 0 ? result.pluginConfigs : undefined
}

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
  return dshHomePath('petween', 'pets')
}

/** The preset-owned slice of a config (poses/states/global scale). */
export function petSliceFromConfig(config: PetweenConfig): PetSlice {
  return { scale: config.global.scale, poses: config.poses, states: config.states }
}

/**
 * The auto-provisioned pet's name (preset authority, form (i)): every edit
 * belongs to a pet, so the boot migration (host/migrate-v2.ts), the update
 * funnel's null/dangling-pointer repair and the C5-C delete fallback all
 * create this pet when nothing else exists. Renaming is the user's fork
 * point — the name says so.
 */
export const DEFAULT_PET_NAME = '未命名宠物（可改名）'

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
  const preset: PetPreset = {
    id: raw.id as string,
    name: (raw.name as string).trim(),
    ...normalizePetSlice(raw),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
  const attribution = normalizeAttribution(raw.attribution)
  if (attribution !== undefined) preset.attribution = attribution
  // §12: carried explicitly — toPreset whitelists known keys, so without this
  // line a record's pluginConfigs would silently vanish on the next read
  // (and with it on the next slice write, which spreads the stored record).
  const pluginConfigs = normalizePluginConfigs(raw.pluginConfigs)
  if (pluginConfigs !== undefined) preset.pluginConfigs = pluginConfigs
  return preset
}

export interface PetsStoreOptions {
  /** Directory holding the preset files; created lazily on first write. */
  petsDir: string
  /** Clock injection for tests; defaults to real ISO timestamps. */
  now?: () => string
  /** Shared cross-store write serializer (B10); default: a private chain. */
  lock?: WriteLock
}

export class PetsStore {
  /** Serializes read-modify-write cycles in this process (AssetStore pattern). */
  private readonly lock: WriteLock

  constructor(private readonly options: PetsStoreOptions) {
    this.lock = options.lock ?? createWriteLock()
  }

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

  /**
   * Create a preset from a name, a raw slice (repaired field-wise) and the
   * optional pre-validated attribution / pluginConfigs (pet-package import
   * writes the whole record — slice, attribution and companion blobs — in
   * ONE atomic file, §12).
   */
  create(name: unknown, slice: unknown, attribution?: PetAttribution, pluginConfigs?: PetPluginConfigs): Promise<PetPreset> {
    return this.enqueue(async () => {
      const now = this.now()
      const preset: PetPreset = {
        id: this.generateId(),
        name: requirePetName(name),
        ...normalizePetSlice(slice),
        createdAt: now,
        updatedAt: now,
      }
      if (attribution !== undefined && Object.keys(attribution).length > 0) preset.attribution = attribution
      if (pluginConfigs !== undefined && Object.keys(pluginConfigs).length > 0) preset.pluginConfigs = pluginConfigs
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
   * Update identity fields without touching the slice: `name` (validated as
   * in rename) and `attribution` with PUT partial semantics — the patch
   * object updates fields one by one (absent = keep, null = clear), while
   * `attribution: null` clears the whole block. A call providing neither
   * field is a no-op returning the stored preset untouched.
   */
  updateMeta(id: string, changes: { name?: unknown; attribution?: null | Record<string, unknown> }): Promise<PetPreset> {
    return this.enqueue(async () => {
      const preset = await this.read(id)
      const next: PetPreset = { ...preset }
      if (changes.name !== undefined) next.name = requirePetName(changes.name)
      if (changes.attribution !== undefined) {
        if (changes.attribution === null) {
          delete next.attribution
        } else {
          const merged = mergePetAttribution(preset.attribution, changes.attribution)
          if (!merged.ok) throw new PetError('INVALID_PRESET', merged.errors.join('; '))
          delete next.attribution
          if (merged.attribution !== undefined) next.attribution = merged.attribution
        }
      }
      if (next.name === preset.name && JSON.stringify(next.attribution) === JSON.stringify(preset.attribution)) {
        return preset
      }
      const updated: PetPreset = { ...next, updatedAt: this.now() }
      await writeJsonAtomic(this.filePathFor(preset.id), updated)
      return updated
    })
  }

  /**
   * Replace a preset's slice from a STRICTLY validated patch — the
   * authoritative slice write path (preset-authority phase 2). The patch
   * uses the slice shape `{scale?, poses?, states?}` and is validated
   * against the preset's CURRENT slice with config-PUT semantics: absent
   * fields keep their value, invalid present fields throw
   * ConfigValidationError (→ HTTP 400 at the routes layer). Name, createdAt
   * and the out-of-slice fields (attribution, pluginConfigs) are kept; an
   * unchanged result skips the disk write and the updatedAt bump (same
   * no-churn rule as saveSlice).
   */
  writeSlice(id: string, slice: unknown, options: { animationLookup?: (id: string) => AnimationKind | undefined } = {}): Promise<PetPreset> {
    return this.enqueue(async () => {
      const preset = await this.read(id)
      const validated = validatePetSlicePatch(slice, { scale: preset.scale, poses: preset.poses, states: preset.states }, options)
      const unchanged =
        preset.scale === validated.scale &&
        JSON.stringify(preset.poses) === JSON.stringify(validated.poses) &&
        JSON.stringify(preset.states) === JSON.stringify(validated.states)
      if (unchanged) return preset
      const updated: PetPreset = { ...preset, ...validated, updatedAt: this.now() }
      await writeJsonAtomic(this.filePathFor(preset.id), updated)
      return updated
    })
  }

  /**
   * Replace a preset's slice with repair-style normalization, keeping name
   * and createdAt. This is the READ/IMPORT repair path (a create() sibling):
   * tolerant field-wise repair instead of strict rejection. The
   * authoritative write path is writeSlice() — new callers writing user
   * input belong there. NOT_FOUND when the file is gone. When the normalized
   * content is unchanged the write is skipped and the original updatedAt
   * kept: rewriting identical slices would churn the preset files and fake
   * content changes in updatedAt.
   */
  saveSlice(id: string, slice: unknown): Promise<PetPreset> {
    return this.enqueue(async () => {
      const preset = await this.read(id)
      const normalized = normalizePetSlice(slice)
      // Both sides pass through normalizePetSlice/repairConfig, which builds
      // fresh objects with a fixed key order — a stringify comparison is
      // stable here.
      const unchanged =
        preset.scale === normalized.scale &&
        JSON.stringify(preset.poses) === JSON.stringify(normalized.poses) &&
        JSON.stringify(preset.states) === JSON.stringify(normalized.states)
      if (unchanged) return preset
      const updated: PetPreset = { ...preset, ...normalized, updatedAt: this.now() }
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
    return this.lock(op)
  }
}
