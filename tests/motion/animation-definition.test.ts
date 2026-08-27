/**
 * AnimationDefinition schema validation (spec §29.0): illegal property / at /
 * easing / repeat / duration / id are all rejected, by hand-written rules.
 */
import { describe, expect, it } from 'vitest'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import { parseEasing, validateAnimationDefinition } from '../../src/motion/animation-definition'
import { compileTimeline } from '../../src/motion/timeline-compiler'
import { BUILTIN_AMBIENT_DEFINITIONS } from '../../src/core/ambient-presets'
import { BUILTIN_TRANSITION_DEFINITIONS } from '../../src/core/transition-presets'

const validDefinition = (): AnimationDefinition => ({
  version: 1,
  id: 'user:test-pop',
  name: 'Test Pop',
  kind: 'transition',
  durationMs: 200,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1 },
        { at: 1, value: 1.2 },
      ],
    },
  ],
  events: [{ at: 0.5, type: 'pose-swap' }],
})

const errorsOf = (definition: unknown): string[] => {
  const result = validateAnimationDefinition(definition)
  return result.valid ? [] : result.errors
}

describe('validateAnimationDefinition', () => {
  it('accepts a minimal valid definition', () => {
    expect(validateAnimationDefinition(validDefinition())).toEqual({ valid: true })
  })

  it('accepts every built-in definition (data integrity)', () => {
    for (const definition of [...BUILTIN_TRANSITION_DEFINITIONS, ...BUILTIN_AMBIENT_DEFINITIONS]) {
      expect(errorsOf(definition), definition.id).toEqual([])
    }
  })

  it('rejects unknown motion properties', () => {
    const definition = validDefinition()
    definition.tracks[0].property = 'transition.color' as never
    expect(errorsOf(definition).join()).toContain('unknown motion property')
    definition.tracks[0].property = 'transform' as never
    expect(errorsOf(definition).join()).toContain('unknown motion property')
  })

  it('rejects keyframe at outside 0..1', () => {
    const definition = validDefinition()
    definition.tracks[0].keyframes[1].at = 1.5
    expect(errorsOf(definition).join()).toContain('0..1')
    definition.tracks[0].keyframes[1].at = -0.1
    expect(errorsOf(definition).join()).toContain('0..1')
  })

  it('rejects a track with zero keyframes', () => {
    const definition = validDefinition()
    definition.tracks[0].keyframes = []
    expect(errorsOf(definition).join()).toContain('at least 1 keyframe')
  })

  it('rejects invalid easings and accepts aliases and cubic-bezier', () => {
    const definition = validDefinition()
    definition.tracks[0].keyframes[0].easing = 'banana' as never
    expect(errorsOf(definition).join()).toContain('unknown easing')

    definition.tracks[0].keyframes[0].easing = 'spring-snappy'
    expect(errorsOf(definition)).toEqual([])

    definition.tracks[0].keyframes[0].easing = 'cubic-bezier(0.34,1.56,0.64,1)'
    expect(errorsOf(definition)).toEqual([])

    // CSS requires bezier x values within 0..1
    definition.tracks[0].keyframes[0].easing = 'cubic-bezier(1.5,0,0,1)' as never
    expect(errorsOf(definition).join()).toContain('unknown easing')
  })

  it('rejects illegal repeat policies', () => {
    const definition = validDefinition()
    definition.repeat = { mode: 'warp' } as never
    expect(errorsOf(definition).join()).toContain('unknown repeat mode')

    definition.repeat = { mode: 'random-interval', minDelayMs: 1000, maxDelayMs: 100 }
    expect(errorsOf(definition).join()).toContain('random-interval')

    definition.repeat = { mode: 'random-interval', minDelayMs: 100, maxDelayMs: 1000 }
    expect(errorsOf(definition)).toEqual([])
  })

  it('rejects out-of-range durationMs', () => {
    const definition = validDefinition()
    definition.durationMs = 0
    expect(errorsOf(definition).join()).toContain('durationMs')
    definition.durationMs = 120_000
    expect(errorsOf(definition).join()).toContain('durationMs')
  })

  it('rejects malformed ids', () => {
    const definition = validDefinition()
    definition.id = 'Comic Pop'
    expect(errorsOf(definition).join()).toContain('"id"')
    definition.id = 'builtin:comic-pop'
    expect(errorsOf(definition)).toEqual([])
  })

  it('rejects unknown ParameterizedValue parameters', () => {
    const definition = validDefinition()
    definition.tracks[0].keyframes[1].value = { base: 1, parameter: 'power', amount: 2 } as never
    expect(errorsOf(definition).join()).toContain('ParameterizedValue')
  })

  it('rejects unknown event types and event at outside 0..1', () => {
    const definition = validDefinition()
    definition.events = [{ at: 0.5, type: 'sound' as never }]
    expect(errorsOf(definition).join()).toContain('pose-swap')
    definition.events = [{ at: 1.2, type: 'pose-swap' }]
    expect(errorsOf(definition).join()).toContain('0..1')
  })

  it('rejects duplicate tracks for the same property (the compiler only reads the first)', () => {
    const definition = validDefinition()
    definition.tracks.push({
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1 },
        { at: 1, value: 0.5 },
      ],
    })
    expect(errorsOf(definition).join()).toContain('duplicate track for "transition.scaleX"')
  })

  it('enforces event cardinality: transitions exactly 1 pose-swap, ambient none', () => {
    const transition = validDefinition()
    transition.events = []
    expect(errorsOf(transition).join()).toContain('exactly 1 pose-swap')
    transition.events = [
      { at: 0.3, type: 'pose-swap' },
      { at: 0.7, type: 'pose-swap' },
    ]
    expect(errorsOf(transition).join()).toContain('exactly 1 pose-swap')

    const ambient: AnimationDefinition = { ...validDefinition(), kind: 'ambient', events: [{ at: 0.5, type: 'pose-swap' }] }
    expect(errorsOf(ambient).join()).toContain('must not declare events')

    // 2026-08-27: interactions MAY swap poses, but every swap must name its
    // target (resolved at play time); transitions must not name one (the
    // enter pose is state-machine-owned).
    const anonymousInteraction: AnimationDefinition = {
      ...validDefinition(),
      kind: 'interaction',
      events: [{ at: 0.5, type: 'pose-swap' }],
    }
    expect(errorsOf(anonymousInteraction).join()).toContain('must declare its "pose" target')

    const targetedInteraction: AnimationDefinition = {
      ...validDefinition(),
      kind: 'interaction',
      events: [{ at: 0.5, type: 'pose-swap', pose: 'user:doze-doze' }],
    }
    expect(errorsOf(targetedInteraction)).toEqual([])

    const badTargetInteraction: AnimationDefinition = {
      ...validDefinition(),
      kind: 'interaction',
      events: [{ at: 0.5, type: 'pose-swap', pose: 'not a valid id!' }],
    }
    expect(errorsOf(badTargetInteraction).join()).toContain('must be a builtin slot name')

    const namedTransition: AnimationDefinition = {
      ...validDefinition(),
      events: [{ at: 0.5, type: 'pose-swap', pose: 'user:doze-doze' }],
    }
    expect(errorsOf(namedTransition).join()).toContain('state-machine-owned')

    const eventlessInteraction: AnimationDefinition = { ...validDefinition(), kind: 'interaction', events: undefined }
    expect(errorsOf(eventlessInteraction)).toEqual([])
  })

  it('allows particle events on transitions and interactions, never on ambient (§8.5)', () => {
    const transition = validDefinition()
    transition.events = [
      { at: 0.5, type: 'pose-swap' },
      { at: 0.5, type: 'particle', effect: 'confetti' },
      { at: 0.8, type: 'particle', effect: 'sparkle' },
    ]
    expect(errorsOf(transition)).toEqual([])

    const interaction: AnimationDefinition = {
      ...validDefinition(),
      kind: 'interaction',
      events: [
        { at: 0, type: 'particle', effect: 'star-burst' },
        { at: 1, type: 'particle', effect: 'sparkle' },
      ],
    }
    expect(errorsOf(interaction)).toEqual([])

    const ambient: AnimationDefinition = {
      ...validDefinition(),
      kind: 'ambient',
      events: [{ at: 0.5, type: 'particle', effect: 'confetti' }],
    }
    expect(errorsOf(ambient).join()).toContain('must not declare events')

    // particles do not count towards the pose-swap cardinality either way
    const noSwap = validDefinition()
    noSwap.events = [{ at: 0.5, type: 'particle', effect: 'confetti' }]
    expect(errorsOf(noSwap).join()).toContain('exactly 1 pose-swap')
  })

  it('rejects unknown particle effects', () => {
    const definition = validDefinition()
    definition.events = [
      { at: 0.5, type: 'pose-swap' },
      { at: 0.6, type: 'particle', effect: 'fireworks' as never },
    ]
    expect(errorsOf(definition).join()).toContain('unknown particle effect')
  })

  it('rejects alternate repeat with events; eventless alternate stays legal', () => {
    const eventful = validDefinition()
    eventful.repeat = { mode: 'alternate' }
    expect(errorsOf(eventful).join()).toContain('"alternate" with events')

    const eventless: AnimationDefinition = {
      ...validDefinition(),
      kind: 'ambient',
      repeat: { mode: 'alternate' },
      events: undefined,
      tracks: [
        { property: 'sway.rotation', keyframes: [{ at: 0, value: -4 }, { at: 1, value: 4 }] },
      ],
    }
    expect(errorsOf(eventless)).toEqual([])
  })

  it('rejects duplicate "at" values inside one track', () => {
    const definition = validDefinition()
    definition.tracks[0].keyframes.push({ at: 1, value: 1.4 })
    expect(errorsOf(definition).join()).toContain('duplicate "at" 1')
  })

  it('requires random-interval minDelayMs >= 1 (no full-speed replay loop)', () => {
    const definition = validDefinition()
    definition.repeat = { mode: 'random-interval', minDelayMs: 0, maxDelayMs: 0 }
    expect(errorsOf(definition).join()).toContain('1 <= minDelayMs')
    definition.repeat = { mode: 'random-interval', minDelayMs: 1, maxDelayMs: 10 }
    expect(errorsOf(definition)).toEqual([])
  })

  it('keeps ambient definitions off the transition layer (enter/click own that DOM layer)', () => {
    const ambient: AnimationDefinition = { ...validDefinition(), kind: 'ambient', events: undefined }
    expect(errorsOf(ambient).join()).toContain('must not animate')

    // the motion layers are fine for ambient
    ambient.tracks[0].property = 'sway.rotation'
    expect(errorsOf(ambient)).toEqual([])
  })

  it('rejects same-layer tracks whose easings disagree on any interval', () => {
    const definition = validDefinition()
    definition.tracks = [
      {
        property: 'transition.scaleX',
        keyframes: [
          { at: 0, value: 1, easing: 'ease-out' },
          { at: 0.5, value: 1.2, easing: 'spring-soft' },
          { at: 1, value: 1 },
        ],
      },
      {
        property: 'transition.scaleY',
        keyframes: [
          { at: 0, value: 1, easing: 'ease-out' },
          { at: 0.5, value: 0.8, easing: 'overshoot' }, // disagrees at t=0.5
          { at: 1, value: 1 },
        ],
      },
    ]
    const errors = errorsOf(definition).join()
    expect(errors).toContain('layer "transition"')
    expect(errors).toContain('t=0.5')
  })

  it('accepts same-layer tracks when easings match, including mid-interval and alias equivalence', () => {
    const definition = validDefinition()
    definition.tracks = [
      {
        property: 'bounce.scaleX',
        keyframes: [
          { at: 0, value: 1, easing: 'ease-out' },
          { at: 1, value: 1.2 },
        ],
      },
      {
        property: 'bounce.scaleY',
        keyframes: [
          // ease-out as an explicit bezier (with spaces) resolves identically;
          // the extra keyframe at 0.6 falls inside scaleX's only interval,
          // whose ease-out must match
          { at: 0, value: 1, easing: 'cubic-bezier(0, 0, 0.58, 1)' },
          { at: 0.6, value: 0.9, easing: 'ease-out' },
          { at: 1, value: 1 },
        ],
      },
    ]
    expect(errorsOf(definition)).toEqual([])
  })

  it('ignores easing differences across different layers (they never merge)', () => {
    const definition = validDefinition()
    definition.tracks = [
      {
        property: 'transition.scaleX',
        keyframes: [
          { at: 0, value: 1, easing: 'ease-out' },
          { at: 1, value: 1.2 },
        ],
      },
      {
        property: 'bounce.scaleX',
        keyframes: [
          { at: 0, value: 1, easing: 'overshoot' },
          { at: 1, value: 1.2 },
        ],
      },
    ]
    expect(errorsOf(definition)).toEqual([])
  })

  it('rejects non-object input and wrong version', () => {
    expect(errorsOf(null).join()).toContain('object')
    expect(errorsOf({ ...validDefinition(), version: 2 }).join()).toContain('version')
  })
})

describe('parseEasing', () => {
  it('resolves named easings and semantic aliases', () => {
    expect(parseEasing('linear')).toEqual([0, 0, 1, 1])
    expect(parseEasing('ease-in-out')).toEqual([0.42, 0, 0.58, 1])
    expect(parseEasing('overshoot')).toEqual([0.34, 1.56, 0.64, 1])
    expect(parseEasing('anticipate')).not.toBeNull()
  })

  it('parses cubic-bezier and rejects garbage', () => {
    expect(parseEasing('cubic-bezier(0.34, 1.56, 0.64, 1)')).toEqual([0.34, 1.56, 0.64, 1])
    expect(parseEasing('cubic-bezier(2,0,0,1)')).toBeNull()
    expect(parseEasing('cubic-bezier(0,0,1)')).toBeNull()
    expect(parseEasing('steps(4)')).toBeNull()
  })
})

// Keeps the worked example in docs/motion-format.md honest: it must stay a
// valid, compilable definition. All four tracks share the transition layer,
// so they key on the same times and share one easing per interval (V1).
const DOC_EXAMPLE: AnimationDefinition = {
  version: 1,
  id: 'user:slam-land',
  name: 'Slam Land',
  kind: 'transition',
  durationMs: 320,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1 },
        { at: 0.3, value: { base: 1, parameter: 'strength', amount: 0.22 }, easing: 'anticipate' },
        { at: 0.55, value: { base: 1, parameter: 'strength', amount: -0.14 }, easing: 'overshoot' },
        { at: 0.8, value: { base: 1, parameter: 'strength', amount: 0.05 } },
        { at: 1, value: 1 },
      ],
    },
    {
      property: 'transition.scaleY',
      keyframes: [
        { at: 0, value: 1 },
        { at: 0.3, value: { base: 1, parameter: 'strength', amount: -0.24 }, easing: 'anticipate' },
        { at: 0.55, value: { base: 1, parameter: 'strength', amount: 0.18 }, easing: 'overshoot' },
        { at: 0.8, value: { base: 1, parameter: 'strength', amount: -0.04 } },
        { at: 1, value: 1 },
      ],
    },
    {
      property: 'transition.y',
      keyframes: [
        { at: 0, value: 0 },
        { at: 0.3, value: { base: 0, parameter: 'strength', amount: 6 }, easing: 'anticipate' },
        { at: 0.55, value: { base: 0, parameter: 'strength', amount: -12 }, easing: 'overshoot' },
        { at: 0.8, value: 0 },
        { at: 1, value: 0 },
      ],
    },
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 0 },
        { at: 0.3, value: 0, easing: 'anticipate' },
        { at: 0.55, value: { base: 0, parameter: 'strength', amount: -4 }, easing: 'overshoot' },
        { at: 0.8, value: { base: 0, parameter: 'strength', amount: 1.5 } },
        { at: 1, value: 0 },
      ],
    },
  ],
  events: [{ at: 0.42, type: 'pose-swap' }],
  parameters: { strength: { default: 1, min: 0, max: 1.8 } },
}

describe('docs/motion-format.md worked example', () => {
  it('is valid and compiles into two segments with the pose-swap at the boundary', () => {
    expect(validateAnimationDefinition(DOC_EXAMPLE)).toEqual({ valid: true })
    const compiled = compileTimeline(DOC_EXAMPLE, { params: { strength: 1 } })
    expect(compiled.segments).toHaveLength(2)
    expect(compiled.events).toEqual([{ at: 0.42, type: 'pose-swap', beforeSegmentIndex: 1 }])
  })
})
