/**
 * Host asset tests (spec §7.2, §20, §29.2): magic-byte sniffing for
 * PNG/WebP (VP8/VP8L/VP8X)/JPEG, SVG and forgery rejection, size and
 * dimension caps, content-addressed dedup, delete semantics, whitelist
 * path resolution.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetError, AssetStore, detectImage } from '../../src/host/assets'
import { makeJpeg, makePng, makeSvg, makeWebp, makeWebpExtended, makeWebpLossless } from './fixtures'

let dir: string
let store: AssetStore
let assetsDir: string
let manifestPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'motion-pet-assets-'))
  assetsDir = join(dir, 'assets')
  manifestPath = join(dir, 'assets.json')
  store = new AssetStore({ assetsDir, manifestPath })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function expectAssetError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).code).toBe(code)
  }
}

describe('detectImage', () => {
  it('parses PNG / WebP (VP8, VP8L, VP8X) / JPEG headers', () => {
    expect(detectImage(makePng(2, 3))).toMatchObject({ mimeType: 'image/png', ext: 'png', width: 2, height: 3 })
    expect(detectImage(makeWebp(4, 5))).toMatchObject({ mimeType: 'image/webp', width: 4, height: 5 })
    expect(detectImage(makeWebpLossless(6, 7))).toMatchObject({ mimeType: 'image/webp', width: 6, height: 7 })
    expect(detectImage(makeWebpExtended(8, 9))).toMatchObject({ mimeType: 'image/webp', width: 8, height: 9 })
    expect(detectImage(makeJpeg(10, 11))).toMatchObject({ mimeType: 'image/jpeg', ext: 'jpg', width: 10, height: 11 })
  })

  it('rejects SVG, garbage and truncated headers', () => {
    expect(detectImage(makeSvg())).toBeNull()
    expect(detectImage(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull()
    expect(detectImage(Buffer.alloc(64))).toBeNull()
  })
})

describe('AssetStore.save (§20)', () => {
  it('stores a valid PNG and returns full metadata', async () => {
    const png = makePng(2, 3)
    const meta = await store.save(png, 'image/png')
    expect(meta.id).toMatch(/^[0-9a-f]{16}$/)
    expect(meta).toMatchObject({
      fileName: `${meta.id}.png`,
      mimeType: 'image/png',
      width: 2,
      height: 3,
      sizeBytes: png.length,
      url: `/motion-pet-assets/${meta.id}`,
    })
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/)
    // Disk file uses the host-generated name and carries the exact bytes.
    expect(await readFile(join(assetsDir, meta.fileName))).toEqual(png)
    // Manifest persisted.
    expect(await store.list()).toEqual({ [meta.id]: meta })
  })

  it('accepts WebP and JPEG uploads', async () => {
    const webp = await store.save(makeWebp(4, 5), 'image/webp')
    expect(webp.fileName.endsWith('.webp')).toBe(true)
    const jpeg = await store.save(makeJpeg(10, 11), 'image/jpeg')
    expect(jpeg.fileName.endsWith('.jpg')).toBe(true)
  })

  it('dedups identical bytes to the same asset id', async () => {
    const first = await store.save(makePng(2, 3), 'image/png')
    const second = await store.save(makePng(2, 3), 'image/png')
    expect(second.id).toBe(first.id)
    expect(Object.keys(await store.list())).toHaveLength(1)
  })

  it('rejects SVG and unknown formats', async () => {
    await expectAssetError(store.save(makeSvg(), 'image/svg+xml'), 'UNSUPPORTED_TYPE')
    await expectAssetError(store.save(Buffer.from('plain text'), 'image/png'), 'UNSUPPORTED_TYPE')
  })

  it('rejects forged magic bytes (declared MIME ≠ content)', async () => {
    await expectAssetError(store.save(makePng(2, 3), 'image/webp'), 'MIME_MISMATCH')
    await expectAssetError(store.save(makeJpeg(4, 5), 'image/png'), 'MIME_MISMATCH')
  })

  it('rejects files over the single-file cap', async () => {
    await expectAssetError(store.save(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png'), 'PAYLOAD_TOO_LARGE')
  })

  it('rejects images over the dimension cap', async () => {
    await expectAssetError(store.save(makePng(4097, 10), 'image/png'), 'DIMENSIONS_TOO_LARGE')
    await expectAssetError(store.save(makePng(10, 5000), 'image/png'), 'DIMENSIONS_TOO_LARGE')
    // 4096 exactly is allowed.
    const ok = await store.save(makePng(4096, 1), 'image/png')
    expect(ok.width).toBe(4096)
  })

  it('rejects when the total asset size cap would be exceeded', async () => {
    const png = makePng(2, 3)
    const tight = new AssetStore({ assetsDir, manifestPath, maxTotalBytes: png.length })
    await tight.save(png, 'image/png')
    await expectAssetError(tight.save(makeJpeg(10, 11), 'image/jpeg'), 'TOTAL_SIZE_EXCEEDED')
    // Re-uploading the same bytes still dedups instead of counting twice.
    expect((await tight.save(png, 'image/png')).id).toBeDefined()
  })
})

describe('AssetStore.delete (§19.4)', () => {
  it('deletes an unreferenced asset from disk and manifest', async () => {
    const meta = await store.save(makePng(2, 3), 'image/png')
    await store.delete(meta.id, () => false)
    expect(await store.list()).toEqual({})
    expect(await readdir(assetsDir)).toEqual([])
  })

  it('refuses to delete a referenced asset (409 semantics)', async () => {
    const meta = await store.save(makePng(2, 3), 'image/png')
    await expectAssetError(store.delete(meta.id, (id) => id === meta.id), 'IN_USE')
    expect(await store.list()).toHaveProperty(meta.id)
  })

  it('reports unknown or malformed ids as NOT_FOUND', async () => {
    await expectAssetError(store.delete('0123456789abcdef', () => false), 'NOT_FOUND')
    await expectAssetError(store.delete('..', () => false), 'NOT_FOUND')
  })
})

describe('AssetStore.resolve (§19.5)', () => {
  it('resolves registered ids to the host-generated path', async () => {
    const meta = await store.save(makePng(2, 3), 'image/png')
    expect(await store.resolve(meta.id)).toEqual({
      path: join(assetsDir, meta.fileName),
      mimeType: 'image/png',
    })
  })

  it('never resolves traversal, slashes or unknown ids', async () => {
    await store.save(makePng(2, 3), 'image/png')
    for (const bad of ['..', '..%2f..', 'a/b', '../../config.json', '0123456789abcdef', 'zzz']) {
      expect(await store.resolve(bad)).toBeNull()
    }
  })
})
