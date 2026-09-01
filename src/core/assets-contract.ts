/**
 * core/assets-contract.ts — the single source of truth for the image upload
 * contract (spec §20): which MIME types are accepted and how large they may
 * be.
 *
 * The host is the enforcing authority; the client imports the same constants
 * for its UX pre-checks (file-picker accept, size guard), so the two sides
 * can never drift into "client allows, host rejects". `AssetMimeType` is
 * DERIVED from the runtime array — the type union and the whitelist cannot
 * drift apart by construction.
 */

/** MIME whitelist for uploaded pose images; SVG is explicitly rejected. */
export const ASSET_MIME_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const

/** An accepted image MIME type; identical to `AssetMeta['mimeType']`. */
export type AssetMimeType = (typeof ASSET_MIME_TYPES)[number]

/** Type guard for untrusted input (parsed JSON, File.type). */
export function isAssetMimeType(value: unknown): value is AssetMimeType {
  return typeof value === 'string' && (ASSET_MIME_TYPES as readonly string[]).includes(value)
}

/** File-picker `accept` attribute matching ASSET_MIME_TYPES. */
export const ASSET_ACCEPT_ATTRIBUTE: string = ASSET_MIME_TYPES.join(',')

export const MAX_ASSET_BYTES = 10 * 1024 * 1024 // spec §20
export const MAX_TOTAL_ASSET_BYTES = 60 * 1024 * 1024 // spec §20
export const MAX_ASSET_DIMENSION = 4096 // spec §20
