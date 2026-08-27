/**
 * client/api.ts tests (spec §19): the typed fetch wrapper must hit the exact
 * host routes with the right methods/bodies, and map every failure — host
 * error JSON (both the `{error:{code,...}}` and the §19.4 `{error:'...'}`
 * shapes), non-JSON errors and network failures — onto ApiError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  applyPet,
  createPet,
  deleteAnimation,
  deleteAsset,
  deletePet,
  getAnimations,
  getConfig,
  getPets,
  patchConfig,
  putAnimation,
  putConfig,
  renamePet,
  uploadAsset,
} from '../../src/client/api'
import { createDefaultPetweenConfig } from '../../src/core/defaults'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

const makeDefinition = (id: string): AnimationDefinition => ({
  version: 1,
  id,
  name: 'Custom Pop',
  kind: 'transition',
  durationMs: 300,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: 1 },
        { at: 1, value: 1 },
      ],
    },
  ],
  events: [{ at: 0.5, type: 'pose-swap' }],
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const lastCall = (): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit?]
  return { url: call[0], init: call[1] ?? {} }
}

describe('client api — request timeout', () => {
  it('a hung fetch aborts the request and rejects as TIMEOUT instead of wedging load() forever', async () => {
    vi.useFakeTimers()
    // A request sent on a connection that died with a host restart never
    // settles: the browser has no default fetch timeout, and ConfigHub's
    // memoized load() would sit at "正在加载" for good (incident 2026-08-25).
    fetchMock.mockReturnValue(new Promise<Response>(() => {}))

    const pending = getConfig()
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'TIMEOUT',
      message: expect.stringContaining('timed out'),
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    vi.useRealTimers()
    // The timeout must also abort the underlying fetch, not just lose the race.
    const signal = (lastCall().init as RequestInit & { signal?: AbortSignal }).signal
    expect(signal?.aborted).toBe(true)
  })
})

describe('client api', () => {
  it('getConfig GETs /api/petween/config and returns { config, assets }', async () => {
    const config = createDefaultPetweenConfig()
    const payload = { config, assets: {} }
    fetchMock.mockResolvedValue(jsonResponse(200, payload))

    await expect(getConfig()).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/config')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('putConfig PUTs the draft as JSON and unwraps { config }', async () => {
    const config = createDefaultPetweenConfig()
    config.global.scale = 1.5
    fetchMock.mockResolvedValue(jsonResponse(200, { config }))

    const response = await putConfig(config)
    expect(response.config.global.scale).toBe(1.5)
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/config')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(JSON.parse(JSON.stringify(config)))
  })

  it('putConfig surfaces a 400 INVALID_CONFIG with field details', async () => {
    const details = [{ path: 'global.scale', message: 'expected 0.5..2' }]
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: 'INVALID_CONFIG', message: 'global.scale: expected 0.5..2', details } }),
    )

    const failure = await putConfig(createDefaultPetweenConfig()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    const apiError = failure as ApiError
    expect(apiError.status).toBe(400)
    expect(apiError.code).toBe('INVALID_CONFIG')
    expect(apiError.details).toEqual(details)
  })

  it('patchConfig PUTs a partial patch and unwraps the merged { config }', async () => {
    const merged = createDefaultPetweenConfig()
    merged.overlay = { x: 12, y: 34 }
    fetchMock.mockResolvedValue(jsonResponse(200, { config: merged }))

    const response = await patchConfig({ overlay: { x: 12, y: 34 } })
    expect(response.config.overlay).toEqual({ x: 12, y: 34 })
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/config')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    // only the patch travels — not a full config copy
    expect(JSON.parse(init.body as string)).toEqual({ overlay: { x: 12, y: 34 } })
  })

  it('uploadAsset POSTs multipart with the file under the "file" field', async () => {
    const asset = { id: '0123456789abcdef', url: '/petween-assets/0123456789abcdef', width: 240, height: 240 }
    fetchMock.mockResolvedValue(jsonResponse(200, { asset }))
    const file = new File(['png-bytes'], 'pet.png', { type: 'image/png' })

    await expect(uploadAsset(file)).resolves.toEqual({ asset })
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/assets')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect((form.get('file') as File).name).toBe('pet.png')
    // no explicit content-type: the browser must set the multipart boundary
    expect(init.headers).toBeUndefined()
  })

  it('uploadAsset maps a 415 rejection to the host error code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(415, { error: { code: 'UNSUPPORTED_TYPE', message: 'svg rejected' } }))

    const failure = await uploadAsset(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(415)
    expect((failure as ApiError).code).toBe('UNSUPPORTED_TYPE')
  })

  it('deleteAsset DELETEs the id subpath and resolves on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { deleted: '0123456789abcdef' }))

    await expect(deleteAsset('0123456789abcdef')).resolves.toEqual({ deleted: '0123456789abcdef' })
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/assets/0123456789abcdef')
    expect(init.method).toBe('DELETE')
  })

  it('deleteAsset maps the §19.4 409 { error: "ASSET_IN_USE" } shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'ASSET_IN_USE' }))

    const failure = await deleteAsset('0123456789abcdef').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(409)
    expect((failure as ApiError).code).toBe('ASSET_IN_USE')
  })

  it('deleteAsset maps 404 NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'unknown asset' } }))

    const failure = await deleteAsset('0123456789abcdef').catch((error: unknown) => error)
    expect((failure as ApiError).status).toBe(404)
    expect((failure as ApiError).code).toBe('NOT_FOUND')
  })

  it('network failures become ApiError with code NETWORK', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))

    const failure = await getConfig().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(0)
    expect((failure as ApiError).code).toBe('NETWORK')
    expect((failure as ApiError).message).toBe('connection refused')
  })
})

describe('client api — animations (V1.1)', () => {
  it('getAnimations GETs /api/petween/animations and returns { customs, warnings }', async () => {
    const payload = { customs: [makeDefinition('user:abc')], warnings: ['broken.json: skipped'] }
    fetchMock.mockResolvedValue(jsonResponse(200, payload))

    await expect(getAnimations()).resolves.toEqual(payload)
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/animations')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('putAnimation PUTs the definition to the id subpath and unwraps { animation }', async () => {
    const definition = makeDefinition('user:abc-123')
    fetchMock.mockResolvedValue(jsonResponse(200, { animation: definition }))

    const response = await putAnimation(definition)
    expect(response.animation.id).toBe('user:abc-123')
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/animations/user%3Aabc-123')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(JSON.parse(JSON.stringify(definition)))
  })

  it('putAnimation surfaces 400 INVALID_ANIMATION with schema details', async () => {
    const details = ['"kind" must be transition | ambient | interaction']
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: 'INVALID_ANIMATION', message: 'invalid AnimationDefinition', details } }),
    )

    const failure = await putAnimation(makeDefinition('user:abc')).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(400)
    expect((failure as ApiError).code).toBe('INVALID_ANIMATION')
    expect((failure as ApiError).details).toEqual(details)
  })

  it('putAnimation surfaces 400 ID_MISMATCH', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: 'ID_MISMATCH', message: 'path id "user:a" does not match body id "user:b"' } }),
    )

    const failure = await putAnimation(makeDefinition('user:b')).catch((error: unknown) => error)
    expect((failure as ApiError).status).toBe(400)
    expect((failure as ApiError).code).toBe('ID_MISMATCH')
  })

  it('deleteAnimation DELETEs the id subpath and resolves on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { deleted: 'user:abc' }))

    await expect(deleteAnimation('user:abc')).resolves.toEqual({ deleted: 'user:abc' })
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/animations/user%3Aabc')
    expect(init.method).toBe('DELETE')
  })

  it('deleteAnimation maps the 409 { error: "ANIMATION_IN_USE" } shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'ANIMATION_IN_USE' }))

    const failure = await deleteAnimation('user:abc').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(409)
    expect((failure as ApiError).code).toBe('ANIMATION_IN_USE')
  })

  it('deleteAnimation maps 404 NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'unknown animation' } }))

    const failure = await deleteAnimation('user:missing').catch((error: unknown) => error)
    expect((failure as ApiError).status).toBe(404)
    expect((failure as ApiError).code).toBe('NOT_FOUND')
  })
})

describe('client api — pet presets (V1.1)', () => {
  const makePet = () => {
    const config = createDefaultPetweenConfig()
    return {
      id: 'pet_abc-123',
      name: '蓝猫',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      scale: config.global.scale,
      poses: config.poses,
      states: config.states,
    }
  }

  it('getPets GETs the index and returns the active pointer and warnings', async () => {
    const payload = { pets: [makePet()], activePetId: 'pet_abc-123', warnings: ['bad file'] }
    fetchMock.mockResolvedValue(jsonResponse(200, payload))
    await expect(getPets()).resolves.toEqual(payload)
    expect(lastCall().url).toBe('/api/petween/pets')
    expect(lastCall().init.method ?? 'GET').toBe('GET')
  })

  it('createPet POSTs name/from and returns the pet plus applied config', async () => {
    const config = createDefaultPetweenConfig()
    config.activePetId = 'pet_abc-123'
    fetchMock.mockResolvedValue(jsonResponse(200, { pet: makePet(), config }))
    await expect(createPet({ name: '蓝猫', from: 'blank' })).resolves.toMatchObject({ config })
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/pets')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: '蓝猫', from: 'blank' })
  })

  it('renamePet PUTs the name to the encoded id subpath', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { pet: { ...makePet(), name: '新名字' } }))
    await renamePet('pet_abc-123', '新名字')
    const { url, init } = lastCall()
    expect(url).toBe('/api/petween/pets/pet_abc-123')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ name: '新名字' })
  })

  it('deletePet DELETEs the id and maps host error codes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: 'pet_abc-123' }))
    await expect(deletePet('pet_abc-123')).resolves.toEqual({ deleted: 'pet_abc-123' })
    expect(lastCall()).toMatchObject({ url: '/api/petween/pets/pet_abc-123', init: { method: 'DELETE' } })

    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'unknown pet' } }))
    const failure = await deletePet('pet_missing').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('NOT_FOUND')
  })

  it('applyPet POSTs the apply subpath and returns the host config', async () => {
    const config = createDefaultPetweenConfig()
    config.activePetId = 'pet_abc-123'
    fetchMock.mockResolvedValue(jsonResponse(200, { config }))
    await expect(applyPet('pet_abc-123')).resolves.toEqual({ config })
    expect(lastCall()).toMatchObject({
      url: '/api/petween/pets/pet_abc-123/apply',
      init: { method: 'POST' },
    })
  })
})
