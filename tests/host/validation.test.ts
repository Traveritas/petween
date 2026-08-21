/**
 * Host validation tests (spec §7.7, §19.2): strict PUT validation with field
 * paths, base-fill semantics, and the asset-id whitelist regex.
 */
import { describe, expect, it } from 'vitest'
import { createDefaultMotionPetConfig } from '../../src/core/defaults'
import { ConfigValidationError, repairConfig, validateAssetId, validateConfigPatch } from '../../src/host/validation'

describe('validateConfigPatch (§19.2)', () => {
  it('accepts a full valid config unchanged', () => {
    const config = createDefaultMotionPetConfig()
    config.enabled = false
    config.states.working.enter = { preset: 'jump', strength: 1.4, durationMs: 380 }
    config.poses.thinking.assetId = '0123456789abcdef'
    expect(validateConfigPatch(config)).toEqual(config)
  })

  it('fills missing fields from the base config (patch semantics)', () => {
    const base = createDefaultMotionPetConfig()
    base.global.scale = 1.6
    base.poses.idle.assetId = 'aaaaaaaaaaaaaaaa'
    const patched = validateConfigPatch({ version: 1, enabled: false }, base)
    expect(patched.enabled).toBe(false)
    expect(patched.global.scale).toBe(1.6)
    expect(patched.poses.idle.assetId).toBe('aaaaaaaaaaaaaaaa')
    expect(patched.states).toEqual(base.states)
  })

  it('strips unknown fields without failing', () => {
    const patched = validateConfigPatch({ version: 1, injected: true, global: { scale: 2, evil: 1 } })
    expect(patched.global.scale).toBe(2)
    expect(patched).not.toHaveProperty('injected')
    expect(patched.global).not.toHaveProperty('evil')
  })

  it('throws with the field path on wrong types', () => {
    try {
      validateConfigPatch({ version: 1, enabled: 'yes' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      const issues = (error as ConfigValidationError).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ path: 'enabled' })
    }
  })

  it('throws on out-of-range numbers and bad enums, collecting all issues', () => {
    try {
      validateConfigPatch({
        version: 1,
        global: { scale: 0.1, transition: { preset: 'warp', strength: 99, durationMs: 300 } },
        states: { idle: { enter: { preset: 'none', strength: 1, durationMs: 10 } } },
      })
      expect.unreachable()
    } catch (error) {
      const paths = (error as ConfigValidationError).issues.map((issue) => issue.path).sort()
      expect(paths).toEqual([
        'global.scale',
        'global.transition.preset',
        'global.transition.strength',
        'states.idle.enter.durationMs',
      ])
    }
  })

  it('rejects a non-v1 version tag and non-object bodies', () => {
    expect(() => validateConfigPatch({ version: 2 })).toThrowError(ConfigValidationError)
    expect(() => validateConfigPatch('nope')).toThrowError(ConfigValidationError)
  })

  it('accepts the advanced section and fills it from the base when absent', () => {
    const turned = validateConfigPatch({ version: 1, advanced: { changePoseWithinActive: true } })
    expect(turned.advanced).toEqual({
      changePoseWithinActive: true,
      activityTransition: 'subtle',
      terminalHold: 'timed',
      particles: true,
    })

    const base = createDefaultMotionPetConfig()
    base.advanced.changePoseWithinActive = true
    const patched = validateConfigPatch({ version: 1, enabled: false }, base)
    expect(patched.advanced.changePoseWithinActive).toBe(true)
  })

  it('accepts advanced.particles and throws with the field path on a bad value', () => {
    const turned = validateConfigPatch({ version: 1, advanced: { particles: false } })
    expect(turned.advanced.particles).toBe(false)

    const base = createDefaultMotionPetConfig()
    base.advanced.particles = false
    const patched = validateConfigPatch({ version: 1, enabled: false }, base)
    expect(patched.advanced.particles).toBe(false)

    try {
      validateConfigPatch({ version: 1, advanced: { particles: 'yes' } })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ConfigValidationError).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ path: 'advanced.particles' })
    }
  })

  it('accepts advanced.terminalHold and keeps the base value when absent', () => {
    const turned = validateConfigPatch({ version: 1, advanced: { terminalHold: 'until-interaction' } })
    expect(turned.advanced.terminalHold).toBe('until-interaction')

    const base = createDefaultMotionPetConfig()
    base.advanced.terminalHold = 'until-interaction'
    const patched = validateConfigPatch({ version: 1, enabled: false }, base)
    expect(patched.advanced.terminalHold).toBe('until-interaction')
  })

  it('throws with the field path on a bad terminalHold value', () => {
    try {
      validateConfigPatch({ version: 1, advanced: { terminalHold: 'forever' } })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ConfigValidationError).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ path: 'advanced.terminalHold' })
    }
  })

  it('throws with the field path on a bad advanced value', () => {
    try {
      validateConfigPatch({ version: 1, advanced: { changePoseWithinActive: 'yes' } })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ConfigValidationError).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ path: 'advanced.changePoseWithinActive' })
    }
  })

  it('accepts advanced.activityTransition and keeps the base value when absent', () => {
    const turned = validateConfigPatch({ version: 1, advanced: { activityTransition: 'state' } })
    expect(turned.advanced.activityTransition).toBe('state')

    const base = createDefaultMotionPetConfig()
    base.advanced.activityTransition = 'none'
    const patched = validateConfigPatch({ version: 1, enabled: false }, base)
    expect(patched.advanced.activityTransition).toBe('none')
  })

  it('throws with the field path on a bad activityTransition value', () => {
    try {
      validateConfigPatch({ version: 1, advanced: { activityTransition: 'fancy' } })
      expect.unreachable()
    } catch (error) {
      const issues = (error as ConfigValidationError).issues
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ path: 'advanced.activityTransition' })
    }
  })

  it('accepts interactions.click and fills it from the base when absent', () => {
    const turned = validateConfigPatch({ version: 1, interactions: { click: { animation: 'builtin:click-spin', pose: 'success' } } })
    expect(turned.interactions).toEqual({ click: { animation: 'builtin:click-spin', pose: 'success' } })

    const withNull = validateConfigPatch({ version: 1, interactions: { click: { animation: 'builtin:click-pop', pose: null } } })
    expect(withNull.interactions.click.pose).toBeNull()

    const base = createDefaultMotionPetConfig()
    base.interactions.click = { animation: 'builtin:click-wiggle', pose: 'thinking' }
    const patched = validateConfigPatch({ version: 1, enabled: false }, base)
    expect(patched.interactions.click).toEqual({ animation: 'builtin:click-wiggle', pose: 'thinking' })
  })

  it('throws with field paths on bad interaction values, collecting all issues', () => {
    try {
      validateConfigPatch({ version: 1, interactions: { click: { animation: '', pose: 'happy' } } })
      expect.unreachable()
    } catch (error) {
      const paths = (error as ConfigValidationError).issues.map((issue) => issue.path).sort()
      expect(paths).toEqual(['interactions.click.animation', 'interactions.click.pose'])
    }
    expect(() => validateConfigPatch({ version: 1, interactions: { click: { animation: 42 } } })).toThrowError(
      ConfigValidationError,
    )
  })

  it('accepts the widened bounds (user-signed-off spec deviation)', () => {
    const config = createDefaultMotionPetConfig()
    config.global.scale = 4
    config.global.transition = { preset: 'jelly', strength: 3, durationMs: 2000 }
    config.global.successHoldMs = 120_000
    config.global.errorHoldMs = 120_000
    config.poses.idle.zoom = 8
    config.states.idle.ambient.sway = { enabled: true, angleDeg: 60, periodMs: 120_000 }
    config.states.idle.ambient.breathe = { enabled: true, strength: 1.8, periodMs: 120_000 }
    config.states.idle.ambient.bounce = { enabled: true, strength: 1.8, intervalMinMs: 50, intervalMaxMs: 120_000, durationMs: 360 }
    expect(validateConfigPatch(config)).toEqual(config)
    expect(validateConfigPatch({ version: 1, global: { scale: 0.3 } }).global.scale).toBe(0.3)
  })

  it('still rejects values beyond the widened bounds', () => {
    try {
      validateConfigPatch({
        version: 1,
        global: { scale: 4.1, transition: { preset: 'jelly', strength: 3.1, durationMs: 2001 }, successHoldMs: 120_001 },
        poses: { idle: { zoom: 8.1 } },
        states: {
          idle: {
            ambient: {
              sway: { enabled: true, angleDeg: 61, periodMs: 120_001 },
              bounce: { enabled: true, intervalMinMs: 49 },
            },
          },
        },
      })
      expect.unreachable()
    } catch (error) {
      const paths = (error as ConfigValidationError).issues.map((issue) => issue.path).sort()
      expect(paths).toEqual([
        'global.scale',
        'global.successHoldMs',
        'global.transition.durationMs',
        'global.transition.strength',
        'poses.idle.zoom',
        'states.idle.ambient.bounce.intervalMinMs',
        'states.idle.ambient.sway.angleDeg',
        'states.idle.ambient.sway.periodMs',
      ])
    }
  })
})

describe('repairConfig — advanced defaults (§18.3)', () => {
  it('fills a missing advanced section with the defaults', () => {
    const repaired = repairConfig({ version: 1, enabled: true })
    expect(repaired.advanced).toEqual({
      changePoseWithinActive: false,
      activityTransition: 'subtle',
      terminalHold: 'timed',
      particles: true,
    })
  })

  it('repairs an invalid advanced value back to the default without throwing', () => {
    const repaired = repairConfig({ version: 1, advanced: { changePoseWithinActive: 1 } })
    expect(repaired.advanced.changePoseWithinActive).toBe(false)
    expect(repairConfig({ version: 1, advanced: { particles: 'no' } }).advanced.particles).toBe(true)
  })

  it('repairs a missing or invalid terminalHold back to the default', () => {
    expect(repairConfig({ version: 1 }).advanced.terminalHold).toBe('timed')
    const repaired = repairConfig({ version: 1, advanced: { terminalHold: 42 } })
    expect(repaired.advanced.terminalHold).toBe('timed')
  })

  it('repairs invalid interactions/activityTransition back to the defaults without throwing', () => {
    const repaired = repairConfig({
      version: 1,
      advanced: { activityTransition: 'fancy' },
      interactions: { click: { animation: 42, pose: 'happy' } },
    })
    expect(repaired.advanced.activityTransition).toBe('subtle')
    expect(repaired.interactions).toEqual({ click: { animation: 'builtin:click-pop', pose: null } })
  })
})

describe('states.*.enter.animationId (§8.14, V1.1)', () => {
  const withAnimationId = (animationId: unknown): Record<string, unknown> => ({
    version: 1,
    states: { idle: { enter: { preset: 'soft', strength: 1, durationMs: 220, animationId } } },
  })

  it('accepts a known built-in transition id', () => {
    const patched = validateConfigPatch(withAnimationId('builtin:jelly'))
    expect(patched.states.idle.enter.animationId).toBe('builtin:jelly')
  })

  it('accepts a user id that exists on disk (injected check)', () => {
    const patched = validateConfigPatch(withAnimationId('user:pop'), undefined, { animationExists: () => true })
    expect(patched.states.idle.enter.animationId).toBe('user:pop')
  })

  it('accepts a user id shape-only when no existence check is injected', () => {
    const patched = validateConfigPatch(withAnimationId('user:pop'))
    expect(patched.states.idle.enter.animationId).toBe('user:pop')
  })

  it('throws with the field path on unknown builtin ids, missing customs and bad shapes', () => {
    const pathsOf = (body: unknown, exists?: (id: string) => boolean): string[] => {
      try {
        validateConfigPatch(body, undefined, { animationExists: exists })
        return []
      } catch (error) {
        return (error as ConfigValidationError).issues.map((issue) => issue.path)
      }
    }
    expect(pathsOf(withAnimationId('builtin:warp'))).toEqual(['states.idle.enter.animationId'])
    expect(pathsOf(withAnimationId('user:ghost'), () => false)).toEqual(['states.idle.enter.animationId'])
    expect(pathsOf(withAnimationId('../evil'))).toEqual(['states.idle.enter.animationId'])
    expect(pathsOf(withAnimationId(42))).toEqual(['states.idle.enter.animationId'])
  })

  it('keeps the base animationId when the patch omits it; explicit null clears it', () => {
    const base = createDefaultMotionPetConfig()
    base.states.idle.enter.animationId = 'user:pop'
    // enter absent entirely, and enter present without animationId: both keep the base
    expect(validateConfigPatch({ version: 1 }, base).states.idle.enter.animationId).toBe('user:pop')
    const partial = validateConfigPatch({ version: 1, states: { idle: { enter: { preset: 'jelly' } } } }, base)
    expect(partial.states.idle.enter).toEqual({ preset: 'jelly', strength: 1, durationMs: 220, animationId: 'user:pop' })
    // explicit null clears (mirrors overlay.x / interactions.click.pose)
    const cleared = validateConfigPatch(withAnimationId(null), base)
    expect(cleared.states.idle.enter.animationId).toBeUndefined()
    expect(cleared.states.idle.enter.preset).toBe(base.states.idle.enter.preset)
  })

  it('repair drops an animationId whose custom animation is gone (preset fallback)', () => {
    const repaired = repairConfig(withAnimationId('user:ghost'), { animationExists: () => false })
    expect(repaired.states.idle.enter.animationId).toBeUndefined()
    expect(repaired.states.idle.enter.preset).toBe('soft') // untouched fields survive
  })

  it('repair keeps a resolvable animationId and never throws on bad shapes', () => {
    expect(repairConfig(withAnimationId('user:pop'), { animationExists: () => true }).states.idle.enter.animationId).toBe(
      'user:pop',
    )
    expect(repairConfig(withAnimationId('builtin:flip')).states.idle.enter.animationId).toBe('builtin:flip')
    expect(repairConfig(withAnimationId('builtin:warp')).states.idle.enter.animationId).toBeUndefined()
    expect(repairConfig(withAnimationId(42)).states.idle.enter.animationId).toBeUndefined()
  })

  it('global.transition stays preset-only: animationId there is stripped', () => {
    const patched = validateConfigPatch({
      version: 1,
      global: { transition: { preset: 'jelly', strength: 1, durationMs: 380, animationId: 'user:pop' } },
    })
    expect(patched.global.transition).not.toHaveProperty('animationId')
  })
})

describe('validateAssetId', () => {
  it('accepts 16 lowercase hex chars', () => {
    expect(validateAssetId('0123456789abcdef')).toBe('0123456789abcdef')
  })

  it('rejects traversal, slashes, non-hex and wrong lengths', () => {
    for (const bad of ['..', '../config', 'ab/cd', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', 42, null]) {
      expect(validateAssetId(bad)).toBeNull()
    }
  })
})
