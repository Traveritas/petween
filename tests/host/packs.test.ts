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

  it('rejects the reserved client preview draft id (user:0draft) up front', () => {
    // The id is a legal custom-namespace shape, so without this guard it
    // passed pack validation and only the store's write path refused — after
    // earlier writes of the same import had already landed on disk.
    const result = validateMotionPack(makePack({ namespace: 'user', animations: [makeDefinition('user:0draft')] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('user:0draft')
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

  it('a remap yields to ids the pack itself requests (no duplicate writes)', () => {
    // Library: manga:pop holds DIFFERENT content; manga:pop-2 is free — but
    // the pack requests it too. The contract imports a library-free requested
    // id VERBATIM, so the remap must skip -2 and land on -3. (Before the
    // taken-set fix this planned two writes to manga:pop-2 — the second
    // silently overwriting the first, both entries reporting success.)
    const existing = new Map<string, AnimationDefinition>([['manga:pop', enter(240)]])
    const result = planMotionPackImport(validated([enter(500), makeDefinition('manga:pop-2')]), existing)
    expect(result.entries).toEqual([
      { requestedId: 'manga:pop', finalId: 'manga:pop-3', status: 'remapped' },
      { requestedId: 'manga:pop-2', finalId: 'manga:pop-2', status: 'imported' },
    ])
    const writtenIds = result.writes.map((definition) => definition.id)
    expect(new Set(writtenIds).size).toBe(writtenIds.length) // never write an id twice
  })

  it('exhausting the -N range falls back to a hash suffix that never collides', () => {
    const existing = new Map<string, AnimationDefinition>([['manga:pop', enter(240)]])
    for (let attempt = 2; attempt < 102; attempt += 1) {
      existing.set(`manga:pop-${attempt}`, makeDefinition(`manga:pop-${attempt}`))
    }
    const result = planMotionPackImport(validated([enter(500)]), existing)
    expect(result.entries[0]?.status).toBe('remapped')
    const finalId = result.entries[0]?.finalId ?? ''
    expect(existing.has(finalId)).toBe(false)
    expect(result.writes).toHaveLength(1)
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

  it('re-importing a conflicting pack reuses the identical -N copy instead of piling up another', () => {
    // First import: manga:pop is taken by DIFFERENT content → remapped to -2.
    const first = planMotionPackImport(validated([enter(500)]), new Map([['manga:pop', enter(240)]]))
    expect(first.entries[0]).toEqual({ requestedId: 'manga:pop', finalId: 'manga:pop-2', status: 'remapped' })
    // Second import of the same conflicting pack: the library now holds the
    // identical -2 copy — report identical, plan no write (no -3 pile-up).
    const existing = new Map<string, AnimationDefinition>([
      ['manga:pop', enter(240)],
      ['manga:pop-2', enter(500)],
    ])
    const second = planMotionPackImport(validated([enter(500)]), existing)
    expect(second.entries[0]).toEqual({ requestedId: 'manga:pop', finalId: 'manga:pop-2', status: 'identical' })
    expect(second.writes).toHaveLength(0)
  })

  it('a taken -N suffix holding DIFFERENT content still advances to the next free suffix', () => {
    const existing = new Map<string, AnimationDefinition>([
      ['manga:pop', enter(240)],
      ['manga:pop-2', enter(300)],
    ])
    const result = planMotionPackImport(validated([enter(500)]), existing)
    expect(result.entries[0]).toEqual({ requestedId: 'manga:pop', finalId: 'manga:pop-3', status: 'remapped' })
    expect(result.writes[0]?.id).toBe('manga:pop-3')
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
