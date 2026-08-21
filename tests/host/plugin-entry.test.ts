/**
 * Host entry (src/index.ts) mount-once flag: the flag is set only AFTER every
 * registration succeeded, so a mid-init failure cannot wedge later in-process
 * reloads behind a stale flag; a healthy second apply stays a no-op.
 *
 * The fake context mirrors the cordis semantics the entry relies on: the
 * effect body runs synchronously while the fiber is active and a synchronous
 * failure rethrows out of ctx.effect.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index'

const MOUNT_FLAG = Symbol.for('dsh-motion-pet/host')

const ALL_ROUTES = [
  '/api/motion-pet/config',
  '/api/motion-pet/assets',
  '/api/motion-pet/animations', // exact GET
  '/api/motion-pet/animations', // prefix PUT/DELETE
  '/motion-pet-assets',
  '/motion-pet-editor',
  '/api/motion-pet/events',
  '/api/motion-pet/state',
]

type EffectCallback = () => (() => void) | void

const makeCtx = (options: { failOnPath?: string } = {}): { ctx: Context; routes: string[]; listeners: string[] } => {
  const routes: string[] = []
  const listeners: string[] = []
  const ctx = {
    effect: (callback: EffectCallback): (() => void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
    on: (name: string): (() => void) => {
      listeners.push(name)
      return () => undefined
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
  return { ctx: ctx as unknown as Context, routes, listeners }
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

    const second = makeCtx()
    apply(second.ctx)
    expect(second.routes).toHaveLength(0)
    expect(second.listeners).toHaveLength(0)
  })

  it('a mid-init failure releases the flag and rolls back: a retry mounts cleanly', () => {
    const failing = makeCtx({ failOnPath: '/api/motion-pet/events' })
    expect(() => apply(failing.ctx)).toThrow(/duplicate/)
    // the config/asset routes registered before the throw were rolled back
    expect(failing.routes).toEqual([])

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

    const second = makeCtx()
    apply(second.ctx)
    expect(second.routes).toEqual(ALL_ROUTES)
  })
})
