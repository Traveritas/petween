/**
 * host/assets.ts — image asset store (spec §7.2, §20).
 *
 * Layout (§18.1): files live in `$DSH_HOME/petween/assets/<id>.<ext>`, the
 * manifest in `$DSH_HOME/petween/assets.json` (Record<assetId, AssetMeta>,
 * written atomically). Ids are the first 16 hex chars of the content sha256,
 * so identical bytes dedup naturally; disk file names are always host-
 * generated, never derived from the user's original filename.
 *
 * Format sniffing is hand-written magic-byte + header parsing (no deps):
 * PNG (IHDR), WebP (VP8 / VP8L / VP8X), JPEG (SOF0/1/2). Anything else —
 * SVG included — is rejected.
 */
import { createHash } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AssetMeta } from '../core/types'
import { createWriteLock, readJsonFile, writeJsonAtomic, type WriteLock } from './storage'
import { validateAssetId } from './validation'

export const MAX_ASSET_BYTES = 10 * 1024 * 1024 // spec §20
export const MAX_TOTAL_ASSET_BYTES = 60 * 1024 * 1024 // spec §20
export const MAX_ASSET_DIMENSION = 4096 // spec §20

export type AssetErrorCode =
  | 'PAYLOAD_TOO_LARGE'
  | 'TOTAL_SIZE_EXCEEDED'
  | 'DIMENSIONS_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'MIME_MISMATCH'
  | 'NOT_FOUND'
  | 'IN_USE'

/** Asset-store failure with a stable code; the routes layer maps it to HTTP. */
export class AssetError extends Error {
  override readonly name = 'AssetError'
  constructor(
    readonly code: AssetErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface DetectedImage {
  mimeType: AssetMeta['mimeType']
  ext: 'png' | 'webp' | 'jpg'
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function detectPng(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return null
  }
  // The first chunk must be a 13-byte IHDR; width/height are big-endian.
  if (buffer.readUInt32BE(8) !== 13) return null
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { mimeType: 'image/png', ext: 'png', width, height }
}

function detectWebp(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 20) return null
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null
  const fourcc = buffer.toString('latin1', 12, 16)
  if (fourcc === 'VP8 ') {
    // Lossy bitstream: 3-byte frame tag, 9d 01 2a start code, then 14-bit
    // little-endian width/height.
    if (buffer.length < 30) return null
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null
    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    if (width === 0 || height === 0) return null
    return { mimeType: 'image/webp', ext: 'webp', width, height }
  }
  if (fourcc === 'VP8L') {
    // Lossless bitstream: 0x2f signature, then 14-bit (width-1, height-1)
    // packed little-endian.
    if (buffer.length < 25) return null
    if (buffer[20] !== 0x2f) return null
    const bits = buffer.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { mimeType: 'image/webp', ext: 'webp', width, height }
  }
  if (fourcc === 'VP8X') {
    // Extended container: flags(1) + reserved(3), then 24-bit LE canvas
    // (width-1, height-1).
    if (buffer.length < 30) return null
    const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1
    const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1
    return { mimeType: 'image/webp', ext: 'webp', width, height }
  }
  return null
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2])

function detectJpeg(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let pos = 2
  while (pos + 1 < buffer.length) {
    if (buffer[pos] !== 0xff) return null
    // Skip fill bytes (0xff padding before the real marker).
    let marker = buffer[pos + 1]
    while (marker === 0xff && pos + 2 < buffer.length) {
      pos += 1
      marker = buffer[pos + 1]
    }
    pos += 2
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9) return null // EOI before any SOF
    if (pos + 2 > buffer.length) return null
    const length = buffer.readUInt16BE(pos)
    if (length < 2 || pos + length > buffer.length) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null
      const height = buffer.readUInt16BE(pos + 3)
      const width = buffer.readUInt16BE(pos + 5)
      if (width === 0 || height === 0) return null
      return { mimeType: 'image/jpeg', ext: 'jpg', width, height }
    }
    pos += length
  }
  return null
}

/** Sniff the real image type and dimensions; null when unrecognized/corrupt. */
export function detectImage(buffer: Buffer): DetectedImage | null {
  return detectPng(buffer) ?? detectWebp(buffer) ?? detectJpeg(buffer)
}

export interface AssetStoreOptions {
  /** Directory holding the image files; created lazily on first save. */
  assetsDir: string
  /** Manifest JSON path (Record<assetId, AssetMeta>). */
  manifestPath: string
  maxFileBytes?: number
  maxTotalBytes?: number
  maxDimension?: number
  /** Shared cross-store write serializer (B10); default: a private chain. */
  lock?: WriteLock
}

export function defaultAssetsDir(): string {
  return dshHomePath('petween', 'assets')
}

export function defaultManifestPath(): string {
  return dshHomePath('petween', 'assets.json')
}

/**
 * Read-time url normalization: manifests written before the v1.2.0 rename
 * (motion-pet → Petween) carry the dead `/motion-pet-assets/<id>` prefix,
 * which 404s against the current static route. Normalizing on read
 * self-heals every entry, and because save()/delete() do their
 * read-modify-write through list(), the next manifest write persists the
 * fixed urls back to disk. There is deliberately no legacy alias route —
 * this normalization is the only repair path.
 */
function normalizeAssetUrls(manifest: Record<string, AssetMeta>): Record<string, AssetMeta> {
  for (const [id, meta] of Object.entries(manifest)) {
    if (typeof meta === 'object' && meta !== null && meta.url !== `/petween-assets/${id}`) {
      manifest[id] = { ...meta, url: `/petween-assets/${id}` }
    }
  }
  return manifest
}

export class AssetStore {
  readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly maxDimension: number
  /** Serializes manifest read-modify-write cycles in this process. */
  private readonly lock: WriteLock

  constructor(private readonly options: AssetStoreOptions) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_ASSET_BYTES
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_ASSET_BYTES
    this.maxDimension = options.maxDimension ?? MAX_ASSET_DIMENSION
    this.lock = options.lock ?? createWriteLock()
  }

  /** Current manifest; empty when the file is missing or corrupt. */
  async list(): Promise<Record<string, AssetMeta>> {
    const manifest = (await readJsonFile<Record<string, AssetMeta>>(this.options.manifestPath)) ?? {}
    return normalizeAssetUrls(manifest)
  }

  /**
   * Validate and store an image (spec §20): size cap → magic-byte sniff →
   * declared-MIME consistency → dimension cap → total-size cap. Returns the
   * existing meta when the content was already uploaded (dedup by sha256).
   */
  save(buffer: Buffer, declaredMime?: string): Promise<AssetMeta> {
    return this.enqueue(async () => {
      if (buffer.length === 0) throw new AssetError('UNSUPPORTED_TYPE', 'empty upload')
      if (buffer.length > this.maxFileBytes) {
        throw new AssetError('PAYLOAD_TOO_LARGE', `asset exceeds the ${this.maxFileBytes}-byte limit`)
      }
      const detected = detectImage(buffer)
      if (detected === null) {
        throw new AssetError('UNSUPPORTED_TYPE', 'only PNG, WebP and JPEG images are accepted')
      }
      if (
        declaredMime !== undefined &&
        declaredMime !== '' &&
        declaredMime !== 'application/octet-stream' &&
        declaredMime !== detected.mimeType
      ) {
        throw new AssetError('MIME_MISMATCH', `declared ${declaredMime} but the content is ${detected.mimeType}`)
      }
      if (detected.width > this.maxDimension || detected.height > this.maxDimension) {
        throw new AssetError('DIMENSIONS_TOO_LARGE', `image exceeds ${this.maxDimension}x${this.maxDimension}`)
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const id = sha256.slice(0, 16)
      const manifest = await this.list()
      const existing = manifest[id]
      if (existing !== undefined) return existing
      const totalBytes = Object.values(manifest).reduce((sum, meta) => sum + meta.sizeBytes, 0)
      if (totalBytes + buffer.length > this.maxTotalBytes) {
        throw new AssetError('TOTAL_SIZE_EXCEEDED', `assets exceed the ${this.maxTotalBytes}-byte total limit`)
      }
      const meta: AssetMeta = {
        id,
        fileName: `${id}.${detected.ext}`,
        mimeType: detected.mimeType,
        width: detected.width,
        height: detected.height,
        sizeBytes: buffer.length,
        sha256,
        url: `/petween-assets/${id}`,
      }
      await mkdir(this.options.assetsDir, { recursive: true })
      await writeFile(join(this.options.assetsDir, meta.fileName), buffer)
      manifest[id] = meta
      await writeJsonAtomic(this.options.manifestPath, manifest)
      return meta
    })
  }

  /**
   * Delete an asset. 409 semantics (IN_USE) when `referencedBy` reports the
   * id as still referenced; 404 semantics (NOT_FOUND) for unknown ids. The
   * reference probe is ASYNC and runs inside the serialized delete, so the
   * routes layer can load the freshest config/preset state at check time
   * (B10: no stale-snapshot TOCTOU when a referencing save is in flight).
   */
  delete(id: string, referencedBy: (assetId: string) => Promise<boolean>): Promise<void> {
    return this.enqueue(async () => {
      const manifest = await this.list()
      const meta = validateAssetId(id) !== null ? manifest[id] : undefined
      if (meta === undefined) throw new AssetError('NOT_FOUND', `unknown asset: ${id}`)
      if (await referencedBy(id)) throw new AssetError('IN_USE', `asset is still referenced: ${id}`)
      delete manifest[id]
      await writeJsonAtomic(this.options.manifestPath, manifest)
      await unlink(join(this.options.assetsDir, meta.fileName)).catch(() => {
        /* already gone from disk — the manifest is the source of truth */
      })
    })
  }

  /**
   * Whitelist resolution for the static route (spec §19.5): only manifest-
   * registered ids resolve, and the disk path is built from the host-generated
   * `fileName`, never from the request input. Anything malformed → null.
   */
  async resolve(id: string): Promise<{ path: string; mimeType: string } | null> {
    if (validateAssetId(id) === null) return null
    const meta = (await this.list())[id]
    if (meta === undefined) return null
    return { path: join(this.options.assetsDir, meta.fileName), mimeType: meta.mimeType }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    return this.lock(op)
  }
}
