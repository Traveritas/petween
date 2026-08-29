/**
 * host/pet-package.ts — Pet Package import/export (motion-format §12).
 *
 * A package is a zip: `manifest.json` plus `assets/<assetId>.<ext>` binaries.
 * Unlike the single-file Motion Pack (§11), images force a binary container —
 * base64-inflating them into JSON would grow every share by a third.
 *
 * Import discipline (§12 原子性): EVERYTHING below `validatePetPackage` is
 * read-only — zip structural guards, per-field manifest checks, sha256 and
 * image sniffing all run before the first byte hits disk. The routes layer
 * then persists in the fixed order assets → animations (existing one-lock
 * pack transaction) → pet creation last, best-effort rolling fresh writes
 * back if a pre-creation step fails, so an import can never leave half a pet.
 *
 * Export always embeds the mounts (the mirror image of the pure-pack export,
 * which never carries them): they are derived from the pet's own state
 * timelines and drive the id rewriting on re-import.
 */
import { createHash } from 'node:crypto'
import { unzip, zipSync, type UnzipFileInfo } from 'fflate'
import type { AssetMeta, PetSlice, PoseKey, StateAppearance } from '../core/types'
import { POSE_KEYS } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'
import { detectImage, MAX_ASSET_DIMENSION } from './assets'
import type { PetAttribution, PetPreset } from './pets'
import { validatePetAttribution } from './pets'
import {
  MIXED_NAMESPACE,
  buildMotionPackExport,
  validateMotionPack,
  type MotionPackManifest,
  type PackImportEntry,
  type PackMounts,
  type ValidatedMotionPack,
} from './packs'
import { ConfigValidationError, validateAssetId, validateConfigPatch } from './validation'

/** Request-body cap for POST /pets/import (§12 HTTP). */
export const PET_PACKAGE_BODY_LIMIT = 48 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 64
const MAX_PACKAGE_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_PACKAGE_FILE_BYTES = 12 * 1024 * 1024
const MANIFEST_ENTRY = 'manifest.json'
const MAX_PACKAGE_NAME_LENGTH = 120

/** Zip entry whitelist: `assets/<16-hex>.<png|webp|jpeg|jpg>` only. */
const ASSET_ENTRY_RE = /^assets\/([0-9a-f]{16})\.(png|webp|jpe?g)$/
const SHA256_RE = /^[0-9a-f]{64}$/
const ASSET_MIME_TYPES: readonly string[] = ['image/png', 'image/webp', 'image/jpeg']
/** Export-side extension per MIME (import additionally accepts `.jpg`). */
const MIME_TO_EXT: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpeg' }

export type PetPackageErrorCode = 'PET_PACKAGE_INVALID' | 'PACK_VERSION_NEWER' | 'EXPORT_INCOMPLETE'

/** Pet-package failure with a stable code; the routes layer maps it to HTTP. */
export class PetPackageError extends Error {
  override readonly name = 'PetPackageError'
  constructor(
    readonly code: PetPackageErrorCode,
    message: string,
    readonly details?: string[],
  ) {
    super(message)
  }
}

/** One manifest asset row (§12): content-addressed like the asset library. */
export interface PetPackageAssetEntry {
  id: string
  sha256: string
  file: string
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg'
  width: number
  height: number
}

export interface PetPackageManifest {
  format: 'pet-package'
  version: 1
  name: string
  pet: PetSlice
  assets: PetPackageAssetEntry[]
  /** Present iff the pet's states reference custom animations (§12). */
  motionPack?: MotionPackManifest
  attribution?: PetAttribution
}

/** Read-only import plan: everything validated, nothing persisted yet. */
export interface PetPackageImportPlan {
  name: string
  pet: PetSlice
  attribution?: PetAttribution
  motionPack?: ValidatedMotionPack
  /** Referenced assets only, in manifest order; hashes already verified. */
  assets: Array<{ id: string; mimeType: string; data: Buffer }>
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asBuffer(data: Uint8Array): Buffer {
  // fflate allocates a dedicated ArrayBuffer per extracted file, so wrapping
  // (not copying) is safe and keeps the 60MB cap a single copy at most.
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Structural unzip with the §12 bomb guards. The fflate filter runs BEFORE a
 * file is inflated, so the entry-count / per-file / total caps are enforced
 * against the recorded sizes without ever decompressing over-limit entries.
 * Anything off the path whitelist (traversal, backslashes, stray files) is a
 * hard violation, not a skip.
 */
function extractZip(body: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    let entryCount = 0
    let totalBytes = 0
    let tooManyEntries = false
    let oversizedEntry: string | null = null
    let overTotal = false
    const violations: string[] = []
    const whitelisted = (name: string): boolean => name === MANIFEST_ENTRY || ASSET_ENTRY_RE.test(name)
    const filter = (file: UnzipFileInfo): boolean => {
      entryCount += 1
      if (entryCount > MAX_PACKAGE_ENTRIES) {
        tooManyEntries = true
        return false
      }
      if (file.originalSize > MAX_PACKAGE_FILE_BYTES) {
        oversizedEntry ??= file.name
        return false
      }
      totalBytes += file.originalSize
      if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
        overTotal = true
        return false
      }
      // Plain directory markers are tolerated; anything else off-whitelist
      // (`..`, absolute paths, backslashes, stray names) rejects the package.
      if (file.name.length > 0 && !file.name.endsWith('/')) {
        if (!whitelisted(file.name)) violations.push(file.name)
        return whitelisted(file.name)
      }
      return false
    }
    unzip(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), { filter }, (error, unzipped) => {
      if (error !== null) {
        reject(new PetPackageError('PET_PACKAGE_INVALID', 'request body is not a valid zip archive'))
        return
      }
      if (tooManyEntries) {
        reject(new PetPackageError('PET_PACKAGE_INVALID', `package exceeds the ${MAX_PACKAGE_ENTRIES}-entry limit`))
        return
      }
      if (oversizedEntry !== null) {
        reject(
          new PetPackageError(
            'PET_PACKAGE_INVALID',
            `entry "${oversizedEntry}" exceeds the ${MAX_PACKAGE_FILE_BYTES}-byte single-file limit`,
          ),
        )
        return
      }
      if (overTotal) {
        reject(
          new PetPackageError('PET_PACKAGE_INVALID', `package exceeds the ${MAX_PACKAGE_TOTAL_BYTES}-byte decompressed total`),
        )
        return
      }
      if (violations.length > 0) {
        reject(
          new PetPackageError(
            'PET_PACKAGE_INVALID',
            `entries must be ${MANIFEST_ENTRY} or assets/<16-hex>.<png|webp|jpeg|jpg> (no traversal, absolute paths or stray files)`,
            violations,
          ),
        )
        return
      }
      resolve(new Map(Object.entries(unzipped).map(([name, data]) => [name, asBuffer(data)])))
    })
  })
}

/** Manifest rows for `assets` — per-entry field errors, duplicate ids rejected. */
function validateAssetEntries(raw: unknown): { errors: string[]; entries: PetPackageAssetEntry[] } {
  const errors: string[] = []
  const entries: PetPackageAssetEntry[] = []
  if (!Array.isArray(raw)) return { errors: ['"assets" must be an array'], entries }
  const seen = new Set<string>()
  for (const [index, candidate] of raw.entries()) {
    if (!isRecord(candidate)) {
      errors.push(`assets[${index}]: expected an object`)
      continue
    }
    const id = validateAssetId(candidate.id)
    if (id === null) {
      errors.push(`assets[${index}].id: expected a 16-hex asset id`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`assets[${index}]: duplicate id "${id}"`)
      continue
    }
    const mimeType = candidate.mimeType
    if (typeof mimeType !== 'string' || !ASSET_MIME_TYPES.includes(mimeType)) {
      errors.push(`assets[${index}].mimeType: expected one of ${ASSET_MIME_TYPES.join(' / ')}`)
      continue
    }
    const file = candidate.file
    const fileRe = new RegExp(`^assets/${id}\\.(png|webp|jpe?g)$`)
    if (typeof file !== 'string' || !fileRe.test(file)) {
      errors.push(`assets[${index}].file: expected "assets/${id}.<png|webp|jpeg|jpg>" matching the entry id`)
      continue
    }
    const ext = file.slice(file.lastIndexOf('.') + 1)
    const wantedExt = MIME_TO_EXT[mimeType]
    if (ext !== wantedExt && !(mimeType === 'image/jpeg' && ext === 'jpg')) {
      errors.push(`assets[${index}].file: extension ".${ext}" does not match mimeType ${mimeType}`)
      continue
    }
    const width = candidate.width
    const height = candidate.height
    if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0) {
      errors.push(`assets[${index}].width: expected a positive integer`)
      continue
    }
    if (typeof height !== 'number' || !Number.isInteger(height) || height <= 0) {
      errors.push(`assets[${index}].height: expected a positive integer`)
      continue
    }
    seen.add(id)
    entries.push({ id, sha256: String(candidate.sha256), file, mimeType: mimeType as PetPackageAssetEntry['mimeType'], width, height })
  }
  return { errors, entries }
}

/** Pose asset references of a slice, deduplicated, in slot order. */
export function referencedAssetIds(slice: PetSlice): string[] {
  const ids: string[] = []
  for (const key of POSE_KEYS) {
    const assetId = slice.poses[key]?.assetId
    if (assetId !== undefined && !ids.includes(assetId)) ids.push(assetId)
  }
  return ids
}

/** Custom (non-builtin) animation ids a slice's state timelines reference. */
export function referencedCustomAnimationIds(slice: PetSlice): string[] {
  const ids: string[] = []
  for (const key of POSE_KEYS) {
    const state = slice.states[key]
    for (const id of [state.enter.animationId, state.ambient.customAnimationId]) {
      if (id !== undefined && !id.startsWith('builtin:') && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/**
 * Full read-only validation of a package body: structural zip guards → strict
 * manifest fields (the same walker `normalizePetSlice` repairs with, but
 * errors surface instead of being silently repaired) → cross checks (referenced
 * assets present in manifest AND zip, sha256/content agreement, the asset-side
 * image sniffing, custom animation references carried by the motionPack).
 * Throws PetPackageError; resolves with the import plan otherwise.
 */
export async function validatePetPackage(body: Buffer): Promise<PetPackageImportPlan> {
  const files = await extractZip(body)
  const manifestBytes = files.get(MANIFEST_ENTRY)
  if (manifestBytes === undefined) {
    throw new PetPackageError('PET_PACKAGE_INVALID', `package is missing ${MANIFEST_ENTRY}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new PetPackageError('PET_PACKAGE_INVALID', `${MANIFEST_ENTRY} is not valid JSON`)
  }
  if (!isRecord(raw)) throw new PetPackageError('PET_PACKAGE_INVALID', 'manifest must be a JSON object')

  const errors: string[] = []
  if (raw.format !== 'pet-package') errors.push('"format" must be "pet-package"')
  if (raw.version !== 1) {
    if (typeof raw.version === 'number' && raw.version > 1) {
      // B2 seam: never silently misread a newer package.
      throw new PetPackageError(
        'PACK_VERSION_NEWER',
        `"version" ${raw.version} was written by a newer petween (this build reads version 1); upgrade the plugin or re-export the package at version 1`,
      )
    }
    errors.push('"version" must be 1')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0) errors.push('"name" must be a non-empty string')
  if (name.length > MAX_PACKAGE_NAME_LENGTH) errors.push(`"name" exceeds ${MAX_PACKAGE_NAME_LENGTH} characters`)

  // Character slice: strict field validation against the defaults — the same
  // base normalizePetSlice repairs onto, so what passes here is exactly what
  // the store would persist (slice-level junk reports instead of vanishing).
  let pet: PetSlice | null = null
  if (!isRecord(raw.pet)) {
    errors.push('"pet" must be an object with the character slice')
  } else {
    try {
      const config = validateConfigPatch({ global: { scale: raw.pet.scale }, poses: raw.pet.poses, states: raw.pet.states })
      pet = { scale: config.global.scale, poses: config.poses, states: config.states }
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        errors.push(...error.issues.map((issue) => `pet.${issue.path}: ${issue.message}`))
      } else {
        throw error
      }
    }
  }

  const assetCheck = validateAssetEntries(raw.assets)
  errors.push(...assetCheck.errors)

  let motionPack: ValidatedMotionPack | undefined
  if (raw.motionPack !== undefined) {
    const packResult = validateMotionPack(raw.motionPack)
    if (!packResult.ok) errors.push(...packResult.errors.map((message) => `motionPack: ${message}`))
    else motionPack = packResult.pack
  }

  let attribution: PetAttribution | undefined
  if (raw.attribution !== undefined) {
    const attributionResult = validatePetAttribution(raw.attribution)
    if (!attributionResult.ok) errors.push(...attributionResult.errors)
    else if (Object.keys(attributionResult.attribution).length > 0) attribution = attributionResult.attribution
  }

  if (errors.length > 0 || pet === null) {
    throw new PetPackageError('PET_PACKAGE_INVALID', 'invalid Pet Package manifest', errors.length > 0 ? errors : ['"pet" must be an object with the character slice'])
  }

  // Cross checks. Referenced assets must be declared AND shipped; unreferenced
  // manifest rows are redundant and ignored with a warning (§12).
  const warnings: string[] = []
  const entriesById = new Map(assetCheck.entries.map((entry) => [entry.id, entry]))
  const referenced = referencedAssetIds(pet)
  const missingFromManifest = referenced.filter((id) => !entriesById.has(id))
  if (missingFromManifest.length > 0) {
    throw new PetPackageError(
      'PET_PACKAGE_INVALID',
      'poses reference asset ids missing from the manifest (a package must be self-contained)',
      missingFromManifest,
    )
  }
  const missingFromZip = referenced.filter((id) => !files.has(entriesById.get(id)?.file ?? ''))
  if (missingFromZip.length > 0) {
    throw new PetPackageError('PET_PACKAGE_INVALID', 'manifest assets missing from the package', missingFromZip)
  }
  for (const entry of assetCheck.entries) {
    if (!referenced.includes(entry.id)) warnings.push(`asset ${entry.id} is not referenced by any pose, ignored`)
  }

  // Content agreement: sha256, the content-derived id, and the asset-side
  // sniffing (magic bytes vs declared MIME, dimension cap, SVG rejection).
  const contentErrors: string[] = []
  const assets: PetPackageImportPlan['assets'] = []
  for (const id of referenced) {
    const entry = entriesById.get(id) as PetPackageAssetEntry
    const data = files.get(entry.file) as Buffer
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (!SHA256_RE.test(entry.sha256)) {
      contentErrors.push(`assets.${id}.sha256: expected a 64-hex digest`)
      continue
    }
    if (sha256 !== entry.sha256) {
      contentErrors.push(`assets.${id}: sha256 mismatch (manifest ${entry.sha256.slice(0, 8)}…, content ${sha256.slice(0, 8)}…)`)
      continue
    }
    if (sha256.slice(0, 16) !== id) {
      contentErrors.push(`assets.${id}: id must be the first 16 hex chars of the content sha256 (content hashes to ${sha256.slice(0, 16)})`)
      continue
    }
    const detected = detectImage(data)
    if (detected === null) {
      contentErrors.push(`assets.${id}: unsupported image content (PNG/WebP/JPEG only; SVG is rejected)`)
      continue
    }
    if (detected.mimeType !== entry.mimeType) {
      contentErrors.push(`assets.${id}: manifest declares ${entry.mimeType} but the content is ${detected.mimeType}`)
      continue
    }
    if (detected.width > MAX_ASSET_DIMENSION || detected.height > MAX_ASSET_DIMENSION) {
      contentErrors.push(`assets.${id}: image exceeds ${MAX_ASSET_DIMENSION}x${MAX_ASSET_DIMENSION}`)
      continue
    }
    if (detected.width !== entry.width || detected.height !== entry.height) {
      contentErrors.push(`assets.${id}: manifest says ${entry.width}x${entry.height} but the content is ${detected.width}x${detected.height}`)
      continue
    }
    assets.push({ id, mimeType: entry.mimeType, data })
  }
  if (contentErrors.length > 0) {
    throw new PetPackageError('PET_PACKAGE_INVALID', 'asset content does not match the manifest', contentErrors)
  }

  // The slice's custom animation references must travel inside the package —
  // same self-containment rule as the assets (and what export guarantees).
  const packIds = new Set((motionPack?.animations ?? []).map((definition) => definition.id))
  const missingAnimations = referencedCustomAnimationIds(pet).filter((id) => !packIds.has(id))
  if (missingAnimations.length > 0) {
    throw new PetPackageError(
      'PET_PACKAGE_INVALID',
      'states reference custom animations not carried by the package (a package must be self-contained)',
      missingAnimations,
    )
  }

  return { name, pet, ...(attribution === undefined ? {} : { attribution }), ...(motionPack === undefined ? {} : { motionPack }), assets, warnings }
}

/** Zip entry name for an asset id on export (`assets/<id>.<ext>`). */
export function assetEntryPath(id: string, mimeType: string): string {
  return `assets/${id}.${MIME_TO_EXT[mimeType] ?? 'bin'}`
}

/** Build a zip archive: manifest plus the asset bytes the caller read. */
export function buildPetPackageZip(manifest: PetPackageManifest, assetData: Record<string, Buffer>): Uint8Array {
  const mimeTypeById = new Map(manifest.assets.map((entry) => [entry.id, entry.mimeType]))
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: Buffer.from(JSON.stringify(manifest), 'utf8'),
  }
  for (const [id, data] of Object.entries(assetData)) {
    entries[assetEntryPath(id, mimeTypeById.get(id) ?? 'image/png')] = data
  }
  return zipSync(entries)
}

/** Mounts derived from a pet's state timelines (§12): builtin ids stay out. */
export function mountsFromPetStates(pet: PetPreset): PackMounts {
  const mounts: PackMounts = {}
  for (const key of POSE_KEYS) {
    const state = pet.states[key]
    const mount: { enter?: string; ambient?: string } = {}
    const enter = state.enter.animationId
    if (enter !== undefined && !enter.startsWith('builtin:')) mount.enter = enter
    if (state.ambient.customAnimationId !== undefined) mount.ambient = state.ambient.customAnimationId
    if (mount.enter !== undefined || mount.ambient !== undefined) mounts[key] = mount
  }
  return mounts
}

/**
 * Export builder: a complete, self-contained manifest from a preset plus the
 * live libraries. Export must be complete — an asset or animation referenced
 * by the pet but missing from its library is an EXPORT_INCOMPLETE error
 * naming the missing items, never a silently degraded package. The motionPack
 * section (present iff the states reference custom animations) always carries
 * the mounts, unlike the pure Motion Pack export which never does.
 */
export function buildPetPackageExport(
  pet: PetPreset,
  library: { assets: Record<string, AssetMeta>; animations: AnimationDefinition[] },
): PetPackageManifest {
  const assetIds = referencedAssetIds(pet)
  const missingAssets = assetIds.filter((id) => library.assets[id] === undefined)
  if (missingAssets.length > 0) {
    throw new PetPackageError('EXPORT_INCOMPLETE', 'pet references assets missing from the library', missingAssets)
  }
  const assets: PetPackageAssetEntry[] = assetIds.map((id) => {
    const meta = library.assets[id] as AssetMeta
    return {
      id,
      sha256: meta.sha256,
      file: assetEntryPath(id, meta.mimeType),
      mimeType: meta.mimeType,
      width: meta.width,
      height: meta.height,
    }
  })

  const animationIds = referencedCustomAnimationIds(pet)
  let motionPack: MotionPackManifest | undefined
  if (animationIds.length > 0) {
    const byId = new Map(library.animations.map((definition) => [definition.id, definition]))
    const missing = animationIds.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      throw new PetPackageError('EXPORT_INCOMPLETE', 'pet references animations missing from the library', missing)
    }
    motionPack = {
      // §12: namespace stays 'mixed' (per-definition namespaces preserved).
      ...buildMotionPackExport(`${pet.name} 动画`, animationIds.map((id) => byId.get(id) as AnimationDefinition)),
      namespace: MIXED_NAMESPACE,
      mounts: mountsFromPetStates(pet),
    }
  }

  return {
    format: 'pet-package',
    version: 1,
    name: pet.name,
    pet: { scale: pet.scale, poses: structuredClone(pet.poses), states: structuredClone(pet.states) },
    assets,
    ...(motionPack === undefined ? {} : { motionPack }),
    ...(pet.attribution === undefined ? {} : { attribution: pet.attribution }),
  }
}

/**
 * Rewrite a validated slice's custom animation references to the import
 * plan's FINAL ids (a remapped `-2` id must not dangle), then apply the
 * resolved mounts — after collision planning these are authoritative for
 * their slots (§12: mounts are rewritten into the new pet's states).
 */
export function rewritePetSliceAnimations(
  slice: PetSlice,
  finalIds: ReadonlyMap<string, string>,
  mounts: PackMounts,
): PetSlice {
  const states = {} as Record<PoseKey, StateAppearance>
  for (const key of POSE_KEYS) {
    const state = slice.states[key]
    const enterId = state.enter.animationId
    const ambientId = state.ambient.customAnimationId
    const enterFinal =
      enterId === undefined || enterId.startsWith('builtin:') ? enterId : (finalIds.get(enterId) ?? enterId)
    const ambientFinal = ambientId === undefined ? undefined : (finalIds.get(ambientId) ?? ambientId)
    states[key] = {
      ...state,
      ...(enterFinal === undefined ? {} : { enter: { ...state.enter, animationId: enterFinal } }),
      ...(ambientFinal === undefined ? {} : { ambient: { ...state.ambient, customAnimationId: ambientFinal } }),
    }
  }
  for (const [slot, mount] of Object.entries(mounts)) {
    const state = states[slot as PoseKey]
    if (state === undefined) continue
    if (mount.enter !== undefined) state.enter = { ...state.enter, animationId: mount.enter }
    if (mount.ambient !== undefined) state.ambient = { ...state.ambient, customAnimationId: mount.ambient }
  }
  return { scale: slice.scale, poses: slice.poses, states }
}

/** The requestedId → finalId view of a pack import plan. */
export function finalIdMapOf(entries: readonly PackImportEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.requestedId, entry.finalId]))
}
