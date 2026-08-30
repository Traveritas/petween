/**
 * host/routes.ts — HTTP API (spec §19) on the bare node http the DSH
 * webServer service exposes: method dispatch, body parsing, traversal guards
 * and error mapping are all hand-rolled (M0 finding §6).
 *
 * Registered routes:
 * - exact  `/api/petween/packs/import`  POST (P2 Motion Pack import)
 * - exact  `/api/petween/packs/export`  GET ?ids= (P2 Motion Pack export)
 * - exact  `/api/petween/meta`     GET (B2: apiVersion / configVersion /
 *                                  revision / additive-only features)
 * - exact  `/api/petween/config`   GET / PUT (PUT accepts the optional
 *                                  `x-petween-expected-revision` header, B3)
 * - prefix `/api/petween/assets`   POST (base path) / DELETE `<id>` subpath
 * - exact  `/api/petween/animations` GET (V1.1)
 * - prefix `/api/petween/animations` PUT / DELETE `<id>` subpath (V1.1)
 * - exact  `/api/petween/pets`     GET / POST (V1.1; POST accepts from:
 *                                  current | blank | draft — draft carries
 *                                  the slice itself and never touches the
 *                                  active pet, A2)
 * - prefix `/api/petween/pets`     GET / PUT / DELETE `<id>` subpath (PUT
 *                                  accepts `{name?, attribution?}` with
 *                                  partial attribution semantics), POST
 *                                  `<id>/apply` (V1.1), POST `import` +
 *                                  GET `<id>/export` (Pet Package zip, §12)
 * - prefix `/petween-assets`       GET / HEAD `<id>` subpath (static)
 *
 * The `/api` prefix belongs to the connection gateway, but exact routes win
 * over prefixes, so the exact config route is safe (M0 finding §8); the
 * assets prefix path is specific enough not to collide. The animations pair
 * shares one path across kinds (exact GET wins; PUT/DELETE fall to the
 * prefix), and neither collides with the assets prefix.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AssetMeta, PetweenConfig, PoseKey } from '../core/types'
import { POSE_KEYS } from '../core/types'
import { ANIMATION_KINDS, type AnimationDefinition, type AnimationKind } from '../motion/animation-definition'
import { AnimationError, validateAnimationId } from './animations'
import { AssetError } from './assets'
import { RevisionMismatchError } from './config'
import { PetError, petSliceFromConfig, validatePetId, type PetAttribution, type PetPreset } from './pets'
import {
  buildPetPackageExport,
  buildPetPackageZip,
  finalIdMapOf,
  PetPackageError,
  PET_PACKAGE_BODY_LIMIT,
  rewritePetSliceAnimations,
  validatePetPackage,
} from './pet-package'
import {
  buildMotionPackExport,
  validateMotionPack,
  type PackImportPlan,
  type PackImportEntry,
  type PackMounts,
  type ValidatedMotionPack,
} from './packs'
import { ConfigValidationError, validateAssetId, validateConfigPatch } from './validation'

const CONFIG_PATH = '/api/petween/config'
const ASSETS_PATH = '/api/petween/assets'
const ANIMATIONS_PATH = '/api/petween/animations'
const PETS_PATH = '/api/petween/pets'
const META_PATH = '/api/petween/meta'
const PACK_IMPORT_PATH = '/api/petween/packs/import'
const PACK_EXPORT_PATH = '/api/petween/packs/export'
const STATIC_PATH = '/petween-assets'

const JSON_BODY_LIMIT = 64 * 1024 // M0 §2: dsh-pet's readJsonBody precedent
/** A pack may carry up to 200 inline definitions (~3KB each) — JSON only. */
const PACK_BODY_LIMIT = 2 * 1024 * 1024
/** multipart framing (boundary lines, headers) on top of the file bytes. */
const MULTIPART_FORM_OVERHEAD = 256 * 1024

/**
 * B2 capability discovery. `apiVersion` bumps ONLY on a breaking change
 * (fields are added, never renamed or removed — same rule as the cordis
 * service); `configVersion` mirrors the persisted config's schema version;
 * `features` is an additive-only list a client can probe instead of guessing
 * endpoint by endpoint. Append at will; never reorder-with-rename or delete.
 */
const API_VERSION = 1
const API_FEATURES: readonly string[] = [
  'config', // GET/PUT /api/petween/config (§19.1/§19.2)
  'config.revision', // B3: revision in config responses + x-petween-expected-revision
  'assets', // POST/DELETE /api/petween/assets (§19.3/§19.4)
  'animations', // GET/PUT/DELETE /api/petween/animations (V1.1)
  'packs', // P2 Motion Pack: POST /packs/import + GET /packs/export
  'pets', // V1.1 pet presets incl. GET /pets/<id> (B10)
  'pets.draft', // A2: POST /pets from:'draft' forks a client slice
  'pets.packages', // §12 Pet Package: POST /pets/import + GET /pets/<id>/export
  'events.sse', // /api/petween/events state stream (M4)
  'meta', // this endpoint
]

/** Everything the routes need from config/asset persistence, injected for tests. */
export interface RoutesDeps {
  loadConfig(): Promise<PetweenConfig>
  /**
   * PUT path: strictly validate the patch against the current config and
   * atomically save it, resolving the merged config. Implementations must
   * serialize concurrent calls (ConfigStore.update) — a bare read-modify-write
   * loses fields when two writers overlap. `options.expectedRevision` (B3)
   * opts the caller into conflict detection: a stale expectation rejects
   * (RevisionMismatchError → 409 REVISION_MISMATCH) before anything is written.
   */
  updateConfig(patch: unknown, options?: { expectedRevision?: number }): Promise<PetweenConfig>
  /** B3: the current monotonic config revision (bumped once per update). */
  configRevision(): Promise<number>
  listAssets(): Promise<Record<string, AssetMeta>>
  /**
   * `created` reports whether THIS call wrote a new asset (content-hash dedup
   * returns the existing entry with created:false) — rollback paths must only
   * undo what they actually created.
   */
  saveAsset(buffer: Buffer, declaredMime: string | undefined): Promise<AssetMeta & { created: boolean }>
  /**
   * The reference probe is async and runs inside the store's serialized
   * delete: implementations load the FRESHEST config/preset state at check
   * time (B10 — no stale-snapshot TOCTOU while a referencing save is in flight).
   */
  deleteAsset(id: string, referencedBy: (assetId: string) => Promise<boolean>): Promise<void>
  resolveAssetPath(id: string): Promise<{ path: string; mimeType: string } | null>
  /** Single-file upload cap; the multipart body limit adds form overhead. */
  maxAssetBytes: number
  /**
   * Live directory scan: every stored custom animation, skip `warnings`, and
   * `normalized` = legacy shapes mechanically repaired and LOADED (the
   * caller's wording must not report those as skipped).
   */
  listAnimations(): Promise<{ customs: AnimationDefinition[]; warnings: string[]; normalized: string[] }>
  /**
   * The optional `guard` runs inside the store's serialized save, just before
   * the write, with the FRESHEST stored kind of the same id (undefined = not
   * stored): the kind-change 409 probe lives there so a concurrent referencing
   * save cannot slip between probe and write (B10, same contract as the async
   * reference probes on the delete paths).
   */
  saveAnimation(
    definition: AnimationDefinition,
    guard?: (existingKind: AnimationKind | undefined) => Promise<void>,
  ): Promise<void>
  /** Same async in-lock reference contract as deleteAsset. */
  deleteAnimation(id: string, referencedBy: (animationId: string) => Promise<boolean>): Promise<void>
  /**
   * P2 Motion Pack import: plan (collision remap against the freshest
   * library) and persist inside ONE serialized segment — the injected
   * implementation owns the store transaction; the route only validates the
   * manifest shape.
   */
  importPack(pack: ValidatedMotionPack): Promise<PackImportPlan>
  /** Pet presets (V1.1): live directory scan plus identity/slice mutations. */
  listPets(): Promise<{ pets: PetPreset[]; warnings: string[] }>
  /**
   * Create a preset; the optional attribution (pet-package import, §12) is
   * written into the SAME atomic record as the rest of the pet.
   */
  createPet(name: unknown, slice: unknown, attribution?: PetAttribution): Promise<PetPreset>
  readPet(id: string): Promise<PetPreset>
  /**
   * PUT /pets/&lt;id&gt; meta updates: rename and/or attribution with partial
   * semantics (`attribution: null` clears the whole block).
   */
  updatePetMeta(id: string, changes: { name?: unknown; attribution?: null | Record<string, unknown> }): Promise<PetPreset>
  deletePet(id: string): Promise<void>
}

/** Minimal slice of the host context the routes register against. */
export interface RoutesHost {
  webServer: {
    register(route: WebRoute): () => void
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  sendJson(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } })
}

/** Unified error → HTTP mapping; every handler throws, the wrapper answers. */
function mapError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (error instanceof HttpError) {
    sendError(res, error.status, error.code, error.message, error.details)
    return
  }
  if (error instanceof ConfigValidationError) {
    sendError(res, 400, 'INVALID_CONFIG', error.message, error.issues)
    return
  }
  if (error instanceof RevisionMismatchError) {
    // B3 optimistic concurrency: the caller's expected revision is stale.
    sendError(res, 409, 'REVISION_MISMATCH', error.message, { currentRevision: error.currentRevision })
    return
  }
  if (error instanceof AssetError) {
    switch (error.code) {
      case 'IN_USE':
        // spec §19.4: the 409 keeps the simple `{ error: 'ASSET_IN_USE' }` shape
        sendJson(res, 409, { error: 'ASSET_IN_USE' })
        return
      case 'NOT_FOUND':
        sendError(res, 404, 'NOT_FOUND', error.message)
        return
      case 'PAYLOAD_TOO_LARGE':
      case 'TOTAL_SIZE_EXCEEDED':
      case 'DIMENSIONS_TOO_LARGE':
        sendError(res, 413, error.code, error.message)
        return
      default:
        sendError(res, 415, error.code, error.message)
        return
    }
  }
  if (error instanceof AnimationError) {
    switch (error.code) {
      case 'IN_USE':
        // Mirror of the asset 409 shape (plan §3: same delete semantics)
        sendJson(res, 409, { error: 'ANIMATION_IN_USE' })
        return
      case 'NOT_FOUND':
        sendError(res, 404, 'NOT_FOUND', error.message)
        return
      default:
        sendError(res, 400, 'INVALID_ANIMATION', error.message, error.details)
        return
    }
  }
  if (error instanceof PetError) {
    switch (error.code) {
      case 'NOT_FOUND':
        sendError(res, 404, 'NOT_FOUND', error.message)
        return
      default:
        sendError(res, 400, 'INVALID_PRESET', error.message)
        return
    }
  }
  if (error instanceof PetPackageError) {
    // §12 import/export failures: manifest/zip problems and incomplete
    // exports are client errors; the newer-version seam is its own code so
    // clients can prompt for an upgrade instead of showing field noise.
    sendError(res, 400, error.code, error.message, error.details)
    return
  }
  sendError(res, 500, 'INTERNAL', 'internal error')
}

/** Read a request body with a hard size cap (drains on overflow). */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) {
      req.resume()
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`)
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parsePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

// --- multipart/form-data (hand-written, spec §19.3: only the `file` field) ---

interface MultipartPart {
  headers: Record<string, string>
  data: Buffer
}

function parseBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  return boundary !== undefined && boundary.length > 0 && boundary.length <= 200 ? boundary : null
}

/** Split a multipart body into parts; throws 400 on malformed framing. */
function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1')
  let cursor = body.indexOf(delimiter)
  if (cursor === -1) throw new HttpError(400, 'BAD_MULTIPART', 'multipart boundary not found')
  cursor += delimiter.length
  const parts: MultipartPart[] = []
  while (cursor < body.length) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break // closing `--`
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2
    const next = body.indexOf(delimiter, cursor)
    if (next === -1) throw new HttpError(400, 'BAD_MULTIPART', 'unterminated multipart part')
    let part = body.subarray(cursor, next)
    cursor = next + delimiter.length
    // Strip the CRLF that always precedes the next delimiter.
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2)
    }
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers: Record<string, string> = {}
    for (const line of part.subarray(0, headerEnd).toString('latin1').split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    parts.push({ headers, data: part.subarray(headerEnd + 4) })
  }
  return parts
}

function partFieldName(disposition: string | undefined): string | null {
  if (disposition === undefined) return null
  const match = /(?:^|;)\s*name="([^"]*)"/.exec(disposition)
  return match?.[1] ?? null
}

/** Extract the first `file` field; the user's filename is ignored entirely. */
function extractFilePart(body: Buffer, boundary: string): { data: Buffer; contentType: string | undefined } | null {
  for (const part of parseMultipart(body, boundary)) {
    if (partFieldName(part.headers['content-disposition']) === 'file') {
      return { data: part.data, contentType: part.headers['content-type'] }
    }
  }
  return null
}

// --- handlers --

/**
 * P2 Motion Pack import: POST /api/petween/packs/import with the pack JSON.
 * Manifest shape errors are 400 PACK_INVALID (field-level details); the
 * collision policy (identical skip / `-N` remap / import) runs inside the
 * store transaction and is reported per entry. Mounts are RESOLVED to final
 * ids and returned — applying them to config stays the caller's choice.
 */
async function handlePackImport(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected POST')
  const body = await readBody(req, PACK_BODY_LIMIT)
  let raw: unknown
  try {
    raw = JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
  }
  const validation = validateMotionPack(raw)
  if (!validation.ok) {
    throw new HttpError(400, 'PACK_INVALID', 'invalid Motion Pack', validation.errors)
  }
  const plan = await deps.importPack(validation.pack)
  const mounts = plan.mounts
  const mountedSlots = Object.keys(mounts)
  sendJson(res, 200, {
    name: validation.pack.name,
    namespace: validation.pack.namespace,
    entries: plan.entries,
    mounts,
    warnings: plan.warnings,
    // Minimal states patch with the mounts resolved to FINAL ids (§11 挂载
    // 应用): applying stays the caller's choice — the editor merges it into
    // its draft on confirmation; a raw API consumer can PUT it as-is.
    ...(mountedSlots.length > 0 ? { applyPatch: { states: mountsStatesPatch(mounts) } } : {}),
  })
}

/**
 * §11 挂载应用: the minimal per-slot states patch — only the mounted fields,
 * everything else falls back to the live config through patch semantics.
 */
function mountsStatesPatch(mounts: PackMounts): Record<string, Record<string, unknown>> {
  const states: Record<string, Record<string, unknown>> = {}
  for (const [slot, mount] of Object.entries(mounts)) {
    const state: Record<string, unknown> = {}
    if (mount.enter !== undefined) state.enter = { animationId: mount.enter }
    if (mount.ambient !== undefined) state.ambient = { customAnimationId: mount.ambient }
    states[slot] = state
  }
  return states
}

/**
 * P2 Motion Pack export: GET /api/petween/packs/export?ids=a,b,c → the pack
 * manifest (single-file JSON, animations inline). Unknown ids are a 400
 * listing them; exports never carry mounts (they are author intent, not the
 * user's live config state).
 */
async function handlePackExport(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET')
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams
  // Dedupe: a repeated id would otherwise emit the same definition twice,
  // and re-importing such a pack is rejected by the duplicate-id check.
  const ids = [
    ...new Set(
      (query.get('ids') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ]
  if (ids.length === 0) {
    throw new HttpError(400, 'PACK_EXPORT_EMPTY', 'expected a non-empty ?ids= list')
  }
  const { customs } = await deps.listAnimations()
  const byId = new Map(customs.map((definition) => [definition.id, definition]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new HttpError(400, 'PACK_EXPORT_UNKNOWN', 'unknown animation ids', missing)
  }
  const pack = buildMotionPackExport(
    'Motion Pack',
    ids.map((id) => byId.get(id) as AnimationDefinition),
  )
  sendJson(res, 200, pack)
}

/** B2: capability discovery — one GET instead of per-endpoint 404 probing. */
async function handleMeta(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET')
  const [config, revision] = await Promise.all([deps.loadConfig(), deps.configRevision()])
  sendJson(res, 200, { apiVersion: API_VERSION, configVersion: config.version, revision, features: API_FEATURES })
}

async function handleConfig(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method === 'GET') {
    const [config, assets, revision] = await Promise.all([deps.loadConfig(), deps.listAssets(), deps.configRevision()])
    sendJson(res, 200, { config, assets, revision })
    return
  }
  if (req.method === 'PUT') {
    const body = await readBody(req, JSON_BODY_LIMIT)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
    }
    // B3 optional optimistic concurrency: `x-petween-expected-revision: N`.
    // Absent (or empty) → last-writer-wins exactly as before; present and
    // stale → 409 before any write. The revision counter itself never enters
    // the config document (schema-pure), only this header and the responses.
    const expectedHeader = req.headers['x-petween-expected-revision']
    const expectedRaw = Array.isArray(expectedHeader) ? expectedHeader[0] : expectedHeader
    let expectedRevision: number | undefined
    if (expectedRaw !== undefined && expectedRaw !== '') {
      // Digits only — Number() alone would accept '0x10' / '1e2' / padding.
      if (!/^\d+$/.test(expectedRaw)) {
        throw new HttpError(400, 'INVALID_REQUEST', 'x-petween-expected-revision must be a non-negative integer')
      }
      expectedRevision = Number(expectedRaw)
    }
    // Bare pet-switch guard (2026-08-29): a PUT that flips activePetId
    // without the character slice used to save the OLD pet's live data, and
    // the onSaved mirror then wrote that data into the NEWLY active preset —
    // a silent clobber (incident: a preset lost its poses this way). A
    // switch through this route now carries apply semantics: the target
    // preset's slice becomes the patch base, with caller-supplied poses /
    // states / global.scale still winning field-by-field. Dangling ids stay
    // tolerated (validation's documented stance): no expansion, the mirror
    // no-ops with its existing warn.
    if (typeof raw === 'object' && raw !== null) {
      const targetId = (raw as Record<string, unknown>).activePetId
      if (typeof targetId === 'string') {
        const current = await deps.loadConfig()
        if (targetId !== current.activePetId) {
          try {
            raw = expandPetSwitchPatch(raw as Record<string, unknown>, await deps.readPet(targetId))
          } catch (error) {
            if (!(error instanceof PetError && error.code === 'NOT_FOUND')) throw error
          }
        }
      }
    }
    // Strict validation against the current config as base, then atomic save —
    // serialized inside updateConfig so overlapping PUTs cannot lose fields.
    // Sequential on purpose: the revision read must observe THIS update's bump.
    const config = await deps.updateConfig(raw, expectedRevision === undefined ? undefined : { expectedRevision })
    const revision = await deps.configRevision()
    sendJson(res, 200, { config, revision })
    return
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET or PUT')
}

async function handleAssets(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutesDeps,
  pathname: string,
): Promise<void> {
  if (pathname === ASSETS_PATH) {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected POST')
    const boundary = parseBoundary(req.headers['content-type'])
    if (boundary === null) {
      throw new HttpError(400, 'BAD_MULTIPART', 'expected multipart/form-data with a boundary')
    }
    const body = await readBody(req, deps.maxAssetBytes + MULTIPART_FORM_OVERHEAD)
    const file = extractFilePart(body, boundary)
    if (file === null) throw new HttpError(400, 'FILE_FIELD_MISSING', 'multipart field "file" is required')
    const asset = await deps.saveAsset(file.data, file.contentType)
    sendJson(res, 200, {
      asset: { id: asset.id, url: asset.url, width: asset.width, height: asset.height },
    })
    return
  }
  if (pathname.startsWith(`${ASSETS_PATH}/`)) {
    if (req.method !== 'DELETE') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected DELETE')
    const id = safeDecode(pathname.slice(ASSETS_PATH.length + 1))
    if (id === null || validateAssetId(id) === null) throw new HttpError(404, 'NOT_FOUND', 'unknown asset')
    // An asset referenced by ANY preset's poses is as protected as one
    // referenced by the live config (V1.1 pet presets). The probe loads the
    // FRESHEST state inside the store's serialized delete (B10) — the shared
    // host-wide write lock means a referencing config/preset save that started
    // earlier has already landed by the time this runs.
    await deps.deleteAsset(id, async (assetId) => {
      const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
      return (
        POSE_KEYS.some((key) => config.poses[key]?.assetId === assetId) ||
        pets.some((pet) => POSE_KEYS.some((key) => pet.poses[key]?.assetId === assetId))
      )
    })
    sendJson(res, 200, { deleted: id })
    return
  }
  throw new HttpError(404, 'NOT_FOUND', 'unknown route')
}

async function handleAnimationsIndex(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET')
  // Live scan on every call: the directory is tiny, so there is no cache.
  const { customs, warnings, normalized } = await deps.listAnimations()
  sendJson(res, 200, { customs, warnings, normalized })
}

/** A state references an animation via its enter or custom ambient timeline. */
function stateReferencesAnimation(state: PetweenConfig['states'][PoseKey], id: string): boolean {
  return state.enter.animationId === id || state.ambient.customAnimationId === id
}

/** A config references an animation via a state timeline or the click interaction. */
function animationReferenced(config: PetweenConfig, id: string): boolean {
  if (config.interactions.click.animation === id) return true
  return POSE_KEYS.some((key) => stateReferencesAnimation(config.states[key], id))
}

/**
 * Reference judgement shared by the DELETE 409 and the PUT kind-change 409:
 * the live config (state timelines + click interaction) plus every pet
 * preset, active or not.
 */
function animationReferencedAnywhere(config: PetweenConfig, pets: PetPreset[], id: string): boolean {
  return (
    animationReferenced(config, id) ||
    pets.some((pet) => POSE_KEYS.some((key) => stateReferencesAnimation(pet.states[key], id)))
  )
}

async function handleAnimations(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutesDeps,
  pathname: string,
): Promise<void> {
  if (!pathname.startsWith(`${ANIMATIONS_PATH}/`)) {
    // The exact route owns GET on the bare path; anything else lacks the <id>.
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected PUT or DELETE with an animation id')
  }
  const id = safeDecode(pathname.slice(ANIMATIONS_PATH.length + 1))
  if (id === null || validateAnimationId(id) === null) throw new HttpError(404, 'NOT_FOUND', 'unknown animation')
  if (req.method === 'PUT') {
    const body = await readBody(req, JSON_BODY_LIMIT)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
    }
    const bodyId = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).id : undefined
    if (bodyId !== id) throw new HttpError(400, 'ID_MISMATCH', `path id "${id}" does not match body id ${JSON.stringify(bodyId)}`)
    // Kind-change guard (DELETE parity): flipping the kind of a still-
    // referenced animation (e.g. transition → ambient) would silently break
    // its mounts — the runtime falls back, config repair drops the mount and
    // the preset mirror writes the loss into every referencing preset. Same
    // reference judgement as DELETE, same 409 ANIMATION_IN_USE body. Only a
    // well-formed kind participates: a garbage kind must surface as the
    // store's 400 INVALID_DEFINITION, not as a kind-change 409. The probe
    // runs INSIDE the store's serialized save (guard callback) against the
    // freshest state — a lock-free pre-check could be overtaken by a
    // concurrent config PUT mounting the animation in between (B10).
    const incoming = raw as AnimationDefinition
    const kindUsable = typeof incoming.kind === 'string' && ANIMATION_KINDS.includes(incoming.kind)
    // Full schema + user-namespace validation happens in the store (after the guard).
    await deps.saveAnimation(incoming, async (existingKind) => {
      if (!kindUsable || existingKind === undefined || existingKind === incoming.kind) return
      const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
      if (animationReferencedAnywhere(config, pets, id)) {
        throw new AnimationError('IN_USE', '动画仍被挂载引用，不能变更类型；请先解除引用，或另存为新动画')
      }
    })
    sendJson(res, 200, { animation: raw })
    return
  }
  if (req.method === 'DELETE') {
    // Same B10 contract as asset deletes: fresh state inside the store's
    // serialized delete, no stale request-time snapshot.
    await deps.deleteAnimation(id, async (animationId) => {
      const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
      return animationReferencedAnywhere(config, pets, animationId)
    })
    sendJson(res, 200, { deleted: id })
    return
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected PUT or DELETE')
}

/** Config patch that applies a preset: the character slice plus the active pointer. */
function applyPatchFor(pet: PetPreset): Record<string, unknown> {
  // Optional animation references use patch semantics where an absent field
  // means "keep current". A preset application is authoritative, so encode
  // absent references as null to clear ids owned by the previous pet.
  const states = Object.fromEntries(
    POSE_KEYS.map((key) => {
      const state = pet.states[key]
      return [
        key,
        {
          ...state,
          enter: { ...state.enter, animationId: state.enter.animationId ?? null },
          ambient: { ...state.ambient, customAnimationId: state.ambient.customAnimationId ?? null },
        },
      ]
    }),
  )
  return { activePetId: pet.id, poses: pet.poses, states, global: { scale: pet.scale } }
}

/**
 * Pet-switch patch base (bare-switch guard): the target preset's full
 * character slice, so the onSaved mirror can only ever write the preset's
 * own data back into it. Caller slice fields win field-by-field; `global`
 * merges scale-only — a caller `global` without `scale` must not resurrect
 * the previous pet's scale through the merge-onto-current patch semantics.
 */
function expandPetSwitchPatch(raw: Record<string, unknown>, pet: PetPreset): Record<string, unknown> {
  const base = applyPatchFor(pet)
  const callerGlobal =
    typeof raw.global === 'object' && raw.global !== null ? (raw.global as Record<string, unknown>) : undefined
  const callerScale = callerGlobal?.scale
  return {
    ...raw,
    poses: raw.poses !== undefined ? raw.poses : base.poses,
    states: raw.states !== undefined ? raw.states : base.states,
    global:
      callerGlobal !== undefined
        ? { ...callerGlobal, scale: callerScale !== undefined ? callerScale : (base.global as { scale: number }).scale }
        : { scale: (base.global as { scale: number }).scale },
  }
}

async function handlePetsIndex(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method === 'GET') {
    const [{ pets, warnings }, config] = await Promise.all([deps.listPets(), deps.loadConfig()])
    sendJson(res, 200, { pets, activePetId: config.activePetId, warnings })
    return
  }
  if (req.method === 'POST') {
    const body = await readBody(req, JSON_BODY_LIMIT)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
    }
    const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    if (source.from === 'draft') {
      // A2 (2026-08-27 拍板 A): create a preset from the client-supplied
      // slice — the editor's CURRENT DRAFT, unsaved edits included — without
      // touching the active pet: no apply, no activePetId change. The
      // lossless fork of the variant workflow (the active pet keeps its own
      // draft and dirty state). The slice gets the same strict field
      // validation a config PUT would give these sections, animation
      // references included (a ConfigValidationError maps to 400
      // INVALID_CONFIG through mapError).
      const pet = source.pet
      if (typeof pet !== 'object' || pet === null || Array.isArray(pet)) {
        throw new HttpError(400, 'INVALID_REQUEST', 'from:"draft" requires a "pet" slice object')
      }
      const slice = pet as Record<string, unknown>
      const { customs } = await deps.listAnimations()
      const kindById = new Map(customs.map((definition) => [definition.id, definition.kind]))
      // Default base (not the live config): missing slice keys then inherit
      // the SAME defaults normalizePetSlice repairs with, so what validation
      // approves is exactly what the store persists.
      validateConfigPatch(
        { global: { scale: slice.scale }, poses: slice.poses, states: slice.states },
        undefined,
        { animationLookup: (id) => kindById.get(id) },
      )
      const created = await deps.createPet(source.name, slice)
      sendJson(res, 200, { pet: created })
      return
    }
    if (source.from !== 'current' && source.from !== 'blank') {
      throw new HttpError(400, 'INVALID_REQUEST', 'expected "from" to be "current", "blank" or "draft"')
    }
    const config = await deps.loadConfig()
    if (source.from === 'current') {
      // Save the current slice as a preset and adopt it as the active pet.
      const pet = await deps.createPet(source.name, petSliceFromConfig(config))
      const updated = await deps.updateConfig({ activePetId: pet.id })
      sendJson(res, 200, { pet, config: updated })
      return
    }
    // from=blank: create an empty named preset and apply it.
    const pet = await deps.createPet(source.name, {})
    const updated = await deps.updateConfig(applyPatchFor(pet))
    sendJson(res, 200, { pet, config: updated })
    return
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET or POST')
}

/**
 * §12 Pet Package import: POST /api/petween/pets/import with the zip body.
 * Validation is fully read-only (host/pet-package.ts); writes then follow the
 * fixed order assets → animations (the existing one-lock pack transaction) →
 * pet creation LAST → immediate apply. Any failure along the way rolls the
 * fresh writes back best-effort — only ids this call actually created are
 * removed, with the same fresh-state reference probes as the DELETE routes
 * (B10), so a concurrent consumer that started reusing them keeps them.
 */
async function handlePetPackageImport(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected POST')
  const body = await readBody(req, PET_PACKAGE_BODY_LIMIT)
  const plan = await validatePetPackage(body)
  const library = await deps.listAssets()
  const assetsAdded: string[] = []
  const assetsReused: string[] = []
  const importedAnimationIds: string[] = []
  let entries: PackImportEntry[] = []
  let mounts: PackMounts = {}
  /**
   * Best-effort undo of everything this import persisted — only what THIS
   * call created (created:true assets, this transaction's animation writes,
   * and a created pet last). The reference probes load the freshest state
   * inside the store locks (B10), so a concurrent consumer that started
   * reusing an id keeps it.
   */
  const rollback = async (petId?: string): Promise<void> => {
    // The pet goes first: until it is deleted its own slice still references
    // the fresh animations/assets, and the probes below would spare them.
    if (petId !== undefined) await deps.deletePet(petId).catch(() => undefined)
    for (const id of importedAnimationIds) {
      await deps
        .deleteAnimation(id, async (animationId) => {
          const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
          return animationReferencedAnywhere(config, pets, animationId)
        })
        .catch(() => undefined)
    }
    for (const id of assetsAdded) {
      await deps
        .deleteAsset(id, async (assetId) => {
          const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
          return (
            POSE_KEYS.some((key) => config.poses[key]?.assetId === assetId) ||
            pets.some((pet) => POSE_KEYS.some((key) => pet.poses[key]?.assetId === assetId))
          )
        })
        .catch(() => undefined)
    }
  }
  try {
    for (const asset of plan.assets) {
      if (library[asset.id] !== undefined) {
        assetsReused.push(asset.id) // content-addressed reuse: no second copy
        continue
      }
      // The store re-runs the asset-side validation inside its lock and
      // dedupes by content hash — a concurrent import of the same bytes lands
      // here as created:false, and the rollback must NOT delete that shared
      // entry from under the other importer.
      const saved = await deps.saveAsset(asset.data, asset.mimeType)
      if (saved.created) assetsAdded.push(asset.id)
      else assetsReused.push(asset.id)
    }
    if (plan.motionPack !== undefined) {
      const packPlan = await deps.importPack(plan.motionPack)
      entries = packPlan.entries
      mounts = packPlan.mounts
      plan.warnings.push(...packPlan.warnings)
      importedAnimationIds.push(...packPlan.writes.map((definition) => definition.id))
    }
  } catch (error) {
    await rollback()
    throw error
  }
  // Creation is the last write: the slice's animation references point at
  // the FINAL ids, attribution rides in the same atomic record. Creation and
  // the immediate apply sit inside the rollback scope too (defense in depth:
  // validation already guarantees the apply passes strict re-validation, but
  // a dead half-imported pet must never survive a disk/config failure).
  const slice = rewritePetSliceAnimations(plan.pet, finalIdMapOf(entries), mounts)
  let pet: PetPreset
  try {
    pet = await deps.createPet(plan.name, slice, plan.attribution)
  } catch (error) {
    await rollback()
    throw error
  }
  let config: PetweenConfig
  try {
    config = await deps.updateConfig(applyPatchFor(pet))
  } catch (error) {
    await rollback(pet.id)
    throw error
  }
  sendJson(res, 200, {
    pet,
    config,
    report: { assetsAdded, assetsReused, entries, mounts, warnings: plan.warnings },
  })
}

/**
 * §12 Pet Package export: GET /api/petween/pets/<id>/export → the zip bytes
 * (binary — sendJson never applies here). The manifest is complete or the
 * request fails: EXPORT_INCOMPLETE names the missing assets/animations.
 */
async function handlePetPackageExport(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps, id: string): Promise<void> {
  if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET')
  const pet = await deps.readPet(id) // NOT_FOUND for unknown ids
  const [assets, { customs }] = await Promise.all([deps.listAssets(), deps.listAnimations()])
  const manifest = buildPetPackageExport(pet, { assets, animations: customs })
  const assetData: Record<string, Buffer> = {}
  for (const entry of manifest.assets) {
    const resolved = await deps.resolveAssetPath(entry.id)
    let data: Buffer | null = null
    if (resolved !== null) data = await readFile(resolved.path).catch(() => null)
    if (data === null) throw new PetPackageError('EXPORT_INCOMPLETE', `asset file missing: ${entry.id}`, [entry.id])
    assetData[entry.id] = data
  }
  const zipped = buildPetPackageZip(manifest, assetData)
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': zipped.byteLength,
    'x-content-type-options': 'nosniff',
  })
  res.end(zipped)
}

async function handlePets(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutesDeps,
  pathname: string,
): Promise<void> {
  if (!pathname.startsWith(`${PETS_PATH}/`)) {
    // The exact route owns the bare path; anything else lacks the <id>.
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected PUT, POST or DELETE with a pet id')
  }
  const sub = safeDecode(pathname.slice(PETS_PATH.length + 1))
  if (sub === null) throw new HttpError(404, 'NOT_FOUND', 'unknown pet')
  // §12 Pet Package import lives under the pets prefix but is not a pet id;
  // it must be picked off before PET_ID_RE rejects it as unknown.
  if (sub === 'import') {
    await handlePetPackageImport(req, res, deps)
    return
  }
  if (sub.endsWith('/export')) {
    const id = validatePetId(sub.slice(0, -'/export'.length))
    if (id === null) throw new HttpError(404, 'NOT_FOUND', 'unknown pet')
    await handlePetPackageExport(req, res, deps, id)
    return
  }
  if (sub.endsWith('/apply')) {
    const id = validatePetId(sub.slice(0, -'/apply'.length))
    if (id === null) throw new HttpError(404, 'NOT_FOUND', 'unknown pet')
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected POST')
    const pet = await deps.readPet(id)
    const updated = await deps.updateConfig(applyPatchFor(pet))
    sendJson(res, 200, { config: updated })
    return
  }
  const id = validatePetId(sub)
  if (id === null) throw new HttpError(404, 'NOT_FOUND', 'unknown pet')
  if (req.method === 'GET') {
    // B10: single-preset read (pack export needs one pet without the whole
    // list; readPet was already there, only the route was missing).
    const pet = await deps.readPet(id)
    sendJson(res, 200, { pet })
    return
  }
  if (req.method === 'PUT') {
    const body = await readBody(req, JSON_BODY_LIMIT)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
    }
    const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    // `{name?, attribution?}`: absent fields keep their current value;
    // `attribution: null` clears the whole block, an object updates it
    // field-by-field (partial semantics live in the store). Name and
    // attribution validation both surface as INVALID_PRESET.
    const attribution = source.attribution
    if (attribution !== undefined && attribution !== null && (typeof attribution !== 'object' || Array.isArray(attribution))) {
      throw new HttpError(400, 'INVALID_REQUEST', '"attribution" must be an object or null')
    }
    const pet = await deps.updatePetMeta(id, {
      ...(source.name === undefined ? {} : { name: source.name }),
      ...(attribution === undefined ? {} : { attribution: attribution as null | Record<string, unknown> }),
    })
    sendJson(res, 200, { pet })
    return
  }
  if (req.method === 'DELETE') {
    await deps.deletePet(id)
    // The pet keeps showing as unsaved edits: drop only the active pointer.
    const config = await deps.loadConfig()
    if (config.activePetId === id) await deps.updateConfig({ activePetId: null })
    sendJson(res, 200, { deleted: id })
    return
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET, PUT or DELETE')
}

async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutesDeps,
  pathname: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET or HEAD')
  }
  const raw = pathname.startsWith(`${STATIC_PATH}/`) ? pathname.slice(STATIC_PATH.length + 1) : ''
  const id = safeDecode(raw)
  // Whitelist resolution: the id never touches the filesystem directly.
  const resolved = id === null ? null : await deps.resolveAssetPath(id)
  if (resolved === null) throw new HttpError(404, 'NOT_FOUND', 'unknown asset')
  let data: Buffer
  try {
    data = await readFile(resolved.path)
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'asset file missing')
  }
  res.writeHead(200, {
    'content-type': resolved.mimeType,
    'content-length': data.length,
    // ids are content-addressed, so assets are immutable
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : data)
}

type Handler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>

/**
 * §20 defense-in-depth: browser writes must be same-origin. CORS "simple"
 * requests (multipart/form-data POST, text/plain POST) never preflight, so a
 * malicious page could otherwise upload assets, create pets or apply presets
 * cross-origin with side effects landing even though the response is blocked.
 * Non-browser clients (no Sec-Fetch-Site / Origin metadata — curl, the future
 * CLI) stay allowed; GETs/HEADs are read-only and never guarded.
 *
 * Sec-Fetch-Site handling: `cross-site` rejects outright; `same-origin` and
 * `none` (direct navigation) pass; `same-site` is NOT enough on its own —
 * it spans origins (e.g. another localhost port), so those requests fall
 * through to the Origin ↔ Host comparison below (a missing Origin still
 * means a non-browser client and passes).
 */
function rejectsCrossOriginWrite(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') {
    if (site === 'cross-site') return true
    if (site === 'same-origin' || site === 'none') return false
    // 'same-site' (or an unrecognized value): verify the origin below.
  }
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      // Same-origin writes carry an Origin matching the Host header; 'null'
      // (file://, sandboxed iframes) and foreign hosts are rejected.
      return new URL(origin).host !== req.headers.host
    } catch {
      return true
    }
  }
  return false
}

/** Register all routes; the returned disposer unregisters every one. */
export function registerRoutes(host: RoutesHost, deps: RoutesDeps): () => void {
  const wrap =
    (handler: Handler): WebRoute['handler'] =>
    async (req, res) => {
      try {
        if (rejectsCrossOriginWrite(req)) {
          throw new HttpError(403, 'CROSS_ORIGIN', 'cross-origin writes are not allowed')
        }
        await handler(req, res, parsePathname(req.url))
      } catch (error) {
        mapError(res, error)
      }
    }
  const disposers = [
    host.webServer.register({ kind: 'exact', path: PACK_IMPORT_PATH, handler: wrap((req, res) => handlePackImport(req, res, deps)) }),
    host.webServer.register({ kind: 'exact', path: PACK_EXPORT_PATH, handler: wrap((req, res) => handlePackExport(req, res, deps)) }),
    host.webServer.register({ kind: 'exact', path: META_PATH, handler: wrap((req, res) => handleMeta(req, res, deps)) }),
    host.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: wrap((req, res) => handleConfig(req, res, deps)) }),
    host.webServer.register({
      kind: 'prefix',
      path: ASSETS_PATH,
      handler: wrap((req, res, pathname) => handleAssets(req, res, deps, pathname)),
    }),
    host.webServer.register({
      kind: 'exact',
      path: ANIMATIONS_PATH,
      handler: wrap((req, res) => handleAnimationsIndex(req, res, deps)),
    }),
    host.webServer.register({
      kind: 'prefix',
      path: ANIMATIONS_PATH,
      handler: wrap((req, res, pathname) => handleAnimations(req, res, deps, pathname)),
    }),
    host.webServer.register({
      kind: 'exact',
      path: PETS_PATH,
      handler: wrap((req, res) => handlePetsIndex(req, res, deps)),
    }),
    host.webServer.register({
      kind: 'prefix',
      path: PETS_PATH,
      handler: wrap((req, res, pathname) => handlePets(req, res, deps, pathname)),
    }),
    host.webServer.register({
      kind: 'prefix',
      path: STATIC_PATH,
      handler: wrap((req, res, pathname) => handleStatic(req, res, deps, pathname)),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
