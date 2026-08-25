// @vitest-environment jsdom
/**
 * ParticleEmitter tests (spec §8.5, §22, §23): burst counts and the per-emit /
 * live caps, element cleanup on finish, the reduced-motion and config-switch
 * gates, unknown-effect drops, and dispose semantics. WAAPI is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LIVE_PARTICLES,
  MAX_PARTICLES_PER_EMIT,
  PARTICLE_EFFECTS,
  ParticleEmitter,
} from '../../src/client/overlay/particles'
import { flushScheduler, installFakeAnimate, type FakeAnimateHarness } from '../motion/fake-animate'

let harness: FakeAnimateHarness
let layer: HTMLDivElement

beforeEach(() => {
  harness = installFakeAnimate()
  layer = document.createElement('div')
  document.body.appendChild(layer)
})

afterEach(() => {
  harness.restore()
  document.body.innerHTML = ''
})

describe('ParticleEmitter', () => {
  it('emits one WAAPI-driven DOM particle per spawn, within the per-emit cap', () => {
    const emitter = new ParticleEmitter(layer)
    emitter.emit('confetti')
    const particles = [...layer.children]
    expect(particles).toHaveLength(PARTICLE_EFFECTS.confetti.count)
    expect(PARTICLE_EFFECTS.confetti.count).toBeLessThanOrEqual(MAX_PARTICLES_PER_EMIT)
    expect(emitter.liveCount).toBe(PARTICLE_EFFECTS.confetti.count)
    for (const element of particles) {
      expect(element.className).toBe('petween-particle')
      expect((element as HTMLElement).style.pointerEvents).toBe('none')
    }
    // one animation per particle, finite duration from the spec range
    expect(harness.animations).toHaveLength(PARTICLE_EFFECTS.confetti.count)
    for (const animation of harness.animations) {
      expect(animation.options.duration).toBeGreaterThanOrEqual(PARTICLE_EFFECTS.confetti.duration[0])
      expect(animation.options.duration).toBeLessThanOrEqual(PARTICLE_EFFECTS.confetti.duration[1])
    }
    emitter.dispose()
  })

  it('every effect row stays within the per-emit cap', () => {
    for (const spec of Object.values(PARTICLE_EFFECTS)) {
      expect(spec.count).toBeLessThanOrEqual(MAX_PARTICLES_PER_EMIT)
    }
  })

  it('removes each element once its animation finishes', async () => {
    const emitter = new ParticleEmitter(layer)
    emitter.emit('sparkle')
    expect(layer.children).toHaveLength(PARTICLE_EFFECTS.sparkle.count)

    harness.finishPending()
    await flushScheduler()
    expect(layer.children).toHaveLength(0)
    expect(emitter.liveCount).toBe(0)
    emitter.dispose()
  })

  it('caps total live particles across bursts', () => {
    const emitter = new ParticleEmitter(layer)
    for (let burst = 0; burst < 5; burst += 1) emitter.emit('confetti') // 5 × 22 > cap
    expect(emitter.liveCount).toBe(MAX_LIVE_PARTICLES) // the 5th burst is trimmed
    expect(layer.children).toHaveLength(MAX_LIVE_PARTICLES)
    emitter.dispose()
  })

  it('is a no-op under reduced-motion or when disabled by config', () => {
    const reduced = new ParticleEmitter(layer, { reducedMotion: true })
    reduced.emit('confetti')
    expect(layer.children).toHaveLength(0)

    const disabled = new ParticleEmitter(layer, { enabled: false })
    disabled.emit('confetti')
    expect(layer.children).toHaveLength(0)

    // live flag flips both ways
    disabled.setEnabled(true)
    disabled.emit('confetti')
    expect(layer.children).toHaveLength(PARTICLE_EFFECTS.confetti.count)

    const emitter = new ParticleEmitter(layer)
    emitter.setReducedMotion(true)
    emitter.emit('sparkle')
    expect(layer.children).toHaveLength(PARTICLE_EFFECTS.confetti.count) // unchanged
    reduced.dispose()
    disabled.dispose()
    emitter.dispose()
  })

  it('drops unknown effect ids', () => {
    const emitter = new ParticleEmitter(layer)
    emitter.emit('fireworks')
    expect(layer.children).toHaveLength(0)
    expect(emitter.liveCount).toBe(0)
    emitter.dispose()
  })

  it('dispose cancels every in-flight particle and removes the elements', () => {
    const emitter = new ParticleEmitter(layer)
    emitter.emit('confetti')
    emitter.emit('star-burst')
    const inFlight = harness.pending()
    expect(inFlight.length).toBeGreaterThan(0)

    emitter.dispose()
    expect(layer.children).toHaveLength(0)
    expect(emitter.liveCount).toBe(0)
    expect(harness.pending()).toHaveLength(0) // all cancelled
    for (const animation of inFlight) expect(animation.playState).toBe('idle')
  })
})
