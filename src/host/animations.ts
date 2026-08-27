/**
 * host/animations.ts — custom AnimationDefinition persistence (V1.1, plan §3).
 *
 * Layout: `$DSH_HOME/petween/animations/<ns>_<name>.json` — one file per
 * custom animation, holding the AnimationDefinition verbatim, written
 * atomically (host/storage.ts). Any non-`builtin` lowercase namespace is
 * storable (`user:` remains the editor's default; Motion Packs and companion
 * plugins may claim their own — B6): the charset after the separator is
 * filename-safe, so the disk name derives from the id and a request id can
 * never traverse the filesystem.
 *
 * Loading is scan-based and fault-tolerant: unreadable, invalid or reserved-
 * namespace files are skipped with a warning instead of blocking startup;
 * the client registers whatever customs come back through the same zero-
 * branch registry path as the built-ins.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AnimationDefinition, AnimationKind } from '../motion/animation-definition'
import { isCustomAnimationId, RANDOM_DELAY_LIMITS, validateAnimationDefinition } from '../motion/animation-definition'
import { isMotionProperty, MOTION_PROPERTIES } from '../motion/motion-properties'
import { createWriteLock, writeJsonAtomic, type WriteLock } from './storage'

export type AnimationErrorCode = 'INVALID_DEFINITION' | 'NOT_FOUND' | 'IN_USE'

/** Animation-store failure with a stable code; the routes layer maps it to HTTP. */
export class AnimationError extends Error {
  override readonly name = 'AnimationError'
  constructor(
    readonly code: AnimationErrorCode,
    message: string,
    /** Schema-violation details for INVALID_DEFINITION (field paths inline). */
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export function defaultAnimationsDir(): string {
  return dshHomePath('petween', 'animations')
}

/**
 * The client timeline editor keeps its never-persisted preview draft under
 * this id (src/client/custom-animations.ts DRAFT_ANIMATION_ID). It matches
 * the user: charset, so without this guard a Motion Pack PUT could legally
 * claim it and the client sync would silently swallow the animation. The
 * host must not import client code, hence the literal — keep the two in
 * sync. Client previewing only registers in memory, never through the host
 * PUT, so rejecting the id here cannot break it.
 */
const RESERVED_CLIENT_DRAFT_ID = 'user:0draft'

/** Route-level id guard: `<namespace>:<name>` with a filename-safe charset. */
const SAFE_ID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * Storable custom-animation ids: any non-`builtin` namespace with a
 * filename-safe charset (no dots, no slashes — traversal is impossible by
 * construction). `user:` stays the editor default; packs/companions may
 * claim their own lowercase namespace (B6).
 */
export function validateCustomAnimationId(id: unknown): string | null {
  return typeof id === 'string' && isCustomAnimationId(id) ? id : null
}

/**
 * Charset/traversal guard for request path ids. Any namespace passes here —
 * the store enforces the custom-namespace restriction (a `builtin:*` PUT is
 * a 400, not a malformed-path 404).
 */
export function validateAnimationId(id: unknown): string | null {
  return typeof id === 'string' && SAFE_ID_RE.test(id) ? id : null
}

/** `<ns>:<name>` → `<ns>_<name>.json` (the charsets make this bijective). */
function fileNameFor(id: string): string {
  return `${id.replace(':', '_')}.json`
}

/**
 * Load-time tolerance for definitions saved under the pre-2026-08-27 schema:
 * the three tightening rules (ambient keeps off the transition layer,
 * per-track duplicate `at`, random-interval min >= 1) retroactively
 * invalidated files that earlier builds legitimately wrote — without this,
 * they vanish from the library and any config still mounting them can no
 * longer be saved. Mechanical normalization keeps them loadable: clamp the
 * delay floor, drop ambient transition-layer tracks, keep the first
 * keyframe per `at`. Only runs on shapes the current validator rejects;
 * returns null when even the normalized shape is invalid (caller falls
 * back to skip-with-warning). Files on disk are never rewritten here —
 * the next editor save persists the normalized shape.
 */
function normalizeLegacyDefinition(raw: unknown): AnimationDefinition | null {
  const candidate = raw as {
    kind?: unknown
    repeat?: { mode?: unknown; minDelayMs?: unknown; maxDelayMs?: unknown }
    tracks?: Array<{ property?: unknown; keyframes?: Array<{ at?: unknown }> }>
  }
  if (typeof candidate !== 'object' || candidate === null || !Array.isArray(candidate.tracks)) return null

  if (
    candidate.repeat?.mode === 'random-interval' &&
    typeof candidate.repeat.minDelayMs === 'number' &&
    Number.isFinite(candidate.repeat.minDelayMs)
  ) {
    const flooredMin = Math.max(candidate.repeat.minDelayMs, RANDOM_DELAY_LIMITS.min)
    candidate.repeat.minDelayMs = flooredMin
    const max = candidate.repeat.maxDelayMs
    if (typeof max === 'number' && Number.isFinite(max)) {
      candidate.repeat.maxDelayMs = Math.max(max, flooredMin)
    }
  }

  if (candidate.kind === 'ambient') {
    candidate.tracks = candidate.tracks.filter(
      (track) => !(isMotionProperty(track.property) && MOTION_PROPERTIES[track.property].targetLayer === 'transition'),
    )
  }

  for (const track of candidate.tracks) {
    if (!Array.isArray(track.keyframes)) continue
    const seenAt = new Set<number>()
    track.keyframes = track.keyframes.filter((keyframe) => {
      const at = keyframe.at
      // Invalid `at` values pass through untouched — the validator reports them.
      if (typeof at !== 'number' || !Number.isFinite(at)) return true
      if (seenAt.has(at)) return false
      seenAt.add(at)
      return true
    })
  }

  return validateAnimationDefinition(candidate).valid ? (candidate as AnimationDefinition) : null
}

function idFromFileName(entry: string): string | null {
  if (!entry.endsWith('.json')) return null
  // The first '_' is exactly the namespace separator: 'user' contains none.
  return validateCustomAnimationId(entry.slice(0, -'.json'.length).replace('_', ':'))
}

export interface AnimationsStoreOptions {
  /** Directory holding the animation files; created lazily on first save. */
  animationsDir: string
  /** Shared cross-store write serializer (B10); default: a private chain. */
  lock?: WriteLock
}

export class AnimationsStore {
  /** Serializes read-modify-write cycles in this process (AssetStore pattern). */
  private readonly lock: WriteLock

  constructor(private readonly options: AnimationsStoreOptions) {
    this.lock = options.lock ?? createWriteLock()
  }

  /**
   * Scan the directory and load every custom animation. Corrupt JSON, schema
   * violations and non-`user:` ids (a `builtin:*` file is an anomaly) are
   * skipped with a warning — startup is never blocked by a bad file.
   */
  async loadAll(): Promise<{ customs: AnimationDefinition[]; warnings: string[] }> {
    let entries: string[]
    try {
      entries = await readdir(this.options.animationsDir)
    } catch {
      return { customs: [], warnings: [] } // no directory yet = no customs
    }
    const customs: AnimationDefinition[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(join(this.options.animationsDir, entry), 'utf8'))
      } catch {
        warnings.push(`${entry}: unreadable or invalid JSON, skipped`)
        continue
      }
      const result = validateAnimationDefinition(raw)
      let definition: AnimationDefinition
      if (result.valid) {
        definition = raw as AnimationDefinition
      } else {
        // Pre-tightening shapes get one mechanical normalization pass before
        // the skip path — dropping them would dangle every config mount.
        const normalized = normalizeLegacyDefinition(raw)
        if (normalized === null) {
          warnings.push(`${entry}: invalid AnimationDefinition (${result.errors.join('; ')}), skipped`)
          continue
        }
        warnings.push(`${entry}: legacy shape auto-normalized (${result.errors.join('; ')})`)
        definition = normalized
      }
      if (validateCustomAnimationId(definition.id) === null) {
        warnings.push(`${entry}: id "${definition.id}" is not a custom-namespace id, skipped`)
        continue
      }
      if (seen.has(definition.id)) {
        warnings.push(`${entry}: duplicate id "${definition.id}", skipped`)
        continue
      }
      seen.add(definition.id)
      customs.push(definition)
    }
    return { customs, warnings }
  }

  /** Validate and persist a definition atomically; invalid input throws with details. */
  save(definition: AnimationDefinition): Promise<void> {
    return this.enqueue(async () => {
      const result = validateAnimationDefinition(definition)
      if (!result.valid) {
        throw new AnimationError('INVALID_DEFINITION', `invalid AnimationDefinition: ${result.errors.join('; ')}`, result.errors)
      }
      if (validateCustomAnimationId(definition.id) === null) {
        throw new AnimationError(
          'INVALID_DEFINITION',
          `custom animations must use a "<namespace>:<name>" id (any lowercase namespace except builtin), got "${definition.id}"`,
          ['"id" must match "<namespace>:<name>" (lowercase namespace, then letters, digits, "_" and "-")'],
        )
      }
      if (definition.id === RESERVED_CLIENT_DRAFT_ID) {
        throw new AnimationError(
          'INVALID_DEFINITION',
          '"user:0draft" is reserved for the client-side preview draft and cannot be stored',
          ['"id" must not be the reserved client draft id "user:0draft"'],
        )
      }
      await writeJsonAtomic(join(this.options.animationsDir, fileNameFor(definition.id)), definition)
    })
  }

  /**
   * Delete an animation. 409 semantics (IN_USE) when `referencedBy` reports
   * the id as still referenced; 404 semantics (NOT_FOUND) for unknown ids.
   * The reference probe is ASYNC and runs inside the serialized delete, so
   * the routes layer can probe the freshest config/preset state (B10).
   */
  delete(id: string, referencedBy: (animationId: string) => Promise<boolean>): Promise<void> {
    return this.enqueue(async () => {
      const valid = validateCustomAnimationId(id)
      if (valid === null || !this.exists(valid)) throw new AnimationError('NOT_FOUND', `unknown animation: ${id}`)
      if (await referencedBy(valid)) throw new AnimationError('IN_USE', `animation is still referenced: ${valid}`)
      await unlink(join(this.options.animationsDir, fileNameFor(valid)))
    })
  }

  /** Sync existence check for config validation (states.*.enter.animationId). */
  exists(id: string): boolean {
    return validateCustomAnimationId(id) !== null && existsSync(join(this.options.animationsDir, fileNameFor(id)))
  }

  /**
   * Sync kind lookup for config validation: mounts are kind-checked at the
   * interface (enter needs transition, ambient needs ambient), so a wrong-kind
   * id is rejected like a dangling one. Missing/corrupt files and inner ids
   * that disagree with the filename report undefined (unknown).
   */
  kindOf(id: string): AnimationKind | undefined {
    if (validateCustomAnimationId(id) === null) return undefined
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(this.options.animationsDir, fileNameFor(id)), 'utf8'))
    } catch {
      return undefined
    }
    let definition = raw as AnimationDefinition
    if (!validateAnimationDefinition(raw).valid) {
      const normalized = normalizeLegacyDefinition(raw)
      if (normalized === null) return undefined
      definition = normalized
    }
    return definition.id === id ? definition.kind : undefined
  }

  /** Ids of every animation file on disk (filename-derived, shape-filtered). */
  listIds(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(this.options.animationsDir)
    } catch {
      return []
    }
    return entries.map(idFromFileName).filter((id): id is string => id !== null)
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    return this.lock(op)
  }
}
