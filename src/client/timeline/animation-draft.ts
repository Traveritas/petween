/**
 * client/timeline/animation-draft.ts — the animation-editor draft model
 * shared by the settings editor's AnimationLibrary panel and the standalone
 * animator workbench (/petween-animator/, V1.2): the editable DraftState
 * (scalar fields + structured tracks/events), assembly + real-schema
 * validation (evaluateDraft), the pristine-baseline dirty check
 * (draftDivergesFromBaseline), kind-switch normalization, and the built-in
 * definition list both library views show. Pure functions only — no React,
 * no fetching; each host owns its draft state and calls into these.
 */
import { BUILTIN_AMBIENT_DEFINITIONS } from '../../core/ambient-presets'
import { BUILTIN_INTERACTION_DEFINITIONS, BUILTIN_TRANSITION_DEFINITIONS } from '../../core/transition-presets'
import type {
  AnimationDefinition,
  AnimationKind,
  MotionTrack,
  RepeatPolicy,
  TimelineEvent,
} from '../../motion/animation-definition'
import { validateAnimationDefinition } from '../../motion/animation-definition'
import { MOTION_PROPERTIES } from '../../motion/motion-properties'
import { addTrack } from './timeline-model'

/** Every built-in definition, mirroring what the sessions register. */
export const BUILTIN_DEFINITIONS: readonly AnimationDefinition[] = [
  ...BUILTIN_TRANSITION_DEFINITIONS,
  ...BUILTIN_AMBIENT_DEFINITIONS,
  ...BUILTIN_INTERACTION_DEFINITIONS,
]

export const KIND_LABELS: Record<AnimationKind, string> = {
  transition: '过渡',
  ambient: '循环动画',
  interaction: '互动',
}

export const KIND_OPTIONS: ReadonlyArray<{ value: AnimationKind; label: string }> = [
  { value: 'transition', label: '过渡 transition' },
  { value: 'ambient', label: '循环动画 ambient' },
  { value: 'interaction', label: '互动 interaction' },
]

export const REPEAT_MODE_OPTIONS: ReadonlyArray<{ value: RepeatPolicy['mode']; label: string }> = [
  { value: 'once', label: '单次' },
  { value: 'loop', label: '循环' },
  { value: 'alternate', label: '往返' },
  { value: 'random-interval', label: '随机间隔' },
]

/** Debounce for the 循环试播 auto-replay after an edit. */
export const AUTO_REPLAY_DELAY_MS = 600

/** A guaranteed-valid starting point for 新建 (one squash track + pose-swap). */
export function newAnimationTemplate(): AnimationDefinition {
  return {
    version: 1,
    id: `user:${crypto.randomUUID()}`,
    name: '新建动画',
    kind: 'transition',
    durationMs: 300,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.scaleY',
        keyframes: [
          { at: 0, value: 1 },
          { at: 0.45, value: { base: 1, parameter: 'strength', amount: -0.25 }, easing: 'anticipate' },
          { at: 1, value: 1 },
        ],
      },
    ],
    events: [{ at: 0.45, type: 'pose-swap' }],
    parameters: { strength: { default: 1, min: 0, max: 3 } },
  }
}

/** The editable draft: scalar fields plus structured tracks/events. */
export interface DraftState {
  name: string
  kind: AnimationKind
  durationMs: number
  repeatMode: RepeatPolicy['mode']
  repeatMinMs: number
  repeatMaxMs: number
  tracks: MotionTrack[]
  events: TimelineEvent[]
}

export function draftFrom(definition: AnimationDefinition): DraftState {
  const repeat = definition.repeat
  return {
    name: definition.name,
    kind: definition.kind,
    durationMs: definition.durationMs,
    repeatMode: repeat.mode,
    repeatMinMs: repeat.mode === 'random-interval' ? repeat.minDelayMs : 800,
    repeatMaxMs: repeat.mode === 'random-interval' ? repeat.maxDelayMs : 1300,
    tracks: structuredClone(definition.tracks),
    events: structuredClone(definition.events ?? []),
  }
}

export interface DraftEvaluation {
  /** The assembled definition; null while any field or timeline part is schema-invalid. */
  definition: AnimationDefinition | null
  errors: string[]
}

/** Assemble the draft into a candidate and run the real schema validation. */
export function evaluateDraft(
  baseId: string,
  parameters: AnimationDefinition['parameters'],
  draft: DraftState,
): DraftEvaluation {
  const repeat: RepeatPolicy =
    draft.repeatMode === 'random-interval'
      ? { mode: 'random-interval', minDelayMs: draft.repeatMinMs, maxDelayMs: draft.repeatMaxMs }
      : { mode: draft.repeatMode }
  // version/id are immutable; parameters (strength range) are preserved from
  // the base definition. An empty events list is omitted from the payload.
  const candidate: Record<string, unknown> = {
    version: 1,
    id: baseId,
    name: draft.name,
    kind: draft.kind,
    durationMs: draft.durationMs,
    repeat,
    tracks: draft.tracks,
    ...(draft.events.length > 0 ? { events: draft.events } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  }
  const result = validateAnimationDefinition(candidate)
  if (!result.valid) return { definition: null, errors: result.errors }
  return { definition: candidate as unknown as AnimationDefinition, errors: [] }
}

/**
 * UX-2 dirty check, run on the ASSEMBLED definitions (exactly what a save
 * would persist). A raw DraftState comparison would flag repeatMinMs/MaxMs
 * leftovers — e.g. a custom interval from an earlier random-interval setting
 * that a non-random-interval save legitimately drops (evaluateDraft omits
 * them) — and keep the ● marker on forever after such a save. An invalid
 * draft (null assembly) always counts as dirty so the unsaved-edit guards
 * stay armed.
 */
export function draftDivergesFromBaseline(
  selected: AnimationDefinition,
  assembled: AnimationDefinition | null,
): boolean {
  if (assembled === null) return true
  const baseline = evaluateDraft(selected.id, selected.parameters, draftFrom(selected)).definition
  return baseline === null || JSON.stringify(assembled) !== JSON.stringify(baseline)
}

/**
 * Kind switches normalize event rules AND the track set so a valid draft
 * stays editable: ambient timelines may keep no transition-layer track (the
 * schema rejects them — enter/click own that DOM layer), and an emptied-out
 * ambient is reseeded with a default loop. Pose-swap rules convert in BOTH
 * directions: → interaction keeps the timing but names a target (idle —
 * retarget in the inspector), → transition strips targets and truncates to
 * the exactly-one anonymous swap.
 */
export function normalizeKindSwitch(draft: DraftState, kind: AnimationKind): DraftState {
  if (draft.kind === kind) return draft
  let events = draft.events
  let tracks = draft.tracks
  if (kind === 'ambient') {
    events = []
    tracks = tracks.filter((track) => MOTION_PROPERTIES[track.property].targetLayer !== 'transition')
    if (tracks.length === 0) tracks = addTrack([], 'sway.rotation').tracks
  }
  if (kind === 'interaction') {
    // Interaction swaps are legal only with a named target; the timing
    // the author tuned on the transition survives the switch.
    events = events.map((event) =>
      event.type === 'pose-swap' && event.pose === undefined ? { ...event, pose: 'idle' } : event,
    )
  }
  if (kind === 'transition') {
    // Keep the FIRST pose-swap's timing, drop extras, strip the target:
    // the enter pose is state-machine-owned (schema forbids "pose").
    let keptSwap = false
    events = events.filter((event) => {
      if (event.type !== 'pose-swap') return true
      if (keptSwap) return false
      keptSwap = true
      return true
    })
    events = events.map((event) => (event.type === 'pose-swap' ? { at: event.at, type: 'pose-swap' } : event))
    if (!keptSwap) events = [...events, { at: 0.5, type: 'pose-swap' }]
  }
  const repeatMode = events.length > 0 && draft.repeatMode === 'alternate' ? 'once' : draft.repeatMode
  return { ...draft, kind, events, repeatMode, tracks }
}
