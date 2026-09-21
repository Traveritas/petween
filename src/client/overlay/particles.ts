/**
 * client/overlay/particles.ts — DOM particle bursts for `particle` timeline
 * events (spec §8.5). One WAAPI animation per particle element; an element
 * removes itself when its animation settles. No rAF loops, no resident
 * timers (§23). Emission is a no-op under reduced-motion, when the config
 * switch is off, or for an unknown effect id.
 *
 * Every effect is one row in a data table (count/shapes/colors/trajectory);
 * there is a single emitter path — no per-effect animation branches.
 */

/** Particle silhouettes, built with border-radius / clip-path only. */
export type ParticleShape = 'strip' | 'dot' | 'star' | 'cross' | 'heart' | 'ring' | 'petal'

interface ParticleEffectSpec {
  /** Particles per burst (kept <= MAX_PARTICLES_PER_EMIT). */
  count: number
  shapes: readonly ParticleShape[]
  colors: readonly string[]
  /** px size range (strip: width, height follows; others: side). */
  size: readonly [number, number]
  /** px travel range from the burst origin. */
  distance: readonly [number, number]
  /** ms lifetime range. */
  duration: readonly [number, number]
  /**
   * Extra downward drift in px (gravity); 0 = straight radial flight.
   * Negative values are legal — a buoyant effect drifts upward instead.
   */
  gravity: number
  /** deg spin range, applied in a random direction. */
  spin: readonly [number, number]
}

export const MAX_PARTICLES_PER_EMIT = 24
/** Backstop against burst spam (e.g. an eventful loop): total live elements. */
export const MAX_LIVE_PARTICLES = 96

const CONFETTI_COLORS = ['#ff5a5f', '#ffb400', '#3ec1d3', '#7c5cff', '#ff7ac8', '#59d98c']
const STAR_COLORS = ['#ffd23f', '#ffb400', '#fff3b0', '#ff8c42']
const SPARKLE_COLORS = ['#ffffff', '#fff3b0', '#cde7ff', '#ffe9a8']
const HEART_COLORS = ['#ff5a8a', '#ff8fab', '#ff2e63', '#ffc2d1']
const PETAL_COLORS = ['#ffb7c5', '#ffd1dc', '#ff8fab', '#ffe5ec']
const FIREWORK_COLORS = ['#ff5a5f', '#ffd23f', '#3ec1d3', '#7c5cff', '#ff7ac8']

/** The effect table; ids mirror ParticleEffectId in motion/animation-definition. */
export const PARTICLE_EFFECTS: Record<string, ParticleEffectSpec> = {
  // Colorful paper bits tossed outward, tumbling, gravity pulling them down.
  confetti: {
    count: 22,
    shapes: ['strip', 'strip', 'dot'],
    colors: CONFETTI_COLORS,
    size: [5, 8],
    distance: [46, 92],
    duration: [620, 980],
    gravity: 26,
    spin: [140, 320],
  },
  // Comic star shapes radiating with a light fall.
  'star-burst': {
    count: 12,
    shapes: ['star', 'cross'],
    colors: STAR_COLORS,
    size: [7, 12],
    distance: [40, 84],
    duration: [480, 760],
    gravity: 10,
    spin: [90, 240],
  },
  // Small cross glints: short range, quick fade, no gravity.
  sparkle: {
    count: 10,
    shapes: ['cross', 'dot'],
    colors: SPARKLE_COLORS,
    size: [4, 7],
    distance: [20, 44],
    duration: [420, 640],
    gravity: 0,
    spin: [0, 90],
  },
  // Pastel hearts buoyantly rising with a gentle tumble (negative gravity).
  'heart-burst': {
    count: 12,
    shapes: ['heart', 'heart', 'dot'],
    colors: HEART_COLORS,
    size: [6, 10],
    distance: [34, 72],
    duration: [640, 940],
    gravity: -18,
    spin: [60, 180],
  },
  // Sakura petals: slow wide drift, strong fall, lazy spin.
  'petal-fall': {
    count: 14,
    shapes: ['petal', 'petal', 'strip'],
    colors: PETAL_COLORS,
    size: [6, 10],
    distance: [26, 58],
    duration: [760, 1120],
    gravity: 32,
    spin: [150, 340],
  },
  // A loud radial burst: mixed silhouettes, long reach, hard fall.
  firework: {
    count: 24,
    shapes: ['dot', 'strip', 'ring'],
    colors: FIREWORK_COLORS,
    size: [4, 7],
    distance: [58, 108],
    duration: [680, 1000],
    gravity: 42,
    spin: [100, 300],
  },
}

const STAR_CLIP =
  'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)'
const CROSS_CLIP = 'polygon(50% 0%, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0% 50%, 38% 38%)'
const HEART_CLIP =
  'polygon(50% 88%, 38% 79%, 24% 66%, 13% 50%, 10% 34%, 16% 20%, 29% 14%, 41% 18%, 50% 28%, 59% 18%, 71% 14%, 84% 20%, 90% 34%, 87% 50%, 76% 66%, 62% 79%)'

function randomIn([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min)
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)]
}

export interface ParticleEmitterOptions {
  /** Config switch (advanced.particles); false = emit() is a no-op. */
  enabled?: boolean
  /** Effective reduced-motion flag; true = emit() is a no-op (§22). */
  reducedMotion?: boolean
}

interface LiveParticle {
  element: HTMLDivElement
  animation: Animation
}

export class ParticleEmitter {
  private readonly layer: HTMLElement
  private readonly live = new Set<LiveParticle>()
  private enabled: boolean
  private reducedMotion: boolean

  constructor(layer: HTMLElement, options: ParticleEmitterOptions = {}) {
    this.layer = layer
    this.enabled = options.enabled ?? true
    this.reducedMotion = options.reducedMotion ?? false
  }

  /** Fires one burst of the named effect; unknown ids are dropped. */
  emit(effect: string): void {
    if (!this.enabled || this.reducedMotion) return
    const spec = PARTICLE_EFFECTS[effect]
    if (spec === undefined) return
    const count = Math.min(spec.count, MAX_PARTICLES_PER_EMIT, MAX_LIVE_PARTICLES - this.live.size)
    for (let index = 0; index < count; index += 1) this.spawn(spec)
  }

  get liveCount(): number {
    return this.live.size
  }

  setEnabled(value: boolean): void {
    this.enabled = value
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value
  }

  /** Cancels every in-flight particle animation and removes the elements. */
  dispose(): void {
    for (const particle of this.live) {
      try {
        particle.animation.cancel()
      } catch {
        // already settled — nothing to cancel
      }
      particle.element.remove()
    }
    this.live.clear()
  }

  private spawn(spec: ParticleEffectSpec): void {
    const element = document.createElement('div')
    element.className = 'petween-particle'
    this.styleParticle(element, spec)

    const angle = Math.random() * Math.PI * 2
    const distance = randomIn(spec.distance)
    const dx = Math.cos(angle) * distance
    const dy = Math.sin(angle) * distance
    const spin = randomIn(spec.spin) * (Math.random() < 0.5 ? -1 : 1)
    const mid = (value: number): number => Math.round(value * 0.7 * 100) / 100
    const end = (value: number): number => Math.round(value * 100) / 100

    const animation = element.animate(
      [
        { transform: 'translate(-50%, -50%) translate(0px, 0px) rotate(0deg)', opacity: 1 },
        {
          transform: `translate(-50%, -50%) translate(${mid(dx)}px, ${mid(dy)}px) rotate(${mid(spin)}deg)`,
          opacity: 1,
          offset: 0.7,
        },
        {
          transform: `translate(-50%, -50%) translate(${end(dx)}px, ${end(dy + spec.gravity)}px) rotate(${end(spin)}deg)`,
          opacity: 0,
        },
      ],
      { duration: randomIn(spec.duration), easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)', fill: 'forwards' },
    )

    const particle: LiveParticle = { element, animation }
    this.live.add(particle)
    const settle = (): void => {
      particle.element.remove()
      this.live.delete(particle)
    }
    // Settles on finish AND on cancel (dispose) — the element never lingers.
    animation.finished.then(settle, settle)
    this.layer.appendChild(element)
  }

  private styleParticle(element: HTMLDivElement, spec: ParticleEffectSpec): void {
    const style = element.style
    style.position = 'absolute'
    style.left = '50%'
    style.top = '50%'
    style.pointerEvents = 'none'

    const color = pick(spec.colors)
    const size = randomIn(spec.size)
    const shape = pick(spec.shapes)
    if (shape === 'ring') {
      // Hollow circle: a border instead of a fill (the only non-background shape).
      style.width = `${Math.round(size)}px`
      style.height = `${Math.round(size)}px`
      style.background = 'transparent'
      style.border = `${Math.max(2, Math.round(size * 0.3))}px solid ${color}`
      style.borderRadius = '50%'
      return
    }
    style.background = color
    if (shape === 'strip') {
      style.width = `${Math.round(size)}px`
      style.height = `${Math.round(size * 1.9)}px`
      style.borderRadius = '1.5px'
    } else if (shape === 'dot') {
      style.width = `${Math.round(size)}px`
      style.height = `${Math.round(size)}px`
      style.borderRadius = '50%'
    } else if (shape === 'petal') {
      style.width = `${Math.round(size * 0.75)}px`
      style.height = `${Math.round(size * 1.7)}px`
      style.borderRadius = '50%'
    } else {
      style.width = `${Math.round(size)}px`
      style.height = `${Math.round(size)}px`
      style.clipPath = shape === 'star' ? STAR_CLIP : shape === 'heart' ? HEART_CLIP : CROSS_CLIP
    }
  }
}
