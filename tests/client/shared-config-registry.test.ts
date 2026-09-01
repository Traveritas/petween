/**
 * Shared-config-registry tests (pet-package P3): registration, per-namespace
 * collection, provider error isolation, abstention, and the stale-safe
 * unregister. The registry is a module singleton, so every provider leaves
 * with its test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectSharedPluginConfigs, registerSharedPluginConfigProvider } from '../../src/client/shared-config-registry'

const unregisters: Array<() => void> = []

const register = (pluginId: string, provider: () => unknown): void => {
  unregisters.push(registerSharedPluginConfigProvider(pluginId, provider))
}

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister()
  vi.restoreAllMocks()
})

describe('shared-config-registry (pet-package P3)', () => {
  it('an empty registry collects an empty object (the GET fallback signal)', () => {
    expect(collectSharedPluginConfigs()).toEqual({})
  })

  it('collects every registered provider under its own namespace', () => {
    register('petween-physics', () => ({ gravity: 2400 }))
    register('petween-mood', () => ({ bubble: '…' }))
    expect(collectSharedPluginConfigs()).toEqual({
      'petween-physics': { config: { gravity: 2400 } },
      'petween-mood': { config: { bubble: '…' } },
    })
  })

  it('a throwing provider is isolated: a warn, its namespace skipped, the rest still collected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    register('broken-plugin', () => {
      throw new Error('boom')
    })
    register('petween-physics', () => ({ gravity: 2400 }))
    expect(collectSharedPluginConfigs()).toEqual({ 'petween-physics': { config: { gravity: 2400 } } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('broken-plugin')
  })

  it('an undefined return abstains — that namespace keeps the record snapshot at export', () => {
    register('quiet-plugin', () => undefined)
    register('petween-physics', () => ({ gravity: 2400 }))
    expect(collectSharedPluginConfigs()).toEqual({ 'petween-physics': { config: { gravity: 2400 } } })
  })

  it('unregister removes the provider; collecting afterwards skips it', () => {
    const unregister = registerSharedPluginConfigProvider('petween-physics', () => ({ gravity: 2400 }))
    expect(Object.keys(collectSharedPluginConfigs())).toEqual(['petween-physics'])
    unregister()
    expect(collectSharedPluginConfigs()).toEqual({})
  })

  it('re-registering replaces, and a stale unregister never clobbers the replacement', () => {
    const stale = registerSharedPluginConfigProvider('petween-physics', () => ({ gravity: 1 }))
    register('petween-physics', () => ({ gravity: 2400 }))
    stale() // must NOT remove the replacement
    expect(collectSharedPluginConfigs()).toEqual({ 'petween-physics': { config: { gravity: 2400 } } })
  })
})
