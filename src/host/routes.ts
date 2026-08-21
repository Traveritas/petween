/**
 * host/routes.ts — HTTP API (spec §19) on the bare node http the DSH
 * webServer service exposes: method dispatch, body parsing, traversal guards
 * and error mapping are all hand-rolled (M0 finding §6).
 *
 * Registered routes:
 * - exact  `/api/motion-pet/config`     GET / PUT
 * - prefix `/api/motion-pet/assets`     POST (base path) / DELETE `<id>` subpath
 * - exact  `/api/motion-pet/animations` GET (V1.1)
 * - prefix `/api/motion-pet/animations` PUT / DELETE `<id>` subpath (V1.1)
 * - prefix `/motion-pet-assets`         GET / HEAD `<id>` subpath (static)
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
import type { AssetMeta, MotionPetConfig } from '../core/types'
import { POSE_KEYS } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'
import { AnimationError, validateAnimationId } from './animations'
import { AssetError } from './assets'
import { ConfigValidationError, validateAssetId } from './validation'

const CONFIG_PATH = '/api/motion-pet/config'
const ASSETS_PATH = '/api/motion-pet/assets'
const ANIMATIONS_PATH = '/api/motion-pet/animations'
const STATIC_PATH = '/motion-pet-assets'

const JSON_BODY_LIMIT = 64 * 1024 // M0 §2: dsh-pet's readJsonBody precedent
/** multipart framing (boundary lines, headers) on top of the file bytes. */
const MULTIPART_FORM_OVERHEAD = 256 * 1024

/** Everything the routes need from config/asset persistence, injected for tests. */
export interface RoutesDeps {
  loadConfig(): Promise<MotionPetConfig>
  /**
   * PUT path: strictly validate the patch against the current config and
   * atomically save it, resolving the merged config. Implementations must
   * serialize concurrent calls (ConfigStore.update) — a bare read-modify-write
   * loses fields when two writers overlap.
   */
  updateConfig(patch: unknown): Promise<MotionPetConfig>
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
    const config = await deps.loadConfig()
    await deps.deleteAsset(id, (assetId) => POSE_KEYS.some((key) => config.poses[key]?.assetId === assetId))
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

/** A config references an animation via a state enter or the click interaction. */
function animationReferenced(config: MotionPetConfig, id: string): boolean {
  if (config.interactions.click.animation === id) return true
  return POSE_KEYS.some((key) => config.states[key].enter.animationId === id)
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
    // Full schema + user-namespace validation happens in the store.
    await deps.saveAnimation(raw as AnimationDefinition)
    sendJson(res, 200, { animation: raw })
    return
  }
  if (req.method === 'DELETE') {
    const config = await deps.loadConfig()
    await deps.deleteAnimation(id, (animationId) => animationReferenced(config, animationId))
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

/** Register all routes; the returned disposer unregisters every one. */
export function registerRoutes(host: RoutesHost, deps: RoutesDeps): () => void {
  const wrap =
    (handler: Handler): WebRoute['handler'] =>
    async (req, res) => {
      try {
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
      kind: 'prefix',
      path: STATIC_PATH,
      handler: wrap((req, res, pathname) => handleStatic(req, res, deps, pathname)),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
