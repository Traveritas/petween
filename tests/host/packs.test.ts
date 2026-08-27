/**
 * host/packs.ts unit tests (P2 Motion Pack): manifest validation (structure,
 * B1 version seam, namespace discipline, mount kind-checking), the collision
 * planner (import / identical / remap + mount rewriting) and export building.
 */
import { describe, expect, it } from 'vitest'
import type { AnimationDefinition } from '../../src/motion/animation-definition'
import {
  MIXED_NAMESPACE,
  buildMotionPackExport,
  planMotionPackImport,
  validateMotionPack,
} from '../../src/host/packs'

function makeDefinition(id: string, overrides: Record<string, unknown> = {}): AnimationDefinition {
  return {
    version: 1,
    id,
    name: `Anim ${id}`,
    kind: 'interaction',
    durationMs: 200,
    repeat: { mode: 'once' },
    tracks: [
      {
        property: 'transition.rotation',
        keyframes: [
          { at: 0, value: 0 },
          { at: 1, value: 12 },
        ],
      },
    ],
    ...overrides,
  } as AnimationDefinition
}

function makePack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'motion-pack',
    version: 1,
    name: '测试包',
    namespace: 'manga',
    animations: [makeDefinition('manga:pop'), makeDefinition('manga:sway')],
    ...overrides,
  }
}

describe('validateMotionPack', () => {
  it('accepts a well-formed pack and normalizes the name', () => {
    const result = validateMotionPack(makePack({ name: '  弹跳包  ' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.pack.name).toBe('弹跳包')
  })

  it('rejects structure problems with field-level errors', () => {
    for (const broken of [
      'not an object',
      makePack({ format: 'pet-pack' }),
      makePack({ version: 2 }),
      makePack({ name: '' }),
      makePack({ namespace: 'builtin' }),
      makePack({ namespace: 'NotLower' }),
      makePack({ animations: [] }),
    ]) {
      const result = validateMotionPack(broken)
      expect(result.ok, JSON.stringify(broken)).toBe(false)
    }
    const newer = validateMotionPack(makePack({ version: 3 }))
    expect(newer.ok).toBe(false)
    if (!newer.ok) expect(newer.errors.join(' ')).toContain('newer petween')
  })

  it('enforces the pack namespace on every definition and rejects duplicates', () => {
    const foreign = validateMotionPack(makePack({ animations: [makeDefinition('user:pop')] }))
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) expect(foreign.errors.join(' ')).toContain('outside the pack namespace')

    const duplicate = validateMotionPack(
      makePack({ animations: [makeDefinition('manga:pop'), makeDefinition('manga:pop')] }),
    )
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.errors.join(' ')).toContain('duplicate id')

    // 'mixed' keeps per-definition namespaces (what export produces).
    expect(validateMotionPack(makePack({ namespace: MIXED_NAMESPACE })).ok).toBe(true)
  })

  it('validates mounts: known slots, pack-internal ids, kind discipline', () => {
    const enter = {
      ...makeDefinition('manga:enter'),
      kind: 'transition',
      durationMs: 240,
      events: [{ at: 0.5, type: 'pose-swap' }],
    } as AnimationDefinition
    // Ambient definitions may not touch the transition layer (schema rule) —
    // sway is the canonical ambient channel.
    const loop: AnimationDefinition = {
      ...makeDefinition('manga:loop'),
      kind: 'ambient',
      durationMs: 900,
      repeat: { mode: 'loop' },
      tracks: [
        {
          property: 'sway.rotation',
          keyframes: [
            { at: 0, value: -2 },
            { at: 1, value: 2 },
          ],
        },
      ],
    }
    const ok = validateMotionPack(makePack({ animations: [enter, loop], mounts: { idle: { enter: 'manga:enter', ambient: 'manga:loop' } } }))
    expect(ok.ok).toBe(true)

    for (const broken of [
      { flying: { enter: 'manga:pop' } }, // unknown slot
      { idle: { enter: 'user:elsewhere' } }, // outside the pack
      { idle: { enter: 'manga:pop' } }, // interaction kind, enter needs transition
    ]) {
      const result = validateMotionPack(makePack({ mounts: broken }))
      expect(result.ok, JSON.stringify(broken)).toBe(false)
    }
  })
})

describe('planMotionPackImport', () => {
  const enter = (durationMs: number): AnimationDefinition =>
    ({ ...makeDefinition('manga:pop'), kind: 'transition', durationMs, events: [{ at: 0.5, type: 'pose-swap' }] }) as AnimationDefinition
  const sway = () => makeDefinition('manga:sway')
  /** Validate a fixture pack or throw — tests only ever plan valid packs. */
  const validated = (animations: AnimationDefinition[], mounts?: Record<string, unknown>) => {
    const result = validateMotionPack(makePack({ animations, ...(mounts === undefined ? {} : { mounts }) }))
    if (!result.ok) throw new Error(`fixture pack must validate: ${result.errors.join('; ')}`)
    return result.pack
  }

  it('imports free ids verbatim and resolves mounts to their final ids', () => {
    const result = planMotionPackImport(validated([enter(240), sway()], { idle: { enter: 'manga:pop' } }), new Map())
    expect(result.entries).toEqual([
      { requestedId: 'manga:pop', finalId: 'manga:pop', status: 'imported' },
      { requestedId: 'manga:sway', finalId: 'manga:sway', status: 'imported' },
    ])
    expect(result.writes.map((definition) => definition.id)).toEqual(['manga:pop', 'manga:sway'])
    expect(result.mounts).toEqual({ idle: { enter: 'manga:pop' } })
    expect(result.warnings).toEqual([])
  })

  it('identical content is skipped (idempotent re-import)', () => {
    const existing = new Map<string, AnimationDefinition>([['manga:pop', enter(240)]])
    const result = planMotionPackImport(validated([enter(240), sway()]), existing)
    expect(result.entries[0]).toEqual({ requestedId: 'manga:pop', finalId: 'manga:pop', status: 'identical' })
    expect(result.writes.some((definition) => definition.id === 'manga:pop')).toBe(false)
  })

  it('different content under a taken id remaps to -2 and REWRITES the mount reference', () => {
    const existing = new Map<string, AnimationDefinition>([['manga:pop', enter(240)]])
    const result = planMotionPackImport(validated([enter(500), sway()], { idle: { enter: 'manga:pop' } }), existing)
    expect(result.entries[0]).toEqual({ requestedId: 'manga:pop', finalId: 'manga:pop-2', status: 'remapped' })
    expect(result.writes[0]?.id).toBe('manga:pop-2')
    expect(result.writes[0]?.durationMs).toBe(500)
    expect(result.mounts).toEqual({ idle: { enter: 'manga:pop-2' } })
  })

  it('a valid pack plans cleanly: mount warnings only fire on defensive dead paths', () => {
    // validateMotionPack rejects mounts naming non-pack animations, so the
    // planner's dangling-mount warning is defense in depth — a valid pack
    // must always plan with zero warnings.
    const existing = new Map<string, AnimationDefinition>([['manga:pop', sway()]])
    const result = planMotionPackImport(validated([enter(240)], { idle: { enter: 'manga:pop' } }), existing)
    expect(result.warnings).toEqual([])
    expect(result.entries).toHaveLength(1)
  })
})

describe('buildMotionPackExport', () => {
  it('uses the shared namespace, or mixed across namespaces; never carries mounts', () => {
    const same = buildMotionPackExport('同域', [makeDefinition('user:a'), makeDefinition('user:b')])
    expect(same.namespace).toBe('user')
    const mixed = buildMotionPackExport('', [makeDefinition('user:a'), makeDefinition('manga:b')])
    expect(mixed.namespace).toBe(MIXED_NAMESPACE)
    expect(mixed.name).toBe('Motion Pack') // blank name falls back
    expect(mixed.mounts).toBeUndefined()
    expect(mixed.animations).toHaveLength(2)
  })
})
