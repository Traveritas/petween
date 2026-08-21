/**
 * client/api.ts — typed fetch wrapper for the M2 host HTTP API (spec §19).
 * Same-origin only; every failure is an {@link ApiError} carrying the host
 * error code (`INVALID_CONFIG`, `ASSET_IN_USE`, …) or `NETWORK`/`HTTP_*`.
 *
 * Endpoints (host/routes.ts):
 * - GET    /api/motion-pet/config         → { config, assets }
 * - PUT    /api/motion-pet/config         → { config } | 400 INVALID_CONFIG
 * - POST   /api/motion-pet/assets         → { asset }  | 413 / 415
 * - DELETE /api/motion-pet/assets/<id>    → { deleted } | 404 | 409 ASSET_IN_USE
 * - GET    /api/motion-pet/animations     → { customs, warnings } (V1.1)
 * - PUT    /api/motion-pet/animations/<id>    → { animation } | 400 INVALID_ANIMATION / ID_MISMATCH
 * - DELETE /api/motion-pet/animations/<id>    → { deleted } | 404 | 409 ANIMATION_IN_USE
 */
import type { AssetMeta, MotionPetConfig } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'

const CONFIG_URL = '/api/motion-pet/config'
const ASSETS_URL = '/api/motion-pet/assets'
const ANIMATIONS_URL = '/api/motion-pet/animations'

/** The standalone full-page settings editor (host/editor-page.ts). */
export const EDITOR_PAGE_URL = '/motion-pet-editor/'

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
  config: MotionPetConfig
  assets: Record<string, AssetMeta>
}

export interface PutConfigResponse {
  config: MotionPetConfig
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
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
export function putConfig(config: MotionPetConfig): Promise<PutConfigResponse> {
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
  global?: Partial<MotionPetConfig['global']>
  poses?: MotionPetConfig['poses']
  states?: MotionPetConfig['states']
  overlay?: Partial<MotionPetConfig['overlay']>
  advanced?: MotionPetConfig['advanced']
  interactions?: MotionPetConfig['interactions']
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
