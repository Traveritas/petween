/**
 * host/animations.ts — custom AnimationDefinition persistence (V1.1, plan §3).
 *
 * Layout: `$DSH_HOME/motion-pet/animations/user_<name>.json` — one file per
 * custom animation, holding the AnimationDefinition verbatim, written
 * atomically (host/storage.ts). Only `user:<safe>` ids are storable: the
 * charset after the prefix is filename-safe, so the disk name is derived from
 * the id and a request id can never traverse the filesystem.
 *
 * Loading is scan-based and fault-tolerant: unreadable, invalid or wrongly-
 * namespaced files are skipped with a warning instead of blocking startup;
 * the client registers whatever customs come back through the same zero-
 * branch registry path as the built-ins.
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AnimationDefinition } from '../motion/animation-definition'
import { validateAnimationDefinition } from '../motion/animation-definition'
import { writeJsonAtomic } from './storage'

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
  return dshHomePath('motion-pet', 'animations')
}

/**
 * Storable custom-animation ids: the `user:` namespace with a filename-safe
 * charset (no dots, no slashes — traversal is impossible by construction).
 */
const USER_ID_RE = /^user:[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Route-level id guard: `<namespace>:<name>` with a filename-safe charset. */
const SAFE_ID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Returns the id when usable as a custom-animation id, else null. */
export function validateUserAnimationId(id: unknown): string | null {
  return typeof id === 'string' && USER_ID_RE.test(id) ? id : null
}

/**
 * Charset/traversal guard for request path ids. Any namespace passes here —
 * the store enforces the `user:` restriction (a `builtin:*` PUT is a 400, not
 * a malformed-path 404).
 */
export function validateAnimationId(id: unknown): string | null {
  return typeof id === 'string' && SAFE_ID_RE.test(id) ? id : null
}

/** `user:<name>` → `user_<name>.json` (the charset makes this bijective). */
function fileNameFor(id: string): string {
  return `${id.replace(':', '_')}.json`
}

function idFromFileName(entry: string): string | null {
  if (!entry.endsWith('.json')) return null
  // The first '_' is exactly the namespace separator: 'user' contains none.
  return validateUserAnimationId(entry.slice(0, -'.json'.length).replace('_', ':'))
}

export interface AnimationsStoreOptions {
  /** Directory holding the animation files; created lazily on first save. */
  animationsDir: string
}

export class AnimationsStore {
  /** Serializes read-modify-write cycles in this process (AssetStore pattern). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: AnimationsStoreOptions) {}

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
      if (!result.valid) {
        warnings.push(`${entry}: invalid AnimationDefinition (${result.errors.join('; ')}), skipped`)
        continue
      }
      const definition = raw as AnimationDefinition
      if (validateUserAnimationId(definition.id) === null) {
        warnings.push(`${entry}: id "${definition.id}" is not in the user: namespace, skipped`)
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
      if (validateUserAnimationId(definition.id) === null) {
        throw new AnimationError(
          'INVALID_DEFINITION',
          `custom animations must use a "user:<name>" id, got "${definition.id}"`,
          ['"id" must match "user:<name>" (letters, digits, "_" and "-")'],
        )
      }
      await writeJsonAtomic(join(this.options.animationsDir, fileNameFor(definition.id)), definition)
    })
  }

  /**
   * Delete an animation. 409 semantics (IN_USE) when `referencedBy` reports
   * the id as still referenced; 404 semantics (NOT_FOUND) for unknown ids.
   */
  delete(id: string, referencedBy: (animationId: string) => boolean): Promise<void> {
    return this.enqueue(async () => {
      const valid = validateUserAnimationId(id)
      if (valid === null || !this.exists(valid)) throw new AnimationError('NOT_FOUND', `unknown animation: ${id}`)
      if (referencedBy(valid)) throw new AnimationError('IN_USE', `animation is still referenced: ${valid}`)
      await unlink(join(this.options.animationsDir, fileNameFor(valid)))
    })
  }

  /** Sync existence check for config validation (states.*.enter.animationId). */
  exists(id: string): boolean {
    return validateUserAnimationId(id) !== null && existsSync(join(this.options.animationsDir, fileNameFor(id)))
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
    const result = this.queue.then(op)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
