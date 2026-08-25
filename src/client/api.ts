/**
 * client/api.ts — typed fetch wrapper for the M2 host HTTP API (spec §19).
 * Same-origin only; every failure is an {@link ApiError} carrying the host
 * error code (`INVALID_CONFIG`, `ASSET_IN_USE`, …) or `NETWORK`/`HTTP_*`.
 *
 * Endpoints (host/routes.ts):
 * - GET    /api/petween/config         → { config, assets }
 * - PUT    /api/petween/config         → { config } | 400 INVALID_CONFIG
 * - POST   /api/petween/assets         → { asset }  | 413 / 415
 * - DELETE /api/petween/assets/<id>    → { deleted } | 404 | 409 ASSET_IN_USE
 * - GET    /api/petween/animations     → { customs, warnings } (V1.1)
 * - PUT    /api/petween/animations/<id>    → { animation } | 400 INVALID_ANIMATION / ID_MISMATCH
 * - DELETE /api/petween/animations/<id>    → { deleted } | 404 | 409 ANIMATION_IN_USE
 * - GET/POST /api/petween/pets and PUT/DELETE/apply subpaths (V1.1 presets)
 */
import type { AssetMeta, PetweenConfig, PetPreset } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'

const CONFIG_URL = '/api/petween/config'
const ASSETS_URL = '/api/petween/assets'
const ANIMATIONS_URL = '/api/petween/animations'
const PETS_URL = '/api/petween/pets'

/** The standalone full-page settings editor (host/editor-page.ts). */
export const EDITOR_PAGE_URL = '/petween-editor/'

export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export interface GetConfigResponse {
  config: PetweenConfig
  assets: Record<string, AssetMeta>
}

export interface PutConfigResponse {
  config: PetweenConfig
}

/** The POST response carries only these fields (host/routes.ts §19.3). */
export interface UploadedAsset {
  id: string
  url: string
  width: number
  height: number
}

export interface UploadAssetResponse {
  asset: UploadedAsset
}

/** Host error bodies: `{ error: { code, message, details? } }`, or the §19.4 409 shape `{ error: 'ASSET_IN_USE' }`. */
interface ErrorBody {
  error?: string | { code?: string; message?: string; details?: unknown }
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`
  let message = response.statusText !== '' ? response.statusText : `request failed (${response.status})`
  let details: unknown
  try {
    const body = (await response.json()) as ErrorBody
    if (typeof body.error === 'string') {
      code = body.error
      message = body.error
    } else if (typeof body.error === 'object' && body.error !== null) {
      if (typeof body.error.code === 'string') code = body.error.code
      if (typeof body.error.message === 'string') message = body.error.message
      details = body.error.details
    }
  } catch {
    // non-JSON error body: keep the HTTP-derived code/message
  }
  return new ApiError(response.status, code, message, details)
}

/**
 * Per-request timeout. fetch has none by default: a request sent on a
 * connection that died with a host restart can hang for the browser's TCP
 * timeout (minutes), which wedged ConfigHub's memoized load() at
 * "正在加载" forever — a hung load neither rejects (retryable) nor resolves.
 * The timeout turns hangs into NETWORK errors the existing retry paths
 * already handle. Generous enough for a slow first paint; SSE streams are
 * NOT routed through request() and stay unaffected.
 */
const REQUEST_TIMEOUT_MS = 15_000

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await Promise.race([
      fetch(url, init),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS),
      ),
    ])
  } catch (error) {
    throw new ApiError(0, 'NETWORK', error instanceof Error ? error.message : 'network error')
  }
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as T
}

export function getConfig(): Promise<GetConfigResponse> {
  return request(CONFIG_URL)
}

/**
 * §19.2: the endpoint also accepts partial configs (missing fields are filled
 * from the current config server-side). Full-document writes go through this
 * helper; the settings editor and the overlay send partial patches instead
 * (see {@link ConfigPatch}) so concurrent writers cannot clobber each other.
 */
export function putConfig(config: PetweenConfig): Promise<PutConfigResponse> {
  return request(CONFIG_URL, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
}

/**
 * A partial config update (§19.2): the host merges the present fields onto the
 * current config. Ownership is split between the two writers — the settings
 * editor patches `enabled`/`global`/`poses`/`states`/`advanced`/`interactions`,
 * the overlay drag patches `overlay` — and neither sends the other's fields
 * (nor `version`), so a later save cannot roll back the other writer's section.
 */
export interface ConfigPatch {
  enabled?: boolean
  global?: Partial<PetweenConfig['global']>
  poses?: PetweenConfig['poses']
  states?: PetweenConfig['states']
  overlay?: Partial<PetweenConfig['overlay']>
  advanced?: PetweenConfig['advanced']
  interactions?: PetweenConfig['interactions']
}

/**
 * PATCH-style PUT: sends only the changed sections so a concurrent writer
 * (e.g. the settings editor) does not get its fields clobbered. The host
 * serializes the read-merge-write; the response carries the full new config.
 */
export function patchConfig(patch: ConfigPatch): Promise<PutConfigResponse> {
  return request(CONFIG_URL, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function uploadAsset(file: File): Promise<UploadAssetResponse> {
  const form = new FormData()
  form.append('file', file)
  return request(ASSETS_URL, { method: 'POST', body: form })
}

export function deleteAsset(id: string): Promise<{ deleted: string }> {
  return request(`${ASSETS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** V1.1 custom animations (plan §3): everything the host scanned, plus skip warnings. */
export interface GetAnimationsResponse {
  customs: AnimationDefinition[]
  warnings: string[]
}

export function getAnimations(): Promise<GetAnimationsResponse> {
  return request(ANIMATIONS_URL)
}

export interface PutAnimationResponse {
  animation: AnimationDefinition
}

/** Full-document write; the path id must equal definition.id (host: 400 ID_MISMATCH). */
export function putAnimation(definition: AnimationDefinition): Promise<PutAnimationResponse> {
  return request(`${ANIMATIONS_URL}/${encodeURIComponent(definition.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(definition),
  })
}

export function deleteAnimation(id: string): Promise<{ deleted: string }> {
  return request(`${ANIMATIONS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** V1.1 pet presets: stored character slices plus the active config pointer. */
export interface GetPetsResponse {
  pets: PetPreset[]
  activePetId: string | null
  warnings: string[]
}

export function getPets(): Promise<GetPetsResponse> {
  return request(PETS_URL)
}

export interface CreatePetResponse {
  pet: PetPreset
  config: PetweenConfig
}

export function createPet(input: { name: string; from: 'current' | 'blank' }): Promise<CreatePetResponse> {
  return request(PETS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function renamePet(id: string, name: string): Promise<{ pet: PetPreset }> {
  return request(`${PETS_URL}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function deletePet(id: string): Promise<{ deleted: string }> {
  return request(`${PETS_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function applyPet(id: string): Promise<{ config: PetweenConfig }> {
  return request(`${PETS_URL}/${encodeURIComponent(id)}/apply`, { method: 'POST' })
}
