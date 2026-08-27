/**
 * host service (ctx.provide('petween')) — the companion-facing registration
 * surface (L1).
 *
 * Unit level: createPetweenHostService over a real AnimationsStore in a
 * tmpdir. save() already validates the schema, enforces the `user:` id
 * namespace and persists atomically — the service must not weaken any of
 * that, so every rejection path is asserted with its error code.
 *
 * Entry level: src/index.ts provides the service once every route
 * registration succeeded (see plugin-entry.test.ts for the mount-once flag
 * interplay); here we only pin the provided shape so companions can code
 * against `inject: ['petween']`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index'
import { AnimationsStore, AnimationError } from '../../src/host/animations'
import { createPetweenHostService, type PetweenHostService } from '../../src/host/service'
import type { AnimationDefinition } from '../../src/motion/animation-definition'

const MOUNT_FLAG = Symbol.for('petween/host')

let dir: string | undefined

afterEach(async () => {
  ;(globalThis as Record<symbol, unknown>)[MOUNT_FLAG] = undefined
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

const makeStore = (): AnimationsStore => {
  // `dir` is assigned by the caller via withDir() below before the store is used.
  return new AnimationsStore({ animationsDir: join(dir!, 'animations') })
}

const makeTransition = (id: string): AnimationDefinition => ({
  version: 1,
  id,
  name: 'Companion Wall Bounce',
  kind: 'transition',
  durationMs: 240,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1 },
        { at: 1, value: 1 },
      ],
    },
  ],
  events: [{ at: 0.5, type: 'pose-swap' }],
})

describe('createPetweenHostService', () => {
  it('persists a valid definition into the shared library', async () => {
    dir = await mkdtemp(join(tmpdir(), 'petween-service-'))
    const store = makeStore()
    const service = createPetweenHostService(store)

    await service.registerAnimation(makeTransition('user:motion-run-wall-bounce'))

    const { customs, warnings } = await store.loadAll()
    expect(warnings).toEqual([])
    expect(customs.map((entry) => entry.id)).toEqual(['user:motion-run-wall-bounce'])
  })

  it('rejects schema violations with INVALID_DEFINITION', async () => {
    dir = await mkdtemp(join(tmpdir(), 'petween-service-'))
    const service = createPetweenHostService(makeStore())
    const broken = makeTransition('user:broken')
    // Keyframe times are normalized 0..1 — an `at` beyond 1 must be rejected.
    broken.tracks[0]!.keyframes[0]!.at = 1.5

    await expect(service.registerAnimation(broken)).rejects.toMatchObject({
      name: 'AnimationError',
      code: 'INVALID_DEFINITION',
    })
    expect((await makeStore().loadAll()).customs).toEqual([])
  })

  it("rejects ids outside the user: namespace (builtin:, pack:, bare)", async () => {
    dir = await mkdtemp(join(tmpdir(), 'petween-service-'))
    const service = createPetweenHostService(makeStore())

    for (const id of ['builtin:wall-bounce', 'pack:wall-bounce', 'wall-bounce']) {
      await expect(service.registerAnimation(makeTransition(id))).rejects.toBeInstanceOf(AnimationError)
    }
  })

  it('re-registering the same id overwrites in place (idempotent installs)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'petween-service-'))
    const store = makeStore()
    const service = createPetweenHostService(store)

    const first = makeTransition('user:motion-run-wall-bounce')
    first.durationMs = 200
    await service.registerAnimation(first)
    const second = makeTransition('user:motion-run-wall-bounce')
    second.durationMs = 320
    await service.registerAnimation(second)

    const { customs } = await store.loadAll()
    expect(customs).toHaveLength(1)
    expect(customs[0]!.durationMs).toBe(320)
  })

  it('hasAnimation reports library membership (first-install guard)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'petween-service-'))
    const service = createPetweenHostService(makeStore())

    await expect(service.hasAnimation('user:motion-run-wall-bounce')).resolves.toBe(false)
    await service.registerAnimation(makeTransition('user:motion-run-wall-bounce'))
    await expect(service.hasAnimation('user:motion-run-wall-bounce')).resolves.toBe(true)
    await expect(service.hasAnimation('user:other')).resolves.toBe(false)
  })

  it('pack isolation: a pack-scoped register cannot leave user:<pack>- (2026-08-27)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'petween-service-'))
    const store = makeStore()
    const service = createPetweenHostService(store)

    // the user's hand-made entry (or another pack's) is structurally out of reach
    await service.registerAnimation(makeTransition('user:hand-made'))
    await expect(service.registerAnimation(makeTransition('user:hand-made'), { pack: 'physics' })).rejects.toThrow(
      'outside the user:physics- namespace',
    )
    await expect(service.registerAnimation(makeTransition('user:other-pack-thing'), { pack: 'physics' })).rejects.toThrow(
      'outside the user:physics- namespace',
    )
    await expect(
      service.registerAnimation(makeTransition('user:physics-bounce'), { pack: 'not valid!' }),
    ).rejects.toThrow('invalid pack id')

    await expect(service.registerAnimation(makeTransition('user:physics-bounce'), { pack: 'physics' })).resolves.toBeUndefined()
    const { customs } = await store.loadAll()
    expect(customs.map((entry) => entry.id).sort()).toEqual(['user:hand-made', 'user:physics-bounce'])
  })
})

describe('host entry provides the service', () => {
  type EffectCallback = () => (() => void) | void

  const makeCtx = (): { ctx: Context; provides: { name: string; value: unknown }[] } => {
    const provides: { name: string; value: unknown }[] = []
    const ctx = {
      effect: (callback: EffectCallback): (() => void) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => undefined
      },
      on: (): (() => void) => () => undefined,
      provide: (name: string, value: unknown): (() => void) => {
        provides.push({ name, value })
        return () => {
          const index = provides.findIndex((entry) => entry.name === name)
          if (index !== -1) provides.splice(index, 1)
        }
      },
      webServer: {
        register: (): (() => void) => () => undefined,
      },
    }
    return { ctx: ctx as unknown as Context, provides }
  }

  it("provides 'petween' with the v1 shape", () => {
    const { ctx, provides } = makeCtx()
    apply(ctx)

    expect(provides.map((entry) => entry.name)).toEqual(['petween'])
    const service = provides[0]!.value as PetweenHostService
    expect(service.version).toBe(1)
    expect(typeof service.registerAnimation).toBe('function')
  })
})
