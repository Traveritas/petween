/**
 * host/routes.ts — HTTP API (spec §19) on the bare node http the DSH
 * webServer service exposes: method dispatch, body parsing, traversal guards
 * and error mapping are all hand-rolled (M0 finding §6).
 *
 * Registered routes:
 * - exact  `/api/petween/config`     GET / PUT
 * - prefix `/api/petween/assets`     POST (base path) / DELETE `<id>` subpath
 * - exact  `/api/petween/animations` GET (V1.1)
 * - prefix `/api/petween/animations` PUT / DELETE `<id>` subpath (V1.1)
 * - exact  `/api/petween/pets`       GET / POST (V1.1)
 * - prefix `/api/petween/pets`       PUT / DELETE `<id>` subpath, POST `<id>/apply` (V1.1)
 * - prefix `/petween-assets`         GET / HEAD `<id>` subpath (static)
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
import { ANIMATION_KINDS, type AnimationDefinition } from '../motion/animation-definition'
import { AnimationError, validateAnimationId } from './animations'
import { AssetError } from './assets'
import { PetError, petSliceFromConfig, validatePetId, type PetPreset } from './pets'
import { ConfigValidationError, validateAssetId } from './validation'

const CONFIG_PATH = '/api/petween/config'
const ASSETS_PATH = '/api/petween/assets'
const ANIMATIONS_PATH = '/api/petween/animations'
const PETS_PATH = '/api/petween/pets'
const STATIC_PATH = '/petween-assets'

const JSON_BODY_LIMIT = 64 * 1024 // M0 §2: dsh-pet's readJsonBody precedent
/** multipart framing (boundary lines, headers) on top of the file bytes. */
const MULTIPART_FORM_OVERHEAD = 256 * 1024

/** Everything the routes need from config/asset persistence, injected for tests. */
export interface RoutesDeps {
  loadConfig(): Promise<PetweenConfig>
  /**
   * PUT path: strictly validate the patch against the current config and
   * atomically save it, resolving the merged config. Implementations must
   * serialize concurrent calls (ConfigStore.update) — a bare read-modify-write
   * loses fields when two writers overlap.
   */
  updateConfig(patch: unknown): Promise<PetweenConfig>
  listAssets(): Promise<Record<string, AssetMeta>>
  saveAsset(buffer: Buffer, declaredMime: string | undefined): Promise<AssetMeta>
  deleteAsset(id: string, referencedBy: (assetId: string) => boolean): Promise<void>
  resolveAssetPath(id: string): Promise<{ path: string; mimeType: string } | null>
  /** Single-file upload cap; the multipart body limit adds form overhead. */
  maxAssetBytes: number
  /** Live directory scan: every stored custom animation plus load warnings. */
  listAnimations(): Promise<{ customs: AnimationDefinition[]; warnings: string[] }>
  saveAnimation(definition: AnimationDefinition): Promise<void>
  deleteAnimation(id: string, referencedBy: (animationId: string) => boolean): Promise<void>
  /** Pet presets (V1.1): live directory scan plus identity/slice mutations. */
  listPets(): Promise<{ pets: PetPreset[]; warnings: string[] }>
  createPet(name: unknown, slice: unknown): Promise<PetPreset>
  readPet(id: string): Promise<PetPreset>
  renamePet(id: string, name: unknown): Promise<PetPreset>
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

// --- handlers ---

async function handleConfig(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method === 'GET') {
    const [config, assets] = await Promise.all([deps.loadConfig(), deps.listAssets()])
    sendJson(res, 200, { config, assets })
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
    // Strict validation against the current config as base, then atomic save —
    // serialized inside updateConfig so overlapping PUTs cannot lose fields.
    const config = await deps.updateConfig(raw)
    sendJson(res, 200, { config })
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
    // referenced by the live config (V1.1 pet presets).
    const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
    await deps.deleteAsset(
      id,
      (assetId) =>
        POSE_KEYS.some((key) => config.poses[key]?.assetId === assetId) ||
        pets.some((pet) => POSE_KEYS.some((key) => pet.poses[key]?.assetId === assetId)),
    )
    sendJson(res, 200, { deleted: id })
    return
  }
  throw new HttpError(404, 'NOT_FOUND', 'unknown route')
}

async function handleAnimationsIndex(req: IncomingMessage, res: ServerResponse, deps: RoutesDeps): Promise<void> {
  if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected GET')
  // Live scan on every call: the directory is tiny, so there is no cache.
  const { customs, warnings } = await deps.listAnimations()
  sendJson(res, 200, { customs, warnings })
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
    // store's 400 INVALID_DEFINITION, not as a kind-change 409.
    const incoming = raw as AnimationDefinition
    const kindUsable = typeof incoming.kind === 'string' && ANIMATION_KINDS.includes(incoming.kind)
    const { customs } = await deps.listAnimations()
    const existing = customs.find((definition) => definition.id === id)
    if (kindUsable && existing !== undefined && existing.kind !== incoming.kind) {
      const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
      if (animationReferencedAnywhere(config, pets, id)) {
        throw new AnimationError('IN_USE', '动画仍被挂载引用，不能变更类型；请先解除引用，或另存为新动画')
      }
    }
    // Full schema + user-namespace validation happens in the store.
    await deps.saveAnimation(incoming)
    sendJson(res, 200, { animation: raw })
    return
  }
  if (req.method === 'DELETE') {
    const [config, { pets }] = await Promise.all([deps.loadConfig(), deps.listPets()])
    await deps.deleteAnimation(id, (animationId) => animationReferencedAnywhere(config, pets, animationId))
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
    if (source.from !== 'current' && source.from !== 'blank') {
      throw new HttpError(400, 'INVALID_REQUEST', 'expected "from" to be "current" or "blank"')
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
  if (req.method === 'PUT') {
    const body = await readBody(req, JSON_BODY_LIMIT)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
    }
    const name = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).name : undefined
    // Name validation happens in the store (INVALID_PRESET → 400).
    const pet = await deps.renamePet(id, name)
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
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'expected PUT or DELETE')
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
 */
function rejectsCrossOriginWrite(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'cross-site'
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
