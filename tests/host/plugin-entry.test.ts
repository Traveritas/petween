/**
 * Host entry (src/index.ts) mount-once flag: the flag is set only AFTER every
 * registration succeeded, so a mid-init failure cannot wedge later in-process
 * reloads behind a stale flag; a healthy second apply stays a no-op.
 *
 * The fake context mirrors the cordis semantics the entry relies on: the
 * effect body runs synchronously while the fiber is active and a synchronous
 * failure rethrows out of ctx.effect.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index'

// apply() runs the one-time home-dir migration (host/migrate.ts) against
// dshHomePath() BEFORE constructing stores. Point $DSH_HOME at a throwaway
// tmpdir so these tests can never touch (let alone move) real user data.
// dshHomePath reads the env on every call, so the per-file override sticks.
const PREVIOUS_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'petween-entry-'))
afterAll(() => {
  rmSync(process.env.DSH_HOME!, { recursive: true, force: true })
  if (PREVIOUS_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_DSH_HOME
})

const MOUNT_FLAG = Symbol.for('petween/host')

const ALL_ROUTES = [
  '/api/petween/meta', // B2 capability discovery (exact GET)
  '/api/petween/config',
  '/api/petween/assets',
  '/api/petween/animations', // exact GET
  '/api/petween/animations', // prefix PUT/DELETE
  '/api/petween/pets', // exact GET/POST
  '/api/petween/pets', // prefix GET/PUT/DELETE + apply
  '/petween-assets',
  '/petween-editor',
  '/api/petween/events',
  '/api/petween/state',
]

type EffectCallback = () => (() => void) | void

interface ProvidedService {
  name: string
  value: unknown
}

const makeCtx = (
  options: { failOnPath?: string } = {},
): { ctx: Context; routes: string[]; listeners: string[]; provides: ProvidedService[] } => {
  const routes: string[] = []
  const listeners: string[] = []
  const provides: ProvidedService[] = []
  const ctx = {
    effect: (callback: EffectCallback): (() => void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
    on: (name: string): (() => void) => {
      listeners.push(name)
      return () => undefined
    },
    provide: (name: string, value: unknown): (() => void) => {
      provides.push({ name, value })
      return () => {
        const index = provides.findIndex((entry) => entry.name === name)
        if (index !== -1) provides.splice(index, 1)
      }
    },
    webServer: {
      register: (route: { kind: string; path: string }): (() => void) => {
        if (route.path === options.failOnPath) throw new Error(`duplicate (${route.kind}, ${route.path}) registration`)
        routes.push(route.path)
        return () => {
          const index = routes.indexOf(route.path)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
  }
  return { ctx: ctx as unknown as Context, routes, listeners, provides }
}

afterEach(() => {
  ;(globalThis as Record<symbol, unknown>)[MOUNT_FLAG] = undefined
})

describe('host apply — mount-once flag', () => {
  it('registers routes + state channel; a second apply is a no-op', () => {
    const first = makeCtx()
    apply(first.ctx)
    expect(first.routes).toEqual(ALL_ROUTES)
    expect(first.listeners).toEqual(['session/event', 'agent/status', 'agent/error', 'session/disposed'])
    expect(first.provides.map((entry) => entry.name)).toEqual(['petween'])

    const second = makeCtx()
    apply(second.ctx)
    expect(second.routes).toHaveLength(0)
    expect(second.listeners).toHaveLength(0)
    expect(second.provides).toHaveLength(0)
  })

  it('migrates a legacy motion-pet home onto petween before any store loads', () => {
    const legacy = join(process.env.DSH_HOME!, 'motion-pet')
    const target = join(process.env.DSH_HOME!, 'petween')
    mkdirSync(join(legacy, 'assets'), { recursive: true })
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({ marker: 'real-user-data' }))
    writeFileSync(join(legacy, 'assets', 'a.webp'), Buffer.from([0x89, 0x50]))

    const { ctx } = makeCtx()
    apply(ctx)
    // Entry-level guarantee: the rename happened, content survived intact.
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe(JSON.stringify({ marker: 'real-user-data' }))
    expect(readFileSync(join(target, 'assets', 'a.webp'))).toEqual(Buffer.from([0x89, 0x50]))
    // Keep the isolated home clean for the tests that follow.
    rmSync(target, { recursive: true, force: true })
  })

  it('a mid-init failure releases the flag and rolls back: a retry mounts cleanly', () => {
    const failing = makeCtx({ failOnPath: '/api/petween/events' })
    expect(() => apply(failing.ctx)).toThrow(/duplicate/)
    // the config/asset routes registered before the throw were rolled back
    expect(failing.routes).toEqual([])
    // the service is provided last: a mid-init throw never advertises it
    expect(failing.provides).toEqual([])

    const retry = makeCtx()
    apply(retry.ctx)
    expect(retry.routes).toEqual(ALL_ROUTES)
  })

  it('the returned disposer unmounts and frees the flag for a later reload', () => {
    const first = makeCtx()
    const dispose = apply(first.ctx) as () => void
    expect(typeof dispose).toBe('function')
    dispose()
    expect(first.routes).toEqual([])
    expect(first.provides).toEqual([])

    const second = makeCtx()
    apply(second.ctx)
    expect(second.routes).toEqual(ALL_ROUTES)
    expect(second.provides.map((entry) => entry.name)).toEqual(['petween'])
  })
})
