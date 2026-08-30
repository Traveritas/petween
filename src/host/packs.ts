/**
 * host/packs.ts — Motion Pack import/export (V1.1 P2; spec §8.18 sketch).
 *
 * A pack is, for v1, ONE JSON document — the manifest plus every definition
 * inline. The spec's motion-pack.zip is a future container for the same
 * manifest (an animation pack carries no binary payload — images stay in the
 * Pet Pack per §8.18 — so JSON distribution needs no new dependency and no
 * binary parsing surface). Format:
 *
 *   {
 *     "format": "motion-pack",
 *     "version": 1,
 *     "name": "漫画弹跳包",
 *     "namespace": "manga-pop",
 *     "animations": [ ...AnimationDefinition... ],
 *     "mounts": { "idle": { "enter": "manga-pop:bounce" } }   // optional
 *   }
 *
 * Import semantics (the B6 collision contract):
 * - every definition must live in the pack's namespace (a pack never smug-
 *   gles foreign ids); `namespace: "mixed"` (what export produces for a
 *   cross-namespace selection) keeps each definition's own namespace;
 * - a requested id that is FREE → imported verbatim;
 * - a requested id already holding IDENTICAL content → "identical", skipped
 *   (re-importing the same pack is idempotent);
 * - a requested id holding DIFFERENT content → imported under the first free
 *   `<id>-2`, `-3`, … suffix ("remapped") — free means not in the library AND
 *   not claimed by the pack itself (a pack-mate's requested id imports
 *   verbatim, so a remap must yield to it) — never a silent overwrite, never
 *   a whole-pack rejection. Mounts are rewritten to the FINAL ids; the mapping
 *   is reported so the caller (and the editor UI) can show what landed where.
 *
 * Mounts are carried and RESOLVED, not applied: writing config state mounts
 * stays the caller's explicit action ("一键应用" is a deliberate later step).
 */
import type { AnimationDefinition } from '../motion/animation-definition'
import {
  ANIMATION_DEFINITION_VERSION,
  isCustomAnimationId,
  validateAnimationDefinition,
} from '../motion/animation-definition'
import { POSE_KEYS, type PoseKey } from '../core/types'
// Same host layer: the store owns the reserved-id rule; packs reject it at
// validation time so a reserved id fails BEFORE any file is written (a remap
// candidate can never collide with it by construction — the suffix `-N` is
// always appended, and the reserved id itself carries none).
import { RESERVED_CLIENT_DRAFT_ID } from './animations'

/** The namespace of a single-file pack; 'mixed' = keep per-definition ns. */
const PACK_NAMESPACE_RE = /^[a-z][a-z0-9-]*$/
export const MIXED_NAMESPACE = 'mixed'
const MAX_PACK_NAME_LENGTH = 120
const MAX_PACK_ANIMATIONS = 200
/** Cap the remap suffix search; a hostile pack cannot spin this loop. */
const MAX_REMAP_ATTEMPTS = 100

export interface PackMounts {
  [stateSlot: string]: { enter?: string; ambient?: string }
}

export interface MotionPackManifest {
  format: 'motion-pack'
  version: 1
  name: string
  namespace: string
  animations: AnimationDefinition[]
  mounts?: PackMounts
}

/** A validated manifest — the only shape the import path accepts. */
export type ValidatedMotionPack = MotionPackManifest

export type PackImportStatus = 'imported' | 'identical' | 'remapped'

export interface PackImportEntry {
  requestedId: string
  finalId: string
  status: PackImportStatus
}

export interface PackImportPlan {
  /** Definitions to persist (already id-rewritten for remaps). */
  writes: AnimationDefinition[]
  entries: PackImportEntry[]
  /** Mounts with references rewritten to final ids (input copy otherwise). */
  mounts: PackMounts
  /** Non-fatal problems: mount slots/ids that resolved to nothing. */
  warnings: string[]
}

export type PackValidationResult =
  | { ok: true; pack: ValidatedMotionPack }
  | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function namespaceOf(id: string): string {
  return id.slice(0, id.indexOf(':'))
}

/**
 * Structural + per-definition validation. Every definition passes the B1
 * version seam (a newer format rejects with the explicit reader error, so a
 * future pack never silently mangles); ids must be custom-namespace ids in
 * the pack's namespace (or their own, under 'mixed'); ids are unique inside
 * the pack; mount references must name pack animations of the right kind.
 */
export function validateMotionPack(raw: unknown): PackValidationResult {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ['pack must be a JSON object'] }
  if (raw.format !== 'motion-pack') errors.push('"format" must be "motion-pack"')
  if (raw.version !== 1) {
    if (raw.version === undefined || typeof raw.version !== 'number' || raw.version <= ANIMATION_DEFINITION_VERSION) {
      errors.push('"version" must be 1')
    } else {
      errors.push(
        `"version" ${raw.version} was written by a newer petween (this build reads version 1); upgrade the plugin or re-export the pack at version 1`,
      )
    }
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0) errors.push('"name" must be a non-empty string')
  if (name.length > MAX_PACK_NAME_LENGTH) errors.push(`"name" exceeds ${MAX_PACK_NAME_LENGTH} characters`)
  const namespace = raw.namespace
  if (typeof namespace !== 'string' || namespace === 'builtin' || !PACK_NAMESPACE_RE.test(namespace)) {
    errors.push('"namespace" must be a lowercase namespace (not builtin); "mixed" keeps per-animation namespaces')
  }
  if (!Array.isArray(raw.animations) || raw.animations.length === 0) {
    errors.push('"animations" must be a non-empty array')
    return { ok: false, errors }
  }
  if (raw.animations.length > MAX_PACK_ANIMATIONS) {
    errors.push(`"animations" exceeds the ${MAX_PACK_ANIMATIONS}-entry limit`)
  }
  const animations: AnimationDefinition[] = []
  const byId = new Map<string, AnimationDefinition>()
  const seenIds = new Set<string>()
  for (const [index, candidate] of raw.animations.entries()) {
    const result = validateAnimationDefinition(candidate)
    if (!result.valid) {
      errors.push(`animations[${index}]: ${result.errors.join('; ')}`)
      continue
    }
    const definition = candidate as AnimationDefinition
    if (!isCustomAnimationId(definition.id)) {
      errors.push(`animations[${index}]: id "${definition.id}" is not a custom (non-builtin) namespace id`)
      continue
    }
    if (definition.id === RESERVED_CLIENT_DRAFT_ID) {
      errors.push(`animations[${index}]: id "${RESERVED_CLIENT_DRAFT_ID}" is reserved for the client preview draft and cannot be stored`)
      continue
    }
    if (typeof namespace === 'string' && namespace !== MIXED_NAMESPACE && namespaceOf(definition.id) !== namespace) {
      errors.push(`animations[${index}]: id "${definition.id}" is outside the pack namespace "${namespace}"`)
      continue
    }
    if (seenIds.has(definition.id)) {
      errors.push(`animations[${index}]: duplicate id "${definition.id}" inside the pack`)
      continue
    }
    seenIds.add(definition.id)
    byId.set(definition.id, definition)
    animations.push(definition)
  }
  let mounts: PackMounts | undefined
  if (raw.mounts !== undefined) {
    if (!isRecord(raw.mounts)) {
      errors.push('"mounts" must be an object keyed by state slot')
    } else {
      mounts = {}
      for (const [slot, value] of Object.entries(raw.mounts)) {
        if (!(POSE_KEYS as readonly string[]).includes(slot)) {
          errors.push(`mounts.${slot}: unknown state slot (expected one of ${POSE_KEYS.join('/')})`)
          continue
        }
        if (!isRecord(value)) {
          errors.push(`mounts.${slot}: must be an object with optional enter/ambient ids`)
          continue
        }
        const mount: { enter?: string; ambient?: string } = {}
        for (const field of ['enter', 'ambient'] as const) {
          const id = value[field]
          if (id === undefined) continue
          if (typeof id !== 'string') {
            errors.push(`mounts.${slot}.${field}: expected an animation id string`)
            continue
          }
          const target = byId.get(id)
          if (target === undefined) {
            errors.push(`mounts.${slot}.${field}: "${id}" does not name a pack animation`)
            continue
          }
          const wanted = field === 'enter' ? 'transition' : 'ambient'
          if (target.kind !== wanted) {
            errors.push(`mounts.${slot}.${field}: "${id}" is ${target.kind}, needs ${wanted}`)
            continue
          }
          mount[field] = id
        }
        mounts[slot as PoseKey] = mount
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const pack: ValidatedMotionPack = {
    format: 'motion-pack',
    version: 1,
    name,
    namespace: namespace as string,
    animations,
    ...(mounts === undefined ? {} : { mounts }),
  }
  return { ok: true, pack }
}

/**
 * Byte-level equality (JSON.stringify, key order included): stable for our
 * own export→import round-trips, while a hand-reordered pack counts as
 * different content and remaps — deliberate, and cheap to reason about.
 */
function sameDefinition(a: AnimationDefinition, b: AnimationDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The pure collision planner (runs INSIDE the store's import lock segment,
 * against the freshest library): free id → import; identical content → skip;
 * different content → first free `-N` suffix. Mount references are rewritten
 * to final ids; dangling/unknown references degrade to warnings.
 */
export function planMotionPackImport(
  pack: ValidatedMotionPack,
  existing: ReadonlyMap<string, AnimationDefinition>,
): PackImportPlan {
  const writes: AnimationDefinition[] = []
  const entries: PackImportEntry[] = []
  const finalIdOf = new Map<string, string>()
  // An id is TAKEN when the library holds it, the pack itself requests it, or
  // an earlier entry of this plan already claimed it. Remaps must yield to a
  // pack-requested id even when it is free in the library (the contract
  // imports it verbatim) — otherwise a pack containing both `ns:x` and
  // `ns:x-2` could plan two writes to `ns:x-2`, the second silently
  // overwriting the first.
  const requestedIds = new Set(pack.animations.map((definition) => definition.id))
  const plannedIds = new Set<string>()
  const taken = (id: string): boolean =>
    existing.has(id) || requestedIds.has(id) || plannedIds.has(id)
  for (const definition of pack.animations) {
    const current = existing.get(definition.id)
    if (current === undefined) {
      finalIdOf.set(definition.id, definition.id)
      entries.push({ requestedId: definition.id, finalId: definition.id, status: 'imported' })
      writes.push(definition)
      continue
    }
    if (sameDefinition(current, definition)) {
      finalIdOf.set(definition.id, definition.id)
      entries.push({ requestedId: definition.id, finalId: definition.id, status: 'identical' })
      continue
    }
    let finalId: string | null = null
    let reusedIdentical = false
    for (let attempt = 2; attempt < 2 + MAX_REMAP_ATTEMPTS; attempt += 1) {
      const candidate = `${definition.id}-${attempt}`
      if (!taken(candidate)) {
        finalId = candidate
        break
      }
      // Re-importing a previously remapped conflict: the library copy already
      // sitting at this suffix may hold IDENTICAL content — reuse it (report
      // "identical") instead of piling on yet another -N copy. Only an
      // existing-library copy qualifies: an id claimed by the pack itself
      // (requested/planned) will hold the pack-mate's own content.
      if (!requestedIds.has(candidate) && !plannedIds.has(candidate)) {
        const held = existing.get(candidate)
        if (held !== undefined && sameDefinition(held, definition)) {
          finalId = candidate
          reusedIdentical = true
          break
        }
      }
    }
    if (finalId === null) {
      // 100 collisions on one name: pathological by construction. Fall back
      // to a content-hash suffix — unique by construction.
      finalId = `${definition.id}-${Math.abs(JSON.stringify(definition).length * 31 + definition.id.length).toString(36)}`
      while (taken(finalId)) finalId = `${finalId}x`
    }
    finalIdOf.set(definition.id, finalId)
    if (reusedIdentical) {
      entries.push({ requestedId: definition.id, finalId, status: 'identical' })
      continue
    }
    plannedIds.add(finalId)
    entries.push({ requestedId: definition.id, finalId, status: 'remapped' })
    writes.push({ ...definition, id: finalId })
  }
  const warnings: string[] = []
  let mounts: PackMounts = {}
  if (pack.mounts !== undefined) {
    mounts = {}
    for (const [slot, mount] of Object.entries(pack.mounts)) {
      const resolved: { enter?: string; ambient?: string } = {}
      for (const field of ['enter', 'ambient'] as const) {
        const id = mount[field]
        if (id === undefined) continue
        const finalId = finalIdOf.get(id)
        if (finalId === undefined) {
          warnings.push(`mounts.${slot}.${field}: "${id}" is not part of this pack`)
          continue
        }
        resolved[field] = finalId
      }
      mounts[slot] = resolved
    }
  }
  return { writes, entries, mounts, warnings }
}

/**
 * Build an export manifest from an existing selection. The namespace is the
 * shared one, or 'mixed' when the selection spans namespaces (import keeps
 * per-definition namespaces under 'mixed'). Exports carry no mounts — mounts
 * are author intent, and silently exporting the user's live config state
 * would pretend otherwise.
 */
export function buildMotionPackExport(
  name: string,
  definitions: AnimationDefinition[],
): MotionPackManifest {
  const namespaces = new Set(definitions.map((definition) => namespaceOf(definition.id)))
  return {
    format: 'motion-pack',
    version: 1,
    name: name.trim().length > 0 ? name.trim() : 'Motion Pack',
    namespace: namespaces.size === 1 ? ([...namespaces][0] as string) : MIXED_NAMESPACE,
    animations: structuredClone(definitions),
  }
}
