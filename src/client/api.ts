/**
 * client/api.ts — typed fetch wrapper for the M2 host HTTP API (spec §19).
 * Same-origin only; every failure is an {@link ApiError} carrying the host
 * error code (`INVALID_CONFIG`, `ASSET_IN_USE`, …) or `NETWORK`/`TIMEOUT`/`HTTP_*`.
 *
 * Endpoints (host/routes.ts):
 * - GET    /api/petween/config         → { config, assets }
 * - PUT    /api/petween/config         → { config } | 400 INVALID_CONFIG
 * - POST   /api/petween/assets         → { asset }  | 413 / 415
 * - DELETE /api/petween/assets/<id>    → { deleted } | 404 | 409 ASSET_IN_USE
 * - GET    /api/petween/animations     → { customs, warnings } (V1.1)
 * - PUT    /api/petween/animations/<id>    → { animation } | 400 INVALID_ANIMATION / ID_MISMATCH
 * - DELETE /api/petween/animations/<id>    → { deleted } | 404 | 409 ANIMATION_IN_USE
 * - GET/POST /api/petween/pets and GET/PUT/DELETE/apply subpaths (V1.1 presets)
 * - GET    /api/petween/meta           → capability discovery (B2)
 * - POST   /api/petween/packs/import   → { entries, mounts, warnings } | 400 PACK_INVALID (P2)
 * - GET    /api/petween/packs/export?ids= → pack manifest (P2)
 */
import type { AssetMeta, PetweenConfig, PetPreset, PetSlice } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'

const CONFIG_URL = '/api/petween/config'
const ASSETS_URL = '/api/petween/assets'
const ANIMATIONS_URL = '/api/petween/animations'
const PETS_URL = '/api/petween/pets'
const META_URL = '/api/petween/meta'
const PACK_IMPORT_URL = '/api/petween/packs/import'
const PACK_EXPORT_URL = '/api/petween/packs/export'

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
  /** B3: the config revision at GET time (absent on pre-B3 hosts). */
  revision?: number
}

export interface PutConfigResponse {
  config: PetweenConfig
  /** B3: the revision AFTER this write (absent on pre-B3 hosts). */
  revision?: number
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
 * The timeout aborts the underlying fetch (no request left hanging) and turns
 * the hang into a TIMEOUT ApiError the existing retry paths already handle;
 * plain network failures stay NETWORK. Generous enough for a slow first
 * paint; SSE streams are NOT routed through request() and stay unaffected.
 */
const REQUEST_TIMEOUT_MS = 15_000

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // The raced timeout reject stays as a belt-and-braces prompt even where a
  // fetch implementation ignores the abort signal.
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let response: Response
  try {
    response = await Promise.race([
      fetch(url, { ...init, signal: init?.signal ?? controller.signal }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort()
          reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`))
        }, REQUEST_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    // A real fetch rejects with AbortError once the timeout aborts it; either
    // path leaves the controller aborted, which separates TIMEOUT from a
    // genuine NETWORK failure (editor-store maps the codes to Chinese copy).
    if (controller.signal.aborted) {
      throw new ApiError(0, 'TIMEOUT', `request timed out after ${REQUEST_TIMEOUT_MS}ms`)
    }
    throw new ApiError(0, 'NETWORK', error instanceof Error ? error.message : 'network error')
  } finally {
    clearTimeout(timeoutId)
  }
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as T
}

export function getConfig(): Promise<GetConfigResponse> {
  return request(CONFIG_URL)
}

/** B2: host capability discovery (apiVersion / configVersion / revision / features). */
export interface MetaResponse {
  apiVersion: number
  configVersion: number
  revision: number
  /** Additive-only list; probe with includes() instead of guessing endpoints. */
  features: string[]
}

export function getMeta(): Promise<MetaResponse> {
  return request(META_URL)
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
 * `options.expectedRevision` (B3) opts the caller into optimistic
 * concurrency: a stale expectation rejects with 409 REVISION_MISMATCH
 * (error.details.currentRevision carries the fresh value for a rebase).
 * Existing callers omit it and keep last-writer-wins.
 */
export function patchConfig(patch: ConfigPatch, options: { expectedRevision?: number } = {}): Promise<PutConfigResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.expectedRevision !== undefined) {
    headers['x-petween-expected-revision'] = String(options.expectedRevision)
  }
  return request(CONFIG_URL, { method: 'PUT', headers, body: JSON.stringify(patch) })
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

// --- Motion Pack (P2) -------------------------------------------------------

/** One animation's import outcome; remapped ids never overwrite silently. */
export interface PackImportEntry {
  requestedId: string
  finalId: string
  status: 'imported' | 'identical' | 'remapped'
}

export interface PackImportResponse {
  name: string
  namespace: string
  entries: PackImportEntry[]
  /** Mounts resolved to FINAL ids — applying them stays the caller's choice. */
  mounts: Record<string, { enter?: string; ambient?: string }>
  warnings: string[]
}

/** The export/import manifest (v1: single-file JSON, definitions inline). */
export interface MotionPack {
  format: 'motion-pack'
  version: 1
  name: string
  namespace: string
  animations: AnimationDefinition[]
}

/** Import a pack: body is the raw pack JSON text (the host validates it). */
export function importMotionPack(packJson: string): Promise<PackImportResponse> {
  return request(PACK_IMPORT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: packJson,
  })
}

/** Export the given animation ids as a pack manifest (mounts never included). */
export function exportMotionPack(ids: string[]): Promise<MotionPack> {
  const query = ids.map((id) => encodeURIComponent(id)).join(',')
  return request(`${PACK_EXPORT_URL}?ids=${query}`)
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

/**
 * A2 (2026-08-27): create a preset FROM the supplied slice — the editor's
 * current draft, unsaved edits included. Unlike current/blank the host never
 * touches the active config, so the response carries no `config`: the active
 * pet and its draft stay exactly as they were.
 */
export function createPetFromDraft(name: string, pet: PetSlice): Promise<{ pet: PetPreset }> {
  return request(PETS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, from: 'draft', pet }),
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
