/**
 * host/validation.ts — PetweenConfig schema enforcement (spec §7.7, §19.2)
 * plus small shared validators.
 *
 * One walker serves two modes:
 * - `repair` (config load, spec §18.3): never throws; every invalid known
 *   field falls back to the base config value, unknown fields are stripped,
 *   missing fields are filled from the base.
 * - `strict` (PUT /api/petween/config): same walk, but any invalid known
 *   field is collected as a field-path issue and reported via
 *   ConfigValidationError (→ HTTP 400). Unknown fields are still stripped
 *   rather than rejected (§19.2 "只接受 schema 中存在的字段").
 *
 * Numeric bounds: strength/duration/scale/anchor come from the spec; the
 * remaining ranges are internal sanity bounds, marked as such below.
 */
import type {
  AmbientConfig,
  BounceConfig,
  BreatheConfig,
  PetweenConfig,
  PoseAnchor,
  PoseConfig,
  PoseKey,
  StateAppearance,
  SwayConfig,
  TransitionPreset,
} from '../core/types'
import { POSE_KEYS, TRANSITION_DURATION_LIMITS, TRANSITION_STRENGTH_LIMITS } from '../core/types'
import { createDefaultPetweenConfig } from '../core/defaults'
import type { AnimationKind } from '../motion/animation-definition'
import { BUILTIN_TRANSITION_DEFINITIONS } from '../core/transition-presets'

export interface FieldIssue {
  path: string
  message: string
}

/** Strict-mode validation failure; carries every offending field path. */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError'
  constructor(readonly issues: FieldIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
  }
}

const TRANSITION_PRESETS: readonly TransitionPreset[] = [
  'global',
  'none',
  'soft',
  'comic-pop',
  'jelly',
  'jump',
  'snap',
  'flip',
  'celebrate',
  'deflate',
]
const GLOBAL_PRESETS = TRANSITION_PRESETS.filter(
  (preset): preset is Exclude<TransitionPreset, 'global'> => preset !== 'global',
)
const REDUCED_MOTION_VALUES = ['system', 'always', 'never'] as const
const TERMINAL_HOLD_VALUES = ['timed', 'until-interaction'] as const
const ACTIVITY_TRANSITION_VALUES = ['subtle', 'none', 'state'] as const

/** Known built-in enter-transition ids (§8.14): the preset definitions. */
const BUILTIN_TRANSITION_IDS: ReadonlySet<string> = new Set(BUILTIN_TRANSITION_DEFINITIONS.map((definition) => definition.id))
/** Shape mirror of host/animations.ts (kept local so validation stays fs-free). */
const USER_ANIMATION_ID_RE = /^user:[A-Za-z0-9][A-Za-z0-9_-]*$/
/** Shape mirror of host/pets.ts (kept local so validation stays fs-free). */
const PET_ID_RE = /^pet_[a-z0-9]+$/

interface Range {
  min: number
  max: number
}

// User-signed-off spec deviations (post-release feedback, widened bounds):
// scale 0.5..2 → 0.3..4, zoom 0.2..5 → 0.2..8, holds/periods/intervals
// 60000 → 120000ms, intervalMin 100 → 50ms, sway angle 0..45 → 0..60.
const SCALE_RANGE: Range = { min: 0.3, max: 4 }
const ANCHOR_RANGE: Range = { min: 0, max: 1 } // spec §7.3
// Internal sanity bounds (spec fixes no ranges for these):
const ZOOM_RANGE: Range = { min: 0.2, max: 8 }
const HOLD_RANGE: Range = { min: 0, max: 120_000 }
const AMBIENT_STRENGTH_RANGE: Range = { min: 0, max: 1.8 }
const AMBIENT_INTERVAL_RANGE: Range = { min: 50, max: 120_000 }
const BOUNCE_DURATION_RANGE: Range = { min: 50, max: 5_000 }
const SWAY_ANGLE_RANGE: Range = { min: 0, max: 60 }
const PERIOD_RANGE: Range = { min: 200, max: 120_000 }

type Mode = 'strict' | 'repair'

/** Optional injections for checks that need host state (custom animations on disk). */
export interface ConfigValidationOptions {
  /**
   * Kind lookup for `user:*` animation ids referenced by the config: mounts
   * are kind-checked at the interface (enter needs a transition, ambient
   * needs an ambient), so a wrong-kind id is rejected like a dangling one.
   * Undefined = the id is unknown; absent injection = shape-only validation.
   */
  animationLookup?: (id: string) => AnimationKind | undefined
}

interface Walk {
  mode: Mode
  issues: FieldIssue[]
  animationLookup?: (id: string) => AnimationKind | undefined
}

function fail(walk: Walk, path: string, message: string): void {
  if (walk.mode === 'strict') walk.issues.push({ path, message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce to a plain record; undefined means "absent, use fallback". */
function objectField(value: unknown, path: string, walk: Walk): Record<string, unknown> {
  if (value === undefined) return {}
  if (isRecord(value)) return value
  fail(walk, path, 'expected object')
  return {}
}

function booleanField(value: unknown, fallback: boolean, path: string, walk: Walk): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  fail(walk, path, 'expected boolean')
  return fallback
}

function numberField(
  value: unknown,
  fallback: number,
  path: string,
  walk: Walk,
  range?: Range,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(walk, path, 'expected number')
    return fallback
  }
  if (range !== undefined && (value < range.min || value > range.max)) {
    fail(walk, path, `expected ${range.min}..${range.max}`)
    return fallback
  }
  return value
}

function nullableNumberField(value: unknown, fallback: number | null, path: string, walk: Walk): number | null {
  if (value === undefined) return fallback
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(walk, path, 'expected number or null')
    return fallback
  }
  return value
}

function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  walk: Walk,
): T {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  fail(walk, path, `expected one of: ${allowed.join(', ')}`)
  return fallback
}

function stringField(value: unknown, fallback: string, path: string, walk: Walk): string {
  if (value === undefined) return fallback
  if (typeof value === 'string' && value.length > 0) return value
  fail(walk, path, 'expected non-empty string')
  return fallback
}

/** A PoseKey or explicit null (interactions.click.pose: null = no flash). */
function nullablePoseField(value: unknown, fallback: PoseKey | null, path: string, walk: Walk): PoseKey | null {
  if (value === undefined) return fallback
  if (value === null) return null
  if (typeof value === 'string' && (POSE_KEYS as readonly string[]).includes(value)) return value as PoseKey
  fail(walk, path, `expected one of: ${POSE_KEYS.join(', ')} or null`)
  return fallback
}

/**
 * activePetId (V1.1): a `pet_*` preset id or explicit null (unsaved edits).
 * Shape only — a dangling id (preset deleted out-of-band) is tolerated, the
 * client matches it against the pet list.
 */
function nullablePetIdField(value: unknown, fallback: string | null, path: string, walk: Walk): string | null {
  if (value === undefined) return fallback
  if (value === null) return null
  if (typeof value === 'string' && PET_ID_RE.test(value)) return value
  fail(walk, path, 'expected a "pet_<name>" id or null')
  return fallback
}

function anchorField(value: unknown, fallback: PoseAnchor, path: string, walk: Walk): PoseAnchor {
  const source = objectField(value, path, walk)
  return {
    x: numberField(source.x, fallback.x, `${path}.x`, walk, ANCHOR_RANGE),
    y: numberField(source.y, fallback.y, `${path}.y`, walk, ANCHOR_RANGE),
  }
}

function poseField(value: unknown, fallback: PoseConfig, path: string, walk: Walk): PoseConfig {
  // Whole pose absent → keep the base. A present pose object is authoritative:
  // an absent assetId means "no asset" (explicit null clears too), so a full
  // PUT behaves as a plain document replace.
  if (value === undefined) return { ...fallback, anchor: { ...fallback.anchor } }
  const source = objectField(value, path, walk)
  const pose: PoseConfig = {
    anchor: anchorField(source.anchor, fallback.anchor, `${path}.anchor`, walk),
    zoom: numberField(source.zoom, fallback.zoom, `${path}.zoom`, walk, ZOOM_RANGE),
  }
  if (typeof source.assetId === 'string') pose.assetId = source.assetId
  else if (source.assetId !== undefined && source.assetId !== null) fail(walk, `${path}.assetId`, 'expected string')
  return pose
}

/**
 * §8.14 animationId: `builtin:*` must name a known built-in transition,
 * `user:*` must exist on disk AND be transition-kind when a lookup is
 * injected (an enter without pose-swap would break the §12 swap invariant).
 * Invalid input records an issue (strict) or drops the field (repair → preset
 * semantics; the repair base never carries an animationId).
 */
function animationIdField(value: unknown, fallback: string | undefined, path: string, walk: Walk): string | undefined {
  if (value === undefined) return fallback
  if (value === null) return undefined // explicit clear, mirroring overlay.x / click.pose
  if (typeof value !== 'string' || value.length === 0) {
    fail(walk, path, 'expected non-empty string or null')
    return fallback
  }
  if (value.startsWith('builtin:')) {
    if (BUILTIN_TRANSITION_IDS.has(value)) return value
    fail(walk, path, `unknown built-in animation: ${value}`)
    return fallback
  }
  if (USER_ANIMATION_ID_RE.test(value)) {
    if (walk.animationLookup === undefined) return value
    const kind = walk.animationLookup(value)
    if (kind === 'transition') return value
    fail(walk, path, kind === undefined ? `unknown custom animation: ${value}` : `not a transition animation: ${value}`)
    return fallback
  }
  fail(walk, path, 'expected a builtin:* or user:* animation id')
  return fallback
}

/**
 * A per-state custom ambient reference: only persisted ambient-kind user
 * definitions are valid (a transition/interaction mounted here would never
 * loop as an ambient profile).
 */
function ambientAnimationIdField(
  value: unknown,
  fallback: string | undefined,
  path: string,
  walk: Walk,
): string | undefined {
  if (value === undefined) return fallback
  if (value === null) return undefined
  if (typeof value !== 'string' || !USER_ANIMATION_ID_RE.test(value)) {
    fail(walk, path, 'expected a user:* animation id or null')
    return fallback
  }
  if (walk.animationLookup === undefined) return value
  const kind = walk.animationLookup(value)
  if (kind === 'ambient') return value
  fail(walk, path, kind === undefined ? `unknown custom animation: ${value}` : `not an ambient animation: ${value}`)
  return fallback
}

function transitionField<T extends TransitionPreset>(
  value: unknown,
  fallback: { preset: T; strength: number; durationMs: number; animationId?: string },
  allowed: readonly T[],
  path: string,
  walk: Walk,
  allowAnimationId = false,
): { preset: T; strength: number; durationMs: number; animationId?: string } {
  const source = objectField(value, path, walk)
  const transition: { preset: T; strength: number; durationMs: number; animationId?: string } = {
    preset: enumField(source.preset, allowed, fallback.preset, `${path}.preset`, walk),
    strength: numberField(source.strength, fallback.strength, `${path}.strength`, walk, TRANSITION_STRENGTH_LIMITS),
    durationMs: numberField(source.durationMs, fallback.durationMs, `${path}.durationMs`, walk, TRANSITION_DURATION_LIMITS),
  }
  // State enters may reference a custom/builtin definition (§8.14); the
  // global transition stays preset-only, so the field is stripped there.
  if (allowAnimationId) {
    const animationId = animationIdField(source.animationId, fallback.animationId, `${path}.animationId`, walk)
    if (animationId !== undefined) transition.animationId = animationId
  }
  return transition
}

function bounceField(value: unknown, fallback: BounceConfig, path: string, walk: Walk): BounceConfig {
  const source = objectField(value, path, walk)
  const intervalMinMs = numberField(source.intervalMinMs, fallback.intervalMinMs, `${path}.intervalMinMs`, walk, AMBIENT_INTERVAL_RANGE)
  let intervalMaxMs = numberField(source.intervalMaxMs, fallback.intervalMaxMs, `${path}.intervalMaxMs`, walk, AMBIENT_INTERVAL_RANGE)
  if (intervalMinMs > intervalMaxMs) {
    fail(walk, `${path}.intervalMaxMs`, 'expected >= intervalMinMs')
    intervalMaxMs = intervalMinMs
  }
  return {
    enabled: booleanField(source.enabled, fallback.enabled, `${path}.enabled`, walk),
    strength: numberField(source.strength, fallback.strength, `${path}.strength`, walk, AMBIENT_STRENGTH_RANGE),
    intervalMinMs,
    intervalMaxMs,
    durationMs: numberField(source.durationMs, fallback.durationMs, `${path}.durationMs`, walk, BOUNCE_DURATION_RANGE),
  }
}

function swayField(value: unknown, fallback: SwayConfig, path: string, walk: Walk): SwayConfig {
  const source = objectField(value, path, walk)
  return {
    enabled: booleanField(source.enabled, fallback.enabled, `${path}.enabled`, walk),
    angleDeg: numberField(source.angleDeg, fallback.angleDeg, `${path}.angleDeg`, walk, SWAY_ANGLE_RANGE),
    periodMs: numberField(source.periodMs, fallback.periodMs, `${path}.periodMs`, walk, PERIOD_RANGE),
  }
}

function breatheField(value: unknown, fallback: BreatheConfig, path: string, walk: Walk): BreatheConfig {
  const source = objectField(value, path, walk)
  return {
    enabled: booleanField(source.enabled, fallback.enabled, `${path}.enabled`, walk),
    strength: numberField(source.strength, fallback.strength, `${path}.strength`, walk, AMBIENT_STRENGTH_RANGE),
    periodMs: numberField(source.periodMs, fallback.periodMs, `${path}.periodMs`, walk, PERIOD_RANGE),
  }
}

function ambientField(value: unknown, fallback: AmbientConfig, path: string, walk: Walk): AmbientConfig {
  const source = objectField(value, path, walk)
  const ambient: AmbientConfig = {
    bounce: bounceField(source.bounce, fallback.bounce, `${path}.bounce`, walk),
    sway: swayField(source.sway, fallback.sway, `${path}.sway`, walk),
    breathe: breatheField(source.breathe, fallback.breathe, `${path}.breathe`, walk),
  }
  const customAnimationId = ambientAnimationIdField(
    source.customAnimationId,
    fallback.customAnimationId,
    `${path}.customAnimationId`,
    walk,
  )
  if (customAnimationId !== undefined) ambient.customAnimationId = customAnimationId
  return ambient
}

function stateField(value: unknown, fallback: StateAppearance, path: string, walk: Walk): StateAppearance {
  const source = objectField(value, path, walk)
  return {
    pose: enumField(source.pose, POSE_KEYS, fallback.pose, `${path}.pose`, walk),
    enter: transitionField(source.enter, fallback.enter, TRANSITION_PRESETS, `${path}.enter`, walk, true),
    ambient: ambientField(source.ambient, fallback.ambient, `${path}.ambient`, walk),
  }
}

/** Walk a Record<PoseKey, V>; unknown keys are stripped, missing keys fall back. */
function poseRecordField<V>(
  value: unknown,
  base: Record<PoseKey, V>,
  walkField: (value: unknown, fallback: V, path: string, walk: Walk) => V,
  path: string,
  walk: Walk,
): Record<PoseKey, V> {
  const source = objectField(value, path, walk)
  const out = {} as Record<PoseKey, V>
  for (const key of POSE_KEYS) {
    out[key] = walkField(source[key], base[key], `${path}.${key}`, walk)
  }
  return out
}

function buildConfig(raw: unknown, base: PetweenConfig, mode: Mode, options: ConfigValidationOptions = {}): PetweenConfig {
  const walk: Walk = { mode, issues: [], animationLookup: options.animationLookup }
  const source = objectField(raw ?? undefined, '', walk)
  // Version handling is decided by loadConfig (spec §18.3); here the v1 tag
  // is only enforced, never migrated.
  if (source.version !== undefined && source.version !== 1) {
    fail(walk, 'version', 'unsupported version')
  }
  const globalSource = objectField(source.global, 'global', walk)
  const overlaySource = objectField(source.overlay, 'overlay', walk)
  const advancedSource = objectField(source.advanced, 'advanced', walk)
  const interactionsSource = objectField(source.interactions, 'interactions', walk)
  const clickSource = objectField(interactionsSource.click, 'interactions.click', walk)

  const config: PetweenConfig = {
    version: 1,
    enabled: booleanField(source.enabled, base.enabled, 'enabled', walk),
    global: {
      scale: numberField(globalSource.scale, base.global.scale, 'global.scale', walk, SCALE_RANGE),
      transition: transitionField(
        globalSource.transition,
        base.global.transition,
        GLOBAL_PRESETS,
        'global.transition',
        walk,
      ),
      reducedMotion: enumField(
        globalSource.reducedMotion,
        REDUCED_MOTION_VALUES,
        base.global.reducedMotion,
        'global.reducedMotion',
        walk,
      ),
      successHoldMs: numberField(globalSource.successHoldMs, base.global.successHoldMs, 'global.successHoldMs', walk, HOLD_RANGE),
      errorHoldMs: numberField(globalSource.errorHoldMs, base.global.errorHoldMs, 'global.errorHoldMs', walk, HOLD_RANGE),
    },
    poses: poseRecordField(source.poses, base.poses, poseField, 'poses', walk),
    states: poseRecordField(source.states, base.states, stateField, 'states', walk),
    overlay: {
      x: nullableNumberField(overlaySource.x, base.overlay.x, 'overlay.x', walk),
      y: nullableNumberField(overlaySource.y, base.overlay.y, 'overlay.y', walk),
    },
    advanced: {
      changePoseWithinActive: booleanField(
        advancedSource.changePoseWithinActive,
        base.advanced.changePoseWithinActive,
        'advanced.changePoseWithinActive',
        walk,
      ),
      activityTransition: enumField(
        advancedSource.activityTransition,
        ACTIVITY_TRANSITION_VALUES,
        base.advanced.activityTransition,
        'advanced.activityTransition',
        walk,
      ),
      terminalHold: enumField(
        advancedSource.terminalHold,
        TERMINAL_HOLD_VALUES,
        base.advanced.terminalHold,
        'advanced.terminalHold',
        walk,
      ),
      particles: booleanField(advancedSource.particles, base.advanced.particles, 'advanced.particles', walk),
    },
    interactions: {
      click: {
        // Shape only: the id's existence/kind is a client-side fallback concern.
        animation: stringField(
          clickSource.animation,
          base.interactions.click.animation,
          'interactions.click.animation',
          walk,
        ),
        pose: nullablePoseField(clickSource.pose, base.interactions.click.pose, 'interactions.click.pose', walk),
      },
    },
    activePetId: nullablePetIdField(source.activePetId, base.activePetId, 'activePetId', walk),
  }
  if (walk.issues.length > 0) throw new ConfigValidationError(walk.issues)
  return config
}

/** Lenient load-time repair (spec §18.3): never throws, always returns v1. */
export function repairConfig(raw: unknown, options: ConfigValidationOptions = {}): PetweenConfig {
  return buildConfig(raw, createDefaultPetweenConfig(), 'repair', options)
}

/**
 * Strict PUT validation (spec §19.2): unknown fields stripped, missing fields
 * filled from `base` (the current config), invalid known fields throw a
 * ConfigValidationError carrying field paths.
 */
export function validateConfigPatch(
  raw: unknown,
  base: PetweenConfig = createDefaultPetweenConfig(),
  options: ConfigValidationOptions = {},
): PetweenConfig {
  return buildConfig(raw, base, 'strict', options)
}

/** Asset ids are the first 16 hex chars of the content sha256 (host-generated). */
export function validateAssetId(id: unknown): string | null {
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : null
}
