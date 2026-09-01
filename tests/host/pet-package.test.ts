/**
 * host/pet-package.ts unit tests (motion-format §12): manifest validation
 * (field groups, B1 version seam), zip structural guards (whitelist, bomb
 * caps), asset content cross-checks (sha256, sniffing), export completeness
 * and the slice rewriting that carries collision-planned final ids.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import type { AssetMeta, PetSlice } from '../../src/core/types'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import {
  PetPackageError,
  buildPetPackageExport,
  buildPetPackageZip,
  finalIdMapOf,
  injectAnimationIdRemap,
  mountsFromPetStates,
  rewritePetSliceAnimations,
  validatePetPackage,
} from '../../src/host/pet-package'
import { mergePetAttribution, normalizePetSlice, validatePetAttribution, validatePluginConfigs, type PetPluginConfigs, type PetPreset } from '../../src/host/pets'
import { makePng, makeSvg } from './fixtures'

/** Content-addressed PNG asset: id = sha256 prefix, exactly like the library. */
function pngAsset(width = 2, height = 3): { data: Buffer; id: string; sha256: string } {
  const data = makePng(width, height)
  const sha256 = createHash('sha256').update(data).digest('hex')
  return { data, id: sha256.slice(0, 16), sha256 }
}

function transitionAnimation(id: string, durationMs = 240): AnimationDefinition {
  return {
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'transition',
    durationMs,
    repeat: { mode: 'once' },
    tracks: [
      { property: 'transition.scaleX', keyframes: [{ at: 0, value: 1 }, { at: 1, value: 1 }] },
    ],
    events: [{ at: 0.5, type: 'pose-swap' }],
  }
}

function ambientAnimation(id: string): AnimationDefinition {
  return {
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'ambient',
    durationMs: 900,
    repeat: { mode: 'loop' },
    tracks: [{ property: 'sway.rotation', keyframes: [{ at: 0, value: -2 }, { at: 1, value: 2 }] }],
  }
}

/** fflate's zipSync `level` is a 0..9 literal union, not a plain number. */
type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Zip a manifest (plus optional extra files) into a package body. */
function packageZip(
  manifest: unknown,
  extraFiles: Record<string, Buffer> = {},
  options: { level?: ZipLevel } = {},
): Buffer {
  return Buffer.from(
    zipSync(
      {
        'manifest.json': strToU8(JSON.stringify(manifest)),
        ...Object.fromEntries(Object.entries(extraFiles).map(([name, data]) => [name, new Uint8Array(data)])),
      },
      { level: options.level },
    ),
  )
}

/** A minimal well-formed package: one PNG pose on idle, no animations. */
function makePackage(
  overrides: Record<string, unknown> = {},
  extraFiles: Record<string, Buffer> = {},
  options: { level?: ZipLevel } = {},
): Buffer {
  const asset = pngAsset()
  const manifest = {
    format: 'pet-package',
    version: 1,
    name: 'Kitty',
    pet: { scale: 1.2, poses: { idle: { assetId: asset.id } }, states: {} },
    assets: [
      { id: asset.id, sha256: asset.sha256, file: `assets/${asset.id}.png`, mimeType: 'image/png', width: 2, height: 3 },
    ],
    ...overrides,
  }
  return packageZip(manifest, { [`assets/${asset.id}.png`]: asset.data, ...extraFiles }, options)
}

/** Run validation expecting a PetPackageError; rethrows anything else. */
async function expectInvalid(body: Buffer): Promise<PetPackageError> {
  try {
    await validatePetPackage(body)
  } catch (error) {
    if (error instanceof PetPackageError) return error
    throw error
  }
  throw new Error('expected validatePetPackage to reject this package')
}

describe('validatePetPackage: manifest fields', () => {
  it('accepts a well-formed package and resolves a complete slice', async () => {
    const asset = pngAsset()
    const body = makePackage({
      attribution: { character: '溟月', creators: ['上善无形'], sourceUrl: 'https://example.com', license: 'CC BY-NC-SA 4.0' },
    })
    const plan = await validatePetPackage(body)
    expect(plan.name).toBe('Kitty')
    expect(plan.pet.scale).toBe(1.2)
    // The slice was normalized to a complete six-slot record, defaults filled.
    expect(Object.keys(plan.pet.poses).sort()).toEqual(['error', 'idle', 'success', 'thinking', 'waiting', 'working'])
    expect(plan.pet.poses.idle.assetId).toBe(asset.id)
    expect(plan.assets).toHaveLength(1)
    expect(plan.assets[0]?.id).toBe(asset.id)
    expect(plan.warnings).toEqual([])
    expect(plan.attribution).toEqual({ character: '溟月', creators: ['上善无形'], sourceUrl: 'https://example.com', license: 'CC BY-NC-SA 4.0' })
  })

  it('rejects structural and field-level manifest problems', async () => {
    for (const broken of [
      makePackage({ format: 'motion-pack' }),
      makePackage({ version: 0 }),
      makePackage({ version: 'one' }),
      makePackage({ name: '' }),
      makePackage({ name: 'x'.repeat(121) }),
      makePackage({ pet: 'nope' }),
      makePackage({ pet: { scale: 99, poses: {}, states: {} } }), // strict slice error
      makePackage({ pet: { scale: 1, poses: { idle: { assetId: 'xyz' } }, states: {} } }),
      makePackage({ assets: 'nope' }),
      makePackage({ assets: [{ id: 'not-hex', sha256: '0'.repeat(64), file: 'x', mimeType: 'image/png', width: 2, height: 3 }] }),
      makePackage({ assets: [{ id: '0'.repeat(16), sha256: 'short', file: `assets/${'0'.repeat(16)}.png`, mimeType: 'image/png', width: 2, height: 3 }] }),
      makePackage({ assets: [{ id: '0'.repeat(16), sha256: '0'.repeat(64), file: 'assets/elsewhere.png', mimeType: 'image/png', width: 2, height: 3 }] }),
      makePackage({ motionPack: { format: 'motion-pack', version: 1, name: 'x', namespace: 'manga', animations: [] } }),
      makePackage({ attribution: { creators: 'nope' } }),
      makePackage({ attribution: { sourceUrl: 'x'.repeat(501) } }),
    ]) {
      const error = await expectInvalid(broken)
      expect(error.code, JSON.stringify(broken).slice(0, 120)).toBe('PET_PACKAGE_INVALID')
      expect(error.details, JSON.stringify(broken).slice(0, 120)).toBeDefined()
    }
  })

  it('prefixes slice errors with pet. and reports the offending field paths', async () => {
    const error = await expectInvalid(makePackage({ pet: { scale: 99, poses: {}, states: {} } }))
    expect(error.details).toContain('pet.global.scale: expected 0.3..4')
  })

  it('rejects duplicate manifest asset ids', async () => {
    const asset = pngAsset()
    const entry = { id: asset.id, sha256: asset.sha256, file: `assets/${asset.id}.png`, mimeType: 'image/png', width: 2, height: 3 }
    const error = await expectInvalid(makePackage({ assets: [entry, entry] }))
    expect(error.details?.join(' ')).toContain('duplicate id')
  })

  it('rejects a newer format version with the explicit upgrade hint (B1 seam)', async () => {
    const error = await expectInvalid(makePackage({ version: 2 }))
    expect(error.code).toBe('PACK_VERSION_NEWER')
    expect(error.message).toContain('newer petween')
  })

  it('rejects an unusable manifest.json (missing, bad JSON, non-object)', async () => {
    const noManifest = Buffer.from(zipSync({ 'assets/0000000000000000.png': new Uint8Array(makePng()) }))
    expect((await expectInvalid(noManifest)).message).toContain('missing manifest.json')
    const badJson = Buffer.from(zipSync({ 'manifest.json': strToU8('{ nope') }))
    expect((await expectInvalid(badJson)).message).toContain('not valid JSON')
    const notAnObject = packageZip('just a string')
    expect((await expectInvalid(notAnObject)).message).toContain('JSON object')
  })
})

describe('validatePetPackage: zip structure', () => {
  it('rejects a non-zip body', async () => {
    const error = await expectInvalid(Buffer.from('definitely not a zip'))
    expect(error.code).toBe('PET_PACKAGE_INVALID')
    expect(error.message).toContain('not a valid zip')
  })

  it('rejects entries outside the whitelist (zip-slip, absolute, backslash, stray)', async () => {
    for (const evil of ['../evil.png', '/etc/passwd', 'assets\\0000000000000000.png', 'readme.txt', 'assets/short.png']) {
      const error = await expectInvalid(makePackage({}, { [evil]: makePng() }))
      expect(error.code, evil).toBe('PET_PACKAGE_INVALID')
      expect(error.details, evil).toContain(evil)
    }
  })

  it('tolerates plain directory markers', async () => {
    const plan = await validatePetPackage(makePackage({}, { 'assets/': Buffer.alloc(0) }))
    expect(plan.name).toBe('Kitty')
  })

  it('enforces the 64-entry limit', async () => {
    const files: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify({ format: 'pet-package', version: 1, name: 'x', pet: {}, assets: [] })) }
    for (let index = 0; index < 64; index += 1) {
      files[`assets/${index.toString(16).padStart(16, '0')}.png`] = new Uint8Array(makePng())
    }
    const error = await expectInvalid(Buffer.from(zipSync(files)))
    expect(error.message).toContain('64-entry limit')
  })

  it('enforces the 12MB single-file cap', async () => {
    // level 0 (stored): the cap polices UNCOMPRESSED bytes, and deflating a
    // 12MB bomb would itself cost seconds of test time.
    const bomb = Buffer.alloc(12 * 1024 * 1024 + 1) // zeros: would compress tiny
    const error = await expectInvalid(makePackage({}, { 'assets/0000000000000000.png': bomb }, { level: 0 }))
    expect(error.message).toContain('single-file limit')
  })

  it('enforces the 60MB decompressed total', async () => {
    // level 0 (stored): same reason as above — the total is checked against
    // uncompressed sizes, so building the 66MB bomb must stay near-instant.
    const files: Record<string, Buffer> = {}
    for (let index = 0; index < 6; index += 1) {
      files[`assets/${index.toString(16).padStart(16, '0')}.png`] = Buffer.alloc(11 * 1024 * 1024) // 66MB total
    }
    const error = await expectInvalid(makePackage({}, files, { level: 0 }))
    expect(error.message).toContain('decompressed total')
  })
})

describe('validatePetPackage: asset cross-checks', () => {
  it('rejects a referenced asset missing from the manifest or the zip', async () => {
    // Referenced by the slice but not listed in assets[].
    const notListed = await expectInvalid(
      makePackage({ pet: { scale: 1, poses: { idle: { assetId: '0123456789abcdef' } }, states: {} }, assets: [] }),
    )
    expect(notListed.message).toContain('missing from the manifest')
    expect(notListed.details).toContain('0123456789abcdef')

    // Listed in assets[] but the zip does not carry the declared file.
    const listedNotShipped = await expectInvalid(
      makePackage({
        pet: { scale: 1, poses: { idle: { assetId: '0123456789abcdef' } }, states: {} },
        assets: [
          { id: '0123456789abcdef', sha256: '0'.repeat(64), file: 'assets/0123456789abcdef.png', mimeType: 'image/png', width: 2, height: 3 },
        ],
      }),
    )
    expect(listedNotShipped.message).toContain('missing from the package')
    expect(listedNotShipped.details).toContain('0123456789abcdef')
  })

  it('rejects sha256 mismatches and non-content-derived ids', async () => {
    const asset = pngAsset()
    const wrongSha = await expectInvalid(
      makePackage({
        assets: [{ id: asset.id, sha256: '0'.repeat(64), file: `assets/${asset.id}.png`, mimeType: 'image/png', width: 2, height: 3 }],
      }),
    )
    expect(wrongSha.details?.join(' ')).toContain('sha256 mismatch')

    const wrongId = await expectInvalid(
      makePackage({
        pet: { scale: 1, poses: { idle: { assetId: '0123456789abcdef' } }, states: {} },
        assets: [{ id: '0123456789abcdef', sha256: asset.sha256, file: 'assets/0123456789abcdef.png', mimeType: 'image/png', width: 2, height: 3 }],
      }, { 'assets/0123456789abcdef.png': asset.data }),
    )
    expect(wrongId.details?.join(' ')).toContain('first 16 hex chars')
  })

  it('runs the asset-side image checks: sniffed MIME, dimension cap, SVG, dimension agreement', async () => {
    const png = pngAsset()
    const declared = (mimeType: string, file: string) =>
      makePackage(
        {
          pet: { scale: 1, poses: { idle: { assetId: png.id } }, states: {} },
          assets: [{ id: png.id, sha256: png.sha256, file, mimeType, width: 2, height: 3 }],
        },
        { [file]: png.data },
      )
    // PNG bytes under a consistent .webp name still sniff as PNG.
    const mime = await expectInvalid(declared('image/webp', `assets/${png.id}.webp`))
    expect(mime.details?.join(' ')).toContain('manifest declares image/webp but the content is image/png')

    const big = pngAsset(5000, 10)
    const oversized = await expectInvalid(
      makePackage(
        {
          pet: { scale: 1, poses: { idle: { assetId: big.id } }, states: {} },
          assets: [{ id: big.id, sha256: big.sha256, file: `assets/${big.id}.png`, mimeType: 'image/png', width: 5000, height: 10 }],
        },
        { [`assets/${big.id}.png`]: big.data },
      ),
    )
    expect(oversized.details?.join(' ')).toContain('exceeds 4096x4096')

    const svgSha = createHash('sha256').update(makeSvg()).digest('hex')
    const svgId = svgSha.slice(0, 16)
    const svg = await expectInvalid(
      makePackage(
        {
          pet: { scale: 1, poses: { idle: { assetId: svgId } }, states: {} },
          assets: [{ id: svgId, sha256: svgSha, file: `assets/${svgId}.png`, mimeType: 'image/png', width: 10, height: 10 }],
        },
        { [`assets/${svgId}.png`]: makeSvg() },
      ),
    )
    expect(svg.details?.join(' ')).toContain('unsupported image content')

    const lying = pngAsset(4, 5)
    const wrongDims = await expectInvalid(
      makePackage(
        {
          pet: { scale: 1, poses: { idle: { assetId: lying.id } }, states: {} },
          assets: [{ id: lying.id, sha256: lying.sha256, file: `assets/${lying.id}.png`, mimeType: 'image/png', width: 4, height: 4 }],
        },
        { [`assets/${lying.id}.png`]: lying.data },
      ),
    )
    expect(wrongDims.details?.join(' ')).toContain('manifest says 4x4 but the content is 4x5')
  })

  it('warns about unreferenced manifest entries and ignores them', async () => {
    const asset = pngAsset()
    const extraSha = createHash('sha256').update(makePng(7, 8)).digest('hex')
    const extraId = extraSha.slice(0, 16)
    const plan = await validatePetPackage(
      makePackage({
        assets: [
          { id: asset.id, sha256: asset.sha256, file: `assets/${asset.id}.png`, mimeType: 'image/png', width: 2, height: 3 },
          { id: extraId, sha256: extraSha, file: `assets/${extraId}.png`, mimeType: 'image/png', width: 7, height: 8 },
        ],
      }),
    )
    expect(plan.assets.map((entry) => entry.id)).toEqual([asset.id])
    expect(plan.warnings).toEqual([`asset ${extraId} is not referenced by any pose, ignored`])
  })

  it('rejects custom animation references the motionPack does not carry', async () => {
    const error = await expectInvalid(
      makePackage({ pet: { scale: 1, poses: {}, states: { idle: { enter: { animationId: 'user:missing' } } } } }),
    )
    expect(error.details).toContain('user:missing')

    const noPack = await expectInvalid(
      makePackage({
        pet: { scale: 1, poses: {}, states: { idle: { ambient: { customAnimationId: 'user:float' } } } },
      }),
    )
    expect(noPack.details).toContain('user:float')
  })

  it('rejects wrong-kind slice mounts against the pack kind table (ambient on enter, transition on ambient)', async () => {
    const asset = pngAsset()
    const body = makePackage({
      pet: {
        scale: 1,
        poses: { idle: { assetId: asset.id } },
        states: {
          idle: { enter: { animationId: 'manga:float' } }, // ambient on an enter slot
          thinking: { ambient: { customAnimationId: 'manga:pop' } }, // transition on an ambient slot
        },
      },
      motionPack: {
        format: 'motion-pack',
        version: 1,
        name: 'Kitty 动画',
        namespace: 'manga',
        animations: [ambientAnimation('manga:float'), transitionAnimation('manga:pop')],
      },
    })
    const error = await expectInvalid(body)
    expect(error.code).toBe('PET_PACKAGE_INVALID')
    expect(error.details?.join(' ')).toContain('states.idle.enter.animationId: "manga:float" is ambient, needs transition')
    expect(error.details?.join(' ')).toContain('states.thinking.ambient.customAnimationId: "manga:pop" is transition, needs ambient')
  })

  it('accepts slice mounts whose kinds match (and builtin enter ids skip the table)', async () => {
    const asset = pngAsset()
    const body = makePackage({
      pet: {
        scale: 1,
        poses: { idle: { assetId: asset.id } },
        states: {
          idle: { enter: { animationId: 'manga:pop' } },
          thinking: { ambient: { customAnimationId: 'manga:float' }, enter: { animationId: 'builtin:jelly' } },
        },
      },
      motionPack: {
        format: 'motion-pack',
        version: 1,
        name: 'Kitty 动画',
        namespace: 'manga',
        animations: [transitionAnimation('manga:pop'), ambientAnimation('manga:float')],
      },
    })
    const plan = await validatePetPackage(body)
    expect(plan.pet.states.idle.enter.animationId).toBe('manga:pop')
    expect(plan.pet.states.thinking.ambient.customAnimationId).toBe('manga:float')
  })

  it('accepts a package with a motionPack and keeps builtin references out of the membership check', async () => {
    const asset = pngAsset()
    const body = makePackage(
      {
        pet: {
          scale: 1,
          poses: { idle: { assetId: asset.id } },
          states: { idle: { enter: { animationId: 'manga:pop' } }, thinking: { enter: { animationId: 'builtin:jelly' } } },
        },
        motionPack: {
          format: 'motion-pack',
          version: 1,
          name: 'Kitty 动画',
          namespace: 'manga',
          animations: [transitionAnimation('manga:pop')],
          mounts: { idle: { enter: 'manga:pop' } },
        },
      },
    )
    const plan = await validatePetPackage(body)
    expect(plan.motionPack?.animations.map((definition) => definition.id)).toEqual(['manga:pop'])
    expect(plan.motionPack?.mounts).toEqual({ idle: { enter: 'manga:pop' } })
  })
})

describe('buildPetPackageExport', () => {
  function petPreset(slice: PetSlice): PetPreset {
    return { id: 'pet_abc', name: 'Kitty', ...slice, createdAt: '', updatedAt: '' }
  }

  const assetMetaFor = (asset: { id: string; sha256: string }): AssetMeta => ({
    id: asset.id,
    fileName: `${asset.id}.png`,
    mimeType: 'image/png',
    width: 2,
    height: 3,
    sizeBytes: 42,
    sha256: asset.sha256,
    url: `/petween-assets/${asset.id}`,
  })

  it('builds a complete manifest: deduped assets, mounts derived, attribution carried', () => {
    const idle = pngAsset()
    const thinking = pngAsset(4, 5)
    const slice = normalizePetSlice({})
    slice.scale = 1.3
    slice.poses.idle.assetId = idle.id
    slice.poses.thinking.assetId = thinking.id
    slice.poses.waiting.assetId = idle.id // same asset on two slots: deduped
    slice.states.idle.enter.animationId = 'manga:pop'
    slice.states.thinking.ambient.customAnimationId = 'manga:float'
    const pet = petPreset(slice)
    pet.attribution = { character: '溟月' }

    const manifest = buildPetPackageExport(pet, {
      assets: { [idle.id]: assetMetaFor(idle), [thinking.id]: assetMetaFor(thinking) },
      animations: [transitionAnimation('manga:pop'), ambientAnimation('manga:float')],
    })

    expect(manifest.format).toBe('pet-package')
    expect(manifest.version).toBe(1)
    expect(manifest.name).toBe('Kitty')
    expect(manifest.pet.scale).toBe(1.3)
    expect(manifest.assets.map((entry) => entry.id)).toEqual([idle.id, thinking.id])
    expect(manifest.assets[0]).toMatchObject({ sha256: idle.sha256, file: `assets/${idle.id}.png`, mimeType: 'image/png', width: 2, height: 3 })
    expect(manifest.motionPack).toMatchObject({
      format: 'motion-pack',
      version: 1,
      namespace: 'mixed',
      animations: [transitionAnimation('manga:pop'), ambientAnimation('manga:float')],
      mounts: { idle: { enter: 'manga:pop' }, thinking: { ambient: 'manga:float' } },
    })
    expect(manifest.attribution).toEqual({ character: '溟月' })
  })

  it('omits the motionPack entirely when no custom animations are referenced', () => {
    const asset = pngAsset()
    const slice = normalizePetSlice({})
    slice.poses.idle.assetId = asset.id
    slice.states.idle.enter.animationId = 'builtin:jelly' // builtin: never enters a pack
    const manifest = buildPetPackageExport(petPreset(slice), {
      assets: { [asset.id]: assetMetaFor(asset) },
      animations: [],
    })
    expect(manifest.motionPack).toBeUndefined()
    expect(manifest.assets).toHaveLength(1)
  })

  it('carries pluginConfigs from the record; the zipped export revalidates field-equal', async () => {
    const asset = pngAsset()
    const slice = normalizePetSlice({})
    slice.poses.idle.assetId = asset.id
    const pet = petPreset(slice)
    pet.pluginConfigs = {
      'petween-physics': { config: { gravity: 2400, slideAnimationId: 'user:pop' }, animationIdRemap: { 'user:pop': 'user:pop-2' } },
    }
    const manifest = buildPetPackageExport(pet, { assets: { [asset.id]: assetMetaFor(asset) }, animations: [] })
    expect(manifest.pluginConfigs).toEqual(pet.pluginConfigs)
    const plan = await validatePetPackage(Buffer.from(buildPetPackageZip(manifest, { [asset.id]: asset.data })))
    expect(plan.pluginConfigs).toEqual(pet.pluginConfigs)
  })

  it('omits pluginConfigs when the record has none', () => {
    const asset = pngAsset()
    const slice = normalizePetSlice({})
    slice.poses.idle.assetId = asset.id
    const manifest = buildPetPackageExport(petPreset(slice), { assets: { [asset.id]: assetMetaFor(asset) }, animations: [] })
    expect(manifest.pluginConfigs).toBeUndefined()
  })

  it('throws EXPORT_INCOMPLETE naming the missing assets or animations', () => {
    const slice = normalizePetSlice({})
    const asset = pngAsset()
    slice.poses.idle.assetId = '0123456789abcdef'
    expect(() => buildPetPackageExport(petPreset(slice), { assets: {}, animations: [] })).toThrow(PetPackageError)
    try {
      buildPetPackageExport(petPreset(slice), { assets: {}, animations: [] })
    } catch (error) {
      expect((error as PetPackageError).code).toBe('EXPORT_INCOMPLETE')
      expect((error as PetPackageError).details).toEqual(['0123456789abcdef'])
    }

    slice.poses.idle.assetId = asset.id
    slice.states.idle.enter.animationId = 'user:gone'
    try {
      buildPetPackageExport(petPreset(slice), { assets: { [asset.id]: assetMetaFor(asset) }, animations: [] })
      expect.unreachable('export must not succeed')
    } catch (error) {
      expect((error as PetPackageError).code).toBe('EXPORT_INCOMPLETE')
      expect((error as PetPackageError).details).toEqual(['user:gone'])
    }
  })

  it('an export zipped here validates as an import (unit-level round trip)', async () => {
    const asset = pngAsset()
    const slice = normalizePetSlice({})
    slice.scale = 0.9
    slice.poses.idle.assetId = asset.id
    slice.states.idle.enter.animationId = 'user:pop'
    const pet = petPreset(slice)
    pet.attribution = { creators: ['someone'] }

    const manifest = buildPetPackageExport(pet, {
      assets: { [asset.id]: assetMetaFor(asset) },
      animations: [transitionAnimation('user:pop')],
    })
    const plan = await validatePetPackage(Buffer.from(buildPetPackageZip(manifest, { [asset.id]: asset.data })))
    expect(plan.name).toBe('Kitty')
    expect(plan.pet.scale).toBe(0.9)
    expect(plan.pet.poses.idle.assetId).toBe(asset.id)
    expect(plan.motionPack?.mounts).toEqual({ idle: { enter: 'user:pop' } })
    expect(plan.attribution).toEqual({ creators: ['someone'] })
    expect(plan.warnings).toEqual([])
    // The zip entry layout matches the manifest's declared files.
    const names = Object.keys(unzipSync(buildPetPackageZip(manifest, { [asset.id]: asset.data })))
    expect(names.sort()).toEqual(['assets/' + asset.id + '.png', 'manifest.json'])
  })
})

describe('slice rewriting (collision-planned final ids)', () => {
  it('rewrites custom enter/ambient refs, keeps builtin ones, and lets resolved mounts win', () => {
    const slice = normalizePetSlice({})
    slice.states.idle.enter.animationId = 'manga:pop'
    slice.states.idle.ambient.customAnimationId = 'manga:float'
    slice.states.thinking.enter.animationId = 'builtin:jelly'
    const finalIds = finalIdMapOf([
      { requestedId: 'manga:pop', finalId: 'manga:pop-2', status: 'remapped' },
      { requestedId: 'manga:float', finalId: 'manga:float', status: 'identical' },
    ])
    const mounts = { idle: { enter: 'manga:pop-2', ambient: 'manga:float' } }
    const rewritten = rewritePetSliceAnimations(slice, finalIds, mounts)
    expect(rewritten.states.idle.enter.animationId).toBe('manga:pop-2')
    expect(rewritten.states.idle.ambient.customAnimationId).toBe('manga:float')
    expect(rewritten.states.thinking.enter.animationId).toBe('builtin:jelly')
    // untouched fields survive the rewrite
    expect(rewritten.states.idle.enter.preset).toBe(slice.states.idle.enter.preset)
    expect(rewritten.poses).toBe(slice.poses) // poses pass through by reference
  })

  it('mountsFromPetStates collects custom refs per slot and skips builtin ids', () => {
    const slice = normalizePetSlice({})
    slice.states.idle.enter.animationId = 'builtin:comic-pop'
    slice.states.waiting.enter.animationId = 'user:pop'
    slice.states.waiting.ambient.customAnimationId = 'user:float'
    expect(mountsFromPetStates({ id: 'pet_x', name: 'x', ...slice, createdAt: '', updatedAt: '' })).toEqual({
      waiting: { enter: 'user:pop', ambient: 'user:float' },
    })
  })
})

describe('attribution validation (host/pets.ts)', () => {
  it('validatePetAttribution accepts a full shape and rejects bound/type violations', () => {
    expect(validatePetAttribution({ character: '溟月', creators: ['a', 'b'], sourceUrl: 'https://x', license: 'MIT' })).toEqual({
      ok: true,
      attribution: { character: '溟月', creators: ['a', 'b'], sourceUrl: 'https://x', license: 'MIT' },
    })
    expect(validatePetAttribution(undefined)).toEqual({ ok: true, attribution: {} })
    for (const broken of [
      { creators: Array.from({ length: 9 }, (_, index) => `c${index}`) },
      { creators: ['x'.repeat(121)] },
      { creators: [42] },
      { character: 7 },
      { character: 'x'.repeat(201) },
      { license: 'x'.repeat(201) },
    ]) {
      const result = validatePetAttribution(broken)
      expect(result.ok, JSON.stringify(broken)).toBe(false)
    }
  })

  it('mergePetAttribution: absent keeps, null clears, empty result resolves undefined', () => {
    const current = { character: 'A', creators: ['x'], sourceUrl: 'https://x' }
    const patched = mergePetAttribution(current, { creators: ['y'], character: null })
    expect(patched).toEqual({ ok: true, attribution: { creators: ['y'], sourceUrl: 'https://x' } })
    expect(mergePetAttribution(current, { character: null, creators: null, sourceUrl: null })).toEqual({ ok: true, attribution: undefined })
    expect(mergePetAttribution(undefined, { license: 'MIT' })).toEqual({ ok: true, attribution: { license: 'MIT' } })
    expect(mergePetAttribution(current, { creators: 'nope' }).ok).toBe(false)
  })
})

describe('pluginConfigs validation (§12 companion blobs)', () => {
  it('accepts well-formed blobs into the import plan; the config content is never inspected', async () => {
    const blob = {
      'petween-physics': {
        config: {
          // Zero interpretation: strings that LOOK like animation ids, odd
          // nesting and nulls all pass through untouched.
          gravity: 2400,
          slideAnimationId: 'user:pop',
          nested: { list: [1, 'two', null, { deep: true }] },
        },
        animationIdRemap: { 'user:pop': 'user:pop-2' },
      },
    }
    const plan = await validatePetPackage(makePackage({ pluginConfigs: blob }))
    expect(plan.pluginConfigs).toEqual(blob)
  })

  it('an absent or empty pluginConfigs stays absent in the plan (old packages behave as before)', async () => {
    expect((await validatePetPackage(makePackage({}))).pluginConfigs).toBeUndefined()
    expect((await validatePetPackage(makePackage({ pluginConfigs: {} }))).pluginConfigs).toBeUndefined()
  })

  it('rejects envelope violations field-wise', async () => {
    // Top level must be an object.
    let error = await expectInvalid(makePackage({ pluginConfigs: ['not-an-object'] }))
    expect(error.details?.join(' ')).toContain('pluginConfigs must be an object')
    // Plugin id charset `^[a-z0-9][a-z0-9-]*$`, ≤64 characters.
    error = await expectInvalid(
      makePackage({
        pluginConfigs: {
          UPPERCASE: { config: {} },
          '-leading-dash': { config: {} },
          under_score: { config: {} },
          ['x'.repeat(65)]: { config: {} },
        },
      }),
    )
    const details = error.details?.join('\n') ?? ''
    for (const bad of ['UPPERCASE', '-leading-dash', 'under_score', 'x'.repeat(65)]) {
      expect(details).toContain(`pluginConfigs.${bad}: plugin id must match`)
    }
    // Each entry must be an object carrying a `config`.
    error = await expectInvalid(makePackage({ pluginConfigs: { 'petween-physics': 'nope' } }))
    expect(error.details?.join(' ')).toContain('pluginConfigs.petween-physics: expected an object with a "config" field')
    error = await expectInvalid(makePackage({ pluginConfigs: { 'petween-physics': {} } }))
    expect(error.details?.join(' ')).toContain('pluginConfigs.petween-physics.config: required')
    // animationIdRemap must be a string→string map.
    error = await expectInvalid(
      makePackage({ pluginConfigs: { 'petween-physics': { config: {}, animationIdRemap: { 'user:a': 2 } } } }),
    )
    expect(error.details?.join(' ')).toContain('pluginConfigs.petween-physics.animationIdRemap must be a string→string map')
    error = await expectInvalid(
      makePackage({ pluginConfigs: { 'petween-physics': { config: {}, animationIdRemap: ['user:a'] } } }),
    )
    expect(error.details?.join(' ')).toContain('pluginConfigs.petween-physics.animationIdRemap must be a string→string map')
  })

  it('rejects the entry-count and byte caps', async () => {
    // More than 8 entries.
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`plugin-${index}`, { config: {} }]))
    let error = await expectInvalid(makePackage({ pluginConfigs: tooMany }))
    expect(error.details?.join(' ')).toContain('pluginConfigs exceeds 8 entries')
    // One config over the 16KiB serialized cap.
    error = await expectInvalid(
      makePackage({ pluginConfigs: { 'petween-physics': { config: { payload: 'x'.repeat(16 * 1024) } } } }),
    )
    expect(error.details?.join(' ')).toContain('pluginConfigs.petween-physics.config exceeds 16KiB serialized')
    // The whole block over 64KiB while every entry stays under the per-config cap.
    const fat = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`plugin-${index}`, { config: { payload: 'x'.repeat(9 * 1024) } }]))
    error = await expectInvalid(makePackage({ pluginConfigs: fat }))
    expect(error.details?.join(' ')).toContain('pluginConfigs exceeds 64KiB serialized')
  })

  it('validatePluginConfigs unit checks: JSON-value configs pass, non-serializable ones fail', () => {
    // `null` is a JSON value; the envelope only requires a PRESENT config.
    expect(validatePluginConfigs({ 'petween-physics': { config: null } })).toEqual({
      ok: true,
      pluginConfigs: { 'petween-physics': { config: null } },
    })
    expect(validatePluginConfigs({ 'petween-physics': { config: BigInt(1) } })).toEqual({
      ok: false,
      errors: ['pluginConfigs.petween-physics.config must be JSON-serializable'],
    })
    expect(validatePluginConfigs('nope')).toEqual({ ok: false, errors: ['pluginConfigs must be an object'] })
  })
})

describe('injectAnimationIdRemap (§12)', () => {
  it('injects the full requestedId→finalId table into every entry, replacing stale remaps, config untouched', () => {
    const configs: PetPluginConfigs = {
      'petween-physics': {
        config: { slideAnimationId: 'user:pop', gravity: 2400 },
        animationIdRemap: { 'user:stale': 'user:stale-9' },
      },
      'petween-other': { config: {} },
    }
    const finalIds = finalIdMapOf([
      { requestedId: 'user:pop', finalId: 'user:pop-2', status: 'remapped' },
      { requestedId: 'user:float', finalId: 'user:float', status: 'identical' },
    ])
    const injected = injectAnimationIdRemap(configs, finalIds)
    expect(injected['petween-physics']!.animationIdRemap).toEqual({ 'user:pop': 'user:pop-2', 'user:float': 'user:float' })
    expect(injected['petween-other']!.animationIdRemap).toEqual({ 'user:pop': 'user:pop-2', 'user:float': 'user:float' })
    // The blob itself is never rewritten — id fixup is the companion's job.
    expect(injected['petween-physics']!.config).toEqual({ slideAnimationId: 'user:pop', gravity: 2400 })
    // Non-mutating: the input entry keeps its stale remap.
    expect(configs['petween-physics']!.animationIdRemap).toEqual({ 'user:stale': 'user:stale-9' })
  })

  it('a package without animation entries leaves the blobs (and any stale remap) as-is', () => {
    const configs: PetPluginConfigs = { 'petween-physics': { config: {}, animationIdRemap: { 'user:a': 'user:b' } } }
    expect(injectAnimationIdRemap(configs, new Map())).toBe(configs)
  })
})
